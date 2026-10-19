// P04.T02a PostgreSQL 17 lab: the configured journey through the real wrangler
// dry-run bundles of the api and broker, over the WSS->TCP bridge into an
// isolated PostgreSQL 17 engine (migrations 0001-0013, restricted roles, test-only
// LOGIN with random passwords held only by the broker). Synthetic WorkOS; no
// account, credential or network. Linux CI only (the `pgwire` job), like the
// other PG-wire labs; `edge-postgresql-local.mjs` runs the same journeys on a
// developer machine as supporting evidence only. Covers AC13, AC17, AC18 (second
// half), AC19, AC20, AC26 (login 200 half) and AC27.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Log, LogLevel, Miniflare } from "miniflare";
import { tsImport } from "tsx/esm/api";
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
import { managedWorkspacePostgresqlLab } from "./fixtures/controlled-neon-postgresql.mjs";
import { createControlledNeonTcpService } from "./fixtures/controlled-neon-tcp-bridge.mjs";
import {
  controlledNeonWireBinding,
  createPgFrontendParser,
} from "./fixtures/controlled-neon-pg-wire-oracle.mjs";
import { createPlatformWorkosProviderOracle } from "./fixtures/fixed-workos-platform-provider.mjs";
import { createBoundedLoginCookieJar } from "./fixtures/login-https.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const held = (code = "HELD") => Error("EDGE_POSTGRESQL_LAB_" + code);
const require = (condition, code) => {
  if (!condition) throw held(code);
};
// Account login and signup (P05.T01x): the selection role left; the onboarding executor joined.
export const edgePostgresqlRoles = Object.freeze([
  "morrow_identity_login",
  "morrow_identity_preauth",
  "morrow_identity_sessions",
  "morrow_api",
  "morrow_identity_linking",
  "morrow_identity_logout",
  "morrow_identity_onboarding",
]);
const roles = edgePostgresqlRoles;
const literal = (value) => {
  require(typeof value === "string" && value.length <= 16384, "LITERAL");
  return "'" + value.replaceAll("'", "''") + "'";
};

// Test-side administrator fixture over the engine's local Unix socket (as in the
// workspace API PostgreSQL lab): never reachable from the Workers, never a
// credential path for the application. SQL goes over stdin, not arguments.
function fixtureAdministratorSql(engineId, sql) {
  require(/^[a-f0-9]{64}$/.test(engineId) && Buffer.byteLength(sql) <= 65536, "FIXTURE_SQL");
  const result = spawnSync(
    "docker",
    [
      "exec",
      "--interactive",
      engineId,
      "psql",
      "-X",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "morrow",
    ],
    // Docker on a loaded developer machine can take tens of seconds per exec.
    { input: sql, encoding: "utf8", timeout: 60000, maxBuffer: 1048576 },
  );
  require(!result.error && result.status === 0, "FIXTURE_SQL_FAILED");
  return result.stdout.trim();
}

