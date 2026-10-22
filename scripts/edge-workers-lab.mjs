// P04.T02a workerd lab: the real wrangler dry-run bundles of the api and broker
// (and the orchestrator and connector) under Miniflare 4.20260730.0, with Worker
// options from `unstable_getMiniflareWorkerOptions`, injected bindings, a fixed
// `cf` and a synthetic WorkOS provider. No account, credential or network: every
// outbound request is routed to an in-process oracle or counted and refused.
// Covers AC06, AC08, AC10, AC11, AC13-AC15 (broker side), AC18 (first half),
// AC22, AC26, AC28, AC29 and AC30. The PostgreSQL-backed journeys (AC17, AC19,
// AC20, AC27 and the rest of AC13/AC18/AC26) are in edge-postgresql-lab.mjs.
// P05.T01ab adds the sign-in abuse guard over the same bundles: Miniflare `ratelimits`
// from the committed development config and a synthetic siteverify behind the
// broker's fixed URL (AC01, AC02, AC03, AC04, AC05, AC09, AC10 and the fourth method).
// M2 PR-1 adds the trust model v1 entrypoints (ConnectorBroker, RuntimeBroker): each
// serves only its own role lease and health, and a bad vault KEK disables the vault only.
// M2 PR-2 binds the connector bundle to the broker's ConnectorBroker: unconfigured it is
// deny-all; configured, syntactic refusals reach no database, the Shopify methods exist on
// ConnectorBroker only, and an unreachable vault login fails closed. The PR-2 review adds
// the connector's committed per-address ingress limits: no address fails closed and the
// limit's next request is 429 with no broker call.
// M5 PR-1 adds the four ApiBroker Stripe methods (held without the capability; with it,
// an unreachable vault login holds every write before any Stripe request) and the unbound
// api's billing and webhook paths. The Stripe switch (owner decision (c), 2026-10-21): with
// no MORROW_STRIPE_MODE every Stripe method is STRIPE_UNAVAILABLE before its inputs, even
// with every Stripe secret bound, and a bound api answers the webhook 503 unavailable
// without calling the broker.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Log, LogLevel, Miniflare } from "miniflare";
import { writeArtifact } from "./artifacts.mjs";
import {
  captureConsole,
  edgeConnectorRateLimits,
  edgeDryRun,
  edgeRateLimits,
  edgeRefusals,
  edgeWorkers,
  ensureWorkspaceDist,
  loadWranglerApi,
  workerConfigPath,
} from "./edge.mjs";
import { createPlatformWorkosProviderOracle } from "./fixtures/fixed-workos-platform-provider.mjs";
import {
  createSiteverifyOracle,
  labChallengeActions,
  siteverifyOrigin,
} from "./fixtures/turnstile-siteverify.mjs";

const held = (code) => Error("EDGE_WORKERS_LAB_" + code);
if (process.version !== "v24.13.0") throw held("PINNED_NODE_REQUIRED");
const packageVersion = (name) =>
  JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version;
if (
  packageVersion("miniflare") !== "4.20260730.0" ||
  packageVersion("workerd") !== "1.20260730.1" ||
  packageVersion("wrangler") !== "4.116.0"
)
  throw held("PINNED_RUNTIME_REQUIRED");
const refusals = edgeRefusals();
if (refusals.length) throw held("REFUSED " + refusals.join(","));
const hash = (text) => createHash("sha256").update(text).digest("hex");
const checks = [];
const cases = [];
const privateMarkers = [];
const check = (name, passed) => {
  checks.push({ name, passed: passed === true });
  return passed === true;
};
const scratch = mkdtempSync(join(tmpdir(), "morrow-edge-workers-lab-"));
const [apiWorker, brokerWorker, orchestratorWorker, connectorWorker] = edgeWorkers;
const names = {
  api: "morrow-development-api",
  broker: "morrow-development-broker",
  orchestrator: "morrow-development-orchestrator",
  connector: "morrow-development-connector",
};

// The real deployable bundles (wrangler 4.116.0, esbuild 0.28.1) for development.
ensureWorkspaceDist();
const bundleRoot = join(scratch, "bundles");
edgeDryRun({ outRoot: bundleRoot, environments: ["development"], report: false });
const bundle = (worker) =>
  readFileSync(
    join(bundleRoot, worker.key, "development", basename(worker.entry).replace(/\.ts$/, ".js")),
    "utf8",
  );
const { unstable_getMiniflareWorkerOptions } = await loadWranglerApi();
const workerOptions = (worker, overrides) =>
  captureConsole(() =>
    unstable_getMiniflareWorkerOptions(
      workerConfigPath(worker),
      undefined,
      overrides ? { overrides } : undefined,
    ),
  ).value.workerOptions;
const options = Object.fromEntries(
  edgeWorkers.map((worker) => [worker.key, workerOptions(worker)]),
);
check(
  "wrangler_options_bind_the_same_environment_api_broker_entrypoint",
  JSON.stringify(options.api.serviceBindings) ===
    JSON.stringify({ BROKER: { name: names.broker, entrypoint: "ApiBroker" } }),
);
// P05.T01ab: the Miniflare `ratelimits` of every api instance are the committed
// development limiters (wrangler's own options), never a lab override.
check(
  "P05T01ab:wrangler_options_bind_the_development_limiters",
  JSON.stringify(
    Object.values(options.api.ratelimits ?? {}).map(({ name, namespace_id, simple }) => ({
      name,
      namespace_id,
      simple,
    })),
  ) === JSON.stringify(edgeRateLimits("development")),
);
// M2 PR-2: the connector binds the broker's ConnectorBroker entrypoint (trust model v1).
// M3 PR-2: the orchestrator, its first caller, binds exactly the same environment's
// RuntimeBroker entrypoint (its role lease and modelRespond) and nothing else.
check(
  "M3PR2:orchestrator_binds_only_the_runtime_broker_entrypoint",
  JSON.stringify(options.orchestrator.serviceBindings) ===
    JSON.stringify({ BROKER: { name: names.broker, entrypoint: "RuntimeBroker" } }),
);
check(
  "M2PR2:connector_binds_the_same_environment_connector_broker_entrypoint",
  JSON.stringify(options.connector.serviceBindings) ===
    JSON.stringify({ BROKER: { name: names.broker, entrypoint: "ConnectorBroker" } }),
);
// M2 PR-2 review: the connector's Miniflare `ratelimits` are its committed development
// ingress limiters, never a lab override.
check(
  "M2PR2:wrangler_options_bind_the_connector_development_limiters",
  JSON.stringify(
    Object.values(options.connector.ratelimits ?? {}).map(({ name, namespace_id, simple }) => ({
      name,
      namespace_id,
      simple,
    })),
  ) === JSON.stringify(edgeConnectorRateLimits("development")),
);

// Synthetic configuration; every marker is built at runtime and never written.
const origin = "https://workspace.example.test";
const keyMarker = ["sk", "test", randomBytes(16).toString("hex")].join("_");
privateMarkers.push(keyMarker);
const provider = createPlatformWorkosProviderOracle({ origin, managementMarker: keyMarker });
// Every issued Turnstile token is a private marker, like the secret.
const siteverify = createSiteverifyOracle({
  hostname: new URL(origin).hostname,
  onIssue: (token) => privateMarkers.push(token),
});
privateMarkers.push(siteverify.secret);
const login = JSON.parse(provider.configurationJson);
const auth = JSON.parse(login.authenticationBindingJson);
const configurationDigest = hash(
  JSON.stringify([
    "morrow.login.configuration",
    "1",
    login.controllerProtocol,
    login.origin,
    login.retentionTier,
    auth.bindingId,
    String(auth.bindingRevision),
    auth.environmentId,
    auth.applicationId,
    auth.clientId,
    auth.redirectUri,
    auth.returnPath,
    login.profileId,
    String(login.profileRecordRevision),
    hash(login.verificationProfileJson),
  ]),
);
const databaseBinding = {
  schemaVersion: 1,
  environment: "development",
  projectId: "morrow-edge-lab",
  branchId: "br-edge-lab",
  hostname: "ep-edge-lab.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
};
const roles = [
  "morrow_identity_login",
  "morrow_identity_preauth",
  "morrow_identity_sessions",
  "morrow_api",
  "morrow_identity_linking",
  "morrow_identity_logout",
  "morrow_identity_onboarding",
  "morrow_api_worker",
];
// M2 PR-1 (ADR-0022 items 7-8): the connector's and the orchestrator's leased logins, the
// broker's own vault login and the vault KEK.
const callerRoles = { connector: "morrow_connector_ingress", runtime: "morrow_runtime_executor" };
const passwords = Object.fromEntries(
  [...roles, ...Object.values(callerRoles), "morrow_vault_broker"].map((role) => [
    role,
    "Edge-" + randomBytes(18).toString("base64url"),
  ]),
);
const vaultKek = randomBytes(32).toString("hex");
privateMarkers.push(...Object.values(passwords), vaultKek);
const day = 86400000;
function keyring({ fromMs, untilMs }) {
  const keyId = randomUUID();
  const material = randomBytes(32).toString("base64url");
  privateMarkers.push(material);
  return JSON.stringify({
    schemaVersion: 1,
    purpose: "morrow.login.capsule/1",
    configurationDigest,
    currentKeyId: keyId,
    versions: [
      {
        keyId,
        material,
        encryptFromMs: fromMs,
        encryptUntilMs: untilMs,
        decryptUntilMs: untilMs + 300000,
      },
    ],
  });
}
const fresh = () => keyring({ fromMs: Date.now() - 300000, untilMs: Date.now() + 90 * day });
function apiBindings(change = {}) {
  return {
    MORROW_ENVIRONMENT: "development",
    LOGIN_CONFIGURATION_JSON: provider.configurationJson,
    WORKSPACE_CONFIGURATION_JSON: JSON.stringify({ schemaVersion: 1, mode: "https", origin }),
    LOGOUT_CONFIGURATION_JSON: JSON.stringify({
      schemaVersion: 1,
      protocol: "morrow-self-logout-v1",
      origin,
      providerId: "workos",
      environmentId: auth.environmentId,
      applicationId: auth.applicationId,
      clientId: auth.clientId,
      profileId: login.profileId,
    }),
    MORROW_DATABASE_BINDING_JSON: JSON.stringify(databaseBinding),
    LOGIN_CAPSULE_KEYRING: fresh(),
    ...change,
  };
}
function brokerBindings(change = {}) {
  return {
    MORROW_ENVIRONMENT: "development",
    LOGIN_CONFIGURATION_JSON: provider.configurationJson,
    MORROW_DATABASE_BINDING_JSON: JSON.stringify(databaseBinding),
    WORKOS_API_KEY: keyMarker,
    TURNSTILE_SECRET_KEY: siteverify.secret,
    TURNSTILE_CONFIGURATION_JSON: siteverify.turnstileConfigurationJson,
    ...Object.fromEntries(
      Object.keys(passwords).map((role) => [
        "MORROW_DB_PASSWORD_" + role.toUpperCase(),
        passwords[role],
      ]),
    ),
    MORROW_VAULT_KEK_V1: vaultKek,
    ...change,
  };
}
// P05.T01ab: the full development guard (the committed limiters plus a challenge).
const guardedApiBindings = (change = {}) =>
  apiBindings({ LOGIN_CHALLENGE_JSON: siteverify.loginChallengeJson, ...change });
