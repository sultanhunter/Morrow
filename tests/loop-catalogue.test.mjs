// PR 10: model catalogue version 2 (proposed; ADR-0027 items 6 and 12) and the loop's money
// rules (ADR-0026 item 4): worst-case turns, turn limits, holds, cap_below_turn and the
// final turn. Every number below is ADR-0027 item 12's table or ADR-0026 item 4's text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  generateLoopCatalogue,
  loopCatalogueData,
  loopCataloguePath,
  modelCatalogueData,
} from "../scripts/generate-model-catalogue.mjs";
import {
  catalogueVersionDigest,
  inspectModelPolicy,
  loopCallBudgetMs,
} from "../scripts/provider-checks.mjs";
import {
  activeLoopVersion,
  callBudgetsFit,
  creditCapUsd12,
  defaultLoopProfile,
  expectedRunUsd12,
  fitsDailyBackstop,
  LoopCatalogueError,
  loopEntries,
  loopEntry,
  loopVersions,
  lookForWorkDailyCapUsd12,
  lookForWorkHold,
  nextTurn,
  publishedLoopEntry,
  runHold,
  runHoldRecord,
  turnLimit,
  usd12Text,
} from "../packages/policy/src/loop-catalogue.ts";
import { modelCallBudgetMs } from "../packages/identity/src/broker-protocol.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

const policy = JSON.parse(readFileSync("docs/decisions/model-policy.json", "utf8"));
const registry = JSON.parse(readFileSync("docs/decisions/providers.json", "utf8"));
const usd = (dollars) => BigInt(Math.round(dollars * 1e6)) * 1_000_000n;
const cents = (units) => Math.round(Number(units / 10_000_000_000n)) / 100;
const entry = (model, effort) => loopEntry(2, `claude_${model}_5_5`, effort);
const capAt = (price, basisPoints) =>
  creditCapUsd12({ planPriceUsd: price, capBasisPoints: basisPoints });

test("the loop catalogue reproduces and is data only", async () => {
  const text = await generateLoopCatalogue();
  assert.equal(readFileSync(loopCataloguePath, "utf8"), text);
  assert.doesNotMatch(text, /\bimport\b|\bfunction\b|=>|\beval\b/);
  assert.deepEqual(loopVersions(), [2]);
});

test("version 2 is proposed: nine entries, no xhigh or max, every call within 600 s", () => {
  const v2 = policy.catalogue.versions[1];
  assert.equal(v2.status, "proposed");
  assert.equal(v2.owner_confirmation, null);
  assert.equal(Object.hasOwn(policy.catalogue.published_digests, "2"), false);
  assert.deepEqual(
    policy.catalogue.active_versions,
    { per_product: 3, agent_loop: null },
    "version 3 is active for listings-run@1 (ADR-0036); no loop version is active",
  );
  assert.equal(activeLoopVersion(), null);
  const entries = loopEntries(2);
  assert.equal(entries.length, 9);
  assert.deepEqual([...new Set(entries.map((e) => e.effort))], ["low", "medium", "high"]);
  assert.ok(callBudgetsFit(2));
  // One call's budget at the 128,000 tokens-an-hour floor: about 197 s, 394 s and 506 s.
  for (const [effort, seconds] of [
    ["low", 197],
    ["medium", 394],
    ["high", 506],
  ]) {
    const e = entry("opus", effort);
    assert.equal(e.callBudgetMs, modelCallBudgetMs(e.maxOutputTokens));
    assert.equal(e.callBudgetMs, loopCallBudgetMs(e.maxOutputTokens), "the inspector agrees");
    assert.equal(Math.round(e.callBudgetMs / 1000), seconds, effort);
  }
  // Admission takes only a published entry and substitutes nothing.
  assert.equal(publishedLoopEntry(2, "claude_opus_5_5", "high"), null);
  assert.equal(loopEntry(2, "claude_opus_5_5", "xhigh"), null);
  assert.equal(loopEntry(2, "claude-opus-5-5", "high"), null);
  assert.equal(loopEntry(3, "claude_opus_5_5", "high"), null);
});

