import type {
  Current_Grant,
  Current_HumanActorRef,
  Current_Proposal,
  Current_ProposalTarget,
  Current_ResourceRef,
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
import {
  reviewerEligible,
  reviewerEligibleOnStore,
  type ReviewerPermissionPort,
} from "@morrow/policy/review";
import { storeResource, type StoreResource } from "@morrow/policy/store-resource";
import type { WorkTx } from "../connection.js";
import { decodeGrants, WorkContextUnavailable } from "../context.js";
import type { WorkAuthority } from "../context.js";

// Every grant question of the approval records goes to the packages/policy
// kernel (ADR-0010 item 2): the actor's, a review candidate's or a counted
// reviewer's grants, at database time. SQL selects grant rows by capability id
// only and never interprets them. Approvals are never paid work (P01.T04a §1),
// so `entitlementAllowed` is the literal false every non-billing builder passes.
//
// v1 PR 3 (ADR-0022 item 3): a store-bound catalogue proposal is read, decided and
// claimed on its store resource {kind: "store", id: S, storeId: S, connectionId: C}, the
// resource the store-link template and every catalogue grant name. The governance
// requirements (decide, preview) stay on the workspace resource. The kernel port
// therefore admits exactly two resources: the session's workspace and the one
// server-built store resource of the proposal; any other resource is scope_denied.

/**
 * The store resource of a store-bound proposal: its store and the connection its targets
 * name, the same on every target. Null for a storeless proposal; "invalid" when the
 * targets disagree with the proposal's store or with each other (never reviewable).
 */
export function proposalStore(p: {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string | null;
  readonly targets: readonly Current_ProposalTarget[];
}): StoreResource | null | "invalid" {
  if (p.storeId === null) return null;
  const first = p.targets[0]?.resource;
  if (!first || first.connectionId === null) return "invalid";
  for (const t of p.targets) {
    const r = t.resource;
    if (
      r.organizationId !== p.organizationId ||
      r.workspaceId !== p.workspaceId ||
      r.storeId !== p.storeId ||
      r.connectionId !== first.connectionId
    )
      return "invalid";
  }
  try {
    return storeResource(p.organizationId, p.workspaceId, p.storeId, first.connectionId);
  } catch {
    return "invalid";
  }
}

/**
 * Whether the store is still linked through the store resource's connection, now
 * (store_association, the session tenant's current association). The commands recheck it
 * under lock (cmd_catalog_apply, cmd_catalog_dispatch).
 */
export async function storeLinkCurrent(tx: WorkTx, store: StoreResource): Promise<boolean> {
  const rows = await tx.run("storeAssociation", [store.storeId]);
  if (rows.length === 0) return false;
  const row = rows[0];
  if (rows.length !== 1 || !row || row.store_id !== store.storeId)
    throw new WorkContextUnavailable();
  return row.connection_id === store.connectionId;
}

const sameResource = (x: Current_ResourceRef, y: Current_ResourceRef) =>
  x.organizationId === y.organizationId &&
  x.workspaceId === y.workspaceId &&
  x.storeId === y.storeId &&
  x.connectionId === y.connectionId &&
  x.kind === y.kind &&
  x.id === y.id;

/**
 * The kernel port for one principal's grants at an instant (epoch ms). With `store`, a
 * request on exactly that store resource is decided on it; every other request is decided
 * on the session's workspace resource (so a request naming any other resource is
 * scope_denied).
 */
export function kernelPort(
  a: WorkAuthority,
  atMs: number = a.databaseNowMs,
  store: StoreResource | null = null,
): ReviewerPermissionPort {
  const authority = (resource: Current_ResourceRef): HumanAuthority => ({
    actor: a.actor,
    policyRevision: a.policyRevision,
    grantsRevision: a.policyRevision,
    principalActive: true,
    organizationActive: true,
    workspaceActive: true,
    membershipActive: true,
    sessionCurrent: true,
    resource,
    accountId: null,
    providerAllowed: true,
    entitlementAllowed: false,
    grants: a.grants,
  });
  const service = createHumanPolicyService(
    {
      readCurrent: async (request) =>
        authority(store !== null && sameResource(request.resource, store) ? store : a.resource),
    },
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
  store: StoreResource | null = null,
): Promise<boolean> {
  const result = await kernelPort(a, atMs, store).decide({
    capabilityId,
    verb,
    resource: store ?? a.resource,
    accountId: null,
    fields: [...fields],
  });
  return result.decision.allowed;
}

/**
 * One §6 operation for the actor on a proposal: every requirement of the rule,
 * with "proposal" the proposal's capability and "targets" its target fields.
 * Ownership-selected verbs need `basis`. A store-bound proposal's own capability is
 * decided on its store resource (proposalStore), the governance requirements on the
 * workspace; a store-bound proposal whose targets disagree is never permitted.
 */
export async function permits(
  a: WorkAuthority,
  op: ApprovalPermissionKey,
  proposal: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly storeId: string | null;
    readonly capabilityId: string;
    readonly targets: readonly Current_ProposalTarget[];
  },
  basis: "own" | "other" | null = null,
  atMs?: number,
): Promise<boolean> {
  const store = proposalStore(proposal);
  if (store === "invalid") return false;
  for (const r of approvalPermissions[op].requirements) {
    const capabilityId = r.capabilityId === "proposal" ? proposal.capabilityId : r.capabilityId;
    let verb = r.verb;
    if (typeof verb !== "string") {
      if (basis === null) return false;
      verb = verb[basis];
    }
    const resolved: PermissionVerb = verb === "proposer" ? proposerVerb(capabilityId) : verb;
    const fields = r.fields === "targets" ? targetFields(proposal) : [...r.fields];
    const on = r.capabilityId === "proposal" ? store : null;
    if (!(await allowed(a, capabilityId, resolved, fields, atMs, on))) return false;
  }
  return true;
}

/**
 * The library's reviewer rule for the actor (decide approve, capability approve per target);
 * for a store-bound proposal, the store-resource rule (reviewerEligibleOnStore).
 */
export async function eligibleReviewer(
  a: WorkAuthority,
  proposal: Current_Proposal,
  selected: readonly number[] | null,
  atMs?: number,
): Promise<boolean> {
  const store = proposalStore(proposal);
  if (store === "invalid") return false;
  if (store !== null)
    return reviewerEligibleOnStore(kernelPort(a, atMs, store), proposal, selected, store);
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
