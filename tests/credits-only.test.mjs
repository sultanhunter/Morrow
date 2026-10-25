// ADR-0039 (OD-2026-10-25-4): credits are the only spend limit. Implementation plan PR 1 (the
// listings and the catalogue, credits only) with PR 4's removal of the runtime budget:
// catalogue version 4 with no run or daily cap and 25 products a run for every entry,
// version 3 retired, run_reserve without the daily cap, runtime_caps() and
// runtime_operation_begin without the monthly budget (migration 0052), and verify refusing a
// money cap on any later per-product version and on any loop version. Pure: no I/O beyond
// reading the repository files. lab:run-credits (C3, C12, C13), lab:listings-runs (B4, C1) and
// lab:runtime-operations (K2) prove migration 0052 on PostgreSQL 17.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { catalogueVersionDigest, inspectModelPolicy } from "../scripts/provider-checks.mjs";
import { generatedModelCatalogue } from "../packages/policy/src/generated/model-catalogue.ts";
import { generatedLoopCatalogue } from "../packages/policy/src/generated/loop-catalogue.ts";
import {
  activeCatalogueVersion,
  catalogueEntry,
  catalogueLimits,
  catalogueListing,
  defaultMemberCreditCeiling,
  defaultSelection,
} from "../packages/policy/src/model-catalogue.ts";
import { reservationSize, usd8Text } from "../packages/policy/src/run-credits.ts";
import { computerProfile, runtimeCaps } from "../packages/policy/src/runtime-computer.ts";
import { runtimeGatewayLimits } from "../packages/identity/src/broker-protocol.ts";
import { fixtureCatalogue } from "../apps/workspace-web/src/fixtures/seed.ts";

const read = (path) => readFileSync(path, "utf8");
const policy = JSON.parse(read("docs/decisions/model-policy.json"));
const registry = JSON.parse(read("docs/decisions/providers.json"));
const manifest = JSON.parse(read("migrations/manifest.json"));
const file = "0052.credits-only-catalogue.sql";
const sql = read("migrations/" + file);
const runs = read("migrations/0038.listings-runs.sql");
const runtime = read("migrations/0043.runtime-operations.sql");
// The owner's words, verbatim (OD-2026-10-25-4).
const quote =
  "for budget why we limiting anything? it should be very simple credit based system like suppose we give user 1000credits it will be spend on the agentic work so that creidt will bcome limit itself no need to hardcode all of that bullshit. and for one i want it to be truty multi agent system so the agents can be orchestrated by the main agent in any way no need to limit to a single agent call only. for 2 why we adding limit on characters? it might strip important information i think only needs to be structured. for other option use the recommded one";
const v3 = policy.catalogue.versions[2];
const v4 = policy.catalogue.versions[3];
const loop = policy.catalogue.versions[1];
const costCaps = ["run_cost_cap_usd", "workspace_daily_cost_cap_usd"];
const loopCaps = [...costCaps, "look_for_work_daily_cost_cap_usd"];
/** The body between the dollar quotes of one function definition in a migration. */
const body = (text, header) => {
  const at = text.indexOf(header);
  assert.ok(at >= 0, header);
  const open = text.indexOf("$$", at) + 2;
  return text.slice(open, text.indexOf("$$", open));
};
const md5 = (text) => createHash("md5").update(text).digest("hex");
/** One VALUES list of an INSERT, as rows of trimmed SQL literals. */
const rows = (insert) => {
  const at = sql.indexOf(insert);
  assert.ok(at >= 0, insert);
  const values = sql.slice(sql.indexOf("VALUES", at) + 6, sql.indexOf(";", at));
  return [...values.matchAll(/\(([^()]*)\)/g)].map((m) =>
    m[1].split(",").map((v) => v.trim().replace(/^'(.*)'$/, "$1")),
  );
};
/** The non-comment lines of a body, trimmed. */
const code = (text) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("--"));

