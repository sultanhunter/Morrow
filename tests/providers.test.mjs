import test from "node:test";
import assert from "node:assert/strict";
import { read } from "../scripts/foundation.mjs";
import {
  catalogueVersionDigest,
  inspectModelPolicy,
  validateModelPolicy,
  validateProviders,
  inspectReadiness,
  inspectSyntheticActivation,
} from "../scripts/provider-checks.mjs";

const registry = read("docs/decisions/providers.json"),
  bindings = read("docs/decisions/provider-bindings.json"),
  catalogue = read("docs/contracts/capabilities.json"),
  deps = read("docs/decisions/dependencies.json"),
  sources = read("docs/research/sources.json");
const validate = (r, b) => validateProviders(r, b, catalogue, deps, sources);
const modelPolicy = read("docs/decisions/model-policy.json");
test("every advertised capability has a gated provider/implementation route", () =>
  assert.deepEqual(validate(registry, bindings), []));
for (const [name, change, expected] of [
  ["missing capability route", (_, b) => b.bindings.pop(), /missing provider binding/],
  [
    "duplicate route",
    (_, b) => b.bindings.push(structuredClone(b.bindings[0])),
    /duplicate binding/,
  ],
  ["malformed decision revision", (r) => (r.plan_sequence = "67"), /unrecorded provider decision/],
  [
    "untracked provider",
    (_, b) => (b.bindings[0].provider = "invented"),
    /unknown capability\/provider/,
  ],
  [
    "wrong dependency",
    (_, b) => (b.bindings[0].provider_dependency = "D02"),
    /wrong decision linkage/,
  ],
  [
    "unqualified activation",
    (r) => (r.providers[0].activation = "active"),
    /unsupported activation/,
  ],
  [
    "fabricated engineering",
    (r) => (r.providers[0].engineering_status = "qualified"),
    /unsupported activation/,
  ],
  [
    "fabricated account test",
    (r) => (r.providers[0].controlled_test_status = "passed"),
    /unsupported activation/,
  ],
  [
    "claiming login is grant",
    (r) => (r.providers.find((p) => p.id === "cloudflare").production_review_status = "granted"),
    /unsupported activation/,
  ],
  [
    "latest API",
    (_, b) => (b.bindings.find((x) => x.mode === "api").version = "latest"),
    /unpinned provider/,
  ],
  [
    "blanket scope",
    (_, b) => (b.bindings.find((x) => x.mode === "api").required_scopes = ["write:all"]),
    /unrestricted/,
  ],
  [
    "connector domain exposure",
    (_, b) => (b.bindings[0].hosts = ["shopify_connector"]),
    /surface drift/,
  ],
  ["missing readback", (_, b) => (b.bindings[0].readback = ""), /outcome contract/],
  [
    "unverified primary source",
    (_, b) => (b.bindings.find((x) => x.provider === "meta").sources = ["S08"]),
    /unverified documentary source/,
  ],
  [
    "invented evidence",
    (r) => (r.providers[0].qualification_evidence = ["fake"]),
    /unsupported activation/,
  ],
])
  test(`provider register rejects ${name}`, () => {
    const r = structuredClone(registry),
      b = structuredClone(bindings);
    change(r, b);
    assert.match(validate(r, b).join("\n"), expected);
  });

test("the model catalogue is adapter-backed, within its margin and never loses money on a selection", () =>
  assert.deepEqual(validateModelPolicy(modelPolicy, registry), []));