test("ADR-0027 item 12 as ADR-0036 amends it: Opus high for Morrow, Opus medium for every other kind", () => {
  assert.deepEqual(defaultLoopProfile(2, "coordinator"), {
    model: "claude_opus_5_5",
    effort: "high",
  });
  assert.deepEqual(defaultLoopProfile(2, "specialist"), {
    model: "claude_opus_5_5",
    effort: "medium",
  });
  assert.deepEqual(defaultLoopProfile(2, "installed"), {
    model: "claude_opus_5_5",
    effort: "medium",
  });
  assert.throws(() => defaultLoopProfile(2, "member"), LoopCatalogueError);
  // The proposed version carries no unrecovered-cost cap (ADR-0036 item 3).
  assert.equal(
    Object.hasOwn(policy.catalogue.versions[1].limits, "workspace_period_unrecovered_cost_cap_usd"),
    false,
  );
});

test("ADR-0027 item 12: worst-case turns of every entry", () => {
  for (const [model, effort, dollars] of [
    ["opus", "low", 0.42],
    ["opus", "medium", 0.56],
    ["opus", "high", 0.64],
    ["sonnet", "low", 0.21],
    ["sonnet", "medium", 0.28],
    ["sonnet", "high", 0.32],
    ["haiku", "low", 0.0105],
    ["haiku", "medium", 0.014],
    ["haiku", "high", 0.016],
  ])
    assert.equal(entry(model, effort).worstCaseTurnUsd12, usd(dollars), `${model} ${effort}`);
});

test("ADR-0027 item 12: the table of defaults: turn limits, holds, expected turns and runs", () => {
  const coordinator = entry("opus", "high");
  assert.equal(turnLimit(coordinator, "coordinator"), 6);
  const c = runHold({ entry: coordinator, kind: "coordinator", creditCapUsd12: null });
  assert.equal(c.ok && c.holdUsd12, usd(3.84));
  assert.equal(c.binding, "turn_limit");
  // Exact values; the ADR rounds them to US$0.13 (US$0.19 first) and US$0.46 for 3 turns.
  assert.equal(coordinator.expectedTurnUsd12, usd(0.1344));
  assert.equal(coordinator.expectedFirstTurnUsd12, usd(0.192));
  assert.equal(expectedRunUsd12(coordinator, 3), usd(0.4608));
  assert.equal(cents(expectedRunUsd12(coordinator, 3)), 0.46);

  const specialist = entry("opus", "medium");
  assert.equal(turnLimit(specialist, "specialist"), 12);
  for (const [price, hold, turns] of [
    ["149", 3.058225, 5],
    ["99", 2.031975, 3],
  ]) {
    const h = runHold({ entry: specialist, kind: "specialist", creditCapUsd12: capAt(price, 500) });
    assert.equal(h.ok && h.holdUsd12, usd(hold), price);
    assert.equal(h.binding, "credit_cap");
    assert.equal(h.turnLimit, 12, "its 12-turn limit binds only when turns cost less");
    assert.equal(h.worstCaseTurns, turns, price);
    assert.equal(h.toolTurnsRequired, 2);
  }
  // US$0.084 (US$0.14 first) and US$0.73 for 8 turns.
  assert.equal(specialist.expectedTurnUsd12, usd(0.0844));
  assert.equal(specialist.expectedFirstTurnUsd12, usd(0.142));
  assert.equal(expectedRunUsd12(specialist, 8), usd(0.7328));

  // ADR-0036: an installed agent's default is Opus 5.5 at medium. Its worst-case turn is
  // US$0.56, so the US$7 backstop lowers its 16-turn limit to 12 and it holds US$6.72; an
  // expected turn is US$0.084 (US$0.14 first) and six turns about US$0.56.
  const installed = entry("opus", "medium");
  assert.deepEqual(
    [installed.model, installed.effort],
    [defaultLoopProfile(2, "installed").model, defaultLoopProfile(2, "installed").effort],
  );
  assert.equal(turnLimit(installed, "routed"), 12);
  const i = runHold({ entry: installed, kind: "routed", creditCapUsd12: null });
  assert.equal(i.ok && i.holdUsd12, usd(6.72));
  assert.equal(i.binding, "turn_limit");
  assert.equal(expectedRunUsd12(installed, 6), usd(0.564));
  // Sonnet 5.5 at low, the default before ADR-0036 and still offered: US$3.36 held, US$0.030
  // (US$0.058 first) and US$0.21 for 6 turns.
  const sonnet = entry("sonnet", "low");
  assert.equal(turnLimit(sonnet, "routed"), 16);
  const s = runHold({ entry: sonnet, kind: "routed", creditCapUsd12: null });
  assert.equal(s.ok && s.holdUsd12, usd(3.36));
  assert.equal(sonnet.expectedTurnUsd12, usd(0.0304));
  assert.equal(sonnet.expectedFirstTurnUsd12, usd(0.058));
  assert.equal(expectedRunUsd12(sonnet, 6), usd(0.21));
});

