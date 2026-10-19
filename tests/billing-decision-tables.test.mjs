// P01.T04a PR-B: the two checked-in billing decision tables (AC10, AC27). The
// rules files are the reviewers' specification; this file builds a fixture from
// every generated row and checks the billing library against it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkDecisionTables,
  checkTable,
  generateTable,
  readRules,
  tablePath,
} from "../scripts/billing-decision-tables.mjs";
import {
  library,
  rawFacts,
  payerFacts,
  link,
  directLink,
  billingState,
  scopeW,
} from "../scripts/billing-route-fixtures.mjs";
import {
  BillingBoundaryError,
  billingCallToAction,
  classifyPayment,
  parseWorkspaceBillingFacts,
  purchaseDecision,
} from "../packages/policy/src/billing-state.ts";

const L = library();
const environment = "staging";
const routeFor = {
  open: L.routes.open,
  shopify_bound: L.routes.shopify_install_bound,
  morrow_direct: L.routes.morrow_direct,
  shopify_app_pricing: L.routes.shopify_app_pricing,
};
const tableText = (name) => readFileSync(tablePath(name), "utf8");
const parseTable = (name) => {
  const [header, ...lines] = tableText(name).trimEnd().split("\n");
  const columns = header.split("\t");
  return lines.map((line) => Object.fromEntries(line.split("\t").map((v, i) => [columns[i], v])));
};
const thrown = (run) => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
};
// The library's outcome as the table writes it.
const label = (o) =>
  o.outcome === "refused"
    ? "refused:" + o.code
    : o.outcome === "held"
      ? "held:" + o.reason
      : o.outcome === "conflict"
        ? "conflict:" + o.code
        : o.outcome === "grant"
          ? "grant:" + o.grant.kind
          : o.outcome === "fix_route_and_grant"
            ? "fix_route_and_grant:" + o.fixRoute.route
            : o.outcome;

const currentSubscription = {
  stripe: L.entitlements.morrow_w.subscriptionId,
  shopify: L.entitlements.shopify_a.subscriptionId,
};
const otherSubscription = {
  stripe: "stripe:sub:sub_TESTW00000009",
  shopify: "shopify:app:7:shop:42:created:2026-10-17T08:00:00Z",
};
const shopifyReversal = {
  ...structuredClone(L.reversals.dispute_morrow_open),
  route: "shopify_app_pricing",
  paymentKey: L.events.shopify_period_a.paymentKey,
};

