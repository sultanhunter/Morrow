import type {
  AdapterResult,
  CountResult,
  ModelProvider,
  ModelUsage,
  ResolvedModelCall,
} from "./model-provider.js";

// The Claude adapter (ADR-0022 item 10): the Messages API by hand-written fetch, one request
// per call, no retries, no streaming, no fallback. The official SDK does not fit the broker's
// 256 KiB bundle cap (P04.T02a-AC02; measured for M3 PR-2: 457,561 bytes with the full SDK,
// 315,143 with only its Messages resource, against 233,808 before this PR), so this follows
// the ADR-0008 item 1 "hand-written checks" precedent. The owner approved it on 2026-10-22
// (decision 3, recorded in the M3 brief) as an amendment of item 10's "with the official SDK"
// (the request fields and the outcome table are item 10's, unchanged).
// Sent: model, max_tokens (the effort's catalogue cap), system, one user message, thinking
// {type: adaptive} and output_config {effort, format: json_schema ListingDraft_v1}; the
// headers x-api-key, anthropic-version and content-type. Never sent: fallbacks,
// budget_tokens, disabled thinking, tools, prefill, sampling parameters, stream, beta headers,
// files, batches, inference_geo or fast mode. The input is counted with the free counting
// endpoint on the identical body (the schema adds input tokens).
// Outcomes (item 10's table; anything unlisted is provider_error):
//   200 end_turn -> completed (its text parsed as JSON; unparseable -> invalid_output);
//   max_tokens -> incomplete; refusal -> refusal; any other stop reason, or a reply naming
//   another model -> provider_error, with usage; an unreadable 200 -> uncertain.
//   400 naming a spend, credit or usage limit -> spend_limit; any other 4xx (400, 401, 402,
//   403, 404, 413) -> provider_error, nothing generated.
//   429 with retry-after that names no spend or usage limit, and 529 -> throttled (resend
//   after the wait, no attempt used); a 429 without retry-after or naming a limit ->
//   spend_limit.
//   500, 504, a timeout or any transport failure -> uncertain (counted at the worst case).
//   Every other status of 500 or above but 529 (502, 503, 520-524 and the rest) is uncertain
//   too: a gateway or edge failure after the request was sent does not prove nothing was
//   generated (a 524 means the origin was still working), so item 10's "transport loss after
//   the request was sent" row applies, never the free provider_error. A non-200 status below
//   400 is uncertain for the same reason.
//   Deviation (recorded in the brief): fetch cannot tell a connection that failed before the
//   request was sent from a loss after it, so item 10's "not sent" row is never produced; the
//   conservative uncertain is used instead.

export const claudeEndpoint = "https://api.anthropic.com";
export const claudeApiVersion = "2023-06-01";
export type Fetch = (request: Request) => Promise<Response>;
const spendWords = /\b(credit balance|spend(?:ing)? limit|usage limits?|monthly limit|billing)\b/i;
const token = /^[a-z_]{1,32}$/;
const requestId = /^[A-Za-z0-9_-]{1,128}$/;
const modelId = /^[A-Za-z0-9._-]{1,128}$/;

/** The exact Messages request body of one resolved call. */
export function claudeRequestBody(call: ResolvedModelCall): Record<string, unknown> {
  return {
    model: call.providerModelId,
    max_tokens: call.maxTokens,
    system: call.system,
    messages: [{ role: "user", content: call.user }],
    thinking: { type: "adaptive" },
    output_config: {
      effort: call.effort,
      format: { type: "json_schema", schema: call.outputSchema },
    },
  };
}
/** The counting body: the identical request without max_tokens. */
export function claudeCountBody(call: ResolvedModelCall): Record<string, unknown> {
  const { max_tokens: _cap, ...body } = claudeRequestBody(call);
  return body;
}
const headers = (key: string) => ({
  "x-api-key": key,
  "anthropic-version": claudeApiVersion,
  "content-type": "application/json",
});
function retryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  if (/^[0-9]{1,6}$/.test(value)) return Math.min(Number(value) * 1000, 120_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 120_000) : null;
}
async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown; type?: unknown } };
    const message = body?.error?.message;
    const type = body?.error?.type;
    return (
      (typeof type === "string" ? type : "") +
      " " +
      (typeof message === "string" ? message.slice(0, 2000) : "")
    );
  } catch {
    return "";
  }
}
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000
    ? value
    : null;
