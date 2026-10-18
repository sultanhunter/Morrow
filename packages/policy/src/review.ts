// The review library for contract v1.1 (P01.T02a §7; ADR-0011). Pure: no I/O,
// clock or randomness; times are always arguments. It takes closed, frozen
// values plus trusted facts from review-facts.ts and returns codes, never
// authority. P11.T01 imports it rather than re-implementing it; P05.T01z,
// P11 and P14 build the routes, storage and UI around it.
import { createHash } from "node:crypto";
import type {
  Current_ActorRef,
  Current_Approval,
  Current_ApprovalDecision,
  Current_ApprovalRef,
  Current_HumanActorRef,
  Current_NonNegativeMoney,
  Current_PolicyRef,
  Current_Proposal,
  Current_ProposalRef,
  Current_ReviewPolicy,
  Current_ReviewPolicyRules,
  Current_RiskClass,
} from "@morrow/contracts";
import {
  validateCapabilityInput,
  validateCapabilityOutput,
  validateCurrentDefinition,
} from "@morrow/contracts/validation";
import catalogue from "../../../docs/contracts/capabilities.json";
import defaults from "../../../docs/contracts/review-policy-defaults.json";
import type { PermissionResult } from "./index";
import { plainJson, closed, freezeJson } from "./json-boundary";
import { isWorkspaceOwnershipFacts } from "./review-facts";
import type {
  DecisionAttempt,
  DispatchFacts,
  ProposalFacts,
  ReviewAttemptSuccess,
  ReviewCommandRecord,
  ReviewMember,
  ReviewState,
  ReviewTransition,
  WorkspaceOwnershipFacts,
} from "./review-facts";
export type * from "./review-facts";

export type ReviewCode =
  // checkProposal: server-derived fields (§7 item 1)
  | "RISK_CLASS_MISMATCH"
  | "IRREVERSIBLE_MISMATCH"
  | "REQUESTED_BY_MISMATCH"
  | "BENEFICIARIES_MISMATCH"
  | "CONTEXT_TAINT_MISMATCH"
  | "PROPOSED_BY_MISMATCH"
  // checkProposal: the work task (ADR-0018)
  | "TASK_MISMATCH"
  | "TASK_REQUIRED"
  | "REVIEW_POLICY_NOT_CURRENT"
  | "TENANT_MISMATCH"
  | "TARGET_SCOPE_MISMATCH"
  | "PARAMETERS_DIGEST_MISMATCH"
  | "PROPOSAL_DIGEST_MISMATCH"
  // ceilings and quorum (§7 items 2-3)
  | "CREDITS_SUM_MISMATCH"
  | "COST_SUM_MISMATCH"
  | "QUORUM_UNREACHABLE"
  // partial approval (§7 item 8)
  | "SELECTION_INVALID"
  | "PARTIAL_APPROVAL_NOT_ALLOWED"
  // decisions (§7 items 4-11)
  | "REVIEWER_DENIED"
  | "SELF_APPROVAL_DENIED"
  | "CONFIRMATION_MISMATCH"
  | "CANCEL_NOT_ALLOWED"
  | "DIGEST_MISMATCH"
  | "COMMAND_CONFLICT"
  | "DUPLICATE_REVIEWER"
  | "FAMILY_CONFLICT"
  | "STALE_REVISION"
  | "APPROVAL_NOT_PENDING"
  // dispatch (§7 item 10)
  | "NOT_APPROVED"
  | "APPROVAL_NOT_EFFECTIVE"
  | "APPROVAL_EXPIRED"
  | "SOLO_OWNER_STATUS_LOST";
export type RiskClass = Current_RiskClass;
export type SelfApproval = "denied" | "solo_owner_typed_confirmation" | "allowed";
export interface EffectiveRule {
  readonly requiredApprovals: number;
  readonly selfApproval: SelfApproval;
  readonly pendingExpirySeconds: number;
  readonly approvedValiditySeconds: number;
  /** null applies no narrowing; a list (possibly empty after a merge) is the only eligible principals. */
  readonly eligibleReviewerPrincipalIds: readonly string[] | null;
}
export interface ReviewAttemptFailure {
  readonly ok: false;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly code: ReviewCode;
  readonly category: ReviewErrorCategory;
  readonly retry: ReviewRetryClass;
  readonly safeMessage: string;
}
export type ReviewAttemptResult = ReviewAttemptSuccess | ReviewAttemptFailure;
export interface FoldResult {
  readonly state: ReviewState;
  readonly results: readonly ReviewAttemptResult[];
  /** Approvals the fold invalidated, as they were before: P11 persists the invalidation. */
  readonly invalidate: readonly Current_ApprovalRef[];
}
/** ErrorEnvelope code and retry class for a review code (§7 item 13). */
export type ReviewErrorCategory = "denied" | "conflict" | "approval_expired";
export type ReviewRetryClass = "never" | "recheck_before_retry";
export class ReviewBoundaryError extends Error {
  constructor(readonly code: "REVIEW_INPUT_INVALID" | "REVIEW_FACTS_INVALID") {
    super(code);
    this.name = "ReviewBoundaryError";
  }
}

const capabilities = new Map(catalogue.capabilities.map((c) => [c.id, c]));
// The fixed effect-to-risk table (ADR-0011 Q9); verify:contracts checks it is total.
const riskClassByEffect: Readonly<Record<string, RiskClass>> = Object.freeze({
  ...(defaults.riskClassByEffect as Record<string, RiskClass>),
});
const decideFields = Object.freeze(
  Object.keys(capabilities.get("governance.approval.decide")?.input.fields ?? {}),
);
const valid = (name: Parameters<typeof validateCurrentDefinition>[0], value: unknown) =>
  validateCurrentDefinition(name, value);

