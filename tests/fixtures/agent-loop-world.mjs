// Build order PR 11: an in-memory stand-in for one agent run's SQL (migration agent-runs) and
// the broker's turn fence, so tests/agent-loop.test.mjs drives the real runner
// (packages/work/src/loop/runner.ts) through every branch without PostgreSQL. It follows the
// definers' rules closely enough for the runner (the turn and attempt order, the tool-call
// begin, finish and replay, the questions, the wait and the resume lease, the hold and the
// booking at the worst case when uncertain); lab:agent-loop proves the real definers.
import { createHash } from "node:crypto";
import { validateCurrentDefinition } from "../../packages/contracts/src/validation.ts";
import { loopEntry } from "../../packages/policy/src/loop-catalogue.ts";
import { routedSystemTextDigest } from "../../packages/policy/src/loop-prompts.ts";
import { toolEntry } from "../../packages/policy/src/tool-catalogue.ts";
import { routedRunCaps } from "../../packages/work/src/loop/admission.ts";
import { conversationDigest, messageDigest } from "../../packages/work/src/loop/conversation.ts";

export const ids = Object.freeze({
  organization: "org_o",
  workspace: "ws_w",
  run: "00000000-0000-4000-8000-0000000000aa",
  task: "task_parent",
  child: "00000000-0000-4000-8000-0000000000c1",
  envelope: "00000000-0000-4000-8000-0000000000e1",
  installation: "00000000-0000-4000-8000-0000000000f1",
  agent: "agent_00000000-0000-4000-8000-0000000000f2",
  store: "store_lab",
  connection: "connection_lab",
  requester: "person_a",
  membership: "membership_a",
  lease: "00000000-0000-4000-8000-000000000101",
});
const usd8 = (units12) => (units12 + 9_999n) / 10_000n;
const text8 = (u8) => `${u8 / 100_000_000n}.${String(u8 % 100_000_000n).padStart(8, "0")}`;
const parse8 = (t) => {
  const [w, f] = t.split(".");
  return BigInt(w) * 100_000_000n + BigInt(f);
};
export const objectiveText = "Tidy the summer collection's product titles";

/**
 * One run's world. `script(call)` answers each send: {outcome, message?, usage?,
 * retryAfterMs?}, or {outcome: "lost"} (the broker's reply is lost after the close
 * committed: the step must read what SQL recorded). With `brokerSays: "uncertain"` the
 * broker answers uncertain whatever SQL recorded (its close's result was lost); with
 * {outcome: "open", polls} the close never committed: the fence stays open (live for
 * `polls` settles, then expired and booked as uncertain). `handlers` are the composed
 * tools; `authority(tool, input)` decides each call ("allowed" by default).
 */
