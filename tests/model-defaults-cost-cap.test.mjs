// ADR-0036 (OD-2026-10-25-1): Opus 5.5 by default for every agent, and no unrecovered-cost
// cap. Pure: no I/O beyond reading the repository files. lab:run-credits (C4, C12) and
// lab:listings-runs (M1, U1) prove migration 0048 on PostgreSQL 17.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectModelPolicy } from "../scripts/provider-checks.mjs";
import { generatedLoopCatalogue } from "../packages/policy/src/generated/loop-catalogue.ts";
import { generatedModelCatalogue } from "../packages/policy/src/generated/model-catalogue.ts";
import {
  activeCatalogueVersion,
  catalogueEntry,
  catalogueLimits,
  defaultMemberCreditCeiling,
  defaultSelection,
  resolveSelection,
} from "../packages/policy/src/model-catalogue.ts";
import {
  defaultLoopProfile,
  fitsDailyBackstop,
  loopEntries,
  loopEntry,
  runHold,
  turnLimit,
} from "../packages/policy/src/loop-catalogue.ts";
import {
  dailyCapAllows,
  failureBreaker,
  parseUsd8,
  reservationSize,
  usd8Text,
} from "../packages/policy/src/run-credits.ts";

const read = (path) => readFileSync(path, "utf8");
const policy = JSON.parse(read("docs/decisions/model-policy.json"));
const registry = JSON.parse(read("docs/decisions/providers.json"));
const manifest = JSON.parse(read("migrations/manifest.json"));
const file = "0048.model-defaults-cost-cap.sql";
const sql = read("migrations/" + file);
const credits = read("migrations/0033.run-credits.sql");
const runs = read("migrations/0038.listings-runs.sql");
const quote =
  "use opus 5.5 high for the main agent and opus 5.5 medium for all type of subagents/specialists etc. and you can remove the cap on ai cost";
const usd12 = (dollars) => BigInt(Math.round(dollars * 1e6)) * 1_000_000n;
/** The body between the dollar quotes of one function definition in a migration. */
const body = (text, header) => {
  const at = text.indexOf(header);
  assert.ok(at >= 0, header);
  const open = text.indexOf("$$", at) + 2;
  return text.slice(open, text.indexOf("$$", open));
};
/** One VALUES list of an INSERT, as rows of trimmed SQL literals. */
const rows = (insert) => {
  const at = sql.indexOf(insert);
  assert.ok(at >= 0, insert);
  const values = sql.slice(sql.indexOf("VALUES", at) + 6, sql.indexOf(";", at));
  return [...values.matchAll(/\(([^()]*)\)/g)].map((m) =>
    m[1].split(",").map((v) => v.trim().replace(/^'(.*)'$/, "$1")),
  );
};

test("the decision is recorded: the owner's words, verbatim, in the decision node and ADR-0036", () => {
  const decision = read("docs/graph/decisions/OD-2026-10-25-1.md");
  assert.ok(decision.includes("> " + quote));
  const adr = read("docs/decisions/adr/ADR-0036-model-defaults-and-cost-cap.md");
  assert.match(adr, /^- Status: Accepted 2026-10-25 \(the owner, OD-2026-10-25-1\)/m);
  const approval = adr.slice(adr.indexOf("## Approval"));
  assert.ok(approval.includes("> " + quote));
  assert.ok(policy.catalogue.versions[2].owner_confirmation.includes(quote));
});

