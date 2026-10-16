import { createServer, request as httpsRequest } from "node:https";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createWorkspaceApiHttpListener } from "../apps/api/src/workspace-router.ts";
import { createStandaloneLoginBridge } from "../packages/identity/src/standalone-login.ts";
import { createSyntheticFixedWorkosLoginPort } from "../packages/identity/src/fixed-workos-login-port.ts";
import { createStandaloneLogout } from "../packages/identity/src/standalone-logout.ts";
import { selfLogoutSql } from "../packages/identity/src/self-logout-control.ts";
import { loginFlowCustodySql } from "../packages/identity/src/login-flow-custody.ts";
import { authenticationExchangeAdmissionSql } from "../packages/identity/src/authentication-exchange-admission.ts";
import { workspaceSelectionSql } from "../packages/identity/src/workos-workspace-selection.ts";
import { browserSessionAdmissionSql } from "../packages/identity/src/workos-browser-session-admission.ts";
import { identitySql } from "../packages/identity/src/index.ts";
import { createStandaloneWorkspaceBootstrap } from "../packages/identity/src/standalone-workspace-bootstrap.ts";
import { createStandaloneStoreLinking } from "../packages/identity/src/standalone-store-linking.ts";
import { workspaceStoreLinkingControlSql } from "../packages/identity/src/workspace-store-linking-control.ts";
import { workspaceStoreLinkingSql } from "../packages/identity/src/workspace-store-linking.ts";
import { createSelfLogoutFixtureHarness } from "./fixtures/self-logout-fixture.mjs";
import {
  createLocalLoginTlsFixture,
  createBoundedLoginCookieJar,
} from "./fixtures/login-https.mjs";
import { createFixedWorkosHttpsProvider } from "./fixtures/fixed-workos-login-https.mjs";
import { seedStandaloneLinkingFixture } from "./fixtures/standalone-linking-fixture.mjs";
import { standaloneSqlLiteral as lit } from "./standalone-session-fixtures.mjs";
import { localStandaloneSqlPool } from "./local-standalone-sql.mjs";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const checks = [];
const check = (name, value) => {
  if (!value || !/^[a-z][a-z0-9_]{1,119}$/.test(name) || checks.some((c) => c.name === name))
    throw Error("FIXED_PROVIDER_HTTPS_CHECK:" + name);
  checks.push({ name, passed: true });
};
async function bounded(value, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([
      value,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("FIXED_PROVIDER_HTTPS_TIMEOUT")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let stage = "setup";
const phase = (value) => {
  stage = value;
  console.error("FIXED_PROVIDER_HTTPS_PHASE:" + value);
};
const paths = [
  "scripts/fixed-workos-login-https-lab.mjs",
  "scripts/fixtures/fixed-workos-login-https.mjs",
  "scripts/fixtures/fixed-workos-provider.mjs",
  "scripts/fixtures/self-logout-fixture.mjs",
  "scripts/local-self-logout-sql.mjs",
  "scripts/fixtures/login-https.mjs",
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
  "packages/identity/src/fixed-workos-login-port.ts",
  "packages/identity/src/standalone-login.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/standalone-logout.ts",
  "packages/identity/src/self-logout-control.ts",
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
  "infra/identity-logout-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  "docs/plan/source.json",
  "docs/plan/build-plan.md",
  "docs/packets/P05.T01r.md",
  "docs/packets/P05.T01s.md",
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
  plan.sequence !== 87 ||
  plan.path !== "docs/plan/build-plan.md" ||
  hash(readFileSync(plan.path)) !== plan.sha256
)
  throw Error("FIXED_PROVIDER_HTTPS_SOURCE_REQUIRED");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
if (manifest.migrations.length !== 11) throw Error("FIXED_PROVIDER_HTTPS_MIGRATIONS_REQUIRED");
for (const [index, entry] of manifest.migrations.entries()) {
  if (
    entry.sequence !== index + 1 ||
    hash(readFileSync("migrations/" + entry.file)) !== entry.sha256
  )
    throw Error("FIXED_PROVIDER_HTTPS_MIGRATION_HASH");
  paths.push("migrations/" + entry.file);
}
const sourceDigests = Object.fromEntries(paths.map((path) => [path, hash(readFileSync(path))]));
const tls = await createLocalLoginTlsFixture();
const nativeFetch = globalThis.fetch;
let nativeFetchAttempts = 0;
globalThis.fetch = async () => {
  nativeFetchAttempts++;
  throw Error("FIXED_PROVIDER_HTTPS_NATIVE_FETCH_DENIED");
};
let ownedContainer,
  listenerClosed = false,
  tlsCleanup,
  measured,
  primaryError;
try {
  measured = await localPostgresLab("P05.T01r-https", async (engine) => {
    ownedContainer = engine.id;
    const harness = createSelfLogoutFixtureHarness(engine);
    const cases = [],
      readPools = [],
      clientClosures = [],
      socketClosures = [],
      privateMarkers = [],
      responseBodies = [];
    let listener = createWorkspaceApiHttpListener(),
      requests = 0,
      clientClosed = 0,
      serverClosed = 0;
    const sockets = new Set();
    const server = createServer({ ...tls.serverOptions, maxHeaderSize: 8192 }, (q, s) =>
      listener(q, s),
    );
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.maxHeadersCount = 64;
    server.on("connection", (socket) => {
      sockets.add(socket);
      socketClosures.push(
        new Promise((resolve) =>
          socket.once("close", () => {
            sockets.delete(socket);
            serverClosed++;
            resolve();
          }),
        ),
      );
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = "https://127.0.0.1:" + server.address().port;
    const request = (path, { method = "GET", headers = {}, body } = {}) => {
      requests++;
      return new Promise((resolve, reject) => {
        const q = httpsRequest(
          origin + path,
          {
            method,
            ca: tls.ca,
            rejectUnauthorized: true,
            agent: false,
            headers: {
              Host: new URL(origin).host,
              Connection: "close",
              ...headers,
              ...(body === undefined ? {} : { "Content-Length": Buffer.byteLength(body) }),
            },
          },
          (response) => {
            let text = "";
            response.on("data", (chunk) => {
              text += chunk;
              if (Buffer.byteLength(text) > 8192) q.destroy();
            });
            response.once("error", () => reject(Error("FIXED_PROVIDER_HTTPS_CLIENT_HELD")));
            response.once("end", () => {
              const resultHeaders = new Headers();
              for (let i = 0; i < response.rawHeaders.length; i += 2)
                resultHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
              if (path !== "/auth/login" || response.statusCode !== 200) responseBodies.push(text);
              resolve({ status: response.statusCode, headers: resultHeaders, text });
            });
          },
        );
        clientClosures.push(
          new Promise((done) =>
            q.once("close", () => {
              clientClosed++;
              done();
            }),
          ),
        );
        q.once("error", () => reject(Error("FIXED_PROVIDER_HTTPS_CLIENT_HELD")));
        q.setTimeout(30000, () => q.destroy());
        q.end(body);
      });
    };
    const authHeaders = () => ({
      Origin: origin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
    });
    // Unchanged84 deliberately cleans failed callbacks into this fixed redirect.
    // This is stricter than accepting a status class or arbitrary failure page.
    const callbackHeld = (response) => {
      const observations = {
        status: Number.isInteger(response.status) ? response.status : null,
        cookieCount: response.headers.getSetCookie().length,
        cleanLocation: response.headers.get("location") === "/auth/result",
        emptyBody: response.text === "",
        noStore: response.headers.get("cache-control") === "no-store",
        nosniff: response.headers.get("x-content-type-options") === "nosniff",
        noReferrer: response.headers.get("referrer-policy") === "no-referrer",
        corsAbsent: !response.headers.has("access-control-allow-origin"),
      };
      const accepted =
        observations.status === 303 &&
        observations.cookieCount === 0 &&
        observations.cleanLocation &&
        observations.emptyBody &&
        observations.noStore &&
        observations.nosniff &&
        observations.noReferrer &&
        observations.corsAbsent;
      if (!accepted)
        console.error(
          "FIXED_PROVIDER_HTTPS_CALLBACK_HOLD_DIAGNOSTIC " +
            JSON.stringify({ stage, ...observations }),
        );
      return accepted;
    };
    const poolList = () => [...harness.rolePools, ...harness.logoutRolePools, ...readPools];
    const familyCount = (c) =>
      Number(
        harness.admin(
          `SELECT count(*) FROM morrow_identity.browser_session_families f JOIN morrow_identity.provider_session_bindings p ON p.id=f.provider_binding_id WHERE p.profile_id=${lit(c.f.profile)};`,
        ),
      );
    const revocations = (family) =>
      Number(
        harness.admin(
          `SELECT count(*) FROM morrow_identity.browser_session_audits WHERE kind='family' AND target_id=${lit(family)} AND outcome='revoked';`,
        ),
      );
    const exchangeReservations = (c) =>
      Number(
        harness.admin(
          `SELECT count(*) FROM morrow_identity.authentication_exchange_admissions WHERE environment_id=${lit(c.f.environment)} AND client_id=${lit(c.f.client)};`,
        ),
      );
    const receipt = (secret) =>
      JSON.parse(
        harness.admin(
          `SELECT row_to_json(x)::text FROM (SELECT f.id::text AS family_id,p.id::text AS provider_binding_id FROM morrow_identity.browser_session_generations g JOIN morrow_identity.browser_session_families f ON f.id=g.family_id JOIN morrow_identity.provider_session_bindings p ON p.id=f.provider_binding_id WHERE g.secret_digest=${lit(hash(secret))}) x;`,
        ),
      );
    async function fresh(options = {}) {
      const configured = harness.configured({ origin });
      const c = {
        ...configured,
        jar: createBoundedLoginCookieJar(),
        linkingTrace: [],
        logoutCalls: 0,
        options,
      };
      c.provider = createFixedWorkosHttpsProvider({
        configurationJson: c.configurationJson,
        subjectId: c.f.subject,
        providerSessionId: c.f.sid,
        fault: options.fault,
      });
      c.port = await createSyntheticFixedWorkosLoginPort({
        configurationJson: c.configurationJson,
        sessionCredentialBroker: c.provider.sessionCredentialBroker,
        now: c.provider.now,
        fetch: c.provider.fetch,
      });
      check(
        "construction_zero_fetch_and_borrow_case_" + c.f.n,
        c.provider.metrics.requests === 0 && c.provider.metrics.borrows === 0,
      );
      const specifications = {
        loginPool: ["morrow_identity_login", loginFlowCustodySql],
        preauthPool: ["morrow_identity_preauth", authenticationExchangeAdmissionSql],
        selectionPool: ["morrow_identity_resolution", workspaceSelectionSql],
        sessionPool: ["morrow_identity_sessions", browserSessionAdmissionSql],
      };
      const pools = {};
      for (const [name, [role, statements]] of Object.entries(specifications))
        pools[name] = harness.pool(role, Object.values(statements));
      c.auth = await createStandaloneLoginBridge({
        configurationJson: c.configurationJson,
        ...pools,
        providerPort: c.port,
        now: c.provider.now,
      });
      const logoutBase = harness.pool("morrow_identity_logout", Object.values(selfLogoutSql));
      c.logout = await createStandaloneLogout({
        configurationJson: harness.logoutConfiguration(configured),
        now: Date.now,
        pool: {
          async connect(control) {
            const client = await logoutBase.connect(control);
            let invoked = false;
            return {
              async query(text, values, queryControl) {
                if (text === selfLogoutSql.end) {
                  invoked = true;
                  c.logoutCalls++;
                }
                const result = await client.query(text, values, queryControl);
                if (text === selfLogoutSql.commit && invoked && options.afterCommit)
                  await options.afterCommit(queryControl);
                return result;
              },
              release(discard) {
                return client.release(discard);
              },
            };
          },
        },
      });
      c.apiPool = localStandaloneSqlPool(engine.id, "morrow_api", Object.values(identitySql));
      c.linkPool = localStandaloneSqlPool(
        engine.id,
        "morrow_identity_linking",
        [
          ...Object.values(workspaceStoreLinkingControlSql),
          ...Object.values(workspaceStoreLinkingSql),
        ],
        { beforeQuery: (text) => c.linkingTrace.push(text) },
      );
      readPools.push(c.apiPool, c.linkPool);
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
          auth: c.auth,
          logout: c.logout,
          bootstrap: c.bootstrap,
          linking: c.linking,
        });
      };
      c.activate();
      cases.push(c);
      return c;
    }
    let serial = 0;
    async function start(c, jar = c.jar) {
      const number = ++serial;
      const response = await request("/auth/login", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ schemaVersion: 1, workspaceId: c.f.workspace }),
      });
      check(
        "real_https_preauth_cookie_" + number,
        response.status === 200 &&
          response.headers.getSetCookie().length === 1 &&
          jar.ingest(origin + "/auth/login", response.headers).accepted === 1,
      );
      const authorizationUrl = JSON.parse(response.text).authorizationUrl;
      const callback = c.provider.arm(authorizationUrl);
      privateMarkers.push(callback.code, callback.token, authorizationUrl);
      return { callback, jar, number };
    }
    async function finish(c, prepared, success = true) {
      const { callback, jar, number } = prepared;
      const url = new URL(callback.callbackUrl);
      const headers = {
        Cookie: jar.header(callback.callbackUrl),
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Site": "cross-site",
      };
      const response = await request(url.pathname + url.search, { headers });
      if (!success) return { response, path: url.pathname + url.search, headers };
      check(
        "real_84_69_crypto_76_77_m_cookie_" + number,
        response.status === 303 &&
          response.headers.get("location") === "/" &&
          response.headers.getSetCookie().length === 1 &&
          jar.ingest(callback.callbackUrl, response.headers).accepted === 1,
      );
      const header = jar.header(origin + "/");
      const secret = /(?:^|; )__Host-morrow_session=([^;]+)/.exec(header)?.[1];
      check(
        "issued_cookie_canonical_" + number,
        typeof secret === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(secret),
      );
      privateMarkers.push(secret, hash(secret));
      return {
        response,
        jar,
        header,
        secret,
        ...receipt(secret),
        path: url.pathname + url.search,
        headers,
      };
    }
    const issue = async (c, jar = c.jar) => finish(c, await start(c, jar));
    const bootstrap = (c, header) =>
      request(`/workspace/${c.f.workspace}/bootstrap`, { headers: { Cookie: header } });
    const logout = (header) =>
      request("/auth/logout", {
        method: "POST",
        headers: { ...authHeaders(), Cookie: header },
        body: '{"schemaVersion":1}',
      });
    const ended = (response) =>
      response.status === 200 &&
      response.text === '{"schemaVersion":1,"outcome":"session_ended"}' &&
      response.headers.getSetCookie().length === 0;
    const link = (c, handoff, header, kind, csrf) =>
      request(`/workspace/${c.f.workspace}/store-links${kind === "apply" ? "" : "/" + kind}`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          Cookie: header,
          "Idempotency-Key": handoff.commandId,
          ...(kind === "apply" && csrf ? { "X-Morrow-CSRF": csrf } : {}),
        },
        body: JSON.stringify({ handoffToken: handoff.handoffToken }),
      });
    let operationError,
      result,
      cleanupVerified = false;
    try {
      check(
        "merchant_https_rejects_untrusted_test_ca",
        await tls.untrustedFetch(origin + "/auth/login").then(
          () => false,
          () => true,
        ),
      );
      phase("closed_chain");
      const defaultReply = await request("/auth/login", { method: "POST" });
      check(
        "default_entry_remains_denied",
        defaultReply.status === 404 &&
          defaultReply.headers.getSetCookie().length === 0 &&
          cases.length === 0,
      );
      const c = await fresh();
      const issued = await issue(c);
      check(
        "exact_real_69_reservation_precedes_cookie",
        exchangeReservations(c) === 1 &&
          harness.admin(
            `SELECT count(*) FROM morrow_identity.browser_session_commands WHERE family_id=${lit(issued.family_id)} AND outcome='admitted';`,
          ) === "1",
      );
      check(
        "fixed_exchange_jwks_sessions_order",
        c.provider.calls.map((call) => call.kind).join(",") === "exchange,publicKeyset,sessionPage",
      );
      check(
        "broad_marker_only_exact_session_get",
        c.provider.calls.every((call) => call.managementMarker === (call.kind === "sessionPage")),
      );
      check(
        "one_acknowledged_fixed_purpose_lease",
        c.provider.metrics.borrows === 1 &&
          c.provider.metrics.releaseAttempts === 1 &&
          c.provider.metrics.releaseCompletions === 1 &&
          c.provider.metrics.activeLeases === 0,
      );
      check("issued_cookie_reads_workspace_o", (await bootstrap(c, issued.header)).status === 200);
      const handoff = await seedStandaloneLinkingFixture(harness, {
        f: c.f,
        result: { outcome: "newly_admitted", credential: { secret: issued.secret } },
      });
      const preview = await link(c, handoff, issued.header, "preview");
      check(
        "issued_cookie_reviews_linking_b",
        preview.status === 200 && preview.headers.getSetCookie().length === 0,
      );
      const csrf = JSON.parse(preview.text).csrfToken;
      const beforeRequests = c.provider.metrics.requests;
      const replay = await request(issued.path, { headers: issued.headers });
      check(
        "callback_replay_does_not_exchange_again",
        callbackHeld(replay) &&
          c.provider.metrics.requests === beforeRequests &&
          c.provider.metrics.exchange === 1 &&
          familyCount(c) === 1,
      );
      const endedReply = await logout(issued.header);
      check(
        "same_cookie_q_logout_retires_one_family",
        ended(endedReply) && revocations(issued.family_id) === 1,
      );
      check(
        "q_logout_never_rewrites_cookie",
        c.jar.ingest(origin + "/auth/logout", endedReply.headers).accepted === 0 &&
          c.jar.header(origin + "/") === issued.header,
      );
      check("retired_cookie_denied_o", (await bootstrap(c, issued.header)).status === 401);
      for (const kind of ["preview", "apply", "status"]) {
        const response = await link(c, handoff, issued.header, kind, csrf);
        check(
          "retired_cookie_denied_b_" + kind,
          response.status === 404 &&
            response.text === '{"code":"linking_not_found"}' &&
            response.headers.getSetCookie().length === 0,
        );
      }
      check(
        "retired_cookie_no_link_apply",
        !c.linkingTrace.includes(workspaceStoreLinkingSql.apply),
      );
      check(
        "retired_cookie_cannot_consume_handoff",
        harness.admin(
          `SELECT (SELECT count(*) FROM morrow_identity.workspace_store_links WHERE installation_id=${lit(handoff.installationId)})::text||':'||(SELECT consumed_at IS NULL FROM morrow_identity.linking_handoffs WHERE id=${lit(handoff.input.handoffId)})::text;`,
        ) === "0:true",
      );
      check("logout_never_calls_provider", c.provider.metrics.requests === beforeRequests);

      phase("independent_concurrent_callbacks");
      const concurrent = await fresh();
      const first = await start(concurrent, createBoundedLoginCookieJar());
      const second = await start(concurrent, createBoundedLoginCookieJar());
      const [a, b] = await Promise.all([finish(concurrent, first), finish(concurrent, second)]);
      check(
        "independent_callbacks_no_shared_used_flag",
        a.secret !== b.secret &&
          a.family_id !== b.family_id &&
          a.provider_binding_id === b.provider_binding_id &&
          familyCount(concurrent) === 2,
      );
      check(
        "independent_callbacks_two_complete_wire_chains",
        concurrent.provider.metrics.exchange === 2 &&
          concurrent.provider.metrics.publicKeyset === 2 &&
          concurrent.provider.metrics.sessionPage === 2 &&
          concurrent.provider.metrics.borrows === 2 &&
          concurrent.provider.metrics.releaseAttempts === 2 &&
          concurrent.provider.metrics.releaseCompletions === 2,
      );
      check("concurrent_cookie_a_reads_o", (await bootstrap(concurrent, a.header)).status === 200);
      check("concurrent_cookie_b_reads_o", (await bootstrap(concurrent, b.header)).status === 200);
      check(
        "logout_a_preserves_b",
        ended(await logout(a.header)) &&
          (await bootstrap(concurrent, a.header)).status === 401 &&
          (await bootstrap(concurrent, b.header)).status === 200,
      );

      phase("delayed_old_logout_new_login");
      const committed = Promise.withResolvers(),
        gate = Promise.withResolvers();
      let armed = false;
      const race = await fresh({
        async afterCommit(control) {
          if (!armed) return;
          committed.resolve();
          await bounded(
            Promise.race([
              gate.promise,
              new Promise((resolve) =>
                control.signal.addEventListener("abort", resolve, { once: true }),
              ),
            ]),
            5000,
          );
        },
      });
      const older = await issue(race);
      armed = true;
      let delivered = false;
      const pending = logout(older.header).then((response) => {
        delivered = true;
        return response;
      });
      await bounded(committed.promise);
      check("old_logout_effect_precedes_ack", !delivered && revocations(older.family_id) === 1);
      const newerJar = createBoundedLoginCookieJar();
      const newer = await issue(race, newerJar);
      gate.resolve();
      const delayed = await pending;
      armed = false;
      check(
        "late_old_ack_cannot_clear_new_issued_cookie",
        ended(delayed) &&
          newerJar.ingest(origin + "/auth/logout", delayed.headers).accepted === 0 &&
          newerJar.header(origin + "/") === newer.header &&
          newer.secret !== older.secret,
      );
      check(
        "new_family_remains_live_after_old_ack",
        revocations(newer.family_id) === 0 &&
          newer.provider_binding_id === older.provider_binding_id &&
          (await bootstrap(race, newer.header)).status === 200,
      );

      phase("provider_boundary_holds");
      for (const fault of [
        "exchange_redirect",
        "signature",
        "wrong_namespace",
        "release_rejected",
        "late_keyset",
      ]) {
        const failed = await fresh({ fault });
        const prepared = await start(failed);
        const outcome = await finish(failed, prepared, false);
        check(
          "fault_" + fault + "_no_cookie_or_family",
          callbackHeld(outcome.response) &&
            familyCount(failed) === 0 &&
            failed.provider.faultCount() === 1,
        );
        check(
          "fault_" + fault + "_keeps_consumed_69_reservation",
          exchangeReservations(failed) === 1,
        );
        const before = failed.provider.metrics.requests;
        const repeated = await request(outcome.path, { headers: outcome.headers });
        check(
          "fault_" + fault + "_no_callback_resend",
          callbackHeld(repeated) &&
            failed.provider.metrics.requests === before &&
            failed.provider.metrics.exchange === 1,
        );
        if (fault === "exchange_redirect")
          check(
            "redirect_never_follows_or_borrows",
            before === 1 && failed.provider.metrics.borrows === 0,
          );
        if (fault === "signature")
          check(
            "invalid_native_rsa_signature_never_lists_sessions",
            failed.provider.metrics.publicKeyset === 1 &&
              failed.provider.metrics.sessionPage === 0 &&
              failed.provider.metrics.borrows === 0,
          );
        if (fault === "wrong_namespace")
          check(
            "wrong_namespace_lease_released_once_without_session_fetch",
            failed.provider.metrics.sessionPage === 0 &&
              failed.provider.metrics.releaseAttempts === 1 &&
              failed.provider.metrics.releaseCompletions === 1,
          );
        if (fault === "release_rejected")
          check(
            "unacknowledged_lease_never_forwards_page",
            failed.provider.metrics.sessionPage === 1 &&
              failed.provider.metrics.releaseAttempts === 1 &&
              failed.provider.metrics.releaseCompletions === 0 &&
              failed.provider.cleanupObservation().credentialDisposal ===
                "intentionally_unverified",
          );
        if (fault === "late_keyset")
          check(
            "late_keyset_never_renews_observation_or_borrows",
            failed.provider.metrics.publicKeyset === 1 &&
              failed.provider.metrics.sessionPage === 0 &&
              failed.provider.metrics.borrows === 0,
          );
      }
      phase("cleanup_and_privacy");
      const unacquired = cases.filter((entry) => entry.provider.metrics.borrows === 0);
      check(
        "unacquired_credential_has_no_release_acknowledgement",
        unacquired.length === 3 &&
          unacquired.every((entry) => {
            const observation = entry.provider.cleanupObservation();
            return (
              observation.credentialDisposal === "not_acquired" &&
              observation.releaseAttempts === 0 &&
              observation.releaseCompletions === 0 &&
              observation.activeLeases === 0
            );
          }),
      );
      const closed = await Promise.allSettled([
        harness.close(),
        ...readPools.map((pool) => pool.close()),
      ]);
      check(
        "all_pool_close_acknowledgements",
        closed.every((reply) => reply.status === "fulfilled"),
      );
      cleanupVerified = true;
      check(
        "all_sql_clients_physical_and_backend_absence",
        poolList().every(
          (pool) =>
            pool.metrics.connections === pool.metrics.released &&
            pool.metrics.released === pool.metrics.closed &&
            pool.metrics.closed === pool.metrics.backendCleanupVerified &&
            pool.metrics.unverifiedHostClosures === 0,
        ),
      );
      const publicBodies = responseBodies.join("\n");
      const markers = [
        ...privateMarkers,
        ...harness.secrets,
        ...cases.flatMap((entry) => [
          ...entry.provider.privateMarkers,
          ...entry.provider.oracle.secrets,
        ]),
      ];
      check(
        "merchant_bodies_do_not_echo_private_provider_or_cookie_material",
        markers.every(
          (marker) =>
            typeof marker !== "string" || marker.length < 16 || !publicBodies.includes(marker),
        ),
      );
      check("synthetic_factory_never_uses_native_fetch", nativeFetchAttempts === 0);
      check(
        "management_marker_never_on_post_or_jwks",
        cases.every((entry) =>
          entry.provider.calls.every(
            (call) => call.managementMarker === (call.kind === "sessionPage"),
          ),
        ),
      );
      result = {
        merchantHttpsRequests: requests,
        caseCount: cases.length,
        roleCleanup: poolList().map((pool) => ({ ...pool.metrics })),
        providers: cases.map((entry) => ({
          metrics: { ...entry.provider.metrics },
          calls: entry.provider.calls,
          credentialCleanup: entry.provider.cleanupObservation(),
        })),
        holders: { created: 0, cleanup: "not_applicable_no_lock_holder_in_this_lab" },
        nativeFetchAttempts,
        actualProviderRequests: 0,
      };
    } catch (error) {
      operationError = error;
    } finally {
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      const transportCleanup = await Promise.allSettled([
        bounded(new Promise((resolve) => server.close(resolve))),
        bounded(Promise.all([...clientClosures, ...socketClosures])),
      ]);
      listenerClosed = transportCleanup.every((reply) => reply.status === "fulfilled");
      if (!listenerClosed) {
        console.error("FIXED_PROVIDER_HTTPS_TRANSPORT_CLEANUP_HELD:" + stage);
        if (!operationError)
          operationError = Error("FIXED_PROVIDER_HTTPS_TRANSPORT_CLEANUP_UNVERIFIED");
      }
      if (!cleanupVerified) {
        const closed = await Promise.allSettled([
          harness.close(),
          ...readPools.map((pool) => pool.close()),
        ]);
        if (closed.some((reply) => reply.status !== "fulfilled")) {
          console.error("FIXED_PROVIDER_HTTPS_CLEANUP_HELD:" + stage);
          if (!operationError)
            operationError = Error("FIXED_PROVIDER_HTTPS_SQL_CLEANUP_UNVERIFIED");
        }
      }
    }
    if (operationError) throw operationError;
    check("all_merchant_client_connections_closed", clientClosed === requests);
    check(
      "all_server_sockets_closed",
      sockets.size === 0 && serverClosed === socketClosures.length,
    );
    return {
      ...result,
      merchantConnectionCleanup: {
        requests,
        clientClosed,
        serverConnections: socketClosures.length,
        serverClosed,
      },
      cleanup: { hostClients: "closed", backendNamespace: "absent", httpsListener: "closed" },
    };
  });
} catch (error) {
  primaryError = error;
} finally {
  globalThis.fetch = nativeFetch;
  try {
    tlsCleanup = await tls.cleanup();
  } catch {
    console.error("FIXED_PROVIDER_HTTPS_TLS_CLEANUP_HELD:" + stage);
    if (!primaryError) primaryError = Error("FIXED_PROVIDER_HTTPS_TLS_CLEANUP_UNVERIFIED");
  }
}
if (primaryError) throw primaryError;
check("merchant_https_listener_closed", listenerClosed);
check(
  "private_tls_keys_directory_and_client_agents_closed",
  tlsCleanup?.clientsClosed === true && tlsCleanup?.privateDirectoryAbsent === true,
);
const absence = containerCommand([
  "ps",
  "--all",
  "--no-trunc",
  "--filter",
  "id=" + ownedContainer,
  "--format",
  "{{.ID}}",
]);
check(
  "exact_owned_postgresql_container_absent",
  absence.status === 0 && absence.stdout.trim() === "",
);
for (const [path, digest] of Object.entries(sourceDigests))
  check(
    "source_unchanged_" + path.replace(/[^a-z0-9]/gi, "_").toLowerCase(),
    hash(readFileSync(path)) === digest,
  );
