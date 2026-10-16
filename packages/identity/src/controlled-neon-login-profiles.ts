import { loginFlowCustodySql } from "./login-flow-custody.js";
import { authenticationExchangeAdmissionSql } from "./authentication-exchange-admission.js";
import { workspaceSelectionSql } from "./workos-workspace-selection.js";
import { browserSessionAdmissionSql } from "./workos-browser-session-admission.js";

// Private source profiles, never an application SQL/role selection API.
export const controlledNeonMetadataSql = Object.freeze({
  primary: `SELECT pg_catalog.pg_backend_pid()::text AS backend_pid,
current_user::text AS current_role,session_user::text AS session_role,
pg_catalog.current_database()::text AS database_name,
a.pid::text AS self_pid,a.datname::text AS self_database,a.usename::text AS self_role,
a.application_name::text AS application_name,
pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start
FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`,
  observer: `SELECT pg_catalog.pg_backend_pid()::text AS backend_pid,
current_user::text AS current_role,session_user::text AS session_role,
pg_catalog.current_database()::text AS database_name,
a.pid::text AS self_pid,a.datname::text AS self_database,a.usename::text AS self_role,
a.application_name::text AS application_name,
pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,
EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity p
WHERE p.pid=$1::integer AND p.backend_start=$2::timestamptz
AND p.datname=$3::name AND p.usename=$4::name AND p.application_name=$5::text) AS primary_present
FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`,
});
export type ControlledNeonProfile = Readonly<{
  role: string;
  statementTimeout: number;
  idleTimeout: number;
  statements: Readonly<Record<string, Readonly<{ text: string; arity: number; maximum: number }>>>;
}>;
function profile(
  role: string,
  sql: Readonly<Record<string, string>>,
  arities: Readonly<Record<string, number>>,
  statementTimeout: number,
  idleTimeout: number,
  maximum: number,
): ControlledNeonProfile {
  return Object.freeze({
    role,
    statementTimeout,
    idleTimeout,
    statements: Object.freeze(
      Object.fromEntries(
        Object.entries(arities).map(([name, arity]) => [
          name,
          Object.freeze({ text: sql[name]!, arity, maximum }),
        ]),
      ),
    ),
  });
}
export const controlledNeonLoginProfiles = Object.freeze({
  loginPool: profile(
    "morrow_identity_login",
    loginFlowCustodySql,
    {
      begin: 0,
      readOnlyBegin: 0,
      role: 0,
      timeout: 0,
      idleTimeout: 0,
      createIntent: 6,
      bindBegin: 12,
      claimCallback: 4,
      observeEligibility: 2,
      reconcile: 5,
      commit: 0,
      rollback: 0,
    },
    1000,
    5000,
    683,
  ),
  preauthPool: profile(
    "morrow_identity_preauth",
    authenticationExchangeAdmissionSql,
    {
      begin: 0,
      beginReadOnly: 0,
      role: 0,
      timeout: 0,
      idleTimeout: 0,
      create: 12,
      admit: 13,
      reconcile: 13,
      commit: 0,
      rollback: 0,
    },
    5000,
    10000,
    2048,
  ),
  selectionPool: profile(
    "morrow_identity_resolution",
    workspaceSelectionSql,
    { begin: 0, role: 0, timeout: 0, idleTimeout: 0, resolve: 9, commit: 0, rollback: 0 },
    1000,
    5000,
    2048,
  ),
  sessionPool: profile(
    "morrow_identity_sessions",
    browserSessionAdmissionSql,
    {
      begin: 0,
      readOnlyBegin: 0,
      role: 0,
      timeout: 0,
      idleTimeout: 0,
      admit: 27,
      reconcile: 2,
      commit: 0,
      rollback: 0,
    },
    1000,
    5000,
    2048,
  ),
});
export type ControlledNeonPoolName = keyof typeof controlledNeonLoginProfiles;
export const controlledNeonHeld = () => Error("CONTROLLED_NEON_LOGIN_HELD");
export function ownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw controlledNeonHeld();
  const ds = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((k) => typeof k !== "string") ||
    Object.keys(ds).sort().join(",") !== [...keys].sort().join(",") ||
    keys.some((k) => !("value" in ds[k]!))
  )
    throw controlledNeonHeld();
  return Object.fromEntries(keys.map((k) => [k, ds[k]!.value]));
}
export function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
export function snapshotControlledNeonParameters(
  profile: ControlledNeonProfile,
  text: unknown,
  values: unknown,
): readonly string[] {
  const statement = Object.values(profile.statements).find((s) => s.text === text);
  if (!statement || !Array.isArray(values)) throw controlledNeonHeld();
  const ds = Object.getOwnPropertyDescriptors(values) as unknown as Record<
      string,
      PropertyDescriptor
    >,
    length = ds.length?.value;
  if (
    length !== statement.arity ||
    Reflect.ownKeys(values).length !== length + 1 ||
    Reflect.ownKeys(values).some((k) => typeof k !== "string") ||
    Object.keys(ds).some((k) => k !== "length" && !/^(0|[1-9][0-9]*)$/.test(k))
  )
    throw controlledNeonHeld();
  let total = 0;
  const copied = Array.from({ length }, (_, i) => {
    const d = ds[String(i)];
    if (!d || !("value" in d) || typeof d.value !== "string") throw controlledNeonHeld();
    const value = d.value;
    if (value.length > statement.maximum || value.includes("\0") || !wellFormed(value))
      throw controlledNeonHeld();
    total += value.length;
    if (total > 16384) throw controlledNeonHeld();
    return value;
  });
  return Object.freeze(copied);
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return year > 0 && day <= days[month - 1]!;
}
const tupleKeys = [
  "backend_pid",
  "current_role",
  "session_role",
  "database_name",
  "self_pid",
  "self_database",
  "self_role",
  "application_name",
  "backend_start",
];
export type ControlledNeonTuple = Readonly<{
  pid: string;
  start: string;
  database: string;
  role: string;
  applicationName: string;
}>;
export function controlledNeonTuple(
  rows: unknown,
  expected: { role: string; database: string; applicationName: string },
  observer = false,
): ControlledNeonTuple {
  if (
    !Array.isArray(rows) ||
    Reflect.ownKeys(rows).sort().join(",") !== "0,length" ||
    Object.getOwnPropertyDescriptor(rows, "length")?.value !== 1
  )
    throw controlledNeonHeld();
  const entry = Object.getOwnPropertyDescriptor(rows, "0");
  if (!entry || !("value" in entry)) throw controlledNeonHeld();
  const r = ownRecord(entry.value, observer ? [...tupleKeys, "primary_present"] : tupleKeys);
  if (
    typeof r.backend_pid !== "string" ||
    !/^[1-9][0-9]{0,9}$/.test(r.backend_pid) ||
    Number(r.backend_pid) > 2147483647 ||
    r.self_pid !== r.backend_pid ||
    r.current_role !== expected.role ||
    r.session_role !== expected.role ||
    r.self_role !== expected.role ||
    r.database_name !== expected.database ||
    r.self_database !== expected.database ||
    r.application_name !== expected.applicationName ||
    !timestamp(r.backend_start) ||
    (observer && r.primary_present !== false)
  )
    throw controlledNeonHeld();
  return Object.freeze({
    pid: r.backend_pid,
    start: r.backend_start,
    database: expected.database,
    role: expected.role,
    applicationName: expected.applicationName,
  });
}
