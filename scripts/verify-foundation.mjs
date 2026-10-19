import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  root,
  read,
  sha,
  validateCatalogue,
  validateTasks,
  inspectAuthority,
  planInventory,
} from "./foundation.mjs";
import { renderDocuments } from "./render-catalogue.mjs";
import { writeArtifact } from "./artifacts.mjs";
import { readEffectiveBodies } from "./contract-sources.mjs";

const catalogue = read("docs/contracts/capabilities.json");
const deps = read("docs/decisions/dependencies.json");
const tasks = read("docs/progress/tasks.json");
const types = read("docs/contracts/schema-types.json");
const bodies = readEffectiveBodies(catalogue.capabilities.map((c) => c.id));
const errors = [
  ...validateCatalogue(catalogue, deps, tasks, types, bodies),
  ...validateTasks(tasks),
];
const readText = (path) => readFileSync(resolve(root, path), "utf8");
const plan = readText("docs/plan/build-plan.md");
// Defined parent tasks and acceptance cases, in plan order, must equal tasks.json in order.
// npm run plan:check owns the rest of the plan's structure (each ID defined once, mentions defined).
const { tasks: expectedTasks, cases: expectedCases } = planInventory(plan);
if (JSON.stringify(tasks.tasks.map((t) => t.id)) !== JSON.stringify(expectedTasks))
  errors.push("task inventory drift");
if (JSON.stringify(tasks.acceptance_ids) !== JSON.stringify(expectedCases))
  errors.push("acceptance inventory drift");
if (new Set(tasks.tasks.map((t) => t.id.slice(0, 3))).size !== 18)
  errors.push("package count drift");
for (const [file, text] of Object.entries(renderDocuments(catalogue, deps)))
  if (readText(`docs/contracts/${file}`) !== text) errors.push(`stale generated record: ${file}`);
const cases = read("docs/acceptance/P01.A01-fixtures.json");
const results = cases.map((test) => {
  const c = catalogue.capabilities.find((c) => c.id === test.capability);
  if (!c) {
    errors.push(`unknown fixture capability ${test.capability}`);
    return { id: test.id, passed: false };
  }
  const actual = inspectAuthority(c, test.request);
  const passed =
    actual.allowed === test.expected.allowed &&
    JSON.stringify([...actual.reasons].sort()) ===
      JSON.stringify([...test.expected.reasons].sort());
  if (!passed) errors.push(`walkthrough failed ${test.id}`);
  return {
    id: test.id,
    capability: c.id,
    host: test.request.host,
    expected: test.expected,
    actual,
    passed,
  };
});
const report = {
  task: "P01.T01",
  generated_at: new Date().toISOString(),
  capabilities: catalogue.capabilities.length,
  domains: catalogue.domain_names.length,
  packages: 18,
  tasks: expectedTasks.length,
  acceptance_cases: expectedCases.length,
  walkthrough_cases: results.length,
  scope:
    "Catalogue consistency and synthetic authority walkthroughs only; not production enforcement or provider qualification.",
  input_digests: Object.fromEntries(
    [
      "docs/contracts/capabilities.json",
      "docs/decisions/dependencies.json",
      "docs/acceptance/P01.A01-fixtures.json",
    ].map((p) => [p, sha(readText(p))]),
  ),
  errors,
  results,
};
writeArtifact("verify/foundation.json", report);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `PASS: ${report.capabilities} capabilities, ${report.domains} domains, ${report.tasks} tasks, ${report.walkthrough_cases} synthetic walkthrough cases. Production gates remain pending.`,
  );
