// ADR-0039 (OD-2026-10-25-4): credits are the only spend limit. Implementation plan PR 1 (the
// listings and the catalogue, credits only) with PR 4's removal of the runtime budget:
// catalogue version 4 with no run or daily cap and 25 products a run for every entry, and
// Claude Opus 5.5 only at medium and high (the owner, 2026-10-26: Haiku 5.5 and Sonnet 5.5
// leave the catalogue, and then low effort, owner question 1 on pull request 82), version 3
// retired, run_reserve without the daily cap, runtime_caps() and runtime_operation_begin
// without the monthly budget (migration 0056), and verify refusing a money cap on any later
// per-product version and on any loop version, and any model but Claude Opus 5.5 and low
// effort from version 4 and in every published version but 1 and 3 (review A2). Pure: no
// I/O beyond reading the repository files. lab:run-credits (C3, C12, C13), lab:listings-runs (B4, C1) and
// lab:runtime-operations (K2) prove migration 0056 on PostgreSQL 17.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OPUS_ONLY_FROM_VERSION,
  OPUS_ONLY_MODEL,
  OPUS_ONLY_REFUSED_EFFORTS,
  PUBLISHED_BEFORE_OPUS_ONLY,
  catalogueVersionDigest,
  inspectModelPolicy,
  isOpusModel,
  opusOnlyApplies,
} from "../scripts/provider-checks.mjs";
import { generatedModelCatalogue } from "../packages/policy/src/generated/model-catalogue.ts";
import { generatedLoopCatalogue } from "../packages/policy/src/generated/loop-catalogue.ts";
import {
  activeCatalogueVersion,
  catalogueEntry,
  catalogueLimits,
  catalogueListing,
  defaultMemberCreditCeiling,
  defaultSelection,
  findCatalogueEntry,
} from "../packages/policy/src/model-catalogue.ts";
import { reservationSize, usd8Text } from "../packages/policy/src/run-credits.ts";
import { computerProfile, runtimeCaps } from "../packages/policy/src/runtime-computer.ts";
import { runtimeGatewayLimits } from "../packages/identity/src/broker-protocol.ts";
import { fixtureCatalogue } from "../apps/workspace-web/src/fixtures/seed.ts";
import { parseAdmitBody } from "../packages/work/src/runs/commands.ts";

const read = (path) => readFileSync(path, "utf8");
const policy = JSON.parse(read("docs/decisions/model-policy.json"));
const registry = JSON.parse(read("docs/decisions/providers.json"));
const manifest = JSON.parse(read("migrations/manifest.json"));
const file = "0056.credits-only-catalogue.sql";
const sql = read("migrations/" + file);
const runs = read("migrations/0038.listings-runs.sql");
const runtime = read("migrations/0043.runtime-operations.sql");
// The owner's words, verbatim (OD-2026-10-25-4).
const quote =
  "for budget why we limiting anything? it should be very simple credit based system like suppose we give user 1000credits it will be spend on the agentic work so that creidt will bcome limit itself no need to hardcode all of that bullshit. and for one i want it to be truty multi agent system so the agents can be orchestrated by the main agent in any way no need to limit to a single agent call only. for 2 why we adding limit on characters? it might strip important information i think only needs to be structured. for other option use the recommded one";
// The owner's words of 2026-10-26, verbatim, on the models.
const opusQuote =
  "one more thing i am seeing we are using haiku for some parts? why is that? we don't want to cheap out on models as we want the best results for users as all the users are going to be paid users";
// The owner's answer of 2026-10-26 to owner question 1 on pull request 82, verbatim, and the
// recommendation it accepted, as Q-adr-0040-0041-owner-questions put it.
const effortAnswer =
  "lets accept the recommended options, also i want to know one thing since we are building a full fledged ai workspace with people and ai agents teammates to run shopify business will the user able to suppose create a agent for suppose a cod order appears then the agent calls the customers to confirm the cod order so the rate of cancellation decreases(ofcourse all the apis access for the external services that will be provided by the user like the calling service etc.)";
const effortRecommendation =
  "Yes to both. Drop low effort everywhere, and keep the per-agent picker with Opus 5.5 at medium or high only; extra-high and max come later, once tests show they help.";
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
  assert.equal(
    v4.decision,
    "ADR-0039 item 4, and the owner's decisions of 2026-10-26 that every agent runs on Claude Opus 5.5, at medium or high effort",
  );
  assert.equal(v4.effective_from, "2026-10-26");
});

