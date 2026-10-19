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
// margin of its credits' net revenue, an unrecovered-cost cap within the rest,
// and published versions that never change.
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

function inspectCatalogueVersion(entry, adapters) {
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
  const caps = [
    limits.run_cost_cap_usd,
    limits.workspace_daily_cost_cap_usd,
    limits.workspace_period_unrecovered_cost_cap_usd,
  ];
  let runCap = null;
  let unrecoveredCap = null;
  if (!caps.every(isDecimal) || caps.some((cap) => scaled(cap, 12) === 0n))
    fail("missing USD caps");
  else {
    runCap = scaled(limits.run_cost_cap_usd, 12);
    unrecoveredCap = scaled(limits.workspace_period_unrecovered_cost_cap_usd, 12);
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
      let productsPerRun = null;
      if (runCap !== null && isCount(maxProducts)) {
        const fit = worst === 0n ? BigInt(maxProducts) : runCap / worst;
        productsPerRun = Number(fit < BigInt(maxProducts) ? fit : BigInt(maxProducts));
        if (productsPerRun < 1)
          fail(`${model.key} at ${key} does not fit one product in the run cap`);
      }
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
  const preset = entry.default_selection ?? {};
  const presetCredits = models.get(preset.model)?.credits_per_product?.[preset.effort];
  if (presetCredits !== 1) fail("the default selection must exist and cost one credit");
  if (
    !isCount(entry.default_member_credit_ceiling) ||
    entry.default_member_credit_ceiling < (presetCredits ?? 1)
  )
    fail("the default member ceiling must admit the default selection");
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
  // Statuses run retired*, active?, proposed*, and versions count up from 1.
  const order = versions.map((entry) => entry.status?.[0] ?? "?").join("");
  if (!/^r*a?p*$/.test(order) || versions.some((entry) => !VERSION_STATUSES.includes(entry.status)))
    fail("model catalogue: statuses must run retired, then at most one active, then proposed");
  const active = versions.filter((entry) => entry.status === "active");
  if ((catalogue.active_version ?? null) !== (active[0]?.version ?? null))
    fail("model catalogue: active_version does not name the active version");
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
