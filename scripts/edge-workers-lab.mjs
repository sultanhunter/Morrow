// P04.T02a workerd lab: the real wrangler dry-run bundles of the api and broker
// (and the orchestrator and connector) under Miniflare 4.20260730.0, with Worker
// options from `unstable_getMiniflareWorkerOptions`, injected bindings, a fixed
// `cf` and a synthetic WorkOS provider. No account, credential or network: every
// outbound request is routed to an in-process oracle or counted and refused.
// Covers AC06, AC08, AC10, AC11, AC13-AC15 (broker side), AC18 (first half),
// AC22, AC26, AC28, AC29 and AC30. The PostgreSQL-backed journeys (AC17, AC19,
// AC20, AC27 and the rest of AC13/AC18/AC26) are in edge-postgresql-lab.mjs.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Log, LogLevel, Miniflare } from "miniflare";
import { writeArtifact } from "./artifacts.mjs";
import {
  captureConsole,
  edgeDryRun,
  edgeRefusals,
  edgeWorkers,
  ensureWorkspaceDist,
  loadWranglerApi,
  workerConfigPath,
} from "./edge.mjs";
import { createPlatformWorkosProviderOracle } from "./fixtures/fixed-workos-platform-provider.mjs";

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
check(
  "orchestrator_and_connector_have_no_service_bindings",
  Object.keys(options.orchestrator.serviceBindings ?? {}).length === 0 &&
    Object.keys(options.connector.serviceBindings ?? {}).length === 0,
);

// Synthetic configuration; every marker is built at runtime and never written.
const origin = "https://workspace.example.test";
const keyMarker = ["sk", "test", randomBytes(16).toString("hex")].join("_");
privateMarkers.push(keyMarker);
const provider = createPlatformWorkosProviderOracle({ origin, managementMarker: keyMarker });
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
  "morrow_identity_resolution",
  "morrow_identity_sessions",
  "morrow_api",
  "morrow_identity_linking",
  "morrow_identity_logout",
];
const passwords = Object.fromEntries(
  roles.map((role) => [role, "Edge-" + randomBytes(18).toString("base64url")]),
);
privateMarkers.push(...Object.values(passwords));
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
      protocol: "morrow-local-self-logout-85",
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
    ...Object.fromEntries(
      roles.map((role) => ["MORROW_DB_PASSWORD_" + role.toUpperCase(), passwords[role]]),
    ),
    ...change,
  };
}
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
    purpose: ["morrow_api", "morrow_identity_linking", "morrow_identity_logout"].includes(role)
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
    const { op, args = [], count = 1, path = "/", method = "GET" } = await request.json();
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
        if (op === "unknown") return { ok: true, ...describe(await env.BROKER.unknownMethod()) };
        return { ok: true, ...describe(await env.BROKER[op](...args)) };
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
  const observed = { logs: [], apiProvider: [], brokerProvider: [], neon: 0, unexpected: 0 };
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
      },
    },
    ...extra,
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
    body: JSON.stringify({ schemaVersion: 1, workspaceId: "workspace_a" }),
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

{
  const extra = [
    {
      ...options.connector,
      name: names.connector,
      modules: true,
      script: bundle(connectorWorker),
      bindings: { MORROW_ENVIRONMENT: "development" },
    },
  ];
  await instance("AC10_connector_placeholder", { extra }, async ({ mf }) => {
    const connector = await mf.getWorker(names.connector);
    const health = await connector.fetch("https://connector.internal/healthz");
    check(
      "AC10:connector_healthz",
      health.status === 200 &&
        (await health.text()) === '{"schemaVersion":1,"service":"connector","mode":"placeholder"}',
    );
    for (const path of ["/", "/auth", "/webhooks/app"]) {
      const response = await connector.fetch("https://connector.internal" + path, {
        method: "POST",
      });
      check(
        "AC10:connector_503" + path,
        response.status === 503 && (await response.text()) === '{"code":"connector_unavailable"}',
      );
    }
  });
}
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