// Review F1: the owner's answer set the default and removed the cap; it did not set the default
// member ceiling. Version 3's ceiling of 4 widens what a Member without
// governance.model_default.revise may run (authority and money), so every record says it awaits
// the owner, and the branch stays unmerged until then. When the owner answers, this test changes
// with the records: the answer quoted in ADR-0036's Approval and in version 3's
// owner_confirmation (a new digest), the question answered and the brief's item ticked.
test("version 3's default member ceiling of 4 is recorded as awaiting the owner, never as confirmed", () => {
  const v3 = policy.catalogue.versions[2];
  assert.equal(v3.default_member_credit_ceiling, 4);
  assert.ok(
    v3.owner_confirmation.includes("Not confirmed by that answer: the default member ceiling of 4"),
  );
  assert.ok(v3.owner_confirmation.includes("awaits the owner's confirmation"));
  // The wording the review found: the ceiling folded into the owner's confirmation.
  assert.doesNotMatch(v3.owner_confirmation, /ceiling of 4 admits that default/);
  const adr = read("docs/decisions/adr/ADR-0036-model-defaults-and-cost-cap.md");
  assert.match(
    adr,
    /^- Status: Accepted 2026-10-25 \(the owner, OD-2026-10-25-1\), except item 2's default member ceiling of 4, which awaits the owner's confirmation \(Q-adr-0036-member-ceiling\); the change does not merge before it/m,
  );
  const approval = adr.slice(adr.indexOf("## Approval"));
  assert.ok(approval.includes("so it awaits the owner's confirmation"));
  assert.ok(approval.includes("so the change waits for the owner"));
  // The widening, stated with the catalogue's own numbers: 12 products at Opus 5.5 medium
  // (4 credits, US$0.544 worst case each) against 25 at a 1-credit entry (US$0.132).
  const opusMedium = catalogueEntry(3, "claude_opus_5_5", "medium");
  const sonnetHigh = catalogueEntry(3, "claude_sonnet_5_5", "high");
  const sonnetLow = catalogueEntry(3, "claude_sonnet_5_5", "low");
  const run = (entry) => [
    entry.creditsPerProduct * entry.runProductLimit,
    usd8Text(entry.worstCasePerProductUsd8 * BigInt(entry.runProductLimit)),
  ];
  assert.deepEqual(run(opusMedium), [48, usd8Text(parseUsd8("6.528"))]);
  assert.equal(run(sonnetHigh)[0], 57);
  assert.deepEqual(run(sonnetLow), [25, usd8Text(parseUsd8("3.30"))]);
  assert.ok(approval.includes("up to 48 credits and US$6.528"));
  assert.ok(approval.includes("57 credits at Sonnet 5.5 `high`"));
  assert.ok(approval.includes("at most 25 credits and US$3.30 a run"));
  const question = read("docs/graph/questions/Q-adr-0036-member-ceiling.md");
  assert.match(question, /^status: open$/m);
  assert.match(question, /^asked_of: owner$/m);
  assert.match(question, /default member ceiling of 4/);
  assert.ok(
    read("docs/graph/decisions/OD-2026-10-25-1.md").includes("(Q-adr-0036-member-ceiling)"),
  );
  const brief = read("docs/briefs/adr-0036-model-defaults-cost-cap.md");
  assert.ok(brief.includes("- [ ] Owner: confirm the default member ceiling of 4"));
  assert.match(brief, /^- \*\*Merge gate:\*\* /m);
});

// Review F3: the CI job description no longer says lab:run-credits checks an unrecovered-cost
// cap; C4 proves the ledger with no cap.
test("ci.md describes lab:run-credits' unrecovered-cost ledger without a cap", () => {
  const ci = read("docs/development/ci.md");
  assert.doesNotMatch(ci, /unrecovered-cost caps/);
  assert.ok(ci.includes("the unrecovered-cost ledger with no cap (ADR-0036;"));
  assert.ok(read("scripts/run-credits-lab.mjs").includes('"C4:unrecovered_ledger_without_cap"'));
});

test("defaults: Morrow on Opus 5.5 at high, every other kind on Opus 5.5 at medium", () => {
  assert.deepEqual(defaultLoopProfile(2, "coordinator"), {
    model: "claude_opus_5_5",
    effort: "high",
  });
  for (const kind of ["specialist", "installed"])
    assert.deepEqual(
      defaultLoopProfile(2, kind),
      { model: "claude_opus_5_5", effort: "medium" },
      kind,
    );
  // Listings' per-product runs: catalogue version 3's default and its member ceiling.
  assert.equal(activeCatalogueVersion(), 3);
  assert.deepEqual(defaultSelection(), { model: "claude_opus_5_5", effort: "medium" });
  assert.equal(defaultMemberCreditCeiling(), 4);
  const member = resolveSelection({
    selection: null,
    workspaceDefault: null,
    ceiling: defaultMemberCreditCeiling(),
    holdsRevise: false,
  });
  assert.equal(member.ok, true);
  assert.deepEqual(
    [member.entry.model, member.entry.effort, member.entry.creditsPerProduct],
    ["claude_opus_5_5", "medium", 4],
  );
  // Every model and effort stays on offer, so the shop still chooses (ADR-0027 item 12).
  assert.equal(loopEntries(2).length, 9);
  for (const model of ["claude_haiku_5_5", "claude_sonnet_5_5", "claude_opus_5_5"])
    for (const effort of ["low", "medium", "high"])
      assert.ok(catalogueEntry(3, model, effort), `${model} ${effort}`);
});

