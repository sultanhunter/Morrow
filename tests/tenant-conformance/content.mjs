// The store-content cleanup contract (P09.T05a; mvp-architecture §11): every registered
// table declares its content class, and every "store" table has exactly one cleanup
// handler in packages/work/src/redaction.ts. Used by S8 (lab:tenant-conformance) and by
// tests/redaction-handlers.test.mjs (npm test).
import { storeContentHandlers } from "../../packages/work/src/redaction.ts";
import { billingTables, identityTables, vaultTables, workTables } from "./registry.mjs";

export const contentClasses = Object.freeze(["none", "workspace", "store"]);
// The schemas whose every table is classified: S8 compares this list with the live
// catalog of each, so a new table in any of them fails until it is registered.
export const contentSchemas = Object.freeze([
  "morrow_billing",
  "morrow_identity",
  "morrow_vault",
  "morrow_work",
]);
const defaultTables = { workTables, billingTables, vaultTables, identityTables };
export const registeredTables = (tables = defaultTables) => [
  ...Object.entries(tables.workTables).map(([name, spec]) => ["morrow_work." + name, spec]),
  ...Object.entries(tables.billingTables).map(([name, spec]) => ["morrow_billing." + name, spec]),
  ...Object.entries(tables.vaultTables).map(([name, spec]) => ["morrow_vault." + name, spec]),
  ...Object.entries(tables.identityTables).map(([name, spec]) => ["morrow_identity." + name, spec]),
];
const triggers = ["shop_redact", "uninstall_or_disconnect"];
const actions = ["destroy_credential", "empty_keep_digest", "delete_rows", "pseudonymise"];
const keys = "action,dataClass,executable,executor,storeKey,table,trigger";

export function contentProblems(handlers = storeContentHandlers, tables = defaultTables) {
  const problems = [];
  const registered = new Map(registeredTables(tables));
  for (const [name, spec] of registered)
    if (!contentClasses.includes(spec.content)) problems.push("CONTENT_UNCLASSIFIED:" + name);
  const handled = new Map();
  for (const handler of handlers) {
    const table = handler?.table;
    if (
      !handler ||
      Object.keys(handler).sort().join(",") !== keys ||
      !triggers.includes(handler.trigger) ||
      !actions.includes(handler.action) ||
      !/^[a-z][a-z0-9_]{2,63}$/.test(handler.dataClass) ||
      typeof handler.storeKey !== "string" ||
      handler.storeKey.length < 3 ||
      !(handler.executor === null || /^[a-z_]+\.[a-z_]+(\(\))?$/.test(handler.executor)) ||
      !["M2 PR-3", "M3 PR-1"].includes(handler.executable)
    ) {
      problems.push("HANDLER_INVALID:" + table);
      continue;
    }
    if (handled.has(table)) problems.push("HANDLER_DUPLICATE:" + table);
    handled.set(table, handler);
    if (!registered.has(table)) problems.push("HANDLER_UNREGISTERED_TABLE:" + table);
    else if (registered.get(table).content !== "store")
      problems.push("HANDLER_FOR_NON_STORE_TABLE:" + table);
  }
  for (const [name, spec] of registered)
    if (spec.content === "store" && !handled.has(name))
      problems.push("STORE_CONTENT_WITHOUT_HANDLER:" + name);
  return problems;
}
