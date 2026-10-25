import { workPermissions } from "@morrow/contracts/work-permissions";
import { storeResource } from "@morrow/policy/store-resource";
import {
  ReconnectNoticeInvalid,
  decodeReinstalledStore,
  readReconnectNotices,
  type ReconnectNotice,
} from "../connection-health/notices.js";
import { disconnectAllowed } from "../connections/commands.js";
import { listApprovals } from "../approvals/index.js";
import { readProposalRow } from "../approvals/family.js";
import type { StoredProposalRow } from "../approvals/mapping.js";
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
//   connection  an open stop on a store connection that is not linked again, neither the
//               same store nor, after a reinstall of the same app, its shop as a new store
//               (v1 PR 5: a reinstall is a new store): a person's disconnect, an uninstall
//               or a scope change recorded before v1 PR 5; and, since v1 PR 5, a live
//               connection's open Reconnect item (a Shopify permission it lacks, or a token
//               Shopify refused: `scopes_changed`, from connection_notices_open, which
//               answers only its recipients); each only for a person who holds the store's
//               disconnect right (the connection steward and the Owner)
// Agents' questions from runs have no backend yet: the SPA shows them only from fixtures
// behind `samples.inbox`, as it does the fuller `reconnect` kind (the missing permissions and
// the paused agents) until PR 10b.
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
  /**
   * More waits for this person than the reply carries: a question or a change to review
   * past its page (50 and 25), or an unknown outcome past the 50 operations, each one this
   * person may see. Records the viewer can't see never set it (it would say they exist and
   * contradict an empty Inbox), and not-applied changes past the limit don't count.
   */
  readonly more: boolean;
}

export const inboxLimits = Object.freeze({ questions: 50, approvals: 25, changes: 50 });
/**
 * How far the read looks past records this person can't see: the operations statement's
 * rows (it fetches one more, to tell the scan's bound from the end) and pages of the
 * approvals list (each scans at most 100 rows). A scan that ends at its bound undecided
 * sets `more` only beside a full page, so it never claims more beside an empty one.
 */
export const inboxScan = Object.freeze({ changes: 100, approvalPages: 4 });
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
 * Whether a reinstall of the same app linked this ended store's shop to this workspace again
 * (v1 PR 5: a reinstall is a new store and connection, so the ended store itself is never
 * linked again; PR 5 review finding F3, after integration with main).
 */
export async function storeReinstalledNow(tx: WorkTx, storeId: string): Promise<boolean> {
  try {
    return decodeReinstalledStore(await tx.run("storeReinstalled", [storeId]), storeId) !== null;
  } catch (error) {
    if (error instanceof ReconnectNoticeInvalid) throw new WorkContextUnavailable();
    throw error;
  }
}

/**
 * A proposal's stored row when the viewer may see its records (its reviewer, or its own
 * proposer or requester: the approvals library's read rule, which the operation reads
 * share), else null. Cached per proposal for one request; the Inbox and the activity log
 * both decide through it.
 */
