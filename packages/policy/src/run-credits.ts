// The run money rules (P11.T04a minimum; ADR-0022 item 11; mvp-architecture §9). Pure: no
// I/O, clock or randomness, and every amount is an exact bigint count of 10^-8 USD (the
// numeric(20,8) of morrow_billing.vendor_cost_reservations). The SQL helpers of the
// run-credits migration (run_reserve, run_book_cost, run_settle, run_release) enforce the
// same rules under a row lock; these are their TypeScript twins for admission (M3 PR-2), the
// per-product step and the tests.
//
// - A run reserves products × the selection's credits per product, and products × its
//   worst case per product of vendor cost. The product count is at most the selection's
//   run limit (min of 25 and US$7 / worst case).
// - It settles at the products drafted × credits per product, never above the reservation:
//   a failed product earns no credit. The rest is released.
// - The daily cap counts settled cost plus open reservations (UTC day).
// - The unrecovered cost of a workspace's billing period (AI cost of products that earned
//   no credit, `uncertain` bookings at their worst case included) is recorded per period and
//   caps nothing: ADR-0036 removed the unrecovered-cost cap, so `unrecovered_cost_cap` is
//   never returned again. The per-run and per-day caps, the breaker and the provider's
//   monthly limit bound failed products' cost.
// - A run stops after three consecutive failed products; a good product resets the count.
import type { CatalogueEntry, CatalogueLimits } from "./model-catalogue";

export class RunCreditsError extends Error {
  constructor(readonly code: "RUN_CREDITS_INPUT_INVALID") {
    super(code);
    this.name = "RunCreditsError";
  }
}
const invalid = () => new RunCreditsError("RUN_CREDITS_INPUT_INVALID");
const nonNegative = (value: bigint) => typeof value === "bigint" && value >= 0n;
const count = (value: number, min = 0) =>
  Number.isSafeInteger(value) && value >= min && value <= 1_000_000;

export interface RunReservation {
  readonly productCount: number;
  readonly creditsPerProduct: number;
  readonly credits: bigint;
  readonly vendorMaximumUsd8: bigint;
}
export type ReservationRefusal = "product_count_invalid" | "run_product_limit";
/** The credits and vendor cost a run reserves before any model call. */
export function reservationSize(
  entry: CatalogueEntry,
  productCount: number,
):
  | { readonly ok: true; readonly reservation: RunReservation }
  | {
      readonly ok: false;
      readonly code: ReservationRefusal;
    } {
  if (!entry || !count(entry.creditsPerProduct, 1) || !count(entry.runProductLimit, 1))
    throw invalid();
  if (!Number.isSafeInteger(productCount) || productCount < 1)
    return Object.freeze({ ok: false, code: "product_count_invalid" });
  if (productCount > entry.runProductLimit)
    return Object.freeze({ ok: false, code: "run_product_limit" });
  return Object.freeze({
    ok: true,
    reservation: Object.freeze({
      productCount,
      creditsPerProduct: entry.creditsPerProduct,
      credits: BigInt(productCount) * BigInt(entry.creditsPerProduct),
      vendorMaximumUsd8: BigInt(productCount) * entry.worstCasePerProductUsd8,
    }),
  });
}

/** Credits settled at run end: drafted × multiplier, never above the reservation. */
export function settledCredits(
  reservedCredits: bigint,
  productsDrafted: number,
  creditsPerProduct: number,
): bigint {
  if (!nonNegative(reservedCredits) || !count(productsDrafted) || !count(creditsPerProduct, 1))
    throw invalid();
  const earned = BigInt(productsDrafted) * BigInt(creditsPerProduct);
  return earned < reservedCredits ? earned : reservedCredits;
}

export interface AttemptUsage {
  readonly inputTokens: number;
  /** Output tokens, thinking included (ADR-0022 item 10). */
  readonly outputTokens: number;
}
/**
 * The cost of one attempt at the run's recorded catalogue version: its usage at that
 * version's rates, or its worst case when the outcome is `uncertain` (never free).
 */
export function attemptCostUsd8(
  entry: CatalogueEntry,
  attempt:
    | { readonly outcome: "usage"; readonly usage: AttemptUsage }
    | { readonly outcome: "uncertain" },
): bigint {
  if (!entry) throw invalid();
  if (attempt.outcome === "uncertain") return entry.worstCasePerAttemptUsd8;
  const u = attempt.usage;
  if (!u || !count(u.inputTokens) || !count(u.outputTokens)) throw invalid();
  return (
    BigInt(u.inputTokens) * entry.inputUsd8PerToken +
    BigInt(u.outputTokens) * entry.outputUsd8PerToken
  );
}

/** The daily cap: settled cost plus open reservations plus this reservation, within the cap. */
export function dailyCapAllows(
  limits: CatalogueLimits,
  settledTodayUsd8: bigint,
  openReservationsUsd8: bigint,
  newReservationUsd8: bigint,
): boolean {
  if (!limits || ![settledTodayUsd8, openReservationsUsd8, newReservationUsd8].every(nonNegative))
    throw invalid();
  return (
    settledTodayUsd8 + openReservationsUsd8 + newReservationUsd8 <= limits.workspaceDailyCostCapUsd8
  );
}

/** The unrecovered-cost ledger's period key: M5's billing period start. No period is no entitlement. */
export function unrecoveredPeriodStart(
  billingPeriod: { readonly start: string; readonly end: string } | null,
): string | null {
  if (billingPeriod === null) return null;
  if (
    !billingPeriod ||
    typeof billingPeriod.start !== "string" ||
    typeof billingPeriod.end !== "string" ||
    !Number.isFinite(Date.parse(billingPeriod.start)) ||
    !Number.isFinite(Date.parse(billingPeriod.end)) ||
    Date.parse(billingPeriod.start) >= Date.parse(billingPeriod.end)
  )
    throw invalid();
  return new Date(Date.parse(billingPeriod.start)).toISOString();
}

/** The failed-product breaker: the count after one product, and whether the run stops. */
export function failureBreaker(
  limits: CatalogueLimits,
  consecutiveFailed: number,
  product: "drafted" | "failed",
): { readonly consecutiveFailed: number; readonly stop: boolean } {
  if (!limits || !count(consecutiveFailed) || (product !== "drafted" && product !== "failed"))
    throw invalid();
  const next = product === "drafted" ? 0 : consecutiveFailed + 1;
  return Object.freeze({
    consecutiveFailed: next,
    stop: next >= limits.maxConsecutiveFailedProducts,
  });
}

/** A 10^-8 USD amount as the numeric(20,8) text the SQL helpers take. */
export function usd8Text(units: bigint): string {
  if (!nonNegative(units) || units >= 10n ** 20n) throw invalid();
  const whole = units / 100_000_000n;
  return `${whole}.${String(units % 100_000_000n).padStart(8, "0")}`;
}
/** The inverse of usd8Text for numeric(20,8) text read back from SQL. */
export function parseUsd8(text: unknown): bigint {
  if (typeof text !== "string" || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$/.test(text))
    throw invalid();
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
}
