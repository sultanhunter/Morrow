import type {
  Core_ApprovalRef,
  Core_ProposalRef,
  Current_Approval,
  Current_Proposal,
} from "@morrow/contracts";
import { previewSelection, proposalRef } from "@morrow/policy/review";
import type { WorkTx } from "../connection.js";
import type { WorkAuthority } from "../context.js";
import { decodeCursor, encodeCursor } from "../contract-mapping.js";
import {
  projectionFacts,
  readContext,
  readFamily,
  readProposalRow,
  type ReviewFamily,
} from "./family.js";
import { eligibleReviewer, permits } from "./kernel.js";
import {
  ApprovalMappingError,
  decodeApproval,
  mapApproval,
  storedApprovalRef,
  storedProjection,
  type StoredProposalRow,
} from "./mapping.js";
import { projectApproval } from "./projection.js";

// Reads (§6, §7). Visibility is decided by the kernel at database time: a
// reviewer (view on the preview capability plus the decide reviewer verbs on the
// proposal) or the proposal's own proposer or requester (the creating verb on its
// capability). The conflict set and the reviewer list do not gate visibility.
// Anything else is "not_found", identical to an absent proposal. Statuses are
// projected and never written; candidate and reviewer grants are never returned.

export type ViewerRole = "reviewer" | "proposer";

export async function viewerRole(
  a: WorkAuthority,
  stored: Pick<StoredProposalRow, "proposal" | "proposer" | "requester">,
): Promise<ViewerRole | null> {
  const p = stored.proposal;
  if ((await permits(a, "approval.reviewer_read", p)) && (await eligibleReviewer(a, p, null)))
    return "reviewer";
  const own =
    (stored.proposer.principalId === a.actor.principalId &&
      stored.proposer.membershipId === a.actor.membershipId) ||
    (stored.requester.principalId === a.actor.principalId &&
      stored.requester.membershipId === a.actor.membershipId);
  if (own && (await permits(a, "approval.own_read", p))) return "proposer";
  return null;
}

export interface ProposalView {
  readonly proposal: Current_Proposal;
  readonly approval: Current_Approval | null;
  readonly approvalRef: Core_ApprovalRef | null;
  readonly parameters: unknown;
  readonly viewerRole: ViewerRole;
}

async function readParameters(tx: WorkTx, stored: StoredProposalRow): Promise<unknown> {
  const rows = await tx.run("parametersById", [stored.parametersId]);
  const row = rows[0];
  if (rows.length !== 1 || !row || typeof row.canonical !== "string")
    throw new ApprovalMappingError();
  if (row.digest !== stored.proposal.parametersDigest) throw new ApprovalMappingError();
  try {
    return JSON.parse(row.canonical);
  } catch {
    throw new ApprovalMappingError();
  }
}

/** One family member's approval as Approval@2 with its projected status. */
function memberView(
  family: ReviewFamily,
  proposal: Current_Proposal,
  facts: ReturnType<typeof projectionFacts>,
  atMs: number,
) {
  const stored = family.approvals.get(proposal.id);
  if (!stored) return { approval: null, approvalRef: null };
  const projected = projectApproval(storedProjection(stored, family.decisions), facts, atMs);
  return {
    approval: mapApproval(stored, proposal, family.decisions, projected.status),
    approvalRef: storedApprovalRef(stored, proposal.storeId),
  };
}

/**
 * GET /proposals/:id(?selected=…): the proposal, or with a selection the derived
 * proposal the decision binds (stored, or previewed when not yet derived), its
 * approval if any and the parameters.
 */
