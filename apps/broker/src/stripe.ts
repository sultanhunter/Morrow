import {
  normalizeCheckoutSession,
  normalizeInvoice,
  normalizeSubscription,
  stripeApiVersion,
  stripeEventObjects,
  stripeIdempotencyKey,
  stripeIdPatterns,
  stripeObjectDigest,
  stripeRequestDigest,
  isStripeEventType,
  type NormalizedStripeObject,
  type StripeEventType,
} from "../../../packages/work/src/billing/stripe-objects.js";
import type {
  StripeCheckoutResult,
  StripeConfiguration,
  StripeCustomerResult,
  StripePortalResult,
  StripeWebhookResult,
} from "../../../packages/identity/src/broker-protocol.js";
import { billingVaultStatements } from "./vault-statements-billing.js";
import type { VaultQuery } from "./vault.js";

// Stripe through the broker (M5 PR-1; ADR-0022 items 7 and 12). No SDK: fixed fetch calls
// to https://api.stripe.com on the one pinned API version, form bodies built from closed
// records, bounded replies, and the restricted key only here. Every write names an
// authorized stripe_write operation; its parameters come from the database
// (stripe_op_begin), whose send fence is set before any HTTP call, and whose request
// digest the broker recomputes before sending. Outcomes (invariant 10): a 2xx is read back
// and settled verified; a first send's 4xx proves nothing ran (failed); one 429 is resent
// with the same key within the budget; a 5xx, timeout or transport loss after sending is
// uncertain. An uncertain operation is reconciled by readback first, then a replay with the
// same key only within 23 hours; never a new key, never promoted without a provider result.
// A customer operation still uncertain once no replay or send can be running (24 hours
// after it was created, an hour after its send) is reconciled by the strongly consistent
// customer list over every time it could have been created: one customer of the operation
// settles it verified (read back), none settles it absent (its intents fail, so the next
// checkout starts a new customer operation), and anything Stripe cannot prove either way
// (several customers, or more than the bounded list) holds it for the operator.
// One deadline per method: every transaction and HTTP call gets only what remains of it.
// Webhooks: the signature over the raw bytes (WebCrypto HMAC-SHA256, constant time, 300 s
// tolerance), livemode equal to the environment's mode, a readback of the object with the
// broker's own key (another account's object is a 404), then the receipt. A subscribed
// event whose read-back object is outside the closed shape is held with its own fixed
// reason (Stripe retries; nothing is dropped silently). No provider text is ever logged or
// returned.

export const stripeOrigin = "https://api.stripe.com";
export const stripeTimings = Object.freeze({
  toleranceSeconds: 300,
  replayWindowMs: 23 * 3600 * 1000,
  // The absence proof of a customer operation: only once Stripe's 24-hour idempotency
  // window has closed on the last possible replay (replays stop at 23 hours, so an hour of
  // margin) and an hour after its own send, over created times from five minutes before
  // the send to an hour after the last possible replay, at most this many list pages.
  absenceAfterMs: 24 * 3600 * 1000,
  absenceSendMarginMs: 3600 * 1000,
  absenceListMarginSeconds: { before: 300, after: 3600 },
  absenceListPages: 5,
  retryAfterMaxMs: 2000,
  replyMaxBytes: 262144,
  // One deadline per method: a transaction never starts with less than this left, an HTTP
  // call never with less than callFloorMs, and the HTTP calls stop settleReserveMs before
  // the deadline so the settle still fits.
  transactionFloorMs: 200,
  callFloorMs: 250,
  settleReserveMs: 1000,
});
export interface BrokerStripe {
  readonly environment: "development" | "staging";
  readonly restrictedKey: string;
  readonly webhookSecret: string;
  readonly configuration: Readonly<StripeConfiguration>;
  /** The workspace origin Checkout and the portal return to. */
  readonly returnOrigin: string;
}
export interface StripeDependencies {
  readonly stripe: Readonly<BrokerStripe>;
  readonly fetch: (request: Request) => Promise<Response>;
  /** One transaction on the broker's own login (vault-database.ts, M2 PR-2). */
  readonly transaction: <T>(
    budgetMs: number,
    body: (query: VaultQuery) => Promise<T>,
  ) => Promise<T>;
  readonly now: () => number;
}
/** A fixed refusal of the broker's own: BROKER_HELD for the caller, never a provider effect. */
export class StripeHold extends Error {
  constructor(readonly code: "INPUT_INVALID" | "PROVIDER_HELD" | "STATE_INVALID") {
    super("STRIPE_HELD");
    this.name = "StripeHold";
  }
}
const hold = (code: StripeHold["code"] = "STATE_INVALID"): never => {
  throw new StripeHold(code);
};

