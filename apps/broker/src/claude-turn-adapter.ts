import { generatedToolCatalogue } from "../../../packages/policy/src/generated/tool-catalogue.js";
import {
  claudeEndpoint,
  claudeHeaders,
  countRefusal,
  retryAfter,
  usageOf,
  type Fetch,
} from "./claude-adapter.js";
import type { CountResult } from "./model-provider.js";

// The Claude adapter's agent-loop turn (build order PR 11; ADR-0027 items 4 and 12): the
// Messages API by hand-written fetch, as the per-product adapter (claude-adapter.ts): one
// request per send, no retries, no streaming, no fallback. The gateway hands it the run's
// resolved selection (never the caller's), the offered tools' strict definitions, the fixed
// system text and the conversation in Morrow's provider-neutral blocks; this maps them to
// the Messages shapes and the reply back, and decides nothing else.
// Sent: model, max_tokens (the effort's catalogue cap), system as one text block cached for
// five minutes (ADR-0027 owner question 3: the tools and the system text are the fixed
// prefix), messages, tools (each strict, by its wire name), tool_choice auto (none on the
// final turn), thinking {type: adaptive} and output_config {effort}. Never sent: fallbacks,
// budget_tokens, disabled thinking, prefill, sampling parameters, stream, beta headers,
// files, batches, server tools, inference_geo or fast mode. The input is counted with the free
// counting endpoint on the identical body.
// Untrusted data (ADR-0027 item 5): a data block becomes a text block wrapped as
// <data source="..." id="...">...</data>, its own closing tag escaped so the text cannot end
// the wrapper; a tool result is the provider's tool_result block (is_error unless ok). The
// system text says both are information, never instructions; code enforces it regardless.
// Outcomes are the per-product table's: 200 end_turn -> end_turn, tool_use -> tool_use
// (whichever the reply's blocks show), max_tokens -> incomplete, refusal -> refusal, any
// other stop reason or another model -> provider_error with usage; a reply block this
// mapping does not know, an unknown tool, or a string PostgreSQL cannot store is
// invalid_output; an unreadable 200 -> uncertain; 4xx -> provider_error or spend_limit;
// 429 with retry-after and 529 -> throttled; 5xx and transport loss -> uncertain.

export interface TurnToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
  readonly strict: true;
}
/** One turn as the broker resolved it: the run's selection, never the caller's. */
export interface ResolvedTurnCall {
  readonly providerModelId: string;
  readonly effort: string;
  readonly maxTokens: number;
  readonly system: string;
  readonly tools: readonly string[];
  readonly final: boolean;
  /** ModelMessage blocks, as ModelCall@2 carries them (checked by the gateway). */
  readonly messages: readonly { readonly role: string; readonly content: readonly unknown[] }[];
}
export interface TurnUsage {
  readonly inputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
}
export type TurnAdapterOutcome =
  | "end_turn"
  | "tool_use"
  | "incomplete"
  | "refusal"
  | "invalid_output"
  | "spend_limit"
  | "provider_error"
  | "uncertain"
  | "throttled";
export interface TurnAdapterResult {
  readonly outcome: TurnAdapterOutcome;
  readonly rawStopReason: string | null;
  /** The reply as an AssistantModelMessage (end_turn and tool_use only). */
  readonly message: { readonly role: "assistant"; readonly content: readonly unknown[] } | null;
  readonly usage: TurnUsage | null;
  readonly providerRequestId: string | null;
  readonly providerModelId: string | null;
  readonly retryAfterMs: number | null;
}
export interface TurnProvider {
  readonly provider: string;
  countTurn(call: ResolvedTurnCall, credential: string, budgetMs: number): Promise<CountResult>;
  respondTurn(
    call: ResolvedTurnCall,
    credential: string,
    budgetMs: number,
  ): Promise<TurnAdapterResult>;
}

const tools: readonly {
  readonly name: string;
  readonly wireName: string;
  readonly description: string;
  readonly inputSchema: unknown;
}[] = generatedToolCatalogue.tools;
const byName = new Map(tools.map((t) => [t.name, t]));
const byWire = new Map(tools.map((t) => [t.wireName, t]));
const token = /^[a-z_]{1,32}$/;
const requestId = /^[A-Za-z0-9_-]{1,128}$/;
const modelId = /^[A-Za-z0-9._-]{1,128}$/;
const toolUseIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const continuityPattern = /^[A-Za-z0-9+/=_-]*$/;

