import {
  modelCallBudgetMs,
  modelGatewayLimits,
  modelSendTiming,
  modelSendWindowMs,
  modelTurnLimits,
} from "../../../packages/identity/src/broker-protocol.js";
import { generatedLoopCatalogue } from "../../../packages/policy/src/generated/loop-catalogue.js";
import { generatedToolCatalogue } from "../../../packages/policy/src/generated/tool-catalogue.js";
import { loopSystemTexts } from "../../../packages/policy/src/loop-prompts.js";
import { BrokerHold, brokerCapabilities, invokeBrokerMethod, type BrokerVault } from "./capabilities.js";
import type { ResolvedTurnCall, TurnAdapterResult, TurnProvider } from "./claude-turn-adapter.js";
import { jcs, sha256 } from "./model-gateway.js";
import { vaultStatements, type VaultQuery } from "./vault.js";

// RuntimeBroker.modelTurn (build order PR 11; ADR-0027 items 4, 5 and 12): the agent loop's
// provider-neutral turn gateway. Order, each step refusing before the next:
//   1. Both reviewed switches: the model provider (MORROW_MODEL_PROVIDER "anthropic", with the
//      key) and the agent loop (MORROW_AGENT_LOOP "on", with the vault); either off holds the
//      call with MODEL_UNAVAILABLE before any input, database or provider access.
//   2. The closed inputs: a lease UUID and generation, a budget, and ModelCall@2 checked by
//      hand (the broker bundles no validator table): closed keys, bounded blocks, roles that
//      alternate from the person's turn, every tool result answering exactly the previous
//      reply's tool calls in order, and no string PostgreSQL cannot store. A call naming a
//      model, an effort, a tool list, a limit or a provider fails here.
//   3. The conversation is append-only: the digest of every message but the last must be the
//      call's prefixDigest (null on turn 1), else prefix_mismatch before any request.
//   4. The fence, on the vault login (agent_turn_begin): the lease resolves for purpose `model`
//      with every resolve_call check under the stop interlock; the run is running under
//      exactly this lease; the turn's stored input has exactly the last message's digest; the
//      prefix is the run's recorded one; attempt 2 only after an uncertain attempt 1; the
//      last turn the limit allows is final; one call per run is open; the hold covers one
//      more worst-case turn. The same fence again never sends (replay or in_flight). The
//      selection, the offered tools and the system text's digest come from SQL, never the
//      call.
//   5. The call against the run: the system text is the one its digest names; every tool in
//      the conversation is offered; the entry is the generated loop catalogue's and SQL's
//      alike, with an adapter and a credential; the budget holds the entry's whole call.
//   6. The count; over the input cap less a tenth the turn closes input_over_cap, nothing sent.
//   7. One send through the adapter (no retries, no fallback), then the reply checked against
//      the run: only offered tools, at most four calls, none on the final turn; anything else
//      is invalid_output. The close (agent_turn_end) records the outcome and usage, books the
//      cost at the entry's rates (or its worst-case turn when uncertain) against the run's
//      hold, and stores the reply with the conversation's digest after it in the same
//      transaction. If the close cannot commit, the result is uncertain (the open fence is
//      booked at its worst case later) and no reply is returned.
// The result is ModelResult@2: no provider request id, provider model id or raw stop reason;
// traceRef names the call's entry. Every refusal is BROKER_HELD with one fixed log line.

export interface AgentTurnGatewaySeams {
  readonly transaction: <T>(
    vault: Readonly<BrokerVault>,
    budgetMs: number,
    body: (query: VaultQuery) => Promise<T>,
  ) => Promise<T>;
  /** The turn adapter of each provider the loop catalogue names; Claude is the only one. */
  readonly providers: Readonly<Record<string, TurnProvider>>;
  readonly now: () => number;
}
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const hold = (code: ConstructorParameters<typeof BrokerHold>[0]) => new BrokerHold(code);
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keysExactly = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const int = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
function codePointsWithin(v: string, min: number, max: number): boolean {
  if (v.length < min) return false;
  if (v.length <= max && min <= 1) return true;
  if (v.length > 2 * max) return false;
  let n = 0;
  for (const _ of v) if (++n > max) return false;
  return n >= min;
}
const str = (v: unknown, max: number, min = 0): v is string =>
  typeof v === "string" && !v.includes("\u0000") && codePointsWithin(v, min, max);
