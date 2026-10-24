import type {
  Current_AgentRunParams,
  Current_AssistantModelMessage,
  Current_ModelResultV2,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { nextTurn, type LoopEntry } from "@morrow/policy/loop-catalogue";
import { checkToolInput, toolEntry } from "@morrow/policy/tool-catalogue";
import { modelCallBudgetMs } from "../../../identity/src/broker-protocol.js";
import { canonicalJson, sha256Hex } from "../digest.js";
import type { LeaseRef, LeaseStep, LeaseStepResult } from "../runtime/leases.js";
import { idsInScope, type ToolAuthority } from "./authority.js";
import {
  firstTurnInput,
  messageDigest,
  modelCall,
  nextTurnInput,
  readTagsOf,
  renderToolResult,
  turnMessages,
  untrustedSourceOf,
} from "./conversation.js";
import type {
  AgentRunEndReason,
  AgentRunState,
  ConversationRow,
  RecordKind,
  RecordedTurnOutcome,
  ToolCallOutcome,
  ToolRefusal,
} from "./steps.js";
import type { ToolDispatch, ToolHandlers } from "./tools.js";

// AgentRunWorkflow's logic (build order PR 11; ADR-0027 items 1, 2, 4-7), independent of
// Cloudflare so the unit tests and the PostgreSQL lab drive the same code the orchestrator
// deploys. One durable job runner for every agent; this migration admits routed runs only.
// Durable steps carry ids and codes only (ADR-0027 item 7: the request, the conversation and
// tool results stay inside one step, in memory, and in run_turns). Every step re-enters the
// run lease, so a stop, a removed member or an ended lease stops the run at its next step.
//   start      the run's current lease (agent_run_resume_lease, ids only), entered:
//              queued -> running (agent_run_start).
//   turn-n-a   one model turn: the caps in code first (the turn limit, the hold left
//              against the entry's worst-case turn and the final turn, nextTurn; the wall
//              time and the lease's time against the call's whole budget), then the input
//              stored with its digest (agent_turn_open, which checks them again), then the
//              fence as SQL sees it (agent_turn_settle: a recorded outcome is used as is, a
//              live call is waited for, an expired one is booked as uncertain), then one
//              ModelCall@2 through the broker's modelTurn (a throttle resends the attempt
//              with the next sequence). The reply is validated with the generated contract
//              (the strict tool_use shapes the run was given), its tools must be offered and
//              a final turn must call none: anything else ends the run invalid_output. An
//              uncertain attempt 1 is sent again at most once, as attempt 2; an uncertain
//              attempt 2 ends the run.
//   tool-n-k   one tool call (ADR-0027 item 2): lease re-entry; replay of a recorded call;
//              validation with the full ToolInput definition (invalid_input goes back to the
//              model); ids in the run's scope; the authority decision in code; dispatch
//              through the tool's handler (a resumed read runs again, an internal write
//              returns its first record); the result as wrapped data (8 KiB) appended to the
//              turn's tool results.
//   wait-q     after a turn that asked the requester (inbox.ask): running -> waiting, the
//              lease released; then answer-q-i (the durable wait for the answer event, an
//              hour at a time) and resume-q-i (the resume lease the answer opened), for at
//              most the 72 hours a question stays open. Unanswered, the Workflow ends and
//              the workspace's stale close ends the run (question_unanswered).
//   finish     the end reason code derived (never model text): agent_run_finish.

/** The durable step options the orchestrator gives every step. */
export class AgentRunRetry extends Error {
  constructor(readonly code: string) {
    super("AGENT_RUN_RETRY:" + code);
    this.name = "AgentRunRetry";
  }
}
const retry = (code: string) => new AgentRunRetry(code);
export interface AgentRunPorts {
  /** One transaction under the run lease (runLeaseStep over the runtime executor's pool). */
  lease<T>(
    ref: LeaseRef,
    body: (step: LeaseStep) => Promise<T>,
  ): Promise<LeaseStepResult<T> | "failed">;
  /** The open run's current lease reference (agent_run_resume_lease), or null. */
  resolveLease(
    organizationId: string,
    workspaceId: string,
    runId: string,
  ): Promise<LeaseRef | null | "failed">;
  /** RuntimeBroker.modelTurn: a ModelResult@2 string, or a thrown BROKER_HELD. */
  modelTurn(
    leaseId: string,
    generation: number,
    callJson: string,
    budgetMs: number,
  ): Promise<string>;
  readonly tools: ToolHandlers;
  readonly authority: ToolAuthority;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}
export interface AgentDurableSteps {
  do<T>(name: string, body: () => Promise<T>): Promise<T>;
  /** Waits durably for the run's answer event, at most `timeoutMs`. */
  waitForAnswer(name: string, timeoutMs: number): Promise<"event" | "timeout">;
}
export type AgentRunResult =
  | {
      readonly kind: "ended";
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly reason: AgentRunEndReason;
    }
  | { readonly kind: "interrupted"; readonly refusal: string }
  | { readonly kind: "unanswered" };
type TurnStep =
  | {
      readonly kind: "reply";
      readonly outcome: "end_turn" | "tool_use";
      readonly toolUses: readonly { readonly id: string; readonly name: string }[];
    }
  | { readonly kind: "resend" }
  | { readonly kind: "end"; readonly reason: AgentRunEndReason }
  | { readonly kind: "interrupted"; readonly refusal: string };
type ToolStep =
  | {
      readonly kind: "tool";
      readonly outcome: ToolCallOutcome;
      readonly refusal: ToolRefusal | null;
      readonly asked: boolean;
    }
  | { readonly kind: "interrupted"; readonly refusal: string };

export const agentRunTimings = Object.freeze({
  /** At most this many sends of one attempt (a throttle resends with the next sequence). */
  sequences: 8,
  /** The longest wait before a resend after a throttle. */
  maxThrottleWaitMs: 30_000,
  /** Kept free after a turn's whole call budget, for the tool calls and the finish. */
  finishMarginMs: 60_000,
  /** How often an open fence is looked at again, and how long past its budget it may stay. */
  openCallPollMs: 5_000,
  fenceGraceMs: 60_000,
  /** The durable wait for an answer: an hour at a time, for the question's 72 hours. */
  answerCheckMs: 3_600_000,
  answerChecks: 72,
});

/** One entered lease step, or the refusal; a failed transaction retries the durable step. */
async function under<T>(
  ports: AgentRunPorts,
  ref: LeaseRef,
  body: (step: LeaseStep) => Promise<T>,
): Promise<
  | { readonly entered: true; readonly value: T }
  | { readonly entered: false; readonly refusal: string }
> {
  const result = await ports.lease(ref, body);
  if (result === "failed") throw retry("transaction");
  if (!result.entered) return Object.freeze({ entered: false as const, refusal: result.refusal });
  return Object.freeze({ entered: true as const, value: result.value });
}
const interrupted = (refusal: string) => Object.freeze({ kind: "interrupted" as const, refusal });
const end = (reason: AgentRunEndReason) => Object.freeze({ kind: "end" as const, reason });

// numeric(20,8) USD text as 10^-12 USD (the loop catalogue's unit).
function usd12(text: string): bigint {
  const m = /^(0|[1-9][0-9]{0,11})\.([0-9]{8})$/.exec(text);
  if (!m) throw retry("amount");
  return BigInt(m[1]!) * 10n ** 12n + BigInt(m[2]!) * 10n ** 4n;
}
/** The run's entry as its SQL facts pin it (the worst-case turn the hold is sized from). */
function entryOf(run: AgentRunState): LoopEntry {
  return Object.freeze({
    catalogueVersion: run.catalogueVersion,
    status: "active" as const,
    model: run.model,
    effort: run.effort,
    maxOutputTokens: run.maxOutputTokens,
    expectedOutputTokens: 0,
    worstCaseTurnUsd12: usd12(run.worstCaseTurnUsd),
    expectedFirstTurnUsd12: 0n,
    expectedTurnUsd12: 0n,
    callBudgetMs: modelCallBudgetMs(run.maxOutputTokens),
  });
}
/**
 * The caps of the next turn, in code, before any send (ADR-0027 item 6): the turn limit,
 * the hold left (no overflow, one worst-case turn, a final turn when it cannot also cover a
 * final turn after it), the wall time (waits excluded) and the lease's own time, each
 * against the call's whole budget plus the finish margin.
 */
export function turnCaps(
  run: AgentRunState,
  turn: number,
):
  | { readonly start: true; readonly final: boolean; readonly budgetMs: number }
  | ReturnType<typeof end> {
  const entry = entryOf(run);
  const holdLeft = usd12(run.holdUsd) - usd12(run.bookedUsd);
  if (usd12(run.overflowUsd) > 0n || holdLeft < 0n) return end("cost_budget");
  const next = nextTurn({
    entry,
    turnLimit: run.turnLimit,
    turnsTaken: turn - 1,
    holdLeftUsd12: holdLeft,
  });
  if (!next.start) return end(next.reason);
  const budgetMs = entry.callBudgetMs;
  if (run.activeMs + budgetMs + agentRunTimings.finishMarginMs > run.wallTimeMs)
    return end("wall_time");
  if (run.leaseExpiresAtMs - run.databaseNowMs < budgetMs + agentRunTimings.finishMarginMs)
    return end("wall_time");
  return Object.freeze({ start: true as const, final: next.final, budgetMs });
}
/** The reply of the attempt of turn n that has one. */
function replied(rows: readonly ConversationRow[], turn: number): ConversationRow | null {
  return (
    rows.find((r) => r.turn === turn && (r.outcome === "end_turn" || r.outcome === "tool_use")) ??
    null
  );
}
/**
 * A reply checked against what the run was given (ADR-0027 item 4): the generated contract
 * (each tool_use in its tool's strict shape), only offered tools, unique ids, at most four
 * tool calls, none on a final turn, and the outcome matching the reply. Anything else is
 * invalid_output, which ends the run.
 */
export function checkReply(
  message: unknown,
  outcome: "end_turn" | "tool_use",
  offered: readonly string[],
  final: boolean,
): readonly { readonly id: string; readonly name: string }[] | null {
  if (!validateCurrentDefinition("AssistantModelMessage", message)) return null;
  const uses = (message as Current_AssistantModelMessage).content.filter(
    (b) => b.type === "tool_use",
  ) as { readonly id: string; readonly name: string }[];
  if (
    uses.length > 4 ||
    (final && uses.length > 0) ||
    (outcome === "tool_use") !== uses.length > 0 ||
    new Set(uses.map((u) => u.id)).size !== uses.length ||
    uses.some((u) => !offered.includes(u.name))
  )
    return null;
  return Object.freeze(uses.map((u) => Object.freeze({ id: u.id, name: u.name })));
}
function parseTurnResult(text: unknown): Current_ModelResultV2 | null {
  if (typeof text !== "string" || text.length > 400_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return validateCurrentDefinition("ModelResultV2", value)
    ? (value as Current_ModelResultV2)
    : null;
}
const endOf: Readonly<Partial<Record<RecordedTurnOutcome, AgentRunEndReason>>> = Object.freeze({
  refusal: "refusal",
  invalid_output: "invalid_output",
  spend_limit: "spend_limit",
  provider_error: "provider_error",
  prefix_mismatch: "prefix_mismatch",
  // The reply outgrew the effort's max_tokens, or the conversation the per-turn input cap:
  // both are the turn's own cost caps (ADR-0027 item 6).
  incomplete: "cost_budget",
  input_over_cap: "cost_budget",
});

/** turn-n-a's body: ids and codes out. */
export async function runTurn(
  ports: AgentRunPorts,
  ref: LeaseRef,
  turn: number,
  attempt: number,
): Promise<TurnStep> {
  // 1. The caps in code, then the input stored with its digest (SQL checks them again).
  const opened = await under(ports, ref, async (step) => {
    const run = await step.loop.state();
    if (run === "denied") return interrupted("denied");
    if (run.status !== "running") return interrupted("run_inactive");
    const caps = turnCaps(run, turn);
    if (!("start" in caps)) return caps;
    const rows = await step.loop.conversation();
    let input;
    let usedTools: string[] = [];
    if (turn === 1) {
      const objective = await step.loop.objective();
      if (objective === "denied") return interrupted("denied");
      input = firstTurnInput(objective);
    } else {
      const previous = replied(rows, turn - 1);
      if (!previous || previous.outcome !== "tool_use") throw retry("conversation");
      input = nextTurnInput(previous, await step.loop.answers());
      const output = previous.output as Current_AssistantModelMessage;
      const results = previous.toolResults as readonly { toolUseId: string; outcome: string }[];
      usedTools = output.content
        .filter((b) => b.type === "tool_use")
        .filter((b) => results.some((r) => r.toolUseId === b.id && r.outcome === "ok"))
        .map((b) => (b as { name: string }).name);
    }
    const o = await step.loop.turnOpen({
      turn,
      attempt,
      inputCanonical: JSON.stringify(input),
      inputDigest: await messageDigest(input),
      untrusted: usedTools.some((t) => untrustedSourceOf(t) !== null),
      readTagsCanonical: JSON.stringify(readTagsOf(usedTools, run.storeId)),
    });
    if (o.outcome === "stop") return end(o.reason);
    if (o.outcome === "run_inactive" || o.outcome === "denied") return interrupted(o.outcome);
    if (o.outcome !== "opened" && o.outcome !== "opened_before") throw retry("turn_" + o.outcome);
    return Object.freeze({
      kind: "opened" as const,
      final: caps.final,
      budgetMs: caps.budgetMs,
      tools: run.tools,
    });
  });
  if (!opened.entered) return interrupted(opened.refusal);
  if (opened.value.kind !== "opened") return opened.value;
  const { final, budgetMs, tools } = opened.value;

  // 2. The fence: a recorded outcome is used as is; a live call is waited for (the broker
  //    closes it, or it outlives its budget and is booked as uncertain); otherwise the next
  //    sequence is sent.
  const settle = async (): Promise<
    | { readonly kind: "recorded"; readonly outcome: RecordedTurnOutcome }
    | { readonly kind: "send"; readonly sequence: number }
    | ReturnType<typeof interrupted>
  > => {
    const waits =
      Math.ceil((budgetMs + agentRunTimings.fenceGraceMs) / agentRunTimings.openCallPollMs) + 1;
    for (let wait = 0; wait <= waits; wait++) {
      const s = await under(ports, ref, (step) => step.loop.turnSettle(turn, attempt));
      if (!s.entered) return interrupted(s.refusal);
      const v = s.value;
      if (v.outcome === "run_inactive" || v.outcome === "denied") return interrupted(v.outcome);
      if (v.outcome !== "found") throw retry("settle");
      if (v.turnOutcome !== null)
        return Object.freeze({ kind: "recorded" as const, outcome: v.turnOutcome });
      if (v.openCall === "none")
        return Object.freeze({ kind: "send" as const, sequence: v.lastSequence + 1 });
      await ports.sleep(agentRunTimings.openCallPollMs);
    }
    throw retry("call_open");
  };
  let state = await settle();
  let message: unknown = null;
  let outcome: RecordedTurnOutcome | null = null;
  while (outcome === null) {
    if (state.kind === "interrupted") return state;
    if (state.kind === "recorded") {
      outcome = state.outcome;
      break;
    }
    if (state.sequence > agentRunTimings.sequences) return end("provider_error");
    const sequence = state.sequence;
    const built = await under(ports, ref, async (step) =>
      modelCall({
        turn,
        attempt,
        sequence,
        final,
        messages: turnMessages(await step.loop.conversation(), turn, attempt),
      }),
    );
    if (!built.entered) return interrupted(built.refusal);
    let result: Current_ModelResultV2 | null = null;
    try {
      result = parseTurnResult(
        await ports.modelTurn(ref.leaseId, ref.generation, JSON.stringify(built.value), budgetMs),
      );
    } catch {
      // BROKER_HELD: the gateway refused before any request, or the reply was lost. What SQL
      // recorded decides; with nothing recorded and no call open, the run ends.
      result = null;
    }
    if (result === null) {
      state = await settle();
      if (state.kind === "send") return end("provider_error");
      continue;
    }
    if (result.outcome === "not_sent") {
      const wait = typeof result.retryAfterMs === "number" ? result.retryAfterMs : 2_000;
      await ports.sleep(Math.min(Math.max(wait, 250), agentRunTimings.maxThrottleWaitMs));
      state = Object.freeze({ kind: "send" as const, sequence: sequence + 1 });
      continue;
    }
    if (result.outcome === "prefix_mismatch") return end("prefix_mismatch");
    outcome = result.outcome;
    message = result.message;
  }
  // 3. The outcome, derived in code.
  if (outcome === "end_turn" || outcome === "tool_use") {
    if (message === null) {
      // A recorded reply (a replayed step): read it back from the run's turns.
      const read = await under(ports, ref, async (step) => {
        const rows = await step.loop.conversation();
        return rows.find((r) => r.turn === turn && r.attempt === attempt)?.output ?? null;
      });
      if (!read.entered) return interrupted(read.refusal);
      message = read.value;
    }
    const uses = checkReply(message, outcome, tools, final);
    if (!uses) return end("invalid_output");
    return Object.freeze({ kind: "reply" as const, outcome, toolUses: uses });
  }
  if (outcome === "uncertain")
    return attempt === 1 ? Object.freeze({ kind: "resend" as const }) : end("provider_error");
  return end(endOf[outcome] ?? "provider_error");
}

/** tool-n-k's body: ids and codes out. */
export async function runToolCall(
  ports: AgentRunPorts,
  ref: LeaseRef,
  turn: number,
  ordinal: number,
): Promise<ToolStep> {
  type Prepared =
    | { readonly kind: "done"; readonly step: ToolStep }
    | {
        readonly kind: "finish";
        readonly tool: string;
        readonly toolUseId: string;
        readonly outcome: Exclude<ToolCallOutcome, "ok">;
        readonly refusal: ToolRefusal | null;
      }
    | {
        readonly kind: "dispatch";
        readonly run: AgentRunState;
        readonly tool: string;
        readonly toolUseId: string;
        readonly input: unknown;
        readonly resumed: boolean;
      };
  // 1. Lease re-entry, replay, validation, ids in scope and the authority, in one transaction.
  const prepared = await under(ports, ref, async (step): Promise<Prepared> => {
    const run = await step.loop.state();
    if (run === "denied") return { kind: "done", step: interrupted("denied") };
    if (run.status !== "running") return { kind: "done", step: interrupted("run_inactive") };
    const row = replied(await step.loop.conversation(), turn);
    if (!row || row.outcome !== "tool_use") throw retry("conversation");
    const use = (row.output as Current_AssistantModelMessage).content.filter(
      (b) => b.type === "tool_use",
    )[ordinal] as { id: string; name: string; input: unknown } | undefined;
    if (!use) throw retry("tool_use");
    const begun = await step.loop.toolBegin({
      turn,
      ordinal,
      toolUseId: use.id,
      tool: use.name,
      inputDigest: await sha256Hex(canonicalJson(use.input)),
    });
    if (begun.outcome === "run_inactive" || begun.outcome === "denied")
      return { kind: "done", step: interrupted(begun.outcome) };
    if (begun.outcome === "invalid") throw retry("tool_invalid");
    if (begun.outcome === "replay")
      return {
        kind: "done",
        step: Object.freeze({
          kind: "tool" as const,
          outcome: begun.recordedOutcome,
          refusal: begun.recordedRefusal,
          asked: use.name === "inbox.ask" && begun.recordedOutcome === "ok",
        }),
      };
    const refuse = (
      outcome: Exclude<ToolCallOutcome, "ok">,
      refusal: ToolRefusal | null,
    ): Prepared => ({
      kind: "finish",
      tool: use.name,
      toolUseId: use.id,
      outcome,
      refusal,
    });
    if (begun.outcome === "refuse") return refuse("refused", begun.refusal);
    if (begun.outcome !== "begun" && begun.outcome !== "resumed") throw retry("tool_begin");
    // The catalogue pair SQL recorded is the generated catalogue's (drift-tested); a
    // mismatch denies rather than trusting either.
    const entry = toolEntry(use.name);
    if (
      !entry ||
      entry.capabilityId !== begun.capabilityId ||
      entry.verb !== begun.verb ||
      entry.replayClass !== begun.replayClass
    )
      return refuse("refused", "authority_denied");
    if (!checkToolInput(use.name, use.input).ok) return refuse("invalid_input", "input_invalid");
    if (!idsInScope(use.name, use.input, run)) return refuse("refused", "id_out_of_scope");
    const decision = await ports.authority.decide(
      step,
      run,
      { name: use.name, capabilityId: begun.capabilityId, verb: begun.verb },
      use.input,
    );
    if (decision !== "allowed") return refuse("refused", decision);
    if (!ports.tools.get(use.name)) return refuse("refused", "not_offered");
    // After a crash a computer call's effect is unknown: never run it again.
    if (begun.replayClass === "computer" && begun.outcome === "resumed")
      return refuse("tool_outcome_unknown", null);
    return {
      kind: "dispatch",
      run,
      tool: use.name,
      toolUseId: use.id,
      input: use.input,
      resumed: begun.outcome === "resumed",
    };
  });
  if (!prepared.entered) return interrupted(prepared.refusal);
  const p = prepared.value;
  if (p.kind === "done") return p.step;
  // 2. Dispatch (outside the transaction: a read may take its own time).
  const tool = p.tool;
  let outcome: ToolCallOutcome;
  let refusal: ToolRefusal | null = null;
  let data: unknown = null;
  let record: { readonly kind: RecordKind; readonly id: string } | null = null;
  let untrusted = false;
  let asked = false;
  if (p.kind === "finish") {
    outcome = p.outcome;
    refusal = p.refusal;
  } else {
    const result: ToolDispatch | "interrupted" = await ports.tools.get(p.tool)!.dispatch({
      run: p.run,
      toolUseId: p.toolUseId,
      input: p.input,
      resumed: p.resumed,
      async lease<T>(body: (step: LeaseStep) => Promise<T>) {
        const r = await under(ports, ref, body);
        return r.entered ? r.value : ("interrupted" as const);
      },
    });
    if (result === "interrupted") return interrupted("lease");
    if (result.outcome === "ok") {
      outcome = "ok";
      data = result.data;
      record = result.record;
      untrusted = result.untrusted;
      asked = result.asked === true;
    } else if (result.outcome === "refused") {
      outcome = "refused";
      refusal = result.refusal;
    } else outcome = "tool_outcome_unknown";
  }
  // 3. The result as wrapped data, at most 8 KiB, then the record.
  let text = renderToolResult({ tool, outcome, refusal, data });
  if (text === null) {
    outcome = "refused";
    refusal = "result_too_large";
    record = null;
    untrusted = false;
    asked = false;
    text = renderToolResult({ tool, outcome, refusal, data: null })!;
  }
  const finished = await under(ports, ref, async (step) =>
    step.loop.toolFinish({
      toolUseId: p.toolUseId,
      outcome,
      refusal,
      result: text,
      resultDigest: await sha256Hex(text),
      record,
      untrusted,
    }),
  );
  if (!finished.entered) return interrupted(finished.refusal);
  if (finished.value === "run_inactive" || finished.value === "denied")
    return interrupted(finished.value);
  if (finished.value !== "finished" && finished.value !== "replay")
    throw retry("finish_" + finished.value);
  return Object.freeze({ kind: "tool" as const, outcome, refusal, asked });
}

/** The run's start (or a restart of a lost first step): ids and codes out. */
async function startRun(
  ports: AgentRunPorts,
  params: Current_AgentRunParams,
): Promise<
  | {
      readonly kind: "started";
      readonly leaseId: string;
      readonly generation: number;
    }
  | { readonly kind: "ended"; readonly status: string }
  | ReturnType<typeof interrupted>
> {
  const ref = await ports.resolveLease(params.organizationId, params.workspaceId, params.runId);
  if (ref === "failed") throw retry("resolve");
  if (ref === null) return interrupted("not_found");
  const r = await under(ports, ref, (step) => step.loop.start());
  if (!r.entered) return interrupted(r.refusal);
  if (r.value.outcome === "denied" || r.value.outcome === "waiting")
    return interrupted(r.value.outcome);
  if (r.value.outcome === "ended")
    return Object.freeze({ kind: "ended" as const, status: r.value.status });
  return Object.freeze({
    kind: "started" as const,
    leaseId: ref.leaseId,
    generation: ref.generation,
  });
}

/**
 * The whole run. `params` is the Workflow's payload (AgentRunParams@1: ids only); the run is
 * also the Workflow's instance id, which the orchestrator checks before calling this.
 */
export async function agentRun(
  ports: AgentRunPorts,
  steps: AgentDurableSteps,
  params: Current_AgentRunParams,
): Promise<AgentRunResult> {
  const started = await steps.do("start", () => startRun(ports, params));
  if (started.kind === "interrupted") return started;
  if (started.kind === "ended")
    return Object.freeze({ kind: "interrupted" as const, refusal: "ended_" + started.status });
  let ref: LeaseRef = Object.freeze({ leaseId: started.leaseId, generation: started.generation });
  let reason: AgentRunEndReason | null = null;
  let questions = 0;
  let turn = 1;
  let attempt = 1;
  while (reason === null) {
    const t = await steps.do("turn-" + turn + "-" + attempt, () =>
      runTurn(ports, ref, turn, attempt),
    );
    if (t.kind === "interrupted") return t;
    if (t.kind === "end") {
      reason = t.reason;
      break;
    }
    if (t.kind === "resend") {
      attempt = 2;
      continue;
    }
    if (t.outcome === "end_turn") {
      reason = "completed";
      break;
    }
    let asked = false;
    for (let k = 0; k < t.toolUses.length; k++) {
      const c = await steps.do("tool-" + turn + "-" + k, () => runToolCall(ports, ref, turn, k));
      if (c.kind === "interrupted") return c;
      asked ||= c.asked;
    }
    if (asked) {
      questions += 1;
      const w = await steps.do("wait-" + questions, () => enterWait(ports, ref));
      if (w.kind === "interrupted") return w;
      let resumed: LeaseRef | null = null;
      for (let i = 1; i <= agentRunTimings.answerChecks && resumed === null; i++) {
        await steps.waitForAnswer("answer-" + questions + "-" + i, agentRunTimings.answerCheckMs);
        const r = await steps.do("resume-" + questions + "-" + i, () => tryResume(ports, params));
        if (r.kind === "ended")
          return Object.freeze({ kind: "interrupted" as const, refusal: "ended_" + r.status });
        if (r.kind === "resumed")
          resumed = Object.freeze({ leaseId: r.leaseId, generation: r.generation });
      }
      if (resumed === null) return Object.freeze({ kind: "unanswered" as const });
      ref = resumed;
    }
    turn += 1;
    attempt = 1;
  }
  return steps.do("finish", () => finishRun(ports, ref, reason!));
}

async function enterWait(
  ports: AgentRunPorts,
  ref: LeaseRef,
): Promise<{ readonly kind: "waiting" } | ReturnType<typeof interrupted>> {
  for (let wait = 0; wait < 200; wait++) {
    const r = await under(ports, ref, (step) => step.loop.wait());
    if (!r.entered) return interrupted(r.refusal);
    if (r.value.outcome === "waiting") return Object.freeze({ kind: "waiting" as const });
    if (r.value.outcome === "call_open") {
      await ports.sleep(agentRunTimings.openCallPollMs);
      continue;
    }
    if (r.value.outcome === "run_inactive" || r.value.outcome === "denied")
      return interrupted(r.value.outcome);
    throw retry("wait_" + r.value.outcome);
  }
  throw retry("wait_call_open");
}
async function tryResume(
  ports: AgentRunPorts,
  params: Current_AgentRunParams,
): Promise<
  | { readonly kind: "resumed"; readonly leaseId: string; readonly generation: number }
  | { readonly kind: "still_waiting" }
  | { readonly kind: "ended"; readonly status: string }
> {
  const ref = await ports.resolveLease(params.organizationId, params.workspaceId, params.runId);
  if (ref === "failed") throw retry("resolve");
  if (ref === null) return Object.freeze({ kind: "still_waiting" as const });
  const r = await under(ports, ref, (step) => step.loop.start());
  if (!r.entered) return Object.freeze({ kind: "still_waiting" as const });
  const v = r.value;
  if (v.outcome === "resumed" || v.outcome === "running" || v.outcome === "started")
    return Object.freeze({
      kind: "resumed" as const,
      leaseId: ref.leaseId,
      generation: ref.generation,
    });
  if (v.outcome === "ended") return Object.freeze({ kind: "ended" as const, status: v.status });
  return Object.freeze({ kind: "still_waiting" as const });
}
async function finishRun(
  ports: AgentRunPorts,
  ref: LeaseRef,
  reason: AgentRunEndReason,
): Promise<AgentRunResult> {
  for (let wait = 0; wait < 200; wait++) {
    const r = await under(ports, ref, (step) => step.loop.finish(reason));
    if (!r.entered) return interrupted(r.refusal);
    if (r.value.outcome === "ended")
      return Object.freeze({ kind: "ended" as const, status: r.value.status, reason });
    if (r.value.outcome === "call_open") {
      await ports.sleep(agentRunTimings.openCallPollMs * 2);
      continue;
    }
    if (r.value.outcome === "denied") return interrupted("denied");
    throw retry("finish_" + r.value.outcome);
  }
  throw retry("finish_call_open");
}
/** AgentRunParams@1, or null (the Workflow's payload is ids only). */
export function parseAgentRunParams(value: unknown): Current_AgentRunParams | null {
  return validateCurrentDefinition("AgentRunParams", value)
    ? (value as Current_AgentRunParams)
    : null;
}
