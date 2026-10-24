// PR 18 (ADR-0033 items 3-7 and 11): measures, area templates, GoalProgress@1 per viewer,
// Finish, Stop steps and spend per project. Pure code: the SQL twins are proved by
// lab:work-postgresql.
import assert from "node:assert/strict";
import test from "node:test";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import {
  areaStartRecords,
  areaTemplate,
  criteriaForViewer,
  everydayAreaTemplates,
  finishResultsDigest,
  goalAssistants,
  goalMetrics,
  goalProgress,
  handCheckCounted,
  handCheckValue,
  holdsCustomerGoal,
  makeProjectIdea,
  measureDirection,
  planFinish,
  planStopSteps,
  productFacts,
  quickTasksStartRecords,
  readTagsFor,
  spendByProject,
  stepHealth,
  valueExpiresAt,
} from "../packages/policy/src/projects/index.ts";

const day = 86_400_000;
const t0 = Date.parse("2026-10-23T10:00:00Z");
const due = t0 + 42 * day;
const store = "store_a";
const tag = (capability) => ({ storeId: store, capability });
const everyTag = { mayView: () => true };
const only = (...capabilities) => ({ mayView: (t) => capabilities.includes(t.capability) });
const facts = {
  kind: "checklist",
  checklistId: "product_facts_complete",
  productIds: ["product:1"],
  target: 12,
  dueAt: null,
  startRef: null,
};
const named = {
  kind: "manual",
  assistant: "chatgpt",
  cadenceWeeks: 4,
  rows: [{ productId: "product:1", checkItems: ["q1", "q2", "q3", "q4", "q5"] }],
  target: 2,
  dueAt: null,
  startRef: null,
};
const cover = {
  kind: "metric",
  metricId: "days_of_stock_cover",
  target: 14,
  dueAt: null,
  startRef: null,
};
const replied = {
  kind: "metric",
  metricId: "replied_within_a_day",
  target: 95,
  dueAt: null,
  startRef: null,
};
const criterion = (key, measure) => ({
  description: key,
  verificationCapabilityId: null,
  evidenceRequired: false,
  key,
  measure,
});
const dated = (criteria, extra = {}) => ({
  id: "goal_a",
  revision: 1,
  status: "active",
  createdAtMs: t0,
  dueAtMs: due,
  areaTemplateId: null,
  successCriteria: criteria,
  ...extra,
});
const value = (key, v, atMs, extra = {}) => ({
  key,
  productId: null,
  value: v,
  observedAtMs: atMs,
  counted: true,
  assistant: null,
  readTags: [tag("catalog.products.read")],
  dataClass: "work",
  expiresAtMs: null,
  ...extra,
});
const ctx = (nowMs, extra = {}) => ({
  nowMs,
  storeIds: [store],
  finished: null,
  waitingOnViewer: false,
  audience: "viewer",
  ...extra,
});

test("measures: closed lists, directions, read tags and clocks come from code", () => {
  assert.equal(productFacts.length, 12);
  assert.deepEqual(goalAssistants, ["chatgpt", "gemini", "copilot", "perplexity"]);
  assert.equal(measureDirection(cover), "at_least");
  assert.equal(measureDirection({ ...cover, metricId: "best_sellers_at_risk" }), "at_most");
  assert.equal(goalMetrics.replied_within_a_day.valueClass, "customer");
  assert.deepEqual(goalMetrics.replied_within_a_day.readCapabilities, ["support.case.read"]);
  assert.deepEqual(readTagsFor(cover, [store, store]), [
    tag("inventory.levels.read"),
    tag("orders.read"),
  ]);
  assert.deepEqual(readTagsFor(facts, [store]), [tag("catalog.products.read")]);
  // Clocks: none for work; 90 days from the day for orders; a customer value never
  // outlives its cases (copying never extends a clock) and needs them.
  assert.equal(valueExpiresAt("work", t0), null);
  assert.equal(valueExpiresAt("order_aggregates", t0), Date.parse("2027-01-21T00:00:00Z"));
  assert.equal(valueExpiresAt("customer", t0, [t0 + 10 * day]), t0 + 10 * day);
  assert.equal(
    valueExpiresAt("customer", t0, [t0 + 400 * day]),
    Date.parse("2027-01-21T00:00:00Z"),
  );
  assert.throws(() => valueExpiresAt("customer", t0, []), /NEEDS_ITS_CASES/);
  assert.equal(handCheckValue(["named_this_product", "named_no_shop", "named_this_product"]), 2);
  assert.equal(handCheckCounted("chatgpt", "chatgpt"), true);
  assert.equal(handCheckCounted("chatgpt", "gemini"), false);
});

