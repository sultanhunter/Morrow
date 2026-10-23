// Fakes of the agent-platform contracts (PR 10), so the agent loop (PR 11) and the Sunrise
// screens (PRs 14 to 16) build against them before any backend exists. Plain data only: type
// imports, no validator table, no I/O, clock or randomness, so a browser fixture may use it.
// tests/agent-platform-contracts.test.mjs validates every fake against its contract, so a
// fake cannot drift from the schema. Every id is synthetic; no real shop, person or address.
import type {
  CurrentBilling_RateCard,
  Current_AgentRunKind,
  Current_AgentRunManifest,
  Current_AgentTriggerSet,
  Current_BatchConfirmationDocument,
  Current_HumanActorRef,
  Current_MandateActorRef,
  Current_MandateDocument,
  Current_MandateTrigger,
  Current_ModelProfile,
  Current_ModelProfileChange,
  Current_ModelProfileTarget,
  Current_ReportArtifact,
  Current_RunToolCall,
  Current_RunTurn,
  Current_SenderIdentity,
  Current_SpecialistBrief,
  Current_SpecialistSpec,
  Current_SpecialistStartDocument,
  Current_SupportReplyParameters,
} from "@morrow/contracts";

/** The synthetic ids every fake shares. */
export const fakeIds = Object.freeze({
  organizationId: "org_fake",
  workspaceId: "ws_fake",
  storeId: "store_fake",
  connectionId: "conn_fake",
  ownerPrincipalId: "principal_owner",
  ownerMembershipId: "membership_owner",
  memberPrincipalId: "principal_member",
  memberMembershipId: "membership_member",
  listingsInstallationId: "inst_listings",
  listingsPrincipalId: "principal_listings",
  supportInstallationId: "inst_support",
  specialistInstallationId: "inst_specialist_1",
  mandateId: "mandate_listings_1",
  triggerId: "trigger_weekly_sweep_1",
  taskId: "task_fake_1",
  childTaskId: "task_fake_child_1",
  runId: "run_fake_1",
  threadId: "thread_fake_1",
  senderIdentityId: "sender_morrow_1",
  documentId: "doc_fake_1",
});
const at = "2026-10-26T09:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
/** A fake SHA-256 hex digest, distinct per label. */
export const fakeDigest = (label: string): string => {
  let h = 0;
  for (const char of label) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return (h.toString(16).padStart(8, "0") + "0".repeat(56)).slice(0, 64);
};
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export function fakeOwner(): Current_HumanActorRef {
  return freeze({
    kind: "human",
    principalId: fakeIds.ownerPrincipalId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    membershipId: fakeIds.ownerMembershipId,
    installationId: null,
    mandateId: null,
  });
}
export function fakeMandateRequester(): Current_MandateActorRef {
  return freeze({
    kind: "installation",
    installationId: fakeIds.listingsInstallationId,
    mandateId: fakeIds.mandateId,
    principalId: fakeIds.listingsPrincipalId,
    ownerPrincipalId: fakeIds.ownerPrincipalId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
  });
}

// --- Model profiles (ADR-0027 item 12) ---------------------------------------------------
/** Each agent's profile at the proposed version 2 defaults, as Settings lists them. */
export function fakeModelProfiles(): readonly {
  readonly target: Current_ModelProfileTarget;
  readonly profile: Current_ModelProfile;
}[] {
  return freeze([
    {
      target: { kind: "coordinator" },
      profile: { model: "claude_opus_5_5", effort: "high", catalogueVersion: 2 },
    },
    {
      target: { kind: "specialist_default" },
      profile: { model: "claude_opus_5_5", effort: "medium", catalogueVersion: 2 },
    },
    {
      target: { kind: "installation", installationId: fakeIds.listingsInstallationId },
      profile: { model: "claude_sonnet_5_5", effort: "low", catalogueVersion: 2 },
    },
    {
      target: { kind: "installation", installationId: fakeIds.supportInstallationId },
      profile: { model: "claude_sonnet_5_5", effort: "low", catalogueVersion: 2 },
    },
  ]);
}
export function fakeModelProfileChange(): Current_ModelProfileChange {
  return freeze({
    schemaVersion: 1,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    actor: fakeOwner(),
    target: { kind: "installation", installationId: fakeIds.listingsInstallationId },
    from: { model: "claude_sonnet_5_5", effort: "low" },
    to: { model: "claude_opus_5_5", effort: "medium" },
    catalogueVersion: 2,
    revision: 2,
    at,
  });
}

