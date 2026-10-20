import type {
  Current_Grant,
  Current_HumanActorRef,
  Current_Proposal,
  Current_ProposalTarget,
} from "@morrow/contracts";
import {
  approvalPermissions,
  proposerVerb,
  type ApprovalPermissionKey,
} from "@morrow/contracts/work-permissions";
import {
  createHumanPolicyService,
  type HumanAuthority,
  type PermissionResult,
  type PermissionVerb,
} from "@morrow/policy";
import { reviewerEligible, type ReviewerPermissionPort } from "@morrow/policy/review";
import { decodeGrants } from "../context.js";
import type { WorkAuthority } from "../context.js";

// Every grant question of the approval records goes to the packages/policy
// kernel (ADR-0010 item 2): the actor's, a review candidate's or a counted
// reviewer's grants, at database time. SQL selects grant rows by capability id
// only and never interprets them. Approvals are never paid work (P01.T04a §1),
// so `entitlementAllowed` is the literal false every non-billing builder passes.

/** The kernel port for one principal's grants at an instant (epoch ms). */
export function kernelPort(
  a: WorkAuthority,
  atMs: number = a.databaseNowMs,
): ReviewerPermissionPort {
  const authority: HumanAuthority = {
    actor: a.actor,
    policyRevision: a.policyRevision,
    grantsRevision: a.policyRevision,
    principalActive: true,
    organizationActive: true,
    workspaceActive: true,
    membershipActive: true,
    sessionCurrent: true,
    resource: a.resource,
    accountId: null,
    providerAllowed: true,
    entitlementAllowed: false,
    grants: a.grants,
  };
  const service = createHumanPolicyService(
    { readCurrent: async () => authority },
    () => new Date(atMs),
  );
  return { decide: (request: unknown): Promise<PermissionResult> => service.decide(request) };
}

/** A workspace member other than the actor, judged on the grants SQL read for it. */
export function memberAuthority(
  a: WorkAuthority,
  principalId: string,
  membershipId: string,
  grants: readonly Current_Grant[],
): WorkAuthority {
  return Object.freeze({
    actor: Object.freeze({
      kind: "human" as const,
      principalId,
      organizationId: a.actor.organizationId,
      workspaceId: a.actor.workspaceId,
      membershipId,
      installationId: null,
      mandateId: null,
    }),
    policyRevision: a.policyRevision,
    grants,
    databaseNowMs: a.databaseNowMs,
    resource: a.resource,
  });
}

/** Decodes a bridge row's grants (at most 64 kept; 65 means overflow, judged ineligible). */
export function snapshotGrants(
  text: unknown,
  count: unknown,
): readonly Current_Grant[] | "overflow" {
  if (typeof count === "string" && /^[0-9]{1,3}$/.test(count) && Number(count) >= 65)
    return "overflow";
  const grants = decodeGrants(text, count);
  return grants === "overflow" ? "overflow" : grants;
}

/** The union of every field of every target, in first-seen order. */
export function targetFields(
  p: { readonly targets: readonly Current_ProposalTarget[] },
  indexes: readonly number[] | null = null,
): string[] {
  const fields: string[] = [];
  for (const [i, t] of p.targets.entries())
    if (indexes === null || indexes.includes(i))
      for (const field of t.fields) if (!fields.includes(field)) fields.push(field);
  return fields;
}

export async function allowed(
  a: WorkAuthority,
  capabilityId: string,
  verb: PermissionVerb,
  fields: readonly string[],
  atMs?: number,
): Promise<boolean> {
  const result = await kernelPort(a, atMs).decide({
    capabilityId,
    verb,
    resource: a.resource,
    accountId: null,
    fields: [...fields],
  });
  return result.decision.allowed;
}

/**
 * One §6 operation for the actor on a proposal: every requirement of the rule,
 * with "proposal" the proposal's capability and "targets" its target fields.
 * Ownership-selected verbs need `basis`.
 */
export async function permits(
  a: WorkAuthority,
  op: ApprovalPermissionKey,
  proposal: { readonly capabilityId: string; readonly targets: readonly Current_ProposalTarget[] },
  basis: "own" | "other" | null = null,
  atMs?: number,
): Promise<boolean> {
  for (const r of approvalPermissions[op].requirements) {
    const capabilityId = r.capabilityId === "proposal" ? proposal.capabilityId : r.capabilityId;
    let verb = r.verb;
    if (typeof verb !== "string") {
      if (basis === null) return false;
      verb = verb[basis];
    }
    const resolved: PermissionVerb = verb === "proposer" ? proposerVerb(capabilityId) : verb;
    const fields = r.fields === "targets" ? targetFields(proposal) : [...r.fields];
    if (!(await allowed(a, capabilityId, resolved, fields, atMs))) return false;
  }
  return true;
}

/** The library's reviewer rule for the actor (decide approve, capability approve per target). */
export function eligibleReviewer(
  a: WorkAuthority,
  proposal: Current_Proposal,
  selected: readonly number[] | null,
  atMs?: number,
): Promise<boolean> {
  return reviewerEligible(
    kernelPort(a, atMs),
    proposal,
    selected,
    proposal.targets.map(() => null),
  );
}

export const humanRef = (a: WorkAuthority): Current_HumanActorRef =>
  Object.freeze({
    kind: "human",
    principalId: a.actor.principalId,
    organizationId: a.actor.organizationId,
    workspaceId: a.actor.workspaceId!,
    membershipId: a.actor.membershipId!,
    installationId: null,
    mandateId: null,
  });
