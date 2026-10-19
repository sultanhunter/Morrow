// P04.T01j D7 (ADR-0020): the hosted administrator model, reproduced in a local
// network-none PostgreSQL 17 container. Laboratory scaffolding only: no provider, host
// port, credential or password. Every login uses the container's local trust socket.
//
// The local superuser creates a Neon-shaped `neon_superuser` and a non-superuser
// CREATEROLE login `neondb_owner` that owns the `morrow` database (P04.T01j M-N1). The
// administrator then runs every prerequisite file itself and applies each manifest entry
// with the ADR-0020 item 5 runner protocol (P04.T01j D4): one transaction on one fresh
// connection that grants itself SET on the entry's `executeAs` role, runs the file, and
// revokes that row again before COMMIT. After every entry the catalog must show no SET row
// on a Morrow role other than the two reviewed work memberships; a REVOKE's exit status
// is never trusted, because a no-op REVOKE exits 0.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrationSqlViolations } from "../migration-sql.mjs";

export const administrator = "neondb_owner";
export const bootstrapSuperuser = "postgres";
const roleName = /^[a-z_][a-z0-9_]{0,62}$/;
const executeAsRole = /^morrow_[a-z]+_owner$/;
const container = /^[a-f0-9]{64}$/;
const sha = (value) => createHash("sha256").update(value).digest("hex");

// The 15 roles the prerequisite files create, in creation order. In createrole mode each
// has exactly one creation row; in superuser mode none has any row of its own.
export const morrowRoles = Object.freeze([
  "morrow_identity_owner",
  "morrow_api",
  "morrow_identity_lifecycle",
  "morrow_identity_linking",
  "morrow_identity_preauth",
  "morrow_identity_resolution",
  "morrow_identity_sessions",
  "morrow_identity_login",
  "morrow_identity_login_maintenance",
  "morrow_identity_logout",
  "morrow_identity_onboarding",
  "morrow_work_owner",
  "morrow_work_command",
  "morrow_work_api",
  "morrow_api_worker",
]);
// The nine identity executors that log in at run time (ADR-0007 item 5 and onboarding).
export const identityExecutors = Object.freeze([
  "morrow_identity_lifecycle",
  "morrow_identity_linking",
  "morrow_identity_preauth",
  "morrow_identity_resolution",
  "morrow_identity_sessions",
  "morrow_identity_login",
  "morrow_identity_login_maintenance",
  "morrow_identity_logout",
  "morrow_identity_onboarding",
]);
export const reviewedPairs = Object.freeze([
  Object.freeze(["morrow_work_api", "morrow_api_worker"]),
  Object.freeze(["morrow_work_command", "morrow_work_owner"]),
]);

// Every SET row on or by a Morrow role except the two reviewed work memberships. The
// runner contract (D4) and S5 both require zero.
export const morrowSetRowsSql =
  "SELECT count(*) FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid=m.roleid JOIN pg_catalog.pg_roles u ON u.oid=m.member WHERE m.set_option AND (g.rolname LIKE 'morrow\\_%' OR u.rolname LIKE 'morrow\\_%') AND (g.rolname,u.rolname) NOT IN (('morrow_work_api','morrow_api_worker'),('morrow_work_command','morrow_work_owner'))";
// Every membership row that names a Morrow role, as closed projections.
export const morrowMembershipCensusSql =
  "SELECT g.rolname AS role, u.rolname AS member, m.grantor=10::oid AS bootstrap_grantor, gr.rolname AS grantor, m.admin_option, m.inherit_option, m.set_option FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid=m.roleid JOIN pg_catalog.pg_roles u ON u.oid=m.member JOIN pg_catalog.pg_roles gr ON gr.oid=m.grantor WHERE g.rolname LIKE 'morrow\\_%' OR u.rolname LIKE 'morrow\\_%' ORDER BY 1,2,4";

