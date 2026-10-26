// ADR-0042 (connected services and customer contact), accepted in OD-2026-10-26-9, and the
// owner's answer on the customer-names gap (OD-2026-10-26-10). The owner's "yes" approved the four
// CLAUDE.md lines of owner question 6 in substance only, since the sheet showed their words after
// the answer; CS2 commits them only after the owner confirms them word for word. These checks keep
// the records consistent with that: no switch under which a call plan acts goes on before CS2's
// commit (review finding F1 on pull request 86), the answered sheet's own approval text carries the
// dated note (F2), the agent's rows name CS16b rather than all of CS16 (F3), and one harness plan
// row owns how a customer's name typed as free text is matched and its lab case (F4). Pure: reads
// repository files only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");
const adrPath = "docs/decisions/adr/ADR-0042-connected-services-and-customer-contact.md";
const planPath = "docs/plan/connected-services-implementation.md";
const harnessPath = "docs/plan/harness-foundations-implementation.md";
const acceptancePath = "docs/graph/decisions/OD-2026-10-26-9.md";
const namesPath = "docs/graph/decisions/OD-2026-10-26-10.md";
const sheetPath = "docs/graph/questions/Q-adr-0042-owner-questions.md";
const adr = read(adrPath);
const plan = read(planPath);
const harness = read(harnessPath);
const acceptance = read(acceptancePath);
const names = read(namesPath);
const sheet = read(sheetPath);

// The switches under which a call plan runs, a plan-driven tag is written or a customer is
// contacted. Each of them acts under the changed CLAUDE.md lines.
const planSwitches = ["`contact-rules`", "`order-tag-writes`", "`contact-live-recipients`"];

/** Prose with its line breaks folded, so a phrase wrapped across lines still matches. */
const flat = (text) => text.replace(/\s+/g, " ");

/** The text between two markers, each of which must occur. */
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `missing ${JSON.stringify(start)}`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
  return text.slice(from, to);
};

/** The cells of the plan table row whose first cell is `id`. */
const row = (text, id) => {
  const lines = text.split("\n").filter((l) => l.startsWith(`| ${id} | `));
  assert.equal(lines.length, 1, `exactly one row ${id}`);
  return lines[0].replace(/^\| /, "").replace(/ \|$/, "").split(" | ");
};

test("F1: ADR-0042 item 27 holds every plan switch until CS2 commits the four CLAUDE.md lines", () => {
  const item = between(adr, "27. **Switches, order and scope**", "\n## Values");
  const gate = item
    .split("\n")
    .find((l) => l.startsWith("    - Each goes on by one reviewed commit"));
  assert.ok(gate, "item 27's switch-gate bullet");
  assert.ok(
    gate.includes("also goes on only after CS2's commit of the four CLAUDE.md lines"),
    "the gate waits for CS2's CLAUDE.md commit",
  );
  assert.ok(gate.includes("the owner's word-for-word confirmation"));
  for (const name of planSwitches) assert.ok(gate.includes(name), `item 27 names ${name}`);

  // Security invariants touched: the promise that nothing reaches a customer rests on that gate.
  const invariants = between(adr, "## Security invariants touched", "\n## ");
  assert.ok(
    flat(invariants).includes(
      "until it lands, `contact-rules`, `order-tag-writes` and `contact-live-recipients` stay off (item 27)",
    ),
  );
  assert.ok(
    flat(invariants).includes(
      "those from `contact-rules` on go on only after CS2 commits the four lines (item 27)",
    ),
  );
});

test("F1: the plan's CS16b waits for CS2's CLAUDE.md commit from contact-rules on", () => {
  const [, , , startsAfter] = row(plan, "CS16b");
  assert.ok(
    startsAfter.includes("CS2's CLAUDE.md commit, after the owner's word-for-word confirmation"),
  );
  for (const name of planSwitches) assert.ok(startsAfter.includes(name), `CS16b names ${name}`);
});

test("F1: neither the plan nor OD-2026-10-26-9 says call plans wait for the agent", () => {
  // CS9 and CS11 build call plans and plan-driven tag writes now, as foundation.
  for (const [path, text] of [
    [planPath, plan],
    [acceptancePath, acceptance],
  ]) {
    const prose = flat(text);
    assert.doesNotMatch(prose, /call plans wait for the agent/, path);
    assert.doesNotMatch(prose, /Nothing waits on (it|this)/, path);
    assert.ok(
      prose.includes("CS9 and CS11 build call plans and plan-driven tag writes now"),
      `${path} says the foundation builds call plans now`,
    );
    assert.ok(prose.includes("ADR-0042 item 27"), `${path} points to item 27's gate`);
    for (const name of planSwitches) assert.ok(prose.includes(name), `${path} names ${name}`);
  }
  // The owner's action names the commit the switches wait for.
  const action = flat(between(plan, "Now: one.", "\n\nWhen you ask"));
  assert.ok(
    action.includes("those switches wait for your request for the agent and for this commit"),
  );
});