test("area templates: closed data, one goal each, repeating tasks off, Quick tasks unmeasured", () => {
  assert.deepEqual(
    everydayAreaTemplates.map((t) => [t.id, t.label, t.releaseId]),
    [
      ["product_pages", "Product pages", "morrow.listings"],
      ["stock", "Stock", "morrow.inventory"],
      ["customer_emails", "Customer emails", "morrow.support"],
      ["sales_and_numbers", "Sales and numbers", "morrow.analyst"],
      ["promotions", "Promotions", "morrow.marketing"],
    ],
  );
  for (const t of everydayAreaTemplates) {
    assert.equal(validateCurrentDefinition("EverydayAreaTemplate", t), true, t.id);
    assert.ok(Object.isFrozen(t), t.id);
    assert.ok(
      t.repeatingTasks.every((r) => r.defaultOn === false),
      t.id,
    );
    const records = areaStartRecords(t.id);
    assert.equal(records.goal.dueAt, null);
    assert.equal(records.goal.areaTemplateId, t.id);
    assert.equal(records.project.pin, false);
    assert.deepEqual(records.repeating, [], "nothing repeats before a person turns it on");
    assert.equal(validateCurrentDefinition("PlanStartRecords", records), true, t.id);
  }
  assert.equal(areaTemplate("quick_tasks"), null);
  const quick = quickTasksStartRecords();
  assert.equal(quick.goal.areaTemplateId, "quick_tasks");
  assert.deepEqual(
    quick.goal.successCriteria.map((c) => c.measure),
    [null],
  );
  assert.equal(validateCurrentDefinition("PlanStartRecords", quick), true);
  assert.throws(() => areaStartRecords("quick_tasks"), /AREA_TEMPLATE_UNKNOWN/);
});

test("Make a project? is a code rule over 3 or more open Quick tasks", () => {
  const task = (taskId, productIds, installationId = null) => ({
    taskId,
    productIds,
    installationId,
  });
  assert.equal(makeProjectIdea([task("a", ["product:1"]), task("b", ["product:1"])]), null);
  assert.deepEqual(
    makeProjectIdea([
      task("a", ["product:1"]),
      task("b", ["product:1", "product:2"]),
      task("c", ["product:1"]),
      task("d", ["product:2"]),
    ]),
    { kind: "product", productId: "product:1", taskIds: ["a", "b", "c"] },
  );
  assert.deepEqual(
    makeProjectIdea([task("a", [], "inst"), task("b", [], "inst"), task("c", [], "inst")]),
    { kind: "agent", installationId: "inst", taskIds: ["a", "b", "c"] },
  );
});

