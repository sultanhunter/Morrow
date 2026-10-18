// Trusted facts for kill switches and review decisions. Only trusted server
// readers fill them, from current SQL state (P05.T01z, P11). Never decode them
// from HTTP, client or model input: a fact here is authority.
import type {
  CapabilityInput,
  Core_ProposalRef,
  Current_ActorRef,
  Current_Approval,
  Current_HumanActorRef,
  Current_Proposal,
  Current_ReviewPolicy,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { closed } from "./json-boundary";

/**
 * The designated owner of a workspace and its membership activity. P05.T01z
 * supplies it from the owner record P05.T01x creates (ADR-0009 item 3). A
 * "membership change" is any revocation or ownership change.
 */
export interface WorkspaceOwnershipFacts {
  readonly ownerPrincipalId: string;
  readonly ownerMembershipId: string;
  readonly activeHumanMembershipCount: number;
  /** UtcTime of the latest membership change, or null when there has been none. */
  readonly lastMembershipChangeAt: string | null;
}

/** Closed-shape guard for WorkspaceOwnershipFacts, shared by the policy checks. */
export function isWorkspaceOwnershipFacts(value: unknown): value is WorkspaceOwnershipFacts {
  return (
    closed(value, [
      "ownerPrincipalId",
      "ownerMembershipId",
      "activeHumanMembershipCount",
      "lastMembershipChangeAt",
    ]) &&
    validateCurrentDefinition("Id", value.ownerPrincipalId) &&
    validateCurrentDefinition("Id", value.ownerMembershipId) &&
    validateCurrentDefinition("Count", value.activeHumanMembershipCount) &&
    (value.lastMembershipChangeAt === null ||
      validateCurrentDefinition("UtcTime", value.lastMembershipChangeAt))
  );
}

/**
 * What each kill switch stops. The kinds are v1 `ResourceRef` kinds, so a
 * KillSwitchRecord can name its targets without a mapping: `ads.campaign.pause`
 * → `campaign`, `agents.installation.disable` → `installation`,
 * `governance.membership.revoke` → `member`, `agents.release.revoke` →
 * `release`. The exception is `connection`: v1 `ResourceRef` has no kind for a
 * store connection, so how a `governance.connection.disconnect` record names its
 * target is open. P05.T01z settles it with a deliberate v1.1 edit before the
 * Tier 3 sign-off freezes v1.1.
 */
export type KillSwitchTargetKind =
  | "campaign"
  | "installation"
  | "member"
  | "connection"
  | "release";

export interface KillSwitchTargetKey {
  readonly kind: KillSwitchTargetKind;
  readonly id: string;
}

/**
 * The record a trusted reader resolved for one requested target ID, wherever it
 * lives; the check itself decides whether it is in the trusted tenant. An ID the
 * reader could not resolve is simply absent.
 */
export interface KillSwitchTargetRecord {
  readonly kind: KillSwitchTargetKind;
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string | null;
  readonly connectionId: string | null;
  /** Release revision and digest; null for every other kind. */
  readonly revision: number | null;
  readonly digest: string | null;
}

/**
 * The store and connection coverage of one of the actor's current execute
 * grants for the kill switch. Every target, of every kind, must fit within a
 * single grant; grants are never unioned. A storeless target needs a grant with
 * no stores (the human evaluator's rule); a target with a store needs that
 * store; a target on a connection, and a connection being disconnected, needs
 * that connection. An empty list of grants therefore stops nothing.
 */
export interface KillSwitchGrantCoverage {
  readonly storeIds: readonly string[];
  readonly connectionIds: readonly string[];
}

/** The proposal a `control.sourceProposalRef` resolved to, with its targets. */
export interface KillSwitchSourceProposal {
  readonly ref: Core_ProposalRef;
  readonly capabilityId: string;
  readonly targets: readonly KillSwitchTargetKey[];
}

export interface KillSwitchTargetFacts {
  /** The trusted organization and workspace of the request. */
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly records: readonly KillSwitchTargetRecord[];
  readonly grants: readonly KillSwitchGrantCoverage[];
  /** Resolved only when the input names a source proposal; otherwise null. */
  readonly sourceProposal: KillSwitchSourceProposal | null;
  readonly ownership: WorkspaceOwnershipFacts;
}

/**
 * The work task of a proposal and its requester, which exist together
 * (ADR-0018). `taskId` is the task the producer attached the proposal to,
 * after its task-attach check, never a value copied from the proposal it
 * built; `requestedBy` is that task's initiator, or the mandate owner for
 * background work. Both are null when the producer attached no task, which is
 * valid only for a human proposer of a Governance-domain capability (agents
 * always need a task; `checkProposal` reports anything else as
 * `TASK_REQUIRED`). The library then derives `requestedBy` as the proposer,
 * who stays in the conflict set in both roles (ADR-0018 item 3).
 */
export type ProposalTaskFacts =
  | { readonly taskId: string; readonly requestedBy: Current_HumanActorRef }
  | { readonly taskId: null; readonly requestedBy: null };

/**
 * Trusted facts `checkProposal` compares a server-built proposal against
 * (P01.T02a §7 items 1-3). The catalogue effect and irreversible flag are not
 * facts: the review library reads them from the compiled catalogue. The task
 * pairing is a union so a producer cannot build a task without a requester,
 * or the reverse; the library still rejects either at runtime.
 */
export type ProposalFacts = ProposalTaskFacts & ProposalFactsFields;

/** The fields of ProposalFacts besides the task pairing. */
export interface ProposalFactsFields {
  /** The trusted organization, workspace and store of the request. */
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string | null;
  /** The authenticated actor that built the proposal. */
  readonly proposedBy: Current_ActorRef;
  /**
   * Principals who benefit from the change. For access_change: those receiving
   * the grant, membership or ownership, plus the requester of any originating
   * access request (ADR-0011 Q1).
   */
  readonly beneficiaryPrincipalIds: readonly string[];
  /** Derived from the evidence the proposing run consumed (P13, P01.T02b). */
  readonly contextTaint: "none" | "untrusted_external";
  /** The workspace's single current ReviewPolicy. */
  readonly reviewPolicy: Current_ReviewPolicy;
  /**
   * Principals currently eligible to review this proposal (each passed
   * `reviewerEligible`). The library removes the conflicted ones itself.
   */
  readonly eligibleReviewerPrincipalIds: readonly string[];
  readonly ownership: WorkspaceOwnershipFacts;
  /** UtcTime the facts were read; solo status is evaluated at it. */
  readonly at: string;
}

/** One member of a review family: the root proposal or a derivation, with its approval. */
export interface ReviewMember {
  readonly proposal: Current_Proposal;
  readonly approval: Current_Approval;
}

/** The P11.T01 durable state of one review family, locked at its root. */
export interface ReviewState {
  /** The family revision. A decision's `expectedRevision` must equal it; it advances with every recorded decision. */
  readonly revision: number;
  /** The root proposal first, then each derived proposal that has an approval, in creation order. */
  readonly members: readonly ReviewMember[];
  /** Recorded decisions, for idempotent replay and read-back by commandId. */
  readonly commands: readonly ReviewCommandRecord[];
}

export interface ReviewCommandRecord {
  readonly commandId: string;
  readonly requestDigest: string;
  /** The reviewer who issued the command; only they can replay it. */
  readonly reviewer: Current_HumanActorRef;
  readonly result: ReviewAttemptSuccess;
}

/** One `governance.approval.decide` command, with the trusted facts current when it runs. */
export interface DecisionAttempt {
  readonly commandId: string;
  /**
   * The CommandEnvelope digest, covering the actor and the whole decide input.
   * A replay must also come from the recorded reviewer, or it is a COMMAND_CONFLICT.
   */
  readonly requestDigest: string;
  /** The authenticated reviewer. */
  readonly reviewer: Current_HumanActorRef;
  readonly input: CapabilityInput<"governance.approval.decide">;
  /** UtcTime of the decision. */
  readonly at: string;
  /** `reviewerEligible` for the decided targets, from current grants. */
  readonly reviewerEligible: boolean;
  /**
   * Principals currently eligible to review the decided proposal (each passes
   * `reviewerEligible` for its targets now). An earlier approval counts toward
   * the quorum only while its reviewer is listed: no recorded decision confers authority.
   */
  readonly eligibleReviewerPrincipalIds: readonly string[];
  readonly ownership: WorkspaceOwnershipFacts;
  /** The workspace's single current ReviewPolicy. */
  readonly currentPolicy: Current_ReviewPolicy;
}

export interface DispatchFacts {
  /** UtcTime of the check: at `effectiveAt` (the P11 scheduler) and again at dispatch. */
  readonly now: string;
  readonly currentPolicy: Current_ReviewPolicy;
  readonly ownership: WorkspaceOwnershipFacts;
  /**
   * Principals currently eligible to review the approved proposal (each passes
   * `reviewerEligible` for its targets at `now`). The approval dispatches only
   * while `requiredApprovals` of its approving reviewers (or its solo owner) are listed.
   */
  readonly eligibleReviewerPrincipalIds: readonly string[];
}

/** A state-machine edge the fold applied; each exists in the v1.1 transition table. */
export interface ReviewTransition {
  readonly aggregate: "approval";
  readonly approvalId: string;
  readonly from: "pending" | "approved";
  readonly to: "approved" | "rejected" | "cancelled" | "invalidated";
  readonly actor: "eligible_human_reviewer" | "solo_owner" | "work_service";
  readonly guard: string;
}

export interface ReviewAttemptSuccess {
  readonly ok: true;
  readonly commandId: string;
  readonly requestDigest: string;
  /** The `governance.approval.decide` output: the decided approval, derived for a selection. */
  readonly output: { readonly approvalId: string; readonly proposalDigest: string };
  readonly status: Current_Approval["status"];
  readonly transitions: readonly ReviewTransition[];
}