test("the owner's model decision of 2026-10-26 is quoted verbatim in version 4's confirmation", () => {
  assert.ok(v4.owner_confirmation.includes('Owner, 2026-10-26, in chat: "' + opusQuote + '"'));
  assert.ok(
    v4.owner_confirmation.includes(
      "The lead reads it as every agent on Claude Opus 5.5, with Haiku 5.5 and Sonnet 5.5 leaving the catalogue",
    ),
  );
  // Both decisions, in order: credits first (2026-10-25), then the models (2026-10-26).
  assert.ok(v4.owner_confirmation.indexOf(quote) < v4.owner_confirmation.indexOf(opusQuote));
  assert.match(
    policy.catalogue.change_policy,
    /from version 4, every version of either run shape holds only Claude Opus 5\.5 entries, at medium and high effort, and so does every published version other than 1 and 3/,
  );
});

test("the owner's answer to question 1 (low effort leaves) is quoted verbatim in version 4's confirmation", () => {
  const confirmation = v4.owner_confirmation;
  assert.ok(
    confirmation.includes(
      'Owner, 2026-10-26, in chat, answering owner question 1 on pull request 82 (ADR-0041, Q-adr-0040-0041-owner-questions), whose recommendation was "' +
        effortRecommendation +
        '": "' +
        effortAnswer +
        '".',
    ),
  );
  assert.ok(
    confirmation.includes(
      "Low effort leaves too: version 4 holds only Opus 5.5 at medium and high (4 and 6 credits a product).",
    ),
  );
  // In order: credits (2026-10-25), the models, then low effort (both 2026-10-26).
  assert.ok(confirmation.indexOf(opusQuote) < confirmation.indexOf(effortAnswer));
  assert.match(v4.economics.rule, /Claude Opus 5\.5 only, at medium and high effort/);
});

// ADR-0039 merged with pull request 75. The code carries out the record, so the record's
// Approval must quote the same words the catalogue's version 4 cites.
test("ADR-0039's Approval quotes OD-2026-10-25-4 verbatim and item 4 publishes version 4", () => {
  const adr = read("docs/decisions/adr/ADR-0039-credits-only-spend-limit.md");
  assert.match(adr, /^- Status: Accepted 2026-10-25 \(the owner, OD-2026-10-25-4; see Approval\)/m);
  const approval = adr.slice(adr.indexOf("## Approval"));
  assert.ok(approval.includes("> " + quote + "\n"));
  // Item 4 is what this branch carries out: version 4 with 25 products for every entry.
  assert.match(adr, /^4\. \*\*Listings\.\*\* /m);
  assert.ok(adr.includes("catalogue version 4 publishes on this decision"));
});