test("F2: the answered sheet's approval text carries a dated note at each place it claims word for word", () => {
  assert.match(sheet, /^status: answered$/m);
  const prose = flat(sheet);
  const claims = [
    'say "approve ADR-0042 as recommended and the CLAUDE.md change"',
    'A "yes" approves these four edits word for word',
  ];
  for (const claim of claims) {
    const at = prose.indexOf(claim);
    assert.ok(at >= 0, claim);
    assert.equal(prose.indexOf(claim, at + 1), -1, `${claim} once`);
    // The note follows within the same paragraph or bullet, before the next numbered line.
    const after = prose.slice(at, at + 700);
    assert.match(after, /\(Note of 2026-10-27: /, claim);
    assert.ok(after.includes("after the answer"), claim);
    assert.ok(after.includes("in substance only"), claim);
    assert.ok(after.includes("word-for-word confirmation"), claim);
  }
});

test("F3: the agent's rows name CS16b, never all of CS16", () => {
  // CS16a (service-connections, order-events) may go on before the owner asks for the agent.
  for (const [path, text] of [
    [adrPath, adr],
    [acceptancePath, acceptance],
    [planPath, plan],
  ]) {
    const bare = flat(text).match(/\bCS16(?![ab'])\S*/g) ?? [];
    assert.deepEqual(bare, [], `${path} names CS16 without a letter`);
  }
  const approval = flat(between(adr, "\n## Approval", "Not approved by it"));
  assert.ok(approval.includes("CS10, CS13, CS14, CS15 and CS16b (CS16's contact switches)"));
  assert.ok(
    flat(acceptance).includes("CS10, CS13, CS14, CS15 and CS16b (CS16's contact switches)"),
  );
  for (const text of [approval, flat(acceptance)])
    assert.ok(
      text.includes("CS16a's foundation switches, `service-connections` and `order-events`"),
    );
});

test("F4: one harness row, H9d, owns how a typed customer name is matched and its lab case", () => {
  const owners = harness
    .split("\n")
    .filter((l) => /^\| H\d/.test(l))
    .filter((l) => l.includes("how a customer's name typed as free text is matched"));
  assert.equal(owners.length, 1, "exactly one row owns the decision");
  const [id, , , startsAfter, , does, gatedBy] = row(harness, "H9d");
  assert.equal(id, "H9d");
  assert.ok(owners[0].startsWith("| H9d | "));
  assert.ok(startsAfter.includes("SD4 of `docs/plan/store-data-foundation-implementation.md`"));
  assert.ok(does.includes("Its brief decides how a customer's name typed as free text is matched"));
  assert.ok(does.includes("`content: customer`"));
  assert.match(
    gatedBy,
    /^`lab:shopify-privacy` \(a customer's name typed into a message is deleted by `customers\/redact`/,
  );

  // H9a no longer leaves the gap with the owner without the decision; H20 names the owner row.
  const [, , , , , h9a] = row(harness, "H9a");
  assert.ok(
    h9a.includes("(Note of 2026-10-27: the owner decided it on 2026-10-26, OD-2026-10-26-10"),
  );
  assert.ok(
    h9a.includes("H9d owns how a typed name is matched and its `lab:shopify-privacy` case"),
  );
  const h20 = row(harness, "H20").at(-1);
  assert.ok(h20.includes("a name typed into a message (H9d)"));
  assert.ok(flat(harness).includes("H9d's brief decides how a typed name is matched"));

  // The decision and the records it notes point to the same row.
  assert.ok(flat(names).includes("one row owns this decision and this case, H9d"));
  const adr41 = read("docs/decisions/adr/ADR-0041-harness-foundations.md");
  assert.ok(
    adr41.includes("that work is row H9d of `docs/plan/harness-foundations-implementation.md`"),
  );
  const adr40 = read("docs/decisions/adr/ADR-0040-messaging-with-agents.md");
  assert.ok(
    adr40.includes("(Note of 2026-10-27: the owner decided it on 2026-10-26, OD-2026-10-26-10"),
  );
});
