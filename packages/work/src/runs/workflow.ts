import { validateCurrentDefinition } from "@morrow/contracts/validation";
import type { CapabilityId } from "@morrow/contracts";
import { createAgentAuthorityService } from "@morrow/policy/agent-authority";

import { storeResource } from "@morrow/policy/store-resource";
import { modelCallBudgetMs, modelGatewayLimits } from "../../../identity/src/broker-protocol.js";
import { generatedModelCatalogue } from "../../../policy/src/generated/model-catalogue.js";
import { createBillingFactsReader } from "../billing/facts.js";
import { createLeaseDelegationReader } from "../agents/delegation-reader.js";
import type { LeaseRef, LeaseStep, LeaseStepResult } from "../runtime/leases.js";
import type { ProductFailureCode, RunEndReason } from "../runtime/run-steps.js";
import { sha256Text } from "../approvals/digests.js";
import {
  checkDraft,
  runFieldsValid,
  snapshotCanonical,
  type ListingField,
  type ListingSnapshot,
} from "./drafting.js";
import { packListingProposals } from "./producer.js";

// ListingsRunWorkflow's logic (M3 PR-2; mvp-architecture §2 steps 8, 9 and 15; ADR-0022
// items 9-11), independent of Cloudflare so the unit tests and the PostgreSQL labs drive the
// same code the orchestrator deploys. Durable steps carry ids and codes only (spine §11): the
// request text, each product as read and each draft stay inside one step, in memory, and in
// the tenant's own tables. Every step reenters the run lease, so a stop, a removed member or
// an ended lease stops the run at its next step; decideDelegation reruns at every step
// (invariant 5), with the entitlement fact from M5's reader over run_billing_facts.
//   start    run_start (queued -> running, lease started).
//   product  one per product: decideDelegation (execute on catalog.content.propose, view on
//            catalog.products.read); run_product_begin (the breaker, the unrecovered-cost cap
//            and the reservation); the product read (M2 PR-3's shopifyRead productContent)
//            and its content-addressed snapshot; at most two attempts through the broker's
//            modelRespond (a resend after a throttle reuses the attempt); the code checks of
//            drafting.ts; run_product_finish. Outcomes follow ADR-0022 item 10: spend_limit
//            and provider_error end the run, incomplete, refusal, invalid output and
//            uncertain use the next attempt, input_over_cap fails the product at once.
//   propose  decideDelegation (propose on catalog.content.publish), the drafts packed by
//            bytes into Proposal@2 records, each submitted by the agent submit definer; it
//            also runs after a run-ending outcome, so drafted products are still proposed.
//   finish   run_finish: settles at the products proposed, ends the run, releases the lease.

export type ProductRead =
  | { readonly outcome: "read"; readonly product: ListingSnapshot }
  | { readonly outcome: "not_found" | "unavailable" };
export interface ListingsRunPorts {
  /** One transaction under the run lease (runLeaseStep over the runtime executor's pool). */
  lease<T>(
    ref: LeaseRef,
    body: (step: LeaseStep) => Promise<T>,
  ): Promise<LeaseStepResult<T> | "failed">;
  /** RuntimeBroker.modelRespond: a ModelResult@1 string, or a thrown BROKER_HELD. */
  modelRespond(
    leaseId: string,
    generation: number,
    callJson: string,
    budgetMs: number,
  ): Promise<string>;
  /** The product read of the run's store under the lease (M2 PR-3's shopifyRead productContent). */
  readProduct(ref: LeaseRef, productId: string): Promise<ProductRead>;
  // The billing environment of the entitlement fact (BillingEnvironment), named literally so
  // this module's declarations reach no policy source (the orchestrator's edge typecheck).
  readonly environment: "development" | "staging" | "production";
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly ids: () => string;
}
/** The durable step API (Cloudflare's WorkflowStep.do, or a test double). */
export interface DurableSteps {
  do<T>(name: string, body: () => Promise<T>): Promise<T>;
}
export type RunStepResult =
  | { readonly kind: "started"; readonly productCount: number; readonly leaseExpiresAtMs: number }
  | {
      readonly kind: "product";
      readonly index: number;
      readonly status: "drafted" | "failed" | "done";
      readonly stop: RunEndReason | null;
    }
  | { readonly kind: "proposed"; readonly proposals: number; readonly stop: RunEndReason | null }
  | { readonly kind: "ended"; readonly status: string }
  | { readonly kind: "interrupted"; readonly refusal: string };

