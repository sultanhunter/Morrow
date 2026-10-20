// M2 PR-2a: the S7 registry format (tests/tenant-conformance/registry.mjs). S7 in
// lab:tenant-conformance compares these entries with the live catalog; this unit test
// checks, without a database, that every entry is well formed and that the per-schema
// USAGE list agrees with what each executor login executes, so a later PR only adds
// entries and a malformed one fails here first.
import test from "node:test";
import assert from "node:assert/strict";
import {
  billingFunctions,
  billingTables,
  executorLogins,
  schemaUsage,
  vaultFunctions,
  vaultTables,
  workRoles,
} from "./tenant-conformance/registry.mjs";

const specKeys = [
  "apiColumns",
  "class",
  "commandColumnUpdates",
  "commandPrivileges",
  "content",
  "parents",
  "policies",
];
const column = /^[a-z][a-z0-9_]{0,62}$/;
const sortedUnique = (list, pattern) =>
  Array.isArray(list) &&
  list.every((x) => typeof x === "string" && pattern.test(x)) &&
  new Set(list).size === list.length &&
  list.every((x, i) => i === 0 || list[i - 1] < x);

// The problems of one S7 table spec, as strings (empty when well formed). The seven
// specKeys are required; `lease` is the one optional key and, when present, is `true`
// (S7's checkPolicies then expects tenant_lease, as for workTables).
function s7SpecProblems(schema, table, spec) {
  const problems = [];
  const at = `${schema}.${table}`;
  if (
    !spec ||
    typeof spec !== "object" ||
    Object.keys(spec)
      .filter((key) => key !== "lease")
      .sort()
      .join() !== specKeys.join()
  )
    return [at + ":keys"];
  if (Object.hasOwn(spec, "lease") && spec.lease !== true) problems.push(at + ":lease");
  const classes =
    schema === "morrow_vault"
      ? ["vault_platform", "vault_tenant"]
      : ["tenant_readable", "tenant_internal", "platform", "tenant_or_platform"];
  if (!classes.includes(spec.class)) problems.push(at + ":class");
  if (!["none", "workspace", "store"].includes(spec.content)) problems.push(at + ":content");
  if (!Array.isArray(spec.parents) || !spec.parents.every((p) => typeof p === "string"))
    problems.push(at + ":parents");
  if (!sortedUnique(spec.policies, /^[a-z][a-z0-9_]{0,62}$/)) problems.push(at + ":policies");
  // Table privileges for the command role only; never DELETE, TRUNCATE, REFERENCES or
  // TRIGGER (no hard delete path, ADR-0010 item 2).
  if (!sortedUnique(spec.commandPrivileges, /^(INSERT|SELECT|UPDATE)$/))
    problems.push(at + ":commandPrivileges");
  if (
    !sortedUnique(spec.commandColumnUpdates, column) ||
    (spec.commandColumnUpdates.length > 0 && spec.commandPrivileges.includes("UPDATE"))
  )
    problems.push(at + ":commandColumnUpdates");
  // The api role reads tenant-readable rows only, column by column; never the vault.
  const readable = spec.class === "tenant_readable" || spec.class === "tenant_or_platform";
  if (!sortedUnique(spec.apiColumns, column) || (!readable && spec.apiColumns.length > 0))
    problems.push(at + ":apiColumns");
  return problems;
}