test("a dated goal: the straight line, the 25% rule, Done and Needs you", () => {
  const record = dated([criterion("facts", facts)]);
  const at = (frac) => t0 + Math.round(frac * 42 * day);
  const run = (values, now) => goalProgress(record, values, everyTag, ctx(now)).goals[0];
  // No value: Not measured.
  assert.deepEqual(
    [run([], at(0.1)).health, run([], at(0.1)).reason],
    ["not_measured", "no_value"],
  );
  // One value: the starting point.
  const start = value("facts", 5, at(0));
  assert.equal(run([start], at(0.1)).reason, "starting_point");
  // At half time the line expects 8.5: 9 is On track (at least), 6 is Behind.
  assert.equal(run([start, value("facts", 9, at(0.5))], at(0.5)).health, "on_track");
  const behind = run([start, value("facts", 6, at(0.5))], at(0.5));
  assert.deepEqual([behind.health, behind.reason], ["behind", "off_target_side"]);
  // Off the line before 25% of the time: never Behind yet.
  const early = run([start, value("facts", 5, at(0.2))], at(0.2));
  assert.deepEqual([early.health, early.reason], ["on_track", "too_early_to_judge"]);
  // Target met: Done; past the date without it: Needs you, never On track.
  assert.equal(run([start, value("facts", 12, at(0.9))], at(0.9)).health, "done");
  const ended = run([start, value("facts", 11, at(0.9))], due + day);
  assert.deepEqual([ended.health, ended.reason], ["needs_you", "ended"]);
  // The other direction: best sellers at risk, at most 0, from 6.
  const risk = { ...cover, metricId: "best_sellers_at_risk", target: 0 };
  const riskRecord = dated([criterion("risk", risk)]);
  const tags = [tag("inventory.levels.read"), tag("orders.read")];
  const v = (n, frac) =>
    value("risk", n, at(frac), {
      readTags: tags,
      dataClass: "order_aggregates",
      expiresAtMs: at(frac) + 90 * day,
    });
  const riskAt = (values, now) => goalProgress(riskRecord, values, everyTag, ctx(now)).goals[0];
  assert.equal(riskAt([v(6, 0), v(2, 0.5)], at(0.5)).health, "on_track");
  assert.equal(riskAt([v(6, 0), v(5, 0.5)], at(0.5)).health, "behind");
  assert.equal(riskAt([v(6, 0), v(0, 0.6)], at(0.6)).health, "done");
});

test("an expired value is gone: the start is the oldest kept value", () => {
  const tags = [tag("inventory.levels.read"), tag("orders.read")];
  const record = dated([criterion("cover", cover)]);
  const old = value("cover", 2, t0, {
    readTags: tags,
    dataClass: "order_aggregates",
    expiresAtMs: t0 + 5 * day,
  });
  const later = value("cover", 9, t0 + 10 * day, {
    readTags: tags,
    dataClass: "order_aggregates",
    expiresAtMs: t0 + 100 * day,
  });
  const now = t0 + 11 * day;
  const g = goalProgress(record, [old, later], everyTag, ctx(now)).goals[0];
  assert.equal(g.reason, "starting_point", "the expired first value no longer counts");
  assert.equal(g.value.value, 9);
});

test("a hand check is judged on check dates; an overdue check is Needs you", () => {
  const record = dated([criterion("named", named)]);
  const check = (v, atMs, extra = {}) =>
    value("named", v, atMs, { productId: "product:1", assistant: "chatgpt", ...extra });
  const run = (values, now) => goalProgress(record, values, everyTag, ctx(now)).goals[0];
  const first = run([], t0 + day);
  assert.deepEqual([first.health, first.reason], ["not_measured", "not_checked_yet"]);
  const once = run([check(0, t0 + day)], t0 + 2 * day);
  assert.deepEqual([once.health, once.reason], ["not_measured", "starting_point"]);
  // A check in another assistant is kept but never counts.
  const other = run(
    [check(0, t0 + day), check(5, t0 + 3 * day, { counted: false, assistant: "gemini" })],
    t0 + 4 * day,
  );
  assert.deepEqual([other.health, other.reason], ["not_measured", "starting_point"]);
  // Two counted checks: words, here Done (2 of 5 named).
  assert.equal(run([check(0, t0 + day), check(2, t0 + 29 * day)], t0 + 30 * day).health, "done");
  // No check for longer than the cadence (4 weeks): Needs you since the due day.
  const overdue = run([check(0, t0 + day)], t0 + 30 * day);
  assert.deepEqual([overdue.health, overdue.reason], ["needs_you", "check_overdue"]);
  assert.equal(overdue.since, new Date(t0 + day + 28 * day).toISOString());
  const never = run([], t0 + 29 * day);
  assert.deepEqual([never.health, never.reason], ["needs_you", "check_overdue"]);
});