test("other entries' turn limits under the US$7 backstop", () => {
  for (const [model, effort, limit] of [
    ["opus", "low", 16],
    ["opus", "high", 10],
    ["sonnet", "medium", 16],
    ["sonnet", "high", 16],
    ["haiku", "high", 16],
  ])
    assert.equal(turnLimit(entry(model, effort), "routed"), limit, `${model} ${effort}`);
  // The dearest turn fits US$7 ten times and US$25 thirty-nine times.
  assert.equal(usd(7) / usd(0.64), 10n);
  assert.equal(usd(25) / usd(0.64), 39n);
});

test("ADR-0026 item 4: credit caps under the margin rule at US$149 and US$99", () => {
  assert.equal(capAt("149", 500), usd(3.058225));
  assert.equal(capAt("99", 500), usd(2.031975));
  assert.equal(capAt("149", 100), usd(0.611645));
  assert.equal(capAt("99", 100), usd(0.406395));
  for (const bad of [
    { planPriceUsd: "149.999", capBasisPoints: 500 },
    { planPriceUsd: "149", capBasisPoints: 0 },
    { planPriceUsd: "149", capBasisPoints: 500, feeBasisPoints: 10_000 },
    { planPriceUsd: -1, capBasisPoints: 500 },
  ])
    assert.throws(() => creditCapUsd12(bad), LoopCatalogueError, JSON.stringify(bad));
});

test("ADR-0036 item 7: one look-for-work pass a day per agent, within US$1.12, at the installed default", () => {
  // OD-2026-10-25-2 Q2: the pass keeps Opus 5.5 at medium and its cap is two worst-case turns
  // at that default, in place of ADR-0026 item 4's 1% of the grant (US$0.61 at US$149, US$0.41
  // at US$99, which no Opus pass fits).
  assert.equal(lookForWorkDailyCapUsd12(2), usd(1.12));
  assert.equal(lookForWorkDailyCapUsd12(2), 2n * entry("opus", "medium").worstCaseTurnUsd12);
  for (const price of ["149", "99"]) assert.ok(capAt(price, 100) < usd(1.12), price);
  const { model: m, effort: e } = defaultLoopProfile(2, "installed");
  const pass = (selected, passesToday = 0) => lookForWorkHold({ entry: selected, passesToday });
  const first = pass(loopEntry(2, m, e));
  assert.deepEqual(first, {
    ok: true,
    turnLimit: 12,
    holdUsd12: usd(1.12),
    binding: "credit_cap",
    toolTurnsRequired: 2,
    worstCaseTurns: 2,
  });
  // A second pass the same day is refused, whatever its profile.
  for (const [model, effort] of [
    ["opus", "medium"],
    ["haiku", "low"],
  ])
    assert.deepEqual(pass(entry(model, effort), 1), { ok: false, code: "trigger_used" });
  // A costlier profile does not fit: Opus 5.5 at high needs US$1.28 for two turns.
  assert.deepEqual(pass(entry("opus", "high")), { ok: false, code: "cap_below_turn" });
  // Cheaper profiles fit, with more turns inside the same cap.
  for (const [model, effort, turns, binding] of [
    ["opus", "low", 2, "credit_cap"],
    ["sonnet", "high", 3, "credit_cap"],
    ["sonnet", "medium", 4, "credit_cap"],
    ["sonnet", "low", 5, "credit_cap"],
    ["haiku", "high", 16, "turn_limit"],
  ]) {
    const h = pass(entry(model, effort));
    assert.equal(h.ok, true, `${model} ${effort}`);
    assert.equal(h.worstCaseTurns, turns, `${model} ${effort}`);
    assert.equal(h.binding, binding, `${model} ${effort}`);
    assert.ok(h.holdUsd12 <= usd(1.12));
  }
  for (const bad of [-1, 0.5, "0", null])
    assert.throws(() => pass(entry("opus", "medium"), bad), LoopCatalogueError, String(bad));
  // Opus 5.5 at high fits a specialist's two turns at either price (its 5% cap is unchanged).
  for (const price of ["149", "99"])
    assert.equal(
      runHold({
        entry: entry("opus", "high"),
        kind: "specialist",
        creditCapUsd12: capAt(price, 500),
      }).ok,
      true,
    );
});

