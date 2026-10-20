import {
  purchaseDecision,
  type BillingDenial,
  type MorrowPurchaseAction,
  type WorkspaceBillingState,
} from "@morrow/policy/billing-state";

// The purchase guard (P18.T01a; P01.T04a §5 and §9): every Morrow purchase route lives
// under the one prefix /workspace/:ws/billing/morrow/, and a closed table maps each
// (method, path) to the purchase actions it may perform. The action never comes from the
// request. An unmapped path is 404 before any handler runs; a denial, or a billing facts
// failure, is decided before any command, definer or broker call.

export type MorrowPurchaseRouteKey =
  | "GET /morrow/plans"
  | "POST /morrow/checkout"
  | "POST /morrow/portal";
/** The closed path -> action table. GET /plans serves whichever of its actions is allowed. */
export const morrowPurchaseRoutes: Readonly<
  Record<MorrowPurchaseRouteKey, readonly MorrowPurchaseAction[]>
> = Object.freeze({
  "GET /morrow/plans": Object.freeze(["subscribe", "billing_portal"] as const),
  "POST /morrow/checkout": Object.freeze(["subscribe"] as const),
  "POST /morrow/portal": Object.freeze(["billing_portal"] as const),
});
export const isMorrowPurchaseRoute = (key: string): key is MorrowPurchaseRouteKey =>
  Object.hasOwn(morrowPurchaseRoutes, key);

export type PurchaseGuardResult =
  | { readonly allowed: true; readonly actions: readonly MorrowPurchaseAction[] }
  | { readonly allowed: false; readonly denial: BillingDenial };

/**
 * Decides one purchase route on a state the billing library issued: allowed with the
 * actions the state permits, or the first action's denial when none is permitted.
 */
export function guardPurchase(
  state: WorkspaceBillingState,
  key: MorrowPurchaseRouteKey,
): PurchaseGuardResult {
  if (!isMorrowPurchaseRoute(key)) throw Error("BILLING_PURCHASE_ROUTE_UNMAPPED");
  const actions = morrowPurchaseRoutes[key];
  const allowed: MorrowPurchaseAction[] = [];
  let first: BillingDenial | null = null;
  for (const action of actions) {
    const decision = purchaseDecision(state, { action });
    if (decision.allowed) allowed.push(action);
    else first ??= decision;
  }
  if (allowed.length) return Object.freeze({ allowed: true, actions: Object.freeze(allowed) });
  return Object.freeze({ allowed: false, denial: first! });
}
