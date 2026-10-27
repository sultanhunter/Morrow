import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  createRuntimeAttempt,
  listPendingStarts,
  runLeaseStep,
  runtimeExecutorProfile,
  type LeaseRef,
  type LeaseStep,
} from "../../../packages/work/src/runtime/leases.js";
import { createDelegationAuthority } from "../../../packages/work/src/loop/authority.js";
import type { AgentRunPorts } from "../../../packages/work/src/loop/runner.js";
import {
  listAgentPendingStarts,
  resolveAgentRunLease,
} from "../../../packages/work/src/loop/steps.js";
import { builtInToolHandlers, createToolHandlers } from "../../../packages/work/src/loop/tools.js";
import {
  createProductReader,
  type ListingsRunPorts,
} from "../../../packages/work/src/runs/workflow.js";
import { runtimeProductReadAvailable } from "../../../packages/identity/src/broker-protocol.js";
import { mapOrchestratorEnvironment, type OrchestratorEnvironmentMapping } from "./environment.js";
import { agentAnswerEvent, legacyAgentRunStart, runAgentWorkflow } from "./agent-run.js";
import { runListingsWorkflow } from "./listings-run.js";
import { createRuntimePool } from "./runtime-pool.js";
import { keepRuntimeSweep } from "./runtime-sweep.js";

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
// Build order PR 11: AgentRunWorkflow (agent-run@1), one instance per agent run, its id the
// run id, its payload AgentRunParams@1 (ids only). It is dispatched only while the reviewed
// agent-loop switch is on as well (environment.ts agentRuns); otherwise it throws
// dispatch_disabled before any step. The same cron lists queued agent runs (ids only,
// agent_run_pending_starts): a new run starts its Workflow, a run whose question was answered
// wakes its waiting Workflow (agent-run-answer), and every agent run's lease is kept out of
// ListingsRunWorkflow's starts. This build composes one tool handler, inbox.ask.

// M2 PR-3's RuntimeBroker.shopifyRead(productContent): the api's admission shares it. Not
// exported: workerd refuses to start a module whose named export is neither a function nor
// an object (tests/orchestrator.test.mjs, lab:edge-workers).
const productReadAvailable = runtimeProductReadAvailable;
const stepBudgetMs = 25_000;

interface Selected {
  readonly mapping: OrchestratorEnvironmentMapping;
  readonly ports: ListingsRunPorts | null;
  readonly agentPorts: AgentRunPorts | null;
}
const selections = new WeakMap<object, Selected>();
function select(env: unknown): Selected {
  if (env === null || typeof env !== "object")
    return {
      mapping: { ok: false, code: "ORCHESTRATOR_ENV_RECORD_INVALID" },
      ports: null,
      agentPorts: null,
    };
  const existing = selections.get(env);
  if (existing) return existing;
  const mapping = mapOrchestratorEnvironment(env);
  let selected: Selected = { mapping, ports: null, agentPorts: null };
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
      let agentPorts: AgentRunPorts | null = null;
      if (mapping.agentRuns !== null) {
        const now = () => Date.now();
        agentPorts = Object.freeze({
          lease: ports.lease,
          async resolveLease(organizationId: string, workspaceId: string, runId: string) {
            const attempt = createRuntimeAttempt(stepBudgetMs, new AbortController().signal);
            try {
              const r = await resolveAgentRunLease(
                pool,
                attempt,
                runtimeExecutorProfile,
                organizationId,
                workspaceId,
                runId,
              );
              return r.ok ? r.value : ("failed" as const);
            } finally {
              attempt.end();
            }
          },
          modelTurn: (leaseId: string, generation: number, callJson: string, budgetMs: number) =>
            mapping.broker.modelTurn(leaseId, generation, callJson, budgetMs),
          tools: createToolHandlers(builtInToolHandlers),
          authority: createDelegationAuthority({ environment: mapping.environment, now }),
          now,
          sleep: ports.sleep,
        });
      }
      selected = { mapping, ports, agentPorts };
    } catch {
      selected = { mapping, ports: null, agentPorts: null };
    }
  selections.set(env, selected);
  console.log(
    JSON.stringify({
      event: "morrow_orchestrator_bound",
      dispatch: selected.ports !== null,
      agentLoop: selected.agentPorts !== null,
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

export class AgentRunWorkflow extends WorkflowEntrypoint<unknown, unknown> {
  async run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<string> {
    return runAgentWorkflow(select(this.env).agentPorts, event, step);
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
    const attempt = createRuntimeAttempt(stepBudgetMs, new AbortController().signal);
    let started = 0;
    let agentStarted = 0;
    let agentWoken = 0;
    try {
      const pool = createRuntimePool(mapping.binding, mapping.broker);
      const pending = await listPendingStarts(pool, attempt);
      if (!pending.ok) return;
      // Every agent run's lease (a run lease too) is kept out of ListingsRunWorkflow's starts.
      const agents = await listAgentPendingStarts(pool, attempt, runtimeExecutorProfile);
      if (!agents.ok) return;
      const agentLeases = new Set(agents.value.map((a) => a.leaseId));
      if (mapping.agentRuns !== null && selected.agentPorts !== null)
        for (const a of agents.value)
          try {
            // The PR 11 runner's one segment (<runId>-s1-i1); H7b's segment rolls, wakes
            // (w-<waitSeq>) and sweep replace this start and answer event.
            const start = legacyAgentRunStart(a);
            if (a.resume) {
              const instance = await mapping.agentRuns.get(start.id);
              await instance.sendEvent({ type: agentAnswerEvent, payload: {} });
              agentWoken += 1;
            } else {
              await mapping.agentRuns.create({ id: start.id, params: start.params });
              agentStarted += 1;
            }
          } catch {
            // An existing instance id means it already started; a lost event is found by
            // the waiting Workflow's own hourly resume check.
          }
      for (const p of pending.value) {
        if (p.kind !== "run" || agentLeases.has(p.leaseId)) continue;
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
      console.log(
        JSON.stringify({ event: "morrow_orchestrator_cron", started, agentStarted, agentWoken }),
      );
    }
  },
};
