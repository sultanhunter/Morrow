import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, read, sha } from "./foundation.mjs";
import {
  allocationDigest,
  ContractCreditLedger,
  billing,
  inspectPaidWork,
  paidWorkPredicate,
} from "./billing-checks.mjs";
import { inspectReadiness } from "./provider-checks.mjs";
import { writeArtifact } from "./artifacts.mjs";

const f = read("docs/contracts/fixtures/P01.A04.json");
f.allocation.allocationDigest = allocationDigest(f.allocation);
f.facts.approvedAllocationDigest = f.allocation.allocationDigest;
const checks = [],
  errors = [];
function check(name, run) {
  try {
    if (!run()) throw new Error("unexpected outcome");
    checks.push({ name, passed: true });
  } catch (e) {
    checks.push({ name, passed: false });
    errors.push(name + ": " + e.message);
  }
}
check("small brand retains installation payer", () => {
  const x = structuredClone(f);
  x.allocation.shares.splice(1);
  x.allocation.maximumCredits = "30";
  x.allocation.allocationDigest = allocationDigest(x.allocation);
  x.facts.approvedAllocationDigest = x.allocation.allocationDigest;
  const l = new ContractCreditLedger(x.facts);
  l.reserve("reservation-1", x.allocation, x.vendorReservation);
  return (
    l.snapshot().wallets["payer-1"].available === "70" &&
    l.snapshot().wallets["payer-2"].available === "100"
  );
});
check("specialist team reconciles two payers and one vendor cost", () => {
  const l = new ContractCreditLedger(f.facts);
  l.reserve("reservation-1", f.allocation, f.vendorReservation);
  l.dispatch("reservation-1");
  l.uncertain("reservation-1");
  l.settle("reservation-1", f.usage, {
    verifiedProviderEvidence: true,
    verifiedRateEvidence: true,
  });
  const s = l.snapshot();
  return (
    s.rootConsumed === "25" &&
    s.rootReserved === "0" &&
    s.vendorConsumed === "300000000" &&
    s.wallets["payer-2"].available === "90"
  );
});
check("unqualified real billing design cannot dispatch", () => {
  const x = structuredClone(f);
  x.facts.rateQualified = false;
  const l = new ContractCreditLedger(x.facts);
  try {
    l.reserve("reservation-1", x.allocation, x.vendorReservation);
  } catch (e) {
    return e.message.includes("RATE_NOT_QUALIFIED");
  }
  return false;
});
// P01.T04a §1: paid work, rules PW1-PW5, with deliberate negative tables.
const paidWork = read("docs/contracts/paid-work.json"),
  catalogue = read("docs/contracts/capabilities.json"),
  templates = read("docs/contracts/fixtures/P01.T04a.json").templates;
for (const e of inspectPaidWork(paidWork, catalogue, templates)) errors.push(e);
const paidCapabilities = catalogue.capabilities
  .filter((c) => paidWork.paidEffects.includes(c.effect) && !c.kill_switch)
  .map((c) => c.id)
  .sort();
check("paid work is execute on the paid-effect capabilities that are not kill switches", () => {
  const paid = paidWorkPredicate(paidWork, catalogue);
  return (
    JSON.stringify(
      catalogue.capabilities
        .filter((c) => paid(c.id, "execute"))
        .map((c) => c.id)
        .sort(),
    ) === JSON.stringify(paidCapabilities) && paid("invented.capability", "view")
  );
});
for (const [name, change, expected] of [
  ["read as a paid effect", (t) => t.paidEffects.push("read"), "PAID_WORK_TABLE_INVALID:PW4"],
  [
    "billable_job dropped",
    (t) => t.paidEffects.splice(t.paidEffects.indexOf("billable_job"), 1),
    "PAID_WORK_TABLE_INVALID:PW3",
  ],
  ["execute never gated", (t) => t.neverGatedVerbs.push("execute"), "PAID_WORK_TABLE_INVALID:PW1"],
  [
    "administer never gated",
    (t) => t.neverGatedVerbs.push("administer"),
    "PAID_WORK_TABLE_INVALID:PW1",
  ],
  [
    "an extra key",
    (t) => {
      t.killSwitchesPaid = true;
    },
    "PAID_WORK_TABLE_INVALID:PW1",
  ],
])
  check("paid-work table rejects " + name, () => {
    const t = structuredClone(paidWork);
    change(t);
    return inspectPaidWork(t, catalogue, templates).includes(expected);
  });
check("paid-work table rejects a paid template row", () => {
  const t = structuredClone(templates);
  t["workspace-member-v1"].push({
    capabilityId: "creative.image.generate",
    verbs: ["execute"],
    fields: ["briefRef"],
  });
  return inspectPaidWork(paidWork, catalogue, t).includes(
    "PAID_WORK_TABLE_INVALID:PW5:workspace-member-v1",
  );
});
const decisions = read("docs/decisions/readiness.json");
check(
  "local design packet ready with pending external reviews",
  () => inspectReadiness(decisions.local_design_packet, decisions.consumed_decisions).ready,
);
check("unresolved consumed structural decision blocks Ready", () => {
  const copy = structuredClone(decisions.consumed_decisions);
  copy[0].status = "unresolved";
  return !inspectReadiness(decisions.local_design_packet, copy).ready;
});
check(
  "missing controlled account still blocks integrated qualification",
  () =>
    !inspectReadiness(
      { ...decisions.local_design_packet, requiresControlledAccount: true },
      decisions.consumed_decisions,
    ).ready,
);
check(
  "unqualified package still blocks consumers",
  () =>
    !inspectReadiness(
      {
        ...decisions.local_design_packet,
        requiresQualifiedPackage: true,
        packageInputStatus: "in_review",
      },
      decisions.consumed_decisions,
    ).ready,
);
for (const d of decisions.consumed_decisions) {
  const original = read("docs/decisions/dependencies.json").find((x) => x.id === d.id);
  if (
    !original ||
    original.status !== "Design recorded" ||
    original.activation !== "blocked_until_qualified"
  )
    errors.push("readiness/activation drift " + d.id);
  if (!d.reviewRef || !existsSync(resolve(root, d.reviewRef)))
    errors.push("review record missing " + d.id);
}
const inputs = [
  "docs/contracts/schemas/v1/billing.schema.json",
  "docs/contracts/schemas/v1.1/billing.schema.json",
  "docs/contracts/paid-work.json",
  "docs/contracts/fixtures/P01.T04a.json",
  "docs/contracts/fixtures/P01.A04.json",
  "docs/contracts/billing-entitlements.md",
  "docs/contracts/budgets.md",
  "docs/decisions/billing-ownership.md",
  "docs/decisions/readiness.json",
  "docs/decisions/reviews/P01.T04-review.md",
  "scripts/billing-checks.mjs",
  "tests/billing.test.mjs",
];
const report = {
  task: "P01.T04",
  generated_at: new Date().toISOString(),
  billing_definitions: Object.keys(billing.$defs).length,
  paid_work_capabilities: paidCapabilities.length,
  checks,
  scope:
    "Synthetic design, exact arithmetic and semantic walkthroughs only. No concurrent database, rate activation, provider charge, independent review or merchant usability proof.",
  input_digests: Object.fromEntries(
    inputs.map((p) => [p, sha(readFileSync(resolve(root, p), "utf8"))]),
  ),
  errors,
};
writeArtifact("verify/billing.json", report);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `PASS: ${report.billing_definitions} billing definitions, ${report.paid_work_capabilities} paid-work capabilities (PW1-PW5) and ${checks.length} billing/readiness checks. Billing activation remains blocked.`,
  );