// --- Sending addresses (ADR-0030 item 10) ------------------------------------------------
/** The workspace's list: the shop's Morrow address, active and the default. */
export function fakeSenderIdentities(): readonly Current_SenderIdentity[] {
  return freeze([
    {
      schemaVersion: 1,
      id: fakeIds.senderIdentityId,
      organizationId: fakeIds.organizationId,
      workspaceId: fakeIds.workspaceId,
      storeId: fakeIds.storeId,
      kind: "morrow_managed",
      address: "example-shop@replies.example.com",
      displayName: "Example Shop",
      status: "active",
      useScope: "workspace",
      isDefault: true,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    },
  ]);
}
export function fakeSupportReplyParameters(): Current_SupportReplyParameters {
  return freeze({
    schemaVersion: 1,
    threadId: fakeIds.threadId,
    senderIdentityId: fakeIds.senderIdentityId,
    from: { address: "example-shop@replies.example.com", displayName: "Example Shop" },
    to: "customer@example.net",
    bcc: "support@example.org",
    replyTo: "support@example.org",
    subject: "Re: Where is my order?",
    inReplyTo: "<message-1@example.net>",
    references: ["<message-1@example.net>"],
    body: "Hello, your order left our warehouse yesterday and should arrive within three days.",
    bodyDigest: fakeDigest("reply body"),
  });
}

// --- Specialists (ADR-0027 item 10, ADR-0028) --------------------------------------------
export function fakeSpecialistBrief(): Current_SpecialistBrief {
  return freeze({
    title: "Summer collection SEO check",
    objective: "Check the SEO titles and descriptions of the summer collection and propose fixes.",
    inputRefs: [{ kind: "task", id: fakeIds.taskId }],
    doneCriteria: ["Every product in the collection has an SEO title under 70 characters."],
    boundaries: ["Do not change prices or stock."],
    skillIds: ["seo-audit"],
    outputContractId: "report@1",
  });
}
export function fakeSpecialistSpec(): Current_SpecialistSpec {
  return freeze({
    schemaVersion: 1,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    storeId: fakeIds.storeId,
    connectionId: fakeIds.connectionId,
    parentTaskId: fakeIds.taskId,
    parentTaskRevision: 3,
    release: { id: "morrow.specialist", revision: 1, digest: fakeDigest("morrow.specialist@1") },
    brief: fakeSpecialistBrief(),
    tools: [
      "knowledge.search",
      "products.read",
      "message.post",
      "report.write",
      "proposal.listing",
    ],
    capabilities: [
      { capabilityId: "catalog.products.read", verbs: ["view"] },
      { capabilityId: "workspace.knowledge.read", verbs: ["view"] },
      { capabilityId: "workspace.conversation.post", verbs: ["execute"] },
      { capabilityId: "workspace.artifact.edit", verbs: ["execute"] },
      { capabilityId: "catalog.content.publish", verbs: ["propose"] },
    ],
    dataClasses: ["catalog.products.read", "workspace.knowledge.read"],
    modelProfile: { model: "claude_opus_5_5", effort: "medium", catalogueVersion: 2 },
    turnLimit: 12,
    creditCap: "15",
    runSeconds: 3600,
  });
}
export function fakeSpecialistStartDocument(): Current_SpecialistStartDocument {
  const spec = fakeSpecialistSpec();
  return freeze({
    schemaVersion: 1,
    documentId: fakeIds.documentId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    actor: fakeOwner(),
    sessionDigest: fakeDigest("session"),
    host: "standalone",
    specDigest: fakeDigest("spec"),
    parentTaskId: spec.parentTaskId,
    parentTaskRevision: spec.parentTaskRevision,
    release: spec.release,
    capabilities: spec.capabilities,
    dataClasses: spec.dataClasses,
    modelProfile: spec.modelProfile,
    turnLimit: spec.turnLimit,
    creditCap: spec.creditCap,
    runSeconds: spec.runSeconds,
    issuedAt: at,
    expiresAt: later(5),
  });
}
export function fakeReportArtifact(): Current_ReportArtifact {
  return freeze({
    schemaVersion: 1,
    contract: "report@1",
    title: "Summer collection SEO check",
    summary: "Four of twelve products have SEO titles over 70 characters; proposals are ready.",
    sections: [
      { heading: "What I checked", body: "The SEO title and description of twelve products." },
      { heading: "What I propose", body: "Shorter titles for four products, waiting for review." },
    ],
    readTags: [
      { storeId: fakeIds.storeId, capability: "catalog.products.read" },
      { storeId: null, capability: "workspace.knowledge.read" },
    ],
  });
}

