import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  validators,
  currentDefinitionSelectors,
  capabilityBodySelectors,
  currentBillingDefinitionSelectors,
  eventPayloadSelectors,
  validateEventPayload,
} from "../packages/contracts/src/generated/runtime-validators.mjs";
import {
  validateDefinition,
  validateCapabilityInput,
  validateCurrentDefinition,
} from "../packages/contracts/src/validation.ts";
import {
  readSchemaSources,
  schemasByKind,
  currentDefinitionSelectors as expectedCurrent,
  currentBillingDefinitionSelectors as expectedBilling,
  capabilityBodySelectors as expectedBodies,
  browserValidatorDefinitions,
  eventPayloadSelectors as expectedEvents,
  readEventRegistry,
} from "../scripts/contract-sources.mjs";
import standaloneCode from "ajv/dist/standalone/index.js";
import {
  assertBrowserValidatorMatchesTable,
  browserValidatorSelector,
  browserValidatorsDirectory,
} from "../scripts/generate-runtime-validators.mjs";

const sources = readSchemaSources();
const definitionCount = sources.reduce((n, s) => n + Object.keys(s.schema.$defs).length, 0);

const schemas = schemasByKind(sources);
// The original compiler, at runtime and only in tests: the oracle for the generated code.
function referenceCompiler() {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  addFormats(ajv);
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
  return (selector) => {
    const split = selector.indexOf(":");
    const kind = selector.slice(0, split);
    return ajv.getSchema(`${schemas[kind].$id}#/$defs/${selector.slice(split + 1)}`);
  };
}
function parityCorpus() {
  const corpus = [
    undefined,
    null,
    true,
    false,
    0,
    1,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    "fixture",
    "2026-10-10T10:00:00Z",
    "2026-99-99T99:99:99Z",
    [],
    {},
    { amount: "1.25", currency: "USD" },
    {
      objective: "Investigate",
      storeIds: ["fixture"],
      successCriteria: [
        { description: "Evidence", verificationCapabilityId: null, evidenceRequired: true },
      ],
    },
  ];
  const add = (value) => {
    if (value && typeof value === "object") {
      corpus.push(value);
      for (const child of Object.values(value)) add(child);
    }
  };
  add(JSON.parse(readFileSync("docs/contracts/fixtures/P01.A02.json", "utf8")));
  add(JSON.parse(readFileSync("docs/contracts/fixtures/P01.T02a.json", "utf8")));
  add(JSON.parse(readFileSync("docs/contracts/fixtures/P01.T04a.json", "utf8")));
  add(JSON.parse(readFileSync("docs/contracts/fixtures/P01.T02c.json", "utf8")));
  return corpus;
}

