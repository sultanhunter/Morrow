// Documentary gate checks for P01. This module cannot enable a connector or
// authorize dispatch. Later services must verify actual current evidence.
import { sha } from "./foundation.mjs";

export function validateProviders(registry, bindings, catalogue, dependencies, sources) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const providers = new Map(registry.providers.map((p) => [p.id, p]));
  const caps = new Map(catalogue.capabilities.map((c) => [c.id, c]));
  const deps = new Set(dependencies.map((d) => d.id));
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  if (providers.size !== registry.providers.length) fail("duplicate provider");
  for (const document of [registry, bindings]) {
    if (document.schema_version !== 1 || !Number.isInteger(document.plan_sequence))
      fail("unrecorded provider decision revision");
  }
  for (const p of providers.values()) {
    if (
      !p.id ||
      !p.owner ||
      !p.version ||
      !p.test_account_plan ||
      !p.restrictions ||
      !p.blocking_packages.length ||
      p.decision_ids.some((d) => !deps.has(d))
    )
      fail(`${p.id}: missing provider ownership or qualification plan`);
    if (
      p.design_status !== "selected" ||
      p.activation !== "blocked" ||
      p.engineering_status !== "not_implemented" ||
      p.controlled_test_status !== "not_run" ||
      !["pending", "not_applicable"].includes(p.production_review_status) ||
      p.qualification_evidence.length !== 0
    )
      fail(`${p.id}: unsupported activation/qualification claim`);
    for (const id of p.sources)
      if (sourceMap.get(id)?.status !== "verified")
        fail(`${p.id}: documentary source unverified ${id}`);
  }
  const seen = new Set();
  for (const b of bindings.bindings) {
    const c = caps.get(b.capability),
      p = providers.get(b.provider);
    if (seen.has(b.capability)) fail(`${b.capability}: duplicate binding`);
    seen.add(b.capability);
    if (!c || !p) {
      fail(`${b.capability}: unknown capability/provider`);
      continue;
    }
    if (
      b.provider_dependency !== c.provider_dependency ||
      !p.decision_ids.includes(b.provider_dependency)
    )
      fail(`${b.capability}: wrong decision linkage`);
    if (b.version !== p.version || /latest|\*/i.test(b.version))
      fail(`${b.capability}: unpinned provider boundary`);
    if (
      b.effect !== c.effect ||
      JSON.stringify([...b.hosts].sort()) !== JSON.stringify(["standalone"])
    )
      fail(`${b.capability}: effect or surface drift`);
    if (
      !["api", "model", "runtime", "projection", "internal", "human_handoff"].includes(b.mode) ||
      !b.operations?.length ||
      b.operations.some((x) => typeof x !== "string" || !x.trim()) ||
      !b.readback?.trim() ||
      !b.logical_idempotency?.trim() ||
      !b.unknown_outcome?.trim()
    )
      fail(`${b.capability}: missing operation/outcome contract`);
    if (
      !Array.isArray(b.required_scopes) ||
      b.required_scopes.some(
        (x) => typeof x !== "string" || !x.trim() || x.includes("*") || x === "write:all",
      )
    )
      fail(`${b.capability}: unrestricted or invalid scope`);
    if (b.activation !== "blocked" || b.scope_status !== "pending_conformance")
      fail(`${b.capability}: provider access is not qualified`);
    if (b.mode === "api" && !b.sources.length) fail(`${b.capability}: external API lacks source`);
    for (const id of b.sources)
      if (sourceMap.get(id)?.status !== "verified")
        fail(`${b.capability}: unverified documentary source ${id}`);
    if (
      !b.conformance_tasks.length ||
      b.conformance_tasks.some((id) => !c.implementation_tasks.includes(id))
    )
      fail(`${b.capability}: missing implementation/conformance linkage`);
  }
  for (const id of caps.keys()) if (!seen.has(id)) fail(`${id}: missing provider binding`);
  return errors;
}

