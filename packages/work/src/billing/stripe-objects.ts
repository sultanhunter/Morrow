// Stripe objects on the one pinned API version (M5 PR-1; ADR-0022 item 12). Pure and
// import-free, so the broker bundle (no validators, no api source) and the api share it.
//
// The broker reads every webhook object back with its own key and reduces it to one of
// three closed shapes: ids, integer amounts, statuses and whole-second times only (no
// email, card, address or URL; ADR-0022 item 13). The shape and its digest are recorded on
// stripe_event_receipts; the api plans an application from the shape, and receipt_apply
// re-derives the money from it in SQL (migration 0027 receipt_object_valid). Field mapping
// on the pinned version (docs/briefs/M5-billing.md): the invoice's subscription and its
// metadata from parent.subscription_details, the price and period from the first line
// (pricing.price_details.price, period), the period end from the subscription item, and
// cancellation from cancel_at as well as cancel_at_period_end.

/** The pinned Stripe API version: broker requests, webhook endpoint and fixtures. */
export const stripeApiVersion = "2025-03-31.basil";

export class StripeObjectError extends Error {
  constructor(readonly code: "STRIPE_OBJECT_INVALID" | "STRIPE_INPUT_INVALID") {
    super(code);
    this.name = "StripeObjectError";
  }
}
const invalid = (): never => {
  throw new StripeObjectError("STRIPE_OBJECT_INVALID");
};

/** The six subscribed events (ADR-0022 item 12) and the object each carries. */
export const stripeEventObjects = Object.freeze({
  "checkout.session.completed": "checkout_session",
  "checkout.session.expired": "checkout_session",
  "invoice.paid": "invoice",
  "invoice.payment_failed": "invoice",
  "customer.subscription.updated": "subscription",
  "customer.subscription.deleted": "subscription",
} as const);
export type StripeEventType = keyof typeof stripeEventObjects;
export type StripeObjectKind = (typeof stripeEventObjects)[StripeEventType];
export const isStripeEventType = (value: unknown): value is StripeEventType =>
  typeof value === "string" && Object.hasOwn(stripeEventObjects, value);

export const stripeSubscriptionStatuses = Object.freeze([
  "active",
  "trialing",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "unpaid",
  "paused",
  "canceled",
] as const);
export type StripeSubscriptionStatus = (typeof stripeSubscriptionStatuses)[number];

/** The Morrow ids a Stripe object carries in its metadata, each null when absent. */
export interface StripeMetadataIds {
  readonly operationId: string | null;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
}
export interface StripeSubscriptionState {
  readonly status: StripeSubscriptionStatus;
  readonly cancelAtPeriodEnd: boolean;
  /** Unix seconds as a string, or null. */
  readonly cancelAt: string | null;
  readonly currentPeriodEnd: string | null;
}
export interface NormalizedInvoice {
  readonly kind: "invoice";
  readonly id: string;
  readonly customer: string;
  readonly livemode: boolean;
  readonly status: "draft" | "open" | "paid" | "uncollectible" | "void";
  readonly billingReason: string | null;
  /** Integer minor units as a string. */
  readonly amountPaid: string;
  /** Lowercase ISO currency, as Stripe sends it. */
  readonly currency: string;
  readonly subscription: string | null;
  readonly price: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly metadata: StripeMetadataIds;
  /** The invoice's subscription read back with it, or null when it has none. */
  readonly subscriptionState: StripeSubscriptionState | null;
}
export interface NormalizedSubscription extends StripeSubscriptionState {
  readonly kind: "subscription";
  readonly id: string;
  readonly customer: string;
  readonly livemode: boolean;
  readonly price: string | null;
  readonly metadata: StripeMetadataIds;
}
export interface NormalizedCheckoutSession {
  readonly kind: "checkout_session";
  readonly id: string;
  readonly customer: string;
  readonly livemode: boolean;
  readonly status: "open" | "complete" | "expired";
  readonly subscription: string | null;
  readonly metadata: StripeMetadataIds;
}
export type NormalizedStripeObject =
  | NormalizedInvoice
  | NormalizedSubscription
  | NormalizedCheckoutSession;

const patterns = Object.freeze({
  invoice: /^in_[A-Za-z0-9]{8,100}$/,
  subscription: /^sub_[A-Za-z0-9]{8,100}$/,
  customer: /^cus_[A-Za-z0-9]{8,100}$/,
  price: /^price_[A-Za-z0-9]{8,100}$/,
  session: /^cs_[A-Za-z0-9_]{8,250}$/,
  portal: /^bps_[A-Za-z0-9_]{8,250}$/,
  event: /^evt_[A-Za-z0-9_]{8,250}$/,
  request: /^req_[A-Za-z0-9]{8,64}$/,
  uuid: /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
  morrowId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  reason: /^[a-z][a-z_]{0,63}$/,
  currency: /^[a-z]{3}$/,
});
export const stripeIdPatterns = patterns;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? (value as Record<string, unknown>)
    : null;
