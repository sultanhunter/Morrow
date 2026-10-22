import type {
  Core_ApprovalRef,
  Core_ProposalRef,
  Current_Approval,
  Current_ApprovalDecision,
  Current_ApprovalStatus,
  Current_HumanActorRef,
  Current_Proposal,
  Current_ReviewPolicy,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { proposalDigest, proposalRef, reviewPolicyRef } from "@morrow/policy/review";
import { approvalRefDigest, sha256Text } from "./digests.js";
import type { StoredApproval } from "./projection.js";

// Rows → contract objects (§7 mapping). Every canonical text must hash to its
// stored digest and parse to a valid Proposal@2 / ReviewPolicy whose library
// digest equals it; anything else is a server fault (ApprovalMappingError → 503),
// never a partial object. A wrong canonicalization therefore fails closed.

export class ApprovalMappingError extends Error {
  constructor() {
    super("APPROVAL_MAPPING_INVALID");
    this.name = "ApprovalMappingError";
  }
}
type Row = Readonly<Record<string, unknown>>;
const fail = (): never => {
  throw new ApprovalMappingError();
};
const text = (row: Row, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : fail();
};
const nullableText = (row: Row, key: string): string | null => {
  const value = row[key];
  return value === null ? null : typeof value === "string" ? value : fail();
};
const integer = (row: Row, key: string): number => {
  const value = text(row, key);
  return /^(0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : fail();
};
const jsonText = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return fail();
  }
};
const ids = (value: string | null): readonly string[] | null => {
  if (value === null) return null;
  const parsed = jsonText(value);
  return Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
    ? Object.freeze(parsed as string[])
    : fail();
};

export interface StoredProposalRow {
  readonly proposal: Current_Proposal;
  readonly familyRootId: string;
  readonly derivedFromId: string | null;
  readonly requester: { readonly principalId: string; readonly membershipId: string };
  /**
   * A person (membership, no installation) or, from M3, the Listings agent (installation, no
   * membership). Either way it equals the proposal's proposedBy; a row that disagrees fails.
   */
  readonly proposer: {
    readonly kind: "human" | "agent";
    readonly principalId: string;
    readonly membershipId: string | null;
    readonly installationId: string | null;
  };
  readonly parametersId: string;
  readonly scopeDigest: string;
  readonly reviewPolicyRevision: number;
}
export interface StoredApprovalRow {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly familyRootId: string;
  readonly status: Current_ApprovalStatus;
  readonly requiredApprovals: number;
  readonly quietPeriodSeconds: number;
  readonly countedReviewerPrincipalIds: readonly string[] | null;
  readonly scopeDigest: string;
  readonly reviewPolicyRevision: number;
  readonly policyRevision: number;
  readonly effectiveAt: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface StoredDecisionRow {
  readonly approvalId: string;
  readonly sequence: number;
  readonly decision: Current_ApprovalDecision;
}

const statuses: readonly string[] = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "invalidated",
  "cancelled",
];

