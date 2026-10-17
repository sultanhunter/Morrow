// Secret-scans a generated output directory before it is uploaded. The scan
// reports only relative paths and finding kinds, never matched values. Symbolic
// links and other non-regular entries are findings: an artifact directory holds
// plain files only. A missing directory scans nothing and passes.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { artifactsRoot } from "./artifacts.mjs";
import { inspectSecrets } from "./delivery-checks.mjs";

const root = resolve(process.argv[2] ?? artifactsRoot());
const findings = [];
let scanned = 0;

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = relative(root, path).split("\\").join("/");
    if (entry.isSymbolicLink()) findings.push({ path: name, kind: "symlink" });
    else if (entry.isDirectory()) walk(path);
    else if (!entry.isFile()) findings.push({ path: name, kind: "unsupported_entry" });
    else {
      scanned += 1;
      for (const kind of inspectSecrets(readFileSync(path, "utf8")))
        findings.push({ path: name, kind });
    }
  }
}

let rootStat;
try {
  rootStat = lstatSync(root);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (rootStat?.isSymbolicLink()) findings.push({ path: ".", kind: "symlink" });
else if (rootStat && !rootStat.isDirectory())
  findings.push({ path: ".", kind: "unsupported_entry" });
else if (rootStat) walk(root);

console.log(JSON.stringify({ scanned, findings }));
if (findings.length) process.exitCode = 1;
