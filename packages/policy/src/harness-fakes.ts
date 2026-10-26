// Fakes of the harness contracts (ADR-0041 and ADR-0040 item 5; harness contracts, H6), so the
// runner (H7b), the broker (H7c), the context engine (H7d), memory (H12) and the screens (H14,
// H15) build against them before any table exists. Plain data only: type imports, the generated
// context policy rows, no validator table, no I/O, clock or randomness, so a browser fixture may
// use them. tests/harness-contracts.test.mjs validates every fake against its contract, so a
// fake cannot drift from the schema. Every id is synthetic; no real shop, person or address.
//
// The story they share: the Owner asks Morrow, in their private Morrow conversation, to improve
// the titles of the summer dresses. Morrow's main thread forks a background job, which calls
// Listings once, proposes new titles for approval, has them reviewed, and waits to say when
// they are live.
import type {
  Current_AgentRunParams,
  Current_ContextCheckpoint,
  Current_ContextEpoch,
  Current_ContextLedger,
  Current_ContextOpeningSection,
  Current_ContextPolicy,
  Current_ContextSectionTokens,
  Current_ConversationSummary,
  Current_DerivedTaint,
  Current_JobState,
  Current_JobStatus,
  Current_MemorySearchHit,
  Current_ModelCallV2,
  Current_ModelResultV2,
  Current_NotebookEntryV2,
  Current_PersonMemory,
  Current_PersonMemorySuggestion,
  Current_ReadTag,
  Current_ReviewVerdict,
  Current_RunCompletion,
  Current_RunEvent,
  Current_RunPlan,
  Current_RunWait,
  Current_RunWaitCondition,
  Current_RunWaitKind,
} from "@morrow/contracts";
import { fakeDigest, fakeHarnessIds, fakeIds } from "./agent-platform-fakes";
import { contextPolicyRow } from "./context-policy";
import { joinTaint } from "./harness";

const at = "2026-10-26T09:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const days = (count: number) => later(count * 24 * 60);
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const ids = fakeHarnessIds;
/** The audience of everything derived from the Owner's private Morrow conversation. */
const ownerAudience = { kind: "principal" as const, principalId: fakeIds.ownerPrincipalId };
const productsTag: Current_ReadTag = {
  storeId: fakeIds.storeId,
  capability: "catalog.products.read",
};
const projectId = "project_fake_1";
/** Nothing untrusted behind the row: the requester's own words and SQL's records only. */
const untainted = (): Current_DerivedTaint => ({ kinds: [], sourceCount: 0 });
/** Listings' item i1: the titles it drafted from the 14 summer dresses it read. */
const itemTaint = (): Current_DerivedTaint => ({ kinds: ["product"], sourceCount: 14 });
/**
 * The fork's taint once it has read the products (c3), Listings' result (j1) and its item (i1),
 * joined without loss (ADR-0027 item 5, ADR-0041 item 34): every row derived from the fork (its
 * checkpoint, ledger and plan, and the review of its proposals) carries at least this.
 */
const forkTaint = (): Current_DerivedTaint =>
  joinTaint(
    { kinds: ["product"], sourceCount: 14 },
    { kinds: ["teammate_result"], sourceCount: 1 },
    { kinds: ["result_item"], sourceCount: 1 },
    itemTaint(),
  );

