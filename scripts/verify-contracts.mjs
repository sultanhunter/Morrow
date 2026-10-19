import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root, read, sha } from "./foundation.mjs";
import {
  core,
  bodies,
  validators,
  bodyValidators,
  checkFixture,
  sources,
  selectorValidator,
  transitionVersions,
  layered,
  inspectEventRegistry,
  inspectCollaborationDefaults,
  inspectSidebar,
} from "./contract-checks.mjs";
import { contractVersion, eventRegistryPath } from "./contract-sources.mjs";
import { writeArtifact } from "./artifacts.mjs";

// P01.A02 holds the frozen v1 cases; P01.T02a, P01.T04a (billing) and P01.T02c (collaboration) add the v1.1 cases by exact selector.
const fixtures = [
  ...read("docs/contracts/fixtures/P01.A02.json"),
  ...read("docs/contracts/fixtures/P01.T02a.json"),
  ...read("docs/contracts/fixtures/P01.T04a.json").cases,
  ...read("docs/contracts/fixtures/P01.T02c.json").cases,
];
const errors = [];
const results = fixtures.map((f) => {
  const passed = checkFixture(f);
  if (!passed) errors.push(f.id);
  return { id: f.id, kind: f.kind, passed };
});
const transitions = read("docs/contracts/state-transitions.json");
// Each machine's states: the v1 enums, the artifact list, and the v1.1 message and access_request enums (P01.T02c).
const enumDefs = {
  goal: "core:GoalStatus",
  task: "core:TaskStatus",
  run: "core:RunStatus",
  question: "core:QuestionStatus",
  approval: "core:ApprovalStatus",
  operation: "core:OperationStatus",
  artifact: null,
  installation: "core:InstallationStatus",
  message: "core-v1.1:MessageStatus",
  access_request: "core-v1.1:AccessRequestStatus",
};
const statesOf = (aggregate) => {
  if (!Object.hasOwn(enumDefs, aggregate)) return null;
  if (enumDefs[aggregate] === null)
    return ["uploading", "processing", "ready", "failed", "quarantined", "deleted"];
  const [kind, name] = enumDefs[aggregate].split(":");
  return layered[kind].$defs[name].enum;
};
const capabilityIds = new Set(
  read("docs/contracts/capabilities.json").capabilities.map((c) => c.id),
);
for (const [aggregate, rows] of Object.entries(transitions.transitions)) {
  const states = statesOf(aggregate);
  if (!states) {
    errors.push("unknown transition machine " + aggregate);
    continue;
  }
  for (const t of rows)
    if (!states.includes(t.from) || !states.includes(t.to) || !t.guard || !t.actor)
      errors.push("invalid transition " + aggregate);
  // v1.1 rows (P01.T02a §8): optional since/superseded_in versions and a named capability.
  for (const t of rows)
    if (
      Object.keys(t).some(
        (k) =>
          !["from", "to", "actor", "guard", "since", "superseded_in", "capability"].includes(k),
      ) ||
      (t.since !== undefined && !transitionVersions.includes(t.since)) ||
      (t.superseded_in !== undefined && !transitionVersions.includes(t.superseded_in)) ||
      (t.since !== undefined &&
        t.superseded_in !== undefined &&
        transitionVersions.indexOf(t.superseded_in) <= transitionVersions.indexOf(t.since)) ||
      (t.capability !== undefined && !capabilityIds.has(t.capability))
    )
      errors.push("invalid transition version or capability " + aggregate);
}
// Review policy defaults (P01.T02a §3, §7; ADR-0011 Q3, Q9): the rules are a valid
// ReviewPolicyRules and the effect-to-risk table covers exactly the catalogue effects.
const defaults = read("docs/contracts/review-policy-defaults.json");
if (!selectorValidator("core-v1.1:ReviewPolicyRules")(defaults.rules))
  errors.push("review policy defaults are not valid ReviewPolicyRules");
const riskClasses = selectorValidator("core-v1.1:RiskClass");
if (
  JSON.stringify(Object.keys(defaults.riskClassByEffect).sort()) !==
    JSON.stringify([
      "billable_job",
      "communication",
      "control",
      "external_write",
      "internal_write",
      "read",
      "spend",
    ]) ||
  !Object.values(defaults.riskClassByEffect).every(riskClasses)
)
  errors.push("review policy risk table must map every effect to a RiskClass");
const routes = read("docs/contracts/workspace-routes.json");
for (const r of routes.routes)
  if (
    r.namespace === "merchant" &&
    JSON.stringify(r.hosts.sort()) !== JSON.stringify(["standalone"])
  )
    errors.push("route surface " + r.id);
// P01.T02c (ADR-0016): the event registry, the collaboration defaults and the sidebar model.
errors.push(
  ...inspectEventRegistry(read(eventRegistryPath)),
  ...inspectCollaborationDefaults(read("docs/contracts/collaboration-defaults.json")),
  ...inspectSidebar(routes),
);
const report = {
  task: "P01.T02",
  contract_version: contractVersion,
  generated_at: new Date().toISOString(),
  schema_definitions: Object.keys(validators).length,
  capability_bodies: Object.keys(bodyValidators).length,
  definitions_by_source: Object.fromEntries(
    sources.map((s) => [s.kind, Object.keys(s.schema.$defs).length]),
  ),
  state_transitions: Object.values(transitions.transitions).reduce((n, rows) => n + rows.length, 0),
  routes: routes.routes.length,
  cases: results.length,
  scope:
    "Versioned schema and semantic examples only; no production policy/authentication or provider qualification.",
  input_digests: Object.fromEntries(
    [
      ...sources.map((s) => s.path),
      "docs/contracts/fixtures/P01.A02.json",
      "docs/contracts/fixtures/P01.T02a.json",
      "docs/contracts/fixtures/P01.T02c.json",
      eventRegistryPath,
      "docs/contracts/collaboration-defaults.json",
      "docs/contracts/review-policy-defaults.json",
      "docs/contracts/state-transitions.json",
      "package-lock.json",
    ].map((p) => [p, sha(readFileSync(resolve(root, p)))]),
  ),
  errors,
  results,
};
writeArtifact("verify/contracts.json", report);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `PASS: ${report.contract_version}; ${report.schema_definitions} v1 core definitions, ${report.capability_bodies} v1 capability bodies, ${Object.entries(
      report.definitions_by_source,
    )
      .filter(([k]) => k.endsWith("-v1.1"))
      .map(([k, n]) => `${n} ${k}`)
      .join(", ")}, ${report.state_transitions} transitions, ${report.cases} contract cases.`,
  );
