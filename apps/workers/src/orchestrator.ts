import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  createRuntimeAttempt,
  listPendingStarts,
  parseLeaseRef,
  runLeaseStep,
  type LeaseRef,
  type LeaseStep,
} from "../../../packages/work/src/runtime/leases.js";
import type { ListingSnapshot } from "../../../packages/work/src/runs/drafting.js";
import {
  listingsRun,
  RunStepRetry,
  type ListingsRunPorts,
  type ProductRead,
} from "../../../packages/work/src/runs/workflow.js";
import { runtimeProductReadAvailable } from "../../../packages/identity/src/broker-protocol.js";
import { mapOrchestratorEnvironment, type OrchestratorEnvironmentMapping } from "./environment.js";
import { createRuntimePool } from "./runtime-pool.js";

// morrow-<env>-orchestrator (P04.T02a D8; M3 PR-2, mvp-architecture §2 steps 8, 9 and 15 and
// §3). ListingsRunWorkflow replaces the placeholder MorrowWorkWorkflow: one instance per run,
// its id the run id, its payload the run lease reference only (ids, spine §11). The cron
// starts every run that pending_starts() lists (ids only, the one cross-tenant read); the
// dispatch Queue consumer still never acks (no producer exists: run admission's start is the
// cron, and an api producer is a follow-up). Dispatch is disabled, and every Workflow throws
// dispatch_disabled before any step, unless the reviewed model-provider switch is on with the
// reviewed database binding, the RuntimeBroker and Workflow bindings (environment.ts), and
// the product read of M2 PR-3 exists (productReadAvailable). OperationWorkflow joins in M4.

/** M2 PR-3's RuntimeBroker.shopifyRead(productContent): the api's admission shares it. */
export const productReadAvailable = runtimeProductReadAvailable;
const productBudgetMs = 15_000;
const stepBudgetMs = 25_000;

interface Selected {
  readonly mapping: OrchestratorEnvironmentMapping;
  readonly ports: ListingsRunPorts | null;
}
const selections = new WeakMap<object, Selected>();
function select(env: unknown): Selected {
  if (env === null || typeof env !== "object")
    return { mapping: { ok: false, code: "ORCHESTRATOR_ENV_RECORD_INVALID" }, ports: null };
  const existing = selections.get(env);
  if (existing) return existing;
  const mapping = mapOrchestratorEnvironment(env);
  let selected: Selected = { mapping, ports: null };
  if (mapping.ok && productReadAvailable)
    try {
      const pool = createRuntimePool(mapping.binding, mapping.broker);
      const ports: ListingsRunPorts = Object.freeze({
        async lease<T>(ref: LeaseRef, body: (step: LeaseStep) => Promise<T>) {
          const attempt = createRuntimeAttempt(stepBudgetMs, new AbortController().signal);
          try {
            const result = await runLeaseStep(pool, attempt, ref, body);
            return result.ok ? result.value : ("failed" as const);
          } finally {
            attempt.end();
          }
        },
        modelRespond: (leaseId: string, generation: number, callJson: string, budgetMs: number) =>
          mapping.broker.modelRespond(leaseId, generation, callJson, budgetMs),
        readProduct: (ref: LeaseRef, runId: string, productId: string) =>
          readProduct(mapping, ref, runId, productId),
        environment: mapping.environment,
        now: () => Date.now(),
        sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        ids: () => crypto.randomUUID(),
      });
      selected = { mapping, ports };
    } catch {
      selected = { mapping, ports: null };
    }
  selections.set(env, selected);
  console.log(
    JSON.stringify({
      event: "morrow_orchestrator_bound",
      dispatch: selected.ports !== null,
      code: mapping.ok ? null : mapping.code,
    }),
  );
  return selected;
}

// The product read (spine §4): M2 PR-3's broker method, minimised JSON of one product's
// listing fields. The orchestrator accepts exactly {schemaVersion 1, outcome read, product}
// or {schemaVersion 1, outcome not_found}; anything else is unavailable.
async function readProduct(
  mapping: OrchestratorEnvironmentMapping,
  ref: LeaseRef,
  runId: string,
  productId: string,
): Promise<ProductRead> {
  if (!mapping.ok) return { outcome: "unavailable" };
  try {
    const text = await mapping.broker.shopifyRead(
      ref.leaseId,
      ref.generation,
      runId,
      "productContent",
      JSON.stringify({ productId }),
      productBudgetMs,
    );
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value?.schemaVersion === 1 && value.outcome === "not_found")
      return { outcome: "not_found" };
    if (
      value?.schemaVersion === 1 &&
      value.outcome === "read" &&
      value.product &&
      typeof value.product === "object"
    )
      return { outcome: "read", product: value.product as ListingSnapshot };
    return { outcome: "unavailable" };
  } catch {
    return { outcome: "unavailable" };
  }
}

export class ListingsRunWorkflow extends WorkflowEntrypoint<unknown, unknown> {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<string> {
    const selected = select(this.env);
    if (!selected.ports) throw new NonRetryableError("dispatch_disabled");
    const ref = parseLeaseRef(event.payload);
    if (!ref) throw new NonRetryableError("payload_invalid");
    const ports = selected.ports;
    const result = await listingsRun(
      ports,
      {
        do: <T>(name: string, body: () => Promise<T>) =>
          step.do(
            name,
            {
              retries: { limit: 4, delay: "15 seconds", backoff: "exponential" },
              // A product step makes up to two model calls, each sized for its effort's whole
              // reply (runModelBudgetMs), so a step may outlast the 10-minute default; no
              // step outlives the run's 30-minute lease.
              timeout: "30 minutes",
            },
            async () => {
              try {
                return (await body()) as never;
              } catch (error) {
                // A RunStepRetry is retried by the Workflow; anything else is a fault that
                // retrying would repeat.
                if (error instanceof RunStepRetry) throw error;
                throw new NonRetryableError("step_fault");
              }
            },
          ) as Promise<T>,
      },
      ref,
      event.instanceId,
    );
    return result.kind;
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
  async scheduled(_controller: unknown, env: unknown): Promise<void> {
    const selected = select(env);
    if (!selected.ports || !selected.mapping.ok) {
      console.log(JSON.stringify({ event: "morrow_orchestrator_dispatch_disabled" }));
      return;
    }
    const mapping = selected.mapping;
    const attempt = createRuntimeAttempt(stepBudgetMs, new AbortController().signal);
    let started = 0;
    try {
      const pending = await listPendingStarts(
        createRuntimePool(mapping.binding, mapping.broker),
        attempt,
      );
      if (!pending.ok) return;
      for (const p of pending.value) {
        if (p.kind !== "run") continue;
        try {
          await mapping.workflow.create({
            id: p.subjectId,
            params: { leaseId: p.leaseId, generation: p.generation },
          });
          started += 1;
        } catch {
          // An existing instance id means it already started.
        }
      }
    } finally {
      attempt.end();
      console.log(JSON.stringify({ event: "morrow_orchestrator_cron", started }));
    }
  },
};
