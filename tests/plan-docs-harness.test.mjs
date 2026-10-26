// Harness plan row H2: the plan documents follow ADR-0040 and ADR-0041 as accepted
// (OD-2026-10-26-7). The owner flagged drift between the plan and the records before
// (2026-10-22), so these tests pin the points where the plan docs would otherwise drift back:
// every harness row they cite exists, no plan doc offers a model or effort the records
// removed, the superseded follow-up rows point to the harness plan, and the owner's choices of
// 2026-10-26 (the P09.T05 path first; COD Confirmation installable and not built now) are there.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (path) => readFileSync(join(repository, path), "utf8");

const harnessPlan = read("docs/plan/harness-foundations-implementation.md");
const docs = {
  mvp: read("docs/plan/mvp.md"),
  order: read("docs/plan/v1-build-order.md"),
  adr0037: read("docs/plan/adr-0037-implementation.md"),
  adr0039: read("docs/plan/adr-0039-implementation.md"),
};

// The harness plan's rows: "| H7a | Agent loop: the data model | …".
const harnessRows = new Set(
  [...harnessPlan.matchAll(/^\| (H\d{1,2}[a-z]?) \|/gm)].map((m) => m[1]),
);

// A table row of a plan doc, by its first cell.
function row(text, number) {
  const lines = text.split("\n").filter((line) => line.startsWith(`| ${number} | `));
  assert.equal(lines.length, 1, `one row ${number}`);
  return lines[0];
}

// A "### PR <n>." section of the v1 build order, up to the next heading.
function section(heading) {
  const start = docs.order.indexOf(`\n### ${heading}`);
  assert.ok(start >= 0, heading);
  const end = docs.order.slice(start + 1).search(/\n##+ /);
  return end < 0 ? docs.order.slice(start) : docs.order.slice(start, start + 1 + end);
}

test("the harness plan has rows H1 to H20, and H2 names the four plan docs", () => {
  for (let n = 1; n <= 20; n += 1)
    assert.ok(
      harnessRows.has(`H${n}`) || [...harnessRows].some((id) => id.startsWith(`H${n}`)),
      `H${n}`,
    );
  const h2 = row(harnessPlan, "H2");
  for (const path of [
    "mvp.md",
    "v1-build-order.md",
    "adr-0037-implementation.md",
    "adr-0039-implementation.md",
  ])
    assert.ok(h2.includes(path), path);
});

test("every harness row a plan doc cites exists in the harness plan", () => {
  for (const [name, text] of Object.entries(docs)) {
    const cited = new Set(
      [...text.matchAll(/(?<![\w-])H\d{1,2}[a-z]?(?![\w-])/g)].map((m) => m[0]),
    );
    assert.ok(cited.size > 0, `${name} cites the harness plan's rows`);
    for (const id of cited) assert.ok(harnessRows.has(id), `${name} cites ${id}`);
    assert.ok(text.includes("harness-foundations-implementation.md"), `${name} links the plan`);
  }
});

test("no plan doc offers Haiku, Sonnet or low effort (ADR-0041 item 2)", () => {
  for (const [name, text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /Haiku, Sonnet (?:or|and) Opus/, name);
    assert.doesNotMatch(text, /\blow, medium (?:or|and) high\b/, name);
  }
  assert.match(docs.mvp, /\*\*Models: Opus 5\.5 only\*\*/);
  assert.match(section("PR 11."), /Opus 5\.5 only, at medium and high/);
  assert.match(section("PR 12."), /Opus 5\.5 at medium or high/);
});

test("the MVP names launch scope only; the foundation is production grade and never cut", () => {
  assert.match(docs.mvp, /"MVP" names the launch scope only/);
  assert.match(docs.mvp, /It never names the foundation/);
  assert.match(docs.mvp, /\*\*The foundation is not cut\*\* \(OD-2026-10-26-6\)/);
  assert.match(docs.mvp, /\| The agent harness \(the foundation, production grade\) \|/);
});

test("ADR-0037's reshaped rows point to their harness rows", () => {
  for (const [number, ids] of [
    ["2", ["H5", "H6"]],
    ["4", ["H10"]],
    ["5", ["H11a"]],
    ["9", ["H18"]],
    ["10", ["H20"]],
  ]) {
    const text = row(docs.adr0037, number);
    for (const id of ids) assert.ok(text.includes(`harness plan ${id}`), `row ${number}: ${id}`);
  }
  // Superseded by ADR-0041 item 9: a call the wallet cannot cover parks the job.
  assert.doesNotMatch(row(docs.adr0037, "4"), /refused at once/);
  assert.match(row(docs.adr0037, "4"), /parks the whole job instead of being refused/);
  assert.match(row(docs.adr0037, "9"), /Merged \(#81\)/);
});

test("ADR-0039's rows park instead of a final turn from a reserve (ADR-0041 item 9)", () => {
  assert.match(row(docs.adr0039, "1"), /Now harness plan H3/);
  assert.match(row(docs.adr0039, "2"), /harness plan H6/);
  assert.match(row(docs.adr0039, "2"), /harness plan H8/);
  assert.match(row(docs.adr0039, "3"), /now harness plan H8/);
  for (const number of ["2", "3", "7"])
    assert.doesNotMatch(row(docs.adr0039, number), /takes its final turn from the reserve/);
  assert.match(row(docs.adr0039, "7"), /parks on an `agent_credit_limit` wait/);
  assert.doesNotMatch(docs.adr0039, /\*\*The final-turn reserve stands\.\*\*/);
  // PR 1 merged as pull request 83 with migration 0056, which is applied and immutable.
  assert.match(row(docs.adr0039, "1"), /Merged 2026-10-26 as pull request 83/);
  assert.match(docs.adr0039, /migrations 0001 to 0056 are applied and immutable/);
  assert.doesNotMatch(docs.adr0039, /pull request 83 holds 0056/);
});

test("the v1 build order's PR 12 splits in two, and teammate calls pause on credits", () => {
  const pr12 = section("PR 12.");
  assert.match(pr12, /12a, the backend \(harness plan H11a and H11b\)/);
  assert.match(pr12, /12b, the screens \(H14\)/);
  assert.doesNotMatch(pr12, /turn, tool-call and time limits/);
  const pr26 = section("PR 26.");
  assert.doesNotMatch(pr26, /a call the balance cannot cover is refused at once/);
  assert.match(pr26, /pauses the whole request until credits are added/);
});

test("the owner's choices of 2026-10-26: the P09.T05 path first; COD Confirmation not built now", () => {
  assert.match(docs.mvp, /G9, before real data:\*\*[^\n]*P09\.T05[^\n]*`async-conversations`/);
  assert.match(docs.mvp, /\*\*COD Confirmation\*\*[^\n]*installable agent[^\n]*not built now/);
  assert.match(docs.order, /P09\.T05\) first, as part of the foundation/);
  assert.match(docs.order, /COD Confirmation[^\n]*installable agent and is not built now/);
  // The owner's direction instead: a foundation ready for agents of that kind.
  assert.match(
    docs.mvp,
    /\*\*COD Confirmation\*\*[^\n]*foundation be solid enough for agents of its kind/,
  );
  assert.match(docs.order, /COD Confirmation[^\n]*foundation be ready for agents like it/);
});