test("cap_below_turn: a person's run needs one worst-case turn, a tool-calling run two", () => {
  const opus = entry("opus", "high");
  assert.deepEqual(runHold({ entry: opus, kind: "routed", creditCapUsd12: usd(0.6) }), {
    ok: false,
    code: "cap_below_turn",
  });
  assert.equal(runHold({ entry: opus, kind: "routed", creditCapUsd12: usd(0.64) }).ok, true);
  assert.deepEqual(runHold({ entry: opus, kind: "mandate", creditCapUsd12: usd(1.0) }), {
    ok: false,
    code: "cap_below_turn",
  });
  assert.equal(runHold({ entry: opus, kind: "mandate", creditCapUsd12: usd(1.28) }).ok, true);
  assert.throws(
    () => runHold({ entry: opus, kind: "routed", creditCapUsd12: -1n }),
    LoopCatalogueError,
  );
});

test("ADR-0027 item 6: a turn starts only if the hold covers it, and is final when it cannot cover another", () => {
  const e = entry("opus", "medium");
  const turn = (turnsTaken, holdLeftUsd12, limit = 12) =>
    nextTurn({ entry: e, turnLimit: limit, turnsTaken, holdLeftUsd12 });
  assert.deepEqual(turn(0, usd(3.0)), { start: true, final: false, reason: null });
  assert.deepEqual(turn(4, usd(0.9)), { start: true, final: true, reason: "cost_budget" });
  assert.deepEqual(turn(5, usd(0.5)), { start: false, reason: "cost_budget" });
  assert.deepEqual(turn(11, usd(3.0)), { start: true, final: true, reason: "turn_limit" });
  assert.deepEqual(turn(12, usd(3.0)), { start: false, reason: "turn_limit" });
  assert.throws(() => turn(-1, usd(1)), LoopCatalogueError);
  assert.throws(() => turn(0, usd(1), 17), LoopCatalogueError);
});

test("the daily backstop counts settled cost, open holds and the new hold", () => {
  const fits = (settled, open, hold) =>
    fitsDailyBackstop({
      catalogueVersion: 2,
      settledUsd12: usd(settled),
      openHoldsUsd12: usd(open),
      holdUsd12: usd(hold),
    });
  assert.equal(fits(10, 11.16, 3.84), true);
  assert.equal(fits(10, 11.17, 3.84), false);
});

test("a hold record is RunHold@1 in numeric(20,8) text, rounded up", () => {
  const e = entry("opus", "medium");
  const hold = runHold({ entry: e, kind: "specialist", creditCapUsd12: capAt("149", 500) });
  const record = runHoldRecord(e, hold);
  assert.ok(validateCurrentDefinition("RunHold", record));
  assert.equal(record.holdUsd, "3.05822500");
  assert.equal(record.worstCaseTurnUsd, "0.56000000");
  assert.equal(usd12Text(1n, "up"), "0.00000001");
  assert.equal(usd12Text(1n, "down"), "0.00000000");
});