// Item 4 still reads "version 3 with no run or daily cap"; the dated note amends it to Claude
// Opus 5.5 only at medium and high, quoting the owner's words exactly as version 4's
// owner_confirmation does.
test("ADR-0039's amendment of 2026-10-26 makes version 4 Opus 5.5 at medium and high only, in the owner's words", () => {
  const adr = read("docs/decisions/adr/ADR-0039-credits-only-spend-limit.md");
  const amendments = adr.slice(adr.indexOf("\n## Amendments\n"));
  assert.ok(adr.indexOf("\n## Amendments\n") > adr.indexOf("\n## Approval\n"));
  const note = amendments.slice(
    amendments.indexOf(
      "### 2026-10-26: item 4, catalogue version 4 is Claude Opus 5.5 only, at medium and high (decided)\n",
    ),
  );
  assert.ok(note.startsWith("### 2026-10-26: item 4"));
  assert.ok(note.includes("\n> " + opusQuote + "\n"));
  assert.ok(v4.owner_confirmation.includes('"' + opusQuote + '"'));
  assert.ok(
    note.includes("The cheapest Listings product costs 4 credits, not 1: Opus 5.5 at medium."),
  );
  // Low effort leaves too: the owner's answer to question 1, quoted verbatim.
  assert.ok(note.includes("owner question 1 on pull request 82 (ADR-0041;"));
  assert.ok(note.includes("\n> " + effortAnswer + "\n"));
  assert.ok(note.includes("(the key `claude_opus_5_5` calling `claude-opus-5-5`)"));
  assert.doesNotMatch(note, /Low effort is the owner's open question/);
});

test("catalogue version 4: version 3's Opus entries at medium and high, rates, default and ceiling, no caps, 25 products", () => {
  assert.equal(v4.version, 4);
  assert.equal(v4.status, "active");
  assert.equal(policy.catalogue.active_versions.per_product, 4);
  assert.equal(v3.status, "retired");
  assert.equal(
    policy.catalogue.published_digests["4"],
    "189ba14bcad6b5cbdf15d7d6e2a51d1b571720615d3688042e17f0777b74c62c",
  );
  assert.equal(catalogueVersionDigest(v4), policy.catalogue.published_digests["4"]);
  // Version 3's digest is unchanged by its retirement (status is outside the digest).
  assert.equal(catalogueVersionDigest(v3), policy.catalogue.published_digests["3"]);
  // Claude Opus 5.5 only: version 3's Opus entry exactly but for low effort, and neither Haiku
  // nor Sonnet.
  const opus3 = structuredClone(v3.models.find((m) => m.key === "claude_opus_5_5"));
  delete opus3.credits_per_product.low;
  assert.deepEqual(v4.models, [opus3]);
  assert.deepEqual(
    v4.models.map((m) => [m.key, m.provider_model_id, m.credits_per_product]),
    [["claude_opus_5_5", "claude-opus-5-5", { medium: 4, high: 6 }]],
  );
  // Medium and high only: version 3's two efforts, unchanged.
  assert.deepEqual(
    v4.efforts,
    v3.efforts.filter((e) => e.key !== "low"),
  );
  assert.deepEqual(
    v4.efforts.map((e) => e.key),
    ["medium", "high"],
  );
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
  for (const effort of ["medium", "high"]) {
    const at = catalogueEntry(4, "claude_opus_5_5", effort);
    const before = catalogueEntry(3, "claude_opus_5_5", effort);
    assert.equal(at.runProductLimit, 25, `opus ${effort}`);
    assert.equal(at.creditsPerProduct, before.creditsPerProduct);
    assert.equal(at.worstCasePerProductUsd8, before.worstCasePerProductUsd8);
    assert.equal(at.worstCasePerAttemptUsd8, before.worstCasePerAttemptUsd8);
  }
  // Haiku 5.5, Sonnet 5.5 and Opus 5.5 at low are not entries of version 4; version 3 keeps
  // them as published, so a run recorded at version 3 is still booked at its entry.
  for (const model of ["claude_haiku_5_5", "claude_sonnet_5_5", "claude_opus_5_5"])
    for (const effort of model === "claude_opus_5_5" ? ["low"] : ["low", "medium", "high"]) {
      assert.equal(findCatalogueEntry(4, model, effort), null, `${model} ${effort}`);
      assert.ok(findCatalogueEntry(3, model, effort), `${model} ${effort} at version 3`);
    }
  // The cheapest Listings product is Opus 5.5 at medium, 4 credits.
  assert.deepEqual(
    catalogueListing().entries.map((e) => [e.model, e.effort, e.creditsPerProduct]),
    [
      ["claude_opus_5_5", "medium", 4],
      ["claude_opus_5_5", "high", 6],
    ],
  );
  // ADR-0039's Consequences: 25 Opus 5.5 high products hold 150 credits and US$17.60 of worst
  // case (was 9 products, US$6.34), at medium 100 credits (was 12). Version 3's limits stay as
  // published (Sonnet 5.5 high's 19 among them).
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
    (p) => (p.catalogue.versions[3].models[0].credits_per_product.high = 1),
    /claude_opus_5_5 at high worst case exceeds 0\.90 of its credits' net revenue/,
  );
  // The report: every version 4 entry runs 25 products.
  const report = inspectModelPolicy(policy, registry).versions.find((v) => v.version === 4);
  assert.ok(report.selections.every((s) => s.products_per_run === 25));
});

// The rule's message, as verify words it (scripts/provider-checks.mjs).
const notOpus = (version, key) =>
  new RegExp(
    `model catalogue v${version}: ${key} is not Claude Opus 5\\.5; from version 4, and in every published version but 1 and 3, every entry is Claude Opus 5\\.5`,
  );
const lowRefused = (version) =>
  new RegExp(
    `model catalogue v${version}: effort low is refused; from version 4, and in every published version but 1 and 3, entries run at medium or high`,
  );

