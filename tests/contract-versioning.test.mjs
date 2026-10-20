// P01.T02a: contract versioning (AC01-AC05, AC10, AC11), and the P01.T04a billing
// v1.1 layer (AC11, AC29, AC30). docs/contracts/contract-versions.md.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  inspectCompatibility,
  inspectBaselineCoverage,
  inspectDeclaredReplacements,
  inspectSupersededUse,
  inspectEntitlementWriters,
  entitlementWriterAllowlist,
  replacedDefinitionNames,
  replacedBillingDefinitionNames,
} from "../scripts/boundary-checks.mjs";
import {
  contractVersion as sourceVersion,
  changesPath,
  readSchemaSources,
  schemaSources,
  schemasByKind,
  billingLayers,
  currentBillingDefinitionSelectors,
} from "../scripts/contract-sources.mjs";
import { checkFixture, inspectTransition } from "../scripts/contract-checks.mjs";
import { generateContracts } from "../scripts/generate-contracts.mjs";
import {
  browserValidatorsDirectory,
  generateRuntimeValidators,
  removeStrayBrowserValidatorFiles,
  strayBrowserValidatorFiles,
} from "../scripts/generate-runtime-validators.mjs";
import { contractVersion } from "../packages/contracts/src/index.ts";
import {
  validateCapabilityInput,
  validateCurrentBillingDefinition,
  validateCurrentDefinition,
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
    // The v1 transition cases hold at v1 and are unaffected by the v1.1 rows.
    if (fixture.kind === "transition") {
      assert.equal(inspectTransition(fixture, "1"), fixture.allowed, fixture.id);
      assert.equal(inspectTransition(fixture, "1.1"), fixture.allowed, fixture.id);
    }
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
    changes.changes.map((c) => [c.kind, c.name, c.adr]),
    [
      ["capability_body", "ads.campaign.pause.input", "ADR-0005"],
      ["capability_body", "agents.installation.disable.input", "ADR-0005"],
      ["capability_body", "governance.membership.revoke.input", "ADR-0005"],
      ["capability_body", "governance.connection.disconnect.input", "ADR-0005"],
      ["capability_body", "agents.release.revoke.input", "ADR-0005"],
      ["definition", "Proposal", "ADR-0011"],
      ["definition", "Approval", "ADR-0011"],
      ["capability_body", "governance.approval.decide.input", "ADR-0011"],
      ["billing_definition", "BillingAccount", "ADR-0015"],
      ["billing_definition", "EntitlementSnapshot", "ADR-0015"],
      ["billing_definition", "CreditGrant", "ADR-0015"],
      ["billing_definition", "AllocationShare", "ADR-0015"],
      ["billing_definition", "CostAllocation", "ADR-0015"],
      ["definition", "EventEnvelope", "ADR-0016"],
      ["definition", "ResourceRef", "ADR-0022"],
      ["definition", "Scope", "ADR-0022"],
      ["definition", "Grant", "ADR-0022"],
    ],
  );
  const prefixes = {
    definition: "core:",
    capability_body: "capabilities:",
    billing_definition: "billing:",
  };
  for (const change of changes.changes)
    assert.equal(change.replaces, prefixes[change.kind] + change.name);
  // Removing a PR-B declaration is reported too.
  assert.deepEqual(
    inspectDeclaredReplacements(
      { ...changes, changes: changes.changes.filter((c) => c.name !== "Approval") },
      layered,
    ),
    ["UNDECLARED_REPLACEMENT:Approval"],
  );
  const removed = {
    ...changes,
    changes: changes.changes.filter((c) => c.name !== "ads.campaign.pause.input"),
  };
  assert.deepEqual(inspectDeclaredReplacements(removed, layered), [
    "UNDECLARED_REPLACEMENT:ads.campaign.pause.input",
  ]);
  const reused = structuredClone(layered);
  reused["core-v1.1"].$defs.Task = reused.core.$defs.Task;
  assert.deepEqual(inspectDeclaredReplacements(changes, reused), ["UNDECLARED_REPLACEMENT:Task"]);
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
  assert.ok(
    Object.hasOwn(layered["capabilities-v1.1"].$defs, "governance.review_policy.revise.input"),
  );
  assert.ok(!Object.hasOwn(layered.capabilities.$defs, "governance.review_policy.revise.input"));
  const added = structuredClone(layered);
  added["capabilities-v1.1"].$defs["governance.invented.capability.input"] = {
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
  // No runtime schema compiler or code generation reaches the validator bundle or any
  // per-definition browser module, and the generator owns its browser directory.
  const modules = Object.keys(validators.files).filter((path) => path.endsWith(".mjs"));
  assert.ok(modules.includes("packages/contracts/src/generated/runtime-validators.mjs"));
  assert.ok(modules.length > 1, "per-definition browser modules are generated");
  for (const path of modules) assert.doesNotMatch(read(path), /new Function|\beval\(/, path);
  assert.deepEqual(strayBrowserValidatorFiles(validators.files), []);
});
test("AC04: a stray file in the browser validators directory is drift and is removed", () => {
  const produced = ["SessionRotationResult.mjs", "SessionRotationResult.d.mts"];
  const files = Object.fromEntries(
    produced.map((name) => [`${browserValidatorsDirectory}/${name}`, ""]),
  );
  const root = mkdtempSync(join(tmpdir(), "morrow-validators-"));
  try {
    assert.deepEqual(strayBrowserValidatorFiles(files, root), [], "no directory, no strays");
    mkdirSync(join(root, browserValidatorsDirectory), { recursive: true });
    for (const name of produced) writeFileSync(join(root, browserValidatorsDirectory, name), "");
    assert.deepEqual(strayBrowserValidatorFiles(files, root), []);
    writeFileSync(join(root, browserValidatorsDirectory, "Proposal.mjs"), "export {};\n");
    assert.deepEqual(strayBrowserValidatorFiles(files, root), [
      `${browserValidatorsDirectory}/Proposal.mjs`,
    ]);
    // Regeneration removes stray files, but refuses a stray directory before removing any.
    const directory = join(root, browserValidatorsDirectory);
    mkdirSync(join(directory, "Zeta"));
    assert.throws(() => removeStrayBrowserValidatorFiles(files, root), {
      message: `RUNTIME_VALIDATOR_STRAY_DIRECTORY: ${browserValidatorsDirectory}/Zeta`,
    });
    assert.deepEqual(readdirSync(directory).sort(), [...produced, "Proposal.mjs", "Zeta"].sort());
    rmSync(join(directory, "Zeta"), { recursive: true });
    assert.deepEqual(removeStrayBrowserValidatorFiles(files, root), [
      `${browserValidatorsDirectory}/Proposal.mjs`,
    ]);
    assert.deepEqual(readdirSync(directory).sort(), [...produced].sort());
    assert.deepEqual(removeStrayBrowserValidatorFiles(files, root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("AC11: product code cannot validate or type a replaced v1 definition", () => {
  const replaced = replacedDefinitionNames(changes);
  assert.deepEqual(replaced, [
    "Proposal",
    "Approval",
    "EventEnvelope",
    "ResourceRef",
    "Scope",
    "Grant",
  ]);
  const check = (path, code) => inspectSupersededUse(path, code, replaced);
  assert.deepEqual(
    check("packages/policy/src/x.ts", 'validateDefinition("core","Proposal", value);'),
    ["SUPERSEDED_CONTRACT_USE:packages/policy/src/x.ts:Proposal"],
  );
  assert.deepEqual(
    check("packages/policy/src/x.ts", 'import type { Core_Approval } from "@morrow/contracts";'),
    ["SUPERSEDED_CONTRACT_USE:packages/policy/src/x.ts:Approval"],
  );
  assert.deepEqual(check("apps/api/src/x.ts", "type A = Contracts.Core_Approval;"), [
    "SUPERSEDED_CONTRACT_USE:apps/api/src/x.ts:Approval",
  ]);
  assert.deepEqual(check("apps/api/src/x.ts", 'const v = validators["core:Proposal"];'), [
    "SUPERSEDED_CONTRACT_USE:apps/api/src/x.ts:Proposal",
  ]);
  assert.deepEqual(check("apps/api/src/x.ts", 'x.validateDefinition("core", "Approval", v);'), [
    "SUPERSEDED_CONTRACT_USE:apps/api/src/x.ts:Approval",
  ]);
  // The current selectors, the exact v1.1 selector and other v1 names are fine.
  for (const code of [
    'validateCurrentDefinition("Proposal", value);',
    'validateDefinition("core-v1.1", "Approval", value);',
    'validateDefinition("core", "ProposalRef", value);',
    'import type { Current_Proposal, Core_ProposalRef, CoreV1_1_Approval } from "@morrow/contracts";',
  ])
    assert.deepEqual(check("packages/policy/src/x.ts", code), [], code);
  // Generated contracts and non-product files are out of scope.
  assert.deepEqual(
    check("packages/contracts/src/generated/domain.ts", "export type Core_Proposal = {};"),
    [],
  );
  assert.deepEqual(check("scripts/contract-checks.mjs", 'validators["core:Proposal"]'), []);
  // Replaced names come from changes.json, so later replacements are covered.
  assert.deepEqual(
    inspectSupersededUse("packages/x/src/y.ts", "type E = Core_Evidence;", [
      ...replaced,
      "Evidence",
    ]),
    ["SUPERSEDED_CONTRACT_USE:packages/x/src/y.ts:Evidence"],
  );
  // The effective definition rejects a v1-shaped proposal or approval.
  const binding = json("docs/contracts/fixtures/P01.A02.json").find((f) => f.kind === "binding");
  assert.equal(validateDefinition("core", "Proposal", binding.context.proposal), true);
  assert.equal(validateCurrentDefinition("Proposal", binding.context.proposal), false);
  assert.equal(validateDefinition("core", "Approval", binding.context.approval), true);
  assert.equal(validateCurrentDefinition("Approval", binding.context.approval), false);
  // Nothing under apps/ or packages/ uses a replaced definition today.
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", "build", ".react-router"].includes(entry.name)) walk(path);
      } else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) files.push(path);
    }
  };
  walk("apps");
  walk("packages");
  assert.deepEqual(
    files.flatMap((path) => check(path, read(path))),
    [],
  );
});

// --- M2 PR-2a: the store resource (ADR-0022 item 2) -------------------------------
test("ADR-0022 item 2: core ResourceRef, Scope and Grant are declared supersets of v1", () => {
  const v1Defs = layered.core.$defs,
    v11Defs = layered["core-v1.1"].$defs;
  // Structurally, each is the v1 definition (local refs made absolute, as every v1.1
  // reuse is) plus exactly one change: kind gains store with its allOf rule; Scope
  // names the v1.1 ResourceRef; Grant names the v1.1 Scope.
  const absolute = (value) =>
    JSON.parse(
      JSON.stringify(value).replaceAll('"#/$defs/', '"urn:morrow:contracts:core:v1#/$defs/'),
    );
  const without = (value, ...keys) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  const resource = structuredClone(without(v11Defs.ResourceRef, "description", "allOf"));
  assert.equal(resource.properties.kind.enum.at(-1), "store");
  resource.properties.kind.enum.pop();
  assert.deepEqual(resource, absolute(v1Defs.ResourceRef));
  assert.deepEqual(v11Defs.ResourceRef.allOf, [
    {
      if: { type: "object", properties: { kind: { const: "store" } }, required: ["kind"] },
      then: {
        type: "object",
        properties: {
          storeId: { $ref: "urn:morrow:contracts:core:v1#/$defs/Id" },
          connectionId: { $ref: "urn:morrow:contracts:core:v1#/$defs/Id" },
        },
      },
    },
  ]);
  const scope = structuredClone(without(v11Defs.Scope, "description"));
  assert.deepEqual(scope.properties.resources.items, { $ref: "#/$defs/ResourceRef" });
  scope.properties.resources.items = { $ref: "urn:morrow:contracts:core:v1#/$defs/ResourceRef" };
  assert.deepEqual(scope, absolute(v1Defs.Scope));
  const grant = structuredClone(without(v11Defs.Grant, "description"));
  assert.deepEqual(grant.properties.scope, { $ref: "#/$defs/Scope" });
  grant.properties.scope = { $ref: "urn:morrow:contracts:core:v1#/$defs/Scope" };
  assert.deepEqual(grant, absolute(v1Defs.Grant));
  // The declared core supersets are exactly these three; every other core replacement
  // stays incompatible in both directions.
  assert.deepEqual(
    changes.changes
      .filter((c) => c.kind === "definition" && /superset of v1/i.test(c.reason))
      .map((c) => c.name),
    ["ResourceRef", "Scope", "Grant"],
  );
  assert.match(changes.policy, /ResourceRef, Scope and Grant \(ADR-0022 item 2\) are supersets/);
  // Every P01.A02 case for them keeps its verdict under the current definition.
  const fixtures = json("docs/contracts/fixtures/P01.A02.json").filter(
    (f) => f.kind === "schema" && ["ResourceRef", "Scope", "Grant"].includes(f.definition),
  );
  assert.equal(fixtures.length, 6);
  for (const f of fixtures)
    assert.equal(validateCurrentDefinition(f.definition, f.value), f.valid, f.id);
  // The one addition: the store resource. v1 refuses it (a v1 reader fails closed).
  const store = {
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeId: "store_a",
    connectionId: "connection_a",
    kind: "store",
    id: "store_a",
  };
  const storeScope = {
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeIds: ["store_a"],
    accountIds: [],
    resources: [store],
    fields: ["title"],
  };
  const grantFixture = fixtures.find((f) => f.id === "P01.A02.schema.valid.Grant").value;
  const storeGrant = { ...structuredClone(grantFixture), scope: storeScope };
  for (const [name, value] of [
    ["ResourceRef", store],
    ["Scope", storeScope],
    ["Grant", storeGrant],
  ]) {
    assert.equal(validateDefinition("core", name, value), false, name);
    assert.equal(validateDefinition("core-v1.1", name, value), true, name);
    assert.equal(validateCurrentDefinition(name, value), true, name);
  }
  // Kind store needs both store keys (schema), and its id is its storeId (code).
  for (const change of [
    { storeId: null },
    { connectionId: null },
    { storeId: null, connectionId: null },
  ])
    assert.equal(validateCurrentDefinition("ResourceRef", { ...store, ...change }), false);
  const misnamed = { ...store, id: "store_b" };
  assert.equal(validateDefinition("core-v1.1", "ResourceRef", misnamed), true);
  assert.equal(validateCurrentDefinition("ResourceRef", misnamed), false);
  const misnamedScope = { ...storeScope, resources: [store, misnamed] };
  assert.equal(validateCurrentDefinition("Scope", misnamedScope), false);
  assert.equal(validateCurrentDefinition("Grant", { ...storeGrant, scope: misnamedScope }), false);
  // A storeless or store-bound resource of any other kind is unchanged.
  for (const kind of ["workspace", "product", "installation"])
    assert.equal(
      validateCurrentDefinition("ResourceRef", { ...store, kind, id: kind + "_a" }),
      validateDefinition("core", "ResourceRef", { ...store, kind, id: kind + "_a" }),
      kind,
    );
});

// --- P01.T04a PR-A: billing routes by origin (ADR-0015) --------------------------
const t04a = json("docs/contracts/fixtures/P01.T04a.json");
const t04aCase = (id) => t04a.cases.find((c) => c.id === `P01.T04a.${id}`);
const billingReplacements = [
  "BillingAccount",
  "EntitlementSnapshot",
  "CreditGrant",
  "AllocationShare",
  "CostAllocation",
];
const productFiles = () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", "build", ".react-router"].includes(entry.name)) walk(path);
      } else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) files.push(path);
    }
  };
  walk("apps");
  walk("packages");
  return files;
};