// --- Errors (§7 item 13): existence-free messages, fixed per code ---------------
const conflictCodes: ReadonlySet<ReviewCode> = new Set([
  "DIGEST_MISMATCH",
  "COMMAND_CONFLICT",
  "DUPLICATE_REVIEWER",
  "FAMILY_CONFLICT",
  "STALE_REVISION",
  "REVIEW_POLICY_NOT_CURRENT",
  "APPROVAL_NOT_PENDING",
  "APPROVAL_NOT_EFFECTIVE",
]);
const messages: Partial<Record<ReviewCode, string>> = {
  CONFIRMATION_MISMATCH: "The confirmation phrase does not match this proposal.",
  SELECTION_INVALID: "The selected changes are not a valid part of this proposal.",
  PARTIAL_APPROVAL_NOT_ALLOWED: "This proposal can only be decided as a whole.",
  CANCEL_NOT_ALLOWED: "This approval can no longer be cancelled.",
  APPROVAL_EXPIRED: "Current approval does not permit this request.",
  APPROVAL_NOT_EFFECTIVE: "This approval is not in effect yet.",
};
export function reviewError(code: ReviewCode): {
  readonly category: ReviewErrorCategory;
  readonly retry: ReviewRetryClass;
  readonly safeMessage: string;
} {
  const category: ReviewErrorCategory =
    code === "APPROVAL_EXPIRED"
      ? "approval_expired"
      : conflictCodes.has(code)
        ? "conflict"
        : "denied";
  return Object.freeze({
    category,
    retry: category === "conflict" ? "recheck_before_retry" : "never",
    safeMessage:
      messages[code] ??
      (category === "conflict"
        ? "The review changed; reread it before deciding."
        : "This review action is not permitted."),
  });
}

// --- Canonical digests (RFC 8785 JCS over closed JSON, SHA-256) ----------------
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(record[k]))
      .join(",") +
    "}"
  );
}
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** sha256 of the RFC 8785 canonical JSON of a closed JSON value. */
export const canonicalDigest = (value: unknown): string => sha256(canonical(value));
/** The proposal digest: every field except `proposalDigest` itself is bound. */
export function proposalDigest(p: Current_Proposal): string {
  const { proposalDigest: _omitted, ...content } = p;
  return canonicalDigest(content);
}
export const proposalRef = (p: Current_Proposal): Current_ProposalRef => ({
  organizationId: p.organizationId,
  workspaceId: p.workspaceId,
  storeId: p.storeId,
  kind: "proposal",
  id: p.id,
  revision: p.revision,
  digest: p.proposalDigest,
});
/** The one reference a proposal and an approval may bind for a workspace's review policy. */
export const reviewPolicyRef = (policy: Current_ReviewPolicy): Current_PolicyRef => ({
  organizationId: policy.organizationId,
  workspaceId: policy.workspaceId,
  storeId: null,
  kind: "policy",
  id: policy.id,
  revision: policy.revision,
  digest: canonicalDigest(policy),
});
export const approvalRef = (a: Current_Approval): Current_ApprovalRef => ({
  organizationId: a.organizationId,
  workspaceId: a.workspaceId,
  storeId: a.storeId,
  kind: "approval",
  id: a.id,
  revision: a.revision,
  digest: canonicalDigest(a),
});
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

// --- Time (UtcTime strings; arithmetic only, never a clock read) ---------------
function ms(t: string): number {
  const value = Date.parse(t);
  if (!Number.isFinite(value)) throw new ReviewBoundaryError("REVIEW_FACTS_INVALID");
  return value;
}
const plusSeconds = (t: string, seconds: number) => new Date(ms(t) + seconds * 1000).toISOString();
const earliest = (a: string, b: string) => (ms(a) <= ms(b) ? a : b);

// --- Ceilings (§7 item 2): BigInt only -----------------------------------------
const micros = (amount: string) => {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
};
const scale = (amount: string) => amount.split(".")[1]?.length ?? 0;
function formatMicros(value: bigint, digits: number): string {
  const whole = (value / 1_000_000n).toString();
  if (digits === 0) return whole;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").slice(0, digits);
  return `${whole}.${fraction}`;
}
const creditSum = (targets: Current_Proposal["targets"]) =>
  targets.reduce((sum, t) => sum + BigInt(t.maximumCredits), 0n);
/** The exact cash sum of the target ceilings, `null` when every one is null, or "mixed" for several currencies. */
function costSum(targets: Current_Proposal["targets"]): Current_NonNegativeMoney | null | "mixed" {
  const costs = targets.flatMap((t) => (t.maximumCost === null ? [] : [t.maximumCost]));
  if (!costs.length) return null;
  const currency = costs[0]!.currency;
  if (costs.some((c) => c.currency !== currency)) return "mixed";
  const digits = Math.max(...costs.map((c) => scale(c.amount)));
  return {
    amount: formatMicros(
      costs.reduce((sum, c) => sum + micros(c.amount), 0n),
      digits,
    ),
    currency,
  };
}
function ceilingCodes(p: Current_Proposal): ReviewCode[] {
  const codes: ReviewCode[] = [];
  if (creditSum(p.targets) !== BigInt(p.maximumCredits)) codes.push("CREDITS_SUM_MISMATCH");
  const cost = costSum(p.targets);
  if (
    cost === "mixed" ||
    (cost === null) !== (p.maximumCost === null) ||
    (cost !== null &&
      p.maximumCost !== null &&
      (cost.currency !== p.maximumCost.currency ||
        micros(cost.amount) !== micros(p.maximumCost.amount)))
  )
    codes.push("COST_SUM_MISMATCH");
  return codes;
}

// --- Boundary parsing: closed, cloned and frozen --------------------------------
function snapshot<T>(
  value: unknown,
  check: (v: unknown) => boolean,
  code: ReviewBoundaryError["code"],
): T {
  let ok = false;
  try {
    ok = plainJson(value) && check(value);
  } catch {
    ok = false;
  }
  if (!ok) throw new ReviewBoundaryError(code);
  return freezeJson(JSON.parse(JSON.stringify(value))) as T;
}
const ids = (value: unknown, max: number) =>
  Array.isArray(value) &&
  value.length <= max &&
  new Set(value).size === value.length &&
  value.every((v) => valid("Id", v));
const isProposal = (value: unknown): value is Current_Proposal =>
  valid("Proposal", value) && capabilities.has((value as Current_Proposal).capabilityId);
const isPolicy = (value: unknown) => valid("ReviewPolicy", value);
const sameTenant = (
  a: { organizationId: string; workspaceId: string | null },
  b: { organizationId: string; workspaceId: string | null },
) => a.organizationId === b.organizationId && a.workspaceId === b.workspaceId;
const conflictSet = (p: Current_Proposal) =>
  new Set([p.proposedBy.principalId, p.requestedBy.principalId, ...p.beneficiaryPrincipalIds]);

