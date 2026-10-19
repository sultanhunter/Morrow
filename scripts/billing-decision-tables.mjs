// P01.T04a §5: generates the two checked-in billing decision tables from their
// ordered first-match rule lists, which reviewers read as the specification
// independently of packages/policy/src/billing-state.ts:
//   docs/contracts/decision-tables/classify-payment.rules.json -> classify-payment.tsv
//   docs/contracts/decision-tables/purchase-decision.rules.json -> purchase-decision.tsv
// Every table is the full cartesian product of its dimensions, in dimension order
// (the first dimension varies slowest), with exactly one outcome per row and the
// id of the rule that decided it. A row that no rule matches, a rule that decides
// no row, and an outcome no row has are errors.
//
//   node scripts/billing-decision-tables.mjs           writes both tables
//   node scripts/billing-decision-tables.mjs --check   fails on any drift (verify:billing)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "./foundation.mjs";

export const decisionTableNames = Object.freeze(["classify-payment", "purchase-decision"]);
export const decisionTableDirectory = "docs/contracts/decision-tables";
const token = /^[a-z][a-z_]*$/;
const outcomeToken = /^[A-Za-z][A-Za-z_]*(?::[A-Za-z][A-Za-z_]*)?$/;
const keysAre = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const uniqueStrings = (value, pattern) =>
  Array.isArray(value) &&
  value.length > 0 &&
  new Set(value).size === value.length &&
  value.every((x) => typeof x === "string" && pattern.test(x));

/** Structural errors of a rules file (closed objects, known dimensions, values and outcomes). */
export function validateRules(rules, name) {
  const errors = [];
  const fail = (reason) => errors.push(`DECISION_RULES_INVALID:${name}:${reason}`);
  if (
    !keysAre(rules, [
      "schema_version",
      "table",
      "packet",
      "description",
      "dimensions",
      "outcomes",
      "rules",
    ])
  ) {
    fail("keys");
    return errors;
  }
  if (rules.schema_version !== 1 || rules.table !== name || rules.packet !== "P01.T04a")
    fail("header");
  if (typeof rules.description !== "string" || !rules.description.trim()) fail("description");
  if (
    !Array.isArray(rules.dimensions) ||
    !rules.dimensions.length ||
    rules.dimensions.some(
      (d) =>
        !keysAre(d, ["name", "values", "meaning"]) ||
        typeof d.name !== "string" ||
        !token.test(d.name) ||
        !uniqueStrings(d.values, token) ||
        typeof d.meaning !== "string" ||
        !d.meaning.trim(),
    ) ||
    new Set(rules.dimensions.map((d) => d.name)).size !== rules.dimensions.length
  ) {
    fail("dimensions");
    return errors;
  }
  if (!uniqueStrings(rules.outcomes, outcomeToken)) {
    fail("outcomes");
    return errors;
  }
  const dimensions = new Map(rules.dimensions.map((d) => [d.name, d.values]));
  if (!Array.isArray(rules.rules) || !rules.rules.length) fail("rules");
  else {
    const ids = new Set();
    for (const rule of rules.rules) {
      if (
        !keysAre(rule, ["id", "when", "outcome", "source"]) ||
        typeof rule.id !== "string" ||
        !/^[A-Z][0-9]+[a-z]?$/.test(rule.id) ||
        ids.has(rule.id) ||
        typeof rule.source !== "string" ||
        !rule.source.trim() ||
        !rules.outcomes.includes(rule.outcome) ||
        rule.when === null ||
        typeof rule.when !== "object" ||
        Array.isArray(rule.when) ||
        Object.entries(rule.when).some(
          ([dimension, values]) =>
            !dimensions.has(dimension) ||
            !uniqueStrings(values, token) ||
            values.some((v) => !dimensions.get(dimension).includes(v)),
        )
      )
        fail("rule:" + (typeof rule?.id === "string" ? rule.id : "?"));
      ids.add(rule?.id);
    }
  }
  return errors;
}