// The loop version's rule cases (the per-product cases are in tests/providers.test.mjs).
const v2 = (p) => p.catalogue.versions[1];
// Publishing version 2 as the owner's confirmation would: v1 untouched and still active.
const publishV2 = (p, { pointer = 2 } = {}) => {
  const entry = v2(p);
  entry.status = "active";
  entry.owner_confirmation = "synthetic owner confirmation";
  entry.effective_from = "2026-11-01";
  p.catalogue.active_versions.agent_loop = pointer;
  p.catalogue.published_digests["2"] = catalogueVersionDigest(entry);
};
for (const [name, change, expected] of [
  ["an xhigh effort", (p) => (v2(p).efforts[2].key = "xhigh"), /invalid loop effort xhigh/],
  [
    "a call budget over 600 s",
    (p) => (v2(p).efforts[2].max_output_tokens = 20000),
    /effort high: one call's budget exceeds 600 s/,
  ],
  [
    "a missing cache-read rate",
    (p) => delete v2(p).models[0].rates_usd_per_million_tokens.cache_read,
    /needs a rate for each token kind/,
  ],
  [
    "a cache write below the input rate",
    (p) => (v2(p).models[2].rates_usd_per_million_tokens.cache_write_5m = "3"),
    /cache rates out of order/,
  ],
  [
    "an input cap above Haiku's price tier",
    (p) => (v2(p).limits.max_input_tokens_per_turn = 150000),
    /loop limit max_input_tokens_per_turn|leaves its price tier/,
  ],
  ["a 17-turn run", (p) => (v2(p).limits.max_turns_per_run = 17), /loop limit max_turns_per_run/],
  [
    "a 45-minute wall time",
    (p) => (v2(p).limits.wall_time_minutes = 45),
    /loop limit wall_time_minutes/,
  ],
  [
    "a run backstop below two Opus high turns",
    (p) => (v2(p).limits.run_cost_cap_usd = "1"),
    /claude_opus_5_5 at high: two worst-case turns exceed the run backstop/,
  ],
  [
    "a default profile outside the version",
    (p) => (v2(p).default_profiles.coordinator.model = "gpt_6_1_sol"),
    /the coordinator default profile/,
  ],
  ["an unknown run shape", (p) => (v2(p).run_shape = "streaming_loop"), /unknown run shape/],
  [
    "an unrecovered-cost cap, which ADR-0036 removed",
    (p) => (v2(p).limits.workspace_period_unrecovered_cost_cap_usd = "4.50"),
    /model catalogue v2: carries an unrecovered-cost cap, which ADR-0036 removed/,
  ],
  [
    "a missing daily backstop",
    (p) => delete v2(p).limits.workspace_daily_cost_cap_usd,
    /model catalogue v2: missing USD caps/,
  ],
  [
    "a missing look-for-work cap (ADR-0036 item 7)",
    (p) => delete v2(p).limits.look_for_work_daily_cost_cap_usd,
    /model catalogue v2: missing USD caps/,
  ],
  [
    "a look-for-work cap below two worst-case turns of the installed default",
    (p) => (v2(p).limits.look_for_work_daily_cost_cap_usd = "1.11"),
    /model catalogue v2: the look-for-work cap cannot hold two worst-case turns of the installed default/,
  ],
  [
    "the 1% cap at US$149 with the installed default on Opus 5.5 medium",
    (p) => (v2(p).limits.look_for_work_daily_cost_cap_usd = "0.611645"),
    /the look-for-work cap cannot hold two worst-case turns of the installed default/,
  ],
  [
    "a look-for-work cap above the run backstop",
    (p) => (v2(p).limits.look_for_work_daily_cost_cap_usd = "7.01"),
    /model catalogue v2: the look-for-work cap is above the run cap/,
  ],
  [
    "an installed default on Opus 5.5 high under the US$1.12 cap",
    (p) => (v2(p).default_profiles.installed.effort = "high"),
    /the look-for-work cap cannot hold two worst-case turns of the installed default/,
  ],
  [
    "a fallback sent with the loop's requests",
    (p) => p.loop_request.sent.push("fallbacks"),
    /the loop's sent and never-sent fields drifted/,
  ],
  [
    "a streamed loop request",
    (p) => (p.loop_request.stream = true),
    /the loop's sent and never-sent fields drifted/,
  ],
  [
    "forced tool use",
    (p) => (p.loop_request.tool_choice.default = "any"),
    /the loop's sent and never-sent fields drifted/,
  ],
  [
    "a published version 2 without the owner's confirmation",
    (p) => {
      v2(p).status = "active";
      p.catalogue.active_versions.agent_loop = 2;
    },
    /version 2 is published without the owner's confirmation/,
  ],
  [
    "an active loop version without its shape's pointer",
    (p) => publishV2(p, { pointer: null }),
    /active_versions\.agent_loop does not name its active version/,
  ],
  [
    "the per-product pointer naming the loop version",
    (p) => {
      publishV2(p);
      p.catalogue.active_versions.per_product = 2;
    },
    /active_versions\.per_product does not name its active version/,
  ],
  [
    "a second active loop version",
    (p) => {
      publishV2(p);
      const v4 = structuredClone(v2(p));
      v4.version = 4;
      p.catalogue.versions.push(v4);
      p.catalogue.published_digests["4"] = catalogueVersionDigest(v4);
    },
    /agent_loop statuses must run retired, then at most one active, then proposed/,
  ],
  [
    "the old single active_version",
    (p) => (p.catalogue.active_version = 1),
    /active_version is replaced by active_versions/,
  ],
  [
    "active_versions without the loop shape",
    (p) => delete p.catalogue.active_versions.agent_loop,
    /active_versions must name exactly per_product and agent_loop/,
  ],
  [
    "a pointer that is not a version number",
    (p) => (p.catalogue.active_versions.agent_loop = "2"),
    /active_versions\.agent_loop must be a version number or null/,
  ],
])
  test(`model catalogue v2 rejects ${name}`, () => {
    const p = structuredClone(policy);
    change(p);
    assert.match(inspectModelPolicy(p, registry).errors.join("\n"), expected);
  });

