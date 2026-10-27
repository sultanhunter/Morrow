// A scripted fake of the loop's model gateway (ModelCall@2 and ModelResult@2; ADR-0027 item 4 as
// ADR-0041 item 8 edits it; harness contracts, H6), for the runner's (H7b) and the broker's
// (H7c) tests before the broker's streaming adapter exists. It keeps the contract the real
// broker will keep:
//   - a call is a ModelCall@2 of ids and digests only: it names no message, provider, model,
//     effort, tool list or limit, so the conversation can only come from the context store;
//   - the lease: the call's run and lease generation must be the current lease, and the run must
//     be the one attached to the call's context, or the result is lease_refused and nothing is
//     assembled or sent;
//   - assembly from the store, never from the caller: the epoch's opening, then every row of
//     the epoch through throughSequence, in sequence order. The newest row is the one this call
//     answers (its output still empty, its purpose the call's); every earlier row has its output;
//   - append-only: the digest of everything before the newest row (the epoch's own prefix
//     digest on its first call) must equal the call's expectedPrefixDigest, or the result is
//     prefix_mismatch and nothing is sent; a reply's prefixDigest covers the newest row with the
//     reply as its output, which is what the next call names once the orchestrator records it;
//   - the hard guard: estimated input plus max_tokens above it is input_over_cap, non-terminal;
//   - a reply whose blocks fall outside the strict shapes (an unknown block or tool, a wrong
//     type, a missing or extra key) is invalid_output, a protocol break; a reply whose blocks
//     parse but pass a stored bound of AssistantModelMessage (a text block over 32,000
//     characters, more than 128 blocks or 64 tool calls) is incomplete, never a protocol break
//     (ADR-0041 item 8): booked, never kept as history, and resent with output_cut; a tool_use
//     naming an unoffered tool, or one whose input breaks a limit of its ToolInput definition,
//     is returned: the tool-call step answers it and the model corrects it (there is no final
//     turn);
//   - a compaction call returns its block as compacted;
//   - every result is a ModelResult@2 with the request's tokens per layout section.
// Deterministic: no clock or randomness. Digests are SHA-256 of RFC 8785 text (canonicalDigest).
import type {
  Current_AssistantModelMessage,
  Current_ContextSectionTokens,
  Current_ModelCallPurpose,
  Current_ModelCallV2,
  Current_ModelCompaction,
  Current_ModelContextClearing,
  Current_ModelNotice,
  Current_ModelResultV2,
  Current_ModelTurnOutcome,
  Current_ModelUsageV2,
  Current_UserModelMessage,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { canonicalDigest } from "./review";

/** The loop's model port: one model call of one run, under the run's lease. */
export interface ModelTurnGateway {
  modelTurn(request: { readonly call: unknown }): Promise<Current_ModelResultV2>;
}

/** One row of a fake context log, as run_turns holds it (content columns only). */
export interface FakeContextRow {
  readonly sequence: number;
  readonly epoch: number;
  readonly purpose: Current_ModelCallPurpose;
  readonly notices: readonly Current_ModelNotice[];
  readonly input: Current_UserModelMessage | null;
  readonly output: Current_AssistantModelMessage | null;
  /** null while the call is open; a failed call leaves its row out of the history. */
  readonly outcome: Current_ModelTurnOutcome | null;
}
type Entry =
  | { readonly kind: "opening"; readonly message: Current_UserModelMessage }
  | {
      readonly kind: "row";
      readonly sequence: number;
      readonly purpose: Current_ModelCallPurpose;
      readonly notices: readonly Current_ModelNotice[];
      readonly input: Current_UserModelMessage | null;
      readonly output: Current_AssistantModelMessage | null;
    };

export class FakeContextStoreError extends Error {
  constructor(
    readonly code:
      | "CONTEXT_UNKNOWN"
      | "EPOCH_INVALID"
      | "ROW_INVALID"
      | "OUTPUT_ALREADY_RECORDED"
      | "LEASE_INVALID"
      | "CONTEXT_ATTACHED"
      | "NOT_ATTACHED",
  ) {
    super(code);
    this.name = "FakeContextStoreError";
  }
}

/** The digest of a list of assembled entries (the request prefix the broker would send). */
export function contextPrefixDigest(entries: readonly Entry[]): string {
  return canonicalDigest(entries);
}
const rowEntry = (row: FakeContextRow, output = row.output): Entry => ({
  kind: "row",
  sequence: row.sequence,
  purpose: row.purpose,
  notices: row.notices,
  input: row.input,
  output,
});

/**
 * An in-memory stand-in for the context tables and run leases the broker reads (run_turns,
 * context_epochs, agent_runs' lease generation and the one run attached to each context). The
 * orchestrator's writes are methods; the broker's reads are `lease`, `attachedRun` and
 * `assemble`.
 */
export function createFakeContextStore() {
  const contexts = new Map<
    string,
    { readonly openings: Map<number, Current_UserModelMessage>; readonly rows: FakeContextRow[] }
  >();
  const leases = new Map<string, number>();
  // One writer per context (ADR-0041 item 5; agent_contexts' partial unique index).
  const writers = new Map<string, string>();
  const context = (contextId: string) => {
    const found = contexts.get(contextId);
    if (!found) throw new FakeContextStoreError("CONTEXT_UNKNOWN");
    return found;
  };
  const pending = (contextId: string, sequence: number) => {
    const found = context(contextId);
    const row = found.rows[sequence - 1];
    if (!row) throw new FakeContextStoreError("ROW_INVALID");
    if (row.outcome !== null) throw new FakeContextStoreError("OUTPUT_ALREADY_RECORDED");
    return { found, row };
  };
  /**
   * The request for one call, or null when SQL does not hold it as named: the epoch's opening
   * and the epoch's answered rows before throughSequence, then the newest, unanswered row. A row
   * whose call failed (cut at max_tokens, uncertain, refused) is recorded but never history: its
   * turn is resent as a new row.
   */
  const assemble = (
    contextId: string,
    epoch: number,
    throughSequence: number,
  ): {
    readonly prefix: readonly Entry[];
    readonly newest: FakeContextRow;
    readonly prefixDigest: string;
  } | null => {
    const found = contexts.get(contextId);
    const opening = found?.openings.get(epoch);
    const newest = found?.rows[throughSequence - 1];
    if (!found || !opening || !newest || newest.epoch !== epoch || newest.outcome !== null)
      return null;
    const earlier = found.rows.filter((r) => r.epoch === epoch && r.sequence < throughSequence);
    if (earlier.some((r) => r.outcome === null)) return null;
    const prefix: Entry[] = [
      { kind: "opening", message: opening },
      ...earlier.filter((r) => r.output !== null).map((r) => rowEntry(r)),
    ];
    return { prefix, newest, prefixDigest: contextPrefixDigest(prefix) };
  };
  return Object.freeze({
    /** Issues (or re-issues) a run's lease generation; generations only grow. */
    grantLease(runId: string, generation: number): void {
      if (!Number.isInteger(generation) || generation <= (leases.get(runId) ?? 0))
        throw new FakeContextStoreError("LEASE_INVALID");
      leases.set(runId, generation);
    },
    /** Attaches a run to a context as its one writer; another attached run refuses it. */
    attachRun(contextId: string, runId: string): void {
      context(contextId);
      const writer = writers.get(contextId);
      if (writer !== undefined && writer !== runId)
        throw new FakeContextStoreError("CONTEXT_ATTACHED");
      writers.set(contextId, runId);
    },
    /** Detaches a run when it ends or parks without a lease; the context keeps its log. */
    detachRun(contextId: string, runId: string): void {
      if (writers.get(contextId) !== runId) throw new FakeContextStoreError("NOT_ATTACHED");
      writers.delete(contextId);
    },
    /** Opens an epoch with its code-rendered opening; returns the epoch's prefix digest. */
    openEpoch(contextId: string, epoch: number, opening: Current_UserModelMessage): string {
      if (!validateCurrentDefinition("UserModelMessage", opening))
        throw new FakeContextStoreError("ROW_INVALID");
      const found = contexts.get(contextId) ?? { openings: new Map(), rows: [] };
      const last = Math.max(0, ...found.openings.keys());
      if (epoch !== last + 1 || found.rows.some((r) => r.outcome === null))
        throw new FakeContextStoreError("EPOCH_INVALID");
      found.openings.set(epoch, opening);
      contexts.set(contextId, found);
      return contextPrefixDigest([{ kind: "opening", message: opening }]);
    },
    /** Appends a row (the input side of the next call) to the open epoch; returns its sequence. */
    append(
      contextId: string,
      row: {
        readonly epoch: number;
        readonly purpose: Current_ModelCallPurpose;
        readonly notices?: readonly Current_ModelNotice[];
        readonly input: Current_UserModelMessage | null;
      },
    ): number {
      const found = context(contextId);
      const latest = Math.max(...found.openings.keys());
      const notices = row.notices ?? [];
      if (
        row.epoch !== latest ||
        found.rows.some((r) => r.outcome === null) ||
        (row.input !== null && !validateCurrentDefinition("UserModelMessage", row.input)) ||
        notices.length > 8 ||
        notices.some((n) => !validateCurrentDefinition("ModelNotice", n)) ||
        // A turn adds content: its input, or notices (a resume). Only a turn with no answered
        // row before it in its epoch may add nothing, since the opening carries the request.
        (row.purpose === "turn" &&
          row.input === null &&
          notices.length === 0 &&
          found.rows.some((r) => r.epoch === row.epoch && r.output !== null)) ||
        (row.purpose === "compaction" && row.input !== null)
      )
        throw new FakeContextStoreError("ROW_INVALID");
      const sequence = found.rows.length + 1;
      found.rows.push(
        Object.freeze({
          sequence,
          epoch: row.epoch,
          purpose: row.purpose,
          notices: Object.freeze([...notices]),
          input: row.input,
          output: null,
          outcome: null,
        }),
      );
      return sequence;
    },
    /** Records a reply as a row's output (append-only: once). */
    recordOutput(contextId: string, sequence: number, output: Current_AssistantModelMessage): void {
      const { found, row } = pending(contextId, sequence);
      const outcome = output.content.some((block) => block.type === "tool_use")
        ? "tool_use"
        : "end_turn";
      found.rows[sequence - 1] = Object.freeze({ ...row, output, outcome });
    },
    /** Records a call that left no history: a failure, a refusal or a compaction's block. */
    recordOutcome(
      contextId: string,
      sequence: number,
      outcome: Exclude<Current_ModelTurnOutcome, "end_turn" | "tool_use">,
    ): void {
      const { found, row } = pending(contextId, sequence);
      found.rows[sequence - 1] = Object.freeze({ ...row, outcome });
    },
    /** The digest the orchestrator expects before the row at throughSequence. */
    expectedPrefixDigest(contextId: string, epoch: number, throughSequence: number): string {
      const assembled = assemble(contextId, epoch, throughSequence);
      if (!assembled) throw new FakeContextStoreError("ROW_INVALID");
      return assembled.prefixDigest;
    },
    /** Every row of a context, in sequence order (frozen copies). */
    rows(contextId: string): readonly FakeContextRow[] {
      return Object.freeze([...context(contextId).rows]);
    },
    // --- the broker's reads ---
    lease(runId: string): number | null {
      return leases.get(runId) ?? null;
    },
    attachedRun(contextId: string): string | null {
      return writers.get(contextId) ?? null;
    },
    assemble,
    /** The digest once a reply is recorded at the newest row: the next call's prefix. */
    digestWithReply(
      prefix: readonly Entry[],
      newest: FakeContextRow,
      reply: Current_AssistantModelMessage,
    ): string {
      return contextPrefixDigest([...prefix, rowEntry(newest, reply)]);
    },
  });
}
export type FakeContextStore = ReturnType<typeof createFakeContextStore>;

export type FakeTurn =
  | {
      readonly reply: Current_AssistantModelMessage;
      readonly usage?: Current_ModelUsageV2;
      readonly cleared?: Current_ModelContextClearing;
    }
  | { readonly compaction: Current_ModelCompaction; readonly usage?: Current_ModelUsageV2 }
  | {
      readonly outcome: Exclude<Current_ModelTurnOutcome, "end_turn" | "tool_use" | "compacted">;
      readonly usage?: Current_ModelUsageV2;
      readonly retryAfterMs?: number;
    };
export class FakeModelGatewayError extends Error {
  constructor(readonly code: "MODEL_CALL_INVALID" | "SCRIPT_EXHAUSTED" | "SCRIPT_MISMATCH") {
    super(code);
    this.name = "FakeModelGatewayError";
  }
}

const usageOf = (usage: Current_ModelUsageV2 | undefined): Current_ModelUsageV2 =>
  usage ?? { inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 200 };
// A deterministic token estimate: four characters of the JSON text per token.
const estimate = (value: unknown): number => Math.ceil(JSON.stringify(value).length / 4);
// The safety range of tool calls in one reply; code runs 16 a turn and answers the rest.
const maxToolUsesPerReply = 64;
/**
 * AssistantModelMessage's stored bounds (core v1.1; harness-contracts checks they match): the
 * blocks of one reply, a text block's characters, and a reasoning block's text and continuity.
 */
export const replyBounds = Object.freeze({
  blocks: 128,
  toolUses: maxToolUsesPerReply,
  textChars: 32000,
  reasoningChars: 1048576,
});
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const clamp = (value: unknown, length: number): unknown =>
  typeof value === "string" ? value.slice(0, length) : value;
/**
 * How a parsed reply fits the stored message (ADR-0041 item 8). `fits`: a valid
 * AssistantModelMessage within the tool-call range. `over_bound`: every block is in its strict
 * shape, but the reply passes a stored bound (a block's length, the block count, the tool-call
 * range): the outcome is incomplete, booked and resent with output_cut, never a protocol break.
 * `invalid`: a block outside the strict shapes, a protocol break (invalid_output).
 */
export function replyFit(reply: unknown): "fits" | "over_bound" | "invalid" {
  if (
    !isRecord(reply) ||
    Object.keys(reply).sort().join() !== "content,role" ||
    reply.role !== "assistant" ||
    !Array.isArray(reply.content) ||
    reply.content.length < 1
  )
    return "invalid";
  const content: readonly unknown[] = reply.content;
  let over = content.length > replyBounds.blocks;
  let uses = 0;
  for (const block of content) {
    if (!isRecord(block)) return "invalid";
    // Each block is checked in its own shape with its length bounds lifted: a long block is
    // still the block the provider sent.
    const shaped =
      block.type === "text"
        ? validateCurrentDefinition("ModelTextBlock", {
            ...block,
            text: clamp(block.text, replyBounds.textChars),
          })
        : block.type === "reasoning"
          ? validateCurrentDefinition("ModelReasoningBlock", {
              ...block,
              text: clamp(block.text, replyBounds.reasoningChars),
              continuity: clamp(block.continuity, replyBounds.reasoningChars),
            })
          : block.type === "tool_use" && validateCurrentDefinition("ModelToolUseBlock", block);
    if (!shaped) return "invalid";
    if (block.type === "tool_use") uses += 1;
    if (
      (block.type === "text" && (block.text as string).length > replyBounds.textChars) ||
      (block.type === "reasoning" &&
        ((block.text as string).length > replyBounds.reasoningChars ||
          (block.continuity as string).length > replyBounds.reasoningChars))
    )
      over = true;
  }
  if (uses > replyBounds.toolUses) over = true;
  if (over) return "over_bound";
  return validateCurrentDefinition("AssistantModelMessage", reply) ? "fits" : "invalid";
}

/**
 * A gateway that answers each call with the next scripted turn, reading the request from
 * `store`. `systemTokens` and `toolsTokens` stand for the pinned S1 and S2 sections;
 * `hardGuardTokens` and `maxOutputTokens` exercise the hard guard. `calls` records every call
 * it received, valid or not.
 */
export function createFakeModelGateway(
  script: readonly FakeTurn[],
  options: {
    readonly store: FakeContextStore;
    readonly toolsTokens?: number;
    readonly systemTokens?: number;
    readonly hardGuardTokens?: number | null;
    readonly maxOutputTokens?: number;
  },
) {
  const turns = [...script];
  const calls: unknown[] = [];
  let sequence = 0;
  const result = (value: Current_ModelResultV2): Current_ModelResultV2 => {
    if (!validateCurrentDefinition("ModelResultV2", value)) throw Error("FAKE_RESULT_INVALID");
    return Object.freeze(value);
  };
  const empty = (
    outcome: Current_ModelTurnOutcome,
    options: {
      readonly usage?: Current_ModelUsageV2 | null;
      readonly retryAfterMs?: number | null;
      readonly sectionTokens?: Current_ContextSectionTokens | null;
    } = {},
  ) =>
    result({
      schemaVersion: 2,
      outcome,
      message: null,
      usage: options.usage ?? null,
      prefixDigest: null,
      traceRef: null,
      retryAfterMs: options.retryAfterMs ?? null,
      compacted: null,
      cleared: null,
      sectionTokens: options.sectionTokens ?? null,
    });
  async function modelTurn(request: { readonly call: unknown }): Promise<Current_ModelResultV2> {
    calls.push(request.call);
    if (!validateCurrentDefinition("ModelCallV2", request.call))
      throw new FakeModelGatewayError("MODEL_CALL_INVALID");
    const call = request.call as Current_ModelCallV2;
    // The lease names the tenant and the run; the run must be the context's one writer, so a
    // call cannot borrow another run's (or another person's) conversation.
    if (
      options.store.lease(call.runId) !== call.leaseGeneration ||
      options.store.attachedRun(call.contextId) !== call.runId
    )
      return empty("lease_refused");
    const assembled = options.store.assemble(call.contextId, call.epoch, call.throughSequence);
    if (
      !assembled ||
      assembled.newest.purpose !== call.purpose ||
      assembled.prefixDigest !== call.expectedPrefixDigest
    )
      return empty("prefix_mismatch");
    const [opening, ...rows] = assembled.prefix;
    const sectionTokens: Current_ContextSectionTokens = {
      tools: options.toolsTokens ?? 0,
      system: options.systemTokens ?? 0,
      workspace: 0,
      opening: estimate(opening),
      conversation: estimate([...rows, assembled.newest]),
    };
    const input =
      sectionTokens.tools +
      sectionTokens.system +
      sectionTokens.workspace +
      sectionTokens.opening +
      sectionTokens.conversation;
    const guard = options.hardGuardTokens ?? null;
    if (guard !== null && input + (options.maxOutputTokens ?? 32000) > guard)
      return empty("input_over_cap");
    const next = turns.shift();
    if (!next) throw new FakeModelGatewayError("SCRIPT_EXHAUSTED");
    sequence += 1;
    const traceRef = { kind: "model_call" as const, id: `fake_call_${sequence}` };
    if ("outcome" in next)
      return empty(next.outcome, {
        usage: next.usage ?? null,
        retryAfterMs: next.retryAfterMs ?? null,
        sectionTokens,
      });
    if ("compaction" in next) {
      if (call.purpose !== "compaction") throw new FakeModelGatewayError("SCRIPT_MISMATCH");
      return result({
        schemaVersion: 2,
        outcome: "compacted",
        message: null,
        usage: usageOf(next.usage),
        prefixDigest: null,
        traceRef,
        retryAfterMs: null,
        compacted: next.compaction,
        cleared: null,
        sectionTokens,
      });
    }
    if (call.purpose === "compaction") throw new FakeModelGatewayError("SCRIPT_MISMATCH");
    const fit = replyFit(next.reply);
    if (fit === "invalid") return empty("invalid_output", { sectionTokens });
    // A healthy reply past a stored bound: booked like a cut, never kept as history.
    if (fit === "over_bound")
      return empty("incomplete", { usage: usageOf(next.usage), sectionTokens });
    const uses = next.reply.content.filter((block) => block.type === "tool_use");
    return result({
      schemaVersion: 2,
      outcome: uses.length ? "tool_use" : "end_turn",
      message: next.reply,
      usage: usageOf(next.usage),
      prefixDigest: options.store.digestWithReply(assembled.prefix, assembled.newest, next.reply),
      traceRef,
      retryAfterMs: null,
      compacted: null,
      cleared: next.cleared ?? null,
      sectionTokens,
    });
  }
  const gateway: ModelTurnGateway & {
    readonly calls: readonly unknown[];
    readonly remaining: () => number;
  } = Object.freeze({ modelTurn, calls, remaining: () => turns.length });
  return gateway;
}
