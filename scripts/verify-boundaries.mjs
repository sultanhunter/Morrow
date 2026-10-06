import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { inspectImports, inspectCompatibility } from "./boundary-checks.mjs";
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = dir + "/" + entry.name;
    if (entry.isDirectory()) {
      if (!["node_modules", "dist", "build", ".react-router"].includes(entry.name)) walk(p);
    } else if (/\.tsx?$/.test(p)) files.push(p);
  }
}
walk("apps");
walk("packages");
const errors = files.flatMap((p) =>
  inspectImports(p, readFileSync(p, "utf8")).map((e) => p + ":" + e),
);
const baseline = JSON.parse(readFileSync("docs/contracts/release-baseline.json", "utf8"));
const schemas = Object.fromEntries(
  Object.keys(baseline.schemas).map((p) => [p, readFileSync(p, "utf8")]),
);
errors.push(...inspectCompatibility(baseline, schemas));
const negatives = [
  ["host_sdk", "import {x} from '@shopify/shopify-app-react-router/server';", "UI_SERVER_IMPORT"],
  ["relative_api", "import {x} from '../../api/src/index';", "UI_RELATIVE_ESCAPE"],
  ["export_secret", "export {x} from './secrets.server';", "UI_SERVER_IMPORT"],
  ["server_env", "const x=process.env.SHOPIFY_API_SECRET;", "UI_SERVER_ENVIRONMENT"],
  ["dynamic_secret", "const x=import(variable);", "DYNAMIC_IMPORT_UNREVIEWED"],
  ["runtime", "import {x} from '@morrow/runtime';", "TRUST_BOUNDARY_IMPORT"],
].map(([name, code, expected]) => ({
  name,
  passed: inspectImports("apps/workspace-web/src/test.tsx", code).includes(expected),
}));
const changed = { ...schemas };
const first = Object.keys(changed)[0];
const value = JSON.parse(changed[first]);
value.$defs.Id.type = "number";
changed[first] = JSON.stringify(value);
negatives.push({
  name: "incompatible_schema_type",
  passed: inspectCompatibility(baseline, changed).length > 0,
});
if (negatives.some((x) => !x.passed)) errors.push("Negative guard failed");
mkdirSync("docs/evidence/P03.T02", { recursive: true });
writeFileSync(
  "docs/evidence/P03.T02/boundaries.json",
  JSON.stringify(
    {
      scope:
        "Import/dependency and unreleased contract-freeze checks, not production tenant authority.",
      files: files.length,
      negative_checks: negatives,
      errors,
    },
    null,
    2,
  ) + "\n",
);
if (errors.length) throw Error(errors.join("\n"));
console.log(
  `PASS: ${files.length} typed sources, ${negatives.length} deliberate boundary/schema failures detected.`,
);