// Builds the target and event that realize one classify-payment row, and
// classifies them. The dimensions are independent: `payer` sets only the
// account and reversal facts, and `relation` only the recorded subscription
// (none: no entitlement; current and other_live: an active one; the terminal
// relations: a cancelled one). An input_invalid row realizes its contradiction
// literally, which the library must refuse. `onState` sees the workspace state.
function classifyRow(row, onState = () => {}) {
  const stripe = row.provider === "stripe";
  const provider = row.provider;
  const terminal = row.relation === "new_after_terminal" || row.relation === "current_terminal";
  const payerKey = stripe ? "morrow_w" : "shopify_a";
  // The event.
  let event;
  if (row.kind === "top_up")
    event = stripe
      ? structuredClone(L.events.stripe_top_up)
      : {
          ...structuredClone(L.events.shopify_period_a),
          kind: "top_up",
          subscriptionKey: null,
          periodStart: null,
          periodEnd: null,
        };
  else {
    event = structuredClone(
      L.events[
        row.kind === "plan_change"
          ? stripe
            ? "stripe_plan_change"
            : "shopify_plan_change_a"
          : stripe
            ? "stripe_period"
            : "shopify_period_a"
      ],
    );
    event.subscriptionKey =
      row.relation === "other_live" || row.relation === "new_after_terminal"
        ? otherSubscription[provider]
        : currentSubscription[provider];
  }
  if (
    row.kind === "top_up" &&
    (row.relation === "other_live" || row.relation === "new_after_terminal")
  )
    event.subscriptionKey = otherSubscription.stripe;
  event.mode = row.mode === "matches" ? "test" : "live";
  if (row.amount === "zero") event.amountPaid = { ...event.amountPaid, amount: "0.00" };
  if (stripe && row.attribution === "associated_not_current") {
    event.installationId = "installation_a";
    event.storeId = "store_a";
  }
  const terms = L.terms;
  // The target.
  if (row.attribution === "unattributed") {
    event.organizationId = null;
    event.workspaceId = null;
    const target = {
      kind: "unattributed",
      reason: stripe ? "CUSTOMER_NOT_MAPPED" : "INSTALLATION_NOT_ASSOCIATED",
      environment,
    };
    if (row.payer !== "none" || row.relation !== "none") target.payer = { recorded: true };
    return classifyPayment(target, event, terms, new Set());
  }
  const associations = [];
  const payers = [];
  // A morrow_direct workspace links stores only after its route is fixed (R2, R3).
  const linkOf = row.phase === "morrow_direct" ? directLink : link;
  if (!stripe && row.phase !== "open")
    associations.push(linkOf("iA", { current: row.attribution === "attributed" }));
  if (row.phase === "shopify_app_pricing") {
    associations.push(link("iB"));
    payers.push(payerFacts("shopify_b"));
  }
  if (row.phase === "morrow_direct" && !stripe) payers.push(payerFacts("morrow_w"));
  const recorded =
    row.relation === "none"
      ? null
      : {
          ...structuredClone(L.entitlements[payerKey]),
          subscriptionId: currentSubscription[provider],
          status: terminal ? "cancelled" : "active",
        };
  if (row.payer !== "none")
    payers.push(
      payerFacts(payerKey, {
        account:
          row.payer === "suspended"
            ? { ...structuredClone(L.accounts[payerKey]), status: "suspended" }
            : undefined,
        entitlement: recorded,
        openReversals:
          row.payer === "reversed"
            ? [stripe ? structuredClone(L.reversals.dispute_morrow_open) : shopifyReversal]
            : [],
      }),
    );
  else if (recorded !== null)
    // A recorded subscription without its account.
    payers.push(payerFacts(payerKey, { account: null, entitlement: recorded, association: null }));
  const state = billingState(rawFacts({ route: routeFor[row.phase], associations, payers }), {
    environment,
  });
  onState(state);
  return classifyPayment({ kind: "workspace", state }, event, terms, new Set());
}

test("AC10: the payment table is the full product of its dimensions, one outcome per row, and matches its rules", () => {
  const rules = readRules("classify-payment");
  const rows = parseTable("classify-payment");
  assert.equal(rows.length, 4 * 2 * 3 * 2 * 5 * 4 * 3 * 2);
  assert.equal(rows.length, 5760);
  const dimensions = rules.dimensions.map((d) => d.name);
  const keys = rows.map((r) => dimensions.map((d) => r[d]).join(","));
  assert.equal(new Set(keys).size, rows.length);
  for (const row of rows) {
    assert.ok(rules.outcomes.includes(row.outcome), row.outcome);
    assert.ok(rules.rules.some((r) => r.id === row.rule));
  }
  assert.deepEqual(checkDecisionTables(), []);
  assert.equal(generateTable(rules).text, tableText("classify-payment"));
});

test("AC10: classifyPayment returns every row's outcome and throws on every input_invalid row", () => {
  const rows = parseTable("classify-payment");
  const mismatches = [];
  let invalid = 0;
  for (const row of rows) {
    const key = `${row.phase},${row.provider},${row.kind},${row.mode},${row.relation},${row.payer},${row.attribution},${row.amount}`;
    let outcome = null;
    const error = thrown(() => {
      outcome = classifyRow(row);
    });
    if (row.outcome === "input_invalid") {
      invalid++;
      if (!(error instanceof BillingBoundaryError)) mismatches.push(`${key}: expected a refusal`);
    } else if (error) mismatches.push(`${key}: threw ${error.message}`);
    else if (label(outcome) !== row.outcome)
      mismatches.push(`${key}: ${label(outcome)} != ${row.outcome}`);
  }
  assert.deepEqual(mismatches.slice(0, 20), []);
  assert.ok(invalid > 0 && invalid < rows.length);
});

