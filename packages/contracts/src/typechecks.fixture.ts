import type {
  CapabilityInput,
  CapabilityOutput,
  Current_KillSwitchControl,
  CurrentDefinitionName,
} from "./generated/domain";
const goodInput: CapabilityInput<"workspace.goal.create"> = {
  objective: "Investigate",
  storeIds: ["demo"],
  successCriteria: [
    { description: "Evidence", verificationCapabilityId: null, evidenceRequired: true },
  ],
};
const badInput: CapabilityInput<"workspace.goal.create"> = {
  // @ts-expect-error objective has a static string type
  objective: 12,
  storeIds: [],
  successCriteria: [],
};
// @ts-expect-error required revision cannot disappear
const badOutput: CapabilityOutput<"workspace.goal.create"> = { goalId: "goal" };
// @ts-expect-error unknown capability is not callable
export type BadCapability = CapabilityInput<"invented.capability">;
const proposalRef = {
  organizationId: "org",
  workspaceId: "workspace",
  storeId: null,
  kind: "proposal",
  id: "proposal",
  revision: 1,
  digest: "a".repeat(64),
} as const;
// v1.1 replaces the reviewed v1 pause body with named campaigns and a recorded reason.
const control: Current_KillSwitchControl = { reason: "Overspend", sourceProposalRef: null };
const pause: CapabilityInput<"ads.campaign.pause"> = {
  campaigns: [
    {
      organizationId: "org",
      workspaceId: "workspace",
      storeId: "store",
      connectionId: "connection",
      kind: "campaign",
      id: "campaign",
    },
  ],
  control,
};
const v1Pause: CapabilityInput<"ads.campaign.pause"> = {
  // @ts-expect-error the v1 proposalRef/approvalRef pause body is replaced in v1.1
  proposalRef,
  approvalRef: { ...proposalRef, kind: "approval" },
};
const revoke: CapabilityInput<"governance.membership.revoke"> = {
  membershipId: "membership",
  // @ts-expect-error a stop has no expectedRevision in v1.1
  expectedRevision: 1,
  control,
};
const currentName: CurrentDefinitionName = "KillSwitchRecord";
// @ts-expect-error capability bodies are not current definitions
const bodyName: CurrentDefinitionName = "ads.campaign.pause.input";
void goodInput;
void badInput;
void badOutput;
void pause;
void v1Pause;
void revoke;
void currentName;
void bodyName;