const encoder = new TextEncoder();
const toolNames: readonly string[] = generatedToolCatalogue.tools.map((t) => t.name);
const sources = [
  "product",
  "inventory",
  "order_summary",
  "support_mail",
  "knowledge_page",
  "artifact",
  "report",
  "upload",
  "sandbox_output",
  "tool_result",
  "message",
];
const toolOutcomes = ["ok", "refused", "invalid_input", "tool_outcome_unknown", "computer_unavailable"];
const recordId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const toolUseId = /^[A-Za-z0-9_-]{1,64}$/;
const continuity = /^[A-Za-z0-9+/=_-]*$/;
function plainJson(v: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return !v.includes("\u0000") && v.length <= 65536;
  if (Array.isArray(v)) return v.length <= 1000 && v.every((x) => plainJson(x, depth + 1));
  if (isObject(v))
    return Object.entries(v).every(([k, x]) => !k.includes("\u0000") && plainJson(x, depth + 1));
  return false;
}
function userBlock(b: unknown): boolean {
  if (!isObject(b)) return false;
  if (b.type === "text") return keysExactly(b, ["type", "text"]) && str(b.text, 32000, 1);
  if (b.type === "data")
    return (
      keysExactly(b, ["type", "source", "sourceId", "text"]) &&
      typeof b.source === "string" &&
      sources.includes(b.source) &&
      (b.sourceId === null || (typeof b.sourceId === "string" && recordId.test(b.sourceId))) &&
      str(b.text, 65536)
    );
  if (b.type === "tool_result")
    return (
      keysExactly(b, ["type", "toolUseId", "outcome", "content"]) &&
      typeof b.toolUseId === "string" &&
      toolUseId.test(b.toolUseId) &&
      typeof b.outcome === "string" &&
      toolOutcomes.includes(b.outcome) &&
      str(b.content, 8192) &&
      encoder.encode(b.content).length <= 8192
    );
  return false;
}
function assistantBlock(b: unknown): boolean {
  if (!isObject(b)) return false;
  if (b.type === "text") return keysExactly(b, ["type", "text"]) && str(b.text, 32000, 1);
  if (b.type === "tool_use")
    return (
      keysExactly(b, ["type", "id", "name", "input"]) &&
      typeof b.id === "string" &&
      toolUseId.test(b.id) &&
      typeof b.name === "string" &&
      toolNames.includes(b.name) &&
      isObject(b.input) &&
      plainJson(b.input)
    );
  if (b.type === "reasoning")
    return (
      keysExactly(b, ["type", "text", "continuity", "redacted"]) &&
      str(b.text, 65536) &&
      typeof b.continuity === "string" &&
      b.continuity.length <= 65536 &&
      continuity.test(b.continuity) &&
      typeof b.redacted === "boolean"
    );
  return false;
}
export interface ModelCallV2 {
  readonly turn: number;
  readonly attempt: number;
  readonly sequence: number;
  readonly final: boolean;
  readonly prefixDigest: string | null;
  readonly messages: readonly { readonly role: string; readonly content: readonly unknown[] }[];
}
/** ModelCall@2, checked by hand (the contract's closed shape, bounds and conversation order). */
export function parseModelCallV2(text: unknown): ModelCallV2 | null {
  if (typeof text !== "string" || encoder.encode(text).length > modelTurnLimits.callMaxBytes) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isObject(v) ||
    !keysExactly(v, ["schemaVersion", "purpose", "turn", "attempt", "sequence", "final", "prefixDigest", "messages"]) ||
    v.schemaVersion !== 2 ||
    v.purpose !== "agent_turn" ||
    !int(v.turn, 1, 16) ||
    !int(v.attempt, 1, 2) ||
    !int(v.sequence, 1, 8) ||
    typeof v.final !== "boolean" ||
    !(v.prefixDigest === null || (typeof v.prefixDigest === "string" && digest.test(v.prefixDigest))) ||
    !Array.isArray(v.messages) ||
    v.messages.length !== 2 * (v.turn as number) - 1 ||
    (v.turn === 1) !== (v.prefixDigest === null)
  )
    return null;
  let previousUses: string[] = [];
  for (let i = 0; i < v.messages.length; i++) {
    const m = v.messages[i];
    const role = i % 2 === 0 ? "user" : "assistant";
    if (
      !isObject(m) ||
      !keysExactly(m, ["role", "content"]) ||
      m.role !== role ||
      !Array.isArray(m.content) ||
      m.content.length < 1 ||
      m.content.length > 32 ||
      !m.content.every(role === "user" ? userBlock : assistantBlock)
    )
      return null;
    if (role === "assistant") {
      const uses = (m.content as Record<string, unknown>[]).filter((b) => b.type === "tool_use");
      if (uses.length < 1 || uses.length > 4) return null;
      previousUses = uses.map((b) => b.id as string);
      if (new Set(previousUses).size !== previousUses.length) return null;
    } else if (i > 0) {
      // A later turn's input is exactly the previous reply's tool results, in its order.
      const results = m.content as Record<string, unknown>[];
      if (
        results.length !== previousUses.length ||
        results.some((b, k) => b.type !== "tool_result" || b.toolUseId !== previousUses[k])
      )
        return null;
    } else if ((m.content as Record<string, unknown>[]).some((b) => b.type === "tool_result")) return null;
  }
  return v as unknown as ModelCallV2;
}
/** The generated loop catalogue's entry at a published or proposed version (SQL decides). */
function entryOf(version: number, model: string, effort: string) {
  const versions: readonly {
    readonly version: number;
    readonly limits: { readonly maxInputTokensPerTurn: number };
    readonly efforts: readonly { readonly key: string; readonly maxOutputTokens: number }[];
    readonly models: readonly { readonly key: string; readonly provider: string; readonly providerModelId: string }[];
  }[] = generatedLoopCatalogue.versions;
  const v = versions.find((x) => x.version === version);
  const m = v?.models.find((x) => x.key === model);
  const e = v?.efforts.find((x) => x.key === effort);
  if (!v || !m || !e) return null;
  return {
    provider: m.provider,
    providerModelId: m.providerModelId,
    maxTokens: e.maxOutputTokens,
    maxInput: v.limits.maxInputTokensPerTurn,
  };
}
type Begun = {
  readonly callId: string;
  readonly model: string;
  readonly effort: string;
  readonly providerModelId: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly tools: readonly string[];
  readonly systemTextDigest: string;
  readonly catalogueVersion: number;
};
type Replay = {
  readonly callId: string;
  readonly outcome: string;
  readonly output: string | null;
  readonly prefixAfter: string | null;
  readonly usage: string | null;
};
const beginNames =
  "call_id,effort_key,max_input_tokens,max_output_tokens,model_key,outcome,provider_model_id,recorded_outcome,recorded_output,recorded_prefix_after,recorded_usage,system_text_digest,tools";