test("Claude Opus 5.5 only from version 4: verify refuses any other model, either run shape", () => {
  assert.equal(OPUS_ONLY_FROM_VERSION, 4);
  assert.deepEqual(
    { ...OPUS_ONLY_MODEL },
    { provider: "anthropic", key: "claude_opus_5_5", provider_model_id: "claude-opus-5-5" },
  );
  assert.ok(Object.isFrozen(OPUS_ONLY_MODEL));
  for (const entry of policy.catalogue.versions)
    if (opusOnlyApplies(entry)) assert.ok(entry.models.every(isOpusModel), `v${entry.version}`);
  // Versions 1 to 3 keep their Haiku and Sonnet as published (1 and 3) or proposed (the loop's 2).
  for (const index of [0, 1, 2])
    assert.deepEqual(
      policy.catalogue.versions[index].models.map((m) => m.key),
      ["claude_haiku_5_5", "claude_sonnet_5_5", "claude_opus_5_5"],
    );
  assert.ok(
    generatedModelCatalogue.versions
      .filter((v) => v.version >= 4)
      .every((v) =>
        v.models.every(
          (m) => m.key === "claude_opus_5_5" && m.providerModelId === "claude-opus-5-5",
        ),
      ),
  );
  const refused = (change, pattern) => {
    const p = structuredClone(policy);
    change(p);
    assert.match(inspectModelPolicy(p, registry).errors.join("\n"), pattern);
  };
  // Version 3's Haiku and Sonnet entries carried into version 4 are refused, each (at version
  // 4's medium and high, so only the model rule refuses them).
  for (const index of [0, 1])
    refused(
      (p) => {
        const carried = structuredClone(v3.models[index]);
        delete carried.credits_per_product.low;
        p.catalogue.versions[3].models.unshift(carried);
      },
      notOpus(4, v3.models[index].key),
    );
  // An Opus key that calls another model, and another provider's model, are not Opus.
  refused(
    (p) => (p.catalogue.versions[3].models[0].provider_model_id = "claude-sonnet-5-5"),
    notOpus(4, "claude_opus_5_5"),
  );
  // Another Opus generation is refused too (the review's F2): an older, cheaper Opus such as
  // Claude Opus 4.1 in a later per-product version, and a newer one, until a reviewed change to
  // the rule. Each is otherwise a valid entry: version 4's own, with the key and model ID changed.
  for (const [key, id] of [
    ["claude_opus_4_1", "claude-opus-4-1"],
    ["claude_opus_6_0", "claude-opus-6-0"],
  ]) {
    refused(
      (p) => {
        const next = structuredClone(p.catalogue.versions[3]);
        next.version = 5;
        next.status = "proposed";
        next.models[0].key = key;
        next.models[0].provider_model_id = id;
        p.catalogue.versions.push(next);
      },
      new RegExp(`model catalogue v5: ${key} is not Claude Opus 5\\.5`),
    );
    refused(
      (p) => {
        p.catalogue.versions[3].models[0].key = key;
        p.catalogue.versions[3].models[0].provider_model_id = id;
      },
      new RegExp(`model catalogue v4: ${key} is not Claude Opus 5\\.5`),
    );
  }
  // A later loop version (a sim version 5 of the agent-loop shape) is held to the same rule.
  refused((p) => {
    const next = structuredClone(loop);
    next.version = 5;
    p.catalogue.versions.push(next);
  }, /model catalogue v5: claude_haiku_5_5 is not Claude Opus 5\.5[\s\S]*model catalogue v5: claude_sonnet_5_5 is not Claude Opus 5\.5/);
  // The rule itself: exactly Anthropic's claude_opus_5_5 calling claude-opus-5-5.
  const opus = v4.models[0];
  assert.equal(isOpusModel(opus), true);
  assert.equal(
    isOpusModel({ ...opus, key: "claude_opus_4_1", provider_model_id: "claude-opus-4-1" }),
    false,
  );
  assert.equal(
    isOpusModel({ ...opus, key: "claude_opus_6_0", provider_model_id: "claude-opus-6-0" }),
    false,
  );
  assert.equal(
    isOpusModel({ ...opus, key: "claude_opus_5_5_1", provider_model_id: "claude-opus-5-5-1" }),
    false,
  );
  assert.equal(isOpusModel({ ...opus, provider_model_id: "claude-opus-4-1" }), false);
  assert.equal(isOpusModel({ ...opus, provider: "openai" }), false);
  assert.equal(isOpusModel({ ...opus, key: "claude_opus_latest" }), false);
  assert.equal(isOpusModel({ ...opus, provider_model_id: "claude-opus-5-5-latest" }), false);
  assert.equal(isOpusModel({ ...v3.models[0] }), false);
  assert.equal(isOpusModel({ ...v3.models[1] }), false);
});

