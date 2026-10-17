import { readFileSync } from "node:fs";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { createSelfLogoutFixtureHarness } from "./fixtures/self-logout-fixture.mjs";
import { localSelfLogoutSqlPool } from "./local-self-logout-sql.mjs";
import { standaloneSqlLiteral as lit } from "./standalone-session-fixtures.mjs";
import {
  createSelfLogoutControl,
  selfLogoutSql as sql,
} from "../packages/identity/src/self-logout-control.ts";
import { writeArtifact } from "./artifacts.mjs";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const checks = [],
  check = (name, passed) => {
    if (!passed) {
      const failedCheck =
        typeof name === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(name)
          ? name
          : "invalid_check_name";
      console.error("SELF_LOGOUT_SQL_FAILED_CHECK " + JSON.stringify({ check: failedCheck }));
      throw Error("SELF_LOGOUT_SQL_LAB_FAILED:" + failedCheck);
    }
    if (checks.some((x) => x.name === name)) throw Error("SELF_LOGOUT_DUPLICATE_CHECK");
    checks.push({ name, passed: true });
    console.log(JSON.stringify({ check: name, passed: true }));
  };
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const sourcePaths = [
  "scripts/self-logout-sql-lab.mjs",
  "scripts/local-self-logout-sql.mjs",
  "scripts/local-login-flow-sql.mjs",
  "scripts/local-browser-session-sql.mjs",
  "scripts/local-postgres-lab.mjs",
  "scripts/fixtures/self-logout-fixture.mjs",
  "scripts/fixtures/standalone-login-fixture.mjs",
  "scripts/standalone-session-fixtures.mjs",
  "packages/identity/src/self-logout-control.ts",
  "packages/identity/src/workos-browser-session-admission.ts",
  "packages/identity/src/workos-authentication-evidence.ts",
  "packages/identity/src/workos-session-token.ts",
  "packages/identity/src/workos-session-status.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "tests/fixtures/workos-authentication-evidence.mjs",
  "infra/identity-role-prerequisites.sql",
  "infra/identity-login-role-prerequisites.sql",
  "infra/identity-logout-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  ...manifest.migrations.map((m) => "migrations/" + m.file),
];
const sourceHashes = Object.fromEntries(sourcePaths.map((p) => [p, hash(readFileSync(p))]));
// Every published migration must be present in order and checksum-verified. The
// login fixture applies exactly the twelve in the manifest, so the count stays exact until
// this lab also applies later migrations; a thirteenth migration must fail here.
if (
  manifest.migrations.length !== 12 ||
  manifest.migrations.some(
    (m, i) => m.sequence !== i + 1 || hash(readFileSync("migrations/" + m.file)) !== m.sha256,
  )
)
  throw Error("SELF_LOGOUT_CURRENT_PLAN_REQUIRED");
const normal = [],
  faults = [],
  holders = [],
  secrets = [];