// ---------------------------------------------------------------------------
// The HTTP client: one request, bounded by the deadline and the reply cap.
type Reply =
  | {
      readonly kind: "ok";
      readonly status: number;
      readonly json: Record<string, unknown>;
      readonly requestId: string | null;
    }
  | { readonly kind: "client_error"; readonly status: number }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number }
  | { readonly kind: "server_error" }
  | { readonly kind: "timeout" };
type Form = readonly (readonly [string, string])[];
async function stripeCall(
  deps: StripeDependencies,
  method: "GET" | "POST",
  path: string,
  form: Form | null,
  idempotencyKey: string | null,
  deadlineMs: number,
): Promise<Reply> {
  const remaining = deadlineMs - deps.now();
  // Too little time to send: treated as a possible send (uncertain), never as no effect.
  if (remaining < stripeTimings.callFloorMs) return { kind: "timeout" };
  const headers: Record<string, string> = {
    Authorization: "Bearer " + deps.stripe.restrictedKey,
    "Stripe-Version": stripeApiVersion,
    Accept: "application/json",
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  }
  const body = form ? new URLSearchParams(form.map(([k, v]) => [k, v])).toString() : null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), remaining);
  try {
    const response = await deps.fetch(
      new Request(stripeOrigin + path, {
        method,
        headers,
        body,
        signal: abort.signal,
        redirect: "manual",
      }),
    );
    if (response.status === 429) {
      const after = Number(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => {});
      return {
        kind: "rate_limited",
        retryAfterMs: Number.isFinite(after) && after >= 0 ? after * 1000 : 1000,
      };
    }
    if (response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      return { kind: "server_error" };
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      return { kind: "client_error", status: response.status };
    }
    const text = await boundedText(response, stripeTimings.replyMaxBytes);
    const json = JSON.parse(text) as unknown;
    if (json === null || typeof json !== "object" || Array.isArray(json))
      return { kind: "server_error" };
    const requestId = response.headers.get("request-id");
    return {
      kind: "ok",
      status: response.status,
      json: json as Record<string, unknown>,
      requestId: requestId && stripeIdPatterns.request.test(requestId) ? requestId : null,
    };
  } catch {
    // A transport loss or timeout: the request may have been sent.
    return { kind: "timeout" };
  } finally {
    clearTimeout(timer);
  }
}
async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) throw Error("STRIPE_REPLY_TOO_LARGE");
      chunks.push(item.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(out);
}
// A write with one same-key resend after a 429 (Retry-After within the budget).
async function stripeWrite(
  deps: StripeDependencies,
  path: string,
  form: Form,
  key: string,
  deadlineMs: number,
): Promise<Reply> {
  const first = await stripeCall(deps, "POST", path, form, key, deadlineMs);
  if (first.kind !== "rate_limited") return first;
  const wait = Math.min(first.retryAfterMs, stripeTimings.retryAfterMaxMs);
  if (deps.now() + wait >= deadlineMs) return first;
  await new Promise((resolve) => setTimeout(resolve, wait));
  return stripeCall(deps, "POST", path, form, key, deadlineMs);
}
const metadataOf = (json: Record<string, unknown>): Record<string, unknown> => {
  const m = json.metadata;
  return m !== null && typeof m === "object" && !Array.isArray(m)
    ? (m as Record<string, unknown>)
    : {};
};

// ---------------------------------------------------------------------------
// The operation protocol (migration 0027 stripe_op_begin and stripe_op_settle).
interface Begun {
  readonly outcome: string;
  readonly purpose: string;
  readonly params: Record<string, string>;
  readonly providerObjectId: string | null;
  readonly createdAtMs: number;
  /** The send fence (null before the first send). */
  readonly sendStartedAtMs: number | null;
}
const beginColumns =
  "created_at_ms,outcome,params,provider_object_id,purpose,request_digest,send_started_at_ms,status";
