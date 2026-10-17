// Structure and governance lint for the plan of record, docs/plan/build-plan.md (ADR-0001).
// verify:foundation checks the defined parent task and acceptance IDs against
// docs/progress/tasks.json; this script checks the plan's own structure and wording.
// Usage: node scripts/plan-check.mjs [plan-file] [adr-directory]
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { planInventory, root } from "./foundation.mjs";

export const PACKAGES = 18;
export const PARENT_TASKS = 80;
export const ACCEPTANCE_CASES = 73;
export const MAX_LINE_LENGTH = 2000;

const LETTERED_ID = /P\d{2}\.T\d{2}[a-z]+(?![a-z\d])/g;
// Ranges: P04.T01a-T01d (letters), P11.T01a–T03a (task numbers), P17.T02a-f (letters).
const LETTERED_RANGE = /(P\d{2})\.T(\d{2})([a-z])[-–](?:T(\d{2})([a-z])|([a-z]))(?![a-z\d])/g;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s/;
const BOLD = /\*\*(.+?)\*\*/g;
const ADR_FILE = /^ADR-(\d{4})-.+\.md$/;
const lineRules = [
  ["REVISION_TOKEN", /canonical\s*\d|\bseq\d+\b/i],
  ["DIGEST", /(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{40})(?![0-9a-f])/i],
  ["CI_RUN_ID", /(?<!\d)\d{11,}(?!\d)/],
  ["PAGE_REFERENCE", /chatgpt\.com|\bpage_[0-9a-f]{32}\b/i],
];

const letter = (code) => String.fromCharCode(code);
const pad = (n) => String(n).padStart(2, "0");

export function letteredIds(text) {
  const ids = new Set(text.match(LETTERED_ID) ?? []);
  for (const [, pkg, n1, l1, n2, l2, l3] of text.matchAll(LETTERED_RANGE)) {
    if (l3) {
      for (let c = l1.charCodeAt(0); c <= l3.charCodeAt(0); c += 1)
        ids.add(`${pkg}.T${n1}${letter(c)}`);
    } else if (n1 === n2) {
      for (let c = l1.charCodeAt(0); c <= l2.charCodeAt(0); c += 1)
        ids.add(`${pkg}.T${n1}${letter(c)}`);
    } else {
      for (let n = Number(n1); n <= Number(n2); n += 1) ids.add(`${pkg}.T${pad(n)}${l1}`);
    }
  }
  return ids;
}

// A lettered ID is defined when it appears in bold in a list item, such as a
// "- **P05.T01x ...**" child entry or a "6. **P06.T01a** ..." Next work step.
export function definedLetteredIds(text) {
  const ids = new Set();
  for (const line of text.split("\n")) {
    if (!LIST_ITEM.test(line)) continue;
    for (const [, span] of line.matchAll(BOLD)) for (const id of letteredIds(span)) ids.add(id);
  }
  return ids;
}

export function adrNumbers(directory) {
  return new Set(
    readdirSync(directory)
      .map((name) => ADR_FILE.exec(name)?.[1])
      .filter(Boolean),
  );
}

const duplicates = (values) => [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];

export function inspectPlan(text, adrs) {
  const errors = [];
  const lines = text.split("\n");
  const headingNumbers = (pattern) =>
    lines.map((line) => pattern.exec(line)?.[1]).filter((n) => n !== undefined);
  const expected = Array.from({ length: PACKAGES }, (_, i) => i + 1);

  const packages = headingNumbers(/^## (\d+) \S/).map(Number);
  if (JSON.stringify(packages) !== JSON.stringify(expected))
    errors.push(
      `PACKAGE_HEADINGS: expected "## 1" to "## ${PACKAGES}" in order, found ${packages}`,
    );
  const tasks = headingNumbers(/^### Package (\d{2}) implementation tasks$/);
  if (JSON.stringify(tasks) !== JSON.stringify(expected.map(pad)))
    errors.push(
      `IMPLEMENTATION_HEADINGS: expected Package 01 to ${PACKAGES} in order, found ${tasks}`,
    );
  for (const heading of duplicates(lines.filter((l) => /^#{1,6} /.test(l)).map((l) => l.trim())))
    errors.push(`DUPLICATE_HEADING: ${heading}`);

  const inventory = planInventory(text);
  for (const [kind, defined, mentioned, count] of [
    ["PARENT_TASK", inventory.tasks, inventory.mentionedTasks, PARENT_TASKS],
    ["ACCEPTANCE", inventory.cases, inventory.mentionedCases, ACCEPTANCE_CASES],
  ]) {
    const unique = new Set(defined);
    if (unique.size !== count)
      errors.push(`${kind}_COUNT: expected ${count} defined, found ${unique.size}`);
    for (const id of duplicates(defined)) errors.push(`${kind}_DUPLICATE: ${id}`);
    for (const id of mentioned) if (!unique.has(id)) errors.push(`${kind}_UNDEFINED: ${id}`);
  }

  const defined = definedLetteredIds(text);
  for (const id of [...letteredIds(text)].sort())
    if (!defined.has(id)) errors.push(`LETTERED_UNDEFINED: ${id}`);

  lines.forEach((line, index) => {
    if (line.length > MAX_LINE_LENGTH)
      errors.push(`LINE_TOO_LONG: line ${index + 1} has ${line.length} characters`);
    for (const [code, pattern] of lineRules)
      if (pattern.test(line)) errors.push(`${code}: line ${index + 1}`);
  });

  for (const number of [...new Set([...text.matchAll(/\bADR-(\d{4})\b/g)].map((m) => m[1]))])
    if (!adrs.has(number)) errors.push(`ADR_MISSING: ADR-${number}`);
  return errors;
}

function main() {
  const planPath = resolve(process.argv[2] ?? resolve(root, "docs/plan/build-plan.md"));
  const adrDirectory = resolve(process.argv[3] ?? resolve(root, "docs/decisions/adr"));
  const text = readFileSync(planPath, "utf8");
  const errors = inspectPlan(text, adrNumbers(adrDirectory));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    const inventory = planInventory(text);
    console.log(
      `PASS: plan check, ${PACKAGES} packages, ${inventory.tasks.length} parent tasks, ${inventory.cases.length} acceptance cases, ${definedLetteredIds(text).size} lettered IDs, every cited ADR present.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