// --- Effective rule (§7 item 3) -------------------------------------------------
const strictness: readonly SelfApproval[] = ["denied", "solo_owner_typed_confirmation", "allowed"];
/**
 * `rules[risk]`, merged field by field with `rules.irreversible` for an
 * irreversible proposal, taking the stricter value: the larger quorum, the
 * shorter expiries, the stricter self-approval and the intersection of reviewer lists.
 */
export function effectiveRule(
  rules: Current_ReviewPolicyRules,
  risk: RiskClass,
  irreversible: boolean,
): EffectiveRule {
  const r = snapshot<Current_ReviewPolicyRules>(
    rules,
    (v) => valid("ReviewPolicyRules", v),
    "REVIEW_INPUT_INVALID",
  );
  if (!valid("RiskClass", risk) || typeof irreversible !== "boolean")
    throw new ReviewBoundaryError("REVIEW_INPUT_INVALID");
  const base = r[risk];
  if (!irreversible) return freezeJson({ ...base }) as EffectiveRule;
  const extra = r.irreversible;
  const first = base.eligibleReviewerPrincipalIds;
  const second = extra.eligibleReviewerPrincipalIds;
  return freezeJson({
    requiredApprovals: Math.max(base.requiredApprovals, extra.requiredApprovals),
    selfApproval:
      strictness[
        Math.min(strictness.indexOf(base.selfApproval), strictness.indexOf(extra.selfApproval))
      ]!,
    pendingExpirySeconds: Math.min(base.pendingExpirySeconds, extra.pendingExpirySeconds),
    approvedValiditySeconds: Math.min(base.approvedValiditySeconds, extra.approvedValiditySeconds),
    eligibleReviewerPrincipalIds:
      first === null ? second : second === null ? first : first.filter((id) => second.includes(id)),
  }) as EffectiveRule;
}
/** The fixed risk class of a capability's catalogue effect (ADR-0011 Q9). */
export function riskClassFor(capabilityId: string): RiskClass {
  const capability = capabilities.get(capabilityId);
  const risk = capability && riskClassByEffect[capability.effect];
  if (!risk) throw new ReviewBoundaryError("REVIEW_INPUT_INVALID");
  return risk;
}
const ruleFor = (policy: Current_ReviewPolicy, p: Current_Proposal) => {
  const capability = capabilities.get(p.capabilityId)!;
  return effectiveRule(policy.rules, riskClassFor(p.capabilityId), capability.irreversible);
};

// --- Solo owner (§7 item 6) -----------------------------------------------------
/**
 * Solo status at `at`: the reviewer is the designated owner, the only active
 * human member, and no membership change happened within the quiet period.
 */
export function soloOwnerStatus(
  ownership: WorkspaceOwnershipFacts,
  principalId: string,
  at: string,
  quietPeriodSeconds: number,
): boolean {
  return (
    principalId === ownership.ownerPrincipalId &&
    ownership.activeHumanMembershipCount === 1 &&
    (ownership.lastMembershipChangeAt === null ||
      ms(at) >= ms(ownership.lastMembershipChangeAt) + quietPeriodSeconds * 1000)
  );
}
/**
 * The exact phrase a solo owner types (NFC, case-sensitive): `approve N
 * change(s) for C credits`, plus ` and A CUR` when there is a cost, with the
 * amounts copied as written.
 */
export function confirmationPhrase(p: Current_Proposal): string {
  const n = p.targets.length;
  const cost = p.maximumCost ? ` and ${p.maximumCost.amount} ${p.maximumCost.currency}` : "";
  return `approve ${n} ${n === 1 ? "change" : "changes"} for ${p.maximumCredits} credits${cost}`.normalize(
    "NFC",
  );
}

// --- checkProposal (§7 items 1-3) -----------------------------------------------
/**
 * Whether a proposal may have no work task (ADR-0018): only when a human
 * proposes a capability in the catalogue's Governance domain. Agents, and every
 * other non-human proposer, always need a task, including work under a mandate.
 */
const taskOptional = (capabilityId: string, proposedBy: Current_ActorRef) =>
  capabilities.get(capabilityId)?.domain === "Governance" && proposedBy.kind === "human";
function parseProposalFacts(value: unknown): ProposalFacts {
  return snapshot<ProposalFacts>(
    value,
    (v) =>
      closed(v, [
        "organizationId",
        "workspaceId",
        "storeId",
        "proposedBy",
        "taskId",
        "requestedBy",
        "beneficiaryPrincipalIds",
        "contextTaint",
        "reviewPolicy",
        "eligibleReviewerPrincipalIds",
        "ownership",
        "at",
      ]) &&
      valid("Id", v.organizationId) &&
      valid("Id", v.workspaceId) &&
      (v.storeId === null || valid("Id", v.storeId)) &&
      valid("ActorRef", v.proposedBy) &&
      // A task has an initiator or mandate owner; no task has none (ADR-0018).
      (v.taskId === null
        ? v.requestedBy === null
        : valid("Id", v.taskId) && valid("HumanActorRef", v.requestedBy)) &&
      ids(v.beneficiaryPrincipalIds, 100) &&
      (v.contextTaint === "none" || v.contextTaint === "untrusted_external") &&
      isPolicy(v.reviewPolicy) &&
      sameTenant(v.reviewPolicy as Current_ReviewPolicy, v as unknown as ProposalFacts) &&
      ids(v.eligibleReviewerPrincipalIds, 1000) &&
      isWorkspaceOwnershipFacts(v.ownership) &&
      valid("UtcTime", v.at),
    "REVIEW_FACTS_INVALID",
  );
}
/**
 * Checks a server-built proposal against trusted facts. Returns every code
 * that applies, in a fixed order; an empty list means the proposal may be
 * stored and reviewed. Throws ReviewBoundaryError for a malformed proposal or facts.
 */
