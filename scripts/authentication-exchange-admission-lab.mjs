import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { localAuthenticationExchangePool } from "./local-authentication-exchange-sql.mjs";
import {
  createAuthenticationExchangeAdmission,
  authenticationExchangeAdmissionSql,
} from "../packages/identity/src/authentication-exchange-admission.ts";
const checks = [];
const check = (name, ok) => {
  if (!ok) throw Error("AUTH_EXCHANGE_LAB_FAILED:" + name);
  checks.push({ name, passed: true });
};
const literal = (s) => "'" + String(s).replaceAll("'", "''") + "'";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
// This preserved regression keeps its qualified pre-login-custody schema.
if (!Array.isArray(manifest.migrations) || manifest.migrations.length < 9)
  throw Error("PRESERVED_MIGRATIONS_1_TO_9_REQUIRED");
const selectedMigrations = manifest.migrations.slice(0, 9);
if (selectedMigrations.length !== 9) throw Error("PRESERVED_MIGRATIONS_1_TO_9_REQUIRED");
const migrations = selectedMigrations.map((m, index) => {
  const text = readFileSync("migrations/" + m.file, "utf8");
  if (m.sequence !== index + 1 || hash(text) !== m.sha256) throw Error("MIGRATION_CHECKSUM");
  return { m, text };
});
if (migrations.length < 6 || migrations[5].m.sequence !== 6)
  throw Error("ADMISSION_MIGRATION_REQUIRED");
