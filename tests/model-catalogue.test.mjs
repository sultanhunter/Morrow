// M3 PR-1: the generated model catalogue and its selection rules (ADR-0022 items 10, 11
// and 16; mvp-architecture §9). Pure: no I/O beyond reading the repository files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  catalogueVersionData,
  generateModelCatalogue,
  modelCataloguePath,
} from "../scripts/generate-model-catalogue.mjs";
import { catalogueVersionDigest as pinnedDigest } from "../scripts/provider-checks.mjs";
import {
  activeCatalogueVersion,
  catalogueEntry,
  catalogueLimits,
  catalogueListing,
  catalogueVersionDigest,
  checkWorkspaceDefault,
  defaultMemberCreditCeiling,
  defaultSelection,
  findCatalogueEntry,
  memberMayPick,
  ModelCatalogueError,
  resolveSelection,
} from "../packages/policy/src/model-catalogue.ts";
import { generatedModelCatalogue } from "../packages/policy/src/generated/model-catalogue.ts";

const policy = JSON.parse(readFileSync("docs/decisions/model-policy.json", "utf8"));
const usd = (units) => Number(units) / 1e8;

test("the generator is deterministic and the committed file reproduces exactly (--check)", async () => {
  const first = await generateModelCatalogue();
  const second = await generateModelCatalogue();
  assert.equal(first, second);
  assert.equal(readFileSync(modelCataloguePath, "utf8"), first);
  // Data only: no function, import or eval in the generated module.
  assert.doesNotMatch(first, /\bimport\b|\bfunction\b|=>|\beval\b|new Function/);
});

test("the pinned digests of versions 1, 3 and 4 are unchanged and generated with the data", () => {
  const v1 = policy.catalogue.versions[0];
  assert.equal(policy.catalogue.published_digests["1"], pinnedDigest(v1));
  assert.equal(generatedModelCatalogue.versions[0].digest, policy.catalogue.published_digests["1"]);
  assert.equal(catalogueVersionDigest(1), policy.catalogue.published_digests["1"]);
  // ADR-0036: version 3 is active and version 1 retired (a run recorded at 1 is booked at 1).
  const v3 = policy.catalogue.versions[2];
  assert.equal(v3.version, 3);
  assert.equal(policy.catalogue.published_digests["3"], pinnedDigest(v3));
  assert.equal(generatedModelCatalogue.versions[1].digest, policy.catalogue.published_digests["3"]);
  assert.equal(catalogueVersionDigest(3), policy.catalogue.published_digests["3"]);
  // ADR-0039: version 4 is active and version 3 retired (a run recorded at 3 is booked at 3).
  const v4 = policy.catalogue.versions[3];
  assert.equal(v4.version, 4);
  assert.equal(policy.catalogue.published_digests["4"], pinnedDigest(v4));
  assert.equal(generatedModelCatalogue.versions[2].digest, policy.catalogue.published_digests["4"]);
  assert.equal(catalogueVersionDigest(4), policy.catalogue.published_digests["4"]);
  assert.deepEqual(
    generatedModelCatalogue.versions.map((v) => [v.version, v.status]),
    [
      [1, "retired"],
      [3, "retired"],
      [4, "active"],
    ],
  );
  assert.equal(activeCatalogueVersion(), 4);
});

test("the generator refuses a rate or cap it cannot represent at 10^-8 USD", () => {
  const v1 = structuredClone(policy.catalogue.versions[0]);
  v1.models[0].rates_usd_per_million_tokens.input = "0.105";
  assert.throws(() => catalogueVersionData(v1), /MODEL_CATALOGUE_DECIMAL_INEXACT/);
  const cap = structuredClone(policy.catalogue.versions[0]);
  cap.limits.run_cost_cap_usd = "7.000000001";
  assert.throws(() => catalogueVersionData(cap), /MODEL_CATALOGUE_DECIMAL/);
  const key = structuredClone(policy.catalogue.versions[0]);
  key.models[0].key = "claude-haiku-5-5";
  assert.throws(() => catalogueVersionData(key), /MODEL_CATALOGUE_KEY_INVALID/);
});

