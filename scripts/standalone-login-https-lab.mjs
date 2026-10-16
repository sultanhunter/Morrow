import { createServer, request as httpsRequest } from "node:https";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect as connectSocket } from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWorkspaceApiHttpListener } from "../apps/api/src/workspace-router.ts";
import { createStandaloneLoginBridge } from "../packages/identity/src/standalone-login.ts";
import { loginFlowCustodySql } from "../packages/identity/src/login-flow-custody.ts";
import { authenticationExchangeAdmissionSql } from "../packages/identity/src/authentication-exchange-admission.ts";
import { workspaceSelectionSql } from "../packages/identity/src/workos-workspace-selection.ts";
import { browserSessionAdmissionSql } from "../packages/identity/src/workos-browser-session-admission.ts";
import { identitySql } from "../packages/identity/src/index.ts";
import { createStandaloneWorkspaceBootstrap } from "../packages/identity/src/standalone-workspace-bootstrap.ts";
import { createStandaloneStoreLinking } from "../packages/identity/src/standalone-store-linking.ts";
import { workspaceStoreLinkingControlSql } from "../packages/identity/src/workspace-store-linking-control.ts";
import { workspaceStoreLinkingSql } from "../packages/identity/src/workspace-store-linking.ts";
import { createStandaloneLoginFixtureHarness } from "./fixtures/standalone-login-fixture.mjs";
import {
  createLocalLoginTlsFixture,
  createBoundedLoginCookieJar,
} from "./fixtures/login-https.mjs";
import { createSyntheticLoginProvider } from "./fixtures/login-provider.mjs";
import { seedStandaloneLinkingFixture } from "./fixtures/standalone-linking-fixture.mjs";
import { standaloneSqlLiteral as lit } from "./standalone-session-fixtures.mjs";
import { localStandaloneSqlPool } from "./local-standalone-sql.mjs";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
let diagnostic = () => {};
const checks = [],
  check = (name, value) => {
    if (!value || !/^[a-z][a-z0-9_]{1,119}$/.test(name) || checks.some((x) => x.name === name)) {
      // Check names are source-owned constants/fixed variants, never request or SQL fields.
      console.error(
        "LOGIN_HTTPS_FAILED_CHECK:" +
          (typeof name === "string" && /^[a-z][a-z0-9_]{1,119}$/.test(name)
            ? name
            : "invalid_check_name"),
      );
      diagnostic();
      throw Error("LOGIN_HTTPS_LAB_FAILED:" + name);
    }
    checks.push({ name, passed: true });
  };
let phase = "setup";
const setPhase = (value) => {
  phase = value;
  console.error("LOGIN_HTTPS_PHASE:" + value);
};
const deferred = () => Promise.withResolvers();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, timeout = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          diagnostic();
          reject(Error("LOGIN_HTTPS_LAB_TIMEOUT:" + phase));
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const paths = [
  "scripts/standalone-login-https-lab.mjs",
  "scripts/fixtures/login-https.mjs",
  "scripts/fixtures/login-provider.mjs",
  "scripts/fixtures/standalone-login-fixture.mjs",
  "scripts/fixtures/standalone-linking-fixture.mjs",
  "scripts/standalone-session-fixtures.mjs",
  "scripts/local-login-flow-sql.mjs",
  "scripts/local-standalone-sql.mjs",
  "scripts/local-browser-session-sql.mjs",
  "scripts/local-postgres-lab.mjs",
  "apps/api/src/auth-http.ts",
  "apps/api/src/workspace-router.ts",
  "apps/api/src/workspace-http.ts",
  "packages/identity/src/standalone-login.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/login-preauth-control.ts",
  "packages/identity/src/login-flow-custody.ts",
  "packages/identity/src/authentication-exchange-admission.ts",
  "packages/identity/src/workos-workspace-selection.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-session-token.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/identity/src/index.ts",
  "packages/identity/src/standalone-request-guard.ts",
  "packages/identity/src/standalone-workspace-bootstrap.ts",
  "packages/identity/src/standalone-store-linking.ts",
  "packages/identity/src/workspace-store-linking-control.ts",
  "packages/identity/src/workspace-store-linking.ts",
  "packages/policy/src/index.ts",
  "packages/contracts/src/index.ts",
  "packages/contracts/src/validation.ts",
  "packages/contracts/src/generated/runtime-validators.mjs",
  "tests/fixtures/workos-authentication-evidence.mjs",
  "infra/identity-role-prerequisites.sql",
  "infra/identity-login-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  "docs/plan/source.json",
  "docs/plan/build-plan.md",
  "docs/packets/P05.T01p.md",
  "docs/packets/P05.T01r.md",
  "docs/packets/P05.T01s.md",
  "docs/packets/P05.T01t.md",
  ".nvmrc",
  "package.json",
  "package-lock.json",
  "packages/identity/package.json",
  "packages/contracts/package.json",
  "tsconfig.base.json",
];
const plan = JSON.parse(readFileSync("docs/plan/source.json", "utf8")).sources.plan;
if (
  process.version !== "v24.13.0" ||
  plan.sequence !== 89 ||
  hash(readFileSync(plan.path)) !== plan.sha256
)
  throw Error("LOGIN_HTTPS_LAB_SOURCE_REQUIRED");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
if (manifest.migrations.length < 10) throw Error("LOGIN_HTTPS_LAB_TEN_MIGRATIONS_REQUIRED");
for (const [i, entry] of manifest.migrations.slice(0, 10).entries()) {
  if (entry.sequence !== i + 1 || hash(readFileSync("migrations/" + entry.file)) !== entry.sha256)
    throw Error("LOGIN_HTTPS_LAB_MIGRATION_HASH");
  paths.push("migrations/" + entry.file);
}
const sourceDigests = Object.fromEntries(paths.map((path) => [path, hash(readFileSync(path))]));
const tls = await createLocalLoginTlsFixture();
const privateMarkers = [],
  responseBodies = [],
  cases = [],
  readPools = [],
  holderCleanup = [];