test("P01.T04a AC30: billing v1.1 is appended after the five existing sources", () => {
  assert.deepEqual(
    schemaSources.map((s) => [s.kind, s.path, s.prefix]),
    [
      ["core", "docs/contracts/schemas/v1/core.schema.json", "Core"],
      ["capabilities", "docs/contracts/schemas/v1/capabilities.schema.json", "Capability"],
      ["billing", "docs/contracts/schemas/v1/billing.schema.json", "Billing"],
      ["core-v1.1", "docs/contracts/schemas/v1.1/core.schema.json", "CoreV1_1"],
      [
        "capabilities-v1.1",
        "docs/contracts/schemas/v1.1/capabilities.schema.json",
        "CapabilityV1_1",
      ],
      ["billing-v1.1", "docs/contracts/schemas/v1.1/billing.schema.json", "BillingV1_1"],
    ],
  );
  assert.deepEqual([...billingLayers], ["billing-v1.1", "billing"]);
  assert.equal(layered["billing-v1.1"].$id, "urn:morrow:contracts:billing:v1.1");
  const v1Billing = "docs/contracts/schemas/v1/billing.schema.json";
  assert.equal(
    createHash("sha256").update(texts[v1Billing]).digest("hex"),
    baseline.schemas[v1Billing],
  );
  assert.equal(baseline.versions["morrow.contracts.v1.1"].status, "candidate_owner_signoff");
  assert.deepEqual(replacedBillingDefinitionNames(changes), billingReplacements);
  const selectors = currentBillingDefinitionSelectors(layered);
  for (const name of billingReplacements) assert.equal(selectors[name], `billing-v1.1:${name}`);
  for (const name of [
    "CreditUnits",
    "BillingMoney",
    "CreditWallet",
    "CreditReservation",
    "UsageLiability",
    "MeterEvent",
    "VendorCostReservation",
  ])
    assert.equal(selectors[name], `billing:${name}`);
  for (const name of ["WorkspaceBillingRoute", "VerifiedPaymentEvent", "TestEntitlementSeed"])
    assert.equal(selectors[name], `billing-v1.1:${name}`);
});

