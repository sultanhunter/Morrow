import type { Core_ErrorEnvelope, Current_Proposal } from "@morrow/contracts";
import { validateDefinition } from "@morrow/contracts/validation";
import { confirmationPhrase, effectiveRule } from "@morrow/policy/review";
import { listingFieldPaths } from "@morrow/policy/store-resource";
import {
  decodeShopifyApplyResult,
  decodeShopifyReconcileResult,
  decodeShopifyUndoCheckResult,
  shopifyWriteLimits,
  type ShopifyApplyResult,
  type ShopifyUndoCheckResult,
} from "../../../identity/src/broker-protocol.js";
import { decideOn } from "../agents/commands.js";
import {
  approvalErrors,
  decideApproval,
  listApprovals,
  proposalStore,
  readProposal,
  storeLinkCurrent,
  type ApprovalRefusal,
} from "../approvals/index.js";
import { readContext, readProposalRow } from "../approvals/family.js";
import {
  WorkOutcomeUnknown,
  WorkReject,
  withWorkTransaction,
  type WorkSqlConnection,
  type WorkTx,
} from "../connection.js";
import { enterWorkContext, WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { workRequestDigest } from "../digest.js";
import {
  WorkGuardError,
  guardWorkspaceRequest,
  workOrigin,
  type GuardedWorkspaceRequest,
  type WorkspaceRouteSpec,
} from "../http-guard.js";
import { workErrorResponse, type WorkApiDependencies } from "../http.js";
import {
  ApplyReject,
  admitApply,
  decodeOperation,
  dispatchOperation,
  familyOperations,
  operationVisible,
  parseApplyBody,
  setAsideOperation,
  type ApplyRefusal,
  type OperationRow,
} from "./apply.js";
import { BatchReject, buildBatch, decideBatch, parseBatchDecision } from "./batch.js";
import {
  UndoReject,
  admitUndo,
  prepareUndo,
  replayedUndo,
  undoOfProposal,
  undoRequestDigest,
  undoStatesOfTask,
  type UndoAdmitted,
} from "./undo.js";
import { ReviewViewError, buildProductReviews, type ReviewSource } from "./view.js";

// The review and apply routes of the workspace API (v1 PR 3): an internal JSON contract
// between the api Worker and Morrow's own SPA, under /workspace/:ws/work (the api's dispatch
// table sends exactly these paths here, ahead of the work API):
//   GET  /work/approvals                        pending approvals the actor may review
//   GET  /work/proposals/:proposalId/review     before and after per product and field
//                                               (?selected=0,2 previews a subset's exact digest)
//   POST /work/proposals/:proposalId/decision   approve all, approve some, or reject (ADR-0011)
//   POST /work/proposals/:proposalId/apply      claim the approval and apply product by product
//   GET  /work/tasks/:taskId/operations         a task's apply history
//   GET  /work/operations/:operationId          one operation, its transitions and read-backs
//   POST /work/operations/:operationId/reconcile read the product back (an unknown outcome)
//   POST /work/operations/:operationId/set-aside the claimant checked it in Shopify (uncertain)
// v1 PR 4 adds:
//   POST /work/operations/:operationId/undo     Undo: the broker reads the product, then a NEW
//                                               exact change back to the values read before
//                                               the apply, which a person approves and the
//                                               gateway applies like any other (undo.ts)
//   GET  /work/proposals/:proposalId/batch      "Approve several at once": the server-built
//                                               document of the changes waiting on its task
//   POST /work/proposals/:proposalId/batch-decision
//                                               one confirmation of that document: one exact
//                                               approval per change, all or none (batch.ts)
// and the undo state of each change to the task's history and the review document.
// Every read and command is one short transaction of its own (5 s), opened per step. While
// the apply switch is off (MORROW_SHOPIFY_WRITE absent), apply answers 503 before any
// database access: no claim, lease or operation exists without the gateway. The broker's
// replies are closed codes; no product content, Shopify text or token ever reaches a response
// or a log line.

export interface ApplyBrokerPort {
  apply(operationId: string, budgetMs: number, signal: AbortSignal): Promise<string>;
  reconcile(operationId: string, budgetMs: number, signal: AbortSignal): Promise<string>;
  /** v1 PR 4: the undo check; a port without it answers the undo route 503. */
  undoCheck?(operationId: string, budgetMs: number, signal: AbortSignal): Promise<string>;
}
export interface ReviewApiDependencies extends WorkApiDependencies {
  readonly environment: "development" | "staging" | "production";
  /** The reviewed apply switch is on (MORROW_SHOPIFY_WRITE "on"). */
  readonly applyOpen: boolean;
  /** The broker's apply and read-back; null when the binding serves neither (503). */
  readonly broker: ApplyBrokerPort | null;
}
type ReviewOp =
  | "approvals.list"
  | "review.get"
  | "review.decide"
  | "review.apply"
  | "operations.of_task"
  | "operations.get"
  | "operations.reconcile"
  | "operations.set_aside"
  | "operations.undo"
  | "review.batch"
  | "review.batch_decide";
interface ReviewRoute extends WorkspaceRouteSpec {
  readonly op: ReviewOp;
}
const route = (method: "GET" | "POST", pattern: string, op: ReviewOp, query: string[] = []) =>
  Object.freeze({ method, pattern, query, op }) as ReviewRoute;
export const reviewRoutes: readonly ReviewRoute[] = Object.freeze([
  route("GET", "/approvals", "approvals.list", ["after", "limit"]),
  route("GET", "/proposals/:proposalId/review", "review.get", ["selected"]),
  route("POST", "/proposals/:proposalId/decision", "review.decide"),
  route("POST", "/proposals/:proposalId/apply", "review.apply"),
  route("GET", "/tasks/:taskId/operations", "operations.of_task"),
  route("GET", "/operations/:operationId", "operations.get"),
  route("POST", "/operations/:operationId/reconcile", "operations.reconcile"),
  route("POST", "/operations/:operationId/set-aside", "operations.set_aside"),
  // v1 PR 4.
  route("POST", "/operations/:operationId/undo", "operations.undo"),
  route("GET", "/proposals/:proposalId/batch", "review.batch"),
  route("POST", "/proposals/:proposalId/batch-decision", "review.batch_decide"),
]);
/** The paths the api Worker sends to this handler (its dispatch row, ahead of the work API). */
export const reviewPathPattern =
  /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\/work\/(?:approvals|proposals\/[^/]+\/(?:review|decision|apply|batch|batch-decision)|tasks\/[^/]+\/operations|operations\/[^/]+(?:\/reconcile|\/set-aside|\/undo)?)$/;
// A request's whole budget: the apply runs several transactions and broker calls, product by
// product; it starts no product with less than applyProductMinMs left (the rest stay
// authorized and the same request, sent again, continues them).
export const reviewLimits = Object.freeze({
  transactionMs: 5000,
  requestMs: 9000,
  applyRequestMs: 55_000,
  applyProductMinMs: 15_000,
  reconcileBudgetMs: 12_000,
  // v1 PR 4: the undo request's whole budget (two transactions around one broker read) and
  // the read's own.
  undoRequestMs: 25_000,
  undoCheckBudgetMs: 12_000,
  // v1 PR 4: "Approve several at once" rebuilds the document and decides up to ten exact
  // approvals in ONE transaction (all or none), so it has a longer transaction and request.
  batchTransactionMs: 15_000,
  batchRequestMs: 20_000,
});

type Context = Readonly<{ waitUntil(p: Promise<unknown>): void }>;
type Guarded = GuardedWorkspaceRequest<ReviewRoute>;
const headers = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify({ schemaVersion: 1, ...(body as object) }), {
    status,
    headers: { ...headers },
  });
