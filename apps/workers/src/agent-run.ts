import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  agentRun,
  AgentRunRetry,
  parseAgentRunParams,
  type AgentRunPorts,
} from "../../../packages/work/src/loop/runner.js";

// AgentRunWorkflow.run's body (build order PR 11; ADR-0027 item 1), in a module of its own:
// orchestrator.ts's named exports are its workerd entrypoints, and tests/orchestrator.test.mjs
// drives this body with fake ports and a fake step. The payload is AgentRunParams@1 (ids
// only) and its run id must be the Workflow's instance id; everything else is read from the
// run's manifest under its lease. Dispatch is disabled (dispatch_disabled before any step)
// unless the reviewed agent-loop switch is on with its bindings (environment.ts).

/** The event the cron sends a waiting run's Workflow once its answer opened a lease. */
export const agentAnswerEvent = "agent-run-answer";
/** The durable step options of every AgentRunWorkflow step (as ListingsRunWorkflow's). */
export const agentStepOptions = Object.freeze({
  retries: Object.freeze({ limit: 4, delay: "15 seconds", backoff: "exponential" }),
  // A turn step holds one call sized for its effort's whole reply (modelCallBudgetMs) and
  // its fence waits; no step outlives the run's 30-minute lease.
  timeout: "30 minutes",
} as const);

export async function runAgentWorkflow(
  ports: AgentRunPorts | null,
  event: Readonly<WorkflowEvent<unknown>>,
  step: WorkflowStep,
): Promise<string> {
  if (!ports) throw new NonRetryableError("dispatch_disabled");
  const params = parseAgentRunParams(event.payload);
  if (!params || params.runId !== event.instanceId) throw new NonRetryableError("payload_invalid");
  const result = await agentRun(
    ports,
    {
      do: <T>(name: string, body: () => Promise<T>) =>
        step.do(name, agentStepOptions, async () => {
          try {
            return (await body()) as never;
          } catch (error) {
            if (error instanceof AgentRunRetry) throw error;
            throw new NonRetryableError("step_fault");
          }
        }) as Promise<T>,
      async waitForAnswer(name: string, timeoutMs: number) {
        try {
          await step.waitForEvent(name, { type: agentAnswerEvent, timeout: timeoutMs });
          return "event" as const;
        } catch {
          // The wait timed out: the resume step looks for the answer's lease anyway.
          return "timeout" as const;
        }
      },
    },
    params,
  );
  return result.kind;
}
