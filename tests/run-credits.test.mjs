// M3 PR-1: the pure run money rules (P11.T04a minimum; ADR-0022 item 11). The SQL twins
// (run_reserve, run_book_cost, run_settle, run_release, unrecovered_allows) are proved
// under concurrency by lab:run-credits.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { catalogueVersionData } from "../scripts/generate-model-catalogue.mjs";
import { generatedModelCatalogue } from "../packages/policy/src/generated/model-catalogue.ts";
import {
  catalogueEntry,
  catalogueLimits,
  createModelCatalogue,
} from "../packages/policy/src/model-catalogue.ts";
import {
  attemptCostUsd8,
  dailyCapAllows,
  failureBreaker,
  parseUsd8,
  reservationSize,
  RunCreditsError,
  settledCredits,
  unrecoveredAllows,
  unrecoveredPeriodStart,
  usd8Text,
} from "../packages/policy/src/run-credits.ts";

const limits = catalogueLimits(1);
const sonnetLow = catalogueEntry(1, "claude_sonnet_5_5", "low");
const opusHigh = catalogueEntry(1, "claude_opus_5_5", "high");

test("reservation sizing is exact BigInt: Opus high reserves 6 credits per product, at most 9", () => {
  const nine = reservationSize(opusHigh, 9);
  assert.equal(nine.ok, true);
  assert.equal(nine.reservation.credits, 54n);
  assert.equal(nine.reservation.vendorMaximumUsd8, 9n * 70_400_000n);
  assert.equal(usd8Text(nine.reservation.vendorMaximumUsd8), "6.33600000");
  assert.deepEqual(reservationSize(opusHigh, 10), { ok: false, code: "run_product_limit" });
  assert.deepEqual(reservationSize(sonnetLow, 26), { ok: false, code: "run_product_limit" });
  assert.deepEqual(reservationSize(sonnetLow, 0), { ok: false, code: "product_count_invalid" });
  assert.deepEqual(reservationSize(sonnetLow, 1.5), { ok: false, code: "product_count_invalid" });
  const full = reservationSize(sonnetLow, 25);
  assert.equal(full.reservation.credits, 25n);
  // A run never reserves more than US$7 of vendor cost, whatever the selection.
  for (const model of ["claude_haiku_5_5", "claude_sonnet_5_5", "claude_opus_5_5"])
    for (const effort of ["low", "medium", "high"]) {
      const entry = catalogueEntry(1, model, effort);
      const most = reservationSize(entry, entry.runProductLimit);
      assert.ok(most.reservation.vendorMaximumUsd8 <= limits.runCostCapUsd8, `${model} ${effort}`);
    }
});

test("settlement never exceeds the reservation and failed products are not charged", () => {
  // 9 Opus-high products reserved (54 credits), 7 drafted, 2 failed: 42 credits.
  assert.equal(settledCredits(54n, 7, 6), 42n);
  assert.equal(settledCredits(54n, 9, 6), 54n);
  // A caller claiming more drafted products than reserved still settles at the reservation.
  assert.equal(settledCredits(54n, 12, 6), 54n);
  assert.equal(settledCredits(25n, 0, 1), 0n);
  assert.throws(() => settledCredits(-1n, 1, 1), RunCreditsError);
  assert.throws(() => settledCredits(1n, 1, 0), RunCreditsError);
});

test("attempt cost: usage at the run's rates; an uncertain attempt at its worst case", () => {
  // 3,000 input and 1,200 output tokens at Sonnet's US$2/US$10 per million: US$0.018.
  const usage = attemptCostUsd8(sonnetLow, {
    outcome: "usage",
    usage: { inputTokens: 3000, outputTokens: 1200 },
  });
  assert.equal(usd8Text(usage), "0.01800000");
  // 8,000 input and 5,000 output (low max_tokens) at the same rates: US$0.066.
  assert.equal(usd8Text(attemptCostUsd8(sonnetLow, { outcome: "uncertain" })), "0.06600000");
  assert.equal(
    attemptCostUsd8(sonnetLow, { outcome: "uncertain" }) * 2n,
    sonnetLow.worstCasePerProductUsd8,
  );
  assert.throws(
    () =>
      attemptCostUsd8(sonnetLow, { outcome: "usage", usage: { inputTokens: -1, outputTokens: 0 } }),
    RunCreditsError,
  );
});

test("the daily cap counts settled cost plus open reservations at US$25", () => {
  const usd = (text) => parseUsd8(text);
  assert.equal(dailyCapAllows(limits, usd("18"), 0n, usd("7")), true);
  assert.equal(dailyCapAllows(limits, usd("18"), usd("0.00000001"), usd("7")), false);
  assert.equal(dailyCapAllows(limits, 0n, usd("18"), usd("7")), true);
  assert.equal(dailyCapAllows(limits, usd("12.5"), usd("12.5"), 1n), false);
});