test("P01.T04a AC30: the billing v1.1 schema accepts the fixture and rejects the listed shapes", () => {
  assert.ok(t04a.cases.length > 90);
  for (const c of t04a.cases) {
    assert.equal(c.kind, "schema", c.id);
    assert.equal(checkFixture(c), true, c.id);
    // The generated (ahead-of-time) validators agree with the reference compiler.
    const name = c.selector.slice("billing-v1.1:".length);
    assert.equal(validateDefinition("billing-v1.1", name, c.value), c.valid, c.id);
  }
  for (const id of [
    "account.unknown_field",
    "account.morrow_direct_with_installation",
    "account.shopify_without_installation",
    "event.shopify_top_up",
    "route.partly_fixed_no_time",
    "route.partly_fixed_no_route",
    "event.plan_change_without_from_price",
    "event.negative_amount",
    "event.credit_units_field",
    "event.shopify_period_non_usd",
    "event.shopify_plan_change_non_usd",
    "reversal.shopify_non_usd",
    "terms.exact_duplicate_entry",
    "terms.shopify_non_usd",
    "account.shopify_non_usd",
    "usage_cap.non_usd",
    "usage_cap.morrow_direct_account",
    "seed.live_mode",
    "seed.route_field",
  ])
    assert.equal(t04aCase(id).valid, false, id);
  // Shapes the schema accepts on purpose: a Morrow-direct account in another
  // currency, and two semantic errors the billing library refuses in PR-B (a
  // repeated price key with other credits; an allocation mixing both routes).
  for (const id of [
    "account.morrow_direct_eur",
    "reversal.shopify_refund",
    "terms.repeated_price_key_other_credits",
    "allocation.two_routes",
  ])
    assert.equal(t04aCase(id).valid, true, id);
  // Every Shopify-route amount is UsdBillingMoney and every Shopify currency is USD.
  const billingV11 = layered["billing-v1.1"];
  const shopifyMoney = [];
  const visitShopify = (node, path) => {
    if (Array.isArray(node)) return node.forEach((child, i) => visitShopify(child, `${path}/${i}`));
    if (!node || typeof node !== "object") return;
    if (node.properties?.route?.const === "shopify_app_pricing")
      for (const [key, value] of Object.entries(node.properties)) {
        const text = JSON.stringify(value);
        if (key === "currency") shopifyMoney.push([`${path}.${key}`, value.const === "USD"]);
        else if (/BillingMoney/.test(text))
          shopifyMoney.push([`${path}.${key}`, value.$ref === "#/$defs/UsdBillingMoney"]);
      }
    for (const [key, value] of Object.entries(node)) visitShopify(value, `${path}/${key}`);
  };
  visitShopify(billingV11.$defs, "");
  assert.deepEqual(
    shopifyMoney.map(([path]) => path),
    [
      "/VerifiedPaymentEvent/oneOf/3.amountPaid",
      "/VerifiedPaymentEvent/oneOf/4.amountPaid",
      "/PaymentReversal/oneOf/1.amount",
      "/BillingTerms/properties/entries/items/oneOf/1.currency",
      "/BillingAccount/oneOf/1.currency",
    ],
  );
  for (const [path, usd] of shopifyMoney) assert.equal(usd, true, path);
  assert.equal(
    billingV11.$defs.UsageCap.properties.maximumLiability.$ref,
    "#/$defs/UsdBillingMoney",
  );
  // Replacements are not compatible with the v1 shape in either direction,
  // except AllocationShare@2, a declared superset of v1 that is stored only
  // inside CostAllocation@2 (changes.json policy).
  const v1 = (name, value) => validateDefinition("billing", name, value);
  const current = (name, value) => validateCurrentBillingDefinition(name, value);
  const v1Account = t04aCase("account.v1_shape").value;
  assert.equal(v1("BillingAccount", v1Account), true);
  assert.equal(current("BillingAccount", v1Account), false);
  for (const id of ["account.morrow_direct", "account.shopify"]) {
    const account = t04aCase(id).value;
    assert.equal(v1("BillingAccount", account), false, id);
    assert.equal(current("BillingAccount", account), true, id);
  }
  const strip = (value, ...keys) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  const v1Snapshot = {
    ...strip(t04aCase("entitlement.shopify").value, "route", "mode"),
    schemaVersion: 1,
    subscriptionId: "subscription_1",
  };
  assert.equal(v1("EntitlementSnapshot", v1Snapshot), true);
  assert.equal(current("EntitlementSnapshot", v1Snapshot), false);
  for (const id of ["entitlement.morrow_direct", "entitlement.shopify"]) {
    assert.equal(v1("EntitlementSnapshot", t04aCase(id).value), false, id);
    assert.equal(current("EntitlementSnapshot", t04aCase(id).value), true, id);
  }
  const v1Grant = t04aCase("grant.v1_shape").value;
  assert.equal(v1("CreditGrant", v1Grant), true);
  assert.equal(current("CreditGrant", v1Grant), false);
  for (const id of ["grant.morrow_direct_purchased", "grant.shopify_included"]) {
    assert.equal(v1("CreditGrant", t04aCase(id).value), false, id);
    assert.equal(current("CreditGrant", t04aCase(id).value), true, id);
  }
  const storeShare = t04aCase("share.store").value;
  const v1Allocation = {
    ...t04aCase("allocation.v1_schema_version").value,
    shares: [structuredClone(storeShare)],
  };
  assert.equal(v1("CostAllocation", v1Allocation), true);
  assert.equal(current("CostAllocation", v1Allocation), false);
  const allocation = t04aCase("allocation.valid").value;
  assert.equal(v1("CostAllocation", allocation), false);
  assert.equal(current("CostAllocation", allocation), true);
  // The superset: a v1 share is a valid store-bound share; a storeless share is not v1.
  assert.equal(v1("AllocationShare", storeShare), true);
  assert.equal(current("AllocationShare", storeShare), true);
  const storeless = t04aCase("share.storeless").value;
  assert.equal(v1("AllocationShare", storeless), false);
  assert.equal(current("AllocationShare", storeless), true);
  assert.deepEqual(
    changes.changes
      .filter((c) => c.kind === "billing_definition" && /superset of v1/.test(c.reason))
      .map((c) => c.name),
    ["AllocationShare"],
  );
  // Every key fits a core Id, so it fits the v1 subscriptionId and meter fields.
  for (const c of t04a.cases.filter((c) => c.id.startsWith("P01.T04a.key.") && c.valid))
    assert.equal(validateDefinition("core", "Id", c.value), true, c.id);
  assert.equal(validateCurrentBillingDefinition("CreditUnits", "10"), true);
  for (const name of ["constructor", "__proto__", "Proposal", "billing:CreditUnits"])
    assert.equal(validateCurrentBillingDefinition(name, "10"), false, name);
});