// What remains of the method's deadline for one transaction, or a hold before it starts.
function transactionBudget(deps: StripeDependencies, deadlineMs: number): number | null {
  const remaining = Math.floor(deadlineMs - deps.now());
  return remaining >= stripeTimings.transactionFloorMs ? remaining : null;
}
async function begin(
  deps: StripeDependencies,
  operationId: string,
  purpose: string,
  deadlineMs: number,
  digestParts: (params: Record<string, string>) => string[],
): Promise<Begun> {
  const budget = transactionBudget(deps, deadlineMs) ?? hold("PROVIDER_HELD");
  const row = await deps.transaction(budget, async (query) => {
    const rows = await query(billingVaultStatements.stripeOpBegin, [operationId]);
    return rows.length === 1 ? rows[0]! : hold();
  });
  if (Object.keys(row).sort().join(",") !== beginColumns || typeof row.outcome !== "string")
    return hold();
  if (
    ![
      "send",
      "reconcile",
      "held",
      "verified",
      "failed",
      "customer_pending",
      "intent_closed",
    ].includes(row.outcome)
  )
    return hold(
      row.outcome === "invalid" || row.outcome === "not_found" ? "INPUT_INVALID" : "STATE_INVALID",
    );
  if (
    row.purpose !== purpose ||
    typeof row.params !== "string" ||
    typeof row.request_digest !== "string"
  )
    return hold("INPUT_INVALID");
  const params = JSON.parse(row.params) as Record<string, string>;
  // The request the session authorised: recomputed from the database's own parameters.
  if ((await stripeRequestDigest(digestParts(params))) !== row.request_digest) return hold();
  const createdAtMs = Number(row.created_at_ms);
  if (!Number.isSafeInteger(createdAtMs)) return hold();
  const sendStartedAtMs = row.send_started_at_ms === null ? null : Number(row.send_started_at_ms);
  if (sendStartedAtMs !== null && !Number.isSafeInteger(sendStartedAtMs)) return hold();
  // A send or a reconciliation always follows the fence.
  if ((row.outcome === "send" || row.outcome === "reconcile") && sendStartedAtMs === null)
    return hold();
  return {
    outcome: row.outcome,
    purpose,
    params,
    providerObjectId: typeof row.provider_object_id === "string" ? row.provider_object_id : null,
    createdAtMs,
    sendStartedAtMs,
  };
}
// verified: a provider object read back; failed: a first send's own refusal (dispatching
// only); absent: a customer proven never created (uncertain only); held: a customer Stripe
// proved neither way (uncertain only; for the operator); uncertain: unknown.
type Settle = "verified" | "failed" | "absent" | "held" | "uncertain";
// Settles the operation; an unknown commit, too little time left, or any refusal (such as
// a concurrent reconciliation that moved it on) leaves it for reconciliation.
type Settled = "verified" | "failed" | "uncertain";
async function settle(
  deps: StripeDependencies,
  operationId: string,
  result: "held",
  objectId: null,
  requestId: null,
  deadlineMs: number,
): Promise<"held" | "uncertain">;
async function settle(
  deps: StripeDependencies,
  operationId: string,
  result: Exclude<Settle, "held">,
  objectId: string | null,
  requestId: string | null,
  deadlineMs: number,
): Promise<Settled>;
async function settle(
  deps: StripeDependencies,
  operationId: string,
  result: Settle,
  objectId: string | null,
  requestId: string | null,
  deadlineMs: number,
): Promise<Settled | "held"> {
  try {
    const budget = transactionBudget(deps, deadlineMs);
    if (budget === null) return "uncertain";
    const outcome = await deps.transaction(budget, async (query) => {
      const rows = await query(billingVaultStatements.stripeOpSettle, [
        operationId,
        result,
        objectId ?? "",
        requestId ?? "",
      ]);
      return rows.length === 1 ? rows[0]!.outcome : null;
    });
    if (result === "verified")
      return outcome === "verified" || outcome === "already_verified" ? "verified" : "uncertain";
    if (result === "failed" || result === "absent")
      return outcome === "failed" || outcome === "already_failed" ? "failed" : "uncertain";
    if (result === "held")
      return outcome === "held" || outcome === "already_held" ? "held" : "uncertain";
    return "uncertain";
  } catch {
    return "uncertain";
  }
}
// The method's one deadline, and the earlier one its HTTP calls stop at.
const budgetDeadline = (deps: StripeDependencies, budgetMs: number) => deps.now() + budgetMs;
const httpDeadline = (deadlineMs: number) => deadlineMs - stripeTimings.settleReserveMs;
// What a first send's non-2xx reply proves: a 4xx (other than 409, a request still in
// flight) or a 429 after the one resend means Stripe executed nothing, so the operation
// failed. A reconciliation's replay proves nothing about the first send (a changed
// parameter or a rotated key fails the replay while the first send may have succeeded), so
// each caller leaves a reconciling operation uncertain: never promoted either way.
const provesNoEffect = (reply: Reply) =>
  (reply.kind === "client_error" && reply.status !== 409) || reply.kind === "rate_limited";
const withinReplayWindow = (deps: StripeDependencies, begun: Begun) =>
  deps.now() - begun.createdAtMs < stripeTimings.replayWindowMs;
