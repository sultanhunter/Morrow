// M2 PR-1: the store-content cleanup contract (P09.T05a; mvp-architecture §11). The same
// check runs as S8 of the static tenant-conformance suite against the migrated catalog.
import assert from "node:assert/strict";
import test from "node:test";
import {
  customerContentHandlers,
  customerKeyMatchers,
  storeContentHandlers,
} from "../packages/work/src/redaction.ts";
import {
  contentClasses,
  contentProblems,
  customerColumnProblems,
  registeredTables,
} from "./tenant-conformance/content.mjs";
import {
  billingTables,
  identityTables,
  vaultTables,
  workTables,
} from "./tenant-conformance/registry.mjs";

test("every registered table is classified, and every store table has exactly one handler", () => {
  assert.deepEqual(contentProblems(), []);
  assert.deepEqual(
    storeContentHandlers.map((h) => [h.table, h.trigger, h.action, h.executable]),
    [
      ["morrow_vault.credentials", "uninstall_or_disconnect", "destroy_credential", "M2 PR-3"],
      ["morrow_identity.linking_candidates", "shop_redact", "pseudonymise", "M2 PR-3"],
      ["morrow_identity.shopify_apps", "shop_redact", "clear_install_link", "M2 PR-3"],
      ["morrow_identity.store_installations", "shop_redact", "pseudonymise", "M2 PR-3"],
      ["morrow_work.proposal_parameters", "shop_redact", "empty_keep_digest", "M2 PR-3"],
      // M3 PR-2: the run's product snapshots and drafts.
      ["morrow_work.product_snapshots", "shop_redact", "delete_rows", "M2 PR-3"],
      ["morrow_work.run_drafts", "shop_redact", "delete_rows", "M2 PR-3"],
    ],
  );
  assert.ok(Object.isFrozen(storeContentHandlers) && storeContentHandlers.every(Object.isFrozen));
  // M2 PR-3: every handler is executable. The token by the broker's destruction (recorded
  // on the installation in the same vault transaction), the shop identity by the identity
  // redaction, the proposal parameters by M3 PR-1's helper, which 0037 revises to run in the
  // connector's redaction context (shop/redact has no session).
  assert.deepEqual(
    storeContentHandlers.map((h) => h.executor),
    [
      "morrow_vault.shopify_credential_destroy",
      "morrow_identity.work_shopify_redact_identity",
      "morrow_identity.work_shopify_redact_identity",
      "morrow_identity.work_shopify_redact_identity",
      "morrow_work.parameters_redact_for_store",
      "morrow_work.store_content_redact",
      "morrow_work.store_content_redact",
    ],
  );
  // A handler declared without its executor fails the check (M2 PR-3).
  assert.deepEqual(
    contentProblems(
      storeContentHandlers.map((h) =>
        h.table === "morrow_identity.shopify_apps" ? { ...h, executor: null } : h,
      ),
    ),
    ["HANDLER_NOT_EXECUTABLE:morrow_identity.shopify_apps"],
  );
});

// M2 PR-1 review: the identity schema, which holds the shop identity now and M2's store
// tables later (spine §6 and §11), is classified table by table like the others.
test("every morrow_identity table is classified; the shop identity is store content", () => {
  const identity = registeredTables().filter(([name]) => name.startsWith("morrow_identity."));
  // 43 through M5 PR-1, plus M3 PR-1's agent_principals (ids only), M2 PR-3's inbox and
  // privacy requests, the shop-specific webhook subscriptions' registrations (ids, codes,
  // counts and times only), and v1 PR 5's store_data_deletions (the 48-hour deletion's record).
  assert.equal(identity.length, 48);
  assert.equal(identityTables.agent_principals.content, "none");
  assert.deepEqual(
    identity.filter(([, spec]) => spec.content === "store").map(([name]) => name),
    [
      "morrow_identity.linking_candidates",
      "morrow_identity.shopify_apps",
      "morrow_identity.store_installations",
    ],
  );
  // M2 PR-2: the other two new identity tables hold digests and ids; the app registry's
  // install link names the shop (the PR-2 review), so it is store content. M2 PR-3: the
  // inbox holds the minimised bodies (ids, scope names, a keyed customer digest; 7 days)
  // and the privacy requests content-free evidence. v1 PR 5: the 48-hour deletion's record
  // is content-free too (ids, codes, counts and times).
  for (const name of [
    "install_continuations",
    "shopify_oauth_states",
    "shopify_webhook_inbox",
    "privacy_requests",
    "shopify_webhook_registrations",
    "store_data_deletions",
  ])
    assert.equal(identityTables[name].content, "none", name);
  // The linking records that only point at a candidate hold no shop content of their own.
  for (const name of ["linking_reviews", "linking_handoffs", "workspace_store_links"])
    assert.equal(identityTables[name].content, "none", name);
  // A new identity store table registered without its handler fails, and so does dropping
  // the installation's handler (M2 PR-2).
  const tables = {
    workTables,
    billingTables,
    vaultTables,
    identityTables: { ...identityTables, shopify_webhook_inbox: { content: "store" } },
  };
  assert.deepEqual(contentProblems(storeContentHandlers, tables), [
    "STORE_CONTENT_WITHOUT_HANDLER:morrow_identity.shopify_webhook_inbox",
  ]);
  assert.deepEqual(
    contentProblems(
      storeContentHandlers.filter((h) => h.table !== "morrow_identity.store_installations"),
    ),
    ["STORE_CONTENT_WITHOUT_HANDLER:morrow_identity.store_installations"],
  );
  // So does dropping the candidates' shop-identity handler.
  assert.deepEqual(
    contentProblems(
      storeContentHandlers.filter((h) => h.table !== "morrow_identity.linking_candidates"),
    ),
    ["STORE_CONTENT_WITHOUT_HANDLER:morrow_identity.linking_candidates"],
  );
});