// The model catalogue (ADR-0022 items 10, 11 and 16): opaque keys, adaptive
// thinking only, a broker-held adapter for every provider, caps that fit at
// least one product, no selection whose worst case per product exceeds the
// margin of its credits' net revenue, and published versions that never change.
// ADR-0036 removed the unrecovered-cost cap: only version 1, published before it,
// carries `workspace_period_unrecovered_cost_cap_usd` (pinned, still within the
// rest of the plan revenue, and enforced nowhere); any other version that carries
// one is refused.
// ADR-0039 made credits the only spend limit: only versions 1 and 3, published before it,
// carry `run_cost_cap_usd` and `workspace_daily_cost_cap_usd` (pinned, checked as published,
// and enforced nowhere once version 4 is active). A per-product version after 3 that carries
// either, and a loop version that carries any money cap, is refused; the margin rules stay.
// The owner chose the best model for every agent (2026-10-26, in chat: "we don't want to cheap
// out on models"): from version 4, a version of either run shape holds only Claude Opus
// entries, and a Haiku or Sonnet entry is refused. Versions 1 to 3 keep theirs as published
// (1 and 3) or proposed (the loop's 2).
export const OPUS_ONLY_FROM_VERSION = 4;
export const UNRECOVERED_CAP_VERSIONS = Object.freeze([1]);
export const COST_CAP_VERSIONS = Object.freeze([1, 3]);
/**
 * A Claude Opus model: Anthropic's, an opus key and the provider model ID that spells the same
 * name (claude_opus_5_5 is claude-opus-5-5), so a key never names one model and calls another.
 */
export const isOpusModel = (model) =>
  model?.provider === "anthropic" &&
  typeof model.key === "string" &&
  /^claude_opus_[0-9]+(_[0-9]+)*$/.test(model.key) &&
  model.provider_model_id === model.key.replaceAll("_", "-");
