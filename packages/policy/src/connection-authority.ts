// The connection kernel (M2 PR-2; P09.T02a; ADR-0022 item 5; ADR-0011 Q5): the human
// kernel's decision on governance.connection.connect administer for the workspace
// resource, with the connect input fields, from the linking login's server facts. The api
// composes it into the identity issuer and the connections read (the identity package
// never imports the policy package). The SQL issuer rechecks the picked grant under
// locks, so this is the extra in-code check, never the only one.
import type { Core_ActorRef, Current_Grant, Current_ResourceRef } from "@morrow/contracts";
import { createHumanPolicyService, isCurrentGrant } from "./index";

/** The facts the linking login's linking_actor_authority returns (identity's shape). */
export interface ConnectionAuthorityFacts {
  readonly principalId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly policyRevision: number;
  readonly grants: readonly unknown[];
  readonly databaseNowMs: number;
}
export interface ConnectionAuthorityDecision {
  readonly allowed: boolean;
  readonly grantId: string | null;
}
export const connectRequestFields = Object.freeze(["installationProof", "providerId", "scope"]);
const capabilityId = "governance.connection.connect";

/** One decision per call; any input or kernel failure is a denial. */
export function createConnectionKernel(): (
  facts: Readonly<ConnectionAuthorityFacts>,
) => Promise<ConnectionAuthorityDecision> {
  const denied = Object.freeze({ allowed: false, grantId: null });
  return async (facts) => {
    try {
      const actor: Core_ActorRef = {
        kind: "human",
        principalId: facts.principalId,
        organizationId: facts.organizationId,
        workspaceId: facts.workspaceId,
        membershipId: facts.membershipId,
        installationId: null,
        mandateId: null,
      };
      const resource: Current_ResourceRef = {
        organizationId: facts.organizationId,
        workspaceId: facts.workspaceId,
        storeId: null,
        connectionId: null,
        kind: "workspace",
        id: facts.workspaceId,
      };
      const at = new Date(facts.databaseNowMs);
      const result = await createHumanPolicyService(
        {
          readCurrent: async () => ({
            actor,
            policyRevision: facts.policyRevision,
            grantsRevision: facts.policyRevision,
            // linking_actor_authority returns a row only for a current session of an
            // active principal, organization, workspace and membership.
            principalActive: true,
            organizationActive: true,
            workspaceActive: true,
            membershipActive: true,
            sessionCurrent: true,
            resource,
            accountId: null,
            providerAllowed: true,
            // Linking is not paid work (P01.T04a AC08); the kernel never reads this here.
            entitlementAllowed: false,
            grants: facts.grants as Current_Grant[],
          }),
        },
        () => at,
      ).decide({
        capabilityId,
        verb: "administer",
        resource,
        accountId: null,
        fields: [...connectRequestFields],
      });
      if (!result.decision.allowed) return denied;
      // The grant the decision rests on: the first by id that is current for this actor,
      // names the workspace resource with no store or account, and every connect field.
      const grant = (facts.grants as Current_Grant[])
        .filter(
          (g) =>
            isCurrentGrant(
              g,
              actor,
              capabilityId,
              "administer",
              facts.policyRevision,
              at.getTime(),
            ) &&
            g.scope.organizationId === facts.organizationId &&
            g.scope.workspaceId === facts.workspaceId &&
            g.scope.storeIds.length === 0 &&
            g.scope.accountIds.length === 0 &&
            g.scope.resources.some(
              (r) =>
                r.kind === "workspace" &&
                r.id === facts.workspaceId &&
                r.organizationId === facts.organizationId &&
                r.workspaceId === facts.workspaceId &&
                r.storeId === null &&
                r.connectionId === null,
            ) &&
            connectRequestFields.every((f) => g.scope.fields.includes(f)),
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
      return grant ? Object.freeze({ allowed: true, grantId: grant.id }) : denied;
    } catch {
      return denied;
    }
  };
}