test("OD-2026-10-25-4 is recorded verbatim in its node and in version 4's owner confirmation", () => {
  const decision = read("docs/graph/decisions/OD-2026-10-25-4.md");
  assert.match(decision, /^by: owner$/m);
  assert.match(decision, /^channel: chat$/m);
  assert.ok(decision.includes("> " + quote + "\n"));
  assert.ok(v4.owner_confirmation.includes('(OD-2026-10-25-4): "' + quote + '"'));
  assert.equal(v4.decision, "ADR-0039 item 4");
  assert.equal(v4.effective_from, "2026-10-25");
});

// ADR-0039 is on pull request 75. This case reads its Approval section and passes once that
// pull request is on main (the ship stage merges main before this branch merges); until then
// it fails, so the code cannot merge ahead of the record it carries out.
test("ADR-0039's Approval quotes OD-2026-10-25-4 verbatim (needs pull request 75 on main)", () => {
  const path = "docs/decisions/adr/ADR-0039-credits-only-spend-limit.md";
  let adr;
  try {
    adr = read(path);
  } catch {
    assert.fail(path + " is not on this branch yet: merge main once pull request 75 has merged");
  }
  assert.match(adr, /^- Status: Accepted 2026-10-25 \(the owner, OD-2026-10-25-4; see Approval\)/m);
  const approval = adr.slice(adr.indexOf("## Approval"));
  assert.ok(approval.includes("> " + quote + "\n"));
  // Item 4 is what this branch carries out: version 4 with 25 products for every entry.
  assert.match(adr, /^4\. \*\*Listings\.\*\* /m);
  assert.ok(adr.includes("catalogue version 4 publishes on this decision"));
});

test("catalogue version 4: version 3's entries, rates, default and ceiling, no caps, 25 products", () => {
  assert.equal(v4.version, 4);
  assert.equal(v4.status, "active");
  assert.equal(policy.catalogue.active_versions.per_product, 4);
  assert.equal(v3.status, "retired");
  assert.equal(
    policy.catalogue.published_digests["4"],
    "013de2e441ad4d30db5acb75a9a40d953e34d0e973e06f47b7c2dc8766ff1d42",
  );
  assert.equal(catalogueVersionDigest(v4), policy.catalogue.published_digests["4"]);
  // Version 3's digest is unchanged by its retirement (status is outside the digest).
  assert.equal(catalogueVersionDigest(v3), policy.catalogue.published_digests["3"]);
  assert.deepEqual(v4.models, v3.models);
  assert.deepEqual(v4.efforts, v3.efforts);
  assert.deepEqual(v4.default_selection, v3.default_selection);
  assert.equal(v4.default_member_credit_ceiling, v3.default_member_credit_ceiling);
  assert.equal(v4.expected_input_tokens, v3.expected_input_tokens);
  const { rule: _r4, ...economics4 } = v4.economics;
  const { rule: _r3, ...economics3 } = v3.economics;
  assert.deepEqual(economics4, economics3);
  const limits3 = { ...v3.limits };
  for (const field of costCaps) delete limits3[field];
  assert.deepEqual(v4.limits, limits3);
  // The code's view: the active version, its default and ceiling, and 25 products a run.
  assert.equal(activeCatalogueVersion(), 4);
  assert.deepEqual(defaultSelection(), { model: "claude_opus_5_5", effort: "medium" });
  assert.equal(defaultMemberCreditCeiling(), 4);
  assert.deepEqual(
    [catalogueLimits(4).runCostCapUsd8, catalogueLimits(4).workspaceDailyCostCapUsd8],
    [null, null],
  );
  for (const model of ["claude_haiku_5_5", "claude_sonnet_5_5", "claude_opus_5_5"])
    for (const effort of ["low", "medium", "high"]) {
      const at = catalogueEntry(4, model, effort);
      const before = catalogueEntry(3, model, effort);
      assert.equal(at.runProductLimit, 25, `${model} ${effort}`);
      assert.equal(at.creditsPerProduct, before.creditsPerProduct);
      assert.equal(at.worstCasePerProductUsd8, before.worstCasePerProductUsd8);
      assert.equal(at.worstCasePerAttemptUsd8, before.worstCasePerAttemptUsd8);
    }
  // ADR-0039's Consequences: 25 Opus 5.5 high products hold 150 credits and US$17.60 of worst
  // case (was 9 products, US$6.34), at medium 100 credits (was 12), Sonnet 5.5 high 75 (was 19).
  const opusHigh = reservationSize(catalogueEntry(4, "claude_opus_5_5", "high"), 25);
  assert.equal(opusHigh.reservation.credits, 150n);
  assert.equal(usd8Text(opusHigh.reservation.vendorMaximumUsd8), "17.60000000");
  assert.deepEqual(
    [9, 12, 19],
    [
      catalogueEntry(3, "claude_opus_5_5", "high").runProductLimit,
      catalogueEntry(3, "claude_opus_5_5", "medium").runProductLimit,
      catalogueEntry(3, "claude_sonnet_5_5", "high").runProductLimit,
    ],
  );
});