export class RunStepRetry extends Error {
  constructor(readonly code: string) {
    super("LISTINGS_RUN_RETRY:" + code);
    this.name = "RunStepRetry";
  }
}
// One modelRespond's budget is sized per run from its effort's max_tokens
// (modelCallBudgetMs: the fence, the count and a send long enough for the whole reply at
// the floor output rate); a product step needs two such calls and a few throttle waits, so a
// product step does not start with less lease time left than productMarginMs(budget). A fence
// a dead broker left open blocks for its budget plus a minute (migration listings-runs).
export const runTimings = Object.freeze({
  /** At most this many resends of one attempt after a provider throttle. */
  sequences: 8,
  /** The longest wait the step itself makes before a resend. */
  maxWaitMs: 30_000,
  /** The throttle waits a product step's margin allows for. */
  throttleAllowanceMs: 60_000,
  /** How long an open fence outlives its budget before it is booked as uncertain. */
  fenceGraceMs: 60_000,
});
/**
 * The modelRespond budget of a run's selection. An entry this build's catalogue lacks gets
 * the protocol's longest budget; the broker checks every budget against the entry it
 * resolves itself and holds the call when it has no such entry (the run ends broker_held).
 */
export function runModelBudgetMs(catalogueVersion: number, model: string, effort: string): number {
  // The generated catalogue's data (no rules module): a published version, a model that
  // lists the effort, and the effort's max_tokens.
  const versions: readonly {
    readonly version: number;
    readonly status: string;
    readonly efforts: readonly { readonly key: string; readonly maxOutputTokens: number }[];
    readonly models: readonly {
      readonly key: string;
      readonly creditsPerProduct: Readonly<Record<string, number>>;
    }[];
  }[] = generatedModelCatalogue.versions;
  const v = versions.find((x) => x.version === catalogueVersion && x.status !== "proposed");
  const m = v?.models.find((x) => x.key === model);
  const e = v?.efforts.find((x) => x.key === effort);
  return v && m && e && Object.hasOwn(m.creditsPerProduct, effort)
    ? modelCallBudgetMs(e.maxOutputTokens)
    : modelGatewayLimits.budgetMaxMs;
}
/** A product step's worst case: two attempts at the call budget and the throttle waits. */
export const productMarginMs = (modelBudgetMs: number) =>
  2 * modelBudgetMs + runTimings.throttleAllowanceMs;
/** Waits of `everyMs` that outlast a fence left open for its budget plus the grace. */
const openFenceWaits = (modelBudgetMs: number, everyMs: number) =>
  Math.ceil((modelBudgetMs + runTimings.fenceGraceMs) / everyMs) + 1;
const retry = (code: string) => new RunStepRetry(code);
const failureOf: Readonly<Record<string, ProductFailureCode>> = Object.freeze({
  incomplete: "incomplete",
  refusal: "refusal",
  invalid_output: "invalid_output",
  uncertain: "uncertain",
  completed: "validation",
});

/** One entered lease step, or the refusal; a failed transaction retries the durable step. */
async function under<T>(
  ports: ListingsRunPorts,
  ref: LeaseRef,
  body: (step: LeaseStep) => Promise<T>,
): Promise<
  | { readonly entered: true; readonly value: T }
  | { readonly entered: false; readonly refusal: string }
> {
  const result = await ports.lease(ref, body);
  if (result === "failed") throw retry("transaction");
  if (!result.entered) return Object.freeze({ entered: false as const, refusal: result.refusal });
  return Object.freeze({ entered: true as const, value: result.value });
}

/** decideDelegation for one operation on the run's store, in this step. */
async function decide(
  ports: ListingsRunPorts,
  step: LeaseStep,
  envelopeId: string,
  capabilityId: CapabilityId,
  verb: "view" | "execute" | "propose",
  fields: readonly string[],
): Promise<"allowed" | "entitlement" | "delegation_denied"> {
  const lease = step.lease;
  const rows = await step.run.billingFacts();
  const reader = createLeaseDelegationReader({
    facts: step.delegationFacts,
    billing: {
      read: (scope) =>
        createBillingFactsReader(async (name) => rows[name] ?? Object.freeze([])).read(scope),
    },
    environment: ports.environment,
    clock: () => new Date(ports.now()),
  });
  const service = createAgentAuthorityService(reader, () => new Date(ports.now()));
  const resource = storeResource(
    lease.organizationId,
    lease.workspaceId,
    lease.storeId,
    lease.connectionId,
  );
  try {
    const r = await service.decideDelegation(
      JSON.stringify({
        envelopeId,
        executorInstallationId: lease.installationId,
        operation: { capabilityId, verb, resource, accountId: null, fields: [...fields] },
      }),
    );
    if (r.decision.allowed) return "allowed";
    return r.decision.reason === "entitlement_denied" ? "entitlement" : "delegation_denied";
  } catch {
    // Missing or malformed facts deny (AGENT_POLICY_AUTHORITY_UNAVAILABLE).
    return "delegation_denied";
  }
}