export function checkProposal(
  proposal: Current_Proposal,
  facts: ProposalFacts,
): readonly ReviewCode[] {
  const p = snapshot<Current_Proposal>(proposal, isProposal, "REVIEW_INPUT_INVALID");
  const f = parseProposalFacts(facts);
  const capability = capabilities.get(p.capabilityId)!;
  const codes: ReviewCode[] = [];
  // Every ref lies in the trusted organization, workspace and proposal store,
  // and the scope names exactly the proposal store (none for a storeless one).
  // The review policy is per workspace, so its store is checked as currency below.
  const inStore = (r: { organizationId: string; workspaceId: string; storeId: string | null }) =>
    sameTenant(r, f) && r.storeId === p.storeId;
  if (
    !sameTenant(p, f) ||
    p.storeId !== f.storeId ||
    !sameTenant(p.scope, f) ||
    !same(p.scope.storeIds, p.storeId === null ? [] : [p.storeId]) ||
    !p.scope.resources.every(inStore) ||
    !p.targets.every((t) => inStore(t.resource)) ||
    !inStore(p.parametersRef) ||
    !sameTenant(p.reviewPolicyRef, f) ||
    (p.derivedFrom !== null && !inStore(p.derivedFrom.parentRef))
  )
    codes.push("TENANT_MISMATCH");
  if (
    !p.targets.every(
      (t) =>
        p.scope.resources.some((r) => same(r, t.resource)) &&
        t.fields.every((field) => p.scope.fields.includes(field)),
    )
  )
    codes.push("TARGET_SCOPE_MISMATCH");
  // The parameters reference and the bound parameters digest name one artifact.
  if (p.parametersRef.digest !== p.parametersDigest) codes.push("PARAMETERS_DIGEST_MISMATCH");
  const risk = riskClassFor(p.capabilityId);
  if (p.risk !== risk) codes.push("RISK_CLASS_MISMATCH");
  if (p.irreversible !== capability.irreversible) codes.push("IRREVERSIBLE_MISMATCH");
  if (!same(p.proposedBy, f.proposedBy)) codes.push("PROPOSED_BY_MISMATCH");
  // The work task is the one the producer attached (ADR-0018). Without one, the
  // proposal must be human-made and in the Governance domain, and `requestedBy`
  // is the proposer, so the proposer stays in the conflict set in both roles.
  if (p.taskId !== f.taskId) codes.push("TASK_MISMATCH");
  if ((p.taskId === null || f.taskId === null) && !taskOptional(p.capabilityId, f.proposedBy))
    codes.push("TASK_REQUIRED");
  if (!same(p.requestedBy, f.taskId === null ? f.proposedBy : f.requestedBy))
    codes.push("REQUESTED_BY_MISMATCH");
  if (
    p.beneficiaryPrincipalIds.length !== f.beneficiaryPrincipalIds.length ||
    !p.beneficiaryPrincipalIds.every((id) => f.beneficiaryPrincipalIds.includes(id))
  )
    codes.push("BENEFICIARIES_MISMATCH");
  if (p.contextTaint !== f.contextTaint) codes.push("CONTEXT_TAINT_MISMATCH");
  // The workspace's single current policy: same id, revision and digest, storeId null.
  if (!same(p.reviewPolicyRef, reviewPolicyRef(f.reviewPolicy)))
    codes.push("REVIEW_POLICY_NOT_CURRENT");
  codes.push(...ceilingCodes(p));
  if (p.proposalDigest !== proposalDigest(p)) codes.push("PROPOSAL_DIGEST_MISMATCH");
  // Quorum must be reachable by eligible reviewers who may approve, or by a solo
  // owner. Under `allowed` conflicted reviewers may approve, so they count too.
  const rule = effectiveRule(f.reviewPolicy.rules, risk, capability.irreversible);
  const conflicted = conflictSet(p);
  const candidates = f.eligibleReviewerPrincipalIds.filter(
    (id) =>
      rule.eligibleReviewerPrincipalIds === null || rule.eligibleReviewerPrincipalIds.includes(id),
  );
  const reachable =
    rule.selfApproval === "allowed"
      ? candidates.length
      : candidates.filter((id) => !conflicted.has(id)).length;
  // The fold takes the solo path only for a conflicted owner (§7 items 5-6); an
  // owner outside the conflict set is an ordinary candidate, counted above.
  const solo =
    rule.selfApproval === "solo_owner_typed_confirmation" &&
    candidates.includes(f.ownership.ownerPrincipalId) &&
    conflicted.has(f.ownership.ownerPrincipalId) &&
    soloOwnerStatus(
      f.ownership,
      f.ownership.ownerPrincipalId,
      f.at,
      f.reviewPolicy.rules.soloOwner.quietPeriodSeconds,
    );
  if (reachable < rule.requiredApprovals && !solo) codes.push("QUORUM_UNREACHABLE");
  return Object.freeze(codes);
}

// --- Partial approval (§7 item 8) -----------------------------------------------
function derive(parent: Current_Proposal, selected: unknown): Current_Proposal | ReviewCode {
  // Re-derivation is invalid before the partial-approval mode is consulted.
  if (parent.derivedFrom !== null) return "SELECTION_INVALID";
  if (parent.partialApproval === "all_or_nothing") return "PARTIAL_APPROVAL_NOT_ALLOWED";
  const n = parent.targets.length;
  if (
    !Array.isArray(selected) ||
    selected.length < 1 ||
    selected.length >= n ||
    !selected.every(
      (index, i) =>
        Number.isSafeInteger(index) &&
        index >= 0 &&
        index < n &&
        (i === 0 || index > (selected[i - 1] as number)),
    )
  )
    return "SELECTION_INVALID";
  const indexes = selected as number[];
  const parentCodes = ceilingCodes(parent);
  if (parentCodes.length) return parentCodes[0]!;
  if (parent.proposalDigest !== proposalDigest(parent)) return "PROPOSAL_DIGEST_MISMATCH";
  const parentRef = proposalRef(parent);
  const targets = indexes.map((i) => parent.targets[i]!);
  const cost = costSum(targets);
  if (cost === "mixed") return "COST_SUM_MISMATCH";
  const derivedFrom = { parentRef, selectedTargetIndexes: [...indexes] };
  // The scope narrows to the selected change set: only the selected targets'
  // resources and fields, in the parent's order, so the scope digest changes too.
  const scope = {
    ...parent.scope,
    resources: parent.scope.resources.filter((r) => targets.some((t) => same(r, t.resource))),
    fields: parent.scope.fields.filter((field) => targets.some((t) => t.fields.includes(field))),
  };
  const content: Current_Proposal = {
    ...parent,
    id: "derived_" + canonicalDigest(derivedFrom),
    revision: 1,
    scope,
    targets,
    maximumCredits: creditSum(targets).toString(),
    maximumCost: cost,
    derivedFrom,
    partialApproval: "all_or_nothing",
    proposalDigest: "0".repeat(64),
  };
  const derived = { ...content, proposalDigest: proposalDigest(content) };
  // Derivation never raises a ceiling or extends expiry.
  if (
    BigInt(derived.maximumCredits) > BigInt(parent.maximumCredits) ||
    (derived.maximumCost !== null &&
      (parent.maximumCost === null ||
        micros(derived.maximumCost.amount) > micros(parent.maximumCost.amount))) ||
    derived.expiresAt !== parent.expiresAt ||
    !isProposal(derived)
  )
    throw new ReviewBoundaryError("REVIEW_INPUT_INVALID");
  return freezeJson(derived) as Current_Proposal;
}
/**
 * The deterministic proposal a decision on `selected` binds
 * (`governance.approval.preview`). `null` previews the whole proposal.
 */
