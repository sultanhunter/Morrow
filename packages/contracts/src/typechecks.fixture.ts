import type {
  CapabilityInput,
  CapabilityOutput,
  CurrentBilling_BillingAccount,
  CurrentBilling_TestEntitlementSeed,
  CurrentBillingDefinitionName,
  Current_Approval,
  Current_EventEnvelope,
  Current_KillSwitchControl,
  Current_Message,
  Current_Proposal,
  CurrentDefinitionName,
  EventPayloadOf,
  EventType,
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
// P01.T04a: billing v1.1 (ADR-0015). A Morrow-direct account is storeless.
const morrowAccount: CurrentBilling_BillingAccount = {
  schemaVersion: 2,
  id: "account",
  organizationId: "org",
  workspaceId: "workspace",
  route: "morrow_direct",
  mode: "test",
  installationId: null,
  storeId: null,
  currency: "USD",
  status: "active",
  revision: 1,
};
// @ts-expect-error a Morrow-direct account never names an installation
const morrowWithStore: CurrentBilling_BillingAccount = {
  ...morrowAccount,
  installationId: "installation",
  storeId: "store",
};
const seedMode: CurrentBilling_TestEntitlementSeed["mode"] = "test";
// @ts-expect-error a test entitlement seed is never live
const liveSeed: CurrentBilling_TestEntitlementSeed["mode"] = "live";
const billingName: CurrentBillingDefinitionName = "WorkspaceBillingRoute";
// @ts-expect-error core names are not billing definitions
const coreAsBilling: CurrentBillingDefinitionName = "Proposal";
void morrowAccount;
void morrowWithStore;
void seedMode;
void liveSeed;
void billingName;
void coreAsBilling;
// P01.T02c (ADR-0016): EventEnvelope@2 replaces the v1 envelope, and message parts are a closed union.
const actor = {
  kind: "human",
  principalId: "human",
  organizationId: "org",
  workspaceId: "workspace",
  membershipId: "membership",
  installationId: null,
  mandateId: null,
} as const;
const envelope: Current_EventEnvelope = {
  schemaVersion: 2,
  eventId: "event",
  eventType: "message.created",
  organizationId: "org",
  workspaceId: "workspace",
  storeId: null,
  aggregateType: "message",
  aggregateId: "message",
  aggregateRevision: 1,
  streamPosition: "pos_AbCdEfGhIjKlMnOp",
  correlationId: "correlation",
  causationId: null,
  actor,
  occurredAt: "2026-10-19T10:00:00Z",
  payload: null,
  payloadRef: null,
};
const v1EnvelopeValue = {
  schemaVersion: 1,
  eventId: "event",
  eventType: "task.created",
  organizationId: "org",
  workspaceId: "workspace",
  storeId: null,
  aggregateType: "task",
  aggregateId: "task",
  aggregateRevision: 1,
  streamPosition: "1",
  correlationId: "correlation",
  causationId: null,
  actor,
  occurredAt: "2026-10-19T10:00:00Z",
  payloadRef: { ...proposalRef, kind: "artifact" },
} as const;
// @ts-expect-error a v1 envelope (schemaVersion 1, ArtifactRef payloadRef, no payload) is not EventEnvelope@2
const v1Envelope: Current_EventEnvelope = v1EnvelopeValue;
type PartKind = Current_Message["parts"][number]["kind"];
type SixKinds = "text" | "artifact" | "proposal" | "question" | "evidence_summary" | "mention";
const partKinds: [PartKind] extends [SixKinds]
  ? [SixKinds] extends [PartKind]
    ? true
    : false
  : false = true;
// @ts-expect-error there is no image part
const imageKind: PartKind = "image";
const created: EventPayloadOf<"message.created"> = {
  conversationId: "conversation",
  status: "completed",
  authorKind: "human",
};
// @ts-expect-error message text never enters an event payload
const withText: EventPayloadOf<"message.created"> = { ...created, text: "Hello" };
// @ts-expect-error unregistered event types are not EventTypes
const deleted: EventType = "message.deleted";
const emptyPayload: EventPayloadOf<"project.revised"> = {};
// @ts-expect-error an empty payload carries no fields
const nonEmptyPayload: EventPayloadOf<"project.revised"> = { goalId: "goal" };
void envelope;
void v1Envelope;
void partKinds;
void imageKind;
void created;
void withText;
void deleted;
void emptyPayload;
void nonEmptyPayload;