// The owner's answer to question 1 on pull request 82 (2026-10-26): low effort leaves too.
test("low effort is refused from version 4, either run shape; xhigh and max are left to a later version", () => {
  assert.deepEqual([...OPUS_ONLY_REFUSED_EFFORTS], ["low"]);
  assert.ok(Object.isFrozen(OPUS_ONLY_REFUSED_EFFORTS));
  assert.deepEqual(inspectModelPolicy(policy, registry).errors, []);
  for (const entry of policy.catalogue.versions)
    if (opusOnlyApplies(entry)) {
      assert.ok(!entry.efforts.some((e) => e.key === "low"), `v${entry.version}`);
      for (const model of entry.models)
        assert.equal(Object.hasOwn(model.credits_per_product ?? {}, "low"), false);
    }
  const refused = (change, pattern) => {
    const p = structuredClone(policy);
    change(p);
    assert.match(inspectModelPolicy(p, registry).errors.join("\n"), pattern);
  };
  // Version 3's Opus 5.5 at low (its effort and its 2 credits) put back into version 4.
  const withLow = (entry) => {
    entry.efforts.unshift(structuredClone(v3.efforts.find((e) => e.key === "low")));
    entry.models[0].credits_per_product = { low: 2, ...entry.models[0].credits_per_product };
  };
  refused((p) => withLow(p.catalogue.versions[3]), lowRefused(4));
  // A proposed per-product version 5 with low effort.
  refused((p) => {
    const next = structuredClone(p.catalogue.versions[3]);
    next.version = 5;
    next.status = "proposed";
    withLow(next);
    p.catalogue.versions.push(next);
  }, lowRefused(5));
  // A later loop version: Opus 5.5 only but still at low is refused for low alone; at medium
  // and high it passes.
  const loopV5 = (p, { low }) => {
    const next = structuredClone(loop);
    next.version = 5;
    next.models = next.models.filter(isOpusModel);
    if (!low) next.efforts = next.efforts.filter((e) => e.key !== "low");
    p.catalogue.versions.push(next);
  };
  const p = structuredClone(policy);
  loopV5(p, { low: true });
  const errors = inspectModelPolicy(p, registry).errors.join("\n");
  assert.match(errors, lowRefused(5));
  assert.doesNotMatch(errors, /is not Claude Opus 5\.5/);
  const clean = structuredClone(policy);
  loopV5(clean, { low: false });
  assert.deepEqual(inspectModelPolicy(clean, registry).errors, []);
});

