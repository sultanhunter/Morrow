import type {
  CapabilityId,
  Core_ApprovalRef,
  Core_ProposalRef,
  Current_HumanActorRef,
  Current_Proposal,
  Current_ReviewPolicy,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import {
  canonicalDigest,
  checkProposal,
  effectiveRule,
  proposalDigest,
  reviewPolicyRef,
  riskClassFor,
  ReviewBoundaryError,
  soloOwnerStatus,
  type EffectiveRule,
} from "@morrow/policy/review";
import defaults from "../../../../docs/contracts/review-policy-defaults.json";
import type { WorkTx } from "../connection.js";
import { WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { canonicalText, sha256Text } from "./digests.js";
import { ownershipFacts, readContext, readProposalRow, type ReviewContext } from "./family.js";
import { eligibleReviewer, humanRef, memberAuthority, permits, snapshotGrants } from "./kernel.js";
import { beginApprovalCommand, commandRow, decodeResult, sqlRefusal } from "./outcomes.js";
import type { ProducerRegistry } from "./producers.js";
import { viewerRole } from "./reads.js";
import { decodeCommandResult } from "./result.js";

// Submit (§5): producer code only, no HTTP route. The proposal is built from SQL
// facts, the compiled catalogue and the review library; cmd_proposal_submit
// rechecks every data-only rule under lock and writes it with its pending
// approval. Every refusal rolls back and persists nothing.

export interface SubmitInput {
  readonly commandId: string;
  readonly requestDigest: string;
  /** Null only for a human governance proposal (ADR-0018). */
  readonly taskId: string | null;
  readonly capabilityId: CapabilityId;
  readonly parameters: unknown;
  readonly correlationId?: string;
}
export type SubmitRefusal =
  | "producer_missing"
  | "unauthenticated"
  | "denied"
  | "not_found"
  | "invalid"
  | "quorum_unreachable"
  | "command_conflict"
  | "stale_authority"
  | "limit_reached";
export type SubmitResult =
  | {
      readonly outcome: "applied" | "replayed";
      readonly proposalRef: Core_ProposalRef;
      readonly approvalRef: Core_ApprovalRef;
      readonly expiresAt: string;
    }
  | { readonly outcome: SubmitRefusal };

/** Published caps (§5). */
export const approvalCaps = Object.freeze({
  targets: 100,
  proposalBytes: 131072,
  parametersBytes: 32768,
  scopeBytes: 16384,
  candidatesScanned: 1000,
});
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const bytes = (text: string) => new TextEncoder().encode(text).length;
const plusSeconds = (t: string, seconds: number) =>
  new Date(Date.parse(t) + seconds * 1000).toISOString();

/** Revision 1 of a workspace's ReviewPolicy, seeded from the defaults (ADR-0011 Q3). */
export function defaultReviewPolicy(a: WorkAuthority, createdAt: string): Current_ReviewPolicy {
  return {
    schemaVersion: 1,
    id: "review-policy",
    organizationId: a.actor.organizationId,
    workspaceId: a.actor.workspaceId!,
    storeId: null,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    rules: structuredClone(defaults.rules) as Current_ReviewPolicy["rules"],
  };
}

/**
 * Quorum reachability (§5 step 5; liveness only). Unless solo confirmation can
 * apply, pages the review candidates (excluding the conflict set unless the rule
 * allows self-approval) and keeps the kernel-eligible ones until the quorum is
 * reachable; an overflowed candidate counts as ineligible.
 */
async function reachableReviewers(
  tx: WorkTx,
  a: WorkAuthority,
  proposal: Current_Proposal,
  ctx: ReviewContext,
  policy: Current_ReviewPolicy,
  rule: EffectiveRule,
  conflicted: ReadonlySet<string>,
): Promise<string[] | "limit_reached"> {
  const eligible: string[] = [];
  const listed = (id: string) =>
    rule.eligibleReviewerPrincipalIds === null || rule.eligibleReviewerPrincipalIds.includes(id);
  const reachable = () =>
    eligible.filter((id) => rule.selfApproval === "allowed" || !conflicted.has(id)).length;
  const judge = async (row: Record<string, unknown>) => {
    const grants = snapshotGrants(row.grants, row.grant_count);
    if (grants === "overflow") return false;
    if (typeof row.principal_id !== "string" || typeof row.membership_id !== "string")
      throw new WorkContextUnavailable();
    if (typeof row.evaluated_at !== "string") throw new WorkContextUnavailable();
    const member = memberAuthority(a, row.principal_id, row.membership_id, grants);
    return eligibleReviewer(member, proposal, null, Date.parse(row.evaluated_at));
  };
  const owner = ctx.ownerPrincipalId;
  if (
    owner !== null &&
    rule.selfApproval === "solo_owner_typed_confirmation" &&
    conflicted.has(owner) &&
    listed(owner)
  ) {
    const rows = await tx.run("reviewerSnapshot", [proposal.capabilityId, JSON.stringify([owner])]);
    if (rows.length === 1 && (await judge(rows[0]!))) {
      eligible.push(owner);
      const facts = ownershipFacts(ctx, a);
      if (
        soloOwnerStatus(facts, owner, proposal.createdAt, policy.rules.soloOwner.quietPeriodSeconds)
      )
        return eligible;
    }
  }
  const exclude = rule.selfApproval === "allowed" ? [] : [...conflicted];
  let after: string | null = null;
  let scanned = 0;
  for (;;) {
    const rows: readonly Record<string, unknown>[] = await tx.run("reviewCandidates", [
      proposal.capabilityId,
      JSON.stringify(exclude),
      after,
      "25",
    ]);
    for (const row of rows) {
      if (++scanned > approvalCaps.candidatesScanned) return "limit_reached";
      const id = row.principal_id;
      if (typeof id !== "string") throw new WorkContextUnavailable();
      if (!eligible.includes(id) && listed(id) && (await judge(row))) eligible.push(id);
      if (reachable() >= rule.requiredApprovals) return eligible;
    }
    if (rows.length < 25) return eligible;
    after = rows.at(-1)!.principal_id as string;
  }
}

export async function submitProposal(
  tx: WorkTx,
  a: WorkAuthority,
  r: ProducerRegistry,
  i: SubmitInput,
): Promise<SubmitResult> {
  const refuse = (outcome: SubmitRefusal): SubmitResult => {
    tx.rollbackOnly();
    return Object.freeze({ outcome });
  };
  // 1. Producer and closed parameters, before any SQL.
  const producer = r.get(i.capabilityId);
  if (!producer || producer.capabilityId !== i.capabilityId) return refuse("producer_missing");
  if (
    !uuid.test(i.commandId) ||
    !/^[a-f0-9]{64}$/.test(i.requestDigest) ||
    (i.taskId !== null && !validateCurrentDefinition("Id", i.taskId))
  )
    return refuse("invalid");
  const parsed = producer.parse(i.parameters);
  if (parsed === null) return refuse("invalid");
  const tenant = { organizationId: a.actor.organizationId, workspaceId: a.actor.workspaceId! };
  const plan = producer.plan(parsed, tenant);
  if (
    plan === "invalid" ||
    plan.targets.length < 1 ||
    plan.targets.length > approvalCaps.targets ||
    !plan.targets.every(
      (t) =>
        validateCurrentDefinition("ProposalTarget", t) &&
        canonicalText(t.resource) === canonicalText(a.resource),
    ) ||
    plan.beneficiaryPrincipalIds.length > 100 ||
    new Set(plan.beneficiaryPrincipalIds).size !== plan.beneficiaryPrincipalIds.length ||
    !plan.beneficiaryPrincipalIds.every((id) => validateCurrentDefinition("Id", id))
  )
    return refuse("invalid");
  // Replay first: only a currently visible proposal is disclosed.
  const begun = await beginApprovalCommand(tx, "proposal.submit", i.commandId, i.requestDigest);
  if (begun.kind === "conflict") return refuse("command_conflict");
  if (begun.kind === "ineligible") return refuse("unauthenticated");
  if (begun.kind === "invalid") return refuse("invalid");
  if (begun.kind === "replay") {
    const recorded = decodeCommandResult(a, begun.result);
    const stored = await readProposalRow(tx, a, recorded.proposalRef.id);
    if (!stored || (await viewerRole(a, stored)) === null) return refuse("not_found");
    tx.rollbackOnly();
    return Object.freeze({
      outcome: "replayed",
      proposalRef: recorded.proposalRef,
      approvalRef: recorded.approvalRef,
      expiresAt: recorded.expiresAt,
    });
  }
  // 2. Grants: the creating verb on the capability over W and every target field;
  // the task attach (own task → execute, another's → administer).
  if (
    !(await permits(a, "proposal.submit", { capabilityId: i.capabilityId, targets: plan.targets }))
  )
    return refuse("denied");
  let requestedBy: Current_HumanActorRef | null = null;
  let basis: "own" | "other" | null = null;
  if (i.taskId !== null) {
    const rows = await tx.run("proposalTask", [i.taskId]);
    const task = rows[0];
    if (rows.length === 0 || !task) return refuse("not_found");
    if (
      rows.length !== 1 ||
      typeof task.initiator_principal_id !== "string" ||
      typeof task.initiator_membership_id !== "string"
    )
      throw new WorkContextUnavailable();
    basis =
      task.initiator_principal_id === a.actor.principalId &&
      task.initiator_membership_id === a.actor.membershipId
        ? "own"
        : "other";
    const attach = { capabilityId: i.capabilityId, targets: plan.targets };
    if (!(await permits(a, "proposal.task_attach", attach, basis))) return refuse("denied");
    requestedBy = {
      ...humanRef(a),
      principalId: task.initiator_principal_id,
      membershipId: task.initiator_membership_id,
    };
  }
  // 3. Facts, read before the command's locks and rechecked there.
  const ctx = await readContext(tx, a, i.capabilityId, null);
  if (
    !ctx.capability ||
    !ctx.capability.reviewRequired ||
    ctx.capability.killSwitch ||
    i.capabilityId === "governance.connection.connect"
  )
    return refuse("invalid");
  const createdAt = ctx.databaseNow;
  const policy = ctx.policy ?? defaultReviewPolicy(a, createdAt);
  if (ctx.policy === null && ctx.defaultsDigest !== canonicalDigest(defaults.rules))
    throw new WorkContextUnavailable();
  // 4. Build Proposal@2: risk from the effect table, the catalogue flag, the
  // producer's partial-approval mode, no taint, the bound policy and parameters,
  // the derived scope and the fixed expiry formula.
  let risk: Current_Proposal["risk"];
  let rule: EffectiveRule;
  try {
    risk = riskClassFor(i.capabilityId);
    if (risk !== ctx.capability.risk) throw new WorkContextUnavailable();
    rule = effectiveRule(policy.rules, risk, ctx.capability.irreversible);
  } catch (error) {
    if (error instanceof ReviewBoundaryError) return refuse("invalid");
    throw error;
  }
  const parametersCanonical = canonicalText(parsed);
  const parametersDigest = sha256Text(parametersCanonical);
  const parametersId = crypto.randomUUID();
  const fields = [...new Set(plan.targets.flatMap((t) => t.fields))].sort();
  const scope = {
    organizationId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    storeIds: [],
    accountIds: [],
    resources: [a.resource],
    fields,
  };
  const credits = plan.targets.reduce((sum, t) => sum + BigInt(t.maximumCredits), 0n);
  const costs = plan.targets.flatMap((t) => (t.maximumCost === null ? [] : [t.maximumCost]));
  const micros = (amount: string) => {
    const [whole, fraction = ""] = amount.split(".");
    return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  };
  let maximumCost: Current_Proposal["maximumCost"] = null;
  if (costs.length) {
    if (costs.some((c) => c.currency !== costs[0]!.currency)) return refuse("invalid");
    const digits = Math.max(...costs.map((c) => c.amount.split(".")[1]?.length ?? 0));
    const total = costs.reduce((sum, c) => sum + micros(c.amount), 0n);
    const whole = (total / 1_000_000n).toString();
    maximumCost = {
      amount: digits
        ? `${whole}.${(total % 1_000_000n).toString().padStart(6, "0").slice(0, digits)}`
        : whole,
      currency: costs[0]!.currency,
    };
  }
  const proposedBy = humanRef(a);
  const content: Current_Proposal = {
    schemaVersion: 2,
    id: crypto.randomUUID(),
    organizationId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    storeId: null,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    taskId: i.taskId,
    capabilityId: i.capabilityId,
    scope,
    targets: plan.targets.map((t) => structuredClone(t)),
    parametersRef: {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      storeId: null,
      kind: "artifact",
      id: parametersId,
      revision: 1,
      digest: parametersDigest,
    },
    parametersDigest,
    maximumCredits: credits.toString(),
    maximumCost,
    risk,
    irreversible: ctx.capability.irreversible,
    reviewPolicyRef: reviewPolicyRef(policy),
    proposedBy,
    requestedBy: requestedBy ?? proposedBy,
    beneficiaryPrincipalIds: [...plan.beneficiaryPrincipalIds],
    contextTaint: "none",
    partialApproval: producer.partialApproval,
    derivedFrom: null,
    proposalDigest: "0".repeat(64),
    expiresAt: plusSeconds(
      createdAt,
      rule.pendingExpirySeconds +
        policy.rules.soloOwner.coolDownSeconds +
        rule.approvedValiditySeconds,
    ),
  };
  const proposal: Current_Proposal = { ...content, proposalDigest: proposalDigest(content) };
  const { proposalDigest: digest, ...withoutDigest } = proposal;
  const canonical = canonicalText(withoutDigest);
  const scopeCanonical = canonicalText(scope);
  if (
    sha256Text(canonical) !== digest ||
    bytes(parametersCanonical) < 2 ||
    bytes(parametersCanonical) > approvalCaps.parametersBytes ||
    bytes(canonical) > approvalCaps.proposalBytes ||
    bytes(scopeCanonical) > approvalCaps.scopeBytes
  )
    return refuse("invalid");
  // 5. Check: the library returns no codes; quorum reachability is liveness only
  // (interim until P01.T02c turns QUORUM_UNREACHABLE into an inbox exception).
  const conflicted = new Set([
    proposal.proposedBy.principalId,
    proposal.requestedBy.principalId,
    ...proposal.beneficiaryPrincipalIds,
  ]);
  let eligible: string[] | "limit_reached";
  try {
    eligible = await reachableReviewers(tx, a, proposal, ctx, policy, rule, conflicted);
  } catch (error) {
    if (error instanceof ReviewBoundaryError) return refuse("invalid");
    throw error;
  }
  if (eligible === "limit_reached") return refuse("limit_reached");
  let codes: readonly string[];
  try {
    codes = checkProposal(proposal, {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      storeId: null,
      proposedBy,
      ...(i.taskId === null
        ? { taskId: null, requestedBy: null }
        : { taskId: i.taskId, requestedBy: requestedBy! }),
      beneficiaryPrincipalIds: [...plan.beneficiaryPrincipalIds],
      contextTaint: "none",
      reviewPolicy: policy,
      eligibleReviewerPrincipalIds: eligible,
      ownership: ownershipFacts(ctx, a),
      at: createdAt,
    });
  } catch (error) {
    if (error instanceof ReviewBoundaryError) return refuse("invalid");
    throw error;
  }
  if (codes.length)
    return refuse(
      codes.every((c) => c === "QUORUM_UNREACHABLE") ? "quorum_unreachable" : "invalid",
    );
  // 6. Write: from here a lost reply is an unknown outcome.
  const policyCanonical = ctx.policy === null ? canonicalText(policy) : null;
  tx.markSubmitted();
  const row = commandRow(
    await tx.run("cmdProposalSubmit", [
      i.commandId,
      i.requestDigest,
      i.correlationId ?? crypto.randomUUID(),
      i.taskId,
      basis,
      crypto.randomUUID(),
      policyCanonical,
      proposal.reviewPolicyRef.digest,
      parametersCanonical,
      parametersDigest,
      canonical,
      digest,
      scopeCanonical,
    ]),
  );
  if (row.outcome !== "applied") {
    tx.rollbackOnly();
    const refusal = sqlRefusal(row.outcome);
    return Object.freeze({
      outcome: (
        [
          "unauthenticated",
          "denied",
          "not_found",
          "invalid",
          "command_conflict",
          "stale_authority",
          "limit_reached",
        ] as const
      ).includes(refusal as never)
        ? (refusal as SubmitRefusal)
        : "invalid",
    });
  }
  const recorded = decodeCommandResult(a, decodeResult(row.result));
  return Object.freeze({
    outcome: "applied",
    proposalRef: recorded.proposalRef,
    approvalRef: recorded.approvalRef,
    expiresAt: recorded.expiresAt,
  });
}
