import type { Core_PolicyDecision } from "@morrow/contracts";
import {
  workPermissions,
  workVerb,
  type WorkCapabilityId,
  type WorkPermissionKey,
  type WorkVerb,
} from "@morrow/contracts/work-permissions";
import { createHumanPolicyService, type HumanAuthority } from "@morrow/policy";
import type { WorkAuthority } from "./context.js";

// Grant decisions are made only by the packages/policy kernel (ADR-0010 item 2),
// with the database clock of the request's own enter_context() snapshot. Work
// writes are internal and unbilled, so provider and entitlement are allowed
// (ADR-0006 limits only paid dispatch).
export async function decideWork(
  a: WorkAuthority,
  capabilityId: WorkCapabilityId,
  verb: WorkVerb,
  fields: readonly string[],
): Promise<Core_PolicyDecision> {
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
    entitlementAllowed: true,
    grants: a.grants,
  };
  const service = createHumanPolicyService(
    { readCurrent: async () => authority },
    () => new Date(a.databaseNowMs),
  );
  const result = await service.decide({
    capabilityId,
    verb,
    resource: a.resource,
    accountId: null,
    fields: [...fields],
  });
  return result.decision;
}

/** The §4.8 rule for an operation: ownership selects the verb, a grant is always required. */
export function authorizeWork(
  a: WorkAuthority,
  op: WorkPermissionKey,
  basis: "own" | "other" | "none",
): Promise<Core_PolicyDecision> {
  const verb = workVerb(op, basis);
  if (verb === null) return Promise.reject(Error("WORK_PERMISSION_BASIS_REQUIRED"));
  const rule = workPermissions[op];
  return decideWork(a, rule.capabilityId, verb, rule.fields);
}
