// The hosted migration runner and the database operations of the staging tools
// (P04.T01i D3, P04.T01j D4, ADR-0019 item 12, ADR-0020 item 5). Everything here talks
// to PostgreSQL through a `connect()` factory whose connections expose
//   query(text, params) -> rows   one statement; parameters only through `params`
//   exec(text)                    one or more statements, no parameters, no rows
//   close()
// The staging CLI passes the Neon serverless connector below; the PostgreSQL 17 lab
// passes a psql connector (scripts/fixtures/staging-psql-connection.mjs) with fault
// hooks. Identifiers that reach SQL text are closed role, database and schema names;
// every value is a parameter, except a role password, which ALTER ROLE accepts only as a
// literal (it takes no bind parameters) and which is checked against its exact grammar
// first.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { StagingError, fixedServerMessage, sqlState } from "./staging-common.mjs";
import { ledgerRecord } from "./migration-chain.mjs";

const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const morrowRole = /^morrow_[a-z][a-z0-9_]{0,47}$/;
const commitSha = /^[0-9a-f]{40}$/;
// pg_advisory_lock key of the runner (P04.T01i D3 step 1).
export const runnerLockKey = "4719201904190001";
export const runnerApplicationName = "morrow-staging-runner";
export const administratorModes = Object.freeze(["createrole", "superuser"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const sqlFailure = (code, error, details = {}) =>
  error instanceof StagingError
    ? error
    : new StagingError(code, {
        ...details,
        sqlstate: sqlState(error?.sqlstate ?? error?.code),
        server: fixedServerMessage(error?.server ?? error?.message),
      });

// ---------------------------------------------------------------------------
// The Neon connector: the pinned @neondatabase/serverless Client over WebSocket (TLS),
// with explicit parameters (no URL parsing by the driver, no pipelined password) and a
// WebSocket that refuses any URL other than the bound endpoint's.
export function neonConnector({
  ownerUrl,
  binding,
  applicationName = runnerApplicationName,
  driver,
  connectDeadlineMs = 25000,
  endDeadlineMs = 2000,
}) {
  if (ownerUrl.host !== binding.hostname) throw new StagingError("STAGING_HOST_MISMATCH");
  const expectedUrl = `wss://${binding.hostname}/v2?address=${binding.hostname}:5432`;
  return Object.freeze({
    async connect() {
      const { Client } = driver ?? (await import("@neondatabase/serverless"));
      const Native = globalThis.WebSocket;
      const sockets = [];
      class Guard extends Native {
        constructor(url, protocols) {
          if (String(url) !== expectedUrl) throw Error("STAGING_SOCKET_REFUSED");
          super(url, protocols);
          sockets.push(this);
        }
      }
      const client = new Client({
        host: binding.hostname,
        port: 5432,
        database: binding.database,
        user: ownerUrl.user,
        password: ownerUrl.password,
        ssl: false,
        // The driver's own timeout stays inside ours, so its socket teardown always runs
        // before the outer deadline fails the connect.
        connectionTimeoutMillis: Math.max(1000, connectDeadlineMs - 5000),
        query_timeout: 0,
        application_name: applicationName,
        options: "",
        client_encoding: "UTF8",
      });
      client.neonConfig.useSecureWebSocket = true;
      client.neonConfig.forceDisablePgSSL = true;
      client.neonConfig.pipelineConnect = false;
      client.neonConfig.coalesceWrites = false;
      client.neonConfig.wsProxy = `${binding.hostname}/v2`;
      client.neonConfig.webSocketConstructor = Guard;
      client.on?.("error", () => {});
      // Hard deadlines: when the endpoint is unreachable, the driver can leave connect()
      // and then end() pending with nothing keeping the event loop alive, so the process
      // exited mid-run with no outcome (2026-10-20, neon-probe exit 13). Connect fails
      // closed at its deadline, and the cleanup end() is bounded too.
      const bounded = (promise, ms) => {
        let timer;
        return Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("deadline")), ms);
          }),
        ]).finally(() => clearTimeout(timer));
      };
      try {
        await bounded(client.connect(), connectDeadlineMs);
      } catch {
        try {
          await bounded(client.end(), endDeadlineMs);
        } catch {
          // Already closed, or the socket never opened.
        }
        // A socket still connecting would otherwise finish its handshake after we gave up.
        for (const socket of sockets) {
          try {
            socket.close();
          } catch {
            // Already closed.
          }
        }
        throw new StagingError("STAGING_DATABASE_UNAVAILABLE");
      }
      const failure = (error) => {
        const e = new Error("SQL");
        e.sqlstate = error?.code;
        e.server = error?.message;
        return e;
      };
      return Object.freeze({
        async query(text, params = []) {
          try {
            return (await client.query(text, params)).rows;
          } catch (error) {
            throw failure(error);
          }
        },
        async exec(text) {
          try {
            await client.query(text);
          } catch (error) {
            throw failure(error);
          }
        },
        async close() {
          try {
            await client.end();
          } catch {
            // Already closed.
          }
        },
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Session identity and refusals (D3 "Refusal"): the database, the server major version,
// the session role, no SET ROLE in effect, and the administrator's shape.
export async function sessionIdentity(connection) {
  const [row] = await connection.query(
    "SELECT session_user::text AS session_role, current_user::text AS current_role, current_database()::text AS database, current_setting('server_version_num')::int AS version, r.rolsuper AS superuser, r.rolcreaterole AS createrole, r.rolcanlogin AS login FROM pg_catalog.pg_roles r WHERE r.rolname = session_user",
  );
  return row;
}
export function checkIdentity(identity, binding, administrator) {
  if (!identity) throw new StagingError("STAGING_SESSION_ROLE");
  if (identity.database !== binding.database) throw new StagingError("STAGING_DATABASE_MISMATCH");
  if (!(identity.version >= 170000 && identity.version < 180000))
    throw new StagingError("STAGING_SERVER_VERSION");
  if (identity.session_role !== administrator.name || identity.current_role !== administrator.name)
    throw new StagingError("STAGING_SESSION_ROLE");
  if (
    administrator.mode === "createrole" &&
    (identity.superuser || !identity.createrole || !identity.login)
  )
    throw new StagingError("STAGING_ADMINISTRATOR_SHAPE");
  if (administrator.mode === "superuser" && !identity.superuser)
    throw new StagingError("STAGING_ADMINISTRATOR_SHAPE");
}
export function checkAdministrator(administrator) {
  if (
    !administrator ||
    !identifier.test(administrator.name) ||
    administrator.name.startsWith("morrow_") ||
    !administratorModes.includes(administrator.mode)
  )
    throw new StagingError("STAGING_ADMINISTRATOR_INVALID");
}

export async function connectChecked(connect, binding, administrator) {
  let connection;
  try {
    connection = await connect();
  } catch (error) {
    throw error instanceof StagingError ? error : new StagingError("STAGING_DATABASE_UNAVAILABLE");
  }
  try {
    checkIdentity(await sessionIdentity(connection), binding, administrator);
    await connection.exec("SET createrole_self_grant = ''");
    return connection;
  } catch (error) {
    await connection.close();
    throw sqlFailure("STAGING_DATABASE_UNAVAILABLE", error);
  }
}

// ---------------------------------------------------------------------------
// The ledger (ADR-0019 item 12): owned by the administrator, no access for PUBLIC or any
// Morrow role, written in the same transaction as each migration.
const ledgerColumns =
  "sequence:integer,file:text,sha256:text,execute_as:name,prerequisites:jsonb,source_commit:text,applied_at:timestamp with time zone,applied_by:name";
const ledgerDdl = `BEGIN;
CREATE SCHEMA IF NOT EXISTS morrow_migrations;
CREATE TABLE IF NOT EXISTS morrow_migrations.applied(
 sequence integer PRIMARY KEY CHECK (sequence > 0),
 file text NOT NULL CHECK (file ~ '^[0-9]{4}\\.[a-z0-9-]+\\.sql$'),
 sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 execute_as name NOT NULL,
 prerequisites jsonb NOT NULL CHECK (jsonb_typeof(prerequisites) = 'array'),
 source_commit text NOT NULL CHECK (source_commit ~ '^[a-f0-9]{40}$'),
 applied_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 applied_by name NOT NULL DEFAULT session_user
);
REVOKE ALL ON SCHEMA morrow_migrations FROM PUBLIC;
REVOKE ALL ON TABLE morrow_migrations.applied FROM PUBLIC;
DO $$ DECLARE r name; BEGIN
 FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'morrow\\_%' LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA morrow_migrations FROM %I', r);
  EXECUTE format('REVOKE ALL ON TABLE morrow_migrations.applied FROM %I', r);
 END LOOP;
END $$;
COMMIT;`;
export async function ensureLedger(connection) {
  try {
    await connection.exec(ledgerDdl);
  } catch (error) {
    throw sqlFailure("MIGRATION_LEDGER_INVALID", error);
  }
  const [row] = await connection.query(
    `SELECT n.nspowner = r.oid AND c.relowner = r.oid AS owned,
 NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a WHERE a.grantee <> n.nspowner) AS schema_private,
 NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a WHERE a.grantee <> c.relowner) AS table_private,
 (SELECT string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = 'applied' AND c.relkind = 'r'
 JOIN pg_catalog.pg_roles r ON r.rolname = session_user WHERE n.nspname = 'morrow_migrations'`,
  );
  if (!row?.owned || !row.schema_private || !row.table_private || row.columns !== ledgerColumns)
    throw new StagingError("MIGRATION_LEDGER_INVALID");
}
export async function readLedger(connection) {
  return connection.query(
    "SELECT sequence, file, sha256, execute_as::text AS execute_as, prerequisites::text AS prerequisites, source_commit FROM morrow_migrations.applied ORDER BY sequence",
  );
}

// Pure: the first difference between the ledger and the chain, or null. A ledger is a
// prefix of the chain, record for record; a superseded digest is drift (P04.T01j AC14).
export function ledgerDrift(rows, chain) {
  if (rows.length > chain.length) return { reason: "ahead", sequence: rows[chain.length].sequence };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const expected = ledgerRecord(chain[i]);
    let prerequisites;
    try {
      prerequisites = JSON.parse(row.prerequisites);
    } catch {
      prerequisites = null;
    }
    const samePrerequisites =
      Array.isArray(prerequisites) &&
      prerequisites.length === expected.prerequisites.length &&
      prerequisites.every(
        (p, j) =>
          p &&
          Object.keys(p).sort().join() === "file,sha256" &&
          p.file === expected.prerequisites[j].file &&
          p.sha256 === expected.prerequisites[j].sha256,
      );
    if (Number(row.sequence) !== expected.sequence || row.file !== expected.file)
      return { reason: "record", sequence: Number(row.sequence) };
    if (row.sha256 !== expected.sha256) return { reason: "digest", sequence: expected.sequence };
    if (row.execute_as !== expected.executeAs || !samePrerequisites)
      return { reason: "record", sequence: expected.sequence };
  }
  return null;
}

// The D4 catalog check (P04.T01j D4 and its notes, S5): every SET row whose role or member
// is a Morrow role, other than the two reviewed work memberships. Zero before the run and
// after every entry; a REVOKE's exit status is never trusted. The same reading as
// `morrowSetRowsSql` in scripts/fixtures/createrole-administrator.mjs, which the lab checks.
export const morrowSetRowsQuery =
  "SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid = m.roleid JOIN pg_catalog.pg_roles u ON u.oid = m.member WHERE m.set_option AND (g.rolname LIKE 'morrow\\_%' OR u.rolname LIKE 'morrow\\_%') AND (g.rolname, u.rolname) NOT IN (('morrow_work_api', 'morrow_api_worker'), ('morrow_work_command', 'morrow_work_owner'))";
export async function runnerSetRows(connection) {
  const [row] = await connection.query(morrowSetRowsQuery);
  return row.n;
}
async function assertNoSetRows(connection) {
  if ((await runnerSetRows(connection)) !== 0)
    throw new StagingError("MIGRATION_SET_ROW_PERSISTED");
}
const roleList = (roles) => {
  if (!roles.length || !roles.every((r) => morrowRole.test(r)))
    throw new StagingError("PREREQUISITE_ROLES_INVALID");
  return roles.map((r) => `'${r}'`).join(",");
};
async function presentRoles(connection, roles) {
  const [row] = await connection.query(
    `SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname IN (${roleList(roles)})`,
  );
  return row.n;
}

// After a lost acknowledgement the old backend may still be finishing its COMMIT. Wait
// until it has ended (terminating it after a bound), so the read below sees committed
// state: a row means the migration committed with it, no row means it rolled back.
async function awaitBackendEnd(connection, pid, waitMs) {
  if (!Number.isSafeInteger(pid)) return false;
  const gone = async () =>
    (
      await connection.query(
        "SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE pid = $1::int",
        [String(pid)],
      )
    )[0].n === 0;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await gone()) return true;
    await sleep(100);
  }
  await connection.query("SELECT pg_catalog.pg_terminate_backend($1::int)", [String(pid)]);
  const after = Date.now() + waitMs;
  while (Date.now() < after) {
    if (await gone()) return true;
    await sleep(100);
  }
  return false;
}
async function reconnect(connect, binding, administrator) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await connectChecked(connect, binding, administrator);
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

