// Work reply decoding (P14.T01a §4.8, P06.T01a §4.9): the v1 ErrorEnvelope and the v1
// Goal, Task, Question and answer bodies, decoded by hand (no eval or schema
// compilation; unknown properties ignored). Each record decoder checks every field the
// UI renders, and the record's workspace against the path's, so a reply that does not
// decode is unavailable (reads) or uncertain (commands), never a partial object. The UI
// shows an envelope's safeMessage and "Reference: <correlationId>" and never parses
// either. Statuses decode as any non-empty string; unknown ones render as text.
import type {
  AnswerView,
  GoalView,
  Outcome,
  Page,
  PersonRef,
  QuestionView,
  TaskView,
} from "@morrow/workspace-ui";
import { isId, type Reply } from "./client";
import { failureOutcome, record, retryAfter, type Mode } from "./identity-decoders";

export interface ErrorEnvelope {
  readonly code: string;
  readonly retryClass: string;
  readonly safeMessage: string;
  readonly correlationId: string;
  readonly operationId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly inputRequestIds: readonly string[];
}
const codes = [
  "denied",
  "missing_input",
  "conflict",
  "unavailable",
  "rate_limited",
  "provider_rejected",
  "approval_expired",
  "budget_exhausted",
  "uncertain",
];
const retryClasses = ["never", "safe_read_retry", "recheck_before_retry", "reconcile_before_retry"];

export function decodeErrorEnvelope(body: unknown): ErrorEnvelope | null {
  if (!record(body) || body.schemaVersion !== 1) return null;
  const {
    code,
    retryClass,
    safeMessage,
    correlationId,
    operationId,
    retryAfterSeconds,
    inputRequestIds,
  } = body;
  if (typeof code !== "string" || !codes.includes(code)) return null;
  if (typeof retryClass !== "string" || !retryClasses.includes(retryClass)) return null;
  if (typeof safeMessage !== "string" || safeMessage.length < 1 || safeMessage.length > 512)
    return null;
  if (!isId(correlationId)) return null;
  if (operationId !== null && !isId(operationId)) return null;
  if (
    retryAfterSeconds !== null &&
    !(
      typeof retryAfterSeconds === "number" &&
      Number.isInteger(retryAfterSeconds) &&
      retryAfterSeconds >= 1 &&
      retryAfterSeconds <= 86400
    )
  )
    return null;
  if (!Array.isArray(inputRequestIds) || !inputRequestIds.every(isId)) return null;
  return {
    code,
    retryClass,
    safeMessage,
    correlationId,
    operationId,
    retryAfterSeconds,
    inputRequestIds,
  };
}

/** One §4.8 row per reply. Only a decoded 2xx, 400, 403, 404 or 409 is terminal. */
export function workOutcome<T>(
  reply: Reply,
  mode: Mode,
  decode: (body: unknown, status: number) => T | null,
): Outcome<T> {
  if (reply.kind !== "response") return failureOutcome(reply, mode);
  const unconfirmed: Outcome<T> =
    mode === "read" ? { kind: "unavailable", offline: false } : { kind: "uncertain" };
  const { status, body } = reply;
  if (status >= 200 && status < 300) {
    const value = decode(body, status);
    if (value === null) return unconfirmed;
    return { kind: "ok", value, replayed: record(body) && body.replayed === true };
  }
  if (status === 401) return { kind: "unauthenticated" };
  const envelope = decodeErrorEnvelope(body);
  if (status === 429)
    return {
      kind: "rate_limited",
      retryAfterSeconds: envelope?.retryAfterSeconds ?? retryAfter(reply.headers),
    };
  if (status === 503)
    return envelope?.code === "unavailable" ? { kind: "unavailable", offline: false } : unconfirmed;
  if (!envelope) return unconfirmed;
  switch (status) {
    case 400:
      return { kind: "invalid", field: null };
    case 403:
      return { kind: "denied", message: envelope.safeMessage, reference: envelope.correlationId };
    case 404:
      return { kind: "not_found" };
    case 409:
      return {
        kind: "conflict",
        recheck: envelope.retryClass === "recheck_before_retry",
        message: envelope.safeMessage,
      };
    default:
      return unconfirmed;
  }
}

// ---- records (P06.T01a §4.9: every Goal, Task and Question is a v1 object)
const actorKinds = ["human", "agent", "service"] as const;
const nullableId = (value: unknown) => value === null || isId(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;
const statusText = (value: unknown): value is string => text(value, 64);
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
/** v1 UtcTime: an RFC 3339 date-time in UTC (`Z`), as the server's validator requires. */
const utcPattern =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]{1,9})?Z$/;
export const isUtcTime = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 64 && utcPattern.test(value);
const inWorkspace = (value: Readonly<Record<string, unknown>>, ws: string) =>
  value.schemaVersion === 1 &&
  isId(value.id) &&
  isId(value.organizationId) &&
  value.workspaceId === ws &&
  revision(value.revision) &&
  isUtcTime(value.updatedAt);

/** A v1 ActorRef as an opaque person: no label and no "isSelf" until people.list. */
export function decodeActor(value: unknown): PersonRef | null {
  if (!record(value)) return null;
  const { kind, principalId, organizationId, workspaceId, membershipId } = value;
  if (typeof kind !== "string" || !actorKinds.includes(kind as PersonRef["kind"])) return null;
  if (!isId(principalId) || !isId(organizationId)) return null;
  if (!nullableId(workspaceId) || !nullableId(membershipId)) return null;
  if (!nullableId(value.installationId) || !nullableId(value.mandateId)) return null;
  return { principalId, kind: kind as PersonRef["kind"], label: null, isSelf: null };
}