// No same-key replay (23 hours from creation, plus an hour) and no first send (an hour
// after its fence) can still create anything for this operation.
const absenceProvable = (deps: StripeDependencies, begun: Begun) =>
  begun.sendStartedAtMs !== null &&
  deps.now() - begun.createdAtMs >= stripeTimings.absenceAfterMs &&
  deps.now() - begun.sendStartedAtMs >= stripeTimings.absenceSendMarginMs;
const key = (deps: StripeDependencies, operationId: string) =>
  stripeIdempotencyKey(deps.stripe.environment, operationId);
const priceId = (priceKey: string) => {
  const id = priceKey.startsWith("stripe:price:") ? priceKey.slice("stripe:price:".length) : "";
  return stripeIdPatterns.price.test(id) ? id : hold();
};
const billingPage = (deps: StripeDependencies, workspaceId: string, query: string) =>
  `${deps.stripe.returnOrigin}/w/${encodeURIComponent(workspaceId)}/settings/billing${query}`;

// ---------------------------------------------------------------------------
// The workspace's customer: POST /v1/customers, never an email.
export async function stripeCustomerEnsure(
  deps: StripeDependencies,
  operationId: string,
  budgetMs: number,
): Promise<StripeCustomerResult> {
  const deadlineMs = budgetDeadline(deps, budgetMs);
  const deadline = httpDeadline(deadlineMs);
  const b = await begin(deps, operationId, "customer_create", deadlineMs, (p) => [
    "customer_create",
    operationId,
    p.organizationId ?? "",
    p.workspaceId ?? "",
  ]);
  if (b.outcome === "verified") return { outcome: "verified" };
  if (b.outcome === "failed") return { outcome: "failed" };
  // Held for the operator: no reconciliation until the operator's resolution.
  if (b.outcome === "held") return { outcome: "held" };
  const confirm = async (customer: unknown): Promise<StripeCustomerResult> => {
    if (typeof customer !== "string" || !stripeIdPatterns.customer.test(customer))
      return { outcome: await settle(deps, operationId, "uncertain", null, null, deadlineMs) };
    const read = await stripeCall(deps, "GET", "/v1/customers/" + customer, null, null, deadline);
    if (read.kind !== "ok" || metadataOf(read.json).morrow_operation_id !== operationId)
      return { outcome: "uncertain" };
    return { outcome: await settle(deps, operationId, "verified", customer, null, deadlineMs) };
  };
  const form: Form = [
    ["metadata[morrow_operation_id]", operationId],
    ["metadata[morrow_workspace_id]", b.params.workspaceId ?? hold()],
    ["metadata[morrow_organization_id]", b.params.organizationId ?? hold()],
  ];
  if (b.outcome === "reconcile") {
    // Readback first: the customer the first send may have created (search lags; a
    // same-key replay inside Stripe's idempotency window is safe either way).
    const found = await stripeCall(
      deps,
      "GET",
      "/v1/customers/search?query=" +
        encodeURIComponent(`metadata['morrow_operation_id']:'${operationId}'`),
      null,
      null,
      deadline,
    );
    const within = withinReplayWindow(deps, b);
    if (found.kind === "ok" && Array.isArray(found.json.data)) {
      const match = (found.json.data as Record<string, unknown>[]).filter(
        (c) => metadataOf(c).morrow_operation_id === operationId,
      );
      if (match.length === 1) return confirm(match[0]!.id);
      if (match.length > 1 && within) return { outcome: "uncertain" };
    }
    if (!within) {
      if (!absenceProvable(deps, b)) return { outcome: "uncertain" };
      // Past every replay and send: the strongly consistent list, not the lagging search.
      const listed = await customersOfOperation(deps, operationId, b, deadline);
      if (listed.kind === "unavailable") return { outcome: "uncertain" };
      if (listed.kind === "found" && listed.ids.length === 1) return confirm(listed.ids[0]);
      if (listed.kind === "found" && listed.ids.length === 0)
        return { outcome: await settle(deps, operationId, "absent", null, null, deadlineMs) };
      // Several customers of one operation, or more than the bounded list: Stripe proves
      // neither, so the operation is held for the operator (never promoted either way).
      return { outcome: await settle(deps, operationId, "held", null, null, deadlineMs) };
    }
  } else if (b.outcome !== "send") return hold();
  const reply = await stripeWrite(deps, "/v1/customers", form, key(deps, operationId), deadline);
  if (reply.kind === "ok") return confirm(reply.json.id);
  if (b.outcome === "reconcile") return { outcome: "uncertain" };
  return {
    outcome: await settle(
      deps,
      operationId,
      provesNoEffect(reply) ? "failed" : "uncertain",
      null,
      null,
      deadlineMs,
    ),
  };
}
// Every customer this operation could have created: GET /v1/customers (strongly
// consistent, unlike search) over created times from just before its send to an hour after
// its last possible replay, filtered on the operation in the metadata. "incomplete" when
// more customers were created in that range than the bounded pages hold (Stripe proves
// nothing then); "unavailable" for a failed or malformed page or the deadline (retried).
type Listed =
  | { readonly kind: "found"; readonly ids: readonly string[] }
  | { readonly kind: "incomplete" }
  | { readonly kind: "unavailable" };