type Mapped = readonly [
  number,
  Core_ErrorEnvelope["code"],
  Core_ErrorEnvelope["retryClass"],
  string,
];
const applyRefusals: Readonly<Record<string, Mapped>> = Object.freeze({
  apply_unavailable: [
    503,
    "unavailable",
    "recheck_before_retry",
    "Applying changes to Shopify is not switched on yet.",
  ],
  not_entitled: [403, "denied", "never", "An active Morrow plan is required to apply changes."],
  link_changed: [
    409,
    "conflict",
    "never",
    "This store was disconnected or reconnected, so these changes can no longer be applied.",
  ],
  not_catalog: [404, "denied", "never", "The record was not found."],
  already_claimed: [
    409,
    "conflict",
    "never",
    "These changes were already applied by someone else.",
  ],
  stopped: [409, "conflict", "never", "AI work is stopped for this store."],
  scope_missing: [
    409,
    "conflict",
    "never",
    "Morrow does not have permission to edit products in this store.",
  ],
  installation_inactive: [
    409,
    "conflict",
    "never",
    "The Listings agent is not enabled for this store.",
  ],
  not_claimant: [
    403,
    "denied",
    "never",
    "Only the person who applied this change can set it aside.",
  ],
  too_soon: [
    409,
    "conflict",
    "recheck_before_retry",
    "Morrow is still waiting for Shopify's answer. Try again in a minute.",
  ],
  // v1 PR 4: Undo.
  not_applied: [
    409,
    "conflict",
    "never",
    "Only a change Morrow applied and confirmed in Shopify can be undone.",
  ],
  already_requested: [
    409,
    "conflict",
    "never",
    "An undo of this change is already waiting. Open it from the change's history.",
  ],
  already_undone: [409, "conflict", "never", "This change was already undone."],
  changed_since_apply: [
    409,
    "conflict",
    "never",
    "This product changed after Morrow applied the change, so Undo stopped. Nothing was written.",
  ],
  undo_unavailable: [
    409,
    "conflict",
    "never",
    "Undo is no longer available for this change: it was applied more than 90 days ago, or the shop's data was deleted.",
  ],
  check_stale: [
    409,
    "conflict",
    "recheck_before_retry",
    "Morrow could not confirm the product in time. Try Undo again.",
  ],
  product_missing: [
    409,
    "conflict",
    "never",
    "This product is no longer in Shopify, so Undo stopped. Nothing was written.",
  ],
  not_reversible: [
    409,
    "conflict",
    "never",
    "Morrow can't undo this change on its own: an earlier value is longer than Morrow can write. Change it back in Shopify.",
  ],
  undo_too_soon: [
    409,
    "conflict",
    "recheck_before_retry",
    "Morrow checked this product a moment ago. Try again in a few seconds.",
  ],
  credential_unavailable: [
    409,
    "conflict",
    "recheck_before_retry",
    "Morrow can't read this store right now. Try again later.",
  ],
  // v1 PR 4: "Approve several at once".
  batch_changed: [
    409,
    "conflict",
    "recheck_before_retry",
    "These changes are not the same as when you opened them. Review them again.",
  ],
  batch_expired: [
    409,
    "conflict",
    "recheck_before_retry",
    "This confirmation lasts 5 minutes and has expired. Review the changes again.",
  ],
});
// The listing fields in plain words, for Undo's "what changed" message.
const fieldWords: Readonly<Record<string, string>> = Object.freeze({
  title: "the title",
  descriptionHtml: "the description",
  "seo.title": "the SEO title",
  "seo.description": "the SEO description",
  tags: "the tags",
});
/** Undo stopped because these fields changed after the apply (nothing was written). */
export function changedMessage(fields: readonly string[]): string {
  const words = fields.map((f) => fieldWords[f]).filter((w): w is string => !!w);
  if (words.length === 0) return applyRefusals.changed_since_apply![3];
  const list =
    words.length === 1 ? words[0]! : words.slice(0, -1).join(", ") + " and " + words.at(-1)!;
  return (
    list[0]!.toUpperCase() +
    list.slice(1) +
    " changed in Shopify after Morrow applied this change, so Undo stopped. Nothing was written."
  );
}
function envelope(
  status: number,
  code: Core_ErrorEnvelope["code"],
  retry: Core_ErrorEnvelope["retryClass"],
  message: string,
  correlationId: string,
) {
  const body: Core_ErrorEnvelope = {
    schemaVersion: 1,
    code,
    retryClass: retry,
    safeMessage: message,
    correlationId,
    operationId: null,
    retryAfterSeconds: null,
    inputRequestIds: [],
  };
  if (!validateDefinition("core", "ErrorEnvelope", body)) throw Error("REVIEW_ERROR_INVALID");
  return new Response(JSON.stringify(body), { status, headers: { ...headers } });
}
const approvalMessages: Readonly<Record<string, string>> = Object.freeze({
  denied: "This operation is not permitted.",
  conflict: "This change is not allowed from the current state. Reload and try again.",
  missing_input: "The request is not valid.",
  approval_expired: "This approval has expired. Ask Listings to draft again.",
});
function refusalResponse(
  reason: ApplyRefusal | ApprovalRefusal | "apply_unavailable",
  correlationId: string,
) {
  const own = applyRefusals[reason];
  if (own) return envelope(own[0], own[1], own[2], own[3], correlationId);
  if (reason === "not_entitled")
    return envelope(403, "denied", "never", "An active Morrow plan is required.", correlationId);
  const mapped = approvalErrors[reason as ApprovalRefusal];
  if (!mapped) return workErrorResponse("unavailable", correlationId);
  if (mapped.status === 404) return workErrorResponse("not_found", correlationId);
  if (mapped.status === 401) return workErrorResponse("unauthenticated", correlationId);
  return envelope(
    mapped.status,
    mapped.code,
    mapped.retryClass,
    approvalMessages[mapped.code] ?? "This operation is not permitted.",
    correlationId,
  );
}
/** An undo refusal as the route answers it (codes and fixed messages only). */
function undoResponse(error: UndoReject, correlationId: string) {
  switch (error.reason) {
    case "not_found":
    case "invalid":
    case "limit_reached":
    case "stale_authority":
    case "command_conflict":
      return workErrorResponse(error.reason, correlationId);
    case "denied":
      return envelope(403, "denied", "never", "This operation is not permitted.", correlationId);
    case "changed_since_apply": {
      const own = applyRefusals.changed_since_apply!;
      return envelope(own[0], own[1], own[2], changedMessage(error.fields), correlationId);
    }
    default: {
      const own = applyRefusals[error.reason === "unavailable" ? "undo_unavailable" : error.reason];
      if (!own) return workErrorResponse("unavailable", correlationId);
      return envelope(own[0], own[1], own[2], own[3], correlationId);
    }
  }
}
/** A batch refusal: its own two codes, else the approval refusal of the member that failed. */
function batchResponse(error: BatchReject, correlationId: string) {
  const own = applyRefusals[error.reason];
  if (own && (error.reason === "batch_changed" || error.reason === "batch_expired"))
    return envelope(own[0], own[1], own[2], own[3], correlationId);
  return refusalResponse(error.reason as ApprovalRefusal, correlationId);
}
function guardKind(error: WorkGuardError) {
  if (error.status === 401) return "unauthenticated" as const;
  if (error.status === 400) return "invalid" as const;
  if (error.status === 404) return "not_found" as const;
  if (error.status === 405) return "method_not_allowed" as const;
  return "guard_denied" as const;
}
function dependencies(value: ReviewApiDependencies): ReviewApiDependencies {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.now !== "function" ||
    !value.connector ||
    typeof value.connector.open !== "function" ||
    !["development", "staging", "production"].includes(value.environment) ||
    typeof value.applyOpen !== "boolean" ||
    (value.broker !== null &&
      (!value.broker ||
        typeof value.broker.apply !== "function" ||
        typeof value.broker.reconcile !== "function" ||
        !(value.broker.undoCheck === undefined || typeof value.broker.undoCheck === "function")))
  )
    throw Error("REVIEW_API_CONFIGURATION_INVALID");
  const { connector, now, broker } = value;
  return Object.freeze({
    origin: workOrigin(value.origin),
    connector: Object.freeze({ open: connector.open.bind(connector) }),
    now: () => Reflect.apply(now, undefined, []) as number,
    environment: value.environment,
    applyOpen: value.applyOpen,
    broker:
      broker === null
        ? null
        : Object.freeze({
            apply: broker.apply.bind(broker),
            reconcile: broker.reconcile.bind(broker),
            ...(broker.undoCheck ? { undoCheck: broker.undoCheck.bind(broker) } : {}),
          }),
  });
}
async function context(tx: WorkTx, g: Guarded): Promise<WorkAuthority> {
  const a = await enterWorkContext(tx, g.sessionDigest, g.workspaceId);
  if (a === "ineligible") throw new WorkReject("unauthenticated");
  if (a === "grant_overflow") throw new WorkReject("grant_overflow");
  return a;
}
function parseSelected(value: string | undefined): readonly number[] | null | "invalid" {
  if (value === undefined) return null;
  if (!/^(0|[1-9][0-9]?)(,(0|[1-9][0-9]?)){0,99}$/.test(value)) return "invalid";
  return value.split(",").map(Number);
}
const operationView = (o: OperationRow) =>
  Object.freeze({
    operationId: o.operationId,
    taskId: o.taskId,
    storeId: o.storeId,
    proposalId: o.proposalId,
    productId: o.productId,
    targetIndex: o.targetIndex,
    status: o.status,
    reason: o.reason,
    uncertaintyReason: o.uncertaintyReason,
    verdict: o.verdict,
    attempt: o.attempt,
    sendStartedAt: o.sendStartedAt,
    submittedAt: o.submittedAt,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  });

