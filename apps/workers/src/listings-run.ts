import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { parseLeaseRef } from "../../../packages/work/src/runtime/leases.js";
import {
  listingsRun,
  RunStepRetry,
  type ListingsRunPorts,
} from "../../../packages/work/src/runs/workflow.js";

// ListingsRunWorkflow.run's body (M3 PR-2), in a module of its own: orchestrator.ts's named
// exports are its workerd entrypoints, and tests/orchestrator.test.mjs drives this body with
// fake ports and a fake step (the run id passed on is the Workflow's instance id).

/** The durable step options of every ListingsRunWorkflow step. */
export const runStepOptions = Object.freeze({
  retries: Object.freeze({ limit: 4, delay: "15 seconds", backoff: "exponential" }),
  // A product step makes up to two model calls, each sized for its effort's whole reply
  // (runModelBudgetMs), so a step may outlast the 10-minute default; no step outlives the
  // run's 30-minute lease.
  timeout: "30 minutes",
} as const);
/**
 * ListingsRunWorkflow.run's body: dispatch disabled without ports (before any step),
 * the payload parsed as the lease reference only, and the run is the Workflow's instance id
 * (its lease's subject, which the start step checks and the product read names). Each step
 * is Cloudflare's step.do with runStepOptions: a RunStepRetry is retried by the Workflow;
 * anything else is a fault that retrying would repeat.
 */
export async function runListingsWorkflow(
  ports: ListingsRunPorts | null,
  event: Readonly<WorkflowEvent<unknown>>,
  step: WorkflowStep,
): Promise<string> {
  if (!ports) throw new NonRetryableError("dispatch_disabled");
  const ref = parseLeaseRef(event.payload);
  if (!ref) throw new NonRetryableError("payload_invalid");
  const result = await listingsRun(
    ports,
    {
      do: <T>(name: string, body: () => Promise<T>) =>
        step.do(name, runStepOptions, async () => {
          try {
            return (await body()) as never;
          } catch (error) {
            if (error instanceof RunStepRetry) throw error;
            throw new NonRetryableError("step_fault");
          }
        }) as Promise<T>,
    },
    ref,
    event.instanceId,
  );
  return result.kind;
}
