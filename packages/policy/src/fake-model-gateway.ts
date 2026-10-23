// A scripted fake of the loop's model gateway (PR 10; ModelCall@2 and ModelResult@2,
// ADR-0027 item 4), for the agent loop's tests (PR 11) before the broker's modelTurn exists.
// It keeps the contract the real gateway will keep:
//   - a call must be a ModelCall@2 (it names no provider, model, effort, tool list or limit);
//   - the conversation is append-only: turn 1 carries one user message and no prefix digest;
//     every later call's prefixDigest is the digest of all its messages but the last and must
//     equal the digest the previous reply returned, or the result is prefix_mismatch and
//     nothing is "sent";
//   - a reply that calls a tool the run was not offered, or any tool on a final turn, is
//     invalid_output (an invalid tool_use ends the run);
//   - every result is a ModelResult@2, and a reply's prefixDigest covers the call's messages
//     with the reply appended.
// The digest is SHA-256 of the RFC 8785 text of the message array (review.ts canonicalDigest).
import type {
  Current_AssistantModelMessage,
  Current_ModelCallV2,
  Current_ModelMessage,
  Current_ModelResultV2,
  Current_ModelTurnOutcome,
  Current_ModelUsageV2,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { canonicalDigest } from "./review";

/** The loop's model port: one turn of one run, under the run's lease (PR 11 adds the lease). */
export interface ModelTurnGateway {
  modelTurn(request: {
    readonly runId: string;
    readonly call: unknown;
  }): Promise<Current_ModelResultV2>;
}
export type FakeTurn =
  | {
      readonly reply: Current_AssistantModelMessage;
      readonly usage?: Current_ModelUsageV2;
    }
  | {
      readonly outcome: Exclude<Current_ModelTurnOutcome, "end_turn" | "tool_use">;
      readonly retryAfterMs?: number;
    };
export class FakeModelGatewayError extends Error {
  constructor(readonly code: "MODEL_CALL_INVALID" | "SCRIPT_EXHAUSTED") {
    super(code);
    this.name = "FakeModelGatewayError";
  }
}

/** The append-only digest of a conversation. */
export function conversationDigest(messages: readonly Current_ModelMessage[]): string {
  return canonicalDigest(messages);
}
const usageOf = (usage: Current_ModelUsageV2 | undefined): Current_ModelUsageV2 =>
  usage ?? { inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 200 };

/**
 * A gateway that answers each call with the next scripted turn. `tools` are the run's
 * offered tool names; `calls` records every call it received, valid or not.
 */
export function createFakeModelGateway(
  script: readonly FakeTurn[],
  options: { readonly tools: readonly string[] },
) {
  const turns = [...script];
  const calls: unknown[] = [];
  const recorded = new Map<string, string>();
  let sequence = 0;
  const result = (value: Current_ModelResultV2): Current_ModelResultV2 => {
    if (!validateCurrentDefinition("ModelResultV2", value)) throw Error("FAKE_RESULT_INVALID");
    return Object.freeze(value);
  };
  const empty = (outcome: Current_ModelTurnOutcome, retryAfterMs: number | null = null) =>
    result({
      schemaVersion: 2,
      outcome,
      message: null,
      usage: null,
      prefixDigest: null,
      traceRef: null,
      retryAfterMs,
    });
  async function modelTurn(request: {
    readonly runId: string;
    readonly call: unknown;
  }): Promise<Current_ModelResultV2> {
    calls.push(request.call);
    if (
      typeof request.runId !== "string" ||
      !validateCurrentDefinition("ModelCallV2", request.call)
    )
      throw new FakeModelGatewayError("MODEL_CALL_INVALID");
    const call = request.call as Current_ModelCallV2;
    const messages = call.messages;
    const last = messages[messages.length - 1]!;
    const before = messages.slice(0, -1);
    const expected = recorded.get(request.runId) ?? null;
    const prefixOk =
      last.role === "user" &&
      (call.turn === 1
        ? call.prefixDigest === null && messages.length === 1 && expected === null
        : call.prefixDigest !== null &&
          call.prefixDigest === conversationDigest(before) &&
          call.prefixDigest === expected);
    if (!prefixOk) return empty("prefix_mismatch");
    const next = turns.shift();
    if (!next) throw new FakeModelGatewayError("SCRIPT_EXHAUSTED");
    if ("outcome" in next) return empty(next.outcome, next.retryAfterMs ?? null);
    const uses = next.reply.content.filter((block) => block.type === "tool_use");
    if (
      uses.length > 4 ||
      uses.some((u) => !options.tools.includes(u.name)) ||
      (call.final && uses.length)
    )
      return empty("invalid_output");
    const digest = conversationDigest([...messages, next.reply]);
    recorded.set(request.runId, digest);
    sequence += 1;
    return result({
      schemaVersion: 2,
      outcome: uses.length ? "tool_use" : "end_turn",
      message: next.reply,
      usage: usageOf(next.usage),
      prefixDigest: digest,
      traceRef: { kind: "model_call", id: `fake_call_${sequence}` },
      retryAfterMs: null,
    });
  }
  const gateway: ModelTurnGateway & {
    readonly calls: readonly unknown[];
    readonly remaining: () => number;
  } = Object.freeze({ modelTurn, calls, remaining: () => turns.length });
  return gateway;
}
