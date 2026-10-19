import type { CapabilityId, Current_ProposalTarget } from "@morrow/contracts";
import type { ReviewCode as LibraryReviewCode } from "@morrow/policy/review";

/**
 * Trusted server code that turns one capability's closed parameters into
 * proposal targets (§8). A producer never decides authority: the kernel checks
 * the proposer's grants, and SQL derives and rechecks every server field.
 * Producers are registered by the domain packets (P05.T01z, P05.T02a); the
 * production composition passes an empty registry until they land.
 */
export interface ProposalProducer<P> {
  readonly capabilityId: CapabilityId;
  readonly partialApproval: "allowed" | "all_or_nothing";
  /** A closed record over generated validators only; no runtime schema compilation. */
  parse(value: unknown): P | null;
  /** Targets must be the workspace W in this packet. */
  plan(
    p: P,
    tenant: { readonly organizationId: string; readonly workspaceId: string },
  ):
    | {
        readonly targets: readonly Current_ProposalTarget[];
        readonly beneficiaryPrincipalIds: readonly string[];
      }
    | "invalid";
}
export type ProducerRegistry = ReadonlyMap<CapabilityId, ProposalProducer<unknown>>;
/** The production registry: empty until P05.T01z and P05.T02a register producers. */
export const productionProducers: ProducerRegistry = Object.freeze(new Map());

/** The review codes the approval records add to the library's. */
export type ReviewCode = LibraryReviewCode | "REVIEWER_AUTHORITY_LOST" | "APPROVAL_ALREADY_CLAIMED";
