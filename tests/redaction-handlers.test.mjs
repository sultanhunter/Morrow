// M2 PR-1: the store-content cleanup contract (P09.T05a; mvp-architecture §11). The same
// check runs as S8 of the static tenant-conformance suite against the migrated catalog.
import assert from "node:assert/strict";
import test from "node:test";
import { storeContentHandlers } from "../packages/work/src/redaction.ts";
import { contentProblems } from "./tenant-conformance/content.mjs";
import { billingTables, vaultTables, workTables } from "./tenant-conformance/registry.mjs";

test("every registered table is classified, and every store table has exactly one handler", () => {
  assert.deepEqual(contentProblems(), []);
  assert.deepEqual(
    storeContentHandlers.map((h) => [h.table, h.trigger, h.action, h.executable]),
    [
      ["morrow_vault.credentials", "uninstall_or_disconnect", "destroy_credential", "M2 PR-3"],
      ["morrow_work.proposal_parameters", "shop_redact", "empty_keep_digest", "M3 PR-1"],
    ],
  );
  assert.ok(Object.isFrozen(storeContentHandlers) && storeContentHandlers.every(Object.isFrozen));
});

test("the check fails a new store table without a handler, and a stray or duplicate handler", () => {
  const tables = (extra) => ({
    workTables: { ...workTables, ...extra },
    billingTables,
    vaultTables,
  });
  assert.deepEqual(
    contentProblems(storeContentHandlers, tables({ product_snapshots: { content: "store" } })),
    ["STORE_CONTENT_WITHOUT_HANDLER:morrow_work.product_snapshots"],
  );
  assert.deepEqual(
    contentProblems(storeContentHandlers, tables({ run_drafts: { class: "tenant_readable" } })),
    ["CONTENT_UNCLASSIFIED:morrow_work.run_drafts"],
  );
  const extra = (change) => [...storeContentHandlers, { ...storeContentHandlers[1], ...change }];
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
});