// --- Model calls (ModelCall@2 and ModelResult@2, ADR-0041 item 8) -------------------------
/** The run parameters of the fork's first segment: ids only. */
export function fakeAgentRunParams(): Current_AgentRunParams {
  return freeze({
    schemaVersion: 1,
    workflow: "agent-run@1",
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    runId: ids.forkRunId,
    segment: 1,
    incarnation: 1,
  });
}
/** The fork's first call: ids and digests only, never a message, model or limit. */
export function fakeModelCall(): Current_ModelCallV2 {
  return freeze({
    schemaVersion: 2,
    runId: ids.forkRunId,
    leaseGeneration: 1,
    contextId: ids.forkContextId,
    epoch: 1,
    throughSequence: 13,
    expectedPrefixDigest: fakeDigest("fork prefix through 12"),
    purpose: "turn",
    turn: 1,
    attempt: 1,
  });
}
/** The section tokens of one request (S1 to S5, ADR-0041 item 10). */
export function fakeSectionTokens(): Current_ContextSectionTokens {
  return freeze({ tools: 4200, system: 9800, workspace: 60, opening: 7400, conversation: 18200 });
}
/** The reply to fakeModelCall: one teammate call, mostly a cache read of the main thread. */
export function fakeModelResult(): Current_ModelResultV2 {
  return freeze({
    schemaVersion: 2,
    outcome: "tool_use",
    message: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "", continuity: "c2ln", redacted: false },
        {
          type: "tool_use",
          id: ids.toolUseId,
          name: "products.read",
          input: { productIds: null, titleContains: "dress", limit: 10 },
        },
      ],
    },
    usage: { inputTokens: 900, cacheWriteTokens: 1100, cacheReadTokens: 37660, outputTokens: 640 },
    prefixDigest: fakeDigest("fork prefix through 13"),
    traceRef: { kind: "model_call", id: "model_call_fake_1" },
    retryAfterMs: null,
    compacted: null,
    cleared: null,
    sectionTokens: fakeSectionTokens(),
  });
}

// --- Context (ADR-0041 items 10 to 14) ----------------------------------------------------
/** The proposed version 1 row for a model and effort, as a ContextPolicy@1 (no digest). */
export function fakeContextPolicy(effort: "high" | "medium" = "high"): Current_ContextPolicy {
  const row = contextPolicyRow(1, "claude_opus_5_5", effort);
  if (!row) throw Error("FAKE_CONTEXT_POLICY_MISSING");
  const { digest: _digest, ...policy } = structuredClone(row) as typeof row;
  return freeze(policy as Current_ContextPolicy);
}
const section = (label: string, tokens: number, items: number): Current_ContextOpeningSection => ({
  digest: fakeDigest(label),
  tokens,
  items,
});
/**
 * The fork's epochs: the first (initial: facts, the teammate list, pinned knowledge, one
 * person memory, the knowledge index, the ledger and the request) and the second, after one
 * compaction (the checkpoint, the plan's revision and a kept tail of five rows).
 */
export function fakeContextEpoch(kind: "initial" | "compaction" = "initial"): Current_ContextEpoch {
  const opening = {
    facts: section("opening facts", 600, 9),
    teammates: section("teammate list", 900, 3),
    pinnedKnowledge: [{ pageId: ids.pageId, version: 2, digest: fakeDigest("brand voice v2") }],
    personMemories: [{ memoryId: ids.personMemoryId, version: 1, digest: fakeDigest("memory v1") }],
    knowledgeIndex: section("knowledge index", 1400, 12),
    notebookIndex: null,
    conversationSummaries: [],
    ledger: section("ledger epoch " + (kind === "initial" ? 1 : 2), 2100, 7),
    checkpoint: null,
    plan: null,
    request: { kind: "message" as const, id: ids.messageId, digest: fakeDigest("request") },
  };
  return freeze(
    kind === "initial"
      ? {
          schemaVersion: 1,
          organizationId: fakeIds.organizationId,
          workspaceId: fakeIds.workspaceId,
          contextId: ids.forkContextId,
          epoch: 1,
          kind,
          cutSequence: null,
          tail: null,
          opening,
          prefixDigest: fakeDigest("fork epoch 1 prefix"),
          sectionTokens: fakeSectionTokens(),
          policyVersion: 1,
          rendererVersion: 1,
          openedAt: at,
          closedAt: null,
          expiresAt: null,
        }
      : {
          schemaVersion: 1,
          organizationId: fakeIds.organizationId,
          workspaceId: fakeIds.workspaceId,
          contextId: ids.forkContextId,
          epoch: 2,
          kind,
          cutSequence: 135,
          tail: { fromSequence: 136, throughSequence: 140 },
          opening: {
            ...opening,
            checkpoint: { checkpointId: ids.checkpointId, digest: fakeDigest("checkpoint") },
            plan: { planId: ids.planId, revision: 2 },
          },
          prefixDigest: fakeDigest("fork epoch 2 prefix"),
          sectionTokens: { ...fakeSectionTokens(), opening: 14600, conversation: 41000 },
          policyVersion: 1,
          rendererVersion: 1,
          openedAt: later(95),
          closedAt: null,
          expiresAt: null,
        },
  );
}
/**
 * The fork's hand-off at its first compaction: the fallback strategy's ContextCheckpoint@1
 * (narrative, facts cited by label, a promise, stated states that match SQL), or the provider
 * strategy's opaque compaction block with its readable summary.
 */
