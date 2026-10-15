import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { localPostgresLab, containerCommand } from "./local-postgres-lab.mjs";
import { localIdentityPool } from "./local-identity-sql.mjs";
import { createAuthenticationChallenges } from "../packages/identity/src/authentication-challenges.ts";
import { identitySql } from "../packages/identity/src/index.ts";
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
const source = JSON.parse(readFileSync("docs/plan/source.json", "utf8"));
if (
  !Number.isSafeInteger(source.sources.plan.sequence) ||
  source.sources.plan.sequence < 79 ||
  source.sources.plan.path !== "docs/plan/build-plan.md" ||
  hash(readFileSync(source.sources.plan.path)) !== source.sources.plan.sha256
)
  throw Error("CHALLENGE_LAB_PLAN_INVALID");
const sourcePaths = [
  "scripts/authentication-challenge-lab.mjs",
  "scripts/local-identity-sql.mjs",
  "scripts/local-postgres-lab.mjs",
  "packages/identity/src/authentication-challenges.ts",
  "packages/identity/src/index.ts",
  "packages/contracts/src/validation.ts",
  "packages/contracts/src/generated/runtime-validators.mjs",
  "packages/contracts/package.json",
  "packages/identity/package.json",
  "infra/identity-role-prerequisites.sql",
  "infra/local-engine.json",
  "migrations/manifest.json",
  "docs/plan/build-plan.md",
  "docs/plan/source.json",
  ".nvmrc",
  "package-lock.json",
];
const sourceDigests = sourcePaths.map((path) => ({ path, sha256: hash(readFileSync(path)) }));
const binding = (letter) => ({
  id: "binding_" + letter,
  environmentId: "environment_" + letter,
  clientId: "client_" + letter.toUpperCase().repeat(26),
  redirectUri: "http://127.0.0.1:3001/auth/callback",
  returnPath: "/",
});
const a = binding("a"),
  b = binding("b");

