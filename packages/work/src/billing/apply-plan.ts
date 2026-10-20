import type {
  CurrentBilling_BillingTerms,
  CurrentBilling_EntitlementSnapshot,
  CurrentBilling_VerifiedPaymentEvent,
} from "@morrow/contracts";
import { validateDefinition } from "@morrow/contracts/validation";
import {
  classifyPayment,
  environmentMode,
  foldEntitlementEvidence,
  mapProviderStatus,
  parseBillingTerms,
  parseWorkspaceBillingFacts,
  stripePaymentKind,
  workspaceBillingState,
  type BillingEnvironment,
  type PaymentOutcome,
} from "@morrow/policy/billing-state";
import { workspaceBillingRouteFromRow } from "../billing-route.js";
import {
  accountFromRow,
  associationFromRow,
  billingFactsInput,
  conflictFromRow,
  snapshotFromRow,
} from "./facts.js";
import {
  isStripeEventType,
  stripeEventObjects,
  usdAmount,
  type NormalizedCheckoutSession,
  type NormalizedInvoice,
  type NormalizedStripeObject,
  type NormalizedSubscription,
  type StripeEventType,
  type StripeSubscriptionState,
} from "./stripe-objects.js";

// The receipt application planner (M5 PR-1; P01.T04a §5; ADR-0022 item 9 amendment). Pure:
// from receipt_begin's facts (the recorded receipt and its tenant's billing records, read
// under the route row's lock) it decides one closed plan with classifyPayment and
// foldEntitlementEvidence. receipt_apply then re-derives every money and authority fact in
// SQL and accepts only plans the receipt allows, so this planner chooses among outcomes; it
// never supplies an amount, a key, a mode, a tenant or a credit quantity.

export class ReceiptPlanError extends Error {
  constructor(readonly code: "RECEIPT_FACTS_INVALID") {
    super(code);
    this.name = "ReceiptPlanError";
  }
}
const invalid = (): never => {
  throw new ReceiptPlanError("RECEIPT_FACTS_INVALID");
};

export type ReceiptOutcome =
  | "applied"
  | "held"
  | "conflict"
  | "no_charge"
  | "refused"
  | "already_granted"
  | "ignored";
export interface ReceiptPlan {
  readonly schemaVersion: 1;
  readonly outcome: ReceiptOutcome;
  readonly code: string | null;
  readonly payment: null | {
    readonly action: "fix_route_and_grant" | "grant" | "record";
    readonly outcome: "granted" | "held" | "no_charge" | "conflict";
    readonly code: string | null;
    readonly termsRevision: number;
  };
  readonly snapshot: null | { readonly revision: number };
  readonly intent: null | {
    readonly intentId: string;
    readonly to: "completed" | "expired" | "verified";
  };
}

/** The receipt as receipt_begin returns it. */
export interface BegunReceipt {
  readonly id: string;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly eventId: string;
  readonly eventType: StripeEventType;
  readonly livemode: boolean;
  readonly mode: "live" | "test";
  readonly objectType: "invoice" | "subscription" | "checkout_session";
  readonly objectId: string;
  readonly customerId: string;
  readonly object: NormalizedStripeObject;
  readonly objectDigest: string;
  readonly observedAt: string;
}
type Row = Record<string, unknown>;
const plain = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keysOf = (value: Row) => Object.keys(value).sort().join(",");
const id = (value: unknown): value is string => validateDefinition("core", "Id", value);
const utc = (value: unknown): value is string =>
  validateDefinition("core", "UtcTime", value) && Number.isFinite(Date.parse(value as string));

function parseReceipt(value: unknown): BegunReceipt {
  if (
    !plain(value) ||
    keysOf(value) !==
      "customerId,eventId,eventType,id,livemode,mode,object,objectDigest,objectId,objectType,observedAt,organizationId,workspaceId"
  )
    return invalid();
  const r = value;
  if (
    !id(r.id) ||
    (r.organizationId === null) !== (r.workspaceId === null) ||
    (r.organizationId !== null && (!id(r.organizationId) || !id(r.workspaceId))) ||
    typeof r.eventId !== "string" ||
    !isStripeEventType(r.eventType) ||
    typeof r.livemode !== "boolean" ||
    r.mode !== (r.livemode ? "live" : "test") ||
    stripeEventObjects[r.eventType] !== r.objectType ||
    typeof r.objectId !== "string" ||
    typeof r.customerId !== "string" ||
    !plain(r.object) ||
    r.object.kind !== r.objectType ||
    r.object.id !== r.objectId ||
    typeof r.objectDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.objectDigest) ||
    !utc(r.observedAt)
  )
    return invalid();
  return r as unknown as BegunReceipt;
}