export function fakeContextCheckpoint(
  kind: "fallback" | "provider_compaction" = "fallback",
): Current_ContextCheckpoint {
  return freeze({
    schemaVersion: 1,
    id: ids.checkpointId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    contextId: ids.forkContextId,
    epoch: 1,
    runId: ids.forkRunId,
    kind,
    throughSequence: 135,
    summary:
      kind === "provider_compaction"
        ? "Read 14 summer dresses (c3). Listings drafted titles (j1); 12 are proposed (p1)."
        : null,
    // The provider's opaque block, kept here and sent first, unchanged, in epoch 2's request.
    block: kind === "provider_compaction" ? "Y29tcGFjdGlvbiBibG9jayBvZiBlcG9jaCAx" : null,
    content:
      kind === "fallback"
        ? {
            narrative:
              "The owner asked for clearer titles for the summer dresses (m1). Listings read 14 " +
              "dresses and drafted titles; two were set aside as already clear.",
            facts: [
              { label: "c3", value: "14 summer dresses, product:1 to product:14" },
              { label: "j1", value: "Listings call finished: 12 drafts, 2 unchanged" },
            ],
            discussed: [
              {
                topic: "Brand names in titles",
                quote: { label: "m1", text: "Keep the brand name first." },
                why: "The owner's standing style",
              },
            ],
            setAside: [{ what: "Rewriting descriptions", why: "Not part of the request" }],
            difficulties: [],
            promises: [{ text: "Say when the new titles are live", label: "p1" }],
            nextSteps: ["Have the proposal set reviewed", "Wait for the approval and read-back"],
            states: [{ label: "p1", state: "pending" }],
          }
        : null,
    validation: { result: "valid", code: null },
    readTags: [productsTag],
    audience: ownerAudience,
    sourceSubjects: [{ kind: "conversation", id: ids.conversationId }],
    taint: forkTaint(),
    createdAt: later(94),
    expiresAt: null,
  });
}
/** The ledger rendered at the fork's second epoch: SQL's records, never the model's words. */
export function fakeContextLedger(): Current_ContextLedger {
  return freeze({
    schemaVersion: 1,
    contextId: ids.forkContextId,
    epoch: 2,
    throughSequence: 140,
    requests: [
      {
        label: "m1",
        messageId: ids.messageId,
        authorPrincipalId: fakeIds.ownerPrincipalId,
        postedAt: at,
        text: "Improve the titles of my summer dresses. Keep the brand name first.",
        truncated: false,
      },
    ],
    threadPosts: [],
    questions: [
      {
        label: "q1",
        questionId: ids.questionId,
        question: "Should the size range stay in the title?",
        answer: "No, leave sizes out.",
        status: "answered",
      },
    ],
    proposals: [
      {
        label: "p1",
        proposalId: ids.proposalId,
        digest: fakeDigest("proposal set"),
        status: "approved",
        riskClass: "external",
        requiredApprovals: 1,
      },
    ],
    operations: [
      {
        label: "o1",
        operationId: ids.operationId,
        proposalId: ids.proposalId,
        status: "submitted",
        unknown: true,
      },
    ],
    records: [{ label: "r1", kind: "proposal", id: ids.proposalId }],
    calls: [
      {
        label: "j1",
        callId: ids.callId,
        installationId: fakeIds.listingsInstallationId,
        state: "finished",
        outcome: "done",
        created: 0,
        items: [ids.itemId],
        findings: 2,
      },
    ],
    refusals: [{ label: "c7", tool: "products.read", code: "id_out_of_scope", next: "rebrief" }],
    waits: [],
    taint: forkTaint(),
    plan: [
      { key: "read_dresses", title: "Read the summer dresses", status: "done" },
      { key: "draft_titles", title: "Propose new titles", status: "done" },
      { key: "tell_when_live", title: "Say when the titles are live", status: "open" },
    ],
    omitted: {
      requests: 0,
      threadPosts: 0,
      questions: 0,
      proposals: 0,
      operations: 0,
      records: 0,
      calls: 0,
      refusals: 0,
      plan: 0,
    },
  });
}