// --- Agent runs (ADR-0027) ---------------------------------------------------------------
/** A manifest of each run kind, at the version 2 defaults. */
export function fakeAgentRunManifest(kind: Current_AgentRunKind): Current_AgentRunManifest {
  const base = {
    schemaVersion: 1 as const,
    workflow: "agent-run@1" as const,
    runId: fakeIds.runId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    taskId: fakeIds.taskId,
    systemTextDigest: fakeDigest("system text"),
    toolCatalogueVersion: 1,
    toolCatalogueDigest: fakeDigest("tool catalogue"),
    admittedAt: at,
  };
  const caps = (turns: number, holdUsd: string, deadline: string | null) => ({
    maxTurns: turns,
    maxToolCallsPerTurn: 4,
    maxToolCallsPerRun: 40,
    maxQuestions: 2,
    maxInputTokensPerTurn: 64000,
    maxOutputTokensPerTurn: kind === "coordinator" ? 16000 : kind === "specialist" ? 12000 : 5000,
    wallTimeSeconds: deadline === null ? 1800 : null,
    deadline,
    holdUsd,
  });
  switch (kind) {
    case "coordinator":
      return freeze({
        ...base,
        kind,
        storeId: fakeIds.storeId,
        connectionId: fakeIds.connectionId,
        installationId: null,
        mandateId: null,
        triggerId: null,
        requester: fakeOwner(),
        release: { id: "morrow.coordinator", revision: 1, digest: fakeDigest("coordinator") },
        tools: [
          "knowledge.search",
          "work.read",
          "message.post",
          "inbox.ask",
          "task.create",
          "agent.route",
          "specialist.draft",
        ],
        modelProfile: { model: "claude_opus_5_5", effort: "high", catalogueVersion: 2 },
        caps: caps(6, "3.84000000", null),
        specDigest: null,
        dataClasses: null,
      });
    case "routed":
    case "mandate":
      return freeze({
        ...base,
        kind,
        storeId: fakeIds.storeId,
        connectionId: fakeIds.connectionId,
        installationId: fakeIds.listingsInstallationId,
        mandateId: kind === "mandate" ? fakeIds.mandateId : null,
        triggerId: kind === "mandate" ? fakeIds.triggerId : null,
        requester: kind === "mandate" ? fakeMandateRequester() : fakeOwner(),
        release: { id: "morrow.listings", revision: 2, digest: fakeDigest("listings") },
        tools: [
          "knowledge.search",
          "work.read",
          "products.read",
          "message.post",
          "inbox.ask",
          "suggestion.create",
          "proposal.listing",
        ],
        modelProfile: { model: "claude_sonnet_5_5", effort: "low", catalogueVersion: 2 },
        caps: caps(16, "3.36000000", null),
        specDigest: null,
        dataClasses: null,
      });
    case "specialist": {
      const spec = fakeSpecialistSpec();
      return freeze({
        ...base,
        kind,
        storeId: fakeIds.storeId,
        connectionId: fakeIds.connectionId,
        taskId: fakeIds.childTaskId,
        installationId: fakeIds.specialistInstallationId,
        mandateId: null,
        triggerId: null,
        requester: fakeOwner(),
        release: spec.release,
        tools: spec.tools,
        modelProfile: spec.modelProfile,
        caps: caps(12, "3.05822500", later(60)),
        specDigest: fakeDigest("spec"),
        dataClasses: spec.dataClasses,
      });
    }
  }
}
/** One turn of a routed Listings run that called products.read. */
export function fakeRunTurn(): Current_RunTurn {
  return freeze({
    schemaVersion: 1,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    runId: fakeIds.runId,
    turn: 1,
    attempt: 1,
    input: {
      role: "user",
      content: [{ type: "text", text: "Improve the titles of my summer dresses." }],
    },
    output: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "", continuity: "c2lnbmF0dXJl", redacted: false },
        {
          type: "tool_use",
          id: "toolu_fake_1",
          name: "products.read",
          input: { productIds: null, titleContains: "dress", limit: 10 },
        },
      ],
    },
    outcome: "tool_use",
    prefixDigestBefore: null,
    prefixDigestAfter: fakeDigest("after turn 1"),
    usage: { inputTokens: 8000, cacheWriteTokens: 12000, cacheReadTokens: 0, outputTokens: 900 },
    readTags: [],
    createdAt: at,
    expiresAt: "2027-01-24T09:00:00.000Z",
  });
}
export function fakeRunToolCall(): Current_RunToolCall {
  return freeze({
    schemaVersion: 1,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    runId: fakeIds.runId,
    turn: 1,
    toolUseId: "toolu_fake_1",
    tool: "products.read",
    capabilityId: "catalog.products.read",
    verb: "view",
    replayClass: "read",
    inputDigest: fakeDigest("tool input"),
    outcome: "ok",
    refusal: null,
    resultDigest: fakeDigest("tool result"),
    resultBytes: 2048,
    record: null,
    startedAt: at,
    finishedAt: later(1),
    expiresAt: "2027-10-26T09:00:00.000Z",
  });
}