test("the committed policy, with version 2 proposed, passes", () =>
  assert.deepEqual(inspectModelPolicy(policy, registry).errors, []));

// ADR-0027 item 4 and the brief: version 2 publishes while the per-product version (3 since
// ADR-0036) stays active for listings-run@1. Each shape's generated module takes its own pointer.
test("publishing loop version 2 keeps version 3 active for listings-run@1", () => {
  const p = structuredClone(policy);
  publishV2(p);
  assert.equal(p.catalogue.versions[2].status, "active");
  assert.deepEqual(inspectModelPolicy(p, registry).errors, []);
  const perProduct = modelCatalogueData(p, registry);
  assert.equal(perProduct.activeVersion, 3);
  assert.deepEqual(
    perProduct.versions.map((v) => [v.version, v.status]),
    [
      [1, "retired"],
      [3, "active"],
    ],
  );
  const loop = loopCatalogueData(p, registry);
  assert.equal(loop.activeVersion, 2);
  assert.deepEqual(
    loop.versions.map((v) => [v.version, v.status]),
    [[2, "active"]],
  );
  // Retiring version 3 later leaves the loop's pointer alone.
  p.catalogue.versions[2].status = "retired";
  p.catalogue.active_versions.per_product = null;
  assert.deepEqual(inspectModelPolicy(p, registry).errors, []);
  assert.equal(modelCatalogueData(p, registry).activeVersion, null);
  assert.equal(loopCatalogueData(p, registry).activeVersion, 2);
});

test("the committed modules take each shape's own pointer: the loop's is null", () => {
  assert.equal(modelCatalogueData(policy, registry).activeVersion, 3);
  const loop = loopCatalogueData(policy, registry);
  assert.equal(loop.activeVersion, null);
  assert.ok(
    loop.versions.every((v) => v.version !== 1 && v.version !== 3),
    "versions 1 and 3 are per-product versions, not loop versions",
  );
});