async function runPrerequisite(state, prerequisite) {
  const { lock, connect, binding, administrator, reconcileWaitMs } = state;
  const present = await presentRoles(lock, prerequisite.roles);
  if (present === prerequisite.roles.length) return "present";
  if (present !== 0) throw new StagingError("PREREQUISITE_PARTIAL", { file: prerequisite.file });
  const connection = await connectChecked(connect, binding, administrator);
  let pid = null;
  let commitSent = false;
  try {
    [{ pid }] = await connection.query("SELECT pg_catalog.pg_backend_pid()::int AS pid");
    await connection.exec("BEGIN");
    await connection.exec(prerequisite.text);
    commitSent = true;
    await connection.exec("COMMIT");
  } catch (error) {
    if (!commitSent) throw sqlFailure("PREREQUISITE_FAILED", error, { file: prerequisite.file });
    // Unknown outcome: settled from the catalog once the old backend has ended.
    const check = await reconnect(connect, binding, administrator);
    if (!check) throw new StagingError("PREREQUISITE_OUTCOME_UNKNOWN", { file: prerequisite.file });
    try {
      if (!(await awaitBackendEnd(check, pid, reconcileWaitMs)))
        throw new StagingError("PREREQUISITE_OUTCOME_UNKNOWN", { file: prerequisite.file });
      const after = await presentRoles(check, prerequisite.roles);
      if (after === 0)
        throw new StagingError("PREREQUISITE_NOT_COMMITTED", { file: prerequisite.file });
      if (after !== prerequisite.roles.length)
        throw new StagingError("PREREQUISITE_PARTIAL", { file: prerequisite.file });
      return "reconciled";
    } finally {
      await check.close();
    }
  } finally {
    await connection.close();
  }
  if ((await presentRoles(lock, prerequisite.roles)) !== prerequisite.roles.length)
    throw new StagingError("PREREQUISITE_PARTIAL", { file: prerequisite.file });
  return "applied";
}

