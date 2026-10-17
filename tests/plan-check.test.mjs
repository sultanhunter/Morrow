import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adrNumbers,
  definedLetteredIds,
  inspectPlan,
  letteredIds,
} from "../scripts/plan-check.mjs";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const checker = join(repository, "scripts/plan-check.mjs");
const planPath = join(repository, "docs/plan/build-plan.md");
const adrDirectory = join(repository, "docs/decisions/adr");
const plan = readFileSync(planPath, "utf8");
const adrs = adrNumbers(adrDirectory);

function replaceOnce(text, from, to) {
  assert.equal(text.split(from).length, 2, `expected one occurrence of ${from}`);
  return text.replace(from, to);
}

function withTemporaryDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "morrow-plan-check-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runChecker(args) {
  return spawnSync(process.execPath, [checker, ...args], { encoding: "utf8" });
}

test("the repository plan passes and cites only recorded ADRs", () => {
  assert.deepEqual(inspectPlan(plan, adrs), []);
  assert.ok(adrs.has("0001") && adrs.has("0013"));
  const result = runChecker([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^PASS: plan check, 18 packages, 80 parent tasks, 73 acceptance cases/,
  );
});

test("the command fails on a broken temporary copy and names each finding", () =>
  withTemporaryDirectory((directory) => {
    const copy = join(directory, "build-plan.md");
    let broken = replaceOnce(
      plan,
      "## 7 Artifacts and collaboration",
      "## Artifacts and collaboration",
    );
    broken += `\nSee ADR-0099 and P07.T05q.\n`;
    writeFileSync(copy, broken);
    const result = runChecker([copy, adrDirectory]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^PACKAGE_HEADINGS:/m);
    assert.match(result.stderr, /^LETTERED_UNDEFINED: P07\.T05q$/m);
    assert.match(result.stderr, /^ADR_MISSING: ADR-0099$/m);
    assert.equal(result.stdout, "");
  }));

test("an ADR the plan cites must exist in the ADR directory", () =>
  withTemporaryDirectory((directory) => {
    for (const name of readdirSync(adrDirectory))
      if (!name.startsWith("ADR-0013-")) writeFileSync(join(directory, name), "");
    const result = runChecker([planPath, directory]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^ADR_MISSING: ADR-0013$/m);
    assert.deepEqual(adrNumbers(directory).has("0013"), false);
  }));

for (const [name, mutate, expected] of [
  [
    "an out-of-order implementation heading",
    (p) =>
      replaceOnce(p, "### Package 07 implementation tasks", "### Package 7 implementation tasks"),
    /^IMPLEMENTATION_HEADINGS:/m,
  ],
  ["a duplicate heading", (p) => `${p}\n## Next work\n`, /^DUPLICATE_HEADING: ## Next work$/m],
  [
    "a parent task defined twice",
    (p) => `${p}\n1. **P01.T01 Again.**\n`,
    /^PARENT_TASK_DUPLICATE: P01\.T01$/m,
  ],
  [
    "a parent task that loses its definition",
    (p) =>
      replaceOnce(p, "1. **P01.T01 Capability and authority catalogue.**", "1. **Catalogue.**"),
    /^PARENT_TASK_COUNT: expected 80 defined, found 79$[\s\S]*^PARENT_TASK_UNDEFINED: P01\.T01$/m,
  ],
  ["an invented parent task", (p) => `${p}\nSee P19.T01.\n`, /^PARENT_TASK_UNDEFINED: P19\.T01$/m],
  [
    "an acceptance case defined twice",
    (p) => `${p}\n**P01.A01:** again.\n`,
    /^ACCEPTANCE_DUPLICATE: P01\.A01$/m,
  ],
  [
    "an invented acceptance case",
    (p) => `${p}\nSee P18.A09.\n`,
    /^ACCEPTANCE_UNDEFINED: P18\.A09$/m,
  ],
  [
    "a lettered range used without a definition",
    (p) => `${p}\nNext: P07.T05q-T05s.\n`,
    /^LETTERED_UNDEFINED: P07\.T05r$/m,
  ],
  ["a line over 2,000 characters", (p) => `${p}\n${"x".repeat(2001)}\n`, /^LINE_TOO_LONG:/m],
  ["a Canonical revision token", (p) => `${p}\nCanonical${96} applies.\n`, /^REVISION_TOKEN:/m],
  ["a seq revision token", (p) => `${p}\nAs of seq${95}.\n`, /^REVISION_TOKEN:/m],
  ["a SHA-256 digest", (p) => `${p}\nDigest ${"a1".repeat(32)}.\n`, /^DIGEST:/m],
  ["a commit SHA", (p) => `${p}\nCommit ${"b2".repeat(20)}.\n`, /^DIGEST:/m],
  ["a CI run ID", (p) => `${p}\nRun ${String(38979693185)}.\n`, /^CI_RUN_ID:/m],
  [
    "a ChatGPT Page URL",
    (p) => `${p}\nSee https://chatgpt${".com"}/space/page_${"0".repeat(32)}.\n`,
    /^PAGE_REFERENCE:/m,
  ],
])
  test(`rejects ${name}`, () => {
    const errors = inspectPlan(mutate(plan), adrs);
    assert.match(errors.join("\n"), expected);
  });

test("a lettered ID is defined by a bold list entry, including ranges", () => {
  const extra = "\n- **P07.T05q-T05s Example children.** Uses P07.T05r.\n";
  assert.deepEqual(inspectPlan(plan + extra, adrs), []);
  const prose = "\nProse **P07.T05q** is not a definition.\n";
  assert.match(inspectPlan(plan + prose, adrs).join("\n"), /^LETTERED_UNDEFINED: P07\.T05q$/m);
  assert.deepEqual([...letteredIds("P11.T01a–T03a and P17.T02a-c")].sort(), [
    "P11.T01a",
    "P11.T02a",
    "P11.T03a",
    "P17.T02a",
    "P17.T02b",
    "P17.T02c",
  ]);
  assert.ok(definedLetteredIds("6. **P05.T01x Signup**; **P06.T01a** work").has("P06.T01a"));
});
