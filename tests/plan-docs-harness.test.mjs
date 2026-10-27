// Harness plan row H2: the plan documents follow ADR-0040 and ADR-0041 as accepted
// (OD-2026-10-26-7). The owner flagged drift between the plan and the records before
// (2026-10-22), so these tests pin the points where the plan docs would otherwise drift back:
// every harness row they cite exists, no plan doc offers a model or effort the records
// removed, the superseded follow-up rows point to the harness plan, and the owner's choices of
// 2026-10-26 (the P09.T05 path first; COD Confirmation installable and not built now) are there,
// and, since OD-2026-10-26-12, credits are the only budget in every one of them. Since pull
// request 86 merged (ADR-0042 Accepted, OD-2026-10-26-9; the customer-names gap decided,
// OD-2026-10-26-10; harness plan row H9d) and pull request 79 (H5), they cite those records.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

// The same rows in plan order, with their Size and Changes cells
// ("| # | PR | Size | Starts after | Changes | What it does | Gated by |").
const harnessTable = [...harnessPlan.matchAll(/^\| (H\d{1,2}[a-z]?) \| ([^\n]*)$/gm)].map((m) => {
  const cells = m[2].split(" | ");
  return { id: m[1], size: cells[1], changes: cells[3] };
});
const harnessOrder = harnessTable.map((entry) => entry.id);
const harnessEntry = new Map(harnessTable.map((entry) => [entry.id, entry]));

// "H4 and H7a to H8" -> H4, H7a, H7b, H7c, H7d, H7e, H8, in the harness plan's order.
function harnessIds(list) {
  const ids = [];
  for (const part of list.split(/, (?:and )?| and /)) {
    const m = part.trim().match(/^(H\d{1,2}[a-z]?)(?: to (H\d{1,2}[a-z]?))?$/);
    assert.ok(m, `a harness row or range: "${part}"`);
    const from = harnessOrder.indexOf(m[1]);
    const to = harnessOrder.indexOf(m[2] ?? m[1]);
    assert.ok(from >= 0 && to >= from, `a range of existing rows: "${part}"`);
    ids.push(...harnessOrder.slice(from, to + 1));
  }
  return ids;
}

