// The store-content cleanup contract (P09.T05a; mvp-architecture §11): every registered
// table declares its content class, and every "store" table has exactly one cleanup
// handler in packages/work/src/redaction.ts. Used by S8 (lab:tenant-conformance) and by
// tests/redaction-handlers.test.mjs (npm test).
//
// SD3 (P09.T05b): the customer-content contract beside it. A table whose rows are keyed by an
// order (or, from SD4, a customer id or a customer digest) declares those keys
// (`customerKeys`), and has exactly one customer handler (redaction.ts
// customerContentHandlers) applying the matcher each key needs; a `content: customer` table
// must carry a key and also have its shop/redact handler. S8 also reads the live catalog: a
// column named for a key (customerKeyColumns) must belong to a table that declares that key.
import {
  customerContentHandlers,
  customerKeyMatchers,
  storeContentHandlers,
} from "../../packages/work/src/redaction.ts";
import { billingTables, identityTables, vaultTables, workTables } from "./registry.mjs";

export const contentClasses = Object.freeze(["none", "workspace", "store", "customer"]);
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
const actions = [
  "destroy_credential",
  "empty_keep_digest",
  "delete_rows",
  "pseudonymise",
  // M2 PR-2 review: the app registry's install link (packages/work/src/redaction.ts).
  "clear_install_link",
];
const keys = "action,dataClass,executable,executor,storeKey,table,trigger";
// SD3: the customer keys, and the column names that hold each (S8's catalog rule).
export const customerKeys = Object.freeze(Object.keys(customerKeyMatchers));
export const customerKeyColumns = Object.freeze([
  Object.freeze({ key: "order_id", column: /^(?:[a-z0-9_]+_)?order_ids?$/ }),
]);
const customerActions = ["delete_rows", "blank_order_id", "empty_keep_digest", "erase_keep_digest"];
const customerHandlerKeys = "action,dataClass,executable,executor,key,matchers,table,trigger";
const holdsStoreContent = (spec) => spec.content === "store" || spec.content === "customer";

export function contentProblems(
  handlers = storeContentHandlers,
  tables = defaultTables,
  customerHandlers = customerContentHandlers,
) {
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
      handler.executable !== "M2 PR-3"
    ) {
      problems.push("HANDLER_INVALID:" + table);
      continue;
    }
    // M2 PR-3 makes every handler executable: a declared handler without its executor
    // (a store table whose content nothing would delete) fails.
    if (handler.executor === null) problems.push("HANDLER_NOT_EXECUTABLE:" + table);
    if (handled.has(table)) problems.push("HANDLER_DUPLICATE:" + table);
    handled.set(table, handler);
    if (!registered.has(table)) problems.push("HANDLER_UNREGISTERED_TABLE:" + table);
    else if (!holdsStoreContent(registered.get(table)))
      problems.push("HANDLER_FOR_NON_STORE_TABLE:" + table);
  }
  for (const [name, spec] of registered)
    if (holdsStoreContent(spec) && !handled.has(name))
      problems.push("STORE_CONTENT_WITHOUT_HANDLER:" + name);
  // SD3: the customer keys each table declares.
  const keyed = new Map();
  for (const [name, spec] of registered) {
    if (spec.customerKeys === undefined) {
      if (spec.content === "customer") problems.push("CUSTOMER_CONTENT_UNMATCHABLE:" + name);
      continue;
    }
    const list = spec.customerKeys;
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      new Set(list).size !== list.length ||
      !list.every((key) => customerKeys.includes(key))
    ) {
      problems.push("CUSTOMER_KEYS_INVALID:" + name);
      continue;
    }
    keyed.set(name, list);
  }
  const customerHandled = new Map();
  for (const handler of customerHandlers) {
    const table = handler?.table;
    if (
      !handler ||
      Object.keys(handler).sort().join(",") !== customerHandlerKeys ||
      handler.trigger !== "customers_redact" ||
      !customerActions.includes(handler.action) ||
      !/^[a-z][a-z0-9_]{2,63}$/.test(handler.dataClass) ||
      !Array.isArray(handler.matchers) ||
      handler.matchers.length === 0 ||
      new Set(handler.matchers).size !== handler.matchers.length ||
      !handler.matchers.every((m) => Object.values(customerKeyMatchers).includes(m)) ||
      typeof handler.key !== "string" ||
      handler.key.length < 3 ||
      handler.executor !== "morrow_work.customer_content_redact" ||
      typeof handler.executable !== "string" ||
      !/^[A-Z][A-Za-z0-9 -]{1,31}$/.test(handler.executable)
    ) {
      problems.push("CUSTOMER_HANDLER_INVALID:" + table);
      continue;
    }
    if (customerHandled.has(table)) problems.push("CUSTOMER_HANDLER_DUPLICATE:" + table);
    customerHandled.set(table, handler);
    if (!registered.has(table)) problems.push("CUSTOMER_HANDLER_UNREGISTERED_TABLE:" + table);
    else if (!keyed.has(table)) problems.push("CUSTOMER_HANDLER_FOR_UNKEYED_TABLE:" + table);
  }
  for (const [name, list] of keyed) {
    const handler = customerHandled.get(name);
    if (!handler) {
      problems.push("CUSTOMER_KEYED_WITHOUT_HANDLER:" + name);
      continue;
    }
    for (const key of list)
      if (!handler.matchers.includes(customerKeyMatchers[key]))
        problems.push("CUSTOMER_KEY_UNMATCHED:" + name + ":" + key);
  }
  return problems;
}

// S8's catalog rule (SD3): every live column named for a customer key, in the four schemas,
// belongs to a table that declares that key. `columns` are [schema.table, column] pairs.
export function customerColumnProblems(columns, tables = defaultTables) {
  const registered = new Map(registeredTables(tables));
  const problems = [];
  for (const [table, column] of columns)
    for (const { key, column: pattern } of customerKeyColumns)
      if (pattern.test(column) && !(registered.get(table)?.customerKeys ?? []).includes(key))
        problems.push("CUSTOMER_KEY_UNDECLARED:" + table + "." + column);
  return problems.sort();
}