test("the catalogue derives each selection's worst case and run limit", () => {
  const [v1] = inspectModelPolicy(modelPolicy, registry).versions;
  const row = (model, effort) =>
    v1.selections.find((s) => s.model === model && s.effort === effort);
  assert.equal(v1.status, "proposed");
  assert.deepEqual(row("claude_sonnet_5_5", "low"), {
    model: "claude_sonnet_5_5",
    effort: "low",
    credits_per_product: 1,
    worst_case_usd: "0.132000",
    products_per_run: 25,
  });
  assert.equal(row("claude_opus_5_5", "high").worst_case_usd, "0.704000");
  assert.equal(row("claude_opus_5_5", "high").products_per_run, 9);
  assert.equal(row("claude_sonnet_5_5", "high").products_per_run, 19);
});
// Catalogue v1 is proposed until the owner confirms it; publishing pins its digest.
const latest = (p) => p.catalogue.versions.at(-1);
const model = (p, key) => latest(p).models.find((m) => m.key === key);
const publish = (p) => {
  const entry = latest(p);
  entry.status = "active";
  entry.owner_confirmation = "synthetic owner confirmation";
  entry.effective_from = "2026-10-20";
  p.catalogue.active_version = entry.version;
  p.catalogue.published_digests[String(entry.version)] = catalogueVersionDigest(entry);
};
test("a published catalogue version passes with its pinned digest, and retiring it keeps the digest", () => {
  const p = structuredClone(modelPolicy);
  publish(p);
  assert.deepEqual(validateModelPolicy(p, registry), []);
  latest(p).status = "retired";
  p.catalogue.active_version = null;
  assert.deepEqual(validateModelPolicy(p, registry), []);
});
for (const [name, change, expected] of [
  ["automatic fallback", (p) => (p.gateway.automatic_fallback = true), /fallback/],
  ["client model strings", (p) => (p.gateway.client_model_strings = "accepted"), /client model/],
  [
    "a zero-retention claim",
    (p) => (p.data_policy.zero_data_retention_status = "granted"),
    /data\/access/,
  ],
  [
    "a stateful provider feature",
    (p) => p.data_policy.stateful_features.push("files"),
    /data\/access/,
  ],
  [
    "an adapter for an unselected provider",
    (p) => (p.gateway.adapters[0].provider = "invented"),
    /invalid adapter/,
  ],
  ["SDK retries", (p) => (p.gateway.adapters[0].sdk_retries = 2), /invalid adapter/],
  [
    "a model without an adapter",
    (p) => (model(p, "claude_opus_5_5").provider = "openai"),
    /no broker adapter/,
  ],
  [
    "an unpinned model",
    (p) => (model(p, "claude_opus_5_5").provider_model_id = "claude-latest"),
    /unpinned/,
  ],
  [
    "a duplicate model key",
    (p) => latest(p).models.push(structuredClone(latest(p).models[0])),
    /invalid model key/,
  ],
  [
    "a free-form model key",
    (p) => (model(p, "claude_haiku_5_5").key = "Claude Haiku"),
    /invalid model key/,
  ],
  [
    "a thinking budget",
    (p) => (latest(p).efforts[0].request.thinking = { type: "enabled", budget_tokens: 2048 }),
    /adaptive thinking/,
  ],
  [
    "disabled thinking",
    (p) => (latest(p).efforts[0].request.thinking = { type: "disabled" }),
    /adaptive thinking/,
  ],
  [
    "an effort mapped to another level",
    (p) => (latest(p).efforts[0].request.output_config.effort = "high"),
    /its own level/,
  ],
  ["an unknown effort", (p) => (latest(p).efforts[0].key = "turbo"), /invalid effort/],
  [
    "an output cap above the model's limit",
    (p) => (latest(p).efforts[2].max_output_tokens = 200000),
    /output limit/,
  ],
  [
    "a missing multiplier",
    (p) => delete model(p, "claude_sonnet_5_5").credits_per_product.high,
    /no credit multiplier/,
  ],
  [
    "Opus at high effort for one credit",
    (p) => (model(p, "claude_opus_5_5").credits_per_product.high = 1),
    /claude_opus_5_5 at high worst case exceeds 0\.90 of its credits' net revenue/,
  ],
  [
    "a cheaper plan",
    (p) => (latest(p).economics.plan_price_usd = "29"),
    /claude_sonnet_5_5 at low worst case exceeds/,
  ],
  [
    "a larger input cap",
    (p) => (latest(p).limits.max_input_tokens_per_call = 20000),
    /worst case exceeds/,
  ],
  [
    "a low-effort output cap that leaves no margin",
    (p) => (latest(p).efforts[0].max_output_tokens = 6000),
    /claude_sonnet_5_5 at low worst case exceeds 0\.90/,
  ],
  [
    "economics without Stripe Tax",
    (p) => delete latest(p).economics.tax_fee_rate,
    /missing plan economics/,
  ],
  ["no margin", (p) => (latest(p).economics.max_worst_case_share = "1.5"), /no valid margin/],
  [
    "an input cap above Haiku's price tier",
    (p) => (latest(p).limits.max_input_tokens_per_call = 150000),
    /claude_haiku_5_5: the input cap leaves its price tier/,
  ],
  [
    "a model with no declared price tier",
    (p) => delete model(p, "claude_haiku_5_5").rate_tier_max_input_tokens,
    /no declared price tier/,
  ],
  [
    "a run cap below one Opus high product",
    (p) => (latest(p).limits.run_cost_cap_usd = "0.5"),
    /claude_opus_5_5 at high does not fit one product in the run cap/,
  ],
  [
    "a daily cap below the run cap",
    (p) => (latest(p).limits.workspace_daily_cost_cap_usd = "5"),
    /daily cap is below the run cap/,
  ],
  ["a missing USD cap", (p) => delete latest(p).limits.run_cost_cap_usd, /missing USD caps/],
  [
    "a missing product limit",
    (p) => delete latest(p).limits.max_products_per_run,
    /per-run limits/,
  ],
  [
    "a failure breaker beyond the run",
    (p) => (latest(p).limits.max_consecutive_failed_products = 26),
    /failure breaker/,
  ],
  [
    "an unrecovered-cost cap above what the margin leaves",
    (p) => (latest(p).limits.workspace_period_unrecovered_cost_cap_usd = "10"),
    /unrecovered-cost cap exceeds/,
  ],
  [
    "a default that costs two credits",
    (p) => (latest(p).default_selection.effort = "medium"),
    /default selection/,
  ],
  [
    "a default outside the catalogue",
    (p) => (latest(p).default_selection.model = "gpt_6_1_sol"),
    /default selection/,
  ],
  [
    "a member ceiling below the default",
    (p) => (latest(p).default_member_credit_ceiling = 0),
    /default member ceiling/,
  ],
  [
    "an edited published version",
    (p) => {
      publish(p);
      model(p, "claude_opus_5_5").credits_per_product.low = 3;
    },
    /version 1 changed since it was published/,
  ],
  [
    "a published version without a pinned digest",
    (p) => {
      publish(p);
      p.catalogue.published_digests = {};
    },
    /published without a pinned digest/,
  ],
  [
    "a published version without the owner's confirmation",
    (p) => {
      latest(p).owner_confirmation = "";
      publish(p);
      latest(p).owner_confirmation = "";
    },
    /without the owner's confirmation/,
  ],
  [
    "a pinned digest on a proposed version",
    (p) => (p.catalogue.published_digests["1"] = catalogueVersionDigest(latest(p))),
    /proposed version 1 has a pinned digest/,
  ],
  [
    "a removed published version",
    (p) => (p.catalogue.published_digests["2"] = "0".repeat(64)),
    /published version 2 was removed/,
  ],
  [
    "two active versions",
    (p) => {
      publish(p);
      const next = structuredClone(latest(p));
      next.version = 2;
      p.catalogue.versions.push(next);
      p.catalogue.published_digests["2"] = catalogueVersionDigest(next);
    },
    /at most one active/,
  ],
  [
    "a proposed version before an active one",
    (p) => {
      const next = structuredClone(latest(p));
      next.version = 2;
      p.catalogue.versions.push(next);
      publish(p);
    },
    /at most one active/,
  ],
  [
    "an active_version that names no active version",
    (p) => (p.catalogue.active_version = 1),
    /active_version/,
  ],
  ["a version out of sequence", (p) => (latest(p).version = 3), /out of sequence/],
])
  test(`model catalogue rejects ${name}`, () => {
    const p = structuredClone(modelPolicy);
    change(p);
    assert.match(validateModelPolicy(p, registry).join("\n"), expected);
  });

