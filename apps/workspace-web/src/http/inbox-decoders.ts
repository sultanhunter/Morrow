// v1 PR 15: closed decoders of the Inbox and activity reads (internal JSON between the api
// Worker and this SPA; packages/work/src/inbox/http.ts) and of one operation's document
// (GET /work/operations/:id, packages/work/src/review/http.ts). A body that does not match
// exactly decodes to null, which the work outcome mapping turns into an unconfirmed read,
// never a guess. Ids, closed codes, counts and times only; a question's words are the one
// text, and the screen shows them as text.
import type {
  ActivityLogView,
  ActivityRecordView,
  InboxItemView,
  InboxView,
  OperationDetailView,
} from "@morrow/workspace-ui";
import { isId } from "./client";
import { decodeOperation } from "./review-decoders";
import { isUtcTime } from "./work-decoders";

type Json = Readonly<Record<string, unknown>>;
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactly = (value: Json, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const code = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(value);
const oneOf = <T extends string>(value: unknown, list: readonly T[]): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const capabilityId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 128 && /^[a-z]+(\.[a-z_]+)+$/.test(value);
const operationId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const cursor = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const sections = ["questions", "approvals", "changes", "connections"] as const;

function decodeInboxItem(value: unknown): InboxItemView | null {
  if (!record(value)) return null;
  switch (value.kind) {
    case "question":
      return exactly(value, ["kind", "id", "taskId", "prompt", "createdAt", "open"]) &&
        isId(value.id) &&
        isId(value.taskId) &&
        text(value.prompt, 8192) &&
        isUtcTime(value.createdAt) &&
        value.open === true
        ? {
            kind: "question",
            id: value.id,
            taskId: value.taskId,
            prompt: value.prompt,
            createdAt: value.createdAt,
            open: true,
          }
        : null;
    case "approval":
      return exactly(value, [
        "kind",
        "id",
        "proposalId",
        "storeId",
        "capabilityId",
        "targetCount",
        "expiresAt",
        "storeLinked",
        "open",
      ]) &&
        isId(value.id) &&
        isId(value.proposalId) &&
        (value.storeId === null || isId(value.storeId)) &&
        capabilityId(value.capabilityId) &&
        integer(value.targetCount, 1, 100) &&
        isUtcTime(value.expiresAt) &&
        typeof value.storeLinked === "boolean" &&
        // A change for a store that isn't linked can't be applied: never counted.
        value.open === value.storeLinked
        ? {
            kind: "approval",
            id: value.id,
            proposalId: value.proposalId,
            storeId: value.storeId as string | null,
            capabilityId: value.capabilityId,
            targetCount: value.targetCount,
            expiresAt: value.expiresAt,
            storeLinked: value.storeLinked,
            open: value.open,
          }
        : null;
    case "exception": {
      if (
        !exactly(value, [
          "kind",
          "reason",
          "id",
          "proposalId",
          "taskId",
          "storeId",
          "status",
          "reasonCode",
          "updatedAt",
          "open",
        ]) ||
        !oneOf(value.reason, ["uncertain_operation", "failed_operation"] as const) ||
        !operationId(value.id) ||
        !isId(value.proposalId) ||
        !isId(value.taskId) ||
        !isId(value.storeId) ||
        !oneOf(value.status, ["uncertain", "failed", "conflict"] as const) ||
        !(value.reasonCode === null || code(value.reasonCode)) ||
        !isUtcTime(value.updatedAt)
      )
        return null;
      const uncertain = value.status === "uncertain";
      // The reason follows the status, and only an unknown outcome waits on a person.
      if ((value.reason === "uncertain_operation") !== uncertain || value.open !== uncertain)
        return null;
      return {
        kind: "exception",
        reason: value.reason,
        id: value.id,
        proposalId: value.proposalId,
        taskId: value.taskId,
        storeId: value.storeId,
        status: value.status,
        reasonCode: value.reasonCode as string | null,
        updatedAt: value.updatedAt,
        open: uncertain,
      };
    }
    case "connection":
      return exactly(value, ["kind", "reason", "id", "storeId", "setBy", "since", "open"]) &&
        oneOf(value.reason, [
          "disconnected",
          "uninstalled",
          "scopes_changed",
          "stopped",
        ] as const) &&
        isId(value.id) &&
        isId(value.storeId) &&
        oneOf(value.setBy, ["human", "system", "operator"] as const) &&
        isUtcTime(value.since) &&
        value.open === true
        ? {
            kind: "connection",
            reason: value.reason,
            id: value.id,
            storeId: value.storeId,
            setBy: value.setBy,
            since: value.since,
            open: true,
          }
        : null;
  }
  return null;
}

/** GET /work/inbox. */
export function decodeInbox(body: unknown): InboxView | null {
  if (
    !record(body) ||
    !exactly(body, ["schemaVersion", "sections", "items", "more"]) ||
    body.schemaVersion !== 1 ||
    !record(body.sections) ||
    !exactly(body.sections, sections) ||
    !Array.isArray(body.items) ||
    body.items.length > 200 ||
    typeof body.more !== "boolean"
  )
    return null;
  const states = body.sections;
  if (!sections.every((k) => states[k] === "ok" || states[k] === "denied")) return null;
  const items: InboxItemView[] = [];
  const seen = new Set<string>();
  for (const value of body.items) {
    const item = decodeInboxItem(value);
    if (!item || seen.has(item.kind + ":" + item.id)) return null;
    // A denied section sends none of its items.
    const section =
      item.kind === "question"
        ? "questions"
        : item.kind === "approval"
          ? "approvals"
          : item.kind === "exception"
            ? "changes"
            : "connections";
    if (states[section] !== "ok") return null;
    seen.add(item.kind + ":" + item.id);
    items.push(item);
  }
  return {
    sections: {
      questions: states.questions as "ok" | "denied",
      approvals: states.approvals as "ok" | "denied",
      changes: states.changes as "ok" | "denied",
      connections: states.connections as "ok" | "denied",
    },
    items,
    more: body.more,
  };
}

function decodeActor(value: unknown): ActivityRecordView["actor"] | null {
  if (!record(value)) return null;
  if (value.kind === "person")
    return exactly(value, ["kind", "principalId"]) && isId(value.principalId)
      ? { kind: "person", principalId: value.principalId }
      : null;
  if (value.kind === "morrow" || value.kind === "shopify")
    return exactly(value, ["kind"]) ? { kind: value.kind } : null;
  return null;
}
const nullableId = (value: unknown) => value === null || isId(value);

function decodeRecord(value: unknown): ActivityRecordView | null {
  if (!record(value) || !isId(value.id) || !isUtcTime(value.at)) return null;
  const actor = decodeActor(value.actor);
  if (!actor) return null;
  const base = { id: value.id, at: value.at, actor };
  const keys = (more: readonly string[]) => exactly(value, ["id", "at", "actor", "kind", ...more]);
  const person = actor.kind === "person";
  switch (value.kind) {
    case "approval_decided":
      return keys(["decision", "proposalId", "taskId", "storeId", "targetCount"]) &&
        person &&
        oneOf(value.decision, ["approve", "reject"] as const) &&
        isId(value.proposalId) &&
        nullableId(value.taskId) &&
        nullableId(value.storeId) &&
        integer(value.targetCount, 1, 100)
        ? {
            ...base,
            kind: "approval_decided",
            decision: value.decision,
            proposalId: value.proposalId,
            taskId: value.taskId as string | null,
            storeId: value.storeId as string | null,
            targetCount: value.targetCount,
          }
        : null;
    case "change_outcome":
      return keys(["outcome", "reasonCode", "operationId", "proposalId", "taskId", "storeId"]) &&
        actor.kind === "morrow" &&
        oneOf(value.outcome, ["verified", "not_applied", "unknown", "set_aside"] as const) &&
        (value.reasonCode === null || code(value.reasonCode)) &&
        operationId(value.operationId) &&
        isId(value.proposalId) &&
        isId(value.taskId) &&
        isId(value.storeId)
        ? {
            ...base,
            kind: "change_outcome",
            outcome: value.outcome,
            reasonCode: value.reasonCode as string | null,
            operationId: value.operationId,
            proposalId: value.proposalId,
            taskId: value.taskId,
            storeId: value.storeId,
          }
        : null;
    case "ai_work_stopped":
      return keys(["storeId", "agent", "alreadyStopped"]) &&
        person &&
        isId(value.storeId) &&
        value.agent === "listings" &&
        typeof value.alreadyStopped === "boolean"
        ? {
            ...base,
            kind: "ai_work_stopped",
            storeId: value.storeId,
            agent: "listings",
            alreadyStopped: value.alreadyStopped,
          }
        : null;
    case "store_disconnected":
      return keys(["storeId", "alreadyStopped"]) &&
        person &&
        isId(value.storeId) &&
        typeof value.alreadyStopped === "boolean"
        ? {
            ...base,
            kind: "store_disconnected",
            storeId: value.storeId,
            alreadyStopped: value.alreadyStopped,
          }
        : null;
    case "store_ended":
      return keys(["storeId", "reason"]) &&
        actor.kind === "shopify" &&
        isId(value.storeId) &&
        oneOf(value.reason, ["uninstalled", "scopes_changed", "other"] as const)
        ? { ...base, kind: "store_ended", storeId: value.storeId, reason: value.reason }
        : null;
    case "agent_added":
      return keys(["storeId", "agent"]) &&
        person &&
        isId(value.storeId) &&
        oneOf(value.agent, ["listings", "other"] as const)
        ? { ...base, kind: "agent_added", storeId: value.storeId, agent: value.agent }
        : null;
    case "drafts_requested":
      return keys(["taskId", "storeId", "productCount", "status", "drafted", "failed"]) &&
        person &&
        isId(value.taskId) &&
        isId(value.storeId) &&
        integer(value.productCount, 1, 100) &&
        oneOf(value.status, ["queued", "running", "succeeded", "failed", "cancelled"] as const) &&
        integer(value.drafted, 0, 100) &&
        integer(value.failed, 0, 100) &&
        value.drafted + value.failed <= value.productCount
        ? {
            ...base,
            kind: "drafts_requested",
            taskId: value.taskId,
            storeId: value.storeId,
            productCount: value.productCount,
            status: value.status,
            drafted: value.drafted,
            failed: value.failed,
          }
        : null;
  }
  return null;
}

/** GET /work/activity: a page of the log, newest first. */
export function decodeActivity(body: unknown): ActivityLogView | null {
  if (
    !record(body) ||
    !exactly(body, ["schemaVersion", "entries", "next"]) ||
    body.schemaVersion !== 1 ||
    !Array.isArray(body.entries) ||
    body.entries.length > 50 ||
    !(body.next === null || cursor(body.next))
  )
    return null;
  const entries: ActivityRecordView[] = [];
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  for (const value of body.entries) {
    const entry = decodeRecord(value);
    if (!entry || seen.has(entry.id)) return null;
    // Newest first, as the server orders the log.
    const at = Date.parse(entry.at);
    if (at > previous) return null;
    previous = at;
    seen.add(entry.id);
    entries.push(entry);
  }
  return { entries, next: body.next as string | null };
}

/** GET /work/operations/:id: the operation the path names, its transitions and read-backs. */
export function decodeOperationDetail(body: unknown, id: string): OperationDetailView | null {
  if (
    !record(body) ||
    !exactly(body, ["schemaVersion", "operation", "transitions", "readbacks"]) ||
    body.schemaVersion !== 1 ||
    !record(body.operation) ||
    !Array.isArray(body.transitions) ||
    body.transitions.length > 100 ||
    !Array.isArray(body.readbacks) ||
    body.readbacks.length > 20
  )
    return null;
  const operation = decodeOperation(body.operation);
  if (!operation || operation.operationId !== id || !isId(body.operation.storeId)) return null;
  const transitions: OperationDetailView["transitions"][number][] = [];
  for (const t of body.transitions) {
    if (
      !record(t) ||
      !exactly(t, ["revision", "from", "to", "reason", "occurredAt"]) ||
      !integer(t.revision, 1, Number.MAX_SAFE_INTEGER) ||
      !code(t.from) ||
      !code(t.to) ||
      !(t.reason === null || code(t.reason)) ||
      !isUtcTime(t.occurredAt)
    )
      return null;
    transitions.push({
      revision: t.revision,
      from: t.from,
      to: t.to,
      reason: t.reason as string | null,
      occurredAt: t.occurredAt,
    });
  }
  const readbacks: OperationDetailView["readbacks"][number][] = [];
  for (const r of body.readbacks) {
    if (
      !record(r) ||
      !exactly(r, ["sequence", "observedAt", "outcome", "verdict", "fields"]) ||
      !integer(r.sequence, 1, Number.MAX_SAFE_INTEGER) ||
      !isUtcTime(r.observedAt) ||
      !code(r.outcome) ||
      !(r.verdict === null || code(r.verdict))
    )
      return null;
    readbacks.push({
      sequence: r.sequence,
      observedAt: r.observedAt,
      outcome: r.outcome,
      verdict: r.verdict as string | null,
    });
  }
  return { operation, storeId: body.operation.storeId, transitions, readbacks };
}