// A fresh psql connection per call, as `user`, through the local trust socket. Failures
// expose fixed codes only; callers read stderr only through classifyFailure.
export function psqlAs(
  id,
  text,
  { user = bootstrapSuperuser, database = "morrow", allowFailure = false } = {},
) {
  if (!container.test(id)) throw Error("CREATEROLE_FIXTURE_CONTAINER_INVALID");
  if (!roleName.test(user) || !roleName.test(database)) throw Error("CREATEROLE_FIXTURE_NAME");
  const result = spawnSync(
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
      "-v",
      "VERBOSITY=verbose",
      "-U",
      user,
      "-d",
      database,
    ],
    { encoding: "utf8", input: text, timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
  );
  const ok = !result.error && result.status === 0;
  if (allowFailure)
    return { ok, stdout: (result.stdout ?? "").trim(), stderr: result.stderr ?? "" };
  if (!ok) throw Error("CREATEROLE_FIXTURE_SQL_FAILED");
  return result.stdout.trim();
}

// The first error of a failed psql run, reduced to its SQLSTATE and one of a closed set
// of codes. No other error text leaves this function.
const failureCodes = [
  "MIGRATION_ADMINISTRATOR_INVALID",
  "MIGRATION_ADMINISTRATOR_IMMUTABLE",
  "LINKING_ROLE_PREREQUISITES_INVALID",
  "WORK_ROLE_PREREQUISITES_INVALID",
  "WORK_BRIDGE_PREREQUISITES_INVALID",
];
export function classifyFailure(stderr) {
  const line = String(stderr)
    .split("\n")
    .find((l) => /^(psql:[^ ]* )?ERROR: {2}[0-9A-Z]{5}: /.test(l));
  if (!line) return Object.freeze({ sqlstate: null, code: null });
  const [, sqlstate, message] = /ERROR: {2}([0-9A-Z]{5}): (.*)$/.exec(line);
  const code =
    failureCodes.find((c) => message === c) ??
    (/^permission denied to grant role "morrow_[a-z_]+"$/.test(message)
      ? "GRANT_REQUIRES_ADMIN_OPTION"
      : /^permission denied for (function|table) [a-z_]+$/.test(message)
        ? "PERMISSION_DENIED"
        : "other");
  return Object.freeze({ sqlstate, code });
}

// The local superuser creates the Neon-shaped administrator (neon.com/docs/manage/roles):
// `neon_superuser` (NOLOGIN CREATEDB CREATEROLE REPLICATION BYPASSRLS, member of the
// predefined data roles, ADMIN on pg_monitor and pg_signal_backend) and `neondb_owner`
// (LOGIN INHERIT CREATEROLE CREATEDB, not a superuser, a member of neon_superuser),
// with or without BYPASSRLS, which owns the UTF8 `morrow` database.
export function createAdministrator(id, { bypassrls = false } = {}) {
  psqlAs(
    id,
    [
      "CREATE ROLE neon_superuser NOLOGIN CREATEDB CREATEROLE REPLICATION BYPASSRLS IN ROLE pg_read_all_data, pg_write_all_data, pg_create_subscription, pg_maintain;",
      "GRANT pg_monitor, pg_signal_backend TO neon_superuser WITH ADMIN OPTION;",
      `CREATE ROLE ${administrator} LOGIN INHERIT CREATEROLE CREATEDB ${bypassrls ? "BYPASSRLS" : "NOBYPASSRLS"} NOSUPERUSER IN ROLE neon_superuser;`,
      `CREATE DATABASE morrow OWNER ${administrator};`,
    ].join("\n"),
    { database: "morrow_lab" },
  );
  const shape = psqlAs(
    id,
    `SELECT concat_ws(',',r.rolcanlogin,r.rolsuper,r.rolcreaterole,r.rolbypassrls,(SELECT pg_catalog.pg_encoding_to_char(d.encoding) FROM pg_catalog.pg_database d WHERE d.datname='morrow'),(SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid)) FROM pg_catalog.pg_roles r WHERE r.rolname='${administrator}';`,
    { database: "morrow_lab" },
  );
  if (shape !== `t,f,t,${bypassrls ? "t" : "f"},UTF8,0`) throw Error("CREATEROLE_FIXTURE_SHAPE");
}