export function previewSelection(
  parent: Current_Proposal,
  selected: readonly number[] | null,
): { readonly proposal: Current_Proposal } | { readonly code: ReviewCode } {
  const p = snapshot<Current_Proposal>(parent, isProposal, "REVIEW_INPUT_INVALID");
  if (selected === null) return Object.freeze({ proposal: p });
  let s: unknown;
  try {
    s = plainJson(selected) ? JSON.parse(JSON.stringify(selected)) : null;
  } catch {
    s = null;
  }
  const result = derive(p, s);
  return Object.freeze(typeof result === "string" ? { code: result } : { proposal: result });
}

// --- Eligibility (§7 item 4) ----------------------------------------------------
/** The human policy evaluator, bound to the reviewer's current session (createHumanPolicyService). */
export interface ReviewerPermissionPort {
  decide(request: unknown): Promise<PermissionResult>;
}
/**
 * Composes the human evaluator: the reviewer holds `approve` on
 * `governance.approval.decide` for the workspace, and `approve` on the
 * proposal's capability covering every decided target's resource, store,
 * account and fields. The evaluator also requires a current human membership.
 * The effective rule's reviewer list is applied by `foldDecisions`.
 * `targetAccountIds[i]` is the trusted account of target `i` (null for none).
 */
export async function reviewerEligible(
  port: ReviewerPermissionPort,
  proposal: Current_Proposal,
  selectedTargetIndexes: readonly number[] | null,
  targetAccountIds: readonly (string | null)[],
): Promise<boolean> {
  const p = snapshot<Current_Proposal>(proposal, isProposal, "REVIEW_INPUT_INVALID");
  const accounts = snapshot<(string | null)[]>(
    targetAccountIds,
    (v) =>
      Array.isArray(v) &&
      v.length === p.targets.length &&
      v.every((a) => a === null || valid("Id", a)),
    "REVIEW_FACTS_INVALID",
  );
  let indexes: number[] = p.targets.map((_, i) => i);
  if (selectedTargetIndexes !== null) {
    const derived = previewSelection(p, selectedTargetIndexes);
    if ("code" in derived) return false;
    indexes = derived.proposal.derivedFrom!.selectedTargetIndexes;
  }
  const workspace = {
    organizationId: p.organizationId,
    workspaceId: p.workspaceId,
    storeId: null,
    connectionId: null,
    kind: "workspace",
    id: p.workspaceId,
  };
  const requests = [
    {
      capabilityId: "governance.approval.decide",
      verb: "approve",
      resource: workspace,
      accountId: null,
      fields: [...decideFields],
    },
    ...indexes.map((i) => ({
      capabilityId: p.capabilityId,
      verb: "approve",
      resource: p.targets[i]!.resource,
      accountId: accounts[i]!,
      fields: [...p.targets[i]!.fields],
    })),
  ];
  for (const request of requests) if (!(await port.decide(request)).decision.allowed) return false;
  return true;
}