// --- The plan, completion and review (ADR-0041 items 16 and 19) -------------------------
/**
 * The job's plan. Revision 1 is the plan the fork set in its first turn (no change reason);
 * revision 2 records the requester's follow-up that changed a frozen criterion.
 */
export function fakeRunPlan(revision: 1 | 2 = 1): Current_RunPlan {
  const done = revision === 2;
  return freeze({
    schemaVersion: 1,
    id: ids.planId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    jobId: ids.jobId,
    runId: ids.forkRunId,
    revision,
    objective: "Clearer titles for every summer dress, proposed for the owner's approval.",
    criteria: [
      {
        key: "titles_proposed",
        text: "A new title is proposed for every summer dress that needs one",
        check: "proposal_state",
      },
      {
        key: "brand_first",
        text: done
          ? "The brand name comes first and no size range appears"
          : "The brand name comes first in every proposed title",
        check: "judgment",
      },
    ],
    phases: [
      {
        key: "read",
        title: "Read",
        items: [
          {
            key: "read_dresses",
            title: "Read the summer dresses",
            status: "done",
            criteria: [],
            evidence: [{ kind: "label", id: "c3" }],
            dependsOn: [],
            droppedReason: null,
            followThrough: null,
          },
        ],
      },
      {
        key: "propose",
        title: "Propose",
        items: [
          {
            key: "draft_titles",
            title: "Propose new titles",
            status: done ? "done" : "in_progress",
            criteria: ["titles_proposed", "brand_first"],
            evidence: done ? [{ kind: "proposal", id: ids.proposalId }] : [],
            dependsOn: ["read_dresses"],
            droppedReason: null,
            followThrough: null,
          },
          {
            key: "rewrite_descriptions",
            title: "Rewrite descriptions",
            status: "dropped",
            criteria: [],
            evidence: [],
            dependsOn: [],
            droppedReason: "Not part of the request",
            followThrough: null,
          },
          {
            key: "tell_when_live",
            title: "Say when the titles are live",
            status: "open",
            criteria: [],
            evidence: [],
            dependsOn: ["draft_titles"],
            droppedReason: null,
            followThrough: { kind: "proposal_applied", proposalId: ids.proposalId },
          },
        ],
      },
    ],
    notes: [{ kind: "decision", text: "Brand name first, as the owner asked in m1." }],
    understood: "You'd like clearer titles for your summer dresses, with the brand name first.",
    steps: [
      { title: "Read your summer dresses", by: fakeIds.listingsInstallationId },
      { title: "Draft clearer titles", by: fakeIds.listingsInstallationId },
      { title: "Check them and send them for your approval", by: "morrow" },
    ],
    change: done ? { kind: "requester_message", messageId: ids.followUpMessageId } : null,
    readTags: [productsTag],
    audience: ownerAudience,
    taint: forkTaint(),
    createdAt: done ? later(30) : at,
  });
}
/**
 * run.complete as the gate records it: done (every criterion met, the review passed), waiting
 * (the follow-through item open), partial (an unknown outcome named) or refused by the gate.
 */