// "1 to 3 and 5 to 8" or "11, 12, 15, 16, 20 and 21" -> the sorted PR numbers.
function prNumbers(list) {
  const numbers = new Set();
  for (const part of list.split(/, (?:and )?| and /)) {
    const m = part.trim().match(/^(\d+)(?: to (\d+))?$/);
    assert.ok(m, `a PR number or range: "${part}"`);
    for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n += 1) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

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

test("PR 11 calls on PR #64 only the harness rows that change PR #64, after H5's and H6's contracts", () => {
  // The harness plan's "What each open PR becomes": PR #64 is H7a to H7e and H8 (H4 renumbers
  // its migration); H5 is PR #79's teammate contracts and H6 is a new T2 contracts PR, neither
  // on PR #64 and neither behind the agent-loop switch.
  assert.match(harnessEntry.get("H5").changes, /^PR #79\b/);
  assert.match(harnessEntry.get("H6").changes, /^new\b/);
  const pr11 = section("PR 11.");
  const cited = [];
  for (const [where, text] of [
    ["the progress table", row(docs.order, "Building now")],
    ["PR 11's note", pr11],
  ]) {
    const m = text.match(
      /rows (H[\w ]+?) of (?:the harness plan|\[the harness plan\]\([^)]*\)) \(on PR #64\)/,
    );
    assert.ok(m, `${where} names the harness rows on PR #64`);
    const ids = harnessIds(m[1]);
    for (const id of ids)
      assert.match(harnessEntry.get(id).changes, /PR #64\b/, `${where}: ${id} changes PR #64`);
    assert.match(text, /after the contracts of H5 \(PR #79, merged[^)]*\) and H6\b/, where);
    cited.push(ids);
  }
  assert.deepEqual(cited[0], cited[1], "the progress table and PR 11's note cite the same rows");
  // Only the runner sits behind the agent-loop switch, and H4 is no L PR.
  const size = pr11.match(
    /\*\*Size:\*\* several PRs \(harness plan (H[\w ]+?)\), the runner's behind the agent-loop switch\./,
  );
  assert.ok(size, "PR 11's size line");
  assert.deepEqual(harnessIds(size[1]), cited[0]);
  assert.doesNotMatch(pr11, /each behind the agent-loop switch/);
  if (cited[0].some((id) => !/^L\b/.test(harnessEntry.get(id).size)))
    assert.doesNotMatch(pr11, /several L PRs/);
});

test("mvp.md lists the same reshaped PRs as the plans it summarises", () => {
  const m = docs.mvp.match(
    /reshape ADR-0037's follow-up PRs ([\d, a-z]+?), ADR-0039's PRs ([\d, a-z]+?), and v1 build order PRs ([\d, a-z]+?)\./,
  );
  assert.ok(m, "mvp.md's reshaped-PR sentence");
  // ADR-0037: the build order's "Replaced (2026-10-25)" row.
  const replaced = row(docs.order, "Replaced (2026-10-25)").match(
    /of which ([\d, a-z]+?) continue as harness plan rows/,
  );
  assert.ok(replaced, "the build order's ADR-0037 rows");
  assert.deepEqual(prNumbers(m[1]), prNumbers(replaced[1]), "ADR-0037's follow-up PRs");
  // ADR-0039: the rows its plan's "Changed 2026-10-26" line names (row 4 only merged with PR 1).
  const changed = docs.adr0039.split("\n").find((line) => line.startsWith("- Changed 2026-10-26"));
  assert.ok(changed, "ADR-0039's dated change line");
  const adr0039Rows = new Set();
  for (const r of changed.matchAll(/\b[Rr]ows? (\d+)(?: to (\d+))?\b/g))
    for (let n = Number(r[1]); n <= Number(r[2] ?? r[1]); n += 1) adr0039Rows.add(n);
  assert.deepEqual(
    prNumbers(m[2]),
    [...adr0039Rows].sort((a, b) => a - b),
    "ADR-0039's PRs",
  );
  // The v1 build order: its "Reshaped (2026-10-26)" row.
  const reshaped = row(docs.order, "Reshaped (2026-10-26)").match(
    /^\| Reshaped \(2026-10-26\) \| ([\d, a-z]+?), by ADR-0040/,
  );
  assert.ok(reshaped, "the build order's reshaped row");
  assert.deepEqual(prNumbers(m[3]), prNumbers(reshaped[1]), "the v1 build order's PRs");
  // Every reshaped build order PR cites its harness plan rows.
  for (const number of prNumbers(reshaped[1]))
    assert.match(section(`PR ${number}.`), /(?<![\w-])H\d{1,2}[a-z]?(?![\w-])/, `PR ${number}`);
});

test("credits are the only budget (OD-2026-10-26-12): no plan doc keeps a removed spend limit", () => {
  // Removed by OD-2026-10-26-12 and, for upkeep, by the lead under OD-2026-10-25-4: the cost
  // check-in, the 80% pause with its fair share, the per-person caps on requests working,
  // waiting or standing, and the daily upkeep spend.
  for (const [name, text] of Object.entries(docs)) {
    assert.doesNotMatch(text, /waiting line|too_many_waiting/, `${name}: the waiting line`);
    assert.doesNotMatch(text, /up to 5 requests working at once/, `${name}: 5 at once`);
    assert.doesNotMatch(
      text,
      /at most 10 per person|10 (?:active )?standing requests per person/,
      `${name}: 10 standing`,
    );
    assert.doesNotMatch(text, /the platform breaker at 80%/, `${name}: the 80% pause`);
    assert.doesNotMatch(
      text,
      /upkeep spend (?:per workspace )?per day/,
      `${name}: daily upkeep spend`,
    );
  }
  // mvp.md: the safety row and the conversation row say so.
  const safety = docs.mvp.split("\n").find((line) => line.startsWith("| Safety and governance |"));
  assert.ok(safety, "mvp.md's safety row");
  assert.match(safety, /credits the only budget/);
  assert.match(safety, /no cost check-in/);
  assert.match(safety, /code alerts the owner, as Morrow's operator[^|]*\(OD-2026-10-26-12\)/);
  assert.match(
    docs.mvp,
    /no per-person cap on requests working, waiting or standing \(OD-2026-10-26-12\)/,
  );
  // The build order: PR 11 pauses nothing on spend; PR 21 has no per-person limit.
  const pr11 = section("PR 11.");
  assert.match(pr11, /there is no cost check-in/);
  assert.match(pr11, /code alerts you, as Morrow's operator, and nothing pauses/);
  // ADR-0039's restated item 1 keeps one exception: the Owner's optional per-agent credit limit,
  // which parks only that agent's run (ADR-0041 item 9; OD-2026-10-26-12 item 8).
  assert.match(
    pr11,
    /Apart from your balance and an optional per-agent credit limit you may set, which pauses only that agent, no amount of spend pauses a job/,
  );
  assert.doesNotMatch(pr11, /(?:^|[.:] )No amount of spend/m, "an unqualified spend rule");
  assert.match(section("PR 21."), /no limit on how many you have[^\n]*\(OD-2026-10-26-12\)/);
  // ADR-0039's row 3 (H8): the alert in place of the platform breaker; the cost check-in gone.
  const [kept, gone] = row(docs.adr0039, "3").split(" Gone: ");
  assert.ok(gone, "row 3 lists what is gone");
  assert.doesNotMatch(kept, /platform breaker at|cost check-in/);
  assert.match(kept, /an alert to the owner[^;]*pausing nothing \(OD-2026-10-26-12/);
  assert.match(
    gone,
    /by OD-2026-10-26-12, the platform breaker's pause at 80%[^.]*the cost check-in\./,
  );
});

test("the plan docs follow pull request 86's records and H5's merge, citing ids that resolve", () => {
  // Every OD and ADR id a plan doc cites resolves on main.
  const adrFiles = new Set(
    read("docs/decisions/adr/README.md")
      .match(/ADR-\d{4}-[\w-]+\.md/g)
      .map((name) => name.slice(0, 8)),
  );
  for (const [name, text] of Object.entries(docs)) {
    for (const [id] of text.matchAll(/\bOD-\d{4}-\d{2}-\d{2}-\d+\b/g))
      assert.ok(existsSync(join(repository, `docs/graph/decisions/${id}.md`)), `${name}: ${id}`);
    for (const [id] of text.matchAll(/\bADR-\d{4}\b/g))
      assert.ok(adrFiles.has(id), `${name}: ${id}`);
    // ADR-0042 is Accepted (OD-2026-10-26-9): no plan doc still calls it pending or cites the
    // owner's choices of 2026-10-26 without their records.
    assert.doesNotMatch(text, /\bADR 0042\b/, `${name}: ADR-0042 by its id`);
    assert.doesNotMatch(text, /being finalised|once merged/, `${name}: ADR-0042 pending`);
    assert.doesNotMatch(text, /\(the owner, 2026-10-26\)/, `${name}: an uncited choice`);
    // OD-2026-10-26-10 decided the customer-names gap of ADR-0041 item 31.
    assert.doesNotMatch(
      text,
      /waits? for the owner's decision on the customer-names gap/,
      `${name}: the customer-names gap as still open`,
    );
    // H5 merged as #79 (2026-10-27).
    assert.doesNotMatch(text, /is open \(#79|#79[^)]*\bopen\b/, `${name}: #79 as open`);
  }
  assert.match(harnessEntry.get("H5").changes, /^PR #79\b/);
  assert.match(row(docs.adr0037, "2"), /now harness plan H5\*\* \([^)]*merged 2026-10-27 as #79/);
  assert.match(section("PR 26."), /PR 2's teammate contracts merged as H5 \(#79, 2026-10-27\)/);
  assert.match(docs.mvp, /harness plan H5, merged 2026-10-27 \(#79\)/);

  // mvp.md: G9 and the privacy rows follow OD-2026-10-26-10 and name H9d, the row that owns the
  // typed-name case; the harness plan's H20 row gates async-conversations on that case.
  assert.match(row(harnessPlan, "H20"), /OD-2026-10-26-10/);
  assert.match(row(harnessPlan, "H20"), /\(H9d\)/);
  const g9 = docs.mvp.split("\n").find((line) => line.startsWith("9. **G9, before real data:**"));
  assert.ok(g9, "mvp.md's G9");
  assert.match(g9, /`async-conversations` switch stays off until it exists and passes its tests/);
  assert.match(g9, /H9d's `lab:shopify-privacy` case/);
  assert.match(g9, /customer-names gap of ADR-0041 item 31 \(OD-2026-10-26-10\)/);
  for (const prefix of ["| Privacy and operations |", "| T14 Privacy |"]) {
    const line = docs.mvp.split("\n").find((l) => l.startsWith(prefix));
    assert.ok(line, prefix);
    assert.match(line, /P09\.T05[^|]*\(OD-2026-10-26-10\)[^|]*H9d/, prefix);
  }
  // G1 and the "Since 2026-10-26" note: ADR-0042 accepted, the CLAUDE.md words still the owner's.
  const g1 = docs.mvp.split("\n").find((line) => line.startsWith("1. **G1, W0:**"));
  assert.match(g1, /ADR-0042[^.]*accepted as recommended[^.]*\(OD-2026-10-26-9, pull request 86\)/);
  assert.match(g1, /the owner's word-for-word confirmation/);
  assert.match(g1, /customer-names gap of ADR-0041 item 31 \(OD-2026-10-26-10\)/);
  const since = docs.mvp.split("\n").find((line) => line.startsWith("**Since 2026-10-26**"));
  assert.match(
    since,
    /accepted \[ADR-0042\]\([^)]*\) \(connected services and customer contact\) as recommended \(OD-2026-10-26-9, pull request 86\)/,
  );
  assert.match(since, /approved in substance, their exact text waiting for the owner's/);
  // ADR-0042's own changes to mvp.md and the build order are its plan's CS2, which exists.
  const connected = read("docs/plan/connected-services-implementation.md");
  assert.match(connected, /^\| CS2 \| Amendment notes and plan documents \|/m);
  assert.match(since, /ADR-0042's own changes to this file[^.]*row CS2 of/);
  // COD Confirmation: Accepted, not built now, and customer-level data for agents other than
  // Support only through a further record (OD-2026-10-26-9).
  const cod = docs.mvp.split("\n").find((line) => line.startsWith("**COD Confirmation**"));
  assert.match(cod, /Accepted 2026-10-26 as recommended, OD-2026-10-26-9/);
  assert.match(cod, /not built now \(OD-2026-10-26-9\)/);
  assert.match(cod, /customer-level data for any agent other than Support needs a further record/);
  assert.doesNotMatch(cod, /orders and customers included once their deletion paths exist/);

  // The build order: the owner's choices cite their records, and PR 12's safety tests keep the
  // conversation off until a typed name can be deleted (H9d).
  assert.match(docs.order, /P09\.T05\) first, as part of the foundation \(OD-2026-10-26-10\)/);
  assert.match(
    section("PR 12."),
    /stays off until that path exists and its test shows a customer's name typed into a message is deleted[^\n]*\(OD-2026-10-26-10, harness plan H9d\)/,
  );
  const codOrder = docs.order.split("\n").find((line) => line.startsWith("COD Confirmation ("));
  assert.match(codOrder, /ADR-0042, accepted 2026-10-26/);
  assert.match(codOrder, /not built now \(OD-2026-10-26-9\)/);
  assert.match(codOrder, /customer details for any agent other than Support need a further/);
  assert.doesNotMatch(codOrder, /orders and customers included once their deletion paths exist/);
  assert.match(docs.order, /^At `main` `966fed03`, 2026-10-27\./m);
});
