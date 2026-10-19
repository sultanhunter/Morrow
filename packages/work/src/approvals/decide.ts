import type {
  Core_ApprovalRef,
  Core_ProposalRef,
  Current_ApprovalStatus,
  Current_Proposal,
  Current_ReviewDecisionInput,
} from "@morrow/contracts";
import { validateCapabilityInput, validateCurrentDefinition } from "@morrow/contracts/validation";
import {
  foldDecisions,
  previewSelection,
  proposalRef,
  ReviewBoundaryError,
  type ReviewMember,
} from "@morrow/policy/review";
import type { WorkTx } from "../connection.js";
import { WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { canonicalText, sha256Text } from "./digests.js";
import {
  ownershipFacts,
  projectionFacts,
  readContext,
  readFamily,
  readProposalRow,
  type ReviewFamily,
} from "./family.js";
import { eligibleReviewer, humanRef, memberAuthority, snapshotGrants } from "./kernel.js";
import { mapApproval, storedProjection, type StoredApprovalRow } from "./mapping.js";
import {
  beginApprovalCommand,
  commandRow,
  decodeResult,
  sqlRefusal,
  type ApprovalRefusal,
} from "./outcomes.js";
import { projectApproval } from "./projection.js";
import { viewerRole } from "./reads.js";
import { decodeCommandResult } from "./result.js";

// Decide (§5): `governance.approval.decide` under ADR-0011. The Worker reads the
// family unlocked, asks the kernel about the reviewer and every earlier approver
// still counted, and folds the attempt through the review library; the command
// function then rechecks every rule under lock at database time and persists
// the decision. Decisions are append-only; nothing is written for a refusal.

export interface DecideInput {
  readonly commandId: string;
  readonly requestDigest: string;
  /** The root proposal; a selection names a part of it. */
  readonly proposalId: string;
  readonly body: {
    readonly decision: Current_ReviewDecisionInput;
    readonly expectedRevision: number;
  };
  readonly correlationId?: string;
}
export type DecideResult =
  | {
      readonly outcome: "applied" | "replayed";
      readonly proposalRef: Core_ProposalRef;
      readonly approvalRef: Core_ApprovalRef;
      readonly status: Current_ApprovalStatus;
      readonly effectiveAt: string | null;
      readonly expiresAt: string;
    }
  | { readonly outcome: "refused"; readonly code: ApprovalRefusal };

const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/** The members of a family as the review library holds them (root first, stored statuses). */
function members(family: ReviewFamily): ReviewMember[] {
  const list: ReviewMember[] = [];
  for (const [id, stored] of family.proposals) {
    const approval = family.approvals.get(id);
    if (!approval) throw new WorkContextUnavailable();
    list.push({
      proposal: stored.proposal,
      approval: mapApproval(approval, stored.proposal, family.decisions, approval.status),
    });
  }
  return list;
}

export async function decideApproval(
  tx: WorkTx,
  a: WorkAuthority,
  i: DecideInput,
): Promise<DecideResult> {
  const refuse = (code: ApprovalRefusal): DecideResult => {
    tx.rollbackOnly();
    return Object.freeze({ outcome: "refused", code });
  };
  const decision = i.body?.decision;
  if (
    !uuid.test(i.commandId) ||
    !/^[a-f0-9]{64}$/.test(i.requestDigest) ||
    !validateCurrentDefinition("Id", i.proposalId) ||
    !validateCurrentDefinition("ReviewDecisionInput", decision) ||
    !validateCurrentDefinition("Revision", i.body.expectedRevision)
  )
    return refuse("invalid");
  // Replay first: only to an actor who can still read the decided proposal.
  const begun = await beginApprovalCommand(tx, "approval.decide", i.commandId, i.requestDigest);
  if (begun.kind === "conflict") return refuse("COMMAND_CONFLICT");
  if (begun.kind === "ineligible") return refuse("unauthenticated");
  if (begun.kind === "invalid") return refuse("invalid");
  if (begun.kind === "replay") {
    const recorded = decodeCommandResult(a, begun.result);
    const stored = await readProposalRow(tx, a, recorded.proposalRef.id);
    if (!stored || (await viewerRole(a, stored)) === null) return refuse("not_found");
    tx.rollbackOnly();
    return Object.freeze({ outcome: "replayed", ...recorded });
  }
  // 1. The target: not visible, unknown or foreign is one not_found.
  const stored = await readProposalRow(tx, a, i.proposalId);
  if (!stored || (await viewerRole(a, stored)) === null) return refuse("not_found");
  if (stored.derivedFromId !== null) return refuse("invalid");
  const family = await readFamily(tx, a, stored.proposal.id);
  if (!family) throw new WorkContextUnavailable();
  const root = family.root.proposal;
  const input = {
    proposalRef: proposalRef(root),
    decision,
    expectedRevision: i.body.expectedRevision,
  };
  if (!validateCapabilityInput("governance.approval.decide", input)) return refuse("invalid");
  const ctx = await readContext(tx, a, root.capabilityId, root.id);
  if (!ctx.policy) throw new WorkContextUnavailable();
  const atMs = Date.parse(ctx.databaseNow);
  // The decided member: the approved one for a cancel, the root, or the
  // derivation a valid selection names (stored, or new from the preview).
  const selection =
    decision.decision === "cancel_before_effective" ? null : decision.selectedTargetIndexes;
  let derived: Current_Proposal | null = null;
  if (selection !== null) {
    const preview = previewSelection(root, selection);
    if ("proposal" in preview) derived = preview.proposal;
  }
  const rootApproval = family.approvals.get(root.id);
  if (!rootApproval) throw new WorkContextUnavailable();
  let target: StoredApprovalRow | null = rootApproval;
  if (decision.decision === "cancel_before_effective")
    target = [...family.approvals.values()].find((x) => x.status === "approved") ?? null;
  else if (derived !== null) target = family.approvals.get(derived.id) ?? null;
  // 2. The reviewer, first: approve on decide and on the capability for every
  // decided target (ADR-0011 Q5), at database time.
  const decided = derived !== null ? selection : null;
  const reviewerOk = await eligibleReviewer(a, root, decided, atMs);
  // 3. Projections at database time, in the SQL order (claims close the family).
  const facts = projectionFacts(ctx, root.id, family);
  if (facts.hasClaim && decision.decision !== "cancel_before_effective" && reviewerOk)
    return refuse("FAMILY_CONFLICT");
  for (const x of [target, decision.decision === "cancel_before_effective" ? null : rootApproval]) {
    if (!x || !reviewerOk) continue;
    const projected = projectApproval(
      storedProjection(x, family.decisions),
      { ...facts, hasClaim: false },
      atMs,
    );
    if (projected.code !== null) return refuse(projected.code);
  }
  // 4. Earlier approvers of the decided approval still count only while the
  // kernel finds them eligible now; a reviewer who is no longer a member stops
  // counting (its decision row remains).
  const eligible: string[] = reviewerOk ? [a.actor.principalId] : [];
  const counted: { principalId: string; membershipId: string; grantsDigest: string }[] = [];
  let evaluatedAt = ctx.databaseNow;
  const earlier =
    target === null || decision.decision !== "approve"
      ? []
      : family.decisions
          .filter((d) => d.approvalId === target!.id && d.decision.decision === "approve")
          .map((d) => d.decision.reviewer.principalId)
          .filter((id) => id !== a.actor.principalId);
  if (earlier.length) {
    const rows = await tx.run("reviewerSnapshot", [root.capabilityId, JSON.stringify(earlier)]);
    for (const row of rows) {
      if (
        typeof row.principal_id !== "string" ||
        typeof row.membership_id !== "string" ||
        typeof row.grants_digest !== "string" ||
        typeof row.evaluated_at !== "string" ||
        !earlier.includes(row.principal_id)
      )
        throw new WorkContextUnavailable();
      evaluatedAt = row.evaluated_at;
      const grants = snapshotGrants(row.grants, row.grant_count);
      if (grants === "overflow") continue;
      const member = memberAuthority(a, row.principal_id, row.membership_id, grants);
      if (await eligibleReviewer(member, root, decided, Date.parse(row.evaluated_at))) {
        eligible.push(row.principal_id);
        counted.push({
          principalId: row.principal_id,
          membershipId: row.membership_id,
          grantsDigest: row.grants_digest,
        });
      }
    }
  }
  // 5. The fold: the library decides the outcome over the stored family.
  let result;
  try {
    const state = {
      revision: (target ?? rootApproval).revision,
      members: members(family),
      commands: [],
    };
    result = foldDecisions(state, [
      {
        commandId: i.commandId,
        requestDigest: i.requestDigest,
        reviewer: humanRef(a),
        input,
        at: ctx.databaseNow,
        reviewerEligible: reviewerOk,
        eligibleReviewerPrincipalIds: eligible,
        ownership: ownershipFacts(ctx, a),
        currentPolicy: ctx.policy,
      },
    ]).results[0];
  } catch (error) {
    if (error instanceof ReviewBoundaryError) throw new WorkContextUnavailable();
    throw error;
  }
  if (!result) throw new WorkContextUnavailable();
  if (!result.ok) return refuse(result.code);
  // 6. The command: the phrase digest only on the solo path, the new derivation's
  // exact document, and the counted earlier approvers with their grants digests.
  const solo = result.transitions.some((t) => t.actor === "solo_owner" && t.to === "approved");
  const phraseDigest =
    solo && decision.soloOwnerConfirmation !== null
      ? sha256Text(decision.soloOwnerConfirmation.normalize("NFC"))
      : null;
  let derivedCanonical: string | null = null;
  let derivedScope: string | null = null;
  if (derived !== null && !family.proposals.has(derived.id)) {
    const { proposalDigest: _omitted, ...content } = derived;
    derivedCanonical = canonicalText(content);
    derivedScope = canonicalText(derived.scope);
  }
  const countedJson = canonicalText({
    evaluatedAt,
    reviewers: solo || decision.decision !== "approve" ? [] : counted,
  });
  tx.markSubmitted();
  const row = commandRow(
    await tx.run("cmdApprovalDecide", [
      i.commandId,
      i.requestDigest,
      i.correlationId ?? crypto.randomUUID(),
      root.id,
      String(i.body.expectedRevision),
      decision.decision,
      selection === null ? null : JSON.stringify(selection),
      decision.expectedDecisionDigest,
      derivedCanonical,
      derivedCanonical === null ? null : derived!.proposalDigest,
      derivedScope,
      phraseDigest,
      decision.comment,
      countedJson,
    ]),
  );
  if (row.outcome !== "applied") return refuse(sqlRefusal(row.outcome));
  return Object.freeze({
    outcome: "applied",
    ...decodeCommandResult(a, decodeResult(row.result)),
  });
}
