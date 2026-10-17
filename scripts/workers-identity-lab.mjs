import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { validators } from "../packages/contracts/src/generated/runtime-validators.mjs";
import { writeArtifact } from "./artifacts.mjs";
import { contractVersion, readSchemaSources } from "./contract-sources.mjs";

// Every exact selector of every contract source runs in workerd; the expected
// count comes from the sources, never from a hard-coded number.
const sources = readSchemaSources();
const definitions = sources.reduce((n, source) => n + Object.keys(source.schema.$defs).length, 0);
assert.equal(Object.keys(validators).length, definitions);
const bundle = await build({
  entryPoints: ["scripts/fixtures/neon-worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  write: false,
  metafile: true,
});
assert.ok(
  !Object.keys(bundle.metafile.inputs).some((path) => /ajv\/dist\/(compile|core|2020)/.test(path)),
  "Runtime schema compiler entered Worker bundle",
);
let outboundRequests = 0;
const runtime = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  log: new Log(LogLevel.ERROR),
  outboundService: () => {
    outboundRequests++;
    return new Response(null, { status: 502 });
  },
});
const control = { reason: "Overspend", sourceProposalRef: null };
try {
  const corpus = [
    null,
    true,
    false,
    0,
    1,
    "fixture",
    "2026-10-10T10:00:00Z",
    "2026-99-99T99:99:99Z",
    {},
    [],
    { amount: "1.25", currency: "USD" },
    {
      objective: "Investigate",
      storeIds: ["fixture"],
      successCriteria: [
        { description: "Evidence", verificationCapabilityId: null, evidenceRequired: true },
      ],
    },
    control,
    {
      campaigns: [
        {
          organizationId: "org_a",
          workspaceId: "workspace_a",
          storeId: "store_a",
          connectionId: "connection_a",
          kind: "campaign",
          id: "campaign_a",
        },
      ],
      control,
    },
    { membershipId: "membership_a", control: { ...control, reason: "   " } },
  ];
  const response = await runtime.dispatchFetch("http://morrow.local/validators", {
    method: "POST",
    body: JSON.stringify(corpus),
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 200);
  const results = await response.json();
  assert.deepEqual(
    results,
    Object.fromEntries(
      Object.entries(validators).map(([key, validator]) => [
        key,
        corpus.map((value) => validator(value)),
      ]),
    ),
  );
  const sdk = await (await runtime.dispatchFetch("http://morrow.local/sdk")).json();
  assert.deepEqual(sdk, {
    secure: true,
    proxy: "ep-fixture.us-east-2.aws.neon.tech/v2",
    invalidProof: true,
    dynamicCodeDenied: true,
  });
  const tenantResults = await Promise.all(
    ["a", "b"].map(async (tenant) =>
      (await runtime.dispatchFetch(`http://morrow.local/identity-${tenant}`)).json(),
    ),
  );
  assert.deepEqual(tenantResults, [
    { organizationId: "org_a", closed: true },
    { organizationId: "org_b", closed: true },
  ]);
  assert.equal(outboundRequests, 0);
  const inputPaths = [
    "packages/identity/src/neon.ts",
    "packages/identity/src/neon-request.ts",
    "packages/contracts/src/validation.ts",
    "packages/contracts/src/generated/runtime-validators.mjs",
    ...sources.map((source) => source.path),
    "scripts/fixtures/neon-worker.ts",
    "scripts/workers-identity-lab.mjs",
    "package-lock.json",
  ];
  const sha = (text) => createHash("sha256").update(text).digest("hex");
  writeArtifact(
    "labs/workers-identity.json",
    JSON.stringify(
      {
        task: "P04.T01b",
        scope:
          "Pinned local workerd runtime with synthetic driver/identity; not hosted Neon, TLS, pool reuse, provider identity or deployment qualification",
        runtime: "miniflare4.20260730.0",
        compatibility_date: "2026-07-30",
        contract_version: contractVersion,
        validator_definitions: definitions,
        validator_definitions_by_source: Object.fromEntries(
          sources.map((source) => [source.kind, Object.keys(source.schema.$defs).length]),
        ),
        validator_cases: definitions * corpus.length,
        dynamic_code_generation_denied: true,
        sdk_configuration_passed: true,
        concurrent_synthetic_tenant_reads: 2,
        request_clients_closed: true,
        provider_calls: outboundRequests,
        deployed: false,
        bundle_sha256: sha(bundle.outputFiles[0].text),
        input_digests: Object.fromEntries(
          inputPaths.map((path) => [path, sha(readFileSync(path))]),
        ),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: local Workers runtime; ${(definitions * corpus.length).toLocaleString("en-US")} validator cases over ${definitions} selectors, SDK settings, dynamic-code denial, two concurrent fixture reads; zero provider calls.`,
  );
} finally {
  await runtime.dispose();
}
