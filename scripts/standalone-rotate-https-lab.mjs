// P05.T01y PR-2 HTTPS laboratory (AC22-AC24, AC27, AC28, AC32): POST /auth/rotate, the
// logout clear and the client session keeper over real HTTPS (the Node auth adapter and
// workspace router) and PostgreSQL 17 with the full checksum-verified manifest chain
// (0001-0016) in a network-none container. Owner-seeded synthetic families stand in for
// sign-ins (lab:session-lifecycle-sql qualifies admission itself). No provider call, no
// hosted database, no merchant data.
import { createServer, request as httpsRequest } from "node:https";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWorkspaceApiHttpListener } from "../apps/api/src/workspace-router.ts";
import { createStandaloneLogout } from "../packages/identity/src/standalone-logout.ts";
import { createStandaloneRotation } from "../packages/identity/src/standalone-session-rotation.ts";
import { selfLogoutSql } from "../packages/identity/src/self-logout-control.ts";
import { selfRotationSql } from "../packages/identity/src/self-session-rotation-control.ts";
import { identitySql } from "../packages/identity/src/index.ts";
import { createStandaloneWorkspaceBootstrap } from "../packages/identity/src/standalone-workspace-bootstrap.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { createSessionKeeper } from "../packages/workspace-ui/src/session-keeper.ts";
import { literal as lit, withWorkDatabase } from "../tests/tenant-conformance/harness.mjs";
import {
  createLocalLoginTlsFixture,
  createBoundedLoginCookieJar,
} from "./fixtures/login-https.mjs";
import { localSelfLogoutSqlPool } from "./local-self-logout-sql.mjs";
import { localStandaloneSqlPool } from "./local-standalone-sql.mjs";
import { writeArtifact } from "./artifacts.mjs";
import { loadMigrationChain } from "./migration-chain.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const chain = loadMigrationChain();
if (!chain.some((m) => m.sequence === 16 && m.file === "0016.browser-session-lifecycle.sql"))
  throw Error("ROTATE_HTTPS_LAB_MIGRATION_REQUIRED");