// One manifest entry: one transaction on one fresh connection (P04.T01j D4). The ledger
// table lock and the expected-count check serialise entries even if the session lock
// were lost; the grant and the revoke of the SET row share the migration's fate.
async function applyEntry(state, entry, index, previous) {
  const { connect, binding, administrator, sourceCommit, reconcileWaitMs } = state;
  const connection = await connectChecked(connect, binding, administrator);
  let pid = null;
  let commitSent = false;
  const admin = administrator.name;
  try {
    [{ pid }] = await connection.query("SELECT pg_catalog.pg_backend_pid()::int AS pid");
    await connection.exec("SET statement_timeout = '300s'");
    await connection.exec("BEGIN");
    await connection.exec("LOCK TABLE morrow_migrations.applied IN EXCLUSIVE MODE");
    const [ledger] = await connection.query(
      "SELECT count(*)::int AS n, coalesce(max(sequence), 0)::int AS last FROM morrow_migrations.applied",
    );
    if (ledger.n !== index || ledger.last !== previous)
      throw new StagingError("MIGRATION_LEDGER_DRIFT", {
        reason: "concurrent",
        sequence: entry.sequence,
      });
    if (administrator.mode === "createrole")
      await connection.exec(
        `GRANT ${entry.executeAs} TO ${admin} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
      );
    await connection.exec(`SET LOCAL ROLE ${entry.executeAs}`);
    await connection.exec(entry.body);
    // The body must end as it began: as its executeAs, in the administrator's session.
    // A body that changed the role (dynamic SQL the static guard cannot see) is refused
    // here, before COMMIT, so the connection closes and the transaction rolls back.
    const [who] = await connection.query(
      "SELECT current_user::text AS current_role, session_user::text AS session_role",
    );
    if (who?.current_role !== entry.executeAs || who?.session_role !== admin)
      throw new StagingError("MIGRATION_ROLE_CHANGED", { sequence: entry.sequence });
    await connection.exec("RESET ROLE");
    if (administrator.mode === "createrole")
      await connection.exec(`REVOKE ${entry.executeAs} FROM ${admin} GRANTED BY ${admin}`);
    const record = ledgerRecord(entry);
    await connection.query(
      "INSERT INTO morrow_migrations.applied(sequence, file, sha256, execute_as, prerequisites, source_commit) VALUES ($1::int, $2::text, $3::text, $4::name, $5::jsonb, $6::text)",
      [
        String(record.sequence),
        record.file,
        record.sha256,
        record.executeAs,
        JSON.stringify(record.prerequisites),
        sourceCommit,
      ],
    );
    commitSent = true;
    await connection.exec("COMMIT");
    return "applied";
  } catch (error) {
    if (!commitSent) throw sqlFailure("MIGRATION_FAILED", error, { sequence: entry.sequence });
    const check = await reconnect(connect, binding, administrator);
    if (!check) throw new StagingError("MIGRATION_OUTCOME_UNKNOWN", { sequence: entry.sequence });
    try {
      if (!(await awaitBackendEnd(check, pid, reconcileWaitMs)))
        throw new StagingError("MIGRATION_OUTCOME_UNKNOWN", { sequence: entry.sequence });
      const rows = await check.query(
        "SELECT sha256 FROM morrow_migrations.applied WHERE sequence = $1::int",
        [String(entry.sequence)],
      );
      if (rows.length === 0)
        throw new StagingError("MIGRATION_NOT_COMMITTED", { sequence: entry.sequence });
      if (rows[0].sha256 !== entry.sha256)
        throw new StagingError("MIGRATION_LEDGER_DRIFT", {
          reason: "digest",
          sequence: entry.sequence,
        });
      return "reconciled";
    } finally {
      await check.close();
    }
  } finally {
    await connection.close();
  }
}

// D3 algorithm: lock, ensure the ledger, refuse drift, then for each pending entry run
// its pinned prerequisites (all-or-none) and the entry, asserting after every entry that
// no runner SET row persists. A rerun with nothing pending is a no-op.
export async function runMigrations({
  connect,
  chain,
  binding,
  administrator,
  sourceCommit,
  lockTimeoutMs = 120000,
  reconcileWaitMs = 30000,
}) {
  checkAdministrator(administrator);
  if (!commitSha.test(sourceCommit ?? "")) throw new StagingError("STAGING_SOURCE_COMMIT_INVALID");
  if (!chain.every((entry) => morrowRole.test(entry.executeAs)))
    throw new StagingError("MIGRATION_CHAIN_INVALID");
  const lock = await connectChecked(connect, binding, administrator);
  const result = { applied: [], reconciled: [], prerequisites: [] };
  let locked = false;
  try {
    await lock.exec(`SET lock_timeout = '${Math.max(1, Math.ceil(lockTimeoutMs / 1000))}s'`);
    try {
      await lock.query(`SELECT pg_catalog.pg_advisory_lock(${runnerLockKey})::text AS locked`);
      locked = true;
    } catch (error) {
      throw sqlFailure("MIGRATION_LOCK_TIMEOUT", error);
    }
    await lock.exec("SET lock_timeout = 0");
    await ensureLedger(lock);
    const ledger = await readLedger(lock);
    const drift = ledgerDrift(ledger, chain);
    if (drift) throw new StagingError("MIGRATION_LEDGER_DRIFT", drift);
    if (ledger.length === 0) {
      const [row] = await lock.query(
        "SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname LIKE 'morrow\\_%' AND nspname <> 'morrow_migrations'",
      );
      if (row.n !== 0)
        throw new StagingError("MIGRATION_LEDGER_DRIFT", { reason: "untracked_schema" });
    }
    await assertNoSetRows(lock);
    const state = { lock, connect, binding, administrator, sourceCommit, reconcileWaitMs };
    let previous = ledger.length ? chain[ledger.length - 1].sequence : 0;
    for (let index = ledger.length; index < chain.length; index++) {
      const entry = chain[index];
      for (const prerequisite of entry.prerequisites) {
        const outcome = await runPrerequisite(state, prerequisite);
        result.prerequisites.push({ file: prerequisite.file, outcome });
      }
      const outcome = await applyEntry(state, entry, index, previous);
      (outcome === "reconciled" ? result.reconciled : result.applied).push(entry.sequence);
      await assertNoSetRows(lock);
      previous = entry.sequence;
    }
    const final = await readLedger(lock);
    if (final.length !== chain.length || ledgerDrift(final, chain))
      throw new StagingError("MIGRATION_LEDGER_DRIFT", { reason: "final" });
    result.ledger = final.length;
    return result;
  } catch (error) {
    throw sqlFailure("MIGRATION_FAILED", error);
  } finally {
    if (locked)
      try {
        await lock.query(`SELECT pg_catalog.pg_advisory_unlock(${runnerLockKey}) AS released`);
      } catch {
        // The session's end releases the lock.
      }
    await lock.close();
  }
}

// ---------------------------------------------------------------------------
// Role controls (ADR-0007 item 5; D3 "Compensating controls"; M-N3).
export const roleControls = Object.freeze({
  connectionLimit: 10,
  settings: Object.freeze(["idle_in_transaction_session_timeout=10s", "statement_timeout=5s"]),
});
// 32 random bytes, base64url: 43 characters of [A-Za-z0-9_-]. A SQL string literal holds
// them as they are (no quote, backslash or non-ASCII byte), and SASLprep is the identity.
export const generatePassword = () => randomBytes(32).toString("base64url");
export const passwordGrammar = /^[A-Za-z0-9_-]{43}$/;
// The literal that reaches ALTER ROLE: only a password of the generated shape, checked
// immediately before interpolation (ALTER ROLE has no bind parameters).
export function passwordLiteral(password) {
  if (typeof password !== "string" || !passwordGrammar.test(password))
    throw new StagingError("STAGING_PASSWORD_INVALID");
  return `'${password}'`;
}
// PostgreSQL's SCRAM-SHA-256 stored form of a password. Provisioning no longer sends it
// (Neon refuses a pre-hashed verifier, M-N3 as amended 2026-10-20); neon-probe sends one
// to record that refusal, and the lab recomputes stored verifiers with it.
export function scramVerifier(password, { salt = randomBytes(16), iterations = 4096 } = {}) {
  if (typeof password !== "string" || !/^[\x21-\x7e]{16,1024}$/.test(password))
    throw new StagingError("STAGING_PASSWORD_INVALID");
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  salted.fill(0);
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

// The provisioning statements: LOGIN with the role's new password, the connection limit,
// both timeouts, and REVOKE TEMP from PUBLIC. `passwords` maps role -> plaintext for the
// roles whose password changes; every listed role gets the controls. Neon takes only a
// plaintext (its control plane refuses a verifier), and pg_authid then holds the
// plaintext's SCRAM-SHA-256 verifier; what the control plane keeps is not measured (M-N3
// as amended 2026-10-20). So each plaintext is sent once, in its own statement, over the
// TLS connection. The returned text is for `connection.exec` only: never logged, printed,
// put in an error or written anywhere.
export function provisioningSql({ roles, passwords, database }) {
  if (!identifier.test(database)) throw new StagingError("STAGING_DATABASE_MISMATCH");
  const statements = ["BEGIN"];
  for (const role of roles) {
    if (!morrowRole.test(role)) throw new StagingError("STAGING_ROLE_INVALID");
    const password = passwords.get(role);
    statements.push(
      `ALTER ROLE ${role} WITH LOGIN CONNECTION LIMIT ${roleControls.connectionLimit}` +
        (password === undefined ? "" : ` PASSWORD ${passwordLiteral(password)}`),
      `ALTER ROLE ${role} SET statement_timeout = '5s'`,
      `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '10s'`,
    );
  }
  statements.push(`REVOKE TEMP ON DATABASE ${database} FROM PUBLIC`, "COMMIT");
  return statements;
}

export async function roleControlFacts(connection, roles) {
  const rows = await connection.query(
    `SELECT r.rolname::text AS role, r.rolcanlogin AS login, r.rolconnlimit::int AS connection_limit,
 coalesce((SELECT array_to_string(s.setconfig, ',') FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = r.oid AND s.setdatabase = 0), '') AS settings
 FROM pg_catalog.pg_roles r WHERE r.rolname IN (${roleList(roles)}) ORDER BY r.rolname`,
  );
  const [temp] = await connection.query(
    "SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d, pg_catalog.aclexplode(coalesce(d.datacl, pg_catalog.acldefault('d', d.datdba))) a WHERE d.datname = current_database() AND a.grantee = 0 AND a.privilege_type = 'TEMPORARY') AS revoked",
  );
  const facts = roles.map((role) => {
    const row = rows.find((r) => r.role === role);
    const settings = row ? row.settings.split(",").filter(Boolean).sort() : [];
    return {
      role,
      exists: !!row,
      login: row?.login === true,
      connectionLimit: row ? row.connection_limit : null,
      timeouts: settings.join(",") === roleControls.settings.join(","),
    };
  });
  return {
    roles: facts,
    publicTempRevoked: temp.revoked === true,
    ok:
      temp.revoked === true &&
      facts.every(
        (f) =>
          f.exists && f.login && f.connectionLimit === roleControls.connectionLimit && f.timeouts,
      ),
  };
}

// Statement statistics and statement logging (M-N3 as amended 2026-10-20). The plaintext
// is a literal in the ALTER ROLE text. pg_stat_statements keeps a utility statement's text
// with its literals, and once its module is loaded (shared_preload_libraries) it records
// statements in every database, whether or not the extension exists there (measured on a
// Neon probe branch, docs/evidence/live/2026-10-20-neon-password-path-experiments.md, and
// checked by lab:staging-runner on PostgreSQL 17.11). The server log would keep the text
// under log_statement, a duration threshold, a log_min_error_statement level that a
// failing statement reaches, or debug_print_parse or debug_print_rewritten, which print
// the statement's tree with the PASSWORD string (USERSET: a database or role owner can
// turn them on with ALTER DATABASE/ROLE ... SET; checked on PostgreSQL 17.11). So one row
// reads the extension in the session's database, the module's settings (which exist only
// while it is loaded), password_encryption and the logging settings.
export const statementStatsQuery =
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_stat_statements') AS extension, current_setting('pg_stat_statements.track', true) AS track, current_setting('pg_stat_statements.track_utility', true) AS track_utility, current_setting('password_encryption') AS password_encryption, current_setting('log_statement') AS log_statement, current_setting('log_min_duration_statement') AS log_min_duration_statement, current_setting('log_min_duration_sample') AS log_min_duration_sample, current_setting('log_statement_sample_rate') AS log_statement_sample_rate, current_setting('log_min_error_statement') AS log_min_error_statement, current_setting('log_duration') AS log_duration, current_setting('debug_print_parse') AS debug_print_parse, current_setting('debug_print_rewritten') AS debug_print_rewritten, current_setting('debug_print_plan') AS debug_print_plan";
const oneOf = (value, values) => (values.includes(value) ? value : undefined);
const messageLevels = Object.freeze([
  "debug5",
  "debug4",
  "debug3",
  "debug2",
  "debug1",
  "info",
  "notice",
  "warning",
  "error",
  "log",
  "fatal",
  "panic",
]);
// A duration threshold: -1 is "disabled"; any other well-formed value is "enabled".
const threshold = (value) =>
  value === "-1"
    ? "disabled"
    : typeof value === "string" && /^[0-9]{1,10}(us|ms|s|min|h|d)?$/.test(value)
      ? "enabled"
      : null;
// Pure: the closed facts of one row of statementStatsQuery. `recording` is true unless the
// row shows that no statement text can be kept: no extension in the session's database,
// and the module either not loaded or tracking no utility statement. Anything unreadable
// or unexpected counts as recording (`checked` false), or as a logging value of null.
export function statementStatsFacts(row) {
  const extension = typeof row?.extension === "boolean" ? row.extension : undefined;
  const track = row?.track === null ? null : oneOf(row?.track, ["none", "top", "all"]);
  const trackUtility =
    row?.track_utility === null ? null : oneOf(row?.track_utility, ["on", "off"]);
  const checked = extension !== undefined && track !== undefined && trackUtility !== undefined;
  const loaded = checked ? track !== null || trackUtility !== null : null;
  const recording =
    !checked || extension || (loaded && !(track === "none" || trackUtility === "off"));
  const rate = row?.log_statement_sample_rate;
  return Object.freeze({
    checked,
    extension: extension ?? null,
    module: loaded,
    track: track ?? null,
    trackUtility: trackUtility ?? null,
    recording,
    passwordEncryption: oneOf(row?.password_encryption, ["scram-sha-256", "md5"]) ?? null,
    logStatement: oneOf(row?.log_statement, ["none", "ddl", "mod", "all"]) ?? null,
    logMinDurationStatement: threshold(row?.log_min_duration_statement),
    logMinDurationSample: threshold(row?.log_min_duration_sample),
    logStatementSampleRate:
      typeof rate === "string" && /^[01](\.[0-9]{1,6})?$/.test(rate) && Number(rate) <= 1
        ? rate
        : null,
    logMinErrorStatement: oneOf(row?.log_min_error_statement, messageLevels) ?? null,
    logDuration: oneOf(row?.log_duration, ["on", "off"]) ?? null,
    debugPrintParse: oneOf(row?.debug_print_parse, ["on", "off"]) ?? null,
    debugPrintRewritten: oneOf(row?.debug_print_rewritten, ["on", "off"]) ?? null,
    debugPrintPlan: oneOf(row?.debug_print_plan, ["on", "off"]) ?? null,
  });
}
export async function readStatementStats(connection) {
  try {
    const [row] = await connection.query(statementStatsQuery);
    return statementStatsFacts(row);
  } catch {
    return statementStatsFacts(null);
  }
}
// Pure: the first logging setting under which the server could write a statement's text
// to its log, or null. log_min_error_statement must be panic: at fatal, a statement cut
// short by a terminating connection is logged with its text. The three debug_print
// settings must be off: parse and rewritten print an ALTER ROLE's PASSWORD string (both
// checked on PostgreSQL 17.11); plan printed nothing for it there, and is refused too
// because it prints statement trees. log_duration alone never logs the text, so it is
// only recorded. An unreadable value refuses.
const debugPrintSettings = Object.freeze([
  ["debug_print_parse", "debugPrintParse"],
  ["debug_print_rewritten", "debugPrintRewritten"],
  ["debug_print_plan", "debugPrintPlan"],
]);
export function statementLoggingRefusal(facts) {
  if (facts.logStatement !== "none") return "log_statement";
  if (facts.logMinDurationStatement !== "disabled") return "log_min_duration_statement";
  const sampled =
    facts.logMinDurationSample !== "disabled" &&
    !(
      facts.logMinDurationSample === "enabled" &&
      facts.logStatementSampleRate !== null &&
      Number(facts.logStatementSampleRate) === 0
    );
  if (sampled) return "log_min_duration_sample";
  if (facts.logMinErrorStatement !== "panic") return "log_min_error_statement";
  for (const [setting, fact] of debugPrintSettings) if (facts[fact] !== "off") return setting;
  return null;
}
// Refuses before any password statement, with closed details only: statistics that
// cannot be read, the extension in the session's own database, storage other than
// SCRAM-SHA-256, or a logging setting that could write the text. Returns true when the
// loaded module records the statement, so the caller must wipe the statistics from a
// scratch database afterwards (owner decision "Plaintext, then wipe stats").
export function assertPasswordStatementSafe(stats) {
  if (!stats.checked || stats.extension)
    throw new StagingError("STAGING_STATEMENT_STATS_PRESENT", {
      reason: !stats.checked ? "unchecked" : "extension",
      extension: stats.extension,
      module: stats.module,
    });
  if (stats.passwordEncryption !== "scram-sha-256")
    throw new StagingError("STAGING_PASSWORD_ENCRYPTION");
  const logging = statementLoggingRefusal(stats);
  if (logging)
    throw new StagingError("STAGING_STATEMENT_LOGGING", { reason: logging, database: "binding" });
  return stats.recording;
}

// The PostgreSQL instance a session runs on: the postmaster's start time (a restart
// changes it) and, over TCP, the server's address and port ("-" over a socket). Read in
// both sessions before any password statement and again inside the verification, so the
// wipe is shown to have run on the instance that recorded the statements and that it did
// not restart in between (pg_stat_statements saves its entries across a clean restart).
// Only compared in SQL; never printed, logged or put in an error.
export const instanceIdentityExpression =
  "pg_catalog.concat_ws('/', EXTRACT(epoch FROM pg_catalog.pg_postmaster_start_time())::text, coalesce(pg_catalog.host(pg_catalog.inet_server_addr()), '-'), coalesce(pg_catalog.inet_server_port()::text, '-'))";
export const instanceIdentityQuery = `SELECT ${instanceIdentityExpression} AS instance`;
export async function readInstanceIdentity(connection) {
  try {
    const [row] = await connection.query(instanceIdentityQuery);
    return typeof row?.instance === "string" && /^[0-9.]{1,40}\/[^\s]{1,80}$/.test(row.instance)
      ? row.instance
      : null;
  } catch {
    return null;
  }
}

// The scratch database the wipe runs from: Neon's default `neondb`, never the binding
// database, so `morrow` never gains the extension. Opened, identity-checked and held to
// the same logging rule before any password statement. It never receives a password (the
// verification sends only SHA-256 digests), but every session of a password run meets one
// rule, and a scratch database that logs stops the run before any password exists. Its
// instance must be the binding session's (instanceIdentityQuery). A scratch database that
// is unnamed, the binding database itself, absent, unreachable, or not shown to run on the
// binding's instance keeps the refusal (`reason` `module`). Returns {session, instance}.
export const statementStatsScratchDatabase = "neondb";
const scratchRefusal = (scratch) =>
  new StagingError("STAGING_STATEMENT_STATS_PRESENT", {
    reason: "module",
    extension: false,
    module: true,
    scratch,
  });
export async function openStatementStatsScratch(connection, { binding, administrator, scratch }) {
  if (
    typeof scratch?.connect !== "function" ||
    typeof scratch.database !== "string" ||
    !identifier.test(scratch.database)
  )
    throw scratchRefusal("unnamed");
  if (scratch.database === binding.database) throw scratchRefusal("same_database");
  let present = null;
  try {
    [present] = await connection.query(
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1::text AND datallowconn AND NOT datistemplate) AS present",
      [scratch.database],
    );
  } catch {
    present = null;
  }
  if (present?.present !== true) throw scratchRefusal("absent");
  let session;
  try {
    session = await connectChecked(
      scratch.connect,
      { ...binding, database: scratch.database },
      administrator,
    );
  } catch {
    throw scratchRefusal("unavailable");
  }
  try {
    // A bound on every scratch statement: a stalled verification fails closed as a residue
    // (stage "verify") instead of hanging the run.
    await session.exec("SET statement_timeout = '60s'");
    const logging = statementLoggingRefusal(await readStatementStats(session));
    if (logging)
      throw new StagingError("STAGING_STATEMENT_LOGGING", { reason: logging, database: "scratch" });
    const instance = await readInstanceIdentity(connection);
    if (instance === null || (await readInstanceIdentity(session)) !== instance)
      throw scratchRefusal("other_instance");
    return Object.freeze({ session, instance });
  } catch (error) {
    await session.close();
    throw error;
  }
}

// The wipe (owner decision 2026-10-20, "Plaintext, then wipe stats"), from the scratch
// session only: create the extension there if it is absent, run the full reset (all
// users, all databases; it also truncates the stored query texts), then verify, in one
// query: the reset was full (pg_stat_statements_info.stats_reset moved past the time read
// just before it, so entries the session cannot see are gone too), the session still
// runs on `instance` (read in both sessions before the password statements), and no
// entry's text contains any of `passwords`. The passwords never leave memory here: the
// query receives their SHA-256 digests as one bind parameter, and the server hashes every
// 43-character window of each run of password characters in each entry's text and
// compares (each password is 32 random bytes, so its digest reveals nothing). Only
// booleans and a count come back. Then the extension is dropped if this call created it.
// Any failure, including a residue or a drop that fails, is
// STAGING_STATEMENT_STATS_RESIDUE with the stage reached and what the verification read.
const extensionSchemaQuery =
  "SELECT n.nspname::text AS schema FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'";
// The verification query for the extension in `schema`: $1 the time read just before the
// reset, $2 the JSON array of password digests (lowercase hex), $3 the expected instance.
export function statementStatsVerificationQuery(schema) {
  if (typeof schema !== "string" || !identifier.test(schema)) throw Error("schema");
  return `SELECT coalesce((SELECT i.stats_reset >= $1::timestamptz FROM ${schema}.pg_stat_statements_info i), false) AS full_reset, coalesce(${instanceIdentityExpression} = $3::text, false) AS same_instance, (SELECT count(*)::int FROM ${schema}.pg_stat_statements s WHERE EXISTS (SELECT 1 FROM pg_catalog.regexp_matches(s.query, '[A-Za-z0-9_-]{43,}', 'g') m(run), pg_catalog.generate_series(1, pg_catalog.length(m.run[1]) - 42) w(i) WHERE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.substr(m.run[1], w.i, 43), 'UTF8')), 'hex') IN (SELECT pg_catalog.jsonb_array_elements_text($2::jsonb)))) AS remaining`;
}
export const passwordDigest = (password) => createHash("sha256").update(password).digest("hex");
export async function wipeStatementStats(session, passwords, instance) {
  if (
    !Array.isArray(passwords) ||
    !passwords.length ||
    !passwords.every((p) => passwordGrammar.test(p))
  )
    throw new StagingError("STAGING_PASSWORD_INVALID");
  const digests = JSON.stringify(passwords.map(passwordDigest));
  let stage = "extension";
  let created = false;
  let check = null;
  try {
    let [row] = await session.query(extensionSchemaQuery);
    if (!row) {
      await session.exec("CREATE EXTENSION pg_stat_statements");
      created = true;
      [row] = await session.query(extensionSchemaQuery);
    }
    const query = statementStatsVerificationQuery(row?.schema);
    stage = "reset";
    const [clock] = await session.query("SELECT pg_catalog.clock_timestamp()::text AS before");
    await session.query(`SELECT ${row.schema}.pg_stat_statements_reset()::text AS reset`);
    stage = "verify";
    [check] = await session.query(query, [
      clock?.before,
      digests,
      typeof instance === "string" ? instance : "",
    ]);
    if (
      check?.full_reset !== true ||
      check?.same_instance !== true ||
      check?.remaining !== 0 ||
      typeof instance !== "string"
    )
      throw Error("residue");
    if (created) {
      stage = "drop";
      await session.exec("DROP EXTENSION pg_stat_statements");
      created = false;
    }
    return Object.freeze({ wiped: true, entriesRemaining: 0 });
  } catch {
    if (created && stage !== "drop")
      try {
        await session.exec("DROP EXTENSION pg_stat_statements");
      } catch {
        // The residue below already stops the run.
      }
    const read = (value) => (typeof value === "boolean" ? value : null);
    throw new StagingError("STAGING_STATEMENT_STATS_RESIDUE", {
      stage,
      entriesRemaining: Number.isSafeInteger(check?.remaining) ? check.remaining : null,
      fullReset: read(check?.full_reset),
      sameInstance: read(check?.same_instance),
    });
  }
}

// The stored form of the roles' passwords, where the session may read pg_authid (a
// superuser can, and so can a pg_read_all_data member; under ADR-0020's model of Neon's
// roles, not yet confirmed on Neon (M-N1+, P04.T01j-AC15), neondb_owner is one through
// neon_superuser; a plain CREATEROLE role cannot): "SCRAM-SHA-256" when every
// role's stored password is a SCRAM-SHA-256 verifier, "other" when any is not,
// "unreadable" otherwise. Only a count leaves the server, never a stored verifier.
// Readability is asked first, so a refused read never fails the session.
export async function storedPasswordForm(connection, roles) {
  const [access] = await connection.query(
    "SELECT pg_catalog.has_table_privilege('pg_catalog.pg_authid', 'SELECT') AS readable",
  );
  if (access?.readable !== true) return "unreadable";
  const [row] = await connection.query(
    `SELECT count(*)::int AS n FROM pg_catalog.pg_authid WHERE rolname IN (${roleList(roles)}) AND rolpassword LIKE 'SCRAM-SHA-256$%'`,
  );
  return row?.n === roles.length ? "SCRAM-SHA-256" : "other";
}

// Provisions the controls and, for `passwordRoles`, new passwords. Plaintexts are
// generated here, sent once each in their ALTER ROLE statement over the TLS connection,
// and returned only to the in-process caller, which delivers them to the broker (the
// 0600 first-deploy file or `secret bulk` stdin). Before any password statement the
// session must pass assertPasswordStatementSafe; when the loaded module records the
// statements, the scratch session is opened and shown to share the binding's instance
// first, and the statistics are wiped and verified after the statements, whether they
// committed or failed. Each plaintext leaves memory only in its ALTER ROLE and the
// broker delivery; the wipe sends digests. A wipe that cannot be
// verified stops the run before any password is returned (STAGING_STATEMENT_STATS_RESIDUE).
// `scratch` is {database, connect} for the scratch database (statementStatsScratchDatabase).
export async function provisionRoles({
  connect,
  binding,
  administrator,
  roles,
  passwordRoles,
  scratch = null,
}) {
  checkAdministrator(administrator);
  if (!passwordRoles.every((role) => roles.includes(role)))
    throw new StagingError("STAGING_ROLE_INVALID");
  const connection = await connectChecked(connect, binding, administrator);
  let wipeFrom = null;
  try {
    if ((await presentRoles(connection, roles)) !== roles.length)
      throw new StagingError("STAGING_ROLES_MISSING");
    if (passwordRoles.length && assertPasswordStatementSafe(await readStatementStats(connection)))
      wipeFrom = await openStatementStatsScratch(connection, {
        binding,
        administrator,
        scratch,
      });
    const passwords = new Map(passwordRoles.map((role) => [role, generatePassword()]));
    let failure = null;
    try {
      for (const statement of provisioningSql({ roles, passwords, database: binding.database }))
        await connection.exec(statement);
    } catch (error) {
      failure = sqlFailure("STAGING_PROVISION_FAILED", error);
    }
    const statementStats = wipeFrom
      ? {
          recording: true,
          ...(await wipeStatementStats(
            wipeFrom.session,
            [...passwords.values()],
            wipeFrom.instance,
          )),
        }
      : { recording: false };
    if (failure) throw failure;
    const facts = await roleControlFacts(connection, roles);
    if (!facts.ok) throw new StagingError("STAGING_ROLE_CONTROLS_MISMATCH");
    const passwordStorage = passwordRoles.length
      ? await storedPasswordForm(connection, passwordRoles)
      : "unchanged";
    if (passwordStorage === "other") throw new StagingError("STAGING_PASSWORD_STORAGE_MISMATCH");
    return { passwords, facts, passwordStorage, statementStats };
  } finally {
    if (wipeFrom) await wipeFrom.session.close();
    await connection.close();
  }
}

// ---------------------------------------------------------------------------
// Platform seed (D3 `seed-platform`): the configuration rows the 0007–0013 definers read,
// derived from the committed login configuration, written as the identity owner in the
// P05.T01x §7 lock order (the profile, (5), first), idempotent, and refused on drift.
export function platformSeedRows(configuration, profile) {
  const b = configuration.binding;
  const digest = createHash("sha256").update(configuration.verificationProfileJson).digest("hex");
  return Object.freeze({
    profileId: configuration.profileId,
    authenticationBinding: [
      b.bindingId,
      b.environmentId,
      b.clientId,
      b.redirectUri,
      b.returnPath,
      "true",
    ],
    exchangeBinding: [b.bindingId, "workos", b.applicationId, String(b.bindingRevision), "true"],
    profile: [
      configuration.profileId,
      "workos",
      profile.environmentId,
      profile.applicationId,
      profile.clientId,
      profile.issuer,
      String(profile.revision),
      digest,
      String(configuration.profileRecordRevision),
      "active",
    ],
    configuration: [
      configuration.configurationDigest,
      "morrow-login-v1",
      configuration.origin,
      configuration.retentionTier,
      b.bindingId,
      String(b.bindingRevision),
      b.environmentId,
      b.applicationId,
      b.clientId,
      b.redirectUri,
      b.returnPath,
      configuration.profileId,
      String(configuration.profileRecordRevision),
      profile.issuer,
      String(profile.revision),
      digest,
    ],
  });
}
const seedStatements = Object.freeze({
  lockProfile:
    "SELECT id::text AS id FROM morrow_identity.identity_verification_profiles WHERE id = $1::text FOR UPDATE",
  authenticationBinding:
    "INSERT INTO morrow_identity.authentication_bindings(id, environment_id, client_id, redirect_uri, return_path, active) VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::boolean) ON CONFLICT (id) DO NOTHING",
  exchangeBinding:
    "INSERT INTO morrow_identity.authentication_exchange_bindings(binding_id, provider_id, application_id, revision, active) VALUES ($1::text, $2::text, $3::text, $4::bigint, $5::boolean) ON CONFLICT (binding_id) DO NOTHING",
  profile:
    "INSERT INTO morrow_identity.identity_verification_profiles(id, provider_id, environment_id, application_id, client_id, issuer, token_profile_revision, token_profile_digest, record_revision, state) VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::bigint, $8::text, $9::bigint, $10::text) ON CONFLICT (id) DO NOTHING",
  configuration:
    "INSERT INTO morrow_identity.login_controller_configurations(configuration_digest, controller_protocol, origin, retention_tier, binding_id, binding_revision, environment_id, application_id, client_id, redirect_uri, return_path, profile_id, profile_record_revision, issuer, token_profile_revision, token_profile_digest) VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::bigint, $7::text, $8::text, $9::text, $10::text, $11::text, $12::text, $13::bigint, $14::text, $15::bigint, $16::text) ON CONFLICT (configuration_digest) DO NOTHING",
  readAuthenticationBinding:
    "SELECT id::text, environment_id, client_id, redirect_uri, return_path, active::text FROM morrow_identity.authentication_bindings WHERE id = $1::text",
  readExchangeBinding:
    "SELECT binding_id::text, provider_id, application_id, revision::text, active::text FROM morrow_identity.authentication_exchange_bindings WHERE binding_id = $1::text",
  readProfile:
    "SELECT id::text, provider_id, environment_id, application_id, client_id, issuer, token_profile_revision::text, token_profile_digest, record_revision::text, state FROM morrow_identity.identity_verification_profiles WHERE id = $1::text",
  readConfiguration:
    "SELECT configuration_digest, controller_protocol, origin, retention_tier, binding_id::text, binding_revision::text, environment_id, application_id, client_id, redirect_uri, return_path, profile_id::text, profile_record_revision::text, issuer, token_profile_revision::text, token_profile_digest FROM morrow_identity.login_controller_configurations WHERE configuration_digest = $1::text",
  latestSwitch:
    "SELECT revision::int AS revision, enrollment, organization_signup FROM morrow_identity.self_service_revisions WHERE profile_id = $1::text ORDER BY revision DESC LIMIT 1",
  insertSwitch:
    "INSERT INTO morrow_identity.self_service_revisions(profile_id, revision, enrollment, organization_signup, reason, approval_ref) VALUES ($1::text, $2::bigint, 'enabled', 'enabled', 'Staging self-service for the allowlisted owner test user (staging-card-1 E7)', $3::text)",
});
const sameRow = (row, expected) =>
  row && Object.values(row).map(String).join("\u0000") === expected.join("\u0000");

export async function seedPlatform({ connect, binding, administrator, rows, selfService = null }) {
  checkAdministrator(administrator);
  if (
    selfService !== null &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(selfService.approvalRef ?? "")
  )
    throw new StagingError("STAGING_SELF_SERVICE_UNCONFIRMED");
  const connection = await connectChecked(connect, binding, administrator);
  const admin = administrator.name;
  const written = {
    configurationDigest: rows.configuration[0],
    profileId: rows.profileId,
    selfService: "unchanged",
  };
  try {
    try {
      await connection.exec("BEGIN");
      if (administrator.mode === "createrole")
        await connection.exec(
          `GRANT morrow_identity_owner TO ${admin} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
      await connection.exec("SET LOCAL ROLE morrow_identity_owner");
      await connection.query(seedStatements.lockProfile, [rows.profileId]);
      await connection.query(seedStatements.authenticationBinding, rows.authenticationBinding);
      await connection.query(seedStatements.exchangeBinding, rows.exchangeBinding);
      await connection.query(seedStatements.profile, rows.profile);
      await connection.query(seedStatements.configuration, rows.configuration);
      const checks = [
        [
          "authentication_bindings",
          seedStatements.readAuthenticationBinding,
          rows.authenticationBinding,
        ],
        [
          "authentication_exchange_bindings",
          seedStatements.readExchangeBinding,
          rows.exchangeBinding,
        ],
        ["identity_verification_profiles", seedStatements.readProfile, rows.profile],
        ["login_controller_configurations", seedStatements.readConfiguration, rows.configuration],
      ];
      for (const [table, text, expected] of checks) {
        const [row] = await connection.query(text, [expected[0]]);
        if (!sameRow(row, expected)) throw new StagingError("STAGING_SEED_DRIFT", { table });
      }
      if (selfService !== null) {
        const [latest] = await connection.query(seedStatements.latestSwitch, [rows.profileId]);
        if (!(latest?.enrollment === "enabled" && latest?.organization_signup === "enabled")) {
          await connection.query(seedStatements.insertSwitch, [
            rows.profileId,
            String((latest?.revision ?? 0) + 1),
            selfService.approvalRef,
          ]);
          written.selfService = "enabled";
        } else written.selfService = "already_enabled";
      }
      await connection.exec("RESET ROLE");
      if (administrator.mode === "createrole")
        await connection.exec(`REVOKE morrow_identity_owner FROM ${admin} GRANTED BY ${admin}`);
      await connection.exec("COMMIT");
    } catch (error) {
      throw sqlFailure("STAGING_SEED_FAILED", error);
    }
    await assertNoSetRows(connection);
    return written;
  } finally {
    await connection.close();
  }
}