test("every generated validator agrees with the original compiler on bounded valid/invalid corpus", () => {
  const reference = referenceCompiler();
  const corpus = parityCorpus();
  assert.equal(Object.keys(validators).length, definitionCount);
  let accepted = 0,
    rejected = 0;
  for (const [kind, schema] of Object.entries(schemas))
    for (const definition of Object.keys(schema.$defs)) {
      const original = reference(`${kind}:${definition}`);
      const compiled = validators[`${kind}:${definition}`];
      for (const value of corpus) {
        const result = original(structuredClone(value));
        assert.equal(compiled(structuredClone(value)), result, `${kind}:${definition}`);
        if (result) accepted++;
        else rejected++;
      }
    }
  assert.ok(accepted > 100);
  assert.ok(rejected > 1000);
});
// P05.T01y: each browser module is the table's validator for the effective selector, alone.
test("per-definition browser modules agree with their table entry and the original compiler", async () => {
  const manifest = JSON.parse(
    readFileSync("packages/contracts/src/generated/runtime-validators.json", "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.browser_validators), [...browserValidatorDefinitions]);
  assert.deepEqual(
    readdirSync(browserValidatorsDirectory).sort(),
    browserValidatorDefinitions.flatMap((name) => [`${name}.d.mts`, `${name}.mjs`]).sort(),
  );
  const reference = referenceCompiler();
  const rotation = { schemaVersion: 1, outcome: "rotated", idleRemainingMs: 1800000 };
  const rotationAccepted = [
    { ...rotation, absoluteRemainingMs: 43200000 },
    { ...rotation, outcome: "current", idleRemainingMs: 0, absoluteRemainingMs: 0 },
  ];
  const rotationRefused = [
    { ...rotation, absoluteRemainingMs: 43200001 },
    { ...rotation, absoluteRemainingMs: -1 },
    { ...rotation, absoluteRemainingMs: 1.5 },
    { ...rotation, absoluteRemainingMs: "1" },
    { ...rotation, absoluteRemainingMs: 1, outcome: "reuse_revoked" },
    { ...rotation, absoluteRemainingMs: 1, schemaVersion: 2 },
    { ...rotation, absoluteRemainingMs: 1, extra: true },
    rotation,
  ];
  const corpus = [...parityCorpus(), ...rotationAccepted, ...rotationRefused];
  for (const name of browserValidatorDefinitions) {
    const selector = currentDefinitionSelectors[name];
    const exportName = `validate${name}`;
    const path = `${browserValidatorsDirectory}/${name}.mjs`;
    assert.deepEqual(manifest.browser_validators[name], {
      selector,
      export: exportName,
      path,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    });
    // Through the package export, as browser code imports it.
    const module = await import(`@morrow/contracts/validators/${name}`);
    assert.deepEqual(Object.keys(module), [exportName]);
    const original = reference(selector);
    let accepted = 0;
    for (const value of corpus) {
      const result = original(structuredClone(value));
      assert.equal(validators[selector](structuredClone(value)), result, selector);
      assert.equal(module[exportName](structuredClone(value)), result, `${name} module`);
      if (result) accepted++;
    }
    assert.ok(accepted > 0, `${name}: the corpus has an accepted value`);
  }
  const { validateSessionRotationResult } = await import(
    "@morrow/contracts/validators/SessionRotationResult"
  );
  for (const value of rotationAccepted) assert.equal(validateSessionRotationResult(value), true);
  for (const value of rotationRefused) assert.equal(validateSessionRotationResult(value), false);
});
test("a browser validator name must be an own, well-formed effective core definition", () => {
  const current = expectedCurrent(schemas);
  for (const name of browserValidatorDefinitions)
    assert.equal(browserValidatorSelector(name, current), current[name]);
  assert.equal(
    browserValidatorSelector("SessionRotationResult", current),
    "core-v1.1:SessionRotationResult",
  );
  const billingOnly = Object.keys(expectedBilling(schemas)).find(
    (name) => !Object.hasOwn(current, name),
  );
  assert.ok(billingOnly, "a billing-only definition exists");
  for (const name of [
    "NoSuchDefinition",
    "sessionRotationResult",
    "Session-Rotation",
    "",
    billingOnly,
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "SessionRotationResult.input",
    1,
    null,
  ])
    assert.throws(
      () => browserValidatorSelector(name, current),
      { message: "RUNTIME_VALIDATOR_BROWSER_DEFINITION_UNKNOWN:" + name },
      String(name),
    );
  // Inherited, well-formed names are refused, and so are own names that are not
  // identifiers (each name becomes a file path and an export name).
  const inherited = Object.create({ Inherited: "core:Inherited" });
  assert.throws(() => browserValidatorSelector("Inherited", inherited), {
    message: "RUNTIME_VALIDATOR_BROWSER_DEFINITION_UNKNOWN:Inherited",
  });
  const malformed = Object.fromEntries(
    ["../Escape", "lower", "Has Space", "Dotted.input", "Trailing\n"].map((name) => [
      name,
      `core:${name}`,
    ]),
  );
  for (const name of Object.keys(malformed))
    assert.throws(
      () => browserValidatorSelector(name, malformed),
      { message: "RUNTIME_VALIDATOR_BROWSER_DEFINITION_UNKNOWN:" + name },
      JSON.stringify(name),
    );
});
test("a browser module that diverges from its table entry is refused", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true, code: { source: true, esm: true } });
  const $id = "https://morrow.test/browser-validator.json";
  ajv.addSchema({
    $id,
    $defs: {
      A: { type: "object", properties: { n: { type: "integer" } }, additionalProperties: false },
      B: { type: "string", maxLength: 3 },
    },
  });
  const [refA, refB] = [`${$id}#/$defs/A`, `${$id}#/$defs/B`];
  ajv.getSchema(refA);
  ajv.getSchema(refB);
  const table = standaloneCode(ajv, { v0: refA, v1: refB });
  const own = standaloneCode(ajv, { validateA: refA });
  const source = ajv.getSchema(refA).source;
  const matching = { table, tableExport: "v0", own, ownExport: "validateA", source };
  assert.doesNotThrow(() => assertBrowserValidatorMatchesTable("A", matching));
  const extra = "\nfunction validate999(data){return true;}\n";
  // The same function name and declaration, one changed byte in its body.
  const edited = (text) =>
    text.replace(source.validateCode, source.validateCode.replace("errors = 0", "errors = 1"));
  assert.notEqual(edited(table), table);
  for (const [label, change] of [
    ["the table exports another function under that name", { tableExport: "v1" }],
    ["the module exports it under another name", { ownExport: "validateB" }],
    ["the module is another definition's", { own: standaloneCode(ajv, { validateA: refB }) }],
    ["the table carries other code for the function", { table: edited(table) }],
    ["the module carries other code for the function", { own: edited(own) }],
    ["the module declares a function the table does not", { own: own + extra }],
  ])
    assert.throws(
      () => assertBrowserValidatorMatchesTable("A", { ...matching, ...change }),
      { message: "RUNTIME_VALIDATOR_BROWSER_DIVERGED:A" },
      label,
    );
  // A function the table declares too is not divergence.
  assert.doesNotThrow(() =>
    assertBrowserValidatorMatchesTable("A", {
      ...matching,
      table: table + extra,
      own: own + extra,
    }),
  );
});
test("closed validator selectors cannot invoke inherited names or coerce input", () => {
  for (const name of ["constructor", "toString", "__proto__", "unknown"])
    assert.equal(validateDefinition("core", name, {}), false);
  assert.equal(validateDefinition("core", "Revision", "1"), false);
  assert.equal(validateCapabilityInput("unknown", {}), false);
  const input = {
    objective: "Investigate",
    storeIds: ["fixture"],
    successCriteria: [
      { description: "Evidence", verificationCapabilityId: null, evidenceRequired: true },
    ],
    extra: "denied",
  };
  const copy = structuredClone(input);
  assert.equal(validateCapabilityInput("workspace.goal.create", input), false);
  assert.deepEqual(input, copy);
});
test("effective selectors resolve to the newest layer and are frozen", () => {
  const byKind = schemasByKind(sources);
  const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
  assert.deepEqual({ ...currentDefinitionSelectors }, expectedCurrent(byKind));
  assert.deepEqual(
    { ...capabilityBodySelectors },
    expectedBodies(
      byKind,
      catalogue.capabilities.map((c) => c.id),
    ),
  );
  assert.deepEqual({ ...currentBillingDefinitionSelectors }, expectedBilling(byKind));
  // P01.T02c: the event registry selector (ADR-0016), derived from the registry.
  assert.deepEqual(
    JSON.parse(JSON.stringify(eventPayloadSelectors)),
    expectedEvents(byKind, readEventRegistry()),
  );
  for (const row of Object.values(eventPayloadSelectors)) {
    assert.ok(Object.isFrozen(row));
    assert.ok(Object.hasOwn(validators, row.selector), row.selector);
  }
  assert.equal(validateEventPayload("project.pin_changed", "project", { pinned: true }), true);
  assert.equal(validateEventPayload("project.pin_changed", "project", { pinned: "yes" }), false);
  assert.equal(validateEventPayload("hasOwnProperty", "project", {}), false);
  for (const selectors of [
    validators,
    currentDefinitionSelectors,
    capabilityBodySelectors,
    currentBillingDefinitionSelectors,
    eventPayloadSelectors,
  ])
    assert.ok(Object.isFrozen(selectors));
  for (const selector of [
    ...Object.values(currentDefinitionSelectors),
    ...Object.values(capabilityBodySelectors),
    ...Object.values(currentBillingDefinitionSelectors),
  ])
    assert.ok(Object.hasOwn(validators, selector), selector);
  // P01.T04a: billing resolves to the newest billing layer (ADR-0015).
  assert.equal(currentBillingDefinitionSelectors.BillingAccount, "billing-v1.1:BillingAccount");
  assert.equal(currentBillingDefinitionSelectors.CreditWallet, "billing:CreditWallet");
  assert.equal(currentDefinitionSelectors.ActorRef, "core:ActorRef");
  assert.equal(currentDefinitionSelectors.KillSwitchControl, "core-v1.1:KillSwitchControl");
  assert.equal(
    capabilityBodySelectors["ads.campaign.pause.input"],
    "capabilities-v1.1:ads.campaign.pause.input",
  );
  assert.equal(
    capabilityBodySelectors["ads.campaign.pause.output"],
    "capabilities:ads.campaign.pause.output",
  );
  // P01.T02c: EventEnvelope@2 replaces v1 (ADR-0016); new collaboration bodies are additions.
  assert.equal(currentDefinitionSelectors.EventEnvelope, "core-v1.1:EventEnvelope");
  assert.equal(currentDefinitionSelectors.InboxItem, "core-v1.1:InboxItem");
  for (const io of ["input", "output"])
    assert.equal(
      capabilityBodySelectors[`workspace.conversation.post.${io}`],
      `capabilities-v1.1:workspace.conversation.post.${io}`,
    );
  // PR-B replacements and additions (ADR-0011).
  assert.equal(currentDefinitionSelectors.Proposal, "core-v1.1:Proposal");
  assert.equal(currentDefinitionSelectors.Approval, "core-v1.1:Approval");
  assert.equal(currentDefinitionSelectors.ProposalRef, "core:ProposalRef");
  assert.equal(currentDefinitionSelectors.ReviewPolicy, "core-v1.1:ReviewPolicy");
  assert.equal(
    capabilityBodySelectors["governance.approval.decide.input"],
    "capabilities-v1.1:governance.approval.decide.input",
  );
  assert.equal(
    capabilityBodySelectors["governance.approval.decide.output"],
    "capabilities:governance.approval.decide.output",
  );
  for (const io of ["input", "output"])
    for (const id of ["governance.approval.preview", "governance.review_policy.revise"])
      assert.equal(capabilityBodySelectors[`${id}.${io}`], `capabilities-v1.1:${id}.${io}`);
  const control = { reason: "Overspend", sourceProposalRef: null };
  assert.equal(validateCurrentDefinition("KillSwitchControl", control), true);
  assert.equal(validateDefinition("core-v1.1", "KillSwitchControl", control), true);
  assert.equal(validateDefinition("core", "KillSwitchControl", control), false);
  for (const name of ["constructor", "__proto__", "ads.campaign.pause.input"])
    assert.equal(validateCurrentDefinition(name, control), false);
  // Only the declared definition layers are selectable; bodies go through the
  // effective capability validators.
  for (const schema of ["capabilities", "capabilities-v1.1", "core-v1.1:KillSwitchControl#"])
    assert.equal(validateDefinition(schema, "ads.campaign.pause.input", {}), false);
});
