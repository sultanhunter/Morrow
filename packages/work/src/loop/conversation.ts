import type {
  Current_AssistantModelMessage,
  Current_ModelMessage,
  Current_ModelUntrustedSource,
  Current_ReadTag,
  Current_UserModelMessage,
} from "@morrow/contracts";
import { canonicalJson, sha256Hex } from "../digest.js";
import type { ConversationRow, QuestionAnswer, ToolCallOutcome } from "./steps.js";

// The conversation of one agent run (ADR-0027 items 4, 5 and 7), built only from its own
// run_turns rows inside one step: content never reaches a step result. The conversation is
// append-only: turn n's call carries every earlier turn's input and recorded reply, then
// turn n's input; prefixDigest is the digest of all but that last message, which the broker
// compares with the digest it recorded after the previous reply (null on turn 1). Digests
// are SHA-256 of the RFC 8785 text (canonicalJson, the review library's canonicalDigest and
// the broker's own JCS agree on these plain JSON values), on Web Crypto.
//
// Untrusted content (ADR-0027 item 5): the person's request is the one text block; anything
// a tool returns enters only as a tool result whose content is wrapped data naming its
// source, so it can never choose tools, recipients or limits (those come from the manifest
// and SQL, never from text), and a result that carried store, email or upload text taints
// the run.

export const toolResultMaxBytes = 8192;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/** The digest of a conversation (an array of messages). */
export function conversationDigest(messages: readonly Current_ModelMessage[]): Promise<string> {
  return sha256Hex(canonicalJson(messages));
}
/** The digest of one message (a turn's input as stored). */
export function messageDigest(message: Current_ModelMessage): Promise<string> {
  return sha256Hex(canonicalJson(message));
}
/** Turn 1's input: the person's own request, as one text block. */
export function firstTurnInput(objective: string): Current_UserModelMessage {
  if (typeof objective !== "string" || objective.length < 1) throw Error("LOOP_INPUT_INVALID");
  return Object.freeze({
    role: "user" as const,
    content: Object.freeze([Object.freeze({ type: "text" as const, text: objective })]),
  }) as unknown as Current_UserModelMessage;
}
/** The fixed label before the requester's answer to an inbox.ask question. */
export const answerLabel = "The person answered your question: ";
/**
 * Turn n+1's input: the tool results turn n's reply led to, in its tool_use order, then, for
 * each of its inbox.ask calls the requester answered, the answer as one text block (the
 * requester's own words, as the request is; only the run's requester answers, and the answer
 * names no tool, recipient or limit: those come from the manifest and SQL).
 */
export function nextTurnInput(
  previous: ConversationRow,
  answers: readonly QuestionAnswer[] = [],
): Current_UserModelMessage {
  const output = previous.output as Current_AssistantModelMessage | null;
  if (previous.outcome !== "tool_use" || !output) throw Error("LOOP_INPUT_INVALID");
  const asks = output.content
    .filter((b) => b.type === "tool_use" && b.name === "inbox.ask")
    .map((b) => (b as { readonly id: string }).id);
  const uses = output.content.filter((b) => b.type === "tool_use").map((b) => b.id);
  const results = previous.toolResults as readonly {
    readonly type: string;
    readonly toolUseId: string;
  }[];
  if (
    results.length !== uses.length ||
    results.some((r, i) => r?.type !== "tool_result" || r.toolUseId !== uses[i])
  )
    throw Error("LOOP_INPUT_INVALID");
  const answered = asks
    .map((id) => answers.find((a) => a.toolUseId === id))
    .filter((a): a is QuestionAnswer => a !== undefined)
    .map((a) => Object.freeze({ type: "text" as const, text: answerLabel + a.answer }));
  return Object.freeze({
    role: "user" as const,
    content: Object.freeze([...previous.toolResults, ...answered]),
  }) as unknown as Current_UserModelMessage;
}
/** The reply of the attempt that has one, per turn (at most one attempt of a turn has one). */
function replied(rows: readonly ConversationRow[], turn: number): ConversationRow | null {
  return (
    rows.find((r) => r.turn === turn && (r.outcome === "end_turn" || r.outcome === "tool_use")) ??
    null
  );
}
/**
 * The messages of turn n, attempt a: every earlier turn's input and reply, then this
 * attempt's own stored input. Throws unless every earlier turn has exactly its reply.
 */