// ---------------------------------------------------------------------------
// Reads.
async function listPending(tx: WorkTx, g: Guarded) {
  const a = await context(tx, g);
  const limitText = g.query.get("limit") ?? "25";
  if (!/^[1-9][0-9]?$/.test(limitText)) throw new WorkReject("invalid");
  const page = await listApprovals(tx, a, {
    after: g.query.get("after") ?? null,
    limit: Number(limitText),
  });
  if (page === "invalid") throw new WorkReject("invalid");
  return {
    items: page.items.map((i) => ({
      proposalId: i.proposalRef.id,
      proposalDigest: i.proposalRef.digest,
      storeId: i.proposalRef.storeId,
      approvalId: i.approvalRef.id,
      capabilityId: i.capabilityId,
      risk: i.risk,
      targetCount: i.targetCount,
      expiresAt: i.approval.expiresAt,
      viewerRole: i.viewerRole,
    })),
    next: page.next,
  };
}

async function reviewDocument(tx: WorkTx, g: Guarded) {
  const a = await context(tx, g);
  const selected = parseSelected(g.query.get("selected"));
  if (selected === "invalid") throw new WorkReject("invalid");
  const proposalId = g.params.proposalId!;
  const stored = await readProposalRow(tx, a, proposalId);
  if (!stored) throw new WorkReject("not_found");
  const view = await readProposal(tx, a, proposalId, selected);
  if (view === "not_found") throw new WorkReject("not_found");
  if (view === "invalid") throw new WorkReject("invalid");
  const proposal: Current_Proposal = view.proposal;
  const store = proposalStore(proposal);
  if (proposal.capabilityId !== "catalog.content.publish" || store === null || store === "invalid")
    throw new WorkReject("not_found");
  // The "before" values are store content: view on catalog.products.read on the store resource
  // with the listing fields, else nothing (the same not_found as an absent proposal).
  const read = await decideOn(a, store, "catalog.products.read", "view", listingFieldPaths);
  if (!read.decision.allowed) throw new WorkReject("not_found");
  const rows = await tx.run("catalogReviewSources", [stored.familyRootId]);
  const sources: ReviewSource[] = rows.map((r) => {
    const state = r.state;
    if (
      typeof r.target_index !== "string" ||
      !/^(0|[1-9][0-9]?)$/.test(r.target_index) ||
      typeof r.product_id !== "string" ||
      (state !== "available" && state !== "expired" && state !== "redacted") ||
      !(r.snapshot === null || typeof r.snapshot === "string")
    )
      throw new WorkContextUnavailable();
    return {
      targetIndex: Number(r.target_index),
      productId: r.product_id,
      state,
      snapshot: r.snapshot as string | null,
    };
  });
  const flagRows = await tx.run("draftFlagsOfProposal", [stored.familyRootId]);
  const flags = new Map<string, string | null>();
  for (const r of flagRows) {
    if (typeof r.product_id !== "string" || typeof r.flags !== "string")
      throw new WorkContextUnavailable();
    flags.set(r.product_id, r.flags);
  }
  const redacted = sources.some((s) => s.state === "redacted");
  let products;
  try {
    products = redacted ? [] : buildProductReviews(proposal, view.parameters, sources, flags);
  } catch (error) {
    if (error instanceof ReviewViewError) throw new WorkContextUnavailable();
    throw error;
  }
  const linked = await storeLinkCurrent(tx, store);
  const claimRows = await tx.run("catalogClaimOf", [proposalId]);
  let claim = null;
  if (claimRows.length === 1) {
    const c = claimRows[0]!;
    const operations = await familyOperations(tx, stored.familyRootId);
    claim = {
      mine:
        c.claimant_principal_id === a.actor.principalId &&
        c.claimant_membership_id === a.actor.membershipId,
      approvalId: c.approval_id,
      proposalId: c.proposal_id,
      operations: operations.map(operationView),
    };
  }
  const status = view.approval?.status ?? null;
  // The solo owner's typed confirmation (ADR-0011 Q3): asked only when the viewer is in the
  // proposal's conflict set (proposer, requester, beneficiaries) and the current policy's
  // effective rule for its risk requires it; the server checks the phrase again.
  const ctx = await readContext(tx, a, proposal.capabilityId, stored.familyRootId);
  const conflicted = [
    proposal.proposedBy.principalId,
    proposal.requestedBy.principalId,
    ...proposal.beneficiaryPrincipalIds,
  ].includes(a.actor.principalId);
  const confirmationRequired =
    ctx.policy !== null &&
    conflicted &&
    effectiveRule(ctx.policy.rules, proposal.risk, proposal.irreversible).selfApproval ===
      "solo_owner_typed_confirmation";
  const blocked = redacted
    ? "redacted"
    : !linked
      ? "link_changed"
      : view.viewerRole !== "reviewer"
        ? "not_reviewer"
        : null;
  // v1 PR 4: an undo proposal names the change it undoes (ids and the apply's time).
  const undoOf = await undoOfProposal(tx, stored.familyRootId);
  return {
    proposal: {
      id: proposal.id,
      digest: proposal.proposalDigest,
      storeId: proposal.storeId,
      taskId: proposal.taskId,
      capabilityId: proposal.capabilityId,
      risk: proposal.risk,
      targetCount: proposal.targets.length,
      expiresAt: proposal.expiresAt,
      contextTaint: proposal.contextTaint,
      partialApproval: proposal.partialApproval,
      derivedFromId: proposal.derivedFrom?.parentRef.id ?? null,
      selectedTargetIndexes: proposal.derivedFrom?.selectedTargetIndexes ?? null,
    },
    proposalRef: {
      organizationId: proposal.organizationId,
      workspaceId: proposal.workspaceId,
      storeId: proposal.storeId,
      kind: "proposal",
      id: proposal.id,
      revision: 1,
      digest: proposal.proposalDigest,
    },
    approval:
      view.approval === null
        ? null
        : {
            id: view.approval.id,
            revision: view.approval.revision,
            status,
            effectiveAt: view.approval.effectiveAt,
            expiresAt: view.approval.expiresAt,
          },
    approvalRef: view.approvalRef,
    viewerRole: view.viewerRole,
    actionable: blocked === null,
    blocked,
    confirmation: { required: confirmationRequired, phrase: confirmationPhrase(proposal) },
    products,
    claim,
    undoOf,
  };
}