const decisions = [
  { id: "hosting", status: "recorded", reviewRef: "synthetic:hosting-review" },
  { id: "billing", status: "recorded", reviewRef: "synthetic:billing-review" },
];
const localPacket = {
  consumedDecisions: ["hosting", "billing"],
  acceptanceIds: ["P01.A04"],
  verification: ["synthetic command"],
  requiresControlledAccount: false,
  requiresQualifiedPackage: false,
};
test("recorded designs permit independent local preparation without claiming activation", () =>
  assert.equal(inspectReadiness(localPacket, decisions).ready, true));
for (const state of ["open", "proposed", "rejected", undefined])
  test(`Ready denied for structural decision ${state}`, () => {
    const d = structuredClone(decisions);
    d[1].status = state;
    assert.ok(
      inspectReadiness(localPacket, d).reasons.includes("STRUCTURAL_DECISION_UNRESOLVED:billing"),
    );
  });
test("a decision without review evidence cannot promote Ready", () => {
  const d = structuredClone(decisions);
  d[1].reviewRef = null;
  assert.equal(inspectReadiness(localPacket, d).ready, false);
});
test("missing required account blocks a controlled test, not independent research", () =>
  assert.ok(
    inspectReadiness(
      { ...localPacket, requiresControlledAccount: true },
      decisions,
    ).reasons.includes("CONTROLLED_ACCOUNT_MISSING"),
  ));
