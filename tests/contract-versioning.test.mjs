// P01.T02a PR-A: contract versioning (AC01-AC05, AC10). docs/contracts/contract-versions.md.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  inspectCompatibility,
  inspectBaselineCoverage,
  inspectDeclaredReplacements,
} from "../scripts/boundary-checks.mjs";
import {
  contractVersion as sourceVersion,
  changesPath,
  readSchemaSources,
  schemasByKind,
} from "../scripts/contract-sources.mjs";
import { checkFixture } from "../scripts/contract-checks.mjs";
import { generateContracts } from "../scripts/generate-contracts.mjs";
import { generateRuntimeValidators } from "../scripts/generate-runtime-validators.mjs";
import { contractVersion } from "../packages/contracts/src/index.ts";
import {
  validateCapabilityInput,
  validateDefinition,
} from "../packages/contracts/src/validation.ts";

const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));
const baseline = json("docs/contracts/release-baseline.json");
const sources = readSchemaSources();
const texts = Object.fromEntries(sources.map((s) => [s.path, s.text]));
const layered = schemasByKind(sources);
const changes = json(changesPath);
const v1Paths = sources.filter((s) => s.path.includes("/v1/")).map((s) => s.path);
function schemaFiles(dir = "docs/contracts/schemas") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? schemaFiles(`${dir}/${entry.name}`)
      : entry.name.endsWith(".schema.json")
        ? [`${dir}/${entry.name}`]
        : [],
  );
}

test("AC01: v1 files are byte-identical to the frozen baseline", () => {
  assert.deepEqual(v1Paths, [
    "docs/contracts/schemas/v1/core.schema.json",
    "docs/contracts/schemas/v1/capabilities.schema.json",
    "docs/contracts/schemas/v1/billing.schema.json",
  ]);
  for (const path of v1Paths)
    assert.equal(createHash("sha256").update(texts[path]).digest("hex"), baseline.schemas[path]);
  assert.deepEqual(inspectCompatibility(baseline, texts), []);
  assert.equal(baseline.current, contractVersion);
  assert.deepEqual(baseline.versions, {
    "morrow.contracts.v1": { status: "frozen" },
    "morrow.contracts.v1.1": {
      status: "candidate_owner_signoff",
      extends: "morrow.contracts.v1",
    },
  });
  // v1 never refers to v1.1.
  for (const path of v1Paths) assert.doesNotMatch(texts[path], /v1\.1/);
});

test("AC01: changing one byte of any v1 file is an unreviewed schema delta", () => {
  for (const path of v1Paths) {
    const text = texts[path];
    const changed = { ...texts, [path]: text.slice(0, -1) + (text.endsWith("\n") ? " " : "\n") };
    assert.equal(changed[path].length, text.length);
    assert.deepEqual(inspectCompatibility(baseline, changed), ["UNREVIEWED_SCHEMA_DELTA:" + path]);
  }
});

test("AC01: every P01.A02 case passes under the v1 selectors, reference and generated", () => {
  const fixtures = json("docs/contracts/fixtures/P01.A02.json");
  assert.ok(fixtures.length > 200);
  for (const fixture of fixtures) {
    assert.equal(checkFixture(fixture), true, fixture.id);
    if (fixture.kind === "schema")
      assert.equal(
        validateDefinition("core", fixture.definition, fixture.value),
        fixture.valid,
        fixture.id,
      );
  }
});

test("AC02: every schema file is baselined; an unbaselined one is reported", () => {
  const files = schemaFiles();
  assert.deepEqual(files.sort(), Object.keys(baseline.schemas).sort());
  assert.deepEqual(inspectBaselineCoverage(baseline, files), []);
  assert.deepEqual(
    inspectBaselineCoverage(baseline, [...files, "docs/contracts/schemas/v1.1/extra.schema.json"]),
    ["UNBASELINED_SCHEMA:docs/contracts/schemas/v1.1/extra.schema.json"],
  );
});