test("no money cap after version 3: per-product versions, the loop version and the generated data", () => {
  assert.deepEqual(inspectModelPolicy(policy, registry).errors, []);
  for (const entry of policy.catalogue.versions) {
    const fields = entry.run_shape === "agent_loop" ? loopCaps : costCaps;
    for (const field of fields)
      assert.equal(
        Object.hasOwn(entry.limits, field),
        entry.version === 1 || entry.version === 3,
        `v${entry.version} ${field}`,
      );
  }
  assert.equal(loop.status, "proposed", "loop version 2 stays proposed");
  for (const v of generatedModelCatalogue.versions)
    assert.equal(v.limits.runCostCapUsd8 === null, v.version > 3, `v${v.version}`);
  for (const v of generatedLoopCatalogue.versions)
    assert.doesNotMatch(JSON.stringify(v.limits), /CostCap/, `v${v.version}`);
  // Verify refuses a run or daily cap on version 4, any money cap on the loop version, and a
  // published version 1 or 3 without its caps; the margin rules stay.
  const refused = (change, pattern) => {
    const p = structuredClone(policy);
    change(p);
    assert.match(inspectModelPolicy(p, registry).errors.join("\n"), pattern);
  };
  for (const field of costCaps)
    refused(
      (p) => (p.catalogue.versions[3].limits[field] = "7"),
      /model catalogue v4: carries a run or daily cost cap, which ADR-0039 removed/,
    );
  for (const field of loopCaps)
    refused(
      (p) => (p.catalogue.versions[1].limits[field] = "1.12"),
      new RegExp(`model catalogue v2: carries ${field}, a money cap, which ADR-0039 removed`),
    );
  refused(
    (p) => delete p.catalogue.versions[2].limits.run_cost_cap_usd,
    /model catalogue v3: missing USD caps/,
  );
  refused(
    (p) => (p.catalogue.versions[3].models[2].credits_per_product.high = 1),
    /claude_opus_5_5 at high worst case exceeds 0\.90 of its credits' net revenue/,
  );
  // The report: every version 4 entry runs 25 products.
  const report = inspectModelPolicy(policy, registry).versions.find((v) => v.version === 4);
  assert.ok(report.selections.every((s) => s.products_per_run === 25));
});

test("the Sunrise sample's catalogue listing is version 4's", () => {
  const listing = catalogueListing();
  assert.equal(listing.catalogueVersion, 4);
  assert.deepEqual(
    fixtureCatalogue.map((e) => ({ ...e })),
    listing.entries.map((e) => ({ ...e })),
  );
  assert.match(read("apps/workspace-web/src/fixtures/adapter.ts"), /catalogueVersion: 4,/);
});

