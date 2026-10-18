// Work reply decoding (P14.T01a §4.8, P06.T01a §4.9): the v1 ErrorEnvelope, decoded by
// hand (no eval or schema compilation; unknown properties ignored). The UI shows its
// safeMessage and "Reference: <correlationId>" and never parses either. The record
// decoders (Goal, Task, Question, Answer) arrive with the work routes in PR-2.
import type { Outcome } from "@morrow/workspace-ui";
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