export function fakeRunCompletion(
  kind: "done" | "waiting" | "partial" | "refused" = "done",
): Current_RunCompletion {
  const criteria = [
    {
      key: "titles_proposed",
      status: "met" as const,
      evidence: [{ kind: "proposal" as const, id: ids.proposalId }],
    },
    {
      key: "brand_first",
      status: "met" as const,
      evidence: [{ kind: "result_item" as const, id: ids.itemId }],
    },
  ];
  const base = {
    schemaVersion: 1 as const,
    runId: ids.forkRunId,
    jobId: ids.jobId,
    callId: null,
    criteria,
    followThrough: [] as string[],
    unknownOutcomes: [] as string[],
    gate: { result: "accepted" as const, code: null, criterion: null },
    reviewVerdictId: ids.verdictId,
    createdAt: later(100),
  };
  switch (kind) {
    case "done":
      return freeze({
        ...base,
        outcome: "done",
        reply: "I've proposed new titles for 12 summer dresses. They're waiting for your approval.",
      });
    case "waiting":
      return freeze({
        ...base,
        outcome: "waiting",
        reply: "The new titles are waiting for your approval. I'll tell you when they're live.",
        followThrough: ["tell_when_live"],
      });
    case "partial":
      return freeze({
        ...base,
        outcome: "partial",
        reply: "The titles were sent to your store, but the store hasn't confirmed them yet.",
        unknownOutcomes: [ids.operationId],
      });
    case "refused":
      return freeze({
        ...base,
        outcome: "done",
        criteria: [{ ...criteria[0]!, status: "unverified" as const, evidence: [] }, criteria[1]!],
        reply: "Done.",
        gate: {
          result: "verification_failed" as const,
          code: "evidence_unresolved" as const,
          criterion: "titles_proposed",
        },
        reviewVerdictId: null,
      });
  }
}
/** A fresh-context review of the proposal set: no objection, or a block on one criterion. */
export function fakeReviewVerdict(
  outcome: "no_objection" | "blocks" = "no_objection",
): Current_ReviewVerdict {
  const blocks = outcome === "blocks";
  return freeze({
    schemaVersion: 1,
    id: ids.verdictId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    reviewRunId: ids.reviewRunId,
    reviewedRunId: ids.forkRunId,
    jobId: ids.jobId,
    deliverable: { kind: "proposal_set", ids: [ids.proposalId] },
    criteria: [
      {
        key: "titles_proposed",
        verdict: "pass",
        evidence: [{ ref: { kind: "proposal", id: ids.proposalId }, note: "" }],
      },
      {
        key: "brand_first",
        verdict: blocks ? "fail" : "pass",
        evidence: [
          {
            ref: { kind: "proposal", id: ids.proposalId },
            note: blocks ? "Two titles put the fabric before the brand." : "",
          },
        ],
      },
    ],
    outcome,
    summary: blocks
      ? "Two of the 12 titles do not start with the brand name."
      : "Every proposed title starts with the brand name.",
    readTags: [productsTag],
    audience: ownerAudience,
    taint: forkTaint(),
    createdAt: later(98),
  });
}

// --- Waits (ADR-0041 items 7, 9, 17, 18 and 21) -------------------------------------------
const waitConditions: Readonly<Record<Current_RunWaitKind, Current_RunWaitCondition>> = {
  question: { kind: "question", questionId: ids.questionId },
  checkin: { kind: "checkin", code: "active_time" },
  detector: { kind: "detector", code: "repetition" },
  credits: { kind: "credits" },
  agent_credit_limit: {
    kind: "agent_credit_limit",
    installationId: fakeIds.listingsInstallationId,
  },
  children: { kind: "children", mode: "all", callIds: [ids.callId] },
  approval: { kind: "approval", until: "applied", proposalIds: [ids.proposalId] },
  timer: { kind: "timer", until: days(1) },
  provider: { kind: "provider", attempt: 2, nextAt: later(65) },
  slot: { kind: "slot" },
  idle_followup: { kind: "idle_followup", callId: ids.callId },
};
/** Every wait kind, in its order. */
export const fakeRunWaitKinds: readonly Current_RunWaitKind[] = Object.freeze(
  Object.keys(waitConditions) as Current_RunWaitKind[],
);
/**
 * One open wait of a kind: the fork's (an idle teammate's own for idle_followup), with its wake
 * time where code sets one and the person waits' 7-day expiry. No wait holds a lease.
 */
export function fakeRunWait(kind: Current_RunWaitKind = "children"): Current_RunWait {
  const sequence = fakeRunWaitKinds.indexOf(kind) + 1;
  const condition = waitConditions[kind];
  const person = ["question", "checkin", "detector"].includes(kind);
  return freeze({
    schemaVersion: 1,
    id: `${ids.waitId}_${kind}`,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    runId: kind === "idle_followup" ? ids.callRunId : ids.forkRunId,
    jobId: ids.jobId,
    waitSequence: sequence,
    kind,
    condition: structuredClone(condition),
    state: "open",
    openedAt: later(sequence),
    wakeAt:
      condition.kind === "timer"
        ? condition.until
        : condition.kind === "provider"
          ? condition.nextAt
          : null,
    expiresAt: person || kind === "credits" ? days(7) : null,
    resolution: null,
  });
}
/** The question wait, answered by the requester in session: a person's act re-issues the lease. */
export function fakeResolvedRunWait(): Current_RunWait {
  return freeze({
    ...structuredClone(fakeRunWait("question")),
    state: "resolved",
    resolution: { code: "answered", leaseSource: "person_act", at: later(20) },
  });
}