test("AC03: replacements are declared, and undeclared ones are reported", () => {
  assert.deepEqual(inspectDeclaredReplacements(changes, layered), []);
  assert.deepEqual(
    changes.changes.map((c) => c.name),
    [
      "ads.campaign.pause.input",
      "agents.installation.disable.input",
      "governance.membership.revoke.input",
      "governance.connection.disconnect.input",
      "agents.release.revoke.input",
    ],
  );
  for (const change of changes.changes) {
    assert.equal(change.kind, "capability_body");
    assert.equal(change.adr, "ADR-0005");
    assert.equal(change.replaces, "capabilities:" + change.name);
  }
  const removed = {
    ...changes,
    changes: changes.changes.filter((c) => c.name !== "ads.campaign.pause.input"),
  };
  assert.deepEqual(inspectDeclaredReplacements(removed, layered), [
    "UNDECLARED_REPLACEMENT:ads.campaign.pause.input",
  ]);
  const reused = structuredClone(layered);
  reused["core-v1.1"].$defs.Proposal = reused.core.$defs.Proposal;
  assert.deepEqual(inspectDeclaredReplacements(changes, reused), [
    "UNDECLARED_REPLACEMENT:Proposal",
  ]);
  for (const entry of [
    { ...changes.changes[0], name: "Invented" },
    { ...changes.changes[0], replaces: "capabilities:ads.campaign.activate.input" },
    { ...changes.changes[0], kind: "definition" },
    { ...changes.changes[0], adr: "" },
    { ...changes.changes[0], reason: " " },
    { ...changes.changes[0], extra: true },
  ])
    assert.ok(
      inspectDeclaredReplacements(
        { ...changes, changes: [...changes.changes.slice(1), entry] },
        layered,
      ).some((error) => error.startsWith("UNDECLARED_REPLACEMENT:")),
      JSON.stringify(entry),
    );
  // A new body in v1.1 for a capability v1 never had is an addition, not a replacement.
  const added = structuredClone(layered);
  added["capabilities-v1.1"].$defs["governance.review_policy.revise.input"] = {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  };
  assert.deepEqual(inspectDeclaredReplacements(changes, added), []);
});

test("AC04: generation is ahead of time, deterministic and matches the committed output", async () => {
  const first = generateContracts();
  assert.deepEqual(generateContracts().files, first.files);
  for (const [path, text] of Object.entries(first.files)) assert.equal(read(path), text, path);
  const validators = await generateRuntimeValidators();
  assert.deepEqual((await generateRuntimeValidators()).files, validators.files);
  for (const [path, text] of Object.entries(validators.files)) assert.equal(read(path), text, path);
  const definitions = sources.reduce((n, s) => n + Object.keys(s.schema.$defs).length, 0);
  assert.equal(first.manifest.definitions, definitions);
  assert.equal(validators.manifest.definitions, definitions);
  assert.equal(first.manifest.schema_version, 2);
  assert.equal(first.manifest.contract_version, sourceVersion);
  assert.deepEqual(
    first.manifest.replacements.map((r) => r.name),
    changes.changes.map((c) => c.name),
  );
  const check = spawnSync(process.execPath, ["scripts/generate-contracts.mjs", "--check"], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
  // No runtime schema compiler or code generation reaches the validator bundle.
  const bundle = read("packages/contracts/src/generated/runtime-validators.mjs");
  assert.doesNotMatch(bundle, /new Function|\beval\(/);
});

test("AC05: the effective kill-switch bodies replace the v1 bodies", () => {
  const campaign = {
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeId: "store_a",
    connectionId: "connection_a",
    kind: "campaign",
    id: "campaign_a",
  };
  const control = { reason: "Overspend", sourceProposalRef: null };
  const pause = (value) => validateCapabilityInput("ads.campaign.pause", value);
  assert.equal(pause({ campaigns: [campaign], control }), true);
  const proposalRef = {
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeId: "store_a",
    kind: "proposal",
    id: "proposal_a",
    revision: 1,
    digest: "a".repeat(64),
  };
  for (const invalid of [
    { proposalRef, approvalRef: { ...proposalRef, kind: "approval" } },
    { campaigns: [campaign], control: { ...control, reason: "" } },
    { campaigns: [campaign], control: { ...control, reason: "   " } },
    { campaigns: [], control },
    { campaigns: [campaign, { ...campaign }], control },
    { campaigns: [{ ...campaign, kind: "product" }], control },
    { campaigns: [campaign], control, apiKey: "fixture-not-secret" },
  ])
    assert.equal(pause(invalid), false, JSON.stringify(invalid));
  assert.equal(
    validateCapabilityInput("governance.membership.revoke", {
      membershipId: "membership_a",
      control,
    }),
    true,
  );
  assert.equal(
    validateCapabilityInput("governance.membership.revoke", {
      membershipId: "membership_a",
      expectedRevision: 1,
      control,
    }),
    false,
  );
  // Outputs are unchanged, and the v1 bodies stay valid only under their exact selectors.
  for (const fixture of json("docs/contracts/fixtures/P01.T02a.json"))
    assert.equal(checkFixture(fixture), true, fixture.id);
});

test("AC10: contractVersion has exactly one source", () => {
  assert.equal(contractVersion, "morrow.contracts.v1.1");
  assert.equal(contractVersion, sourceVersion);
  const declarations = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", "build", ".react-router"].includes(entry.name)) walk(path);
      } else if (
        /\.(?:ts|tsx|mts|mjs|js)$/.test(entry.name) &&
        /morrow\.contracts\.v1/.test(read(path))
      )
        declarations.push(path);
    }
  };
  walk("apps");
  walk("packages");
  walk("scripts");
  assert.deepEqual(declarations.sort(), [
    "packages/contracts/src/generated/domain.ts",
    "scripts/contract-sources.mjs",
  ]);
  assert.match(
    read("packages/contracts/src/generated/domain.ts"),
    /^export const contractVersion = "morrow\.contracts\.v1\.1" as const;$/m,
  );
});
