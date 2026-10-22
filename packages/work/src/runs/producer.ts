import type { Current_Proposal, Current_ReviewPolicy } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { effectiveRule, riskClassFor } from "@morrow/policy/review";
import defaults from "../../../../docs/contracts/review-policy-defaults.json";
import { canonicalText, sha256Text } from "../approvals/digests.js";
import { listingFields, type ListingField } from "./drafting.js";

// The catalog.content.publish producer (ADR-0022 items 1-3; mvp-architecture §2 step 9 and
// §7): it packs a run's pending drafts into Proposal@2 records by bytes, each with its
// CatalogContentChangeSet@1 parameters, in product order. A draft's item is at most 16 KiB of
// canonical JSON, so any two fit the 32 KiB parameter cap; a 25-product run usually yields
// several proposals on its one task T. Every proposal is proposed by the Listings
// installation's agent principal on behalf of the run's requester (the task initiator), is
// store-bound to the run's store and connection, charges no credit and no cost
// (maximumCredits "0", maximumCost null), allows partial approval, and is
// contextTaint untrusted_external (the run read third-party product text). The agent submit
// definer rebuilds the targets and items from the stored drafts and checks the document; the
// producer decides nothing about authority.

export interface ProducerRun {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string;
  readonly connectionId: string;
  readonly taskId: string;
  readonly installationId: string;
  readonly agentPrincipalId: string;
  readonly requesterPrincipalId: string;
  readonly requesterMembershipId: string;
}
export interface PendingDraft {
  readonly draftId: string;
  readonly productIndex: number;
  readonly productId: string;
  readonly snapshotDigest: string;
  readonly fields: readonly ListingField[];
  readonly setCanonical: string;
}
/** The workspace's current review policy, or null when none exists yet (seeded at revision 1). */
export interface CurrentReviewPolicy {
  readonly revision: number;
  readonly canonical: string;
  readonly digest: string;
}
export interface PackedProposal {
  readonly draftIds: readonly string[];
  readonly approvalId: string;
  /** The seeded revision 1, when the workspace had no policy; else null. */
  readonly policyCanonical: string | null;
  readonly policyDigest: string;
  readonly parametersCanonical: string;
  readonly parametersDigest: string;
  readonly proposalCanonical: string;
  readonly proposalDigest: string;
  readonly scopeCanonical: string;
  readonly proposal: Current_Proposal;
}
export const producerCaps = Object.freeze({
  parametersBytes: 32_768,
  proposalBytes: 131_072,
  scopeBytes: 16_384,
  targets: 100,
});
const capability = "catalog.content.publish";
const bytes = (text: string) => new TextEncoder().encode(text).length;
const plusSeconds = (t: string, seconds: number) =>
  new Date(Date.parse(t) + seconds * 1000).toISOString();
const invalid = () => Error("LISTINGS_PRODUCER_INVALID");

function policyOf(run: ProducerRun, current: CurrentReviewPolicy | null, createdAt: string) {
  if (current) {
    let policy: Current_ReviewPolicy;
    try {
      policy = JSON.parse(current.canonical) as Current_ReviewPolicy;
    } catch {
      throw invalid();
    }
    if (
      !validateCurrentDefinition("ReviewPolicy", policy) ||
      sha256Text(current.canonical) !== current.digest ||
      policy.revision !== current.revision ||
      policy.organizationId !== run.organizationId ||
      policy.workspaceId !== run.workspaceId
    )
      throw invalid();
    return { policy, canonical: null as string | null, digest: current.digest };
  }
  const policy = {
    schemaVersion: 1,
    id: "review-policy",
    organizationId: run.organizationId,
    workspaceId: run.workspaceId,
    storeId: null,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    rules: structuredClone(defaults.rules),
  } as unknown as Current_ReviewPolicy;
  if (!validateCurrentDefinition("ReviewPolicy", policy)) throw invalid();
  const canonical = canonicalText(policy);
  return { policy, canonical, digest: sha256Text(canonical) };
}

/**
 * Packs the drafts (in product order) into proposals and builds each one. `ids` supplies a
 * fresh id per call (proposal, parameters and approval ids); `createdAt` is the database
 * time of the submitting transaction's step.
 */