interface RunFacts {
  readonly envelopeId: string;
  readonly fields: readonly ListingField[];
  /** One modelRespond's budget for the run's selection (runModelBudgetMs). */
  readonly modelBudgetMs: number;
}
function parseResult(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || text.length > 200_000) throw retry("model_result");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw retry("model_result");
  }
  if (!validateCurrentDefinition("ModelResult", value)) throw retry("model_result");
  return value as Record<string, unknown>;
}

/** One product: the step body (ids and codes out). */
export async function draftProduct(
  ports: ListingsRunPorts,
  ref: LeaseRef,
  facts: RunFacts,
  index: number,
): Promise<RunStepResult> {
  const product = (
    status: "drafted" | "failed" | "done",
    stop: RunEndReason | null,
  ): RunStepResult => Object.freeze({ kind: "product", index, status, stop });
  // 1. Authority and the product's admission, in one transaction.
  const begun = await under(ports, ref, async (step) => {
    const may = await decide(
      ports,
      step,
      facts.envelopeId,
      "catalog.content.propose",
      "execute",
      facts.fields,
    );
    if (may !== "allowed") return { kind: "stop" as const, reason: may as RunEndReason };
    const read = await decide(
      ports,
      step,
      facts.envelopeId,
      "catalog.products.read",
      "view",
      facts.fields,
    );
    if (read !== "allowed") return { kind: "stop" as const, reason: read as RunEndReason };
    return { kind: "begin" as const, begin: await step.run.productBegin(index) };
  });
  if (!begun.entered) return Object.freeze({ kind: "interrupted", refusal: begun.refusal });
  if (begun.value.kind === "stop") return product("failed", begun.value.reason);
  const b = begun.value.begin;
  if (b.outcome === "done") return product("done", null);
  if (b.outcome === "stop") return product("failed", b.reason);
  if (b.outcome !== "begun") throw retry("product_begin");
  const finish = async (
    result: Parameters<LeaseStep["run"]["productFinish"]>[1],
    runStop: RunEndReason | null,
  ): Promise<RunStepResult> => {
    // A call of this product a dead broker left open blocks the finish for its budget plus
    // the grace; then the fence is booked as uncertain and the finish goes through.
    for (let wait = 0; wait < openFenceWaits(facts.modelBudgetMs, 5_000); wait++) {
      const done = await under(ports, ref, (step) => step.run.productFinish(index, result));
      if (!done.entered) return Object.freeze({ kind: "interrupted", refusal: done.refusal });
      const f = done.value;
      if (f.outcome === "call_open") {
        await ports.sleep(5_000);
        continue;
      }
      if (f.outcome !== "recorded" && f.outcome !== "done") throw retry("product_finish");
      const stop = runStop ?? (f.stop ? ((f.reason as RunEndReason | null) ?? "breaker") : null);
      return product(result.outcome === "drafted" ? "drafted" : "failed", stop);
    }
    throw retry("call_open");
  };
  // 2. The product as read and its snapshot (re-read after a retried step: a bound snapshot
  //    with counted attempts must be exactly what the calls used).
  const read = await ports.readProduct(ref, b.productId);
  if (read.outcome !== "read") return finish({ outcome: "failed", code: "read_failed" }, null);
  if (read.product.productId !== b.productId)
    return finish({ outcome: "failed", code: "product_mismatch" }, null);
  let canonical: string;
  try {
    canonical = snapshotCanonical(read.product);
  } catch {
    return finish({ outcome: "failed", code: "read_failed" }, null);
  }
  if (new TextEncoder().encode(canonical).length > 65_536)
    return finish({ outcome: "failed", code: "too_large" }, null);
  if (b.snapshotDigest === null || b.attempts === 0 || b.snapshotDigest !== sha256Text(canonical)) {
    if (b.attempts > 0 && b.snapshotDigest !== null && b.snapshotDigest !== sha256Text(canonical))
      return finish({ outcome: "failed", code: "read_failed" }, null);
    const put = await under(ports, ref, (step) => step.run.snapshotPut(index, canonical));
    if (!put.entered) return Object.freeze({ kind: "interrupted", refusal: put.refusal });
    if (put.value.outcome === "too_large")
      return finish({ outcome: "failed", code: "too_large" }, null);
    if (put.value.outcome !== "stored") throw retry("snapshot");
  }
  if (!runFieldsValid(b.fields)) throw retry("fields");
  // 3. At most two attempts; a throttle resends within the attempt.
  let last: ProductFailureCode = "validation";
  for (let attempt = b.attempts + 1; attempt <= 2; attempt++) {
    let settled = false;
    for (let sequence = 1; sequence <= runTimings.sequences && !settled; sequence++) {
      const call = {
        schemaVersion: 1,
        purpose: "listing_draft",
        productIndex: index,
        attempt,
        sequence,
        request: b.objective,
        fields: [...b.fields],
        product: read.product,
      };
      let text: string;
      try {
        text = await ports.modelRespond(
          ref.leaseId,
          ref.generation,
          JSON.stringify(call),
          facts.modelBudgetMs,
        );
      } catch {
        // BROKER_HELD: the gateway refused before any request (the switch is off, the lease
        // or a stop refused, the reservation is spent, or the fence is in flight). The fence
        // keeps any open call; the run ends and the stale close books what remains.
        return finish({ outcome: "failed", code: "provider_error" }, "broker_held");
      }
      const result = parseResult(text);
      const outcome = result.outcome as string;
      if (outcome === "not_sent") {
        const wait = typeof result.retryAfterMs === "number" ? result.retryAfterMs : 2_000;
        await ports.sleep(Math.min(Math.max(wait, 250), runTimings.maxWaitMs));
        continue;
      }
      settled = true;
      if (outcome === "spend_limit")
        return finish({ outcome: "failed", code: "spend_limit" }, "spend_limit");
      if (outcome === "provider_error")
        return finish({ outcome: "failed", code: "provider_error" }, "provider_error");
      if (outcome === "input_over_cap")
        return finish({ outcome: "failed", code: "input_over_cap" }, null);
      if (outcome === "completed" && result.output !== null) {
        const checked = checkDraft(
          result.output,
          b.productId,
          read.product,
          b.fields as ListingField[],
        );
        if (checked.ok)
          return finish(
            {
              outcome: "drafted",
              setCanonical: checked.setCanonical,
              fields: checked.fields,
              flags: checked.flags,
            },
            null,
          );
        last = checked.code;
        continue;
      }
      last = failureOf[outcome] ?? "validation";
    }
    if (!settled) return finish({ outcome: "failed", code: "provider_error" }, "provider_error");
  }
  return finish({ outcome: "failed", code: last }, null);
}

