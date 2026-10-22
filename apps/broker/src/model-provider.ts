// The model gateway's provider port (ADR-0022 item 10; mvp-architecture §9 and §12). Callers
// never see it: they send ModelCall@1 to RuntimeBroker.modelRespond and receive ModelResult@1.
// Inside the broker, the run's catalogue entry names a provider, and that provider's adapter
// turns one resolved call into the provider's request and its reply into an AdapterResult:
// broker-internal, with the raw stop reason, the token usage and the provider's request and
// model ids, which the broker records in the run's call entry and never returns. An adapter
// computes no cost (SQL books it from the catalogue's rates) and decides no authority.
// Another provider is one more adapter here, one broker credential and one catalogue entry,
// chosen by ADR; callers and contracts do not change.

/** One call as the broker resolved it: the run's selection, never the caller's. */
export interface ResolvedModelCall {
  readonly providerModelId: string;
  /** The catalogue effort key, sent as the provider's effort ("low", "medium" or "high"). */
  readonly effort: string;
  /** The effort's output cap from the run's catalogue version (thinking included). */
  readonly maxTokens: number;
  /** The fixed system prompt (its digest is the manifest's prompt digest). */
  readonly system: string;
  /** The user turn: the merchant's request, the fields and the one product. */
  readonly user: string;
  /** ListingDraft_v1 (the strict output schema). */
  readonly outputSchema: Readonly<Record<string, unknown>>;
}
export interface ModelUsage {
  readonly inputTokens: number;
  /** Output tokens, thinking included (ADR-0022 item 10). */
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
}
/**
 * The adapter's outcome of one send (ADR-0022 item 10's table). `throttled` (a 429 with
 * retry-after, a 529) generated nothing and the caller may resend after `retryAfterMs`;
 * `uncertain` (a 500, a 504, a timeout or a transport loss) is counted and booked at the
 * attempt's worst case; `spend_limit` and `provider_error` end the run. An unknown stop
 * reason or a reply naming another model is provider_error with its usage.
 */
export type AdapterOutcome =
  | "completed"
  | "incomplete"
  | "refusal"
  | "invalid_output"
  | "spend_limit"
  | "provider_error"
  | "uncertain"
  | "throttled";
export interface AdapterResult {
  readonly outcome: AdapterOutcome;
  /** A bounded token, e.g. end_turn, or null when there was no reply. */
  readonly rawStopReason: string | null;
  /** The parsed JSON of a completed reply's text, unchecked (the broker checks it). */
  readonly output: unknown;
  /** The reply's usage, or null when nothing was generated or the outcome is unknown. */
  readonly usage: ModelUsage | null;
  readonly providerRequestId: string | null;
  readonly providerModelId: string | null;
  readonly retryAfterMs: number | null;
}
/** The input count before any send (the provider's free counting endpoint). */
export type CountResult =
  | { readonly outcome: "counted"; readonly inputTokens: number }
  | { readonly outcome: "throttled"; readonly retryAfterMs: number }
  | { readonly outcome: "spend_limit" | "provider_error" | "not_sent" };
export interface ModelProvider {
  readonly provider: string;
  /** Counts the input of exactly the request respond would send. */
  countInput(call: ResolvedModelCall, credential: string, budgetMs: number): Promise<CountResult>;
  /** Sends once (no retries, no fallback) and maps the reply. Never throws. */
  respond(call: ResolvedModelCall, credential: string, budgetMs: number): Promise<AdapterResult>;
}