async function customersOfOperation(
  deps: StripeDependencies,
  operationId: string,
  b: Begun,
  deadline: number,
): Promise<Listed> {
  const margin = stripeTimings.absenceListMarginSeconds;
  const sent = Math.floor(b.sendStartedAtMs! / 1000);
  const lastReplay = Math.floor((b.createdAtMs + stripeTimings.replayWindowMs) / 1000);
  const range =
    "created[gte]=" +
    (sent - margin.before) +
    "&created[lte]=" +
    (Math.max(sent, lastReplay) + margin.after);
  const found: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < stripeTimings.absenceListPages; page++) {
    const list = await stripeCall(
      deps,
      "GET",
      "/v1/customers?limit=100&" +
        range +
        (after ? "&starting_after=" + encodeURIComponent(after) : ""),
      null,
      null,
      deadline,
    );
    if (
      list.kind !== "ok" ||
      !Array.isArray(list.json.data) ||
      typeof list.json.has_more !== "boolean"
    )
      return { kind: "unavailable" };
    const data = list.json.data as Record<string, unknown>[];
    for (const c of data)
      if (metadataOf(c).morrow_operation_id === operationId) {
        if (typeof c.id !== "string" || !stripeIdPatterns.customer.test(c.id))
          return { kind: "unavailable" };
        found.push(c.id);
      }
    if (!list.json.has_more) return { kind: "found", ids: found };
    const last = data.at(-1)?.id;
    if (typeof last !== "string" || !stripeIdPatterns.customer.test(last))
      return { kind: "unavailable" };
    after = last;
  }
  return { kind: "incomplete" };
}