const neonNamespace = (role, binding = databaseBinding) =>
  JSON.stringify({
    schemaVersion: 1,
    providerId: "neon",
    environment: binding.environment,
    projectId: binding.projectId,
    branchId: binding.branchId,
    hostname: binding.hostname,
    database: binding.database,
    role,
    purpose:
      role === "morrow_api_worker"
        ? "work_request_transaction"
        : role === "morrow_connector_ingress"
          ? "connector_request_transaction"
          : role === "morrow_runtime_executor"
            ? "runtime_step_transaction"
            : [
                  "morrow_api",
                  "morrow_identity_linking",
                  "morrow_identity_logout",
                  "morrow_identity_onboarding",
                ].includes(role)
              ? "workspace_primary_and_one_same_role_observer"
              : "primary_and_one_same_role_observer",
  });
const sessionNamespace = JSON.stringify({
  schemaVersion: 1,
  providerId: "workos",
  environmentId: auth.environmentId,
  applicationId: auth.applicationId,
  clientId: auth.clientId,
  purpose: "list_active_sessions",
});

// A test-only caller holding the same ApiBroker binding the api holds.
const probeScript = `
const describe = (value) => ({
  type: value === null ? "null" : typeof value,
  disposer: value !== null && typeof value === "object" ? typeof value[Symbol.dispose] : null,
  value: typeof value === "string" || typeof value === "boolean" ? value : null,
});
export default {
  async fetch(request, env) {
    const { op, args = [], count = 1, path = "/", method = "GET", binding = "BROKER" } = await request.json();
    if (op === "processEnv") return Response.json(Object.keys(globalThis.process?.env ?? {}));
    const call = async () => {
      try {
        if (op === "default") {
          const response = await env.BROKER_DEFAULT.fetch(new Request("https://broker.internal" + path, { method }));
          return { ok: true, status: response.status, body: await response.text() };
        }
        if (op === "fetch") {
          const response = await env.BROKER.fetch("https://broker.internal/");
          return { ok: true, status: response.status };
        }
        if (op === "unknown") return { ok: true, ...describe(await env[binding].unknownMethod()) };
        return { ok: true, ...describe(await env[binding][op](...args)) };
      } catch (error) {
        return { ok: false, name: error?.name ?? null, message: error?.message ?? null, keys: Object.keys(error ?? {}) };
      }
    };
    return Response.json(await Promise.all(Array.from({ length: count }, call)));
  },
};`;

// One Miniflare instance per case, disposed in finally. Outbound traffic is routed
// per Worker and counted; logs are the Workers' own structured console lines.
async function instance(name, { api = {}, broker = {}, extra = [], assets } = {}, run) {
  const observed = {
    logs: [],
    apiProvider: [],
    brokerProvider: [],
    neon: 0,
    siteverify: 0,
    unexpected: 0,
    // M2 PR-2: the broker's vault login and the connector's own login (never answered).
    brokerNeon: 0,
    connectorOutbound: 0,
  };
  const apiOptions = assets
    ? workerOptions(apiWorker, { assets: { directory: assets } })
    : options.api;
  const workers = [
    {
      ...apiOptions,
      name: names.api,
      modules: true,
      script: api.script ?? bundle(apiWorker),
      bindings: api.bindings ?? { MORROW_ENVIRONMENT: "development" },
      ...(api.compatibilityFlags ? { compatibilityFlags: api.compatibilityFlags } : {}),
      outboundService(request) {
        const url = new URL(request.url);
        if (url.hostname === databaseBinding.hostname || url.hostname.endsWith(".neon.tech")) {
          observed.neon++;
          return new Response(null, { status: 503 });
        }
        if (url.origin === "https://api.workos.com") {
          observed.apiProvider.push({
            method: request.method,
            path: url.pathname,
            authorization: request.headers.has("authorization"),
          });
          return provider.handleRequest(request);
        }
        observed.unexpected++;
        return new Response(null, { status: 503 });
      },
    },
    {
      ...options.broker,
      name: names.broker,
      modules: true,
      script: broker.script ?? bundle(brokerWorker),
      bindings: broker.bindings ?? brokerBindings(),
      outboundService(request) {
        const url = new URL(request.url);
        if (url.origin === "https://api.workos.com") {
          observed.brokerProvider.push({
            method: request.method,
            path: url.pathname,
            authorization: request.headers.get("authorization") === "Bearer " + keyMarker,
          });
          return provider.handleRequest(request);
        }
        if (url.origin === siteverifyOrigin) {
          observed.siteverify++;
          return siteverify.handleRequest(request);
        }
        if (url.hostname === databaseBinding.hostname) {
          observed.brokerNeon++;
          return new Response(null, { status: 503 });
        }
        observed.unexpected++;
        return new Response(null, { status: 503 });
      },
    },
    {
      name: "probe",
      modules: true,
      script: probeScript,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat", "nodejs_compat_do_not_populate_process_env"],
      serviceBindings: {
        BROKER: { name: names.broker, entrypoint: "ApiBroker" },
        BROKER_DEFAULT: { name: names.broker },
        // M2 PR-1: test-only holders of the connector's and the orchestrator's bindings,
        // on the real broker bundle only (the stand-in brokers export ApiBroker alone).
        ...(broker.script
          ? {}
          : {
              BROKER_CONNECTOR: { name: names.broker, entrypoint: "ConnectorBroker" },
              BROKER_RUNTIME: { name: names.broker, entrypoint: "RuntimeBroker" },
            }),
      },
    },
    ...extra.map((worker) =>
      worker.name === names.connector
        ? {
            ...worker,
            outboundService() {
              observed.connectorOutbound++;
              return new Response(null, { status: 503 });
            },
          }
        : worker,
    ),
  ];
  const mf = new Miniflare({
    workers,
    upstream: origin,
    cf: { colo: "LAB", country: "US", asn: 0 },
    log: new Log(LogLevel.NONE),
    handleStructuredLogs({ message }) {
      if (typeof message === "string" && message.startsWith("{"))
        try {
          observed.logs.push(JSON.parse(message));
        } catch {}
    },
  });
  const fetchApi = async (path, init = {}) => {
    const response = await mf.dispatchFetch(origin + path, init);
    return { status: response.status, headers: response.headers, body: await response.text() };
  };
  const probe = async (body) => {
    const worker = await mf.getWorker("probe");
    const response = await worker.fetch("https://probe.internal/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return response.json();
  };
  const events = (event) => observed.logs.filter((row) => row.event === event);
  let failure = null;
  const startedChecks = checks.length;
  try {
    await mf.ready;
    await run({ mf, fetchApi, probe, observed, events });
  } catch (error) {
    failure = String(error?.message ?? error)
      .split("\n")[0]
      .slice(0, 300);
  } finally {
    await mf.dispose();
  }
  // P04.T01i D6 lab redaction: no Worker log line of any instance holds a private
  // marker (the WorkOS key, passwords, keyring material, the Turnstile secret and
  // every token the lab issued or made up).
  const logged = JSON.stringify(observed.logs);
  check(
    name + ":no_private_marker_in_logs",
    privateMarkers.every((marker) => !logged.includes(marker)),
  );
  const own = checks.slice(startedChecks);
  cases.push({
    name,
    passed: failure === null && own.every((row) => row.passed),
    failure,
    checks: own.length,
    outbound: {
      apiProvider: observed.apiProvider,
      brokerProvider: observed.brokerProvider.length,
      neon: observed.neon,
      brokerNeon: observed.brokerNeon,
      connectorOutbound: observed.connectorOutbound,
      siteverify: observed.siteverify,
      unexpected: observed.unexpected,
    },
  });
  return observed;
}
// M4: an RPC error keeps its name and message; the runtime adds only `remote`.
const remoteOnly = (keys) => keys.every((key) => key === "remote");
const json = (body) => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};
const loginStart = (fetchApi) =>
  fetchApi("/auth/login", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify({ schemaVersion: 2 }),
  });
const cookie = "__Host-morrow_session=" + randomBytes(32).toString("base64url").slice(0, 42) + "A";
const unavailable = '{"schemaVersion":1,"outcome":"login_unavailable"}';