test("a hand check counts only in the measure's current assistant and on its current rows", () => {
  const two = {
    ...named,
    rows: [
      { productId: "product:1", checkItems: ["q1", "q2"] },
      { productId: "product:2", checkItems: ["q1", "q2"] },
    ],
  };
  const check = (productId, v, atMs, assistant = "chatgpt") =>
    value("named", v, atMs, { productId, assistant, counted: true });
  const checks = [
    check("product:1", 0, t0 + day),
    check("product:2", 0, t0 + day),
    check("product:1", 1, t0 + 20 * day),
    check("product:2", 1, t0 + 20 * day),
  ];
  const run = (measure, values = checks) =>
    goalProgress(dated([criterion("named", measure)]), values, everyTag, ctx(t0 + 21 * day))
      .goals[0];
  // Both rows in ChatGPT: 1 + 1 named, the target of 2 met.
  assert.equal(run(two).health, "done");
  assert.equal(run(two).value.value, 2);
  // A revise switches the assistant: the ChatGPT checks, though stored as counted, no
  // longer count for the Gemini goal.
  const gemini = run({ ...two, assistant: "gemini" });
  assert.deepEqual(
    [gemini.health, gemini.reason, gemini.value],
    ["not_measured", "not_checked_yet", null],
  );
  // A revise removes product:2's row: its checks no longer count (1 named, not Done).
  const one = run({ ...two, rows: [two.rows[0]] });
  assert.notEqual(one.health, "done");
  assert.equal(one.value.value, 1);
  // A check whose stored assistant is not the measure's never counts, even if flagged.
  const flagged = run(two, [...checks, check("product:1", 2, t0 + 20.5 * day, "gemini")]);
  assert.equal(flagged.value.value, 2);
});

test("goal records per viewer: a customer-class goal only for members who may read customer data", () => {
  const record = [
    criterion("facts", facts),
    criterion("replied", replied),
    criterion("cover", cover),
  ];
  assert.equal(holdsCustomerGoal(record), true);
  assert.equal(holdsCustomerGoal([criterion("facts", facts)]), false);
  // Without support.case.read on the store, the customer goal is left out; others stay,
  // whatever else the viewer may not see (goal definitions are not order data).
  assert.deepEqual(
    criteriaForViewer(record, only("catalog.products.read"), [store]).map((c) => c.key),
    ["facts", "cover"],
  );
  // With it, everything is shown.
  assert.deepEqual(
    criteriaForViewer(record, only("support.case.read"), [store]).map((c) => c.key),
    ["facts", "replied", "cover"],
  );
  // No store: no viewer may see a customer-class goal.
  assert.deepEqual(
    criteriaForViewer(record, everyTag, []).map((c) => c.key),
    ["facts", "cover"],
  );
  // The Customer emails area holds only its customer goal: nothing is left, so the record
  // is not shown to this viewer at all.
  const emails = areaStartRecords("customer_emails").goal.successCriteria;
  assert.equal(criteriaForViewer(emails, only("orders.read"), [store]), null);
  assert.deepEqual(criteriaForViewer(emails, only("support.case.read"), [store]), emails);
  // Unmeasured criteria (Quick tasks' hidden one) are always kept.
  const quick = quickTasksStartRecords().goal.successCriteria;
  assert.deepEqual(criteriaForViewer(quick, only(), []), quick);
});

test("Finish's results record leaves a customer-class goal out and stores no number", async () => {
  const record = dated([criterion("facts", facts), criterion("replied", replied)]);
  const plan = await planFinish({
    record,
    values: [value("facts", 5, t0), value("facts", 12, t0 + 30 * day)],
    tasks: [],
    storeIds: [store],
    nowMs: t0 + 30 * day,
    keepMonthlyCheck: false,
    productPagesArea: null,
    cancelEdgesAvailable: false,
  });
  // Code's own view still judges the customer goal (no value yet: not Done), so the record
  // is not achieved; the results record names only the other goal, by key and health.
  assert.equal(plan.to, "cancelled");
  assert.deepEqual(plan.results.goals, [{ key: "facts", health: "done" }]);
  assert.doesNotMatch(JSON.stringify(plan.results), /replied|"value"/);
});

