// ADR-0036 (OD-2026-10-25-1, OD-2026-10-25-2): Opus 5.5 by default for every agent, no
// unrecovered-cost cap, the member ceiling of 4 and the look-for-work cap of US$1.12 a day.
// ADR-0039 (OD-2026-10-25-4) later removed the look-for-work cap and the US$7 and US$25
// backstops (catalogue version 4, migration 0053; tests/credits-only.test.mjs); the cases
// below keep ADR-0036's records and say what ADR-0039 changed. Pure: no I/O beyond reading
// the repository files. lab:run-credits (C4, C12) and lab:listings-runs (M1, U1) prove
// migration 0051 on PostgreSQL 17.
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
import * as loopCatalogue from "../packages/policy/src/loop-catalogue.ts";
import {
  defaultLoopProfile,
  loopEntries,
  loopEntry,
  runHold,
  turnLimit,
} from "../packages/policy/src/loop-catalogue.ts";
import * as runCredits from "../packages/policy/src/run-credits.ts";
import {
  failureBreaker,
  parseUsd8,
  reservationSize,
  usd8Text,
} from "../packages/policy/src/run-credits.ts";

const read = (path) => readFileSync(path, "utf8");
const policy = JSON.parse(read("docs/decisions/model-policy.json"));
const registry = JSON.parse(read("docs/decisions/providers.json"));
const manifest = JSON.parse(read("migrations/manifest.json"));
const file = "0051.model-defaults-cost-cap.sql";
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
  assert.match(
    adr,
    /^- Status: Accepted 2026-10-25 \(the owner, OD-2026-10-25-1 and OD-2026-10-25-2\)/m,
  );
  const approval = adr.slice(adr.indexOf("## Approval"));
  assert.ok(approval.includes("> " + quote));
  assert.ok(policy.catalogue.versions[2].owner_confirmation.includes(quote));
});

// OD-2026-10-25-2: the owner's answers to the three questions the lead put after
// OD-2026-10-25-1, each the question as put and the option chosen, verbatim.
const answers = [
  'Q1: "With Listings on Opus 5.5 medium, each product it drafts costs 4 credits instead of 1 (your 300 test credits = about 75 products). Who in a shop may run it at that default?" Answer: "Everyone, up to 4 (Recommended)"',
  'Q2: "Each agent\'s daily \'look for useful work\' pass (read-only, proposes nothing) has a cost cap of about 1% of the plan price. One Opus 5.5 medium pass costs more than that cap, so these passes would never run. What should they use?" Answer: "Opus medium, raise the cap" (the option said: keep Opus 5.5 medium even for the daily check and raise its cap to fit, about US$1.12 per agent per day worst case)',
  'Q3: "With the unbilled-AI-cost cap removed, the remaining safety limits are US$7 per run and US$25 per workspace per day, plus your Anthropic monthly limit. Keep those two?" Answer: "Keep US$7 / US$25 (Recommended)"',
];

test("OD-2026-10-25-2 is recorded verbatim in its node and in ADR-0036's Approval", () => {
  const decision = read("docs/graph/decisions/OD-2026-10-25-2.md");
  assert.match(decision, /^by: owner$/m);
  assert.match(decision, /^channel: chat$/m);
  assert.match(decision, /^ {2}answers: \[Q-adr-0036-member-ceiling\]$/m);
  const adr = read("docs/decisions/adr/ADR-0036-model-defaults-and-cost-cap.md");
  const approval = adr.slice(adr.indexOf("## Approval"));
  for (const answer of answers) {
    assert.ok(decision.includes("> " + answer + "\n"), answer.slice(0, 3));
    assert.ok(approval.includes("> " + answer + "\n"), answer.slice(0, 3));
  }
  assert.match(
    adr,
    /^- Status: Accepted 2026-10-25 \(the owner, OD-2026-10-25-1 and OD-2026-10-25-2\)\.$/m,
  );
});