await instance("AC06_unbound_api_spa_and_denials", {}, async ({ fetchApi, observed, events }) => {
  const root = await fetchApi("/");
  check("AC06:spa_index", root.status === 200 && root.body.includes('<div id="root"></div>'));
  check(
    "AC06:spa_headers",
    /frame-ancestors 'none'/.test(root.headers.get("content-security-policy") ?? "") &&
      root.headers.get("x-content-type-options") === "nosniff" &&
      root.headers.get("referrer-policy") === "no-referrer" &&
      root.headers.get("cross-origin-opener-policy") === "same-origin" &&
      /camera=\(\)/.test(root.headers.get("permissions-policy") ?? ""),
  );
  const navigate = await fetchApi("/w/x/inbox", { headers: { "Sec-Fetch-Mode": "navigate" } });
  check(
    "AC06:navigate_unmatched_index",
    navigate.status === 200 && navigate.body.includes('<div id="root">'),
  );
  // M1 (measured): with run_worker_first as a list, static routing applies the SPA
  // fallback to every unmatched path, navigation or not; the Worker's own 404 is
  // reachable only on reserved paths.
  const plain = await fetchApi("/w/x/inbox", { headers: { "Sec-Fetch-Mode": "cors" } });
  check(
    "AC06:M1_non_navigation_unmatched_index",
    plain.status === 200 && plain.body.includes('<div id="root">'),
  );
  const api = await fetchApi("/api/x");
  check(
    "AC06:reserved_unknown_worker_404",
    api.status === 404 && api.body === '{"code":"not_found"}',
  );
  // M5 PR-1: the unbound api answers billing 401 and the Stripe webhook 404, with no
  // network, database or broker call (checked below with the rest of AC06).
  const billing = await fetchApi("/workspace/workspace_a/billing");
  const webhook = await fetchApi("/api/billing/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=" + "a".repeat(64) },
    body: "{}",
  });
  check(
    "M5:unbound_billing_401_and_webhook_404",
    billing.status === 401 &&
      json(billing.body)?.code === "denied" &&
      webhook.status === 404 &&
      webhook.body === '{"code":"not_found"}',
  );
  const loginResponse = await fetchApi("/auth/login", { method: "POST" });
  check(
    "AC06:login_unavailable",
    loginResponse.status === 503 && loginResponse.body === '{"code":"unavailable"}',
  );
  const bootstrap = await fetchApi("/workspace/workspace_a/bootstrap");
  check(
    "AC06:bootstrap_401",
    bootstrap.status === 401 && json(bootstrap.body)?.code === "authentication_required",
  );
  const health = await fetchApi("/healthz");
  check(
    "AC06:healthz_not_ready",
    health.status === 200 && health.body === '{"schemaVersion":1,"service":"api","ready":false}',
  );
  check(
    "AC06:healthz_no_store",
    health.headers.get("cache-control") === "no-store" &&
      health.headers.get("x-content-type-options") === "nosniff",
  );
  const head = await fetchApi("/healthz", { method: "HEAD" });
  const post = await fetchApi("/healthz", { method: "POST" });
  check("AC06:healthz_methods", head.status === 200 && head.body === "" && post.status === 405);
  check(
    "AC06:unbound_logged_once",
    events("morrow_api_unbound").length === 1 &&
      events("morrow_api_unbound")[0].code === "API_ENV_UNBOUND",
  );
  check(
    "AC06:broker_zero_calls",
    events("morrow_broker_init").length === 0 && events("morrow_broker").length === 0,
  );
  check(
    "AC06:no_outbound",
    observed.apiProvider.length +
      observed.brokerProvider.length +
      observed.neon +
      observed.unexpected ===
      0,
  );
});

await instance(
  "AC07_tripwire",
  { api: { bindings: apiBindings({ WORKOS_API_KEY: keyMarker }) } },
  async ({ fetchApi, events }) => {
    const health = await fetchApi("/healthz");
    check("AC07:healthz_false", json(health.body)?.ready === false);
    const started = await loginStart(fetchApi);
    check(
      "AC07:unbound_login",
      started.status === 503 && started.body === '{"code":"unavailable"}',
    );
    check(
      "AC07:code",
      events("morrow_api_unbound")[0]?.code === "API_ENV_FORBIDDEN_CREDENTIAL_BINDING",
    );
    check("AC07:broker_untouched", events("morrow_broker_init").length === 0);
  },
);

// AC08: every Worker's own compatibility settings expose no process.env; the
// api without the flag maps to API_ENV_PROCESS_ENV_POPULATED.
{
  const probes = edgeWorkers.map((worker) => ({
    name: "env_" + worker.key,
    modules: true,
    script: probeScript,
    compatibilityDate: options[worker.key].compatibilityDate,
    compatibilityFlags: options[worker.key].compatibilityFlags,
    bindings: { ...(options[worker.key].bindings ?? {}), PROBE_TEXT_BINDING: "text" },
  }));
  probes.push({
    ...probes[0],
    name: "env_negative_control",
    compatibilityFlags: ["nodejs_compat"],
  });
  await instance("AC08_process_env", { extra: probes }, async ({ mf }) => {
    for (const item of probes) {
      const worker = await mf.getWorker(item.name);
      const keys = await (
        await worker.fetch("https://probe.internal/", {
          method: "POST",
          body: '{"op":"processEnv"}',
        })
      ).json();
      if (item.name === "env_negative_control")
        check("AC08:negative_control_populated", keys.includes("PROBE_TEXT_BINDING"));
      else check("AC08:" + item.name + "_empty", Array.isArray(keys) && keys.length === 0);
    }
  });
  await instance(
    "AC08_api_without_flag",
    { api: { bindings: apiBindings(), compatibilityFlags: ["nodejs_compat"] } },
    async ({ fetchApi, events }) => {
      check("AC08:healthz_false", json((await fetchApi("/healthz")).body)?.ready === false);
      check(
        "AC08:mapped_code",
        events("morrow_api_unbound")[0]?.code === "API_ENV_PROCESS_ENV_POPULATED",
      );
    },
  );
}

await instance("AC10_AC11_AC13_AC15_broker_surface", {}, async ({ probe, observed, events }) => {
  for (const [method, path] of [
    ["GET", "/"],
    ["POST", "/neonLease"],
    ["DELETE", "/x"],
    ["GET", "/healthz"],
  ]) {
    const [reply] = await probe({ op: "default", method, path });
    check(
      `AC10:default_404_${method}_${path}`,
      reply.ok && reply.status === 404 && reply.body === '{"code":"not_found"}',
    );
  }
  const [fetchReply] = await probe({ op: "fetch" });
  check("AC10:entrypoint_fetch_rejects", fetchReply.ok === false);
  const [unknown] = await probe({ op: "unknown" });
  check("AC10:unknown_method_rejects", unknown.ok === false && unknown.name === "TypeError");
  const results = [];
  for (const role of roles) {
    const [reply] = await probe({ op: "neonLease", args: [neonNamespace(role)] });
    results.push(reply);
    const grant = reply.ok && typeof reply.value === "string" ? json(reply.value) : null;
    check(
      "AC11:lease_" + role,
      reply.type === "string" &&
        grant?.schemaVersion === 1 &&
        Object.keys(grant).join() === "schemaVersion,password" &&
        roles.every((other) => (grant.password === passwords[other]) === (other === role)),
    );
  }
  const denied = [
    ...[
      "morrow_identity_owner",
      "morrow_identity_lifecycle",
      "morrow_identity_login_maintenance",
      // Retired from the login wiring by P05.T01x (ADR-0009 item 4).
      "morrow_identity_resolution",
    ].map((role) => neonNamespace(role)),
    neonNamespace("morrow_api").replace("workspace_primary", "primary"),
    neonNamespace("morrow_api", { ...databaseBinding, environment: "staging" }),
    neonNamespace("morrow_api", { ...databaseBinding, projectId: "other" }),
    neonNamespace("morrow_api", { ...databaseBinding, branchId: "br-other" }),
    neonNamespace("morrow_api", {
      ...databaseBinding,
      hostname: "ep-other.c-14.us-east-1.aws.neon.tech",
    }),
    neonNamespace("morrow_api", { ...databaseBinding, database: "other" }),
    JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(neonNamespace("morrow_api"))).reverse()),
    ),
    JSON.stringify(JSON.parse(neonNamespace("morrow_api")), null, 1),
    "x".repeat(1025),
  ];
  for (const namespace of denied) {
    const [reply] = await probe({ op: "neonLease", args: [namespace] });
    results.push(reply);
    check(
      "AC11:denied_" + hash(namespace).slice(0, 8),
      reply.ok === false && reply.message === "BROKER_HELD" && remoteOnly(reply.keys),
    );
  }
  for (const value of [1, null, { role: "morrow_api" }, ["x"]]) {
    const [reply] = await probe({ op: "neonLease", args: [value] });
    check("AC11:non_string_denied", reply.ok === false && reply.message === "BROKER_HELD");
  }
  const leaseCodes = events("morrow_broker")
    .filter((row) => row.method === "neonLease")
    .map((row) => row.code);
  check(
    "AC11:namespace_denied_codes",
    leaseCodes.length === denied.length + 4 &&
      leaseCodes.every((code) => code === "NAMESPACE_DENIED"),
  );
  const issued = provider.issueAuthorization({ challenge: "a".repeat(42) + "A" });
  provider.activate(issued);
  const selector = JSON.stringify({
    schemaVersion: 1,
    subjectId: issued.claims.sub,
    after: null,
    limit: 100,
    order: "asc",
  });
  const [page] = await probe({ op: "workosSessionPage", args: [sessionNamespace, selector, 5000] });
  results.push(page);
  check(
    "AC13:broker_session_page",
    page.ok && page.type === "string" && json(page.value)?.object === "list",
  );
  check(
    "AC13:broker_only_keyed_sessions_get",
    observed.brokerProvider.length === 1 &&
      observed.brokerProvider[0].method === "GET" &&
      /^\/user_management\/users\/user_[A-Z0-9]{26}\/sessions$/.test(
        observed.brokerProvider[0].path,
      ) &&
      observed.brokerProvider[0].authorization === true,
  );
  for (const budget of [0, -1, 1.5, 10001, null]) {
    const [reply] = await probe({
      op: "workosSessionPage",
      args: [sessionNamespace, selector, budget],
    });
    check("AC11:budget_" + String(budget), reply.ok === false);
  }
  const [wrong] = await probe({
    op: "workosSessionPage",
    args: [sessionNamespace.replace("list_active", "other"), selector, 5000],
  });
  check("AC11:session_namespace_denied", wrong.ok === false);
  const sessionCodes = events("morrow_broker")
    .filter((row) => row.method === "workosSessionPage")
    .map((row) => row.code);
  check(
    "AC11:session_codes",
    JSON.stringify(sessionCodes) ===
      JSON.stringify([
        "BUDGET_INVALID",
        "BUDGET_INVALID",
        "BUDGET_INVALID",
        "BUDGET_INVALID",
        "BUDGET_INVALID",
        "NAMESPACE_DENIED",
      ]),
  );
  const [health] = await probe({ op: "health" });
  results.push(health);
  check(
    "AC15:health_boolean_true",
    health.ok && health.type === "boolean" && health.value === true,
  );
  check(
    "AC15:every_result_primitive",
    results
      .filter((row) => row.ok)
      .every((row) => ["string", "boolean"].includes(row.type) && row.disposer === null),
  );
  check(
    "AC13:one_provider_request_total",
    observed.brokerProvider.length === 1 && observed.apiProvider.length === 0,
  );
  const serialized = JSON.stringify(observed.logs);
  check(
    "AC13:no_marker_in_logs",
    privateMarkers.every((marker) => !serialized.includes(marker)),
  );
});

