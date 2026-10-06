import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const entries = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = dir + "/" + entry.name;
    if (entry.isDirectory()) walk(path);
    else if (path !== "docs/evidence/index.json") {
      entries.push({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    }
  }
}
walk("docs/evidence");
const source = JSON.parse(readFileSync("docs/plan/source.json", "utf8"));
const tasks = JSON.parse(readFileSync("docs/progress/tasks.json", "utf8"));
writeFileSync(
  "docs/evidence/index.json",
  JSON.stringify(
    {
      scope:
        "Snapshot of recorded evidence after verification; rerun after new reports. Self-review is separate from independent/merchant/provider qualification.",
      plan_sequence: source.sources.plan.sequence,
      plan_digest: source.sources.plan.sha256,
      tasks: tasks.tasks.filter((x) => x.status !== "Planned"),
      entries,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Indexed ${entries.length} evidence artifacts.`);