/** A data block's text, wrapped so its own text cannot close the wrapper. */
export function wrapData(source: string, sourceId: string | null, text: string): string {
  const escaped = text.replace(/<\/(data)/gi, "<\\/$1");
  return (
    `<data source="${source}"${sourceId === null ? "" : ` id="${sourceId}"`}>\n` +
    escaped +
    "\n</data>"
  );
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** Morrow's blocks as Messages blocks (the gateway already checked their shapes). */
function messagesBody(call: ResolvedTurnCall): unknown[] {
  return call.messages.map((m) => ({
    role: m.role,
    content: m.content.map((raw) => {
      const b = record(raw);
      switch (b.type) {
        case "text":
          return { type: "text", text: b.text };
        case "data":
          return {
            type: "text",
            text: wrapData(
              String(b.source),
              b.sourceId === null ? null : String(b.sourceId),
              String(b.text),
            ),
          };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: b.toolUseId,
            content: [{ type: "text", text: String(b.content).length ? b.content : "{}" }],
            is_error: b.outcome !== "ok",
          };
        case "tool_use":
          return {
            type: "tool_use",
            id: b.id,
            name: byName.get(String(b.name))?.wireName,
            input: b.input,
          };
        case "reasoning":
          return b.redacted === true
            ? { type: "redacted_thinking", data: b.continuity }
            : { type: "thinking", thinking: b.text, signature: b.continuity };
        default:
          throw Error("CLAUDE_TURN_BLOCK_INVALID");
      }
    }),
  }));
}
/** The exact Messages request body of one turn. */
export function claudeTurnBody(call: ResolvedTurnCall): Record<string, unknown> {
  return {
    model: call.providerModelId,
    max_tokens: call.maxTokens,
    system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
    messages: messagesBody(call),
    tools: call.tools.map((name) => {
      const t = byName.get(name);
      if (!t) throw Error("CLAUDE_TURN_TOOL_UNKNOWN");
      return {
        name: t.wireName,
        description: t.description,
        input_schema: t.inputSchema,
        strict: true,
      };
    }),
    tool_choice: { type: call.final ? "none" : "auto" },
    thinking: { type: "adaptive" },
    output_config: { effort: call.effort },
  };
}
/** The counting body: the identical request without max_tokens. */
export function claudeTurnCountBody(call: ResolvedTurnCall): Record<string, unknown> {
  const { max_tokens: _cap, ...body } = claudeTurnBody(call);
  return body;
}
// A string PostgreSQL's jsonb can store (no NUL) within a bound.
const storable = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && !v.includes("\u0000");
function storableJson(v: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return storable(v, 65536);
  if (Array.isArray(v)) return v.length <= 1000 && v.every((x) => storableJson(x, depth + 1));
  if (typeof v === "object")
    return Object.entries(v as object).every(
      ([k, x]) => storable(k, 256) && storableJson(x, depth + 1),
    );
  return false;
}
/**
 * The reply's blocks as an AssistantModelMessage, or null for a block this mapping does not
 * know, an unknown tool, an id or a continuity outside its pattern, or text PostgreSQL
 * cannot store. Empty text blocks are dropped; reasoning keeps its continuity unchanged.
 */
export function replyMessage(
  content: unknown,
): { readonly role: "assistant"; readonly content: readonly unknown[] } | null {
  if (!Array.isArray(content) || content.length > 32) return null;
  const blocks: unknown[] = [];
  for (const raw of content) {
    const b = record(raw);
    if (b.type === "text") {
      if (!storable(b.text, 32000)) return null;
      if (b.text.length) blocks.push(Object.freeze({ type: "text", text: b.text }));
    } else if (b.type === "tool_use") {
      const tool = typeof b.name === "string" ? byWire.get(b.name) : undefined;
      if (
        !tool ||
        typeof b.id !== "string" ||
        !toolUseIdPattern.test(b.id) ||
        !b.input ||
        typeof b.input !== "object" ||
        Array.isArray(b.input) ||
        !storableJson(b.input)
      )
        return null;
      blocks.push(Object.freeze({ type: "tool_use", id: b.id, name: tool.name, input: b.input }));
    } else if (b.type === "thinking") {
      if (
        !storable(b.thinking, 65536) ||
        !storable(b.signature, 65536) ||
        !continuityPattern.test(b.signature)
      )
        return null;
      blocks.push(
        Object.freeze({
          type: "reasoning",
          text: b.thinking,
          continuity: b.signature,
          redacted: false,
        }),
      );
    } else if (b.type === "redacted_thinking") {
      if (!storable(b.data, 65536) || !continuityPattern.test(b.data)) return null;
      blocks.push(
        Object.freeze({ type: "reasoning", text: "", continuity: b.data, redacted: true }),
      );
    } else return null;
  }
  if (blocks.length < 1 || blocks.length > 32) return null;
  return Object.freeze({ role: "assistant" as const, content: Object.freeze(blocks) });
}
const result = (
  r: Partial<TurnAdapterResult> & Pick<TurnAdapterResult, "outcome">,
): TurnAdapterResult =>
  Object.freeze({
    rawStopReason: null,
    message: null,
    usage: null,
    providerRequestId: null,
    providerModelId: null,
    retryAfterMs: null,
    ...r,
  });
