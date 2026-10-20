// The hosted migration runner and the database operations of the staging tools
// (P04.T01i D3, P04.T01j D4, ADR-0019 item 12, ADR-0020 item 5). Everything here talks
// to PostgreSQL through a `connect()` factory whose connections expose
//   query(text, params) -> rows   one statement; parameters only through `params`
//   exec(text)                    one or more statements, no parameters, no rows
//   close()
// The staging CLI passes the Neon serverless connector below; the PostgreSQL 17 lab
// passes a psql connector (scripts/fixtures/staging-psql-connection.mjs) with fault
// hooks. Identifiers that reach SQL text are closed role and database names; every value
// is a parameter, except a SCRAM verifier, which PostgreSQL accepts only as a literal and
// which is checked against its exact grammar first.
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
}) {
  if (ownerUrl.host !== binding.hostname) throw new StagingError("STAGING_HOST_MISMATCH");
  const expectedUrl = `wss://${binding.hostname}/v2?address=${binding.hostname}:5432`;
  return Object.freeze({
    async connect() {
      const { Client } = driver ?? (await import("@neondatabase/serverless"));
      const Native = globalThis.WebSocket;
      class Guard extends Native {
        constructor(url, protocols) {
          if (String(url) !== expectedUrl) throw Error("STAGING_SOCKET_REFUSED");
          super(url, protocols);
        }
      }
      const client = new Client({
        host: binding.hostname,
        port: 5432,
        database: binding.database,
        user: ownerUrl.user,
        password: ownerUrl.password,
        ssl: false,
        connectionTimeoutMillis: 20000,
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
      try {
        await client.connect();
      } catch {
        try {
          await client.end();
        } catch {
          // Already closed.
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

async function connectChecked(connect, binding, administrator) {
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
// 32 random bytes, base64url: 43 printable ASCII characters (SASLprep is the identity).
export const generatePassword = () => randomBytes(32).toString("base64url");
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
const verifierGrammar =
  /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;

// The provisioning statements: LOGIN with a verifier (never a plaintext), the connection
// limit, both timeouts, and REVOKE TEMP from PUBLIC. `verifiers` maps role -> verifier
// for the roles whose password changes; every listed role gets the controls.
export function provisioningSql({ roles, verifiers, database }) {
  if (!identifier.test(database)) throw new StagingError("STAGING_DATABASE_MISMATCH");
  const statements = ["BEGIN"];
  for (const role of roles) {
    if (!morrowRole.test(role)) throw new StagingError("STAGING_ROLE_INVALID");
    const verifier = verifiers.get(role);
    if (verifier !== undefined && !verifierGrammar.test(verifier))
      throw new StagingError("STAGING_PASSWORD_INVALID");
    statements.push(
      `ALTER ROLE ${role} WITH LOGIN CONNECTION LIMIT ${roleControls.connectionLimit}` +
        (verifier === undefined ? "" : ` PASSWORD '${verifier}'`),
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

// Provisions the controls and, for `passwordRoles`, new passwords. Plaintexts are
// generated here and returned only to the in-process caller; only verifiers reach SQL.
export async function provisionRoles({ connect, binding, administrator, roles, passwordRoles }) {
  checkAdministrator(administrator);
  if (!passwordRoles.every((role) => roles.includes(role)))
    throw new StagingError("STAGING_ROLE_INVALID");
  const connection = await connectChecked(connect, binding, administrator);
  try {
    if ((await presentRoles(connection, roles)) !== roles.length)
      throw new StagingError("STAGING_ROLES_MISSING");
    const passwords = new Map(passwordRoles.map((role) => [role, generatePassword()]));
    const verifiers = new Map(
      [...passwords].map(([role, password]) => [role, scramVerifier(password)]),
    );
    const statements = provisioningSql({ roles, verifiers, database: binding.database });
    let committed = false;
    try {
      for (const statement of statements) await connection.exec(statement);
      committed = true;
    } catch (error) {
      throw sqlFailure("STAGING_PROVISION_FAILED", error);
    }
    const facts = await roleControlFacts(connection, roles);
    if (!committed || !facts.ok) throw new StagingError("STAGING_ROLE_CONTROLS_MISMATCH");
    return { passwords, facts };
  } finally {
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
