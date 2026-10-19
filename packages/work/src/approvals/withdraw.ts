import type { Core_ApprovalRef, Core_ProposalRef, Current_ApprovalStatus } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import type { WorkTx } from "../connection.js";
import type { WorkAuthority } from "../context.js";
import { readProposalRow } from "./family.js";
import { permits } from "./kernel.js";
import {
  beginApprovalCommand,
  commandRow,
  decodeResult,
  sqlRefusal,
  type ApprovalRefusal,
} from "./outcomes.js";
import { viewerRole } from "./reads.js";
import { decodeCommandResult } from "./result.js";

// Withdraw (§5): the v1 pending→cancelled owner row, by the proposer only, holding
// the creating verb on the proposal's capability; a withdrawn root closes its
// pending derivations (family_closed). SQL rechecks the proposer, the revision,
// the projection and the status under lock.

export interface WithdrawInput {
  readonly commandId: string;
  readonly requestDigest: string;
  readonly proposalId: string;
  readonly expectedRevision: number;
  readonly correlationId?: string;
}
export type TransitionResult =
  | {
      readonly outcome: "applied" | "replayed";
      readonly proposalRef: Core_ProposalRef;
      readonly approvalRef: Core_ApprovalRef;
      readonly status: Current_ApprovalStatus;
      readonly effectiveAt: string | null;
      readonly expiresAt: string;
    }
  | { readonly outcome: "refused"; readonly code: ApprovalRefusal };

export async function withdrawProposal(
  tx: WorkTx,
  a: WorkAuthority,
  i: WithdrawInput,
): Promise<TransitionResult> {
  const refuse = (code: ApprovalRefusal): TransitionResult => {
    tx.rollbackOnly();
    return Object.freeze({ outcome: "refused", code });
  };
  if (
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(i.commandId) ||
    !/^[a-f0-9]{64}$/.test(i.requestDigest) ||
    !validateCurrentDefinition("Id", i.proposalId) ||
    !validateCurrentDefinition("Revision", i.expectedRevision)
  )
    return refuse("invalid");
  const begun = await beginApprovalCommand(tx, "approval.withdraw", i.commandId, i.requestDigest);
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
  const stored = await readProposalRow(tx, a, i.proposalId);
  if (!stored || (await viewerRole(a, stored)) === null) return refuse("not_found");
  if (
    stored.proposer.principalId !== a.actor.principalId ||
    stored.proposer.membershipId !== a.actor.membershipId ||
    !(await permits(a, "approval.withdraw", stored.proposal))
  )
    return refuse("denied");
  if (stored.derivedFromId !== null) return refuse("state_conflict");
  tx.markSubmitted();
  const row = commandRow(
    await tx.run("cmdApprovalWithdraw", [
      i.commandId,
      i.requestDigest,
      i.correlationId ?? crypto.randomUUID(),
      stored.proposal.id,
      String(i.expectedRevision),
    ]),
  );
  if (row.outcome !== "applied") return refuse(sqlRefusal(row.outcome));
  return Object.freeze({
    outcome: "applied",
    ...decodeCommandResult(a, decodeResult(row.result)),
  });
}
