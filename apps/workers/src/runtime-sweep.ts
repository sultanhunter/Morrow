import { runtimeGatewayLimits } from "../../../packages/identity/src/broker-protocol.js";

// The scheduled clean-up of leftover sandboxes (ADR-0029 items 2 and 9; build order PR 8). On
// every fifth minute of the orchestrator's one-minute cron it asks the broker to sweep
// (RuntimeBroker.runtimeSweep): reconcile stale runtime operations by their metadata, and kill
// any sandbox a stop (platform, connection or installation), an ended lease or an expired one
// has cut off. It runs whatever the model-provider switch, dispatch, a stop or a runtime hold
// says: nothing here creates, and cleanup is never blocked. The broker's runtime switch
// decides: off (the committed state) answers BROKER_HELD before any database or provider
// access; cleanup_only and on sweep. The orchestrator holds no credential: it reads only its
// environment's name and the RuntimeBroker binding, and logs counts, never ids.

export const runtimeSweepSchedule = Object.freeze({
  everyMinutes: 5,
  budgetMs: 120_000,
});
export type RuntimeSweepOutcome = "swept" | "held" | "not_due" | "unbound";
interface Sweeper {
  runtimeSweep(budgetMs: number): Promise<string>;
}
function own(record: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
const counts = ["examined", "killed", "absentVerified", "unknown", "skipped"] as const;

/** One scheduled sweep, if due. Never throws; one log line with the outcome and counts. */
export async function sweepRuntimeOnSchedule(
  controller: unknown,
  env: unknown,
): Promise<RuntimeSweepOutcome> {
  const scheduledTime =
    controller !== null && typeof controller === "object"
      ? own(controller, "scheduledTime")
      : undefined;
  if (
    typeof scheduledTime !== "number" ||
    !Number.isSafeInteger(scheduledTime) ||
    Math.floor(scheduledTime / 60_000) % runtimeSweepSchedule.everyMinutes !== 0
  )
    return "not_due";
  let outcome: RuntimeSweepOutcome = "unbound";
  let swept: Record<string, number> | null = null;
  try {
    const environment =
      env !== null && typeof env === "object" ? own(env, "MORROW_ENVIRONMENT") : null;
    const broker = env !== null && typeof env === "object" ? own(env, "BROKER") : null;
    if (
      (environment === "development" || environment === "staging") &&
      broker !== null &&
      typeof broker === "object" &&
      typeof (broker as Partial<Sweeper>).runtimeSweep === "function"
    ) {
      try {
        const reply: unknown = JSON.parse(
          await (broker as Sweeper).runtimeSweep(
            Math.min(runtimeSweepSchedule.budgetMs, runtimeGatewayLimits.sweepBudgetMaxMs),
          ),
        );
        swept = {};
        for (const name of counts) {
          const value = reply !== null && typeof reply === "object" ? own(reply, name) : undefined;
          swept[name] = typeof value === "number" && Number.isSafeInteger(value) ? value : -1;
        }
        outcome = "swept";
      } catch {
        outcome = "held";
      }
    }
  } catch {
    outcome = "unbound";
  }
  console.log(
    JSON.stringify({ event: "morrow_orchestrator_runtime_sweep", outcome, ...(swept ?? {}) }),
  );
  return outcome;
}

/** The cron's hook: the sweep runs beside the pending starts, kept alive by waitUntil. */
export function keepRuntimeSweep(controller: unknown, env: unknown, ctx: unknown): void {
  const pending = sweepRuntimeOnSchedule(controller, env);
  const waitUntil =
    ctx !== null && typeof ctx === "object"
      ? (ctx as { waitUntil?: unknown }).waitUntil
      : undefined;
  if (typeof waitUntil === "function") waitUntil.call(ctx, pending);
}
