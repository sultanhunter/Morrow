// M2 PR-1 billing route row (P01.T04a §3 R1-R4 and §8.1; ADR-0015 item 2; spine §2 step
// 1): the row a creating transaction writes, from originForCreation, and the api's
// reader. lab:spine-foundation T5 pins 0021's signup trigger to billingRouteForCreation.
import assert from "node:assert/strict";
import test from "node:test";
import { validateCurrentBillingDefinition } from "../packages/contracts/src/validation.ts";
import {
  BillingRouteError,
  billingRouteForCreation,
  effectiveBillingOrigin,
  readWorkspaceBillingRoute,
  workspaceBillingRouteFromRow,
} from "../packages/work/src/billing-route.ts";
import { workStatements } from "../packages/work/src/sql.ts";

const scope = { organizationId: "org_1", workspaceId: "ws_1" };
const website = { kind: "website_signup", installHandoffPending: false };

test("billingRouteForCreation: the origin comes only from originForCreation (R1)", () => {
  const route = billingRouteForCreation(website, scope);
  assert.deepEqual(route, {
    schemaVersion: 1,
    ...scope,
    origin: "website",
    shopifyBoundAt: null,
    route: null,
    mode: null,
    routeFixedAt: null,
    fixingPaymentKey: null,
    revision: 1,
  });
  assert.ok(validateCurrentBillingDefinition("WorkspaceBillingRoute", route));
  assert.ok(Object.isFrozen(route));
  // Every other flow, and anything malformed, is shopify_install (fail closed).
  for (const flow of [
    { kind: "website_signup", installHandoffPending: true },
    { kind: "install_continuation" },
    { kind: "workspace_in_existing_organization" },
    { kind: "operator_seed" },
    { kind: "fixture" },
    { kind: "website_signup" },
    { kind: "website_signup", installHandoffPending: false, origin: "website" },
    "website_signup",
    null,
  ])
    assert.equal(
      billingRouteForCreation(flow, scope).origin,
      "shopify_install",
      JSON.stringify(flow),
    );
  // A creating transaction that links a store records the binding (R2).
  assert.equal(
    billingRouteForCreation(website, scope, "2026-10-20T10:00:00.000Z").shopifyBoundAt,
    "2026-10-20T10:00:00.000Z",
  );
  for (const [s, bound] of [
    [{ organizationId: "", workspaceId: "ws_1" }, null],
    [{ organizationId: "org_1" }, null],
    [scope, "2026-10-20"],
  ])
    assert.throws(() => billingRouteForCreation(website, s, bound), BillingRouteError);
});

const row = (change = {}) => ({
  organization_id: "org_1",
  workspace_id: "ws_1",
  origin: "website",
  shopify_bound_at: null,
  route: null,
  mode: null,
  route_fixed_at: null,
  fixing_payment_key: null,
  revision: "1",
  ...change,
});

test("rows map to the three WorkspaceBillingRoute@1 variants; others are refused", () => {
  assert.deepEqual(workspaceBillingRouteFromRow(row()), billingRouteForCreation(website, scope));
  const direct = workspaceBillingRouteFromRow(
    row({
      route: "morrow_direct",
      mode: "test",
      route_fixed_at: "2026-10-20T10:00:00.000Z",
      fixing_payment_key: "stripe:invoice:in_ABCDEFGH12",
      revision: "2",
    }),
  );
  assert.equal(direct.route, "morrow_direct");
  const shopify = workspaceBillingRouteFromRow(
    row({
      origin: "shopify_install",
      shopify_bound_at: "2026-10-01T00:00:00.000Z",
      route: "shopify_app_pricing",
      mode: "test",
      route_fixed_at: "2026-10-20T10:00:00.000Z",
      fixing_payment_key: "shopify:app:1:shop:2:cycle:2026-10-01T00:00:00Z",
      revision: "3",
    }),
  );
  assert.equal(shopify.route, "shopify_app_pricing");
  for (const change of [
    { origin: "partner" },
    { route: "morrow_direct" },
    {
      route: "morrow_direct",
      mode: "test",
      route_fixed_at: "2026-10-20T10:00:00.000Z",
      fixing_payment_key: "pi_1",
    },
    { revision: "0" },
    { revision: 1 },
    { extra: null },
    { shopify_bound_at: "yesterday" },
  ])
    assert.throws(
      () => workspaceBillingRouteFromRow(row(change)),
      (e) => e instanceof BillingRouteError && e.code === "BILLING_ROUTE_ROW_INVALID",
    );
  assert.equal(effectiveBillingOrigin(null), "shopify_install");
  assert.equal(effectiveBillingOrigin(direct), "website");
});

test("readWorkspaceBillingRoute: the authority's own row through one fixed statement", async () => {
  const authority = {
    actor: { kind: "human", organizationId: "org_1", workspaceId: "ws_1" },
  };
  const sent = [];
  const tx = (rows) => ({
    run: async (name, values) => {
      sent.push([name, values]);
      return rows;
    },
  });
  assert.deepEqual(
    await readWorkspaceBillingRoute(tx([row()]), authority),
    workspaceBillingRouteFromRow(row()),
  );
  assert.equal(await readWorkspaceBillingRoute(tx([]), authority), null);
  assert.deepEqual(sent[0], ["workspaceBillingRoute", ["ws_1"]]);
  assert.match(
    workStatements.workspaceBillingRoute,
    /FROM morrow_billing\.workspace_billing_routes r WHERE r\.workspace_id=\$1::text$/,
  );
  for (const rows of [
    [row(), row()],
    [row({ workspace_id: "ws_2" })],
    [row({ organization_id: "org_2" })],
  ])
    await assert.rejects(readWorkspaceBillingRoute(tx(rows), authority));
});
