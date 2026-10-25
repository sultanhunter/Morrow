// v1 PR 15 fixtures: the Inbox, one operation's document and the activity log, built from
// the fixture's own state (its questions, reviews, operations and disconnect), plus the
// default-off Inbox preview's samples. Synthetic data only. Scripted, not simulated: who
// may see which item is the server's (lab:catalog-apply I1-I6, tests/inbox-api.test.mjs).
import type {
  ActivityLogView,
  ActivityRecordView,
  InboxItemView,
  InboxSamplesView,
  InboxView,
  OperationView,
  QuestionView,
} from "@morrow/workspace-ui";
import { fixtureStore, people } from "./seed";

export interface InboxFixtureState {
  readonly questions: readonly QuestionView[];
  readonly reviews: readonly {
    readonly id: string;
    readonly status: "pending" | "approved" | "rejected";
    readonly productCount: number;
    readonly expiresAt: string;
    readonly operations: readonly OperationView[];
  }[];
  readonly storeLinked: boolean;
  readonly disconnectedAt: string | null;
}

/** What the fixture's server would answer: the viewer is the owner, who may see all of it. */
export function fixtureInbox(state: InboxFixtureState): InboxView {
  const items: InboxItemView[] = [];
  if (state.disconnectedAt !== null)
    items.push({
      kind: "connection",
      reason: "disconnected",
      id: fixtureStore.connectionId,
      storeId: fixtureStore.storeId,
      setBy: "human",
      since: state.disconnectedAt,
      open: true,
    });
  for (const r of state.reviews)
    for (const o of r.operations)
      if (o.status === "uncertain" || o.status === "failed" || o.status === "conflict")
        items.push({
          kind: "exception",
          reason: o.status === "uncertain" ? "uncertain_operation" : "failed_operation",
          id: o.operationId,
          proposalId: o.proposalId,
          taskId: o.taskId,
          storeId: fixtureStore.storeId,
          status: o.status,
          reasonCode: o.reason ?? o.uncertaintyReason,
          updatedAt: o.updatedAt,
          open: o.status === "uncertain",
        });
  for (const r of state.reviews)
    if (r.status === "pending")
      items.push({
        kind: "approval",
        id: `approval-${r.id}`,
        proposalId: r.id,
        storeId: fixtureStore.storeId,
        capabilityId: "catalog.content.publish",
        targetCount: r.productCount,
        expiresAt: r.expiresAt,
        storeLinked: state.storeLinked,
        open: state.storeLinked,
      });
  for (const q of state.questions)
    if (q.status === "open")
      items.push({
        kind: "question",
        id: q.id,
        taskId: q.taskId,
        prompt: q.prompt,
        createdAt: q.updatedAt,
        open: true,
      });
  return {
    sections: { questions: "ok", approvals: "ok", changes: "ok", connections: "ok" },
    items,
    more: false,
  };
}
export const emptyInbox: InboxView = {
  sections: { questions: "ok", approvals: "ok", changes: "ok", connections: "ok" },
  items: [],
  more: false,
};
/** The AC26 first-run Home: questions denied, nothing else waiting. */
export const questionsDeniedInbox: InboxView = {
  ...emptyInbox,
  sections: { ...emptyInbox.sections, questions: "denied" },
};

const t = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString();
const owner = { kind: "person", principalId: people.owner.principalId } as const;
const editor = { kind: "person", principalId: people.editor.principalId } as const;
const S = fixtureStore.storeId;
/** The log, newest first: requests to Listings, decisions, results and stops. */
const activityRecords: readonly ActivityRecordView[] = [
  {
    id: "act-0012",
    at: t(23, 14, 4),
    actor: owner,
    kind: "ai_work_stopped",
    storeId: S,
    agent: "listings",
    alreadyStopped: false,
  },
  {
    id: "act-0011",
    at: t(23, 11, 52),
    actor: { kind: "morrow" },
    kind: "change_outcome",
    outcome: "verified",
    reasonCode: "readback_matched",
    operationId: "00000000-0000-4000-9000-000000000901",
    proposalId: "proposal-sample-0",
    taskId: "task-titles",
    storeId: S,
  },
  {
    id: "act-0010",
    at: t(23, 11, 51),
    actor: { kind: "morrow" },
    kind: "change_outcome",
    outcome: "not_applied",
    reasonCode: "source_changed",
    operationId: "00000000-0000-4000-9000-000000000902",
    proposalId: "proposal-sample-0",
    taskId: "task-titles",
    storeId: S,
  },
  {
    id: "act-0009",
    at: t(23, 11, 50),
    actor: owner,
    kind: "approval_decided",
    decision: "approve",
    proposalId: "proposal-sample-0",
    taskId: "task-titles",
    storeId: S,
    targetCount: 2,
  },
  {
    id: "act-0008",
    at: t(23, 10, 33),
    actor: editor,
    kind: "drafts_requested",
    taskId: "task-titles",
    storeId: S,
    productCount: 3,
    status: "succeeded",
    drafted: 2,
    failed: 1,
  },
  {
    id: "act-0007",
    at: t(22, 16, 10),
    actor: owner,
    kind: "approval_decided",
    decision: "reject",
    proposalId: "proposal-sample-x",
    taskId: "task-titles",
    storeId: S,
    targetCount: 1,
  },
  {
    id: "act-0006",
    at: t(21, 17, 40),
    actor: { kind: "morrow" },
    kind: "change_outcome",
    outcome: "unknown",
    reasonCode: "fence_expired",
    operationId: "00000000-0000-4000-9000-000000000903",
    proposalId: "proposal-sample-y",
    taskId: "task-titles",
    storeId: S,
  },
  {
    id: "act-0005",
    at: t(20, 9, 0),
    actor: editor,
    kind: "drafts_requested",
    taskId: "task-source",
    storeId: S,
    productCount: 1,
    status: "failed",
    drafted: 0,
    failed: 1,
  },
  {
    id: "act-0004",
    at: t(2, 15, 15),
    actor: owner,
    kind: "agent_added",
    storeId: S,
    agent: "listings",
  },
];
/** The log in pages of `size`, with cursors as the fixture's own strings. */
export function fixtureActivity(after: string | null, size = 25): ActivityLogView {
  const start = after === null ? 0 : Number(after.replace(/^cursor-/, ""));
  const entries = activityRecords.slice(start, start + size);
  const next = start + size < activityRecords.length ? `cursor-${start + size}` : null;
  return { entries, next };
}

/** The Inbox preview (default off): kinds whose backend isn't built yet. */
export const fixtureInboxSamples: InboxSamplesView = {
  items: [
    {
      kind: "run_question",
      id: "sample-ask-1",
      agent: "inventory",
      prompt: "Order 50 Utility Overshirts, or wait?",
      choices: ["Order 50", "Wait for now"],
      askedAt: t(23, 6, 6),
    },
    {
      kind: "reconnect",
      id: "sample-reconnect-1",
      missingPermissions: ["See orders"],
      stoppedAgents: ["Business Analyst"],
      since: t(23, 8, 0),
    },
  ],
};