async function operationsOfTask(tx: WorkTx, g: Guarded) {
  const a = await context(tx, g);
  const rows = (await tx.run("operationsOfTask", [g.params.taskId!])).map(decodeOperation);
  const visible = [];
  const seen = new Map<string, boolean>();
  for (const o of rows) {
    let ok = seen.get(o.proposalId);
    if (ok === undefined) {
      ok = await operationVisible(tx, a, o);
      seen.set(o.proposalId, ok);
    }
    if (ok) visible.push(operationView(o));
  }
  // v1 PR 4: each visible change's undo state (ids, codes and times), in the same order. The
  // server decides whether Undo is offered; the screen only shows it.
  const states = visible.length ? await undoStatesOfTask(tx, g.params.taskId!) : new Map();
  const undo = visible.map((o) => {
    const s = states.get(o.operationId);
    return {
      operationId: o.operationId,
      state: s?.state ?? "none",
      availableUntil: s?.availableUntil ?? null,
      undoProposalId: s?.undoProposalId ?? null,
      undoOfOperationId: s?.undoOfOperationId ?? null,
    };
  });
  return { operations: visible, undo };
}
async function visibleOperation(tx: WorkTx, a: WorkAuthority, operationId: string) {
  const rows = await tx.run("operationById", [operationId]);
  if (rows.length !== 1) throw new WorkReject("not_found");
  const op = decodeOperation(rows[0]!);
  if (!(await operationVisible(tx, a, op))) throw new WorkReject("not_found");
  return op;
}
async function operationDocument(tx: WorkTx, g: Guarded) {
  const a = await context(tx, g);
  const op = await visibleOperation(tx, a, g.params.operationId!);
  const transitions = (await tx.run("operationTransitions", [op.operationId])).map((t) => ({
    revision: Number(t.revision),
    from: t.from_status,
    to: t.to_status,
    reason: t.reason,
    occurredAt: t.occurred_at,
  }));
  const readbacks = (await tx.run("operationReadbacks", [op.operationId])).map((r) => ({
    sequence: Number(r.sequence),
    observedAt: r.observed_at,
    outcome: r.outcome,
    verdict: r.verdict,
    fields: typeof r.field_verdicts === "string" ? JSON.parse(r.field_verdicts) : null,
  }));
  return { operation: operationView(op), transitions, readbacks };
}