test("migration 0052: a forward work-owner migration, row 52, its brief and digest", () => {
  const row = manifest.migrations.find((m) => m.file === file);
  // The next free number on main after ADR-0036's 0051; open pull requests hold 0052-0054 and
  // renumber at their integration (or this one does, whichever merges later).
  assert.equal(row.sequence, 52);
  assert.equal(manifest.migrations.at(-1), row);
  assert.equal(row.executeAs, "morrow_work_owner");
  assert.equal(row.sha256, createHash("sha256").update(sql).digest("hex"));
  assert.equal(row.reviewRef, "docs/briefs/adr-0039-credits-catalogue.md");
  assert.match(sql, /current_user<>'morrow_work_owner'/);
  assert.match(sql, /RAISE EXCEPTION 'CREDITS_ONLY_PREREQUISITES_INVALID'/);
  // Versions 1 and 3 keep their caps; no other version may carry either.
  assert.match(
    sql,
    /ALTER COLUMN run_cost_cap_usd DROP NOT NULL,\n ALTER COLUMN workspace_daily_cost_cap_usd DROP NOT NULL,\n ADD CONSTRAINT model_catalogue_versions_cost_caps CHECK \(\(run_cost_cap_usd IS NOT NULL\)=\(version IN \(1,3\)\)\n {2}AND \(workspace_daily_cost_cap_usd IS NOT NULL\)=\(version IN \(1,3\)\)\);/,
  );
  // The append-only trigger is lifted for exactly one status change and restored after it.
  const off = sql.indexOf(
    "ALTER TABLE morrow_work.model_catalogue_versions DISABLE TRIGGER append_only;",
  );
  const update = sql.indexOf(
    "UPDATE morrow_work.model_catalogue_versions SET status='retired' WHERE version=3 AND status='active';",
  );
  const on = sql.indexOf(
    "ALTER TABLE morrow_work.model_catalogue_versions ENABLE TRIGGER append_only;",
  );
  assert.ok(off > 0 && off < update && update < on, "disable, retire, enable");
  assert.equal(sql.match(/DISABLE TRIGGER/g).length, 1);
  // The only UPDATEs: the retirement, and inside the replaced definer the capacity row.
  assert.equal(sql.match(/^UPDATE /gm).length, 1);
  // Exactly two functions are dropped, each created again below; nothing else is.
  assert.deepEqual(
    [...sql.matchAll(/^DROP [^\n]+$/gm)].map((m) => m[0]),
    [
      "DROP FUNCTION morrow_work.runtime_caps();",
      "DROP FUNCTION morrow_vault.runtime_operation_begin(text,text,text,text,text);",
    ],
  );
  assert.doesNotMatch(sql, /\bDELETE\b|\bDROP (TABLE|TRIGGER|POLICY|COLUMN|CONSTRAINT)\b|TRUNCATE/);
  assert.doesNotMatch(sql, /SET (LOCAL )?ROLE|SECURITY INVOKER|BYPASSRLS/);
});

test("migration 0052 seeds catalogue version 4 exactly as the generated catalogue holds it", () => {
  const generated = generatedModelCatalogue.versions.find((v) => v.version === 4);
  assert.equal(generatedModelCatalogue.activeVersion, 4);
  const [version] = rows("INSERT INTO morrow_work.model_catalogue_versions(");
  assert.deepEqual(version, [
    "4",
    "active",
    policy.catalogue.published_digests["4"],
    generated.defaultSelection.model,
    generated.defaultSelection.effort,
    String(generated.defaultMemberCreditCeiling),
    String(generated.limits.maxProductsPerRun),
    "NULL",
    "NULL",
    "NULL",
  ]);
  assert.equal(generated.digest, policy.catalogue.published_digests["4"]);
  const entries = rows("INSERT INTO morrow_work.model_catalogue_entries(");
  assert.equal(entries.length, 9);
  for (const [v, model, effort, perProduct, worst, attempt, limit] of entries) {
    const e = catalogueEntry(4, model, effort);
    assert.deepEqual(
      [v, perProduct, worst, attempt, limit],
      [
        "4",
        String(e.creditsPerProduct),
        usd8Text(e.worstCasePerProductUsd8),
        usd8Text(e.worstCasePerAttemptUsd8),
        "25",
      ],
      `${model} ${effort}`,
    );
  }
  const rates = rows("INSERT INTO morrow_work.model_catalogue_rates(");
  assert.deepEqual(
    rates,
    generated.models.map((m) => [
      "4",
      m.key,
      m.provider,
      m.providerModelId,
      String(m.inputUsd8PerToken),
      String(m.outputUsd8PerToken),
      String(generated.limits.maxInputTokensPerCall),
    ]),
  );
});