function decodeBegin(rows: readonly Record<string, unknown>[]): { begun: Begun } | { replay: Replay } | string {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || Object.keys(rows[0]).sort().join(",") !== beginNames)
    throw hold("STATE_INVALID");
  const r = rows[0];
  if (r.outcome === "replay") {
    if (
      typeof r.call_id !== "string" ||
      !uuid.test(r.call_id) ||
      typeof r.recorded_outcome !== "string" ||
      (r.recorded_output !== null && typeof r.recorded_output !== "string") ||
      (r.recorded_prefix_after !== null && (typeof r.recorded_prefix_after !== "string" || !digest.test(r.recorded_prefix_after))) ||
      (r.recorded_usage !== null && typeof r.recorded_usage !== "string")
    )
      throw hold("STATE_INVALID");
    return {
      replay: {
        callId: r.call_id,
        outcome: r.recorded_outcome,
        output: r.recorded_output as string | null,
        prefixAfter: r.recorded_prefix_after as string | null,
        usage: r.recorded_usage as string | null,
      },
    };
  }
  if (r.outcome !== "begun") {
    if (typeof r.outcome !== "string") throw hold("STATE_INVALID");
    return r.outcome;
  }
  let tools: unknown;
  try {
    tools = JSON.parse(String(r.tools));
  } catch {
    throw hold("STATE_INVALID");
  }
  if (
    typeof r.call_id !== "string" ||
    !uuid.test(r.call_id) ||
    typeof r.model_key !== "string" ||
    typeof r.effort_key !== "string" ||
    typeof r.provider_model_id !== "string" ||
    typeof r.max_input_tokens !== "string" ||
    !/^[1-9][0-9]{0,4}$/.test(r.max_input_tokens) ||
    typeof r.max_output_tokens !== "string" ||
    !/^[1-9][0-9]{0,4}$/.test(r.max_output_tokens) ||
    typeof r.system_text_digest !== "string" ||
    !digest.test(r.system_text_digest) ||
    !Array.isArray(tools) ||
    !tools.every((t) => typeof t === "string" && toolNames.includes(t))
  )
    throw hold("STATE_INVALID");
  return {
    begun: {
      callId: r.call_id,
      model: r.model_key,
      effort: r.effort_key,
      providerModelId: r.provider_model_id,
      maxInputTokens: Number(r.max_input_tokens),
      maxOutputTokens: Number(r.max_output_tokens),
      tools: Object.freeze(tools as string[]),
      systemTextDigest: r.system_text_digest,
      // The loop catalogue's one version in SQL is the generated catalogue's (drift-tested).
      catalogueVersion: generatedLoopCatalogue.versions[0]?.version ?? 0,
    },
  };
}
/** ModelResult@2 text. */
function turnResult(
  outcome: string,
  message: unknown,
  usage: unknown,
  prefixDigest: string | null,
  callId: string | null,
  retryAfterMs: number | null,
): string {
  const reply = outcome === "end_turn" || outcome === "tool_use";
  return JSON.stringify({
    schemaVersion: 2,
    outcome,
    message: reply ? message : null,
    usage: usage ?? null,
    prefixDigest: reply ? prefixDigest : null,
    traceRef: callId === null ? null : { kind: "model_call", id: callId },
    retryAfterMs,
  });
}