test("AC10: every decided row realizes its payer and relation as defined, never a contradiction", () => {
  // The event's payer is billable exactly when the payer is active, its recorded
  // subscription is live (current or other_live) and, on Shopify, its link is
  // current; an account with no recorded or a cancelled subscription is not.
  const rows = parseTable("classify-payment").filter(
    (r) => r.outcome !== "input_invalid" && r.attribution !== "unattributed" && r.payer !== "none",
  );
  assert.ok(rows.length > 0);
  const wrong = [];
  for (const row of rows) {
    let payer;
    classifyRow(row, (state) => {
      payer = state.payers.find((p) =>
        row.provider === "stripe"
          ? p.installationId === null
          : p.installationId === "installation_a",
      );
    });
    const billable =
      row.payer === "active" &&
      ["current", "other_live"].includes(row.relation) &&
      row.attribution === "attributed";
    const terminal = ["current_terminal", "new_after_terminal"].includes(row.relation);
    if (
      (payer.status === "billable") !== billable ||
      (payer.subscriptionKey === null) !== (row.relation === "none") ||
      payer.subscriptionTerminal !== terminal
    )
      wrong.push(`${JSON.stringify(row)}: ${payer.status}`);
  }
  assert.deepEqual(wrong.slice(0, 10), []);
});

test("AC10: the table holds the named cases, and no row moves a fixed route", () => {
  const rows = parseTable("classify-payment");
  const find = (where) =>
    rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).map((r) => r.outcome);
  const live = { mode: "matches", amount: "positive" };
  // A late payment on a terminal subscription.
  assert.deepEqual(
    [
      ...new Set(
        find({
          ...live,
          kind: "subscription_period",
          relation: "current_terminal",
          payer: "active",
          attribution: "attributed",
        }),
      ),
    ].sort(),
    // A payer exists only on its own route, so cross-route rows with a payer are input_invalid.
    ["conflict:SUBSCRIPTION_TERMINAL", "input_invalid"],
  );
  assert.deepEqual(
    find({
      ...live,
      phase: "morrow_direct",
      provider: "stripe",
      kind: "subscription_period",
      relation: "current_terminal",
      payer: "active",
      attribution: "attributed",
    }),
    ["conflict:SUBSCRIPTION_TERMINAL"],
  );
  // A top-up in every phase.
  for (const [phase, outcome] of [
    ["open", "conflict:SUBSCRIPTION_REQUIRED"],
    ["shopify_bound", "conflict:ROUTE_MISMATCH"],
    ["shopify_app_pricing", "conflict:ROUTE_MISMATCH"],
  ])
    assert.deepEqual(
      find({
        ...live,
        phase,
        provider: "stripe",
        kind: "top_up",
        relation: "none",
        payer: "none",
        attribution: "attributed",
      }),
      [outcome],
      phase,
    );
  assert.deepEqual(
    find({
      ...live,
      phase: "morrow_direct",
      provider: "stripe",
      kind: "top_up",
      relation: "current",
      payer: "active",
      attribution: "attributed",
    }),
    ["grant:purchased"],
  );
  assert.deepEqual(
    find({
      ...live,
      phase: "morrow_direct",
      provider: "stripe",
      kind: "top_up",
      relation: "current",
      payer: "reversed",
      attribution: "attributed",
    }),
    ["conflict:SUBSCRIPTION_REQUIRED"],
  );
  // The pre-link case, the associated-but-disconnected case and the unmapped case.
  assert.deepEqual(
    [
      ...new Set(
        find({
          ...live,
          provider: "shopify",
          kind: "subscription_period",
          relation: "none",
          payer: "none",
          attribution: "unattributed",
        }),
      ),
    ],
    ["held:INSTALLATION_NOT_ASSOCIATED"],
  );
  assert.deepEqual(
    find({
      ...live,
      phase: "shopify_bound",
      provider: "shopify",
      kind: "subscription_period",
      relation: "none",
      payer: "none",
      attribution: "associated_not_current",
    }),
    ["fix_route_and_grant:shopify_app_pricing"],
  );
  assert.deepEqual(
    find({
      ...live,
      phase: "shopify_app_pricing",
      provider: "shopify",
      kind: "subscription_period",
      relation: "current",
      payer: "suspended",
      attribution: "associated_not_current",
    }),
    ["grant:included"],
  );
  assert.deepEqual(
    [
      ...new Set(
        find({
          ...live,
          provider: "stripe",
          kind: "subscription_period",
          relation: "none",
          payer: "none",
          attribution: "unattributed",
        }),
      ),
    ],
    ["held:CUSTOMER_NOT_MAPPED"],
  );
  // No row yields a route other than the fixed one on a fixed route, and $0 never fixes one.
  for (const row of rows) {
    if (row.outcome.startsWith("fix_route_and_grant")) {
      assert.ok(["open", "shopify_bound"].includes(row.phase), JSON.stringify(row));
      assert.equal(row.amount, "positive");
      assert.equal(row.mode, "matches");
      assert.equal(
        row.outcome,
        row.phase === "open"
          ? "fix_route_and_grant:morrow_direct"
          : "fix_route_and_grant:shopify_app_pricing",
      );
    }
    if (row.amount === "zero")
      assert.ok(
        !row.outcome.startsWith("grant") && !row.outcome.startsWith("fix_route"),
        JSON.stringify(row),
      );
  }
});