/** A stored proposal: the canonical text, digest-checked, parsed and validated. */
export function decodeProposal(row: Row, tenant: { organizationId: string; workspaceId: string }) {
  const canonical = text(row, "canonical");
  const digest = text(row, "digest");
  if (sha256Text(canonical) !== digest) fail();
  const content = jsonText(canonical);
  if (content === null || typeof content !== "object" || Array.isArray(content)) fail();
  const proposal = { ...(content as object), proposalDigest: digest } as Current_Proposal;
  if (
    !validateCurrentDefinition("Proposal", proposal) ||
    proposalDigest(proposal) !== digest ||
    proposal.id !== text(row, "id") ||
    proposal.organizationId !== tenant.organizationId ||
    proposal.workspaceId !== tenant.workspaceId ||
    row.organization_id !== tenant.organizationId ||
    row.workspace_id !== tenant.workspaceId
  )
    fail();
  const kind = text(row, "proposer_kind");
  const proposer = {
    kind: kind === "human" || kind === "agent" ? kind : fail(),
    principalId: text(row, "proposer_principal_id"),
    membershipId: nullableText(row, "proposer_membership_id"),
    installationId: nullableText(row, "proposer_installation_id"),
  } as const;
  const by = proposal.proposedBy;
  if (
    (proposer.kind === "human") !== (proposer.membershipId !== null) ||
    (proposer.kind === "agent") !== (proposer.installationId !== null) ||
    by.kind !== proposer.kind ||
    by.principalId !== proposer.principalId ||
    by.membershipId !== proposer.membershipId ||
    by.installationId !== proposer.installationId ||
    proposal.storeId !== nullableText(row, "store_id")
  )
    fail();
  const stored: StoredProposalRow = {
    proposal: Object.freeze(proposal),
    familyRootId: text(row, "family_root_id"),
    derivedFromId: nullableText(row, "derived_from_id"),
    requester: {
      principalId: text(row, "requester_principal_id"),
      membershipId: text(row, "requester_membership_id"),
    },
    proposer,
    parametersId: text(row, "parameters_id"),
    scopeDigest: text(row, "scope_digest"),
    reviewPolicyRevision: integer(row, "review_policy_revision"),
  };
  return Object.freeze(stored);
}

