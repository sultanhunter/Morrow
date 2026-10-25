// Child process for tests/staging-secrets.test.mjs (P04.T01i AC07): runs one staging
// subcommand through scripts/staging.mjs `main` over fakes that carry secret markers in
// every source (files, environment, tool output, failing tools, database errors), with
// the subcommand's output bound to this process's real stdout and stderr, so the parent
// sees everything the tool could print at the file-descriptor level. The fakes' records
// (arguments, stdin, statements) go to a dump file for the parent's checks.
//   node --import tsx tests/fixtures/staging-marker-child.mjs <scenario> <home> <markers.json> <dump.json>
import { readFileSync, writeFileSync } from "node:fs";
import { identityConstants, main } from "../../scripts/staging.mjs";
import { loadMigrationChain, schemaHead } from "../../scripts/migration-chain.mjs";
import { StagingError } from "../../scripts/staging-common.mjs";
import {
  fakeCloudflare,
  fakeContext,
  fakeDatabase,
  fakeSite,
  fakeTools,
} from "./staging-fakes.mjs";

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

const head = schemaHead(loadMigrationChain());
const staging = JSON.parse(readFileSync("infra/environments/staging.json", "utf8"));
const labStaging = {
  ...staging,
  cloudflare: {
    ...staging.cloudflare,
    account_id: "0".repeat(31) + "1",
    workers_dev_subdomain: "lab",
    origin: "https://morrow-staging-api.lab.workers.dev",
  },
  neon: {
    ...staging.neon,
    project_id: "lab-project-runner",
    root_branch_id: "br-root-000001",
    branch_id: "br-lab-runner-000001",
  },
};
const widgetReply = {
  sitekey: "0x4AAAAAAA" + "S".repeat(14),
  secret: "0x4AAAAAAA" + markers.turnstile,
};
const probeNeonctl = (args) => {
  if (args[1] === "create")
    return {
      status: 0,
      stdout: JSON.stringify({
        branch: { id: "br-probe-000001", name: args[args.indexOf("--name") + 1] },
      }),
      stderr: emit,
    };
  if (args[0] === "connection-string")
    return {
      status: 0,
      stdout: `postgresql://neondb_owner:${markers.url}@ep-probe-000001.us-east-1.aws.neon.tech/neondb?sslmode=require\n`,
      stderr: emit,
    };
  if (args[1] === "reset") return { status: 0, stdout: "{}", stderr: emit };
  if (args[1] === "get")
    return {
      status: 0,
      stdout: JSON.stringify({ branch: { id: "br-probe-000001" } }),
      stderr: emit,
    };
  return null;
};
// A probe connection whose every failure carries markers in its message, in Neon's
// measured shape (M-N3, 2026-10-20): the verifier is refused with Neon's control-plane
// text around the markers, the generated plaintext is accepted, and pg_stat_statements is
// preloaded with utility tracking, so the probe wipes and verifies from neondb. Every
// statement goes to the dump, so the parent can check that the plaintext never reaches
// the output.
const probeStatements = [];
const probeScratch = { extension: false };
const probeConnection = async (url) => ({
  async query(text, params = []) {
    probeStatements.push({ text, params: [...params], database: url.database });
    if (/session_role/.test(text))
      return [
        {
          session_role: "neondb_owner",
          current_role: "neondb_owner",
          database: url.database,
          version: 170011,
          superuser: false,
          createrole: true,
          login: true,
        },
      ];
    if (/AS extension, current_setting/.test(text))
      return [
        {
          extension: url.database === "neondb" && probeScratch.extension,
          track: "top",
          track_utility: "on",
          password_encryption: "scram-sha-256",
          log_statement: "none",
          log_min_duration_statement: "-1",
          log_min_duration_sample: "-1",
          log_statement_sample_rate: "1",
          log_min_error_statement: "panic",
          log_duration: "off",
          debug_print_parse: "off",
          debug_print_rewritten: "off",
          debug_print_plan: "off",
        },
      ];
    if (/ AS instance$/.test(text)) return [{ instance: "1792526146.012127/10.0.0.1/5432" }];
    if (/FROM pg_catalog\.pg_database WHERE datname/.test(text)) return [{ present: true }];
    if (/pg_catalog\.pg_extension e JOIN/.test(text))
      return probeScratch.extension ? [{ schema: "public" }] : [];
    if (/clock_timestamp/.test(text)) return [{ before: "2026-10-20 19:00:00.000001+00" }];
    if (/pg_stat_statements_info/.test(text))
      return [{ full_reset: true, same_instance: true, remaining: 0 }];
    if (/^SELECT EXISTS \(SELECT 1 FROM pg_catalog\.pg_extension WHERE/.test(text))
      return [{ extension: url.database === "neondb" && probeScratch.extension }];
    if (/has_table_privilege/.test(text)) throw markerError();
    return [];
  },
  async exec(text) {
    probeStatements.push({ text, params: [], database: url.database });
    if (text === "CREATE EXTENSION pg_stat_statements") probeScratch.extension = true;
    if (text === "DROP EXTENSION pg_stat_statements") probeScratch.extension = false;
    if (/PASSWORD 'SCRAM/.test(text)) {
      const error = markerError();
      error.server =
        "Received HTTP code 400 from control plane: " +
        JSON.stringify({
          error: "Neon only supports being given plaintext passwords " + markers.url,
        });
      throw error;
    }
    if (/^REVOKE/.test(text)) throw markerError();
  },
  async close() {},
});
const deployValues = {
  STAGING_DEPLOY_ENABLED: "1",
  STAGING_SCHEMA_HEAD: head,
  STAGING_LOGIN_CONFIGURATION_DIGEST: "c".repeat(64),
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
  // M5: the Stripe switch on: the two Stripe owner files join the first-deploy file.
  "provision-first-stripe": () => ({
    stripe: "on",
    argv: ["provision-roles", "--first"],
    tools: { emit },
    database: {},
  }),
  // Neon's measured shape (M-N3 as amended 2026-10-20): the module loaded with utility
  // tracking, so the passwords are wiped from the scratch database and verified.
  "provision-first-neon": () => ({
    argv: ["provision-roles", "--first"],
    tools: { emit },
    database: { statementStats: { track: "top", track_utility: "on" } },
  }),
  // A residue after the wipe stops the rotation before `secret bulk`.
  "provision-rotate-residue": (constants) => ({
    argv: ["provision-roles", "--rotate", "all"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
    database: { statementStats: { track: "top", track_utility: "on" }, residue: 3 },
  }),
  // A reset that fails with markers in the server's text.
  "provision-first-wipe-error": () => ({
    argv: ["provision-roles", "--first"],
    tools: { emit },
    database: {
      statementStats: { track: "top", track_utility: "on" },
      rules: [[/pg_stat_statements_reset\(\)/, markerError()]],
    },
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
  // M2 PR-1: the owner's vault KEK file re-placed as the broker secret, by stdin only.
  "put-secret-kek": (constants) => ({
    argv: ["put-secret", "MORROW_VAULT_KEK_V1"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
  }),
  // M5 PR-1, with the Stripe switch on: the Stripe owner files, placed on a broker that
  // does not hold them yet.
  "put-secret-stripe-key": (constants) => ({
    stripe: "on",
    argv: ["put-secret", "STRIPE_RESTRICTED_KEY"],
    tools: {
      emit,
      wrangler: {
        secrets: { broker: constants.brokerSecrets.filter((n) => !n.startsWith("STRIPE_")) },
      },
    },
  }),
  "put-secret-stripe-webhook": (constants) => ({
    stripe: "on",
    argv: ["put-secret", "STRIPE_WEBHOOK_SECRET"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
  }),
  // M5: with the switch off (the committed state) put-secret refuses a Stripe name before
  // reading the file or running any tool.
  "put-secret-stripe-off": (constants) => ({
    argv: ["put-secret", "STRIPE_RESTRICTED_KEY"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
  }),
  // Build order PR 7: the E2B key. With the runtime switch off (committed) put-secret refuses
  // it before reading the file or running any tool, unless the owner passes
  // --while-runtime-off; then the owner file reaches the broker only through `secret bulk`
  // stdin. With the switch on the key is required and the flag is refused.
  "put-secret-e2b-off": (constants) => ({
    argv: ["put-secret", "E2B_API_KEY"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
  }),
  "put-secret-e2b-while-off": (constants) => ({
    argv: ["put-secret", "E2B_API_KEY", "--while-runtime-off"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
  }),
  "put-secret-e2b-on": (constants) => ({
    runtime: "on",
    argv: ["put-secret", "E2B_API_KEY"],
    tools: {
      emit,
      wrangler: {
        secrets: { broker: constants.brokerSecrets.filter((n) => n !== "E2B_API_KEY") },
      },
    },
  }),
  "put-secret-e2b-on-flag": (constants) => ({
    runtime: "on",
    argv: ["put-secret", "E2B_API_KEY", "--while-runtime-off"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
  }),
  "put-secret-flag-other": (constants) => ({
    argv: ["put-secret", "WORKOS_API_KEY", "--while-runtime-off"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
  }),
  // model-provider-on: the Anthropic key. With the model-provider switch off put-secret refuses
  // it before reading the file or running any tool (there is no flag to place it ahead of the
  // switch); with the switch on (the committed state) the owner file reaches the broker only
  // through `secret bulk` stdin, also when the running broker does not hold the name yet.
  "put-secret-model-off": (constants) => ({
    argv: ["put-secret", "ANTHROPIC_API_KEY"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
  }),
  "put-secret-model-on": (constants) => ({
    model: "on",
    argv: ["put-secret", "ANTHROPIC_API_KEY"],
    tools: {
      emit,
      wrangler: {
        secrets: { broker: constants.brokerSecrets.filter((n) => n !== "ANTHROPIC_API_KEY") },
      },
    },
  }),
  "put-secret-model-flag": (constants) => ({
    model: "on",
    argv: ["put-secret", "ANTHROPIC_API_KEY", "--while-runtime-off"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
  }),
  "put-secret-model-other-flag": (constants) => ({
    argv: ["put-secret", "ANTHROPIC_API_KEY", "--while-model-off"],
    tools: { emit, wrangler: { secrets: { broker: constants.brokerSecrets } } },
  }),
  // The first provisioning with the switch on reads the owner's Anthropic file into the
  // broker file, like the Stripe files.
  "provision-first-model": () => ({
    model: "on",
    argv: ["provision-roles", "--first"],
    tools: { emit },
    database: {},
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
  "turnstile-create": () => ({
    argv: ["turnstile-create"],
    tools: { emit },
    cloudflare: { widgetReply },
  }),
  "turnstile-lost": () => ({
    argv: ["turnstile-create"],
    tools: { emit },
    cloudflare: { widgetReply, widgetCreate: "lost" },
  }),
  "neon-probe": () => ({
    argv: ["neon-probe"],
    tools: { emit, neonctl: probeNeonctl },
    staging: labStaging,
    probe: true,
  }),
  "kill-failing": () => ({
    argv: ["kill"],
    tools: { emit, fail: { gh: true } },
    cloudflare: { failWith: "STAGING_CLOUDFLARE_REQUEST_FAILED" },
    fetch: async () => {
      throw Error("connect failed " + markers.url + " " + markers.tool);
    },
  }),
  "deploy-failing": (constants) => ({
    argv: ["deploy"],
    tools: {
      emit,
      gh: { values: deployValues },
      wrangler: { secrets: { broker: constants.brokerSecrets } },
      deployFails: () => true,
    },
    login: true,
  }),
  "deploy-first": (constants) => ({
    argv: ["deploy", "--first"],
    tools: {
      emit,
      gh: { values: { ...deployValues, STAGING_DEPLOY_ENABLED: "0" } },
      wrangler: { secrets: { broker: constants.brokerSecrets } },
    },
    cloudflare: { scripts: [] },
    login: true,
    site: true,
  }),
  "seed-database-error": () => ({
    argv: ["seed-platform"],
    tools: { emit },
    database: { execError: { pattern: /^SET LOCAL ROLE/, error: markerError() } },
    seed: true,
  }),
};

// M5: each scenario runs under its Stripe switch (off unless it says "on"); the switch is
// probed with off constants, then the scenario is built with its own.
const probe = scenarios[scenario]?.(await identityConstants());
if (!probe) process.exit(97);
const stripe = probe.stripe ?? "off";
// Build order PR 7: likewise the runtime switch (off unless the scenario says otherwise).
const runtime = probe.runtime ?? "off";
// model-provider-on: likewise the model-provider switch (off unless the scenario says "on").
const model = probe.model ?? "off";
const constants = await identityConstants({ stripe, model, runtime });
const spec = scenarios[scenario](constants);
const cloud = fakeCloudflare(spec.cloudflare ?? {});
const fake = fakeTools({ ...(spec.tools ?? {}), cloudflare: cloud });
const site = fakeSite({
  cloud,
  csp: (await import("../../scripts/staging.mjs")).committedCsp(process.cwd()),
});
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
const { ctx, reports } = await fakeContext({
  home,
  stripe,
  model,
  runtime,
  tools: fake.tools,
  cloudflare: cloud.api,
  database: spec.database ? db.connector : undefined,
  staging: spec.staging,
  fetch: spec.fetch ?? (spec.site ? site.fetch : null),
  overrides: {
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
    ...(spec.keyring || spec.seed || spec.login
      ? { loginConfiguration: async () => loginConfiguration }
      : {}),
    ...(spec.probe ? { probeDatabase: probeConnection } : {}),
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
    probeStatements,
    bulkInputs: fake.state.bulkInputs,
    cloudflareCalls: cloud.calls,
    reports,
  }),
);
process.exitCode = code;