let container;
const observed = await localPostgresLab("P05.T01q-sql", async (context) => {
  container = context.id;
  const h = createSelfLogoutFixtureHarness(context),
    count = (s) => Number(h.admin(s));
  const control = () => ({ deadlineMs: Date.now() + 5000, signal: new AbortController().signal });
  const owned = (options = {}, fault = false) => {
    const pool = fault
      ? localSelfLogoutSqlPool(context.id, "morrow_identity_logout", Object.values(sql), options)
      : h.pool("morrow_identity_logout", Object.values(sql), options);
    (fault ? faults : normal).push(pool);
    return pool;
  };
  const selected = (admitted, overrides = {}) => {
    const configurationDigest = hash("isolated-self-logout-profile:" + admitted.f.profile),
      commandId = randomUUID();
    const v = {
      schemaVersion: 1,
      commandId,
      configurationDigest,
      environmentId: admitted.f.environment,
      applicationId: admitted.f.application,
      clientId: admitted.f.client,
      profileId: admitted.f.profile,
      sessionDigest: hash(admitted.result.credential.secret),
      ...overrides,
    };
    v.requestDigest = hash(
      JSON.stringify([
        "morrow.browser.self_logout",
        "1",
        v.commandId,
        v.configurationDigest,
        "workos",
        v.environmentId,
        v.applicationId,
        v.clientId,
        v.profileId,
        v.sessionDigest,
      ]),
    );
    return v;
  };
  async function admitted(f = h.fixture()) {
    const started = Date.now(),
      a = await h.admitted(f);
    if (a.result.outcome !== "newly_admitted" || !a.result.credential) {
      let terminal = "not_recorded";
      if (a.result.correlation) {
        const stored = h
          .admin(
            `SELECT CASE WHEN c.outcome='admitted' THEN 'admitted' WHEN c.outcome='denied' AND a.reason IN('identity_ineligible','evidence_expired','revision_conflict','binding_revoked','digest_conflict','identity_conflict') THEN a.reason ELSE 'other' END FROM morrow_identity.browser_session_commands c JOIN morrow_identity.browser_session_audits a ON a.id=c.audit_id WHERE c.command_id=${lit(a.result.correlation.commandId)};`,
          )
          .trim();
        if (
          [
            "admitted",
            "identity_ineligible",
            "evidence_expired",
            "revision_conflict",
            "binding_revoked",
            "digest_conflict",
            "identity_conflict",
            "other",
          ].includes(stored)
        )
          terminal = stored;
      }
      const metric = (value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null;
      console.error(
        "SELF_LOGOUT_OWNING_ADMISSION_DIAGNOSTIC " +
          JSON.stringify({
            stage: "owning_M_admission",
            elapsedMs: Math.min(60000, Math.max(0, Date.now() - started)),
            outcome: a.result.outcome === "held" ? "held" : "other",
            tupleCaptured: Array.isArray(a.tuple),
            terminal,
            evidenceStillFresh: Date.now() < a.e.evidence.expiresAtMs,
            connections: a.pool.metrics.connections,
            closed: a.pool.metrics.closed,
            backendCleanupVerified: a.pool.metrics.backendCleanupVerified,
            released: metric(a.pool.metrics.released),
            discarded: metric(a.pool.metrics.discarded),
            cancelled: metric(a.pool.metrics.cancelled),
            unverifiedHostClosures: metric(a.pool.metrics.unverifiedHostClosures),
          }),
      );
    }
    check(
      "owning_signed_M_admission_" + checks.length,
      a.result.outcome === "newly_admitted" && !!a.result.credential,
    );
    secrets.push(a.result.credential.secret, a.e.token);
    return a;
  }
  const rawValues = (v) => [
    v.commandId,
    v.requestDigest,
    v.configurationDigest,
    v.environmentId,
    v.applicationId,
    v.clientId,
    v.profileId,
    v.sessionDigest,
  ];
  const rawCall = (v) =>
    `SELECT outcome,audit_id FROM morrow_identity.end_self_browser_family(${rawValues(v).map(lit).join(",")})`;
  const call = async (v, options = {}, fault = false) => {
    const p = owned(options, fault),
      service = createSelfLogoutControl({ pool: p, now: Date.now });
    return { result: await service.end(JSON.stringify(v), control()), pool: p };
  };
  const record = (a) =>
    JSON.parse(
      h.admin(
        `SELECT row_to_json(r)::text FROM(SELECT f.id::text,f.revoked_at IS NOT NULL AS revoked,f.record_revision::text,g.revoked_at IS NOT NULL AS generation_revoked,pb.revoked_at IS NOT NULL AS provider_revoked FROM morrow_identity.browser_session_families f JOIN morrow_identity.browser_session_generations g ON g.family_id=f.id JOIN morrow_identity.provider_session_bindings pb ON pb.id=f.provider_binding_id WHERE f.id=${lit(a.result.credential.familyId)})r;`,
      ),
    );
  const audits = (a) =>
    count(
      `SELECT count(*) FROM morrow_identity.browser_session_audits WHERE kind='family' AND target_id=${lit(a.result.credential.familyId)};`,
    );
  const roleSql = (role, text, allowFailure = false) =>
    containerCommand(
      [
        "exec",
        "--interactive",
        context.id,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        role,
        "-d",
        "morrow",
      ],
      "\\set VERBOSITY verbose\n" + text,
      allowFailure,
    );
  function deniedSql(name, role, text, expected = "42501") {
    const r = roleSql(role, text, true);
    check(name, r.status !== 0 && r.stderr.includes(expected));
  }
  async function holder() {
    const app = "morrow_self_logout_holder_" + randomUUID().replaceAll("-", "");
    const child = spawn(
      "docker",
      [
        "exec",
        "--interactive",
        "--env",
        "PGAPPNAME=" + app,
        context.id,
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
    let pending,
      buffer = "",
      closed = false,
      closeSignal = null;
    let finish;
    const finished = new Promise((r) => {
      finish = r;
    });
    child.on("close", (_code, signal) => {
      closed = true;
      closeSignal = signal;
      pending?.reject(Error("SELF_LOGOUT_HOLDER_CLOSED"));
      pending = undefined;
      finish();
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!pending) continue;
        if (line === pending.marker) {
          const p = pending;
          pending = undefined;
          clearTimeout(p.timer);
          p.resolve(p.lines.join("\n").trim());
        } else if (line) pending.lines.push(line);
      }
    });
    child.stderr.resume();
    const run = (text) =>
      new Promise((resolve, reject) => {
        if (pending || closed) return reject(Error("SELF_LOGOUT_HOLDER_UNAVAILABLE"));
        const marker = "Q_HOLDER_" + randomUUID();
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("SELF_LOGOUT_HOLDER_TIMEOUT"));
        }, 5000);
        pending = { marker, resolve, reject, timer, lines: [] };
        child.stdin.write(text + "\n\\echo " + marker + "\n");
      });
    const pid = Number(await run("SELECT pg_backend_pid();"));
    return {
      run,
      pid,
      async close() {
        if (!closed) {
          try {
            await run("ROLLBACK;");
          } finally {
            child.stdin.end();
          }
        }
        await Promise.race([
          finished,
          new Promise((_, reject) =>
            setTimeout(() => reject(Error("SELF_LOGOUT_HOLDER_CLEANUP_UNVERIFIED")), 5000),
          ),
        ]);
        const absence =
          context
            .sql(
              `SELECT count(*) FROM pg_stat_activity WHERE datname='morrow' AND usename='postgres' AND application_name=${lit(app)};`,
              "morrow",
            )
            .trim() === "0";
        holders.push({ hostClosedNormally: closeSignal === null, backendAbsent: absence });
        if (closeSignal !== null || !absence) throw Error("SELF_LOGOUT_HOLDER_CLEANUP_UNVERIFIED");
      },
    };
  }
  try {
    check("twelve_exact_immutable_migrations", manifest.migrations.length === 12);
    check(
      "dedicated_logout_role_safe",
      context
        .sql(
          "SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolinherit FROM pg_roles WHERE rolname='morrow_identity_logout';",
          "morrow",
        )
        .trim() === "t",
    );
    const first = await admitted(),
      v = selected(first),
      before = record(first);
    check(
      "new_family_is_current_unrevoked",
      before.revoked === false && before.record_revision === "1",
    );
    const ended = await call(v);
    check("owned_cookie_family_ended", ended.result.outcome === "ended");
    check(
      "private_control_exposes_only_outcome",
      Object.keys(ended.result).join(",") === "outcome",
    );
    check("one_attributable_family_audit", audits(first) === 1);
    const after = record(first);
    check(
      "only_family_revision_changed",
      after.revoked === true &&
        after.record_revision === "2" &&
        !after.generation_revoked &&
        !after.provider_revoked,
    );
    check(
      "same_command_replay_state_ack_no_new_audit",
      (await call(v)).result.outcome === "ended" && audits(first) === 1,
    );
    const noOpInput = selected(first);
    check(
      "new_command_noop_no_new_audit",
      (await call(noOpInput)).result.outcome === "ended" && audits(first) === 1,
    );
    check(
      "noop_does_not_reserve_command",
      count(
        `SELECT count(*) FROM morrow_identity.browser_session_audits WHERE command_id=${lit(noOpInput.commandId)};`,
      ) === 0,
    );
    const wrongDigest = { ...v, requestDigest: hash("changed") };
    check(
      "changed_digest_denies_before_effect",
      (await call(wrongDigest)).result.outcome === "denied" && audits(first) === 1,
    );
    const second = await admitted(),
      collide = selected(second, { commandId: v.commandId });
    check(
      "command_collision_before_noop_denied",
      (await call(collide)).result.outcome === "denied" && audits(second) === 0,
    );
    const siblingF = { ...second.f, selector: { ...second.f.selector, commandId: randomUUID() } };
    const sibling = await admitted(siblingF);
    check(
      "same_provider_second_family_independent",
      sibling.result.credential.familyId !== second.result.credential.familyId,
    );
    check(
      "first_sibling_retirement_leaves_second_live",
      (await call(selected(second))).result.outcome === "ended" && !record(sibling).revoked,
    );
    check(
      "command_collision_precedes_already_ended_noop",
      (await call(selected(second, { commandId: v.commandId }))).result.outcome === "denied" &&
        audits(second) === 1,
    );
    for (const field of ["environmentId", "applicationId", "clientId", "profileId"]) {
      const value =
        field === "profileId"
          ? "foreign_profile"
          : (field === "environmentId"
              ? "environment_"
              : field === "applicationId"
                ? "app_"
                : "client_") + "Z".repeat(26);
      check(
        "foreign_" + field + "_denied",
        (await call(selected(sibling, { [field]: value }))).result.outcome === "denied" &&
          !record(sibling).revoked,
      );
    }
    const absent = selected(sibling, { sessionDigest: hash("absent") });
    check("absent_secret_denied", (await call(absent)).result.outcome === "denied");
    const legacy = await admitted();
    h.admin(
      `INSERT INTO morrow_identity.sessions VALUES(${lit("legacy_" + legacy.f.n)},${lit(legacy.f.principal)},${lit(legacy.f.organization)},${lit(hash(legacy.result.credential.secret))},'workos',${lit("legacy_" + legacy.f.n)},clock_timestamp()+interval '1 hour',NULL);`,
    );
    check(
      "legacy_new_ambiguity_denies_even_active_new_family",
      (await call(selected(legacy))).result.outcome === "denied" && audits(legacy) === 0,
    );
    for (const kind of [
      "membership",
      "principal",
      "mapping",
      "profile",
      "provider",
      "generation",
      "expired",
    ]) {
      const a = await admitted();
      if (kind === "membership")
        h.admin(
          `UPDATE morrow_identity.memberships SET active=false WHERE id=${lit(a.f.membership)};`,
        );
      if (kind === "principal")
        h.admin(
          `UPDATE morrow_identity.principals SET active=false WHERE id=${lit(a.f.principal)};`,
        );
      if (kind === "mapping")
        h.admin(
          `UPDATE morrow_identity.provider_subject_mappings SET state='revoked',record_revision=record_revision+1 WHERE id=${lit(a.f.mapping)};`,
        );
      if (kind === "profile")
        h.admin(
          `UPDATE morrow_identity.identity_verification_profiles SET state='revoked',record_revision=record_revision+1 WHERE id=${lit(a.f.profile)};`,
        );
      if (kind === "provider")
        h.admin(
          `SELECT * FROM morrow_identity.revoke_provider_binding(${lit(a.result.credential.providerBindingId)},${lit(randomUUID())},${lit(hash("provider"))});`,
        );
      if (kind === "generation")
        h.admin(
          `SELECT * FROM morrow_identity.revoke_browser_generation(${lit(a.result.credential.generationId)},${lit(randomUUID())},${lit(hash("generation"))});`,
        );
      if (kind === "expired")
        context.sql(
          `ALTER TABLE morrow_identity.browser_session_families DISABLE TRIGGER USER;ALTER TABLE morrow_identity.browser_session_generations DISABLE TRIGGER USER;UPDATE morrow_identity.browser_session_families SET created_at=t.at-interval '16 minutes',expires_at=t.at-interval '1 minute' FROM(SELECT clock_timestamp() at)t WHERE id=${lit(a.result.credential.familyId)};UPDATE morrow_identity.browser_session_generations g SET created_at=f.created_at,expires_at=f.expires_at FROM morrow_identity.browser_session_families f WHERE g.family_id=f.id AND f.id=${lit(a.result.credential.familyId)};ALTER TABLE morrow_identity.browser_session_families ENABLE TRIGGER USER;ALTER TABLE morrow_identity.browser_session_generations ENABLE TRIGGER USER;`,
          "morrow",
        );
      check(
        kind + "_inactive_or_expired_still_retires_own_family",
        (await call(selected(a))).result.outcome === "ended" && audits(a) === 1,
      );
    }
    for (const roleName of [
      "morrow_api",
      "morrow_identity_sessions",
      "morrow_identity_linking",
      "morrow_identity_login",
    ]) {
      deniedSql(
        "direct_new_function_denied_" + roleName,
        roleName,
        rawCall(selected(sibling)) + ";",
      );
    }
    for (const name of [
      "provider_session_bindings",
      "browser_session_families",
      "browser_session_generations",
      "browser_session_audits",
      "browser_session_commands",
      "sessions",
    ]) {
      deniedSql(
        "no_direct_table_access_" + name,
        "morrow_identity_logout",
        `SELECT * FROM morrow_identity.${name};`,
      );
    }
    for (const name of [
      "revoke_browser_family",
      "revoke_browser_generation",
      "revoke_provider_binding",
    ]) {
      deniedSql(
        "no_generic_owner_revoker_" + name,
        "morrow_identity_logout",
        `SELECT * FROM morrow_identity.${name}(${lit(sibling.result.credential.familyId)},${lit(randomUUID())},${lit(hash("forbidden"))});`,
      );
    }
    check(
      "set_role_not_exact_logout_session",
      context
        .sql("SET ROLE morrow_identity_logout;" + rawCall(selected(sibling)) + ";", "morrow")
        .trim() === "denied|",
    );
    context.sql("ALTER ROLE morrow_identity_logout REPLICATION;", "morrow");
    check(
      "unsafe_replication_flag_denies",
      roleSql("morrow_identity_logout", rawCall(selected(sibling)) + ";").stdout.trim() ===
        "denied|",
    );
    context.sql("ALTER ROLE morrow_identity_logout NOREPLICATION;", "morrow");
    context.sql(
      "CREATE ROLE logout_edge NOLOGIN;GRANT logout_edge TO morrow_identity_logout;",
      "morrow",
    );
    check(
      "outgoing_membership_denies",
      roleSql("morrow_identity_logout", rawCall(selected(sibling)) + ";").stdout.trim() ===
        "denied|",
    );
    context.sql(
      "REVOKE logout_edge FROM morrow_identity_logout;GRANT morrow_identity_logout TO logout_edge;",
      "morrow",
    );
    check(
      "incoming_assumption_membership_denies",
      roleSql("morrow_identity_logout", rawCall(selected(sibling)) + ";").stdout.trim() ===
        "denied|",
    );
    context.sql("REVOKE morrow_identity_logout FROM logout_edge;DROP ROLE logout_edge;", "morrow");
    const rollback = await admitted(),
      rollbackV = selected(rollback);
    roleSql("morrow_identity_logout", "BEGIN;" + rawCall(rollbackV) + ";ROLLBACK;");
    check(
      "transaction_rollback_preserves_family_and_audit",
      !record(rollback).revoked && audits(rollback) === 0,
    );
    const unknown = await admitted(),
      uv = selected(unknown);
    check(
      "commit_ack_lost_is_unknown",
      (await call(uv, { commitAckLoss: true }, true)).result.outcome === "unknown",
    );
    check(
      "lost_ack_has_one_effect_and_explicit_new_capture_ack",
      record(unknown).revoked &&
        audits(unknown) === 1 &&
        (await call(selected(unknown))).result.outcome === "ended" &&
        audits(unknown) === 1,
    );
    const released = await admitted();
    check(
      "release_ack_lost_is_unknown",
      (await call(selected(released), { releaseAckLoss: true }, true)).result.outcome ===
        "unknown" &&
        record(released).revoked &&
        audits(released) === 1,
    );
    const concurrent = await admitted(),
      cv = selected(concurrent);
    const outcomes = await Promise.all([call(cv), call(cv)]);
    check(
      "concurrent_identical_command_one_effect_two_state_acks",
      outcomes.every((r) => r.result.outcome === "ended") && audits(concurrent) === 1,
    );
    // Supported schema keeps generation==1 immutable. These owner-only corrupt
    // fixtures separately challenge post-wait observed relationships/namespace;
    // they do not qualify rotation or serialize arbitrary owner writes.
    for (const kind of ["legacy", "namespace", "generation"]) {
      const a = await admitted(),
        target = selected(a),
        lock = await holder(),
        pool = owned();
      let client;
      const emptyFamily = randomUUID();
      if (kind === "generation")
        h.admin(
          `INSERT INTO morrow_identity.browser_session_families SELECT ${lit(emptyFamily)},provider_binding_id,profile_record_revision,mapping_revision,binding_revision,current_generation,created_at,expires_at,revoked_at,record_revision FROM morrow_identity.browser_session_families WHERE id=${lit(a.result.credential.familyId)};`,
        );
      try {
        client = await pool.connect({
          deadlineMs: Date.now() + 15000,
          signal: new AbortController().signal,
        });
        const pids = await lock.run(
          "SELECT pid FROM pg_stat_activity WHERE datname='morrow' AND usename='morrow_identity_logout' AND application_name LIKE 'morrow_self_logout_%';",
        );
        check("wait_" + kind + "_one_owned_warm_consumer", /^[1-9][0-9]*$/.test(pids));
        const pid = Number(pids);
        await lock.run(
          "BEGIN;SET ROLE morrow_identity_owner;" +
            (kind === "namespace"
              ? `SELECT 1 FROM morrow_identity.provider_session_bindings WHERE id=${lit(a.result.credential.providerBindingId)} FOR UPDATE;`
              : kind === "generation"
                ? `SELECT 1 FROM morrow_identity.browser_session_generations WHERE id=${lit(a.result.credential.generationId)} FOR UPDATE;`
                : `SELECT 1 FROM morrow_identity.browser_session_families WHERE id=${lit(a.result.credential.familyId)} FOR UPDATE;`) +
            "RESET ROLE;",
        );
        let adopted = false;
        const service = createSelfLogoutControl({
          pool: {
            connect: async () => {
              if (adopted) throw Error("SELF_LOGOUT_DOUBLE_ADOPT");
              adopted = true;
              return client;
            },
          },
          now: Date.now,
        });
        const pending = service.end(JSON.stringify(target), control());
        let witnessed = false;
        const deadline = Date.now() + 700;
        while (Date.now() < deadline) {
          if (
            (await lock.run(
              `SELECT pg_stat_clear_snapshot();SELECT ${lock.pid}=ANY(pg_blocking_pids(${pid})) AND EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${pid} AND wait_event_type='Lock');`,
            )) === "t"
          ) {
            witnessed = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        check("wait_" + kind + "_actual_lock_witness", witnessed);
        if (kind === "legacy")
          await lock.run(
            `SET ROLE morrow_identity_owner;INSERT INTO morrow_identity.sessions VALUES(${lit("wait_legacy_" + a.f.n)},${lit(a.f.principal)},${lit(a.f.organization)},${lit(target.sessionDigest)},'workos',${lit("wait_legacy_sid_" + a.f.n)},clock_timestamp()+interval '1 hour',NULL);RESET ROLE;`,
          );
        if (kind === "namespace")
          await lock.run(
            `ALTER TABLE morrow_identity.provider_session_bindings DISABLE TRIGGER USER;UPDATE morrow_identity.provider_session_bindings SET client_id=${lit("client_" + "Z".repeat(26))} WHERE id=${lit(a.result.credential.providerBindingId)};ALTER TABLE morrow_identity.provider_session_bindings ENABLE TRIGGER USER;`,
          );
        if (kind === "generation")
          await lock.run(
            `ALTER TABLE morrow_identity.browser_session_generations DISABLE TRIGGER USER;UPDATE morrow_identity.browser_session_generations SET family_id=${lit(emptyFamily)} WHERE id=${lit(a.result.credential.generationId)};ALTER TABLE morrow_identity.browser_session_generations ENABLE TRIGGER USER;`,
          );
        await lock.run("COMMIT;");
        const answer = await pending;
        check(
          "wait_" + kind + "_post_lock_semantic_denial",
          answer.outcome === "denied" && audits(a) === 0,
        );
      } finally {
        await Promise.allSettled([client?.release(true), lock.close()]);
      }
    }
    const auditless = await admitted();
    h.admin(
      `SELECT * FROM morrow_identity.revoke_browser_family(${lit(auditless.result.credential.familyId)},${lit(randomUUID())},${lit(hash("owner-state"))});`,
    );
    // A second owner-inserted revoked audit is structurally legal but ambiguous:
    // the narrow wrapper must not guess which immutable state attribution is original.
    h.admin(
      `INSERT INTO morrow_identity.browser_session_audits SELECT gen_random_uuid(),gen_random_uuid(),request_digest,kind,target_id,outcome,reason,recorded_at FROM morrow_identity.browser_session_audits WHERE kind='family' AND target_id=${lit(auditless.result.credential.familyId)};`,
    );
    check(
      "multiple_original_audits_deny_without_new_effect",
      (await call(selected(auditless))).result.outcome === "denied" && audits(auditless) === 2,
    );
    check(
      "all_audit_and_family_tables_force_rls",
      count(
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='morrow_identity' AND c.relname IN('provider_session_bindings','browser_session_families','browser_session_generations','browser_session_audits','browser_session_commands') AND c.relrowsecurity AND c.relforcerowsecurity;",
      ) === 5,
    );
    for (const p of [...normal, ...faults])
      for (const output of p.observed)
        check(
          "redacted_driver_output_" + checks.length,
          !secrets.some(
            (secret) => output.stdout.includes(secret) || output.stderr.includes(secret),
          ),
        );
  } finally {
    const results = await Promise.allSettled([
      h.close(),
      ...normal.map((p) => p.close()),
      ...faults.map((p) => p.close()),
    ]);
    const unexpected = results.some(
      (r, index) => r.status === "rejected" && (index === 0 || index <= normal.length),
    );
    if (
      unexpected ||
      [...normal, ...faults].some(
        (p) =>
          p.metrics.connections !== p.metrics.closed ||
          p.metrics.connections !== p.metrics.backendCleanupVerified,
      )
    ) {
      const bounded = (value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null;
      const summarize = (group, metrics) => {
        const total = (field) => {
          let sum = 0;
          for (const metric of metrics) {
            const value = bounded(metric[field]);
            if (value === null || bounded(sum + value) === null) return null;
            sum += value;
          }
          return sum;
        };
        return {
          group,
          poolCount: bounded(metrics.length),
          connections: total("connections"),
          released: total("released"),
          closed: total("closed"),
          discarded: total("discarded"),
          cancelled: total("cancelled"),
          backendCleanupVerified: total("backendCleanupVerified"),
          unverifiedHostClosures: total("unverifiedHostClosures"),
        };
      };
      console.error(
        "SELF_LOGOUT_SQL_CLEANUP_DIAGNOSTIC " +
          JSON.stringify({
            fixtureClose: results[0].status,
            normalCloseRejected: bounded(
              results.slice(1, normal.length + 1).filter((r) => r.status === "rejected").length,
            ),
            faultCloseRejected: bounded(
              results.slice(normal.length + 1).filter((r) => r.status === "rejected").length,
            ),
            groups: [
              summarize("admission", h.metrics),
              summarize(
                "login_roles",
                h.rolePools.map((p) => p.metrics),
              ),
              summarize(
                "logout_normal",
                normal.map((p) => p.metrics),
              ),
              summarize(
                "logout_fault",
                faults.map((p) => p.metrics),
              ),
            ],
          }),
      );
      throw Error("SELF_LOGOUT_SQL_CLEANUP_UNVERIFIED");
    }
  }
});
check(
  "all_normal_clients_physically_closed",
  normal.every(
    (p) =>
      p.metrics.connections === p.metrics.released &&
      p.metrics.connections === p.metrics.closed &&
      p.metrics.connections === p.metrics.backendCleanupVerified &&
      p.metrics.unverifiedHostClosures === 0,
  ),
);
check(
  "fault_cleanup_separate_and_physically_verified",
  faults.length === 2 &&
    faults.every(
      (p) =>
        p.metrics.connections === p.metrics.closed &&
        p.metrics.connections === p.metrics.backendCleanupVerified,
    ),
);
check(
  "three_holders_host_and_backend_closed",
  holders.length === 3 && holders.every((h) => h.hostClosedNormally && h.backendAbsent),
);
const absent = containerCommand(["inspect", container], undefined, true).status !== 0;
check("owned_container_absent", absent);
const changedSourcePaths = sourcePaths.filter((p) => hash(readFileSync(p)) !== sourceHashes[p]);
if (changedSourcePaths.length)
  console.error(
    "SELF_LOGOUT_SOURCE_FENCE_DIAGNOSTIC " + JSON.stringify({ changedSources: changedSourcePaths }),
  );
check("source_snapshot_unchanged", changedSourcePaths.length === 0);
const report = {
  schemaVersion: 1,
  task: "P05.T01q",
  scope: "actual_local_postgresql_captured_cookie_commitment_family_retirement_only",
  sourceHashes,
  checkCount: checks.length,
  checks,
  providerRequests: 0,
  normalCleanup: normal.map((p) => p.metrics),
  faultCleanup: faults.map((p) => p.metrics),
  holderCleanup: holders,
  containerAbsent: absent,
  engine: observed,
  limitations: [
    "No actual provider, key, hosted migration, HTTP/browser or merchant qualification.",
    "Three post-wait negatives include explicitly privileged owner-corrupted namespace/relationship fixtures; generation rotation remains unsupported.",
    "Fresh legacy ambiguity is observed after waits; no shared secret lock or serialization against arbitrary owner legacy writes is claimed.",
    "Already-ended acknowledgement correlates original immutable family state, not a new command receipt or browser delivery.",
  ],
};
writeArtifact("labs/self-logout-sql.json", JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    packet: "P05.T01q",
    checks: checks.length,
    passed: true,
    providerRequests: 0,
    containerAbsent: absent,
  }),
);
