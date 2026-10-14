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

export function estimateStackComponents(model, usage) {
  if (model.status !== "component_estimate_not_complete_quote" || !model.exclusions?.length)
    throw Error("A component estimate requires explicit exclusions");
  if (model.stack !== "cloudflare-neon-daytona" || model.currency !== "USD")
    throw Error("Unsupported stack or currency");
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
    daytona_cpu: cost(u.daytona_vcpu_hours, "daytona_vcpu_hour"),
    daytona_memory: cost(u.daytona_gib_hours, "daytona_gib_hour"),
    daytona_disk: cost(u.daytona_disk_gib_hours, "daytona_disk_gib_hour"),
  };
  if (!["Launch", "Scale"].includes(model.neon_plan)) throw Error("Unknown Neon plan");
  return {
    currency: "USD",
    status: model.status,
    components: Object.fromEntries(
      Object.entries(components).map(([key, value]) => [key, format(value)]),
    ),
    subtotal: format(Object.values(components).reduce((a, b) => a + b, 0n)),
    completeQuote: false,
    provisioningAuthorized: false,
    exclusions: model.exclusions,
    assumptions: model.assumptions,
  };
}
