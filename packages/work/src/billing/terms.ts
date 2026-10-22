import type { CurrentBilling_BillingTerms } from "@morrow/contracts";
import { parseBillingTerms } from "@morrow/policy/billing-state";
import { stripeCanonicalJson, stripeSha256Hex } from "./stripe-objects.js";

// Morrow's versioned terms table (R10; ADR-0022 item 11: US$49 a month with 300 credits;
// item 5 as amended 2026-10-21: a development or staging revision may carry one
// operator_test_entitlement entry, the beta plan's credits without a price, which only the
// owner's operator path reads and which subscriptionEntry and the offers never match).
// docs/decisions/billing-terms.json publishes each environment's revisions with their
// display offers and pinned digests; staging:seed-platform writes them to
// morrow_billing.billing_terms, the only source the definers and the api read.

export class BillingTermsError extends Error {
  constructor(readonly code: "BILLING_TERMS_INVALID") {
    super(code);
    this.name = "BillingTermsError";
  }
}
const invalid = (): never => {
  throw new BillingTermsError("BILLING_TERMS_INVALID");
};

/** A display offer: the price a subscription entry charges, in minor units, per month. */
export interface BillingOffer {
  readonly priceKey: string;
  readonly unitAmount: string;
  readonly currency: string;
  readonly interval: "month";
}
export interface BillingTermsRevision {
  readonly termsRevision: number;
  readonly terms: CurrentBilling_BillingTerms;
  readonly offers: readonly BillingOffer[];
  readonly digest: string;
}
export type BillingTermsEntry = CurrentBilling_BillingTerms["entries"][number];

const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const keys = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...names].sort().join(",");

/** The morrow_direct subscription entry for one price, in one mode, or null. */
export function subscriptionEntry(
  terms: CurrentBilling_BillingTerms,
  priceKey: string,
  mode: "live" | "test",
): BillingTermsEntry | null {
  const found = terms.entries.filter(
    (e) =>
      e.route === "morrow_direct" &&
      e.priceKey === priceKey &&
      e.mode === mode &&
      e.kind === "subscription_period",
  );
  return found.length === 1 ? found[0]! : null;
}

/**
 * Parses one revision's terms and offers: the terms through parseBillingTerms, and each
 * offer closed, priced in whole minor units, monthly and naming a morrow_direct
 * subscription entry in its own currency. At most 20 offers, one per price, and at least
 * one in a revision with a priced Morrow-direct subscription; only a revision without one
 * has none (ADR-0022 item 5 amendment, 2026-10-21: staging's revision while the Stripe
 * switch is off carries only the operator test entitlement's entry, which is never an
 * offer).
 */
export function parseTermsDocument(
  terms: unknown,
  offers: unknown,
): { readonly terms: CurrentBilling_BillingTerms; readonly offers: readonly BillingOffer[] } {
  let parsed: CurrentBilling_BillingTerms;
  try {
    parsed = parseBillingTerms(terms);
  } catch {
    return invalid();
  }
  const priced = parsed.entries.some(
    (e) => e.route === "morrow_direct" && e.kind === "subscription_period",
  );
  if (!Array.isArray(offers) || offers.length > 20 || (priced && offers.length < 1))
    return invalid();
  const list = offers.map((o): BillingOffer => {
    if (
      !plain(o) ||
      !keys(o, ["priceKey", "unitAmount", "currency", "interval"]) ||
      typeof o.priceKey !== "string" ||
      typeof o.unitAmount !== "string" ||
      !/^[1-9][0-9]{0,8}$/.test(o.unitAmount) ||
      typeof o.currency !== "string" ||
      !/^[A-Z]{3}$/.test(o.currency) ||
      o.interval !== "month" ||
      !parsed.entries.some(
        (e) =>
          e.route === "morrow_direct" &&
          e.kind === "subscription_period" &&
          e.priceKey === o.priceKey &&
          e.currency === o.currency,
      )
    )
      return invalid();
    return Object.freeze({
      priceKey: o.priceKey,
      unitAmount: o.unitAmount,
      currency: o.currency,
      interval: "month",
    });
  });
  if (new Set(list.map((o) => o.priceKey)).size !== list.length) return invalid();
  return Object.freeze({ terms: parsed, offers: Object.freeze(list) });
}

/** The published digest: SHA-256 of the canonical JSON of {terms, offers} (JCS for this data). */
export function termsDocumentDigest(terms: unknown, offers: unknown): Promise<string> {
  return stripeSha256Hex(stripeCanonicalJson({ terms, offers }));
}

/** Maps the billingTermsLatest row; any other shape is BILLING_TERMS_INVALID. */
export function termsFromRow(row: Readonly<Record<string, unknown>>): BillingTermsRevision {
  if (
    !row ||
    Object.keys(row).sort().join(",") !== "digest,offers,terms,terms_revision" ||
    typeof row.terms_revision !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(row.terms_revision) ||
    typeof row.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.digest) ||
    typeof row.terms !== "string" ||
    typeof row.offers !== "string"
  )
    return invalid();
  let terms: unknown, offers: unknown;
  try {
    terms = JSON.parse(row.terms);
    offers = JSON.parse(row.offers);
  } catch {
    return invalid();
  }
  const document = parseTermsDocument(terms, offers);
  if (document.terms.termsRevision !== Number(row.terms_revision)) return invalid();
  return Object.freeze({
    termsRevision: document.terms.termsRevision,
    terms: document.terms,
    offers: document.offers,
    digest: row.digest,
  });
}