// An ApplyReject leaves its transaction rolled back, as a value the route maps (a thrown
// error would end the transaction as unavailable).
async function refusable<T>(tx: WorkTx, run: () => Promise<T>): Promise<T | ApplyReject> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ApplyReject)) throw error;
    tx.rollbackOnly();
    return error;
  }
}
// v1 PR 4: the same for Undo's and the batch's refusals.
async function undoRefusable<T>(tx: WorkTx, run: () => Promise<T>): Promise<T | UndoReject> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof UndoReject)) throw error;
    tx.rollbackOnly();
    return error;
  }
}
async function batchRefusable<T>(tx: WorkTx, run: () => Promise<T>): Promise<T | BatchReject> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof BatchReject)) throw error;
    tx.rollbackOnly();
    return error;
  }
}

// ---------------------------------------------------------------------------
// The handler.
export function createReviewApiHandler(d?: ReviewApiDependencies) {
  const configured = d === undefined ? undefined : dependencies(d);
  async function handle(request: Request, ctx: Context, correlationId: string) {
    const log: { route: string; outcome: string; products?: number } = {
      route: "unmatched",
      outcome: "unbound",
    };
    if (!configured) return { log, response: workErrorResponse("unauthenticated", correlationId) };
    const start = configured.now();
    if (!Number.isSafeInteger(start)) throw Error("REVIEW_CLOCK_INVALID");
    const abort = new AbortController();
    let budget: number = reviewLimits.requestMs;
    let timer = setTimeout(() => abort.abort(), budget);
    const stop = () => abort.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    let read = request.method === "GET";
    // One transaction on a connection of its own, within the request's deadline.
    const transaction = async <T>(
      readOnly: boolean,
      body: (tx: WorkTx) => Promise<T>,
      transactionMs: number = reviewLimits.transactionMs,
    ) => {
      const deadlineMs = Math.min(configured.now() + transactionMs, start + budget);
      let connection: WorkSqlConnection;
      try {
        connection = await configured.connector.open({
          signal: abort.signal,
          deadlineMs,
          waitUntil: (p) => ctx.waitUntil(p),
        });
      } catch {
        throw new WorkReject("unavailable");
      }
      try {
        return await withWorkTransaction(
          connection,
          { readOnly, deadlineMs, signal: abort.signal, now: configured.now },
          body,
        );
      } finally {
        await connection.close().catch(() => {});
      }
    };
    try {
      let g: Guarded;
      try {
        g = await guardWorkspaceRequest(
          configured.origin,
          "work",
          reviewRoutes,
          request,
          abort.signal,
        );
      } catch (error) {
        if (!(error instanceof WorkGuardError)) throw error;
        log.outcome = "guard_" + error.status;
        return { log, response: workErrorResponse(guardKind(error), correlationId, error.allow) };
      }
      log.route = g.route.method + " " + g.route.pattern;
      read = g.route.method === "GET";
      switch (g.route.op) {
        case "approvals.list": {
          const body = await transaction(true, (tx) => listPending(tx, g));
          log.outcome = "read";
          return { log, response: json(200, body) };
        }
        case "review.get": {
          const body = await transaction(true, (tx) => reviewDocument(tx, g));
          log.outcome = "read";
          return { log, response: json(200, body) };
        }
        case "operations.of_task": {
          const body = await transaction(true, (tx) => operationsOfTask(tx, g));
          log.outcome = "read";
          return { log, response: json(200, body) };
        }
        case "operations.get": {
          const body = await transaction(true, (tx) => operationDocument(tx, g));
          log.outcome = "read";
          return { log, response: json(200, body) };
        }
        case "review.decide": {
          const body = g.body as Record<string, unknown> | null;
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            Object.keys(body).sort().join(",") !== "decision,expectedRevision" ||
            g.commandId === null
          )
            throw new WorkReject("invalid");
          const proposalId = g.params.proposalId!;
          const digest = await workRequestDigest(
            "approval.decide",
            g.workspaceId,
            [proposalId],
            body,
          );
          const result = await transaction(false, async (tx) => {
            const a = await context(tx, g);
            return decideApproval(tx, a, {
              commandId: g.commandId!,
              requestDigest: digest,
              proposalId,
              body: body as never,
              correlationId,
            });
          });
          if (result.outcome === "refused") {
            log.outcome = result.code;
            return { log, response: refusalResponse(result.code, correlationId) };
          }
          log.outcome = result.outcome;
          return {
            log,
            response: json(result.outcome === "applied" ? 201 : 200, {
              outcome: result.outcome,
              proposalRef: result.proposalRef,
              approvalRef: result.approvalRef,
              status: result.status,
              effectiveAt: result.effectiveAt,
              expiresAt: result.expiresAt,
            }),
          };
        }
        case "review.apply": {
          // The switch first, before any database access.
          if (!configured.applyOpen || configured.broker === null) {
            log.outcome = "apply_unavailable";
            return { log, response: refusalResponse("apply_unavailable", correlationId) };
          }
          const broker = configured.broker;
          const proposalId = g.params.proposalId!;
          const parsed = parseApplyBody(g.body, proposalId);
          if (!parsed || g.commandId === null) throw new WorkReject("invalid");
          // The apply runs product by product within a longer budget.
          clearTimeout(timer);
          budget = reviewLimits.applyRequestMs;
          timer = setTimeout(() => abort.abort(), budget - (configured.now() - start));
          const claim = await transaction(false, async (tx) => {
            const a = await context(tx, g);
            return refusable(tx, () =>
              admitApply(tx, a, g.commandId!, proposalId, parsed, configured.environment),
            );
          });
          if (claim instanceof ApplyReject) throw claim;
          // The family's operations, read in the claimant's own context (codes only).
          const readOperations = () =>
            transaction(true, async (tx) => {
              await context(tx, g);
              return familyOperations(tx, claim.familyRootId);
            });
          let products = 0;
          for (;;) {
            const left = start + budget - configured.now();
            if (left < reviewLimits.applyProductMinMs) break;
            const pending = (await readOperations()).find((o) => o.status === "authorized");
            if (!pending) break;
            products += 1;
            const dispatched = await transaction(false, async (tx) => {
              const a = await context(tx, g);
              return refusable(tx, () =>
                dispatchOperation(tx, a, pending.operationId, configured.environment),
              );
            });
            if (dispatched instanceof ApplyReject) throw dispatched;
            if (dispatched.kind !== "dispatching") continue;
            await applyThroughBroker(
              broker,
              pending.operationId,
              start + budget,
              abort.signal,
              configured.now,
            );
          }
          log.products = products;
          const operations = await readOperations();
          log.outcome = claim.replayed ? "continued" : "applied";
          return {
            log,
            response: json(200, {
              replayed: claim.replayed,
              pending: operations.filter((o) => o.status === "authorized").length,
              operations: operations.map(operationView),
            }),
          };
        }
        case "operations.reconcile": {
          if (configured.broker === null) {
            log.outcome = "unavailable";
            return { log, response: workErrorResponse("unavailable", correlationId) };
          }
          const body = g.body;
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
            throw new WorkReject("invalid");
          const operationId = g.params.operationId!;
          await transaction(true, async (tx) =>
            visibleOperation(tx, await context(tx, g), operationId),
          );
          let outcome = "unavailable";
          try {
            outcome = decodeShopifyReconcileResult(
              await configured.broker.reconcile(
                operationId,
                Math.min(reviewLimits.reconcileBudgetMs, start + budget - configured.now() - 1500),
                abort.signal,
              ),
            ).outcome;
          } catch {
            outcome = "unavailable";
          }
          const op = await transaction(true, async (tx) =>
            visibleOperation(tx, await context(tx, g), operationId),
          );
          log.outcome = outcome;
          return { log, response: json(200, { outcome, operation: operationView(op) }) };
        }
        case "operations.set_aside": {
          // Nothing reaches the broker: the claimant records that they checked the product.
          const body = g.body;
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
            throw new WorkReject("invalid");
          const operationId = g.params.operationId!;
          const result = await transaction(false, async (tx) => {
            const a = await context(tx, g);
            return refusable(tx, () =>
              setAsideOperation(tx, a, operationId, configured.environment),
            );
          });
          if (result instanceof ApplyReject) throw result;
          const op = await transaction(true, async (tx) =>
            visibleOperation(tx, await context(tx, g), operationId),
          );
          log.outcome = result.changed ? "set_aside" : "unchanged";
          return {
            log,
            response: json(200, { outcome: log.outcome, operation: operationView(op) }),
          };
        }
        case "operations.undo": {
          // Exactly an empty body and a command key; the undo's request digest names the
          // operation only, so the same key repeats the same undo.
          const body = g.body;
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            Object.keys(body).length ||
            g.commandId === null
          )
            throw new WorkReject("invalid");
          const operationId = g.params.operationId!;
          const commandId = g.commandId;
          const digest = await undoRequestDigest(g.workspaceId, operationId);
          clearTimeout(timer);
          budget = reviewLimits.undoRequestMs;
          timer = setTimeout(() => abort.abort(), budget - (configured.now() - start));
          const admittedBody = (u: UndoAdmitted) => ({
            outcome: u.replayed ? "replayed" : "applied",
            proposalId: u.proposalId,
            proposalDigest: u.proposalDigest,
            approvalId: u.approvalId,
            status: u.status,
            expiresAt: u.expiresAt,
            operationId: u.operationId,
          });
          // 1. A replay of this person's own key, else their checks and the undo state.
          const first = await transaction(true, async (tx) => {
            const a = await context(tx, g);
            return undoRefusable(tx, async () => {
              const replayed = await replayedUndo(tx, a, commandId, digest);
              if (replayed) return replayed;
              await prepareUndo(tx, a, operationId);
              return null;
            });
          });
          if (first instanceof UndoReject) throw first;
          if (first !== null) {
            log.outcome = "replayed";
            return { log, response: json(200, admittedBody(first)) };
          }
          // 2. The broker reads the product and records whether it still holds what the apply
          // left (nothing is written to Shopify).
          const check = configured.broker?.undoCheck;
          if (!check) {
            log.outcome = "unavailable";
            return { log, response: workErrorResponse("unavailable", correlationId) };
          }
          let checked: ShopifyUndoCheckResult;
          try {
            checked = decodeShopifyUndoCheckResult(
              await check(
                operationId,
                Math.min(reviewLimits.undoCheckBudgetMs, start + budget - configured.now() - 6000),
                abort.signal,
              ),
            );
          } catch {
            log.outcome = "check_unavailable";
            return { log, response: workErrorResponse("unavailable", correlationId) };
          }
          if (checked.outcome !== "recorded") {
            log.outcome = "check_" + checked.outcome;
            if (checked.outcome === "held")
              return { log, response: workErrorResponse("unavailable", correlationId) };
            throw new UndoReject(
              checked.outcome === "too_soon" ? "undo_too_soon" : checked.outcome,
            );
          }
          if (checked.verdict === "missing") throw new UndoReject("product_missing");
          if (checked.verdict !== "unchanged")
            throw new UndoReject(
              "changed_since_apply",
              Object.entries(checked.fields ?? {})
                .filter(([, v]) => v === "changed")
                .map(([k]) => k),
            );
          // 3. The new exact change, rechecked and stored in SQL.
          const admitted = await transaction(false, async (tx) => {
            const a = await context(tx, g);
            return undoRefusable(tx, async () => {
              const replayed = await replayedUndo(tx, a, commandId, digest);
              if (replayed) return replayed;
              const prepared = await prepareUndo(tx, a, operationId);
              return admitUndo(tx, a, prepared, commandId, digest, checked.sequence!);
            });
          });
          if (admitted instanceof UndoReject) throw admitted;
          log.outcome = admitted.replayed ? "replayed" : "applied";
          return {
            log,
            response: json(admitted.replayed ? 200 : 201, admittedBody(admitted)),
          };
        }
        case "review.batch": {
          const proposalId = g.params.proposalId!;
          clearTimeout(timer);
          budget = reviewLimits.batchRequestMs;
          timer = setTimeout(() => abort.abort(), budget - (configured.now() - start));
          const document = await transaction(
            true,
            async (tx) => {
              const a = await context(tx, g);
              return batchRefusable(tx, () => buildBatch(tx, a, g.sessionDigest, proposalId, null));
            },
            reviewLimits.batchTransactionMs,
          );
          if (document instanceof BatchReject) throw document;
          log.outcome = "read";
          return {
            log,
            response: json(200, {
              proposalId: document.proposalId,
              taskId: document.taskId,
              storeId: document.storeId,
              items: document.items,
              unavailable: document.unavailable,
              confirmation: document.confirmation,
              issuedAt: document.issuedAt,
              expiresAt: document.expiresAt,
              documentDigest: document.documentDigest,
            }),
          };
        }
        case "review.batch_decide": {
          const parsed = parseBatchDecision(g.body);
          if (!parsed || g.commandId === null) throw new WorkReject("invalid");
          const proposalId = g.params.proposalId!;
          const batchKey = g.commandId;
          clearTimeout(timer);
          budget = reviewLimits.batchRequestMs;
          timer = setTimeout(() => abort.abort(), budget - (configured.now() - start));
          const result = await transaction(
            false,
            async (tx) => {
              const a = await context(tx, g);
              return batchRefusable(tx, () =>
                decideBatch(tx, a, g.sessionDigest, proposalId, batchKey, parsed, correlationId),
              );
            },
            reviewLimits.batchTransactionMs,
          );
          if (result instanceof BatchReject) throw result;
          log.outcome = result.replayed ? "replayed" : "applied";
          log.products = result.decided.length;
          return {
            log,
            response: json(result.replayed ? 200 : 201, {
              outcome: log.outcome,
              decided: result.decided,
            }),
          };
        }
      }
    } catch (error) {
      if (error instanceof UndoReject) {
        log.outcome = error.reason;
        return { log, response: undoResponse(error, correlationId) };
      }
      if (error instanceof BatchReject) {
        log.outcome = error.reason;
        return { log, response: batchResponse(error, correlationId) };
      }
      if (error instanceof ApplyReject) {
        log.outcome = error.reason;
        if (error.reason === "invalid")
          return { log, response: workErrorResponse("invalid", correlationId) };
        if (error.reason === "not_found")
          return { log, response: workErrorResponse("not_found", correlationId) };
        if (error.reason === "stale_authority")
          return { log, response: workErrorResponse("stale_authority", correlationId) };
        if (error.reason === "command_conflict")
          return { log, response: workErrorResponse("command_conflict", correlationId) };
        if (error.reason === "limit_reached")
          return { log, response: workErrorResponse("limit_reached", correlationId) };
        if (error.reason === "state_conflict")
          return { log, response: workErrorResponse("state_conflict", correlationId) };
        return { log, response: refusalResponse(error.reason, correlationId) };
      }
      if (error instanceof WorkReject) {
        log.outcome = error.reason;
        const kind = error.reason === "unavailable" && read ? "unavailable_read" : error.reason;
        return { log, response: workErrorResponse(kind, correlationId) };
      }
      if (error instanceof WorkOutcomeUnknown) {
        log.outcome = "uncertain";
        return { log, response: workErrorResponse("uncertain", correlationId) };
      }
      log.outcome = "unavailable";
      return {
        log,
        response: workErrorResponse(read ? "unavailable_read" : "unavailable", correlationId),
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", stop);
    }
    throw new WorkContextUnavailable();
  }
  return Object.freeze({
    async fetch(request: Request, _env: unknown, ctx: Context): Promise<Response> {
      const correlationId = crypto.randomUUID();
      let log: Record<string, unknown> = { route: "unmatched", outcome: "unavailable" };
      try {
        if (!(request instanceof Request)) {
          log.outcome = "invalid";
          return workErrorResponse("invalid", correlationId);
        }
        const handled = await handle(request, ctx, correlationId);
        log = handled.log;
        return handled.response;
      } catch {
        return workErrorResponse("unavailable", correlationId);
      } finally {
        console.log(JSON.stringify({ event: "morrow_review", ...log, correlationId }));
      }
    },
  });
}

