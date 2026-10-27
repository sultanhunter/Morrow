import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  agentRun,
  agentRunInstanceId,
  AgentRunRetry,
  legacyAgentRunSegment,
  parseAgentRunParams,
  type AgentRunPorts,
} from "../../../packages/work/src/loop/runner.js";

// AgentRunWorkflow.run's body (build order PR 11; ADR-0027 item 1), in a module of its own:
// orchestrator.ts's named exports are its workerd entrypoints, and tests/orchestrator.test.mjs
// drives this body with fake ports and a fake step. The payload is AgentRunParams@1 (ids
// only: the run, its segment and incarnation) and the Workflow's instance id must be
// <runId>-s<segment>-i<incarnation> (ADR-0041 item 6); everything else is read from the run's
// manifest under its lease. Dispatch is disabled (dispatch_disabled before any step) unless
// the reviewed agent-loop switch is on with its bindings (environment.ts), and that switch
// cannot go on before H7b's runner replaces this one (its harness_runner prerequisite), so the
// PR 11 runner here only ever runs segment 1, incarnation 1 (legacyAgentRunSegment).

/** The event the cron sends a waiting run's Workflow once its answer opened a lease. */
export const agentAnswerEvent = "agent-run-answer";
/** The PR 11 runner's one segment's instance id and params (ADR-0041 item 6's id rule). */
export function legacyAgentRunStart(run: {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly runId: string;
}) {
  const params = Object.freeze({
    schemaVersion: 1 as const,
    workflow: "agent-run@1" as const,
    organizationId: run.organizationId,
    workspaceId: run.workspaceId,
    runId: run.runId,
    ...legacyAgentRunSegment,
  });
  return Object.freeze({ id: agentRunInstanceId(params), params });
}
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
  if (
    !params ||
    params.segment !== legacyAgentRunSegment.segment ||
    params.incarnation !== legacyAgentRunSegment.incarnation ||
    event.instanceId !== agentRunInstanceId(params)
  )
    throw new NonRetryableError("payload_invalid");
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
