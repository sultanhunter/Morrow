import {
  parseBrokerDatabaseBinding,
  runtimeProductReadAvailable,
  workosSessionNamespace,
  type ApiBrokerRpc,
} from "../../../packages/identity/src/broker-protocol.js";
import {
  managedApiRoute,
  type ManagedWorkspaceApiDependencies,
} from "../../../packages/identity/src/managed-workspace-api.js";
import { captureManagedWorkspaceBinding } from "../../../packages/identity/src/managed-workspace-binding.js";
import { createNeonWorkConnector } from "../../../packages/work/src/neon-connector.js";
import { createConnectionKernel } from "../../../packages/policy/src/connection-authority.js";
import type { WorkApiDependencies } from "../../../packages/work/src/http.js";
import type { RunsApiDependencies } from "../../../packages/work/src/runs/http.js";
import type { BillingApiDependencies } from "../../../packages/work/src/billing/http.js";
import type { StripeWebhookDependencies } from "../../../packages/work/src/billing/webhook.js";
import { createAbuseGuard, type AbuseGuard } from "./abuse-guard.js";
import {
  createBrokerChallengeVerifier,
  createBrokerHealth,
  createBrokerNeonCredentialBroker,
  createBrokerSessionPageReader,
  createBrokerStripe,
} from "./broker-client.js";
import {
  mapApiEnvironment,
  type ApiEnvironmentCode,
  type ApiEnvironmentValues,
  type ApiModelMode,
  type ApiStripeMode,
} from "./environment.js";
import { createWorkspaceApiWorker } from "./worker.js";
import { createLazyWorkosLoginPort, type ApiKeyringReadiness } from "./workos-port.js";

// The wrangler `main` of morrow-<env>-api (P04.T02a D6). Static Assets serve the
// SPA; reserved paths reach this Worker. Bindings map to the managed workspace
// API once per env object (isolate); any problem keeps the deny-all instance.

type Context = Readonly<{ waitUntil(pending: Promise<unknown>): void }>;
type WorkspaceApi = ReturnType<typeof createWorkspaceApiWorker>;
interface Selected {
  readonly api: WorkspaceApi;
  // P05.T01ab: present whenever the environment mapped; it runs before the router.
  readonly guard?: AbuseGuard;
  readonly readiness?: () => Promise<ApiKeyringReadiness>;
  readonly brokerHealth?: () => Promise<boolean>;
  keyringLogged: boolean;
}

// The single place dependencies are assembled, and the P05.T01x extension point.
/** Run admission opens on the model-provider switch and the product read together. */
export const runAdmissionOpen = (modelMode: ApiModelMode, productRead: boolean): boolean =>
  modelMode === "anthropic" && productRead === true;
export function composeApiDependencies(
  values: Readonly<ApiEnvironmentValues>,
  broker: ApiBrokerRpc,
  now: () => number,
  environment: "development" | "staging" | "production" = "development",
  stripeMode: ApiStripeMode = "off",
  modelMode: ApiModelMode = "off",
  productReadAvailable: boolean = runtimeProductReadAvailable,
) {
  const port = createLazyWorkosLoginPort(values.login, now);
  const credentialBroker = createBrokerNeonCredentialBroker(broker, now);
  const dependencies: ManagedWorkspaceApiDependencies = {
    login: {
      configurationJson: values.login,
      capsuleKeyringJson: values.keyring,
      bindingJson: values.binding,
      credentialBroker,
      providerPort: {
        exchange: port.exchange,
        readPublicKeyset: port.readPublicKeyset,
        readSessionPage: createBrokerSessionPageReader(
          broker,
          workosSessionNamespace(values.login),
          now,
        ),
      },
      now,
    },
    workspaceConfigurationJson: values.workspace,
    logoutConfigurationJson: values.logout,
    // M2 PR-2 (P09.T02a): the human kernel for governance.connection.connect administer,
    // used by the Shopify link issuer and the connections read.
    connections: createConnectionKernel(),
  };
  // P06.T01a: the work API on the same origin, with one morrow_api_worker lease
  // per request from the same broker binding (ADR-0010 item 2, ADR-0007).
  const work: WorkApiDependencies = Object.freeze({
    origin: captureManagedWorkspaceBinding({
      loginConfigurationJson: values.login,
      workspaceConfigurationJson: values.workspace,
      logoutConfigurationJson: values.logout,
      bindingJson: values.binding,
    }).origin,
    connector: createNeonWorkConnector(
      parseBrokerDatabaseBinding(values.binding),
      credentialBroker,
    ),
    now,
  });
  // M5 PR-1: the billing API and the Stripe webhook on the same origin and work login, with
  // the broker's Stripe methods behind the ApiBroker binding. The environment is the
  // Worker's own (production never maps, ADR-0007 item 9). While the Stripe switch is off
  // (owner decision (c), 2026-10-21) there are no Stripe adapters: checkout and portal
  // answer 503 unavailable before any database access and the webhook 503 before reading
  // its body; the billing view and the plans keep working from the database.
  const stripe = stripeMode === "test" ? createBrokerStripe(broker) : null;
  const billing: BillingApiDependencies = Object.freeze({
    origin: work.origin,
    connector: work.connector,
    environment,
    broker: stripe,
    now,
  });
  const webhook: StripeWebhookDependencies = Object.freeze({
    connector: work.connector,
    environment,
    broker: stripe,
    now,
  });
  // M3 PR-2: the runs routes on the work dependencies; admission only while the
  // model-provider switch is on and M2 PR-3's product read exists (the orchestrator
  // dispatches on the same two), otherwise 503 before any database access: no run, lease
  // or reservation exists without a Workflow to execute it.
  const runs: RunsApiDependencies = Object.freeze({
    ...work,
    environment,
    admission: runAdmissionOpen(modelMode, productReadAvailable),
  });
  return Object.freeze({
    dependencies,
    work,
    billing,
    webhook,
    runs,
    readiness: () => port.readiness(values.keyring),
    brokerHealth: createBrokerHealth(broker, now),
  });
}