const report = {
  schemaVersion: 1,
  task: "P05.T01r",
  canonicalSequence: 87,
  qualification:
    "private_fixed_workos_port_independent_synthetic_fetch_real_postgresql_merchant_https_jar_o_b_q",
  observedAt: new Date().toISOString(),
  sourceDigests,
  sourceDigest: hash(JSON.stringify(Object.entries(sourceDigests).sort())),
  appliedMigrations: 11,
  checks,
  checkCount: checks.length,
  providerRequests: 0,
  browserEngineQualified: false,
  providerTransport: {
    kind: "independent_in_process_synthetic_fetch",
    normalizedResponseUrl: true,
    actualWorkosDnsTlsOrAccountQualified: false,
    providerNetworkListeners: 0,
  },
  merchantTransport: {
    kind: "actual_loopback_https",
    tls: tls.metadata,
    cookieJar: "bounded_locked_standard_parser",
  },
  result: measured,
  cleanup: { httpsListener: "closed", tlsDirectory: "absent", ownedContainer: "absent" },
  limitations: [
    "Independent RSA/PKCE/HTTP fixture feeds the real adapter and unchanged84→69→72→78→76→77→M chain; provider final URLs are synthetic attestations, not native DNS/TLS proof.",
    "Actual local merchant HTTPS and a bounded test cookie jar do not qualify browser-engine cookie enforcement, hosted custody or merchant activation.",
    "The deliberately rejected lease release is retained as one attempted but unacknowledged synthetic disposal; no page/cookie or release retry follows it.",
    "Late-keyset negative advances only its synthetic clock after Fetch; original callback, operation and five-second observation lifetimes are not extended.",
    "No real WorkOS request, owned credential, Shopify call, live sign-in, refresh or provider logout occurs.",
  ],
};
const text = JSON.stringify(report, null, 2) + "\n";
const privateValues = [
  "synthetic_management_marker_86_only",
  "synthetic_dropped_refresh_marker",
  "synthetic_dropped_oauth_marker",
];
if (privateValues.some((value) => text.includes(value)))
  throw Error("FIXED_PROVIDER_HTTPS_REPORT_PRIVACY");
mkdirSync("docs/evidence/P05.T01s/regressions", { recursive: true });
writeFileSync("docs/evidence/P05.T01s/regressions/fixed-provider-https.json", text);
console.log(
  "PASS: " +
    checks.length +
    " fixed provider-port actual PostgreSQL/merchant HTTPS checks; zero actual provider requests; owned resources removed.",
);