test("S7 registry: every billing and vault table carries a well-formed per-table spec", () => {
  const problems = [
    ...Object.entries(billingTables).flatMap(([t, s]) => s7SpecProblems("morrow_billing", t, s)),
    ...Object.entries(vaultTables).flatMap(([t, s]) => s7SpecProblems("morrow_vault", t, s)),
  ];
  assert.deepEqual(problems, []);
  // The reviewed 0020 shape, as the old hard-coded S7 asserted it.
  assert.deepEqual(billingTables.workspace_billing_routes.commandPrivileges, ["INSERT", "SELECT"]);
  assert.equal(billingTables.workspace_billing_routes.apiColumns.length, 11);
  for (const table of ["app_secrets", "credentials"])
    assert.deepEqual(vaultTables[table].apiColumns, [], table);
  assert.deepEqual(vaultTables.app_secrets.commandPrivileges, ["SELECT"]);
  // M2 PR-2 (0027): the broker's install definer is the first credentials writer: insert a
  // version, and destroy the active one (erasing its key material); never DELETE.
  assert.deepEqual(vaultTables.credentials.commandPrivileges, ["INSERT", "SELECT"]);
  assert.deepEqual(vaultTables.credentials.commandColumnUpdates, [
    "destroy_reason",
    "destroyed_at",
    "sealed_value",
    "status",
    "wrapped_key",
  ]);
  // Planted malformed specs are reported.
  const good = billingTables.workspace_billing_routes;
  for (const [name, change] of [
    ["keys", { extra: true }],
    ["lease", { lease: "yes" }],
    ["lease", { lease: false }],
    ["commandPrivileges", { commandPrivileges: ["DELETE", "SELECT"] }],
    ["commandPrivileges", { commandPrivileges: ["SELECT", "TRUNCATE"] }],
    ["commandPrivileges", { commandPrivileges: ["SELECT", "INSERT"] }],
    ["commandColumnUpdates", { commandColumnUpdates: ["revision", "revision"] }],
    ["apiColumns", { apiColumns: ["route", "mode"] }],
    ["apiColumns", { apiColumns: ["Route"] }],
    ["class", { class: "vault_tenant" }],
  ])
    assert.ok(
      s7SpecProblems("morrow_billing", "x", { ...good, ...change }).some((p) =>
        p.endsWith(":" + name),
      ),
      JSON.stringify(change),
    );
  assert.ok(
    s7SpecProblems("morrow_vault", "x", { ...vaultTables.credentials, apiColumns: ["id"] }).some(
      (p) => p.endsWith(":apiColumns"),
    ),
  );
  // The optional `lease: true` is well formed; a missing required key is not.
  assert.deepEqual(s7SpecProblems("morrow_billing", "x", { ...good, lease: true }), []);
  const leaseOnly = { ...good, lease: true };
  delete leaseOnly.apiColumns;
  assert.deepEqual(s7SpecProblems("morrow_billing", "x", leaseOnly), ["morrow_billing.x:keys"]);
});

test("S7 registry: schema USAGE agrees with the command role and each executor login", () => {
  assert.deepEqual(Object.keys(schemaUsage).sort(), ["morrow_billing", "morrow_vault"]);
  for (const [schema, roles] of Object.entries(schemaUsage)) {
    assert.ok(sortedUnique(roles, /^morrow_[a-z_]+$/), schema);
    assert.ok(roles.includes(workRoles.command), schema);
    assert.ok(!roles.includes(workRoles.owner), schema);
  }
  // The api role needs USAGE exactly where it reads columns.
  const apiReads = Object.values(billingTables).some((s) => s.apiColumns.length > 0);
  assert.equal(schemaUsage.morrow_billing.includes(workRoles.api), apiReads);
  assert.equal(schemaUsage.morrow_vault.includes(workRoles.api), false);
  // An executor login holds USAGE on an S7 schema exactly when it executes one of its
  // functions (S7 also checks this against the catalog for every schema).
  const registered = { morrow_billing: billingFunctions, morrow_vault: vaultFunctions };
  for (const [login, functions] of Object.entries(executorLogins))
    for (const schema of Object.keys(schemaUsage)) {
      const executes = functions.some((signature) => signature.startsWith(schema + "."));
      assert.equal(schemaUsage[schema].includes(login), executes, `${login} ${schema}`);
      for (const signature of functions.filter((s) => s.startsWith(schema + ".")))
        assert.ok(
          registered[schema][signature.slice(schema.length + 1)]?.grantees.includes(login),
          signature,
        );
    }
});

// The reviewed 0020 column grants, pinned by name as the old hard-coded S7 implied them
// (migration 0020): the api role reads exactly the route's eleven columns, and the command
// role holds no column UPDATE on the route or either vault table. A later PR that widens
// one of these tables changes this expectation beside its registry entry and migration.
test("S7 registry: the reviewed 0020 column grants", () => {
  assert.deepEqual(billingTables.workspace_billing_routes.apiColumns, [
    "created_at",
    "fixing_payment_key",
    "mode",
    "organization_id",
    "origin",
    "revision",
    "route",
    "route_fixed_at",
    "shopify_bound_at",
    "updated_at",
    "workspace_id",
  ]);
  // One line per table, so a PR that widens one table changes only its line.
  assert.deepEqual(billingTables.workspace_billing_routes.commandColumnUpdates, []);
  assert.deepEqual(vaultTables.app_secrets.commandColumnUpdates, []);
  assert.deepEqual(vaultTables.credentials.commandColumnUpdates, []);
});