// --- Events and the request card (ADR-0041 item 36, ADR-0040 item 5) --------------------
/** The job's content-free event log, numbered per root run, kept 365 days. */
export function fakeRunEvents(): readonly Current_RunEvent[] {
  const event = (
    sequence: number,
    kind: Current_RunEvent["kind"],
    more: Partial<Current_RunEvent> = {},
  ): Current_RunEvent => ({
    schemaVersion: 1,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    rootRunId: ids.forkRunId,
    sequence,
    runId: ids.forkRunId,
    jobId: ids.jobId,
    contextId: ids.forkContextId,
    kind,
    code: null,
    ref: null,
    count: null,
    tokensBefore: null,
    tokensAfter: null,
    durationMs: null,
    credits: null,
    digest: null,
    at: later(sequence),
    expiresAt: days(365),
    ...more,
  });
  const wait = { kind: "wait" as const, id: `${ids.waitId}_children` };
  return freeze([
    event(1, "run.admitted", { code: "person_act", ref: { kind: "run", id: ids.forkRunId } }),
    event(2, "context.forked", { ref: { kind: "context", id: ids.forkContextId } }),
    event(3, "plan.set", { ref: { kind: "plan", id: ids.planId }, count: 3 }),
    event(4, "call.admitted", {
      runId: ids.callRunId,
      contextId: ids.callContextId,
      ref: { kind: "call", id: ids.callId },
    }),
    event(5, "credits.held", { runId: ids.callRunId, contextId: ids.callContextId, credits: "6" }),
    event(6, "wait.opened", { code: "children", ref: wait }),
    event(7, "wait.resolved", { code: "child_finished", ref: wait }),
    event(8, "context.compacted", {
      code: "compaction",
      ref: { kind: "checkpoint", id: ids.checkpointId },
      tokensBefore: 161200,
      tokensAfter: 62700,
    }),
    event(9, "review.verdict", { ref: { kind: "review", id: ids.verdictId } }),
    event(10, "completion.accepted", { digest: fakeDigest("completion") }),
    event(11, "credits.drawn", { credits: "38" }),
    event(12, "run.ended", { code: "completed", durationMs: 6_120_000 }),
  ]);
}
/** The request card for its requester in one state (a projection of the jobs row and events). */
export function fakeJobStatus(state: Current_JobState = "working"): Current_JobStatus {
  const reasons: Partial<Record<Current_JobState, Current_JobStatus["reason"]>> = {
    queued: "waiting_for_slot",
    waiting: "waiting_for_approval",
    paused: "paused_credits",
    checking: "operation_unconfirmed",
    stopped: "stopped_by_requester",
    failed: "error",
  };
  const started = !["not_started", "received", "reading", "queued"].includes(state);
  const ended = ["done", "stopped", "failed"].includes(state);
  return freeze({
    schemaVersion: 1,
    jobId: ids.jobId,
    conversationId: ids.conversationId,
    state,
    reason: reasons[state] ?? null,
    activity: state === "working" ? "asking_teammate" : null,
    activityInstallationId: state === "working" ? fakeIds.listingsInstallationId : null,
    title: { kind: "opening_post", messageId: ids.messageId },
    steps: started ? { done: state === "done" ? 3 : 1, total: 3 } : null,
    teammates: started ? [fakeIds.listingsInstallationId] : [],
    counts: {
      suggestedChanges: state === "done" ? 12 : 0,
      changesMade: 0,
      operationsUnconfirmed: state === "checking" ? 1 : 0,
    },
    creditsUsed: started ? "38" : null,
    needsYou: state === "waiting" || state === "paused",
    unread: state === "done",
    stoppedByPrincipalId: state === "stopped" ? fakeIds.ownerPrincipalId : null,
    startedAt: started ? later(1) : null,
    updatedAt: later(100),
    endedAt: ended ? later(100) : null,
  });
}