test("an area goal: the template's threshold, never Done", () => {
  const records = areaStartRecords("product_pages");
  const record = {
    id: "goal_area",
    revision: 1,
    status: "active",
    createdAtMs: t0,
    dueAtMs: null,
    areaTemplateId: "product_pages",
    successCriteria: records.goal.successCriteria,
  };
  const run = (v) =>
    goalProgress(record, [value("pages_complete", v, t0 + day)], everyTag, ctx(t0 + 2 * day));
  assert.equal(run(100).goals[0].health, "on_track", "even at the target, never Done");
  assert.equal(run(90).goals[0].health, "on_track");
  assert.equal(run(89).goals[0].health, "behind");
  assert.equal(run(89).health, "behind");
});

test("per viewer: goals a viewer may not see are left out, never counted", () => {
  const ordersTags = [tag("inventory.levels.read"), tag("orders.read")];
  const record = dated([
    criterion("facts", facts),
    criterion("cover", cover),
    criterion("replied", replied),
  ]);
  const values = [
    value("facts", 5, t0),
    value("facts", 11, t0 + 21 * day),
    value("cover", 3, t0, {
      readTags: ordersTags,
      dataClass: "order_aggregates",
      expiresAtMs: t0 + 90 * day,
    }),
    value("cover", 3, t0 + 21 * day, {
      readTags: ordersTags,
      dataClass: "order_aggregates",
      expiresAtMs: t0 + 90 * day,
    }),
    value("replied", 50, t0, {
      readTags: [tag("support.case.read")],
      dataClass: "customer",
      expiresAtMs: t0 + 30 * day,
    }),
  ];
  const now = t0 + 21 * day;
  const owner = goalProgress(record, values, everyTag, ctx(now));
  assert.deepEqual(
    owner.goals.map((g) => g.key),
    ["facts", "cover", "replied"],
  );
  assert.equal(owner.health, "behind", "the worst goal (stock cover) for the Owner");
  // A Member without orders.read: the order-measured goal and its word are left out.
  const member = goalProgress(record, values, only("catalog.products.read"), ctx(now));
  assert.deepEqual(
    member.goals.map((g) => g.key),
    ["facts"],
  );
  assert.equal(member.health, "on_track");
  assert.equal(validateCurrentDefinition("GoalProgress", member), true);
  assert.ok(!JSON.stringify(member).includes("cover"));
  // The customer goal: only a viewer holding support.case.read sees it, and never in a
  // project_update or the Coordinator's context, whatever the viewer holds.
  for (const audience of ["project_update", "coordinator"]) {
    const p = goalProgress(record, values, everyTag, ctx(now, { audience }));
    assert.deepEqual(
      p.goals.map((g) => g.key),
      ["facts", "cover"],
      audience,
    );
  }
  const noCases = goalProgress(
    record,
    values,
    only("catalog.products.read", "orders.read", "inventory.levels.read"),
    ctx(now),
  );
  assert.deepEqual(
    noCases.goals.map((g) => g.key),
    ["facts", "cover"],
  );
  // A value with one tag the viewer lacks is not seen even under a visible goal.
  const mixed = goalProgress(
    dated([criterion("facts", facts)]),
    [
      value("facts", 12, t0 + day, {
        readTags: [tag("catalog.products.read"), tag("orders.read")],
      }),
    ],
    only("catalog.products.read"),
    ctx(now),
  );
  assert.equal(mixed.goals[0].reason, "no_value");
});

test("the project's word: Done only after Finish, Needs you when waited on or ended", () => {
  const record = dated([criterion("facts", facts)]);
  const values = [value("facts", 5, t0), value("facts", 12, t0 + 10 * day)];
  const word = (extra, now = t0 + 11 * day) => {
    const p = goalProgress(record, values, everyTag, ctx(now, extra));
    return [p.health, p.reason];
  };
  assert.deepEqual(word({}), ["on_track", "target_met"], "every goal Done is still On track");
  assert.deepEqual(word({ waitingOnViewer: true }), ["needs_you", "waiting_on_you"]);
  assert.deepEqual(word({}, due + day), ["needs_you", "ended"]);
  assert.deepEqual(word({ finished: { outcome: "achieved", atMs: t0 + 12 * day } }), [
    "done",
    "finished",
  ]);
  const unmeasured = goalProgress(dated([]), [], everyTag, ctx(t0 + day));
  assert.deepEqual([unmeasured.health, unmeasured.reason], ["not_measured", "no_value"]);
});