// Review finding A2: the rule held only from version 4, so publishing the loop's version 2 as
// it stands (Haiku 5.5, Sonnet 5.5 and low effort) passed verify. Every published version but
// 1 and 3 is now held to it; version 2 passes only while it is proposed.
test("every published version but 1 and 3 is Opus 5.5 at medium or high, the loop's version 2 included (review A2)", () => {
  assert.deepEqual([...PUBLISHED_BEFORE_OPUS_ONLY], [1, 3]);
  assert.ok(Object.isFrozen(PUBLISHED_BEFORE_OPUS_ONLY));
  for (const [version, status, applies] of [
    [1, "retired", false],
    [1, "active", false],
    [3, "retired", false],
    [3, "active", false],
    [2, "proposed", false],
    [2, "active", true],
    [2, "retired", true],
    [4, "proposed", true],
    [4, "active", true],
    [5, "proposed", true],
    [5, "retired", true],
  ])
    assert.equal(opusOnlyApplies({ version, status }), applies, `v${version} ${status}`);
  assert.equal(opusOnlyApplies({ version: "4", status: "active" }), false);
  assert.equal(loop.status, "proposed");
  assert.deepEqual(inspectModelPolicy(policy, registry).errors, []);
  // Publishing loop version 2 as the owner's confirmation would.
  const publish = (p, { retire = false } = {}) => {
    const entry = p.catalogue.versions[1];
    entry.status = retire ? "retired" : "active";
    entry.owner_confirmation = "synthetic owner confirmation";
    entry.effective_from = "2026-11-01";
    p.catalogue.active_versions.agent_loop = retire ? null : 2;
    p.catalogue.published_digests["2"] = catalogueVersionDigest(entry);
  };
  for (const retire of [false, true]) {
    const p = structuredClone(policy);
    publish(p, { retire });
    const errors = inspectModelPolicy(p, registry).errors.join("\n");
    assert.match(errors, notOpus(2, "claude_haiku_5_5"), `retire ${retire}`);
    assert.match(errors, notOpus(2, "claude_sonnet_5_5"), `retire ${retire}`);
    assert.match(errors, lowRefused(2), `retire ${retire}`);
  }
  // Rewritten to Opus 5.5 at medium and high (as pull request 64 will, under ADR-0041), it
  // publishes.
  const p = structuredClone(policy);
  const v2 = p.catalogue.versions[1];
  v2.models = v2.models.filter(isOpusModel);
  v2.efforts = v2.efforts.filter((e) => e.key !== "low");
  publish(p);
  assert.deepEqual(inspectModelPolicy(p, registry).errors, []);
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

test("more than 25 products is the request's bound (400 missing_input), not the selection's 409", () => {
  // The server: parseAdmitBody refuses 26 before any database access, so under version 4,
  // where every entry allows 25, the selection's run_product_limit is never reached.
  const products = (n) => Array.from({ length: n }, (_, i) => "product:" + (i + 1));
  const admit = (n) => ({
    storeId: "store_a",
    products: products(n),
    fields: ["title"],
    selection: { model: "claude_opus_5_5", effort: "high" },
  });
  assert.equal(parseAdmitBody(admit(26)), null);
  assert.equal(parseAdmitBody(admit(25)).products.length, 25);
  assert.ok(catalogueListing().entries.every((e) => e.runProductLimit === 25));
  // A null parse is WorkReject("invalid"): 400 missing_input (tests/listings-runs-http.test.mjs).
  assert.match(read("packages/work/src/http.ts"), /invalid: \[400, "missing_input", "never"/);
  // The contract says the same, and no longer promises the 409 for 26 products.
  const contract = read("docs/contracts/work-api.md");
  const refusals = contract.slice(contract.indexOf("- **Refusals** persist nothing."));
  const line = refusals.slice(0, refusals.indexOf("\n"));
  assert.match(
    line,
    /More than 25 products is outside the request's bound[^.]*: 400 `missing_input`/,
  );
  assert.match(
    line,
    /since catalogue version 4 \(ADR-0039\) every entry allows 25, so it is never returned/,
  );
  assert.doesNotMatch(line, /more products than the selection allows/);
  // The Sunrise sample answers as the server does (tests/workspace-web-runs.test.mjs).
});

test("migration 0056: a forward work-owner migration, row 56, its brief and digest", () => {
  const row = manifest.migrations.find((m) => m.file === file);
  // The next free number on main after the test credits renewal's 0055 (pull request 80); if
  // another pull request lands first, the lead renumbers this one again at merge time.
  assert.equal(row.sequence, 56);
  // Applied live, so every later row comes after it (plan row SD5's shopify-query-cost is
  // the first).
  assert.ok(manifest.migrations.slice(row.sequence).every((m) => m.sequence > row.sequence));
  assert.equal(manifest.migrations[row.sequence - 1], row);
  // The header names the migration it follows (review A1), the one before it in the manifest.
  const previous = manifest.migrations.find((m) => m.sequence === row.sequence - 1);
  assert.equal(previous.file, "0055.staging-test-credits-renewal.sql");
  assert.match(
    sql,
    /^-- Executes AS morrow_work_owner, after 0055 \(staging-test-credits-renewal\)\./m,
  );
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

test("migration 0056 seeds catalogue version 4 exactly as the generated catalogue holds it", () => {
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
  // Claude Opus 5.5 at medium and high only.
  assert.deepEqual(
    entries.map(([, model, effort]) => model + ":" + effort),
    ["claude_opus_5_5:medium", "claude_opus_5_5:high"],
  );
  assert.doesNotMatch(sql, /\(4,'claude_(haiku|sonnet)_5_5'/);
  assert.doesNotMatch(sql, /\(4,'claude_opus_5_5','low'/);
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
  // The broker's closed refusal set keeps monthly_budget for replies from before 0056.
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
    /\/\/ Never returned since migration 0056 \(ADR-0039[^\n]*\n[^\n]*\n {2}\| "daily_cap"/,
  );
  const http = read("packages/work/src/runs/http.ts");
  assert.match(
    http,
    /\/\/ Never returned since migration 0056 \(ADR-0039[^\n]*\n {4}daily_cap: \[/,
  );
  // The only SQL that returns it is 0033's and 0038's run_reserve, both replaced by 0056.
  const returning = manifest.migrations
    .filter((m) => read("migrations/" + m.file).includes("SELECT 'daily_cap'"))
    .map((m) => m.sequence);
  assert.deepEqual(returning, [33, 38]);
});