const field = (value: Record<string, unknown>, name: string): unknown =>
  Object.hasOwn(value, name) ? value[name] : undefined;
const matches = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
// An id or an expanded object with that id (Stripe's expandable fields).
function expandable(value: unknown, pattern: RegExp): string | null {
  if (value === null || value === undefined) return null;
  if (matches(pattern, value)) return value;
  const expanded = record(value);
  const id = expanded ? field(expanded, "id") : undefined;
  return matches(pattern, id) ? id : invalid();
}
// A whole Unix second: 2001-09-09 to 5138-11-16 (9 to 11 digits), as a string.
function seconds(value: unknown, nullable: boolean): string | null {
  if (value === null || value === undefined) return nullable ? null : invalid();
  if (!Number.isSafeInteger(value) || (value as number) < 1e8 || (value as number) > 99999999999)
    return invalid();
  return String(value);
}
function metadataIds(value: unknown): StripeMetadataIds {
  if (value === null || value === undefined)
    return { operationId: null, organizationId: null, workspaceId: null };
  const m = record(value) ?? invalid();
  const id = (name: string, pattern: RegExp): string | null => {
    const v = field(m, name);
    if (v === undefined || v === null || v === "") return null;
    return matches(pattern, v) ? v : null;
  };
  return {
    operationId: id("morrow_operation_id", patterns.uuid),
    organizationId: id("morrow_organization_id", patterns.morrowId),
    workspaceId: id("morrow_workspace_id", patterns.morrowId),
  };
}
function subscriptionState(raw: Record<string, unknown>): StripeSubscriptionState {
  const status = field(raw, "status");
  if (!(stripeSubscriptionStatuses as readonly unknown[]).includes(status)) return invalid();
  const cancelAtPeriodEnd = field(raw, "cancel_at_period_end");
  if (typeof cancelAtPeriodEnd !== "boolean") return invalid();
  // The period end lives on the subscription item on the pinned version.
  const items = record(field(raw, "items"));
  const data = items ? field(items, "data") : undefined;
  let currentPeriodEnd: string | null = null;
  if (Array.isArray(data) && data.length > 0) {
    const ends = data.map((item) =>
      seconds(field(record(item) ?? invalid(), "current_period_end"), true),
    );
    const known = ends.filter((e): e is string => e !== null).map(Number);
    currentPeriodEnd = known.length ? String(Math.min(...known)) : null;
  }
  return {
    status: status as StripeSubscriptionStatus,
    cancelAtPeriodEnd,
    cancelAt: seconds(field(raw, "cancel_at"), true),
    currentPeriodEnd,
  };
}
function firstItemPrice(raw: Record<string, unknown>): string | null {
  const items = record(field(raw, "items"));
  const data = items ? field(items, "data") : undefined;
  if (!Array.isArray(data) || data.length === 0) return null;
  const price = field(record(data[0]) ?? invalid(), "price");
  return expandable(price, patterns.price);
}

/** Reduces a read-back subscription to its closed shape. */
export function normalizeSubscription(value: unknown): NormalizedSubscription {
  const raw = record(value) ?? invalid();
  if (field(raw, "object") !== "subscription") return invalid();
  const id = field(raw, "id");
  const livemode = field(raw, "livemode");
  if (!matches(patterns.subscription, id) || typeof livemode !== "boolean") return invalid();
  return Object.freeze({
    kind: "subscription",
    id,
    customer: expandable(field(raw, "customer"), patterns.customer) ?? invalid(),
    livemode,
    ...subscriptionState(raw),
    price: firstItemPrice(raw),
    metadata: Object.freeze(metadataIds(field(raw, "metadata"))),
  });
}

/**
 * Reduces a read-back invoice, and its subscription when it has one, to the closed shape.
 * The subscription and its metadata come from parent.subscription_details; the price and
 * the period from the first line.
 */
