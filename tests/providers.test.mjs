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
  const versions = inspectModelPolicy(modelPolicy, registry).versions;
  const [v1, v3] = [versions[0], versions[2]];
  assert.deepEqual([v1.version, v1.status, v3.version, v3.status], [1, "retired", 3, "active"]);
  // Version 3 keeps every entry of version 1 (ADR-0036 changes its default, not its prices).
  assert.deepEqual(v3.selections, v1.selections);
  const row = (model, effort) =>
    v3.selections.find((s) => s.model === model && s.effort === effort);
  assert.deepEqual(row("claude_sonnet_5_5", "low"), {
    model: "claude_sonnet_5_5",
    effort: "low",
    credits_per_product: 1,
    worst_case_usd: "0.132000",
    products_per_run: 25,
  });
  assert.deepEqual(row("claude_opus_5_5", "medium"), {
    model: "claude_opus_5_5",
    effort: "medium",
    credits_per_product: 4,
    worst_case_usd: "0.544000",
    products_per_run: 12,
  });
  assert.equal(row("claude_opus_5_5", "high").worst_case_usd, "0.704000");
  assert.equal(row("claude_opus_5_5", "high").products_per_run, 9);
  assert.equal(row("claude_sonnet_5_5", "high").products_per_run, 19);
});
// Catalogue v1 was published on the owner's confirmation (2026-10-19); its digest is pinned.
// ADR-0036 (OD-2026-10-25-1) published version 3 and retired version 1.
test("catalogue v1 is retired and v3 active, each with the owner's confirmation and its pinned digest", () => {
  const v1 = modelPolicy.catalogue.versions[0];
  assert.equal(v1.status, "retired");
  assert.match(v1.owner_confirmation, /Confirm all \(Recommended\)/);
  assert.equal(v1.effective_from, "2026-10-19");
  assert.equal(modelPolicy.catalogue.published_digests["1"], catalogueVersionDigest(v1));
  // Version 1 keeps its published US$4.50, which nothing enforces any more.
  assert.equal(v1.limits.workspace_period_unrecovered_cost_cap_usd, "4.50");
  const v3 = modelPolicy.catalogue.versions[2];
  assert.equal(v3.version, 3);
  assert.equal(v3.status, "active");
  assert.equal(v3.run_shape, undefined);
  assert.equal(modelPolicy.catalogue.active_versions.per_product, 3);
  assert.ok(
    v3.owner_confirmation.includes(
      "use opus 5.5 high for the main agent and opus 5.5 medium for all type of subagents/specialists etc. and you can remove the cap on ai cost",
    ),
  );
  assert.match(v3.owner_confirmation, /OD-2026-10-25-1/);
  assert.equal(v3.effective_from, "2026-10-25");
  assert.equal(modelPolicy.catalogue.published_digests["3"], catalogueVersionDigest(v3));
  assert.deepEqual(v3.default_selection, { model: "claude_opus_5_5", effort: "medium" });
  assert.equal(v3.default_member_credit_ceiling, 4);
  assert.equal(Object.hasOwn(v3.limits, "workspace_period_unrecovered_cost_cap_usd"), false);
  // Everything else is version 1's.
  const strip = (v) => {
    const {
      version: _v,
      status: _s,
      proposed_on: _p,
      decision: _d,
      owner_confirmation: _o,
      effective_from: _e,
      default_selection: _ds,
      default_member_credit_ceiling: _c,
      ...rest
    } = structuredClone(v);
    delete rest.limits.workspace_period_unrecovered_cost_cap_usd;
    delete rest.economics.rule;
    return rest;
  };
  assert.deepEqual(strip(v3), strip(v1));
});
// The rule cases start from v1 as it stood before publication: proposed, nothing pinned. They
// are the per-product shape's, so the proposed loop version (v2, PR 10) and the later
// per-product version 3 are left out here; tests/loop-catalogue.test.mjs has the loop cases.
const proposedBase = () => {
  const p = structuredClone(modelPolicy);
  p.catalogue.versions = p.catalogue.versions.filter((entry) => entry.version === 1);
  const v1 = p.catalogue.versions[0];
  v1.status = "proposed";
  v1.owner_confirmation = null;
  v1.effective_from = null;
  p.catalogue.active_versions = { per_product: null, agent_loop: null };
  p.catalogue.published_digests = {};
  return p;
};
const latest = (p) => p.catalogue.versions.at(-1);
const model = (p, key) => latest(p).models.find((m) => m.key === key);
const publish = (p) => {
  const entry = latest(p);
  entry.status = "active";
  entry.owner_confirmation = "synthetic owner confirmation";
  entry.effective_from = "2026-10-20";
  p.catalogue.active_versions.per_product = entry.version;
  p.catalogue.published_digests[String(entry.version)] = catalogueVersionDigest(entry);
};
test("a published catalogue version passes with its pinned digest, and retiring it keeps the digest", () => {
  const p = proposedBase();
  publish(p);
  assert.deepEqual(validateModelPolicy(p, registry), []);
  latest(p).status = "retired";
  p.catalogue.active_versions.per_product = null;
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
    "a two-credit default that the one-credit ceiling does not admit",
    (p) => (latest(p).default_selection.effort = "medium"),
    /the default member ceiling must admit the default selection/,
  ],
  [
    "a default outside the catalogue",
    (p) => (latest(p).default_selection.model = "gpt_6_1_sol"),
    /the default selection must be an entry of this version/,
  ],
  [
    "a default at an effort the version does not list",
    (p) => (latest(p).default_selection.effort = "xhigh"),
    /the default selection must be an entry of this version/,
  ],
  [
    "a member ceiling below the default",
    (p) => (latest(p).default_member_credit_ceiling = 0),
    /default member ceiling/,
  ],
  [
    "a default member ceiling above the default's credits",
    (p) => (latest(p).default_member_credit_ceiling = 2),
    /the default member ceiling must be the default selection's credits/,
  ],
  [
    "an unrecovered-cost cap on a version after 1 (ADR-0036)",
    (p) => {
      const next = structuredClone(latest(p));
      next.version = 2;
      p.catalogue.versions.push(next);
    },
    /model catalogue v2: carries an unrecovered-cost cap, which ADR-0036 removed/,
  ],
  [
    "version 1 without its published unrecovered-cost cap",
    (p) => delete latest(p).limits.workspace_period_unrecovered_cost_cap_usd,
    /model catalogue v1: missing USD caps/,
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
    "an active pointer that names no active version",
    (p) => (p.catalogue.active_versions.per_product = 1),
    /active_versions\.per_product does not name its active version/,
  ],
  ["a version out of sequence", (p) => (latest(p).version = 3), /out of sequence/],
])
  test(`model catalogue rejects ${name}`, () => {
    const p = proposedBase();
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