export function proposalReader(tx: WorkTx, a: WorkAuthority) {
  const seen = new Map<string, Promise<StoredProposalRow | null>>();
  return (proposalId: string): Promise<StoredProposalRow | null> => {
    let visible = seen.get(proposalId);
    if (!visible) {
      visible = (async () => {
        const stored = await readProposalRow(tx, a, proposalId);
        return stored && (await viewerRole(a, stored)) !== null ? stored : null;
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
type ApprovalPage = {
  readonly items: Parameters<typeof inboxApprovalItems>[0];
  readonly next: string | null;
};
/**
 * The changes to review, paged until 25 this person may decide, the end of the list or
 * the scan's bound; `more` only when one more they may decide lies past the 25 (a page of
 * a proposer's own changes, or of nothing they may see, never sets it).
 */
export async function inboxApprovals(
  readPage: (after: string | null) => Promise<ApprovalPage>,
  linked: (storeId: string) => Promise<boolean>,
): Promise<{ readonly items: InboxApprovalItem[]; readonly more: boolean }> {
  const items: InboxApprovalItem[] = [];
  let after: string | null = null;
  for (let pages = 0; pages < inboxScan.approvalPages; pages++) {
    const page = await readPage(after);
    for (const item of await inboxApprovalItems(page.items, linked)) {
      if (items.length === inboxLimits.approvals) return { items, more: true };
      items.push(item);
    }
    if (page.next === null) return { items, more: false };
    after = page.next;
  }
  return { items, more: items.length === inboxLimits.approvals };
}
async function approvals(
  tx: WorkTx,
  a: WorkAuthority,
  linked: (storeId: string) => Promise<boolean>,
) {
  const { items, more } = await inboxApprovals(async (after) => {
    const page = await listApprovals(tx, a, { after, limit: inboxLimits.approvals });
    if (page === "invalid") throw new WorkContextUnavailable();
    return page;
  }, linked);
  return { state: "ok" as const, items, more };
}

const exceptionStatuses = ["uncertain", "failed", "conflict"] as const;
/**
 * The Inbox's problems from the operations statement's rows (unknown outcomes first): the
 * first 50 this person may see (the operation read's rule, `visible`), and `more` only
 * when one more unknown outcome they may see lies past those 50. A row they can't see is
 * skipped and never counted, so a person who can see none of them gets no items and no
 * `more`, and learns nothing of the hidden ones. Past the 50, a not-applied change is
 * information, so the first one ends the search.
 */
export async function inboxChangeItems(
  rows: readonly Readonly<Record<string, unknown>>[],
  visible: (proposalId: string) => Promise<unknown>,
): Promise<{ readonly items: InboxExceptionItem[]; readonly more: boolean }> {
  const items: InboxExceptionItem[] = [];
  for (const row of rows.slice(0, inboxScan.changes)) {
    const status = text(row, "status");
    if (!(exceptionStatuses as readonly string[]).includes(status))
      throw new WorkContextUnavailable();
    const uncertain = status === "uncertain";
    const proposalId = id(row, "proposal_id");
    if (items.length === inboxLimits.changes) {
      if (!uncertain) return { items, more: false };
      if (await visible(proposalId)) return { items, more: true };
      continue;
    }
    if (!(await visible(proposalId))) continue;
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
  // The rows ran out: at their end nothing more waits; at the scan's bound (the statement
  // sent one row past it), more may wait only beside a full page.
  return {
    items,
    more: rows.length > inboxScan.changes && items.length === inboxLimits.changes,
  };
}
async function changes(
  tx: WorkTx,
  visible: (proposalId: string) => Promise<StoredProposalRow | null>,
) {
  const rows = await tx.run("inboxOperations", []);
  return { state: "ok" as const, ...(await inboxChangeItems(rows, visible)) };
}

const setters = ["human", "system", "operator"] as const;
function connectionReason(setBy: string, reasonCode: string): InboxConnectionItem["reason"] {
  if (setBy === "human" && reasonCode === "human_disconnect") return "disconnected";
  if (reasonCode === "shopify_app_uninstalled") return "uninstalled";
  // Only a connection stop recorded before v1 PR 5 carries this code (0037's suspension on
  // app/scopes_update, which 0052 refuses since): a scope change now keeps the connection
  // and raises a Reconnect item instead (inboxReconnectItems below).
  if (reasonCode === "shopify_scopes_changed") return "scopes_changed";
  return "stopped";
}
/**
 * The Inbox's connection problems from a live connection's open Reconnect items (v1 PR 5;
 * PR 5 review finding F1, after integration with main): each item the read definer answers
 * (only to its recipients, the connection steward and the Owner) that still needs
 * reconnecting, as a `scopes_changed` problem of its connection, for a viewer who also holds
 * the store's disconnect right, as every connection problem. An item a re-authorisation
 * already settled (`open` false; the cron clears it) and a connection already listed are
 * skipped.
 */
export async function inboxReconnectItems(
  notices: readonly ReconnectNotice[],
  allowed: (storeId: string, connectionId: string) => Promise<boolean>,
  seen: Set<string> = new Set(),
): Promise<InboxConnectionItem[]> {
  const items: InboxConnectionItem[] = [];
  for (const n of notices) {
    if (!n.open || seen.has(n.connectionId)) continue;
    seen.add(n.connectionId);
    if (!(await allowed(n.storeId, n.connectionId))) continue;
    items.push(
      Object.freeze({
        kind: "connection",
        reason: "scopes_changed",
        id: n.connectionId,
        storeId: n.storeId,
        setBy: "system",
        since: n.createdAt,
        open: true,
      }),
    );
  }
  return items;
}
async function connections(
  tx: WorkTx,
  a: WorkAuthority,
  linked: (storeId: string) => Promise<boolean>,
) {
  const rows = await tx.run("inboxConnectionStops", []);
  const items: InboxConnectionItem[] = [];
  const seen = new Set<string>();
  const allowed = (storeId: string, connectionId: string) =>
    disconnectAllowed(
      a,
      storeResource(a.actor.organizationId, a.resource.workspaceId, storeId, connectionId),
    );
  for (const row of rows) {
    const connectionId = id(row, "connection_id");
    const storeId = id(row, "store_id");
    const setBy = text(row, "set_by_kind");
    const reasonCode = code(row, "reason_code");
    if (!(setters as readonly string[]).includes(setBy) || reasonCode === null)
      throw new WorkContextUnavailable();
    if (seen.has(connectionId)) continue;
    seen.add(connectionId);
    // Settled once the store is linked to this workspace again (a new connection), or once a
    // reinstall of the same app linked its shop again (a new store: v1 PR 5's reinstall).
    if (await linked(storeId)) continue;
    if (await storeReinstalledNow(tx, storeId)) continue;
    if (!(await allowed(storeId, connectionId))) continue;
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
  let notices: readonly ReconnectNotice[];
  try {
    notices = await readReconnectNotices(tx);
  } catch (error) {
    if (error instanceof ReconnectNoticeInvalid) throw new WorkContextUnavailable();
    throw error;
  }
  items.push(...(await inboxReconnectItems(notices, allowed, seen)));
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
