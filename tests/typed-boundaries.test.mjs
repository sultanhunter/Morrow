import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inspectImports, inspectCompatibility } from "../scripts/boundary-checks.mjs";
import {
  validateDefinition,
  validateCapabilityInput,
} from "../packages/contracts/src/validation.ts";
import { createCapabilityClient } from "../packages/contracts/src/client.ts";
const input = {
  objective: "Investigate",
  storeIds: ["demo"],
  successCriteria: [
    { description: "Evidence", verificationCapabilityId: null, evidenceRequired: true },
  ],
};
test("generated client validates a real input/output pair", async () => {
  const client = createCapabilityClient(async () => ({ goalId: "goal", revision: 1 }));
  assert.deepEqual(await client.invoke("workspace.goal.create", input), {
    goalId: "goal",
    revision: 1,
  });
});
test("extra input cannot reach transport", async () => {
  let calls = 0;
  const client = createCapabilityClient(async () => {
    calls++;
  });
  await assert.rejects(
    client.invoke("workspace.goal.create", { ...input, shop: "forged" }),
    /Invalid capability input/,
  );
  assert.equal(calls, 0);
});
test("provider output is not accepted on static types alone", async () => {
  const client = createCapabilityClient(async () => ({ goalId: "goal", revision: "1" }));
  await assert.rejects(client.invoke("workspace.goal.create", input), /Invalid capability output/);
});
test("closed input validation does not coerce", () =>
  assert.equal(
    validateCapabilityInput("workspace.goal.create", { ...input, objective: 42 }),
    false,
  ));
for (const [value, expected] of [
  [1, true],
  [1.2, false],
  ["1", false],
  [Number.MAX_SAFE_INTEGER + 1, false],
])
  test("runtime revision " + String(value), () =>
    assert.equal(validateDefinition("core", "Revision", value), expected),
  );
for (const code of [
  "import x from '@shopify/shopify-app-react-router/server'",
  "export {x} from './credentials.server'",
  "import x from '../../api/src/index'",
  "const x=import(secretModule)",
  "const x=process['env']['KEY']",
  "import fs from 'fs'",
])
  test("deny UI crossing: " + code, () =>
    assert.ok(inspectImports("apps/workspace-web/src/test.tsx", code).length > 0),
  );
test("ordinary shared UI imports allowed", () =>
  assert.deepEqual(
    inspectImports(
      "apps/workspace-web/src/test.tsx",
      "import {FoundationNotice} from '@morrow/workspace-ui'",
    ),
    [],
  ));
test("neutral contracts cannot depend on app implementations", () =>
  assert.ok(
    inspectImports(
      "packages/contracts/src/index.ts",
      "export {x} from '../../../apps/api/src/index'",
    ).length > 0,
  ));
test("incompatible schema delta blocks before baseline rewrite", () => {
  const baseline = JSON.parse(readFileSync("docs/contracts/release-baseline.json", "utf8"));
  const sources = Object.fromEntries(
    Object.keys(baseline.schemas).map((p) => [p, readFileSync(p, "utf8")]),
  );
  assert.deepEqual(inspectCompatibility(baseline, sources), []);
  const path = Object.keys(sources)[0],
    schema = JSON.parse(sources[path]);
  schema.$defs.Id.type = "number";
  sources[path] = JSON.stringify(schema);
  assert.equal(inspectCompatibility(baseline, sources).length, 1);
});
