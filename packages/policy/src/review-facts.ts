// Trusted facts for kill switches (and, later, review decisions). Only trusted
// server readers fill them, from current SQL state (P05.T01z, P11). Never decode
// them from HTTP, client or model input: a fact here is authority.
import type { Core_ProposalRef } from "@morrow/contracts";

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