export function decodeApproval(
  row: Row,
  tenant: { organizationId: string; workspaceId: string },
): StoredApprovalRow {
  const status = text(row, "status");
  if (!statuses.includes(status)) fail();
  if (row.organization_id !== tenant.organizationId || row.workspace_id !== tenant.workspaceId)
    fail();
  return Object.freeze({
    id: text(row, "id"),
    organizationId: text(row, "organization_id"),
    workspaceId: text(row, "workspace_id"),
    revision: integer(row, "revision"),
    proposalId: text(row, "proposal_id"),
    proposalDigest: text(row, "proposal_digest"),
    familyRootId: text(row, "family_root_id"),
    status: status as Current_ApprovalStatus,
    requiredApprovals: integer(row, "required_approvals"),
    quietPeriodSeconds: integer(row, "quiet_period_seconds"),
    countedReviewerPrincipalIds: ids(nullableText(row, "counted_reviewer_principal_ids")),
    scopeDigest: text(row, "scope_digest"),
    reviewPolicyRevision: integer(row, "review_policy_revision"),
    policyRevision: integer(row, "policy_revision"),
    effectiveAt: nullableText(row, "effective_at"),
    expiresAt: text(row, "expires_at"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  });
}

export function decodeDecision(
  row: Row,
  tenant: { organizationId: string; workspaceId: string },
): StoredDecisionRow {
  const decision = text(row, "decision");
  const soloDigest = nullableText(row, "solo_phrase_digest");
  const soloCoolDown = nullableText(row, "solo_cool_down_seconds");
  if ((soloDigest === null) !== (soloCoolDown === null)) fail();
  const reviewer: Current_HumanActorRef = {
    kind: "human",
    principalId: text(row, "reviewer_principal_id"),
    organizationId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    membershipId: text(row, "reviewer_membership_id"),
    installationId: null,
    mandateId: null,
  };
  const value: Current_ApprovalDecision = {
    reviewer,
    decision: decision === "approve" || decision === "reject" ? decision : fail(),
    decidedAt: text(row, "decided_at"),
    commandId: text(row, "command_id"),
    requestDigest: text(row, "request_digest"),
    comment: nullableText(row, "comment"),
    soloOwnerConfirmation:
      soloDigest === null
        ? null
        : { phraseDigest: soloDigest, coolDownSeconds: integer(row, "solo_cool_down_seconds") },
  };
  if (!validateCurrentDefinition("ApprovalDecision", value)) fail();
  return Object.freeze({
    approvalId: text(row, "approval_id"),
    sequence: integer(row, "sequence"),
    decision: Object.freeze(value),
  });
}

/** A stored ReviewPolicy: digest-checked, valid, and its library digest equal to the stored one. */
export function decodePolicy(
  canonical: string,
  digest: string,
  tenant: { organizationId: string; workspaceId: string },
): Current_ReviewPolicy {
  if (sha256Text(canonical) !== digest) fail();
  const policy = jsonText(canonical) as Current_ReviewPolicy;
  if (
    !validateCurrentDefinition("ReviewPolicy", policy) ||
    policy.organizationId !== tenant.organizationId ||
    policy.workspaceId !== tenant.workspaceId ||
    reviewPolicyRef(policy).digest !== digest
  )
    fail();
  return Object.freeze(policy);
}

/** The stored approval's ApprovalRef: its digest binds the stored state at this revision. */
export function storedApprovalRef(a: StoredApprovalRow): Core_ApprovalRef {
  return Object.freeze({
    organizationId: a.organizationId,
    workspaceId: a.workspaceId,
    storeId: null,
    kind: "approval",
    id: a.id,
    revision: a.revision,
    digest: approvalRefDigest({
      organizationId: a.organizationId,
      workspaceId: a.workspaceId,
      id: a.id,
      revision: a.revision,
      proposalDigest: a.proposalDigest,
      scopeDigest: a.scopeDigest,
      status: a.status,
      effectiveAt: a.effectiveAt,
      expiresAt: a.expiresAt,
    }),
  });
}

/** The projection input of a stored approval. */
export function storedProjection(
  a: StoredApprovalRow,
  decisions: readonly StoredDecisionRow[],
): StoredApproval {
  const solo = decisions.find(
    (d) => d.approvalId === a.id && d.decision.soloOwnerConfirmation !== null,
  );
  return {
    status: a.status,
    expiresAt: a.expiresAt,
    boundPolicyRevision: a.reviewPolicyRevision,
    soloReviewerPrincipalId: solo?.decision.reviewer.principalId ?? null,
    soloDecidedAt: solo?.decision.decidedAt ?? null,
    quietPeriodSeconds: a.quietPeriodSeconds,
  };
}

/**
 * Approval@2 from the stored rows (§7 mapping). reviewer, decision and decidedAt
 * come from the closing decision of an approval that was approved or rejected
 * (null while pending, or when closed without a decision); decisions[] holds the
 * rows in sequence; policyRevision is the organization revision at the last write;
 * `status` is the given (projected) status. It must validate as Approval@2.
 */
export function mapApproval(
  a: StoredApprovalRow,
  proposal: Current_Proposal,
  decisions: readonly StoredDecisionRow[],
  status: Current_ApprovalStatus,
): Current_Approval {
  const own = decisions
    .filter((d) => d.approvalId === a.id)
    .sort((x, y) => x.sequence - y.sequence)
    .map((d) => d.decision);
  const closing =
    (a.effectiveAt !== null || a.status === "rejected") && own.length ? own.at(-1)! : null;
  if (proposal.proposalDigest !== a.proposalDigest || proposal.id !== a.proposalId) fail();
  const approval: Current_Approval = {
    schemaVersion: 2,
    id: a.id,
    organizationId: a.organizationId,
    workspaceId: a.workspaceId,
    storeId: null,
    revision: a.revision,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    proposalRef: proposalRef(proposal),
    proposalDigest: a.proposalDigest,
    status,
    reviewer: closing?.reviewer ?? null,
    decision: closing?.decision ?? null,
    decidedAt: closing?.decidedAt ?? null,
    expiresAt: a.expiresAt,
    policyRevision: a.policyRevision,
    scopeDigest: a.scopeDigest,
    reviewPolicyRef: proposal.reviewPolicyRef,
    requiredApprovals: a.requiredApprovals,
    decisions: own,
    effectiveAt: a.effectiveAt,
  };
  if (!validateCurrentDefinition("Approval", approval)) fail();
  return Object.freeze(approval);
}

export const storedProposalRef = (p: Current_Proposal): Core_ProposalRef => proposalRef(p);
