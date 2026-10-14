import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  selectedConfiguration,
  compileSelectedConfiguration,
  inspectSelectedConfiguration,
} from "../packages/infrastructure/src/selected-stack.ts";
import { estimateStackComponents } from "../scripts/stack-cost.mjs";
import { estimateStackComponents as estimateLegacyDaytonaComponents } from "../docs/decisions/archive/daytona-selection-54/scripts/stack-cost.mjs";
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const model = read("docs/decisions/cost-model.json");

test("selected environment inventories are distinct and remain non-activating", () => {
  const configs = ["development", "staging", "production"].map((env) =>
    read(`infra/environments/${env}.json`),
  );
  const results = configs.map(compileSelectedConfiguration);
  assert.equal(new Set(results.map((r) => r.configuration_sha256)).size, 3);
  assert.equal(new Set(configs.flatMap((c) => Object.values(c.cloudflare.buckets))).size, 9);
  for (const r of results) {
    assert.equal(r.deployment_entrypoint, false);
    assert.equal(r.resource_creation, false);
    assert.equal(r.provider_calls, false);
  }
  assert.equal(configs[2].neon.pitr_days, 30);
  assert.equal(configs[2].neon.daily_recovery_days, 35);
  assert.equal(configs[2].runtime.provider, "e2b");
  assert.equal(configs[2].runtime.sandbox_class, "linux_microvm");
  for (const config of configs) {
    assert.equal(config.stack, "cloudflare-neon-runtime");
    assert.equal("daytona" in config, false);
    for (const key of ["project_id", "region", "template_id", "template_build_id", "image_digest"])
      assert.equal(config.runtime[key], null);
    assert.equal(config.runtime.dispatch, "disabled");
  }
});
test("configuration digest is independent of JSON key ordering", () => {
  const config = selectedConfiguration("staging", 59);
  const reordered = Object.fromEntries(Object.entries(config).reverse());
  assert.equal(
    compileSelectedConfiguration(config).configuration_sha256,
    compileSelectedConfiguration(reordered).configuration_sha256,
  );
});
test("selected runtime registry, policy and neutral capability routes agree", () => {
  const registry = read("docs/decisions/providers.json");
  assert.equal(
    registry.providers.some((provider) => provider.id === "daytona"),
    false,
  );
  const runtime = registry.providers.find((provider) => provider.id === "e2b");
  assert.equal(runtime.design_status, "selected");
  assert.equal(runtime.activation, "blocked");
  assert.equal(runtime.controlled_test_status, "not_run");
  assert.deepEqual(runtime.qualification_evidence, []);
  const policy = read("docs/decisions/deployment-policy.json");
  assert.equal(policy.stack, "cloudflare-neon-runtime");
  assert.equal(policy.runtime.provider, "E2B");
  assert.equal(policy.runtime.sandbox_class, "linux_microvm");
  assert.equal(policy.runtime.provider_replaceable, true);
  assert.equal(policy.runtime.existing_operation_provider_pinned, true);
  assert.equal(policy.runtime.dispatch, "disabled");
  const routes = read("docs/decisions/provider-bindings.json").bindings.filter(
    (route) => route.mode === "runtime",
  );
  assert.ok(routes.length > 0);
  assert.ok(routes.every((route) => ["public_web", "morrow"].includes(route.provider)));
});
test("non-finite and cyclic configuration values cannot masquerade as null selectors", () => {
  for (const invalid of [NaN, Infinity, undefined]) {
    const config = selectedConfiguration("staging", 59);
    config.cloudflare.account_id = invalid;
    assert.deepEqual(inspectSelectedConfiguration(config), ["INVALID_CONFIGURATION_VALUE"]);
  }
  const config = selectedConfiguration("staging", 59);
  config.quote = config;
  assert.deepEqual(inspectSelectedConfiguration(config), ["INVALID_CONFIGURATION_VALUE"]);
});
for (const [name, change] of [
  ["direct sandbox internet", (c) => (c.runtime.direct_internet = true)],
  ["default container class", (c) => (c.runtime.sandbox_class = "container")],
  ["silent Daytona fallback", (c) => (c.runtime.provider = "daytona")],
  ["unknown provider fallback", (c) => (c.runtime.provider = "invented")],
  ["wrong VM profile", (c) => (c.runtime.sandbox_class = "linux_vm")],
  ["forged runtime project", (c) => (c.runtime.project_id = "unqualified")],
  ["assumed region", (c) => (c.runtime.region = "us-west-1")],
  ["unpinned template", (c) => (c.runtime.template_id = "base")],
  ["forged build binding", (c) => (c.runtime.template_build_id = "unqualified-build")],
  ["public preview", (c) => (c.runtime.public_preview = true)],
  ["merchant dispatch", (c) => (c.runtime.dispatch = "enabled")],
  ["database authority cache", (c) => (c.neon.authority_cache = true)],
  [
    "cross-environment bucket",
    (c) => (c.cloudflare.buckets.artifacts = "morrow-production-artifacts"),
  ],
  ["public credential broker", (c) => (c.cloudflare.broker_public_route = true)],
  ["invented account binding", (c) => (c.cloudflare.account_id = "unqualified-account")],
  ["invented JSON approval", (c) => (c.owner_cost_authorization = { approved: true })],
  ["unexpected credential field", (c) => (c.runtime.token = "synthetic")],
])
  test(`local selected inventory rejects ${name}`, () => {
    const config = selectedConfiguration("staging", 59);
    change(config);
    assert.deepEqual(inspectSelectedConfiguration(config), ["UNREVIEWED_CONFIGURATION_DELTA"]);
    assert.throws(() => compileSelectedConfiguration(config), /UNREVIEWED_CONFIGURATION_DELTA/);
  });