export function turnMessages(
  rows: readonly ConversationRow[],
  turn: number,
  attempt: number,
): readonly Current_ModelMessage[] {
  const messages: Current_ModelMessage[] = [];
  for (let t = 1; t < turn; t++) {
    const row = replied(rows, t);
    if (!row || row.output === null) throw Error("LOOP_CONVERSATION_INVALID");
    messages.push(row.input as Current_ModelMessage, row.output as Current_ModelMessage);
  }
  const current = rows.find((r) => r.turn === turn && r.attempt === attempt);
  if (!current) throw Error("LOOP_CONVERSATION_INVALID");
  messages.push(current.input as Current_ModelMessage);
  return Object.freeze(messages);
}
/**
 * The build order PR 11 turn call this runner sends (the broker's parseModelCallV2 checks it by
 * hand). H6 edited ModelCall@2 to ids and digests only (ADR-0041 item 8: the broker assembles
 * the request from SQL); H7b's runner and H7c's broker adopt that contract, and this shape, with
 * its whole conversation and its final turn, goes with them. It is reached only while the
 * agent-loop switch is on, which its harness_runner prerequisite refuses until H7b (plan row
 * H7a).
 */
export interface LegacyTurnCall {
  readonly schemaVersion: 2;
  readonly purpose: "agent_turn";
  readonly turn: number;
  readonly attempt: number;
  readonly sequence: number;
  readonly final: boolean;
  readonly prefixDigest: string | null;
  readonly messages: readonly Current_ModelMessage[];
}
/** One send of the PR 11 runner: closed; it names no model, effort, tool list, limit or price. */
export async function modelCall(input: {
  readonly turn: number;
  readonly attempt: number;
  readonly sequence: number;
  readonly final: boolean;
  readonly messages: readonly Current_ModelMessage[];
}): Promise<LegacyTurnCall> {
  const { turn, attempt, sequence, final, messages } = input;
  return Object.freeze({
    schemaVersion: 2,
    purpose: "agent_turn",
    turn,
    attempt,
    sequence,
    final,
    prefixDigest: turn === 1 ? null : await conversationDigest(messages.slice(0, -1)),
    messages: [...messages],
  });
}

/** The tools whose results carry a store's or a person's outside content (ADR-0027 item 5). */
const untrustedSources: Readonly<Record<string, Current_ModelUntrustedSource>> = Object.freeze({
  "products.read": "product",
  "inventory.read": "inventory",
  "orders.summary": "order_summary",
  "support.thread.read": "support_mail",
  "knowledge.search": "knowledge_page",
  "work.read": "artifact",
});
/** The read tags a tool's result carries (ADR-0031 item 6): its capability on the run's store. */
const readTagCapabilities: Readonly<Record<string, Current_ReadTag["capability"]>> = Object.freeze({
  "products.read": "catalog.products.read",
  "inventory.read": "inventory.levels.read",
  "orders.summary": "orders.read",
  "support.thread.read": "support.case.read",
  "knowledge.search": "workspace.knowledge.read",
  "work.read": "workspace.artifact.read",
});
/** Whether a tool's result is untrusted data (its source), or null for Morrow's own records. */
export function untrustedSourceOf(tool: string): Current_ModelUntrustedSource | null {
  return untrustedSources[tool] ?? null;
}
/** The read tags of one turn's input: the union of its tool results' tags, sorted. */
export function readTagsOf(tools: readonly string[], storeId: string): readonly Current_ReadTag[] {
  const caps = [...new Set(tools.map((t) => readTagCapabilities[t]).filter(Boolean))].sort();
  return Object.freeze(
    caps.map((capability) => Object.freeze({ storeId, capability: capability! })),
  ) as readonly Current_ReadTag[];
}
/**
 * One tool call's result as the model sees it: a closed JSON object, the tool, its outcome
 * and, for a result, the data, with `source` naming where untrusted data came from. At most
 * 8 KiB, or null (the call is then refused result_too_large).
 */
export function renderToolResult(input: {
  readonly tool: string;
  readonly outcome: ToolCallOutcome;
  readonly refusal: string | null;
  readonly data: unknown;
}): string | null {
  const source = input.outcome === "ok" ? untrustedSourceOf(input.tool) : null;
  const text = canonicalJson({
    tool: input.tool,
    outcome: input.outcome,
    refusal: input.refusal,
    source,
    data: input.outcome === "ok" ? (input.data ?? null) : null,
  });
  return bytes(text) <= toolResultMaxBytes ? text : null;
}