test("the check fails a new store table without a handler, and a stray or duplicate handler", () => {
  const tables = (extra) => ({
    workTables: { ...workTables, ...extra },
    billingTables,
    vaultTables,
    identityTables,
  });
  assert.deepEqual(
    contentProblems(storeContentHandlers, tables({ product_media: { content: "store" } })),
    ["STORE_CONTENT_WITHOUT_HANDLER:morrow_work.product_media"],
  );
  assert.deepEqual(
    contentProblems(storeContentHandlers, tables({ run_notes: { class: "tenant_readable" } })),
    ["CONTENT_UNCLASSIFIED:morrow_work.run_notes"],
  );
  const parameters = storeContentHandlers.find(
    (h) => h.table === "morrow_work.proposal_parameters",
  );
  const extra = (change) => [...storeContentHandlers, { ...parameters, ...change }];
  assert.deepEqual(contentProblems(extra({})), [
    "HANDLER_DUPLICATE:morrow_work.proposal_parameters",
  ]);
  assert.deepEqual(contentProblems(extra({ table: "morrow_work.goals" })), [
    "HANDLER_FOR_NON_STORE_TABLE:morrow_work.goals",
  ]);
  assert.deepEqual(contentProblems(extra({ table: "morrow_work.absent" })), [
    "HANDLER_UNREGISTERED_TABLE:morrow_work.absent",
  ]);
  assert.deepEqual(contentProblems(extra({ table: "morrow_work.x", action: "ignore" })), [
    "HANDLER_INVALID:morrow_work.x",
  ]);
  // `executable` names a PR still to come (M2 PR-3); a handler waiting on M3 PR-1, this
  // PR, is invalid.
  assert.deepEqual(contentProblems(extra({ table: "morrow_work.y", executable: "M3 PR-1" })), [
    "HANDLER_INVALID:morrow_work.y",
  ]);
});