test("earlier hosting decisions and unknown environments cannot compile", () => {
  for (const revision of [44, 45, 54, 55, 56, 57, 58])
    assert.throws(() => selectedConfiguration("staging", revision), /UNRECORDED_STACK_DECISION/);
  assert.throws(() => selectedConfiguration("invented", 59), /UNKNOWN_ENVIRONMENT/);
});
test("E2B active arithmetic excludes unbound subscription and runtime meters", () => {
  const result = estimateStackComponents(model, model.example_usage);
  assert.equal(result.subtotal, "548.190000000");
  assert.equal(result.components.runtime_cpu, "201.600000000");
  assert.equal(result.components.runtime_memory, "129.600000000");
  assert.equal(
    Object.keys(result.components).some((key) => key.startsWith("daytona_")),
    false,
  );
  assert.equal(result.runtimeProvider, "e2b");
  assert.equal(result.runtimeQuoteBound, false);
  assert.equal(result.runtimePlan, null);
  assert.equal(result.runtimeSubscriptionAmount, null);
  assert.match(result.subtotalScope, /known_components_only/);
  assert.equal(result.components.neon_compute, "159.840000000");
  assert.equal(result.components.workflow_steps, "12.000000000");
  assert.equal(result.completeQuote, false);
  assert.equal(result.provisioningAuthorized, false);
});
test("zero E2B active time does not invent zero paused or subscription costs", () => {
  const usage = { ...model.example_usage, runtime_vcpu_seconds: "0", runtime_gib_seconds: "0" };
  const result = estimateStackComponents(model, usage);
  assert.equal(result.components.runtime_cpu, "0.000000000");
  assert.equal(result.components.runtime_memory, "0.000000000");
  assert.equal(result.runtimeSubscriptionAmount, null);
  assert.equal(result.completeQuote, false);
  assert.ok(result.missingRuntimeCosts.includes("PAUSED_RESOURCE_AND_OTHER_RUNTIME_METERS"));
  assert.equal(model.published_runtime_plans.Pro.subscription_amount, "150");
  assert.equal(model.published_runtime_plans.Hobby.subscription_amount, "0");
});
test("request/CPU shared allowances are applied once and R2 operation units round upward", () => {
  const usage = Object.fromEntries(model.usage_fields.map((key) => [key, "0"]));
  Object.assign(usage, {
    worker_requests: "10000001",
    worker_cpu_ms: "30000001",
    r2_class_a_operations: "1000001",
  });
  const result = estimateStackComponents(model, usage);
  assert.equal(result.components.workers_requests, "0.000000300");
  assert.equal(result.components.workers_cpu, "0.000000020");
  assert.equal(result.components.r2_writes, "4.500000000");
});
test("estimates reject missing usage, negative amounts, unsupported plans and hidden exclusions", () => {
  for (const value of [undefined, "-1", "NaN", 10])
    assert.throws(
      () => estimateStackComponents(model, { ...model.example_usage, runtime_vcpu_seconds: value }),
      /nonnegative decimal/,
    );
  assert.throws(
    () => estimateStackComponents({ ...model, exclusions: [] }, model.example_usage),
    /explicit exclusions/,
  );
  assert.throws(
    () => estimateStackComponents({ ...model, neon_plan: "unknown" }, model.example_usage),
    /Unknown Neon plan/,
  );
});
test("active pricing refuses legacy meters, provider substitution and invented plan binding", () => {
  const variants = [
    { runtime_provider: "daytona" },
    { runtime_provider: "invented" },
    { runtime_plan: "Hobby", runtime_subscription_amount: "0" },
    { runtime_plan: "Pro", runtime_subscription_amount: "150" },
    { runtime_quote: { approved: true } },
    { missing_runtime_costs: [] },
  ];
  for (const delta of variants)
    assert.throws(
      () => estimateStackComponents({ ...model, ...delta }, model.example_usage),
      /unbound/,
    );
  assert.throws(
    () =>
      estimateStackComponents(
        { ...model, rates: { ...model.rates, daytona_vcpu_hour: { amount: "0.0504" } } },
        model.example_usage,
      ),
    /legacy provider/,
  );
  assert.throws(
    () => estimateStackComponents(model, { ...model.example_usage, daytona_vcpu_hours: "1" }),
    /meter mismatch/,
  );
  const forged = structuredClone(model);
  forged.rates.e2b_vcpu_second.amount = "0";
  assert.throws(() => estimateStackComponents(forged, model.example_usage), /Unqualified E2B/);
});
test("exact previous Daytona inventory and cost arithmetic are retained as explicit history", () => {
  const manifest = read("docs/decisions/archive/daytona-selection-54/manifest.json");
  for (const entry of Object.values(manifest.entries))
    assert.equal(
      createHash("sha256").update(readFileSync(entry.archive)).digest("hex"),
      entry.sha256,
    );
  const previous = read("infra/archive/daytona-selection-54/environments/staging.json");
  assert.equal(previous.stack, "cloudflare-neon-daytona");
  assert.equal(previous.daytona.sandbox_class, "linux_vm");
  const legacy = read(model.legacy_cost_model);
  assert.equal(
    estimateLegacyDaytonaComponents(legacy, legacy.example_usage).subtotal,
    "859.230000000",
  );
  assert.throws(
    () => estimateStackComponents(legacy, legacy.example_usage),
    /explicit exclusions|Unsupported stack/,
  );
  const retained = read("infra/providers/daytona.json");
  assert.equal(retained.new_allocation, "disabled");
  assert.match(retained.original_operation_cleanup, /original_provider_account_profile_journal/);
  const selected = read("infra/providers/e2b.json");
  assert.equal(selected.status, "selected_not_qualified");
  assert.equal(selected.activation, "disabled");
  assert.deepEqual(selected.qualification_evidence, []);
});