test("the unrecovered-cost cap: US$4.50 per billing period, the next worst case included", () => {
  const cap = parseUsd8("4.50");
  assert.equal(limits.workspacePeriodUnrecoveredCostCapUsd8, cap);
  assert.equal(
    unrecoveredAllows(
      limits,
      cap - opusHigh.worstCasePerProductUsd8,
      opusHigh.worstCasePerProductUsd8,
    ),
    true,
  );
  assert.equal(
    unrecoveredAllows(
      limits,
      cap - opusHigh.worstCasePerProductUsd8 + 1n,
      opusHigh.worstCasePerProductUsd8,
    ),
    false,
  );
  // Once the period's unrecovered cost reaches the cap, even the cheapest product is refused.
  assert.equal(unrecoveredAllows(limits, cap, 1n), false);
  // The ledger is keyed on M5's billing period; no period means no entitlement.
  assert.equal(unrecoveredPeriodStart(null), null);
  assert.equal(
    unrecoveredPeriodStart({ start: "2026-10-05T10:00:00.000Z", end: "2026-11-05T10:00:00.000Z" }),
    "2026-10-05T10:00:00.000Z",
  );
  assert.throws(
    () => unrecoveredPeriodStart({ start: "2026-11-05T10:00:00Z", end: "2026-10-05T10:00:00Z" }),
    RunCreditsError,
  );
});

test("the failure breaker: three consecutive failed products stop a run; a good one resets it", () => {
  let state = { consecutiveFailed: 0, stop: false };
  const step = (product) => (state = failureBreaker(limits, state.consecutiveFailed, product));
  step("failed");
  step("failed");
  assert.deepEqual(state, { consecutiveFailed: 2, stop: false });
  // A good product between failures resets the count (never the unrecovered cost).
  step("drafted");
  assert.deepEqual(state, { consecutiveFailed: 0, stop: false });
  step("failed");
  step("failed");
  step("failed");
  assert.deepEqual(state, { consecutiveFailed: 3, stop: true });
});

test("a run is booked at its recorded catalogue version after a newer version is active", () => {
  // Synthetic version 2: Sonnet doubles its rates; version 1 is retired, not removed.
  const policy = JSON.parse(readFileSync("docs/decisions/model-policy.json", "utf8"));
  const v1 = { ...structuredClone(policy.catalogue.versions[0]), status: "retired" };
  const v2 = structuredClone(policy.catalogue.versions[0]);
  v2.version = 2;
  v2.status = "active";
  for (const model of v2.models)
    if (model.key === "claude_sonnet_5_5")
      model.rates_usd_per_million_tokens = { input: "4", output: "20" };
  const catalogue = createModelCatalogue({
    id: generatedModelCatalogue.id,
    activeVersion: 2,
    versions: [catalogueVersionData(v1), catalogueVersionData(v2)],
  });
  assert.equal(catalogue.activeCatalogueVersion(), 2);
  // A new selection resolves against version 2 ...
  const resolved = catalogue.resolveSelection({
    selection: { model: "claude_sonnet_5_5", effort: "low" },
    workspaceDefault: null,
    ceiling: 1,
    holdsRevise: false,
  });
  assert.equal(resolved.ok && resolved.entry.catalogueVersion, 2);
  assert.equal(resolved.entry.worstCasePerProductUsd8, 26_400_000n);
  // ... while a run recorded at version 1 is booked at version 1's rates.
  const recorded = catalogue.catalogueEntry(1, "claude_sonnet_5_5", "low");
  assert.equal(recorded.status, "retired");
  const usage = { outcome: "usage", usage: { inputTokens: 3000, outputTokens: 1200 } };
  assert.equal(usd8Text(attemptCostUsd8(recorded, usage)), "0.01800000");
  assert.equal(usd8Text(attemptCostUsd8(resolved.entry, usage)), "0.03600000");
  // The retired version's pinned digest stays (status is outside the digest).
  assert.equal(catalogue.catalogueVersionDigest(1), policy.catalogue.published_digests["1"]);
});

test("numeric(20,8) text conversions are exact and closed", () => {
  for (const text of [
    "0.00000000",
    "0.13200000",
    "7.00000000",
    "4.50000000",
    "123456789012.00000001",
  ])
    assert.equal(usd8Text(parseUsd8(text)), text);
  assert.equal(parseUsd8("4.5"), 450_000_000n);
  for (const bad of ["-1", "1e3", "0.000000001", "01", "", 1])
    assert.throws(() => parseUsd8(bad), RunCreditsError, String(bad));
  assert.throws(() => usd8Text(-1n), RunCreditsError);
});