test("step words: Not started before its date, No progress after 3 days unmoved", () => {
  assert.deepEqual(stepHealth({ startsAtMs: t0 + day, lastMovedAtMs: t0, ended: false }, t0), {
    kind: "not_started",
    startsAt: new Date(t0 + day).toISOString(),
  });
  assert.deepEqual(
    stepHealth({ startsAtMs: null, lastMovedAtMs: t0, ended: false }, t0 + 3 * day),
    { kind: "no_progress", since: new Date(t0).toISOString() },
  );
  assert.deepEqual(stepHealth({ startsAtMs: null, lastMovedAtMs: t0, ended: false }, t0 + day), {
    kind: "moving",
  });
});

test("Finish: achieved only when code finds every goal Done; the monthly check moves", async () => {
  const record = dated([criterion("facts", facts), criterion("named", named)]);
  const doneValues = [
    value("facts", 5, t0),
    value("facts", 12, t0 + 30 * day),
    value("named", 0, t0 + day, { productId: "product:1", assistant: "chatgpt" }),
    value("named", 3, t0 + 29 * day, { productId: "product:1", assistant: "chatgpt" }),
  ];
  const base = {
    record,
    values: doneValues,
    tasks: [{ id: "task_done", status: "succeeded" }],
    storeIds: [store],
    nowMs: t0 + 30 * day,
    keepMonthlyCheck: false,
    productPagesArea: null,
    cancelEdgesAvailable: false,
  };
  const achieved = await planFinish(base);
  assert.equal(achieved.to, "achieved");
  assert.match(achieved.resultsDigest, /^[a-f0-9]{64}$/);
  assert.equal(achieved.resultsDigest, await finishResultsDigest(achieved.results));
  // The results record keeps keys and health codes only, never a measured number.
  assert.deepEqual(achieved.results.goals, [
    { key: "facts", health: "done" },
    { key: "named", health: "done" },
  ]);
  assert.doesNotMatch(JSON.stringify(achieved.results), /"value"|"observedAt"/);
  const partial = await planFinish({ ...base, values: doneValues.slice(0, 2) });
  assert.equal(partial.to, "cancelled");
  // An open task: refused until the P06 cancel edges exist; a running one always.
  assert.deepEqual(await planFinish({ ...base, tasks: [{ id: "t", status: "ready" }] }), {
    refusal: "tasks_open",
  });
  assert.deepEqual(
    await planFinish({
      ...base,
      tasks: [{ id: "t", status: "running" }],
      cancelEdgesAvailable: true,
    }),
    { refusal: "tasks_open" },
  );
  assert.deepEqual(
    (
      await planFinish({
        ...base,
        tasks: [{ id: "t", status: "ready" }],
        cancelEdgesAvailable: true,
      })
    ).cancelTaskIds,
    ["t"],
  );
  assert.deepEqual(await planFinish({ ...base, record: { ...record, status: "achieved" } }), {
    refusal: "already_finished",
  });
  const area = areaStartRecords("product_pages");
  // Keep the monthly check: a new area goal, then a product row on it.
  const keep = await planFinish({
    ...base,
    keepMonthlyCheck: true,
    productPagesArea: {
      goalId: "goal_area",
      revision: 3,
      objective: area.goal.objective,
      successCriteria: area.goal.successCriteria,
    },
  });
  assert.equal(keep.areaRevision.expectedRevision, 3);
  const added = keep.areaRevision.successCriteria.at(-1);
  assert.equal(added.key, "ai_named");
  assert.deepEqual(added.measure.rows, named.rows);
  assert.equal(added.measure.startRef, null);
  const second = await planFinish({
    ...base,
    record: dated([
      criterion("facts", facts),
      criterion("named", { ...named, rows: [{ productId: "product:2", checkItems: ["q"] }] }),
    ]),
    keepMonthlyCheck: true,
    productPagesArea: {
      goalId: "goal_area",
      revision: 4,
      objective: area.goal.objective,
      successCriteria: keep.areaRevision.successCriteria,
    },
  });
  assert.deepEqual(
    second.areaRevision.successCriteria.at(-1).measure.rows.map((r) => r.productId),
    ["product:1", "product:2"],
  );
  // A 4th measured area goal is refused.
  const full = ["a", "b", "c"].map((k) => criterion(k, { ...cover, dueAt: null }));
  assert.deepEqual(
    await planFinish({
      ...base,
      keepMonthlyCheck: true,
      productPagesArea: { goalId: "g", revision: 1, objective: "x", successCriteria: full },
    }),
    { refusal: "area_goal_limit" },
  );
  assert.deepEqual(await planFinish({ ...base, keepMonthlyCheck: true }), {
    refusal: "area_missing",
  });
  assert.deepEqual(
    await planFinish({ ...base, record: { ...record, dueAtMs: null, areaTemplateId: "stock" } }),
    { refusal: "not_a_project" },
  );
});

