// Planning arithmetic in integer nanodollars. This never reserves or spends money.
const scale = 1_000_000_000n;
const decimal = (value) => {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,9})?$/.test(value))
    throw new TypeError("Expected nonnegative decimal string with <=9 places");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * scale + BigInt(fraction.padEnd(9, "0"));
};
const multiply = (a, b) => (a * b) / scale;
const above = (value, allowance) => (value > allowance ? value - allowance : 0n);
const roundUp = (value, unit) => ((value + unit - 1n) / unit) * unit;
const format = (value) => `${value / scale}.${(value % scale).toString().padStart(9, "0")}`;
const usageFields = [
  "worker_requests",
  "worker_cpu_ms",
  "workflow_steps",
  "workflow_state_gb_month",
  "queue_operations",
  "r2_gb_month",
  "r2_class_a_operations",
  "r2_class_b_operations",
  "neon_cu_hours",
  "neon_database_gb_month",
  "neon_history_gb_month",
  "neon_snapshot_gb_month",
  "neon_public_transfer_gb",
  "runtime_vcpu_seconds",
  "runtime_gib_seconds",
];

export function estimateStackComponents(model, usage) {
  if (model.status !== "component_estimate_runtime_unbound" || !model.exclusions?.length)
    throw Error("A component estimate requires explicit exclusions");
  if (model.stack !== "cloudflare-neon-runtime" || model.currency !== "USD")
    throw Error("Unsupported stack or currency");
  if (
    model.runtime_provider !== "e2b" ||
    model.runtime_plan !== null ||
    model.runtime_subscription_amount !== null ||
    model.runtime_quote !== null ||
    !Array.isArray(model.missing_runtime_costs) ||
    !model.missing_runtime_costs.length
  )
    throw Error("Runtime quote is unbound; provider or plan fallback is forbidden");
  if (
    JSON.stringify(model.usage_fields) !== JSON.stringify(usageFields) ||
    Object.keys(usage).sort().join(",") !== [...usageFields].sort().join(",") ||
    Object.keys(model.rates).some((key) => key.startsWith("daytona_"))
  )
    throw Error("Runtime cost meter mismatch; legacy provider rates are forbidden");
  for (const [key, amount, unit] of [
    ["e2b_vcpu_second", "0.000014", "running vCPU-second"],
    ["e2b_gib_second", "0.0000045", "running GiB-second"],
  ]) {
    if (
      model.rates[key]?.amount !== amount ||
      model.rates[key]?.unit !== unit ||
      model.rates[key]?.source !== "S97"
    )
      throw Error("Unqualified E2B active compute rate");
  }
  const u = Object.fromEntries(model.usage_fields.map((key) => [key, decimal(usage[key])]));
  const r = (key) => decimal(model.rates[key].amount);
  const cost = (quantity, rate) => multiply(quantity, r(rate));
  const million = decimal("1000000");
  const perMillion = (quantity, rate) => cost((quantity * scale) / million, rate);
  const components = {
    workers_base: r("workers_base"),
    workers_requests: perMillion(
      above(u.worker_requests, decimal("10000000")),
      "workers_requests_million",
    ),
    workers_cpu: perMillion(above(u.worker_cpu_ms, decimal("30000000")), "workers_cpu_million_ms"),
    workflow_steps: cost(
      above(u.workflow_steps, decimal("500000")) / 100000n,
      "workflow_100k_steps",
    ),
    workflow_state: cost(above(u.workflow_state_gb_month, decimal("1")), "workflow_state_gb_month"),
    queue_operations: perMillion(
      above(u.queue_operations, decimal("1000000")),
      "queues_million_operations",
    ),
    r2_storage: cost(roundUp(above(u.r2_gb_month, decimal("10")), scale), "r2_gb_month"),
    r2_writes: perMillion(
      roundUp(above(u.r2_class_a_operations, million), million),
      "r2_class_a_million",
    ),
    r2_reads: perMillion(
      roundUp(above(u.r2_class_b_operations, decimal("10000000")), million),
      "r2_class_b_million",
    ),
    neon_compute: cost(
      u.neon_cu_hours,
      model.neon_plan === "Scale" ? "neon_scale_cu_hour" : "neon_launch_cu_hour",
    ),
    neon_storage: cost(u.neon_database_gb_month, "neon_storage_gb_month"),
    neon_restore_history: cost(u.neon_history_gb_month, "neon_history_gb_month"),
    neon_snapshots: cost(u.neon_snapshot_gb_month, "neon_snapshot_gb_month"),
    neon_transfer: cost(above(u.neon_public_transfer_gb, decimal("500")), "neon_transfer_gb"),
    runtime_cpu: cost(u.runtime_vcpu_seconds, "e2b_vcpu_second"),
    runtime_memory: cost(u.runtime_gib_seconds, "e2b_gib_second"),
  };
  if (!["Launch", "Scale"].includes(model.neon_plan)) throw Error("Unknown Neon plan");
  return {
    currency: "USD",
    status: model.status,
    components: Object.fromEntries(
      Object.entries(components).map(([key, value]) => [key, format(value)]),
    ),
    subtotal: format(Object.values(components).reduce((a, b) => a + b, 0n)),
    subtotalScope: "known_components_only_runtime_subscription_and_other_meters_omitted",
    runtimeProvider: "e2b",
    runtimePlan: null,
    runtimeSubscriptionAmount: null,
    runtimeQuoteBound: false,
    missingRuntimeCosts: model.missing_runtime_costs,
    completeQuote: false,
    provisioningAuthorized: false,
    exclusions: model.exclusions,
    assumptions: model.assumptions,
  };
}