test("selected design cannot replace required package qualification", () =>
  assert.ok(
    inspectReadiness(
      { ...localPacket, requiresQualifiedPackage: true, packageInputStatus: "in_review" },
      decisions,
    ).reasons.includes("PACKAGE_INPUT_UNQUALIFIED"),
  ));
test("unknown structural decision denies Ready", () =>
  assert.equal(
    inspectReadiness({ ...localPacket, consumedDecisions: ["unknown"] }, decisions).ready,
    false,
  ));

for (const host of ["shopify_admin", "standalone"]) {
  const facts = {
    host,
    engineering: "qualified",
    controlledTest: "passed",
    productionReviewRequired: true,
    productionReview: "granted",
    productionReviewRef: "synthetic:receipt",
    currentAccountPermission: true,
    currentActorPermission: true,
    currentRegionAndRetention: true,
    requiresSpend: true,
    budgetReserved: true,
    requiresReview: true,
    exactCurrentApproval: true,
    remainingStructuralGap: false,
  };
  test(`${host}: surface gate remains enforced with otherwise qualified synthetic facts`, () =>
    assert.equal(inspectSyntheticActivation(facts).allowed, host === "standalone"));
  for (const [name, delta, reason] of [
    [
      "production permission pending",
      { productionReview: "pending" },
      "PRODUCTION_PERMISSION_PENDING",
    ],
    ["no review receipt", { productionReviewRef: null }, "PRODUCTION_PERMISSION_PENDING"],
    ["only documentary design", { engineering: "not_implemented" }, "ENGINEERING_UNQUALIFIED"],
    ["no controlled test", { controlledTest: "not_run" }, "CONTROLLED_TEST_UNQUALIFIED"],
    ["merchant account revoked", { currentAccountPermission: false }, "ACCOUNT_PERMISSION_MISSING"],
    ["specialist lacks authority", { currentActorPermission: false }, "ACTOR_PERMISSION_MISSING"],
    ["US database alone", { currentRegionAndRetention: false }, "DATA_POLICY_UNQUALIFIED"],
    ["owner infrastructure has no ceiling", { budgetReserved: false }, "BUDGET_NOT_RESERVED"],
    ["stale approval", { exactCurrentApproval: false }, "EXACT_APPROVAL_MISSING"],
    ["unresolved API field", { remainingStructuralGap: true }, "STRUCTURAL_GAP"],
  ])
    test(`${host}: denies ${name}`, () =>
      assert.ok(inspectSyntheticActivation({ ...facts, ...delta }).reasons.includes(reason)));
}