/** receipt_begin's facts: the receipt, and for an attributed receipt its tenant's records. */
export interface ReceiptFacts {
  readonly receipt: BegunReceipt;
  readonly records: null | {
    readonly route: Row | null;
    readonly associations: readonly Row[];
    readonly account: Row | null;
    readonly snapshot: Row | null;
    readonly conflicts: readonly Row[];
    readonly intentPending: boolean;
    readonly terms: null | { readonly termsRevision: string; readonly terms: unknown };
    readonly payment: null | {
      readonly paymentKey: string;
      readonly granted: boolean;
      readonly recorded: boolean;
    };
    readonly checkoutOperation: null | {
      readonly operationId: string | null;
      readonly intentId: string | null;
    };
    readonly intent: null | {
      readonly id: string;
      readonly status: string;
      readonly revision: string;
    };
  };
}
export function parseReceiptFacts(text: unknown): ReceiptFacts {
  let value: unknown;
  try {
    value = typeof text === "string" ? JSON.parse(text) : invalid();
  } catch {
    return invalid();
  }
  if (!plain(value)) return invalid();
  const receipt = parseReceipt(value.receipt);
  if (receipt.organizationId === null) {
    if (keysOf(value) !== "receipt") return invalid();
    return Object.freeze({ receipt, records: null });
  }
  if (
    keysOf(value) !==
    "account,associations,checkoutOperation,conflicts,intent,intentPending,payment,receipt,route,snapshot,terms"
  )
    return invalid();
  const nullableRow = (v: unknown): Row | null => (v === null ? null : plain(v) ? v : invalid());
  const rows = (v: unknown): readonly Row[] =>
    Array.isArray(v) && v.every(plain) ? (v as Row[]) : invalid();
  const terms = value.terms;
  const payment = value.payment;
  const operation = value.checkoutOperation;
  const intent = value.intent;
  if (
    typeof value.intentPending !== "boolean" ||
    !(
      terms === null ||
      (plain(terms) &&
        keysOf(terms) === "terms,termsRevision" &&
        typeof terms.termsRevision === "string")
    ) ||
    !(
      payment === null ||
      (plain(payment) &&
        keysOf(payment) === "granted,paymentKey,recorded" &&
        typeof payment.paymentKey === "string" &&
        typeof payment.granted === "boolean" &&
        typeof payment.recorded === "boolean")
    ) ||
    !(
      operation === null ||
      (plain(operation) &&
        keysOf(operation) === "intentId,operationId" &&
        (operation.operationId === null || id(operation.operationId)) &&
        (operation.intentId === null || id(operation.intentId)))
    ) ||
    !(
      intent === null ||
      (plain(intent) &&
        keysOf(intent) === "id,revision,status" &&
        id(intent.id) &&
        typeof intent.status === "string")
    )
  )
    return invalid();
  type Records = NonNullable<ReceiptFacts["records"]>;
  return Object.freeze({
    receipt,
    records: Object.freeze({
      route: nullableRow(value.route),
      associations: rows(value.associations),
      account: nullableRow(value.account),
      snapshot: nullableRow(value.snapshot),
      conflicts: rows(value.conflicts),
      intentPending: value.intentPending,
      terms: terms as Records["terms"],
      payment: payment as Records["payment"],
      checkoutOperation: operation as Records["checkoutOperation"],
      intent: intent as Records["intent"],
    }),
  });
}

const iso = (seconds: string) => new Date(Number(seconds) * 1000).toISOString();
/** validUntil = min(item period end, cancel_at), or the observation itself when neither. */
export function subscriptionValidUntil(state: StripeSubscriptionState, observedAt: string): string {
  const ends = [state.currentPeriodEnd, state.cancelAt]
    .filter((s): s is string => s !== null)
    .map(Number);
  return ends.length ? iso(String(Math.min(...ends))) : observedAt;
}
function subscriptionOf(
  object: NormalizedStripeObject,
): { readonly key: string; readonly state: StripeSubscriptionState } | null {
  if (object.kind === "invoice")
    return object.subscription && object.subscriptionState
      ? { key: "stripe:sub:" + object.subscription, state: object.subscriptionState }
      : null;
  if (object.kind === "subscription") {
    const s = object as NormalizedSubscription;
    return {
      key: "stripe:sub:" + s.id,
      state: {
        status: s.status,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        cancelAt: s.cancelAt,
        currentPeriodEnd: s.currentPeriodEnd,
      },
    };
  }
  return null;
}