// The manifest chain: each entry's bytes and each prerequisite's bytes must match their
// pinned digests.
export function manifestChain() {
  const manifest = JSON.parse(readFileSync("migrations/manifest.json", "utf8"));
  return manifest.migrations.map((entry, index) => {
    const text = readFileSync("migrations/" + entry.file, "utf8");
    if (entry.sequence !== index + 1 || sha(text) !== entry.sha256)
      throw Error("CREATEROLE_FIXTURE_MIGRATION_UNQUALIFIED");
    const prerequisites = (entry.prerequisites ?? []).map((p) => {
      const bytes = readFileSync(p.file, "utf8");
      if (sha(bytes) !== p.sha256) throw Error("CREATEROLE_FIXTURE_PREREQUISITE_UNQUALIFIED");
      return Object.freeze({ file: p.file, text: bytes });
    });
    return Object.freeze({
      sequence: entry.sequence,
      file: entry.file,
      executeAs: entry.executeAs,
      text,
      prerequisites: Object.freeze(prerequisites),
    });
  });
}

// A manifest entry without its own first "BEGIN;" and last "COMMIT;" lines. The file must
// be one transaction with no other transaction control, no role or session switch and no
// psql meta-command (scripts/migration-sql.mjs): otherwise an inner COMMIT would commit
// the runner's SET row, or a RESET ROLE would run the rest of the file as the
// administrator.
export function migrationBody(entry) {
  if (!executeAsRole.test(entry?.executeAs ?? "")) throw Error("CREATEROLE_FIXTURE_ROLE_INVALID");
  const { text } = entry;
  if (
    typeof text !== "string" ||
    !text.startsWith("BEGIN;\n") ||
    !text.endsWith("\nCOMMIT;\n") ||
    migrationSqlViolations(text).length !== 0
  )
    throw Error("CREATEROLE_FIXTURE_FRAMING");
  return text.slice("BEGIN;\n".length, text.length - "COMMIT;\n".length);
}

// One manifest entry as the D4 transaction: the grant and the revoke share the
// migration's fate, so no failure can leave the SET row behind.
export function d4Transaction(entry, admin = administrator) {
  if (!roleName.test(admin)) throw Error("CREATEROLE_FIXTURE_ROLE_INVALID");
  const body = migrationBody(entry);
  const x = entry.executeAs;
  return (
    "BEGIN;\n" +
    `GRANT ${x} TO ${admin} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;\n` +
    `SET LOCAL ROLE ${x};\n` +
    body +
    "RESET ROLE;\n" +
    `REVOKE ${x} FROM ${admin} GRANTED BY ${admin};\n` +
    "COMMIT;\n"
  );
}

export const morrowSetRows = (id) => Number(psqlAs(id, morrowSetRowsSql + ";"));

// Prerequisites run as the administrator with createrole_self_grant forced to '' and no
// SET ROLE; each entry runs with D4. Returns the applied sequences.
export function applyChainAsAdministrator(
  id,
  chain,
  { stopBefore = Infinity, admin = administrator } = {},
) {
  const applied = [];
  for (const entry of chain) {
    if (entry.sequence >= stopBefore) break;
    for (const prerequisite of entry.prerequisites)
      psqlAs(id, "SET createrole_self_grant='';\n" + prerequisite.text, { user: admin });
    psqlAs(id, d4Transaction(entry, admin), { user: admin });
    if (morrowSetRows(id) !== 0) throw Error("MIGRATION_SET_ROW_PERSISTED");
    applied.push(entry.sequence);
  }
  return applied;
}

// The local-lab shape: the bootstrap superuser runs every prerequisite and applies each
// entry with SET ROLE <executeAs> on a fresh connection. Its recorded administrator is
// the superuser, and no Morrow role holds a row of its own.
export function applyChainAsSuperuser(id, chain, { stopBefore = Infinity } = {}) {
  const applied = [];
  for (const entry of chain) {
    if (entry.sequence >= stopBefore) break;
    if (!executeAsRole.test(entry.executeAs)) throw Error("CREATEROLE_FIXTURE_ROLE_INVALID");
    for (const prerequisite of entry.prerequisites) psqlAs(id, prerequisite.text);
    psqlAs(id, "SET ROLE " + entry.executeAs + ";\n" + entry.text);
    applied.push(entry.sequence);
  }
  return applied;
}