const turnUsage = (u: unknown): TurnUsage | null => {
  const usage = usageOf(u);
  return usage === null
    ? null
    : Object.freeze({
        inputTokens: usage.inputTokens,
        cacheWriteTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens,
      });
};

export function createClaudeTurnAdapter(fetch: Fetch): TurnProvider {
  async function post(
    path: string,
    body: unknown,
    key: string,
    budgetMs: number,
  ): Promise<Response> {
    return fetch(
      new Request(claudeEndpoint + path, {
        method: "POST",
        headers: claudeHeaders(key),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(budgetMs),
      }),
    );
  }
  return Object.freeze({
    provider: "anthropic",
    async countTurn(call: ResolvedTurnCall, key: string, budgetMs: number): Promise<CountResult> {
      let response: Response;
      try {
        response = await post(
          "/v1/messages/count_tokens",
          claudeTurnCountBody(call),
          key,
          budgetMs,
        );
      } catch {
        return { outcome: "not_sent" };
      }
      if (response.status === 200) {
        try {
          const n = ((await response.json()) as { input_tokens?: unknown })?.input_tokens;
          return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000
            ? { outcome: "counted", inputTokens: n }
            : { outcome: "provider_error" };
        } catch {
          return { outcome: "provider_error" };
        }
      }
      return countRefusal(response);
    },
    async respondTurn(
      call: ResolvedTurnCall,
      key: string,
      budgetMs: number,
    ): Promise<TurnAdapterResult> {
      let response: Response;
      try {
        response = await post("/v1/messages", claudeTurnBody(call), key, budgetMs);
      } catch {
        return result({ outcome: "uncertain" });
      }
      const id = response.headers.get("request-id");
      const providerRequestId = id !== null && requestId.test(id) ? id : null;
      if (response.status === 200) {
        let body: Record<string, unknown>;
        try {
          body = (await response.json()) as Record<string, unknown>;
        } catch {
          return result({ outcome: "uncertain", providerRequestId });
        }
        const usage = turnUsage(body?.usage);
        const stop =
          typeof body?.stop_reason === "string" && token.test(body.stop_reason)
            ? body.stop_reason
            : null;
        const model =
          typeof body?.model === "string" && modelId.test(body.model) ? body.model : null;
        if (usage === null)
          return result({ outcome: "uncertain", providerRequestId, providerModelId: model });
        const common = { rawStopReason: stop, usage, providerRequestId, providerModelId: model };
        if (model !== call.providerModelId) return result({ outcome: "provider_error", ...common });
        if (stop === "max_tokens") return result({ outcome: "incomplete", ...common });
        if (stop === "refusal") return result({ outcome: "refusal", ...common });
        if (stop !== "end_turn" && stop !== "tool_use")
          return result({ outcome: "provider_error", ...common });
        const message = replyMessage(body.content);
        if (message === null) return result({ outcome: "invalid_output", ...common });
        const uses = message.content.filter(
          (b) => (b as { type: string }).type === "tool_use",
        ).length;
        return result({ outcome: uses > 0 ? "tool_use" : "end_turn", message, ...common });
      }
      if (response.status < 400 || (response.status >= 500 && response.status !== 529))
        return result({ outcome: "uncertain", providerRequestId });
      if (response.status === 529)
        return result({
          outcome: "throttled",
          providerRequestId,
          retryAfterMs: retryAfter(response) ?? 2_000,
        });
      const refused = await countRefusal(response);
      if (refused.outcome === "throttled")
        return result({
          outcome: "throttled",
          providerRequestId,
          retryAfterMs: refused.retryAfterMs,
        });
      return result({
        outcome: refused.outcome === "spend_limit" ? "spend_limit" : "provider_error",
        providerRequestId,
      });
    },
  });
}