// Review F1, answered: the owner confirmed version 3's default member ceiling of 4 (Q1). Every
// record says so; none still says it awaits the owner, and the merge gate is gone.
test("version 3's default member ceiling of 4 is owner-confirmed (OD-2026-10-25-2, Q1)", () => {
  const v3 = policy.catalogue.versions[2];
  assert.equal(v3.default_member_credit_ceiling, 4);
  assert.equal(defaultMemberCreditCeiling(), 4);
  assert.ok(v3.owner_confirmation.includes("(OD-2026-10-25-2)"));
  assert.ok(v3.owner_confirmation.includes(answers[0].slice(5, answers[0].indexOf('" Answer:'))));
  assert.ok(v3.owner_confirmation.includes('answered "Everyone, up to 4 (Recommended)"'));
  assert.doesNotMatch(v3.owner_confirmation, /Not confirmed|await/);
  // The confirmation changed version 3's digest; the pin, the generated catalogue and
  // migration 0051's seed follow it.
  assert.equal(
    policy.catalogue.published_digests["3"],
    "f1f15d4f3b952234693f15aee1943e937f8c421ab1f4809e73345469c616d6c0",
  );
  const adr = read("docs/decisions/adr/ADR-0036-model-defaults-and-cost-cap.md");
  const approval = adr.slice(adr.indexOf("## Approval"));
  assert.ok(approval.includes("Q1, item 2's default member ceiling of 4"));
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
  assert.match(question, /^status: answered$/m);
  assert.ok(question.includes("(OD-2026-10-25-2, Q1)"));
  const brief = read("docs/briefs/adr-0036-model-defaults-cost-cap.md");
  assert.ok(brief.includes("- [x] Owner: confirm the default member ceiling of 4"));
  assert.doesNotMatch(brief, /^- \*\*Merge gate:\*\* /m);
  // No record still says the ceiling awaits the owner.
  for (const path of [
    "docs/decisions/adr/ADR-0036-model-defaults-and-cost-cap.md",
    "docs/decisions/adr/ADR-0022-mvp-contracts.md",
    "docs/decisions/adr/README.md",
    "docs/decisions/model-selection.md",
    "docs/briefs/mvp-architecture.md",
    "docs/briefs/adr-0036-model-defaults-cost-cap.md",
    "docs/graph/branches/claude--adr-0036-model-defaults-cost-cap.md",
  ])
    assert.doesNotMatch(
      read(path),
      /(ceiling|value)[^.]*await|await[^.]*ceiling|stays unmerged until the owner/i,
      path,
    );
});

