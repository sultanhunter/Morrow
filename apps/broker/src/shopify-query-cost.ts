// Per-shop buckets for Shopify's API query cost (plan row SD5 of
// docs/plan/store-data-foundation-implementation.md, a P09.T03 child; migration
// shopify-query-cost; docs/briefs/sd5-shopify-query-cost.md). Shopify's rate limit, counted in
// Shopify's GraphQL query-cost points: never money, never credits.
//
// One token bucket per store installation, which is one (shop, app) pair while it is live,
// held in SQL (morrow_work.rate_buckets) so every broker isolate shares it. Before a fixed
// document is sent its known cost is taken from the bucket; Shopify's reply (its
// extensions.cost and throttleStatus) settles it. Priority classes, highest first: gateway
// writes and contact dispatch (`write`: always admitted, never waits on the bucket), person
// reads, agent reads, reconciliation and bulk; each class below `write` leaves a share of the
// bucket untouched for the classes above it (shopifyQueryCostPolicy.floorShare, the same
// values as morrow_work.rate_bucket_policy(), drift-tested), so a background read never takes
// the headroom an approved write needs. A read the bucket cannot yet cover waits instead of
// failing: in the broker while the wait is short and fits the read's budget, otherwise it
// parks (`parked` with retryAfterMs; an agent read parks, and H7b's run.wait consumes it).
// CS7's per-connection buckets reuse the same SQL helpers with their own provider value.
//
// Each definer is one round trip, takes ids, a closed class and numbers, and runs only on
// the broker's own login (morrow_vault_broker); the tenant comes from the installation row.
// Nothing here logs, and no token, shop domain or Shopify value leaves it.
import { VaultError, vaultStatements, type VaultQuery } from "./vault.js";
import type { ShopifyCostReport } from "./shopify.js";

export const queryCostClasses = Object.freeze([
  "write",
  "person_read",
  "agent_read",
  "reconciliation",
  "bulk",
] as const);
export type QueryCostClass = (typeof queryCostClasses)[number];
/**
 * The bucket's policy as morrow_work.rate_bucket_policy() holds it (drift-tested): the share
 * of the bucket each class leaves untouched, the defaults before Shopify's first report
 * (Shopify's smallest published bucket: 1,000 points restored at 50 a second), the dearest
 * single document Shopify runs, the longest wait the definer returns, and the safety ranges
 * the table's CHECKs hold.
 */
export const shopifyQueryCostPolicy = Object.freeze({
  provider: "shopify",
  unit: "query_cost_points",
  floorShare: Object.freeze({
    write: 0,
    person_read: 0.1,
    agent_read: 0.3,
    reconciliation: 0.5,
    bulk: 0.7,
  } as const satisfies Record<QueryCostClass, number>),
  defaultCapacity: 1000,
  defaultRestoreRate: 50,
  maxCost: 1000,
  maxWaitMs: 3_600_000,
  capacityRange: Object.freeze([100, 1_000_000] as const),
  restoreRateRange: Object.freeze([1, 100_000] as const),
  availableMax: 1_000_000,
});
/**
 * How a read that must wait is handled in the broker. A person read waits in the broker while
 * the wait leaves sendReserveMs of its budget for the call; an agent read waits there only
 * for a short wait (agentInlineMaxMs) and otherwise parks, so its run waits durably (H7b's
 * run.wait) instead of holding an isolate; reconciliation and bulk always park (their own
 * callers schedule them). At most maxTakes takes per call, so a stale model cannot spin.
 */
export const shopifyQueryCostWaits = Object.freeze({
  sendReserveMs: 2000,
  agentInlineMaxMs: 1000,
  maxTakes: 4,
  /** A THROTTLED reply with no throttleStatus parks for this long. */
  unknownWaitMs: 1000,
});

export type QueryCostTake =
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "wait"; waitMs: number }>
  | Readonly<{ kind: "refused"; reason: "too_costly" | "not_found" | "invalid" | "denied" }>;
const installationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const one = (rows: readonly Record<string, unknown>[], columns: string) => {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || Object.keys(row).sort().join(",") !== columns)
    throw new VaultError("VAULT_RECORD_INVALID");
  return row;
};
/**
 * Takes `cost` points of one class from the installation's bucket (one statement of the
 * caller's vault transaction). Closed inputs: the class from queryCostClasses, a whole cost of
 * 1 to maxCost points. A malformed row is a VaultError.
 */
export async function takeShopifyQueryCost(
  query: VaultQuery,
  installationId: string,
  cls: QueryCostClass,
  cost: number,
): Promise<QueryCostTake> {
  if (
    !installationPattern.test(installationId) ||
    !queryCostClasses.includes(cls) ||
    !Number.isSafeInteger(cost) ||
    cost < 1 ||
    cost > shopifyQueryCostPolicy.maxCost
  )
    throw new VaultError("VAULT_INPUT_INVALID");
  const row = one(
    await query(vaultStatements.shopifyQueryCostTake, [installationId, cls, String(cost)]),
    "outcome,wait_ms",
  );
  if (row.outcome === "admitted" && row.wait_ms === "0") return Object.freeze({ kind: "admitted" });
  if (
    row.outcome === "wait" &&
    typeof row.wait_ms === "string" &&
    /^[1-9][0-9]{0,6}$/.test(row.wait_ms)
  ) {
    const waitMs = Number(row.wait_ms);
    if (waitMs <= shopifyQueryCostPolicy.maxWaitMs) return Object.freeze({ kind: "wait", waitMs });
  }
  if (
    (row.outcome === "too_costly" ||
      row.outcome === "not_found" ||
      row.outcome === "invalid" ||
      row.outcome === "denied") &&
    row.wait_ms === null
  )
    return Object.freeze({ kind: "refused", reason: row.outcome });
  throw new VaultError("VAULT_RECORD_INVALID");
}

// A finite number within [min, max] as the definer's decimal text (at most 3 decimals), or ""
// (absent: the statement turns it into NULL). Shopify's values outside the table's safety
// ranges are dropped, never clamped: the bucket keeps what it had.
const decimal = (value: number | null, min: number, max: number) =>
  value !== null && Number.isFinite(value) && value >= min && value <= max ? value.toFixed(3) : "";
const points = (value: number | null) =>
  value !== null &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= shopifyQueryCostPolicy.maxCost
    ? String(value)
    : "";
/** The settle's text parameters for one reply: [charged, actual, available, maximum, rate, throttled]. */
export function shopifyQueryCostSettleValues(
  charged: number,
  report: ShopifyCostReport | null,
  throttled: boolean,
): readonly [string, string, string, string, string, "true" | "false"] {
  const p = shopifyQueryCostPolicy;
  return [
    points(charged) || "0",
    points(report?.actual ?? null),
    decimal(report?.available ?? null, 0, p.availableMax),
    decimal(report?.maximum ?? null, p.capacityRange[0], p.capacityRange[1]),
    decimal(report?.restoreRate ?? null, p.restoreRateRange[0], p.restoreRateRange[1]),
    throttled ? "true" : "false",
  ];
}
/**
 * Settles one reply on the installation's bucket (one statement): refunds what the reply
 * proves was not used, adopts Shopify's capacity and restore rate, and never keeps more
 * points than Shopify reported. Returns the definer's outcome.
 */
export async function settleShopifyQueryCost(
  query: VaultQuery,
  installationId: string,
  charged: number,
  report: ShopifyCostReport | null,
  throttled: boolean,
): Promise<"settled" | "not_found" | "invalid" | "denied"> {
  if (!installationPattern.test(installationId)) throw new VaultError("VAULT_INPUT_INVALID");
  const row = one(
    await query(vaultStatements.shopifyQueryCostSettle, [
      installationId,
      ...shopifyQueryCostSettleValues(charged, report, throttled),
    ]),
    "outcome",
  );
  if (
    row.outcome === "settled" ||
    row.outcome === "not_found" ||
    row.outcome === "invalid" ||
    row.outcome === "denied"
  )
    return row.outcome;
  throw new VaultError("VAULT_RECORD_INVALID");
}