await instance(
  "AC14_live_key_in_development",
  {
    broker: {
      bindings: brokerBindings({
        WORKOS_API_KEY: ["sk", "live", randomBytes(16).toString("hex")].join("_"),
      }),
    },
  },
  async ({ probe, events }) => {
    const selector = JSON.stringify({
      schemaVersion: 1,
      subjectId: "user_" + "C".repeat(26),
      after: null,
      limit: 100,
      order: "asc",
    });
    const [page] = await probe({
      op: "workosSessionPage",
      args: [sessionNamespace, selector, 1000],
    });
    check(
      "AC14:session_unavailable",
      page.ok === false && events("morrow_broker").at(-1)?.code === "CAPABILITY_UNAVAILABLE",
    );
    const [health] = await probe({ op: "health" });
    check("AC14:health_false", health.ok && health.value === false);
    const [lease] = await probe({ op: "neonLease", args: [neonNamespace("morrow_api")] });
    check("AC14:lease_unaffected", lease.ok && lease.type === "string");
  },
);

await instance(
  "AC18_branch_drift_login_unavailable",
  {
    api: { bindings: apiBindings() },
    broker: {
      bindings: brokerBindings({
        MORROW_DATABASE_BINDING_JSON: JSON.stringify({
          ...databaseBinding,
          branchId: "br-edge-lab-drift",
        }),
      }),
    },
  },
  async ({ fetchApi, observed, events }) => {
    const started = await loginStart(fetchApi);
    check(
      "AC18:login_unavailable",
      started.status === 503 &&
        started.body === unavailable &&
        started.headers.getSetCookie().length === 0,
    );
    check("AC18:no_wss_opened", observed.neon === 0);
    check(
      "AC18:namespace_denied",
      events("morrow_broker").some(
        (row) => row.method === "neonLease" && row.code === "NAMESPACE_DENIED",
      ),
    );
  },
);

