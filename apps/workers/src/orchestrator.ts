import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  createRuntimeAttempt,
  listPendingStarts,
  runLeaseStep,
  type LeaseRef,
  type LeaseStep,
} from "../../../packages/work/src/runtime/leases.js";
import {
  createProductReader,
  type ListingsRunPorts,
} from "../../../packages/work/src/runs/workflow.js";
import { runtimeProductReadAvailable } from "../../../packages/identity/src/broker-protocol.js";
import { mapOrchestratorEnvironment, type OrchestratorEnvironmentMapping } from "./environment.js";
import { runListingsWorkflow } from "./listings-run.js";
import { createRuntimePool } from "./runtime-pool.js";
import { keepRuntimeSweep } from "./runtime-sweep.js";
import { keepScheduleFiring, schedulesSwitchOn } from "./schedule-fire.js";

// morrow-<env>-orchestrator (P04.T02a D8; M3 PR-2, mvp-architecture §2 steps 8, 9 and 15 and
// §3). ListingsRunWorkflow replaces the placeholder MorrowWorkWorkflow: one instance per run,
// its id the run id, its payload the run lease reference only (ids, spine §11). The cron
// starts every run that pending_starts() lists (ids only, the one cross-tenant read); the
// dispatch Queue consumer still never acks (no producer exists: run admission's start is the
// cron, and an api producer is a follow-up). Dispatch is disabled, and every Workflow throws
// dispatch_disabled before any step, unless the reviewed model-provider switch is on with the
// reviewed database binding and the RuntimeBroker and Workflow bindings (environment.ts).
// M2 PR-3's product read exists since the integration of M2 PR-3 and M3 PR-2
// (productReadAvailable, a reviewed constant), so the model-provider switch (on in staging
// since model-provider-on, 2026-10-25) is the only gate. OperationWorkflow joins in M4.

// M2 PR-3's RuntimeBroker.shopifyRead(productContent): the api's admission shares it. Not
// exported: workerd refuses to start a module whose named export is neither a function nor
// an object (tests/orchestrator.test.mjs, lab:edge-workers).
const productReadAvailable = runtimeProductReadAvailable;
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
        // The product read (spine §4): M2 PR-3's RuntimeBroker.shopifyRead(productContent)
        // under the run lease, named by the run id (createProductReader, workflow.ts).
        readProduct: createProductReader(mapping.broker),
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

export class ListingsRunWorkflow extends WorkflowEntrypoint<unknown, unknown> {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<string> {
    return runListingsWorkflow(select(this.env).ports, event, step);
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
  async scheduled(controller: unknown, env: unknown, ctx?: unknown): Promise<void> {
    // Build order PR 8: the runtime's clean-up, whatever dispatch says (runtime-sweep.ts).
    keepRuntimeSweep(controller, env, ctx);
    const selected = select(env);
    if (!selected.ports || !selected.mapping.ok) {
      console.log(JSON.stringify({ event: "morrow_orchestrator_dispatch_disabled" }));
      return;
    }
    const mapping = selected.mapping;
    // Plan row SD12: due schedules fire only while the reviewed schedules-v2 switch is on
    // (schedule-fire.ts), beside the pending starts and in transactions of their own.
    if (schedulesSwitchOn(env))
      keepScheduleFiring(createRuntimePool(mapping.binding, mapping.broker), ctx);
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
