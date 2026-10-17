import test from "node:test";
import assert from "node:assert/strict";
import { lab, runLab, fakeCatalogRead } from "../scripts/lab.mjs";
const request = {
  organizationId: "org-small",
  workspaceId: "workspace-main",
  storeId: "store-main",
  accountId: "account-shopify",
  input: { productIds: ["product-shirt", "product-bag"], fields: ["title"] },
};
test("headless contract lab is deterministic and does not complete work", () => {
  assert.deepEqual(runLab(), runLab());
  assert.equal(runLab().completionClaim, false);
  assert.equal(runLab().paidDispatches, 0);
  assert.equal(runLab().durable, false);
});
test("fixture read returns schema-valid scoped references", () => {
  const r = fakeCatalogRead(request);
  assert.equal(r.kind, "verified_fixture");
  assert.equal(r.output.products[0].resource.storeId, "store-main");
});
test("other organization denies the fake account", () =>
  assert.equal(fakeCatalogRead({ ...request, organizationId: "org-enterprise" }).kind, "denied"));
test("other store cannot reuse fake account", () =>
  assert.equal(fakeCatalogRead({ ...request, storeId: "store-outlet" }).kind, "denied"));
test("other provider account cannot impersonate Shopify", () =>
  assert.equal(fakeCatalogRead({ ...request, accountId: "account-meta" }).kind, "denied"));
test("connection expiry remains explicit", () =>
  assert.equal(fakeCatalogRead({ ...request, now: "2026-10-08T00:00:00Z" }).kind, "expired"));
test("partial result retains unresolved items", () => {
  const r = fakeCatalogRead({ ...request, mode: "partial" });
  assert.equal(r.verified.length, 1);
  assert.deepEqual(r.unresolved, ["product-bag"]);
  assert.equal(r.complete, false);
});
test("uncertain outcome does not pretend verified or retryable", () => {
  const r = fakeCatalogRead({ ...request, mode: "uncertain" });
  assert.equal(r.kind, "uncertain");
  assert.equal(r.retryAllowed, false);
  assert.equal(r.output, undefined);
});
test("unsupported fields do not invent source facts", () =>
  assert.equal(
    fakeCatalogRead({ ...request, input: { ...request.input, fields: ["invented"] } }).kind,
    "denied",
  ));
test("unknown products do not become success", () =>
  assert.equal(
    fakeCatalogRead({ ...request, input: { ...request.input, productIds: ["foreign-product"] } })
      .kind,
    "denied",
  ));
test("returned fixture copies cannot alter subsequent evidence", () => {
  const r = fakeCatalogRead(request);
  r.output.products[0].resource.storeId = "tampered";
  assert.equal(fakeCatalogRead(request).output.products[0].resource.storeId, "store-main");
});
test("fixture catalogue covers both merchant segments", () =>
  assert.deepEqual(
    lab.organizations.map((o) => o.segment),
    ["independent_brand", "specialist_team"],
  ));
test("partial outcome follows requested item order", () => {
  const r = fakeCatalogRead({
    ...request,
    mode: "partial",
    input: { productIds: ["product-bag", "product-shirt"], fields: ["title"] },
  });
  assert.equal(r.verified[0].resource.id, "product-bag");
  assert.deepEqual(r.unresolved, ["product-shirt"]);
});
test("invalid clock cannot make a fake expiry valid", () =>
  assert.equal(fakeCatalogRead({ ...request, now: "invalid" }).kind, "denied"));
