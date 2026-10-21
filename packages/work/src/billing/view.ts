import {
  billingCallToAction,
  type BillingCallToAction,
  type WorkspaceBillingState,
} from "@morrow/policy/billing-state";

// The billing view's call to action (M5 PR-1). Its own module because its signature names
// @morrow/policy types: http.ts uses it without exporting it, so the billing handlers'
// declarations, which the api Worker's edge typecheck consumes, stay free of them (port.ts).

/**
 * The view's call to action: billingCallToAction's (P01.T04a §9), or none. None for a
 * viewer without `view` on governance.billing.manage, and none in place of the Morrow
 * plans link while the Stripe switch is off (owner decision (c), 2026-10-21): with no
 * broker Stripe port the plans offer nothing and checkout and the portal answer
 * unavailable, so "Choose a plan" or "Manage plan" would lead nowhere. A Shopify phase's
 * plan page is App Pricing, not Stripe, so the switch leaves it as it is. Nothing here
 * makes a link or wording of its own.
 */
export function billingViewCallToAction(
  state: WorkspaceBillingState,
  mayPurchase: boolean,
  stripeOn: boolean,
): BillingCallToAction {
  if (!mayPurchase) return Object.freeze({ kind: "none" });
  const action = billingCallToAction(state);
  return action.kind === "morrow_plans" && !stripeOn ? Object.freeze({ kind: "none" }) : action;
}