// SD3 (P09.T05b): the customer-content contract. No table is keyed by an order at this head,
// so the registry is empty and S8 passes; each rule below fails a deliberately broken copy.
test("SD3: an order-keyed table needs a customer handler that applies the listed-orders matcher", () => {
  assert.deepEqual(customerContentHandlers, []);
  assert.ok(Object.isFrozen(customerContentHandlers) && Object.isFrozen(customerKeyMatchers));
  assert.deepEqual(customerKeyMatchers, { order_id: "listed_orders" });
  assert.deepEqual(contentClasses, ["none", "workspace", "store", "customer"]);
  const tables = (extra) => ({
    workTables: { ...workTables, ...extra },
    billingTables,
    vaultTables,
    identityTables,
  });
  const handler = (change = {}) => ({
    table: "morrow_work.order_rows",
    dataClass: "order_rows",
    trigger: "customers_redact",
    matchers: ["listed_orders"],
    action: "delete_rows",
    key: "order_id: the rows of each listed order",
    executor: "morrow_work.customer_content_redact",
    executable: "SD3",
    ...change,
  });
  const orderRows = { order_rows: { content: "none", customerKeys: ["order_id"] } };
  // An order-keyed table without its handler fails; with it, passes.
  assert.deepEqual(contentProblems(storeContentHandlers, tables(orderRows), []), [
    "CUSTOMER_KEYED_WITHOUT_HANDLER:morrow_work.order_rows",
  ]);
  assert.deepEqual(contentProblems(storeContentHandlers, tables(orderRows), [handler()]), []);
  // Malformed keys, a handler without the matcher its key needs, a handler for a table with
  // no key, an unregistered table, a duplicate and a malformed handler each fail.
  for (const [keys, code] of [
    [[], "CUSTOMER_KEYS_INVALID"],
    [["order_id", "order_id"], "CUSTOMER_KEYS_INVALID"],
    [["order_number"], "CUSTOMER_KEYS_INVALID"],
    ["order_id", "CUSTOMER_KEYS_INVALID"],
  ])
    assert.deepEqual(
      contentProblems(
        storeContentHandlers,
        tables({ order_rows: { content: "none", customerKeys: keys } }),
        [],
      ),
      [code + ":morrow_work.order_rows"],
    );
  assert.deepEqual(
    contentProblems(storeContentHandlers, tables({ order_rows: { content: "none" } }), [handler()]),
    ["CUSTOMER_HANDLER_FOR_UNKEYED_TABLE:morrow_work.order_rows"],
  );
  assert.deepEqual(contentProblems(storeContentHandlers, tables({}), [handler()]), [
    "CUSTOMER_HANDLER_UNREGISTERED_TABLE:morrow_work.order_rows",
  ]);
  assert.deepEqual(
    contentProblems(storeContentHandlers, tables(orderRows), [handler(), handler()]),
    ["CUSTOMER_HANDLER_DUPLICATE:morrow_work.order_rows"],
  );
  for (const change of [
    { matchers: [] },
    { matchers: ["listed_orders", "listed_orders"] },
    { matchers: ["names"] },
    { trigger: "shop_redact" },
    { action: "ignore" },
    { executor: "morrow_work.store_content_redact" },
    { executable: "" },
    { key: "" },
    { dataClass: "Order rows" },
    { extra: true },
  ])
    assert.deepEqual(
      contentProblems(storeContentHandlers, tables(orderRows), [handler(change)]),
      [
        "CUSTOMER_HANDLER_INVALID:morrow_work.order_rows",
        "CUSTOMER_KEYED_WITHOUT_HANDLER:morrow_work.order_rows",
      ],
      JSON.stringify(change),
    );
  // A `content: customer` table needs a key (else nothing could find it), its customer
  // handler, and its shop/redact handler too.
  assert.deepEqual(
    contentProblems(storeContentHandlers, tables({ notes: { content: "customer" } }), []),
    [
      "STORE_CONTENT_WITHOUT_HANDLER:morrow_work.notes",
      "CUSTOMER_CONTENT_UNMATCHABLE:morrow_work.notes",
    ],
  );
  const customerRows = { order_rows: { content: "customer", customerKeys: ["order_id"] } };
  assert.deepEqual(contentProblems(storeContentHandlers, tables(customerRows), [handler()]), [
    "STORE_CONTENT_WITHOUT_HANDLER:morrow_work.order_rows",
  ]);
  const shopRedact = {
    table: "morrow_work.order_rows",
    dataClass: "order_rows",
    trigger: "shop_redact",
    action: "delete_rows",
    storeKey: "store_id: the store the order belongs to",
    executor: "morrow_work.store_content_redact",
    executable: "M2 PR-3",
  };
  assert.deepEqual(
    contentProblems([...storeContentHandlers, shopRedact], tables(customerRows), [handler()]),
    [],
  );
});

test("SD3: S8's catalog rule: a column named for an order id needs its table to declare the key", () => {
  assert.deepEqual(customerColumnProblems([]), []);
  // Every shape the rule reads as an order id, and names it does not.
  for (const column of ["order_id", "subject_order_id", "order_ids", "listed_order_ids"])
    assert.deepEqual(customerColumnProblems([["morrow_work.goals", column]]), [
      "CUSTOMER_KEY_UNDECLARED:morrow_work.goals." + column,
    ]);
  for (const column of ["order", "orders", "ordering", "order_id_digest", "reorder_count", "id"])
    assert.deepEqual(customerColumnProblems([["morrow_work.goals", column]]), [], column);
  // A declared key passes.
  assert.deepEqual(
    customerColumnProblems([["morrow_work.order_rows", "order_id"]], {
      workTables: { ...workTables, order_rows: { content: "none", customerKeys: ["order_id"] } },
      billingTables,
      vaultTables,
      identityTables,
    }),
    [],
  );
});
