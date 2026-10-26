// The CLAUDE.md wording drafts of harness plan row H2 (docs/briefs/claude-md-wording-2026-10.md).
// CLAUDE.md changes only with the owner's own confirmation of its text (OD-2026-10-23-10), so
// the drafts live in a brief until then. These tests keep the brief honest: every "Before" is
// still in CLAUDE.md, exactly once, until its "After" replaces it, so the page the owner reads
// cannot drift from the file it changes; and every "After" obeys the wording rules that
// plan:check applies to CLAUDE.md.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectWording } from "../scripts/plan-check.mjs";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const briefPath = "docs/briefs/claude-md-wording-2026-10.md";
const brief = readFileSync(join(repository, briefPath), "utf8");
const rules = readFileSync(join(repository, "CLAUDE.md"), "utf8");

// ADR 0042 is approved as recommended, but its record is still being finalised in pull
// request 86; its section of the brief is marked provisional until the file lands.
const PENDING_ADRS = new Set(["0042"]);

// The fenced blocks, in order, with their info strings and the section heading above them.
function draftBlocks(text) {
  const blocks = [];
  let section = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^#{2,3} (.+)$/.exec(lines[i]);
    if (heading) section = heading[1];
    const open = /^```(claude-md-(?:before|after))$/.exec(lines[i]);
    if (!open) continue;
    const body = [];
    for (i += 1; i < lines.length && lines[i] !== "```"; i += 1) body.push(lines[i]);
    assert.ok(i < lines.length, `an unclosed ${open[1]} block in ${section}`);
    blocks.push({ kind: open[1].slice("claude-md-".length), section, text: body.join("\n") });
  }
  return blocks;
}

function draftPairs(text) {
  const blocks = draftBlocks(text);
  assert.equal(blocks.length % 2, 0, "every Before has an After");
  const pairs = [];
  for (let i = 0; i < blocks.length; i += 2) {
    const [before, after] = [blocks[i], blocks[i + 1]];
    assert.equal(before.kind, "before", `block ${i} is a Before`);
    assert.equal(after.kind, "after", `block ${i + 1} is an After`);
    assert.equal(before.section, after.section, `${before.section}: one section per pair`);
    pairs.push({ section: before.section, before: before.text, after: after.text });
  }
  return pairs;
}

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
const pairs = draftPairs(brief);

test("the H2 brief drafts the four requested changes, each as a Before and an After", () => {
  const sections = pairs.map((p) => p.section);
  for (const pattern of [/^A\. The "MVP" line/, /^B\. The stack line/, /^C\. The model line/])
    assert.equal(sections.filter((s) => pattern.test(s)).length, 1, String(pattern));
  assert.ok(
    sections.some((s) => /^D\d\. /.test(s)),
    "the lines ADR 0042 changes",
  );
  for (const { section, before, after } of pairs) {
    assert.notEqual(before.trim(), "", `${section}: an empty Before`);
    assert.notEqual(before, after, `${section}: the After changes something`);
  }
});

test("each Before is in CLAUDE.md exactly once until its After replaces it", () => {
  for (const { section, before, after } of pairs) {
    if (rules.includes(after)) continue; // applied after the owner's confirmation
    assert.equal(
      occurrences(rules, before),
      1,
      `${section}: its Before is no longer in CLAUDE.md (or is ambiguous); update the brief`,
    );
  }
});

test("each After keeps CLAUDE.md's wording rules and names only real records", () => {
  const adrs = new Set(
    readdirSync(join(repository, "docs/decisions/adr"))
      .map((name) => /^ADR-(\d{4})-/.exec(name)?.[1])
      .filter(Boolean),
  );
  for (const { section, after } of pairs) {
    assert.deepEqual(inspectWording(after, `${section}: `), [], section);
    for (const [, number] of after.matchAll(/\bADR-(\d{4})\b/g))
      assert.ok(
        adrs.has(number) || (PENDING_ADRS.has(number) && /^D\d\. /.test(section)),
        `${section} names ADR-${number}, which is not a record`,
      );
  }
});

test("the drafts say what the accepted records say", () => {
  const after = (pattern) => pairs.find((p) => pattern.test(p.section)).after;
  // ADR-0040 item 15 names the stack line's addition word for word.
  assert.ok(after(/^B\. /).includes("Durable Objects (ADR-0038, ADR-0040)"));
  // ADR-0041's Consequences: "MVP" names the launch scope, not the harness (OD-2026-10-26-6).
  assert.match(after(/^A\. /), /names the launch scope only/);
  assert.match(after(/^A\. /), /never names the foundation/);
  assert.doesNotMatch(after(/^A\. /), /specialist/);
  // ADR-0023 keeps ADR-0021 item 2's production-grade architecture; ADR-0041 extends the rule to
  // the harness, so the After keeps CLAUDE.md's clause word for word.
  assert.match(
    after(/^A\. /),
    /The architecture stays production-grade so it scales without rewrites/,
  );
  // ADR-0041 item 2: Opus 5.5 only, medium or high; no Haiku, Sonnet or low effort.
  const models = after(/^C\. /);
  assert.match(models, /Claude Opus 5\.5 only/);
  assert.match(models, /`high`/);
  assert.match(models, /`medium`/);
  assert.match(models, /No Haiku, no Sonnet and no `low` effort/);
  assert.match(models, /no agent SDK/);
  // ADR 0042's owner question 6 shows four CLAUDE.md edits word for word; D1 to D4 copy them,
  // each naming the record, and D1 keeps "Any edit invalidates them" for every other approval.
  const contact = pairs.filter((p) => /^D\d\. /.test(p.section));
  assert.deepEqual(
    contact.map((p) => p.section.slice(0, 2)),
    ["D1", "D2", "D3", "D4"],
  );
  for (const { section, after } of contact) assert.match(after, /\(ADR-0042\)/, section);
  assert.match(contact[0].after, /Any edit invalidates them\./);
  assert.match(contact[0].after, /the approved revision keeps running until then/);
});
