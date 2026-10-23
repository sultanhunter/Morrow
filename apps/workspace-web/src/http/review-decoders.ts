// v1 PR 3: closed decoders of the review and apply routes' replies (internal JSON between the
// api Worker and this SPA; packages/work/src/review/http.ts). A body that does not match
// exactly decodes to null, which the work outcome mapping turns into an unconfirmed read or an
// uncertain command, never a guess. Product values are plain text the screen shows as text;
// operations carry ids, statuses and reason codes only.
import type {
  ApplyResultView,
  FieldChangeView,
  ListingFieldName,
  OperationView,
  PendingApprovalView,
  ProductReviewView,
  RecordRefView,
  ReviewDecidedView,
  ReviewView,
} from "@morrow/workspace-ui";
import { isId } from "./client";
import { isUtcTime } from "./work-decoders";

type Json = Readonly<Record<string, unknown>>;
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactly = (value: Json, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const code = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(value);
const nullableCode = (value: unknown) => value === null || code(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const productId = (value: unknown): value is string =>
  typeof value === "string" && /^product:[1-9][0-9]{0,19}$/.test(value);
const operationId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !value.includes("\0");
const listingFields: readonly ListingFieldName[] = [
  "title",
  "descriptionHtml",
  "seo.title",
  "seo.description",
  "tags",
];
const strings = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every((t) => text(t, 4096));

/** A ProposalRef or ApprovalRef, exactly as the server sent it (sent back verbatim). */
export function decodeRef(value: unknown, kind: "proposal" | "approval"): RecordRefView | null {
  if (
    !record(value) ||
    !exactly(value, [
      "organizationId",
      "workspaceId",
      "storeId",
      "kind",
      "id",
      "revision",
      "digest",
    ]) ||
    !isId(value.organizationId) ||
    !isId(value.workspaceId) ||
    !(value.storeId === null || isId(value.storeId)) ||
    value.kind !== kind ||
    !isId(value.id) ||
    !integer(value.revision, 1, Number.MAX_SAFE_INTEGER) ||
    !digest(value.digest)
  )
    return null;
  return {
    organizationId: value.organizationId,
    workspaceId: value.workspaceId,
    storeId: value.storeId as string | null,
    kind,
    id: value.id,
    revision: value.revision,
    digest: value.digest,
  };
}

/** One product's apply, as every review and history route returns it (codes only). */
export function decodeOperation(value: unknown): OperationView | null {
  if (
    !record(value) ||
    !exactly(value, [
      "operationId",
      "taskId",
      "storeId",
      "proposalId",
      "productId",
      "targetIndex",
      "status",
      "reason",
      "uncertaintyReason",
      "verdict",
      "attempt",
      "sendStartedAt",
      "submittedAt",
      "createdAt",
      "updatedAt",
    ]) ||
    !operationId(value.operationId) ||
    !isId(value.taskId) ||
    !isId(value.storeId) ||
    !isId(value.proposalId) ||
    !productId(value.productId) ||
    !integer(value.targetIndex, 0, 99) ||
    !code(value.status) ||
    !nullableCode(value.reason) ||
    !nullableCode(value.uncertaintyReason) ||
    !nullableCode(value.verdict) ||
    !integer(value.attempt, 0, 100) ||
    !(value.sendStartedAt === null || isUtcTime(value.sendStartedAt)) ||
    !(value.submittedAt === null || isUtcTime(value.submittedAt)) ||
    !isUtcTime(value.createdAt) ||
    !isUtcTime(value.updatedAt)
  )
    return null;
  return {
    operationId: value.operationId,
    taskId: value.taskId,
    proposalId: value.proposalId,
    productId: value.productId,
    targetIndex: value.targetIndex,
    status: value.status,
    reason: value.reason as string | null,
    uncertaintyReason: value.uncertaintyReason as string | null,
    verdict: value.verdict as string | null,
    updatedAt: value.updatedAt,
  };
}
const operations = (value: unknown, max: number): OperationView[] | null => {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: OperationView[] = [];
  for (const item of value) {
    const o = decodeOperation(item);
    if (!o) return null;
    out.push(o);
  }
  return out;
};

function decodeChange(value: unknown): FieldChangeView | null {
  if (!record(value) || !exactly(value, ["field", "before", "after"])) return null;
  const field = value.field as ListingFieldName;
  if (!listingFields.includes(field)) return null;
  const list = field === "tags";
  const valueOk = (v: unknown) => (list ? strings(v, 250) : text(v, 196608));
  if (!(value.before === null || valueOk(value.before)) || !valueOk(value.after)) return null;
  return {
    field,
    before: value.before as string | readonly string[] | null,
    after: value.after as string | readonly string[],
  };
}
function decodeProduct(value: unknown): ProductReviewView | null {
  if (
    !record(value) ||
    !exactly(value, ["targetIndex", "productId", "source", "changes", "tags", "flags"]) ||
    !integer(value.targetIndex, 0, 99) ||
    !productId(value.productId) ||
    !["available", "expired", "redacted"].includes(value.source as string) ||
    !Array.isArray(value.changes) ||
    value.changes.length < 1 ||
    value.changes.length > 5
  )
    return null;
  const changes: FieldChangeView[] = [];
  for (const c of value.changes) {
    const change = decodeChange(c);
    if (!change || changes.some((x) => x.field === change.field)) return null;
    changes.push(change);
  }
  let tags: ProductReviewView["tags"] = null;
  if (value.tags !== null) {
    const t = value.tags;
    if (
      !record(t) ||
      !exactly(t, ["added", "removed"]) ||
      !strings(t.added, 250) ||
      !strings(t.removed, 250)
    )
      return null;
    tags = { added: [...t.added], removed: [...t.removed] };
  }
  let flags: ProductReviewView["flags"] = null;
  if (value.flags !== null) {
    const f = value.flags;
    if (
      !record(f) ||
      !exactly(f, ["newUrls", "newEmails", "newPhones", "tagsAdded", "tagsRemoved"]) ||
      !Object.values(f).every((n) => integer(n, 0, 999))
    )
      return null;
    flags = {
      newUrls: f.newUrls as number,
      newEmails: f.newEmails as number,
      newPhones: f.newPhones as number,
      tagsAdded: f.tagsAdded as number,
      tagsRemoved: f.tagsRemoved as number,
    };
  }
  return {
    targetIndex: value.targetIndex,
    productId: value.productId,
    source: value.source as ProductReviewView["source"],
    changes,
    tags,
    flags,
  };
}

/** GET /work/proposals/:proposalId/review(?selected=): the review document of that proposal. */
export function decodeReview(body: unknown, proposalId: string): ReviewView | null {
  if (
    !record(body) ||
    !exactly(body, [
      "schemaVersion",
      "proposal",
      "proposalRef",
      "approval",
      "approvalRef",
      "viewerRole",
      "actionable",
      "blocked",
      "confirmation",
      "products",
      "claim",
    ]) ||
    body.schemaVersion !== 1 ||
    !code(body.viewerRole) ||
    typeof body.actionable !== "boolean" ||
    !nullableCode(body.blocked)
  )
    return null;
  const p = body.proposal;
  if (
    !record(p) ||
    !exactly(p, [
      "id",
      "digest",
      "storeId",
      "taskId",
      "capabilityId",
      "risk",
      "targetCount",
      "expiresAt",
      "contextTaint",
      "partialApproval",
      "derivedFromId",
      "selectedTargetIndexes",
    ]) ||
    !isId(p.id) ||
    !digest(p.digest) ||
    !isId(p.storeId) ||
    !(p.taskId === null || isId(p.taskId)) ||
    p.capabilityId !== "catalog.content.publish" ||
    !code(p.risk) ||
    !integer(p.targetCount, 1, 100) ||
    !isUtcTime(p.expiresAt) ||
    (p.partialApproval !== "allowed" && p.partialApproval !== "all_or_nothing") ||
    !(p.derivedFromId === null || isId(p.derivedFromId)) ||
    !(
      p.selectedTargetIndexes === null ||
      (Array.isArray(p.selectedTargetIndexes) &&
        p.selectedTargetIndexes.every((i) => integer(i, 0, 99)))
    )
  )
    return null;
  // The root's own review names the requested proposal; a selection names its derivation.
  if (p.id !== proposalId && p.derivedFromId !== proposalId) return null;
  const proposalRef = decodeRef(body.proposalRef, "proposal");
  if (!proposalRef || proposalRef.id !== p.id || proposalRef.digest !== p.digest) return null;
  let approval: ReviewView["approval"] = null;
  if (body.approval !== null) {
    const a = body.approval;
    if (
      !record(a) ||
      !exactly(a, ["id", "revision", "status", "effectiveAt", "expiresAt"]) ||
      !isId(a.id) ||
      !integer(a.revision, 1, Number.MAX_SAFE_INTEGER) ||
      !code(a.status) ||
      !(a.effectiveAt === null || isUtcTime(a.effectiveAt)) ||
      !isUtcTime(a.expiresAt)
    )
      return null;
    approval = {
      id: a.id,
      revision: a.revision,
      status: a.status,
      effectiveAt: a.effectiveAt as string | null,
      expiresAt: a.expiresAt,
    };
  }
  const approvalRef = body.approvalRef === null ? null : decodeRef(body.approvalRef, "approval");
  if (body.approvalRef !== null && approvalRef === null) return null;
  const c = body.confirmation;
  if (
    !record(c) ||
    !exactly(c, ["required", "phrase"]) ||
    typeof c.required !== "boolean" ||
    !text(c.phrase, 256)
  )
    return null;
  if (!Array.isArray(body.products) || body.products.length > 100) return null;
  const products: ProductReviewView[] = [];
  for (const item of body.products) {
    const product = decodeProduct(item);
    if (!product) return null;
    products.push(product);
  }
  let claim: ReviewView["claim"] = null;
  if (body.claim !== null) {
    const k = body.claim;
    if (
      !record(k) ||
      !exactly(k, ["mine", "approvalId", "proposalId", "operations"]) ||
      typeof k.mine !== "boolean" ||
      !isId(k.approvalId) ||
      !isId(k.proposalId)
    )
      return null;
    const list = operations(k.operations, 100);
    if (!list) return null;
    claim = { mine: k.mine, operations: list };
  }
  return {
    proposal: {
      id: p.id,
      digest: p.digest,
      storeId: p.storeId,
      taskId: p.taskId as string | null,
      targetCount: p.targetCount,
      expiresAt: p.expiresAt,
      partialApproval: p.partialApproval === "allowed",
      untrustedSource: p.contextTaint === "untrusted_external",
      derivedFromId: p.derivedFromId as string | null,
      selectedTargetIndexes: p.selectedTargetIndexes as readonly number[] | null,
    },
    proposalRef,
    approval,
    approvalRef,
    viewerRole: body.viewerRole,
    actionable: body.actionable,
    blocked: body.blocked as string | null,
    confirmation: { required: c.required, phrase: c.phrase },
    products,
    claim,
  };
}

/** POST /work/proposals/:proposalId/decision (201 applied, 200 replayed). */
export function decodeDecided(body: unknown): ReviewDecidedView | null {
  if (
    !record(body) ||
    !exactly(body, [
      "schemaVersion",
      "outcome",
      "proposalRef",
      "approvalRef",
      "status",
      "effectiveAt",
      "expiresAt",
    ]) ||
    body.schemaVersion !== 1 ||
    (body.outcome !== "applied" && body.outcome !== "replayed") ||
    !code(body.status) ||
    !(body.effectiveAt === null || isUtcTime(body.effectiveAt)) ||
    !isUtcTime(body.expiresAt)
  )
    return null;
  const proposalRef = decodeRef(body.proposalRef, "proposal");
  const approvalRef = decodeRef(body.approvalRef, "approval");
  if (!proposalRef || !approvalRef) return null;
  return { proposalRef, approvalRef, status: body.status, expiresAt: body.expiresAt };
}

/** POST /work/proposals/:proposalId/apply: each product's result, and how many still wait. */
export function decodeApplied(body: unknown): ApplyResultView | null {
  if (
    !record(body) ||
    !exactly(body, ["schemaVersion", "replayed", "pending", "operations"]) ||
    body.schemaVersion !== 1 ||
    typeof body.replayed !== "boolean" ||
    !integer(body.pending, 0, 100)
  )
    return null;
  const list = operations(body.operations, 100);
  return list && list.length >= 1 ? { pending: body.pending, operations: list } : null;
}

/** GET /work/tasks/:taskId/operations (at most 100, newest first). */
export function decodeOperationsOfTask(
  body: unknown,
  taskId: string,
): readonly OperationView[] | null {
  if (!record(body) || !exactly(body, ["schemaVersion", "operations"]) || body.schemaVersion !== 1)
    return null;
  const list = operations(body.operations, 100);
  return list && list.every((o) => o.taskId === taskId) ? list : null;
}

/** POST /work/operations/:operationId/reconcile: the operation after the read-back. */
export function decodeRechecked(body: unknown, id: string): OperationView | null {
  if (
    !record(body) ||
    !exactly(body, ["schemaVersion", "outcome", "operation"]) ||
    body.schemaVersion !== 1 ||
    !code(body.outcome)
  )
    return null;
  const o = decodeOperation(body.operation);
  return o && o.operationId === id ? o : null;
}

/** GET /work/approvals: the pending approvals this person may see. */
export function decodePendingApprovals(body: unknown): readonly PendingApprovalView[] | null {
  if (
    !record(body) ||
    !exactly(body, ["schemaVersion", "items", "next"]) ||
    body.schemaVersion !== 1
  )
    return null;
  if (
    !Array.isArray(body.items) ||
    body.items.length > 25 ||
    !(body.next === null || text(body.next, 1024))
  )
    return null;
  const items: PendingApprovalView[] = [];
  for (const v of body.items) {
    if (
      !record(v) ||
      !exactly(v, [
        "proposalId",
        "proposalDigest",
        "storeId",
        "approvalId",
        "capabilityId",
        "risk",
        "targetCount",
        "expiresAt",
        "viewerRole",
      ]) ||
      !isId(v.proposalId) ||
      !digest(v.proposalDigest) ||
      !(v.storeId === null || isId(v.storeId)) ||
      !isId(v.approvalId) ||
      typeof v.capabilityId !== "string" ||
      !/^[a-z]+(\.[a-z_]+)+$/.test(v.capabilityId) ||
      !code(v.risk) ||
      !integer(v.targetCount, 1, 100) ||
      !isUtcTime(v.expiresAt) ||
      !code(v.viewerRole)
    )
      return null;
    items.push({
      proposalId: v.proposalId,
      storeId: v.storeId as string | null,
      capabilityId: v.capabilityId,
      targetCount: v.targetCount,
      expiresAt: v.expiresAt,
      viewerRole: v.viewerRole,
    });
  }
  return items;
}