export function createAgentTurnGateway(seams: Readonly<AgentTurnGatewaySeams>) {
  async function turn(
    env: unknown,
    leaseId: unknown,
    generation: unknown,
    callJson: unknown,
    budgetMs: unknown,
  ): Promise<string> {
    // 1. Both switches, before anything else.
    const capabilities = await brokerCapabilities(env);
    const model = capabilities.model;
    const vault = capabilities.vault;
    if (capabilities.modelMode !== "anthropic" || capabilities.agentLoop !== "on" || model === null || vault === null)
      throw hold("MODEL_UNAVAILABLE");
    // 2. The closed inputs.
    if (
      typeof leaseId !== "string" ||
      !uuid.test(leaseId) ||
      typeof generation !== "number" ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      typeof budgetMs !== "number" ||
      !Number.isSafeInteger(budgetMs) ||
      budgetMs < modelGatewayLimits.budgetMinMs ||
      budgetMs > modelGatewayLimits.budgetMaxMs
    )
      throw hold("INPUT_INVALID");
    const call = parseModelCallV2(callJson);
    if (call === null) throw hold("INPUT_INVALID");
    // 3. Append-only: the prefix is every message but the last.
    const before = call.messages.slice(0, -1);
    const last = call.messages[call.messages.length - 1]!;
    if (call.turn > 1 && (await sha256(jcs(before))) !== call.prefixDigest)
      return turnResult("prefix_mismatch", null, null, null, null, null);
    const inputDigest = await sha256(jcs(last));
    const deadline = seams.now() + budgetMs;
    const left = () => deadline - seams.now();
    // 4. The fence.
    const begun = decodeBegin(
      await seams.transaction(vault, Math.min(modelSendTiming.fenceMaxMs, Math.max(1_000, left())), (query) =>
        query(vaultStatements.agentTurnBegin, [
          leaseId,
          String(generation),
          String(call.turn),
          String(call.attempt),
          String(call.sequence),
          String(call.final),
          String(budgetMs),
          call.prefixDigest ?? "",
          inputDigest,
        ]),
      ),
    );
    if (begun === "prefix_mismatch") return turnResult("prefix_mismatch", null, null, null, null, null);
    if (typeof begun === "string") throw hold("STATE_INVALID");
    if ("replay" in begun) {
      // A fence already closed (or booked as uncertain): its recorded outcome, never a send.
      const r = begun.replay;
      let message: unknown = null;
      let usage: unknown = null;
      try {
        message = r.output === null ? null : JSON.parse(r.output);
        usage = r.usage === null ? null : JSON.parse(r.usage);
      } catch {
        throw hold("STATE_INVALID");
      }
      const replied = (r.outcome === "end_turn" || r.outcome === "tool_use") && message !== null && r.prefixAfter !== null;
      return turnResult(
        replied ? r.outcome : r.outcome === "end_turn" || r.outcome === "tool_use" ? "uncertain" : r.outcome,
        message,
        usage,
        r.prefixAfter,
        r.callId,
        null,
      );
    }
    const b = begun.begun;
    const close = async (outcome: string, a: TurnAdapterResult | null, counted: number | null, reply: unknown, prefixAfter: string | null): Promise<string | null> => {
      try {
        const rows = await seams.transaction(vault, Math.min(10_000, Math.max(1_000, left() + 5_000)), (query) =>
          query(vaultStatements.agentTurnEnd, [
            b.callId,
            outcome,
            a?.rawStopReason ?? "",
            a?.providerRequestId ?? "",
            a?.providerModelId ?? "",
            counted === null ? "" : String(counted),
            a?.usage ? String(a.usage.inputTokens) : "",
            a?.usage ? String(a.usage.cacheWriteTokens) : "",
            a?.usage ? String(a.usage.cacheReadTokens) : "",
            a?.usage ? String(a.usage.outputTokens) : "",
            reply === null ? "" : JSON.stringify(reply),
            prefixAfter ?? "",
          ]),
        );
        const r = rows.length === 1 ? rows[0] : undefined;
        if (!r || (r.outcome !== "closed" && r.outcome !== "already_closed") || typeof r.recorded_outcome !== "string")
          return null;
        return r.outcome === "already_closed" ? null : r.recorded_outcome;
      } catch {
        // The close never committed: the open fence is booked as uncertain at its worst case.
        return null;
      }
    };
    // 5. The call against the run.
    const entry = entryOf(b.catalogueVersion, b.model, b.effort);
    const provider = entry ? seams.providers[entry.provider] : undefined;
    const system = loopSystemTexts[b.systemTextDigest];
    const named = call.messages.flatMap((m) =>
      m.role === "assistant"
        ? (m.content as Record<string, unknown>[]).filter((x) => x.type === "tool_use").map((x) => x.name as string)
        : [],
    );
    if (
      !entry ||
      !provider ||
      entry.providerModelId !== b.providerModelId ||
      entry.maxTokens !== b.maxOutputTokens ||
      typeof system !== "string" ||
      named.some((n) => !b.tools.includes(n)) ||
      budgetMs < modelCallBudgetMs(entry.maxTokens)
    ) {
      await close("not_sent", null, null, null, null);
      throw hold("INPUT_INVALID");
    }
    const resolved: ResolvedTurnCall = Object.freeze({
      providerModelId: entry.providerModelId,
      effort: b.effort,
      maxTokens: entry.maxTokens,
      system,
      tools: b.tools,
      final: call.final,
      messages: call.messages,
    });
    // 6. The count, leaving the send its window.
    const sendWindow = modelSendWindowMs(entry.maxTokens);
    const closeMargin = modelSendTiming.closeMarginMs;
    if (left() < closeMargin + 1_000 + sendWindow) {
      await close("not_sent", null, null, null, null);
      return turnResult("not_sent", null, null, null, b.callId, 1_000);
    }
    const counted = await provider.countTurn(
      resolved,
      model.apiKey,
      Math.max(1_000, Math.min(modelSendTiming.countMaxMs, left() - closeMargin - sendWindow)),
    );
    if (counted.outcome !== "counted") {
      const outcome = counted.outcome === "throttled" ? "not_sent" : counted.outcome;
      const recorded = (await close(outcome, null, null, null, null)) ?? "uncertain";
      return turnResult(recorded, null, null, null, b.callId, counted.outcome === "throttled" ? counted.retryAfterMs : null);
    }
    const cap = Math.min(entry.maxInput, b.maxInputTokens);
    if (counted.inputTokens > cap - Math.ceil(cap / 10)) {
      const recorded = (await close("input_over_cap", null, counted.inputTokens, null, null)) ?? "uncertain";
      return turnResult(recorded, null, null, null, b.callId, null);
    }
    // 7. One send, the reply checked against the run, then the close.
    if (left() - closeMargin < sendWindow) {
      await close("not_sent", null, counted.inputTokens, null, null);
      return turnResult("not_sent", null, null, null, b.callId, 1_000);
    }
    const reply = await provider.respondTurn(resolved, model.apiKey, left() - closeMargin);
    let outcome: string = reply.outcome === "throttled" ? "not_sent" : reply.outcome;
    let message: unknown = null;
    if (outcome === "end_turn" || outcome === "tool_use") {
      const uses = (reply.message?.content ?? []).filter((x) => (x as { type: string }).type === "tool_use") as {
        name: string;
      }[];
      if (reply.message === null || uses.length > 4 || (call.final && uses.length > 0) || uses.some((u) => !b.tools.includes(u.name)))
        outcome = "invalid_output";
      else message = reply.message;
    }
    const usage = outcome === "uncertain" || outcome === "not_sent" || outcome === "spend_limit" ? null : reply.usage;
    if (["end_turn", "tool_use", "incomplete", "refusal", "invalid_output"].includes(outcome) && usage === null)
      outcome = "uncertain";
    if (outcome === "uncertain") message = null;
    const prefixAfter = message === null ? null : await sha256(jcs([...call.messages, message]));
    const recorded = await close(outcome, { ...reply, usage }, counted.inputTokens, message, prefixAfter);
    if (recorded === null) return turnResult("uncertain", null, null, null, b.callId, null);
    return turnResult(
      recorded,
      recorded === outcome ? message : null,
      usage,
      recorded === outcome ? prefixAfter : null,
      b.callId,
      reply.outcome === "throttled" ? reply.retryAfterMs : null,
    );
  }
  return Object.freeze({
    modelTurn(env: unknown, leaseId: unknown, generation: unknown, callJson: unknown, budgetMs: unknown): Promise<string> {
      return invokeBrokerMethod("modelTurn", () => turn(env, leaseId, generation, callJson, budgetMs), "RuntimeBroker");
    },
  });
}