// --- Decision fold (§7 items 5-11) ----------------------------------------------
function parseState(value: unknown): ReviewState {
  const state = snapshot<ReviewState>(
    value,
    (v) =>
      closed(v, ["revision", "members", "commands"]) &&
      valid("Revision", v.revision) &&
      Array.isArray(v.members) &&
      v.members.length >= 1 &&
      v.members.length <= 1000 &&
      v.members.every(
        (m) =>
          closed(m, ["proposal", "approval"]) &&
          isProposal(m.proposal) &&
          valid("Approval", m.approval),
      ) &&
      Array.isArray(v.commands) &&
      v.commands.length <= 100000 &&
      v.commands.every(
        (c) =>
          closed(c, ["commandId", "requestDigest", "reviewer", "result"]) &&
          valid("Id", c.commandId) &&
          valid("Digest", c.requestDigest) &&
          valid("HumanActorRef", c.reviewer),
      ),
    "REVIEW_FACTS_INVALID",
  );
  // Members are self-consistent: the root first, derivations recomputed exactly,
  // each approval bound to its proposal, at most one approved, unique commands.
  const [root] = state.members;
  const rootRef = proposalRef(root!.proposal);
  const consistent =
    root!.proposal.derivedFrom === null &&
    state.members.every((m, i) => {
      const a = m.approval;
      const derivedOk =
        i === 0 ||
        (m.proposal.derivedFrom !== null &&
          same(m.proposal.derivedFrom.parentRef, rootRef) &&
          same(derive(root!.proposal, m.proposal.derivedFrom.selectedTargetIndexes), m.proposal));
      return (
        derivedOk &&
        same(a.proposalRef, proposalRef(m.proposal)) &&
        a.proposalDigest === m.proposal.proposalDigest &&
        sameTenant(a, m.proposal) &&
        a.storeId === m.proposal.storeId
      );
    }) &&
    new Set(state.members.map((m) => m.proposal.id)).size === state.members.length &&
    state.members.filter((m) => m.approval.status === "approved").length <= 1 &&
    new Set(state.commands.map((c) => c.commandId)).size === state.commands.length &&
    state.commands.every(
      (c) =>
        c.result.ok === true &&
        c.result.commandId === c.commandId &&
        c.result.requestDigest === c.requestDigest,
    );
  if (!consistent) throw new ReviewBoundaryError("REVIEW_FACTS_INVALID");
  return state;
}
function parseAttempt(value: unknown, root: Current_Proposal): DecisionAttempt {
  const a = snapshot<DecisionAttempt>(
    value,
    (v) =>
      closed(v, [
        "commandId",
        "requestDigest",
        "reviewer",
        "input",
        "at",
        "reviewerEligible",
        "eligibleReviewerPrincipalIds",
        "ownership",
        "currentPolicy",
      ]) &&
      valid("Id", v.commandId) &&
      valid("Digest", v.requestDigest) &&
      valid("HumanActorRef", v.reviewer) &&
      validateCapabilityInput("governance.approval.decide", v.input) &&
      valid("UtcTime", v.at) &&
      typeof v.reviewerEligible === "boolean" &&
      ids(v.eligibleReviewerPrincipalIds, 1000) &&
      isWorkspaceOwnershipFacts(v.ownership) &&
      isPolicy(v.currentPolicy),
    "REVIEW_INPUT_INVALID",
  );
  // The current policy is a trusted fact of the family's workspace.
  if (!sameTenant(a.currentPolicy, root)) throw new ReviewBoundaryError("REVIEW_FACTS_INVALID");
  ms(a.at);
  return a;
}
const transition = (
  approvalId: string,
  from: ReviewTransition["from"],
  to: ReviewTransition["to"],
  actor: ReviewTransition["actor"],
  guard: string,
): ReviewTransition => ({ aggregate: "approval", approvalId, from, to, actor, guard });
interface Step {
  readonly state: ReviewState;
  readonly result: ReviewAttemptResult;
  readonly invalidate: readonly Current_ApprovalRef[];
}
function decideOne(state: ReviewState, a: DecisionAttempt): Step {
  const fail = (code: ReviewCode): Step => ({
    state,
    result: {
      ok: false,
      commandId: a.commandId,
      requestDigest: a.requestDigest,
      code,
      ...reviewError(code),
    },
    invalidate: [],
  });
  const root = state.members[0]!;
  const { decision } = a.input;
  const policy = a.currentPolicy;
  const currentPolicyRef = reviewPolicyRef(policy);
  // Every member shares the root's capability, so one effective rule covers the family.
  const rule = ruleFor(policy, root.proposal);
  // Idempotency per (commandId, requestDigest): the recorded reviewer's replay
  // returns the recorded result and changes nothing.
  const recorded = state.commands.find((c) => c.commandId === a.commandId);
  if (recorded && recorded.requestDigest === a.requestDigest && same(recorded.reviewer, a.reviewer))
    return { state, result: recorded.result, invalidate: [] };
  // The reviewer comes first (§7 items 4 and 13): an ineligible, foreign-tenant
  // or unlisted reviewer gets one uniform denial, whatever the family's state.
  if (
    !a.reviewerEligible ||
    !sameTenant(a.reviewer, root.proposal) ||
    (rule.eligibleReviewerPrincipalIds !== null &&
      !rule.eligibleReviewerPrincipalIds.includes(a.reviewer.principalId))
  )
    return fail("REVIEWER_DENIED");
  if (recorded) return fail("COMMAND_CONFLICT");
  const approved = state.members.find((m) => m.approval.status === "approved");
  // Only the confirming solo reviewer of an approved member may cancel; anyone
  // else learns nothing more about the family.
  const soloDecision = approved?.approval.decisions.find((d) => d.soloOwnerConfirmation !== null);
  if (
    decision.decision === "cancel_before_effective" &&
    (!soloDecision || !same(soloDecision.reviewer, a.reviewer))
  )
    return fail("CANCEL_NOT_ALLOWED");
  if (!same(a.input.proposalRef, proposalRef(root.proposal))) return fail("DIGEST_MISMATCH");
  if (a.input.expectedRevision !== state.revision) return fail("STALE_REVISION");
  const members = [...state.members];
  const commit = (
    changed: readonly ReviewMember[],
    transitions: ReviewTransition[],
    decided: ReviewMember,
  ): Step => {
    for (const m of changed) {
      if (!valid("Approval", m.approval)) throw new ReviewBoundaryError("REVIEW_FACTS_INVALID");
      const i = members.findIndex((x) => x.proposal.id === m.proposal.id);
      if (i < 0) members.push(m);
      else members[i] = m;
    }
    const output = {
      approvalId: decided.approval.id,
      proposalDigest: decided.proposal.proposalDigest,
    };
    if (!validateCapabilityOutput("governance.approval.decide", output))
      throw new ReviewBoundaryError("REVIEW_FACTS_INVALID");
    const result: ReviewAttemptSuccess = {
      ok: true,
      commandId: a.commandId,
      requestDigest: a.requestDigest,
      output,
      status: decided.approval.status,
      transitions,
    };
    const invalidate = transitions
      .filter((t) => t.to === "invalidated")
      .map((t) => approvalRef(state.members.find((m) => m.approval.id === t.approvalId)!.approval));
    const command: ReviewCommandRecord = {
      commandId: a.commandId,
      requestDigest: a.requestDigest,
      reviewer: a.reviewer,
      result,
    };
    return {
      state: freezeJson({
        revision: state.revision + 1,
        members,
        commands: [...state.commands, command],
      }) as ReviewState,
      result: freezeJson(structuredClone(result)) as ReviewAttemptSuccess,
      invalidate,
    };
  };
  const touch = (
    approval: Current_Approval,
    changes: Partial<Current_Approval>,
  ): Current_Approval => ({
    ...approval,
    ...changes,
    revision: approval.revision + 1,
    updatedAt: a.at,
  });

  // Cancel (§7 item 11): only the confirming solo reviewer (checked above), before effectiveAt.
  if (decision.decision === "cancel_before_effective") {
    if (!approved) return fail("CANCEL_NOT_ALLOWED");
    if (decision.expectedDecisionDigest !== approved.proposal.proposalDigest)
      return fail("DIGEST_MISMATCH");
    if (approved.approval.effectiveAt === null || ms(a.at) >= ms(approved.approval.effectiveAt))
      return fail("CANCEL_NOT_ALLOWED");
    const cancelled = { ...approved, approval: touch(approved.approval, { status: "cancelled" }) };
    return commit(
      [cancelled],
      [
        transition(
          cancelled.approval.id,
          "approved",
          "cancelled",
          "solo_owner",
          "before_effective_at",
        ),
      ],
      cancelled,
    );
  }

  // Approve or reject one exact member: the root, or the derivation a selection names.
  // A rejection rejects the proposal as reviewed; a part is approved, never rejected.
  let member: ReviewMember | undefined = root;
  let derived: Current_Proposal | null = null;
  if (decision.selectedTargetIndexes !== null) {
    if (decision.decision === "reject") return fail("SELECTION_INVALID");
    const result = derive(root.proposal, decision.selectedTargetIndexes);
    if (typeof result === "string") return fail(result);
    derived = result;
    member = state.members.find((m) => m.proposal.id === result.id);
  }
  const proposal = member?.proposal ?? derived!;
  if (decision.expectedDecisionDigest !== proposal.proposalDigest) return fail("DIGEST_MISMATCH");
  // Family (§7 item 9): at most one member is approved.
  if (decision.decision === "approve" && approved) return fail("FAMILY_CONFLICT");
  if (root.approval.status !== "pending" || (member && member.approval.status !== "pending"))
    return fail("APPROVAL_NOT_PENDING");
  // A policy revision makes approvals bound to the old one stale (§7 item 12).
  if (
    !same(proposal.reviewPolicyRef, currentPolicyRef) ||
    (member && !same(member.approval.reviewPolicyRef, currentPolicyRef))
  )
    return fail("REVIEW_POLICY_NOT_CURRENT");
  // A derived approval shares the root approval's creation time, so a selection
  // never extends the pending window (§7 item 10).
  const pendingExpiresAt =
    member?.approval.expiresAt ??
    earliest(proposal.expiresAt, plusSeconds(root.approval.createdAt, rule.pendingExpirySeconds));
  if (ms(a.at) >= ms(pendingExpiresAt)) return fail("APPROVAL_EXPIRED");
  // A reviewer decides once per approval. Deciding the root and then a derivation
  // is two approvals of nested change sets; each member counts its own quorum.
  if (member?.approval.decisions.some((d) => d.reviewer.principalId === a.reviewer.principalId))
    return fail("DUPLICATE_REVIEWER");
  // Conflict set (§7 items 5-6): proposer, requester and beneficiaries, inherited by derivations.
  const confirmation = decision.soloOwnerConfirmation;
  let solo = false;
  if (decision.decision === "approve" && conflictSet(proposal).has(a.reviewer.principalId)) {
    if (rule.selfApproval === "denied") return fail("SELF_APPROVAL_DENIED");
    if (rule.selfApproval === "solo_owner_typed_confirmation") {
      if (
        !soloOwnerStatus(
          a.ownership,
          a.reviewer.principalId,
          a.at,
          policy.rules.soloOwner.quietPeriodSeconds,
        )
      )
        return fail("SELF_APPROVAL_DENIED");
      if (confirmation === null || confirmation.normalize("NFC") !== confirmationPhrase(proposal))
        return fail("CONFIRMATION_MISMATCH");
      solo = true;
    }
  }
  // A phrase is only ever typed for a solo-owner approval.
  if (!solo && confirmation !== null) return fail("CONFIRMATION_MISMATCH");

  const coolDownSeconds = policy.rules.soloOwner.coolDownSeconds;
  const entry: Current_ApprovalDecision = {
    reviewer: a.reviewer,
    decision: decision.decision,
    decidedAt: a.at,
    commandId: a.commandId,
    requestDigest: a.requestDigest,
    comment: decision.comment,
    soloOwnerConfirmation: solo
      ? { phraseDigest: sha256(confirmationPhrase(proposal)), coolDownSeconds }
      : null,
  };
  const base: Current_Approval = member
    ? member.approval
    : {
        ...root.approval,
        id: "approval_" + proposal.id,
        revision: 1,
        proposalRef: proposalRef(proposal),
        proposalDigest: proposal.proposalDigest,
        expiresAt: pendingExpiresAt,
        scopeDigest: canonicalDigest(proposal.scope),
        reviewPolicyRef: currentPolicyRef,
        requiredApprovals: rule.requiredApprovals,
        decisions: [],
      };
  const decisions = [...base.decisions, entry];
  const transitions: ReviewTransition[] = [];
  let next: Current_Approval;
  if (decision.decision === "reject") {
    next = {
      ...base,
      status: "rejected",
      reviewer: a.reviewer,
      decision: "reject",
      decidedAt: a.at,
      decisions,
    };
    transitions.push(
      transition(
        next.id,
        "pending",
        "rejected",
        "eligible_human_reviewer",
        "eligible_rejection_exact_digest_and_current_policy",
      ),
    );
  } else if (
    solo ||
    // Earlier approvals count only while their reviewer is still eligible.
    decisions.filter(
      (d) =>
        d.decision === "approve" &&
        (d === entry || a.eligibleReviewerPrincipalIds.includes(d.reviewer.principalId)),
    ).length >= base.requiredApprovals
  ) {
    // A solo decision meets the quorum alone and takes effect after the cool-down.
    const effectiveAt = solo ? plusSeconds(a.at, coolDownSeconds) : a.at;
    next = {
      ...base,
      status: "approved",
      reviewer: a.reviewer,
      decision: "approve",
      decidedAt: a.at,
      decisions,
      effectiveAt,
      expiresAt: earliest(
        proposal.expiresAt,
        plusSeconds(effectiveAt, rule.approvedValiditySeconds),
      ),
    };
    transitions.push(
      solo
        ? transition(
            next.id,
            "pending",
            "approved",
            "solo_owner",
            "typed_confirmation_recorded_cool_down_scheduled",
          )
        : transition(
            next.id,
            "pending",
            "approved",
            "eligible_human_reviewer",
            "quorum_met_exact_digest_scope_and_current_policy",
          ),
    );
  } else next = { ...base, decisions };
  if (member) next = { ...next, revision: base.revision + 1, updatedAt: a.at };
  else next = { ...next, updatedAt: a.at };
  const decided: ReviewMember = { proposal, approval: next };
  const changed: ReviewMember[] = [decided];
  // An approval supersedes every other pending member of the family, and a
  // rejection (always of the root) closes the family.
  if (next.status === "approved" || next.status === "rejected")
    for (const m of state.members)
      if (m.proposal.id !== proposal.id && m.approval.status === "pending") {
        changed.push({ ...m, approval: touch(m.approval, { status: "invalidated" }) });
        transitions.push(
          transition(
            m.approval.id,
            "pending",
            "invalidated",
            "work_service",
            next.status === "approved" ? "superseded_by_partial_approval" : "family_rejected",
          ),
        );
      }
  return commit(changed, transitions, decided);
}
/**
 * Folds ordered decision attempts over one review family. An error result
 * changes nothing; a success records the decision, advances the family
 * revision and returns the approvals it invalidated.
 */