// --- Mandates and review rules (ADR-0024) ------------------------------------------------
export function fakeMandateDocument(): Current_MandateDocument {
  return freeze({
    schemaVersion: 1,
    documentId: fakeIds.documentId,
    purpose: "issue",
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    storeId: fakeIds.storeId,
    connectionId: fakeIds.connectionId,
    installationId: fakeIds.listingsInstallationId,
    actor: fakeOwner(),
    sessionDigest: fakeDigest("session"),
    host: "standalone",
    capabilities: [
      { capabilityId: "catalog.products.read", verbs: ["view"] },
      { capabilityId: "catalog.content.propose", verbs: ["execute"] },
      { capabilityId: "catalog.content.publish", verbs: ["propose"] },
    ],
    scope: {
      organizationId: fakeIds.organizationId,
      workspaceId: fakeIds.workspaceId,
      storeIds: [fakeIds.storeId],
      accountIds: [],
      resources: [
        {
          organizationId: fakeIds.organizationId,
          workspaceId: fakeIds.workspaceId,
          storeId: fakeIds.storeId,
          connectionId: fakeIds.connectionId,
          kind: "store",
          id: fakeIds.storeId,
        },
      ],
      fields: ["descriptionHtml", "seo.description", "seo.title", "tags", "title"],
    },
    triggerKinds: ["schedule", "shopify_event", "look_for_work"],
    quietHours: { timezone: "America/New_York", start: "22:00", end: "07:00" },
    caps: { dailyCredits: "20", monthlyCredits: "200" },
    depth: 0,
    startsAt: at,
    expiresAt: "2027-01-24T09:00:00.000Z",
    issuedAt: at,
    documentExpiresAt: later(5),
  });
}
export function fakeAgentTriggerSet(): Current_AgentTriggerSet {
  return freeze({
    schemaVersion: 1,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    installationId: fakeIds.listingsInstallationId,
    mandateId: fakeIds.mandateId,
    revision: 1,
    kinds: ["schedule", "shopify_event", "look_for_work"],
    quietHours: { timezone: "America/New_York", start: "22:00", end: "07:00" },
    updatedAt: at,
  });
}
export function fakeMandateTrigger(): Current_MandateTrigger {
  return freeze({
    schemaVersion: 1,
    id: fakeIds.triggerId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    storeId: fakeIds.storeId,
    installationId: fakeIds.listingsInstallationId,
    kind: "schedule",
    triggerKey: "schedule:weekly-sweep:2026-W44",
    status: "pending",
    dueAt: at,
    expiresAt: later(24 * 60),
  });
}
export function fakeBatchConfirmationDocument(): Current_BatchConfirmationDocument {
  return freeze({
    schemaVersion: 1,
    documentId: fakeIds.documentId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    storeId: fakeIds.storeId,
    actor: fakeOwner(),
    sessionDigest: fakeDigest("session"),
    capabilityId: "catalog.content.publish",
    proposals: [
      { proposalId: "proposal_fake_1", proposalDigest: fakeDigest("proposal 1") },
      { proposalId: "proposal_fake_2", proposalDigest: fakeDigest("proposal 2") },
    ],
    totals: { proposals: 2, credits: "0", amount: null },
    phrase: "approve 2 changes, 0 credits",
    issuedAt: at,
    expiresAt: later(5),
  });
}

// --- Rate card shape (ADR-0026 item 5) ---------------------------------------------------
/**
 * A synthetic rate card in RateCard@1's shape. Its numbers are placeholders, not a proposal:
 * rate card v1 publishes only with the owner's recorded confirmation.
 */
export function fakeRateCard(): CurrentBilling_RateCard {
  return freeze({
    schemaVersion: 1,
    version: 1,
    catalogueVersion: 2,
    modelRates: [
      {
        model: "claude_sonnet_5_5",
        effort: "low",
        creditsPerMillionTokens: { input: "4", cacheWrite: "5", cacheRead: "0.4", output: "20" },
        worstCaseTurnCredits: "1",
      },
    ],
    computerCreditsPerMinute: "0.5",
    emailSendCredits: "0",
    caps: {
      installationDailyCredits: "30",
      installationMonthlyCredits: "300",
      workspaceDailyCredits: "60",
      lookForWorkPassBasisPoints: 100,
      specialistRunBasisPoints: 500,
      specialistWorkspaceDailyBasisPoints: 2000,
    },
    backstops: {
      runUsd: { amount: "7", currency: "USD" },
      workspaceDailyUsd: { amount: "25", currency: "USD" },
    },
    margin: { maxVendorShareBasisPoints: 5000, feeBasisPoints: 1790 },
    free: [
      "reads",
      "monitors",
      "approvals",
      "gateway_apply",
      "exports",
      "deletion",
      "stops",
      "routine_revoke",
      "sync",
      "notifications",
    ],
  });
}
