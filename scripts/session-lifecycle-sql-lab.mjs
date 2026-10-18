// P05.T01y PR-1 PostgreSQL 17 acceptance laboratory (AC01-AC21): migration 0016 on the
// full checksum-verified manifest chain in an isolated network-none engine. Owner-seeded
// synthetic families and generations satisfy the insert and preservation triggers; the
// executors run as their own logins. Boundaries use expiries a few seconds ahead and poll
// the database clock; no single sleep exceeds 3 s. Race hooks hold rows from a second
// connection. No provider, credential, hosted database or merchant data.
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  literal as lit,
  manifestChain,
  migrationPrerequisite,
  psql,
  psqlAsync,
  sleep,
  withWorkDatabase,
} from "../tests/tenant-conformance/harness.mjs";
import {
  expectedReplacement,
  functionDefinition,
  sessionLifecycleReplacements,
} from "../tests/fixtures/session-lifecycle-replacements.mjs";
import { writeArtifact } from "./artifacts.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const read = (path) => readFileSync(path, "utf8");
const migrationFile = "0016.browser-session-lifecycle.sql";
const chain = manifestChain();
const lifecycle = chain.find((m) => m.file === migrationFile);
if (!lifecycle || lifecycle.sequence !== 16 || lifecycle.executeAs !== "morrow_identity_owner")
  throw Error("SESSION_LIFECYCLE_LAB_MIGRATION_REQUIRED");
if (migrationPrerequisite(migrationFile) !== null) throw Error("SESSION_LIFECYCLE_LAB_NO_NEW_ROLE");

const checks = [];
const failures = [];
const print = console.log.bind(console);
function check(name, passed, observed) {
  if (!/^ac[0-9]{2}_[a-z0-9_]{1,100}$/.test(name) || checks.some((c) => c.name === name))
    throw Error("SESSION_LIFECYCLE_LAB_CHECK_NAME:" + name);
  checks.push({ name, passed: passed === true });
  if (passed !== true) {
    failures.push(name);
    // Closed values only: outcomes, counts and booleans. Never secrets or digests.
    print(JSON.stringify({ check: name, passed: false, observed: observed ?? null }));
  } else print(JSON.stringify({ check: name, passed: true }));
  return passed === true;
}
const only = process.env.MORROW_SESSION_LAB_ONLY?.split(",") ?? null;
async function section(name, body) {
  if (only && !only.includes(name)) return;
  const started = Date.now();
  try {
    await body();
  } catch (error) {
    failures.push(name + ":completed");
    checks.push({ name: name + "_completed", passed: false });
    print("SECTION_FAILED " + name + " " + (error instanceof Error ? error.message : "unknown"));
  }
  timings[name] = Date.now() - started;
}
const timings = {};

// Synthetic WorkOS-shaped identifiers: [A-Z0-9]{26} suffixes.
let counter = 0;
const next = () => ++counter;
const wid = (prefix, n) => prefix + "_" + String(n).padStart(26, "0");
const newSecret = () => randomBytes(32).toString("base64url");
const configurationDigest = sha("session-lifecycle-lab-configuration");
const profile = Object.freeze({
  id: "profile_main",
  environment: wid("environment", 1),
  application: wid("app", 1),
  client: wid("client", 1),
  tokenDigest: sha("session-lifecycle-lab-token-profile"),
});
const issuer = "https://api.workos.com/user_management/" + profile.client;

// A long-lived psql connection for deliberate interleavings. The SQLSTATE of the last
// statement is read in-band on stdout. Fixed lab SQL only.
function connection(id, user = "postgres", applicationName = "session_lab_" + next()) {
  const child = spawn(
    "docker",
    [
      "exec",
      "--env",
      "PGAPPNAME=" + applicationName,
      "--interactive",
      id,
      "psql",
      "-X",
      "-qAt",
      "-U",
      user,
      "-d",
      "morrow",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "",
    pending = null,
    closed = false;
  const ended = new Promise((resolve) =>
    child.on("close", () => {
      closed = true;
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(Error("SESSION_LAB_CONNECTION_CLOSED"));
        pending = null;
      }
      resolve();
    }),
  );
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const i = buffer.indexOf("\n"),
        line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!pending) continue;
      if (line.startsWith(pending.marker)) {
        const p = pending;
        pending = null;
        clearTimeout(p.timer);
        p.resolve({ lines: p.lines, sqlstate: line.slice(p.marker.length + 1) });
      } else if (line) pending.lines.push(line);
    }
  });
  return {
    applicationName,
    query(text) {
      if (closed || pending) return Promise.reject(Error("SESSION_LAB_CONNECTION_PROTOCOL"));
      const marker = "SESSION_LAB_" + randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("SESSION_LAB_CONNECTION_TIMEOUT"));
        }, 60000);
        pending = { marker, timer, resolve, reject, lines: [] };
        child.stdin.write(text + "\n\\echo " + marker + " :SQLSTATE\n");
      });
    },
    async close() {
      child.stdin.end();
      let timer;
      await Promise.race([
        ended,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 5000);
        }),
      ]);
      clearTimeout(timer);
      await ended;
    },
  };
}

