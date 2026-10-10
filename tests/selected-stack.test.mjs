import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  selectedConfiguration,
  compileSelectedConfiguration,
  inspectSelectedConfiguration,
} from "../packages/infrastructure/src/selected-stack.ts";
import { estimateStackComponents } from "../scripts/stack-cost.mjs";
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
  assert.equal(configs[2].daytona.sandbox_class, "linux_vm");
});
test("configuration digest is independent of JSON key ordering", () => {
  const config = selectedConfiguration("staging", 45);
  const reordered = Object.fromEntries(Object.entries(config).reverse());
  assert.equal(
    compileSelectedConfiguration(config).configuration_sha256,
    compileSelectedConfiguration(reordered).configuration_sha256,
  );
});
test("non-finite and cyclic configuration values cannot masquerade as null selectors", () => {
  for (const invalid of [NaN, Infinity, undefined]) {
    const config = selectedConfiguration("staging", 45);
    config.cloudflare.account_id = invalid;
    assert.deepEqual(inspectSelectedConfiguration(config), ["INVALID_CONFIGURATION_VALUE"]);
  }
  const config = selectedConfiguration("staging", 45);
  config.quote = config;
  assert.deepEqual(inspectSelectedConfiguration(config), ["INVALID_CONFIGURATION_VALUE"]);
});
for (const [name, change] of [
  ["direct sandbox internet", (c) => (c.daytona.direct_internet = true)],
  ["default container class", (c) => (c.daytona.sandbox_class = "container")],
  ["database authority cache", (c) => (c.neon.authority_cache = true)],
  [
    "cross-environment bucket",
    (c) => (c.cloudflare.buckets.artifacts = "morrow-production-artifacts"),
  ],
  ["public credential broker", (c) => (c.cloudflare.broker_public_route = true)],
  ["invented account binding", (c) => (c.cloudflare.account_id = "unqualified-account")],
  ["invented JSON approval", (c) => (c.owner_cost_authorization = { approved: true })],
  ["unexpected credential field", (c) => (c.daytona.token = "synthetic")],
])
  test(`local selected inventory rejects ${name}`, () => {
    const config = selectedConfiguration("staging", 45);
    change(config);
    assert.deepEqual(inspectSelectedConfiguration(config), ["UNREVIEWED_CONFIGURATION_DELTA"]);
    assert.throws(() => compileSelectedConfiguration(config), /UNREVIEWED_CONFIGURATION_DELTA/);
  });
test("earlier hosting decisions and unknown environments cannot compile", () => {
  assert.throws(() => selectedConfiguration("staging", 44), /UNRECORDED_STACK_DECISION/);
  assert.throws(() => selectedConfiguration("invented", 45), /UNKNOWN_ENVIRONMENT/);
});
test("published-rate example retains exact arithmetic and explicit exclusions", () => {
  const result = estimateStackComponents(model, model.example_usage);
  assert.equal(result.subtotal, "859.230000000");
  assert.equal(result.components.daytona_cpu, "201.600000000");
  assert.equal(result.components.daytona_memory, "129.600000000");
  assert.equal(result.components.daytona_disk, "311.040000000");
  assert.equal(result.components.neon_compute, "159.840000000");
  assert.equal(result.components.workflow_steps, "12.000000000");
  assert.equal(result.completeQuote, false);
  assert.equal(result.provisioningAuthorized, false);
});
test("zero running sandbox time still bills persistent disk", () => {
  const usage = { ...model.example_usage, daytona_vcpu_hours: "0", daytona_gib_hours: "0" };
  const result = estimateStackComponents(model, usage);
  assert.equal(result.components.daytona_cpu, "0.000000000");
  assert.equal(result.components.daytona_memory, "0.000000000");
  assert.equal(result.components.daytona_disk, "311.040000000");
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
      () => estimateStackComponents(model, { ...model.example_usage, daytona_vcpu_hours: value }),
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
