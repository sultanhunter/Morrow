import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { localIdentityPool } from "./local-identity-sql.mjs";
import { createAuthenticationChallenges } from "../packages/identity/src/authentication-challenges.ts";
const checks = [];
const check = (name, ok) => {
  if (!ok) throw Error("CHALLENGE_LAB_FAILED:" + name);
  checks.push({ name, passed: true });
};
const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
const migrations = manifest.migrations.map((record) => {
  const text = readFileSync("migrations/" + record.file, "utf8");
  if (hash(text) !== record.sha256) throw Error("MIGRATION_CHECKSUM");
  return { record, text };
});
const binding = (letter) => ({
  id: "binding_" + letter,
  environmentId: "environment_" + letter,
  clientId: "client_" + letter.toUpperCase().repeat(26),
  redirectUri: "http://127.0.0.1:3001/auth/callback",
  returnPath: "/",
});
const a = binding("a"),
  b = binding("b");
const observed = await localPostgresLab(
  "P05.T01b-challenges",
  async ({ id, sql, image, version }) => {
    sql("CREATE DATABASE morrow; CREATE DATABASE morrow_challenge_rollback;");
    sql(readFileSync("infra/identity-role-prerequisites.sql", "utf8"), "morrow");
    for (const m of migrations) sql("SET ROLE morrow_identity_owner;\n" + m.text, "morrow");
    sql("GRANT CREATE ON DATABASE morrow_challenge_rollback TO morrow_identity_owner;");
    for (const m of migrations.slice(0, 2))
      sql("SET ROLE morrow_identity_owner;\n" + m.text, "morrow_challenge_rollback");
    const failed = containerCommand(
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
        "morrow_challenge_rollback",
      ],
      "SET ROLE morrow_identity_owner;\n" +
        migrations[2].text.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;"),
      true,
    );
    check(
      "third_migration_failure_rolls_back_tables_and_functions",
      failed.status !== 0 &&
        sql(
          "SELECT to_regclass('morrow_identity.authentication_challenges') IS NULL AND to_regclass('morrow_identity.authentication_bindings') IS NULL AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND p.proname LIKE '%authentication_challenge');",
          "morrow_challenge_rollback",
        ) === "t",
    );
    check(
      "prior_identity_and_grant_schema_survives_failed_third_migration",
      sql(
        "SELECT to_regclass('morrow_identity.grants') IS NOT NULL AND to_regclass('morrow_identity.sessions') IS NOT NULL;",
        "morrow_challenge_rollback",
      ) === "t",
    );
    sql("ALTER ROLE morrow_api LOGIN;");
    const admin = (text) => sql("SET ROLE morrow_identity_owner;\n" + text, "morrow");
    for (const c of [a, b])
      admin(
        `INSERT INTO morrow_identity.authentication_bindings VALUES (${[c.id, c.environmentId, c.clientId, c.redirectUri, c.returnPath].map(literal).join(",")},true);`,
      );
    const pool = localIdentityPool(id),
      proofs = [];
    try {
      const service = createAuthenticationChallenges(pool, a),
        other = createAuthenticationChallenges(pool, b);
      const begin = async (s = service) => {
        const p = await s.begin();
        proofs.push(p.state, p.browserProof, hash(p.state), hash(p.browserProof));
        return p;
      };
      const deny = async (s, p) =>
        s.consume({ state: p.state, browserProof: p.browserProof }).then(
          () => false,
          (e) => e.code === "CHALLENGE_DENIED",
        );
      const p = await begin();
      check(
        "application_creates_only_hashed_independent_proofs",
        admin(
          "SELECT count(*) FROM morrow_identity.authentication_challenges WHERE length(state_digest)=64 AND length(browser_digest)=64 AND state_digest<>browser_digest;",
        ) === "1",
      );
      check(
        "fixed_exact_binding_consumes_once",
        Boolean(
          (await service.consume({ state: p.state, browserProof: p.browserProof })).challengeId,
        ),
      );
      check("committed_replay_denied", await deny(service, p));
      const concurrent = await begin();
      const results = await Promise.allSettled([
        service.consume({ state: concurrent.state, browserProof: concurrent.browserProof }),
        service.consume({ state: concurrent.state, browserProof: concurrent.browserProof }),
      ]);
      check(
        "two_real_concurrent_connections_have_exactly_one_consumer",
        results.filter((r) => r.status === "fulfilled").length === 1 &&
          results.filter((r) => r.status === "rejected" && r.reason.code === "CHALLENGE_DENIED")
            .length === 1,
      );
      const cross = await begin();
      check("other_application_cannot_consume_state", await deny(other, cross));
      check(
        "wrong_binding_does_not_consume_original",
        Boolean(
          (await service.consume({ state: cross.state, browserProof: cross.browserProof }))
            .challengeId,
        ),
      );
      const browser = await begin(),
        second = await begin();
      check(
        "mixing_two_browser_transactions_denied",
        await deny(service, { state: browser.state, browserProof: second.browserProof }),
      );
      check(
        "original_browser_transaction_remains_valid",
        Boolean(
          (await service.consume({ state: browser.state, browserProof: browser.browserProof }))
            .challengeId,
        ),
      );
      const expired = await begin();
      admin(
        "UPDATE morrow_identity.authentication_challenges SET created_at=statement_timestamp()-interval '10 minutes',expires_at=statement_timestamp()-interval '5 minutes' WHERE consumed_at IS NULL;",
      );
      check("database_time_rejects_expired_challenge", await deny(service, expired));
      const disabled = await begin();
      admin(
        "UPDATE morrow_identity.authentication_bindings SET active=false WHERE id='binding_a';",
      );
      check("disabled_owner_binding_rejects_consumption", await deny(service, disabled));
      check(
        "disabled_owner_binding_rejects_creation",
        await service.begin().then(
          () => false,
          (e) => e.code === "CHALLENGE_DENIED",
        ),
      );
      admin("UPDATE morrow_identity.authentication_bindings SET active=true WHERE id='binding_a';");
      const changed = await begin();
      admin(
        "UPDATE morrow_identity.authentication_bindings SET environment_id='environment_changed' WHERE id='binding_a';",
      );
      check("owner_configuration_change_rejects_old_server_binding", await deny(service, changed));
      const switched = createAuthenticationChallenges(pool, {
        ...a,
        environmentId: "environment_changed",
      });
      check("new_environment_cannot_relabel_old_challenge", await deny(switched, changed));
      admin(
        "UPDATE morrow_identity.authentication_bindings SET environment_id='environment_a' WHERE id='binding_a';",
      );
      const callback = await begin();
      admin(
        "UPDATE morrow_identity.authentication_bindings SET redirect_uri='http://127.0.0.1:3001/other-callback' WHERE id='binding_a';",
      );
      check(
        "callback_change_cannot_rebind_old_challenge",
        await deny(
          createAuthenticationChallenges(pool, {
            ...a,
            redirectUri: "http://127.0.0.1:3001/other-callback",
          }),
          callback,
        ),
      );
      admin(
        "UPDATE morrow_identity.authentication_bindings SET redirect_uri='http://127.0.0.1:3001/auth/callback' WHERE id='binding_a';",
      );
      const waiting = await begin();
      const waitingId = admin(
        "SELECT id::text FROM morrow_identity.authentication_challenges WHERE state_digest=" +
          literal(hash(waiting.state)) +
          ";",
      );
      if (!/^[a-f0-9-]{36}$/.test(waitingId)) throw Error("CHALLENGE_LAB_ROW_INVALID");
      admin(
        "UPDATE morrow_identity.authentication_challenges SET created_at=statement_timestamp()-interval '298 seconds',expires_at=statement_timestamp()+interval '2 seconds' WHERE id=" +
          literal(waitingId) +
          "::uuid;",
      );
      const holder = spawn(
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
      let holderOutput = "",
        holderError = "";
      holder.stderr.on("data", (chunk) => {
        holderError += chunk;
      });
      const holderClosed = new Promise((resolve) => holder.on("close", (code) => resolve(code)));
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          holder.kill("SIGKILL");
          reject(Error("CHALLENGE_LAB_LOCK_TIMEOUT"));
        }, 5000);
        holder.on("error", () => {
          clearTimeout(timer);
          reject(Error("CHALLENGE_LAB_LOCK_FAILED"));
        });
        holder.on("close", () => {
          clearTimeout(timer);
          if (!holderOutput.includes("CHALLENGE_LOCK_READY"))
            reject(Error("CHALLENGE_LAB_LOCK_FAILED"));
        });
        holder.stdout.on("data", (chunk) => {
          holderOutput += chunk;
          if (holderOutput.includes("CHALLENGE_LOCK_READY")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      holder.stdin.end(
        "BEGIN; SET ROLE morrow_identity_owner; SELECT id FROM morrow_identity.authentication_challenges WHERE id=" +
          literal(waitingId) +
          "::uuid FOR UPDATE;\n\\echo CHALLENGE_LOCK_READY\nSELECT pg_sleep(3); COMMIT;\n",
      );
      try {
        await ready;
        check(
          "challenge_valid_before_waiting_on_real_row_lock",
          admin(
            "SELECT expires_at>clock_timestamp() FROM morrow_identity.authentication_challenges WHERE id=" +
              literal(waitingId) +
              "::uuid;",
          ) === "t",
        );
        check(
          "expiry_during_real_row_lock_wait_denies_after_acquisition",
          await deny(service, waiting),
        );
        check(
          "owned_lock_holder_finished_without_proof_output",
          (await holderClosed) === 0 &&
            !holderError &&
            !proofs.some((p) => holderOutput.includes(p)),
        );
      } finally {
        if (holder.exitCode === null) holder.kill("SIGKILL");
        await holderClosed;
      }
      const future = await begin();
      admin(
        "UPDATE morrow_identity.authentication_challenges SET created_at=statement_timestamp()+interval '1 minute',expires_at=statement_timestamp()+interval '6 minutes' WHERE consumed_at IS NULL AND expires_at>statement_timestamp();",
      );
      check("future_dated_challenge_cannot_consume", await deny(service, future));
      const attacker = (text) =>
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
            "morrow_api",
            "-d",
            "morrow",
          ],
          text,
          true,
        );
      for (const [name, text] of [
        [
          "direct_challenge_read_denied",
          "SELECT state_digest FROM morrow_identity.authentication_challenges;",
        ],
        ["direct_binding_read_denied", "SELECT * FROM morrow_identity.authentication_bindings;"],
        ["direct_challenge_write_denied", "DELETE FROM morrow_identity.authentication_challenges;"],
        [
          "direct_binding_activation_denied",
          "UPDATE morrow_identity.authentication_bindings SET active=true;",
        ],
        [
          "direct_session_write_still_denied",
          "UPDATE morrow_identity.sessions SET revoked_at=NULL;",
        ],
        ["direct_grant_write_still_denied", "UPDATE morrow_identity.grants SET payload='{}';"],
        ["owner_role_escalation_denied", "SET ROLE morrow_identity_owner;"],
      ])
        check(name, /42501:/.test(attacker(text).stderr));
      check(
        "both_new_private_tables_force_rls",
        sql(
          "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='morrow_identity' AND c.relname IN('authentication_bindings','authentication_challenges') AND c.relrowsecurity AND c.relforcerowsecurity;",
          "morrow",
        ) === "2",
      );
      check(
        "public_role_has_no_function_execution",
        sql(
          "SELECT NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE n.nspname='morrow_identity' AND p.proname LIKE '%authentication_challenge' AND a.grantee=0 AND a.privilege_type='EXECUTE');",
          "morrow",
        ) === "t",
      );
      check(
        "challenge_cannot_create_principal_or_session",
        admin(
          "SELECT (SELECT count(*) FROM morrow_identity.principals)=0 AND (SELECT count(*) FROM morrow_identity.sessions)=0 AND (SELECT count(*) FROM morrow_identity.grants)=0;",
        ) === "t",
      );
      const logs = containerCommand(["logs", id]);
      check(
        "all_observed_output_excludes_raw_and_hashed_proofs",
        !proofs.some(
          (p) =>
            logs.stdout.includes(p) ||
            logs.stderr.includes(p) ||
            pool.observed.some((o) => o.stdout.includes(p) || o.stderr.includes(p)),
        ),
      );
    } finally {
      await pool.close();
    }
    return { image, version };
  },
);
const source = JSON.parse(readFileSync("docs/plan/source.json", "utf8"));
writeFileSync(
  "docs/evidence/P05.T01/challenge-lab.json",
  JSON.stringify(
    {
      task: "P05.T01b",
      canonical_sequence: source.sources.plan.sequence,
      observed_at: new Date().toISOString(),
      scope:
        "Actual application pre-authentication challenge transaction on isolated PostgreSQL17.11, synthetic owner bindings; not WorkOS authentication/session issuance or production SQL/IAM/TLS.",
      ...observed,
      migrations: migrations.map((m) => m.record),
      checks,
      limitations: [
        "No provider exchange/PKCE or cookie/origin/rate-qualified HTTP entry.",
        "No principal, session, membership or grant authority conferred.",
        "SQL role is synthetic local login; no cloud activation or production pool.",
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "PASS: " +
    checks.length +
    " actual authentication-challenge SQL checks; identity/provider activation pending.",
);
