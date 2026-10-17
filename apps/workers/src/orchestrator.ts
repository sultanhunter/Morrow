import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

// morrow-<env>-orchestrator (P04.T02a D8). Dispatch is hard-disabled until the
// P11 gateway, budget reservations and stop controls exist (Security invariant
// 15): the Workflow fails before any step, the Queue consumer never acks (so
// messages end in the dead-letter queue) and there is no producer.

export class MorrowWorkWorkflow extends WorkflowEntrypoint<unknown, unknown> {
  async run(_event: Readonly<WorkflowEvent<unknown>>, _step: WorkflowStep): Promise<never> {
    throw new NonRetryableError("dispatch_disabled");
  }
}

export default {
  fetch(): Response {
    return new Response('{"code":"not_found"}', {
      status: 404,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
  queue(batch: MessageBatch<unknown>): void {
    batch.retryAll();
    console.log(JSON.stringify({ event: "morrow_orchestrator_dispatch_disabled" }));
  },
};
