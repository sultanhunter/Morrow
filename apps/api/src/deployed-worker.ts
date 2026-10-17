import {
  workosSessionNamespace,
  type ApiBrokerRpc,
} from "../../../packages/identity/src/broker-protocol.js";
import type { ManagedWorkspaceApiDependencies } from "../../../packages/identity/src/managed-workspace-api.js";
import {
  createBrokerHealth,
  createBrokerNeonCredentialBroker,
  createBrokerSessionPageReader,
} from "./broker-client.js";
import {
  mapApiEnvironment,
  type ApiEnvironmentCode,
  type ApiEnvironmentValues,
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
  readonly readiness?: () => Promise<ApiKeyringReadiness>;
  readonly brokerHealth?: () => Promise<boolean>;
  keyringLogged: boolean;
}

// The single place dependencies are assembled, and the P05.T01x extension point.
export function composeApiDependencies(
  values: Readonly<ApiEnvironmentValues>,
  broker: ApiBrokerRpc,
  now: () => number,
) {
  const port = createLazyWorkosLoginPort(values.login, now);
  const dependencies: ManagedWorkspaceApiDependencies = {
    login: {
      configurationJson: values.login,
      capsuleKeyringJson: values.keyring,
      bindingJson: values.binding,
      credentialBroker: createBrokerNeonCredentialBroker(broker, now),
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
  };
  return Object.freeze({
    dependencies,
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
      const composed = composeApiDependencies(mapped.values, mapped.broker, () => Date.now());
      selected = {
        api: createWorkspaceApiWorker(composed.dependencies),
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
    // No await precedes the selected owner; its response is returned unchanged.
    return selected.api.fetch(request, env, ctx);
  },
};
