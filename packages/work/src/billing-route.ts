import type { CurrentBilling_WorkspaceBillingRoute } from "@morrow/contracts";
import { validateCurrentBillingDefinition, validateDefinition } from "@morrow/contracts/validation";
import { originForCreation, type BillingOrigin } from "@morrow/policy/billing-state";
import type { WorkTx } from "./connection.js";
import type { WorkAuthority } from "./context.js";
import { WorkContextUnavailable } from "./context.js";

// The billing route row of one workspace (P01.T04a §3 R1-R4 and §8.1; ADR-0015 item 2;
// mvp-architecture §2 step 1; morrow_billing.workspace_billing_routes, migration 0020).
//
// The creating transaction writes the row; its origin comes only from originForCreation
// (R1). For the website signup, the one creation flow that writes a row today, the
// writer is migration 0021's trigger on organization_signups, which records
// originForCreation({kind: "website_signup", installHandoffPending: false}) = "website"
// in the same transaction (no install handoff exists before P09.T02a). Every other flow
// writes no row, and a missing row reads as origin shopify_install (fail closed).
// `billingRouteForCreation` is the row every creating writer must produce, and the lab
// pins 0021's trigger to it. The api reads its own tenant's row with
// `readWorkspaceBillingRoute` (tenant_read policy, column grants).

export class BillingRouteError extends Error {
  constructor(readonly code: "BILLING_ROUTE_INPUT_INVALID" | "BILLING_ROUTE_ROW_INVALID") {
    super(code);
    this.name = "BillingRouteError";
  }
}
const id = (value: unknown): value is string => validateDefinition("core", "Id", value);
const utcTime = (value: unknown): value is string =>
  validateDefinition("core", "UtcTime", value) && Number.isFinite(Date.parse(value as string));

/**
 * The unfixed WorkspaceBillingRoute@1 a creating transaction writes for `flow`: the
 * origin from originForCreation (anything but a website signup without a pending install
 * handoff is shopify_install), no route, revision 1. `shopifyBoundAt` is the workspace's
 * first store link if the creating transaction links one, else null.
 */
export function billingRouteForCreation(
  flow: unknown,
  scope: { readonly organizationId: string; readonly workspaceId: string },
  shopifyBoundAt: string | null = null,
): CurrentBilling_WorkspaceBillingRoute & { readonly origin: BillingOrigin } {
  if (
    !scope ||
    !id(scope.organizationId) ||
    !id(scope.workspaceId) ||
    (shopifyBoundAt !== null && !utcTime(shopifyBoundAt))
  )
    throw new BillingRouteError("BILLING_ROUTE_INPUT_INVALID");
  const route = {
    schemaVersion: 1,
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    origin: originForCreation(flow),
    shopifyBoundAt,
    route: null,
    mode: null,
    routeFixedAt: null,
    fixingPaymentKey: null,
    revision: 1,
  } as const;
  if (!validateCurrentBillingDefinition("WorkspaceBillingRoute", route))
    throw new BillingRouteError("BILLING_ROUTE_INPUT_INVALID");
  return Object.freeze(route);
}

/** R1: the origin a workspace reads as; a workspace without a row is shopify_install. */
export const effectiveBillingOrigin = (
  route: CurrentBilling_WorkspaceBillingRoute | null,
): BillingOrigin => (route === null ? "shopify_install" : route.origin);

export { spineStatements } from "./spine-sql.js";
const routeNames =
  "fixing_payment_key,mode,organization_id,origin,revision,route,route_fixed_at,shopify_bound_at,workspace_id";

/** Maps one row to WorkspaceBillingRoute@1; any other shape is BILLING_ROUTE_ROW_INVALID. */
export function workspaceBillingRouteFromRow(
  row: Readonly<Record<string, unknown>>,
): CurrentBilling_WorkspaceBillingRoute {
  if (
    !row ||
    typeof row !== "object" ||
    Object.keys(row).sort().join(",") !== routeNames ||
    typeof row.revision !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(row.revision)
  )
    throw new BillingRouteError("BILLING_ROUTE_ROW_INVALID");
  const route = {
    schemaVersion: 1,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    origin: row.origin,
    shopifyBoundAt: row.shopify_bound_at,
    route: row.route,
    mode: row.mode,
    routeFixedAt: row.route_fixed_at,
    fixingPaymentKey: row.fixing_payment_key,
    revision: Number(row.revision),
  };
  if (!validateCurrentBillingDefinition("WorkspaceBillingRoute", route))
    throw new BillingRouteError("BILLING_ROUTE_ROW_INVALID");
  return Object.freeze(route) as CurrentBilling_WorkspaceBillingRoute;
}

/** The authority's own workspace route, or null (which reads as shopify_install). */
export async function readWorkspaceBillingRoute(
  tx: WorkTx,
  authority: WorkAuthority,
): Promise<CurrentBilling_WorkspaceBillingRoute | null> {
  const workspaceId = authority.actor.workspaceId;
  if (!id(workspaceId)) throw new WorkContextUnavailable();
  const rows = await tx.run("workspaceBillingRoute", [workspaceId]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new WorkContextUnavailable();
  const route = workspaceBillingRouteFromRow(rows[0]!);
  if (route.organizationId !== authority.actor.organizationId || route.workspaceId !== workspaceId)
    throw new WorkContextUnavailable();
  return route;
}