test("no unrecovered-cost cap in the policy or the generated catalogues", () => {
  assert.deepEqual(inspectModelPolicy(policy, registry).errors, []);
  for (const entry of policy.catalogue.versions)
    assert.equal(
      Object.hasOwn(entry.limits, "workspace_period_unrecovered_cost_cap_usd"),
      entry.version === 1,
      `v${entry.version}: only version 1 keeps its published value`,
    );
  for (const generated of [generatedModelCatalogue, generatedLoopCatalogue])
    assert.doesNotMatch(JSON.stringify(generated), /nrecovered/);
  // A cap on any later version fails verify, per-product or loop.
  for (const index of [1, 2]) {
    const p = structuredClone(policy);
    p.catalogue.versions[index].limits.workspace_period_unrecovered_cost_cap_usd = "4.50";
    assert.match(
      inspectModelPolicy(p, registry).errors.join("\n"),
      /carries an unrecovered-cost cap, which ADR-0036 removed/,
    );
  }
});

test("the per-run and per-day backstops and the breaker still refuse (TypeScript twins)", () => {
  const limits = catalogueLimits(3);
  const opusMedium = catalogueEntry(3, "claude_opus_5_5", "medium");
  // US$7 a run: twelve products at the default (US$6.528), not thirteen.
  const twelve = reservationSize(opusMedium, 12);
  assert.equal(twelve.ok, true);
  assert.equal(usd8Text(twelve.reservation.vendorMaximumUsd8), "6.52800000");
  assert.equal(twelve.reservation.credits, 48n);
  assert.deepEqual(reservationSize(opusMedium, 13), { ok: false, code: "run_product_limit" });
  // US$25 a day: settled cost plus open reservations plus this one.
  assert.equal(dailyCapAllows(limits, parseUsd8("18.472"), 0n, parseUsd8("6.528")), true);
  assert.equal(dailyCapAllows(limits, parseUsd8("18.473"), 0n, parseUsd8("6.528")), false);
  // Three consecutive failed products stop a run.
  let state = { consecutiveFailed: 0, stop: false };
  for (let i = 0; i < 3; i++) state = failureBreaker(limits, state.consecutiveFailed, "failed");
  assert.deepEqual(state, { consecutiveFailed: 3, stop: true });
  // Loop runs: every entry's hold fits US$7, and the installed default holds US$6.72 over 12
  // turns; the daily backstop still refuses past US$25.
  for (const entry of loopEntries(2)) {
    const hold = runHold({ entry, kind: "routed", creditCapUsd12: null });
    assert.ok(hold.ok && hold.holdUsd12 <= usd12(7), `${entry.model} ${entry.effort}`);
  }
  const installed = defaultLoopProfile(2, "installed");
  const entry = loopEntry(2, installed.model, installed.effort);
  assert.equal(turnLimit(entry, "routed"), 12);
  const hold = runHold({ entry, kind: "routed", creditCapUsd12: null });
  assert.equal(hold.ok && hold.holdUsd12, usd12(6.72));
  const day = (settled) =>
    fitsDailyBackstop({
      catalogueVersion: 2,
      settledUsd12: usd12(settled),
      openHoldsUsd12: 0n,
      holdUsd12: usd12(6.72),
    });
  assert.equal(day(18.28), true);
  assert.equal(day(18.29), false);
});

test("migration 0048 seeds catalogue version 3 exactly as the generated catalogue holds it", () => {
  const v3 = generatedModelCatalogue.versions.find((v) => v.version === 3);
  const [version] = rows("INSERT INTO morrow_work.model_catalogue_versions(");
  assert.deepEqual(version, [
    "3",
    "active",
    policy.catalogue.published_digests["3"],
    v3.defaultSelection.model,
    v3.defaultSelection.effort,
    String(v3.defaultMemberCreditCeiling),
    String(v3.limits.maxProductsPerRun),
    usd8Text(BigInt(v3.limits.runCostCapUsd8)),
    usd8Text(BigInt(v3.limits.workspaceDailyCostCapUsd8)),
    "NULL",
  ]);
  assert.equal(v3.digest, policy.catalogue.published_digests["3"]);
  const entries = rows("INSERT INTO morrow_work.model_catalogue_entries(");
  assert.equal(entries.length, 9);
  for (const [v, model, effort, perProduct, worst, attempt, limit] of entries) {
    const e = catalogueEntry(3, model, effort);
    assert.deepEqual(
      [v, perProduct, worst, attempt, limit],
      [
        "3",
        String(e.creditsPerProduct),
        usd8Text(e.worstCasePerProductUsd8),
        usd8Text(e.worstCasePerAttemptUsd8),
        String(e.runProductLimit),
      ],
      `${model} ${effort}`,
    );
  }
  const rates = rows("INSERT INTO morrow_work.model_catalogue_rates(");
  assert.deepEqual(
    rates,
    v3.models.map((m) => [
      "3",
      m.key,
      m.provider,
      m.providerModelId,
      String(m.inputUsd8PerToken),
      String(m.outputUsd8PerToken),
      String(v3.limits.maxInputTokensPerCall),
    ]),
  );
});