// OD-2026-10-25-2 Q2 (ADR-0036 item 7) set the daily look-for-work cap to US$1.12 per agent,
// two worst-case turns at the installed default. ADR-0039 item 1 removed it with every other
// money cap: one pass per agent a day stays (a count, not money), and the pass holds and
// draws credits like any run (ADR-0039 PR 2 and 3).
test("the look-for-work cap of US$1.12 is recorded by ADR-0036 and removed by ADR-0039", () => {
  const v2 = policy.catalogue.versions[1];
  assert.equal(Object.hasOwn(v2.limits, "look_for_work_daily_cost_cap_usd"), false);
  const generated = generatedLoopCatalogue.versions.find((v) => v.version === 2);
  assert.equal(Object.hasOwn(generated.limits, "lookForWorkDailyCostCapUsd12"), false);
  for (const name of ["lookForWorkHold", "lookForWorkDailyCapUsd12"])
    assert.equal(Object.hasOwn(loopCatalogue, name), false, name);
  // The installed default is still Opus 5.5 at medium (ADR-0036), whose two worst-case turns
  // were the US$1.12.
  const installed = defaultLoopProfile(2, "installed");
  const entry = loopEntry(2, installed.model, installed.effort);
  assert.deepEqual([entry.model, entry.effort], ["claude_opus_5_5", "medium"]);
  assert.equal(2n * entry.worstCaseTurnUsd12, usd12(1.12));
  // The records: ADR-0036 item 7 and ADR-0026's and ADR-0027's dated notes are kept.
  const adr = read("docs/decisions/adr/ADR-0036-model-defaults-and-cost-cap.md");
  assert.match(
    adr,
    /^7\. \*\*The look-for-work cap: US\$1\.12 per agent per day\*\* \(OD-2026-10-25-2;/m,
  );
  assert.ok(
    read("docs/decisions/adr/ADR-0026-billing-and-price.md").includes(
      "### 2026-10-25: item 4's look-for-work cap becomes US$1.12 per agent per day (ADR-0036 item 7)",
    ),
  );
  assert.ok(
    read("docs/decisions/adr/ADR-0027-agent-loop-and-model.md").includes(
      "### 2026-10-25: item 12's look-for-work hold (ADR-0036 item 7)",
    ),
  );
});

// OD-2026-10-25-2 Q3 kept the per-run US$7 and per-day US$25 backstops; OD-2026-10-25-4
// (ADR-0039) removed them. Versions 1 and 3 keep the values they were published with, which
// nothing enforces once version 4 is active.
test("the US$7 and US$25 backstops: reconfirmed by ADR-0036, removed by ADR-0039", () => {
  for (const index of [0, 2]) {
    const { version, limits } = policy.catalogue.versions[index];
    assert.equal(limits.run_cost_cap_usd, "7", `v${version}`);
    assert.equal(limits.workspace_daily_cost_cap_usd, "25", `v${version}`);
  }
  for (const index of [1, 3]) {
    const { version, limits } = policy.catalogue.versions[index];
    assert.equal(Object.hasOwn(limits, "run_cost_cap_usd"), false, `v${version}`);
    assert.equal(Object.hasOwn(limits, "workspace_daily_cost_cap_usd"), false, `v${version}`);
  }
  assert.equal(catalogueLimits(4).runCostCapUsd8, null);
  assert.equal(catalogueLimits(4).workspaceDailyCostCapUsd8, null);
  assert.equal(Object.hasOwn(runCredits, "dailyCapAllows"), false);
  assert.equal(Object.hasOwn(loopCatalogue, "fitsDailyBackstop"), false);
  // ADR-0036's own record of the owner's answer is unchanged.
  const adr = read("docs/decisions/adr/ADR-0036-model-defaults-and-cost-cap.md");
  assert.ok(
    adr.includes(
      "4. **What stays.** The per-run US$7 and per-day US$25 backstops, which the owner reconfirmed with the cap removed (OD-2026-10-25-2);",
    ),
  );
  assert.ok(adr.includes("Q3, item 4's per-run US$7 and per-day US$25 backstops, kept unchanged."));
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
  // Listings' per-product runs: catalogue version 3's default and its member ceiling, which
  // version 4 keeps (ADR-0039 removed only its caps).
  assert.equal(activeCatalogueVersion(), 4);
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

test("version 3's published run limits stay for its runs; version 4 and the loop have no money cap", () => {
  // A run recorded at version 3 keeps version 3's limits: twelve products at the default
  // (US$6.528), not thirteen.
  const opusMedium3 = catalogueEntry(3, "claude_opus_5_5", "medium");
  const twelve = reservationSize(opusMedium3, 12);
  assert.equal(twelve.ok, true);
  assert.equal(usd8Text(twelve.reservation.vendorMaximumUsd8), "6.52800000");
  assert.equal(twelve.reservation.credits, 48n);
  assert.deepEqual(reservationSize(opusMedium3, 13), { ok: false, code: "run_product_limit" });
  // ADR-0039 item 4: at version 4 the default admits 25 products, 100 credits held up front.
  const opusMedium4 = catalogueEntry(4, "claude_opus_5_5", "medium");
  const all = reservationSize(opusMedium4, 25);
  assert.equal(all.ok && all.reservation.credits, 100n);
  assert.equal(usd8Text(all.reservation.vendorMaximumUsd8), "13.60000000");
  assert.deepEqual(reservationSize(opusMedium4, 26), { ok: false, code: "run_product_limit" });
  // Three consecutive failed products still stop a run.
  let state = { consecutiveFailed: 0, stop: false };
  for (let i = 0; i < 3; i++)
    state = failureBreaker(catalogueLimits(4), state.consecutiveFailed, "failed");
  assert.deepEqual(state, { consecutiveFailed: 3, stop: true });
  // Loop runs: no backstop lowers a turn limit; the installed default keeps its 16 turns,
  // US$8.96 at worst (ADR-0039's Consequences).
  for (const entry of loopEntries(2)) assert.equal(turnLimit(entry, "routed"), 16);
  const installed = defaultLoopProfile(2, "installed");
  const entry = loopEntry(2, installed.model, installed.effort);
  const hold = runHold({ entry, kind: "routed", creditCapUsd12: null });
  assert.equal(hold.ok && hold.holdUsd12, usd12(8.96));
});

test("migration 0051 seeds catalogue version 3 exactly as the generated catalogue holds it", () => {
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

test("migration 0051: a forward work-owner migration that retires version 1 in place", () => {
  const row = manifest.migrations.find((m) => m.file === file);
  // Row 51, after main's 0048-0050 (#71's webhook registrations, #67's catalog-undo), which
  // read nothing this migration changes.
  assert.equal(row.sequence, 51);
  const undo = manifest.migrations.find((m) => m.file.endsWith(".catalog-undo.sql"));
  assert.ok(undo.sequence < row.sequence);
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
  // Its callers are not redefined here: 0038's run_reserve and run_product_begin refuse at the
  // run limit (and, until migration 0053 removed it under ADR-0039, the daily cap), and stop
  // at the breaker and an exhausted hold.
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