/**
 * The VerifiedPaymentEvent@1 of an attributed invoice.paid, or null when no subscription
 * period can be derived (an unmapped billing_reason, a non-USD currency or a missing
 * subscription, price or period), which is held TERMS_MISMATCH without an event. The
 * operation is the metadata's only when it names this workspace (and organization, when
 * present) and a checkout operation of this tenant (R8; receipt_apply re-derives it).
 */
export function paymentEventFor(
  receipt: BegunReceipt,
  operationId: string | null,
): CurrentBilling_VerifiedPaymentEvent | null {
  const invoice = receipt.object as NormalizedInvoice;
  if (invoice.kind !== "invoice" || receipt.organizationId === null) return null;
  if (
    stripePaymentKind(invoice.billingReason) !== "subscription_period" ||
    !["subscription_create", "subscription_cycle"].includes(invoice.billingReason ?? "") ||
    invoice.currency !== "usd" ||
    invoice.subscription === null ||
    invoice.price === null ||
    invoice.periodStart === null ||
    invoice.periodEnd === null ||
    Number(invoice.periodEnd) <= Number(invoice.periodStart)
  )
    return null;
  const m = invoice.metadata;
  const traced =
    m.operationId !== null &&
    m.operationId === operationId &&
    m.workspaceId === receipt.workspaceId &&
    (m.organizationId === null || m.organizationId === receipt.organizationId);
  return {
    schemaVersion: 1,
    organizationId: receipt.organizationId,
    workspaceId: receipt.workspaceId,
    route: "morrow_direct",
    mode: receipt.mode,
    paymentKey: "stripe:invoice:" + invoice.id,
    kind: "subscription_period",
    subscriptionKey: "stripe:sub:" + invoice.subscription,
    priceKey: "stripe:price:" + invoice.price,
    fromPriceKey: null,
    periodStart: iso(invoice.periodStart),
    periodEnd: iso(invoice.periodEnd),
    installationId: null,
    storeId: null,
    operationId: traced ? m.operationId : null,
    amountPaid: { amount: usdAmount(invoice.amountPaid), currency: "USD" },
    providerEvidenceRef: receipt.objectDigest,
    verifiedAt: receipt.observedAt,
  } as CurrentBilling_VerifiedPaymentEvent;
}

const plan = (
  outcome: ReceiptOutcome,
  code: string | null,
  parts: Partial<Pick<ReceiptPlan, "payment" | "snapshot" | "intent">> = {},
): ReceiptPlan =>
  Object.freeze({
    schemaVersion: 1,
    outcome,
    code,
    payment: parts.payment ?? null,
    snapshot: parts.snapshot ?? null,
    intent: parts.intent ?? null,
  });

/**
 * Plans one receipt's application at `now` in `environment`. Unattributed: held
 * CUSTOMER_NOT_MAPPED. invoice.paid: classifyPayment (once per payment key), then the
 * subscription fold and, for the payment that fixes the route or grants, the checkout
 * intent it traces to. Subscription events and invoice.payment_failed: the fold only.
 * Checkout events: the intent only.
 */
