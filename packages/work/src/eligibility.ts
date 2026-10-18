import { validateDefinition } from "@morrow/contracts/validation";
import { workEligibility, workPermissions } from "@morrow/contracts/work-permissions";
import type { WorkTx } from "./connection.js";
import { decodeGrants, WorkContextUnavailable, type WorkAuthority } from "./context.js";
import { decideWork } from "./permissions.js";

// Eligibility of an assignee or respondent (ADR-0010 item 4): an active human
// member of the caller's own workspace who currently holds the required grants.
// The target's grants are read server-side for this decision only and are never
// returned. A non-member is indistinguishable from an unknown principal.
export async function targetEligible(
  tx: WorkTx,
  a: WorkAuthority,
  target: string,
  role: "assignee" | "respondent",
): Promise<"eligible" | "not_member" | "ineligible"> {
  if (!validateDefinition("core", "Id", target)) return "not_member";
  const rows = await tx.run("targetMember", [target]);
  if (rows.length === 0) return "not_member";
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    Object.keys(row).sort().join(",") !== "grant_count,grants,membership_id" ||
    !validateDefinition("core", "Id", row.membership_id)
  )
    throw new WorkContextUnavailable();
  const grants = decodeGrants(row.grants, row.grant_count);
  if (grants === "overflow") return "ineligible";
  const targetAuthority: WorkAuthority = Object.freeze({
    actor: Object.freeze({
      kind: "human" as const,
      principalId: target,
      organizationId: a.actor.organizationId,
      workspaceId: a.actor.workspaceId,
      membershipId: row.membership_id as string,
      installationId: null,
      mandateId: null,
    }),
    policyRevision: a.policyRevision,
    grants,
    databaseNowMs: a.databaseNowMs,
    resource: a.resource,
  });
  for (const key of workEligibility[role]) {
    const rule = workPermissions[key];
    const verb = typeof rule.verb === "string" ? rule.verb : rule.verb.own;
    const decision = await decideWork(targetAuthority, rule.capabilityId, verb, rule.fields);
    if (!decision.allowed) return "ineligible";
  }
  return "eligible";
}