// ---------------------------------------------------------------------------
// M5 PR-1: the billing terms seed (`seed-platform`). docs/decisions/billing-terms.json
// publishes each environment's BillingTerms@1 revisions with their display offers and
// digests (npm run verify:billing checks the file; staging.mjs parses it again with the
// billing module before calling this). Written as morrow_work_owner, in revision order, in
// one transaction under the D4 SET-row protocol, idempotent, and refused on drift: a
// stored revision that differs from the file, or one the file does not have. The table's
// own guard (0029 terms_guard) also refuses a gap or any change.
const termsStatements = Object.freeze({
  lock: "LOCK TABLE morrow_billing.billing_terms IN SHARE ROW EXCLUSIVE MODE",
  count: "SELECT count(*)::int AS n FROM morrow_billing.billing_terms",
  same: "SELECT (terms = $2::jsonb AND offers = $3::jsonb AND digest = $4::text)::text AS same FROM morrow_billing.billing_terms WHERE terms_revision = $1::bigint",
  insert:
    "INSERT INTO morrow_billing.billing_terms(terms_revision, terms, offers, digest, recorded_at) VALUES ($1::bigint, $2::jsonb, $3::jsonb, $4::text, date_trunc('milliseconds', clock_timestamp()))",
});
/** One row per revision, in order: [revision, terms JSON, offers JSON, digest], all text. */
export function billingTermsSeedRows(revisions) {
  if (!Array.isArray(revisions) || revisions.length > 1000)
    throw new StagingError("STAGING_TERMS_INVALID");
  return Object.freeze(
    revisions.map((r, index) => {
      if (
        !r ||
        typeof r !== "object" ||
        Object.keys(r).sort().join() !== "digest,offers,terms" ||
        !/^[a-f0-9]{64}$/.test(r.digest ?? "") ||
        r.terms?.termsRevision !== index + 1
      )
        throw new StagingError("STAGING_TERMS_INVALID");
      return Object.freeze([
        String(index + 1),
        JSON.stringify(r.terms),
        JSON.stringify(r.offers),
        r.digest,
      ]);
    }),
  );
}
export async function seedBillingTerms({ connect, binding, administrator, rows }) {
  checkAdministrator(administrator);
  if (
    !Array.isArray(rows) ||
    !rows.every(
      (row, index) =>
        Array.isArray(row) &&
        row.length === 4 &&
        row.every((v) => typeof v === "string") &&
        row[0] === String(index + 1),
    )
  )
    throw new StagingError("STAGING_TERMS_INVALID");
  const connection = await connectChecked(connect, binding, administrator);
  const admin = administrator.name;
  const written = { termsRevisions: rows.length, termsInserted: 0 };
  try {
    try {
      await connection.exec("BEGIN");
      if (administrator.mode === "createrole")
        await connection.exec(
          `GRANT morrow_work_owner TO ${admin} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
      await connection.exec("SET LOCAL ROLE morrow_work_owner");
      await connection.exec(termsStatements.lock);
      const [{ n } = {}] = await connection.query(termsStatements.count);
      const stored = Number.isSafeInteger(n) ? n : 0;
      if (stored > rows.length)
        throw new StagingError("STAGING_SEED_DRIFT", { table: "billing_terms" });
      for (const row of rows.slice(0, stored)) {
        const [same] = await connection.query(termsStatements.same, row);
        if (same?.same !== "true")
          throw new StagingError("STAGING_SEED_DRIFT", { table: "billing_terms" });
      }
      for (const row of rows.slice(stored)) {
        await connection.query(termsStatements.insert, row);
        written.termsInserted++;
      }
      await connection.exec("RESET ROLE");
      if (administrator.mode === "createrole")
        await connection.exec(`REVOKE morrow_work_owner FROM ${admin} GRANTED BY ${admin}`);
      await connection.exec("COMMIT");
    } catch (error) {
      throw sqlFailure("STAGING_SEED_FAILED", error);
    }
    await assertNoSetRows(connection);
    return written;
  } finally {
    await connection.close();
  }
}

// ---------------------------------------------------------------------------
// M5 PR-1 (review): the operator path for a held customer operation
// (`billing-customer-resolve`). The broker holds a customer operation when, once no replay
// or send can run, Stripe proves neither outcome (several customers of the operation, or
// more than its bounded list); the workspace's checkout then answers customer_held. After
// correcting or inspecting Stripe (a per-action approval and a docs/evidence/live record,
// whose path is recorded), the operator runs morrow_billing.operator_customer_operation_resolve
// as morrow_work_owner under the D4 SET-row protocol: retry (stripe_corrected) clears the
// hold so the broker's proof runs again; abandon (customers_deleted or none_found) fails the
// operation and the intents it serves. Anything but released or abandoned commits nothing.
export const customerResolutionEvidence = Object.freeze({
  retry: Object.freeze(["stripe_corrected"]),
  abandon: Object.freeze(["customers_deleted", "none_found"]),
});
const resolveOutcomes = ["released", "abandoned", "not_held", "not_found", "invalid", "denied"];
const resolveStatement =
  "SELECT outcome, operation_status FROM morrow_billing.operator_customer_operation_resolve($1, $2, $3, $4, $5)";
export function customerResolutionInput({
  operatorId,
  operationId,
  resolution,
  evidenceCode,
  evidenceRef,
}) {
  if (
    typeof operatorId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operatorId) ||
    typeof operationId !== "string" ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId) ||
    !Object.hasOwn(customerResolutionEvidence, resolution ?? "") ||
    !customerResolutionEvidence[resolution].includes(evidenceCode) ||
    typeof evidenceRef !== "string" ||
    !/^docs\/evidence\/live\/\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,80}\.md$/.test(evidenceRef)
  )
    throw new StagingError("STAGING_USAGE");
  return Object.freeze([operatorId, operationId, resolution, evidenceCode, evidenceRef]);
}
export async function resolveHeldCustomerOperation({ connect, binding, administrator, input }) {
  checkAdministrator(administrator);
  const values = customerResolutionInput(input ?? {});
  const connection = await connectChecked(connect, binding, administrator);
  const admin = administrator.name;
  try {
    let row;
    try {
      await connection.exec("BEGIN");
      if (administrator.mode === "createrole")
        await connection.exec(
          `GRANT morrow_work_owner TO ${admin} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
      await connection.exec("SET LOCAL ROLE morrow_work_owner");
      [row] = await connection.query(resolveStatement, [...values]);
      const outcome = resolveOutcomes.includes(row?.outcome) ? row.outcome : "unknown";
      if (outcome !== "released" && outcome !== "abandoned")
        throw new StagingError("STAGING_RESOLVE_REFUSED", { outcome });
      await connection.exec("RESET ROLE");
      if (administrator.mode === "createrole")
        await connection.exec(`REVOKE morrow_work_owner FROM ${admin} GRANTED BY ${admin}`);
      await connection.exec("COMMIT");
    } catch (error) {
      throw sqlFailure("STAGING_RESOLVE_FAILED", error);
    }
    await assertNoSetRows(connection);
    return Object.freeze({
      outcome: row.outcome,
      operationStatus: typeof row.operation_status === "string" ? row.operation_status : null,
    });
  } finally {
    await connection.close();
  }
}

// ---------------------------------------------------------------------------
// The platform stop (M3 PR-1; ADR-0022 item 15; P11.T05a): the owner's script sets or
// lifts the one platform stop through 0020's operator functions, as morrow_work_owner
// inside the administrator's own transaction (the seed-platform shape: a SET-only grant
// for the transaction, revoked before COMMIT). Setting it revokes every active run and
// operation lease (stop_guard) and records StopRecord@1; lifting revokes nothing back.
// Both are idempotent (already_stopped, not_stopped), so a run whose COMMIT reply was lost
// is checked by running it again, never assumed done. Fixed statements; the operator id
// and the reason travel only as parameters, and the reason is never echoed.
export const platformStopStatements = Object.freeze({
  set: "SELECT outcome, stop_id::text AS stop_id FROM morrow_work.platform_stop_set($1::text, $2::text)",
  lift: "SELECT outcome, stop_id::text AS stop_id FROM morrow_work.platform_stop_lift($1::text, $2::text)",
});
const platformStopOutcomes = Object.freeze({
  set: Object.freeze(["applied", "already_stopped"]),
  lift: Object.freeze(["applied", "not_stopped"]),
});
const stopId = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
/** The closed input of a platform stop: set|lift, an Id-shaped operator, a person's reason. */
export function checkPlatformStopInput(input) {
  const { action, operatorId, reason } = input ?? {};
  if (
    !Object.hasOwn(platformStopStatements, action) ||
    typeof operatorId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operatorId) ||
    typeof reason !== "string" ||
    reason.length < 1 ||
    reason.length > 1024 ||
    !/\S/.test(reason) ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(reason)
  )
    throw new StagingError("STAGING_USAGE");
  return Object.freeze({ action, operatorId, reason });
}
export async function platformStop({ connect, binding, administrator, ...input }) {
  checkAdministrator(administrator);
  const { action, operatorId, reason } = checkPlatformStopInput(input);
  const connection = await connectChecked(connect, binding, administrator);
  const admin = administrator.name;
  try {
    let row;
    try {
      await connection.exec("BEGIN");
      if (administrator.mode === "createrole")
        await connection.exec(
          `GRANT morrow_work_owner TO ${admin} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`,
        );
      await connection.exec("SET LOCAL ROLE morrow_work_owner");
      const rows = await connection.query(platformStopStatements[action], [operatorId, reason]);
      row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
      const outcome = typeof row?.outcome === "string" ? row.outcome : null;
      if (outcome === null || !platformStopOutcomes[action].includes(outcome))
        throw new StagingError("STAGING_PLATFORM_STOP_REFUSED", {
          outcome: outcome !== null && /^[a-z_]{1,32}$/.test(outcome) ? outcome : "other",
        });
      const quiet = outcome === "not_stopped";
      if (
        quiet ? row.stop_id !== null : typeof row.stop_id !== "string" || !stopId.test(row.stop_id)
      )
        throw new StagingError("STAGING_PLATFORM_STOP_REFUSED", { outcome: "other" });
      await connection.exec("RESET ROLE");
      if (administrator.mode === "createrole")
        await connection.exec(`REVOKE morrow_work_owner FROM ${admin} GRANTED BY ${admin}`);
      await connection.exec("COMMIT");
    } catch (error) {
      throw sqlFailure("STAGING_PLATFORM_STOP_FAILED", error);
    }
    await assertNoSetRows(connection);
    return Object.freeze({ action, outcome: row.outcome, stopId: row.stop_id });
  } finally {
    await connection.close();
  }
}