// The journeys, given an owned engine and the matching WSS->TCP service factory.
// `hook` (P14.T01a) lets the browser lab reuse this setup unchanged: `origin` and
// `listen` give the api a real HTTPS listener on an ephemeral port, and `journeys`
// replaces the P04 scenarios; the cleanup and marker checks stay shared. `work`
// (P14.T01a PR-2) also applies the work role prerequisites and migrations 0014-0015
// before the seal, so the api's /workspace/:ws/work routes reach PostgreSQL as
// morrow_api_worker; the engine must then log in that role too.
export async function edgePostgresqlJourneys(engine, createService, hook = {}) {
  const work = hook.work === true;
  const migrationCount = work ? 15 : 13;
  const checks = [];
  const cases = [];
  // privateMarkers: never in the report, logs or results. credentialMarkers (a
  // subset: key, passwords, keyring material, codes, tokens) also never in any
  // response body, Set-Cookie or Location header.
  const privateMarkers = [];
  const credentialMarkers = ["platform_dropped_refresh_marker"];
  const secret = (...values) => {
    credentialMarkers.push(...values);
    privateMarkers.push(...values);
  };
  const responses = [];
  const instances = new Set();
  let stage = "fixture";
  const check = (name, passed) => {
    checks.push({ name, passed: passed === true });
    return passed === true;
  };
  const { createSelfLogoutFixtureHarness } = await tsImport(
    "./fixtures/self-logout-fixture.mjs",
    import.meta.url,
  );
  const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
  // The login fixture applies 0001-0013 (0013 is account onboarding); those entries must
  // be present in order and checksum-verified. Later manifest entries are not applied.
  require(manifest.migrations.length >= migrationCount, "MIGRATION_COUNT");
  const appliedManifest = manifest.migrations.slice(0, migrationCount);
  for (const [i, row] of appliedManifest.entries())
    require(row.sequence === i + 1 &&
      hash(readFileSync("migrations/" + row.file)) === row.sha256, "MIGRATION_DRIFT");
  const migrationSql = new Map(
    appliedManifest.map((row) => [
      "SET ROLE " +
        (row.executeAs ?? "morrow_identity_owner") +
        ";\n" +
        readFileSync("migrations/" + row.file, "utf8"),
      row.sequence,
    ]),
  );
  let appliedMigrations = 0;
  const harness = createSelfLogoutFixtureHarness(
    {
      id: engine.id,
      sql(text, database) {
        const sequence = migrationSql.get(text);
        if (sequence !== undefined) require(sequence === appliedMigrations + 1, "MIGRATION_ORDER");
        const result = engine.sql(text, database);
        if (sequence !== undefined) appliedMigrations = sequence;
        return result;
      },
    },
    { accountOnboarding: true },
  );
  // Work (P06.T01a): the reviewed role prerequisites, then 0014 and 0015 with their
  // manifest `executeAs`, through the same order-checking adapter.
  if (work) {
    engine.sql(readFileSync("infra/work-role-prerequisites.sql", "utf8"), "morrow");
    for (const [text, sequence] of migrationSql)
      if (sequence > 13) {
        require(sequence === appliedMigrations + 1, "MIGRATION_ORDER");
        engine.sql(text, "morrow");
        appliedMigrations = sequence;
      }
  }
  const origin = hook.origin ?? "https://127.0.0.1";
  const configuration = harness.configured({ origin });
  const f = configuration.f;
  const keyMarker = ["sk", "test", randomBytes(16).toString("hex")].join("_");
  const fault = {};
  const oracle = createPlatformWorkosProviderOracle({
    configurationJson: configuration.configurationJson,
    subjectId: f.subject,
    providerSessionId: f.sid,
    now: Date.now,
    managementMarker: keyMarker,
    fault,
  });
  const day = 86400000;
  const ring = (fromMs, untilMs) => {
    const keyId = randomUUID();
    const material = randomBytes(32).toString("base64url");
    secret(material);
    return JSON.stringify({
      schemaVersion: 1,
      purpose: "morrow.login.capsule/1",
      configurationDigest: configuration.configurationDigest,
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
  };
  // The engine logs in the seven identity roles. Without `work` the P06.T01a work login
  // has no role in this engine and no journey borrows it; the broker still requires its
  // secret. With `work` the engine logs it in too, and the broker gets its password.
  const passwords = { ...engine.passwordByRole };
  require(!work || typeof passwords.morrow_api_worker === "string", "WORK_LOGIN_ROLE");
  const workLoginPassword =
    passwords.morrow_api_worker ?? "Edge-work-" + randomBytes(18).toString("base64url");
  secret(keyMarker, workLoginPassword, ...Object.values(passwords));
  const databaseBinding = { ...controlledNeonWireBinding, environment: "development" };
  const apiBindings = (change = {}) => ({
    MORROW_ENVIRONMENT: "development",
    LOGIN_CONFIGURATION_JSON: configuration.configurationJson,
    WORKSPACE_CONFIGURATION_JSON: JSON.stringify({ schemaVersion: 1, mode: "https", origin }),
    LOGOUT_CONFIGURATION_JSON: harness.logoutConfiguration(configuration),
    MORROW_DATABASE_BINDING_JSON: JSON.stringify(databaseBinding),
    LOGIN_CAPSULE_KEYRING: ring(Date.now() - 300000, Date.now() + 90 * day),
    ...change,
  });
  const brokerBindings = (change = {}) => ({
    MORROW_ENVIRONMENT: "development",
    LOGIN_CONFIGURATION_JSON: configuration.configurationJson,
    MORROW_DATABASE_BINDING_JSON: JSON.stringify(databaseBinding),
    WORKOS_API_KEY: keyMarker,
    ...Object.fromEntries(
      roles.map((role) => ["MORROW_DB_PASSWORD_" + role.toUpperCase(), passwords[role]]),
    ),
    MORROW_DB_PASSWORD_MORROW_API_WORKER: workLoginPassword,
    ...change,
  });

  stage = "seal";
  const sealed = await engine.sealSetup();
  if (work) {
    check("all_fifteen_unchanged_migrations", appliedMigrations === 15);
    check("eight_scram_roles", sealed.scramOfferedRoles === 8);
  } else {
    check("all_thirteen_unchanged_migrations", appliedMigrations === 13);
    check("seven_scram_roles", sealed.scramOfferedRoles === 7);
  }

  // Passive PG-wire observation of every bridged connection: the startup role.
  // One bridge service admits at most 256 bridges over its life, and the
  // wrong-secret matrix alone opens more, so a fresh service takes over between
  // scenarios and matrix rounds (never inside one journey). Old services stay open
  // until cleanup, so connections that instances still hold are never cut.
  const services = [];
  let service;
  const startService = () => {
    const parsers = new Map();
    service = createService({
      endpoint: engine.endpoint,
      hostname: controlledNeonWireBinding.hostname,
      onClientBytes(bytes, observation) {
        let parser = parsers.get(observation.index);
        if (!parser) {
          parser = createPgFrontendParser({
            onStartup({ parameters }) {
              observation.startup = { user: parameters.user, database: parameters.database };
            },
            onMessage() {},
          });
          parsers.set(observation.index, parser);
        }
        parser.push(bytes);
      },
      onServerBytes() {},
    });
    services.push(service);
  };
  startService();
  const freshBridgeCapacity = () => {
    if (service.observations.length > 96) startService();
  };
  const bridgedRoles = (from = 0) =>
    new Set(
      service.observations
        .slice(from)
        .map((row) => row.startup?.user)
        .filter(Boolean),
    );

  stage = "bundles";
  ensureWorkspaceDist();
  const scratch = mkdtempSync(join(tmpdir(), "morrow-edge-postgresql-lab-"));
  edgeDryRun({
    outRoot: scratch,
    workers: edgeWorkers.slice(0, 2),
    environments: ["development"],
    report: false,
  });
  const script = (worker) =>
    readFileSync(
      join(scratch, worker.key, "development", basename(worker.entry).replace(/\.ts$/, ".js")),
      "utf8",
    );
  const scripts = { api: script(edgeWorkers[0]), broker: script(edgeWorkers[1]) };
  rmSync(scratch, { recursive: true, force: true });
  const { unstable_getMiniflareWorkerOptions } = await loadWranglerApi();
  const options = (worker) =>
    captureConsole(() => unstable_getMiniflareWorkerOptions(workerConfigPath(worker), undefined))
      .value.workerOptions;
  const apiOptions = options(edgeWorkers[0]);
  const brokerOptions = options(edgeWorkers[1]);

  const outbound = { api: [], broker: [], unexpected: 0 };
  const logs = [];
  const workersFor = (api, broker) => [
    {
      ...apiOptions,
      name: "morrow-development-api",
      modules: true,
      script: scripts.api,
      bindings: api,
      outboundService(request) {
        const url = new URL(request.url);
        if (url.hostname === controlledNeonWireBinding.hostname) return service.outbound(request);
        if (url.origin === "https://api.workos.com") {
          outbound.api.push({
            method: request.method,
            path: url.pathname,
            authorization: request.headers.has("authorization"),
          });
          return oracle.handleRequest(request);
        }
        outbound.unexpected++;
        return new Response(null, { status: 503 });
      },
    },
    {
      ...brokerOptions,
      name: "morrow-development-broker",
      modules: true,
      script: scripts.broker,
      bindings: broker,
      outboundService(request) {
        const url = new URL(request.url);
        if (url.origin === "https://api.workos.com") {
          outbound.broker.push({
            method: request.method,
            path: url.pathname,
            authorization: request.headers.get("authorization") === "Bearer " + keyMarker,
          });
          return oracle.handleRequest(request);
        }
        outbound.unexpected++;
        return new Response(null, { status: 503 });
      },
    },
  ];
  async function instance(api = apiBindings(), broker = brokerBindings()) {
    const mf = new Miniflare({
      ...hook.listen,
      workers: workersFor(api, broker),
      upstream: origin,
      cf: { colo: "LAB", country: "US", asn: 0 },
      log: new Log(LogLevel.NONE),
      handleStructuredLogs({ message }) {
        if (typeof message === "string" && message.startsWith("{"))
          try {
            logs.push(JSON.parse(message));
          } catch {}
      },
    });
    instances.add(mf);
    await mf.ready;
    const fetch = async (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (init.body !== undefined && !headers.has("Content-Length"))
        headers.set("Content-Length", String(Buffer.byteLength(init.body)));
      const response = await mf.dispatchFetch(origin + path, {
        redirect: "manual",
        ...init,
        headers,
      });
      const body = await response.text();
      responses.push({
        body,
        setCookie: response.headers.getSetCookie(),
        location: response.headers.get("location"),
      });
      return { status: response.status, headers: response.headers, body };
    };
    return {
      fetch,
      url: async () => mf.ready,
      setBroker: (bindings) =>
        mf.setOptions({
          ...hook.listen,
          workers: workersFor(api, bindings),
          upstream: origin,
          cf: { colo: "LAB", country: "US", asn: 0 },
          log: new Log(LogLevel.NONE),
          handleStructuredLogs({ message }) {
            if (typeof message === "string" && message.startsWith("{"))
              try {
                logs.push(JSON.parse(message));
              } catch {}
          },
        }),
      async dispose() {
        instances.delete(mf);
        await mf.dispose();
      },
    };
  }
  const json = (body) => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  };
  const jsonHeaders = (response) =>
    response.headers.get("cache-control") === "no-store" &&
    response.headers.get("x-content-type-options") === "nosniff" &&
    response.headers.get("referrer-policy") === "no-referrer";
  // 0010 admits at most 10 new login flows per 10 seconds per environment and
  // profile (`rate_limited`); every start, from any instance, stays below that.
  const loginStarts = [];
  async function startLogin(owner) {
    for (;;) {
      const recent = loginStarts.filter((at) => at > Date.now() - 10500);
      if (recent.length < 8) break;
      await new Promise((resolve) => setTimeout(resolve, recent[0] + 10600 - Date.now()));
    }
    loginStarts.push(Date.now());
    return owner.fetch("/auth/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Morrow-Request": "1" },
      body: JSON.stringify({ schemaVersion: 2 }),
    });
  }
  const callback = (owner, url, cookie) =>
    owner.fetch(url.pathname + url.search, {
      headers: {
        Cookie: cookie,
        "Sec-Fetch-Mode": "navigate",
        "MF-Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Site": "cross-site",
      },
    });
  const bootstrap = (owner, cookie) =>
    owner.fetch("/workspace/" + f.workspace + "/bootstrap", {
      headers: cookie ? { Cookie: cookie } : {},
    });
  async function signIn(owner, label) {
    const jar = createBoundedLoginCookieJar();
    const started = await startLogin(owner);
    const loginCode = label + "_LOGIN_" + started.status;
    require(started.status === 200 &&
      jar.ingest(origin + "/auth/login", started.headers).accepted === 1, loginCode);
    const armed = oracle.arm(json(started.body).authorizationUrl);
    secret(armed.code, armed.token);
    const callbackUrl = new URL(armed.callbackUrl);
    const finished = await callback(owner, callbackUrl, jar.header(armed.callbackUrl));
    require(finished.status === 303 &&
      jar.ingest(armed.callbackUrl, finished.headers).accepted === 1, label + "_CALLBACK");
    const cookie = jar.header(origin + "/");
    privateMarkers.push(cookie);
    return cookie;
  }
  async function scenario(name, run) {
    const before = checks.length;
    let failure = null;
    stage = name;
    freshBridgeCapacity();
    try {
      await run();
    } catch (error) {
      failure = String(error?.message ?? error).slice(0, 200);
    }
    const own = checks.slice(before);
    cases.push({
      name,
      passed: failure === null && own.every((row) => row.passed),
      failure,
      checks: own.length,
    });
  }

  const linkStatus = (owner, cookie) =>
    owner.fetch("/workspace/" + f.workspace + "/store-links/status", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-Morrow-Request": "1",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        handoffToken: randomBytes(32).toString("base64url").slice(0, 42) + "A",
      }),
    });
  // The account routes (P05.T01x): the owner-seeded person lists its workspace and is
  // not eligible to sign up, so a healthy signup answers 403 through the onboarding role.
  const workspaces = (owner, cookie) =>
    owner.fetch("/workspaces", { headers: { Cookie: cookie, "X-Morrow-Request": "1" } });
  const signup = (owner, cookie) =>
    owner.fetch("/organizations", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-Morrow-Request": "1",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({ schemaVersion: 1, organizationName: "Edge", workspaceName: "Main" }),
    });
  const logout = (owner, cookie) =>
    owner.fetch("/auth/logout", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-Morrow-Request": "1",
      },
      body: JSON.stringify({ schemaVersion: 1 }),
    });

  // AC17 steps 1-5, with AC13 (WorkOS calls) and AC19 (borrowed roles) measured
  // over the same journey, on one fresh instance.
  async function journey(owner, label) {
    const name = (suffix) => label + ":" + suffix;
    const firstBridge = service.observations.length;
    const apiFrom = outbound.api.length;
    const brokerFrom = outbound.broker.length;
    const jar = createBoundedLoginCookieJar();
    const started = await startLogin(owner);
    const authorizationUrl = json(started.body)?.authorizationUrl ?? "";
    const authorization = new URL(authorizationUrl || "https://invalid.example/");
    check(
      name("1_authorization_url"),
      started.status === 200 &&
        Object.keys(json(started.body)).join() === "schemaVersion,authorizationUrl" &&
        authorization.origin + authorization.pathname ===
          "https://api.workos.com/user_management/authorize" &&
        [...authorization.searchParams.keys()].join() ===
          "client_id,redirect_uri,response_type,provider,state,code_challenge,code_challenge_method" &&
        authorization.searchParams.get("client_id") === f.client &&
        authorization.searchParams.get("redirect_uri") === origin + "/auth/workos/callback" &&
        authorization.searchParams.get("response_type") === "code" &&
        authorization.searchParams.get("provider") === "authkit" &&
        authorization.searchParams.get("code_challenge_method") === "S256",
    );
    const loginCookies = started.headers.getSetCookie();
    const loginAge =
      /^__Host-morrow_login=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=(\d+)$/.exec(
        loginCookies[0] ?? "",
      );
    check(
      name("1_one_login_cookie"),
      loginCookies.length === 1 &&
        !!loginAge &&
        Number(loginAge[1]) >= 1 &&
        Number(loginAge[1]) <= 300,
    );
    check(name("1_json_headers"), jsonHeaders(started));
    require(jar.ingest(origin + "/auth/login", started.headers).accepted === 1, "JAR_LOGIN");
    const armed = oracle.arm(authorizationUrl);
    secret(armed.code, armed.token);
    privateMarkers.push(authorizationUrl);
    const callbackUrl = new URL(armed.callbackUrl);
    const finished = await callback(owner, callbackUrl, jar.header(armed.callbackUrl));
    const sessionCookies = finished.headers.getSetCookie();
    const sessionAge =
      /^__Host-morrow_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=(\d+)$/.exec(
        sessionCookies[0] ?? "",
      );
    check(
      name("2_callback_session_cookie"),
      finished.status === 303 &&
        finished.headers.get("location") === "/" &&
        sessionCookies.length === 1 &&
        !!sessionAge &&
        Number(sessionAge[1]) >= 1 &&
        Number(sessionAge[1]) <= 900 &&
        !/domain=/i.test(sessionCookies[0]),
    );
    require(jar.ingest(armed.callbackUrl, finished.headers).accepted === 1, "JAR_SESSION");
    const cookie = jar.header(origin + "/");
    privateMarkers.push(cookie);
    const boot = await bootstrap(owner, cookie);
    const body = json(boot.body);
    check(
      name("3_bootstrap"),
      boot.status === 200 &&
        Object.keys(body ?? {})
          .sort()
          .join() === "policyRevision,schemaVersion,workspace" &&
        Object.keys(body.workspace ?? {})
          .sort()
          .join() === "displayName,id" &&
        body.workspace.id === f.workspace &&
        !boot.headers.has("set-cookie") &&
        jsonHeaders(boot),
    );
    // P05.T01x account routes over the deployable bundle and real PostgreSQL 17.
    const listed = await workspaces(owner, cookie);
    const overview = json(listed.body);
    check(
      name("3a_account_list"),
      listed.status === 200 &&
        overview?.schemaVersion === 1 &&
        overview.onboarding === "unavailable" &&
        overview.truncated === false &&
        overview.workspaces.length === 1 &&
        overview.workspaces[0].workspaceId === f.workspace &&
        !listed.headers.has("set-cookie") &&
        jsonHeaders(listed),
    );
    const refused = await signup(owner, cookie);
    check(
      name("3b_owner_seeded_signup_unavailable"),
      refused.status === 403 &&
        refused.body === '{"schemaVersion":1,"outcome":"signup_unavailable"}' &&
        !refused.headers.has("set-cookie") &&
        jsonHeaders(refused),
    );
    // The status route is POST with Idempotency-Key and a handoffToken body.
    const status = await linkStatus(owner, cookie);
    check(
      name("4_unknown_link_status"),
      status.status === 404 &&
        status.body === '{"code":"linking_not_found"}' &&
        jsonHeaders(status),
    );
    const ended = await logout(owner, cookie);
    check(
      name("5_logout"),
      ended.status === 200 &&
        ended.body === '{"schemaVersion":1,"outcome":"session_ended"}' &&
        !ended.headers.has("set-cookie") &&
        jsonHeaders(ended),
    );
    check(name("5_bootstrap_after_logout_401"), (await bootstrap(owner, cookie)).status === 401);
    check(
      name("AC13_api_workos_calls_keyless"),
      JSON.stringify(outbound.api.slice(apiFrom)) ===
        JSON.stringify([
          { method: "POST", path: "/user_management/authenticate", authorization: false },
          { method: "GET", path: "/sso/jwks/" + f.client, authorization: false },
        ]),
    );
    const brokerCalls = outbound.broker.slice(brokerFrom);
    check(
      name("AC13_broker_only_keyed_sessions_get"),
      brokerCalls.length === 1 &&
        brokerCalls[0].method === "GET" &&
        brokerCalls[0].path === "/user_management/users/" + f.subject + "/sessions" &&
        brokerCalls[0].authorization === true,
    );
    const used = bridgedRoles(firstBridge);
    check(
      name("AC19_borrowed_roles_equal_allowlist"),
      used.size === roles.length && roles.every((role) => used.has(role)),
    );
    check(
      name("AC19_no_unexpected_outbound"),
      outbound.unexpected === 0 && oracle.metrics.oracleFailures === 0,
    );
  }

  if (hook.journeys) {
    await hook.journeys({
      check,
      scenario,
      instance,
      oracle,
      f,
      origin,
      secret,
      privateMarkers,
      outbound,
      bootstrap,
      json,
      // Owner fixture SQL after the seal (test side only, over the engine's local socket).
      adminSql: (sql) => fixtureAdministratorSql(engine.id, sql),
    });
    return finish(null);
  }

  let session = null;
  await scenario("AC17_AC13_AC19_configured_journey", async () => {
    const owner = await instance();
    try {
      await journey(owner, "AC17");
    } finally {
      await owner.dispose();
    }
  });

  // AC19: one wrong role secret at a time fails only that role's routes, each with
  // its existing failure response. Every flow starts on a correctly configured
  // instance that shares the api bindings (and so the capsule keyring); each route
  // then runs on the instance whose broker holds the one wrong password.
  const routeOutcome = {
    login: (r) =>
      r.status === 200
        ? "ok"
        : r.status === 503 && r.body === '{"schemaVersion":1,"outcome":"login_unavailable"}'
          ? "unavailable"
          : null,
    callback: (r) =>
      r.status === 303 && r.headers.get("location") === "/" && r.headers.getSetCookie().length === 1
        ? "ok"
        : r.status === 303 &&
            r.headers.get("location") === "/auth/result" &&
            r.headers.getSetCookie().length === 0
          ? "result_page"
          : null,
    bootstrap: (r) =>
      r.status === 200
        ? "ok"
        : r.status === 503 && r.body === '{"code":"unavailable"}'
          ? "unavailable"
          : null,
    linkStatus: (r) =>
      r.status === 404 && r.body === '{"code":"linking_not_found"}'
        ? "ok"
        : r.status === 503 && r.body === '{"code":"unavailable"}'
          ? "unavailable"
          : null,
    logout: (r) =>
      r.status === 200 && r.body === '{"schemaVersion":1,"outcome":"session_ended"}'
        ? "ok"
        : r.status === 503 && r.body === '{"schemaVersion":1,"outcome":"logout_unavailable"}'
          ? "unavailable"
          : null,
    workspaces: (r) =>
      r.status === 200 &&
      json(r.body)?.onboarding === "unavailable" &&
      json(r.body)?.workspaces?.[0]?.workspaceId === f.workspace &&
      r.headers.getSetCookie().length === 0
        ? "ok"
        : r.status === 503 && r.body === '{"code":"unavailable"}'
          ? "unavailable"
          : null,
    signup: (r) =>
      r.status === 403 && r.body === '{"schemaVersion":1,"outcome":"signup_unavailable"}'
        ? "ok"
        : r.status === 503 && r.body === '{"code":"unavailable"}'
          ? "unavailable"
          : null,
  };
  const classify = (route, response) =>
    routeOutcome[route](response) ??
    "unexpected_" +
      response.status +
      (response.status >= 400 ? "_" + response.body.slice(0, 80) : "");
  const healthy = {
    login: "ok",
    callback: "ok",
    bootstrap: "ok",
    linkStatus: "ok",
    logout: "ok",
    workspaces: "ok",
    signup: "ok",
  };
  const expectedWrongSecret = Object.freeze({
    morrow_identity_login: { ...healthy, login: "unavailable", callback: "result_page" },
    morrow_identity_preauth: { ...healthy, login: "unavailable", callback: "result_page" },
    morrow_identity_sessions: { ...healthy, callback: "result_page" },
    morrow_api: { ...healthy, bootstrap: "unavailable", workspaces: "unavailable" },
    morrow_identity_linking: { ...healthy, linkStatus: "unavailable" },
    morrow_identity_logout: { ...healthy, logout: "unavailable" },
    morrow_identity_onboarding: { ...healthy, signup: "unavailable" },
  });
  const wrongSecretMatrix = {};
  await scenario("AC19_one_wrong_role_secret_fails_only_its_routes", async () => {
    const sharedApi = apiBindings();
    const good = await instance(sharedApi);
    try {
      session = await signIn(good, "GOOD");
      for (const role of roles) {
        freshBridgeCapacity();
        const wrongPassword = "Wrong-" + randomBytes(16).toString("hex");
        secret(wrongPassword);
        const logoutSession = await signIn(good, "LOGOUT");
        const wrong = await instance(
          sharedApi,
          brokerBindings({ ["MORROW_DB_PASSWORD_" + role.toUpperCase()]: wrongPassword }),
        );
        try {
          const started = await startLogin(wrong);
          const login = classify("login", started);
          // The callback uses the wrong instance's own flow, or one from the good
          // instance when this role's secret breaks login start.
          const jar = createBoundedLoginCookieJar();
          const begun = login === "ok" ? started : await startLogin(good);
          require(begun.status === 200 &&
            jar.ingest(origin + "/auth/login", begun.headers).accepted === 1, "MATRIX_LOGIN");
          const armed = oracle.arm(json(begun.body).authorizationUrl);
          secret(armed.code, armed.token);
          const outcome = {
            login,
            callback: classify(
              "callback",
              await callback(wrong, new URL(armed.callbackUrl), jar.header(armed.callbackUrl)),
            ),
            bootstrap: classify("bootstrap", await bootstrap(wrong, session)),
            linkStatus: classify("linkStatus", await linkStatus(wrong, session)),
            logout: classify("logout", await logout(wrong, logoutSession)),
            workspaces: classify("workspaces", await workspaces(wrong, session)),
            signup: classify("signup", await signup(wrong, session)),
          };
          wrongSecretMatrix[role] = outcome;
          check(
            "AC19:wrong_" + role + "_fails_only_its_routes",
            JSON.stringify(outcome) === JSON.stringify(expectedWrongSecret[role]),
          );
        } finally {
          await wrong.dispose();
        }
      }
      check("AC19:session_survives_the_matrix", (await bootstrap(good, session)).status === 200);
    } finally {
      await good.dispose();
    }
  });

  await scenario("AC18_client_drift_denies_session_catalogue", async () => {
    const otherClient = "client_" + "9".repeat(26);
    const drifted = configuration.configurationJson.replaceAll(f.client, otherClient);
    const owner = await instance(
      apiBindings(),
      brokerBindings({ LOGIN_CONFIGURATION_JSON: drifted }),
    );
    try {
      const pages = oracle.metrics.sessionPage;
      const jar = createBoundedLoginCookieJar();
      const started = await startLogin(owner);
      require(started.status === 200 &&
        jar.ingest(origin + "/auth/login", started.headers).accepted === 1, "DRIFT_LOGIN");
      const armed = oracle.arm(json(started.body).authorizationUrl);
      secret(armed.code, armed.token);
      const finished = await callback(
        owner,
        new URL(armed.callbackUrl),
        jar.header(armed.callbackUrl),
      );
      check(
        "AC18:callback_result_page",
        finished.status === 303 &&
          finished.headers.get("location") === "/auth/result" &&
          finished.headers.getSetCookie().length === 0,
      );
      check("AC18:sessions_endpoint_zero_requests", oracle.metrics.sessionPage === pages);
      check(
        "AC18:namespace_denied",
        logs.some(
          (row) =>
            row.event === "morrow_broker" &&
            row.method === "workosSessionPage" &&
            row.code === "NAMESPACE_DENIED",
        ),
      );
    } finally {
      await owner.dispose();
    }
  });

  await scenario("AC27_unknown_exchange_never_retried", async () => {
    const owner = await instance();
    const exchanges = () =>
      outbound.api.filter((row) => row.path === "/user_management/authenticate").length;
    try {
      const posts = exchanges();
      const failures = oracle.metrics.oracleFailures;
      const jar = createBoundedLoginCookieJar();
      const started = await startLogin(owner);
      require(started.status === 200 &&
        jar.ingest(origin + "/auth/login", started.headers).accepted === 1, "UNKNOWN_LOGIN");
      const armed = oracle.arm(json(started.body).authorizationUrl);
      secret(armed.code, armed.token);
      fault.kind = "exchange";
      fault.delayMs = 11000;
      const url = new URL(armed.callbackUrl);
      const cookie = jar.header(armed.callbackUrl);
      const first = await callback(owner, url, cookie);
      check(
        "AC27:held_exchange_result_page",
        first.status === 303 && first.headers.get("location") === "/auth/result",
      );
      const replay = await callback(owner, url, cookie);
      check(
        "AC27:replay_result_page",
        replay.status === 303 && replay.headers.get("location") === "/auth/result",
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      check(
        "AC27:exactly_one_post",
        exchanges() === posts + 1 && oracle.metrics.oracleFailures === failures,
      );
    } finally {
      delete fault.kind;
      delete fault.delayMs;
      await owner.dispose();
    }
  });

  await scenario("AC26_ten_days_left_login_200", async () => {
    const owner = await instance(
      apiBindings({ LOGIN_CAPSULE_KEYRING: ring(Date.now() - 80 * day, Date.now() + 10 * day) }),
    );
    try {
      const before = logs.filter((row) => row.event === "morrow_api_keyring").length;
      check("AC26:login_200", (await startLogin(owner)).status === 200);
      for (let i = 0; i < 2; i++) {
        const h = await owner.fetch("/healthz");
        check("AC26:healthz_true_" + i, json(h.body)?.ready === true);
      }
      const logged = logs.filter((row) => row.event === "morrow_api_keyring").slice(before);
      check(
        "AC26:expiring_logged_once",
        logged.length === 1 && logged[0].code === "KEYRING_EXPIRING",
      );
    } finally {
      await owner.dispose();
    }
  });

  await scenario("AC20_rotation_precursor", async () => {
    const owner = await instance();
    try {
      require(session, "NO_SESSION");
      check("AC20:bootstrap_before_rotation", (await bootstrap(owner, session)).status === 200);
      const rotated = randomBytes(32).toString("hex");
      secret(rotated);
      fixtureAdministratorSql(
        engine.id,
        "ALTER ROLE morrow_api PASSWORD " + literal(rotated) + ";",
      );
      const stale = await bootstrap(owner, session);
      check(
        "AC20:stale_broker_503",
        stale.status === 503 && stale.body === '{"code":"unavailable"}',
      );
      passwords.morrow_api = rotated;
      await owner.setBroker(brokerBindings());
      check("AC20:broker_restart_only_200", (await bootstrap(owner, session)).status === 200);
    } finally {
      await owner.dispose();
    }
  });

  await scenario("AC19_journey_after_revoke_temp", async () => {
    fixtureAdministratorSql(engine.id, "REVOKE TEMP ON DATABASE morrow FROM PUBLIC;");
    check(
      "AC19:temp_revoked_for_every_runtime_role",
      fixtureAdministratorSql(
        engine.id,
        "SELECT count(*) FROM unnest(ARRAY[" +
          roles.map(literal).join(",") +
          "]) AS r(name) WHERE has_database_privilege(r.name, 'morrow', 'TEMP');",
      ) === "0",
    );
    // The whole AC17 journey (login, callback, bootstrap, link status, logout).
    const owner = await instance();
    try {
      await journey(owner, "AC19_after_revoke_temp");
    } finally {
      await owner.dispose();
    }
  });

  return finish(wrongSecretMatrix);

  // Shared cleanup: dispose every instance and bridge, then the marker checks.
  async function finish(wrongSecretMatrix) {
    stage = "cleanup";
    await Promise.allSettled([...instances].map((mf) => mf.dispose()));
    for (const owned of services) await owned.close?.();
    engine.revokeEndpoint();
    const final = await engine.observeFinalNamespace();
    const evidence = JSON.stringify({ checks, cases, logs, outbound, wrongSecretMatrix });
    check(
      "AC13:no_marker_in_logs_or_results",
      privateMarkers.every((marker) => !marker || !evidence.includes(marker)),
    );
    // Every response the Workers returned: bodies, Set-Cookie and Location headers.
    const returned = JSON.stringify(responses);
    check(
      "AC13:no_credential_marker_in_any_response",
      responses.length > 0 &&
        credentialMarkers.every((marker) => !marker || !returned.includes(marker)),
    );
    responses.length = 0;
    return {
      checks,
      cases,
      wrongSecretMatrix,
      responsesScanned: JSON.parse(returned).length,
      appliedMigrations,
      final,
      stage,
      privateMarkers,
      outbound: {
        api: outbound.api.length,
        broker: outbound.broker.length,
        unexpected: outbound.unexpected,
      },
    };
  }
}