const selections = new WeakMap<object, Selected>();
let detached: Selected | undefined;
function unbound(code: ApiEnvironmentCode | "API_ENV_COMPOSITION_INVALID"): Selected {
  console.log(JSON.stringify({ event: "morrow_api_unbound", code }));
  return { api: createWorkspaceApiWorker(), keyringLogged: false };
}
function select(env: unknown): Selected {
  if (env === null || typeof env !== "object")
    return (detached ??= unbound("API_ENV_RECORD_INVALID"));
  const existing = selections.get(env);
  if (existing) return existing;
  let selected: Selected;
  const mapped = mapApiEnvironment(env);
  if (!mapped.ok) selected = unbound(mapped.code);
  else
    try {
      const composed = composeApiDependencies(
        mapped.values,
        mapped.broker,
        () => Date.now(),
        mapped.environment,
        mapped.stripe,
        mapped.model,
      );
      selected = {
        api: createWorkspaceApiWorker(
          composed.dependencies,
          composed.work,
          composed.billing,
          composed.webhook,
          composed.runs,
        ),
        guard: createAbuseGuard(mapped.guard, createBrokerChallengeVerifier(mapped.broker)),
        readiness: composed.readiness,
        brokerHealth: composed.brokerHealth,
        keyringLogged: false,
      };
    } catch {
      selected = unbound("API_ENV_COMPOSITION_INVALID");
    }
  selections.set(env, selected);
  return selected;
}

function json(status: number, body: unknown, head: boolean, extra: Record<string, string> = {}) {
  return new Response(head ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...extra,
    },
  });
}
// configured AND port ready AND the keyring window contains now AND cached broker health.
async function ready(selected: Selected): Promise<boolean> {
  if (!selected.readiness || !selected.brokerHealth) return false;
  const keyring = await selected.readiness();
  if (
    !selected.keyringLogged &&
    (keyring === "KEYRING_EXPIRING" ||
      keyring === "KEYRING_NOT_YET_VALID" ||
      keyring === "KEYRING_EXPIRED")
  ) {
    selected.keyringLogged = true;
    console.log(JSON.stringify({ event: "morrow_api_keyring", code: keyring }));
  }
  if (keyring !== "KEYRING_READY" && keyring !== "KEYRING_EXPIRING") return false;
  return selected.brokerHealth();
}
async function healthz(request: Request, selected: Selected): Promise<Response> {
  const head = request.method === "HEAD";
  if (request.method !== "GET" && !head)
    return json(405, { code: "method_not_allowed" }, false, { allow: "GET, HEAD" });
  let value = false;
  try {
    value = await ready(selected);
  } catch {
    value = false;
  }
  return json(200, { schemaVersion: 1, service: "api", ready: value }, head);
}

export default {
  fetch(request: Request, env: unknown, ctx: Context): Promise<Response> {
    const selected = select(env);
    let pathname = "";
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      pathname = "";
    }
    if (pathname === "/healthz") return healthz(request, selected);
    const guard = selected.guard;
    // An unbound api has no guard: every route answers its deny-all response.
    if (!guard) return selected.api.fetch(request, env, ctx);
    if (managedApiRoute(pathname) === "challenge")
      return Promise.resolve(guard.configurationResponse(request));
    // The guard runs before the router and any SQL; the response is returned unchanged.
    return guard.handle(request, (forwarded) => selected.api.fetch(forwarded, env, ctx));
  },
};
