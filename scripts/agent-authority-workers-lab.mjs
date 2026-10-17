import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import {
  delegationFixture,
  automationFixture,
  at,
  clone,
  actor,
  digest,
} from "../tests/fixtures/agent-authority.mjs";
import { writeArtifact } from "./artifacts.mjs";

// Real local workerd, synthetic data and denied outbound network only.
// This is not a production reader, authenticator or deployment command.
const cases = [];
function add(name, make, mode, allowed, mutate = () => {}) {
  const f = make();
  mutate(f);
  cases.push({ name, mode, input: f.input, facts: f.facts, allowed });
}
add("delegation_owner_coordinator_specialist_allows", delegationFixture, "delegation", true);
add("origin_departure_denies", delegationFixture, "delegation", false, (f) => {
  f.facts.origin.membershipActive = false;
});
add("shared_admin_owned_installation_allows", delegationFixture, "delegation", true, (f) => {
  const shared = actor("shared_admin");
  f.facts.executor.installation.owner = clone(shared);
  f.facts.executor.owner.actor = clone(shared);
  for (const grant of f.facts.executor.owner.grants) grant.principal = clone(shared);
});
add("installation_owner_departure_denies", delegationFixture, "delegation", false, (f) => {
  f.facts.executor.owner.membershipActive = false;
});
add("missing_dispatch_grant_denies", delegationFixture, "delegation", false, (f) => {
  f.facts.hops[0].dispatcher.current.grants = [];
});
add("cross_tenant_resource_denies", delegationFixture, "delegation", false, (f) => {
  f.input.operation.resource.organizationId = "org_foreign";
});
add("envelope_expiry_denies", delegationFixture, "delegation", false, (f) => {
  f.facts.envelope.expiresAt = "2026-10-14T00:00:00.000Z";
});
add("stale_policy_facts_deny", delegationFixture, "delegation", false, (f) => {
  f.facts.executor.current.grantsRevision--;
});
add("disabled_installation_denies", delegationFixture, "delegation", false, (f) => {
  f.facts.executor.installation.status = "disabled";
});
add("provider_constraint_denies", delegationFixture, "delegation", false, (f) => {
  f.facts.constraints.providerAllowed = false;
});
add("grant_reference_digest_mismatch_denies", delegationFixture, "delegation", false, (f) => {
  f.facts.executor.installation.grantRefs[0].digest = "f".repeat(64);
});
add("automation_offline_owner_allows", automationFixture, "automation", true);
add("automation_owner_departure_denies", automationFixture, "automation", false, (f) => {
  f.facts.executor.owner.membershipActive = false;
});
add("automation_mandate_expiry_denies", automationFixture, "automation", false, (f) => {
  f.facts.mandate.payload.expiresAt = "2026-10-14T00:00:00.000Z";
  f.facts.executor.installation.mandateRefs[0].digest = digest(f.facts.mandate.payload);
});
add("automation_mandate_reference_mismatch_denies", automationFixture, "automation", false, (f) => {
  f.facts.executor.installation.mandateRefs[0].revision++;
});
const paths = [
  "packages/policy/src/agent-authority.ts",
  "packages/policy/src/agent-authority-facts.ts",
  "scripts/fixtures/agent-authority-worker.ts",
  "scripts/agent-authority-workers-lab.mjs",
  "tests/fixtures/agent-authority.mjs",
  "package-lock.json",
];
const bundle = await build({
  entryPoints: ["scripts/fixtures/agent-authority-worker.ts"],
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
);
assert.ok(
  !Object.values(bundle.metafile.outputs).some((output) =>
    output.imports.some((item) => item.path === "node:util"),
  ),
);
let outbound = 0;
const runtime = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  log: new Log(LogLevel.ERROR),
  outboundService: () => {
    outbound++;
    return new Response(null, { status: 502 });
  },
});
try {
  const digestPayload = cases[0].facts.executor.grantRecords[0].payload;
  const response = await runtime.dispatchFetch("http://morrow.local/agent-authority", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cases,
      clock: at,
      digestPayload,
      expectedDigest: digest(digestPayload),
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.checks.length, cases.length + 6);
  for (const c of result.checks) assert.equal(c.passed, true, c.name);
  assert.equal(outbound, 0);
  result.checks.push({ name: "zero_provider_requests", passed: outbound === 0 });
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  writeArtifact(
    "labs/agent-authority-workers.json",
    JSON.stringify(
      {
        task: "P05.T04a",
        observed_at: new Date().toISOString(),
        scope:
          "Actual pinned local workerd with synthetic agent authority readers; no hosted deployment, SQL ownership, provider authentication or dispatch qualification",
        runtime: "miniflare4.20260730.0",
        compatibility_date: "2026-07-30",
        provider_calls: outbound,
        bundle_sha256: sha(bundle.outputFiles[0].text),
        input_digests: Object.fromEntries(paths.map((path) => [path, sha(readFileSync(path))])),
        checks: result.checks,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: ${result.checks.length} actual local Workers agent-authority checks; zero provider requests.`,
  );
} finally {
  await runtime.dispose();
}