{
  const dist = join(scratch, "reserved-dist");
  mkdirSync(join(dist, "auth"), { recursive: true });
  mkdirSync(join(dist, "workspace"), { recursive: true });
  mkdirSync(join(dist, "api"), { recursive: true });
  mkdirSync(join(dist, "assets"), { recursive: true });
  for (const path of ["auth/login", "workspace/x", "api/x", "healthz", "index.html"])
    writeFileSync(join(dist, path), "SHADOW_" + path);
  writeFileSync(join(dist, "assets/app-lab.js"), "console.log(1);");
  cpSync("apps/workspace-web/public/_headers", join(dist, "_headers"));
  await instance(
    "AC22_reserved_paths_cannot_be_shadowed",
    { assets: dist },
    async ({ fetchApi }) => {
      for (const path of ["/auth/login", "/workspace/x", "/api/x", "/healthz"])
        for (const mode of [null, "navigate"]) {
          const response = await fetchApi(
            path,
            mode ? { headers: { "Sec-Fetch-Mode": mode } } : {},
          );
          check(
            `AC22:${path}:${mode ?? "none"}_reaches_worker`,
            !response.body.startsWith("SHADOW_") && /^\{/.test(response.body),
          );
        }
      const script = await fetchApi("/assets/app-lab.js");
      check(
        "AC22:assets_immutable",
        script.status === 200 &&
          script.headers.get("cache-control") === "public, max-age=31536000, immutable",
      );
    },
  );
}

for (const [label, ring, expectedCode, ready] of [
  [
    "expired",
    keyring({ fromMs: Date.now() - 100 * day, untilMs: Date.now() - 1000 }),
    "KEYRING_EXPIRED",
    false,
  ],
  [
    "not_yet_valid",
    keyring({ fromMs: Date.now() + day, untilMs: Date.now() + 90 * day }),
    "KEYRING_NOT_YET_VALID",
    false,
  ],
  [
    "expiring",
    keyring({ fromMs: Date.now() - 80 * day, untilMs: Date.now() + 10 * day }),
    "KEYRING_EXPIRING",
    true,
  ],
])
  await instance(
    "AC26_keyring_" + label,
    { api: { bindings: apiBindings({ LOGIN_CAPSULE_KEYRING: ring }) } },
    async ({ fetchApi, events, observed }) => {
      if (!ready) {
        const started = await loginStart(fetchApi);
        check(`AC26:${label}:login_503`, started.status === 503 && started.body === unavailable);
        check(`AC26:${label}:no_database`, observed.neon === 0);
      }
      for (let i = 0; i < 3; i++) {
        const health = await fetchApi("/healthz");
        check(`AC26:${label}:healthz_${i}`, json(health.body)?.ready === ready);
      }
      const logged = events("morrow_api_keyring");
      check(`AC26:${label}:logged_once`, logged.length === 1 && logged[0].code === expectedCode);
    },
  );

// The configured instance outlives the request that composed it: a later
// request's broker health RPC must not reuse request-bound objects.
await instance(
  "AC30_health_after_composing_request",
  { api: { bindings: apiBindings() } },
  async ({ fetchApi }) => {
    const bootstrap = await fetchApi("/workspace/workspace_a/bootstrap");
    check("AC30:composed_by_bootstrap_401", bootstrap.status === 401);
    check("AC30:later_healthz_ready", json((await fetchApi("/healthz")).body)?.ready === true);
  },
);

await (async () => {
  let refused = null;
  const mf = new Miniflare({
    workers: [
      {
        ...options.api,
        name: names.api,
        modules: true,
        script: bundle(apiWorker),
        bindings: apiBindings(),
      },
      {
        name: names.broker,
        modules: true,
        compatibilityDate: "2026-07-30",
        script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
      },
    ],
    cf: { colo: "LAB" },
    log: new Log(LogLevel.NONE),
  });
  try {
    await mf.ready;
  } catch (error) {
    refused = String(error?.message ?? error);
  } finally {
    await mf.dispose().catch(() => {});
  }
  // M5 (measured): Miniflare refuses to start a pair whose named entrypoint is
  // missing; any other startup failure does not count.
  const passed = check(
    "AC28:M5_missing_entrypoint_refused",
    refused !== null &&
      refused.includes("has no such named entrypoint") &&
      refused.includes('"ApiBroker"'),
  );
  cases.push({
    name: "AC28_missing_entrypoint_refused_to_start",
    passed,
    failure: null,
    checks: 1,
  });
})();

const partialBroker = `import { WorkerEntrypoint } from "cloudflare:workers";
export class ApiBroker extends WorkerEntrypoint {
  async workosSessionPage() { return "{}"; }
}
export default { fetch() { console.log(JSON.stringify({ event: "partial_broker_fetch" })); return new Response(null, { status: 200 }); } };`;
await instance(
  "AC28_entrypoint_without_neonLease",
  { api: { bindings: apiBindings() }, broker: { script: partialBroker } },
  async ({ fetchApi, events, observed }) => {
    const started = await loginStart(fetchApi);
    check("AC28:login_503", started.status === 503 && started.body === unavailable);
    const bootstrap = await fetchApi("/workspace/workspace_a/bootstrap", {
      headers: { Cookie: cookie },
    });
    check("AC28:bootstrap_503", bootstrap.status === 503);
    check("AC28:healthz_false", json((await fetchApi("/healthz")).body)?.ready === false);
    check(
      "AC28:never_falls_back_to_fetch",
      events("partial_broker_fetch").length === 0 && observed.neon === 0,
    );
  },
);

// M2 PR-1 (ADR-0022 item 7, trust model v1): each caller's entrypoint in workerd serves
// only its own role lease and health; no other caller's role, and no v0 method.
await instance("M2_connector_and_runtime_entrypoints", {}, async ({ probe, events }) => {
  for (const [caller, binding, entrypoint] of [
    ["connector", "BROKER_CONNECTOR", "ConnectorBroker"],
    ["runtime", "BROKER_RUNTIME", "RuntimeBroker"],
  ]) {
    const role = callerRoles[caller];
    const [health] = await probe({ op: "health", binding });
    check(`M2:${caller}_health`, health.ok && health.value === true);
    const [own] = await probe({ op: "neonLease", binding, args: [neonNamespace(role)] });
    const grant = own.ok && typeof own.value === "string" ? json(own.value) : null;
    check(
      `M2:${caller}_leases_its_own_role`,
      grant?.schemaVersion === 1 &&
        Object.keys(grant).join() === "schemaVersion,password" &&
        grant.password === passwords[role],
    );
    const others = [
      ...roles,
      ...Object.values(callerRoles).filter((other) => other !== role),
      "morrow_vault_broker",
    ];
    const denied = [];
    for (const other of others)
      denied.push((await probe({ op: "neonLease", binding, args: [neonNamespace(other)] }))[0]);
    check(
      `M2:${caller}_denied_every_other_role`,
      denied.every((r) => r.ok === false && r.message === "BROKER_HELD" && remoteOnly(r.keys)),
    );
    const [v0] = await probe({
      op: "workosSessionPage",
      binding,
      args: [sessionNamespace, "{}", 1000],
    });
    check(`M2:${caller}_has_no_v0_session_method`, v0.ok === false && v0.name === "TypeError");
    const codes = events("morrow_broker").filter((row) => row.entrypoint === entrypoint);
    check(
      `M2:${caller}_denials_logged_under_its_entrypoint`,
      codes.length === others.length && codes.every((row) => row.code === "NAMESPACE_DENIED"),
    );
  }
  // The api's entrypoint never leases the new roles.
  const apiDenied = [];
  for (const role of [...Object.values(callerRoles), "morrow_vault_broker"])
    apiDenied.push((await probe({ op: "neonLease", args: [neonNamespace(role)] }))[0]);
  check(
    "M2:api_never_leases_the_executor_roles",
    apiDenied.every((r) => r.ok === false),
  );
});
await instance(
  "M2_vault_kek_missing",
  { broker: { bindings: brokerBindings({ MORROW_VAULT_KEK_V1: "not-a-kek" }) } },
  async ({ probe, events }) => {
    const [connector] = await probe({ op: "health", binding: "BROKER_CONNECTOR" });
    const [runtime] = await probe({ op: "health", binding: "BROKER_RUNTIME" });
    const [api] = await probe({ op: "health" });
    check(
      "M2:a_bad_kek_disables_the_vault_only",
      connector.value === false && runtime.value === false && api.value === true,
    );
    const init = events("morrow_broker_init")[0];
    check(
      "M2:init_reports_each_capability",
      init?.vault === false &&
        init.connector === true &&
        init.runtime === true &&
        init.database === true,
    );
  },
);

// M5 PR-1 (ADR-0022 items 7 and 12): the four ApiBroker Stripe methods over the real RPC
// binding. Switched off (no MORROW_STRIPE_MODE, the committed state; owner decision (c),
// 2026-10-21) every method is STRIPE_UNAVAILABLE before its inputs are read, with every
// Stripe secret bound, and nothing leaves the broker. Switched on without the Stripe
// secrets the capability is held (init stripe:false) and every method answers
// BROKER_HELD; malformed arguments are refused first. With them the capability
// initialises, and each write first opens its operation on the vault login (M2 PR-2's
// transport): the lab answers that database 503, so every call is held before any network
// and no Stripe request leaves the broker.
const stripeOperation = "00000000-0000-4000-8000-0000000000a5";
const stripeCalls = [
  ["stripeCustomerEnsure", [stripeOperation, 1000]],
  ["stripeCheckoutCreate", [stripeOperation, 1000]],
  ["stripePortalCreate", [stripeOperation, 1000]],
  ["stripeWebhookVerify", ["e30=", "t=1,v1=" + "a".repeat(64), 1000]],
  ["stripeCustomerEnsure", ["not-an-operation", 1000]],
  ["stripeCheckoutCreate", [stripeOperation, 10001]],
  ["stripeWebhookVerify", ["", "t=1", 1000]],
];
const stripeKey = "rk_test_" + randomBytes(16).toString("hex");
const stripeWebhookSecret = "whsec_" + randomBytes(16).toString("hex");
privateMarkers.push(stripeKey, stripeWebhookSecret);
const stripeBindings = {
  STRIPE_RESTRICTED_KEY: stripeKey,
  STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
  STRIPE_CONFIGURATION_JSON: JSON.stringify({
    schemaVersion: 1,
    portalConfigurationId: "bpc_" + "Lab".padEnd(24, "0"),
    automaticTax: false,
    billingAddressCollection: "auto",
  }),
};
const stripeCodes = (events) =>
  JSON.stringify(
    events("morrow_broker")
      .filter((row) => row.method.startsWith("stripe"))
      .map((row) => row.code),
  );
await instance(
  "M5_stripe_methods_switched_off",
  { broker: { bindings: brokerBindings(stripeBindings) } },
  async ({ probe, events, observed }) => {
    const replies = [];
    for (const [op, args] of stripeCalls) replies.push((await probe({ op, args }))[0]);
    check(
      "M5:switched_off_every_stripe_method_held",
      replies.every((r) => r.ok === false && r.message === "BROKER_HELD" && remoteOnly(r.keys)),
    );
    const init = events("morrow_broker_init")[0];
    check(
      "M5:switched_off_init_reads_no_stripe",
      init?.stripe === false && init.stripeMode === "off" && init.vault === true,
    );
    check(
      "M5:switched_off_refusals_are_stripe_unavailable_before_inputs",
      stripeCodes(events) === JSON.stringify(Array(stripeCalls.length).fill("STRIPE_UNAVAILABLE")),
    );
    check(
      "M5:switched_off_no_vault_or_stripe_request",
      observed.brokerNeon === 0 && observed.unexpected === 0,
    );
  },
);
await instance(
  "M5_stripe_methods_without_the_capability",
  { broker: { bindings: brokerBindings({ MORROW_STRIPE_MODE: "test" }) } },
  async ({ probe, events, observed }) => {
    const replies = [];
    for (const [op, args] of stripeCalls) replies.push((await probe({ op, args }))[0]);
    check(
      "M5:stripe_methods_held_without_the_capability",
      replies.every((r) => r.ok === false && r.message === "BROKER_HELD" && remoteOnly(r.keys)),
    );
    check(
      "M5:init_reports_stripe_held",
      events("morrow_broker_init")[0]?.stripe === false &&
        events("morrow_broker_init")[0]?.stripeMode === "test",
    );
    check(
      "M5:refusals_are_fixed_codes",
      stripeCodes(events) ===
        JSON.stringify([
          "CAPABILITY_UNAVAILABLE",
          "CAPABILITY_UNAVAILABLE",
          "CAPABILITY_UNAVAILABLE",
          "CAPABILITY_UNAVAILABLE",
          "INPUT_INVALID",
          "BUDGET_INVALID",
          "INPUT_INVALID",
        ]),
    );
    check("M5:no_outbound_without_the_capability", observed.unexpected === 0);
  },
);
await instance(
  "M5_stripe_capability_with_an_unreachable_vault",
  { broker: { bindings: brokerBindings({ MORROW_STRIPE_MODE: "test", ...stripeBindings }) } },
  async ({ probe, events, observed }) => {
    const replies = [];
    for (const [op, args] of stripeCalls.slice(0, 3)) replies.push((await probe({ op, args }))[0]);
    check("M5:init_reports_stripe_ready", events("morrow_broker_init")[0]?.stripe === true);
    check(
      "M5:an_unreachable_vault_holds_every_write_before_any_stripe_request",
      replies.every((r) => r.ok === false && r.message === "BROKER_HELD") &&
        observed.brokerNeon >= replies.length &&
        observed.unexpected === 0,
    );
  },
);
// The bound api (the deployed composition, deployed-worker.ts) with a broker that logs
// every Stripe call: switched off the webhook is 503 {"code":"unavailable"} and no Stripe
// method runs; switched on (MORROW_STRIPE_MODE "test") the same request reaches
// stripeWebhookVerify (held here, so 503 for Stripe's retry).
const stripeCountingBroker = `import { WorkerEntrypoint } from "cloudflare:workers";
const stripe = (method) => { console.log(JSON.stringify({ event: "counting_broker_stripe", method })); throw new Error("BROKER_HELD"); };
export class ApiBroker extends WorkerEntrypoint {
  health() { return true; }
  async neonLease() { throw new Error("BROKER_HELD"); }
  async workosSessionPage() { throw new Error("BROKER_HELD"); }
  async challengeVerify() { throw new Error("BROKER_HELD"); }
  async stripeCustomerEnsure() { return stripe("stripeCustomerEnsure"); }
  async stripeCheckoutCreate() { return stripe("stripeCheckoutCreate"); }
  async stripePortalCreate() { return stripe("stripePortalCreate"); }
  async stripeWebhookVerify() { return stripe("stripeWebhookVerify"); }
}
export default { fetch() { return new Response(null, { status: 404 }); } };`;
const deliverWebhook = (fetchApi) =>
  fetchApi("/api/billing/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=" + "a".repeat(64) },
    body: "{}",
  });
await instance(
  "M5_bound_api_with_stripe_switched_off",
  { api: { bindings: apiBindings() }, broker: { script: stripeCountingBroker } },
  async ({ fetchApi, events, observed }) => {
    const webhook = await deliverWebhook(fetchApi);
    check(
      "M5:switched_off_webhook_unavailable_without_a_broker_call",
      webhook.status === 503 &&
        webhook.body === '{"code":"unavailable"}' &&
        events("counting_broker_stripe").length === 0 &&
        observed.unexpected === 0,
    );
    check(
      "M5:switched_off_webhook_logs_stripe_off",
      events("morrow_billing_webhook").some((row) => row.outcome === "stripe_off"),
    );
  },
);
await instance(
  "M5_bound_api_with_stripe_switched_on",
  {
    api: { bindings: apiBindings({ MORROW_STRIPE_MODE: "test" }) },
    broker: { script: stripeCountingBroker },
  },
  async ({ fetchApi, events }) => {
    const webhook = await deliverWebhook(fetchApi);
    check(
      "M5:switched_on_webhook_reaches_the_broker",
      webhook.status === 503 &&
        json(webhook.body)?.received === false &&
        JSON.stringify(events("counting_broker_stripe").map((row) => row.method)) ===
          JSON.stringify(["stripeWebhookVerify"]),
    );
  },
);