const started = Date.now();
let observedEngine = null;
await withWorkDatabase(
  "P05.T01y.session-lifecycle-sql",
  async (db) => {
    const id = db.id;
    const run = (text, user = "postgres", database = "morrow") =>
      psql(id, text, { user, database });
    const attempt = (text, user = "postgres", database = "morrow") =>
      psql(id, "\\set VERBOSITY verbose\n" + text, { user, database, allowFailure: true });
    const admin = (text) => run("SET ROLE morrow_identity_owner;\n" + text);
    const value = (text, user) => run(text, user).split("\n").at(-1);
    const nowMs = () =>
      Number(value("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint;"));
    observedEngine = value("SHOW server_version;");
    const applied = db.applied;
    const fullChain = chain.filter((m) => m.sequence < 16).map((m) => m.sequence);

    // ------------------------------------------------------------- world (0001-0015)
    admin(`INSERT INTO morrow_identity.organizations VALUES('org_a','Synthetic A',true,1),('org_b','Synthetic B',true,1);
INSERT INTO morrow_identity.workspaces VALUES('ws_a1','org_a','A1',true),('ws_a2','org_a','A2',true),('ws_b1','org_b','B1',true);
INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state)
 VALUES(${lit(profile.id)},'workos',${lit(profile.environment)},${lit(profile.application)},${lit(profile.client)},${lit(issuer)},1,${lit(profile.tokenDigest)},1,'active');`);
    const workspaces = { org_a: ["ws_a1", "ws_a2"], org_b: ["ws_b1"] };
    const people = {};
    function person(key, orgs = ["org_a", "org_b"]) {
      const n = next();
      const p = {
        key,
        principal: "person_" + key,
        mapping: "mapping_" + key,
        subject: wid("user", n),
        memberships: Object.fromEntries(orgs.map((o) => [o, "membership_" + key + "_" + o])),
      };
      const statements = [
        `INSERT INTO morrow_identity.principals VALUES(${lit(p.principal)},'human',true);`,
        `INSERT INTO morrow_identity.provider_subject_mappings(id,provider_id,environment_id,subject_id,principal_id,record_revision,state) VALUES(${lit(p.mapping)},'workos',${lit(profile.environment)},${lit(p.subject)},${lit(p.principal)},1,'active');`,
        `INSERT INTO morrow_identity.provider_subject_profile_bindings(mapping_id,profile_id,provider_id,environment_id,record_revision,state) VALUES(${lit(p.mapping)},${lit(profile.id)},'workos',${lit(profile.environment)},1,'active');`,
      ];
      for (const org of orgs) {
        statements.push(
          `INSERT INTO morrow_identity.memberships VALUES(${lit(p.memberships[org])},${lit(org)},${lit(p.principal)},true);`,
        );
        for (const ws of workspaces[org])
          statements.push(
            `INSERT INTO morrow_identity.workspace_memberships VALUES(${lit(org)},${lit(ws)},${lit(p.memberships[org])},true);`,
          );
      }
      admin(statements.join("\n"));
      people[key] = p;
      return p;
    }
    // One family with its generations, seeded by the owner exactly as admission and
    // rotation would write them, at instants relative to one database clock reading.
    // `age` and `rotations` are seconds before now; rotations are in time order.
    function seedFamily(
      p,
      { age = 120, rotations = [], lifetime = "12 hours", sid, binding } = {},
    ) {
      const n = next();
      const family = randomUUID();
      const pb = binding ?? randomUUID();
      const providerSession = sid ?? wid("session", n);
      const gens = [age, ...rotations].map(() => {
        const secret = newSecret();
        return { id: randomUUID(), secret, digest: sha(secret) };
      });
      const legacy = lifetime === "15 minutes";
      let body = `DO $$ DECLARE now0 timestamptz:=clock_timestamp(); t0 timestamptz; fexp timestamptz; ti timestamptz; a text; BEGIN
 t0:=now0-make_interval(secs=>${age}); fexp:=t0+interval '${lifetime}';\n`;
      if (!binding)
        body += ` INSERT INTO morrow_identity.provider_session_bindings(id,provider_id,environment_id,client_id,provider_session_id,mapping_id,profile_id,created_at) VALUES(${lit(pb)},'workos',${lit(profile.environment)},${lit(profile.client)},${lit(providerSession)},${lit(p.mapping)},${lit(profile.id)},t0);\n`;
      body += ` INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,created_at,expires_at) VALUES(${lit(family)},${lit(pb)},1,1,1,t0,fexp);
 INSERT INTO morrow_identity.browser_session_generations(id,family_id,secret_digest,created_at,expires_at) VALUES(${lit(gens[0].id)},${lit(family)},${lit(gens[0].digest)},t0,${legacy ? "fexp" : "least(t0+interval '30 minutes',fexp)"});\n`;
      rotations.forEach((secondsAgo, i) => {
        body += ` ti:=now0-make_interval(secs=>${secondsAgo}); a:=gen_random_uuid()::text;
 INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at) VALUES(a,gen_random_uuid()::text,${lit(sha(randomUUID()))},'generation',${lit(gens[i].id)},'revoked','rotated',ti);
 PERFORM set_config('morrow.browser_revocation_audit',a,true);
 UPDATE morrow_identity.browser_session_generations SET revoked_at=ti,record_revision=record_revision+1 WHERE id=${lit(gens[i].id)};
 UPDATE morrow_identity.browser_session_families SET current_generation=current_generation+1,record_revision=record_revision+1 WHERE id=${lit(family)};
 INSERT INTO morrow_identity.browser_session_generations(id,family_id,generation,secret_digest,created_at,expires_at) VALUES(${lit(gens[i + 1].id)},${lit(family)},${i + 2},${lit(gens[i + 1].digest)},ti,least(ti+interval '30 minutes',fexp));
 PERFORM set_config('morrow.browser_revocation_audit','',true);\n`;
      });
      body += "END $$;";
      admin(body);
      return {
        person: p,
        family,
        binding: pb,
        sid: providerSession,
        gens,
        current: gens.at(-1),
      };
    }
    const eligible = (digest, ws) =>
      Number(
        value(
          `SELECT count(*) FROM morrow_identity.session_eligibility(${lit(digest)},${lit(ws)});`,
        ),
      );
    const writes = () =>
      value(`SELECT json_build_object(
 'audits',(SELECT count(*) FROM morrow_identity.browser_session_audits),
 'generations',(SELECT count(*) FROM morrow_identity.browser_session_generations),
 'generation_revisions',(SELECT coalesce(sum(record_revision),0) FROM morrow_identity.browser_session_generations),
 'families',(SELECT count(*) FROM morrow_identity.browser_session_families),
 'family_revisions',(SELECT coalesce(sum(record_revision),0) FROM morrow_identity.browser_session_families),
 'bindings',(SELECT coalesce(sum(record_revision),0) FROM morrow_identity.provider_session_bindings),
 'signouts',(SELECT count(*) FROM morrow_identity.organization_session_signouts),
 'account_commands',(SELECT count(*) FROM morrow_identity.account_session_commands))::text;`);
    const family = (f) =>
      JSON.parse(
        value(
          `SELECT row_to_json(x)::text FROM (SELECT current_generation::int AS current,record_revision::int AS revision,revoked_at IS NOT NULL AS revoked,floor(extract(epoch FROM expires_at)*1000)::bigint AS expires_ms,floor(extract(epoch FROM created_at)*1000)::bigint AS created_ms FROM morrow_identity.browser_session_families WHERE id=${lit(f)}) x;`,
        ),
      );
    function rotateSql(digest, options = {}) {
      const command = options.command ?? randomUUID();
      const secret = newSecret();
      const newDigest = options.newDigest ?? sha(secret);
      const newGeneration = options.newGeneration ?? randomUUID();
      const profileId = options.profileId ?? profile.id;
      const values = [
        command,
        null,
        configurationDigest,
        profile.environment,
        profile.application,
        profile.client,
        profileId,
        digest,
        newDigest,
        newGeneration,
      ];
      values[1] =
        options.requestDigest ??
        sha(
          JSON.stringify([
            "morrow.browser.self_rotate",
            "1",
            command,
            configurationDigest,
            "workos",
            profile.environment,
            profile.application,
            profile.client,
            profileId,
            digest,
            newDigest,
            newGeneration,
          ]),
        );
      return {
        text: `SELECT outcome||'|'||coalesce(idle_expires_at_ms,'')||'|'||coalesce(absolute_expires_at_ms,'') FROM morrow_identity.rotate_self_browser_generation(${values.map(lit).join(",")});`,
        secret,
        newDigest,
        newGeneration,
        command,
      };
    }
    const parseRotation = (line) => {
      const [outcome, idle, absolute] = (line ?? "").split("|");
      return {
        outcome,
        idle: idle ? Number(idle) : null,
        absolute: absolute ? Number(absolute) : null,
      };
    };
    function rotate(digest, options = {}) {
      const r = rotateSql(digest, options);
      const prefix = options.prefix ?? "";
      return {
        ...r,
        ...parseRotation(value(prefix + r.text, options.user ?? "morrow_identity_logout")),
      };
    }
    function logout(digest) {
      const command = randomUUID();
      const requestDigest = sha(
        JSON.stringify([
          "morrow.browser.self_logout",
          "1",
          command,
          configurationDigest,
          "workos",
          profile.environment,
          profile.application,
          profile.client,
          profile.id,
          digest,
        ]),
      );
      return value(
        `SELECT outcome FROM morrow_identity.end_self_browser_family(${[command, requestDigest, configurationDigest, profile.environment, profile.application, profile.client, profile.id, digest].map(lit).join(",")});`,
        "morrow_identity_logout",
      );
    }
    // A real account admission (0013 admit_account_family, replaced by 0016) as the
    // sessions executor, with evidence observed now and expiring within 5 s.
    function admissionTuple(p, sid) {
      const now = nowMs();
      const secret = newSecret();
      const t = [
        randomUUID(),
        "workos",
        profile.environment,
        profile.application,
        profile.client,
        issuer,
        "1",
        profile.tokenDigest,
        p.subject,
        sid,
        String(now),
        String(now),
        String(now + 5000),
        sha("keyset"),
        sha("observation"),
        sha(secret),
        profile.id,
        "1",
        randomUUID(),
        randomUUID(),
      ];
      return { t, secret, digest: t[15], familyId: t[18], generationId: t[19] };
    }
    const admissionSql = (t) =>
      `SELECT outcome||'|'||coalesce(family_id,'')||'|'||coalesce(expires_at_ms,'') FROM morrow_identity.admit_account_family(${[t[0], sha(JSON.stringify(t)), ...t.slice(1)].map(lit).join(",")});`;
    const admissionReason = (command) =>
      value(
        `SELECT a.reason FROM morrow_identity.account_session_commands c JOIN morrow_identity.browser_session_audits a ON a.id=c.audit_id WHERE c.command_id=${lit(command)};`,
      );
    function admit(p, sid = wid("session", next())) {
      for (let i = 0; i < 3; i++) {
        const a = admissionTuple(p, sid);
        const [outcome, familyId, expiresMs] = value(
          admissionSql(a.t),
          "morrow_identity_sessions",
        ).split("|");
        const reason = outcome === "denied" ? admissionReason(a.t[0]) : null;
        if (reason === "evidence_expired") continue;
        return { ...a, sid, outcome, family: familyId, expiresMs: Number(expiresMs), reason };
      }
      throw Error("SESSION_LAB_ADMISSION_EVIDENCE_EXPIRED");
    }
    async function waitUntilPast(sqlInstant) {
      for (let i = 0; i < 400; i++) {
        if (value(`SELECT clock_timestamp()>${sqlInstant};`) === "t") return true;
        await sleep(100);
      }
      return false;
    }
    async function waitingOnLock(applicationName, count = 1) {
      for (let i = 0; i < 400; i++) {
        const n = Number(
          value(
            `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND application_name LIKE ${lit(applicationName + "%")};`,
          ),
        );
        if (n >= count) return true;
        await sleep(50);
      }
      return false;
    }
    const prosrc = (name) =>
      value(
        `SELECT p.prosrc FROM pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname=${lit(name)};`,
      ) ?? "";
    // pg_proc.prosrc of a function body, read as one JSON string (multi-line safe).
    const source = (name) =>
      JSON.parse(
        value(
          `SELECT to_json(p.prosrc)::text FROM pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname=${lit(name)};`,
        ),
      );
    const body = (definition) =>
      definition.slice(definition.indexOf("$$") + 2, definition.lastIndexOf("$$"));

    // Fixtures that exist before the migration: a legacy 15-minute family (L) and one
    // expiring shortly after the migration (LX), plus the predecessor bodies and OIDs.
    const L0 = person("legacy");
    const L = seedFamily(L0, { age: 30, lifetime: "15 minutes" });
    const LX = seedFamily(L0, { age: 900 - 25, lifetime: "15 minutes" });
    const legacyBytes = (f) =>
      value(
        `SELECT (SELECT to_jsonb(x)::text FROM morrow_identity.browser_session_families x WHERE x.id=${lit(f.family)})||'|'||(SELECT string_agg(to_jsonb(g)::text,',' ORDER BY g.generation) FROM morrow_identity.browser_session_generations g WHERE g.family_id=${lit(f.family)});`,
      );
    const legacyBefore = legacyBytes(L);
    const predecessorSources = Object.fromEntries(
      sessionLifecycleReplacements.map((e) => [e.name, source(e.name)]),
    );
    const eligibilityOid = value(
      "SELECT 'morrow_identity.session_eligibility(text,text)'::regprocedure::oid;",
    );
    const eligibilityResult = value(
      "SELECT pg_get_function_result('morrow_identity.session_eligibility(text,text)'::regprocedure);",
    );

    // ------------------------------------------------------------------- AC01
    await section("AC01", async () => {
      const migration = read("migrations/" + migrationFile);
      check(
        "ac01_full_chain_before",
        JSON.stringify(applied) === JSON.stringify(fullChain) &&
          chain.every((m) => sha(read("migrations/" + m.file)) === m.sha256),
      );
      const nothing = () =>
        value(
          "SELECT to_regclass('morrow_identity.organization_session_signouts') IS NULL AND to_regprocedure('morrow_identity.rotate_self_browser_generation(text,text,text,text,text,text,text,text,text,text)') IS NULL AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='membership_organization_signout');",
        ) === "t";
      const refused = (r) => !r.ok && r.stderr.includes("SESSION_LIFECYCLE_PREREQUISITES_INVALID");
      // A non-owner run (the administrator itself).
      check("ac01_non_owner_refused", refused(attempt(migration)) && nothing());
      // A logout executor with a membership in either direction.
      run("GRANT morrow_identity_logout TO morrow_identity_onboarding;");
      const member = attempt("SET ROLE morrow_identity_owner;\n" + migration);
      run("REVOKE morrow_identity_logout FROM morrow_identity_onboarding;");
      check("ac01_logout_membership_refused", refused(member) && nothing());
      // An executor that is a member of the owner.
      run("GRANT morrow_identity_owner TO morrow_api_worker;");
      const owner = attempt("SET ROLE morrow_identity_owner;\n" + migration);
      run("REVOKE morrow_identity_owner FROM morrow_api_worker;");
      check("ac01_owner_member_refused", refused(owner) && nothing());
      // 0013 absent: a separate database with 0001-0012 only.
      run("CREATE DATABASE morrow_pre13;", "postgres", "morrow_lab");
      run(
        "GRANT CREATE ON DATABASE morrow_pre13 TO morrow_identity_owner;",
        "postgres",
        "morrow_pre13",
      );
      for (const m of chain.filter((x) => x.sequence <= 12))
        run("SET ROLE morrow_identity_owner;\n" + m.text, "postgres", "morrow_pre13");
      const pre13 = attempt(
        "SET ROLE morrow_identity_owner;\n" + migration,
        "postgres",
        "morrow_pre13",
      );
      check(
        "ac01_without_0013_refused",
        refused(pre13) &&
          run(
            "SELECT to_regclass('morrow_identity.organization_session_signouts') IS NULL;",
            "postgres",
            "morrow_pre13",
          ) === "t",
      );
      // Apply as the owner, then a second run is refused and creates nothing more.
      run("SET ROLE morrow_identity_owner;\n" + migration);
      const triggers = () =>
        value(
          "SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('morrow_identity.memberships'::regclass,'morrow_identity.browser_session_generations'::regclass,'morrow_identity.organization_session_signouts'::regclass) AND NOT tgisinternal;",
        );
      const before = triggers();
      check(
        "ac01_second_run_refused",
        refused(attempt("SET ROLE morrow_identity_owner;\n" + migration)) && triggers() === before,
      );
      check(
        "ac01_applied_bytes_unchanged",
        chain.every((m) => sha(read("migrations/" + m.file)) === m.sha256) &&
          sha(migration) === lifecycle.sha256,
      );
      for (const role of [
        "morrow_identity_logout",
        "morrow_identity_sessions",
        "morrow_identity_lifecycle",
      ])
        run(`ALTER ROLE ${role} LOGIN;`);
    });

    // ------------------------------------------------------------------- AC02
    await section("AC02", async () => {
      check("ac02_legacy_bytes_unchanged", legacyBytes(L) === legacyBefore);
      check("ac02_legacy_bootstraps", eligible(L.current.digest, "ws_a1") === 1);
      const before = writes();
      const r = rotate(L.current.digest);
      check(
        "ac02_legacy_rotation_denied",
        r.outcome === "denied" && writes() === before,
        r.outcome,
      );
      // LX expires about 25 s after it was seeded; it resolves until then, never after.
      // Eligibility is read first; if the clock is still before the expiry afterwards, the
      // family must have resolved.
      const live = value(
        `WITH e AS MATERIALIZED (SELECT count(*) AS n FROM morrow_identity.session_eligibility(${lit(LX.current.digest)},'ws_a1')) SELECT e.n::text||'|'||(clock_timestamp()<f.expires_at)::text FROM e,morrow_identity.browser_session_families f WHERE f.id=${lit(LX.family)};`,
      ).split("|");
      check("ac02_legacy_resolves_until_expiry", live[1] !== "true" || live[0] === "1");
      const expiry = `(SELECT expires_at FROM morrow_identity.browser_session_families WHERE id=${lit(LX.family)})`;
      check(
        "ac02_legacy_expires",
        (await waitUntilPast(expiry)) && eligible(LX.current.digest, "ws_a1") === 0,
      );
      check(
        "ac02_legacy_logout_ends",
        logout(L.current.digest) === "ended" && family(L.family).revoked,
      );
    });

    // ------------------------------------------------------------------- AC03
    await section("AC03", async () => {
      const P = person("constraints");
      const C = seedFamily(P);
      const n = next();
      const familyInsert = (generation, lifetime) =>
        `INSERT INTO morrow_identity.provider_session_bindings(id,provider_id,environment_id,client_id,provider_session_id,mapping_id,profile_id,created_at) VALUES('pb_c_${n}_${generation}','workos',${lit(profile.environment)},${lit(profile.client)},${lit(wid("session", next()))},${lit(P.mapping)},${lit(profile.id)},clock_timestamp());
INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,current_generation,created_at,expires_at) SELECT 'f_c_${n}_${generation}','pb_c_${n}_${generation}',1,1,1,${generation},t,t+interval '${lifetime}' FROM (SELECT clock_timestamp() AS t) c;`;
      const rejected = (text, marker) => {
        const r = attempt("BEGIN; SET LOCAL ROLE morrow_identity_owner;\n" + text + "\nROLLBACK;");
        return !r.ok && (marker === undefined || r.stderr.includes(marker));
      };
      check("ac03_generation_zero", rejected(familyInsert(0, "12 hours")));
      check(
        "ac03_generation_1001",
        rejected(familyInsert(1001, "12 hours"), "browser_session_family_lifetime"),
      );
      check(
        "ac03_legacy_generation_two",
        rejected(familyInsert(2, "15 minutes"), "browser_session_family_lifetime"),
      );
      check(
        "ac03_other_lifetime",
        rejected(familyInsert(1, "1 hour"), "browser_session_family_lifetime"),
      );
      check(
        "ac03_twelve_hours_accepted",
        attempt(
          "BEGIN; SET LOCAL ROLE morrow_identity_owner;\n" +
            familyInsert(1, "12 hours") +
            "\nROLLBACK;",
        ).ok,
      );
      // The idle CHECK on its own (the insert trigger is disabled inside the probe).
      check(
        "ac03_generation_over_30_minutes",
        rejected(
          `ALTER TABLE morrow_identity.browser_session_generations DISABLE TRIGGER browser_session_generation_insert;
INSERT INTO morrow_identity.browser_session_generations(id,family_id,generation,secret_digest,created_at,expires_at) SELECT 'g_c_${n}',${lit(C.family)},2,${lit(sha(randomUUID()))},t,t+interval '31 minutes' FROM (SELECT clock_timestamp() AS t) c;`,
          "browser_session_generation_idle",
        ),
      );
      const invalid = "BROWSER_SESSION_GENERATION_INVALID";
      const generation = (number, created, expires, familyId = C.family) =>
        `INSERT INTO morrow_identity.browser_session_generations(id,family_id,generation,secret_digest,created_at,expires_at) VALUES('g_${next()}',${lit(familyId)},${number},${lit(sha(randomUUID()))},${created},${expires});`;
      const fam = `(SELECT created_at FROM morrow_identity.browser_session_families WHERE id=${lit(C.family)})`;
      check(
        "ac03_trigger_non_current_number",
        rejected(
          generation(2, "clock_timestamp()", "clock_timestamp()+interval '10 minutes'"),
          invalid,
        ),
      );
      // Generation 2 of a family ending in 10 minutes may not outlive it.
      const E = seedFamily(P, { age: 12 * 3600 - 600 });
      const retireFirst = `DO $$ DECLARE a text:=gen_random_uuid()::text; t timestamptz:=clock_timestamp(); BEGIN
 INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at) VALUES(a,gen_random_uuid()::text,${lit(sha("e"))},'generation',${lit(E.current.id)},'revoked','rotated',t);
 PERFORM set_config('morrow.browser_revocation_audit',a,true);
 UPDATE morrow_identity.browser_session_generations SET revoked_at=t,record_revision=record_revision+1 WHERE id=${lit(E.current.id)};
 UPDATE morrow_identity.browser_session_families SET current_generation=2,record_revision=record_revision+1 WHERE id=${lit(E.family)};
END $$;`;
      const retired = `(SELECT revoked_at FROM morrow_identity.browser_session_generations WHERE id=${lit(E.current.id)})`;
      const familyEnd = `(SELECT expires_at FROM morrow_identity.browser_session_families WHERE id=${lit(E.family)})`;
      check(
        "ac03_trigger_expiry_beyond_lifetime",
        rejected(
          retireFirst + "\n" + generation(2, retired, retired + "+interval '30 minutes'", E.family),
          invalid,
        ),
      );
      check(
        "ac03_trigger_bounded_expiry_control",
        attempt(
          "BEGIN; SET LOCAL ROLE morrow_identity_owner;\n" +
            retireFirst +
            "\n" +
            generation(2, retired, familyEnd, E.family) +
            "\nROLLBACK;",
        ).ok,
      );
      check(
        "ac03_trigger_lower_generation_live",
        rejected(
          `ALTER TABLE morrow_identity.browser_session_families DISABLE TRIGGER browser_session_immutable;
UPDATE morrow_identity.browser_session_families SET current_generation=2 WHERE id=${lit(C.family)};
ALTER TABLE morrow_identity.browser_session_families ENABLE TRIGGER browser_session_immutable;
${generation(2, "clock_timestamp()", "clock_timestamp()+interval '1 minute'")}`,
          invalid,
        ),
      );
      check(
        "ac03_trigger_generation_one_shape",
        rejected(
          `${familyInsert(1, "12 hours")}
${generation(1, "clock_timestamp()", "clock_timestamp()+interval '30 minutes'", "f_c_" + n + "_1")}`,
          invalid,
        ),
      );
      check(
        "ac03_trigger_revoked_family",
        rejected(
          `SELECT * FROM morrow_identity.revoke_browser_family(${lit(C.family)},${lit(randomUUID())},${lit(sha("y"))});
${generation(1, fam, fam + "+interval '30 minutes'")}`,
          invalid,
        ),
      );
      // Generation 2 after a maintenance revocation (reason revoked, not rotated) of 1.
      check(
        "ac03_trigger_without_rotated_audit",
        rejected(
          `SELECT * FROM morrow_identity.revoke_browser_generation(${lit(C.gens[0].id)},${lit(randomUUID())},${lit(sha("z"))});
ALTER TABLE morrow_identity.browser_session_families DISABLE TRIGGER browser_session_immutable;
UPDATE morrow_identity.browser_session_families SET current_generation=2 WHERE id=${lit(C.family)};
ALTER TABLE morrow_identity.browser_session_families ENABLE TRIGGER browser_session_immutable;
${generation(2, `(SELECT revoked_at FROM morrow_identity.browser_session_generations WHERE id=${lit(C.gens[0].id)})`, `(SELECT revoked_at FROM morrow_identity.browser_session_generations WHERE id=${lit(C.gens[0].id)})+interval '30 minutes'`)}`,
          invalid,
        ),
      );
    });

    // ------------------------------------------------------------------- AC04
    await section("AC04", async () => {
      const P = person("admission");
      const a = admit(P);
      const row = JSON.parse(
        value(
          `SELECT row_to_json(x)::text FROM (SELECT f.expires_at=f.created_at+interval '12 hours' AS family_12h,g.created_at=f.created_at AND g.expires_at=f.created_at+interval '30 minutes' AS generation_30m,c.expires_at=g.expires_at AS command_is_generation,floor(extract(epoch FROM g.expires_at)*1000)::bigint AS generation_ms FROM morrow_identity.browser_session_families f JOIN morrow_identity.browser_session_generations g ON g.family_id=f.id JOIN morrow_identity.account_session_commands c ON c.family_id=f.id WHERE f.id=${lit(a.familyId)}) x;`,
        ),
      );
      check(
        "ac04_account_admission_lifetimes",
        a.outcome === "newly_admitted" &&
          row.family_12h &&
          row.generation_30m &&
          row.command_is_generation &&
          a.expiresMs === Number(row.generation_ms),
        a.outcome,
      );
      check("ac04_admitted_bootstraps", eligible(a.digest, "ws_a1") === 1);
      // Each replaced body: the predecessor before, the reviewed replacement after.
      for (const entry of sessionLifecycleReplacements) {
        const predecessor = functionDefinition(read(entry.from), entry.name);
        check(
          "ac04_prosrc_" + entry.name,
          predecessorSources[entry.name] === body(predecessor) &&
            source(entry.name) === body(expectedReplacement(read, entry)),
        );
      }
      const helpers = JSON.parse(
        value(
          "SELECT json_agg(json_build_object('name',p.proname,'volatile',p.provolatile,'definer',p.prosecdef,'config',p.proconfig))::text FROM pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname IN ('browser_new_lifetimes','browser_generation_fits_family','self_session_role_safe');",
        ),
      );
      check(
        "ac04_helpers_stable_invoker",
        helpers.length === 3 &&
          helpers.every(
            (h) =>
              h.volatile === "s" &&
              h.definer === false &&
              JSON.stringify(h.config) === '["search_path=pg_catalog, morrow_identity, pg_temp"]',
          ),
      );
      check(
        "ac04_new_lifetimes",
        value(
          "SELECT family_expires_at-t='12 hours'::interval AND generation_expires_at-t='30 minutes'::interval FROM (SELECT clock_timestamp() AS t) c,morrow_identity.browser_new_lifetimes(c.t);",
        ) === "t",
      );
    });

    // ------------------------------------------------------------------- AC05
    let rotatedFamily;
    await section("AC05", async () => {
      const P = person("rotation");
      const F = seedFamily(P);
      const before = JSON.parse(writes());
      const was = family(F.family);
      const r = rotate(F.current.digest);
      const after = JSON.parse(writes());
      const now = family(F.family);
      const times = JSON.parse(
        value(
          `SELECT row_to_json(x)::text FROM (SELECT g1.revoked_at=a.recorded_at AND a.recorded_at=g2.created_at AS chained,a.reason,a.kind,g2.generation::int AS generation,floor(extract(epoch FROM g2.expires_at)*1000)::bigint AS idle_ms,g2.expires_at=least(g2.created_at+interval '30 minutes',f.expires_at) AS expiry,g2.id=${lit(r.newGeneration)} AS id FROM morrow_identity.browser_session_generations g1 JOIN morrow_identity.browser_session_audits a ON a.target_id=g1.id JOIN morrow_identity.browser_session_generations g2 ON g2.family_id=g1.family_id AND g2.generation=2 JOIN morrow_identity.browser_session_families f ON f.id=g1.family_id WHERE g1.id=${lit(F.current.id)}) x;`,
        ),
      );
      check("ac05_rotated", r.outcome === "rotated", r.outcome);
      check(
        "ac05_retire_audit_issue_chain",
        times.chained &&
          times.reason === "rotated" &&
          times.kind === "generation" &&
          times.generation === 2 &&
          times.expiry &&
          times.id,
      );
      check(
        "ac05_family_advances_by_one",
        now.current === was.current + 1 && now.revision === was.revision + 1 && !now.revoked,
      );
      check(
        "ac05_exactly_one_audit",
        after.audits === before.audits + 1 && after.generations === before.generations + 1,
      );
      check(
        "ac05_returned_expiries",
        r.idle === Number(times.idle_ms) && r.absolute === now.expires_ms,
      );
      check(
        "ac05_new_resolves_old_does_not",
        eligible(r.newDigest, "ws_a1") === 1 && eligible(F.current.digest, "ws_a1") === 0,
      );
      rotatedFamily = { ...F, newer: r };
      check(
        "ac05_logout_with_old_digest_ends_family",
        logout(F.current.digest) === "ended" &&
          family(F.family).revoked &&
          eligible(r.newDigest, "ws_a1") === 0,
      );
    });

    // ------------------------------------------------------------------- AC06
    await section("AC06", async () => {
      const P = person("young");
      const F = seedFamily(P, { age: 10 });
      const holder = connection(id);
      try {
        await holder.query(
          `BEGIN; SET LOCAL ROLE morrow_identity_owner; SELECT 1 FROM morrow_identity.browser_session_families WHERE id=${lit(F.family)} FOR UPDATE;`,
        );
        const before = writes();
        const r = rotate(F.current.digest, { prefix: "SET lock_timeout='50ms';\n" });
        const expected = JSON.parse(
          value(
            `SELECT json_build_object('idle',floor(extract(epoch FROM g.expires_at)*1000)::bigint,'absolute',floor(extract(epoch FROM f.expires_at)*1000)::bigint)::text FROM morrow_identity.browser_session_generations g JOIN morrow_identity.browser_session_families f ON f.id=g.family_id WHERE g.id=${lit(F.current.id)};`,
          ),
        );
        check(
          "ac06_young_generation_current_unlocked",
          r.outcome === "current" && r.idle === expected.idle && r.absolute === expected.absolute,
          r.outcome,
        );
        check("ac06_current_writes_nothing", writes() === before);
      } finally {
        await holder.query("ROLLBACK;").catch(() => {});
        await holder.close();
      }
    });

    // ------------------------------------------------------------------- AC07
    let reused;
    await section("AC07", async () => {
      const P = person("reuse");
      const F = seedFamily(P, { age: 600, rotations: [300] });
      const before = JSON.parse(writes());
      const r = rotate(F.gens[0].digest);
      const after = JSON.parse(writes());
      check("ac07_reuse_revoked", r.outcome === "reuse_revoked", r.outcome);
      check(
        "ac07_one_reuse_audit",
        after.audits === before.audits + 1 &&
          value(
            `SELECT count(*) FROM morrow_identity.browser_session_audits a JOIN morrow_identity.browser_session_families f ON f.id=a.target_id AND a.recorded_at=f.revoked_at WHERE a.kind='family' AND a.outcome='revoked' AND a.reason='reuse_detected' AND f.id=${lit(F.family)};`,
          ) === "1",
      );
      check("ac07_current_resolves_nothing", eligible(F.current.digest, "ws_a1") === 0);
      const quiet = writes();
      const again = rotate(F.current.digest);
      check(
        "ac07_current_rotation_denied",
        again.outcome === "denied" && writes() === quiet,
        again.outcome,
      );
      reused = F;
    });

    // ------------------------------------------------------------------- AC08
    await section("AC08", async () => {
      const P = person("race");
      const F = seedFamily(P);
      const holder = connection(id);
      const app = "session_lab_race_" + next();
      try {
        await holder.query(
          `BEGIN; SET LOCAL ROLE morrow_identity_owner; SELECT 1 FROM morrow_identity.browser_session_families WHERE id=${lit(F.family)} FOR UPDATE;`,
        );
        const one = rotateSql(F.current.digest),
          two = rotateSql(F.current.digest);
        const runs = [one, two].map((r, i) =>
          psqlAsync(id, r.text, { user: "morrow_identity_logout", applicationName: app + "_" + i }),
        );
        const both = await waitingOnLock(app, 2);
        await holder.query("ROLLBACK;");
        const outcomes = (await Promise.all(runs)).map(
          (r) => parseRotation(r.stdout.split("\n").at(-1)).outcome,
        );
        check("ac08_both_waited", both);
        check(
          "ac08_one_rotated_one_reuse",
          outcomes.sort().join(",") === "reuse_revoked,rotated",
          outcomes.join(","),
        );
        const state = JSON.parse(
          value(
            `SELECT json_build_object('current',(SELECT count(*) FROM morrow_identity.browser_session_generations g JOIN morrow_identity.browser_session_families f ON f.id=g.family_id AND f.current_generation=g.generation WHERE f.id=${lit(F.family)}),'live',(SELECT count(*) FROM morrow_identity.browser_session_generations g WHERE g.family_id=${lit(F.family)} AND g.revoked_at IS NULL),'revoked',(SELECT revoked_at IS NOT NULL FROM morrow_identity.browser_session_families WHERE id=${lit(F.family)}))::text;`,
          ),
        );
        check(
          "ac08_one_current_no_two_live",
          state.current === 1 && state.live <= 1 && state.revoked === true,
        );
      } finally {
        await holder.query("ROLLBACK;").catch(() => {});
        await holder.close();
      }
    });

    // ------------------------------------------------------------------- AC09
    await section("AC09", async () => {
      const P = person("idle");
      // Generation 1 of a 12-hour family, created 30 min - 1.5 s ago: expires 1.5 s ahead.
      const F = seedFamily(P, { age: 1800 - 1.5 });
      const live = value(
        `WITH e AS MATERIALIZED (SELECT count(*) AS n FROM morrow_identity.session_eligibility(${lit(F.current.digest)},'ws_a1')) SELECT e.n::text||'|'||(clock_timestamp()<g.expires_at)::text FROM e,morrow_identity.browser_session_generations g WHERE g.id=${lit(F.current.id)};`,
      ).split("|");
      check("ac09_resolves_before_idle_expiry", live[1] !== "true" || live[0] === "1", live);
      const passed = await waitUntilPast(
        `(SELECT expires_at FROM morrow_identity.browser_session_generations WHERE id=${lit(F.current.id)})`,
      );
      check("ac09_idle_expired", passed && eligible(F.current.digest, "ws_a1") === 0);
      const before = writes();
      const r = rotate(F.current.digest);
      check(
        "ac09_rotation_denied_no_write",
        r.outcome === "denied" && writes() === before,
        r.outcome,
      );
      await sleep(500);
      check("ac09_no_revival", eligible(F.current.digest, "ws_a1") === 0);
    });

    // ------------------------------------------------------------------- AC10
    await section("AC10", async () => {
      const P = person("absolute");
      for (const [label, left] of [
        ["5s", 5],
        ["29m", 29 * 60],
        ["31m", 31 * 60],
      ]) {
        // Created 12 h - left ago; generation 2 issued 2 minutes ago.
        const F = seedFamily(P, { age: 12 * 3600 - left, rotations: [120] });
        const r = rotate(F.current.digest);
        const f = family(F.family);
        const g = JSON.parse(
          value(
            `SELECT coalesce((SELECT json_build_object('created',floor(extract(epoch FROM created_at)*1000)::bigint,'expires',floor(extract(epoch FROM expires_at)*1000)::bigint) FROM morrow_identity.browser_session_generations WHERE id=${lit(r.newGeneration)}),'null')::text;`,
          ),
        );
        const expected = g ? Math.min(g.created + 1800000, f.expires_ms) : null;
        check(
          "ac10_rotation_bounded_" + label,
          r.outcome === "rotated" &&
            g !== null &&
            g.expires === expected &&
            r.idle === expected &&
            r.absolute === f.expires_ms,
          r.outcome,
        );
        if (label === "5s") {
          const passed = await waitUntilPast(
            `(SELECT expires_at FROM morrow_identity.browser_session_families WHERE id=${lit(F.family)})`,
          );
          const before = writes();
          const after = rotate(r.newDigest);
          check(
            "ac10_after_absolute_expiry_everything_denies",
            passed &&
              eligible(r.newDigest, "ws_a1") === 0 &&
              after.outcome === "denied" &&
              writes() === before,
            after.outcome,
          );
        }
      }
      // The step-11 late check: a row wait inside the rotation subtransaction outlives the
      // family. The holder blocks generation writes (SHARE mode) but not the reads and row
      // locks before the subtransaction, so the rotation reads its instant and then waits.
      const F = seedFamily(P, { age: 12 * 3600 - 6, rotations: [120] });
      const holder = connection(id);
      const app = "session_lab_late_" + next();
      try {
        await holder.query(
          "BEGIN; SET LOCAL ROLE morrow_identity_owner; LOCK TABLE morrow_identity.browser_session_generations IN SHARE MODE;",
        );
        const r = rotateSql(F.current.digest);
        const pending = psqlAsync(id, r.text, {
          user: "morrow_identity_logout",
          applicationName: app,
        });
        const waited = await waitingOnLock(app);
        const expired = await waitUntilPast(
          `(SELECT expires_at FROM morrow_identity.browser_session_families WHERE id=${lit(F.family)})`,
        );
        const before = writes();
        await holder.query("ROLLBACK;");
        const out = parseRotation((await pending).stdout.split("\n").at(-1));
        check(
          "ac10_late_check_denies_after_wait",
          waited && expired && out.outcome === "denied" && writes() === before,
          out.outcome,
        );
        const f = family(F.family);
        check("ac10_late_check_retired_nothing", f.current === 2 && !f.revoked);
      } finally {
        await holder.query("ROLLBACK;").catch(() => {});
        await holder.close();
      }
    });

    // ------------------------------------------------------------------- AC11
    await section("AC11", async () => {
      const P = person("revival");
      const zero = (F, label) => {
        const before = writes();
        const r = rotate(F.current.digest);
        check("ac11_denied_" + label, r.outcome === "denied" && writes() === before, r.outcome);
      };
      const revokedFamily = seedFamily(P);
      admin(
        `SELECT * FROM morrow_identity.revoke_browser_family(${lit(revokedFamily.family)},${lit(randomUUID())},${lit(sha("a"))});`,
      );
      zero(revokedFamily, "revoked_family");
      const revokedBinding = seedFamily(P);
      admin(
        `SELECT * FROM morrow_identity.revoke_provider_binding(${lit(revokedBinding.binding)},${lit(randomUUID())},${lit(sha("b"))});`,
      );
      zero(revokedBinding, "revoked_binding");
      const revokedGeneration = seedFamily(P);
      admin(
        `SELECT * FROM morrow_identity.revoke_browser_generation(${lit(revokedGeneration.current.id)},${lit(randomUUID())},${lit(sha("c"))});`,
      );
      zero(revokedGeneration, "maintenance_revoked_generation");
      const expired = seedFamily(P, { age: 12 * 3600 + 60, rotations: [12 * 3600 + 30] });
      zero(expired, "expired_family");
      const raises = (text, marker) => {
        const r = attempt("BEGIN; SET LOCAL ROLE morrow_identity_owner;\n" + text + "\nROLLBACK;");
        return !r.ok && r.stderr.includes(marker);
      };
      const F = seedFamily(P, { age: 600, rotations: [300] });
      const setAudit = (target) =>
        `SELECT set_config('morrow.browser_revocation_audit',(SELECT a.id::text FROM morrow_identity.browser_session_audits a WHERE a.target_id=${lit(target)} AND a.reason='rotated'),true);`;
      check(
        "ac11_unrevoke_raises",
        raises(
          `UPDATE morrow_identity.browser_session_families SET revoked_at=NULL,record_revision=record_revision+1 WHERE id=${lit(revokedFamily.family)};`,
          "BROWSER_SESSION_REVOCATION_INVALID",
        ),
      );
      check(
        "ac11_lower_generation_raises",
        raises(
          `${setAudit(F.gens[0].id)}
UPDATE morrow_identity.browser_session_families SET current_generation=1,record_revision=record_revision+1 WHERE id=${lit(F.family)};`,
          "BROWSER_SESSION_ADVANCE_INVALID",
        ),
      );
      const retire = (target, family) =>
        `DO $$ DECLARE a text:=gen_random_uuid()::text; t timestamptz:=clock_timestamp(); BEGIN
 INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at) VALUES(a,gen_random_uuid()::text,${lit(sha("r"))},'generation',${lit(target)},'revoked','rotated',t);
 PERFORM set_config('morrow.browser_revocation_audit',a,false);
 UPDATE morrow_identity.browser_session_generations SET revoked_at=t,record_revision=record_revision+1 WHERE id=${lit(target)};
END $$;
UPDATE morrow_identity.browser_session_families SET current_generation=current_generation+{STEP},record_revision=record_revision+1 WHERE id=${lit(family)};`;
      check(
        "ac11_skip_generation_raises",
        raises(
          retire(F.current.id, F.family).replace("{STEP}", "2"),
          "BROWSER_SESSION_ADVANCE_INVALID",
        ),
      );
      check(
        "ac11_valid_advance_control",
        attempt(
          "BEGIN; SET LOCAL ROLE morrow_identity_owner;\n" +
            retire(F.current.id, F.family).replace("{STEP}", "1") +
            "\nROLLBACK;",
        ).ok,
      );
      const legacy = seedFamily(P, { age: 30, lifetime: "15 minutes" });
      check(
        "ac11_advance_legacy_raises",
        raises(
          retire(legacy.current.id, legacy.family).replace("{STEP}", "1"),
          "BROWSER_SESSION_ADVANCE_INVALID",
        ),
      );
      check(
        "ac11_advance_revoked_raises",
        raises(
          retire(revokedFamily.current.id, revokedFamily.family).replace("{STEP}", "1"),
          "BROWSER_SESSION_REVOCATION_INVALID",
        ),
      );
      check(
        "ac11_advance_expired_raises",
        raises(
          retire(expired.current.id, expired.family).replace("{STEP}", "1"),
          "BROWSER_SESSION_ADVANCE_INVALID",
        ),
      );
      check(
        "ac11_advance_without_audit_raises",
        raises(
          `UPDATE morrow_identity.browser_session_families SET current_generation=current_generation+1,record_revision=record_revision+1 WHERE id=${lit(F.family)};`,
          "BROWSER_SESSION_ADVANCE_INVALID",
        ),
      );
      // A sign-out row to probe immutability.
      const S = person("immutable", ["org_a"]);
      admin(
        `UPDATE morrow_identity.memberships SET active=false WHERE id=${lit(S.memberships.org_a)};`,
      );
      for (const [label, text] of [
        [
          "update",
          "UPDATE morrow_identity.organization_session_signouts SET cause='membership_deleted';",
        ],
        ["delete", "DELETE FROM morrow_identity.organization_session_signouts;"],
        ["truncate", "TRUNCATE morrow_identity.organization_session_signouts;"],
      ])
        check(
          "ac11_signout_" + label + "_raises",
          raises(text, "SESSION_SIGNOUT_RECORD_IMMUTABLE"),
        );
    });

    // ------------------------------------------------------------------- AC12
    await section("AC12", async () => {
      const F = reused;
      check(
        "ac12_binding_unrevoked_after_reuse",
        value(
          `SELECT revoked_at IS NULL FROM morrow_identity.provider_session_bindings WHERE id=${lit(F.binding)};`,
        ) === "t" && family(F.family).revoked,
      );
      const fresh = admit(F.person, F.sid);
      check(
        "ac12_fresh_signin_new_family",
        fresh.outcome === "newly_admitted" &&
          fresh.familyId !== F.family &&
          value(
            `SELECT provider_binding_id FROM morrow_identity.browser_session_families WHERE id=${lit(fresh.familyId)};`,
          ) === F.binding &&
          eligible(fresh.digest, "ws_a1") === 1,
        fresh.outcome,
      );
      admin(
        `SELECT * FROM morrow_identity.revoke_provider_binding(${lit(F.binding)},${lit(randomUUID())},${lit(sha("binding"))});`,
      );
      const after = admit(F.person, F.sid);
      check(
        "ac12_revoked_binding_denies_admission",
        after.outcome === "denied" && after.reason === "binding_revoked",
        after.reason,
      );
    });

    // ------------------------------------------------------------------- AC13
    let signedOut;
    await section("AC13", async () => {
      const Q = person("signout");
      const F = seedFamily(Q, { age: 600, rotations: [300] });
      check(
        "ac13_resolves_both_before",
        eligible(F.current.digest, "ws_a1") === 1 && eligible(F.current.digest, "ws_b1") === 1,
      );
      const before = Number(
        value("SELECT count(*) FROM morrow_identity.organization_session_signouts;"),
      );
      // Membership writers lock the organization first (the 0008/0014 order).
      admin(`BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization','org_a'::text)::text,0));
SELECT 1 FROM morrow_identity.organizations WHERE id='org_a' FOR UPDATE;
UPDATE morrow_identity.memberships SET active=false WHERE id=${lit(Q.memberships.org_a)};
COMMIT;`);
      const rows = JSON.parse(
        value(
          `SELECT coalesce(json_agg(json_build_object('cause',cause,'principal',principal_id,'membership',membership_id,'by',recorded_by)),'[]')::text FROM morrow_identity.organization_session_signouts WHERE organization_id='org_a' AND principal_id=${lit(Q.principal)};`,
        ),
      );
      check(
        "ac13_one_signout_row",
        Number(value("SELECT count(*) FROM morrow_identity.organization_session_signouts;")) ===
          before + 1 &&
          rows.length === 1 &&
          rows[0].cause === "membership_deactivated" &&
          rows[0].membership === Q.memberships.org_a &&
          rows[0].by === "postgres",
      );
      check(
        "ac13_organization_signed_out_only",
        eligible(F.current.digest, "ws_a1") === 0 &&
          eligible(F.current.digest, "ws_a2") === 0 &&
          eligible(F.current.digest, "ws_b1") === 1 &&
          !family(F.family).revoked,
      );
      admin(
        `UPDATE morrow_identity.memberships SET active=true WHERE id=${lit(Q.memberships.org_a)};`,
      );
      check(
        "ac13_reactivation_does_not_revive",
        eligible(F.current.digest, "ws_a1") === 0 && eligible(F.current.digest, "ws_b1") === 1,
      );
      const fresh = admit(Q);
      check(
        "ac13_signin_after_reactivation_resolves",
        fresh.outcome === "newly_admitted" && eligible(fresh.digest, "ws_a1") === 1,
        fresh.outcome,
      );
      // Deletion and reassignment record their cause.
      const R = person("deleted", ["org_a"]);
      admin(`DELETE FROM morrow_identity.workspace_memberships WHERE membership_id=${lit(R.memberships.org_a)};
DELETE FROM morrow_identity.memberships WHERE id=${lit(R.memberships.org_a)};`);
      const S = person("reassigned", ["org_a"]);
      const T = person("reassignee", ["org_b"]);
      admin(
        `UPDATE morrow_identity.memberships SET principal_id=${lit(T.principal)} WHERE id=${lit(S.memberships.org_a)};`,
      );
      check(
        "ac13_deletion_and_reassignment_causes",
        value(
          `SELECT string_agg(cause,',' ORDER BY cause) FROM morrow_identity.organization_session_signouts WHERE principal_id IN (${lit(R.principal)},${lit(S.principal)});`,
        ) === "membership_deleted,membership_reassigned",
      );
      signedOut = { Q, F };
    });

    // ------------------------------------------------------------------- AC14
    await section("AC14", async () => {
      // (a) The admission holds the principal FOR UPDATE when the removal fires.
      const U = person("race_a");
      const a = admissionTuple(U, wid("session", next()));
      const sessions = connection(id, "morrow_identity_sessions");
      const app = "session_lab_removal_" + next();
      try {
        const admitted = await sessions.query("BEGIN;\n" + admissionSql(a.t));
        const removal = psqlAsync(
          id,
          `SET ROLE morrow_identity_owner;\nUPDATE morrow_identity.memberships SET active=false WHERE id=${lit(U.memberships.org_a)};`,
          { applicationName: app },
        );
        const waited = await waitingOnLock(app);
        await sessions.query("COMMIT;");
        const done = await removal;
        const order = value(
          `SELECT (s.signed_out_at>f.created_at)::text FROM morrow_identity.organization_session_signouts s,morrow_identity.browser_session_families f WHERE s.principal_id=${lit(U.principal)} AND s.organization_id='org_a' AND f.id=${lit(a.familyId)};`,
        );
        admin(
          `UPDATE morrow_identity.memberships SET active=true WHERE id=${lit(U.memberships.org_a)};`,
        );
        check(
          "ac14_a_removal_waits_for_admission",
          admitted.lines.at(-1)?.startsWith("newly_admitted|") &&
            waited &&
            done.ok &&
            order === "true",
        );
        check(
          "ac14_a_admitted_family_excluded_after_reactivation",
          eligible(a.digest, "ws_a1") === 0 && eligible(a.digest, "ws_b1") === 1,
        );
      } finally {
        await sessions.query("ROLLBACK;").catch(() => {});
        await sessions.close();
      }
      // (b) The removal has fired and is held open; the admission waits on the principal.
      const V = person("race_b");
      const F0 = seedFamily(V);
      const legacyDigest = sha(newSecret());
      admin(
        `INSERT INTO morrow_identity.sessions VALUES(${lit("session_" + V.key)},${lit(V.principal)},'org_a',${lit(legacyDigest)},'workos',${lit("provider_session_" + V.key)},clock_timestamp()+interval '1 day',NULL);`,
      );
      check("ac14_b_legacy_session_resolves_before", eligible(legacyDigest, "ws_a1") === 1);
      const remover = connection(id);
      const app2 = "session_lab_admission_" + next();
      try {
        await remover.query(
          `BEGIN; SET LOCAL ROLE morrow_identity_owner; UPDATE morrow_identity.memberships SET active=false WHERE id=${lit(V.memberships.org_a)};`,
        );
        const b = admissionTuple(V, wid("session", next()));
        // Evidence must still be open after the hold: the hold is released promptly.
        const pending = psqlAsync(id, admissionSql(b.t), {
          user: "morrow_identity_sessions",
          applicationName: app2,
        });
        const waited = await waitingOnLock(app2);
        const onPrincipal = value(
          `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity s ON s.pid=l.pid WHERE NOT l.granted AND s.application_name=${lit(app2)};`,
        );
        await remover.query("COMMIT;");
        const outcome = (await pending).stdout.split("\n").at(-1)?.split("|")[0];
        const order = value(
          `SELECT (f.created_at>s.signed_out_at)::text FROM morrow_identity.organization_session_signouts s,morrow_identity.browser_session_families f WHERE s.principal_id=${lit(V.principal)} AND s.organization_id='org_a' AND f.id=${lit(b.familyId)};`,
        );
        admin(
          `UPDATE morrow_identity.memberships SET active=true WHERE id=${lit(V.memberships.org_a)};`,
        );
        check(
          "ac14_b_admission_waits_for_removal",
          waited && Number(onPrincipal) >= 1 && outcome === "newly_admitted" && order === "true",
          outcome,
        );
        check(
          "ac14_b_prior_family_excluded_after_reactivation",
          eligible(F0.current.digest, "ws_a1") === 0 &&
            eligible(F0.current.digest, "ws_b1") === 1 &&
            eligible(b.digest, "ws_a1") === 1,
        );
        check("ac14_b_legacy_session_excluded", eligible(legacyDigest, "ws_a1") === 0);
      } finally {
        await remover.query("ROLLBACK;").catch(() => {});
        await remover.close();
      }
    });

    // ------------------------------------------------------------------- AC15
    await section("AC15", async () => {
      const W = person("workspace_removal");
      const F = seedFamily(W, { age: 600, rotations: [300] });
      const policy = () =>
        value("SELECT policy_revision FROM morrow_identity.organizations WHERE id='org_a';");
      const revision = policy();
      const signouts = value("SELECT count(*) FROM morrow_identity.organization_session_signouts;");
      admin(`BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization','org_a'::text)::text,0));
SELECT 1 FROM morrow_identity.organizations WHERE id='org_a' FOR UPDATE;
UPDATE morrow_identity.workspace_memberships SET active=false WHERE workspace_id='ws_a1' AND membership_id=${lit(W.memberships.org_a)};
UPDATE morrow_identity.organizations SET policy_revision=policy_revision+1 WHERE id='org_a';
COMMIT;`);
      check(
        "ac15_one_workspace_stops",
        eligible(F.current.digest, "ws_a1") === 0 &&
          eligible(F.current.digest, "ws_a2") === 1 &&
          eligible(F.current.digest, "ws_b1") === 1,
      );
      check(
        "ac15_no_signout_no_revocation",
        value("SELECT count(*) FROM morrow_identity.organization_session_signouts;") === signouts &&
          !family(F.family).revoked &&
          Number(policy()) === Number(revision) + 1,
      );
    });

    // ------------------------------------------------------------------- AC16
    await section("AC16", async () => {
      check(
        "ac16_eligibility_oid_and_shape",
        value("SELECT 'morrow_identity.session_eligibility(text,text)'::regprocedure::oid;") ===
          eligibilityOid &&
          value(
            "SELECT pg_get_function_result('morrow_identity.session_eligibility(text,text)'::regprocedure);",
          ) === eligibilityResult &&
          eligibilityResult ===
            "TABLE(principal_id text, organization_id text, workspace_id text, membership_id text, policy_revision bigint)",
      );
      const { F } = signedOut;
      const overview = JSON.parse(
        value(
          `SELECT workspaces::text FROM morrow_identity.account_overview(${lit(F.current.digest)},${lit(profile.id)});`,
        ),
      );
      check(
        "ac16_account_overview_excludes_signed_out",
        overview.map((w) => w.workspaceId).join(",") === "ws_b1",
      );
      check(
        "ac16_work_session_context_excludes_signed_out",
        value(
          `SELECT count(*) FROM morrow_identity.work_session_context(${lit(F.current.digest)},'ws_a1');`,
        ) === "0" &&
          value(
            `SELECT count(*) FROM morrow_identity.work_session_context(${lit(F.current.digest)},'ws_b1');`,
          ) === "1",
      );
    });

    // ------------------------------------------------------------------- AC17
    await section("AC17", async () => {
      const executable = value(
        "SELECT string_agg(regexp_replace(p.oid::regprocedure::text,'\\(.*$',''),',' ORDER BY 1) FROM pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace AND has_function_privilege('morrow_identity_logout',p.oid,'EXECUTE');",
      );
      check(
        "ac17_logout_executes_two_functions",
        executable ===
          "morrow_identity.end_self_browser_family,morrow_identity.rotate_self_browser_generation" &&
          value("SELECT has_schema_privilege('morrow_identity_logout','morrow_work','USAGE');") ===
            "f",
        executable,
      );
      check(
        "ac17_logout_no_table_privilege",
        value(
          "SELECT count(*) FROM pg_class c WHERE c.relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('morrow_identity','morrow_work')) AND c.relkind IN ('r','v','m','p') AND (has_table_privilege('morrow_identity_logout',c.oid,'SELECT') OR has_table_privilege('morrow_identity_logout',c.oid,'INSERT') OR has_table_privilege('morrow_identity_logout',c.oid,'UPDATE') OR has_table_privilege('morrow_identity_logout',c.oid,'DELETE'));",
        ) === "0",
      );
      const P = person("privilege");
      const F = seedFamily(P);
      const r = rotateSql(F.current.digest);
      const other = attempt(r.text, "morrow_identity_sessions");
      check("ac17_other_executor_refused", !other.ok && other.stderr.includes("42501"));
      const before = writes();
      check(
        "ac17_owner_session_denied",
        parseRotation(value("SET ROLE morrow_identity_owner;\n" + r.text)).outcome === "denied" &&
          writes() === before,
      );
      for (const [label, grant] of [
        ["onboarding", "GRANT morrow_identity_owner TO morrow_identity_onboarding;"],
        ["work_role", "GRANT morrow_identity_owner TO morrow_work_api;"],
        ["owner_into_logout_peer", "GRANT morrow_identity_sessions TO morrow_identity_owner;"],
      ]) {
        run(grant);
        let outcome;
        try {
          outcome = rotate(F.current.digest).outcome;
        } finally {
          run(grant.replace("GRANT", "REVOKE").replace(" TO ", " FROM "));
        }
        check("ac17_role_unsafe_" + label, outcome === "denied", outcome);
      }
      check("ac17_safe_again_rotates", rotate(F.current.digest).outcome === "rotated");
      check(
        "ac17_signouts_force_rls_owner_only",
        value(
          "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='morrow_identity.organization_session_signouts'::regclass;",
        ) === "t" &&
          value(
            "SELECT count(*) FROM pg_roles r WHERE r.rolname<>'morrow_identity_owner' AND r.rolname LIKE 'morrow\\_%' AND (has_table_privilege(r.oid,'morrow_identity.organization_session_signouts','SELECT') OR has_table_privilege(r.oid,'morrow_identity.organization_session_signouts','INSERT'));",
          ) === "0" &&
          value(
            "SELECT string_agg(policyname||':'||roles::text,',') FROM pg_policies WHERE schemaname='morrow_identity' AND tablename='organization_session_signouts';",
          ) === "identity_owner:{morrow_identity_owner}",
      );
      check(
        "ac17_new_helpers_not_executable",
        value(
          "SELECT count(*) FROM pg_proc p,pg_roles r WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname IN ('preserve_session_signout_record','record_organization_session_signout','browser_new_lifetimes','browser_generation_fits_family','self_session_role_safe','check_browser_generation_insert') AND r.rolname<>'morrow_identity_owner' AND NOT r.rolsuper AND r.rolname LIKE 'morrow\\_%' AND has_function_privilege(r.oid,p.oid,'EXECUTE');",
        ) === "0",
      );
    });

    // ------------------------------------------------------------------- AC18
    await section("AC18", async () => {
      const P = person("ambiguous");
      const F = seedFamily(P);
      admin(
        `INSERT INTO morrow_identity.sessions VALUES('session_ambiguous',${lit(P.principal)},'org_a',${lit(F.current.digest)},'workos','provider_session_ambiguous',clock_timestamp()+interval '1 day',NULL);`,
      );
      let before = writes();
      check(
        "ac18_presented_in_both_denied",
        rotate(F.current.digest).outcome === "denied" && writes() === before,
      );
      admin("DELETE FROM morrow_identity.sessions WHERE id='session_ambiguous';");
      const G = seedFamily(P);
      before = writes();
      check(
        "ac18_new_digest_in_generations_denied",
        rotate(F.current.digest, { newDigest: G.current.digest }).outcome === "denied" &&
          writes() === before,
      );
      const taken = sha(newSecret());
      admin(
        `INSERT INTO morrow_identity.sessions VALUES('session_taken',${lit(P.principal)},'org_a',${lit(taken)},'workos','provider_session_taken',clock_timestamp()+interval '1 day',NULL);`,
      );
      before = writes();
      check(
        "ac18_new_digest_in_sessions_denied",
        rotate(F.current.digest, { newDigest: taken }).outcome === "denied" && writes() === before,
      );
      check("ac18_control_rotates", rotate(F.current.digest).outcome === "rotated");
    });

    // ------------------------------------------------------------------- AC19
    await section("AC19", async () => {
      const P = person("contention");
      const F1 = seedFamily(P);
      const F2 = seedFamily(P);
      const first = connection(id, "morrow_identity_logout");
      try {
        const one = rotateSql(F1.current.digest);
        const a = await first.query("SET lock_timeout='50ms'; BEGIN;\n" + one.text);
        const two = rotate(F2.current.digest, { prefix: "SET lock_timeout='50ms';\n" });
        check(
          "ac19_two_families_one_profile_rotate_concurrently",
          parseRotation(a.lines.at(-1)).outcome === "rotated" && two.outcome === "rotated",
          two.outcome,
        );
        const update = attempt(
          `SET lock_timeout='50ms'; SET ROLE morrow_identity_owner; UPDATE morrow_identity.identity_verification_profiles SET record_revision=record_revision+1 WHERE id=${lit(profile.id)};`,
        );
        check(
          "ac19_profile_update_waits_for_rotation",
          !update.ok && update.stderr.includes("55P03"),
        );
        await first.query("COMMIT;");
      } finally {
        await first.query("ROLLBACK;").catch(() => {});
        await first.close();
      }
      const F3 = seedFamily(P);
      const owner = connection(id);
      try {
        await owner.query(
          `BEGIN; SET LOCAL ROLE morrow_identity_owner; UPDATE morrow_identity.identity_verification_profiles SET record_revision=record_revision+1 WHERE id=${lit(profile.id)};`,
        );
        const r = attempt(
          "SET lock_timeout='50ms';\n" + rotateSql(F3.current.digest).text,
          "morrow_identity_logout",
        );
        check("ac19_rotation_waits_for_profile_update", !r.ok && r.stderr.includes("55P03"));
      } finally {
        await owner.query("ROLLBACK;").catch(() => {});
        await owner.close();
      }
      check(
        "ac19_profile_unchanged",
        value(
          `SELECT record_revision FROM morrow_identity.identity_verification_profiles WHERE id=${lit(profile.id)};`,
        ) === "1",
      );
    });

    // ------------------------------------------------------------------- AC20
    await section("AC20", async () => {
      const named = value(
        "SELECT string_agg(n.nspname||'.'||p.proname,',' ORDER BY n.nspname,p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('morrow_identity','morrow_work') AND (p.prosrc LIKE '%browser_session_families%' OR p.prosrc LIKE '%browser_session_generations%');",
      );
      const replaced = [
        "account_session_principal",
        "admit_account_family",
        "end_self_browser_family",
        "preserve_browser_session_record",
        "reconcile_login_flow",
        "session_eligibility",
      ];
      const introduced = ["check_browser_generation_insert", "rotate_self_browser_generation"];
      const legacyOnly = [
        "admit_browser_family",
        "reconcile_browser_admission",
        "reconcile_workspace_login_flow",
      ];
      const unaffected = ["lock_session_eligibility", "revoke_browser_record"];
      const reviewed = [...replaced, ...introduced, ...legacyOnly, ...unaffected]
        .map((name) => "morrow_identity." + name)
        .sort();
      const actual = (named ?? "").split(",").filter(Boolean);
      check(
        "ac20_reviewed_function_list",
        actual.every((name) => reviewed.includes(name)) &&
          [
            ...replaced,
            ...introduced,
            "admit_browser_family",
            "lock_session_eligibility",
            "revoke_browser_record",
          ].every((name) => actual.includes("morrow_identity." + name)),
        actual,
      );
      const offenders = value(
        `SELECT coalesce(string_agg(p.proname,','),'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('morrow_identity','morrow_work') AND p.proname NOT IN (${[...replaced, ...legacyOnly].map(lit).join(",")}) AND regexp_replace(p.prosrc,'\\s','','g') ~ '(g\\.created_at(=|<>)f\\.created_at|g\\.expires_at(=|<>)f\\.expires_at|current_generation=1)';`,
      );
      check("ac20_no_old_time_predicate_elsewhere", offenders === "", offenders);
    });

    // ------------------------------------------------------------------- AC21
    await section("AC21", async () => {
      const X = person("digest_actor", ["org_a"]);
      const Y = person("digest_target", ["org_a"]);
      const Z = person("digest_target_two", ["org_a"]);
      const F = seedFamily(X);
      const grant = {
        id: "grant_digest_actor_revoke",
        principal: {
          kind: "human",
          principalId: X.principal,
          organizationId: "org_a",
          workspaceId: "ws_a1",
          membershipId: X.memberships.org_a,
          installationId: null,
          mandateId: null,
        },
        capabilityId: "governance.membership.revoke",
        verbs: ["execute", "approve"],
        scope: {
          organizationId: "org_a",
          workspaceId: "ws_a1",
          storeIds: [],
          accountIds: [],
          resources: [
            {
              organizationId: "org_a",
              workspaceId: "ws_a1",
              storeId: null,
              connectionId: null,
              kind: "workspace",
              id: "ws_a1",
            },
          ],
          fields: ["membershipId", "expectedRevision", "control"],
        },
        issuedBy: {
          kind: "human",
          principalId: X.principal,
          organizationId: "org_a",
          workspaceId: "ws_a1",
          membershipId: X.memberships.org_a,
          installationId: null,
          mandateId: null,
        },
        validFrom: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        revokedAt: null,
        policyRevision: 1,
      };
      admin(
        `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES(${lit(grant.id)},'org_a','ws_a1',${lit(X.memberships.org_a)},${lit(X.principal)},${lit(JSON.stringify(grant))}::jsonb);`,
      );
      const receipt = (key, digest, target) => {
        const policy = value(
          "SELECT policy_revision FROM morrow_identity.organizations WHERE id='org_a';",
        );
        const r = {
          id: "receipt_" + key,
          command: randomUUID(),
          request: sha(randomUUID()),
          digest,
          target,
          policy,
        };
        admin(
          `INSERT INTO morrow_identity.workspace_revocation_receipts(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,actor_session_digest,target_membership_id,command_id,request_digest,expected_policy_revision,authorizing_grant_id,authorizing_grant_snapshot,approval_evidence_id,expires_at) VALUES(${lit(r.id)},'org_a','ws_a1',${lit(X.principal)},${lit(X.memberships.org_a)},${lit(digest)},${lit(target)},${lit(r.command)},${lit(r.request)},${policy},${lit(grant.id)},${lit(JSON.stringify(grant))}::jsonb,'approval_${key}',clock_timestamp()+interval '10 minutes');`,
        );
        return r;
      };
      const execute = (r) =>
        value(
          `SELECT outcome FROM morrow_identity.revoke_workspace_access(${[r.id, r.command, r.request, r.digest, "org_a", "ws_a1", r.target, r.policy].map(lit).join(",")});`,
          "morrow_identity_lifecycle",
        );
      const stale = receipt("stale", F.current.digest, Y.memberships.org_a);
      const rotation = rotate(F.current.digest);
      const policy = value(
        "SELECT policy_revision FROM morrow_identity.organizations WHERE id='org_a';",
      );
      const outcome = execute(stale);
      check(
        "ac21_revocation_bound_to_retired_digest_denied",
        rotation.outcome === "rotated" &&
          outcome === "denied" &&
          value(
            `SELECT active FROM morrow_identity.workspace_memberships WHERE workspace_id='ws_a1' AND membership_id=${lit(Y.memberships.org_a)};`,
          ) === "t" &&
          value("SELECT policy_revision FROM morrow_identity.organizations WHERE id='org_a';") ===
            policy &&
          value(
            `SELECT reason FROM morrow_identity.workspace_revocation_results WHERE receipt_id=${lit(stale.id)};`,
          ) === "actor_ineligible",
        outcome,
      );
      const current = receipt("current", rotation.newDigest, Z.memberships.org_a);
      check("ac21_control_current_digest_applies", execute(current) === "applied");
      check(
        "ac21_linking_functions_authenticate_by_eligibility",
        value(
          "SELECT bool_and(p.prosrc LIKE '%session_eligibility(h.session_digest%') FROM pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname='link_workspace_store';",
        ) === "t",
      );
    });
  },
  { stopBefore: 16 },
);

console.log = print;
const report = {
  task: "P05.T01y",
  pr: "PR-1 lifecycle SQL",
  qualification: "local_postgresql17_network_none_session_lifecycle",
  engine: observedEngine,
  observedAt: new Date().toISOString(),
  durationMs: Date.now() - started,
  sectionMs: timings,
  checks,
  limitations: [
    "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, provider or merchant data.",
    "AC15 reproduces the 0004 workspace revocation by owner maintenance with the same lock order and effects; AC21 runs the real revoke_workspace_access.",
    "AC21: the 0004 revocation records a durable 'denied' result (actor_ineligible) for a receipt bound to a retired generation; linking handoffs, reviews, the 0009 lookup and status are covered statically (they authenticate through session_eligibility of the bound digest), not by a seeded linking flow.",
  ],
};
writeArtifact("labs/session-lifecycle-sql.json", report);
if (failures.length) {
  print("FAILED: " + failures.join(", "));
  process.exitCode = 1;
} else print(`PASS: ${checks.length} P05.T01y PostgreSQL checks.`);
