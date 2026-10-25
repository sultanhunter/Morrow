import { validateCurrentDefinition } from "@morrow/contracts/validation";
import type { CapabilityId } from "@morrow/contracts";
import { createAgentAuthorityService } from "@morrow/policy/agent-authority";

import { storeResource } from "@morrow/policy/store-resource";
import {
  decodeShopifyReadResult,
  modelCallBudgetMs,
  modelGatewayLimits,
  shopifyReadLimits,
  type RuntimeBrokerRpc,
} from "../../../identity/src/broker-protocol.js";
import { generatedModelCatalogue } from "../../../policy/src/generated/model-catalogue.js";
import { createBillingFactsReader } from "../billing/facts.js";
import { createLeaseDelegationReader } from "../agents/delegation-reader.js";
import type { LeaseRef, LeaseStep, LeaseStepResult } from "../runtime/leases.js";
import type { ProductFailureCode, RunEndReason } from "../runtime/run-steps.js";
import { sha256Text } from "../approvals/digests.js";
import {
  checkDraft,
  readSnapshot,
  runFieldsValid,
  snapshotBytes,
  snapshotCanonical,
  snapshotMaxBytes,
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
//   start    run_start (queued -> running, lease started), under the lease whose subject is
//            the Workflow's instance id (the run id; anything else interrupts the run).
//   product  one per product: decideDelegation (execute on catalog.content.propose, view on
//            catalog.products.read); run_product_begin (the breaker and the reservation; its
//            unrecovered-cost check caps nothing since migration 0048, ADR-0036); the product read (M2 PR-3's shopifyRead productContent,
//            named by the run id: a read that throws is tried again within the step, the
//            lease entered before each retry, at most runTimings.readWaitsMs.length + 1
//            reads; one still unavailable, not_found or a reply outside the protocol fails
//            the product read_failed, which the breaker counts, and a breaker tripped by
//            unreadable products alone ends the run read_unavailable; a product over
//            64 KiB fails too_large before any schema check) and its
//            content-addressed snapshot; at most two attempts through the broker's
//            modelRespond (a resend after a throttle reuses the attempt); the code checks of
//            drafting.ts; run_product_finish. Outcomes follow ADR-0022 item 10: spend_limit
//            and provider_error end the run, incomplete, refusal, invalid output and
//            uncertain use the next attempt, input_over_cap fails the product at once.
//   propose  decideDelegation (propose on catalog.content.publish), the drafts packed by
//            bytes into Proposal@2 records, each submitted by the agent submit definer; it
//            also runs after a run-ending outcome, so drafted products are still proposed.
//   finish   run_finish: settles at the products proposed, ends the run, releases the lease.

/**
 * One product read. unavailable: the read threw (BROKER_HELD, which carries no code: READ_BUSY,
 * a throttle that did not fit the budget, OUTCOME_UNKNOWN, a lost RPC, a stop or an ended
 * lease, but also READ_REFUSED for a Shopify refusal or a reply over the read's limits, which
 * repeats on every try), so the product step tries it again a bounded number of times and
 * then fails the product read_failed (draftProduct). invalid: the reply was not the
 * protocol's closed result.
 */
export type ProductRead =
  | { readonly outcome: "read"; readonly product: ListingSnapshot }
  | { readonly outcome: "not_found" | "unavailable" | "invalid" };
/**
 * One shopifyRead(productContent) reply as the product step takes it, decoded with the
 * protocol's own closed decoder (M2 PR-3): a product's listing fields, not_found, or invalid
 * for anything else. createProductReader maps a thrown read to unavailable itself.
 */
export function productReadOf(text: unknown): ProductRead {
  try {
    const result = decodeShopifyReadResult("productContent", text);
    if (result.outcome === "not_found") return Object.freeze({ outcome: "not_found" });
    if ("product" in result) return Object.freeze({ outcome: "read", product: result.product });
  } catch {
    // The reply was not the protocol's closed result.
  }
  return Object.freeze({ outcome: "invalid" });
}
/**
 * The orchestrator's product read (spine §4), free of Cloudflare so its tests and the
 * PostgreSQL lab run it: M2 PR-3's RuntimeBroker.shopifyRead(leaseId, generation, subjectId,
 * queryName, variablesJson, budgetMs) for productContent under the run lease, named by the run
 * id as the lease's subject (the vault resolution refuses any other subject, and any product
 * not in progress in that run), within the read's whole budget. A thrown read (BROKER_HELD) is
 * unavailable; a reply is decoded by productReadOf.
 */
export function createProductReader(
  broker: Pick<RuntimeBrokerRpc, "shopifyRead">,
): ListingsRunPorts["readProduct"] {
  return async (ref, runId, productId) => {
    let text: string;
    try {
      text = await broker.shopifyRead(
        ref.leaseId,
        ref.generation,
        runId,
        "productContent",
        JSON.stringify({ productId }),
        shopifyReadLimits.budgetMaxMs,
      );
    } catch {
      return Object.freeze({ outcome: "unavailable" as const });
    }
    return productReadOf(text);
  };
}
/** What the product step takes from one read: the snapshot and its canonical text, or a failure. */
export type ReadSnapshot =
  | {
      readonly kind: "snapshot";
      readonly snapshot: ListingSnapshot;
      readonly canonical: string;
    }
  | { readonly kind: "failed"; readonly code: "read_failed" | "product_mismatch" | "too_large" };
/**
 * The product step's handling of its last read (draftProduct tries an unavailable read again
 * first). A read still unavailable, not_found and a reply outside the protocol fail
 * read_failed; another product, product_mismatch. The size is checked before the schema (the
 * read admits text ListingSnapshot@1 does not), so a product over 64 KiB fails too_large,
 * never read_failed; exact duplicate tags are dropped first.
 */
export function snapshotOfRead(read: ProductRead, productId: string): ReadSnapshot {
  const failed = (code: "read_failed" | "product_mismatch" | "too_large") =>
    Object.freeze({ kind: "failed" as const, code });
  if (read.outcome !== "read") return failed("read_failed");
  if (read.product.productId !== productId) return failed("product_mismatch");
  const snapshot = readSnapshot(read.product);
  if (snapshotBytes(snapshot) > snapshotMaxBytes) return failed("too_large");
  try {
    return Object.freeze({
      kind: "snapshot" as const,
      snapshot,
      canonical: snapshotCanonical(snapshot),
    });
  } catch {
    return failed("read_failed");
  }
}
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
  /**
   * The product read of the run's store under the lease (M2 PR-3's shopifyRead
   * productContent); runId is the lease's subject, which the vault resolution requires.
   */
  readProduct(ref: LeaseRef, runId: string, productId: string): Promise<ProductRead>;
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
      /** Present only when the product failed because its read stayed unavailable. */
      readonly unreadable?: true;
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
// the floor output rate); a product step needs its reads, two such calls and a few throttle
// waits, so a product step does not start with less lease time left than
// productMarginMs(budget). A fence a dead broker left open blocks for its budget plus a minute
// (migration listings-runs).
export const runTimings = Object.freeze({
  /** At most this many resends of one attempt after a provider throttle. */
  sequences: 8,
  /** The longest wait the step itself makes before a resend. */
  maxWaitMs: 30_000,
  /** The throttle waits a product step's margin allows for. */
  throttleAllowanceMs: 60_000,
  /** How long an open fence outlives its budget before it is booked as uncertain. */
  fenceGraceMs: 60_000,
  /**
   * The waits before each retry of an unavailable product read, within the product step: at
   * most readWaitsMs.length + 1 reads, each within shopifyReadLimits.budgetMaxMs. The durable
   * step's own retries are never spent on a read, so a read that never clears fails its
   * product instead of failing the Workflow.
   */
  readWaitsMs: Object.freeze([2_000, 5_000]),
});
/**
 * The failed-product breaker (run_product_begin and run_product_finish: the catalogue's
 * maxConsecutiveFailedProducts, 3 in every published version).
 */
export const breakerProducts = 3;
/** A product step's reads at their worst: every try at the read's budget, and the waits. */
const readAllowanceMs =
  (runTimings.readWaitsMs.length + 1) * shopifyReadLimits.budgetMaxMs +
  runTimings.readWaitsMs.reduce((sum, wait) => sum + wait, 0);
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
/** A product step's worst case: its reads, two attempts at the call budget, the throttle waits. */
export const productMarginMs = (modelBudgetMs: number) =>
  readAllowanceMs + 2 * modelBudgetMs + runTimings.throttleAllowanceMs;
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
  /** The run id: the Workflow instance id and the run lease's subject. */
  readonly runId: string;
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

/**
 * The product step's read: a read that threw (unavailable) is tried again after each of
 * runTimings.readWaitsMs, the run lease entered first, so a stop or an ended lease interrupts
 * the run instead of reading on. Returns the last read (still unavailable when every try
 * threw) or the lease's refusal; a failed lease transaction is a RunStepRetry.
 */
export async function readProductWithRetries(
  ports: ListingsRunPorts,
  ref: LeaseRef,
  runId: string,
  productId: string,
): Promise<ProductRead | { readonly outcome: "interrupted"; readonly refusal: string }> {
  let read = await ports.readProduct(ref, runId, productId);
  for (const waitMs of runTimings.readWaitsMs) {
    if (read.outcome !== "unavailable") break;
    await ports.sleep(waitMs);
    const live = await under(ports, ref, async () => true);
    if (!live.entered)
      return Object.freeze({ outcome: "interrupted" as const, refusal: live.refusal });
    read = await ports.readProduct(ref, runId, productId);
  }
  return read;
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
  //    with counted attempts must be exactly what the calls used). A read that threw
  //    (unavailable) is tried again within this step after each of runTimings.readWaitsMs,
  //    the lease entered first, so a stop or an ended lease interrupts the run. One still
  //    unavailable fails the product read_failed through the lease (the breaker counts it),
  //    so the run goes on to propose and finish; the durable step's retries are kept for
  //    its transactions, and a refusal that repeats on every read never fails the Workflow.
  const read = await readProductWithRetries(ports, ref, facts.runId, b.productId);
  if (read.outcome === "interrupted")
    return Object.freeze({ kind: "interrupted", refusal: read.refusal });
  if (read.outcome === "unavailable") {
    const failed = await finish({ outcome: "failed", code: "read_failed" }, null);
    return failed.kind === "product" ? Object.freeze({ ...failed, unreadable: true }) : failed;
  }
  const got = snapshotOfRead(read, b.productId);
  if (got.kind === "failed") return finish({ outcome: "failed", code: got.code }, null);
  const { snapshot, canonical } = got;
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
        product: snapshot,
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
          snapshot,
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
 * propose, finish. `ref` is the Workflow's payload (the lease reference only) and `runId`
 * its instance id (the run id).
 */
export async function listingsRun(
  ports: ListingsRunPorts,
  steps: DurableSteps,
  ref: LeaseRef,
  runId: string,
): Promise<RunStepResult> {
  const started = await steps.do("start", async () => {
    // The lease the payload names must be this run's: the instance id is the run id, and the
    // product read names it as the lease's subject (M2 PR-3's resolution refuses any other).
    const r = await under(ports, ref, async (step) =>
      step.lease.kind === "run" && step.lease.subjectId === runId
        ? step.run.start()
        : ("subject_mismatch" as const),
    );
    if (!r.entered)
      return Object.freeze({ kind: "interrupted", refusal: r.refusal }) as RunStepResult;
    if (r.value === "denied" || r.value === "subject_mismatch")
      return Object.freeze({ kind: "interrupted", refusal: r.value }) as RunStepResult;
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
    runId,
    envelopeId: s.envelopeId,
    fields: s.fields,
    modelBudgetMs: s.modelBudgetMs,
  });
  let stop: RunEndReason | null = null;
  // Products in a row whose read stayed unavailable (from the durable results, so a replay
  // counts the same): a breaker they alone tripped ends the run read_unavailable ("the store
  // couldn't be read"), not breaker.
  let unreadable = 0;
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
    if (r.kind === "product") {
      unreadable = r.unreadable === true ? unreadable + 1 : 0;
      stop = r.stop === "breaker" && unreadable >= breakerProducts ? "read_unavailable" : r.stop;
    }
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