await instance("AC29_cold_initialisation", {}, async ({ probe, events }) => {
  const replies = await probe({ op: "health", count: 20 });
  check(
    "AC29:twenty_concurrent_first_calls",
    replies.length === 20 && replies.every((reply) => reply.ok && reply.value === true),
  );
  check("AC29:one_initialisation", events("morrow_broker_init").length === 1);
});
await instance(
  "AC29_failed_initialisation_held",
  { broker: { bindings: brokerBindings({ LOGIN_CONFIGURATION_JSON: "{}" }) } },
  async ({ probe, events }) => {
    const first = await probe({ op: "health", count: 5 });
    const later = await probe({ op: "health" });
    check(
      "AC29:held_not_ready",
      [...first, ...later].every((reply) => reply.ok && reply.value === false),
    );
    check(
      "AC29:held_one_initialisation",
      events("morrow_broker_init").length === 1 &&
        events("morrow_broker_init")[0].sessions === false,
    );
  },
);

const countingBroker = (answer) => `import { WorkerEntrypoint } from "cloudflare:workers";
export class ApiBroker extends WorkerEntrypoint {
  health() { console.log(JSON.stringify({ event: "counting_broker_health" })); return ${answer}; }
  async neonLease() { throw new Error("BROKER_HELD"); }
  async workosSessionPage() { throw new Error("BROKER_HELD"); }
}
export default { fetch() { return new Response(null, { status: 404 }); } };`;
await instance(
  "AC30_health_amplification",
  { api: { bindings: apiBindings() }, broker: { script: countingBroker("Promise.resolve(true)") } },
  async ({ fetchApi, events }) => {
    const replies = [];
    for (let wave = 0; wave < 5; wave++)
      replies.push(...(await Promise.all(Array.from({ length: 20 }, () => fetchApi("/healthz")))));
    check(
      "AC30:hundred_ready",
      replies.length === 100 && replies.every((reply) => json(reply.body)?.ready === true),
    );
    check("AC30:at_most_one_rpc", events("counting_broker_health").length === 1);
  },
);
await instance(
  "AC30_silent_broker",
  { api: { bindings: apiBindings() }, broker: { script: countingBroker("new Promise(() => {})") } },
  async ({ fetchApi }) => {
    const started = performance.now();
    const health = await fetchApi("/healthz");
    const elapsed = performance.now() - started;
    check("AC30:not_ready_within_1100ms", json(health.body)?.ready === false && elapsed < 1100);
  },
);

// ---- M2 PR-2: the connector bundle bound to the real broker's ConnectorBroker ----
{
  const connectorOrigin = "https://connector.example.test";
  const connectorWorkerOptions = (bindings) => [
    {
      ...options.connector,
      name: names.connector,
      modules: true,
      script: bundle(connectorWorker),
      bindings,
    },
  ];
  // Every request carries a client address unless `address` is null (the edge sets
  // CF-Connecting-IP; its absence fails closed).
  const connectorFetch = async (mf, path, init = {}, address = "198.51.100.20") => {
    const worker = await mf.getWorker(names.connector);
    const headers = { ...(init.headers ?? {}) };
    if (address !== null) headers["CF-Connecting-IP"] = address;
    const response = await worker.fetch(connectorOrigin + path, {
      redirect: "manual",
      ...init,
      headers,
    });
    return { status: response.status, headers: response.headers, body: await response.text() };
  };
  const unavailableBody = '{"code":"connector_unavailable"}';
  // Committed configuration: MORROW_ENVIRONMENT and the broker binding only. Deny-all:
  // every path is 503 and /healthz says not ready, with no RPC, database or network.
  await instance(
    "M2PR2_connector_unconfigured",
    { extra: connectorWorkerOptions({ MORROW_ENVIRONMENT: "development" }) },
    async ({ mf, observed, events }) => {
      const health = await connectorFetch(mf, "/healthz");
      check(
        "M2PR2:unconfigured_healthz_not_ready",
        health.status === 200 &&
          health.body === '{"schemaVersion":1,"service":"connector","ready":false}',
      );
      for (const [path, method] of [
        ["/", "GET"],
        ["/shopify/a/lab-app/launch?shop=lab.myshopify.com&hmac=00", "GET"],
        ["/shopify/a/lab-app/callback?state=x", "GET"],
        ["/shopify/a/lab-app/webhooks", "POST"],
        ["/auth", "POST"],
      ]) {
        const response = await connectorFetch(mf, path, { method });
        check(
          "M2PR2:unconfigured_503" + path.split("?")[0],
          response.status === 503 && response.body === unavailableBody,
        );
      }
      check(
        "M2PR2:unconfigured_logs_its_code",
        events("morrow_connector_unbound").some((row) => row.code === "CONNECTOR_ENV_UNBOUND"),
      );
      check(
        "M2PR2:unconfigured_sends_nothing",
        observed.connectorOutbound === 0 && observed.brokerNeon === 0 && observed.unexpected === 0,
      );
    },
  );
  // A Shopify-credential name bound to the connector fails closed (ADR-0008 item 2).
  await instance(
    "M2PR2_connector_refuses_a_credential_binding",
    {
      extra: connectorWorkerOptions({
        MORROW_ENVIRONMENT: "development",
        SHOPIFY_API_SECRET: "x".repeat(32),
      }),
    },
    async ({ mf, events }) => {
      const launch = await connectorFetch(mf, "/shopify/a/lab-app/launch?shop=a.myshopify.com");
      check(
        "M2PR2:credential_binding_is_deny_all",
        launch.status === 503 &&
          launch.body === unavailableBody &&
          events("morrow_connector_unbound").some(
            (row) => row.code === "CONNECTOR_ENV_FORBIDDEN_CREDENTIAL_BINDING",
          ),
      );
    },
  );
  // Configured with the reviewed identifiers, against the real broker with its vault: the
  // syntactic refusals reach no database, the session cookie means nothing here, and the
  // vault login is the only database the broker tries (the lab answers it 503: fail closed).
  await instance(
    "M2PR2_connector_configured",
    {
      api: { bindings: apiBindings() },
      extra: connectorWorkerOptions({
        MORROW_ENVIRONMENT: "development",
        CONNECTOR_CONFIGURATION_JSON: JSON.stringify({
          schemaVersion: 1,
          origin: connectorOrigin,
          apiOrigin: origin,
        }),
        MORROW_DATABASE_BINDING_JSON: JSON.stringify(databaseBinding),
      }),
    },
    async ({ mf, observed, probe }) => {
      const health = await connectorFetch(mf, "/healthz");
      check(
        "M2PR2:configured_healthz_ready",
        health.status === 200 &&
          health.body === '{"schemaVersion":1,"service":"connector","ready":true}',
      );
      // Refused before any database: a foreign shop, an oversize query, a callback with no
      // state cookie (a Morrow session cookie is not one), a webhook with no signature.
      const foreign = await connectorFetch(
        mf,
        "/shopify/a/lab-app/launch?hmac=00&shop=evil.example.com&timestamp=1",
      );
      const oversize = await connectorFetch(
        mf,
        "/shopify/a/lab-app/launch?shop=a.myshopify.com&x=" + "a".repeat(2100),
      );
      const noCookie = await connectorFetch(
        mf,
        "/shopify/a/lab-app/callback?code=c&shop=a.myshopify.com&state=" + "s".repeat(43),
        { headers: { Cookie: cookie } },
      );
      const unsigned = await connectorFetch(mf, "/shopify/a/lab-app/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json", Cookie: cookie },
        body: "{}",
      });
      const unknownPath = await connectorFetch(mf, "/shopify/a/lab-app/install?shop=a");
      check(
        "M2PR2:refusals_before_any_database",
        foreign.status === 403 &&
          oversize.status === 400 &&
          noCookie.status === 403 &&
          (noCookie.headers.get("set-cookie") ?? "").startsWith("__Host-morrow_shopify_state=;") &&
          unsigned.status === 401 &&
          unknownPath.status === 404 &&
          observed.brokerNeon === 0 &&
          observed.connectorOutbound === 0,
      );
      check(
        "M2PR2:connector_pages_set_no_session_cookie",
        [foreign, oversize, noCookie, unsigned].every(
          (r) => !(r.headers.get("set-cookie") ?? "").includes("morrow_session"),
        ),
      );
      // A well-formed launch needs the registry and the app secret: the broker's vault login
      // tries its database (the lab refuses it), and the connector fails closed.
      const launch = await connectorFetch(
        mf,
        "/shopify/a/lab-app/launch?hmac=" +
          "0".repeat(64) +
          "&shop=lab-dev-store.myshopify.com&timestamp=" +
          Math.floor(Date.now() / 1000),
      );
      check(
        "M2PR2:an_unreachable_vault_fails_closed",
        launch.status === 503 &&
          !launch.headers.has("location") &&
          observed.brokerNeon >= 1 &&
          observed.connectorOutbound === 0,
      );
      // The ingress limits (M2 PR-2 review): a request with no client address fails closed
      // before any broker call; from one address the 21st launch in a window is 429 and
      // reaches no broker or database.
      const signedLaunch = () =>
        "/shopify/a/lab-app/launch?hmac=" +
        "0".repeat(64) +
        "&shop=lab-dev-store.myshopify.com&timestamp=" +
        Math.floor(Date.now() / 1000);
      const beforeNoAddress = observed.brokerNeon;
      const noAddress = await connectorFetch(mf, signedLaunch(), {}, null);
      check(
        "M2PR2:connector_without_an_address_fails_closed",
        noAddress.status === 503 && observed.brokerNeon === beforeNoAddress,
      );
      const left = 60000 - (Date.now() % 60000);
      if (left < 25000) await new Promise((resolve) => setTimeout(resolve, left + 250));
      const burst = [];
      for (let i = 0; i < 20; i++)
        burst.push((await connectorFetch(mf, signedLaunch(), {}, "198.51.100.21")).status);
      const beforeLimited = observed.brokerNeon;
      const limited = await connectorFetch(mf, signedLaunch(), {}, "198.51.100.21");
      const afterLimited = observed.brokerNeon;
      const other = await connectorFetch(mf, signedLaunch(), {}, "198.51.100.22");
      check(
        "M2PR2:connector_install_limit_is_20_per_address",
        burst.every((status) => status === 503) &&
          limited.status === 429 &&
          limited.body.includes("Too many attempts") &&
          afterLimited === beforeLimited &&
          other.status === 503 &&
          observed.brokerNeon > afterLimited &&
          observed.connectorOutbound === 0,
      );
      // The Shopify methods exist on ConnectorBroker only.
      const [refused] = await probe({
        op: "shopifyLaunchVerify",
        binding: "BROKER_CONNECTOR",
        args: ["lab-app", "shop=evil.example.com"],
      });
      check(
        "M2PR2:connector_broker_serves_the_shopify_methods",
        refused.ok &&
          json(refused.value)?.verdict === "refused" &&
          json(refused.value).shop === null,
      );
      const others = [];
      for (const binding of ["BROKER", "BROKER_RUNTIME"])
        for (const op of ["shopifyLaunchVerify", "shopifyInstallComplete", "shopifyWebhookVerify"])
          others.push((await probe({ op, binding, args: [] }))[0]);
      check(
        "M2PR2:api_and_runtime_entrypoints_have_no_shopify_method",
        others.every((r) => r.ok === false && r.name === "TypeError"),
      );
      check("M2PR2:no_unexpected_outbound", observed.unexpected === 0);
    },
  );
}
// ---- P05.T01ab: the sign-in abuse guard over the real development bundles ----
const loginUnavailable = '{"schemaVersion":1,"outcome":"login_unavailable"}';
const guardOutcome = (outcome) => JSON.stringify({ schemaVersion: 1, outcome });
const startWith = (fetchApi, headers = {}, path = "/auth/login") =>
  fetchApi(path, {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      "Sec-Fetch-Site": "same-origin",
      ...headers,
    },
    body: JSON.stringify({ schemaVersion: 2 }),
  });