const checks = [];
const failures = [];
function check(name, passed) {
  if (!/^ac[0-9]{2}_[a-z0-9_]{1,100}$/.test(name) || checks.some((c) => c.name === name))
    throw Error("ROTATE_HTTPS_LAB_CHECK_NAME:" + name);
  checks.push({ name, passed: passed === true });
  if (passed !== true) failures.push(name);
  console.log(JSON.stringify({ check: name, passed: passed === true }));
}
const clear = "__Host-morrow_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
const authenticationRequired = '{"code":"authentication_required"}';
const rotationUnavailable = '{"schemaVersion":1,"outcome":"rotation_unavailable"}';
let counter = 0;
const next = () => ++counter;
const wid = (prefix, n) => prefix + "_" + String(n).padStart(26, "0");
const newSecret = () => randomBytes(32).toString("base64url");
const profile = Object.freeze({
  id: "profile_rotate",
  environment: wid("environment", 7),
  application: wid("app", 7),
  client: wid("client", 7),
  tokenDigest: sha("rotate-lab-token-profile"),
});
const tls = await createLocalLoginTlsFixture();
const started = Date.now();
try {
  await withWorkDatabase("P05.T01y.rotate-https", async (db) => {
    const admin = (text) => db.sql("SET ROLE morrow_identity_owner;\n" + text);
    const value = (text) => db.sql(text).split("\n").at(-1);
    db.sql("ALTER ROLE morrow_identity_logout LOGIN; ALTER ROLE morrow_api LOGIN;");
    admin(`INSERT INTO morrow_identity.organizations VALUES('org_r','Synthetic R',true,1);
INSERT INTO morrow_identity.workspaces VALUES('ws_r','org_r','R',true);
INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state)
 VALUES(${lit(profile.id)},'workos',${lit(profile.environment)},${lit(profile.application)},${lit(profile.client)},${lit("https://api.workos.com/user_management/" + profile.client)},1,${lit(profile.tokenDigest)},1,'active');`);
    function person(key) {
      const p = {
        principal: "person_" + key,
        mapping: "mapping_" + key,
        subject: wid("user", next()),
      };
      admin(`INSERT INTO morrow_identity.principals VALUES(${lit(p.principal)},'human',true);
INSERT INTO morrow_identity.provider_subject_mappings(id,provider_id,environment_id,subject_id,principal_id,record_revision,state) VALUES(${lit(p.mapping)},'workos',${lit(profile.environment)},${lit(p.subject)},${lit(p.principal)},1,'active');
INSERT INTO morrow_identity.provider_subject_profile_bindings(mapping_id,profile_id,provider_id,environment_id,record_revision,state) VALUES(${lit(p.mapping)},${lit(profile.id)},'workos',${lit(profile.environment)},1,'active');
INSERT INTO morrow_identity.memberships VALUES(${lit("membership_" + key)},'org_r',${lit(p.principal)},true);
INSERT INTO morrow_identity.workspace_memberships VALUES('org_r','ws_r',${lit("membership_" + key)},true);`);
      return p;
    }
    // Owner-seeded family exactly as admission and rotation write it (see the SQL lab).
    function seedFamily(p, { age = 120, rotations = [] } = {}) {
      const family = randomUUID(),
        binding = randomUUID();
      const gens = [age, ...rotations].map(() => {
        const secret = newSecret();
        return { id: randomUUID(), secret, digest: sha(secret) };
      });
      let body = `DO $$ DECLARE now0 timestamptz:=clock_timestamp(); t0 timestamptz; fexp timestamptz; ti timestamptz; a text; BEGIN
 t0:=now0-make_interval(secs=>${age}); fexp:=t0+interval '12 hours';
 INSERT INTO morrow_identity.provider_session_bindings(id,provider_id,environment_id,client_id,provider_session_id,mapping_id,profile_id,created_at) VALUES(${lit(binding)},'workos',${lit(profile.environment)},${lit(profile.client)},${lit(wid("session", next()))},${lit(p.mapping)},${lit(profile.id)},t0);
 INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,created_at,expires_at) VALUES(${lit(family)},${lit(binding)},1,1,1,t0,fexp);
 INSERT INTO morrow_identity.browser_session_generations(id,family_id,secret_digest,created_at,expires_at) VALUES(${lit(gens[0].id)},${lit(family)},${lit(gens[0].digest)},t0,least(t0+interval '30 minutes',fexp));\n`;
      rotations.forEach((secondsAgo, i) => {
        body += ` ti:=now0-make_interval(secs=>${secondsAgo}); a:=gen_random_uuid()::text;
 INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at) VALUES(a,gen_random_uuid()::text,${lit(sha(randomUUID()))},'generation',${lit(gens[i].id)},'revoked','rotated',ti);
 PERFORM set_config('morrow.browser_revocation_audit',a,true);
 UPDATE morrow_identity.browser_session_generations SET revoked_at=ti,record_revision=record_revision+1 WHERE id=${lit(gens[i].id)};
 UPDATE morrow_identity.browser_session_families SET current_generation=current_generation+1,record_revision=record_revision+1 WHERE id=${lit(family)};
 INSERT INTO morrow_identity.browser_session_generations(id,family_id,generation,secret_digest,created_at,expires_at) VALUES(${lit(gens[i + 1].id)},${lit(family)},${i + 2},${lit(gens[i + 1].digest)},ti,least(ti+interval '30 minutes',fexp));
 PERFORM set_config('morrow.browser_revocation_audit','',true);\n`;
      });
      admin(body + "END $$;");
      return { family, binding, gens, current: gens.at(-1) };
    }
    const revoked = (family) =>
      value(
        `SELECT revoked_at IS NOT NULL FROM morrow_identity.browser_session_families WHERE id=${lit(family)};`,
      ) === "t";
    const reuseAudits = (family) =>
      Number(
        value(
          `SELECT count(*) FROM morrow_identity.browser_session_audits WHERE kind='family' AND target_id=${lit(family)} AND reason='reuse_detected';`,
        ),
      );

    // The HTTPS server: the real Node adapter and router over the real handlers and pools.
    let listener = createWorkspaceApiHttpListener();
    const server = createServer({ ...tls.serverOptions, maxHeaderSize: 8192 }, (q, s) =>
      listener(q, s),
    );
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = "https://127.0.0.1:" + server.address().port;
    const logoutConfigurationJson = JSON.stringify({
      schemaVersion: 1,
      protocol: "morrow-self-logout-v1",
      origin,
      providerId: "workos",
      environmentId: profile.environment,
      applicationId: profile.application,
      clientId: profile.client,
      profileId: profile.id,
    });
    const sessionPool = localSelfLogoutSqlPool(db.id, "morrow_identity_logout", [
      ...Object.values(selfLogoutSql),
      selfRotationSql.rotate,
    ]);
    const apiPool = localStandaloneSqlPool(db.id, "morrow_api", Object.values(identitySql));
    const rotation = await createStandaloneRotation({
      configurationJson: logoutConfigurationJson,
      pool: sessionPool,
      now: Date.now,
    });
    const logout = await createStandaloneLogout({
      configurationJson: logoutConfigurationJson,
      pool: sessionPool,
      now: Date.now,
    });
    listener = createWorkspaceApiHttpListener({
      origin,
      auth: {
        async dispatch() {
          throw Error("ROTATE_HTTPS_LAB_NO_LOGIN");
        },
      },
      logout,
      rotate: rotation,
      bootstrap: createStandaloneWorkspaceBootstrap({
        configurationJson: JSON.stringify({ schemaVersion: 1, mode: "https", origin }),
        pool: apiPool,
        now: Date.now,
      }),
    });
    const sql = () => sessionPool.metrics.connections + apiPool.metrics.connections;
    function request(path, { method = "GET", headers = {}, body } = {}) {
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
          (s) => {
            let text = "";
            s.on("data", (c) => (text += c));
            s.once("end", () => {
              const h = new Headers();
              for (let i = 0; i < s.rawHeaders.length; i += 2)
                h.append(s.rawHeaders[i], s.rawHeaders[i + 1]);
              resolve({ status: s.statusCode, text, headers: h });
            });
          },
        );
        q.once("error", reject);
        q.setTimeout(30000, () => q.destroy());
        q.end(body);
      });
    }
    const browserPost = (cookie, headers = {}) => ({
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Morrow-Request": "1",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        ...(cookie === null ? {} : { Cookie: cookie }),
        ...headers,
      },
      body: '{"schemaVersion":1}',
    });
    const rotate = (cookie, headers, body) => {
      const init = browserPost(cookie, headers);
      return request("/auth/rotate", body === undefined ? init : { ...init, body });
    };
    const bootstrap = (cookie) =>
      request("/workspace/ws_r/bootstrap", { headers: { Cookie: cookie } });
    const header = (secret) => "__Host-morrow_session=" + secret;
    const noCookie = (r) => r.headers.getSetCookie().length === 0;
    const jsonSafe = (r) =>
      r.headers.get("cache-control") === "no-store" &&
      r.headers.get("x-content-type-options") === "nosniff" &&
      r.headers.get("referrer-policy") === "no-referrer";
    const ms = (sqlInstant) =>
      Number(value(`SELECT floor(extract(epoch FROM ${sqlInstant})*1000)::bigint;`));

    // ---------------------------------------------------------------- AC22
    {
      const P = person("rotated");
      const F = seedFamily(P);
      check(
        "ac22_seeded_cookie_bootstraps",
        (await bootstrap(header(F.current.secret))).status === 200,
      );
      const before = Date.now();
      const r = await rotate(header(F.current.secret));
      const after = Date.now();
      const cookies = r.headers.getSetCookie();
      const issued =
        /^__Host-morrow_session=([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=([1-9][0-9]{0,3})$/.exec(
          cookies[0] ?? "",
        );
      const body = JSON.parse(r.text);
      const idleAt = ms(
        `(SELECT g.expires_at FROM morrow_identity.browser_session_generations g WHERE g.secret_digest=${lit(sha(issued?.[1] ?? ""))})`,
      );
      const absoluteAt = ms(
        `(SELECT expires_at FROM morrow_identity.browser_session_families WHERE id=${lit(F.family)})`,
      );
      check(
        "ac22_rotated_200_one_exact_cookie_valid_body",
        r.status === 200 &&
          jsonSafe(r) &&
          cookies.length === 1 &&
          issued !== null &&
          body.outcome === "rotated" &&
          validateCurrentDefinition("SessionRotationResult", body) &&
          Number(issued[2]) === Math.min(1800, Math.floor(body.idleRemainingMs / 1000)),
      );
      check(
        "ac22_remaining_times_are_sql_expiries_minus_delivery",
        body.idleRemainingMs >= idleAt - after - 1000 &&
          body.idleRemainingMs <= idleAt - before + 1000 &&
          body.absoluteRemainingMs >= absoluteAt - after - 1000 &&
          body.absoluteRemainingMs <= absoluteAt - before + 1000,
      );
      check("ac22_new_cookie_bootstraps", (await bootstrap(header(issued[1]))).status === 200);
      const old = await bootstrap(header(F.current.secret));
      check("ac22_old_cookie_401", old.status === 401 && old.text === authenticationRequired);
    }

    // ---------------------------------------------------------------- AC23
    {
      const P = person("guard");
      const F = seedFamily(P);
      const cookie = header(F.current.secret);
      const cases = [
        ["get", () => request("/auth/rotate", { headers: { Cookie: cookie } }), 405],
        ["foreign_origin", () => rotate(cookie, { Origin: "https://foreign.invalid" }), 403],
        ["missing_marker", () => rotate(cookie, { "X-Morrow-Request": "" }), 403],
        ["content_type", () => rotate(cookie, { "Content-Type": "text/plain" }), 403],
        ["cross_site", () => rotate(cookie, { "Sec-Fetch-Site": "cross-site" }), 403],
        ["idempotency_key", () => rotate(cookie, { "Idempotency-Key": randomUUID() }), 403],
        ["oversize", () => rotate(cookie, {}, " ".repeat(300)), 400],
        ["wrong_body", () => rotate(cookie, {}, '{"schemaVersion":2}'), 400],
      ];
      for (const [name, send, status] of cases) {
        const n = sql();
        const r = await send();
        check(
          "ac23_" + name + "_unavailable_zero_sql",
          r.status === status && r.text === rotationUnavailable && noCookie(r) && sql() === n,
        );
      }
      for (const [name, value] of [
        ["none", null],
        ["two", `${cookie}; ${cookie}`],
        ["malformed", "__Host-morrow_session=" + "A".repeat(42) + "B"],
      ]) {
        const n = sql();
        const r = await rotate(value);
        check(
          "ac23_cookie_" + name + "_401_zero_sql",
          r.status === 401 && r.text === authenticationRequired && noCookie(r) && sql() === n,
        );
      }
      check(
        "ac23_family_untouched",
        !revoked(F.family) && (await bootstrap(cookie)).status === 200,
      );
    }

    // ---------------------------------------------------------------- AC24
    {
      const P = person("denials");
      const young = seedFamily(P, { age: 5 });
      const current = await rotate(header(young.current.secret));
      check(
        "ac24_current_200_without_cookie",
        current.status === 200 &&
          JSON.parse(current.text).outcome === "current" &&
          noCookie(current),
      );
      const expired = seedFamily(P, { age: 1900 });
      const reused = seedFamily(P, { age: 600, rotations: [300] });
      const foreignSecret = newSecret();
      admin(
        `INSERT INTO morrow_identity.sessions VALUES('session_foreign',${lit(P.principal)},'org_r',${lit(sha(foreignSecret))},'workos','provider_session_foreign',clock_timestamp()+interval '1 day',NULL);`,
      );
      const bodies = [];
      for (const [name, secret] of [
        ["unknown", newSecret()],
        ["expired", expired.current.secret],
        ["foreign_representation", foreignSecret],
        ["reuse", reused.gens[0].secret],
        ["after_reuse", reused.current.secret],
      ]) {
        const r = await rotate(header(secret));
        bodies.push(r.text);
        check("ac24_" + name + "_401_no_cookie", r.status === 401 && noCookie(r) && jsonSafe(r));
      }
      check(
        "ac24_identical_401_bytes",
        bodies.every((b) => b === authenticationRequired),
      );
      check(
        "ac24_reuse_revoked_family",
        revoked(reused.family) && reuseAudits(reused.family) === 1,
      );
    }

    // ---------------------------------------------------------------- AC27
    {
      const P = person("two_families");
      const F1 = seedFamily(P, { age: 600, rotations: [300] });
      const F2 = seedFamily(P);
      const ended = await request("/auth/logout", browserPost(header(F1.gens[0].secret)));
      check(
        "ac27_logout_with_retired_generation_ends_its_family",
        ended.status === 200 &&
          ended.text === '{"schemaVersion":1,"outcome":"session_ended"}' &&
          ended.headers.getSetCookie().join() === clear &&
          revoked(F1.family),
      );
      check(
        "ac27_other_family_and_binding_live",
        !revoked(F2.family) &&
          (await bootstrap(header(F2.current.secret))).status === 200 &&
          value(
            `SELECT count(*) FROM morrow_identity.provider_session_bindings WHERE id IN (${lit(F1.binding)},${lit(F2.binding)}) AND revoked_at IS NULL;`,
          ) === "2",
      );
      const F3 = seedFamily(P);
      const third = await request("/auth/logout", browserPost(header(F3.current.secret)));
      check(
        "ac27_logout_with_current_generation",
        third.status === 200 &&
          third.headers.getSetCookie().join() === clear &&
          revoked(F3.family) &&
          !revoked(F2.family),
      );
    }

    // ---------------------------------------------------------------- AC28
    {
      const P = person("delayed");
      const F1 = seedFamily(P);
      const F2 = seedFamily(P);
      const jar = createBoundedLoginCookieJar();
      const captured = header(F1.current.secret);
      // The newer sign-in's cookie arrives through a real rotate Set-Cookie.
      const newer = await rotate(header(F2.current.secret));
      check(
        "ac28_jar_holds_the_newer_cookie",
        newer.status === 200 &&
          jar.ingest(origin + "/auth/rotate", newer.headers).accepted === 1 &&
          jar.header(origin + "/") !== undefined &&
          jar.header(origin + "/") !== captured,
      );
      const newerCookie = jar.header(origin + "/");
      const delayed = await request("/auth/logout", browserPost(captured));
      check(
        "ac28_delayed_logout_revokes_only_its_family",
        delayed.status === 200 &&
          revoked(F1.family) &&
          !revoked(F2.family) &&
          (await bootstrap(newerCookie)).status === 200,
      );
      check(
        "ac28_fixed_name_clear_drops_the_newer_cookie_in_the_jar",
        delayed.headers.getSetCookie().join() === clear &&
          jar.ingest(origin + "/auth/logout", delayed.headers).accepted === 1 &&
          jar.header(origin + "/") === undefined,
      );
    }

    // ---------------------------------------------------------------- AC32
    {
      const P = person("victim");
      const F = seedFamily(P);
      const victimJar = createBoundedLoginCookieJar(),
        attackerJar = createBoundedLoginCookieJar();
      const seeded = new Headers();
      seeded.append(
        "set-cookie",
        header(F.current.secret) + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800",
      );
      victimJar.ingest(origin + "/", seeded);
      // The attacker copies the victim's cookie and rotates first.
      const stolen = victimJar.header(origin + "/");
      const theft = await rotate(stolen);
      check(
        "ac32_thief_rotates_first",
        theft.status === 200 &&
          attackerJar.ingest(origin + "/auth/rotate", theft.headers).accepted === 1,
      );
      // The victim's keeper: bootstrap 401, one rotate presenting the retired generation.
      let signedOut = 0;
      const outcomes = [];
      const keeper = createSessionKeeper({
        locks: null,
        now: () => performance.now(),
        setTimer: (fn, delay) => setTimeout(fn, delay),
        clearTimer: (handle) => clearTimeout(handle),
        onSignedOut: () => signedOut++,
        async fetch(input, init = {}) {
          const cookie = victimJar.header(origin + "/");
          const r =
            (init.method ?? "GET") === "GET"
              ? await request(input, { headers: cookie ? { Cookie: cookie } : {} })
              : await request(input, {
                  ...browserPost(cookie ?? null),
                  body: typeof init.body === "string" ? init.body : undefined,
                });
          if (input === "/auth/rotate") outcomes.push(r.status);
          victimJar.ingest(origin + input, r.headers);
          return new Response(r.text, { status: r.status, headers: r.headers });
        },
      });
      const response = await keeper.request("/workspace/ws_r/bootstrap");
      keeper.dispose();
      check(
        "ac32_victim_bootstrap_401_then_rotate_401_signs_out",
        response.status === 401 && outcomes.join() === "401" && signedOut === 1,
      );
      check(
        "ac32_family_revoked_by_one_reuse_audit",
        revoked(F.family) && reuseAudits(F.family) === 1,
      );
      const attackerCookie = attackerJar.header(origin + "/");
      check("ac32_attacker_cookie_bootstrap_401", (await bootstrap(attackerCookie)).status === 401);
      const again = await rotate(attackerCookie);
      check(
        "ac32_attacker_rotation_denied",
        again.status === 401 && again.text === authenticationRequired,
      );
    }
    await new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  });
} finally {
  await tls.cleanup();
}
const report = {
  task: "P05.T01y",
  pr: "PR-2 rotate route, logout clearing and keeper",
  qualification: "local_https_node_adapter_postgresql17_network_none",
  observedAt: new Date().toISOString(),
  durationMs: Date.now() - started,
  checks,
  limitations: [
    "Families are owner-seeded; admission itself is qualified by lab:session-lifecycle-sql.",
    "The Node HTTPS adapter, not workerd: the Workers transcript (AC33) and the pgwire journey (AC34) are separate.",
  ],
};
writeArtifact("labs/standalone-rotate-https.json", report);
if (failures.length) {
  console.log("FAILED: " + failures.join(", "));
  process.exitCode = 1;
} else console.log(`PASS: ${checks.length} P05.T01y HTTPS checks.`);
