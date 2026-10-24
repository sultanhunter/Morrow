import type {
  Current_GoalAssistant,
  Current_GoalCheckAnswer,
  Current_GoalMeasure,
  Current_GoalMetricId,
  Current_GoalValueClass,
  Current_ReadTag,
} from "@morrow/contracts";

// ADR-0033 item 3: a goal is measured from closed lists, and everything a measure implies
// (its direction, unit, the read tags of its values and their data class) is fixed here in
// code, never by a request, a card or a model. T5's metric catalogue replaces these entries
// with its own MetricDefinition rows; until then this is the launch subset the flow needs
// (the MVP plan's T5: product facts complete, replied within a day as customer data,
// days of stock cover), plus one entry each for the Sales and Promotions areas.

export type GoalDirection = "at_least" | "at_most";
export type ReadCapability = Current_ReadTag["capability"];
export type GoalValueClass = Current_GoalValueClass;
export type GoalValueSource = "store" | "checklist" | "hand_check";

export interface MetricEntry {
  readonly label: string;
  readonly unit: "days" | "products" | "percent" | "orders";
  readonly direction: GoalDirection;
  /** The read tags of every value: the union of the sources' tags (ADR-0031 item 6). */
  readonly readCapabilities: readonly ReadCapability[];
  readonly valueClass: GoalValueClass;
}
export const goalMetrics: Readonly<Record<Current_GoalMetricId, MetricEntry>> = Object.freeze({
  // Stock cover uses the levels and the order rate, so its values are order aggregates.
  days_of_stock_cover: Object.freeze({
    label: "Days of stock cover",
    unit: "days",
    direction: "at_least",
    readCapabilities: Object.freeze(["inventory.levels.read", "orders.read"] as const),
    valueClass: "order_aggregates",
  }),
  best_sellers_at_risk: Object.freeze({
    label: "Best sellers at risk",
    unit: "products",
    direction: "at_most",
    readCapabilities: Object.freeze(["inventory.levels.read", "orders.read"] as const),
    valueClass: "order_aggregates",
  }),
  // ADR-0033 item 4: a value from support cases is customer data (ADR-0031 item 2).
  replied_within_a_day: Object.freeze({
    label: "Replied within a day",
    unit: "percent",
    direction: "at_least",
    readCapabilities: Object.freeze(["support.case.read"] as const),
    valueClass: "customer",
  }),
  orders_per_week: Object.freeze({
    label: "Orders a week",
    unit: "orders",
    direction: "at_least",
    readCapabilities: Object.freeze(["orders.read"] as const),
    valueClass: "order_aggregates",
  }),
  discounted_order_share: Object.freeze({
    label: "Orders with a discount",
    unit: "percent",
    direction: "at_most",
    readCapabilities: Object.freeze(["orders.read"] as const),
    valueClass: "order_aggregates",
  }),
});

/**
 * The 12 facts of "Product facts complete" (ADR-0033 item 3; the approved flow's list).
 * Complete product fields in Shopify's standard structure, not markup.
 */
export const productFacts = Object.freeze([
  "title_names_type",
  "material",
  "size",
  "what_fits_inside",
  "care",
  "colour",
  "product_category",
  "three_photos",
  "photo_descriptions",
  "search_title",
  "search_description",
  "shopper_questions",
] as const);
export type ProductFact = (typeof productFacts)[number];

/** The assistants of a hand check (owner question 3); ChatGPT is the default. */
export const goalAssistants: readonly Current_GoalAssistant[] = Object.freeze([
  "chatgpt",
  "gemini",
  "copilot",
  "perplexity",
]);
export const defaultGoalAssistant: Current_GoalAssistant = "chatgpt";

export function measureDirection(measure: Current_GoalMeasure): GoalDirection {
  return measure.kind === "metric" ? goalMetrics[measure.metricId].direction : "at_least";
}
export function measureReadCapabilities(measure: Current_GoalMeasure): readonly ReadCapability[] {
  // A checklist counts product fields; a hand check is about named products. Both are
  // read under the catalogue tag of the product's store.
  return measure.kind === "metric"
    ? goalMetrics[measure.metricId].readCapabilities
    : Object.freeze(["catalog.products.read"] as const);
}
export function measureValueClass(measure: Current_GoalMeasure): GoalValueClass {
  return measure.kind === "metric" ? goalMetrics[measure.metricId].valueClass : "work";
}
export function measureSource(measure: Current_GoalMeasure): GoalValueSource {
  return measure.kind === "metric"
    ? "store"
    : measure.kind === "checklist"
      ? "checklist"
      : "hand_check";
}
/** True for a measure whose values are customer data (ADR-0031 item 2). */
export const isCustomerMeasure = (measure: Current_GoalMeasure) =>
  measureValueClass(measure) === "customer";

/**
 * The read tags of a measure's values (ReadTag@1, PR 10): its capabilities on each of the
 * stores, sorted. A goal value's tags always name a store.
 */
export function readTagsFor(
  measure: Current_GoalMeasure,
  storeIds: readonly string[],
): readonly Current_ReadTag[] {
  const tags: Current_ReadTag[] = [];
  for (const storeId of [...new Set(storeIds)].sort())
    for (const capability of [...measureReadCapabilities(measure)].sort())
      tags.push({ storeId, capability });
  return Object.freeze(tags);
}

const dayMs = 86_400_000;
/**
 * A value's clock (ADR-0031 items 1 and 2): none for work values; 90 days from the
 * observed day for order aggregates; for a customer value, no later than the earliest
 * expiry of the cases it came from (copying never extends a clock), and never more than
 * 90 days. Returns epoch milliseconds or null.
 */
export function valueExpiresAt(
  valueClass: GoalValueClass,
  observedAtMs: number,
  caseExpiriesMs: readonly number[] = [],
): number | null {
  if (!Number.isSafeInteger(observedAtMs)) throw new RangeError("GOAL_VALUE_TIME_INVALID");
  if (valueClass === "work") return null;
  const day = observedAtMs - (observedAtMs % dayMs);
  const ninety = day + 90 * dayMs;
  if (valueClass === "order_aggregates") return ninety;
  if (caseExpiriesMs.length === 0 || caseExpiriesMs.some((t) => !Number.isSafeInteger(t)))
    throw new RangeError("GOAL_CUSTOMER_VALUE_NEEDS_ITS_CASES");
  return Math.min(ninety, ...caseExpiriesMs);
}

/** A hand-check row's value: how many of its questions named this product. */
export function handCheckValue(answers: readonly Current_GoalCheckAnswer[]): number {
  return answers.filter((a) => a === "named_this_product").length;
}
/** A check counts only in the goal's own assistant (ADR-0033 item 3). */
export const handCheckCounted = (
  goalAssistant: Current_GoalAssistant,
  checkAssistant: Current_GoalAssistant,
) => goalAssistant === checkAssistant;

/** Direction-aware comparison: is `value` on the target's side of `bound`? */
export function onTargetSide(direction: GoalDirection, value: number, bound: number): boolean {
  return direction === "at_least" ? value >= bound : value <= bound;
}