export function agentWorld({
  model = "claude_sonnet_5_5",
  effort = "low",
  tools = ["inbox.ask", "products.read"],
  script,
  authority = async () => "allowed",
  turnLimit,
  holdUsd,
  turnCostUsd = "0.01000000",
  wallTimeMs = 1_800_000,
  activeMs = 0,
  leaseLeftMs = 1_800_000,
} = {}) {
  const entry = loopEntry(2, model, effort);
  const caps = routedRunCaps(entry);
  const now = { ms: Date.UTC(2026, 9, 24, 12) };
  const db = {
    run: {
      status: "queued",
      startedAt: null,
      tools: [...tools],
      turnLimit: turnLimit ?? caps.turnLimit,
      hold8: parse8(holdUsd ?? caps.holdUsd),
      worst8: parse8(caps.worstCaseTurnUsd),
      booked8: 0n,
      overflow8: 0n,
      turnsTaken: 0,
      toolCallsTaken: 0,
      questionsAsked: 0,
      questionsLimit: 2,
      tainted: false,
      prefixDigest: null,
      questionId: null,
      endedReason: null,
    },
    lease: {
      leaseId: ids.lease,
      generation: 1,
      released: false,
      expiresAtMs: now.ms + leaseLeftMs,
    },
    leases: 1,
    // The run's active time (waits excluded): a test may move it on between steps.
    activeMs,
    stopped: false,
    turns: [],
    calls: [],
    toolCalls: new Map(),
    questions: [],
    sends: [],
    sequences: new Map(),
    fences: new Map(),
    dispatched: [],
    decisions: [],
    sleeps: [],
    failNextLease: false,
  };
  const turnCost8 = parse8(turnCostUsd);
  const state = () => ({
    runId: ids.run,
    status: db.run.status,
    kind: "routed",
    taskId: ids.task,
    childTaskId: ids.child,
    envelopeId: ids.envelope,
    installationId: ids.installation,
    agentPrincipalId: ids.agent,
    storeId: ids.store,
    connectionId: ids.connection,
    requesterPrincipalId: ids.requester,
    requesterMembershipId: ids.membership,
    releaseId: "morrow.listings",
    systemTextDigest: routedSystemTextDigest,
    tools: Object.freeze([...db.run.tools]),
    catalogueVersion: 2,
    model,
    effort,
    turnLimit: db.run.turnLimit,
    toolCallsPerTurn: 4,
    toolCallsPerRun: 40,
    questionsLimit: db.run.questionsLimit,
    maxInputTokens: 64000,
    maxOutputTokens: entry.maxOutputTokens,
    wallTimeMs,
    holdUsd: text8(db.run.hold8),
    worstCaseTurnUsd: text8(db.run.worst8),
    bookedUsd: text8(db.run.booked8),
    overflowUsd: text8(db.run.overflow8),
    turnsTaken: db.run.turnsTaken,
    toolCallsTaken: db.run.toolCallsTaken,
    questionsAsked: db.run.questionsAsked,
    activeMs: db.activeMs,
    leaseExpiresAtMs: db.lease.expiresAtMs,
    databaseNowMs: now.ms,
    tainted: db.run.tainted,
    prefixDigest: db.run.prefixDigest,
  });
  const running = () => db.run.status === "running";
  const book = (cost8) => {
    const left = db.run.hold8 - db.run.booked8;
    const booked = cost8 < left ? cost8 : left > 0n ? left : 0n;
    db.run.booked8 += booked;
    db.run.overflow8 += cost8 - booked;
  };
  const end = (status, reason) => {
    db.run.status = status;
    db.run.endedReason = reason;
    db.lease.released = true;
    for (const q of db.questions) if (q.status === "open") q.status = "cancelled";
  };
  const loop = {
    async start() {
      if (db.run.status === "queued") {
        const outcome = db.run.startedAt === null ? "started" : "resumed";
        db.run.status = "running";
        db.run.startedAt ??= now.ms;
        return { outcome, status: "running" };
      }
      if (db.run.status === "running" || db.run.status === "waiting")
        return { outcome: db.run.status, status: db.run.status };
      return { outcome: "ended", status: db.run.status };
    },
    async state() {
      return Object.freeze(state());
    },
    async objective() {
      return objectiveText;
    },
    async conversation() {
      return Object.freeze(
        db.turns.map((t) =>
          Object.freeze({
            turn: t.turn,
            attempt: t.attempt,
            final: t.final,
            budgetMs: t.budgetMs,
            input: structuredClone(t.input),
            inputDigest: t.inputDigest,
            output: t.output === null ? null : structuredClone(t.output),
            outcome: t.outcome,
            toolResults: Object.freeze(structuredClone(t.toolResults)),
            prefixDigestAfter: t.prefixAfter,
          }),
        ),
      );
    },
    async answers() {
      return Object.freeze(
        db.questions
          .filter((q) => q.status === "answered")
          .map((q) => Object.freeze({ toolUseId: q.toolUseId, answer: q.answer })),
      );
    },
    async turnOpen({ turn, attempt, final, budgetMs, inputCanonical, inputDigest, untrusted }) {
      if (!running()) return { outcome: "run_inactive" };
      if (!Number.isSafeInteger(budgetMs) || budgetMs < 1000 || budgetMs > 600_000)
        return { outcome: "invalid" };
      // The same input and caps again is opened_before; the caps are the attempt's, fixed here.
      const found = db.turns.find((t) => t.turn === turn && t.attempt === attempt);
      if (found)
        return {
          outcome:
            found.inputDigest === inputDigest &&
            found.final === final &&
            found.budgetMs === budgetMs
              ? "opened_before"
              : "conflict",
        };
      if (attempt === 1) {
        if (turn !== db.run.turnsTaken + 1) return { outcome: "invalid" };
        if (turn > db.run.turnLimit) return { outcome: "stop", reason: "turn_limit" };
      } else if (
        turn !== db.run.turnsTaken ||
        !db.turns.some((t) => t.turn === turn && t.attempt === 1 && t.outcome === "uncertain")
      )
        return { outcome: "invalid" };
      if (db.run.overflow8 > 0n || db.run.hold8 - db.run.booked8 < db.run.worst8)
        return { outcome: "stop", reason: "cost_budget" };
      // SQL derives the final turn itself (nextTurn's rule) and compares it with the code's.
      if (
        final !== (turn >= db.run.turnLimit || db.run.hold8 - db.run.booked8 < 2n * db.run.worst8)
      )
        return { outcome: "invalid" };
      if ((await messageDigest(JSON.parse(inputCanonical))) !== inputDigest)
        throw Error("WORLD_INPUT_DIGEST");
      db.turns.push({
        turn,
        attempt,
        final,
        budgetMs,
        input: JSON.parse(inputCanonical),
        inputDigest,
        output: null,
        outcome: null,
        toolResults: [],
        prefixAfter: null,
      });
      if (attempt === 1) db.run.turnsTaken = turn;
      db.run.tainted ||= untrusted;
      return { outcome: "opened" };
    },
    async turnSettle(turn, attempt) {
      if (!running()) return { outcome: "run_inactive" };
      const t = db.turns.find((x) => x.turn === turn && x.attempt === attempt);
      if (!t) return { outcome: "invalid" };
      // An open fence: live for its polls, then expired and booked at the worst case.
      let openCall = "none";
      for (const [key, fence] of db.fences) {
        if (fence.polls > 0) {
          fence.polls -= 1;
          openCall = "live";
          continue;
        }
        db.fences.delete(key);
        const [ft, fa] = key.split(".").map(Number);
        const row = db.turns.find((x) => x.turn === ft && x.attempt === fa);
        book(db.run.worst8);
        if (row.outcome === null) row.outcome = "uncertain";
      }
      return {
        outcome: "found",
        turnOutcome: t.outcome,
        openCall,
        lastSequence: db.sequences.get(turn + "." + attempt) ?? 0,
      };
    },
    async toolBegin({ turn, ordinal, toolUseId, tool, inputDigest }) {
      if (!running()) return { outcome: "run_inactive" };
      const k = toolEntry(tool);
      const pair = { capabilityId: k.capabilityId, verb: k.verb, replayClass: k.replayClass };
      const c = db.toolCalls.get(toolUseId);
      if (c) {
        if (
          c.turn !== turn ||
          c.ordinal !== ordinal ||
          c.tool !== tool ||
          c.inputDigest !== inputDigest
        )
          return { outcome: "invalid" };
        // An unfinished uncounted call is refused again (never resumed), as SQL does.
        if (c.outcome === null && !c.counted)
          return {
            outcome: "refuse",
            refusal: db.run.tools.includes(tool) ? "tool_call_limit" : "not_offered",
            ...pair,
          };
        if (c.outcome === null) return { outcome: "resumed", ...pair };
        return {
          outcome: "replay",
          ...pair,
          recordedOutcome: c.outcome,
          recordedRefusal: c.refusal,
          record: c.record,
          resultDigest: c.resultDigest,
        };
      }
      const refusal = !db.run.tools.includes(tool)
        ? "not_offered"
        : ordinal >= 4 || db.run.toolCallsTaken >= 40
          ? "tool_call_limit"
          : null;
      db.toolCalls.set(toolUseId, {
        turn,
        ordinal,
        tool,
        inputDigest,
        counted: refusal === null,
        outcome: null,
        refusal: null,
        record: null,
        resultDigest: null,
      });
      if (refusal === null) db.run.toolCallsTaken += 1;
      return refusal === null
        ? { outcome: "begun", ...pair }
        : { outcome: "refuse", refusal, ...pair };
    },
    async toolFinish({ toolUseId, outcome, refusal, result, resultDigest, record, untrusted }) {
      const c = db.toolCalls.get(toolUseId);
      if (!c) return "invalid";
      if (c.outcome !== null)
        return c.outcome === outcome && c.resultDigest === resultDigest ? "replay" : "conflict";
      if (!running()) return "run_inactive";
      // run_tool_calls_counted: an uncounted call finishes only refused with its code.
      if (
        !c.counted &&
        !(outcome === "refused" && ["not_offered", "tool_call_limit"].includes(refusal))
      )
        throw Error("WORLD_UNCOUNTED_CALL_FINISHED");
      if (createHash("sha256").update(result).digest("hex") !== resultDigest) return "invalid";
      Object.assign(c, { outcome, refusal, record, resultDigest });
      const t = db.turns
        .filter((x) => x.turn === c.turn && x.outcome === "tool_use")
        .sort((a, b) => b.attempt - a.attempt)[0];
      t.toolResults.push({ type: "tool_result", toolUseId, outcome, content: result });
      db.run.tainted ||= untrusted;
      return "finished";
    },
    async questionAsk(toolUseId, question, choicesCanonical) {
      if (!running()) return { outcome: "run_inactive" };
      const c = db.toolCalls.get(toolUseId);
      if (!c || c.tool !== "inbox.ask" || c.outcome !== null) return { outcome: "invalid" };
      const q = db.questions.find((x) => x.toolUseId === toolUseId);
      if (q) return { outcome: "replay", questionId: q.id };
      if (
        db.run.questionsAsked >= db.run.questionsLimit ||
        db.questions.some((x) => x.status === "open")
      )
        return { outcome: "question_limit" };
      const id = "00000000-0000-4000-8000-00000000090" + (db.questions.length + 1);
      db.questions.push({
        id,
        toolUseId,
        question,
        choices: JSON.parse(choicesCanonical),
        status: "open",
        answer: null,
      });
      db.run.questionsAsked += 1;
      return { outcome: "asked", questionId: id };
    },
    async wait() {
      if (!running()) return { outcome: "run_inactive" };
      const q = [...db.questions].reverse().find((x) => x.status === "open");
      if (!q) return { outcome: "invalid" };
      db.run.status = "waiting";
      db.run.questionId = q.id;
      db.lease.released = true;
      return { outcome: "waiting", questionId: q.id };
    },
    async finish(reason) {
      if (["succeeded", "failed", "cancelled"].includes(db.run.status))
        return { outcome: "ended", status: db.run.status };
      const status =
        reason === "completed"
          ? "succeeded"
          : ["stopped", "lease_ended", "switch_off", "task_closed", "mandate_ended"].includes(
                reason,
              )
            ? "cancelled"
            : "failed";
      end(status, reason);
      return { outcome: "ended", status };
    },
  };
  const entered = () =>
    Object.freeze({
      leaseId: db.lease.leaseId,
      generation: db.lease.generation,
      organizationId: ids.organization,
      workspaceId: ids.workspace,
      kind: "run",
      subjectId: db.leases === 1 ? ids.run : ids.run + ":r" + (db.leases - 1),
      storeId: ids.store,
      connectionId: ids.connection,
      installationId: ids.installation,
      initiatorPrincipalId: ids.requester,
      initiatorMembershipId: ids.membership,
      expiresAtMs: db.lease.expiresAtMs,
    });
  const result = (
    outcome,
    message = null,
    usage = null,
    prefixDigest = null,
    retryAfterMs = null,
  ) =>
    JSON.stringify({
      schemaVersion: 2,
      outcome,
      message: outcome === "end_turn" || outcome === "tool_use" ? message : null,
      usage,
      prefixDigest: outcome === "end_turn" || outcome === "tool_use" ? prefixDigest : null,
      traceRef: {
        kind: "model_call",
        id: "00000000-0000-4000-8000-00000000c0" + String(db.calls.length).padStart(2, "0"),
      },
      retryAfterMs,
    });
  const ports = {
    async lease(ref, body) {
      if (db.failNextLease) {
        db.failNextLease = false;
        return "failed";
      }
      if (db.stopped) return { entered: false, refusal: "stopped" };
      if (
        ref.leaseId !== db.lease.leaseId ||
        ref.generation !== db.lease.generation ||
        db.lease.released
      )
        return { entered: false, refusal: "lease_ended" };
      const lease = entered();
      const step = Object.freeze({
        lease,
        loop,
        delegationFacts: async () => null,
        run: Object.freeze({ billingFacts: async () => ({}) }),
      });
      return { entered: true, lease, value: await body(step) };
    },
    async resolveLease() {
      if (!["queued", "running", "waiting"].includes(db.run.status)) return null;
      return Object.freeze({
        leaseId: db.lease.leaseId,
        generation: db.lease.generation,
        status: db.run.status,
      });
    },
    async modelTurn(leaseId, generation, callJson, budgetMs) {
      const call = JSON.parse(callJson);
      db.sends.push(Object.freeze({ call, budgetMs }));
      if (!validateCurrentDefinition("ModelCallV2", call)) throw Error("BROKER_HELD");
      if (
        db.stopped ||
        leaseId !== db.lease.leaseId ||
        generation !== db.lease.generation ||
        !running()
      )
        throw Error("BROKER_HELD");
      const row = db.turns.find((t) => t.turn === call.turn && t.attempt === call.attempt);
      // The fence takes the attempt as opened: its caps too (agent_turn_begin's turn_state).
      if (!row || row.outcome !== null || row.final !== call.final || row.budgetMs !== budgetMs)
        throw Error("BROKER_HELD");
      const prefix = call.turn === 1 ? null : await conversationDigest(call.messages.slice(0, -1));
      if (prefix !== call.prefixDigest || prefix !== db.run.prefixDigest)
        return result("prefix_mismatch");
      if ((await messageDigest(call.messages.at(-1))) !== row.inputDigest)
        throw Error("BROKER_HELD");
      const key = call.turn + "." + call.attempt;
      db.sequences.set(key, call.sequence);
      const reply = await script(Object.freeze({ ...call, run: state() }));
      if (reply.outcome === "not_sent")
        return result("not_sent", null, null, null, reply.retryAfterMs ?? 1000);
      if (reply.outcome === "open") {
        // The close never committed: the fence stays open; the broker says uncertain.
        db.fences.set(key, { polls: reply.polls ?? 0 });
        return result("uncertain");
      }
      db.calls.push({
        turn: call.turn,
        attempt: call.attempt,
        sequence: call.sequence,
        outcome: reply.outcome,
      });
      const lost = reply.outcome === "lost";
      const outcome = lost ? reply.recorded : reply.outcome;
      const message = outcome === "end_turn" || outcome === "tool_use" ? reply.message : null;
      const counted = !["spend_limit", "not_sent", "input_over_cap"].includes(outcome);
      if (counted) book(outcome === "uncertain" ? db.run.worst8 : (reply.cost8 ?? turnCost8));
      row.outcome = outcome;
      row.output = message;
      if (message !== null) {
        row.prefixAfter = await conversationDigest([...call.messages, message]);
        db.run.prefixDigest = row.prefixAfter;
      }
      if (lost) throw Error("BROKER_HELD");
      if (reply.brokerSays === "uncertain") return result("uncertain");
      const usage =
        message === null && outcome === "uncertain"
          ? null
          : { inputTokens: 1200, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 300 };
      return result(outcome, message, outcome === "uncertain" ? null : usage, row.prefixAfter);
    },
    tools: null,
    authority: {
      async decide(step, run, tool, input) {
        db.decisions.push(tool.name);
        return authority(tool, input, run, step);
      },
    },
    now: () => now.ms,
    sleep: async (ms) => {
      db.sleeps.push(ms);
    },
  };
  /** The requester's answer (cmd_agent_run_answer): the resume lease, the run queued. */
  function answer(text) {
    const q = db.questions.find((x) => x.id === db.run.questionId && x.status === "open");
    if (!q || db.run.status !== "waiting") return false;
    q.status = "answered";
    q.answer = text;
    db.leases += 1;
    db.lease = {
      leaseId: "00000000-0000-4000-8000-00000000010" + db.leases,
      generation: 1,
      released: false,
      expiresAtMs: now.ms + 1_800_000,
    };
    db.run.status = "queued";
    db.run.questionId = null;
    return true;
  }
  /** Durable steps: each name runs once and its (JSON) result is replayed; answers by hook. */
  function durable({ onWait } = {}) {
    const results = new Map();
    const names = [];
    return {
      names,
      results,
      async do(name, body) {
        if (results.has(name)) return structuredClone(results.get(name));
        const value = await body();
        if (JSON.stringify(value) === undefined) throw Error("WORLD_STEP_RESULT");
        names.push(name);
        results.set(name, structuredClone(value));
        return value;
      },
      async waitForAnswer(name, timeoutMs) {
        names.push(name);
        return (await onWait?.(name, timeoutMs)) ? "event" : "timeout";
      },
    };
  }
  return { db, ports, answer, durable, state, entry, caps, now, text8, usd8 };
}
/** An assistant reply with text and tool calls. */
export function reply(text, ...uses) {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const [id, name, input] of uses) content.push({ type: "tool_use", id, name, input });
  return { role: "assistant", content };
}
export const params = Object.freeze({
  schemaVersion: 1,
  workflow: "agent-run@1",
  organizationId: ids.organization,
  workspaceId: ids.workspace,
  runId: ids.run,
});