const refuseNonOpus = (entry, model, fail) => {
  if (
    Number.isInteger(entry.version) &&
    entry.version >= OPUS_ONLY_FROM_VERSION &&
    !isOpusModel(model)
  )
    fail(`${model.key} is not a Claude Opus model; from version 4 every entry is Opus`);
};
const unrecoveredCapField = "workspace_period_unrecovered_cost_cap_usd";
const costCapFields = Object.freeze(["run_cost_cap_usd", "workspace_daily_cost_cap_usd"]);
const loopMoneyCapFields = Object.freeze([
  ...costCapFields,
  "look_for_work_daily_cost_cap_usd",
  unrecoveredCapField,
]);
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const VERSION_STATUSES = ["proposed", "active", "retired"];
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDecimal = (value) => typeof value === "string" && DECIMAL.test(value);
const isCount = (value) => Number.isInteger(value) && value >= 1;
// A decimal string scaled to an integer number of 10^-places units.
const scaled = (text, places) => {
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, "0") || "0");
};
// 10^-12 USD units as a decimal string with six places, for reports.
const usd = (units) => {
  const micros = units / 1_000_000n;
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, "0")}`;
};
const canonicalJson = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

// The digest pinned for a published catalogue version. It leaves out `status`,
// so retiring a version keeps its digest, and covers everything else.
export function catalogueVersionDigest(entry) {
  const { status: _status, ...content } = entry;
  return sha(canonicalJson(content));
}

// The two run shapes of the catalogue (PR 10): a version without `run_shape` is a
// per-product version (listings-run@1, ADR-0022); `agent_loop` is a loop version
// (agent-run@1, ADR-0027). Each shape has its own active pointer in `active_versions`.
export const RUN_SHAPES = ["per_product", "agent_loop"];
export const runShapeOf = (entry) =>
  entry.run_shape === undefined ? "per_product" : entry.run_shape;

// A loop version (ADR-0027 items 6 and 12; PR 10): per-turn prices of four token kinds, no
// per-product credits (the rate card prices runs, ADR-0026 item 5). Every entry's worst-case
// turn is the input cap at the 5-minute cache-write rate (the dearest input rate) plus the
// effort's whole max_tokens at the output rate; it must fit one call budget of at most 600 s
// at the 128,000-tokens-an-hour floor. No loop version carries a money cap (ADR-0039 item 1:
// the run and daily backstops, the look-for-work cap and the unrecovered-cost cap are gone);
// a run's turns hold and draw credits from the wallet.
export const LOOP_KINDS = ["coordinator", "specialist", "installed"];
const LOOP_LIMITS = {
  max_input_tokens_per_turn: [1, 64000],
  max_turns_per_run: [2, 16],
  max_turns_per_coordinator_run: [1, 16],
  max_tool_calls_per_turn: [1, 4],
  max_tool_calls_per_run: [1, 40],
  max_questions_per_run: [0, 2],
  question_wait_hours: [1, 72],
  wall_time_minutes: [1, 30],
  specialist_default_run_minutes: [1, 480],
  specialist_max_run_minutes: [1, 480],
  tool_result_max_bytes: [1, 8192],
};
// modelCallBudgetMs (packages/identity/src/broker-protocol.ts) at an effort's max_tokens:
// fence 10 s, count 15 s, first token 30 s, the floor rate and the close's second.
export const loopCallBudgetMs = (maxOutputTokens) =>
  10_000 + 15_000 + 30_000 + Math.ceil((maxOutputTokens * 3_600_000) / 128_000) + 1_000;
function inspectLoopCatalogueVersion(entry, adapters) {
  const errors = [];
  const selections = [];
  const fail = (message) => errors.push(`model catalogue v${entry.version}: ${message}`);
  const efforts = new Map();
  for (const effort of entry.efforts ?? []) {
    const request = effort.request ?? {};
    // No xhigh or max at launch: the send is non-streaming (ADR-0027 item 12).
    if (!["low", "medium", "high"].includes(effort.key) || efforts.has(effort.key))
      fail(`invalid loop effort ${effort.key}`);
    if (
      JSON.stringify(Object.keys(request).sort()) !== '["output_config","thinking"]' ||
      JSON.stringify(request.thinking) !== '{"type":"adaptive"}' ||
      JSON.stringify(request.output_config) !== JSON.stringify({ effort: effort.key }) ||
      !isCount(effort.max_output_tokens) ||
      !isCount(effort.expected_output_tokens) ||
      effort.expected_output_tokens > effort.max_output_tokens
    )
      fail(`effort ${effort.key} must map to adaptive thinking and its own level`);
    else if (loopCallBudgetMs(effort.max_output_tokens) > 600_000)
      fail(`effort ${effort.key}: one call's budget exceeds 600 s`);
    efforts.set(effort.key, effort);
  }
  if (efforts.size === 0) fail("no effort levels");
  const limits = entry.limits ?? {};
  for (const [key, [min, max]] of Object.entries(LOOP_LIMITS))
    if (!Number.isInteger(limits[key]) || limits[key] < min || limits[key] > max)
      fail(`loop limit ${key} must be ${min} to ${max}`);
  if (limits.max_turns_per_coordinator_run > limits.max_turns_per_run)
    fail("the Coordinator's turn limit exceeds the run's");
  if (limits.specialist_default_run_minutes > limits.specialist_max_run_minutes)
    fail("the specialist default run exceeds its maximum");
  // No money cap (ADR-0039 item 1): not the run or daily backstop, not the look-for-work cap
  // (ADR-0036 item 7 set it; ADR-0039 removed it) and not the unrecovered-cost cap (ADR-0036).
  if (Object.hasOwn(limits, unrecoveredCapField))
    fail("carries an unrecovered-cost cap, which ADR-0036 removed");
  for (const field of loopMoneyCapFields)
    if (field !== unrecoveredCapField && Object.hasOwn(limits, field))
      fail(`carries ${field}, a money cap, which ADR-0039 removed`);
  const expected = entry.expected_turn ?? {};
  if (
    !isCount(expected.input_tokens) ||
    !isCount(expected.cached_prefix_tokens) ||
    expected.cached_prefix_tokens > expected.input_tokens ||
    expected.input_tokens > (limits.max_input_tokens_per_turn ?? 0)
  )
    fail("the expected turn must fit the input cap");
  const inputCap = limits.max_input_tokens_per_turn;
  const models = new Map();
  for (const model of entry.models ?? []) {
    const price = model.rates_usd_per_million_tokens ?? {};
    if (!KEY.test(model.key ?? "") || models.has(model.key)) fail(`invalid model key ${model.key}`);
    models.set(model.key, model);
    if (!adapters.has(model.provider))
      fail(`${model.key} has no broker adapter for ${model.provider}`);
    if (
      typeof model.provider_model_id !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(model.provider_model_id) ||
      /latest/.test(model.provider_model_id)
    )
      fail(`${model.key} has an unpinned provider model`);
    refuseNonOpus(entry, model, fail);
    const kinds = ["input", "output", "cache_write_5m", "cache_read"];
    const priced =
      JSON.stringify(Object.keys(price).sort()) === JSON.stringify([...kinds].sort()) &&
      kinds.every((kind) => isDecimal(price[kind]));
    if (!priced) {
      fail(`${model.key} needs a rate for each token kind`);
      continue;
    }
    // The cache write is the dearest input rate, and a read the cheapest (owner question 3).
    if (
      scaled(price.cache_write_5m, 6) < scaled(price.input, 6) ||
      scaled(price.cache_read, 6) > scaled(price.input, 6)
    )
      fail(`${model.key}: cache rates out of order`);
    const tier = model.rate_tier_max_input_tokens;
    if (tier !== null && !isCount(tier)) fail(`${model.key} has no declared price tier`);
    else if (isCount(tier) && isCount(inputCap) && inputCap > tier)
      fail(`${model.key}: the input cap leaves its price tier`);
    for (const [key, effort] of efforts) {
      if (
        !Number.isInteger(model.max_output_tokens) ||
        effort.max_output_tokens > model.max_output_tokens
      )
        fail(`${model.key} at ${key} exceeds the model's output limit`);
      if (!isCount(inputCap) || !isCount(effort.max_output_tokens)) continue;
      // 10^-12 USD: a per-million rate scaled by 10^6 is the per-token price.
      const worst =
        BigInt(inputCap) * scaled(price.cache_write_5m, 6) +
        BigInt(effort.max_output_tokens) * scaled(price.output, 6);
      selections.push({
        model: model.key,
        effort: key,
        worst_case_turn_usd: usd(worst),
        call_budget_ms: loopCallBudgetMs(effort.max_output_tokens),
      });
    }
  }
  if (models.size === 0) fail("no models");
  const profiles = entry.default_profiles ?? {};
  if (JSON.stringify(Object.keys(profiles).sort()) !== JSON.stringify([...LOOP_KINDS].sort()))
    fail("default profiles must name the Coordinator, specialists and installed agents");
  for (const kind of LOOP_KINDS) {
    const profile = profiles[kind] ?? {};
    if (
      JSON.stringify(Object.keys(profile).sort()) !== '["effort","model"]' ||
      !models.has(profile.model) ||
      !efforts.has(profile.effort)
    )
      fail(`the ${kind} default profile must be an entry of this version`);
  }
  return { errors, selections };
}