export function decodeGoal(value: unknown, ws: string): GoalView | null {
  if (!record(value) || !inWorkspace(value, ws)) return null;
  const owner = decodeActor(value.owner);
  const list = value.successCriteria;
  if (!owner || !statusText(value.status) || !text(value.objective, 8192)) return null;
  if (!Array.isArray(list) || list.length < 1 || list.length > 100) return null;
  const criteria: string[] = [];
  for (const item of list as readonly unknown[]) {
    if (!record(item) || !text(item.description, 2048)) return null;
    criteria.push(item.description);
  }
  return {
    id: value.id as string,
    objective: value.objective,
    status: value.status,
    criteria,
    owner,
    revision: value.revision as number,
    updatedAt: value.updatedAt as string,
  };
}

export function decodeTask(value: unknown, ws: string): TaskView | null {
  if (!record(value) || !inWorkspace(value, ws)) return null;
  const owner = decodeActor(value.owner);
  if (!owner || !statusText(value.status) || !text(value.objective, 8192)) return null;
  if (!nullableId(value.goalId)) return null;
  return {
    id: value.id as string,
    goalId: value.goalId as string | null,
    objective: value.objective,
    status: value.status,
    owner,
    revision: value.revision as number,
    updatedAt: value.updatedAt as string,
  };
}

export function decodeQuestion(value: unknown, ws: string): QuestionView | null {
  if (!record(value) || !inWorkspace(value, ws)) return null;
  if (!isId(value.taskId) || !statusText(value.status) || !text(value.prompt, 8192)) return null;
  const respondents = value.eligibleRespondentIds;
  if (!Array.isArray(respondents) || !respondents.every(isId)) return null;
  if (value.expiresAt !== null && !isUtcTime(value.expiresAt)) return null;
  // v1 work questions name exactly one respondent (P06.T01a §4.9); any other count is
  // shown without one rather than guessed.
  const respondent: PersonRef | null =
    respondents.length === 1
      ? { principalId: respondents[0] as string, kind: "human", label: null, isSelf: null }
      : null;
  return {
    id: value.id as string,
    taskId: value.taskId,
    prompt: value.prompt,
    status: value.status,
    respondent,
    revision: value.revision as number,
    updatedAt: value.updatedAt as string,
    expiresAt: value.expiresAt as string | null,
  };
}

export function decodeAnswer(value: unknown, questionId: string): AnswerView | null {
  if (!record(value) || !isId(value.id) || value.questionId !== questionId) return null;
  const answeredBy = decodeActor(value.answeredBy);
  if (!answeredBy || !text(value.body, 65536) || !isUtcTime(value.createdAt)) return null;
  return {
    id: value.id,
    questionId,
    text: value.body,
    answeredBy,
    createdAt: value.createdAt,
  };
}

/** `{items, next}`: every item must decode, or the page does not (never partial). */
export function decodePage<T>(body: unknown, item: (value: unknown) => T | null): Page<T> | null {
  if (!record(body) || body.schemaVersion !== 1 || !Array.isArray(body.items)) return null;
  if (body.items.length > 50) return null;
  if (body.next !== null && !text(body.next, 1024)) return null;
  const items: T[] = [];
  for (const value of body.items as readonly unknown[]) {
    const decoded = item(value);
    if (decoded === null) return null;
    items.push(decoded);
  }
  return { items, next: body.next as string | null };
}
/** `{schemaVersion:1, <name>: record}` for the single-record reads. */
export function decodeOne<T>(
  body: unknown,
  name: "goal" | "task" | "question" | "answer",
  item: (value: unknown) => T | null,
): T | null {
  return record(body) && body.schemaVersion === 1 ? item(body[name]) : null;
}

// ---- command results (P06.T01a §4.9 success bodies; `replayed: true` on a replay)
const created = (body: unknown, status: number, name: "goalId" | "taskId" | "questionId") =>
  record(body) && body.schemaVersion === 1 && (status === 201 || status === 200) && isId(body[name])
    ? (body[name] as string)
    : null;
export const decodeGoalCreated = (body: unknown, status: number) => {
  const goalId = created(body, status, "goalId");
  return goalId !== null && record(body) && revision(body.revision) ? { goalId } : null;
};
export const decodeTaskCreated = (body: unknown, status: number) => {
  const taskId = created(body, status, "taskId");
  return taskId !== null && record(body) && revision(body.revision) ? { taskId } : null;
};
export const decodeQuestionCreated = (body: unknown, status: number) => {
  const questionId = created(body, status, "questionId");
  return questionId !== null && record(body) && statusText(body.status) ? { questionId } : null;
};
/** Mark ready, assign and cancel: `{revision}` (with `status` or `assignmentId`). */
export const decodeRevision = (body: unknown, status: number) =>
  record(body) && body.schemaVersion === 1 && status === 200 && revision(body.revision)
    ? { revision: body.revision }
    : null;
export const decodeAnswered = (body: unknown, status: number) =>
  record(body) &&
  body.schemaVersion === 1 &&
  status === 200 &&
  revision(body.answerRevision) &&
  record(body.answerRef)
    ? { answerRevision: body.answerRevision }
    : null;