async function main() {
  require(process.version === "v24.13.0", "PINNED_NODE");
  require(edgeRefusals().length === 0, "REFUSED");
  let result = null;
  let failure = null;
  try {
    const measured = await managedWorkspacePostgresqlLab((engine) =>
      edgePostgresqlJourneys(engine, createControlledNeonTcpService),
    );
    result = measured.result;
  } catch (error) {
    failure = {
      code: String(error?.message ?? "EDGE_POSTGRESQL_LAB_HELD").slice(0, 120),
      observation: error?.observation ?? null,
    };
  }
  const passed =
    !failure &&
    result &&
    result.checks.every((row) => row.passed) &&
    result.cases.every((row) => row.passed);
  const report = {
    generated_at: new Date().toISOString(),
    packet: "P04.T02a",
    status: passed ? "passed" : "held",
    scope:
      "Real wrangler 4.116.0 dry-run api and broker bundles in local workerd over the WSS->TCP bridge into isolated PostgreSQL 17 with synthetic WorkOS; not hosted Cloudflare, Neon or WorkOS qualification.",
    appliedMigrations: result?.appliedMigrations ?? null,
    cases: result?.cases ?? [],
    checks: result?.checks ?? [],
    wrongSecretMatrix: result?.wrongSecretMatrix ?? null,
    responsesScanned: result?.responsesScanned ?? null,
    outbound: result?.outbound ?? null,
    finalNamespace: result?.final ?? null,
    failure,
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  const markers = result?.privateMarkers ?? [];
  require(markers.every((marker) => !marker || !text.includes(marker)), "MARKER_IN_REPORT");
  const path = writeArtifact("labs/edge-postgresql.json", text);
  process.stdout.write(
    JSON.stringify({
      report: path,
      status: report.status,
      cases: report.cases.length,
      checks: report.checks.length,
    }) + "\n",
  );
  if (!passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
