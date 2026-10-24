// @morrow/work/approvals: proposal and approval records on the contract v1.1
// review types (P06.T01b PR-1; ADR-0011, ADR-0018). Producers submit exact
// proposals, reviewers decide them under ADR-0011, proposers withdraw them, and a
// consumer claims one approval family once, inside its own effect transaction.
// The HTTP routes are PR-2; the production producer registry is empty.
export {
  submitProposal,
  defaultReviewPolicy,
  approvalCaps,
  type SubmitInput,
  type SubmitResult,
  type SubmitRefusal,
} from "./submit.js";
export { decideApproval, type DecideInput, type DecideResult } from "./decide.js";
export { withdrawProposal, type WithdrawInput, type TransitionResult } from "./withdraw.js";
export {
  prepareApprovalClaim,
  claimedApprovalCurrent,
  type ClaimantCheck,
  type CountedReviewers,
  type PreparedClaim,
  type ClaimRefusal,
} from "./claim.js";
export { proposalStore, storeLinkCurrent } from "./kernel.js";
export {
  readProposal,
  listApprovals,
  viewerRole,
  type ApprovalSummary,
  type ProposalView,
  type ViewerRole,
} from "./reads.js";
export {
  projectApproval,
  type Projection,
  type ProjectionFacts,
  type StoredApproval,
} from "./projection.js";
export {
  scopeDigest,
  approvalRefDigest,
  derivedProposalId,
  canonicalText,
  sha256Text,
  utcText,
  type ApprovalRefFields,
} from "./digests.js";
export {
  productionProducers,
  type ProposalProducer,
  type ProducerRegistry,
  type ReviewCode,
} from "./producers.js";
export { approvalErrors, type ApprovalErrorMapping, type ApprovalRefusal } from "./outcomes.js";
export { ApprovalMappingError } from "./mapping.js";
export { approvalStatements, type ApprovalStatementName } from "./sql.js";