/** The generated table: `{ header, rows: [{ key, values, outcome, rule }], text }`. Throws on rule errors. */
export function generateTable(rules, name = rules?.table) {
  const invalid = validateRules(rules, name);
  if (invalid.length) throw new Error(invalid.join("\n"));
  const dimensions = rules.dimensions;
  const rows = [];
  const used = new Set(),
    outcomes = new Set(),
    errors = [];
  const visit = (index, values) => {
    if (index === dimensions.length) {
      const row = Object.fromEntries(dimensions.map((d, i) => [d.name, values[i]]));
      const rule = rules.rules.find((r) =>
        Object.entries(r.when).every(([dimension, allowed]) => allowed.includes(row[dimension])),
      );
      if (!rule) errors.push(`DECISION_RULES_INCOMPLETE:${name}:${values.join(",")}`);
      else {
        used.add(rule.id);
        outcomes.add(rule.outcome);
        rows.push({ key: values.join("\t"), values: row, outcome: rule.outcome, rule: rule.id });
      }
      return;
    }
    for (const value of dimensions[index].values) visit(index + 1, [...values, value]);
  };
  visit(0, []);
  for (const rule of rules.rules)
    if (!used.has(rule.id)) errors.push(`DECISION_RULE_UNREACHABLE:${name}:${rule.id}`);
  for (const outcome of rules.outcomes)
    if (!outcomes.has(outcome)) errors.push(`DECISION_OUTCOME_UNUSED:${name}:${outcome}`);
  if (errors.length) throw new Error(errors.join("\n"));
  const header = [...dimensions.map((d) => d.name), "outcome", "rule"].join("\t");
  const text =
    [header, ...rows.map((r) => [r.key, r.outcome, r.rule].join("\t"))].join("\n") + "\n";
  return { header, rows, text };
}

/** Drift between a checked-in table and its rules; empty when they agree byte for byte. */
export function checkTable(rules, text, name = rules?.table) {
  let expected;
  try {
    expected = generateTable(rules, name);
  } catch (error) {
    return error.message.split("\n");
  }
  if (text === expected.text) return [];
  const errors = [];
  const lines = String(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== expected.header) errors.push(`DECISION_TABLE_HEADER_CHANGED:${name}`);
  const body = lines.slice(1);
  if (body.length !== expected.rows.length)
    errors.push(`DECISION_TABLE_ROW_COUNT:${name}:${body.length}/${expected.rows.length}`);
  const width = expected.header.split("\t").length - 2;
  const seen = new Map();
  for (const line of body) {
    const cells = line.split("\t");
    const key = cells.slice(0, width).join("\t");
    if (seen.has(key))
      errors.push(`DECISION_TABLE_DUPLICATE_ROW:${name}:${key.replaceAll("\t", ",")}`);
    seen.set(key, cells.slice(width).join("\t"));
  }
  for (const row of expected.rows) {
    const actual = seen.get(row.key);
    if (actual === undefined)
      errors.push(`DECISION_TABLE_MISSING_ROW:${name}:${row.key.replaceAll("\t", ",")}`);
    else if (actual !== row.outcome + "\t" + row.rule)
      errors.push(`DECISION_TABLE_ROW_CHANGED:${name}:${row.key.replaceAll("\t", ",")}`);
  }
  if (!errors.length) errors.push(`DECISION_TABLE_STALE:${name}`);
  return errors.slice(0, 20);
}

const read = (path) => readFileSync(resolve(root, path), "utf8");
export const rulesPath = (name) => `${decisionTableDirectory}/${name}.rules.json`;
export const tablePath = (name) => `${decisionTableDirectory}/${name}.tsv`;
export const readRules = (name) => JSON.parse(read(rulesPath(name)));

/** `--check` for both tables against the working tree. */
export function checkDecisionTables() {
  return decisionTableNames.flatMap((name) => {
    let text;
    try {
      text = read(tablePath(name));
    } catch {
      return [`DECISION_TABLE_MISSING:${name}`];
    }
    return checkTable(readRules(name), text, name);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== "--check") || args.length > 1) {
    console.error("usage: node scripts/billing-decision-tables.mjs [--check]");
    process.exit(2);
  }
  if (args[0] === "--check") {
    const errors = checkDecisionTables();
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else
      console.log(`PASS: ${decisionTableNames.length} billing decision tables match their rules.`);
  } else
    for (const name of decisionTableNames) {
      const { rows, text } = generateTable(readRules(name), name);
      writeFileSync(resolve(root, tablePath(name)), text);
      console.log(`wrote ${tablePath(name)} (${rows.length} rows)`);
    }
}