test("Stop steps: routines off by a configure revision, unstarted tasks cancelled", () => {
  const input = {
    routines: [
      { id: "r1", status: "active", revision: 2 },
      { id: "r2", status: "disabled", revision: 5 },
    ],
    tasks: [
      { id: "t_draft", status: "draft" },
      { id: "t_ready", status: "ready" },
      { id: "t_running", status: "running" },
      { id: "t_waiting", status: "waiting_approval" },
      { id: "t_done", status: "succeeded" },
    ],
  };
  const before = planStopSteps({ ...input, cancelEdgesAvailable: false });
  assert.deepEqual(before.disableRoutines, [{ routineId: "r1", expectedRevision: 2 }]);
  assert.deepEqual(before.cancelTaskIds, []);
  assert.deepEqual(before.cancelUnavailableTaskIds, ["t_draft", "t_ready"]);
  assert.deepEqual(before.keepRunningTaskIds, ["t_running", "t_waiting"]);
  const after = planStopSteps({ ...input, cancelEdgesAvailable: true });
  assert.deepEqual(after.cancelTaskIds, ["t_draft", "t_ready"]);
  assert.deepEqual(after.cancelUnavailableTaskIds, []);
});

test("spend per project and helper: display only, settled credits", () => {
  const projects = new Map([
    ["goal_a", "project_a"],
    ["goal_b", "project_b"],
  ]);
  const run = (runId, credits, helper, attribution) => ({ runId, credits, helper, attribution });
  const result = spendByProject(
    [
      run("1", 7, { kind: "specialist" }, { kind: "task", goalId: "goal_a" }),
      run(
        "2",
        20,
        { kind: "agent", installationId: "listings" },
        { kind: "task", goalId: "goal_a" },
      ),
      run(
        "3",
        2,
        { kind: "coordinator" },
        { kind: "project_conversation", projectId: "project_a" },
      ),
      run("4", 3, { kind: "coordinator" }, { kind: "ask" }),
      run(
        "5",
        4,
        { kind: "agent", installationId: "inventory" },
        { kind: "task", goalId: "goal_b" },
      ),
      run("6", 1, { kind: "coordinator" }, { kind: "task", goalId: "goal_loose" }),
    ],
    projects,
  );
  assert.deepEqual(result.projects, [
    {
      target: { kind: "project", projectId: "project_a" },
      credits: 29,
      byHelper: [
        { helper: "agent:listings", credits: 20 },
        { helper: "coordinator", credits: 2 },
        { helper: "specialist", credits: 7 },
      ],
    },
    {
      target: { kind: "project", projectId: "project_b" },
      credits: 4,
      byHelper: [{ helper: "agent:inventory", credits: 4 }],
    },
    {
      target: { kind: "ask_morrow" },
      credits: 3,
      byHelper: [{ helper: "coordinator", credits: 3 }],
    },
  ]);
  assert.deepEqual(result.unattributed, ["6"]);
  assert.throws(
    () => spendByProject([run("x", -1, { kind: "coordinator" }, { kind: "ask" })], projects),
    /SPEND_INVALID/,
  );
});