// ---------------------------------------------------------------------------
// A subscription-mode Checkout Session on the mapped customer (never customer_email).
export async function stripeCheckoutCreate(
  deps: StripeDependencies,
  operationId: string,
  budgetMs: number,
): Promise<StripeCheckoutResult> {
  const deadlineMs = budgetDeadline(deps, budgetMs);
  const deadline = httpDeadline(deadlineMs);
  const none = (outcome: StripeCheckoutResult["outcome"]): StripeCheckoutResult => ({
    outcome,
    checkoutUrl: null,
    expiresAtMs: null,
  });
  const b = await begin(deps, operationId, "checkout_session_create", deadlineMs, (p) => [
    "checkout_session_create",
    operationId,
    p.organizationId ?? "",
    p.workspaceId ?? "",
    p.intentId ?? "",
    p.priceKey ?? "",
    p.expiresAt ?? "",
    p.termsRevision ?? "",
  ]);
  if (b.outcome === "customer_pending") return none("pending");
  if (b.outcome === "intent_closed") return none("closed");
  if (b.outcome === "failed") return none("failed");
  if (b.params.mode !== "test") return hold();
  const session = async (id: string): Promise<StripeCheckoutResult | null> => {
    const read = await stripeCall(
      deps,
      "GET",
      "/v1/checkout/sessions/" + encodeURIComponent(id),
      null,
      null,
      deadline,
    );
    if (read.kind !== "ok") return null;
    const j = read.json;
    if (
      j.id !== id ||
      j.customer !== b.params.customerId ||
      metadataOf(j).morrow_operation_id !== operationId
    )
      return null;
    if (j.status !== "open") return none("closed");
    const url = j.url;
    const expires = j.expires_at;
    return typeof url === "string" && Number.isSafeInteger(expires)
      ? { outcome: "verified", checkoutUrl: url, expiresAtMs: (expires as number) * 1000 }
      : null;
  };
  if (b.outcome === "verified")
    return (await session(b.providerObjectId ?? hold())) ?? none("uncertain");
  const confirm = async (id: unknown): Promise<StripeCheckoutResult> => {
    if (typeof id !== "string" || !stripeIdPatterns.session.test(id))
      return none(await settle(deps, operationId, "uncertain", null, null, deadlineMs));
    const read = await session(id);
    if (!read) return none("uncertain");
    const settled = await settle(deps, operationId, "verified", id, null, deadlineMs);
    return settled === "verified" ? read : none("uncertain");
  };
  const customer = b.params.customerId ?? hold();
  if (b.outcome === "reconcile") {
    // Readback first: the customer's sessions created since this operation (a session of
    // it cannot be older), matched by the operation in their metadata.
    const list = await stripeCall(
      deps,
      "GET",
      "/v1/checkout/sessions?limit=100&customer=" +
        encodeURIComponent(customer) +
        "&created[gte]=" +
        (Math.floor(b.createdAtMs / 1000) - 60),
      null,
      null,
      deadline,
    );
    if (list.kind !== "ok" || !Array.isArray(list.json.data)) return none("uncertain");
    const match = (list.json.data as Record<string, unknown>[]).filter(
      (s) => metadataOf(s).morrow_operation_id === operationId,
    );
    if (match.length === 1) return confirm(match[0]!.id);
    if (match.length > 1 || list.json.has_more === true || !withinReplayWindow(deps, b))
      return none("uncertain");
  } else if (b.outcome !== "send") return hold();
  const ids: Form = [
    ["morrow_operation_id", operationId],
    ["morrow_workspace_id", b.params.workspaceId ?? hold()],
    ["morrow_organization_id", b.params.organizationId ?? hold()],
  ];
  const c = deps.stripe.configuration;
  const form: Form = [
    ["mode", "subscription"],
    ["customer", customer],
    ["line_items[0][price]", priceId(b.params.priceKey ?? hold())],
    ["line_items[0][quantity]", "1"],
    ["expires_at", b.params.expiresAt ?? hold()],
    ["success_url", billingPage(deps, b.params.workspaceId!, "?checkout=complete")],
    ["cancel_url", billingPage(deps, b.params.workspaceId!, "?checkout=cancelled")],
    ...ids.map(([k, v]) => ["metadata[" + k + "]", v] as const),
    ...ids.map(([k, v]) => ["subscription_data[metadata][" + k + "]", v] as const),
    ["billing_address_collection", c.billingAddressCollection],
    ["automatic_tax[enabled]", String(c.automaticTax)],
    ...(c.automaticTax ? ([["customer_update[address]", "auto"]] as const) : []),
    ["allow_promotion_codes", "false"],
    // Card only: no delayed payment method, so a completed session's first invoice is
    // decided within minutes (an open or completed intent never waits days for it).
    ["payment_method_types[0]", "card"],
  ];
  const reply = await stripeWrite(
    deps,
    "/v1/checkout/sessions",
    form,
    key(deps, operationId),
    deadline,
  );
  if (reply.kind === "ok") return confirm(reply.json.id);
  if (b.outcome === "reconcile") return none("uncertain");
  return none(
    await settle(
      deps,
      operationId,
      provesNoEffect(reply) ? "failed" : "uncertain",
      null,
      null,
      deadlineMs,
    ),
  );
}

// ---------------------------------------------------------------------------
// A customer portal session through the saved configuration. Stripe has no retrieve
// endpoint for it, so only a same-key replay within 23 hours reconciles.
export async function stripePortalCreate(
  deps: StripeDependencies,
  operationId: string,
  budgetMs: number,
): Promise<StripePortalResult> {
  const deadlineMs = budgetDeadline(deps, budgetMs);
  const deadline = httpDeadline(deadlineMs);
  const b = await begin(deps, operationId, "portal_session_create", deadlineMs, (p) => [
    "portal_session_create",
    operationId,
    p.organizationId ?? "",
    p.workspaceId ?? "",
    p.customerId ?? "",
  ]);
  if (b.outcome === "failed") return { outcome: "failed", portalUrl: null };
  if (b.outcome !== "send" && !withinReplayWindow(deps, b))
    return { outcome: "uncertain", portalUrl: null };
  if (!["send", "reconcile", "verified"].includes(b.outcome)) return hold();
  const form: Form = [
    ["customer", b.params.customerId ?? hold()],
    ["configuration", deps.stripe.configuration.portalConfigurationId],
    ["return_url", billingPage(deps, b.params.workspaceId ?? hold(), "")],
  ];
  const reply = await stripeWrite(
    deps,
    "/v1/billing_portal/sessions",
    form,
    key(deps, operationId),
    deadline,
  );
  if (reply.kind === "ok") {
    const id = reply.json.id;
    const url = reply.json.url;
    if (
      typeof id !== "string" ||
      !stripeIdPatterns.portal.test(id) ||
      typeof url !== "string" ||
      reply.json.customer !== b.params.customerId
    )
      return {
        outcome: await settle(deps, operationId, "uncertain", null, null, deadlineMs),
        portalUrl: null,
      };
    if (b.outcome === "verified")
      return b.providerObjectId === id
        ? { outcome: "verified", portalUrl: url }
        : { outcome: "uncertain", portalUrl: null };
    const settled = await settle(deps, operationId, "verified", id, reply.requestId, deadlineMs);
    return settled === "verified"
      ? { outcome: "verified", portalUrl: url }
      : { outcome: "uncertain", portalUrl: null };
  }
  if (b.outcome !== "send") return { outcome: "uncertain", portalUrl: null };
  return {
    outcome: await settle(
      deps,
      operationId,
      provesNoEffect(reply) ? "failed" : "uncertain",
      null,
      null,
      deadlineMs,
    ),
    portalUrl: null,
  };
}