export function foldDecisions(
  state: ReviewState,
  attempts: readonly DecisionAttempt[],
): FoldResult {
  let current = parseState(state);
  if (!Array.isArray(attempts) || attempts.length > 1000)
    throw new ReviewBoundaryError("REVIEW_INPUT_INVALID");
  const results: ReviewAttemptResult[] = [];
  const invalidate: Current_ApprovalRef[] = [];
  for (const attempt of attempts) {
    const step = decideOne(current, parseAttempt(attempt, current.members[0]!.proposal));
    current = step.state;
    results.push(step.result);
    invalidate.push(...step.invalidate);
  }
  return Object.freeze({
    state: current,
    results: Object.freeze(results),
    invalidate: freezeJson(invalidate) as readonly Current_ApprovalRef[],
  });
}

// --- Dispatch (§7 item 10) ------------------------------------------------------
/**
 * Whether the family's approved member may dispatch at `facts.now`. Run at
 * `effectiveAt` and again at dispatch. REVIEW_POLICY_NOT_CURRENT,
 * REVIEWER_DENIED (an approving reviewer lost eligibility) and
 * SOLO_OWNER_STATUS_LOST invalidate the approval (`approved→invalidated`).
 */
export function dispatchCheck(state: ReviewState, facts: DispatchFacts): "ok" | ReviewCode {
  const s = parseState(state);
  const f = snapshot<DispatchFacts>(
    facts,
    (v) =>
      closed(v, ["now", "currentPolicy", "ownership", "eligibleReviewerPrincipalIds"]) &&
      valid("UtcTime", v.now) &&
      isPolicy(v.currentPolicy) &&
      isWorkspaceOwnershipFacts(v.ownership) &&
      ids(v.eligibleReviewerPrincipalIds, 1000),
    "REVIEW_FACTS_INVALID",
  );
  if (!sameTenant(f.currentPolicy, s.members[0]!.proposal))
    throw new ReviewBoundaryError("REVIEW_FACTS_INVALID");
  const member = s.members.find((m) => m.approval.status === "approved");
  if (!member) return "NOT_APPROVED";
  const approval = member.approval;
  if (
    !same(approval.reviewPolicyRef, reviewPolicyRef(f.currentPolicy)) ||
    !same(member.proposal.reviewPolicyRef, approval.reviewPolicyRef)
  )
    return "REVIEW_POLICY_NOT_CURRENT";
  // No recorded decision confers authority: the approving reviewers must still be
  // eligible now, enough of them to meet the quorum (or the solo owner alone).
  const solo = approval.decisions.find((d) => d.soloOwnerConfirmation !== null);
  const stillEligible = (d: Current_ApprovalDecision) =>
    d.decision === "approve" && f.eligibleReviewerPrincipalIds.includes(d.reviewer.principalId);
  if (
    solo
      ? !stillEligible(solo)
      : approval.decisions.filter(stillEligible).length < approval.requiredApprovals
  )
    return "REVIEWER_DENIED";
  if (
    solo &&
    (!soloOwnerStatus(
      f.ownership,
      solo.reviewer.principalId,
      f.now,
      f.currentPolicy.rules.soloOwner.quietPeriodSeconds,
    ) ||
      (f.ownership.lastMembershipChangeAt !== null &&
        ms(f.ownership.lastMembershipChangeAt) > ms(solo.decidedAt)))
  )
    return "SOLO_OWNER_STATUS_LOST";
  if (ms(f.now) < ms(approval.effectiveAt!)) return "APPROVAL_NOT_EFFECTIVE";
  if (ms(f.now) >= ms(approval.expiresAt)) return "APPROVAL_EXPIRED";
  return "ok";
}