let ownedContainer,
  httpsClosed = false,
  httpClosed = false,
  tlsCleanup;
let measured;
try {
  measured = await localPostgresLab("P05.T01p-https", async (engine) => {
    ownedContainer = engine.id;
    const h = createStandaloneLoginFixtureHarness(engine);
    const openHolder = async () => {
      const applicationName = "morrow_login_https_holder_" + randomUUID().replaceAll("-", "");
      const child = spawn(
        "docker",
        [
          "exec",
          "--env",
          "PGAPPNAME=" + applicationName,
          "--interactive",
          engine.id,
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
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let pending = null,
        buffer = "",
        total = 0;
      const finished = new Promise((resolve) =>
        child.once("close", (code, signal) => {
          if (pending) {
            clearTimeout(pending.timer);
            pending.reject(Error("LOGIN_HTTPS_WAIT_HOLDER_UNAVAILABLE"));
            pending = null;
          }
          resolve({ code, signal });
        }),
      );
      child.once("error", () => {
        if (pending) {
          pending.reject(Error("LOGIN_HTTPS_WAIT_HOLDER_UNAVAILABLE"));
          pending = null;
        }
      });
      child.stdin.on("error", () => {});
      child.stderr.on("data", () => {});
      child.stdout.on("data", (chunk) => {
        total += chunk.length;
        buffer += chunk.toString("utf8");
        if (total > 65536) {
          child.kill("SIGKILL");
          return;
        }
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"),
            line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!pending) continue;
          if (line === pending.marker) {
            const p = pending;
            pending = null;
            clearTimeout(p.timer);
            p.resolve(p.lines.join("\n"));
          } else if (line) pending.lines.push(line);
        }
      });
      const run = (text) =>
        new Promise((resolve, reject) => {
          if (pending) return reject(Error("LOGIN_HTTPS_WAIT_HOLDER_UNAVAILABLE"));
          const marker = "LINKING_HOLDER_" + randomUUID();
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(Error("LOGIN_HTTPS_WAIT_HOLDER_UNAVAILABLE"));
          }, 5000);
          pending = { marker, timer, lines: [], resolve, reject };
          child.stdin.write(text + "\n\\echo " + marker + "\n");
        });
      const pid = Number(await run("SELECT pg_backend_pid();"));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw Error("LOGIN_HTTPS_WAIT_HOLDER_UNAVAILABLE");
      return {
        pid,
        run,
        async close() {
          child.stdin.end();
          let timeout;
          const r = await Promise.race([
            finished,
            new Promise((resolve) => {
              timeout = setTimeout(() => {
                child.kill("SIGKILL");
                resolve(null);
              }, 3000);
            }),
          ]);
          clearTimeout(timeout);
          const absent =
            engine.sql(
              "SELECT count(*) FROM pg_stat_activity WHERE datname='morrow' AND usename='postgres' AND application_name=" +
                lit(applicationName) +
                ";",
              "morrow",
            ) === "0";
          const verified = r !== null && r.code === 0 && r.signal === null && absent;
          holderCleanup.push({
            hostClosedNormally: r !== null && r.code === 0 && r.signal === null,
            backendAbsent: absent,
          });
          if (!verified) throw Error("LOGIN_HTTPS_WAIT_HOLDER_CLEANUP_UNVERIFIED");
        },
      };
    };

    let listener = createWorkspaceApiHttpListener();
    const server = createServer({ ...tls.serverOptions, maxHeaderSize: 8192 }, (req, res) =>
      listener(req, res),
    );
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.maxHeadersCount = 64;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = "https://127.0.0.1:" + server.address().port;
    let requests = 0;
    const request = (
      path,
      {
        method = "GET",
        headers = {},
        body,
        rawHeaders,
        declaredLength,
        chunked = false,
        onRequest,
      } = {},
    ) => {
      requests++;
      return new Promise((resolve, reject) => {
        const selected = rawHeaders ?? {
          Host: new URL(origin).host,
          Connection: "close",
          ...headers,
          ...(body === undefined
            ? {}
            : chunked
              ? { "Transfer-Encoding": "chunked" }
              : { "Content-Length": declaredLength ?? Buffer.byteLength(body) }),
        };
        const req = httpsRequest(
          origin + path,
          { method, headers: selected, ca: tls.ca, rejectUnauthorized: true, agent: false },
          (response) => {
            let text = "";
            response.on("data", (chunk) => {
              text += chunk;
              if (Buffer.byteLength(text) > 8192) req.destroy();
            });
            response.once("error", () => reject(Error("LOGIN_HTTPS_CLIENT_HELD")));
            response.once("end", () => {
              const observed = new Headers();
              for (let i = 0; i < response.rawHeaders.length; i += 2)
                observed.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
              resolve({ status: response.statusCode, headers: observed, text });
            });
          },
        );
        req.once("error", () => reject(Error("LOGIN_HTTPS_CLIENT_HELD")));
        req.setTimeout(30000, () => req.destroy());
        if (onRequest) onRequest(req);
        req.end(body);
      });
    };
    const safe = (r) =>
      r.headers.get("cache-control") === "no-store" &&
      r.headers.get("x-content-type-options") === "nosniff" &&
      r.headers.get("referrer-policy") === "no-referrer" &&
      !r.headers.has("access-control-allow-origin");
    const held = (r) =>
      r.status === 303 &&
      r.headers.get("location") === "/auth/result" &&
      r.headers.getSetCookie().length === 0 &&
      r.text === "" &&
      safe(r);
    const mutations = (c, kind) => {
      if (kind === "profile")
        h.admin(
          `UPDATE morrow_identity.identity_verification_profiles SET state='inactive',record_revision=record_revision+1 WHERE id=${lit(c.f.profile)};`,
        );
      else if (kind === "membership")
        h.admin(
          `UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${lit(c.f.workspace)};`,
        );
      else if (kind === "binding")
        h.admin(
          `UPDATE morrow_identity.authentication_exchange_bindings SET active=false,revision=revision+1 WHERE binding_id=${lit(c.bindingId)};`,
        );
      else throw Error("LOGIN_HTTPS_FIXED_MUTATION_REQUIRED");
    };
    const roleSpec = {
      login: ["morrow_identity_login", loginFlowCustodySql],
      preauth: ["morrow_identity_preauth", authenticationExchangeAdmissionSql],
      selection: ["morrow_identity_resolution", workspaceSelectionSql],
      session: ["morrow_identity_sessions", browserSessionAdmissionSql],
    };
    async function fresh(options = {}) {
      const cfg = h.configured({ origin }),
        f = cfg.f;
      const c = {
        ...cfg,
        trace: [],
        events: [],
        enteredAt: Date.now(),
        plans: [],
        opened: 0,
        closed: 0,
        jar: createBoundedLoginCookieJar(),
        options,
      };
      c.provider = createSyntheticLoginProvider({
        configurationJson: cfg.configurationJson,
        subjectId: options.subjectId ?? f.subject,
        providerSessionId: f.sid,
        hooks: options.hooks,
        session: options.session,
      });
      const record = (role, stage, event) =>
        c.events.push({ role, stage, event, relativeMs: Date.now() - c.enteredAt });
      diagnostic = () => {
        try {
          console.error(
            "LOGIN_HTTPS_DIAGNOSTIC " +
              JSON.stringify({
                phase,
                caseCount: cases.length,
                ports: { ...c.provider.metrics },
                opened: c.opened,
                closed: c.closed,
                plans: c.plans,
                events: c.events.slice(-96),
              }),
          );
        } catch {
          /* Diagnostic failure cannot alter cleanup. */
        }
      };
      c.port = Object.freeze(
        Object.fromEntries(
          Object.entries(c.provider.port).map(([name, fn]) => [
            name,
            async (...args) => {
              record("provider", name, "start");
              const value = await fn(...args);
              record("provider", name, "end");
              return value;
            },
          ]),
        ),
      );
      const pools = {};
      for (const [name, [role, statements]] of Object.entries(roleSpec)) {
        const base = h.pool(role, Object.values(statements));
        pools[name + "Pool"] = {
          async connect(control) {
            record(name, "connection", "start");
            const client = await base.connect(control);
            record(name, "connection", "end");
            c.opened++;
            let targeted = false,
              committed = false;
            return {
              async query(text, values, queryControl) {
                const stage =
                  Object.entries(statements).find(([, v]) => v === text)?.[0] ?? "unknown";
                c.trace.push({ role: name, stage });
                record(name, stage, "start");
                if (options.beforeQuery)
                  await options.beforeQuery({ c, role: name, text, values, control: queryControl });
                const rows = await client.query(text, values, queryControl);
                record(name, stage, "end");
                if (options.afterQuery)
                  await options.afterQuery({
                    c,
                    role: name,
                    text,
                    values,
                    rows,
                    control: queryControl,
                  });
                if (options.fault?.role === name && options.fault.statement === text)
                  targeted = true;
                if (text === "COMMIT") committed = true;
                if (targeted && committed && options.fault?.phase === "commit")
                  throw Error("SYNTHETIC_ACK_LOST");
                return rows;
              },
              async release(discard) {
                record(name, "release", "start");
                await client.release(discard);
                record(name, "release", "end");
                c.closed++;
                if (targeted && committed && options.fault?.phase === "release")
                  throw Error("SYNTHETIC_ACK_LOST");
              },
            };
          },
        };
      }
      c.pools = pools;
      c.auth = await createStandaloneLoginBridge({
        configurationJson: cfg.configurationJson,
        ...pools,
        providerPort: c.port,
        now: Date.now,
      });
      c.apiPool = localStandaloneSqlPool(engine.id, "morrow_api", Object.values(identitySql));
      readPools.push(c.apiPool);
      c.linkPool = localStandaloneSqlPool(engine.id, "morrow_identity_linking", [
        ...Object.values(workspaceStoreLinkingSql),
        ...Object.values(workspaceStoreLinkingControlSql),
      ]);
      readPools.push(c.linkPool);
      c.bootstrap = createStandaloneWorkspaceBootstrap({
        configurationJson: JSON.stringify({ schemaVersion: 1, mode: "https", origin }),
        pool: c.apiPool,
        now: Date.now,
      });
      c.linking = createStandaloneStoreLinking({
        configurationJson: JSON.stringify({ schemaVersion: 1, mode: "https", origin }),
        pool: c.linkPool,
        now: Date.now,
      });
      c.activate = () => {
        listener = createWorkspaceApiHttpListener({
          origin,
          auth: {
            dispatch(req, sink) {
              return c.auth.dispatch(req, (plan) => {
                c.plans.push({ status: plan.status, cookies: plan.cookies.length });
                return sink(plan);
              });
            },
          },
          bootstrap: c.bootstrap,
          linking: c.linking,
        });
      };
      c.activate();
      cases.push(c);
      return c;
    }
    const count = (c, what) =>
      Number(
        h.admin(
          what === "family"
            ? `SELECT count(*) FROM morrow_identity.browser_session_commands m JOIN morrow_identity.login_flows f ON m.command_id=f.issuer_command_id::text WHERE f.configuration_digest=${lit(c.configurationDigest)} AND m.outcome='admitted';`
            : `SELECT count(*) FROM morrow_identity.login_flows WHERE configuration_digest=${lit(c.configurationDigest)};`,
        ),
      );
    const flow = (c) =>
      JSON.parse(
        h.admin(
          `SELECT row_to_json(x)::text FROM (SELECT id::text,phase,ciphertext,begin_command_id::text,admission_command_id::text,issuer_command_id::text FROM morrow_identity.login_flows WHERE configuration_digest=${lit(c.configurationDigest)} ORDER BY created_at DESC LIMIT 1) x;`,
        ),
      );
    const receipt = (c) =>
      JSON.parse(
        h.admin(
          `SELECT row_to_json(x)::text FROM (SELECT m.family_id::text,m.generation_id::text,m.provider_binding_id::text,(extract(epoch FROM m.expires_at)*1000)::bigint::text AS expires_at_ms FROM morrow_identity.browser_session_commands m JOIN morrow_identity.login_flows f ON m.command_id=f.issuer_command_id::text WHERE f.configuration_digest=${lit(c.configurationDigest)} AND m.outcome='admitted' ORDER BY m.recorded_at DESC LIMIT 1) x;`,
        ),
      );
    const start = async (c) => {
      const r = await request("/auth/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json", "X-Morrow-Request": "1" },
        body: JSON.stringify({ schemaVersion: 1, workspaceId: c.f.workspace }),
      });
      if (r.status === 200) {
        const body = JSON.parse(r.text);
        check(
          "start_exact_protocol_response_" + cases.length + "_" + count(c, "flow"),
          safe(r) &&
            Object.keys(body).sort().join(",") === "authorizationUrl,schemaVersion" &&
            body.schemaVersion === 1 &&
            r.headers.getSetCookie().length === 1 &&
            c.jar.ingest(origin + "/auth/login", r.headers).accepted === 1,
        );
        c.callback = c.provider.arm(body.authorizationUrl);
        privateMarkers.push(
          body.authorizationUrl,
          ...r.headers.getSetCookie().map((s) => s.split(";", 1)[0].split("=", 2)[1]),
        );
      } else responseBodies.push(r.text);
      return r;
    };
    const callback = async (
      c,
      path = new URL(c.callback.callbackUrl).pathname + new URL(c.callback.callbackUrl).search,
      cookieHeader = c.jar.header(c.callback.callbackUrl),
    ) => {
      const r = await request(path, {
        headers: {
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Site": "cross-site",
        },
      });
      responseBodies.push(r.text);
      if (r.headers.getSetCookie().length) {
        if (c.jar.ingest(c.callback.callbackUrl, r.headers).accepted !== 1)
          throw Error("LOGIN_HTTPS_SESSION_JAR_DENIED");
        privateMarkers.push(
          ...r.headers.getSetCookie().map((s) => s.split(";", 1)[0].split("=", 2)[1]),
        );
      }
      return r;
    };
    const bootstrap = (c) =>
      request(`/workspace/${c.f.workspace}/bootstrap`, {
        headers: { Cookie: c.jar.header(origin + "/") ?? "" },
      });
    try {
      const denied = await request("/auth/login", { method: "POST" });
      check(
        "default_router_auth_denied_without_sql_or_cookie",
        denied.status === 404 &&
          denied.headers.getSetCookie().length === 0 &&
          h.rolePools.length === 0,
      );
      setPhase("malformed_and_happy");
      const good = await fresh();
      const before = () => h.rolePools.reduce((n, p) => n + p.metrics.connections, 0);
      const invalidStart = [
        ["missing_json", {}, "", 400],
        ["duplicate_json_key", {}, '{"schemaVersion":1,"workspaceId":"a","workspaceId":"b"}', 400],
        [
          "extra_authority",
          {},
          JSON.stringify({
            schemaVersion: 1,
            workspaceId: good.f.workspace,
            principalId: "foreign",
          }),
          400,
        ],
        ["malformed_utf8", {}, Buffer.from([0xc0, 0xaf]), 400],
        ["oversized_json", {}, "x".repeat(513), 400],
        ["declared_zero", { declaredLength: 0 }, "", 400],
        ["chunked_body", { chunked: true }, "{}", 400],
        ["foreign_origin", { headers: { Origin: "https://foreign.invalid" } }, "{}", 403],
        ["missing_request_marker", { headers: { "X-Morrow-Request": "0" } }, "{}", 403],
      ];
      for (const [name, options, body, status] of invalidStart) {
        const n = before();
        const r = await request("/auth/login", {
          method: "POST",
          ...options,
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "X-Morrow-Request": "1",
            ...options.headers,
          },
          body,
        });
        check(
          "actual_https_" + name + "_fixed_no_sql",
          r.status === status &&
            r.headers.getSetCookie().length === 0 &&
            r.text === '{"schemaVersion":1,"outcome":"login_unavailable"}' &&
            before() === n &&
            good.provider.metrics.exchange === 0,
        );
      }
      const malformedCallback = [
        "?error=access_denied&state=x",
        "?code=a&state=b&extra=c",
        "?code=a&code=b&state=c",
        "?%63ode=a&state=b",
        "?code=%GG&state=b",
      ];
      for (const [i, query] of malformedCallback.entries()) {
        const n = before(),
          r = await request("/auth/workos/callback" + query);
        check("malformed_callback_clean_redirect_zero_sql_" + i, held(r) && before() === n);
      }
      const identityRowsBeforeLogin = h.admin(
        "SELECT (SELECT count(*) FROM morrow_identity.principals)::text||':'||(SELECT count(*) FROM morrow_identity.memberships)::text||':'||(SELECT count(*) FROM morrow_identity.workspace_memberships)::text||':'||(SELECT count(*) FROM morrow_identity.grants)::text;",
      );
      check(
        "successful_start_uses_cookie_only_after_begin_and_custody",
        (await start(good)).status === 200 &&
          flow(good).phase === "awaiting_callback" &&
          typeof flow(good).ciphertext === "string",
      );
      const success = await callback(good);
      check(
        "real_https_full_69_76_77_m_cookie_chain",
        success.status === 303 &&
          success.headers.get("location") === "/" &&
          success.headers.getSetCookie().length === 1 &&
          safe(success) &&
          good.jar.names().join(",") === "__Host-morrow_login,__Host-morrow_session" &&
          JSON.stringify(good.provider.metrics) ===
            '{"exchange":1,"publicKeyset":1,"sessionPage":1}',
      );
      const saved = flow(good),
        issued = receipt(good),
        sessionSecret = /(?:^|; )__Host-morrow_session=([^;]+)/.exec(
          good.jar.header(origin + "/"),
        )[1];
      check(
        "fresh_claim_atomically_erased_stored_capsule",
        saved.phase === "claimed" && saved.ciphertext === null,
      );
      check(
        "delivered_secret_matches_durable_generation",
        h.admin(
          `SELECT secret_digest=${lit(hash(sessionSecret))} FROM morrow_identity.browser_session_generations WHERE id=${lit(issued.generation_id)};`,
        ) === "t",
      );
      check(
        "database_family_lifetime_exact_fifteen_minutes",
        h.admin(
          `SELECT expires_at-created_at=interval '15 minutes' FROM morrow_identity.browser_session_families WHERE id=${lit(issued.family_id)};`,
        ) === "t",
      );
      const boot = await bootstrap(good);
      check(
        "jar_delivered_cookie_authenticates_actual_o_bootstrap",
        boot.status === 200 &&
          JSON.parse(boot.text).workspace.id === good.f.workspace &&
          !boot.headers.has("set-cookie"),
      );
      const originalCookie = good.jar.header(origin + "/");
      check(
        "replayed_callback_no_exchange_family_or_cookie",
        held(await callback(good)) &&
          good.provider.metrics.exchange === 1 &&
          count(good, "family") === 1 &&
          good.jar.header(origin + "/") === originalCookie,
      );
      check(
        "login_did_not_create_people_memberships_or_grants",
        identityRowsBeforeLogin ===
          h.admin(
            "SELECT (SELECT count(*) FROM morrow_identity.principals)::text||':'||(SELECT count(*) FROM morrow_identity.memberships)::text||':'||(SELECT count(*) FROM morrow_identity.workspace_memberships)::text||':'||(SELECT count(*) FROM morrow_identity.grants)::text;",
          ),
      );
      const handoff = await seedStandaloneLinkingFixture(h, {
        f: good.f,
        result: { outcome: "newly_admitted", credential: { secret: sessionSecret } },
      });
      const b = (stage, csrf) =>
        request(
          `/workspace/${good.f.workspace}/store-links${stage === "apply" ? "" : "/" + stage}`,
          {
            method: "POST",
            headers: {
              Origin: origin,
              Cookie: good.jar.header(origin + "/"),
              "Content-Type": "application/json",
              "X-Morrow-Request": "1",
              "Idempotency-Key": handoff.commandId,
              ...(csrf ? { "X-Morrow-CSRF": csrf } : {}),
            },
            body: JSON.stringify({ handoffToken: handoff.handoffToken }),
          },
        );
      const preview = await b("preview"),
        applied = await b("apply", JSON.parse(preview.text).csrfToken),
        status = await b("status");
      check(
        "same_issued_jar_cookie_b_reviewed_preview_apply_status",
        preview.status === 200 &&
          applied.status === 200 &&
          status.status === 200 &&
          JSON.parse(applied.text).outcome === "applied" &&
          JSON.parse(applied.text).linkId === JSON.parse(status.text).linkId,
      );
      check(
        "owner_seeded_principal_stays_single_and_one_family_issued",
        h.admin(
          `SELECT count(*) FROM morrow_identity.principals WHERE id=${lit(good.f.principal)};`,
        ) === "1" && count(good, "family") === 1,
      );
      for (const path of ["/auth/logout", "/auth/refresh"]) {
        const n = before(),
          r = await request(path, { headers: { Cookie: originalCookie } });
        check(
          "no_" + path.split("/").at(-1) + "_route_or_cookie_clear",
          r.status === 404 && !r.headers.has("set-cookie") && before() === n,
        );
      }
      const resultPage = await request("/auth/result");
      check(
        "generic_result_page_static_no_state_or_sql",
        resultPage.status === 200 &&
          resultPage.headers.get("content-security-policy") ===
            "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" &&
          !resultPage.headers.has("set-cookie") &&
          !resultPage.text.includes("<script"),
      );

      setPhase("key_loss_and_concurrent");
      const keyLoss = await fresh();
      await start(keyLoss);
      keyLoss.auth = await createStandaloneLoginBridge({
        configurationJson: keyLoss.configurationJson,
        ...keyLoss.pools,
        providerPort: keyLoss.port,
        now: Date.now,
      });
      keyLoss.activate();
      check(
        "fresh_factory_key_loss_claims_but_never_recovers_capsule",
        held(await callback(keyLoss)) &&
          flow(keyLoss).ciphertext === null &&
          keyLoss.provider.metrics.exchange === 0 &&
          count(keyLoss, "family") === 0,
      );
      const race = await fresh();
      await start(race);
      const pair = await Promise.all([callback(race), callback(race)]);
      check(
        "concurrent_callbacks_one_cookie_one_exchange_one_family",
        pair.filter((r) => r.headers.getSetCookie().length === 1).length === 1 &&
          pair.filter(held).length === 1 &&
          race.provider.metrics.exchange === 1 &&
          count(race, "family") === 1,
      );

      setPhase("code_alias");
      const alias = await fresh();
      await start(alias);
      const firstAlias = alias.callback;
      check(
        "code_alias_first_callback_succeeds",
        (await callback(alias)).headers.getSetCookie().length === 1,
      );
      await start(alias);
      const aliasUrl = new URL(alias.callback.callbackUrl);
      aliasUrl.searchParams.set("code", firstAlias.code);
      check(
        "same_code_other_flow_irreversible_claim_no_second_exchange",
        held(await callback(alias, aliasUrl.pathname + aliasUrl.search)) &&
          alias.provider.metrics.exchange === 1 &&
          count(alias, "family") === 1 &&
          flow(alias).phase === "claimed",
      );

      setPhase("unmapped_subject");
      const unmapped = await fresh({ subjectId: "user_" + "Z".repeat(26) });
      await start(unmapped);
      check(
        "signed_unmapped_subject_never_issues_cookie_or_family",
        held(await callback(unmapped)) &&
          unmapped.provider.metrics.exchange === 1 &&
          unmapped.provider.metrics.sessionPage === 1 &&
          count(unmapped, "family") === 0,
      );

      setPhase("disconnect_setup");
      const committed = deferred(),
        interrupted = deferred();
      let disconnectArmed = false;
      const disconnected = await fresh({
        async afterQuery({ role, text, control }) {
          if (
            !disconnectArmed &&
            role === "session" &&
            text === browserSessionAdmissionSql.commit
          ) {
            disconnectArmed = true;
            committed.resolve();
            await bounded(
              new Promise((resolve) => {
                if (control.signal.aborted) return resolve();
                control.signal.addEventListener("abort", resolve, { once: true });
              }),
              6000,
            );
            interrupted.resolve();
          }
        },
      });
      await start(disconnected);
      let callbackRequest;
      const disconnectedUrl = new URL(disconnected.callback.callbackUrl);
      const disconnectedReply = request(disconnectedUrl.pathname + disconnectedUrl.search, {
        headers: {
          Cookie: disconnected.jar.header(disconnectedUrl.href),
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Site": "cross-site",
        },
        onRequest(req) {
          callbackRequest = req;
        },
      }).then(
        () => "unexpected_response",
        () => "client_disconnected",
      );
      setPhase("disconnect_wait_commit");
      await bounded(committed.promise);
      callbackRequest.destroy();
      check(
        "actual_disconnect_after_committed_issuer_has_no_cookie_delivery",
        (await disconnectedReply) === "client_disconnected",
      );
      setPhase("disconnect_wait_abort");
      await bounded(interrupted.promise);
      setPhase("disconnect_wait_disposal");
      await bounded(
        (async () => {
          while (disconnected.closed !== disconnected.opened) await pause(10);
        })(),
      );
      check(
        "disconnect_after_commit_keeps_one_attributable_family_and_disposes",
        count(disconnected, "family") === 1 &&
          flow(disconnected).phase === "claimed" &&
          disconnected.plans.filter((p) => p.cookies > 0).length === 1 &&
          disconnected.trace.at(-1).stage === "commit",
      );
      check(
        "disconnect_replayed_callback_cannot_redeliver_secret",
        held(await callback(disconnected)) &&
          count(disconnected, "family") === 1 &&
          disconnected.provider.metrics.exchange === 1,
      );

      setPhase("post_reservation_profile");
      let revoked = false;
      const drift = await fresh({
        afterQuery({ c, role, text }) {
          if (!revoked && role === "preauth" && text === authenticationExchangeAdmissionSql.admit) {
            mutations(c, "profile");
            revoked = true;
          }
        },
      });
      await start(drift);
      check(
        "profile_revocation_after_69_result_before_commit_suppresses_ports",
        held(await callback(drift)) &&
          revoked &&
          drift.provider.metrics.exchange === 0 &&
          drift.provider.metrics.publicKeyset === 0 &&
          drift.provider.metrics.sessionPage === 0 &&
          count(drift, "family") === 0,
      );

      setPhase("actual_69_lock_wait");
      let reservationReturned = false;
      const reservationEntered = deferred();
      const waited = await fresh({
        beforeQuery({ role, text }) {
          if (role === "preauth" && text === authenticationExchangeAdmissionSql.admit)
            reservationEntered.resolve();
        },
        afterQuery({ role, text, rows }) {
          if (role === "preauth" && text === authenticationExchangeAdmissionSql.admit)
            reservationReturned =
              rows.rows.length === 1 && rows.rows[0].outcome === "newly_reserved";
        },
      });
      await start(waited);
      const holder = await openHolder();
      let waitingReply;
      try {
        await holder.run(
          `BEGIN; SELECT id FROM morrow_identity.authentication_bindings WHERE id=${lit(waited.bindingId)} FOR UPDATE;`,
        );
        waitingReply = callback(waited);
        await bounded(reservationEntered.promise);
        const consumerText = await holder.run(
          "SELECT pg_stat_clear_snapshot(); SELECT pid FROM pg_stat_activity WHERE datname='morrow' AND usename='morrow_identity_preauth' AND application_name LIKE 'morrow_login_flow_%';",
        );
        const consumerPid = Number(consumerText);
        check(
          "actual_69_wait_has_one_warmed_exact_consumer",
          /^[1-9][0-9]*$/.test(consumerText) && Number.isSafeInteger(consumerPid),
        );
        let witnessed = false;
        const until = Date.now() + 4000;
        while (Date.now() < until) {
          const fact = await holder.run(
            `SELECT pg_stat_clear_snapshot(); SELECT ${holder.pid}=ANY(pg_blocking_pids(${consumerPid})) AND EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${consumerPid} AND datname='morrow' AND usename='morrow_identity_preauth' AND application_name LIKE 'morrow_login_flow_%' AND state='active' AND wait_event_type='Lock') AND (SELECT expires_at>clock_timestamp() FROM morrow_identity.login_flows WHERE configuration_digest=${lit(waited.configurationDigest)});`,
          );
          if (fact === "t") {
            witnessed = true;
            break;
          }
          await pause(5);
        }
        check("actual_69_reservation_exact_holder_wait_witnessed_before_expiry", witnessed);
        mutations(waited, "profile");
        await holder.run("COMMIT;");
        check(
          "profile_revoked_while_69_waited_never_reaches_provider",
          held(await waitingReply) &&
            reservationReturned &&
            waited.provider.metrics.exchange === 0 &&
            waited.provider.metrics.publicKeyset === 0 &&
            waited.provider.metrics.sessionPage === 0 &&
            count(waited, "family") === 0 &&
            flow(waited).phase === "claimed",
        );
      } finally {
        const rollback = await Promise.allSettled([holder.run("ROLLBACK;")]);
        const released = await Promise.allSettled([holder.close()]);
        if (waitingReply) await Promise.allSettled([waitingReply]);
        if ([...rollback, ...released].some((r) => r.status === "rejected"))
          throw Error("LOGIN_HTTPS_WAIT_CLEANUP_UNVERIFIED");
      }
      check(
        "actual_69_wait_holder_host_and_backend_absent",
        holderCleanup.length === 1 &&
          holderCleanup.every((v) => v.hostClosedNormally && v.backendAbsent),
      );

      setPhase("uncertainty");
      for (const fault of [
        ["begin_commit", "preauth", authenticationExchangeAdmissionSql.create, "commit", true],
        ["custody_bind_commit", "login", loginFlowCustodySql.bindBegin, "commit", true],
        ["claim_commit", "login", loginFlowCustodySql.claimCallback, "commit", false],
        [
          "reservation_commit",
          "preauth",
          authenticationExchangeAdmissionSql.admit,
          "commit",
          false,
        ],
        ["issuer_commit", "session", browserSessionAdmissionSql.admit, "commit", false],
        ["issuer_release", "session", browserSessionAdmissionSql.admit, "release", false],
      ]) {
        const [name, role, statement, phase, startFault] = fault,
          c = await fresh({ fault: { role, statement, phase } });
        const r = await start(c);
        if (startFault)
          check(
            "unknown_" + name + "_no_start_cookie_or_url",
            r.status === 503 &&
              !r.headers.has("set-cookie") &&
              r.text === '{"schemaVersion":1,"outcome":"login_unavailable"}' &&
              c.provider.metrics.exchange === 0,
          );
        else {
          const response = await callback(c);
          check(
            "unknown_" + name + "_no_session_cookie",
            held(response) && !c.jar.names().includes("__Host-morrow_session"),
          );
          const families = count(c, "family"),
            exchanges = c.provider.metrics.exchange;
          check(
            "unknown_" + name + "_replay_has_no_retry",
            held(await callback(c)) &&
              count(c, "family") === families &&
              c.provider.metrics.exchange === exchanges,
          );
          if (role === "session")
            check(
              "unknown_" + name + "_committed_family_stays_attributable",
              families === 1 && flow(c).phase === "claimed",
            );
        }
        const stages = c.trace.filter((t) => t.role === role).map((t) => t.stage);
        check(
          "unknown_" + name + "_no_rollback_after_uncertain_query",
          !stages.includes("rollback"),
        );
      }

      setPhase("revocation");
      for (const kind of ["provider", "family", "generation", "workspace"]) {
        const c = await fresh();
        await start(c);
        check(
          "revocation_" + kind + "_first_issue",
          (await callback(c)).headers.getSetCookie().length === 1,
        );
        const proof = receipt(c);
        if (kind === "workspace") mutations(c, "membership");
        else {
          const fn = {
            provider: "revoke_provider_binding",
            family: "revoke_browser_family",
            generation: "revoke_browser_generation",
          }[kind];
          const field = {
            provider: "provider_binding_id",
            family: "family_id",
            generation: "generation_id",
          }[kind];
          check(
            "audited_" + kind + "_revocation",
            h.admin(
              `SELECT outcome FROM morrow_identity.${fn}(${lit(proof[field])},${lit(randomUUID())},${lit(hash(randomUUID()))});`,
            ) === "applied",
          );
        }
        const denied = await bootstrap(c);
        check(
          "revoked_" + kind + "_cookie_loses_o_authority",
          denied.status === 401 &&
            !denied.headers.has("set-cookie") &&
            c.jar.names().includes("__Host-morrow_session"),
        );
      }

      const n = before();
      await request("/auth/workos/callback?code=a&state=b", {
        headers: { Cookie: "__Host-morrow_login=invalid" },
      });
      check("invalid_cookie_callback_never_reads_sql", before() === n);
      await h.close();
      await Promise.all(readPools.map((p) => p.close()));
      check(
        "all_four_role_pools_physically_closed",
        h.rolePools.every(
          (p) =>
            p.metrics.connections === p.metrics.released &&
            p.metrics.connections === p.metrics.closed &&
            p.metrics.connections === p.metrics.backendCleanupVerified &&
            p.metrics.unverifiedHostClosures === 0,
        ),
      );
      check(
        "o_b_consumer_pools_physically_closed",
        readPools.every(
          (p) =>
            p.metrics.connections === p.metrics.released &&
            p.metrics.connections === p.metrics.closed &&
            p.metrics.connections === p.metrics.backendCleanupVerified &&
            p.metrics.unverifiedHostClosures === 0,
        ),
      );
      check(
        "fresh_database_all_owned_role_backends_absent",
        engine.sql(
          "SELECT count(*) FROM pg_stat_activity WHERE datname='morrow' AND usename IN ('morrow_identity_login','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_api','morrow_identity_linking');",
          "morrow",
        ) === "0",
      );
      const markers = [
        ...privateMarkers,
        ...h.secrets,
        ...cases.flatMap((c) => c.provider.secrets),
      ];
      const rawMarkers = markers.filter((s) => !/^[a-f0-9]{64}$/.test(s));
      check(
        "raw_proof_tokens_absent_from_general_bodies_and_sql_output",
        markers.every((s) => !JSON.stringify(responseBodies).includes(s)) &&
          rawMarkers.every(
            (s) =>
              h.rolePools.every((p) => !JSON.stringify(p.observed).includes(s)) &&
              readPools.every((p) => !JSON.stringify(p.observed).includes(s)),
          ),
      );
      return {
        image: engine.image,
        version: engine.version,
        requests,
        cases: cases.length,
        portCalls: cases.map((c) => ({ ...c.provider.metrics })),
        rolePoolMetrics: h.rolePools.map((p) => p.metrics),
        consumerPoolMetrics: readPools.map((p) => p.metrics),
        holderCleanup,
      };
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      httpsClosed = await new Promise((resolve) => {
        const socket = connectSocket({ host: "127.0.0.1", port: new URL(origin).port });
        socket.once("error", (e) => {
          socket.destroy();
          resolve(e.code === "ECONNREFUSED");
        });
        socket.once("connect", () => {
          socket.destroy();
          resolve(false);
        });
        socket.setTimeout(1000, () => {
          socket.destroy();
          resolve(false);
        });
      });
      const results = await Promise.allSettled([h.close(), ...readPools.map((p) => p.close())]);
      if (results.some((r) => r.status === "rejected")) {
        const metrics = (pool) =>
          Object.fromEntries(
            [
              "connections",
              "released",
              "closed",
              "backendCleanupVerified",
              "unverifiedHostClosures",
            ].map((key) => [
              key,
              Number.isSafeInteger(pool.metrics[key]) && pool.metrics[key] >= 0
                ? pool.metrics[key]
                : null,
            ]),
          );
        console.error(
          "LOGIN_HTTPS_CLEANUP_DIAGNOSTIC " +
            JSON.stringify({
              phase,
              rolePools: h.rolePools.map(metrics),
              consumerPools: readPools.map(metrics),
            }),
        );
        throw Error("LOGIN_HTTPS_LAB_CLEANUP_UNVERIFIED");
      }
    }
  });
  let plaintextDispatches = 0;
  const plainAuth = createWorkspaceApiHttpListener({
    origin: "https://127.0.0.1:4443",
    auth: {
      async dispatch() {
        plaintextDispatches++;
      },
    },
  });
  const plainServer = createHttpServer((req, res) => plainAuth(req, res));
  await new Promise((resolve) => plainServer.listen(0, "127.0.0.1", resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: plainServer.address().port,
          path: "/auth/login",
          method: "POST",
          headers: {
            Host: "127.0.0.1:4443",
            Origin: "https://127.0.0.1:4443",
            "Content-Type": "application/json",
            "X-Morrow-Request": "1",
            "Content-Length": "2",
            Connection: "close",
          },
        },
        (res) => {
          res.resume();
          res.once("end", () =>
            resolve({ status: res.statusCode, cookies: res.headers["set-cookie"] ?? [] }),
          );
        },
      );
      req.once("error", reject);
      req.end("{}");
    });
    check(
      "actual_plain_http_same_https_authority_denied_before_dispatch",
      status.status === 400 && status.cookies.length === 0 && plaintextDispatches === 0,
    );
  } finally {
    plainServer.closeAllConnections();
    await new Promise((resolve) => plainServer.close(resolve));
  }
  const http = createHttpServer((_req, res) => {
    res.writeHead(200, {
      "Set-Cookie": `__Host-morrow_session=${randomBytes(32).toString("base64url")}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900`,
    });
    res.end();
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const origin = "http://127.0.0.1:" + http.address().port;
    const received = await new Promise((resolve, reject) => {
      const req = httpRequest(origin, (r) => {
        const headers = new Headers();
        for (const line of r.headers["set-cookie"] ?? []) headers.append("set-cookie", line);
        r.resume();
        r.once("end", () => resolve(headers));
      });
      req.once("error", reject);
      req.end();
    });
    const jar = createBoundedLoginCookieJar();
    check(
      "actual_http_secure_cookie_cannot_enter_jar",
      jar.ingest(origin, received).accepted === 0 &&
        jar.header(origin.replace("http:", "https:")) === undefined,
    );
  } finally {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    httpClosed = true;
  }
} finally {
  tlsCleanup = await tls.cleanup();
}
const absent = containerCommand([
  "ps",
  "--all",
  "--filter",
  "id=" + ownedContainer,
  "--format",
  "{{.ID}}",
]);
check(
  "exact_owned_database_container_absent",
  /^[a-f0-9]{64}$/.test(ownedContainer) && absent.status === 0 && absent.stdout.trim() === "",
);
check("https_and_http_listeners_closed", httpsClosed && httpClosed);
check(
  "ephemeral_tls_keys_and_client_resources_removed",
  tlsCleanup.clientsClosed && tlsCleanup.privateDirectoryAbsent && !existsSync(tls.directory),
);
check(
  "all_selected_source_bytes_unchanged",
  Object.entries(sourceDigests).every(([p, d]) => hash(readFileSync(p)) === d),
);
const report = {
  schemaVersion: 1,
  task: "P05.T01p",
  canonicalSequence: 89,
  observedAt: new Date().toISOString(),
  qualification: "synthetic_native_rsa_pkce_to_real_sql_to_https_initial_cookie_jar_and_o_b",
  appliedMigrations: 10,
  providerRequests: 0,
  browserEngineQualified: false,
  sourceDigests,
  sourceDigest: hash(JSON.stringify(Object.entries(sourceDigests).sort())),
  checks,
  checkCount: checks.length,
  result: measured,
  tls: tls.metadata,
  cleanup: {
    hostClients: "closed",
    backendNamespace: "absent",
    container: "absent",
    httpsListener: "closed",
    httpListener: "closed",
    syntheticTlsDirectory: "absent",
  },
  limitations: [
    "In-process independently signed synthetic provider only; authorization URL never followed and no native provider key or request.",
    "Bounded Undici parser/test jar and actual HTTPS transport are exercised; browser-engine Secure/HttpOnly/SameSite/prefix enforcement remains unqualified.",
    "Owner-seeded existing identities/profiles/memberships and independent reviewed linking handoffs only; no provisioning, real Shopify, merchant activation, hosted issuer/custody or logout/refresh.",
    "Lost acknowledgement and family attribution do not prove browser delivery or durable provider liveness.",
    "Source digests are selected reviewed inputs, not a complete third-party dependency closure.",
  ],
};
mkdirSync("docs/evidence/P05.T01t/canonical89/regressions", { recursive: true });
writeFileSync(
  "docs/evidence/P05.T01t/canonical89/regressions/login-https-postgresql-lab.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "PASS: " +
    checks.length +
    " actual login HTTPS/PostgreSQL checks; zero provider requests; owned resources removed.",
);