test("AC10: --check detects a deleted or duplicated row and rules edited without regenerating", () => {
  const rules = readRules("classify-payment");
  const text = tableText("classify-payment");
  const lines = text.split("\n");
  const deleted = [...lines.slice(0, 100), ...lines.slice(101)].join("\n");
  assert.ok(checkTable(rules, deleted).some((e) => e.startsWith("DECISION_TABLE_ROW_COUNT")));
  assert.ok(checkTable(rules, deleted).some((e) => e.startsWith("DECISION_TABLE_MISSING_ROW")));
  const duplicated = [...lines.slice(0, 101), lines[100], ...lines.slice(101)].join("\n");
  assert.ok(
    checkTable(rules, duplicated).some((e) => e.startsWith("DECISION_TABLE_DUPLICATE_ROW")),
  );
  const edited = structuredClone(rules);
  edited.rules.find((r) => r.id === "R7a").outcome = "conflict:SUBSCRIPTION_REQUIRED";
  edited.rules.find((r) => r.id === "R7b").outcome = "grant:purchased";
  assert.ok(checkTable(edited, text).some((e) => e.startsWith("DECISION_TABLE_ROW_CHANGED")));
  // The generator refuses an incomplete or dead rule list and an unknown value.
  const incomplete = structuredClone(rules);
  incomplete.rules = incomplete.rules.filter((r) => r.id !== "R9g");
  assert.throws(() => generateTable(incomplete), /DECISION_RULES_INCOMPLETE/);
  const dead = structuredClone(rules);
  dead.rules.push({ id: "Z1", when: { kind: ["top_up"] }, outcome: "no_charge", source: "dead" });
  assert.throws(() => generateTable(dead), /DECISION_RULE_UNREACHABLE:classify-payment:Z1/);
  const unknown = structuredClone(rules);
  unknown.rules[0].when.provider = ["paypal"];
  assert.throws(() => generateTable(unknown), /DECISION_RULES_INVALID/);
  const extra = structuredClone(rules);
  extra.reviewed = true;
  assert.throws(() => generateTable(extra), /DECISION_RULES_INVALID/);
});