function usageOf(value: unknown): ModelUsage | null {
  if (!value || typeof value !== "object") return null;
  const u = value as Record<string, unknown>;
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  const creation =
    u.cache_creation_input_tokens === undefined || u.cache_creation_input_tokens === null
      ? 0
      : count(u.cache_creation_input_tokens);
  const read =
    u.cache_read_input_tokens === undefined || u.cache_read_input_tokens === null
      ? 0
      : count(u.cache_read_input_tokens);
  if (input === null || output === null || creation === null || read === null) return null;
  return Object.freeze({
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: creation,
    cacheReadTokens: read,
  });
}
const result = (r: Partial<AdapterResult> & Pick<AdapterResult, "outcome">): AdapterResult =>
  Object.freeze({
    rawStopReason: null,
    output: null,
    usage: null,
    providerRequestId: null,
    providerModelId: null,
    retryAfterMs: null,
    ...r,
  });

export function createClaudeAdapter(fetch: Fetch): ModelProvider {
  async function post(
    path: string,
    body: unknown,
    key: string,
    budgetMs: number,
  ): Promise<Response> {
    return fetch(
      new Request(claudeEndpoint + path, {
        method: "POST",
        headers: headers(key),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(budgetMs),
      }),
    );
  }
  return Object.freeze({
    provider: "anthropic",
    async countInput(call: ResolvedModelCall, key: string, budgetMs: number): Promise<CountResult> {
      let response: Response;
      try {
        response = await post("/v1/messages/count_tokens", claudeCountBody(call), key, budgetMs);
      } catch {
        // Counting is free and generates nothing: a failed count is not sent.
        return { outcome: "not_sent" };
      }
      if (response.status === 200) {
        try {
          const tokens = count(
            ((await response.json()) as { input_tokens?: unknown })?.input_tokens,
          );
          return tokens === null
            ? { outcome: "provider_error" }
            : { outcome: "counted", inputTokens: tokens };
        } catch {
          return { outcome: "provider_error" };
        }
      }
      return countRefusal(response);
    },
    async respond(call: ResolvedModelCall, key: string, budgetMs: number): Promise<AdapterResult> {
      let response: Response;
      try {
        response = await post("/v1/messages", claudeRequestBody(call), key, budgetMs);
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
        const usage = usageOf(body?.usage);
        const stop =
          typeof body?.stop_reason === "string" && token.test(body.stop_reason)
            ? body.stop_reason
            : null;
        const model =
          typeof body?.model === "string" && modelId.test(body.model) ? body.model : null;
        if (usage === null)
          return result({ outcome: "uncertain", providerRequestId, providerModelId: model });
        const common = { rawStopReason: stop, usage, providerRequestId, providerModelId: model };
        // No fallback: a reply from any other model is a provider error (item 10).
        if (model !== call.providerModelId) return result({ outcome: "provider_error", ...common });
        if (stop === "max_tokens") return result({ outcome: "incomplete", ...common });
        if (stop === "refusal") return result({ outcome: "refusal", ...common });
        if (stop !== "end_turn") return result({ outcome: "provider_error", ...common });
        const blocks = Array.isArray(body.content) ? (body.content as unknown[]) : [];
        const text = blocks
          .filter(
            (b): b is { type: "text"; text: string } =>
              !!b &&
              typeof b === "object" &&
              (b as { type?: unknown }).type === "text" &&
              typeof (b as { text?: unknown }).text === "string",
          )
          .map((b) => b.text)
          .join("");
        try {
          return result({ outcome: "completed", output: JSON.parse(text) as unknown, ...common });
        } catch {
          return result({ outcome: "invalid_output", ...common });
        }
      }
      // Only a 4xx proves nothing was generated; 529 is the provider's own overload signal.
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

// The refusals both endpoints share. On the free count every status of 500 or above but 529
// is not_sent (counting generates nothing); respond never reaches that row, because it
// answers those statuses as uncertain first.
async function countRefusal(response: Response): Promise<CountResult> {
  const status = response.status;
  if (status === 529) return { outcome: "throttled", retryAfterMs: retryAfter(response) ?? 2_000 };
  if (status >= 500) return { outcome: "not_sent" };
  const text = await errorText(response);
  if (status === 429) {
    const wait = retryAfter(response);
    return wait === null || spendWords.test(text)
      ? { outcome: "spend_limit" }
      : { outcome: "throttled", retryAfterMs: wait };
  }
  if (status === 400 && spendWords.test(text)) return { outcome: "spend_limit" };
  return { outcome: "provider_error" };
}
