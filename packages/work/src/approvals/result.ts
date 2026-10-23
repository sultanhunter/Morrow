import type { Core_ApprovalRef, Core_ProposalRef, Current_ApprovalStatus } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { WorkContextUnavailable, type WorkAuthority } from "../context.js";

// The recorded result of an approval command (the commands row, ≤ 1 KiB): the
// decided approval's reference fields, from which the refs are rebuilt with the
// actor's tenant. A replay returns the same object.
export interface ApprovalCommandResult {
  readonly proposalRef: Core_ProposalRef;
  readonly approvalRef: Core_ApprovalRef;
  readonly status: Current_ApprovalStatus;
  readonly effectiveAt: string | null;
  readonly expiresAt: string;
}
const keys = [
  "approvalDigest",
  "approvalId",
  "approvalRevision",
  "effectiveAt",
  "expiresAt",
  "proposalDigest",
  "proposalId",
  "status",
].join(",");
/**
 * `storeId` is the decided proposal's own store (v1 PR 3: a store-bound catalogue proposal's
 * ProposalRef names its store, as proposalRef(p) does); the record holds ids only.
 */
export function decodeCommandResult(
  a: WorkAuthority,
  r: Readonly<Record<string, unknown>>,
  storeId: string | null = null,
): ApprovalCommandResult {
  const tenant = { organizationId: a.actor.organizationId, workspaceId: a.actor.workspaceId! };
  const proposalRef = {
    ...tenant,
    storeId,
    kind: "proposal",
    id: r.proposalId,
    revision: 1,
    digest: r.proposalDigest,
  };
  const approvalRef = {
    ...tenant,
    storeId: null,
    kind: "approval",
    id: r.approvalId,
    revision: r.approvalRevision,
    digest: r.approvalDigest,
  };
  if (
    Object.keys(r).sort().join(",") !== keys ||
    !validateCurrentDefinition("ProposalRef", proposalRef) ||
    !validateCurrentDefinition("ApprovalRef", approvalRef) ||
    !validateCurrentDefinition("ApprovalStatus", r.status) ||
    !(r.effectiveAt === null || validateCurrentDefinition("UtcTime", r.effectiveAt)) ||
    !validateCurrentDefinition("UtcTime", r.expiresAt)
  )
    throw new WorkContextUnavailable();
  return Object.freeze({
    proposalRef: proposalRef as Core_ProposalRef,
    approvalRef: approvalRef as Core_ApprovalRef,
    status: r.status as Current_ApprovalStatus,
    effectiveAt: r.effectiveAt as string | null,
    expiresAt: r.expiresAt as string,
  });
}