// --- Memory (ADR-0041 items 25 to 30) -----------------------------------------------------
/** A project thread's summary over the messages every current viewer can see. */
export function fakeConversationSummary(): Current_ConversationSummary {
  return freeze({
    schemaVersion: 1,
    id: ids.summaryId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    conversationId: ids.projectConversationId,
    fromMessageId: "msg_project_1",
    throughMessageId: "msg_project_40",
    messageCount: 40,
    viewers: { kind: "common", viewerSetDigest: fakeDigest("viewer set") },
    upkeepRunId: ids.upkeepRunId,
    narrative: "The team agreed the summer range launches in May; pricing stays under review.",
    citations: [
      {
        messageId: ids.otherMemberMessageId,
        authorPrincipalId: fakeIds.memberPrincipalId,
        quote: "Keep the linen line under $60.",
      },
    ],
    recordIds: [ids.proposalId],
    validation: { result: "valid", code: null },
    readTags: [],
    audience: { kind: "subject", subject: { kind: "project", id: projectId } },
    sourceSubjects: [{ kind: "conversation", id: ids.projectConversationId }],
    taint: { kinds: ["other_member"], sourceCount: 1 },
    createdAt: later(120),
  });
}
/** The Owner's own memory, saved by tapping Save on Morrow's suggestion. */
export function fakePersonMemory(): Current_PersonMemory {
  return freeze({
    schemaVersion: 1,
    id: ids.personMemoryId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    principalId: fakeIds.ownerPrincipalId,
    version: 1,
    text: "Product titles start with the brand name.",
    scope: "private_chats",
    storeId: null,
    writtenFrom: { kind: "suggestion", suggestionId: ids.suggestionId },
    lastUsedAt: later(1),
    createdAt: at,
    updatedAt: at,
  });
}
/** Morrow's suggestion, a message part only the Owner sees, expiring after 30 days. */
export function fakePersonMemorySuggestion(): Current_PersonMemorySuggestion {
  return freeze({
    schemaVersion: 1,
    id: ids.suggestionId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    principalId: fakeIds.ownerPrincipalId,
    runId: ids.mainThreadRunId,
    conversationId: ids.conversationId,
    messageId: ids.resultMessageId,
    text: "Product titles start with the brand name.",
    scope: "private_chats",
    digest: fakeDigest("suggestion text"),
    state: "pending",
    createdAt: at,
    expiresAt: days(30),
  });
}
/** A lesson in Listings' notebook, written for the Owner, readable across the workspace. */
export function fakeNotebookEntryV2(): Current_NotebookEntryV2 {
  return freeze({
    schemaVersion: 2,
    id: ids.notebookEntryId,
    organizationId: fakeIds.organizationId,
    workspaceId: fakeIds.workspaceId,
    agentPrincipalId: fakeIds.listingsPrincipalId,
    installationId: fakeIds.listingsInstallationId,
    sequence: 1,
    kind: "lesson",
    title: "Titles: brand first",
    text: "This shop's titles start with the brand name, then the product, then the colour.",
    status: "live",
    derivedFrom: [],
    writtenForPrincipalId: fakeIds.ownerPrincipalId,
    readTags: [],
    audience: { kind: "workspace" },
    sourceSubjects: [],
    taint: untainted(),
    useCount: 0,
    lastUsedAt: null,
    affirmedAt: at,
    createdAt: at,
    expiresAt: days(90),
  });
}
/** memory.search's hits for two queries, each naming its layer and trust class. */
export function fakeMemorySearchHits(): readonly Current_MemorySearchHit[] {
  return freeze([
    {
      layer: "knowledge",
      id: ids.pageId,
      label: null,
      query: 0,
      title: "Brand voice",
      snippet: "Warm, plain words. The brand name leads every title.",
      trust: "approved_knowledge",
      taint: untainted(),
      score: 912,
      updatedAt: at,
    },
    {
      layer: "notebook",
      id: ids.notebookEntryId,
      label: null,
      query: 0,
      title: "Titles: brand first",
      snippet: "This shop's titles start with the brand name.",
      trust: "agent_lesson",
      taint: untainted(),
      score: 744,
      updatedAt: at,
    },
    {
      layer: "result_item",
      id: ids.itemId,
      label: "i1",
      query: 1,
      title: "Summer dress titles",
      snippet: "product:3 Linen wrap dress → Morrow Linen Wrap Dress",
      trust: "work_record",
      taint: itemTaint(),
      score: 610,
      updatedAt: later(60),
    },
  ]);
}
