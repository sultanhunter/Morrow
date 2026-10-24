import { workPermissions } from "@morrow/contracts/work-permissions";
import { storeResource } from "@morrow/policy/store-resource";
import { disconnectAllowed } from "../connections/commands.js";
import { listApprovals } from "../approvals/index.js";
import { readProposalRow } from "../approvals/family.js";
import { viewerRole, type ApprovalSummary } from "../approvals/reads.js";
import type { WorkTx } from "../connection.js";
import { WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { mapQuestion } from "../contract-mapping.js";
import { decideWork } from "../permissions.js";

// GET /work/inbox (v1 PR 15): one read of what waits for this person, aggregated from the
// records that exist today, so the Inbox, Home and the sidebar's count read one reply.
// Every item is filtered here, on the server, by the same rule as its own screen; the
// browser decides no authority and only counts what it was given.
//   question    open questions addressed to the viewer (question.read view, as GET
//               /questions?respondent=me); a denial marks the section, never "nothing"
//   approval    pending approvals the viewer may decide (the approvals library's reviewer
//               role: the preview grant, the decide verbs and eligibility), with whether
//               the store is linked now (a change for a disconnected store can't be applied)
//   exception   apply outcomes that are unknown (uncertain: needs a person) or, for seven
//               days, not applied; visible as the operation's own read (the proposal's
//               reviewer or proposer)
//   connection  an open stop on a store connection that is not linked again: a person's
//               disconnect, an uninstall or a scope change; only for a person who holds the
//               store's disconnect right (the connection steward and the Owner)
// Kinds whose backend is not built yet (questions from agent runs, Reconnect after a scope
// change) are not here: the SPA shows them only from fixtures behind `samples.inbox`.
// Ids, codes and times only; a question's prompt is the one text, as the question list
// returns it.

export type InboxSectionState = "ok" | "denied";
export interface InboxQuestionItem {
  readonly kind: "question";
  readonly id: string;
  readonly taskId: string;
  readonly prompt: string;
  readonly createdAt: string;
  readonly open: true;
}
export interface InboxApprovalItem {
  readonly kind: "approval";
  readonly id: string;
  readonly proposalId: string;
  readonly storeId: string | null;
  readonly capabilityId: string;
  readonly targetCount: number;
  readonly expiresAt: string;
  readonly storeLinked: boolean;
  readonly open: boolean;
}
export interface InboxExceptionItem {
  readonly kind: "exception";
  readonly reason: "uncertain_operation" | "failed_operation";
  readonly id: string;
  readonly proposalId: string;
  readonly taskId: string;
  readonly storeId: string;
  readonly status: "uncertain" | "failed" | "conflict";
  readonly reasonCode: string | null;
  readonly updatedAt: string;
  readonly open: boolean;
}
export interface InboxConnectionItem {
  readonly kind: "connection";
  readonly reason: "disconnected" | "uninstalled" | "scopes_changed" | "stopped";
  readonly id: string;
  readonly storeId: string;
  readonly setBy: "human" | "system" | "operator";
  readonly since: string;
  readonly open: true;
}
export type InboxItem =
  | InboxQuestionItem
  | InboxApprovalItem
  | InboxExceptionItem
  | InboxConnectionItem;
export interface InboxDocument {
  readonly sections: {
    readonly questions: InboxSectionState;
    readonly approvals: InboxSectionState;
    readonly changes: InboxSectionState;
    readonly connections: InboxSectionState;
  };
  readonly items: readonly InboxItem[];
  /** A source had more than this reply carries (50 questions, 25 approvals, 50 changes). */
  readonly more: boolean;
}

export const inboxLimits = Object.freeze({ questions: 50, approvals: 25, changes: 50 });
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const text = (row: Readonly<Record<string, unknown>>, key: string) => {
  const value = row[key];
  if (typeof value !== "string") throw new WorkContextUnavailable();
  return value;
};
const id = (row: Readonly<Record<string, unknown>>, key: string) => {
  const value = text(row, key);
  if (!idPattern.test(value)) throw new WorkContextUnavailable();
  return value;
};
const optional = (row: Readonly<Record<string, unknown>>, key: string) =>
  row[key] === null ? null : text(row, key);
const codePattern = /^[a-z][a-z0-9_]{0,63}$/;
const code = (row: Readonly<Record<string, unknown>>, key: string) => {
  const value = optional(row, key);
  if (value !== null && !codePattern.test(value)) throw new WorkContextUnavailable();
  return value;
};

/** Whether the store is linked to this workspace now, through any connection. */
export async function storeLinkedNow(tx: WorkTx, storeId: string): Promise<boolean> {
  const rows = await tx.run("storeAssociation", [storeId]);
  if (rows.length === 0) return false;
  if (rows.length !== 1 || rows[0]!.store_id !== storeId) throw new WorkContextUnavailable();
  return true;
}

/**
 * Whether the viewer may see a proposal's records: its reviewer or its own proposer or
 * requester (the approvals library's read rule, which the operation reads share). Cached
 * per proposal for one request.
 */
export function proposalReader(tx: WorkTx, a: WorkAuthority) {
  const seen = new Map<string, Promise<boolean>>();
  return (proposalId: string): Promise<boolean> => {
    let visible = seen.get(proposalId);
    if (!visible) {
      visible = (async () => {
        const stored = await readProposalRow(tx, a, proposalId);
        return !!stored && (await viewerRole(a, stored)) !== null;
      })();
      seen.set(proposalId, visible);
    }
    return visible;
  };
}

async function questions(tx: WorkTx, a: WorkAuthority) {
  const rule = workPermissions["question.read"];
  const decision = await decideWork(a, rule.capabilityId, "view", rule.fields);
  if (!decision.allowed) return { state: "denied" as const, items: [], more: false };
  const rows = await tx.run("questionPageForRespondent", [
    a.actor.principalId,
    "open",
    null,
    null,
    String(inboxLimits.questions + 1),
  ]);
  const items: InboxQuestionItem[] = rows.slice(0, inboxLimits.questions).map((row) => {
    const q = mapQuestion(row, a);
    return Object.freeze({
      kind: "question",
      id: q.id,
      taskId: q.taskId,
      prompt: q.prompt,
      createdAt: q.createdAt,
      open: true,
    });
  });
  return { state: "ok" as const, items, more: rows.length > inboxLimits.questions };
}

/**
 * The Inbox's changes to review from one page of the approvals list: only those this
 * person may decide (the reviewer role; a proposer follows their own on the review
 * screen), each open only while its store is linked (a change for a disconnected store
 * can't be applied, so it is listed and never counted).
 */
export async function inboxApprovalItems(
  page: readonly Pick<
    ApprovalSummary,
    "approval" | "approvalRef" | "proposalRef" | "capabilityId" | "targetCount" | "viewerRole"
  >[],
  linked: (storeId: string) => Promise<boolean>,
): Promise<InboxApprovalItem[]> {
  const items: InboxApprovalItem[] = [];
  for (const i of page) {
    // Only what this person may decide: a proposer sees their own on the review screen.
    if (i.viewerRole !== "reviewer") continue;
    const storeId = i.proposalRef.storeId;
    const storeLinked = storeId === null ? true : await linked(storeId);
    items.push(
      Object.freeze({
        kind: "approval",
        id: i.approvalRef.id,
        proposalId: i.proposalRef.id,
        storeId,
        capabilityId: i.capabilityId,
        targetCount: i.targetCount,
        expiresAt: i.approval.expiresAt,
        storeLinked,
        open: storeLinked,
      }),
    );
  }
  return items;
}
async function approvals(
  tx: WorkTx,
  a: WorkAuthority,
  linked: (storeId: string) => Promise<boolean>,
) {
  const page = await listApprovals(tx, a, { after: null, limit: inboxLimits.approvals });
  if (page === "invalid") throw new WorkContextUnavailable();
  const items = await inboxApprovalItems(page.items, linked);
  return { state: "ok" as const, items, more: page.next !== null };
}

const exceptionStatuses = ["uncertain", "failed", "conflict"] as const;
async function changes(tx: WorkTx, visible: (proposalId: string) => Promise<boolean>) {
  const rows = await tx.run("inboxOperations", []);
  const items: InboxExceptionItem[] = [];
  for (const row of rows.slice(0, inboxLimits.changes)) {
    const status = text(row, "status");
    if (!(exceptionStatuses as readonly string[]).includes(status))
      throw new WorkContextUnavailable();
    const proposalId = id(row, "proposal_id");
    if (!(await visible(proposalId))) continue;
    const uncertain = status === "uncertain";
    items.push(
      Object.freeze({
        kind: "exception",
        reason: uncertain ? "uncertain_operation" : "failed_operation",
        id: id(row, "id"),
        proposalId,
        taskId: id(row, "task_id"),
        storeId: id(row, "store_id"),
        status: status as InboxExceptionItem["status"],
        reasonCode: code(row, "reason") ?? code(row, "uncertainty_reason"),
        updatedAt: text(row, "updated_at"),
        // A not-applied change is information: nothing waits on a person (the contract's
        // failed_operation is never open).
        open: uncertain,
      }),
    );
  }
  return { state: "ok" as const, items, more: rows.length > inboxLimits.changes };
}

const setters = ["human", "system", "operator"] as const;
function connectionReason(setBy: string, reasonCode: string): InboxConnectionItem["reason"] {
  if (setBy === "human" && reasonCode === "human_disconnect") return "disconnected";
  if (reasonCode === "shopify_app_uninstalled") return "uninstalled";
  if (reasonCode === "shopify_scopes_changed") return "scopes_changed";
  return "stopped";
}
async function connections(
  tx: WorkTx,
  a: WorkAuthority,
  linked: (storeId: string) => Promise<boolean>,
) {
  const rows = await tx.run("inboxConnectionStops", []);
  const items: InboxConnectionItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const connectionId = id(row, "connection_id");
    const storeId = id(row, "store_id");
    const setBy = text(row, "set_by_kind");
    const reasonCode = code(row, "reason_code");
    if (!(setters as readonly string[]).includes(setBy) || reasonCode === null)
      throw new WorkContextUnavailable();
    if (seen.has(connectionId)) continue;
    seen.add(connectionId);
    // Settled once the store is linked to this workspace again (a new connection).
    if (await linked(storeId)) continue;
    const store = storeResource(
      a.actor.organizationId,
      a.resource.workspaceId,
      storeId,
      connectionId,
    );
    if (!(await disconnectAllowed(a, store))) continue;
    items.push(
      Object.freeze({
        kind: "connection",
        reason: connectionReason(setBy, reasonCode),
        id: connectionId,
        storeId,
        setBy: setBy as InboxConnectionItem["setBy"],
        since: text(row, "created_at"),
        open: true,
      }),
    );
  }
  return { state: "ok" as const, items };
}

/** The viewer's Inbox, from one read-only transaction. */
export async function readInbox(tx: WorkTx, a: WorkAuthority): Promise<InboxDocument> {
  const links = new Map<string, Promise<boolean>>();
  const linked = (storeId: string) => {
    let value = links.get(storeId);
    if (!value) {
      value = storeLinkedNow(tx, storeId);
      links.set(storeId, value);
    }
    return value;
  };
  const visible = proposalReader(tx, a);
  // One statement at a time on the one connection.
  const q = await questions(tx, a);
  const p = await approvals(tx, a, linked);
  const c = await changes(tx, visible);
  const s = await connections(tx, a, linked);
  return Object.freeze({
    sections: Object.freeze({
      questions: q.state,
      approvals: p.state,
      changes: c.state,
      connections: s.state,
    }),
    items: Object.freeze([
      ...s.items,
      ...c.items.filter((i) => i.open),
      ...p.items,
      ...q.items,
      ...c.items.filter((i) => !i.open),
    ]),
    more: q.more || p.more || c.more,
  });
}