const secrets = [];
const observed = await localPostgresLab("P05.T01d", async ({ id, sql, image, version }) => {
  sql("CREATE DATABASE morrow; CREATE DATABASE morrow_exchange_rollback;");
  sql(readFileSync("infra/identity-role-prerequisites.sql", "utf8"), "morrow");
  for (const m of migrations) sql("SET ROLE morrow_identity_owner;\n" + m.text, "morrow");
  const admin = (text) => sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
  const exec = (text, role = "morrow_identity_preauth", failure = false, database = "morrow") =>
    containerCommand(
      [
        "exec",
        "--interactive",
        id,
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "VERBOSITY=verbose",
        "-U",
        role,
        "-d",
        database,
      ],
      text,
      failure,
    );
  check(
    "dedicated_role_starts_nologin_safe",
    sql(
      "SELECT NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) FROM pg_roles r WHERE rolname='morrow_identity_preauth';",
      "morrow",
    ) === "t",
  );
  sql(
    "ALTER ROLE morrow_api LOGIN; ALTER ROLE morrow_identity_lifecycle LOGIN; ALTER ROLE morrow_identity_linking LOGIN; ALTER ROLE morrow_identity_preauth LOGIN;",
  );
  const pool = localAuthenticationExchangePool(id);
  let sequence = 0;
  async function fixture(options = {}) {
    const n = ++sequence,
      suffix = String(n).padStart(26, "0");
    const binding = {
      bindingId: "exchange_binding_" + n,
      bindingRevision: 1,
      environmentId: options.alias?.environmentId ?? "environment_" + suffix,
      applicationId: options.alias?.applicationId ?? "app_" + suffix,
      clientId: options.alias?.clientId ?? "client_" + suffix,
      redirectUri: "http://127.0.0.1:3001/auth/callback/" + n,
      returnPath: "/",
    };
    admin(
      `INSERT INTO morrow_identity.authentication_bindings VALUES(${literal(binding.bindingId)},${literal(binding.environmentId)},${literal(binding.clientId)},${literal(binding.redirectUri)},'/',true); INSERT INTO morrow_identity.authentication_exchange_bindings VALUES(${literal(binding.bindingId)},'workos',${literal(binding.applicationId)},1,true);`,
    );
    const service = createAuthenticationExchangeAdmission(pool, JSON.stringify(binding));
    let material;
    if (options.seed) {
      material = {
        challengeId: randomUUID(),
        state: randomBytes(32).toString("base64url"),
        browserProof: randomBytes(32).toString("base64url"),
        verifier: randomBytes(32).toString("base64url"),
      };
      admin(
        `INSERT INTO morrow_identity.authentication_challenges(id,binding_id,environment_id,client_id,redirect_uri,return_path,state_digest,browser_digest,created_at,expires_at) VALUES(${literal(material.challengeId)},${literal(binding.bindingId)},${literal(binding.environmentId)},${literal(binding.clientId)},${literal(binding.redirectUri)},'/',${literal(hash(material.state))},${literal(hash(material.browserProof))},clock_timestamp()-interval '1 second',clock_timestamp()+interval '${options.seconds ?? 298} seconds');`,
      );
      if (!options.legacy)
        admin(
          `INSERT INTO morrow_identity.authentication_pkce_challenges VALUES(${literal(material.challengeId)},'begin_${n}',${literal(binding.bindingId)},1,${literal(binding.applicationId)},${literal(hash(material.verifier))},'S256');`,
        );
    } else material = await service.begin(JSON.stringify({ commandId: "begin_" + n }));
    check("fixture_" + n + "_created", material !== null);
    const input = {
      commandId: "callback_" + n,
      challengeId: material.challengeId,
      state: material.state,
      browserProof: material.browserProof,
      verifier: material.verifier,
      code: options.code ?? "synthetic-code-" + randomBytes(32).toString("hex"),
    };
    secrets.push(input.state, input.browserProof, input.verifier, input.code);
    return { n, binding, service, input, material };
  }
  const params = (f) => [
    f.input.commandId,
    f.input.challengeId,
    f.binding.bindingId,
    String(f.binding.bindingRevision),
    f.binding.environmentId,
    f.binding.applicationId,
    f.binding.clientId,
    f.binding.redirectUri,
    f.binding.returnPath,
    hash(f.input.state),
    hash(f.input.browserProof),
    hash(f.input.verifier),
    hash(f.input.code),
  ];
  const args = (f) => params(f).map(literal).join(",");
  const admit = (f) => f.service.admit(JSON.stringify(f.input));
  const reconcile = (f) => f.service.reconcile(JSON.stringify(f.input));
  const count = (f) =>
    admin(
      `SELECT count(*) FROM morrow_identity.authentication_exchange_admissions WHERE challenge_id=${literal(f.input.challengeId)};`,
    );
  const pending = (f) =>
    admin(
      `SELECT consumed_at IS NULL FROM morrow_identity.authentication_challenges WHERE id=${literal(f.input.challengeId)};`,
    ) === "t";
  const legacy = (f) =>
    `SELECT challenge_id FROM morrow_identity.consume_authentication_challenge(${[f.binding.bindingId, hash(f.input.state), hash(f.input.browserProof), f.binding.environmentId, f.binding.clientId, f.binding.redirectUri, f.binding.returnPath].map(literal).join(",")});`;
  async function holder(lockSql) {
    const child = spawn(
      "docker",
      [
        "exec",
        "--interactive",
        id,
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
    let stdout = "",
      stderr = "";
    const done = new Promise((resolve) => child.on("close", (code) => resolve(code)));
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("ADMISSION_LOCK_BARRIER_FAILED"));
      }, 5000);
      child.on("error", () => {
        clearTimeout(timer);
        reject(Error("ADMISSION_LOCK_BARRIER_FAILED"));
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("ADMISSION_LOCK_READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    });
    child.stdin.write(
      "BEGIN; SET ROLE morrow_identity_owner; " + lockSql + ";\n\\echo ADMISSION_LOCK_READY\n",
    );
    await ready;
    return {
      async release(mutate = "", commit = true) {
        child.stdin.end(mutate + (commit ? "\nCOMMIT;\n" : "\nROLLBACK;\n"));
        if ((await done) !== 0 || stderr || secrets.some((p) => stdout.includes(p)))
          throw Error("ADMISSION_LOCK_RELEASE_FAILED");
      },
      async close() {
        if (child.exitCode === null) child.kill("SIGKILL");
        await done;
      },
    };
  }
  async function waitBlocked(expected = 1, locktype = null) {
    for (let i = 0; i < 60; i++) {
      if (
        Number(
          sql(
            "SELECT count(DISTINCT a.pid) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.usename='morrow_identity_preauth'" +
              (locktype ? " AND l.locktype=" + literal(locktype) : "") +
              ";",
            "morrow",
          ),
        ) >= expected
      )
        return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("ADMISSION_CALL_NOT_BLOCKED");
  }
  async function expire(f) {
    while (
      admin(
        `SELECT expires_at>clock_timestamp() FROM morrow_identity.authentication_challenges WHERE id=${literal(f.input.challengeId)};`,
      ) === "t"
    )
      await new Promise((r) => setTimeout(r, 25));
  }
  try {
    const first = await fixture();
    check(
      "begin_atomic_both_records",
      admin(
        `SELECT count(*) FROM morrow_identity.authentication_challenges c JOIN morrow_identity.authentication_pkce_challenges k ON k.challenge_id=c.id WHERE c.id=${literal(first.input.challengeId)};`,
      ) === "1",
    );
    check(
      "duplicate_begin_no_old_secret_or_new_challenge",
      (await first.service.begin(JSON.stringify({ commandId: "begin_" + first.n }))) === null &&
        admin(
          `SELECT count(*) FROM morrow_identity.authentication_pkce_challenges WHERE begin_command_id='begin_${first.n}';`,
        ) === "1",
    );
    check(
      "s256_of_exact_verifier_ascii",
      first.material.codeChallenge ===
        createHash("sha256").update(first.input.verifier, "utf8").digest("base64url") &&
        first.material.codeChallengeMethod === "S256",
    );
    const missing = await reconcile(first);
    check(
      "absent_readonly_reconciliation_held_without_write",
      missing.outcome === "held" &&
        missing.admissionId === null &&
        count(first) === "0" &&
        pending(first),
    );
    check(
      "legacy_consume_excludes_managed_challenge",
      exec(legacy(first), "morrow_api").stdout.trim() === "" && pending(first),
    );
    const result = await admit(first);
    check(
      "fresh_committed_admission_only_correlation",
      result.outcome === "newly_reserved" &&
        result.admissionId &&
        count(first) === "1" &&
        !pending(first),
    );
    const replay = await admit(first),
      read = await reconcile(first);
    check(
      "exact_replay_and_reconcile_only_held",
      replay.outcome === "held" &&
        read.outcome === "held" &&
        replay.admissionId === result.admissionId &&
        read.admissionId === result.admissionId &&
        count(first) === "1",
    );
    for (const [key, value] of [
      ["commandId", "other_command"],
      ["code", "another-code"],
      ["state", randomBytes(32).toString("base64url")],
      ["browserProof", randomBytes(32).toString("base64url")],
      ["verifier", randomBytes(32).toString("base64url")],
      ["challengeId", randomUUID()],
    ]) {
      const changed = { ...first.input, [key]: value },
        r = await first.service.admit(JSON.stringify(changed)),
        q = await first.service.reconcile(JSON.stringify(changed));
      check(
        "changed_" + key + "_no_new_or_private_correlation",
        r.outcome !== "newly_reserved" &&
          r.admissionId === null &&
          q.outcome === "held" &&
          q.admissionId === null &&
          count(first) === "1",
      );
    }
    for (const field of [
      "applicationId",
      "environmentId",
      "clientId",
      "bindingId",
      "bindingRevision",
      "redirectUri",
      "returnPath",
    ]) {
      const replacement = {
        ...first.binding,
        [field]:
          field === "bindingRevision"
            ? 2
            : field === "redirectUri"
              ? "http://127.0.0.1:3001/other"
              : field === "returnPath"
                ? "/other"
                : field === "bindingId"
                  ? "missing"
                  : first.binding[field].slice(0, -1) + "Z",
      };
      const other = createAuthenticationExchangeAdmission(pool, JSON.stringify(replacement));
      check(
        "wrong_binding_" + field + "_denies",
        (await other.admit(JSON.stringify(first.input))).outcome === "denied" &&
          (await other.reconcile(JSON.stringify(first.input))).admissionId === null,
      );
    }
    const legacyOnly = await fixture({ seed: true, legacy: true });
    check(
      "legacy_created_not_new_admission",
      (await admit(legacyOnly)).outcome === "denied" && count(legacyOnly) === "0",
    );
    check(
      "legacy_still_consumes_own_challenge",
      exec(legacy(legacyOnly), "morrow_api").stdout.trim() === legacyOnly.input.challengeId &&
        !pending(legacyOnly),
    );
    check(
      "legacy_consumed_result_not_admission",
      (await admit(legacyOnly)).outcome === "denied" &&
        (await reconcile(legacyOnly)).admissionId === null,
    );
    const concurrent = await fixture(),
      hold = await holder(
        `SELECT 1 FROM morrow_identity.authentication_challenges WHERE id=${literal(concurrent.input.challengeId)} FOR UPDATE`,
      );
    const racing = [admit(concurrent), admit(concurrent)];
    try {
      await waitBlocked(2);
      await hold.release();
      const rs = await Promise.all(racing);
      check(
        "same_callback_race_one_new_one_held",
        rs.filter((r) => r.outcome === "newly_reserved").length === 1 &&
          rs.filter((r) => r.outcome === "held").length === 1 &&
          rs[0].admissionId === rs[1].admissionId &&
          count(concurrent) === "1",
      );
    } finally {
      await hold.close();
    }
    const singleChallenge = await fixture();
    const challengeHold = await holder(
      `SELECT 1 FROM morrow_identity.authentication_challenges WHERE id=${literal(singleChallenge.input.challengeId)} FOR UPDATE`,
    );
    const otherCallback = {
      ...singleChallenge.input,
      commandId: "different_callback_command",
      code: "different_opaque_code",
    };
    const challengeRace = [
      admit(singleChallenge),
      singleChallenge.service.admit(JSON.stringify(otherCallback)),
    ];
    try {
      await waitBlocked(2);
      await challengeHold.release();
      const rs = await Promise.all(challengeRace);
      check(
        "different_commands_and_codes_one_challenge_winner",
        rs.filter((r) => r.outcome === "newly_reserved").length === 1 &&
          rs.filter((r) => r.outcome === "denied").length === 1 &&
          count(singleChallenge) === "1" &&
          !pending(singleChallenge),
      );
    } finally {
      await challengeHold.close();
    }
    const aliasA = await fixture(),
      aliasB = await fixture({ alias: aliasA.binding, code: aliasA.input.code });
    const codeKey = `hashtext(jsonb_build_array('workos',${literal(aliasA.binding.environmentId)},${literal(aliasA.binding.clientId)},${literal(hash(aliasA.input.code))})::text)`;
    const codeHold = await holder(`SELECT pg_advisory_xact_lock(69002,${codeKey})`),
      competitors = [admit(aliasA), admit(aliasB)];
    try {
      await waitBlocked(2, "advisory");
      await codeHold.release();
      const rs = await Promise.all(competitors);
      check(
        "binding_callback_aliases_one_client_code_reservation",
        rs.filter((r) => r.outcome === "newly_reserved").length === 1 &&
          rs.filter((r) => r.outcome === "conflict").length === 1 &&
          Number(count(aliasA)) + Number(count(aliasB)) === 1 &&
          [pending(aliasA), pending(aliasB)].filter(Boolean).length === 1,
      );
    } finally {
      await codeHold.close();
    }
    const commandA = await fixture(),
      commandB = await fixture();
    commandB.input.commandId = commandA.input.commandId;
    check(
      "command_reserved_for_exact_challenge",
      (await admit(commandA)).outcome === "newly_reserved" &&
        (await admit(commandB)).outcome === "conflict" &&
        pending(commandB) &&
        count(commandB) === "0",
    );
    for (const location of ["binding", "application", "challenge", "command", "code"]) {
      const f = await fixture({ seed: true, seconds: 2 });
      const lock =
        location === "binding"
          ? `SELECT 1 FROM morrow_identity.authentication_bindings WHERE id=${literal(f.binding.bindingId)} FOR UPDATE`
          : location === "application"
            ? `SELECT 1 FROM morrow_identity.authentication_exchange_bindings WHERE binding_id=${literal(f.binding.bindingId)} FOR UPDATE`
            : location === "challenge"
              ? `SELECT 1 FROM morrow_identity.authentication_challenges WHERE id=${literal(f.input.challengeId)} FOR UPDATE`
              : location === "command"
                ? `SELECT pg_advisory_xact_lock(69001,hashtext(${literal(f.input.commandId)}))`
                : `SELECT pg_advisory_xact_lock(69002,hashtext(jsonb_build_array('workos',${literal(f.binding.environmentId)},${literal(f.binding.clientId)},${literal(hash(f.input.code))})::text))`;
      const h = await holder(lock),
        p = admit(f);
      try {
        await waitBlocked();
        await expire(f);
        await h.release();
        const r = await p;
        check(
          "expiry_after_" + location + "_wait",
          r.outcome === "denied" && count(f) === "0" && pending(f),
        );
      } finally {
        await h.close();
      }
    }
    // This owner deliberately skips advisory locks. Its UNIQUE row rolls back,
    // allowing our INSERT to succeed only after expiry: the final check must undo it.
    const outside = await fixture(),
      late = await fixture({
        seed: true,
        seconds: 2,
        alias: outside.binding,
        code: outside.input.code,
      });
    const uniqueHold = await holder(
      `INSERT INTO morrow_identity.authentication_exchange_admissions VALUES(${literal(randomUUID())},'outside_protocol_command',${literal(outside.input.challengeId)},'workos',${literal(outside.binding.environmentId)},${literal(outside.binding.clientId)},${literal(hash(outside.input.code))},clock_timestamp())`,
    );
    const delayed = admit(late);
    try {
      await waitBlocked(1, "transactionid");
      await expire(late);
      await uniqueHold.release("", false);
      const r = await delayed;
      check(
        "expiry_after_unique_owner_rollback_undoes_successful_insert",
        r.outcome === "denied" && count(late) === "0" && pending(late) && count(outside) === "0",
      );
    } finally {
      await uniqueHold.close();
    }
    for (const [name, table, predicate, mutate] of [
      [
        "binding_disabled",
        "authentication_bindings",
        (f) => `id=${literal(f.binding.bindingId)}`,
        "active=false",
      ],
      [
        "callback_changed",
        "authentication_bindings",
        (f) => `id=${literal(f.binding.bindingId)}`,
        "redirect_uri='http://127.0.0.1:3001/changed'",
      ],
      [
        "application_disabled",
        "authentication_exchange_bindings",
        (f) => `binding_id=${literal(f.binding.bindingId)}`,
        "active=false",
      ],
      [
        "application_revision",
        "authentication_exchange_bindings",
        (f) => `binding_id=${literal(f.binding.bindingId)}`,
        "revision=2",
      ],
      [
        "application_identity",
        "authentication_exchange_bindings",
        (f) => `binding_id=${literal(f.binding.bindingId)}`,
        "application_id='app_ZZZZZZZZZZZZZZZZZZZZZZZZZZ'",
      ],
    ]) {
      const f = await fixture(),
        h = await holder(`SELECT 1 FROM morrow_identity.${table} WHERE ${predicate(f)} FOR UPDATE`),
        p = admit(f);
      try {
        await waitBlocked();
        await h.release(`UPDATE morrow_identity.${table} SET ${mutate} WHERE ${predicate(f)};`);
        check(
          name + "_after_wait_denies",
          (await p).outcome === "denied" && count(f) === "0" && pending(f),
        );
      } finally {
        await h.close();
      }
    }
    const before = admin("SELECT count(*) FROM morrow_identity.authentication_challenges;");
    admin(
      "CREATE FUNCTION morrow_identity.fail_pkce_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_PKCE_FAULT'; END $$; CREATE TRIGGER fault_pkce BEFORE INSERT ON morrow_identity.authentication_pkce_challenges FOR EACH ROW EXECUTE FUNCTION morrow_identity.fail_pkce_insert();",
    );
    let failed = false;
    try {
      await first.service.begin(JSON.stringify({ commandId: "fault_begin" }));
    } catch (e) {
      failed = e.code === "AUTH_EXCHANGE_UNAVAILABLE";
    }
    check(
      "begin_sidecar_failure_rolls_back_original_challenge",
      failed && admin("SELECT count(*) FROM morrow_identity.authentication_challenges;") === before,
    );
    admin(
      "DROP TRIGGER fault_pkce ON morrow_identity.authentication_pkce_challenges; DROP FUNCTION morrow_identity.fail_pkce_insert();",
    );
    const audit = await fixture();
    admin(
      "CREATE FUNCTION morrow_identity.fail_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAULT'; END $$; CREATE TRIGGER fault_admission BEFORE INSERT ON morrow_identity.authentication_exchange_admissions FOR EACH ROW EXECUTE FUNCTION morrow_identity.fail_admission();",
    );
    failed = false;
    try {
      await admit(audit);
    } catch (e) {
      failed = e.code === "AUTH_EXCHANGE_UNAVAILABLE";
    }
    check(
      "audit_failure_preserves_unconsumed_challenge",
      failed && count(audit) === "0" && pending(audit),
    );
    admin(
      "DROP TRIGGER fault_admission ON morrow_identity.authentication_exchange_admissions; DROP FUNCTION morrow_identity.fail_admission();",
    );
    const rollback = await fixture();
    exec(
      `BEGIN; SELECT * FROM morrow_identity.admit_authentication_exchange(${args(rollback)}); ROLLBACK;`,
    );
    check(
      "explicit_rollback_no_reservation_or_consumption",
      count(rollback) === "0" && pending(rollback),
    );
    for (const mode of ["commit_ack", "release"]) {
      const f = await fixture();
      let injected = false;
      const broken = createAuthenticationExchangeAdmission(
        {
          async connect() {
            const client = await pool.connect();
            return {
              query: async (text, values) => {
                const r = await client.query(text, values);
                if (
                  mode === "commit_ack" &&
                  text === authenticationExchangeAdmissionSql.commit &&
                  !injected
                ) {
                  injected = true;
                  throw Error("SYNTHETIC_ACK_LOSS");
                }
                return r;
              },
              release: async (discard) => {
                await client.release(discard);
                if (mode === "release" && !injected) {
                  injected = true;
                  throw Error("SYNTHETIC_RELEASE_LOSS");
                }
              },
            };
          },
        },
        JSON.stringify(f.binding),
      );
      let uncertain = false;
      try {
        await broken.admit(JSON.stringify(f.input));
      } catch (e) {
        uncertain = e.code === "AUTH_EXCHANGE_UNCERTAIN" && e.commandId === f.input.commandId;
      }
      const r = await reconcile(f);
      check(
        mode + "_uncertain_then_only_held",
        uncertain &&
          r.outcome === "held" &&
          r.admissionId &&
          (await admit(f)).outcome === "held" &&
          count(f) === "1",
      );
    }
    const lost = await fixture();
    let attempted = false;
    const absent = createAuthenticationExchangeAdmission(
      {
        async connect() {
          const c = await pool.connect();
          return {
            query: async (t, v) => {
              if (t === authenticationExchangeAdmissionSql.commit) {
                attempted = true;
                await c.query(authenticationExchangeAdmissionSql.rollback);
                throw Error("SYNTHETIC_UNKNOWN_ROLLBACK");
              }
              return c.query(t, v);
            },
            release: (d) => c.release(d),
          };
        },
      },
      JSON.stringify(lost.binding),
    );
    let unknown = false;
    try {
      await absent.admit(JSON.stringify(lost.input));
    } catch (e) {
      unknown = e.code === "AUTH_EXCHANGE_UNCERTAIN";
    }
    check(
      "unknown_rolled_back_reconcile_never_creates",
      attempted &&
        unknown &&
        (await reconcile(lost)).outcome === "held" &&
        (await reconcile(lost)).admissionId === null &&
        pending(lost) &&
        count(lost) === "0",
    );
    const uncertainBeginCommand = "uncertain_begin_commit";
    let beginLost = false;
    const beginLoss = createAuthenticationExchangeAdmission(
      {
        async connect() {
          const c = await pool.connect();
          return {
            query: async (t, v) => {
              const r = await c.query(t, v);
              if (t === authenticationExchangeAdmissionSql.commit && !beginLost) {
                beginLost = true;
                throw Error("SYNTHETIC_BEGIN_COMMIT_LOSS");
              }
              return r;
            },
            release: (d) => c.release(d),
          };
        },
      },
      JSON.stringify(first.binding),
    );
    let beginUncertain = false;
    try {
      await beginLoss.begin(JSON.stringify({ commandId: uncertainBeginCommand }));
    } catch (e) {
      beginUncertain =
        e.code === "AUTH_EXCHANGE_UNCERTAIN" && e.commandId === uncertainBeginCommand;
    }
    check(
      "begin_lost_commit_withholds_private_material_and_duplicate",
      beginUncertain &&
        (await first.service.begin(JSON.stringify({ commandId: uncertainBeginCommand }))) ===
          null &&
        admin(
          `SELECT count(*) FROM morrow_identity.authentication_pkce_challenges WHERE begin_command_id=${literal(uncertainBeginCommand)};`,
        ) === "1",
    );
    const inactiveReplay = await fixture();
    await admit(inactiveReplay);
    admin(
      `UPDATE morrow_identity.authentication_exchange_bindings SET active=false WHERE binding_id=${literal(inactiveReplay.binding.bindingId)};`,
    );
    check(
      "current_disabled_config_hides_existing_correlation",
      (await admit(inactiveReplay)).outcome === "denied" &&
        (await reconcile(inactiveReplay)).admissionId === null &&
        count(inactiveReplay) === "1",
    );
    // The actual READ ONLY mode makes accidental reconciliation writes fail.
    const readonly = exec(
      `BEGIN READ ONLY; SELECT outcome||'|'||COALESCE(admission_id,'null') FROM morrow_identity.reconcile_authentication_exchange(${args(first)}); COMMIT;`,
    );
    check(
      "reconcile_runs_in_actual_readonly_transaction",
      readonly.stdout.trim() === "held|" + result.admissionId,
    );
    for (const role of [
      "morrow_api",
      "morrow_identity_lifecycle",
      "morrow_identity_linking",
      "morrow_identity_preauth",
    ]) {
      for (const table of [
        "authentication_exchange_bindings",
        "authentication_pkce_challenges",
        "authentication_exchange_admissions",
      ]) {
        for (const [verb, statement] of [
          ["SELECT", `SELECT * FROM morrow_identity.${table}`],
          ["INSERT", `INSERT INTO morrow_identity.${table} DEFAULT VALUES`],
          [
            "UPDATE",
            `UPDATE morrow_identity.${table} SET ${table === "authentication_exchange_bindings" ? "active=active" : table === "authentication_pkce_challenges" ? "method=method" : "created_at=created_at"}`,
          ],
          ["DELETE", `DELETE FROM morrow_identity.${table}`],
        ]) {
          const r = exec(statement + ";", role, true);
          check(
            role + "_private_" + verb + "_" + table,
            r.status !== 0 && r.stderr.includes("42501"),
          );
        }
      }
      for (const target of [
        "morrow_identity_owner",
        ...(role === "morrow_identity_preauth" ? [] : ["morrow_identity_preauth"]),
      ]) {
        const r = exec(`SET ROLE ${target};`, role, true);
        check(role + "_cannot_assume_" + target, r.status !== 0 && r.stderr.includes("42501"));
      }
      if (role !== "morrow_identity_preauth") {
        const p = [
          randomUUID(),
          "unprivileged_begin",
          first.binding.bindingId,
          String(first.binding.bindingRevision),
          first.binding.environmentId,
          first.binding.applicationId,
          first.binding.clientId,
          first.binding.redirectUri,
          first.binding.returnPath,
          hash(first.input.state),
          hash(first.input.browserProof),
          hash(first.input.verifier),
        ]
          .map(literal)
          .join(",");
        const r = exec(
          `SELECT * FROM morrow_identity.begin_authentication_exchange(${p});`,
          role,
          true,
        );
        check(role + "_cannot_begin", r.status !== 0 && r.stderr.includes("42501"));
      }
      if (role !== "morrow_identity_preauth")
        for (const name of ["admit", "reconcile"]) {
          const r = exec(
            `SELECT * FROM morrow_identity.${name}_authentication_exchange(${args(first)});`,
            role,
            true,
          );
          check(role + "_cannot_" + name, r.status !== 0 && r.stderr.includes("42501"));
        }
    }
    sql("GRANT morrow_identity_preauth TO morrow_api;");
    for (const login of ["morrow_api", "morrow_identity_preauth"]) {
      const r = exec(
        `SET ROLE morrow_identity_preauth; SELECT outcome||'|'||COALESCE(admission_id,'null') FROM morrow_identity.admit_authentication_exchange(${args(first)});`,
        login,
      );
      check(login + "_unsafe_membership_direct_definer_denies", r.stdout.trim() === "denied|null");
    }
    sql("REVOKE morrow_identity_preauth FROM morrow_api;");
    check(
      "owner_login_cannot_substitute_for_executor",
      exec(
        `SET ROLE morrow_identity_owner; SELECT outcome FROM morrow_identity.admit_authentication_exchange(${args(first)});`,
        "postgres",
      ).stdout.trim() === "denied",
    );
    check(
      "public_has_no_new_function_execution",
      sql(
        "SELECT NOT EXISTS(SELECT 1 FROM pg_proc p,aclexplode(p.proacl) a WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname IN ('begin_authentication_exchange','admit_authentication_exchange','reconcile_authentication_exchange') AND a.grantee=0 AND a.privilege_type='EXECUTE');",
        "morrow",
      ) === "t",
    );
    for (const [table, predicate, mutation] of [
      [
        "authentication_pkce_challenges",
        `challenge_id=${literal(first.input.challengeId)}`,
        "verifier_digest=repeat('a',64)",
      ],
      [
        "authentication_exchange_admissions",
        `id=${literal(result.admissionId)}`,
        "code_digest=repeat('a',64)",
      ],
      [
        "authentication_challenges",
        `id=${literal(first.input.challengeId)}`,
        "expires_at=expires_at+interval '1 second'",
      ],
    ])
      for (const [verb, stmt] of [
        ["UPDATE", `UPDATE morrow_identity.${table} SET ${mutation} WHERE ${predicate}`],
        ["DELETE", `DELETE FROM morrow_identity.${table} WHERE ${predicate}`],
      ]) {
        const r = exec("SET ROLE morrow_identity_owner; " + stmt + ";", "postgres", true);
        check(
          table + "_immutable_" + verb,
          r.status !== 0 && r.stderr.includes("PREAUTH_RECORD_IMMUTABLE"),
        );
      }
    check(
      "three_sidecars_force_rls",
      sql(
        "SELECT count(*) FROM pg_class WHERE relnamespace='morrow_identity'::regnamespace AND relname IN ('authentication_exchange_bindings','authentication_pkce_challenges','authentication_exchange_admissions') AND relrowsecurity AND relforcerowsecurity;",
        "morrow",
      ) === "3",
    );
    sql(
      "ALTER ROLE morrow_identity_preauth NOLOGIN; ALTER ROLE morrow_identity_lifecycle NOLOGIN; ALTER ROLE morrow_identity_linking NOLOGIN; GRANT CREATE ON DATABASE morrow_exchange_rollback TO morrow_identity_owner;",
    );
    for (const m of migrations.slice(0, 5))
      sql("SET ROLE morrow_identity_owner;\n" + m.text, "morrow_exchange_rollback");
    const injected = migrations[5].text.replace(/COMMIT;\s*$/, "SELECT 1/0;\nCOMMIT;");
    const failedMigration = exec(
      "SET ROLE morrow_identity_owner;\n" + injected,
      "postgres",
      true,
      "morrow_exchange_rollback",
    );
    check(
      "migration_failure_rolls_back_new_objects_and_legacy_replace",
      failedMigration.status !== 0 &&
        failedMigration.stderr.includes("22012") &&
        sql(
          "SELECT to_regclass('morrow_identity.authentication_pkce_challenges') IS NULL AND position('authentication_pkce_challenges' IN pg_get_functiondef('morrow_identity.consume_authentication_challenge(text,text,text,text,text,text,text)'::regprocedure))=0;",
          "morrow_exchange_rollback",
        ) === "t",
    );
    for (const [name, change, restore] of [
      [
        "unsafe_owner_login",
        "ALTER ROLE morrow_identity_owner LOGIN;",
        "ALTER ROLE morrow_identity_owner NOLOGIN;",
      ],
      [
        "api_owner_membership",
        "GRANT morrow_identity_owner TO morrow_api;",
        "REVOKE morrow_identity_owner FROM morrow_api;",
      ],
      [
        "executor_membership",
        "GRANT morrow_identity_preauth TO morrow_api;",
        "REVOKE morrow_identity_preauth FROM morrow_api;",
      ],
    ]) {
      sql(change);
      const r = exec(
        "SET ROLE morrow_identity_owner;\n" + migrations[5].text,
        "postgres",
        true,
        "morrow_exchange_rollback",
      );
      sql(restore);
      check(
        name + "_migration_rejected",
        r.status !== 0 && r.stderr.includes("PREAUTH_ROLE_PREREQUISITES_INVALID"),
      );
    }
    check(
      "no_raw_code_or_proofs_in_application_output",
      pool.observed.every(
        (o) => !secrets.some((secret) => o.stdout.includes(secret) || o.stderr.includes(secret)),
      ),
    );
    return { image, version };
  } finally {
    await pool.close();
  }
});
const sources = [
  "migrations/0006.authentication-exchange-admission.sql",
  "infra/identity-role-prerequisites.sql",
  "packages/identity/src/authentication-exchange-admission.ts",
  "scripts/local-authentication-exchange-sql.mjs",
  "scripts/authentication-exchange-admission-lab.mjs",
];
mkdirSync("docs/evidence/P05.T01d", { recursive: true });
writeFileSync(
  "docs/evidence/P05.T01d/postgresql-lab.json",
  JSON.stringify(
    {
      task: "P05.T01d",
      observed_at: new Date().toISOString(),
      scope:
        "Actual isolated PostgreSQL with synthetic pre-authentication correlation only; no provider request, exchange permission, identity/session/grant issuance or public route",
      ...observed,
      checks,
      migrations: migrations.map(({ m }) => ({
        sequence: m.sequence,
        file: m.file,
        sha256: m.sha256,
      })),
      limitations: [
        "Only the preserved migrations1–9 are installed; migration10 login custody is not installed or qualified by this regression.",
      ],
      source_digests: Object.fromEntries(sources.map((p) => [p, hash(readFileSync(p))])),
    },
    null,
    2,
  ) + "\n",
);
console.log(`PASS: ${checks.length} actual PostgreSQL authentication admission checks.`);