// Private fixture protocol only: these two persistent psql clients accept named,
// source-owned statements. No shared adapter or product query is extended.
function lockFixtureClient(containerId, kind, challengeId) {
  if (
    !/^[a-f0-9]{64}$/.test(containerId) ||
    !["holder", "observer"].includes(kind) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(challengeId)
  )
    throw Error("CHALLENGE_LAB_HELPER_INPUT");
  const child = spawn(
    "docker",
    [
      "exec",
      "--interactive",
      containerId,
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
    output = "",
    errors = "",
    sequence = 0,
    closed = false,
    closing = null;
  const failPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(Error("CHALLENGE_LAB_HELPER_FAILED"));
    pending = null;
  };
  const finished = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      closed = true;
      failPending();
      resolve({ code, signal });
    }),
  );
  child.once("error", () => {
    closed = true;
    failPending();
  });
  child.stdin.on("error", failPending);
  child.stderr.on("data", (chunk) => {
    errors += chunk;
    if (errors.length > 4096) {
      failPending();
      child.kill("SIGKILL");
    }
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    buffer += chunk;
    if (output.length > 65536) {
      failPending();
      child.kill("SIGKILL");
      return;
    }
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n"),
        line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!pending) continue;
      if (line === pending.marker) {
        const current = pending;
        pending = null;
        clearTimeout(current.timer);
        try {
          if (current.lines.length !== 1) throw Error();
          current.resolve(JSON.parse(current.lines[0]));
        } catch {
          current.reject(Error("CHALLENGE_LAB_HELPER_PROTOCOL"));
        }
      } else if (line) pending.lines.push(line);
    }
  });
  const backend = (value, role) => {
    if (
      !value ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      value.pid > 2147483647 ||
      typeof value.backendStart !== "string" ||
      value.backendStart.length > 64 ||
      !Number.isFinite(Date.parse(value.backendStart)) ||
      value.role !== role ||
      value.database !== "morrow" ||
      Object.keys(value).sort().join(",") !== "backendStart,database,pid,role"
    )
      throw Error("CHALLENGE_LAB_BACKEND_INVALID");
    return value;
  };
  const commands = {
    identity: () =>
      "SET statement_timeout='5s'; SET idle_in_transaction_session_timeout='6s'; SELECT json_build_object('pid',pid,'backendStart',backend_start,'role',usename,'database',datname) FROM pg_stat_activity WHERE pid=pg_backend_pid();",
    catalogue: () => {
      if (kind !== "observer") throw Error("CHALLENGE_LAB_HELPER_COMMAND");
      return "SELECT COALESCE(json_agg(json_build_object('pid',pid,'backendStart',backend_start,'role',usename,'database',datname) ORDER BY pid),'[]'::json) FROM pg_stat_activity WHERE datname='morrow' AND usename='morrow_api';";
    },
    arm: () => {
      if (kind !== "observer") throw Error("CHALLENGE_LAB_HELPER_COMMAND");
      // COMMIT precedes the response marker, so later sessions observe the new
      // deadline. Both timestamps derive from the same database wall-clock read.
      return (
        "BEGIN; WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at), changed AS (UPDATE morrow_identity.authentication_challenges c SET created_at=i.at-interval '298 seconds',expires_at=i.at+interval '2 seconds' FROM instant i WHERE c.id=" +
        literal(challengeId) +
        "::uuid AND c.consumed_at IS NULL RETURNING c.created_at,c.expires_at,i.at) SELECT json_build_object('armed',count(*)=1 AND COALESCE(bool_and(expires_at-at=interval '2 seconds' AND expires_at-created_at=interval '300 seconds'),false)) FROM changed; COMMIT;"
      );
    },
    lock: () => {
      if (kind !== "holder") throw Error("CHALLENGE_LAB_HELPER_COMMAND");
      return (
        "BEGIN; SET LOCAL ROLE morrow_identity_owner; SELECT json_build_object('locked',count(*)=1) FROM (SELECT id FROM morrow_identity.authentication_challenges WHERE id=" +
        literal(challengeId) +
        "::uuid FOR UPDATE) locked;"
      );
    },
    state: (bindings) => {
      if (kind !== "observer") throw Error("CHALLENGE_LAB_HELPER_COMMAND");
      const consumer = backend(bindings.consumer, "morrow_api"),
        holder = backend(bindings.holder, "postgres");
      if (consumer.pid === holder.pid) throw Error("CHALLENGE_LAB_BACKEND_INVALID");
      // Materialize the actual activity/lock facts before taking the clock used
      // for validity. A delayed observation cannot borrow a query-start time.
      return (
        "WITH c AS MATERIALIZED (SELECT expires_at FROM morrow_identity.authentication_challenges WHERE id=" +
        literal(challengeId) +
        "::uuid AND consumed_at IS NULL), consumer AS MATERIALIZED (SELECT * FROM pg_stat_activity WHERE pid=" +
        consumer.pid +
        " AND backend_start=" +
        literal(consumer.backendStart) +
        "::timestamptz AND usename='morrow_api' AND datname='morrow'), holder AS MATERIALIZED (SELECT * FROM pg_stat_activity WHERE pid=" +
        holder.pid +
        " AND backend_start=" +
        literal(holder.backendStart) +
        "::timestamptz AND usename='postgres' AND datname='morrow'), facts AS MATERIALIZED (SELECT (SELECT expires_at FROM c) AS expires_at,EXISTS(SELECT 1 FROM consumer) AS consumer_present,EXISTS(SELECT 1 FROM holder WHERE state='idle in transaction') AS holder_present,EXISTS(SELECT 1 FROM consumer,holder,c WHERE consumer.state='active' AND consumer.wait_event_type='Lock' AND pg_blocking_pids(consumer.pid)=ARRAY[holder.pid] AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=consumer.pid AND NOT l.granted AND l.waitstart IS NOT NULL AND l.waitstart<c.expires_at)) AS blocked), observed AS MATERIALIZED (SELECT facts.*,clock_timestamp() AS observed_at FROM facts) SELECT json_build_object('valid',COALESCE(expires_at>observed_at,false),'expired',COALESCE(expires_at<=observed_at,false),'consumerPresent',consumer_present,'holderPresent',holder_present,'blocked',blocked) FROM observed;"
      );
    },
    commit: () => {
      if (kind !== "holder") throw Error("CHALLENGE_LAB_HELPER_COMMAND");
      return "COMMIT; SELECT json_build_object('committed',true);";
    },
  };
  return {
    async query(name, bindings) {
      if (closed || pending || !Object.hasOwn(commands, name))
        throw Error("CHALLENGE_LAB_HELPER_COMMAND");
      const sql = commands[name](bindings),
        marker = "CHALLENGE_FIXTURE_END_" + ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          failPending();
          child.kill("SIGKILL");
        }, 5000);
        pending = { resolve, reject, timer, marker, lines: [] };
        child.stdin.write(sql + "\n\\echo " + marker + "\n");
      });
    },
    validateBackend: backend,
    clean(proofs) {
      return !errors && !proofs.some((proof) => output.includes(proof));
    },
    close() {
      if (!closing)
        closing = (async () => {
          if (!closed) child.stdin.end("\\q\n");
          const waitClosed = async () => {
            let timer;
            return await Promise.race([
              finished,
              new Promise((resolve) => {
                timer = setTimeout(() => resolve(null), 2000);
              }),
            ]).finally(() => clearTimeout(timer));
          };
          let result = await waitClosed();
          if (!result) {
            child.kill("SIGKILL");
            result = await waitClosed();
          }
          if (!result) throw Error("CHALLENGE_LAB_HELPER_CLEANUP_UNVERIFIED");
          return result.code === 0 && result.signal === null;
        })();
      return closing;
    },
  };
}

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
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(waitingId))
        throw Error("CHALLENGE_LAB_ROW_INVALID");
      const holder = lockFixtureClient(id, "holder", waitingId);
      const observer = lockFixtureClient(id, "observer", waitingId);
      let warmedClient,
        handedOff = false,
        consumption = null;
      try {
        const holderIdentity = holder.validateBackend(await holder.query("identity"), "postgres");
        const observerIdentity = observer.validateBackend(
          await observer.query("identity"),
          "postgres",
        );
        if (holderIdentity.pid === observerIdentity.pid)
          throw Error("CHALLENGE_LAB_BACKEND_INVALID");
        const catalogue = async () => {
          const rows = await observer.query("catalogue");
          if (!Array.isArray(rows) || rows.length > 64)
            throw Error("CHALLENGE_LAB_CATALOGUE_INVALID");
          const unique = new Set();
          for (const row of rows) {
            observer.validateBackend(row, "morrow_api");
            const key = row.pid + ":" + row.backendStart;
            if (unique.has(key)) throw Error("CHALLENGE_LAB_CATALOGUE_INVALID");
            unique.add(key);
          }
          return rows;
        };
        const before = await catalogue();
        warmedClient = await pool.connect();
        const warmed = await warmedClient.query(identitySql.role);
        check(
          "actual_api_consumer_is_warmed_before_fixture_expiry_is_armed",
          warmed.rows.length === 1 &&
            warmed.rows[0].role === "morrow_api" &&
            warmed.rows[0].login === "morrow_api" &&
            ["rolsuper", "rolbypassrls", "rolcreatedb", "rolcreaterole", "owner_member"].every(
              (key) => warmed.rows[0][key] === false,
            ),
        );
        const after = await catalogue();
        const added = after.filter(
          (row) =>
            !before.some((old) => old.pid === row.pid && old.backendStart === row.backendStart),
        );
        check("one_exact_owned_warmed_api_backend_is_identified", added.length === 1);
        const consumerIdentity = added[0];
        if (
          consumerIdentity.pid === holderIdentity.pid ||
          consumerIdentity.pid === observerIdentity.pid
        )
          throw Error("CHALLENGE_LAB_BACKEND_INVALID");
        const sameClientService = createAuthenticationChallenges(
          {
            async connect() {
              if (handedOff) throw Error("CHALLENGE_LAB_CLIENT_ALREADY_USED");
              handedOff = true;
              return warmedClient;
            },
          },
          a,
        );
        const state = async () => {
          const value = await observer.query("state", {
            consumer: consumerIdentity,
            holder: holderIdentity,
          });
          if (
            !value ||
            Object.keys(value).sort().join(",") !==
              "blocked,consumerPresent,expired,holderPresent,valid" ||
            Object.values(value).some((v) => typeof v !== "boolean") ||
            value.valid === value.expired
          )
            throw Error("CHALLENGE_LAB_STATE_INVALID");
          return value;
        };
        check(
          "two_second_deadline_and_original_lifetime_committed_before_holder_lock",
          (await observer.query("arm")).armed === true,
        );
        if ((await holder.query("lock")).locked !== true) throw Error("CHALLENGE_LAB_LOCK_FAILED");
        const initial = await state();
        check(
          "challenge_valid_before_waiting_on_real_row_lock",
          initial.valid && initial.consumerPresent && initial.holderPresent && !initial.blocked,
        );
        // The real service receives this exact connection once. Its transaction,
        // role checks, limits and consume SQL remain unchanged and uninterleaved.
        consumption = deny(sameClientService, waiting);
        const poll = async (phase) => {
          const deadline = Date.now() + 3000;
          for (let attempt = 0; attempt < 256 && Date.now() <= deadline; attempt++) {
            const value = await state();
            if (!value.consumerPresent || !value.holderPresent)
              throw Error("CHALLENGE_LAB_WAITER_LOST");
            if (phase === "before") {
              if (!value.valid) throw Error("CHALLENGE_LAB_WAITER_LATE");
              if (value.blocked) return value;
            } else {
              if (!value.blocked) throw Error("CHALLENGE_LAB_WAITER_LOST");
              if (value.expired) return value;
            }
            // Throttle only: the database facts, never elapsed sleep, prove order.
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
          throw Error("CHALLENGE_LAB_WAITER_TIMEOUT");
        };
        const preExpiry = await poll("before");
        check(
          "actual_consumer_waits_on_exact_owned_lock_while_database_deadline_valid",
          preExpiry.blocked && preExpiry.valid,
        );
        const postExpiry = await poll("after");
        check(
          "owned_lock_is_retained_until_independent_database_expiry_observation",
          postExpiry.blocked && postExpiry.expired,
        );
        if ((await holder.query("commit")).committed !== true)
          throw Error("CHALLENGE_LAB_RELEASE_FAILED");
        check("expiry_during_real_row_lock_wait_denies_after_acquisition", await consumption);
        check("actual_consume_uses_only_the_identified_warmed_connection", handedOff);
        check(
          "owned_lock_holder_finished_without_proof_output",
          (await holder.close()) && holder.clean(proofs),
        );
        check(
          "owned_observer_finished_without_proof_output",
          (await observer.close()) && observer.clean(proofs),
        );
      } finally {
        // Closing the owned holder also rolls back on any failed precondition;
        // failure never rearms, extends, retries or substitutes for exact denial.
        const helperCleanup = await Promise.allSettled([holder.close(), observer.close()]);
        if (warmedClient && !handedOff) warmedClient.release(true);
        if (consumption) await consumption;
        if (helperCleanup.some((result) => result.status !== "fulfilled" || result.value !== true))
          throw Error("CHALLENGE_LAB_HELPER_CLEANUP_UNVERIFIED");
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
if (sourceDigests.some(({ path, sha256 }) => hash(readFileSync(path)) !== sha256))
  throw Error("CHALLENGE_LAB_SOURCE_CHANGED");
mkdirSync("docs/evidence/P05.T01k", { recursive: true });
writeFileSync(
  "docs/evidence/P05.T01k/authentication-challenge-lab.json",
  JSON.stringify(
    {
      task: "P05.T01k",
      primitive: "P05.T01b authentication challenge",
      canonical_sequence: source.sources.plan.sequence,
      execution_sequence: source.sources.plan.sequence,
      fixture_protocol_sequence: 79,
      selected_policy_sequence: 78,
      sources: sourceDigests,
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