test("migration 0048: a forward work-owner migration that retires version 1 in place", () => {
  const row = manifest.migrations.find((m) => m.file === file);
  assert.equal(row.executeAs, "morrow_work_owner");
  assert.equal(row.sha256, createHash("sha256").update(sql).digest("hex"));
  assert.equal(row.reviewRef, "docs/briefs/adr-0036-model-defaults-cost-cap.md");
  assert.match(sql, /current_user<>'morrow_work_owner'/);
  // Version 1 keeps its cap and no other version may hold one.
  assert.match(
    sql,
    /ALTER COLUMN workspace_period_unrecovered_cost_cap_usd DROP NOT NULL,\n ADD CONSTRAINT model_catalogue_versions_unrecovered_cap CHECK \(\(workspace_period_unrecovered_cost_cap_usd IS NOT NULL\)=\(version=1\)\);/,
  );
  // The append-only trigger is lifted for exactly one status change and restored after it.
  const off = sql.indexOf(
    "ALTER TABLE morrow_work.model_catalogue_versions DISABLE TRIGGER append_only;",
  );
  const update = sql.indexOf(
    "UPDATE morrow_work.model_catalogue_versions SET status='retired' WHERE version=1 AND status='active';",
  );
  const on = sql.indexOf(
    "ALTER TABLE morrow_work.model_catalogue_versions ENABLE TRIGGER append_only;",
  );
  assert.ok(off > 0 && off < update && update < on, "disable, retire, enable");
  assert.equal(sql.match(/DISABLE TRIGGER/g).length, 1);
  assert.equal(sql.match(/\bUPDATE\b/g).length, 1);
  assert.doesNotMatch(
    sql,
    /\bDELETE\b|\bDROP (TABLE|FUNCTION|TRIGGER)\b|SECURITY DEFINER|OWNER TO|GRANT |REVOKE /,
  );
});

test("unrecovered_allows is revised from its pinned 0033 body to compare with no cap", () => {
  const header =
    "FUNCTION morrow_billing.unrecovered_allows(p_org text,p_ws text,p_period_start timestamptz,p_catalogue_version integer,p_worst_case_usd numeric)";
  const before = body(credits, "CREATE " + header);
  const pinned = /IS DISTINCT FROM '([a-f0-9]{32})'/.exec(sql)[1];
  assert.equal(createHash("md5").update(before).digest("hex"), pinned);
  assert.match(before, /workspace_period_unrecovered_cost_cap_usd/);
  const after = body(sql, "CREATE OR REPLACE " + header);
  // Same signature, language and INVOKER security; no cap and no read of the ledger.
  const definition = sql.slice(sql.indexOf("CREATE OR REPLACE " + header));
  assert.match(
    definition,
    /^CREATE OR REPLACE FUNCTION [^\n]+\nRETURNS boolean\nLANGUAGE sql STABLE SET search_path=pg_catalog,morrow_billing,pg_temp AS \$\$/,
  );
  assert.doesNotMatch(after, /unrecovered_cost_cap|unrecovered_costs|amount_usd/);
  // Every other check stays: a known version, a billing period, a non-negative worst case,
  // false otherwise.
  assert.match(after, /COALESCE\(\(SELECT true FROM morrow_work\.model_catalogue_versions v/);
  assert.match(after, /v\.version=p_catalogue_version/);
  assert.match(after, /p_period_start IS NOT NULL AND p_worst_case_usd>=0\),false\)/);
  // Its callers are not redefined: 0038's run_reserve and run_product_begin still refuse at
  // the run limit and the daily cap, and still stop at the breaker and an exhausted hold.
  for (const name of ["run_reserve", "run_product_begin", "cmd_run_admit"])
    assert.doesNotMatch(sql, new RegExp(`FUNCTION [a-z_]+\\.${name}\\(`), name);
  const reserve = body(runs, "CREATE OR REPLACE FUNCTION morrow_billing.run_reserve(");
  for (const refusal of ["'run_product_limit'", "'daily_cap'", "'insufficient_credits'"])
    assert.ok(reserve.includes(refusal), refusal);
  const begin = body(runs, "CREATE FUNCTION morrow_work.run_product_begin(");
  for (const stop of ["'breaker'", "'reservation_exhausted'", "'cost_overflow'"])
    assert.ok(begin.includes(stop), stop);
  assert.ok(reserve.includes("morrow_billing.unrecovered_allows("));
  assert.ok(begin.includes("morrow_billing.unrecovered_allows("));
});
