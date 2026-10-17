// P04.T02a PostgreSQL 17 lab: the configured journey through the real wrangler
// dry-run bundles of the api and broker, over the WSS->TCP bridge into an
// isolated PostgreSQL 17 engine (migrations 0001-0011, restricted roles, test-only
// LOGIN with random passwords held only by the broker). Synthetic WorkOS; no
// account, credential or network. Linux CI only (the `pgwire` job), like the
// other PG-wire labs. Covers AC13, AC17, AC18 (second half), AC19, AC20, AC26
// (login 200 half) and AC27.
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
const roles = Object.freeze([
  "morrow_identity_login",
  "morrow_identity_preauth",
  "morrow_identity_resolution",
  "morrow_identity_sessions",
  "morrow_api",
  "morrow_identity_linking",
  "morrow_identity_logout",
]);
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
    { input: sql, encoding: "utf8", timeout: 10000, maxBuffer: 1048576 },
  );
  require(!result.error && result.status === 0, "FIXTURE_SQL_FAILED");
  return result.stdout.trim();
}

// The journeys, given an owned engine and the matching WSS->TCP service factory.
export async function edgePostgresqlJourneys(engine, createService) {
  const checks = [];
  const cases = [];
  const privateMarkers = [];
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
  // Exactly the eleven published migrations; a twelfth must update this lab.
  require(manifest.migrations.length === 11, "MIGRATION_COUNT");
  const migrationSql = new Map(
    manifest.migrations.map((row) => [
      "SET ROLE morrow_identity_owner;\n" + readFileSync("migrations/" + row.file, "utf8"),
      row.sequence,
    ]),
  );
  let appliedMigrations = 0;
  const harness = createSelfLogoutFixtureHarness({
    id: engine.id,
    sql(text, database) {
      const sequence = migrationSql.get(text);
      if (sequence !== undefined) require(sequence === appliedMigrations + 1, "MIGRATION_ORDER");
      const result = engine.sql(text, database);
      if (sequence !== undefined) appliedMigrations = sequence;
      return result;
    },
  });
  const origin = "https://127.0.0.1";
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
    privateMarkers.push(material);
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
  const passwords = { ...engine.passwordByRole };
  privateMarkers.push(keyMarker, ...Object.values(passwords));
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
    ...change,
  });

  stage = "seal";
  const sealed = await engine.sealSetup();
  check("all_eleven_unchanged_migrations", appliedMigrations === 11);
  check("seven_scram_roles", sealed.scramOfferedRoles === 7);

  // Passive PG-wire observation of every bridged connection: the startup role.
  const parsers = new Map();
  const service = createService({
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
      return { status: response.status, headers: response.headers, body: await response.text() };
    };
    return {
      fetch,
      setBroker: (bindings) =>
        mf.setOptions({
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
  const startLogin = (owner, workspaceId = f.workspace) =>
    owner.fetch("/auth/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-Morrow-Request": "1" },
      body: JSON.stringify({ schemaVersion: 1, workspaceId }),
    });
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
    require(started.status === 200 &&
      jar.ingest(origin + "/auth/login", started.headers).accepted === 1, label + "_LOGIN");
    const armed = oracle.arm(json(started.body).authorizationUrl);
    privateMarkers.push(armed.code, armed.token);
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

  let session = null;
  await scenario("AC17_AC13_AC19_configured_journey", async () => {
    const owner = await instance();
    try {
      const firstBridge = service.observations.length;
      const jar = createBoundedLoginCookieJar();
      const started = await startLogin(owner);
      const authorizationUrl = json(started.body)?.authorizationUrl ?? "";
      const authorization = new URL(authorizationUrl || "https://invalid.example/");
      check(
        "AC17:1_authorization_url",
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
        "AC17:1_one_login_cookie",
        loginCookies.length === 1 &&
          !!loginAge &&
          Number(loginAge[1]) >= 1 &&
          Number(loginAge[1]) <= 300,
      );
      check("AC17:1_json_headers", jsonHeaders(started));
      require(jar.ingest(origin + "/auth/login", started.headers).accepted === 1, "JAR_LOGIN");
      const armed = oracle.arm(authorizationUrl);
      privateMarkers.push(armed.code, armed.token, authorizationUrl);
      const callbackUrl = new URL(armed.callbackUrl);
      const finished = await callback(owner, callbackUrl, jar.header(armed.callbackUrl));
      const sessionCookies = finished.headers.getSetCookie();
      const sessionAge =
        /^__Host-morrow_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=(\d+)$/.exec(
          sessionCookies[0] ?? "",
        );
      check(
        "AC17:2_callback_session_cookie",
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
        "AC17:3_bootstrap",
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
      const status = await owner.fetch("/workspace/" + f.workspace + "/store-links/status", {
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
      check(
        "AC17:4_unknown_link_status",
        status.status === 404 &&
          status.body === '{"code":"linking_not_found"}' &&
          jsonHeaders(status),
      );
      const logout = await owner.fetch("/auth/logout", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
          "X-Morrow-Request": "1",
        },
        body: JSON.stringify({ schemaVersion: 1 }),
      });
      check(
        "AC17:5_logout",
        logout.status === 200 &&
          logout.body === '{"schemaVersion":1,"outcome":"session_ended"}' &&
          !logout.headers.has("set-cookie") &&
          jsonHeaders(logout),
      );
      check("AC17:5_bootstrap_after_logout_401", (await bootstrap(owner, cookie)).status === 401);
      check(
        "AC13:api_workos_calls_keyless",
        JSON.stringify(outbound.api) ===
          JSON.stringify([
            { method: "POST", path: "/user_management/authenticate", authorization: false },
            { method: "GET", path: "/sso/jwks/" + f.client, authorization: false },
          ]),
      );
      check(
        "AC13:broker_only_keyed_sessions_get",
        outbound.broker.length === 1 &&
          outbound.broker[0].method === "GET" &&
          outbound.broker[0].path === "/user_management/users/" + f.subject + "/sessions" &&
          outbound.broker[0].authorization === true,
      );
      const used = bridgedRoles(firstBridge);
      check(
        "AC19:borrowed_roles_equal_allowlist",
        used.size === roles.length && roles.every((role) => used.has(role)),
      );
      check(
        "AC19:no_unexpected_outbound",
        outbound.unexpected === 0 && oracle.metrics.oracleFailures === 0,
      );
    } finally {
      await owner.dispose();
    }
  });

  await scenario("AC19_one_wrong_role_secret_fails_only_its_routes", async () => {
    const wrongApi = await instance(
      apiBindings(),
      brokerBindings({ MORROW_DB_PASSWORD_MORROW_API: "Wrong-" + randomBytes(16).toString("hex") }),
    );
    try {
      session = await signIn(wrongApi, "WRONG_API");
      check("AC19:login_unaffected_by_morrow_api_secret", typeof session === "string");
      const boot = await bootstrap(wrongApi, session);
      check(
        "AC19:bootstrap_existing_503",
        boot.status === 503 && boot.body === '{"code":"unavailable"}',
      );
    } finally {
      await wrongApi.dispose();
    }
    const wrongLogin = await instance(
      apiBindings(),
      brokerBindings({
        MORROW_DB_PASSWORD_MORROW_IDENTITY_LOGIN: "Wrong-" + randomBytes(16).toString("hex"),
      }),
    );
    try {
      const started = await startLogin(wrongLogin);
      check(
        "AC19:login_existing_503",
        started.status === 503 &&
          started.body === '{"schemaVersion":1,"outcome":"login_unavailable"}',
      );
      check(
        "AC19:bootstrap_unaffected_by_login_secret",
        (await bootstrap(wrongLogin, session)).status === 200,
      );
    } finally {
      await wrongLogin.dispose();
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
      privateMarkers.push(armed.code, armed.token);
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
      privateMarkers.push(armed.code, armed.token);
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
      privateMarkers.push(rotated);
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
    const owner = await instance();
    try {
      const cookie = await signIn(owner, "AFTER_REVOKE");
      check("AC19:bootstrap_after_revoke_temp", (await bootstrap(owner, cookie)).status === 200);
    } finally {
      await owner.dispose();
    }
  });

  stage = "cleanup";
  await Promise.allSettled([...instances].map((mf) => mf.dispose()));
  await service.close?.();
  engine.revokeEndpoint();
  const final = await engine.observeFinalNamespace();
  const evidence = JSON.stringify({ checks, cases, logs, outbound });
  check(
    "AC13:no_marker_in_logs_or_results",
    privateMarkers.every((marker) => !marker || !evidence.includes(marker)),
  );
  return {
    checks,
    cases,
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