test("AC10: a partly fixed route record is refused by the facts parser", () => {
  const cases = JSON.parse(readFileSync("docs/contracts/fixtures/P01.T04a.json", "utf8")).cases;
  for (const id of [
    "route.partly_fixed_no_time",
    "route.partly_fixed_no_route",
    "route.partly_fixed_no_key",
  ]) {
    const route = cases.find((c) => c.id === "P01.T04a." + id).value;
    assert.throws(
      () => parseWorkspaceBillingFacts(rawFacts({ route }), scopeW, environment),
      (e) => e instanceof BillingBoundaryError && e.code === "BILLING_FACTS_INVALID",
      id,
    );
  }
});

// AC27: the purchase decision table and the call to action.
function purchaseState(row) {
  const status =
    row.subscription === "terminal"
      ? "cancelled"
      : row.payer === "billable"
        ? "active"
        : "past_due";
  const linkOf = row.phase === "morrow_direct" ? directLink : link;
  const associations =
    row.phase === "open" ? [] : [linkOf("iA", { current: row.link === "current" })];
  const payers =
    row.phase === "morrow_direct"
      ? [payerFacts("morrow_w", { entitlement: { ...L.entitlements.morrow_w, status } })]
      : row.phase === "shopify_app_pricing"
        ? [payerFacts("shopify_a", { entitlement: { ...L.entitlements.shopify_a, status } })]
        : [];
  return billingState(rawFacts({ route: routeFor[row.phase], associations, payers }), {
    environment,
  });
}

test("AC27: the purchase table holds every phase, action, link, payer and subscription row once", () => {
  const rules = readRules("purchase-decision");
  const rows = parseTable("purchase-decision");
  assert.equal(rows.length, 4 * 9 * 2 * 2 * 2);
  assert.equal(rows.length, 288);
  assert.equal(
    new Set(rows.map((r) => [r.phase, r.action, r.link, r.payer, r.subscription].join())).size,
    288,
  );
  assert.equal(generateTable(rules).text, tableText("purchase-decision"));
  // Every Morrow action is refused in both Shopify phases, in every row.
  for (const row of rows)
    if (
      ["shopify_bound", "shopify_app_pricing"].includes(row.phase) &&
      !row.action.startsWith("shopify_")
    )
      assert.equal(row.outcome, "PURCHASE_ROUTE_MISMATCH", JSON.stringify(row));
  const lines = tableText("purchase-decision").split("\n");
  assert.ok(checkTable(rules, lines.slice(0, -2).join("\n") + "\n").length > 0);
  const edited = structuredClone(rules);
  edited.rules.find((r) => r.id === "P4").outcome = "allowed";
  assert.ok(
    checkTable(edited, tableText("purchase-decision")).some((e) =>
      e.startsWith("DECISION_TABLE_ROW_CHANGED"),
    ),
  );
});

test("AC27: purchaseDecision matches every row, and the call to action follows the surface", () => {
  const mismatches = [];
  for (const row of parseTable("purchase-decision")) {
    const state = purchaseState(row);
    const action = row.action.startsWith("shopify_")
      ? { action: row.action, storeId: "store_a" }
      : { action: row.action };
    const decision = purchaseDecision(state, action);
    const outcome = decision.allowed ? "allowed" : decision.code;
    if (outcome !== row.outcome) mismatches.push(`${JSON.stringify(row)}: ${outcome}`);
    const cta = billingCallToAction(state);
    const expected =
      row.phase === "open" || row.phase === "morrow_direct"
        ? "morrow_plans"
        : row.link === "current"
          ? "shopify_plan_page"
          : "none";
    if (cta.kind !== expected)
      mismatches.push(`${JSON.stringify(row)}: call to action ${cta.kind}`);
    if (cta.kind === "morrow_plans")
      assert.equal(cta.href, "/workspace/workspace_w/billing/morrow/plans");
    if (cta.kind === "shopify_plan_page") assert.deepEqual(cta.storeIds, ["store_a"]);
  }
  assert.deepEqual(mismatches, []);
});