test("run_reserve is revised from its pinned 0038 body without the daily cap, every other check kept", () => {
  const header = "FUNCTION morrow_billing.run_reserve(";
  const before = body(runs, "CREATE OR REPLACE " + header);
  const pinned = /run_reserve\(text[^\n]*\)'\)\)\n {2}IS DISTINCT FROM '([a-f0-9]{32})'/.exec(
    sql,
  )[1];
  assert.equal(md5(before), pinned);
  assert.match(before, /'daily_cap'/);
  const after = body(sql, "CREATE OR REPLACE " + header);
  // Same signature, language, INVOKER security and search path.
  const signature = (text) =>
    text.slice(
      text.indexOf("CREATE OR REPLACE " + header),
      text.indexOf("$$", text.indexOf(header)),
    );
  assert.equal(signature(sql), signature(runs));
  assert.doesNotMatch(after, /daily_cap|workspace_daily_cost_cap_usd|v_today|SECURITY DEFINER/);
  // Every other refusal and both reservations stay.
  for (const outcome of [
    "'invalid'",
    "'no_billing_period'",
    "'catalogue_inactive'",
    "'run_product_limit'",
    "'wallet_not_found'",
    "'duplicate'",
    "'insufficient_credits'",
    "'unrecovered_cost_cap'",
    "'reserved'",
  ])
    assert.ok(after.includes(outcome), outcome);
  assert.ok(after.includes("'morrow.billing.run_reserve',p_org,p_ws"), "the interlock key");
  assert.ok(after.includes("FOR UPDATE;"), "the wallet's row lock");
  assert.ok(after.includes("morrow_billing.unrecovered_allows("));
  assert.ok(after.includes("created_day"), "the vendor reservation keeps its day");
  // Nothing new: every code line of the revision is a line of 0038's, but the declarations.
  const old = new Set(code(before));
  const added = code(after).filter((l) => !old.has(l));
  assert.deepEqual(added, [
    "DECLARE e record; w record; v_now timestamptz; v_credits bigint; v_vendor numeric(20,8); v_day date; n integer;",
  ]);
});