/** Whether a wait is spent in the broker (true) or the read parks (false). */
export function waitsInline(
  cls: QueryCostClass,
  waitMs: number,
  nowMs: number,
  deadlineMs: number,
): boolean {
  const w = shopifyQueryCostWaits;
  if (nowMs + waitMs + w.sendReserveMs > deadlineMs) return false;
  if (cls === "person_read") return true;
  if (cls === "agent_read") return waitMs <= w.agentInlineMaxMs;
  return false;
}

export type BucketedOutcome<R> =
  | Readonly<{ kind: "reply"; reply: R }>
  | Readonly<{ kind: "parked"; retryAfterMs: number }>
  | Readonly<{ kind: "refused"; reason: "too_costly" | "not_found" | "invalid" | "denied" }>;
export interface BucketedSend<R> {
  readonly reply: R;
  /** Shopify's cost report, when the reply carried one. */
  readonly cost: ShopifyCostReport | null;
  /** Shopify answered THROTTLED: nothing ran. */
  readonly throttled: boolean;
  /** The reply proves Shopify received the call (data or THROTTLED), so it is settled. */
  readonly answered: boolean;
}
export interface BucketedCall<R> {
  readonly installationId: string;
  readonly cls: Exclude<QueryCostClass, "write">;
  readonly cost: number;
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** One vault transaction within the call's deadline (the caller's slots and budget). */
  readonly transact: <T>(body: (query: VaultQuery) => Promise<T>) => Promise<T>;
  /** The first take, when the caller made it in its own resolution transaction. */
  readonly first?: QueryCostTake;
  /** One attempt of the fixed document (never waits). */
  readonly send: () => Promise<BucketedSend<R>>;
}
/**
 * One bucketed call: take (or the caller's first take), wait in the broker or park, send
 * once, settle, and on a THROTTLED reply (the model was stale; Shopify ran nothing) take
 * again from the corrected bucket. A settle that fails is dropped: the charge stands, so the
 * model errs low. A refused take is the caller's refusal.
 */
export async function bucketedShopifyCall<R>(
  call: Readonly<BucketedCall<R>>,
): Promise<BucketedOutcome<R>> {
  const take = () =>
    call.transact((query) => takeShopifyQueryCost(query, call.installationId, call.cls, call.cost));
  let taken = call.first ?? (await take());
  for (let takes = 1; ; takes++) {
    if (taken.kind === "refused") return Object.freeze({ kind: "refused", reason: taken.reason });
    if (taken.kind === "wait") {
      if (
        takes >= shopifyQueryCostWaits.maxTakes ||
        !waitsInline(call.cls, taken.waitMs, call.now(), call.deadlineMs)
      )
        return Object.freeze({ kind: "parked", retryAfterMs: taken.waitMs });
      await call.sleep(taken.waitMs);
      taken = await take();
      continue;
    }
    const sent = await call.send();
    // Only a reply that says something is settled: THROTTLED (refunds the charge) or one
    // with a cost report. Any other reply leaves the charge, so the model errs low.
    if (sent.answered && (sent.throttled || sent.cost !== null))
      await call
        .transact((query) =>
          settleShopifyQueryCost(query, call.installationId, call.cost, sent.cost, sent.throttled),
        )
        .catch(() => {});
    if (!sent.throttled) return Object.freeze({ kind: "reply", reply: sent.reply });
    if (takes >= shopifyQueryCostWaits.maxTakes)
      return Object.freeze({
        kind: "parked",
        retryAfterMs: shopifyQueryCostWaits.unknownWaitMs,
      });
    taken = await take();
  }
}