export function normalizeInvoice(value: unknown, subscription: unknown): NormalizedInvoice {
  const raw = record(value) ?? invalid();
  if (field(raw, "object") !== "invoice") return invalid();
  const id = field(raw, "id");
  const livemode = field(raw, "livemode");
  const status = field(raw, "status");
  const amountPaid = field(raw, "amount_paid");
  const currency = field(raw, "currency");
  const reason = field(raw, "billing_reason");
  if (
    !matches(patterns.invoice, id) ||
    typeof livemode !== "boolean" ||
    !["draft", "open", "paid", "uncollectible", "void"].includes(status as string) ||
    !Number.isSafeInteger(amountPaid) ||
    (amountPaid as number) < 0 ||
    !matches(patterns.currency, currency) ||
    !(reason === null || reason === undefined || matches(patterns.reason, reason))
  )
    return invalid();
  const parent = record(field(raw, "parent"));
  const details =
    parent && field(parent, "type") === "subscription_details"
      ? record(field(parent, "subscription_details"))
      : null;
  const subscriptionId = details
    ? expandable(field(details, "subscription"), patterns.subscription)
    : null;
  const lines = record(field(raw, "lines"));
  const data = lines ? field(lines, "data") : undefined;
  let price: string | null = null,
    periodStart: string | null = null,
    periodEnd: string | null = null;
  if (Array.isArray(data) && data.length > 0) {
    const line = record(data[0]) ?? invalid();
    const pricing = record(field(line, "pricing"));
    const priceDetails =
      pricing && field(pricing, "type") === "price_details"
        ? record(field(pricing, "price_details"))
        : null;
    price = priceDetails ? expandable(field(priceDetails, "price"), patterns.price) : null;
    const period = record(field(line, "period"));
    if (period) {
      periodStart = seconds(field(period, "start"), true);
      periodEnd = seconds(field(period, "end"), true);
    }
  }
  let state: StripeSubscriptionState | null = null;
  if (subscriptionId !== null) {
    const sub = normalizeSubscription(subscription);
    if (sub.id !== subscriptionId) return invalid();
    state = Object.freeze({
      status: sub.status,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      cancelAt: sub.cancelAt,
      currentPeriodEnd: sub.currentPeriodEnd,
    });
  } else if (subscription !== null && subscription !== undefined) return invalid();
  return Object.freeze({
    kind: "invoice",
    id,
    customer: expandable(field(raw, "customer"), patterns.customer) ?? invalid(),
    livemode,
    status: status as NormalizedInvoice["status"],
    billingReason: (reason ?? null) as string | null,
    amountPaid: String(amountPaid),
    currency,
    subscription: subscriptionId,
    price,
    periodStart,
    periodEnd,
    metadata: Object.freeze(metadataIds(details ? field(details, "metadata") : null)),
    subscriptionState: state,
  });
}

/** Reduces a read-back Checkout Session to its closed shape. */
export function normalizeCheckoutSession(value: unknown): NormalizedCheckoutSession {
  const raw = record(value) ?? invalid();
  if (field(raw, "object") !== "checkout.session") return invalid();
  const id = field(raw, "id");
  const livemode = field(raw, "livemode");
  const status = field(raw, "status");
  if (
    !matches(patterns.session, id) ||
    typeof livemode !== "boolean" ||
    !["open", "complete", "expired"].includes(status as string)
  )
    return invalid();
  return Object.freeze({
    kind: "checkout_session",
    id,
    customer: expandable(field(raw, "customer"), patterns.customer) ?? invalid(),
    livemode,
    status: status as NormalizedCheckoutSession["status"],
    subscription: expandable(field(raw, "subscription"), patterns.subscription),
    metadata: Object.freeze(metadataIds(field(raw, "metadata"))),
  });
}

/** Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace. */
export function stripeCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StripeObjectError("STRIPE_INPUT_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(stripeCanonicalJson).join(",") + "]";
  const r = record(value);
  if (!r) throw new StripeObjectError("STRIPE_INPUT_INVALID");
  return (
    "{" +
    Object.keys(r)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stripeCanonicalJson(r[key]))
      .join(",") +
    "}"
  );
}
export async function stripeSha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** The digest a receipt records and receipt_begin/receipt_apply compare. */
export const stripeObjectDigest = (object: NormalizedStripeObject): Promise<string> =>
  stripeSha256Hex(stripeCanonicalJson(object));

/** USD minor units to the BillingMoney amount receipt_apply writes ("4900" -> "49.00"). */
export function usdAmount(minorUnits: string): string {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(minorUnits))
    throw new StripeObjectError("STRIPE_INPUT_INVALID");
  const cents = BigInt(minorUnits);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

/**
 * The request digest of one Stripe operation (migration 0027 cmd_checkout_open and
 * cmd_portal_open): SHA-256 of the JSON array that PostgreSQL's array_to_json writes for the
 * same text parts. Parts are ids, keys and integers only, so both serialise identically.
 */
export function stripeRequestDigest(parts: readonly string[]): Promise<string> {
  if (!parts.every((p) => typeof p === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(p)))
    throw new StripeObjectError("STRIPE_INPUT_INVALID");
  return stripeSha256Hex(JSON.stringify(["morrow.billing.stripe_request", "1", ...parts]));
}

/** The Idempotency-Key bound to one operation: never a new key for a retry (invariant 10). */
export function stripeIdempotencyKey(environment: string, operationId: string): string {
  if (
    !["development", "staging", "production"].includes(environment) ||
    !matches(patterns.uuid, operationId)
  )
    throw new StripeObjectError("STRIPE_INPUT_INVALID");
  return `morrow-${environment}-${operationId}`;
}