test("P01.T04a AC30: product code cannot validate or type a replaced v1 billing definition", () => {
  const billing = replacedBillingDefinitionNames(changes);
  const check = (path, code) =>
    inspectSupersededUse(path, code, replacedDefinitionNames(changes), billing);
  assert.deepEqual(check("packages/policy/src/x.ts", "type A = Billing_BillingAccount;"), [
    "SUPERSEDED_CONTRACT_USE:packages/policy/src/x.ts:BillingAccount",
  ]);
  assert.deepEqual(check("apps/api/src/x.ts", 'validateDefinition("billing", "CreditGrant", v);'), [
    "SUPERSEDED_CONTRACT_USE:apps/api/src/x.ts:CreditGrant",
  ]);
  assert.deepEqual(check("apps/api/src/x.ts", 'const v = validators["billing:CostAllocation"];'), [
    "SUPERSEDED_CONTRACT_USE:apps/api/src/x.ts:CostAllocation",
  ]);
  for (const code of [
    'validateCurrentBillingDefinition("BillingAccount", v);',
    'validateDefinition("billing-v1.1", "BillingAccount", v);',
    'validateDefinition("billing", "CreditWallet", v);',
    "type A = BillingV1_1_BillingAccount | Billing_CreditWallet | CurrentBilling_CreditGrant;",
  ])
    assert.deepEqual(check("packages/policy/src/x.ts", code), [], code);
  assert.deepEqual(
    productFiles().flatMap((path) => check(path, read(path))),
    [],
  );
});

