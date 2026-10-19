// Documentary gate checks for P01. This module cannot enable a connector or
// authorize dispatch. Later services must verify actual current evidence.
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

// The model catalogue (ADR-0022 items 10, 11 and 16): closed keys, adaptive
// thinking only, a broker-held adapter for every provider, and no selection
// whose worst case per product exceeds the revenue of the credits it costs.
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const DECIMAL = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/;
// A decimal string scaled to an integer number of 10^-places units.
const scaled = (text, places) => {
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, "0") || "0");
};

export function validateModelPolicy(policy, registry) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const gateway = policy.gateway ?? {};
  const data = policy.data_policy ?? {};
  const catalogue = policy.catalogue ?? {};
  if (policy.schema_version !== 2) fail("model policy: unsupported schema version");
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
  if (!Number.isInteger(catalogue.version) || catalogue.version < 1)
    fail("model catalogue: unversioned");
  const efforts = new Map();
  for (const effort of catalogue.efforts ?? []) {
    const request = effort.request ?? {};
    if (!EFFORT_LEVELS.includes(effort.key) || efforts.has(effort.key))
      fail(`model catalogue: invalid effort ${effort.key}`);
    if (
      JSON.stringify(Object.keys(request).sort()) !== '["output_config","thinking"]' ||
      JSON.stringify(request.thinking) !== '{"type":"adaptive"}' ||
      JSON.stringify(request.output_config) !== JSON.stringify({ effort: effort.key }) ||
      !Number.isInteger(effort.max_output_tokens) ||
      effort.max_output_tokens < 1
    )
      fail(`model catalogue: effort ${effort.key} must map to adaptive thinking and its own level`);
    efforts.set(effort.key, effort);
  }
  if (efforts.size === 0) fail("model catalogue: no effort levels");
  const limits = catalogue.limits ?? {};
  const inputCap = limits.max_input_tokens_per_call;
  const attempts = limits.max_attempts_per_product;
  if (!Number.isInteger(inputCap) || inputCap < 1 || !Number.isInteger(attempts) || attempts < 1)
    fail("model catalogue: missing per-call limits");
  const economics = catalogue.economics ?? {};
  const planCredits = economics.plan_credits;
  const amounts = [
    economics.plan_price_usd,
    economics.card_fee_rate,
    economics.card_fee_fixed_usd,
    economics.billing_fee_rate,
  ];
  let netRevenue = null;
  if (
    !Number.isInteger(planCredits) ||
    planCredits < 1 ||
    amounts.some((x) => !DECIMAL.test(x ?? ""))
  )
    fail("model catalogue: missing plan economics");
  else {
    // Units of 10^-12 USD; fee rates in parts per million.
    const price = scaled(economics.plan_price_usd, 12);
    const feePpm = scaled(economics.card_fee_rate, 6) + scaled(economics.billing_fee_rate, 6);
    netRevenue = price - (price * feePpm) / 1_000_000n - scaled(economics.card_fee_fixed_usd, 12);
  }
  const models = new Map();
  for (const model of catalogue.models ?? []) {
    const rates = model.rates_usd_per_million_tokens ?? {};
    const credits = model.credits_per_product ?? {};
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(model.key ?? "") || models.has(model.key))
      fail(`model catalogue: invalid model key ${model.key}`);
    models.set(model.key, model);
    if (!adapters.has(model.provider))
      fail(`model catalogue: ${model.key} has no broker adapter for ${model.provider}`);
    if (
      typeof model.provider_model_id !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(model.provider_model_id) ||
      /latest/.test(model.provider_model_id)
    )
      fail(`model catalogue: ${model.key} has an unpinned provider model`);
    if (!DECIMAL.test(rates.input ?? "") || !DECIMAL.test(rates.output ?? ""))
      fail(`model catalogue: ${model.key} has no rates`);
    if (Object.keys(credits).some((key) => !efforts.has(key)))
      fail(`model catalogue: ${model.key} prices an uncatalogued effort`);
    for (const [key, effort] of efforts) {
      const units = credits[key];
      if (!Number.isInteger(units) || units < 1) {
        fail(`model catalogue: ${model.key} at ${key} has no credit multiplier`);
        continue;
      }
      if (
        !Number.isInteger(model.max_output_tokens) ||
        effort.max_output_tokens > model.max_output_tokens
      )
        fail(`model catalogue: ${model.key} at ${key} exceeds the model's output limit`);
      if (
        netRevenue === null ||
        !DECIMAL.test(rates.input ?? "") ||
        !DECIMAL.test(rates.output ?? "")
      )
        continue;
      // Per-token prices in 10^-12 USD: a rate per million tokens scaled by 10^6.
      const worst =
        BigInt(attempts) *
        (BigInt(inputCap) * scaled(rates.input, 6) +
          BigInt(effort.max_output_tokens) * scaled(rates.output, 6));
      if (worst * BigInt(planCredits) > BigInt(units) * netRevenue)
        fail(`model catalogue: ${model.key} at ${key} can cost more than its credits earn`);
    }
  }
  if (models.size === 0) fail("model catalogue: no models");
  const preset = catalogue.default_selection ?? {};
  if (models.get(preset.model)?.credits_per_product?.[preset.effort] !== 1)
    fail("model catalogue: the default selection must exist and cost one credit");
  return errors;
}

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
