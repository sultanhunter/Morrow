import type {
  CapabilityInput,
  CapabilityOutput,
  Current_Approval,
  Current_KillSwitchControl,
  Current_Proposal,
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
// Proposal@2 (ADR-0011 Q6): credit ceilings are integer strings summed with BigInt.
const credits: Current_Proposal["maximumCredits"] = "20";
// @ts-expect-error a credit ceiling is never a number
const numericCredits: Current_Proposal["maximumCredits"] = 20;
// @ts-expect-error Proposal@2 replaces the v1 shape; schemaVersion 1 is not current
const v1Proposal: Current_Proposal["schemaVersion"] = 1;
// ADR-0018: the task is null only for a human-made governance proposal (checked at runtime).
const tasklessProposal: Current_Proposal["taskId"] = null;
// Approval@2 reviewers are human members only.
const agentReviewer: Current_Approval["reviewer"] = {
  // @ts-expect-error an agent cannot be an Approval@2 reviewer
  kind: "agent",
  principalId: "agent",
  organizationId: "org",
  workspaceId: "workspace",
  membershipId: "membership",
  installationId: null,
  mandateId: null,
};
const decide: CapabilityInput<"governance.approval.decide"> = {
  proposalRef,
  decision: {
    decision: "approve",
    selectedTargetIndexes: [0, 1],
    expectedDecisionDigest: "b".repeat(64),
    soloOwnerConfirmation: null,
    comment: null,
  },
  expectedRevision: 1,
};
const v1Decide: CapabilityInput<"governance.approval.decide"> = {
  proposalRef,
  // @ts-expect-error the v1 DecisionRef decision is replaced by a ReviewDecisionInput
  decision: { ...proposalRef, kind: "decision" },
  expectedRevision: 1,
};
const preview: CapabilityInput<"governance.approval.preview"> = {
  proposalRef,
  selectedTargetIndexes: null,
};
void currentName;
void bodyName;
void credits;
void numericCredits;
void v1Proposal;
void tasklessProposal;
void agentReviewer;
void decide;
void v1Decide;
void preview;