function inspectCatalogueVersion(entry, adapters) {
  if (entry.run_shape === "agent_loop") return inspectLoopCatalogueVersion(entry, adapters);
  if (entry.run_shape !== undefined)
    return {
      errors: [`model catalogue v${entry.version}: unknown run shape ${entry.run_shape}`],
      selections: [],
    };
  const errors = [];
  const selections = [];
  const fail = (message) => errors.push(`model catalogue v${entry.version}: ${message}`);
  const efforts = new Map();
  for (const effort of entry.efforts ?? []) {
    const request = effort.request ?? {};
    if (!EFFORT_LEVELS.includes(effort.key) || efforts.has(effort.key))
      fail(`invalid effort ${effort.key}`);
    if (
      JSON.stringify(Object.keys(request).sort()) !== '["output_config","thinking"]' ||
      JSON.stringify(request.thinking) !== '{"type":"adaptive"}' ||
      JSON.stringify(request.output_config) !== JSON.stringify({ effort: effort.key }) ||
      !isCount(effort.max_output_tokens)
    )
      fail(`effort ${effort.key} must map to adaptive thinking and its own level`);
    efforts.set(effort.key, effort);
  }
  if (efforts.size === 0) fail("no effort levels");

  const limits = entry.limits ?? {};
  const inputCap = limits.max_input_tokens_per_call;
  const attempts = limits.max_attempts_per_product;
  const maxProducts = limits.max_products_per_run;
  if (!isCount(inputCap) || !isCount(attempts) || !isCount(maxProducts))
    fail("missing per-call or per-run limits");
  if (
    !isCount(limits.max_consecutive_failed_products) ||
    limits.max_consecutive_failed_products > maxProducts
  )
    fail("the failure breaker must stop a run within its product limit");
  // The per-run and per-day caps, on versions 1 and 3 only (published before ADR-0039 and
  // checked as published; enforced nowhere once version 4 is active); version 1 alone also
  // carries its unrecovered-cost cap, enforced nowhere since ADR-0036. A later version that
  // carries either cost cap is refused: credits are the only spend limit (ADR-0039 item 1).
  const carriesCostCaps = COST_CAP_VERSIONS.includes(entry.version);
  const carriesUnrecoveredCap = UNRECOVERED_CAP_VERSIONS.includes(entry.version);
  const caps = carriesCostCaps
    ? [limits.run_cost_cap_usd, limits.workspace_daily_cost_cap_usd]
    : [];
  if (carriesUnrecoveredCap) caps.push(limits[unrecoveredCapField]);
  else if (Object.hasOwn(limits, unrecoveredCapField))
    fail("carries an unrecovered-cost cap, which ADR-0036 removed");
  if (!carriesCostCaps && costCapFields.some((field) => Object.hasOwn(limits, field)))
    fail("carries a run or daily cost cap, which ADR-0039 removed");
  let runCap = null;
  let unrecoveredCap = null;
  if (!caps.every(isDecimal) || caps.some((cap) => scaled(cap, 12) === 0n))
    fail("missing USD caps");
  else if (carriesCostCaps) {
    runCap = scaled(limits.run_cost_cap_usd, 12);
    if (carriesUnrecoveredCap) unrecoveredCap = scaled(limits[unrecoveredCapField], 12);
    if (scaled(limits.workspace_daily_cost_cap_usd, 12) < runCap)
      fail("the daily cap is below the run cap");
  }

  const economics = entry.economics ?? {};
  const planCredits = economics.plan_credits;
  const rates = [
    economics.card_fee_rate,
    economics.billing_fee_rate,
    economics.tax_fee_rate,
    economics.international_card_fee_rate,
  ];
  let netRevenue = null;
  let sharePpm = null;
  if (
    !isCount(planCredits) ||
    ![
      economics.plan_price_usd,
      economics.card_fee_fixed_usd,
      economics.max_worst_case_share,
      ...rates,
    ].every(isDecimal)
  )
    fail("missing plan economics");
  else {
    // Units of 10^-12 USD; fee rates and the margin share in parts per million.
    const price = scaled(economics.plan_price_usd, 12);
    const feePpm = rates.reduce((sum, rate) => sum + scaled(rate, 6), 0n);
    netRevenue = price - (price * feePpm) / 1_000_000n - scaled(economics.card_fee_fixed_usd, 12);
    sharePpm = scaled(economics.max_worst_case_share, 6);
    if (netRevenue <= 0n || sharePpm === 0n || sharePpm > 1_000_000n) {
      fail("plan economics leave no revenue or no valid margin");
      netRevenue = null;
    } else if (
      unrecoveredCap !== null &&
      unrecoveredCap * 1_000_000n > netRevenue * (1_000_000n - sharePpm)
    )
      fail("the unrecovered-cost cap exceeds the plan revenue the margin leaves");
  }

  const models = new Map();
  for (const model of entry.models ?? []) {
    const price = model.rates_usd_per_million_tokens ?? {};
    const credits = model.credits_per_product ?? {};
    if (!KEY.test(model.key ?? "") || models.has(model.key)) fail(`invalid model key ${model.key}`);
    models.set(model.key, model);
    if (!adapters.has(model.provider))
      fail(`${model.key} has no broker adapter for ${model.provider}`);
    if (
      typeof model.provider_model_id !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(model.provider_model_id) ||
      /latest/.test(model.provider_model_id)
    )
      fail(`${model.key} has an unpinned provider model`);
    refuseNonOpus(entry, model, fail);
    const priced = isDecimal(price.input) && isDecimal(price.output);
    if (!priced) fail(`${model.key} has no rates`);
    // The catalogue prices one tier; null means one price for the whole context.
    const tier = model.rate_tier_max_input_tokens;
    if (tier !== null && !isCount(tier)) fail(`${model.key} has no declared price tier`);
    else if (isCount(tier) && isCount(inputCap) && inputCap > tier)
      fail(`${model.key}: the input cap leaves its price tier`);
    if (Object.keys(credits).some((key) => !efforts.has(key)))
      fail(`${model.key} prices an uncatalogued effort`);
    for (const [key, effort] of efforts) {
      const units = credits[key];
      if (!isCount(units)) {
        fail(`${model.key} at ${key} has no credit multiplier`);
        continue;
      }
      if (
        !Number.isInteger(model.max_output_tokens) ||
        effort.max_output_tokens > model.max_output_tokens
      )
        fail(`${model.key} at ${key} exceeds the model's output limit`);
      if (!priced || !isCount(inputCap) || !isCount(attempts) || !isCount(effort.max_output_tokens))
        continue;
      // Per-token prices in 10^-12 USD: a rate per million tokens scaled by 10^6.
      const worst =
        BigInt(attempts) *
        (BigInt(inputCap) * scaled(price.input, 6) +
          BigInt(effort.max_output_tokens) * scaled(price.output, 6));
      if (
        netRevenue !== null &&
        worst * BigInt(planCredits) * 1_000_000n > BigInt(units) * netRevenue * sharePpm
      )
        fail(
          `${model.key} at ${key} worst case exceeds ${economics.max_worst_case_share} of its credits' net revenue`,
        );
      // A version with a run cap (1 and 3) admits the lower of its product limit and the cap
      // over the worst case; from version 4 every entry admits the product limit (ADR-0039
      // item 4), held up front in credits.
      let productsPerRun = null;
      if (runCap !== null && isCount(maxProducts)) {
        const fit = worst === 0n ? BigInt(maxProducts) : runCap / worst;
        productsPerRun = Number(fit < BigInt(maxProducts) ? fit : BigInt(maxProducts));
        if (productsPerRun < 1)
          fail(`${model.key} at ${key} does not fit one product in the run cap`);
      } else if (!carriesCostCaps && isCount(maxProducts)) productsPerRun = maxProducts;
      selections.push({
        model: model.key,
        effort: key,
        credits_per_product: units,
        worst_case_usd: usd(worst),
        products_per_run: productsPerRun,
      });
    }
  }
  if (models.size === 0) fail("no models");
  // The default selection is an entry of its version. It cost one credit until ADR-0036 made
  // Opus 5.5 at medium the default (four credits). The default member ceiling admits it and is
  // exactly its credits, so the ceiling follows the default and is never raised on its own.
  const preset = entry.default_selection ?? {};
  const presetCredits = models.get(preset.model)?.credits_per_product?.[preset.effort];
  if (
    JSON.stringify(Object.keys(preset).sort()) !== '["effort","model"]' ||
    !efforts.has(preset.effort) ||
    !isCount(presetCredits)
  )
    fail("the default selection must be an entry of this version");
  if (
    !isCount(entry.default_member_credit_ceiling) ||
    entry.default_member_credit_ceiling < (presetCredits ?? 1)
  )
    fail("the default member ceiling must admit the default selection");
  else if (isCount(presetCredits) && entry.default_member_credit_ceiling !== presetCredits)
    fail("the default member ceiling must be the default selection's credits");
  return { errors, selections };
}