export function packListingProposals(
  run: ProducerRun,
  drafts: readonly PendingDraft[],
  current: CurrentReviewPolicy | null,
  createdAt: string,
  ids: () => string,
): readonly PackedProposal[] {
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt)
    throw invalid();
  const ordered = [...drafts].sort((a, b) => a.productIndex - b.productIndex);
  const {
    policy,
    canonical: policyCanonical,
    digest: policyDigest,
  } = policyOf(run, current, createdAt);
  const risk = riskClassFor(capability);
  const rule = effectiveRule(policy.rules, risk, false);
  const expiresAt = plusSeconds(
    createdAt,
    rule.pendingExpirySeconds +
      policy.rules.soloOwner.coolDownSeconds +
      rule.approvedValiditySeconds,
  );
  const item = (d: PendingDraft, index: number) => ({
    targetIndex: index,
    productId: d.productId,
    set: JSON.parse(d.setCanonical) as unknown,
  });
  const parametersOf = (group: readonly PendingDraft[]) =>
    canonicalText({ schemaVersion: 1, storeId: run.storeId, items: group.map(item) });
  // Greedy packing by bytes: a draft starts a new proposal when it would push the parameters
  // over the cap.
  const groups: PendingDraft[][] = [];
  for (const draft of ordered) {
    if (!draft.fields.every((f) => (listingFields as readonly string[]).includes(f)))
      throw invalid();
    const last = groups.at(-1);
    if (
      last &&
      last.length < producerCaps.targets &&
      bytes(parametersOf([...last, draft])) <= producerCaps.parametersBytes
    )
      last.push(draft);
    else groups.push([draft]);
  }
  let seeded = policyCanonical;
  return Object.freeze(
    groups.map((group) => {
      const parametersCanonical = parametersOf(group);
      if (bytes(parametersCanonical) > producerCaps.parametersBytes) throw invalid();
      const parametersDigest = sha256Text(parametersCanonical);
      if (!validateCurrentDefinition("CatalogContentChangeSet", JSON.parse(parametersCanonical)))
        throw invalid();
      const targets = group.map((d) => ({
        resource: {
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
          storeId: run.storeId,
          connectionId: run.connectionId,
          kind: "product",
          id: d.productId,
        },
        expectedSourceRevision: d.snapshotDigest,
        fields: [...d.fields],
        maximumCredits: "0",
        maximumCost: null,
      }));
      const scope = {
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
        storeIds: [run.storeId],
        accountIds: [],
        resources: targets.map((t) => t.resource),
        fields: [...new Set(group.flatMap((d) => d.fields))].sort(),
      };
      const id = ids();
      const parametersId = ids();
      const content = {
        schemaVersion: 2,
        id,
        organizationId: run.organizationId,
        workspaceId: run.workspaceId,
        storeId: run.storeId,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        taskId: run.taskId,
        capabilityId: capability,
        scope,
        targets,
        parametersRef: {
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
          storeId: run.storeId,
          kind: "artifact",
          id: parametersId,
          revision: 1,
          digest: parametersDigest,
        },
        parametersDigest,
        maximumCredits: "0",
        maximumCost: null,
        risk,
        irreversible: false,
        reviewPolicyRef: {
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
          storeId: null,
          kind: "policy",
          id: "review-policy",
          revision: policy.revision,
          digest: policyDigest,
        },
        proposedBy: {
          kind: "agent",
          principalId: run.agentPrincipalId,
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
          membershipId: null,
          installationId: run.installationId,
          mandateId: null,
        },
        requestedBy: {
          kind: "human",
          principalId: run.requesterPrincipalId,
          organizationId: run.organizationId,
          workspaceId: run.workspaceId,
          membershipId: run.requesterMembershipId,
          installationId: null,
          mandateId: null,
        },
        beneficiaryPrincipalIds: [],
        contextTaint: "untrusted_external",
        partialApproval: "allowed",
        derivedFrom: null,
        expiresAt,
      };
      const proposalCanonical = canonicalText(content);
      const proposalDigest = sha256Text(proposalCanonical);
      const proposal = { ...content, proposalDigest } as unknown as Current_Proposal;
      const scopeCanonical = canonicalText(scope);
      if (
        !validateCurrentDefinition("Proposal", proposal) ||
        bytes(proposalCanonical) > producerCaps.proposalBytes ||
        bytes(scopeCanonical) > producerCaps.scopeBytes
      )
        throw invalid();
      // Only the first proposal seeds the policy; the rest bind the seeded revision.
      const packed: PackedProposal = Object.freeze({
        draftIds: Object.freeze(group.map((d) => d.draftId)),
        approvalId: ids(),
        policyCanonical: seeded,
        policyDigest,
        parametersCanonical,
        parametersDigest,
        proposalCanonical,
        proposalDigest,
        scopeCanonical,
        proposal,
      });
      seeded = null;
      return packed;
    }),
  );
}
