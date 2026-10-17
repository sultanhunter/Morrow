import { createServer, request as httpsRequest } from "node:https";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWorkspaceApiHttpListener } from "../apps/api/src/workspace-router.ts";
import { createStandaloneLoginBridge } from "../packages/identity/src/standalone-login.ts";
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
import { createSyntheticLoginProvider } from "./fixtures/login-provider.mjs";
import { seedStandaloneLinkingFixture } from "./fixtures/standalone-linking-fixture.mjs";
import { standaloneSqlLiteral as lit } from "./standalone-session-fixtures.mjs";
import { localStandaloneSqlPool } from "./local-standalone-sql.mjs";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { writeArtifact } from "./artifacts.mjs";
const hash = (x) => createHash("sha256").update(x).digest("hex");
const checks = [];
const check = (name, value) => {
  if (!value || !/^[a-z][a-z0-9_]{1,119}$/.test(name) || checks.some((x) => x.name === name))
    throw Error("LOGOUT_HTTPS_LAB_FAILED:" + name);
  checks.push({ name, passed: true });
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function bounded(p, ms = 10000) {
  let t;
  try {
    return await Promise.race([
      p,
      new Promise((_, j) => {
        t = setTimeout(() => j(Error("LOGOUT_HTTPS_LAB_TIMEOUT")), ms);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}
const paths = [
  "scripts/standalone-logout-https-lab.mjs",
  "scripts/fixtures/self-logout-fixture.mjs",
  "scripts/local-self-logout-sql.mjs",
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
  "packages/identity/src/standalone-logout.ts",
  "packages/identity/src/self-logout-control.ts",
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
  "infra/identity-logout-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  ".nvmrc",
  "package.json",
  "package-lock.json",
  "packages/identity/package.json",
  "packages/contracts/package.json",
  "tsconfig.base.json",
];
if (process.version !== "v24.13.0") throw Error("LOGOUT_HTTPS_SOURCE_REQUIRED");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
// Every published migration must be present in order and checksum-verified. The
// self-logout fixture applies exactly the first eleven, so the count stays exact until
// this lab also applies later migrations; a twelfth migration must fail here.
if (manifest.migrations.length !== 11) throw Error("LOGOUT_HTTPS_ELEVEN_MIGRATIONS_REQUIRED");
for (const [i, m] of manifest.migrations.entries()) {
  if (m.sequence !== i + 1 || hash(readFileSync("migrations/" + m.file)) !== m.sha256)
    throw Error("LOGOUT_HTTPS_MIGRATION_HASH");
  paths.push("migrations/" + m.file);
}
const sources = Object.fromEntries(paths.map((p) => [p, hash(readFileSync(p))]));
const tls = await createLocalLoginTlsFixture();
let ownedContainer,
  listenerClosed = false,
  tlsCleanup,
  measured;
const readPools = [],
  cases = [],
  markers = [],
  bodies = [];
let stage = "setup";
const phase = (s) => {
  stage = s;
  console.error("LOGOUT_HTTPS_PHASE:" + s);
};
try {
  measured = await localPostgresLab("P05.T01q-https", async (engine) => {
    ownedContainer = engine.id;
    const h = createSelfLogoutFixtureHarness(engine);
    let listener = createWorkspaceApiHttpListener();
    const server = createServer({ ...tls.serverOptions, maxHeaderSize: 8192 }, (q, s) =>
      listener(q, s),
    );
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.maxHeadersCount = 64;
    await new Promise((r, j) => {
      server.once("error", j);
      server.listen(0, "127.0.0.1", r);
    });
    const origin = "https://127.0.0.1:" + server.address().port;
    let requestCount = 0;
    const request = (
      path,
      { method = "GET", headers = {}, body, chunked = false, rawHeaders, onRequest } = {},
    ) => {
      requestCount++;
      return new Promise((r, j) => {
        const q = httpsRequest(
          origin + path,
          {
            method,
            ca: tls.ca,
            rejectUnauthorized: true,
            agent: false,
            headers: rawHeaders ?? {
              Host: new URL(origin).host,
              Connection: "close",
              ...headers,
              ...(body === undefined
                ? {}
                : chunked
                  ? { "Transfer-Encoding": "chunked" }
                  : { "Content-Length": Buffer.byteLength(body) }),
            },
          },
          (s) => {
            let text = "";
            s.on("data", (c) => {
              text += c;
              if (Buffer.byteLength(text) > 8192) q.destroy();
            });
            s.once("error", () => j(Error("LOGOUT_HTTPS_CLIENT_HELD")));
            s.once("end", () => {
              const hs = new Headers();
              for (let i = 0; i < s.rawHeaders.length; i += 2)
                hs.append(s.rawHeaders[i], s.rawHeaders[i + 1]);
              if (path !== "/auth/login" || s.statusCode !== 200) bodies.push(text);
              r({ status: s.statusCode, headers: hs, text });
            });
          },
        );
        q.once("error", () => j(Error("LOGOUT_HTTPS_CLIENT_HELD")));
        q.setTimeout(30000, () => q.destroy());
        onRequest?.(q);
        q.end(body);
      });
    };
    const safe = (r) =>
      r.headers.get("cache-control") === "no-store" &&
      r.headers.get("x-content-type-options") === "nosniff" &&
      r.headers.get("referrer-policy") === "no-referrer" &&
      !r.headers.has("access-control-allow-origin");
    const noCookie = (r) =>
      r.headers.getSetCookie().length === 0 && !r.headers.has("location") && safe(r);
    const ended = (r) =>
      r.status === 200 && r.text === '{"schemaVersion":1,"outcome":"session_ended"}' && noCookie(r);
    const allPools = () => [...h.rolePools, ...h.logoutRolePools, ...readPools];
    const sqlCount = () => allPools().reduce((n, p) => n + p.metrics.connections, 0);
    const identityCount = () =>
      h.admin(
        "SELECT (SELECT count(*) FROM morrow_identity.principals)::text||':'||(SELECT count(*) FROM morrow_identity.memberships)::text||':'||(SELECT count(*) FROM morrow_identity.workspace_memberships)::text||':'||(SELECT count(*) FROM morrow_identity.grants)::text;",
      );
    const familyRows = (f) =>
      JSON.parse(
        h.admin(
          `SELECT COALESCE(json_agg(row_to_json(x)),'[]'::json)::text FROM (SELECT f.id::text,f.record_revision::text,f.revoked_at::text,g.id::text AS generation_id,g.revoked_at::text AS generation_revoked_at FROM morrow_identity.browser_session_families f JOIN morrow_identity.browser_session_generations g ON g.family_id=f.id JOIN morrow_identity.provider_session_bindings pb ON pb.id=f.provider_binding_id WHERE pb.profile_id=${lit(f.profile)} ORDER BY f.created_at,f.id) x;`,
        ),
      );
    const receipt = (c, secret) =>
      JSON.parse(
        h.admin(
          `SELECT row_to_json(x)::text FROM (SELECT f.id::text AS family_id,g.id::text AS generation_id,pb.id::text AS provider_binding_id FROM morrow_identity.browser_session_generations g JOIN morrow_identity.browser_session_families f ON f.id=g.family_id JOIN morrow_identity.provider_session_bindings pb ON pb.id=f.provider_binding_id WHERE g.secret_digest=${lit(hash(secret))}) x;`,
        ),
      );
    const relatedSnapshot = (f) =>
      h.admin(
        `SELECT json_build_object('provider',(SELECT COALESCE(json_agg(row_to_json(p)),'[]'::json) FROM morrow_identity.provider_session_bindings p WHERE p.profile_id=${lit(f.profile)}),'generations',(SELECT COALESCE(json_agg(row_to_json(g) ORDER BY g.id),'[]'::json) FROM morrow_identity.browser_session_generations g JOIN morrow_identity.browser_session_families f ON f.id=g.family_id JOIN morrow_identity.provider_session_bindings p ON p.id=f.provider_binding_id WHERE p.profile_id=${lit(f.profile)}))::text;`,
      );
    const auditCount = (id) =>
      Number(
        h.admin(
          `SELECT count(*) FROM morrow_identity.browser_session_audits WHERE kind='family' AND target_id=${lit(id)} AND outcome='revoked';`,
        ),
      );
    async function fresh(options = {}) {
      const cfg = h.configured({ origin });
      const c = {
        ...cfg,
        trace: [],
        linkingTrace: [],
        logoutPlans: [],
        logoutCalls: 0,
        jar: createBoundedLoginCookieJar(),
        options,
      };
      c.provider = createSyntheticLoginProvider({
        configurationJson: cfg.configurationJson,
        subjectId: c.f.subject,
        providerSessionId: c.f.sid,
      });
      const roleSpec = {
        login: ["morrow_identity_login", loginFlowCustodySql],
        preauth: ["morrow_identity_preauth", authenticationExchangeAdmissionSql],
        selection: ["morrow_identity_resolution", workspaceSelectionSql],
        session: ["morrow_identity_sessions", browserSessionAdmissionSql],
      };
      const pools = {};
      for (const [k, [role, sql]] of Object.entries(roleSpec))
        pools[k + "Pool"] = h.pool(role, Object.values(sql));
      c.auth = await createStandaloneLoginBridge({
        configurationJson: cfg.configurationJson,
        ...pools,
        providerPort: c.provider.port,
        now: Date.now,
      });
      const logoutBase = h.pool("morrow_identity_logout", Object.values(selfLogoutSql));
      c.logoutPool = {
        async connect(control) {
          const base = await logoutBase.connect(control);
          let invoked = false,
            committed = false;
          return {
            async query(text, values, qc) {
              const name =
                Object.entries(selfLogoutSql).find(([, v]) => v === text)?.[0] ?? "unknown";
              c.trace.push(name);
              if (text === selfLogoutSql.end) {
                invoked = true;
                c.logoutCalls++;
              }
              const result = await base.query(text, values, qc);
              if (text === selfLogoutSql.commit && invoked) {
                committed = true;
                options.afterCommit?.();
                if (options.commitGate) await options.commitGate(qc);
                if (options.fault === "commit") throw Error("SYNTHETIC_LOGOUT_ACK_LOSS");
              }
              return result;
            },
            async release(discard) {
              await base.release(discard);
              if (options.releaseGate) await options.releaseGate();
              if (invoked && committed && options.fault === "release")
                throw Error("SYNTHETIC_LOGOUT_ACK_LOSS");
            },
          };
        },
      };
      c.logout = await createStandaloneLogout({
        configurationJson: h.logoutConfiguration(cfg),
        pool: c.logoutPool,
        now: Date.now,
      });
      c.apiPool = localStandaloneSqlPool(engine.id, "morrow_api", Object.values(identitySql));
      readPools.push(c.apiPool);
      c.linkPool = localStandaloneSqlPool(
        engine.id,
        "morrow_identity_linking",
        [
          ...Object.values(workspaceStoreLinkingSql),
          ...Object.values(workspaceStoreLinkingControlSql),
        ],
        { beforeQuery: (statement) => c.linkingTrace.push(statement) },
      );
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
          auth: c.auth,
          logout: {
            dispatch(request, sink) {
              request.signal.addEventListener("abort", () => options.abortObserved?.resolve(), {
                once: true,
              });
              return c.logout.dispatch(request, (plan) => {
                c.logoutPlans.push(plan.status);
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
    const authHeaders = () => ({
      Origin: origin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
    });
    async function issue(c, jar = c.jar) {
      c.activate();
      const start = await request("/auth/login", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ schemaVersion: 1, workspaceId: c.f.workspace }),
      });
      check(
        "login_start_cookie_" + c.f.n + "_" + c.provider.metrics.exchange,
        start.status === 200 &&
          start.headers.getSetCookie().length === 1 &&
          jar.ingest(origin + "/auth/login", start.headers).accepted === 1,
      );
      const callback = c.provider.arm(JSON.parse(start.text).authorizationUrl);
      markers.push(callback.code, JSON.parse(start.text).authorizationUrl);
      const response = await request(
        new URL(callback.callbackUrl).pathname + new URL(callback.callbackUrl).search,
        {
          headers: {
            Cookie: jar.header(callback.callbackUrl),
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Site": "cross-site",
          },
        },
      );
      check(
        "owning_login_69_76_77_m_cookie_" + c.f.n + "_" + c.provider.metrics.exchange,
        response.status === 303 &&
          response.headers.get("location") === "/" &&
          response.headers.getSetCookie().length === 1 &&
          jar.ingest(callback.callbackUrl, response.headers).accepted === 1,
      );
      const header = jar.header(origin + "/"),
        secret = /(?:^|; )__Host-morrow_session=([^;]+)/.exec(header)[1];
      markers.push(secret, hash(secret));
      return { jar, header, secret, ...receipt(c, secret) };
    }
    const logout = (header, options = {}) => {
      const { headers = {}, ...rest } = options;
      return request("/auth/logout", {
        method: "POST",
        headers: { ...authHeaders(), Cookie: header, ...headers },
        body: options.body ?? '{"schemaVersion":1}',
        ...rest,
      });
    };
    const bootstrap = (c, header) =>
      request(`/workspace/${c.f.workspace}/bootstrap`, { headers: { Cookie: header } });
    const b = (c, handoff, header, kind, csrf) =>
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
    let cleanupVerified = false;
    try {
      phase("default_and_primary");
      const denied = await request("/auth/logout", { method: "POST" });
      check(
        "default_logout_denied_without_sql",
        denied.status === 404 && noCookie(denied) && sqlCount() === 0,
      );
      const c = await fresh();
      const original = await issue(c);
      check(
        "same_issued_cookie_bootstraps_before_logout",
        (await bootstrap(c, original.header)).status === 200,
      );
      await fresh();
      const foreignReply = await logout(original.header);
      check(
        "foreign_trusted_namespace_cannot_retire_captured_credential",
        foreignReply.status === 403 &&
          noCookie(foreignReply) &&
          auditCount(original.family_id) === 0,
      );
      c.activate();
      const handoff = await seedStandaloneLinkingFixture(h, {
        f: c.f,
        result: { outcome: "newly_admitted", credential: { secret: original.secret } },
      });
      const preview = await b(c, handoff, original.header, "preview");
      check("issued_cookie_reviewed_link_preview", preview.status === 200);
      const csrf = JSON.parse(preview.text).csrfToken;
      const beforeIdentity = identityCount(),
        beforeFamilies = familyRows(c.f),
        beforeRelated = relatedSnapshot(c.f);
      const result = await logout(original.header);
      check("real_https_captured_cookie_ends_derived_family", ended(result));
      check(
        "logout_keeps_cookie_jar_exactly_unchanged",
        c.jar.ingest(origin + "/auth/logout", result.headers).accepted === 0 &&
          c.jar.header(origin + "/") === original.header,
      );
      check(
        "logout_exactly_one_revocation_audit_revision",
        auditCount(original.family_id) === 1 &&
          familyRows(c.f)[0].record_revision === "2" &&
          familyRows(c.f)[0].revoked_at !== null &&
          beforeFamilies[0].record_revision === "1",
      );
      check(
        "same_still_present_cookie_denied_o",
        (await bootstrap(c, original.header)).status === 401,
      );
      for (const kind of ["preview", "apply", "status"]) {
        const statement =
          kind === "status"
            ? workspaceStoreLinkingControlSql.status
            : workspaceStoreLinkingControlSql.lookup;
        const beforeLookup = c.linkingTrace.filter((text) => text === statement).length;
        const r = await b(c, handoff, original.header, kind, csrf);
        if (r.status !== 404 || r.text !== '{"code":"linking_not_found"}') {
          const code =
            ["linking_not_found", "request_denied", "unavailable", "authentication_required"].find(
              (value) => r.text === JSON.stringify({ code: value }),
            ) ?? "other_shape";
          console.error(
            "LOGOUT_HTTPS_LINKING_DIAGNOSTIC " +
              JSON.stringify({
                stage: kind,
                status: r.status,
                code,
                privateReadCount:
                  c.linkingTrace.filter((text) => text === statement).length - beforeLookup,
              }),
          );
        }
        check(
          "same_still_present_cookie_denied_b_" + kind,
          r.status === 404 &&
            r.text === '{"code":"linking_not_found"}' &&
            r.headers.getSetCookie().length === 0 &&
            c.linkingTrace.filter((text) => text === statement).length === beforeLookup + 1 &&
            !c.linkingTrace.includes(workspaceStoreLinkingSql.apply),
        );
      }
      check(
        "retired_cookie_cannot_consume_handoff_or_create_link",
        h.admin(
          `SELECT (SELECT count(*) FROM morrow_identity.workspace_store_links WHERE installation_id=${lit(handoff.installationId)})::text||':'||(SELECT consumed_at IS NULL FROM morrow_identity.linking_handoffs WHERE id=${lit(handoff.input.handoffId)})::text;`,
        ) === "0:true",
      );
      check(
        "logout_does_not_change_identity_membership_grants",
        identityCount() === beforeIdentity,
      );
      check(
        "logout_preserves_provider_binding_and_generation_records",
        relatedSnapshot(c.f) === beforeRelated,
      );
      const after = familyRows(c.f);
      const replay = await logout(original.header);
      check(
        "explicit_replayed_request_acknowledges_old_state_without_write",
        ended(replay) &&
          JSON.stringify(familyRows(c.f)) === JSON.stringify(after) &&
          auditCount(original.family_id) === 1,
      );
      phase("no_sql_ingress");
      const bads = [
        ["missing_origin", { headers: { Origin: "" } }, 403],
        ["foreign_origin", { headers: { Origin: "https://foreign.invalid" } }, 403],
        ["missing_custom", { headers: { "X-Morrow-Request": "" } }, 403],
        ["foreign_fetch", { headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
        ["authority_field", { body: '{"schemaVersion":1,"familyId":"foreign"}' }, 400],
        ["duplicate_json", { body: '{"schemaVersion":1,"schemaVersion":1}' }, 400],
        ["malformed_json", { body: '{"schemaVersion":' }, 400],
        ["invalid_utf8", { body: Buffer.from([0xff]) }, 400],
        ["oversize", { body: " ".repeat(257) }, 400],
        ["oversize_chunked", { body: " ".repeat(4096), chunked: true }, 400],
        [
          "cookie_duplicate",
          { headers: { Cookie: original.header + "; __Host-morrow_session=" + original.secret } },
          403,
        ],
        [
          "cookie_case_variant",
          { headers: { Cookie: original.header + "; __host-morrow_session=" + original.secret } },
          403,
        ],
        ["authority_header", { headers: { Authorization: "Bearer synthetic" } }, 400],
        ["idempotency_header", { headers: { "Idempotency-Key": randomUUID() } }, 403],
      ];
      for (const [name, opts, status] of bads) {
        const n = sqlCount(),
          r = await logout(original.header, opts);
        check(
          "ingress_" + name + "_zero_sql",
          r.status === status && r.headers.getSetCookie().length === 0 && sqlCount() === n,
        );
      }
      phase("unrelated_family_and_delayed_response");
      const gate = Promise.withResolvers(),
        committed = Promise.withResolvers();
      let armed = false;
      const race = await fresh({
        afterCommit: () => {
          if (armed) committed.resolve();
        },
        commitGate: async (control) => {
          if (!armed) return;
          await bounded(
            Promise.race([
              gate.promise,
              new Promise((r) => control.signal.addEventListener("abort", r, { once: true })),
            ]),
            5000,
          );
        },
      });
      const old = await issue(race);
      armed = true;
      let finished = false;
      const pending = logout(old.header).then((r) => {
        finished = true;
        return r;
      });
      await bounded(committed.promise);
      check(
        "old_logout_committed_but_response_still_pending",
        !finished && auditCount(old.family_id) === 1,
      );
      const newerJar = createBoundedLoginCookieJar(),
        newer = await issue(race, newerJar);
      gate.resolve();
      const delayed = await pending;
      armed = false;
      check(
        "delayed_old_response_cannot_clear_new_login_cookie",
        ended(delayed) &&
          newerJar.ingest(origin + "/auth/logout", delayed.headers).accepted === 0 &&
          newerJar.header(origin + "/") === newer.header &&
          newer.secret !== old.secret,
      );
      check(
        "same_provider_binding_other_family_preserved",
        newer.provider_binding_id === old.provider_binding_id &&
          newer.family_id !== old.family_id &&
          auditCount(newer.family_id) === 0 &&
          (await bootstrap(race, newer.header)).status === 200,
      );
      const oldAgain = await logout(old.header);
      check(
        "old_captured_request_replay_never_ends_new_family",
        ended(oldAgain) &&
          auditCount(old.family_id) === 1 &&
          auditCount(newer.family_id) === 0 &&
          (await bootstrap(race, newer.header)).status === 200,
      );
      check(
        "new_explicit_current_cookie_ends_only_new_family",
        ended(await logout(newer.header)) &&
          auditCount(newer.family_id) === 1 &&
          (await bootstrap(race, newer.header)).status === 401,
      );
      phase("inactive_and_expired_retirement");
      for (const kind of [
        "membership",
        "workspace_membership",
        "principal",
        "mapping",
        "profile",
        "provider",
        "generation",
      ]) {
        const x = await fresh(),
          issued = await issue(x),
          f = x.f;
        if (kind === "membership")
          h.admin(
            `UPDATE morrow_identity.memberships SET active=false WHERE id=${lit(f.membership)};`,
          );
        if (kind === "workspace_membership")
          h.admin(
            `UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id=${lit(f.workspace)};`,
          );
        if (kind === "principal")
          h.admin(
            `UPDATE morrow_identity.principals SET active=false WHERE id=${lit(f.principal)};`,
          );
        if (kind === "mapping")
          h.admin(
            `UPDATE morrow_identity.provider_subject_mappings SET state='revoked',record_revision=record_revision+1 WHERE id=${lit(f.mapping)};`,
          );
        if (kind === "profile")
          h.admin(
            `UPDATE morrow_identity.identity_verification_profiles SET state='revoked',record_revision=record_revision+1 WHERE id=${lit(f.profile)};`,
          );
        if (kind === "provider" || kind === "generation") {
          const fn = kind === "provider" ? "revoke_provider_binding" : "revoke_browser_generation";
          const id = kind === "provider" ? issued.provider_binding_id : issued.generation_id;
          h.admin(
            `SELECT * FROM morrow_identity.${fn}(${lit(id)},${lit(randomUUID())},${lit(hash(randomUUID()))});`,
          );
        }
        check(
          "inactive_" + kind + "_never_restores_workspace_authority",
          (await bootstrap(x, issued.header)).status === 401,
        );
        check(
          "inactive_" + kind + "_can_retire_own_family",
          ended(await logout(issued.header)) && auditCount(issued.family_id) === 1,
        );
      }
      const expired = await fresh(),
        live = await issue(expired),
        expiredSecret = randomBytes(32).toString("base64url"),
        fid = randomUUID(),
        gid = randomUUID();
      markers.push(expiredSecret, hash(expiredSecret));
      h.admin(
        `INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,created_at,expires_at) SELECT ${lit(fid)},provider_binding_id,profile_record_revision,mapping_revision,binding_revision,statement_timestamp()-interval '16 minutes',statement_timestamp()-interval '1 minute' FROM morrow_identity.browser_session_families WHERE id=${lit(live.family_id)};INSERT INTO morrow_identity.browser_session_generations(id,family_id,secret_digest,created_at,expires_at) SELECT ${lit(gid)},id,${lit(hash(expiredSecret))},created_at,expires_at FROM morrow_identity.browser_session_families WHERE id=${lit(fid)};`,
      );
      const staleHeader = "__Host-morrow_session=" + expiredSecret;
      check(
        "owner_seeded_expired_generation_denies_workspace",
        (await bootstrap(expired, staleHeader)).status === 401,
      );
      check(
        "owner_seeded_expired_credential_still_retires_its_family",
        ended(await logout(staleHeader)) &&
          auditCount(fid) === 1 &&
          auditCount(live.family_id) === 0,
      );
      phase("unknown_acknowledgements");
      for (const fault of ["commit", "release"]) {
        const x = await fresh({ fault }),
          issued = await issue(x);
        const r = await logout(issued.header);
        check(
          "actual_" + fault + "_ack_loss_unknown_no_cookie",
          r.status === 503 &&
            r.text === '{"schemaVersion":1,"outcome":"logout_outcome_unknown"}' &&
            noCookie(r),
        );
        check(
          "actual_" + fault + "_ack_loss_one_effect_no_followup_sql",
          auditCount(issued.family_id) === 1 &&
            x.logoutCalls === 1 &&
            x.trace.at(-1) === "commit" &&
            !x.trace.includes("rollback"),
        );
        check(
          "actual_" + fault + "_ack_loss_old_cookie_inert",
          (await bootstrap(x, issued.header)).status === 401,
        );
      }
      phase("http_disconnect_after_effect");
      const committed2 = Promise.withResolvers(),
        gate2 = Promise.withResolvers(),
        abortObserved = Promise.withResolvers();
      let requestHandle;
      const gone = await fresh({
          abortObserved,
          afterCommit: () => committed2.resolve(),
          commitGate: async (control) => {
            await Promise.race([
              gate2.promise,
              new Promise((r) => control.signal.addEventListener("abort", r, { once: true })),
            ]);
          },
        }),
        goneIssued = await issue(gone);
      const lost = logout(goneIssued.header, {
        onRequest: (q) => {
          requestHandle = q;
        },
      }).then(
        () => false,
        () => true,
      );
      await bounded(committed2.promise);
      requestHandle.destroy();
      await bounded(abortObserved.promise);
      gate2.resolve();
      check("disconnect_after_real_commit_cannot_deliver_success", await bounded(lost));
      for (
        let i = 0;
        i < 100 && h.logoutRolePools.some((p) => p.metrics.connections !== p.metrics.closed);
        i++
      )
        await pause(25);
      check(
        "disconnect_after_real_commit_one_effect_no_resend",
        gone.logoutCalls === 1 &&
          gone.logoutPlans.length === 0 &&
          auditCount(goneIssued.family_id) === 1 &&
          gone.trace.at(-1) === "commit",
      );
      check(
        "disconnect_old_cookie_still_denied",
        (await bootstrap(gone, goneIssued.header)).status === 401,
      );
      phase("cleanup_and_privacy");
      await h.close();
      await Promise.all(readPools.map((p) => p.close()));
      cleanupVerified = true;
      const pools = allPools();
      check(
        "all_logout_and_login_clients_physically_closed",
        pools.every(
          (p) =>
            p.metrics.connections === p.metrics.released &&
            p.metrics.released === p.metrics.closed &&
            p.metrics.closed === p.metrics.backendCleanupVerified &&
            p.metrics.unverifiedHostClosures === 0,
        ),
      );
      const privateValues = [...markers, ...h.secrets, ...cases.flatMap((c) => c.provider.secrets)];
      const publicBodies = bodies.join("\n");
      check(
        "http_bodies_do_not_echo_private_proofs",
        privateValues.every(
          (v) => typeof v !== "string" || v.length < 16 || !publicBodies.includes(v),
        ),
      );
      const publicCleanup = pools.map((p) => ({ ...p.metrics }));
      return {
        requestCount,
        caseCount: cases.length,
        roleCleanup: publicCleanup,
        providerPorts: cases.map((c) => ({ ...c.provider.metrics })),
        logoutCalls: cases.map((c) => c.logoutCalls),
        expiredCase: "separate_owner_seeded_past_fifteen_minute_family",
        cleanup: { hostClients: "closed", backendNamespace: "absent" },
      };
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      listenerClosed = true;
      if (!cleanupVerified) {
        const results = await Promise.allSettled([h.close(), ...readPools.map((p) => p.close())]);
        if (results.some((r) => r.status !== "fulfilled"))
          throw Error("LOGOUT_HTTPS_CLEANUP_UNVERIFIED:" + stage);
      }
    }
  });
} finally {
  tlsCleanup = await tls.cleanup();
}
check("https_listener_closed", listenerClosed);
check(
  "tls_fixture_keys_and_directory_removed",
  tlsCleanup?.clientsClosed === true && tlsCleanup?.privateDirectoryAbsent === true,
);
const absent = containerCommand([
  "ps",
  "--all",
  "--no-trunc",
  "--filter",
  "id=" + ownedContainer,
  "--format",
  "{{.ID}}",
]);
check("exact_owned_container_absence", absent.status === 0 && absent.stdout.trim() === "");
for (const [p, d] of Object.entries(sources))
  check(
    "source_unchanged_" + p.replace(/[^a-z0-9]/gi, "_").toLowerCase(),
    hash(readFileSync(p)) === d,
  );
const report = {
  schemaVersion: 1,
  task: "P05.T01q",
  qualification: "synthetic_full_login_to_https_jar_current_family_logout_to_o_b_postgresql",
  observedAt: new Date().toISOString(),
  sourceDigests: sources,
  sourceDigest: hash(JSON.stringify(Object.entries(sources).sort())),
  appliedMigrations: 11,
  checks,
  checkCount: checks.length,
  providerRequests: 0,
  browserEngineQualified: false,
  result: measured,
  cleanup: { httpsListener: "closed", tlsDirectory: "absent", ownedContainer: "absent" },
  limitations: [
    "Private synthetic independently signed provider; no native provider calls/keys, hosted driver/custody or merchant activation.",
    "Bounded HTTP cookie jar using locked standard parser is not a browser engine.",
    "One expired-family case is explicitly owner-seeded at past valid fixed15minute times, not a15minute waited live issuance.",
    "Lost actual COMMIT/release/HTTP acknowledgement withholds response;200acknowledges server state, not delivery or all-device/provider logout.",
  ],
};
const text = JSON.stringify(report, null, 2) + "\n";
writeArtifact("labs/standalone-logout-https.json", text);
console.log(
  "PASS: " +
    checks.length +
    " actual current-family logout HTTPS/PostgreSQL checks; zero provider requests; owned resources removed.",
);