export function inspectModelPolicy(policy, registry) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const gateway = policy.gateway ?? {};
  const data = policy.data_policy ?? {};
  const catalogue = policy.catalogue ?? {};
  if (policy.schema_version !== 3) fail("model policy: unsupported schema version");
  if (
    gateway.automatic_fallback !== false ||
    gateway.provider_side_fallback !== false ||
    gateway.client_model_strings !== "refused" ||
    gateway.credential_holder !== "broker"
  )
    fail("model policy: fallback, client model string or credential holder drift");
  if (
    data.regional_project_status !== "not_verified" ||
    data.zero_data_retention_status !== "not_granted" ||
    !Array.isArray(data.stateful_features) ||
    data.stateful_features.length !== 0
  )
    fail("Unsupported model data/access claim");
  // The loop's request fields (ADR-0027 item 4; PR 10): strict tools, auto (none on the final
  // turn), no stream, and never a fallback, sampling, region or server-side feature.
  const loop = policy.loop_request ?? {};
  const neverSent = Array.isArray(loop.never_sent) ? loop.never_sent : [];
  const sent = Array.isArray(loop.sent) ? loop.sent : [];
  if (
    gateway.loop_call_contract !== "ModelCall@2" ||
    gateway.loop_result_contract !== "ModelResult@2" ||
    gateway.profile_contract !== "ModelProfile@1" ||
    loop.stream !== false ||
    loop.strict_tools !== true ||
    JSON.stringify(loop.tool_choice) !== '{"default":"auto","final_turn":"none"}' ||
    JSON.stringify(loop.thinking) !== '{"type":"adaptive"}' ||
    JSON.stringify(loop.tool_definition_fields) !==
      '["name","description","input_schema","strict"]' ||
    ["fallbacks", "temperature", "inference_geo", "stream", "mcp_servers", "container"].some(
      (field) => !neverSent.includes(field),
    ) ||
    sent.some((field) => neverSent.includes(field)) ||
    [...sent].sort().join() !==
      "cache_control,max_tokens,messages,model,output_config,system,thinking,tool_choice,tools"
  )
    fail("model policy: the loop's sent and never-sent fields drifted");
  const selected = new Set(
    registry.providers.filter((p) => p.design_status === "selected").map((p) => p.id),
  );
  const adapters = new Set();
  for (const adapter of gateway.adapters ?? []) {
    if (
      !selected.has(adapter.provider) ||
      adapters.has(adapter.provider) ||
      adapter.sdk_retries !== 0
    )
      fail(`model policy: invalid adapter ${adapter.provider}`);
    adapters.add(adapter.provider);
  }

  const versions = Array.isArray(catalogue.versions) ? catalogue.versions : [];
  const pinned = catalogue.published_digests ?? {};
  if (versions.length === 0) fail("model catalogue: no versions");
  if (versions.some((entry) => !VERSION_STATUSES.includes(entry.status)))
    fail("model catalogue: a version has an unknown status");
  // Each run shape has its own active pointer (ADR-0027 item 4; PR 10): version 1 stays active
  // for listings-run@1 while a loop version publishes. Within one shape, statuses run
  // retired*, active?, proposed*; versions count up from 1 across both shapes.
  if (Object.hasOwn(catalogue, "active_version"))
    fail("model catalogue: active_version is replaced by active_versions, one per run shape");
  const pointers = catalogue.active_versions;
  if (
    pointers === null ||
    typeof pointers !== "object" ||
    Array.isArray(pointers) ||
    JSON.stringify(Object.keys(pointers).sort()) !== JSON.stringify([...RUN_SHAPES].sort())
  )
    fail(`model catalogue: active_versions must name exactly ${RUN_SHAPES.join(" and ")}`);
  for (const shape of RUN_SHAPES) {
    const own = versions.filter((entry) => runShapeOf(entry) === shape);
    const order = own.map((entry) => entry.status?.[0] ?? "?").join("");
    if (!/^r*a?p*$/.test(order))
      fail(
        `model catalogue: ${shape} statuses must run retired, then at most one active, then proposed`,
      );
    const active = own.filter((entry) => entry.status === "active");
    const pointer = pointers?.[shape];
    if (pointer !== null && !Number.isInteger(pointer))
      fail(`model catalogue: active_versions.${shape} must be a version number or null`);
    else if ((pointer ?? null) !== (active[0]?.version ?? null))
      fail(`model catalogue: active_versions.${shape} does not name its active version`);
  }
  const report = [];
  versions.forEach((entry, index) => {
    if (entry.version !== index + 1)
      fail(`model catalogue: version ${entry.version} out of sequence`);
    const digest = catalogueVersionDigest(entry);
    const published = entry.status === "active" || entry.status === "retired";
    if (published) {
      if (typeof entry.owner_confirmation !== "string" || entry.owner_confirmation.trim() === "")
        fail(
          `model catalogue: version ${entry.version} is published without the owner's confirmation`,
        );
      if (!DATE.test(entry.effective_from ?? ""))
        fail(`model catalogue: version ${entry.version} is published without an effective date`);
      if (!Object.hasOwn(pinned, String(entry.version)))
        fail(`model catalogue: version ${entry.version} is published without a pinned digest`);
      else if (pinned[String(entry.version)] !== digest)
        fail(`model catalogue: version ${entry.version} changed since it was published`);
    } else if (Object.hasOwn(pinned, String(entry.version)))
      fail(`model catalogue: proposed version ${entry.version} has a pinned digest`);
    const inspected = inspectCatalogueVersion(entry, adapters);
    errors.push(...inspected.errors);
    report.push({
      version: entry.version,
      status: entry.status,
      digest,
      selections: inspected.selections,
    });
  });
  for (const key of Object.keys(pinned))
    if (!versions.some((entry) => String(entry.version) === key))
      fail(`model catalogue: published version ${key} was removed`);
  return { errors, versions: report };
}

