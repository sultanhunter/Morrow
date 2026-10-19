// Child process for tests/staging-secrets.test.mjs (P04.T01i AC07): runs one staging
// subcommand through scripts/staging.mjs `main` over fakes that carry secret markers in
// every source (files, environment, tool output, failing tools, database errors), with
// the subcommand's output bound to this process's real stdout and stderr, so the parent
// sees everything the tool could print at the file-descriptor level. The fakes' records
// (arguments, stdin, statements) go to a dump file for the parent's checks.
//   node --import tsx tests/fixtures/staging-marker-child.mjs <scenario> <home> <markers.json> <dump.json>
import { readFileSync, writeFileSync } from "node:fs";
import { identityConstants, main } from "../../scripts/staging.mjs";
import { StagingError } from "../../scripts/staging-common.mjs";
import { fakeCloudflare, fakeContext, fakeDatabase, fakeTools } from "./staging-fakes.mjs";

const [scenario, home, markersPath, dumpPath] = process.argv.slice(2);
const markers = JSON.parse(readFileSync(markersPath, "utf8"));
const emit = `tool said ${markers.tool} and ${markers.url} ${markers.token}\n`;
const markerError = () => {
  const error = Error("ERROR: relation " + markers.database + " failed for " + markers.url);
  error.code = "XX000";
  error.sqlstate = "XX000";
  error.server = "permission denied " + markers.database;
  return error;
};

const scenarios = {
  "status-failing-tools": () => ({
    argv: ["secrets-status"],
    tools: { emit, fail: { wrangler: true, gh: true, git: true } },
    database: { connectError: markerError() },
  }),
  "status-noisy-tools": () => ({
    argv: ["secrets-status"],
    tools: {
      emit,
      wrangler: {
        secrets: { api: ["LOGIN_CAPSULE_KEYRING"], broker: [], orchestrator: [], connector: [] },
      },
    },
    database: { provisioned: true, activity: [] },
  }),
  "migrate-failing-git": () => ({ argv: ["migrate"], tools: { emit, fail: { git: true } } }),
  "migrate-database-error": () => ({
    argv: ["migrate"],
    tools: { emit },
    database: { connectError: markerError() },
  }),
  "migrate-query-error": () => ({
    argv: ["migrate"],
    tools: { emit },
    database: { rules: [[/session_user::text AS session_role/, markerError()]] },
  }),
  "provision-first": () => ({
    argv: ["provision-roles", "--first"],
    tools: { emit },
    database: {},
  }),
  "provision-first-sql-error": () => ({
    argv: ["provision-roles", "--first"],
    tools: { emit },
    database: { execError: { pattern: /^ALTER ROLE/, error: markerError() } },
  }),
  "provision-rotate": (constants) => ({
    argv: ["provision-roles", "--rotate", "all"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
    database: {},
  }),
  "provision-rotate-bulk-fails": (constants) => ({
    argv: ["provision-roles", "--rotate", "morrow_api"],
    tools: {
      emit,
      wrangler: { secrets: { broker: constants.brokerSecrets } },
      fail: { wrangler: (args) => args[1] === "bulk" },
    },
    database: {},
  }),
  "put-secret": (constants) => ({
    argv: ["put-secret", "WORKOS_API_KEY"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
  }),
  "put-secret-fails": (constants) => ({
    argv: ["put-secret", "TURNSTILE_SECRET_KEY"],
    tools: {
      emit,
      wrangler: { secrets: { broker: constants.brokerSecrets } },
      fail: { wrangler: (a) => a[1] === "bulk" },
    },
  }),
  "census-fails": () => ({
    argv: ["census"],
    tools: { emit },
    cloudflare: { failWith: "STAGING_CLOUDFLARE_REQUEST_FAILED" },
  }),
  connections: () => ({
    argv: ["connections"],
    tools: { emit },
    database: {
      activity: [
        { role: "morrow_api", application: "morrow_id_" + "a".repeat(32) + "_p", n: 2 },
        { role: markers.database, application: markers.tool, n: 1 },
      ],
    },
  }),
  keyring: () => ({ argv: ["keyring"], tools: { emit }, keyring: true }),
  "seed-database-error": () => ({
    argv: ["seed-platform"],
    tools: { emit },
    database: { execError: { pattern: /^SET LOCAL ROLE/, error: markerError() } },
    seed: true,
  }),
};

const constants = await identityConstants();
const spec = scenarios[scenario]?.(constants);
if (!spec) process.exit(97);
const fake = fakeTools(spec.tools ?? {});
const cloud = fakeCloudflare(spec.cloudflare ?? {});
const db = fakeDatabase({ roles: constants.roles, ...(spec.database ?? {}) });
const loginConfiguration = {
  origin: "https://morrow-staging-api.lab.workers.dev",
  retentionTier: "staging",
  verificationProfileJson: JSON.stringify({
    schemaVersion: 1,
    providerId: "workos",
    environmentId: "environment_" + "E".repeat(26),
    applicationId: "app_" + "A".repeat(26),
    clientId: "client_" + "C".repeat(26),
    issuer: "https://api.workos.com/user_management/client_" + "C".repeat(26),
    revision: 1,
    audiencePolicy: "absent",
  }),
  profileId: "profile_staging",
  profileRecordRevision: 1,
  configurationDigest: "c".repeat(64),
  binding: {
    bindingId: "binding_staging",
    bindingRevision: 1,
    environmentId: "environment_" + "E".repeat(26),
    applicationId: "app_" + "A".repeat(26),
    clientId: "client_" + "C".repeat(26),
    redirectUri: "https://morrow-staging-api.lab.workers.dev/auth/workos/callback",
    returnPath: "/",
  },
};
const { ctx } = await fakeContext({
  home,
  tools: fake.tools,
  cloudflare: cloud.api,
  database: spec.database ? db.connector : undefined,
  overrides: {
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
    ...(spec.keyring || spec.seed ? { loginConfiguration: async () => loginConfiguration } : {}),
  },
});
let code;
try {
  code = await main(spec.argv, ctx);
} catch (error) {
  code = error instanceof StagingError ? 98 : 99;
}
writeFileSync(
  dumpPath,
  JSON.stringify({
    code,
    calls: fake.calls,
    statements: db.statements,
    bulkInputs: fake.state.bulkInputs,
    cloudflareCalls: cloud.calls,
  }),
);
process.exitCode = code;