// ---------------------------------------------------------------------------
// Connections (D6): counts by role and by application_name class. Raw application names
// are client-chosen text and are never printed; unknown ones are only counted.
export const applicationClasses = Object.freeze([
  ["identity_pool", /^morrow_id_[a-f0-9]{32}_[po]$/],
  ["work_connector", /^morrow_work_[a-f0-9]{32}$/],
  ["identity_read", /^morrow-(development|staging)-identity$/],
  ["staging_runner", /^morrow-staging-runner$/],
  ["unnamed", /^$/],
]);
export async function connectionCensus({ connect, binding, administrator, knownRoles }) {
  checkAdministrator(administrator);
  const connection = await connectChecked(connect, binding, administrator);
  try {
    const rows = await connection.query(
      "SELECT coalesce(usename::text, '') AS role, coalesce(application_name, '') AS application, count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND pid <> pg_catalog.pg_backend_pid() GROUP BY 1, 2",
    );
    const byRole = {};
    const byApplication = {};
    let unknownApplications = 0;
    let otherRoles = 0;
    for (const row of rows) {
      const role = [...knownRoles, administrator.name].includes(row.role) ? row.role : "other";
      if (role === "other") otherRoles += row.n;
      byRole[role] = (byRole[role] ?? 0) + row.n;
      const found = applicationClasses.find(([, pattern]) => pattern.test(row.application));
      const name = found ? found[0] : "unknown";
      if (!found) unknownApplications += row.n;
      byApplication[name] = (byApplication[name] ?? 0) + row.n;
    }
    return { byRole, byApplication, unknownApplications, otherRoles };
  } finally {
    await connection.close();
  }
}