const signupWith = (fetchApi, headers = {}) =>
  fetchApi("/organizations", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      "Idempotency-Key": randomUUID(),
      Cookie: cookie,
      ...headers,
    },
    body: JSON.stringify({ schemaVersion: 1, organizationName: "Org", workspaceName: "Main" }),
  });
const guardEvents = (events) => events("morrow_edge_guard").map((row) => row.code);
const noStore429 = (response) =>
  response.status === 429 &&
  response.body === guardOutcome("rate_limited") &&
  response.headers.get("retry-after") === "60" &&
  response.headers.get("cache-control") === "no-store";

await instance(
  "P05T01ab_AC09_configuration_route",
  { api: { bindings: guardedApiBindings() } },
  async ({ fetchApi, observed }) => {
    const configured = await fetchApi("/auth/challenge");
    check(
      "P05T01ab-AC09:turnstile_shape",
      configured.status === 200 &&
        configured.body ===
          JSON.stringify({
            schemaVersion: 1,
            provider: "turnstile",
            siteKey: JSON.parse(siteverify.loginChallengeJson).siteKey,
            actions: labChallengeActions,
          }) &&
        configured.headers.get("cache-control") === "no-store" &&
        configured.headers.get("content-type") === "application/json; charset=utf-8",
    );
    const head = await fetchApi("/auth/challenge", { method: "HEAD" });
    const post = await fetchApi("/auth/challenge", { method: "POST" });
    check("P05T01ab-AC09:methods", head.status === 200 && head.body === "" && post.status === 405);
    check(
      "P05T01ab-AC09:no_broker_or_provider_call",
      observed.siteverify + observed.neon + observed.unexpected === 0,
    );
  },
);
await instance(
  "P05T01ab_AC09_provider_none_in_development",
  { api: { bindings: apiBindings() } },
  async ({ fetchApi }) => {
    const none = await fetchApi("/auth/challenge");
    check(
      "P05T01ab-AC09:provider_none",
      none.status === 200 && none.body === '{"provider":"none"}',
    );
  },
);
await instance("P05T01ab_AC09_unbound_api", {}, async ({ fetchApi }) => {
  const unbound = await fetchApi("/auth/challenge");
  check(
    "P05T01ab-AC09:unbound_is_the_deny_all_503",
    unbound.status === 503 && unbound.body === '{"code":"unavailable"}',
  );
});

await instance(
  "P05T01ab_AC02_AC03_AC10_challenge",
  { api: { bindings: guardedApiBindings() } },
  async ({ fetchApi, probe, observed, events }) => {
    for (const [label, headers] of [
      ["missing", {}],
      ["empty", { "X-Morrow-Challenge": "" }],
      ["oversized", { "X-Morrow-Challenge": "a".repeat(2049) }],
      ["charset", { "X-Morrow-Challenge": "a/b+c=" }],
    ]) {
      const started = await startWith(fetchApi, headers);
      check(
        "P05T01ab-AC02:login_" + label,
        started.status === 403 &&
          started.body === guardOutcome("challenge_required") &&
          started.headers.getSetCookie().length === 0,
      );
    }
    const unsigned = await signupWith(fetchApi);
    check(
      "P05T01ab-AC02:signup_missing",
      unsigned.status === 403 && unsigned.body === guardOutcome("challenge_required"),
    );
    check("P05T01ab-AC02:zero_broker_calls", observed.siteverify === 0 && observed.neon === 0);
    // A bogus token: one siteverify call, 403 challenge_failed, no login flow.
    for (const mode of ["bogus", "other_action", "other_host", "stale"]) {
      const token =
        mode === "bogus"
          ? "lab.bogus." + randomUUID()
          : siteverify.issue(labChallengeActions.login, mode);
      if (mode === "bogus") privateMarkers.push(token);
      const before = observed.siteverify;
      const failed = await startWith(fetchApi, { "X-Morrow-Challenge": token });
      check(
        "P05T01ab-AC03:" + mode + "_challenge_failed",
        failed.status === 403 &&
          failed.body === guardOutcome("challenge_failed") &&
          observed.siteverify === before + 1,
      );
      // Siteverify said success for the three solved-but-wrong tokens, so the broker's
      // own action, hostname and challenge_ts checks are what refused them.
      check(
        "P05T01ab-AC03:" + mode + "_siteverify_success_" + String(mode !== "bogus"),
        siteverify.requests.at(-1)?.success === (mode !== "bogus"),
      );
    }
    // No rejected start reached the login handler, so no login flow and no database.
    check("P05T01ab-AC03:rejections_reach_no_database", observed.neon === 0);
    const replayed = siteverify.issue(labChallengeActions.login);
    // A valid token passes the guard: the handler runs (this lab has no database).
    const first = await startWith(fetchApi, { "X-Morrow-Challenge": replayed });
    check(
      "P05T01ab-AC06:valid_token_reaches_the_handler",
      first.status === 503 && first.body === loginUnavailable && observed.neon > 0,
    );
    const second = await startWith(fetchApi, { "X-Morrow-Challenge": replayed });
    check(
      "P05T01ab-AC03:single_use_token",
      first.status !== 403 &&
        second.status === 403 &&
        second.body === guardOutcome("challenge_failed"),
    );
    // A login token is not a signup token.
    const crossed = await signupWith(fetchApi, {
      "X-Morrow-Challenge": siteverify.issue(labChallengeActions.login),
    });
    check(
      "P05T01ab-AC03:signup_needs_its_own_action",
      crossed.status === 403 && crossed.body === guardOutcome("challenge_failed"),
    );
    const requests = siteverify.requests;
    check(
      "P05T01ab-AC03:siteverify_shape",
      requests.length === observed.siteverify &&
        requests.every(
          (row) =>
            row.method === "POST" &&
            row.path === "/turnstile/v0/siteverify" &&
            row.contentType === "application/x-www-form-urlencoded" &&
            JSON.stringify(row.fields) === '["secret","response"]' &&
            row.secretMatches,
        ),
    );
    const failedLines = events("morrow_challenge");
    check(
      "P05T01ab-AC10:one_line_per_failed_verdict",
      failedLines.length === 6 && failedLines.every((row) => row.code === "failed"),
    );
    check("P05T01ab-AC10:rejections_log_no_guard_line", guardEvents(events).length === 0);
    // The fourth ApiBroker method over the real RPC binding.
    const [passed] = await probe({
      op: "challengeVerify",
      args: [labChallengeActions.signup, siteverify.issue(labChallengeActions.signup), 3000],
    });
    check(
      "P05T01ab-AC03:rpc_passed_string",
      passed.ok && passed.type === "string" && passed.value === "passed",
    );
    const [bad] = await probe({ op: "challengeVerify", args: ["account_login", "a b", 3000] });
    const [budget] = await probe({ op: "challengeVerify", args: ["account_login", "abc", 5001] });
    check(
      "P05T01ab-AC03:rpc_refusals_held",
      bad.ok === false && bad.message === "BROKER_HELD" && budget.ok === false,
    );
  },
);