test("the ADR-0022 item 11 table: credits, worst case and run limits in versions 1, 3 and 4", () => {
  const expected = {
    claude_haiku_5_5: { low: [1, 0.0066, 25], medium: [1, 0.0136, 25], high: [1, 0.0176, 25] },
    claude_sonnet_5_5: { low: [1, 0.132, 25], medium: [2, 0.272, 25], high: [3, 0.352, 19] },
    claude_opus_5_5: { low: [2, 0.264, 25], medium: [4, 0.544, 12], high: [6, 0.704, 9] },
  };
  for (const version of [1, 3, 4])
    for (const [model, efforts] of Object.entries(expected))
      for (const [effort, [credits, worst, limit]] of Object.entries(efforts)) {
        const at = `v${version} ${model} ${effort}`;
        // Version 4 lists Claude Opus 5.5 at medium and high only (the owner, 2026-10-26);
        // versions 1 and 3 keep their Haiku 5.5, Sonnet 5.5 and low entries as published.
        if (version === 4 && (model !== "claude_opus_5_5" || effort === "low")) {
          assert.equal(findCatalogueEntry(version, model, effort), null, at);
          continue;
        }
        const entry = catalogueEntry(version, model, effort);
        assert.equal(entry.creditsPerProduct, credits, `${at} credits`);
        assert.equal(usd(entry.worstCasePerProductUsd8), worst, `${at} worst case`);
        // ADR-0039 item 4: from version 4 no run cost cap lowers the 25-product limit.
        assert.equal(entry.runProductLimit, version === 4 ? 25 : limit, `${at} run limit`);
        // Exact BigInt arithmetic: two attempts at the input cap and the effort's max_tokens.
        assert.equal(entry.worstCasePerProductUsd8, 2n * entry.worstCasePerAttemptUsd8);
      }
  assert.equal(catalogueEntry(1, "claude_sonnet_5_5", "low").worstCasePerProductUsd8, 13_200_000n);
  assert.equal(catalogueEntry(1, "claude_opus_5_5", "high").worstCasePerProductUsd8, 70_400_000n);
  for (const version of [1, 3, 4]) {
    const limits = catalogueLimits(version);
    // Versions 1 and 3 keep their published US$7 and US$25; version 4 has neither (ADR-0039).
    assert.equal(limits.runCostCapUsd8, version === 4 ? null : 700_000_000n);
    assert.equal(limits.workspaceDailyCostCapUsd8, version === 4 ? null : 2_500_000_000n);
    assert.equal(limits.maxProductsPerRun, 25);
    assert.equal(limits.maxConsecutiveFailedProducts, 3);
    // No unrecovered-cost cap in any generated version (ADR-0036).
    assert.equal(Object.hasOwn(limits, "workspacePeriodUnrecoveredCostCapUsd8"), false);
  }
});

test("keys are opaque: provider model strings, unknown keys, xhigh and retired versions give no entry", () => {
  assert.equal(findCatalogueEntry(1, "claude-opus-5-5", "high"), null);
  assert.equal(findCatalogueEntry(1, "claude_opus_5_5", "xhigh"), null);
  assert.equal(findCatalogueEntry(1, "claude_opus_5_5", "max"), null);
  assert.equal(findCatalogueEntry(1, "gpt_5", "low"), null);
  // Version 2 is the proposed loop version: no per-product entry.
  assert.equal(findCatalogueEntry(2, "claude_opus_5_5", "high"), null);
  // Version 4 has no low effort (the owner, 2026-10-26); versions 1 and 3 keep theirs.
  assert.equal(findCatalogueEntry(4, "claude_opus_5_5", "low"), null);
  assert.ok(findCatalogueEntry(3, "claude_opus_5_5", "low"));
  assert.equal(findCatalogueEntry(5, "claude_opus_5_5", "high"), null);
  assert.equal(findCatalogueEntry(0, "claude_opus_5_5", "high"), null);
  assert.throws(() => catalogueEntry(1, "claude-opus-5-5", "high"), ModelCatalogueError);
  // The listing carries no provider, provider model ID, rate or cost.
  const listing = catalogueListing();
  assert.equal(listing.catalogueVersion, 4);
  assert.deepEqual(
    listing.entries.map((entry) => [entry.model, entry.effort]),
    [
      ["claude_opus_5_5", "medium"],
      ["claude_opus_5_5", "high"],
    ],
  );
  assert.ok(listing.entries.every((entry) => entry.runProductLimit === 25));
  const text = JSON.stringify(listing);
  assert.doesNotMatch(text, /anthropic|claude-|Usd|usd|rate/i);
  for (const entry of listing.entries)
    assert.deepEqual(Object.keys(entry).sort(), [
      "creditsPerProduct",
      "effort",
      "model",
      "runProductLimit",
    ]);
});