export const validateModelPolicy = (policy, registry) =>
  inspectModelPolicy(policy, registry).errors;

// A recorded design can make a local implementation task ready while live
// activation remains blocked. This is a planning result, never an access grant.
export function inspectReadiness(packet, decisions) {
  const reasons = [];
  const byId = new Map(decisions.map((d) => [d.id, d]));
  if (!Array.isArray(packet.consumedDecisions) || !packet.consumedDecisions.length)
    reasons.push("DECISION_INPUTS_MISSING");
  for (const id of packet.consumedDecisions ?? []) {
    const d = byId.get(id);
    if (!d || d.status !== "recorded" || !d.reviewRef)
      reasons.push(`STRUCTURAL_DECISION_UNRESOLVED:${id}`);
  }
  if (!packet.acceptanceIds?.length || !packet.verification?.length)
    reasons.push("ACCEPTANCE_OR_VERIFICATION_MISSING");
  if (packet.requiresControlledAccount && !packet.controlledAccountRef)
    reasons.push("CONTROLLED_ACCOUNT_MISSING");
  if (packet.requiresQualifiedPackage && packet.packageInputStatus !== "qualified")
    reasons.push("PACKAGE_INPUT_UNQUALIFIED");
  return { ready: reasons.length === 0, reasons };
}