for (const fault of ["status_500", "redirect", "oversized", "hang"])
  await instance(
    "P05T01ab_AC04_held_" + fault,
    { api: { bindings: guardedApiBindings() } },
    async ({ fetchApi, events, observed }) => {
      siteverify.setFault(fault);
      try {
        const started = await startWith(fetchApi, {
          "X-Morrow-Challenge": siteverify.issue(labChallengeActions.login),
        });
        check(
          "P05T01ab-AC04:" + fault + "_login_503",
          started.status === 503 && started.body === loginUnavailable,
        );
        if (fault === "status_500") {
          const signup = await signupWith(fetchApi, {
            "X-Morrow-Challenge": siteverify.issue(labChallengeActions.signup),
          });
          check(
            "P05T01ab-AC04:signup_503_route_body",
            signup.status === 503 && signup.body === '{"code":"unavailable"}',
          );
        }
        check(
          "P05T01ab-AC04:" + fault + "_fixed_codes",
          guardEvents(events).every((code) => code === "CHALLENGE_HELD") &&
            guardEvents(events).length >= 1 &&
            events("morrow_challenge").length === 0,
        );
        check("P05T01ab-AC04:" + fault + "_no_database", observed.neon === 0);
      } finally {
        siteverify.setFault(null);
      }
    },
  );

// The committed development limiters: login start 10, the callback 20, signup 5 per 60 s.
// Workers rate limits count per fixed window (Miniflare: 60 s windows on the epoch), so
// each burst starts with at least 25 s left in its window; the guarded starts carry no
// token, so every request the limiter admits is a cheap 403 with no broker or database.
const freshWindow = async (leftMs = 25000) => {
  const left = 60000 - (Date.now() % 60000);
  if (left < leftMs) await new Promise((resolve) => setTimeout(resolve, left + 250));
};
await instance(
  "P05T01ab_AC01_AC05_limiter",
  { api: { bindings: guardedApiBindings() } },
  async ({ fetchApi, events, observed }) => {
    const from = (address) => ({ "CF-Connecting-IP": address });
    const required = (r) => r.status === 403 && r.body === guardOutcome("challenge_required");
    // What a third-party page can make a visitor's browser send without a preflight: a
    // simple cross-site POST (no X-Morrow-Request), and another method or a preflight.
    const crossSitePost = (path, address) =>
      fetchApi(path, {
        method: "POST",
        headers: {
          ...from(address),
          "Content-Type": "text/plain",
          "Sec-Fetch-Site": "cross-site",
          "MF-Sec-Fetch-Mode": "no-cors",
        },
        body: "{}",
      });
    const otherMethod = (path, address, method) =>
      fetchApi(path, {
        method,
        headers: {
          ...from(address),
          Origin: "https://elsewhere.example.test",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "x-morrow-request",
        },
      });
    await freshWindow();
    // P05.T01ab-AC01 step 0: twelve uncounted requests first, then the full ten starts.
    const uncounted = [];
    for (let i = 0; i < 4; i++) {
      uncounted.push(["post", await crossSitePost("/auth/login", "198.51.100.10")]);
      uncounted.push(["get", await otherMethod("/auth/login", "198.51.100.10", "GET")]);
      uncounted.push(["options", await otherMethod("/auth/login", "198.51.100.10", "OPTIONS")]);
    }
    check(
      "P05T01ab-AC01:cross_site_start_requests_refused_uncounted",
      uncounted.every(([kind, r]) =>
        kind === "post"
          ? r.status === 403 && r.body === loginUnavailable
          : r.status === 405 && r.body === loginUnavailable,
      ),
    );
    const starts = [];
    for (let i = 0; i < 11; i++) starts.push(await startWith(fetchApi, from("198.51.100.10")));
    check(
      "P05T01ab-AC05:eleventh_start_429_after_ten_challenge_required",
      starts.slice(0, 10).every(required) && noStore429(starts[10]),
    );
    const other = await startWith(fetchApi, from("198.51.100.11"));
    check("P05T01ab-AC05:other_address_unaffected", required(other));
    // IPv6: one /56 is one bucket; another /56 is not.
    await freshWindow();
    const v6 = [];
    for (let i = 0; i < 10; i++)
      v6.push(await startWith(fetchApi, from(`2001:db8:1234:56${i.toString(16)}0::${i + 1}`)));
    const sameSite = await startWith(fetchApi, from("2001:db8:1234:56ff:ffff::1"));
    const otherSite = await startWith(fetchApi, from("2001:db8:1234:5700::1"));
    check(
      "P05T01ab-AC05:ipv6_keyed_by_slash_56",
      v6.every(required) && noStore429(sameSite) && required(otherSite),
    );
    // The router's own matcher decides what is login start: a query string is the same
    // path, so it is limited; the router answers 400 for a start with a query.
    await freshWindow();
    const query = [];
    for (let i = 0; i < 11; i++)
      query.push(await startWith(fetchApi, from("203.0.113.21"), "/auth/login?x=1"));
    check(
      "P05T01ab-AC01:query_string_is_login_start",
      query.slice(0, 10).every(required) && noStore429(query[10]),
    );
    // The callback counts only top-level document navigations. HEAD (the router's
    // 405), an <img> load and a fetch come first, uncounted; the image and the fetch
    // get the handler's 303 from the guard. (MF-Sec-Fetch-Mode is how Miniflare sets
    // the Sec-Fetch-Mode its own client would otherwise overwrite.)
    await freshWindow();
    const callbackAt = (headers) =>
      fetchApi("/auth/workos/callback", {
        redirect: "manual",
        headers: { ...from("203.0.113.22"), ...headers },
      });
    const quiet = [];
    for (let i = 0; i < 7; i++) {
      quiet.push(
        await fetchApi("/auth/workos/callback", { method: "HEAD", headers: from("203.0.113.22") }),
      );
      quiet.push(await callbackAt({ "MF-Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" }));
      quiet.push(await callbackAt({ "MF-Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" }));
    }
    check(
      "P05T01ab-AC01:head_image_and_fetch_callbacks_uncounted",
      quiet.every((r, i) =>
        i % 3 === 0
          ? r.status === 405
          : r.status === 303 && r.headers.get("location") === "/auth/result" && r.body === "",
      ),
    );
    const navigations = [];
    for (let i = 0; i < 21; i++)
      navigations.push(
        await callbackAt({ "MF-Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" }),
      );
    check(
      "P05T01ab-AC05:navigation_callback_limited_at_21",
      navigations.slice(0, 20).every((r) => r.status !== 429) && noStore429(navigations[20]),
    );
    await freshWindow();
    const quietSignups = [];
    for (let i = 0; i < 3; i++) {
      quietSignups.push(["post", await crossSitePost("/organizations", "203.0.113.23")]);
      quietSignups.push([
        "options",
        await otherMethod("/organizations", "203.0.113.23", "OPTIONS"),
      ]);
    }
    check(
      "P05T01ab-AC01:cross_site_signup_requests_refused_uncounted",
      quietSignups.every(
        ([kind, r]) =>
          r.status === (kind === "post" ? 403 : 405) && r.body === '{"code":"request_denied"}',
      ),
    );
    const signups = [];
    for (let i = 0; i < 6; i++) signups.push(await signupWith(fetchApi, from("203.0.113.23")));
    check(
      "P05T01ab-AC05:sixth_signup_429",
      signups.slice(0, 5).every(required) && noStore429(signups[5]),
    );
    check("P05T01ab-AC05:limited_and_rejected_reach_no_broker", observed.siteverify === 0);
    check("P05T01ab-AC01:uncounted_and_limited_reach_no_database", observed.neon === 0);
    // A trailing slash or an encoded letter is another path: never limited, and the
    // router answers its own 404.
    const loose = [];
    for (const path of ["/auth/login/", "/auth/%6Cogin"])
      for (let i = 0; i < 11; i++)
        loose.push(await startWith(fetchApi, from("203.0.113.20"), path));
    check(
      "P05T01ab-AC01:trailing_slash_and_encoded_paths_not_guarded",
      loose.every((r) => r.status === 404 && r.body === loginUnavailable),
    );
    const invalid = await startWith(fetchApi, from("not-an-address"));
    check(
      "P05T01ab-AC05:invalid_address_503",
      invalid.status === 503 && invalid.body === loginUnavailable,
    );
    check(
      "P05T01ab-AC10:only_the_fail_closed_cause_logged",
      JSON.stringify(guardEvents(events)) === '["ADDRESS_INVALID"]',
    );
    const logged = JSON.stringify(observed.logs);
    check(
      "P05T01ab-AC05:no_address_in_any_log_line",
      ["198.51.100", "203.0.113", "2001:db8", "not-an-address"].every(
        (address) => !logged.includes(address),
      ),
    );
  },
);

check("orchestrator_bundle_built", bundle(orchestratorWorker).includes("dispatch_disabled"));
rmSync(scratch, { recursive: true, force: true });

const status =
  checks.every((row) => row.passed) && cases.every((row) => row.passed) ? "passed" : "failed";
const report = {
  generated_at: new Date().toISOString(),
  packet: "P04.T02a",
  status,
  scope:
    "Real wrangler 4.116.0 dry-run bundles of the api and broker in local workerd (Miniflare 4.20260730.0) with synthetic WorkOS and no database; not hosted Cloudflare, Neon or WorkOS qualification.",
  measurements: {
    M1: "With assets.run_worker_first as a list, static routing applies the SPA fallback to every unmatched path, with or without Sec-Fetch-Mode: navigate; the Worker's own 404 is reachable only on reserved paths.",
    M5: "Miniflare refuses to start an api/broker pair whose ApiBroker entrypoint is missing (named entrypoint check).",
  },
  cases,
  checks,
};
const text = JSON.stringify(report, null, 2) + "\n";
if (privateMarkers.some((marker) => text.includes(marker))) throw held("MARKER_IN_REPORT");
const path = writeArtifact("labs/edge-workers.json", text);
process.stdout.write(
  JSON.stringify({ report: path, status, cases: cases.length, checks: checks.length }) + "\n",
);
if (status !== "passed") {
  for (const row of [
    ...cases.filter((item) => !item.passed),
    ...checks.filter((item) => !item.passed),
  ])
    process.stdout.write(JSON.stringify(row) + "\n");
  process.exitCode = 1;
}