/** A pending Approval@2 for a stored root proposal, as P11.T01 creates it. */
export function pendingApproval(
  proposal: Current_Proposal,
  policy: Current_ReviewPolicy,
  init: {
    readonly id: string;
    readonly createdAt: string;
    readonly policyRevision: number;
  },
): Current_Approval {
  const p = snapshot<Current_Proposal>(proposal, isProposal, "REVIEW_INPUT_INVALID");
  const current = snapshot<Current_ReviewPolicy>(policy, isPolicy, "REVIEW_FACTS_INVALID");
  if (
    p.derivedFrom !== null ||
    !sameTenant(current, p) ||
    !same(p.reviewPolicyRef, reviewPolicyRef(current)) ||
    !valid("Id", init.id) ||
    !valid("UtcTime", init.createdAt) ||
    !valid("Revision", init.policyRevision)
  )
    throw new ReviewBoundaryError("REVIEW_INPUT_INVALID");
  const rule = ruleFor(current, p);
  const approval: Current_Approval = {
    schemaVersion: 2,
    id: init.id,
    organizationId: p.organizationId,
    workspaceId: p.workspaceId,
    storeId: p.storeId,
    revision: 1,
    createdAt: init.createdAt,
    updatedAt: init.createdAt,
    proposalRef: proposalRef(p),
    proposalDigest: p.proposalDigest,
    status: "pending",
    reviewer: null,
    decision: null,
    decidedAt: null,
    expiresAt: earliest(p.expiresAt, plusSeconds(init.createdAt, rule.pendingExpirySeconds)),
    policyRevision: init.policyRevision,
    scopeDigest: canonicalDigest(p.scope),
    reviewPolicyRef: reviewPolicyRef(current),
    requiredApprovals: rule.requiredApprovals,
    decisions: [],
    effectiveAt: null,
  };
  if (!valid("Approval", approval)) throw new ReviewBoundaryError("REVIEW_INPUT_INVALID");
  return freezeJson(approval) as Current_Approval;
}