// A request schema "carries a route" when it references a route-bearing billing
// definition at any depth, or has a property with a route field name.
const routeDefinitions = new Set([
  "BillingRoute",
  "WorkspaceBillingRoute",
  "PaymentMode",
  "PaymentKey",
  "StripePaymentKey",
  "ShopifyPeriodKey",
  "ShopifyPlanChangeKey",
  "SubscriptionKey",
  "StripeSubscriptionKey",
  "ShopifySubscriptionKey",
  "PriceKey",
  "StripePriceKey",
  "ShopifyPriceKey",
]);
const routeProperties = new Set([
  "billingRoute",
  "route",
  "origin",
  "shopifyBoundAt",
  "routeFixedAt",
  "fixingPaymentKey",
  "paymentMode",
]);
function routeFields(schema, base, byId) {
  const found = new Set(),
    seen = new Set();
  const visit = (node, base) => {
    if (Array.isArray(node)) return node.forEach((child) => visit(child, base));
    if (!node || typeof node !== "object") return;
    if (typeof node.$ref === "string") {
      const [id, pointer] = node.$ref.startsWith("#")
        ? [base, node.$ref.slice(1)]
        : node.$ref.split("#");
      const name = pointer.replace(/^\/\$defs\//, "");
      if (id === "urn:morrow:contracts:billing:v1.1" && routeDefinitions.has(name))
        found.add("ref:" + name);
      if (!seen.has(id + "#" + name)) {
        seen.add(id + "#" + name);
        assert.ok(byId[id]?.$defs?.[name], node.$ref);
        visit(byId[id].$defs[name], id);
      }
    }
    if (node.properties && typeof node.properties === "object")
      for (const key of Object.keys(node.properties))
        if (routeProperties.has(key)) found.add("property:" + key);
    for (const [key, value] of Object.entries(node)) if (key !== "$ref") visit(value, base);
  };
  visit(schema, base);
  return [...found].sort();
}

test("P01.T04a AC11: no request or capability input can carry a billing route", () => {
  const byId = Object.fromEntries(sources.map((s) => [s.schema.$id, s.schema]));
  const catalogue = json("docs/contracts/capabilities.json");
  const inputs = catalogue.capabilities.map((c) => {
    const kind = Object.hasOwn(layered["capabilities-v1.1"].$defs, `${c.id}.input`)
      ? "capabilities-v1.1"
      : "capabilities";
    return [`${kind}:${c.id}.input`, layered[kind].$defs[`${c.id}.input`], layered[kind].$id];
  });
  // Derived from the catalogue: P01.T02c added eight capabilities (ADR-0016).
  assert.equal(inputs.length, catalogue.capabilities.length);
  assert.ok(inputs.some(([name]) => name === "capabilities-v1.1:governance.access.request.input"));
  const requests = [];
  for (const kind of ["core-v1.1", "core"])
    for (const name of Object.keys(layered[kind].$defs))
      if (/(?:Request|Input)$/.test(name) && !requests.some(([n]) => n.endsWith(":" + name)))
        requests.push([`${kind}:${name}`, layered[kind].$defs[name], layered[kind].$id]);
  assert.ok(requests.some(([name]) => name === "core-v1.1:ReviewDecisionInput"));
  // P05.T01x Part B account requests are walked too (P01.T04a AC11).
  assert.ok(requests.some(([name]) => name === "core-v1.1:OrganizationSignupRequest"));
  for (const [name, schema, base] of [...inputs, ...requests])
    assert.deepEqual(routeFields(schema, base, byId), [], name);
  // Planted negatives: a route property, or a reference to a route definition.
  const [, goal, goalBase] = inputs.find(([name]) => name.endsWith(":workspace.goal.create.input"));
  const planted = structuredClone(goal);
  planted.properties.origin = { type: "string" };
  assert.deepEqual(routeFields(planted, goalBase, byId), ["property:origin"]);
  const referenced = structuredClone(goal);
  referenced.properties.plan = { $ref: "urn:morrow:contracts:billing:v1.1#/$defs/PriceKey" };
  assert.deepEqual(routeFields(referenced, goalBase, byId), [
    "ref:PriceKey",
    "ref:ShopifyPriceKey",
    "ref:StripePriceKey",
  ]);
});

test("P01.T04a AC29: only the billing reader and its two forwarders set entitlementAllowed", () => {
  assert.deepEqual(
    productFiles().flatMap((path) => inspectEntitlementWriters(path, read(path))),
    [],
  );
  const outside = "packages/work/src/permissions.ts";
  const flagged = (code, path = outside, line = 1) =>
    assert.deepEqual(
      inspectEntitlementWriters(path, code),
      [`ENTITLEMENT_WRITER_UNAPPROVED:${path}:${line}`],
      code,
    );
  for (const code of [
    "const facts = { entitlementAllowed: true };",
    "const facts = { entitlementAllowed: allowed };",
    "const facts = { entitlementAllowed: !denied };",
    "facts.entitlementAllowed = true;",
    'facts["entitlementAllowed"] = true;',
    "facts.entitlementAllowed ||= false;",
    "const facts = { entitlementAllowed };",
    'const facts = { ["entitlementAllowed"]: true };',
    "const facts = { get entitlementAllowed() { return true; } };",
    'Object.defineProperty(facts, "entitlementAllowed", { value: true });',
    // Class fields (with or without an initializer) and parameter properties.
    "class Facts { readonly entitlementAllowed = true; }",
    "class Facts { readonly providerAllowed = true; readonly entitlementAllowed = true; }",
    "class Facts { entitlementAllowed: boolean = allowed; }",
    "class Facts { declare entitlementAllowed: boolean; }",
    "class Facts { constructor(readonly entitlementAllowed: boolean) {} }",
    "class Facts { constructor(private entitlementAllowed: boolean) {} }",
    "const facts = { entitlementAllowed() { return true; } };",
    // A key bound to the field's name, an entries pair, and an opaque computed
    // key beside providerAllowed.
    'const k = "entitlementAllowed"; const facts = { [k]: true };',
    'const k = "entitlementAllowed" as const; facts[k] = true;',
    'const k = "entitlementAllowed"; Reflect.set(facts, k, true);',
    'Object.fromEntries([["entitlementAllowed", true]]);',
    'new Map([["entitlementAllowed", allowed]]);',
    "const facts = { providerAllowed: true, [key()]: true };",
    "class Facts { providerAllowed = true; [Keys.entitlement] = true; }",
  ])
    flagged(code);
  flagged(
    "const x = 1;\nconst facts = { providerAllowed: true, entitlementAllowed: true };",
    outside,
    2,
  );
  // A literal false is inert anywhere; type declarations are not writes.
  for (const code of [
    "const facts = { providerAllowed: true, entitlementAllowed: false };",
    "facts.entitlementAllowed = false;",
    "const facts = { entitlementAllowed: (false as boolean) };",
    "interface Facts { readonly entitlementAllowed: boolean }",
    "type Facts = { entitlementAllowed: boolean };",
    'closed(v, ["providerAllowed", "entitlementAllowed"]);',
    'closed(v, ["entitlementAllowed", "providerAllowed"]);',
    "if (!facts.entitlementAllowed) deny();",
    "class Facts { readonly entitlementAllowed = false; }",
    "class Facts { constructor(entitlementAllowed: boolean) {} }",
    'Object.fromEntries([["entitlementAllowed", false]]);',
    'const facts = { providerAllowed: true, ["entitlementAllowed"]: false };',
    "const byKey = { [key]: value };",
  ])
    assert.deepEqual(inspectEntitlementWriters(outside, code), [], code);
  // Labs, fixtures, tests and *.test.* files are out of scope.
  for (const path of [
    "scripts/permission-database-lab.mjs",
    "scripts/fixtures/neon-authority.ts",
    "tests/policy.test.mjs",
    "packages/policy/src/billing-state.test.ts",
    "apps/api/src/worker.test.mjs",
  ])
    assert.deepEqual(
      inspectEntitlementWriters(path, "const f = { entitlementAllowed: true };"),
      [],
      path,
    );
  // The three allowlisted functions pass in their own files only.
  assert.deepEqual(
    Object.fromEntries(Object.entries(entitlementWriterAllowlist).map(([k, v]) => [k, [...v]])),
    {
      "packages/policy/src/billing-state.ts": ["createBillingConstraintsReader"],
      "packages/policy/src/index.ts": [
        "createHumanPolicyService",
        "createWorkspacePermissionBoundary",
      ],
    },
  );
  const reader =
    "export function createBillingConstraintsReader(provider, billing) {\n  return { async readCurrent(r, a) { return { providerAllowed: true, entitlementAllowed: entitled(r) }; } };\n}";
  assert.deepEqual(inspectEntitlementWriters("packages/policy/src/billing-state.ts", reader), []);
  flagged(reader, "packages/policy/src/other.ts", 2);
  const service =
    "export function createHumanPolicyService(reader) {\n  const facts = { entitlementAllowed: copied };\n}";
  assert.deepEqual(inspectEntitlementWriters("packages/policy/src/index.ts", service), []);
  flagged(service, "packages/policy/src/billing-state.ts", 2);
  // The real forwarder in index.ts writes a non-literal value and is allowlisted.
  const index = read("packages/policy/src/index.ts");
  assert.deepEqual(inspectEntitlementWriters("packages/policy/src/index.ts", index), []);
  assert.ok(inspectEntitlementWriters("packages/policy/src/copied.ts", index).length > 0);
});
