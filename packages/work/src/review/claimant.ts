import type { CapabilityId } from "@morrow/contracts";
import { createHumanPolicyService, type HumanAuthority } from "@morrow/policy";
import {
  entitlementFor,
  parseWorkspaceBillingFacts,
  workspaceBillingState,
} from "@morrow/policy/billing-state";
import type { StoreResource } from "@morrow/policy/store-resource";
import { createBillingFactsReader } from "../billing/facts.js";
import type { WorkTx } from "../connection.js";
import type { WorkAuthority } from "../context.js";

// The claimant's own authority to apply (v1 PR 3; ADR-0022 items 3 and 9; ADR-0011: an
// approval confers no authority). Applying a store change is `execute` on
// catalog.content.publish (external_write, so paid work, P01.T04a §1) on the store resource
// {kind: "store", id: S, storeId: S, connectionId: C} with the target fields, for the
// signed-in person, in their own session, with the workspace's entitlement. It is decided at
// the claim and again before each product's dispatch, so revoking a grant or losing the plan
// between products stops the rest.
//
// `entitlementAllowed` comes only from entitlementFor over the workspace's billing facts (the
// M5 reader, the staging operator entitlement included), the createLeaseDelegationReader
// pattern; this function is on boundary-checks' entitlement-writer allowlist for that reason.
// The kernel still reads it only for paid work.

export type ClaimantDecision = "allowed" | "denied" | "not_entitled";

export async function claimantMayApply(
  tx: WorkTx,
  a: WorkAuthority,
  store: StoreResource,
  fields: readonly string[],
  environment: "development" | "staging" | "production",
): Promise<ClaimantDecision> {
  const scope = { organizationId: a.actor.organizationId, workspaceId: a.resource.workspaceId };
  if (
    store.organizationId !== scope.organizationId ||
    store.workspaceId !== scope.workspaceId ||
    fields.length < 1
  )
    return "denied";
  const billing = await createBillingFactsReader((name, values) => tx.run(name, values)).read(
    scope,
  );
  const at = new Date(a.databaseNowMs).toISOString();
  const state = workspaceBillingState(
    parseWorkspaceBillingFacts(billing.facts, scope, environment),
    at,
    environment,
  );
  const request = {
    capabilityId: "catalog.content.publish" as CapabilityId,
    verb: "execute" as const,
    resource: store,
    accountId: null,
    fields: [...fields],
  };
  const authority: HumanAuthority = {
    actor: a.actor,
    policyRevision: a.policyRevision,
    grantsRevision: a.policyRevision,
    principalActive: true,
    organizationActive: true,
    workspaceActive: true,
    membershipActive: true,
    sessionCurrent: true,
    resource: store,
    accountId: null,
    providerAllowed: true,
    entitlementAllowed: entitlementFor(state, request, at),
    grants: a.grants,
  };
  const service = createHumanPolicyService(
    { readCurrent: async () => authority },
    () => new Date(a.databaseNowMs),
  );
  const result = await service.decide(request);
  if (result.decision.allowed) {
    // The kernel's obligations for an external write: recheck at dispatch, the exact approval
    // and the provider effect's verification. This gateway meets exactly these three (the
    // dispatch check, approval_claim and the read-back); any other obligation denies.
    const met = ["recheck_at_dispatch", "exact_approval", "provider_effect_verification"];
    return result.obligations.every((o) => met.includes(o)) ? "allowed" : "denied";
  }
  return result.decision.reason === "entitlement_denied" ? "not_entitled" : "denied";
}
