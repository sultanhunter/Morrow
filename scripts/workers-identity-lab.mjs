import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import {
  validators,
  validateEventPayload,
  eventPayloadSelectors,
} from "../packages/contracts/src/generated/runtime-validators.mjs";
import { writeArtifact } from "./artifacts.mjs";
import { contractVersion, readSchemaSources, readEventRegistry } from "./contract-sources.mjs";
import { proposal, oracle } from "../tests/fixtures/review-policy.mjs";

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
  external: ["node:crypto"],
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
  // The review library derives the same proposal and digest in workerd and Node
  // (P01.T02a AC04, AC14), and both equal an independent RFC 8785 oracle.
  const nodeReview = await build({
    entryPoints: ["packages/policy/src/review.ts"],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
  });
  const { previewSelection } = await import(
    "data:text/javascript;base64," + Buffer.from(nodeReview.outputFiles[0].text).toString("base64")
  );
  const parent = proposal({
    credits: ["10", "10", "5", "9007199254740993"],
    costs: ["10.00", null, "2.5", "0.125"],
  });
  const selections = [[0, 1], [2], [0, 2, 3], [3], null, [1, 0], [0, 1, 2, 3]];
  const preview = await runtime.dispatchFetch("http://morrow.local/review-preview", {
    method: "POST",
    body: JSON.stringify({ parent, selections }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(preview.status, 200);
  const workerd = await preview.json();
  const node = selections.map((selection) => previewSelection(parent, selection));
  assert.deepEqual(workerd, JSON.parse(JSON.stringify(node)));
  const derived = node.filter((result) => "proposal" in result && result.proposal.derivedFrom);
  assert.equal(derived.length, 4);
  for (const { proposal: p } of derived) {
    const { proposalDigest, ...content } = p;
    assert.equal(proposalDigest, oracle(content));
    assert.equal(p.id, "derived_" + oracle(p.derivedFrom));
  }
  assert.deepEqual(workerd.slice(5), [
    { code: "SELECTION_INVALID" },
    { code: "SELECTION_INVALID" },
  ]);
  // P01.T02c (ADR-0016): every collaboration case and the registry selector in
  // workerd equal their expected results; counts derive from the fixture and registry.
  const collaboration = JSON.parse(
    readFileSync("docs/contracts/fixtures/P01.T02c.json", "utf8"),
  ).cases;
  const schemaCases = collaboration.filter((c) => c.kind === "schema");
  const eventCases = collaboration.filter((c) => c.kind === "event");
  const registryRows = readEventRegistry().events;
  assert.equal(Object.keys(eventPayloadSelectors).length, registryRows.length);
  const payloadCases = eventCases
    .filter((c) => c.value.payload !== null)
    .map((c) => ({
      eventType: c.value.eventType,
      aggregateType: c.value.aggregateType,
      payload: c.value.payload,
    }));
  const collaborationResponse = await runtime.dispatchFetch("http://morrow.local/collaboration", {
    method: "POST",
    body: JSON.stringify({
      schema: schemaCases.map(({ selector, value }) => ({ selector, value })),
      events: eventCases.map((c) => c.value),
      payloads: payloadCases,
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(collaborationResponse.status, 200);
  const collaborationResults = await collaborationResponse.json();
  assert.deepEqual(
    collaborationResults.schema,
    schemaCases.map((c) => c.valid),
  );
  assert.deepEqual(
    collaborationResults.events,
    eventCases.map((c) => c.valid),
  );
  assert.deepEqual(
    collaborationResults.payloads,
    payloadCases.map((c) => validateEventPayload(c.eventType, c.aggregateType, c.payload)),
  );
  assert.ok(
    registryRows.every((row) =>
      eventCases.some((c) => c.valid && c.value.eventType === row.eventType),
    ),
  );
  assert.equal(outboundRequests, 0);
  const inputPaths = [
    "packages/identity/src/neon.ts",
    "packages/identity/src/neon-request.ts",
    "packages/contracts/src/validation.ts",
    "packages/contracts/src/generated/runtime-validators.mjs",
    "packages/policy/src/review.ts",
    "packages/policy/src/review-facts.ts",
    "tests/fixtures/review-policy.mjs",
    "docs/contracts/fixtures/P01.T02c.json",
    "docs/contracts/event-registry.json",
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
        review_preview_cases: selections.length,
        collaboration_schema_cases: schemaCases.length,
        collaboration_event_cases: eventCases.length,
        event_registry_rows: registryRows.length,
        review_preview_digests_equal: true,
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
    `PASS: local Workers runtime; ${(definitions * corpus.length).toLocaleString("en-US")} validator cases over ${definitions} selectors, ${schemaCases.length + eventCases.length} collaboration cases and ${registryRows.length} registry rows, ${selections.length} review previews equal to Node, SDK settings, dynamic-code denial, two concurrent fixture reads; zero provider calls.`,
  );
} finally {
  await runtime.dispose();
}