/**
 * One dispatching operation through the broker: the apply, then, when Shopify may have applied
 * it (submitted, uncertain, or a call that threw: its outcome is unknown), one immediate
 * read-back. A read-back that cannot run yet is left for the person's "Check again" (POST
 * /operations/:id/reconcile).
 *
 * A `held` pre-send read (nothing fenced or sent) and a call that threw (BROKER_HELD: the
 * isolate's one write slot busy, a vault timeout; or a lost RPC) are tried again after a
 * second, at most twice, while the request has time (review F4). Only this request ever drives
 * the operation (the apply loop dispatches authorized operations only), so giving up after one
 * throw would leave it unsent until R1 closes it as not_sent. A repeat never sends twice: T1
 * answers in_flight once the operation is fenced and refuses after its 120-second dispatch
 * window, and T2 fences under the product and row locks.
 */
export async function applyThroughBroker(
  broker: ApplyBrokerPort,
  operationId: string,
  deadlineMs: number,
  signal: AbortSignal,
  now: () => number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ShopifyApplyResult | null> {
  let result: ShopifyApplyResult | null = null;
  // A call that threw may still have reached Shopify (its RPC lost after the send), whatever a
  // later attempt answers: the read-back below runs whenever one threw.
  let threw = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      if (signal.aborted) break;
      await sleep(1000);
    }
    const budget = Math.min(shopifyWriteLimits.budgetMaxMs, deadlineMs - now() - 2000);
    if (budget < 5000) break;
    try {
      result = decodeShopifyApplyResult(await broker.apply(operationId, budget, signal));
    } catch {
      result = null;
      threw = true;
      continue;
    }
    if (result.outcome !== "held") break;
  }
  if (
    threw ||
    result === null ||
    result.outcome === "submitted" ||
    result.outcome === "uncertain"
  ) {
    const budget = Math.min(reviewLimits.reconcileBudgetMs, deadlineMs - now() - 1000);
    if (budget >= 3000)
      try {
        decodeShopifyReconcileResult(await broker.reconcile(operationId, budget, signal));
      } catch {
        // Left for a later read-back.
      }
  }
  return result;
}