// ---------------------------------------------------------------------------
// Webhooks.
const encoder = new TextEncoder();
/** Parses Stripe-Signature: one t= and the v1= signatures; anything malformed is null. */
export function parseStripeSignature(
  header: string,
): { readonly timestamp: number; readonly signatures: readonly string[] } | null {
  if (header.length > 4096) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) return null;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === "t") {
      if (timestamp !== null || !/^[1-9][0-9]{8,11}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (name === "v1") {
      if (!/^[a-f0-9]{64}$/.test(value)) return null;
      signatures.push(value);
    }
  }
  return timestamp !== null && signatures.length > 0 && signatures.length <= 8
    ? { timestamp, signatures }
    : null;
}
/** Constant-time equality of two hex digests of equal length. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
/** HMAC-SHA256 over `${t}.` and the raw body bytes, as Stripe signs it. */
export async function stripeSignature(
  secret: string,
  timestamp: number,
  raw: Uint8Array,
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = encoder.encode(timestamp + ".");
  const signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix);
  signed.set(raw, prefix.length);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keyMaterial, signed));
  return [...mac].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function decodeBase64(text: string, maximum: number): Uint8Array | null {
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(text) ||
    text.length % 4 !== 0 ||
    text.length > Math.ceil(maximum / 3) * 4
  )
    return null;
  try {
    const binary = atob(text);
    if (binary.length > maximum) return null;
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
const rejected: StripeWebhookResult = Object.freeze({
  verdict: "rejected",
  receiptId: null,
  objectDigest: null,
  attributed: null,
});
const ignored: StripeWebhookResult = Object.freeze({
  verdict: "ignored",
  receiptId: null,
  objectDigest: null,
  attributed: null,
});
/**
 * The webhook's fixed reason, for the broker's one log line (never provider text): a
 * refusal (rejected), or object_invalid, a subscribed event whose read-back object is
 * outside the closed shape (held, so Stripe retries and its dashboard shows the failures).
 */
export type WebhookRefusal =
  | "body_invalid"
  | "signature_invalid"
  | "timestamp_outside_tolerance"
  | "event_invalid"
  | "mode_mismatch"
  | "object_not_found"
  | "object_invalid";
/** The subscribed event type a refusal concerns, once known (one of the six). */
export type WebhookLog = (reason: WebhookRefusal, eventType: StripeEventType | null) => void;

export async function stripeWebhookVerify(
  deps: StripeDependencies,
  rawBodyBase64: string,
  signatureHeader: string,
  budgetMs: number,
  log: WebhookLog = () => {},
): Promise<StripeWebhookResult> {
  const deadlineMs = budgetDeadline(deps, budgetMs);
  const deadline = httpDeadline(deadlineMs);
  let eventType: StripeEventType | null = null;
  const refuse = (reason: WebhookRefusal) => {
    log(reason, eventType);
    return rejected;
  };
  const raw = decodeBase64(rawBodyBase64, 262144);
  if (!raw || raw.length === 0) return refuse("body_invalid");
  const signature = parseStripeSignature(signatureHeader);
  if (!signature) return refuse("signature_invalid");
  if (
    Math.abs(Math.floor(deps.now() / 1000) - signature.timestamp) > stripeTimings.toleranceSeconds
  )
    return refuse("timestamp_outside_tolerance");
  const expected = await stripeSignature(deps.stripe.webhookSecret, signature.timestamp, raw);
  // Every candidate is compared, in constant time, before deciding.
  let matched = false;
  for (const candidate of signature.signatures)
    matched = constantTimeEqual(candidate, expected) || matched;
  if (!matched) return refuse("signature_invalid");
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw),
    ) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return refuse("event_invalid");
    event = parsed as Record<string, unknown>;
  } catch {
    return refuse("event_invalid");
  }
  const type = event.type;
  if (
    event.object !== "event" ||
    typeof event.id !== "string" ||
    !stripeIdPatterns.event.test(event.id)
  )
    return refuse("event_invalid");
  if (!isStripeEventType(type)) return ignored;
  eventType = type;
  // livemode must be the environment's (development and staging: test only).
  if (event.livemode !== false) return refuse("mode_mismatch");
  const data = event.data;
  const object =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).object
      : null;
  if (object === null || typeof object !== "object" || Array.isArray(object))
    return refuse("event_invalid");
  const objectId = (object as Record<string, unknown>).id;
  const kind = stripeEventObjects[type];
  // The readback with the broker's own key proves the account: another account's object
  // is a 404. Only the read-back object is recorded, never the event's copy.
  const read = async (path: string): Promise<Record<string, unknown> | "absent" | "held"> => {
    const reply = await stripeCall(deps, "GET", path, null, null, deadline);
    if (reply.kind === "ok") return reply.json;
    if (reply.kind === "client_error" && (reply.status === 404 || reply.status === 400))
      return "absent";
    return "held";
  };
  let normalized: NormalizedStripeObject;
  try {
    if (kind === "invoice") {
      if (typeof objectId !== "string" || !stripeIdPatterns.invoice.test(objectId))
        return refuse("event_invalid");
      const invoice = await read("/v1/invoices/" + objectId);
      if (invoice === "held") return hold("PROVIDER_HELD");
      if (invoice === "absent") return refuse("object_not_found");
      const parent = invoice.parent as Record<string, unknown> | null | undefined;
      const details =
        parent && parent.type === "subscription_details"
          ? (parent.subscription_details as Record<string, unknown> | null)
          : null;
      const sub = details?.subscription;
      const subId =
        typeof sub === "string"
          ? sub
          : sub && typeof sub === "object"
            ? (sub as { id?: unknown }).id
            : null;
      let subscription: Record<string, unknown> | null = null;
      if (typeof subId === "string" && stripeIdPatterns.subscription.test(subId)) {
        const s = await read("/v1/subscriptions/" + subId);
        if (s === "held") return hold("PROVIDER_HELD");
        if (s === "absent") return refuse("object_not_found");
        subscription = s;
      }
      normalized = normalizeInvoice(invoice, subscription);
    } else if (kind === "subscription") {
      if (typeof objectId !== "string" || !stripeIdPatterns.subscription.test(objectId))
        return refuse("event_invalid");
      const s = await read("/v1/subscriptions/" + objectId);
      if (s === "held") return hold("PROVIDER_HELD");
      if (s === "absent") return refuse("object_not_found");
      normalized = normalizeSubscription(s);
    } else {
      if (typeof objectId !== "string" || !stripeIdPatterns.session.test(objectId))
        return refuse("event_invalid");
      const s = await read("/v1/checkout/sessions/" + objectId);
      if (s === "held") return hold("PROVIDER_HELD");
      if (s === "absent") return refuse("object_not_found");
      normalized = normalizeCheckoutSession(s);
    }
  } catch (error) {
    if (error instanceof StripeHold) throw error;
    // A subscribed event whose read-back object is outside the closed shape (no customer,
    // or a field of another shape): never acknowledged and dropped. It is held with its own
    // fixed reason, so the api answers 503, Stripe keeps retrying and the endpoint shows the
    // failures, and the broker's log line names the event type.
    log("object_invalid", eventType);
    return hold("PROVIDER_HELD");
  }
  if (normalized.id !== objectId || normalized.livemode !== false) return refuse("mode_mismatch");
  const digest = await stripeObjectDigest(normalized);
  const budget = transactionBudget(deps, deadlineMs) ?? hold("PROVIDER_HELD");
  const row = await deps.transaction(budget, async (query) => {
    const rows = await query(billingVaultStatements.stripeReceiptRecord, [
      event.id as string,
      type,
      "false",
      normalized.kind,
      normalized.id,
      normalized.customer,
      JSON.stringify(normalized),
      digest,
      String(deps.now()),
    ]);
    return rows.length === 1 ? rows[0]! : hold();
  });
  if (row.outcome !== "recorded" && row.outcome !== "duplicate") return hold("STATE_INVALID");
  if (
    typeof row.receipt_id !== "string" ||
    typeof row.object_digest !== "string" ||
    (row.attributed !== "true" && row.attributed !== "false")
  )
    return hold();
  return {
    verdict: row.outcome,
    receiptId: row.receipt_id,
    objectDigest: row.object_digest,
    attributed: row.attributed === "true",
  };
}