test("runtime_caps() and runtime_operation_begin lose the monthly budget, from pinned 0043 bodies", () => {
  const capsHeader = "CREATE FUNCTION morrow_work.runtime_caps()";
  const beginHeader = "CREATE FUNCTION morrow_vault.runtime_operation_begin(";
  const pins = [...sql.matchAll(/IS DISTINCT FROM '([a-f0-9]{32})'/g)].map((m) => m[1]);
  assert.equal(pins.length, 3);
  assert.equal(pins[1], md5(body(runtime, capsHeader)));
  assert.equal(pins[2], md5(body(runtime, beginHeader)));
  // runtime_caps(): the TypeScript twin without monthlyBudgetUsd, owner INVOKER, command only.
  const staleSeconds = runtimeGatewayLimits.executeBudgetMaxMs / 1000 + 60;
  assert.equal(
    body(sql, capsHeader),
    `\n SELECT ${runtimeCaps.concurrentSandboxes},${runtimeCaps.sandboxesPerWorkspace},${runtimeCaps.worstCaseUsd}::numeric(20,8),${computerProfile.sandboxTimeoutSeconds + computerProfile.createAllowanceSeconds},${computerProfile.absentGraceSeconds},${staleSeconds}\n`,
  );
  assert.equal(Object.hasOwn(runtimeCaps, "monthlyBudgetUsd"), false);
  assert.match(
    sql,
    /CREATE FUNCTION morrow_work\.runtime_caps\(\)\nRETURNS TABLE\(concurrent_sandboxes integer,sandboxes_per_workspace integer,worst_case_usd numeric,\n deadline_seconds integer,absent_grace_seconds integer,stale_seconds integer\)\nLANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS \$\$/,
  );
  assert.ok(sql.includes("REVOKE ALL ON FUNCTION morrow_work.runtime_caps() FROM PUBLIC;"));
  assert.ok(
    sql.includes("GRANT EXECUTE ON FUNCTION morrow_work.runtime_caps() TO morrow_work_command;"),
  );
  // runtime_operation_begin: no monthly budget, every other outcome kept, 0043's ACL and owner.
  const before = body(runtime, beginHeader);
  const after = body(sql, beginHeader);
  assert.match(before, /'monthly_budget'/);
  assert.doesNotMatch(
    code(after).join("\n"),
    /monthly|budget_month|month_committed|v_month|v_committed/,
  );
  for (const outcome of [
    "'begun'",
    "'replay'",
    "'runtime_held'",
    "'concurrency_limit'",
    "'workspace_limit'",
    "'reservation_exhausted'",
    "'capability_missing'",
    "'run_inactive'",
    "'sandbox_compute'",
    "'sending'",
  ])
    assert.ok(after.includes(outcome), outcome);
  const signature = (text) =>
    text.slice(text.indexOf(beginHeader), text.indexOf("$$", text.indexOf(beginHeader)));
  assert.equal(signature(sql), signature(runtime));
  assert.match(
    signature(sql),
    /LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS /,
  );
  const old = new Set(code(before));
  assert.deepEqual(
    code(after).filter((l) => !old.has(l)),
    [
      "v_open integer; v_op text; v_entry text; v_deadline timestamptz; n integer;",
      "SELECT x.open_operations INTO cap FROM morrow_work.runtime_capacity x WHERE x.scope='platform' FOR UPDATE;",
      "UPDATE morrow_work.runtime_capacity x SET open_operations=cap.open_operations+1,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)",
      "WHERE x.scope='platform';",
    ],
  );
  const tail = sql.slice(sql.lastIndexOf("END $$;"));
  assert.equal(
    tail,
    `END $$;
REVOKE ALL ON FUNCTION morrow_vault.runtime_operation_begin(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_vault.runtime_operation_begin(text,text,text,text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_vault.runtime_operation_begin(text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_vault FROM morrow_work_command;
COMMIT;
`,
  );
  // The broker's closed refusal set keeps monthly_budget for replies from before 0052.
  assert.match(read("apps/broker/src/runtime-ledger.ts"), /\n {2}"monthly_budget",\n/);
  // The staging runtime record carries the provider's limit and no budget of the code's.
  const record = JSON.parse(read("docs/decisions/runtime-staging.json"));
  assert.equal(Object.hasOwn(record, "monthly_budget_usd"), false);
  assert.equal(record.provider_usage_limit_usd, runtimeCaps.providerUsageLimitUsd);
});

test("daily_cap stays in the run refusals' closed set for old records and is never produced", () => {
  const commands = read("packages/work/src/runs/commands.ts");
  assert.match(
    commands,
    /\/\/ Never returned since migration 0052 \(ADR-0039[^\n]*\n[^\n]*\n {2}\| "daily_cap"/,
  );
  const http = read("packages/work/src/runs/http.ts");
  assert.match(
    http,
    /\/\/ Never returned since migration 0052 \(ADR-0039[^\n]*\n {4}daily_cap: \[/,
  );
  // The only SQL that returns it is 0033's and 0038's run_reserve, both replaced by 0052.
  const returning = manifest.migrations
    .filter((m) => read("migrations/" + m.file).includes("SELECT 'daily_cap'"))
    .map((m) => m.sequence);
  assert.deepEqual(returning, [33, 38]);
});