export async function readProposal(
  tx: WorkTx,
  a: WorkAuthority,
  proposalId: string,
  selected: readonly number[] | null,
): Promise<ProposalView | "not_found" | "invalid"> {
  const stored = await readProposalRow(tx, a, proposalId);
  if (!stored) return "not_found";
  const role = await viewerRole(a, stored);
  if (role === null) return "not_found";
  const family = await readFamily(tx, a, stored.familyRootId);
  if (!family) throw new ApprovalMappingError();
  const ctx = await readContext(tx, a, stored.proposal.capabilityId, stored.familyRootId);
  const facts = projectionFacts(ctx, stored.familyRootId, family);
  const atMs = Date.parse(ctx.databaseNow);
  let proposal = stored.proposal;
  if (selected !== null) {
    if (stored.derivedFromId !== null) return "invalid";
    const preview = previewSelection(stored.proposal, selected);
    if ("code" in preview) return "invalid";
    const existing = family.proposals.get(preview.proposal.id);
    if (existing && existing.proposal.proposalDigest !== preview.proposal.proposalDigest)
      throw new ApprovalMappingError();
    proposal = existing?.proposal ?? preview.proposal;
  }
  const member = memberView(family, proposal, facts, atMs);
  return Object.freeze({
    proposal,
    approval: member.approval,
    approvalRef: member.approvalRef,
    parameters: await readParameters(tx, stored),
    viewerRole: role,
  });
}

export interface ApprovalSummary {
  readonly approval: Current_Approval;
  readonly approvalRef: Core_ApprovalRef;
  readonly proposalRef: Core_ProposalRef;
  readonly capabilityId: string;
  readonly risk: Current_Proposal["risk"];
  readonly targetCount: number;
  readonly maximumCredits: string;
  readonly viewerRole: ViewerRole;
}

/**
 * GET /approvals?status=pending: live pending approvals under the current policy,
 * ordered (expires_at, id), visible items only, at most `limit`, scanning at most
 * 100 rows after the cursor. `next` resumes after the last row scanned.
 */
export async function listApprovals(
  tx: WorkTx,
  a: WorkAuthority,
  page: { readonly after: string | null; readonly limit: number },
): Promise<
  { readonly items: readonly ApprovalSummary[]; readonly next: string | null } | "invalid"
> {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 25) return "invalid";
  let cursor: readonly [string | null, string | null] = [null, null];
  if (page.after !== null) {
    const decoded = decodeCursor(page.after);
    if (!decoded) return "invalid";
    cursor = decoded;
  }
  const rows = await tx.run("pendingApprovalPage", [cursor[0], cursor[1]]);
  const tenant = { organizationId: a.actor.organizationId, workspaceId: a.actor.workspaceId! };
  const items: ApprovalSummary[] = [];
  let next: string | null = null;
  const families = new Map<string, ReviewFamily>();
  for (const [index, row] of rows.entries()) {
    const stored = decodeApproval(row, tenant);
    if (typeof row.cursor_us !== "string") throw new ApprovalMappingError();
    let family = families.get(stored.familyRootId);
    if (!family) {
      const loaded = await readFamily(tx, a, stored.familyRootId);
      if (!loaded) throw new ApprovalMappingError();
      family = loaded;
      families.set(stored.familyRootId, family);
    }
    const member = family.proposals.get(stored.proposalId);
    if (!member) throw new ApprovalMappingError();
    const role = await viewerRole(a, member);
    if (role !== null) {
      items.push(
        Object.freeze({
          approval: mapApproval(stored, member.proposal, family.decisions, "pending"),
          approvalRef: storedApprovalRef(stored, member.proposal.storeId),
          proposalRef: proposalRef(member.proposal),
          capabilityId: member.proposal.capabilityId,
          risk: member.proposal.risk,
          targetCount: member.proposal.targets.length,
          maximumCredits: member.proposal.maximumCredits,
          viewerRole: role,
        }),
      );
    }
    // A full page stops here; a scan of 100 rows resumes after its last row.
    if (items.length === page.limit) {
      next = index < rows.length - 1 || rows.length === 100 ? encodeCursor(row) : null;
      break;
    }
    if (index === rows.length - 1 && rows.length === 100) next = encodeCursor(row);
  }
  return Object.freeze({ items: Object.freeze(items), next });
}