// Used ONLY to challenge the distinction between planning and activation with
// synthetic facts. No documentary "verified" flag is accepted as a grant.
export function inspectSyntheticActivation(facts) {
  const reasons = [];
  if (facts.host !== "standalone") reasons.push("HOST_INVALID");
  if (facts.engineering !== "qualified") reasons.push("ENGINEERING_UNQUALIFIED");
  if (facts.controlledTest !== "passed") reasons.push("CONTROLLED_TEST_UNQUALIFIED");
  if (
    facts.productionReviewRequired &&
    (facts.productionReview !== "granted" || !facts.productionReviewRef)
  )
    reasons.push("PRODUCTION_PERMISSION_PENDING");
  if (!facts.currentAccountPermission) reasons.push("ACCOUNT_PERMISSION_MISSING");
  if (!facts.currentActorPermission) reasons.push("ACTOR_PERMISSION_MISSING");
  if (!facts.currentRegionAndRetention) reasons.push("DATA_POLICY_UNQUALIFIED");
  if (facts.requiresSpend && !facts.budgetReserved) reasons.push("BUDGET_NOT_RESERVED");
  if (facts.requiresReview && !facts.exactCurrentApproval) reasons.push("EXACT_APPROVAL_MISSING");
  if (facts.remainingStructuralGap) reasons.push("STRUCTURAL_GAP");
  return { allowed: reasons.length === 0, reasons };
}
