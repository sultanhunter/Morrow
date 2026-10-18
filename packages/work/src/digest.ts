// Request digests (P06.T01a §4.7 step 1). Canonical JSON sorts object keys by
// UTF-16 code unit, so a body with reordered keys or different whitespace has the
// same digest and replays; any other difference conflicts.

const invalid = () => Error("WORK_CANONICAL_JSON_INVALID");

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
        .join(",") +
      "}"
    );
  }
  throw invalid();
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type WorkCommandType =
  | "goal.create"
  | "goal.transition"
  | "task.create"
  | "task.ready"
  | "task.assign"
  | "question.request"
  | "question.answer"
  | "question.cancel";

export function workRequestDigest(
  type: WorkCommandType,
  workspaceId: string,
  pathIds: readonly string[],
  body: unknown,
): Promise<string> {
  return sha256Hex(
    canonicalJson(["morrow.work.command", 1, type, workspaceId, [...pathIds], body]),
  );
}

/** The built-in answer schema `morrow.answer.text` revision 1, and its fixed digest. */
export const answerTextSchema = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: 8192,
} as const);
/** sha256(canonicalJson(answerTextSchema)); a unit test recomputes it. */
export const answerTextSchemaDigest =
  "e79254cb03a2db7ca0c300bf476208d2b8f5c67326e71c49874f1090fb082f47";
