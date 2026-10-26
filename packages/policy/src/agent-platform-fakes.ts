// Fakes of the agent-platform contracts (PR 10; ADR-0037 PR 2 for teammates, result items and
// agent cards; plan row H5 for ADR-0041's merged teammate contracts and tool catalogue version
// 4's orchestration, memory and harness inputs), so the agent loop, teammate calls, the
// agent-card packet and the Sunrise screens build against them before any backend exists. Plain data only: type
// imports, no validator table, no I/O, clock or randomness, so a browser fixture may use it.
// tests/agent-platform-contracts.test.mjs validates every fake against its contract, so a
// fake cannot drift from the schema. Every id is synthetic; no real shop, person or address.
import type {
  CurrentBilling_RateCard,
  Current_AddToTeamDocument,
  Current_AgentPackage,
  Current_AgentProposal,
  Current_SkillManifest,
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
  Current_ResultItem,
  Current_ResultItemPage,
  Current_RunTaint,
  Current_RunToolCall,
  Current_RunTurn,
  Current_SenderIdentity,
  Current_SupportReplyParameters,
  Current_TeammateBrief,
  Current_TeammateBriefInput,
  Current_TeammateResult,
  Current_ToolInputAgentAsk,
  Current_ToolInputAgentCancel,
  Current_ToolInputAgentMap,
  Current_ToolInputAgentMessage,
  Current_ToolInputAgentPropose,
  Current_ToolInputContextCheckpoint,
  Current_ToolInputMemoryRead,
  Current_ToolInputMemorySearch,
  Current_ToolInputMemorySuggest,
  Current_ToolInputResultWrite,
  Current_ToolInputRunComplete,
  Current_ToolInputRunPlan,
  Current_ToolInputRunWait,
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
  inventoryInstallationId: "inst_inventory",
  cardId: "card_fake_1",
  callId: "call_fake_1",
  messageId: "message_fake_1",
  callRunId: "run_call_fake_1",
  callTaskId: "task_call_fake_1",
  toolUseId: "toolu_ask_fake_1",
  itemId: "item_fake_1",
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
/**
 * Each agent's profile at the proposed version 2 defaults, as Settings lists them: Morrow on
 * Opus 5.5 at high, every other kind on Opus 5.5 at medium (ADR-0036), the default for new
 * teammates included (ADR-0037 item 4).
 */
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
      target: { kind: "teammate_default" },
      profile: { model: "claude_opus_5_5", effort: "medium", catalogueVersion: 2 },
    },
    {
      target: { kind: "installation", installationId: fakeIds.listingsInstallationId },
      profile: { model: "claude_opus_5_5", effort: "medium", catalogueVersion: 2 },
    },
    {
      target: { kind: "installation", installationId: fakeIds.supportInstallationId },
      profile: { model: "claude_opus_5_5", effort: "medium", catalogueVersion: 2 },
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
    from: { model: "claude_opus_5_5", effort: "medium" },
    to: { model: "claude_sonnet_5_5", effort: "low" },
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

// --- Teammates (ADR-0037 item 3(a); ADR-0041 items 19 to 24) -------------------------------
/** A tainted run's taint: it read product text, and the result keeps the kind and the source. */
export function fakeTaint(): Current_RunTaint {
  return freeze({
    contextTaint: "untrusted_external",
    kinds: ["product"],
    sources: [{ source: "product", sourceId: "product:1001" }],
    omittedSources: 0,
  });
}
/** An untainted run's taint. */
export function fakeCleanTaint(): Current_RunTaint {
  return freeze({ contextTaint: "none", kinds: [], sources: [], omittedSources: 0 });
}
/** Morrow's structured brief to Listings as it writes it: no character cap, records by id. */
export function fakeTeammateBriefInput(): Current_TeammateBriefInput {
  return freeze({
    objective: "Check the SEO titles and descriptions of the summer collection.",
    details: "The person wants titles under 70 characters in the brand voice.",
    doneCriteria: [
      "Every product in the collection has been checked.",
      "Every title over 70 characters has a proposal waiting for review.",
    ],
    boundaries: ["Do not change prices or stock."],
    records: [
      { kind: "task", id: fakeIds.taskId },
      { kind: "product", id: "product:1001" },
    ],
    outputFormat: {
      findingKinds: ["metric", "table"],
      tableColumns: ["Product", "Proposed title"],
      itemsExpected: false,
      summaryDepth: "standard",
    },
    approach: ["Read the brand voice page first.", "Check every product, not a sample."],
  });
}
/** The brief Listings receives: the input, the requester's own words (filled by code), ask mode. */
export function fakeTeammateBrief(): Current_TeammateBrief {
  return freeze({
    ...structuredClone(fakeTeammateBriefInput()),
    request: {
      messageId: fakeIds.messageId,
      text: "Can you fix the SEO titles on the summer dresses? Keep them short.",
      readTags: [{ storeId: null, capability: "workspace.knowledge.read" }],
    },
    mode: "ask",
    followUpOf: null,
  });
}
/** agent.ask as Morrow writes it: a fresh call to Listings. */
export function fakeAgentAskInput(): Current_ToolInputAgentAsk {
  return freeze({
    installationId: fakeIds.listingsInstallationId,
    mode: "ask",
    followUpOf: null,
    brief: structuredClone(fakeTeammateBriefInput()),
  });
}
/** agent.map over three products, one per batch. */
export function fakeAgentMapInput(): Current_ToolInputAgentMap {
  return freeze({
    installationId: fakeIds.listingsInstallationId,
    briefTemplate: { ...structuredClone(fakeTeammateBriefInput()), records: [] },
    source: {
      records: [
        { kind: "product", id: "product:1001" },
        { kind: "product", id: "product:1002" },
        { kind: "product", id: "product:1003" },
      ],
      itemId: null,
    },
    batchSize: 1,
  });
}
export function fakeAgentMessageInput(): Current_ToolInputAgentMessage {
  return freeze({ callId: fakeIds.callId, text: "Focus on the linen dresses first." });
}
export function fakeAgentCancelInput(): Current_ToolInputAgentCancel {
  return freeze({ callId: fakeIds.callId });
}
/** What Listings returns with run.complete's child form at the end of the call. */
export function fakeRunCompleteChild(): Current_ToolInputRunComplete {
  return freeze({
    outcome: "done",
    criteria: [
      { index: 0, status: "met", evidence: [{ kind: "product", id: "product:1001" }] },
      { index: 1, status: "met", evidence: [{ kind: "proposal", id: "proposal_fake_1" }] },
    ],
    reply: null,
    result: {
      summary: "Four of twelve products have SEO titles over 70 characters; proposals are ready.",
      counts: { checked: 12, missing: 4, questions: 0 },
      nextSteps: ["fill_fact"],
      findings: [
        {
          kind: "metric",
          title: "Titles over 70 characters",
          detail: "",
          records: [{ kind: "product", id: "product:1001" }],
          value: 4,
          unit: "products",
          table: null,
        },
        {
          kind: "table",
          title: "Proposed titles",
          detail: "Each proposal waits for a person's approval.",
          records: [],
          value: null,
          unit: null,
          table: {
            columns: ["Product", "Proposed title"],
            rows: [["product:1001", "Linen summer dress"]],
          },
        },
      ],
      needs: null,
      items: [],
      verdicts: [],
    },
  });
}
/** The TeammateResult@1 that child form becomes: everything inline (it fits). */
export function fakeTeammateResult(): Current_TeammateResult {
  const child = fakeRunCompleteChild();
  const result = child.result!;
  return freeze({
    schemaVersion: 1,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    parentRunId: fakeIds.runId,
    toolUseId: fakeIds.toolUseId,
    callId: fakeIds.callId,
    sequence: 1,
    mode: "ask",
    runId: fakeIds.callRunId,
    taskId: fakeIds.callTaskId,
    installationId: fakeIds.listingsInstallationId,
    outcome: "done",
    endReason: "completed",
    counts: { ...result.counts },
    nextSteps: [...result.nextSteps],
    created: { kind: "list", records: [{ kind: "proposal", id: "proposal_fake_1" }] },
    criteria: child.criteria.map((c) => ({
      index: c.index,
      status: c.status,
      evidence: { kind: "list" as const, refs: c.evidence.map((r) => ({ ...r })) },
    })),
    verdicts: [],
    next: "none",
    needs: null,
    unresolved: { kind: "list", subjects: [] },
    plan: { itemsDone: 3, itemsTotal: 3 },
    verification: { codeChecksPassed: 2, codeChecksFailed: 0, verifierVerdict: "not_run" },
    checkpointId: null,
    summary: { kind: "text", text: result.summary },
    findings: result.findings.map((f) => ({
      kind: f.kind,
      title: f.title,
      detail: { kind: "text" as const, text: f.detail },
      records: f.records.map((r) => ({ ...r })),
      value: f.value,
      unit: f.unit,
      table:
        f.table === null
          ? null
          : {
              kind: "table" as const,
              columns: [...f.table.columns],
              rows: f.table.rows.map((r) => [...r]),
            },
    })),
    items: [],
    readTags: [
      { storeId: fakeIds.storeId, capability: "catalog.products.read" },
      { storeId: null, capability: "workspace.knowledge.read" },
    ],
    taint: fakeTaint(),
    completedAt: later(3),
  });
}
/** A stored result item: a long summary from the call above, on its run's clock. */
export function fakeResultItem(): Current_ResultItem {
  return freeze({
    schemaVersion: 1,
    itemId: fakeIds.itemId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    runId: fakeIds.callRunId,
    kind: "text",
    mediaType: "text/plain",
    title: "Summary",
    sizeBytes: 9000,
    pageCount: 2,
    open: false,
    sections: 1,
    contentDigest: fakeDigest("item content"),
    readTags: [{ storeId: fakeIds.storeId, capability: "catalog.products.read" }],
    taint: fakeTaint(),
    createdAt: later(2),
    expiresAt: null,
  });
}
/** The first page of that item, as memory.read returns it. */
export function fakeResultItemPage(): Current_ResultItemPage {
  return freeze({
    schemaVersion: 1,
    itemId: fakeIds.itemId,
    kind: "text",
    title: "Summary",
    page: 1,
    pageCount: 2,
    content: { kind: "text", text: "Four of twelve products have SEO titles over 70 characters." },
  });
}

// --- Memory and harness tool inputs (ADR-0041 item 24) -------------------------------------
export function fakeMemorySearchInput(): Current_ToolInputMemorySearch {
  return freeze({
    queries: ["brand voice for titles", "summer collection"],
    layers: ["knowledge", "results"],
    limit: 10,
  });
}
/** memory.read of a teammate's full result, its latest sequence. */
export function fakeMemoryReadInput(): Current_ToolInputMemoryRead {
  return freeze({
    target: {
      kind: "teammate_result",
      id: fakeIds.callId,
      label: null,
      sequence: null,
      fromPosition: null,
      toPosition: null,
    },
    page: 1,
  });
}
export function fakeMemorySuggestInput(): Current_ToolInputMemorySuggest {
  return freeze({
    kind: "preference",
    title: "Short product titles",
    text: "Keep product titles under 70 characters.",
  });
}
/** Morrow's plan for the SEO job, set in its first turn. */
export function fakeRunPlanInput(): Current_ToolInputRunPlan {
  return freeze({
    action: "set",
    plan: {
      objective: "Shorter SEO titles for the summer collection, ready for review.",
      criteria: [
        { text: "Every product in the collection has been checked.", check: "child_outcome" },
        { text: "Every long title has a proposal waiting for review.", check: "proposal_state" },
      ],
      phases: [
        {
          title: "Check and propose",
          items: [
            {
              itemKey: "check",
              title: "Ask Listings to check the titles",
              criteria: [0],
              dependsOn: [],
            },
            {
              itemKey: "review",
              title: "Review the proposals",
              criteria: [1],
              dependsOn: ["check"],
            },
          ],
        },
      ],
      followThrough: [],
      understood: "You want shorter SEO titles on the summer dresses, in the brand voice.",
      steps: ["Check every title", "Draft shorter ones", "Send them for your review"],
    },
    changes: null,
  });
}
/** Morrow finishing that job with its reply. */
export function fakeRunCompleteInput(): Current_ToolInputRunComplete {
  return freeze({
    outcome: "done",
    criteria: [
      { index: 0, status: "met", evidence: [{ kind: "task", id: fakeIds.callTaskId }] },
      { index: 1, status: "met", evidence: [{ kind: "proposal", id: "proposal_fake_1" }] },
    ],
    reply: "Four titles were too long. Shorter ones are waiting for your review.",
    result: null,
  });
}
export function fakeRunWaitInput(): Current_ToolInputRunWait {
  return freeze({
    kind: "children",
    match: "all",
    callIds: null,
    proposalIds: null,
    until: null,
  });
}
/** A called teammate starting a table item it will fill across turns. */
export function fakeResultWriteInput(): Current_ToolInputResultWrite {
  return freeze({
    itemId: null,
    title: "Proposed titles",
    kind: "table",
    mediaType: "text/csv",
    columns: ["Product", "Proposed title"],
    text: null,
    rows: [["product:1001", "Linen summer dress"]],
    close: false,
  });
}
/** The fallback strategy's hand-off, citing labels instead of restating approvals. */
export function fakeContextCheckpointInput(): Current_ToolInputContextCheckpoint {
  return freeze({
    objective: { text: "Shorter SEO titles for the summer collection.", refs: ["m1"] },
    status: "waiting",
    statusNote: "Listings is checking the titles.",
    done: [{ text: "Plan set and Listings asked.", refs: ["c2", "c3"] }],
    inProgress: [{ text: "Listings' check of twelve products.", refs: ["c3"] }],
    decisions: [
      { decision: "Check every product.", reason: "The person asked for all.", refs: ["m1"] },
    ],
    setAside: [],
    facts: [{ fact: "product:1001 has a 92-character title.", exact: true, refs: ["c4"] }],
    difficulties: [],
    promised: [],
    nextSteps: [{ text: "Review the proposals when the result arrives.", refs: [] }],
    reopen: [{ ref: "c4", why: "The exact title lengths." }],
  });
}

// --- Agent cards (ADR-0037 items 4 and 5) ------------------------------------------------
/** What Morrow writes with agent.propose for a new teammate. */
export function fakeAgentProposeInput(): Current_ToolInputAgentPropose {
  return freeze({
    name: "Restock Watch",
    purpose: "Watch stock levels and suggest restocks before products sell out.",
    instructions:
      "You watch stock for this shop. When a product will run out within two weeks, suggest a restock with the numbers that show why.",
    skillTexts: [
      {
        title: "Reading sell-through",
        body: "Compare the last 30 days of units sold with stock on hand.",
      },
    ],
    skillIds: [],
    tools: ["knowledge.search", "inventory.read", "orders.summary", "suggestion.create"],
    triggerKinds: ["schedule"],
  });
}
/** The server facts a card is drafted with: the owner's request, an untainted run. */
export function fakeCardFacts() {
  return freeze({
    cardId: fakeIds.cardId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    storeId: fakeIds.storeId,
    connectionId: fakeIds.connectionId,
    runId: fakeIds.runId,
    requester: fakeOwner(),
    skills: [
      {
        id: "seo-audit",
        digest: fakeDigest("seo-audit skill"),
        eligibleForWorkspaceAgents: true,
        tools: ["knowledge.search", "products.read", "report.write", "proposal.listing"],
      },
    ],
    runLimits: {
      maxTurns: 12,
      maxToolCallsPerTurn: 4,
      maxToolCallsPerRun: 40,
      maxQuestions: 2,
      wallTimeSeconds: 1800,
    },
    modelProfile: { model: "claude_opus_5_5", effort: "medium", catalogueVersion: 2 },
    taint: fakeCleanTaint(),
    at,
  });
}
/** The card code drafts from them: grants, scopes and the Owner-only kind derived in code. */
export function fakeAgentProposal(): Current_AgentProposal {
  const input = fakeAgentProposeInput();
  const facts = fakeCardFacts();
  return freeze({
    schemaVersion: 1,
    cardId: fakeIds.cardId,
    revision: 1,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    storeId: fakeIds.storeId,
    connectionId: fakeIds.connectionId,
    origin: "workspace",
    draftedBy: { runId: fakeIds.runId, requester: fakeOwner() },
    editedBy: null,
    name: input.name,
    purpose: input.purpose,
    instructions: input.instructions,
    skillTexts: input.skillTexts.map((s) => ({ ...s })),
    skills: [],
    tools: ["knowledge.search", "inventory.read", "orders.summary", "suggestion.create"],
    capabilities: [
      { capabilityId: "inventory.levels.read", verbs: ["view"] },
      { capabilityId: "orders.read", verbs: ["view"] },
      { capabilityId: "workspace.comment.create", verbs: ["execute"] },
      { capabilityId: "workspace.knowledge.read", verbs: ["view"] },
    ],
    optionalScopes: ["read_orders"],
    dataClasses: ["inventory.levels.read", "orders.read", "workspace.knowledge.read"],
    customerData: "level1",
    computer: false,
    triggerKinds: ["schedule"],
    runLimits: { ...facts.runLimits },
    modelProfile: { ...facts.modelProfile },
    ownerOnly: ["orders_or_customer"],
    taint: fakeCleanTaint(),
    draftedAt: at,
    revisedAt: at,
  });
}
/**
 * The Add to team document for that card: the owner, a standalone session, 5 minutes. Its
 * cardDigest is a placeholder (addToTeamDocument computes the card's own digest, a hash this
 * module avoids).
 */
export function fakeAddToTeamDocument(): Current_AddToTeamDocument {
  const card = fakeAgentProposal();
  return freeze({
    schemaVersion: 1,
    documentId: fakeIds.documentId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    actor: fakeOwner(),
    sessionDigest: fakeDigest("session"),
    host: "standalone",
    cardId: card.cardId,
    cardRevision: card.revision,
    cardDigest: fakeDigest("card"),
    storeId: card.storeId,
    tools: [...card.tools],
    capabilities: card.capabilities.map((c) => ({ ...c, verbs: [...c.verbs] })),
    optionalScopes: [...card.optionalScopes],
    dataClasses: [...card.dataClasses],
    customerData: card.customerData,
    triggerKinds: [...card.triggerKinds],
    runLimits: { ...card.runLimits },
    modelProfile: { ...card.modelProfile },
    ownerOnly: [...card.ownerOnly],
    taint: fakeCleanTaint(),
    review: "solo_owner_phrase",
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
/**
 * A manifest of each run kind, at the version 2 defaults. Morrow's shows its version 4 launch
 * tools with both team switches on; every kind's list ends with its context's memory and
 * harness tools (ADR-0041 item 24); a called teammate's run is a routed run (ADR-0037 item 2).
 */
export function fakeAgentRunManifest(kind: Current_AgentRunKind): Current_AgentRunManifest {
  const base = {
    schemaVersion: 1 as const,
    workflow: "agent-run@1" as const,
    runId: fakeIds.runId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    taskId: fakeIds.taskId,
    systemTextDigest: fakeDigest("system text"),
    toolCatalogueVersion: 4,
    toolCatalogueDigest: fakeDigest("tool catalogue"),
    admittedAt: at,
  };
  const caps = (turns: number, holdUsd: string) => ({
    maxTurns: turns,
    maxToolCallsPerTurn: 4,
    maxToolCallsPerRun: 40,
    maxQuestions: 2,
    maxInputTokensPerTurn: 64000,
    // The kind's default effort (ADR-0036): high for Morrow, medium for every other kind.
    maxOutputTokensPerTurn: kind === "coordinator" ? 16000 : 12000,
    wallTimeSeconds: 1800,
    deadline: null,
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
          "agent.route",
          "agent.ask",
          "agent.map",
          "agent.message",
          "agent.cancel",
          "agent.propose",
          "memory.search",
          "memory.read",
          "run.plan",
          "run.complete",
          "run.wait",
          "context.checkpoint",
        ],
        modelProfile: { model: "claude_opus_5_5", effort: "high", catalogueVersion: 2 },
        caps: caps(6, "3.84000000"),
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
          "memory.search",
          "memory.read",
          ...(kind === "routed" ? (["memory.suggest"] as const) : []),
          "run.plan",
          "run.complete",
          "run.wait",
          "context.checkpoint",
        ],
        // The installed default, Opus 5.5 at medium: 12 turns and US$6.72 under US$7.
        modelProfile: { model: "claude_opus_5_5", effort: "medium", catalogueVersion: 2 },
        caps: caps(12, "6.72000000"),
        specDigest: null,
        dataClasses: null,
      });
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

// --- Agent packages and skills (ADR-0023 decisions 6 and 11d) ----------------------------
/** A first-party job skill's skill.json. */
export function fakeSkillManifest(): Current_SkillManifest {
  return freeze({
    schemaVersion: 1,
    id: "seo-audit",
    revision: 1,
    title: "SEO audit",
    summary: "Check product SEO titles and descriptions against the brand voice and propose fixes.",
    tools: ["knowledge.search", "products.read", "report.write", "proposal.listing"],
    dataClasses: ["catalog.products.read", "workspace.knowledge.read"],
    outputContracts: ["report@1"],
    eligibleForWorkspaceAgents: true,
    bodyDigest: fakeDigest("seo-audit SKILL.md"),
  });
}
/**
 * Listings as an AgentPackage@1 on the loop (origin first_party). It declares grant tools only:
 * every call of it is offered the call context's run.complete and result.write (ADR-0041 item
 * 24), so Morrow may call it. Its skill pin is a placeholder digest; a test re-pins it with
 * skillDigest (agent-package.ts), which needs a hash this module avoids.
 */
export function fakeListingsPackage(): Current_AgentPackage {
  return freeze({
    schemaVersion: 1,
    id: "morrow.listings",
    revision: 2,
    kind: "installed",
    origin: "first_party",
    title: "Listings",
    roleTextDigest: fakeDigest("listings role"),
    instructions: null,
    skillTexts: [],
    skills: [{ id: "seo-audit", digest: fakeDigest("seo-audit skill") }],
    tools: [
      "knowledge.search",
      "work.read",
      "products.read",
      "message.post",
      "inbox.ask",
      "suggestion.create",
      "report.write",
      "proposal.listing",
    ],
    capabilities: [
      { capabilityId: "workspace.knowledge.read", verbs: ["view"] },
      { capabilityId: "workspace.artifact.read", verbs: ["view"] },
      { capabilityId: "catalog.products.read", verbs: ["view"] },
      { capabilityId: "workspace.conversation.post", verbs: ["execute"] },
      { capabilityId: "workspace.question.request", verbs: ["execute"] },
      { capabilityId: "workspace.comment.create", verbs: ["execute"] },
      { capabilityId: "workspace.artifact.edit", verbs: ["execute"] },
      { capabilityId: "catalog.content.propose", verbs: ["execute"] },
      { capabilityId: "catalog.content.publish", verbs: ["propose"] },
    ],
    optionalScopes: ["write_files"],
    triggerKinds: ["schedule", "shopify_event", "look_for_work"],
    customerData: "none",
    computer: false,
    offeredProfiles: [
      { model: "claude_haiku_5_5", effort: "low" },
      { model: "claude_sonnet_5_5", effort: "low" },
      { model: "claude_sonnet_5_5", effort: "medium" },
      { model: "claude_opus_5_5", effort: "medium" },
    ],
    defaultProfile: { model: "claude_opus_5_5", effort: "medium" },
    evalDigest: fakeDigest("listings evals"),
  });
}

/**
 * The workspace package an approved card becomes (origin workspace). Its roleTextDigest is a
 * placeholder; a test re-pins it with the digest of its instructions and skill text.
 */
export function fakeWorkspacePackage(): Current_AgentPackage {
  const card = fakeAgentProposal();
  return freeze({
    schemaVersion: 1,
    id: "workspace.restock_watch",
    revision: 1,
    kind: "installed",
    origin: "workspace",
    title: card.name,
    roleTextDigest: fakeDigest("restock watch instructions"),
    instructions: card.instructions,
    skillTexts: card.skillTexts.map((s) => ({ ...s })),
    skills: [],
    tools: [...card.tools],
    capabilities: card.capabilities.map((c) => ({ ...c, verbs: [...c.verbs] })),
    optionalScopes: [...card.optionalScopes],
    triggerKinds: [...card.triggerKinds],
    customerData: card.customerData,
    computer: false,
    offeredProfiles: [{ model: "claude_opus_5_5", effort: "medium" }],
    defaultProfile: { model: "claude_opus_5_5", effort: "medium" },
    evalDigest: null,
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
      lookForWorkDailyUsd: { amount: "1.12", currency: "USD" },
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
