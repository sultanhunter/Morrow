import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validators } from "../packages/contracts/src/generated/runtime-validators.mjs";
import {
  validateDefinition,
  validateCapabilityInput,
} from "../packages/contracts/src/validation.ts";

test("all 334 generated validators agree with the original compiler on bounded valid/invalid corpus", () => {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  addFormats(ajv);
  const schemas = Object.fromEntries(
    ["core", "capabilities", "billing"].map((name) => [
      name,
      JSON.parse(readFileSync(`docs/contracts/schemas/v1/${name}.schema.json`, "utf8")),
    ]),
  );
  for (const schema of Object.values(schemas)) ajv.addSchema(schema);
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
  assert.equal(Object.keys(validators).length, 334);
  let accepted = 0,
    rejected = 0;
  for (const [kind, schema] of Object.entries(schemas))
    for (const definition of Object.keys(schema.$defs)) {
      const reference = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
      const compiled = validators[`${kind}:${definition}`];
      for (const value of corpus) {
        const result = reference(structuredClone(value));
        assert.equal(compiled(structuredClone(value)), result, `${kind}:${definition}`);
        if (result) accepted++;
        else rejected++;
      }
    }
  assert.ok(accepted > 100);
  assert.ok(rejected > 1000);
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
