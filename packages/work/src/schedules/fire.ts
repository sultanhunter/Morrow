import {
  runFixedSqlTransaction,
  type FixedSqlAttempt,
  type FixedSqlOutcome,
  type FixedSqlPool,
} from "../../../identity/src/fixed-sql-transaction.js";
import { runtimeExecutorProfile } from "../runtime/leases.js";

// The orchestrator's schedule firing (ADR-0043 item 9; plan row SD12; migration
// schedules-shop-zone). Two source-fixed statements of the runtime executor's login, each in a
// transaction of its own under the leases' profile (the D5 role preflight and the timeouts):
// the cross-tenant list of due tenants, ids only (one due schedule id per tenant), and one
// firing pass per tenant, named by that schedule's id, whose answer is counts only. The
// database computes every slot itself, so nothing here passes a time, a slot, a tenant or a
// zone: a caller can only ask a tenant's due schedules to fire now. Workers code: no node:*.

export const scheduleFireSql = Object.freeze({
  tenantsDue: "SELECT schedule_id FROM morrow_work.schedule_tenants_due()",
  fire: "SELECT outcome,examined,fired,duplicate,dropped,ended,more FROM morrow_work.fire_due_schedules($1)",
});
/** The most tenants one list names (the definer's own LIMIT). */
export const scheduleTenantsPerList = 50;
/** The most schedules one firing pass examines (the definer's own cap). */
export const schedulesPerFire = 25;

export interface ScheduleFireCounts {
  readonly examined: number;
  readonly fired: number;
  readonly duplicate: number;
  readonly dropped: number;
  readonly ended: number;
  /** More due schedules of the tenant remain for another pass. */
  readonly more: boolean;
}
export type ScheduleFireResult =
  | (Readonly<{ outcome: "fired" }> & ScheduleFireCounts)
  | Readonly<{ outcome: "not_found" | "invalid" | "denied" }>;

const held = () => Error("SCHEDULE_FIRE_HELD");
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
const count = (value: unknown, max: number): number => {
  if (!exact(/^(0|[1-9][0-9]{0,3})$/, value)) throw held();
  const n = Number(value);
  if (n > max) throw held();
  return n;
};
const keysOf = (row: unknown): string =>
  row !== null && typeof row === "object" ? Object.keys(row).sort().join(",") : "";

/** The cross-tenant list's strict decoder: distinct schedule ids, at most 50. */
export function decodeScheduleTenantsDue(rows: unknown): readonly string[] {
  if (!Array.isArray(rows) || rows.length > scheduleTenantsPerList) throw held();
  const seen = new Set<string>();
  for (const row of rows) {
    if (keysOf(row) !== "schedule_id") throw held();
    const id = (row as { schedule_id: unknown }).schedule_id;
    if (!exact(uuid, id) || seen.has(id)) throw held();
    seen.add(id);
  }
  return Object.freeze([...seen]);
}
const fireNames = ["dropped", "duplicate", "ended", "examined", "fired", "more", "outcome"].join(
  ",",
);
/** One firing pass's strict decoder: exactly one row of closed values. */
export function decodeScheduleFire(rows: unknown): ScheduleFireResult {
  if (!Array.isArray(rows) || rows.length !== 1 || keysOf(rows[0]) !== fireNames) throw held();
  const r = rows[0] as Record<string, unknown>;
  if (r.outcome === "not_found" || r.outcome === "invalid" || r.outcome === "denied") {
    if (
      ["examined", "fired", "duplicate", "dropped", "ended"].some((k) => r[k] !== "0") ||
      r.more !== "false"
    )
      throw held();
    return Object.freeze({ outcome: r.outcome });
  }
  if (r.outcome !== "fired" || (r.more !== "true" && r.more !== "false")) throw held();
  const examined = count(r.examined, schedulesPerFire);
  const fired = count(r.fired, examined);
  const duplicate = count(r.duplicate, examined);
  const dropped = count(r.dropped, examined);
  const ended = count(r.ended, examined);
  if (fired + duplicate > examined) throw held();
  return Object.freeze({
    outcome: "fired",
    examined,
    fired,
    duplicate,
    dropped,
    ended,
    more: r.more === "true",
  });
}

/** The due tenants, as one due schedule id each, oldest due first. */
export function listScheduleTenantsDue(
  pool: FixedSqlPool,
  attempt: FixedSqlAttempt,
): Promise<FixedSqlOutcome<readonly string[]>> {
  return runFixedSqlTransaction(pool, attempt, runtimeExecutorProfile, async (query) =>
    decodeScheduleTenantsDue(await query(scheduleFireSql.tenantsDue)),
  );
}
/** One firing pass over the due schedules of the tenant of `scheduleId`. */
export function fireDueSchedules(
  pool: FixedSqlPool,
  attempt: FixedSqlAttempt,
  scheduleId: string,
): Promise<FixedSqlOutcome<ScheduleFireResult>> {
  if (!exact(uuid, scheduleId)) return Promise.reject(held());
  return runFixedSqlTransaction(pool, attempt, runtimeExecutorProfile, async (query) =>
    decodeScheduleFire(await query(scheduleFireSql.fire, [scheduleId])),
  );
}