/**
 * The propose step: every pending draft packed and submitted in one transaction. A refusal
 * rolls the whole step back, so nothing is half-proposed. Only stale_authority (the review
 * policy moved under the step) is retried; a refusal retrying cannot fix (limit_reached:
 * the 1,000 pending approvals cap; invalid; not_found; denied) ends the run promptly as
 * proposal_refused instead of retrying until the Workflow fails.
 */
export async function proposeDrafts(
  ports: ListingsRunPorts,
  ref: LeaseRef,
  facts: RunFacts,
): Promise<RunStepResult> {
  let refused: string | null = null;
  const refusedResult = () =>
    Object.freeze({
      kind: "proposed",
      proposals: 0,
      stop: "proposal_refused",
    }) as RunStepResult;
  let done: Awaited<ReturnType<typeof proposeUnder>>;
  try {
    done = await proposeUnder(ports, ref, facts, (outcome) => {
      refused = outcome;
    });
  } catch (error) {
    // The thrown refusal rolled the transaction back; the run ends instead of retrying.
    if (refused !== null) return refusedResult();
    throw error;
  }
  if (refused !== null) return refusedResult();
  if (!done.entered) return Object.freeze({ kind: "interrupted", refusal: done.refusal });
  return Object.freeze({
    kind: "proposed",
    proposals: done.value.proposals,
    stop: done.value.stop,
  });
}
function proposeUnder(
  ports: ListingsRunPorts,
  ref: LeaseRef,
  facts: RunFacts,
  refuse: (outcome: string) => void,
) {
  return under(ports, ref, async (step) => {
    const drafts = await step.run.draftsPending();
    if (drafts.length === 0) return { proposals: 0, stop: null as RunEndReason | null };
    const fields = [...new Set(drafts.flatMap((d) => d.fields))].sort();
    const may = await decide(
      ports,
      step,
      facts.envelopeId,
      "catalog.content.publish",
      "propose",
      fields,
    );
    if (may !== "allowed") return { proposals: 0, stop: may as RunEndReason };
    const context = await step.run.reviewContext();
    const lease = step.lease;
    const runRow = await step.run.start();
    if (runRow === "denied") throw retry("run");
    const packed = packListingProposals(
      {
        organizationId: lease.organizationId,
        workspaceId: lease.workspaceId,
        storeId: lease.storeId,
        connectionId: lease.connectionId,
        taskId: runRow.taskId,
        installationId: runRow.installationId,
        agentPrincipalId: runRow.agentPrincipalId,
        requesterPrincipalId: lease.initiatorPrincipalId,
        requesterMembershipId: lease.initiatorMembershipId,
      },
      drafts.map((d) => ({ ...d, fields: d.fields as ListingField[] })),
      context.policy,
      context.databaseNow,
      ports.ids,
    );
    for (const p of packed) {
      const outcome = await step.run.submitProposal({
        approvalId: p.approvalId,
        policyCanonical: p.policyCanonical,
        policyDigest: p.policyDigest,
        parametersCanonical: p.parametersCanonical,
        parametersDigest: p.parametersDigest,
        proposalCanonical: p.proposalCanonical,
        proposalDigest: p.proposalDigest,
        scopeCanonical: p.scopeCanonical,
        draftIds: p.draftIds,
      });
      // Any refusal rolls the whole step back (the thrown error): nothing is half-proposed.
      if (outcome === "stale_authority") throw retry("submit_" + outcome);
      if (outcome !== "applied") {
        refuse(outcome);
        throw retry("submit_refused");
      }
    }
    return { proposals: packed.length, stop: null as RunEndReason | null };
  });
}