export function planReceiptApplication(
  facts: ReceiptFacts,
  environment: BillingEnvironment,
  now: string,
): ReceiptPlan {
  const receipt = facts.receipt;
  const records = facts.records;
  if (records === null || receipt.organizationId === null || receipt.workspaceId === null)
    return plan("held", "CUSTOMER_NOT_MAPPED");
  const scope = { organizationId: receipt.organizationId, workspaceId: receipt.workspaceId };
  const route = records.route ? workspaceBillingRouteFromRow(records.route) : null;
  const account = records.account ? accountFromRow(records.account) : null;
  const snapshot = records.snapshot ? snapshotFromRow(records.snapshot) : null;
  const input = billingFactsInput(
    {
      route,
      associations: records.associations.map(associationFromRow),
      account,
      snapshot,
      conflicts: records.conflicts.map(conflictFromRow),
      checkoutIntentPending: records.intentPending,
    },
    scope,
  );
  const state = workspaceBillingState(
    parseWorkspaceBillingFacts(input, scope, environment),
    now,
    environment,
  );
  const object = receipt.object;
  // The next snapshot of the read-back subscription, for an account that exists.
  const fold = (
    current: CurrentBilling_EntitlementSnapshot | null,
    billingAccountId: string,
  ): { revision: number } | null => {
    const sub = subscriptionOf(object);
    if (!sub) return null;
    const status = mapProviderStatus({
      provider: "stripe",
      status: sub.state.status,
      cancelAtPeriodEnd: sub.state.cancelAtPeriodEnd,
    });
    const result = foldEntitlementEvidence(current, {
      billingAccountId,
      route: "morrow_direct",
      mode: receipt.mode,
      installationId: null,
      organizationId: receipt.organizationId,
      workspaceId: receipt.workspaceId,
      storeId: null,
      subscriptionId: sub.key,
      status,
      providerEvidenceRef: receipt.objectDigest,
      observedAt: receipt.observedAt,
      validUntil: subscriptionValidUntil(sub.state, receipt.observedAt),
    });
    return result.result === "next" ? { revision: result.snapshot.revision } : null;
  };
  const intentTo = (to: "completed" | "expired" | "verified") =>
    records.intent ? { intentId: records.intent.id, to } : null;

  if (
    receipt.eventType === "checkout.session.completed" ||
    receipt.eventType === "checkout.session.expired"
  ) {
    const session = object as NormalizedCheckoutSession;
    const want = receipt.eventType === "checkout.session.completed" ? "complete" : "expired";
    if (records.intent?.status === "open" && session.status === want) {
      const intent = intentTo(want === "complete" ? "completed" : "expired");
      return plan("applied", null, { intent });
    }
    return plan("ignored", "NOT_APPLICABLE");
  }
  if (receipt.eventType !== "invoice.paid") {
    const snapshotPlan = account ? fold(snapshot, account.id) : null;
    return snapshotPlan
      ? plan("applied", null, { snapshot: snapshotPlan })
      : plan("ignored", account ? "STALE_OBSERVATION" : "NO_ACCOUNT");
  }

  // invoice.paid.
  const payment = records.payment ?? invalid();
  const termsRow = records.terms;
  const operationId = records.checkoutOperation?.operationId ?? null;
  const foldExisting = () => (account ? fold(snapshot, account.id) : null);
  if (payment.granted)
    return plan("already_granted", "ALREADY_GRANTED", { snapshot: foldExisting() });
  if (payment.recorded) return plan("ignored", "ALREADY_RECORDED", { snapshot: foldExisting() });
  const event = paymentEventFor(receipt, operationId);
  if (event === null || termsRow === null)
    return plan("held", "TERMS_MISMATCH", { snapshot: foldExisting() });
  let terms: CurrentBilling_BillingTerms;
  let outcome: PaymentOutcome;
  try {
    terms = parseBillingTerms(termsRow.terms);
    if (String(terms.termsRevision) !== termsRow.termsRevision) return invalid();
    outcome = classifyPayment({ kind: "workspace", state }, event, terms, new Set<string>());
  } catch (error) {
    if (error instanceof ReceiptPlanError) throw error;
    return plan("held", "TERMS_MISMATCH", { snapshot: foldExisting() });
  }
  const termsRevision = terms.termsRevision;
  // The intent the granted payment traces to (its checkout operation's intent).
  const verifiedIntent =
    records.intent &&
    ["open", "completed"].includes(records.intent.status) &&
    records.checkoutOperation?.intentId === records.intent.id &&
    event.operationId !== null &&
    event.operationId === operationId
      ? intentTo("verified")
      : null;
  switch (outcome.outcome) {
    case "refused":
      return plan("refused", outcome.code);
    case "already_granted":
      return plan("already_granted", "ALREADY_GRANTED", { snapshot: foldExisting() });
    case "held":
      return plan("held", outcome.reason, {
        payment: { action: "record", outcome: "held", code: outcome.reason, termsRevision },
        snapshot: foldExisting(),
      });
    case "no_charge":
      return plan("no_charge", null, {
        payment: { action: "record", outcome: "no_charge", code: null, termsRevision },
        snapshot: foldExisting(),
      });
    case "conflict":
      return plan("conflict", outcome.code, {
        payment: { action: "record", outcome: "conflict", code: outcome.code, termsRevision },
      });
    case "fix_route_and_grant":
      // The account is created in the same commit, so its first snapshot is revision 1.
      return plan("applied", null, {
        payment: { action: "fix_route_and_grant", outcome: "granted", code: null, termsRevision },
        snapshot: subscriptionOf(object) ? { revision: 1 } : null,
        intent: verifiedIntent,
      });
    case "grant":
      if (outcome.account.kind !== "existing" || !account) return invalid();
      return plan("applied", null, {
        payment: { action: "grant", outcome: "granted", code: null, termsRevision },
        snapshot: fold(snapshot, account.id),
        intent: verifiedIntent,
      });
  }
}

/** The environment's mode, so the caller can refuse a receipt of the other mode early. */
export const receiptModeAccepted = (receipt: BegunReceipt, environment: BillingEnvironment) =>
  receipt.mode === environmentMode(environment);
