import { schedulesV2On, schedulesV2Var } from "../../../packages/identity/src/broker-protocol.js";
import type { FixedSqlPool } from "../../../packages/identity/src/fixed-sql-transaction.js";
import { createRuntimeAttempt } from "../../../packages/work/src/runtime/leases.js";
import {
  fireDueSchedules,
  listScheduleTenantsDue,
} from "../../../packages/work/src/schedules/fire.js";

// The cron's schedule firing (ADR-0043 item 9; plan row SD12), on the orchestrator's one-minute
// cron, only while the reviewed schedules-v2 switch is on (its var exactly "on") and the
// orchestrator is bound to its database (environment.ts). Under an explicit time budget (time,
// not money): one transaction lists the due tenants (ids only), then each tenant's due
// schedules fire in passes of their own transactions, oldest due first, until the tenant has
// no more due or the run's budget is spent; whatever is left is due again at the next minute.
// The database decides every slot, so a late, repeated or concurrent run fires nothing twice
// (one trigger row per sched:<schedule id>:<slot UTC>). One log line of counts, never ids.

export const scheduleFireBudget = Object.freeze({
  /** The whole run, inside the one-minute cron. */
  runMs: 25_000,
  /** One transaction (the leases' profile caps a statement at 2 s and a transaction at 5 s). */
  transactionMs: 5_000,
  /** Passes for one tenant in one run (each examines at most 25 schedules). */
  passesPerTenant: 4,
});
export type ScheduleFireRunOutcome = "fired" | "unavailable";
export interface ScheduleFireRun {
  readonly outcome: ScheduleFireRunOutcome;
  readonly tenants: number;
  readonly passes: number;
  readonly fired: number;
  readonly duplicate: number;
  readonly dropped: number;
  readonly ended: number;
  readonly unavailable: number;
  readonly unfinished: number;
}

function own(record: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
/** Whether the switch's var is exactly "on" on this Worker. */
export function schedulesSwitchOn(env: unknown): boolean {
  try {
    return env !== null && typeof env === "object" && own(env, schedulesV2Var) === schedulesV2On;
  } catch {
    return false;
  }
}

/** One cron run over the due tenants. Never throws. */
export async function fireSchedulesOnCron(
  pool: FixedSqlPool,
  now: () => number = Date.now,
): Promise<ScheduleFireRun> {
  const deadline = now() + scheduleFireBudget.runMs;
  const counts = {
    tenants: 0,
    passes: 0,
    fired: 0,
    duplicate: 0,
    dropped: 0,
    ended: 0,
    unavailable: 0,
    unfinished: 0,
  };
  const step = async <T>(
    body: (attempt: ReturnType<typeof createRuntimeAttempt>) => Promise<T>,
  ): Promise<T | null> => {
    const left = deadline - now();
    if (left < 1) return null;
    const attempt = createRuntimeAttempt(
      Math.min(scheduleFireBudget.transactionMs, left),
      new AbortController().signal,
      now,
    );
    try {
      return await body(attempt);
    } catch {
      return null;
    } finally {
      attempt.end();
    }
  };
  let outcome: ScheduleFireRunOutcome = "fired";
  const listed = await step((attempt) => listScheduleTenantsDue(pool, attempt));
  if (listed === null || !listed.ok) {
    outcome = "unavailable";
    counts.unavailable += 1;
  } else {
    counts.tenants = listed.value.length;
    for (const scheduleId of listed.value) {
      let finished = false;
      for (let pass = 0; pass < scheduleFireBudget.passesPerTenant; pass++) {
        const result = await step((attempt) => fireDueSchedules(pool, attempt, scheduleId));
        if (result === null || !result.ok) {
          counts.unavailable += 1;
          break;
        }
        counts.passes += 1;
        const r = result.value;
        if (r.outcome !== "fired") {
          finished = true;
          break;
        }
        counts.fired += r.fired;
        counts.duplicate += r.duplicate;
        counts.dropped += r.dropped;
        counts.ended += r.ended;
        if (!r.more) {
          finished = true;
          break;
        }
      }
      if (!finished) counts.unfinished += 1;
      if (now() >= deadline) break;
    }
  }
  const run: ScheduleFireRun = Object.freeze({ outcome, ...counts });
  console.log(JSON.stringify({ event: "morrow_orchestrator_schedules", ...run }));
  return run;
}

/** The cron's hook: the firing pass beside the pending starts, kept alive by waitUntil. */
export function keepScheduleFiring(pool: FixedSqlPool, ctx: unknown): void {
  const pending = fireSchedulesOnCron(pool);
  const waitUntil =
    ctx !== null && typeof ctx === "object"
      ? (ctx as { waitUntil?: unknown }).waitUntil
      : undefined;
  if (typeof waitUntil === "function") waitUntil.call(ctx, pending);
}