/**
 * The whole run: start, one step per product (stopping at the first run-ending outcome),
 * propose, finish. `params` is the Workflow's payload (the lease reference only).
 */
export async function listingsRun(
  ports: ListingsRunPorts,
  steps: DurableSteps,
  ref: LeaseRef,
): Promise<RunStepResult> {
  const started = await steps.do("start", async () => {
    const r = await under(ports, ref, (step) => step.run.start());
    if (!r.entered)
      return Object.freeze({ kind: "interrupted", refusal: r.refusal }) as RunStepResult;
    if (r.value === "denied")
      return Object.freeze({ kind: "interrupted", refusal: "denied" }) as RunStepResult;
    if (r.value.outcome === "ended")
      return Object.freeze({ kind: "ended", status: r.value.status }) as RunStepResult;
    const modelBudgetMs = runModelBudgetMs(r.value.catalogueVersion, r.value.model, r.value.effort);
    return Object.freeze({
      kind: "started",
      productCount: r.value.productCount,
      leaseExpiresAtMs: r.value.leaseExpiresAtMs,
      envelopeId: r.value.envelopeId,
      fields: r.value.fields,
      modelBudgetMs,
    }) as unknown as RunStepResult;
  });
  if (started.kind !== "started") return started;
  const s = started as unknown as {
    productCount: number;
    leaseExpiresAtMs: number;
    envelopeId: string;
    fields: ListingField[];
    modelBudgetMs: number;
  };
  const facts: RunFacts = Object.freeze({
    envelopeId: s.envelopeId,
    fields: s.fields,
    modelBudgetMs: s.modelBudgetMs,
  });
  let stop: RunEndReason | null = null;
  for (let index = 0; index < s.productCount && stop === null; index++) {
    const r = await steps.do("product-" + index, async () => {
      if (ports.now() > s.leaseExpiresAtMs - productMarginMs(facts.modelBudgetMs))
        return Object.freeze({
          kind: "product",
          index,
          status: "done",
          stop: "time_budget",
        }) as RunStepResult;
      return draftProduct(ports, ref, facts, index);
    });
    if (r.kind === "interrupted") return r;
    if (r.kind === "product") stop = r.stop;
  }
  // Drafts already validated are proposed even when the run stops early (one credit per
  // product drafted, ADR-0022 item 11): the propose step reruns decideDelegation, so a run
  // that lost its authority proposes nothing, and with no pending draft it is a no-op.
  const proposed = await steps.do("propose", () => proposeDrafts(ports, ref, facts));
  if (proposed.kind === "interrupted") return proposed;
  if (proposed.kind === "proposed" && stop === null) stop = proposed.stop;
  return steps.do("finish", async () => {
    for (let wait = 0; wait < openFenceWaits(facts.modelBudgetMs, 10_000); wait++) {
      const r = await under(ports, ref, (step) => step.run.finish(stop));
      if (!r.entered)
        return Object.freeze({ kind: "interrupted", refusal: r.refusal }) as RunStepResult;
      if (r.value.outcome === "ended")
        return Object.freeze({ kind: "ended", status: r.value.status }) as RunStepResult;
      if (r.value.outcome === "call_open") {
        await ports.sleep(10_000);
        continue;
      }
      throw retry("finish_" + r.value.outcome);
    }
    throw retry("finish_call_open");
  });
}