test("selection: refusals, the default and the member ceiling (ADR-0022 item 16, ADR-0036)", () => {
  const member = { workspaceDefault: null, ceiling: 4, holdsRevise: false };
  // Refusals before any run exists.
  for (const [selection, code] of [
    [{ model: "claude-opus-5-5", effort: "high" }, "selection_invalid"],
    [{ model: "claude_opus_5_5", effort: "high", catalogueVersion: 4 }, "selection_invalid"],
    ["claude_opus_5_5", "selection_invalid"],
    [{ model: "claude_opus_5_5", effort: "xhigh" }, "selection_unknown"],
    [{ model: "claude_unknown_9", effort: "low" }, "selection_unknown"],
    // Entries of versions 1 and 3 that version 4 does not list (Opus 5.5 at medium and high
    // only, 2026-10-26).
    [{ model: "claude_haiku_5_5", effort: "low" }, "selection_unknown"],
    [{ model: "claude_sonnet_5_5", effort: "high" }, "selection_unknown"],
    [{ model: "claude_opus_5_5", effort: "low" }, "selection_unknown"],
  ])
    assert.deepEqual(resolveSelection({ ...member, selection }), { ok: false, code }, code);
  // A missing selection is the workspace default: Opus 5.5 at medium, four credits (ADR-0036),
  // which the default member ceiling of 4 admits.
  const defaulted = resolveSelection({ ...member, selection: null });
  assert.equal(defaulted.ok, true);
  assert.equal(defaulted.defaulted, true);
  assert.deepEqual([defaulted.entry.model, defaulted.entry.effort], ["claude_opus_5_5", "medium"]);
  assert.equal(defaulted.entry.catalogueVersion, 4);
  assert.equal(defaulted.entry.creditsPerProduct, 4);
  assert.equal(defaulted.entry.runProductLimit, 25);
  assert.deepEqual(defaultSelection(), { model: "claude_opus_5_5", effort: "medium" });
  assert.equal(defaultMemberCreditCeiling(), 4);
  // A workspace that stored a ceiling below 4 (version 1's default was 1) keeps it: its
  // members are refused the new default and, since version 4's cheapest entry is Opus 5.5 at
  // medium (4 credits), every entry, until a holder of governance.model_default.revise
  // raises it.
  for (const ceiling of [1, 2, 3]) {
    assert.deepEqual(resolveSelection({ ...member, ceiling, selection: null }), {
      ok: false,
      code: "selection_above_ceiling",
    });
    assert.deepEqual(
      resolveSelection({
        ...member,
        ceiling,
        selection: { model: "claude_opus_5_5", effort: "medium" },
      }),
      { ok: false, code: "selection_above_ceiling" },
    );
  }
  // A member without governance.model_default.revise picking Opus high under ceiling 4.
  const opusHigh = { model: "claude_opus_5_5", effort: "high" };
  assert.deepEqual(resolveSelection({ ...member, selection: opusHigh }), {
    ok: false,
    code: "selection_above_ceiling",
  });
  // The owner (who holds it) is admitted; the member is admitted after the ceiling is 6.
  assert.equal(resolveSelection({ ...member, holdsRevise: true, selection: opusHigh }).ok, true);
  assert.equal(resolveSelection({ ...member, ceiling: 6, selection: opusHigh }).ok, true);
  // A stored default above the member ceiling is refused for that member as well.
  assert.deepEqual(resolveSelection({ ...member, selection: null, workspaceDefault: opusHigh }), {
    ok: false,
    code: "selection_above_ceiling",
  });
  // A stored default that is not in the active version falls back to the catalogue default.
  const stale = resolveSelection({
    ...member,
    selection: undefined,
    workspaceDefault: { model: "claude_retired_4", effort: "low" },
  });
  assert.equal(stale.ok && stale.entry.model, "claude_opus_5_5");
  // A stored default of version 1 or 3 that version 4 does not list (Sonnet 5.5 at low, Opus
  // 5.5 at low) falls back to the catalogue default too; one that version 4 lists (Opus 5.5 at
  // high) is kept.
  for (const stored of [
    { model: "claude_sonnet_5_5", effort: "low" },
    { model: "claude_opus_5_5", effort: "low" },
  ]) {
    const fallback = resolveSelection({ ...member, selection: null, workspaceDefault: stored });
    assert.deepEqual(
      fallback.ok && [fallback.entry.model, fallback.entry.effort],
      ["claude_opus_5_5", "medium"],
      `${stored.model} ${stored.effort}`,
    );
  }
  const kept = resolveSelection({
    ...member,
    ceiling: 6,
    selection: null,
    workspaceDefault: opusHigh,
  });
  assert.deepEqual(kept.ok && [kept.entry.model, kept.entry.effort], ["claude_opus_5_5", "high"]);
  assert.equal(kept.ok && kept.entry.catalogueVersion, 4);
  assert.equal(memberMayPick(6, 6, false), true);
  assert.equal(memberMayPick(6, 5, false), false);
  assert.equal(memberMayPick(6, 1, true), true);
  assert.throws(() => memberMayPick(0, 1, false), ModelCatalogueError);
});

test("a workspace default must be an entry its own ceiling admits", () => {
  assert.equal(checkWorkspaceDefault({ model: "claude_opus_5_5", effort: "high" }, 6).ok, true);
  assert.deepEqual(checkWorkspaceDefault({ model: "claude_opus_5_5", effort: "high" }, 5), {
    ok: false,
    code: "ceiling_below_default",
  });
  assert.deepEqual(checkWorkspaceDefault({ model: "claude_opus_5_5", effort: "high" }, 0), {
    ok: false,
    code: "ceiling_invalid",
  });
  assert.deepEqual(checkWorkspaceDefault({ model: "claude-opus-5-5", effort: "high" }, 6), {
    ok: false,
    code: "selection_invalid",
  });
  assert.deepEqual(checkWorkspaceDefault({ model: "claude_opus_5_5", effort: "xhigh" }, 6), {
    ok: false,
    code: "selection_unknown",
  });
  // Since version 4 (Opus 5.5 only), Haiku 5.5 and Sonnet 5.5 cannot be a workspace default.
  for (const model of ["claude_haiku_5_5", "claude_sonnet_5_5"])
    assert.deepEqual(checkWorkspaceDefault({ model, effort: "low" }, 6), {
      ok: false,
      code: "selection_unknown",
    });
});
