// P04.T01i PR-B, trimmed by ADR-0021: the deploy (AC03 gate steps, AC04 gates, AC05
// health without rollback), the kill switch and unkill (AC14, fake runner), the
// unattended and assisted smokes (D7), and the bring-up subcommands (preflight, status,
// neon-probe, queues, turnstile-create). Everything runs over fake wrangler, gh, neonctl,
// Cloudflare API, database and HTTP; nothing reaches a provider.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  checkChallengeConfiguration,
  checkStripeConfiguration,
  committedCsp,
  commands,
  identityConstants,
  main,
  stagingChallengeActions,
} from "../scripts/staging.mjs";
import { loadMigrationChain, schemaHead } from "../scripts/migration-chain.mjs";
import { deployOrder, killChecks } from "../scripts/staging-deploy.mjs";
import {
  assistedContextOptions,
  assistedLaunchOptions,
  cookieAttributes,
  cookieAttributesOk,
} from "../scripts/staging-smoke.mjs";
import { StagingError } from "../scripts/staging-common.mjs";
import {
  approvedCard,
  fakeCloudflare,
  fakeContext,
  fakeSha,
  fakeSite,
  fakeTools,
  fakeUuid,
  labSiteKey,
  plantedHome,
  scriptOf,
  unsetStaging,
} from "./fixtures/staging-fakes.mjs";

const head = schemaHead(loadMigrationChain());
const digest = "c".repeat(64);
const csp = committedCsp(process.cwd());
const constants = await identityConstants();
// M5: the Stripe switch on (owner decision (c), 2026-10-21); `constants` is the committed off.
const constantsOn = await identityConstants({ stripe: "on" });
const accountId = "0".repeat(31) + "1";
const origin = "https://morrow-staging-api.lab.workers.dev";
const ciEnvironment = (overrides = {}) => ({
  ci: true,
  headSha: fakeSha("main"),
  deployEnabled: "1",
  schemaHead: head,
  loginDigest: digest,
  accountId,
  ...overrides,
});

// One staging world over fakes. `hook` runs while a `wrangler deploy` is in flight.
async function world({
  gh = {},
  wrangler = {},
  git,
  scripts,
  cloudflare = {},
  ready = true,
  guard = true,
  environment = {},
  card,
  files,
  staging,
  challengeVars,
  overrides = {},
  tools = {},
  stripe = "off",
} = {}) {
  const cloud = fakeCloudflare({ scripts, ...cloudflare });
  const hooks = { onDeploy: null };
  const fake = fakeTools({
    cloudflare: cloud,
    git,
    gh: {
      ...gh,
      values: {
        STAGING_DEPLOY_ENABLED: "1",
        STAGING_SCHEMA_HEAD: head,
        STAGING_LOGIN_CONFIGURATION_DIGEST: digest,
        ...(gh.values ?? {}),
      },
    },
    wrangler: {
      secrets: {
        api: ["LOGIN_CAPSULE_KEYRING"],
        broker: (stripe === "on" ? constantsOn : constants).brokerSecrets,
        orchestrator: [],
        connector: [],
        ...(wrangler.secrets ?? {}),
      },
    },
    onDeploy: (worker, state) => hooks.onDeploy?.(worker, state),
    ...tools,
  });
  const site = fakeSite({ cloud, ready, guard, csp });
  const planted = plantedHome(files ?? {});
  const context = await fakeContext({
    home: planted.home,
    tools: fake.tools,
    cloudflare: cloud.api,
    card,
    staging,
    environment,
    challengeVars,
    stripe,
    fetch: site.fetch,
    overrides: {
      loginConfiguration: async () => ({ configurationDigest: digest, origin }),
      ...overrides,
    },
  });
  // The command's own line is the last one written: a kill run from a deploy hook writes
  // its line earlier.
  const run = async (argv) => {
    let last = null;
    const { stdout, stderr } = context.ctx;
    context.ctx.stdout = (line) => ((last = line), stdout(line));
    context.ctx.stderr = (line) => ((last = line), stderr(line));
    try {
      const code = await main(argv, context.ctx);
      return { code, result: JSON.parse(last) };
    } finally {
      Object.assign(context.ctx, { stdout, stderr });
    }
  };
  return { ...context, cloud, fake, site, planted, hooks, run };
}
const wranglerCalls = (w) => w.fake.calls.filter((c) => c.tool === "wrangler");
const deploys = (w) => wranglerCalls(w).filter((c) => c.args[0] === "deploy");
const deployedWorkers = (w) =>
  deploys(w).map((c) => c.args[c.args.indexOf("--config") + 1].split("/")[1]);
const configWorker = {
  broker: "broker",
  workers: "orchestrator",
  "shopify-connector": "connector",
  api: "api",
};

// ---------------------------------------------------------------------------
// AC04: gates 1–6 and the order.
test("AC04: a green CI deploy runs the gates, then broker, orchestrator, connector and api", async () => {
  const w = await world({ environment: ciEnvironment() });
  try {
    const { code, result } = await w.run(["deploy", "--ci"]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.equal(result.outcome, "deployed");
    assert.deepEqual(
      deployedWorkers(w).map((dir) => configWorker[dir]),
      ["broker", "orchestrator", "connector", "api"],
    );
    assert.deepEqual([...deployOrder], ["broker", "orchestrator", "connector", "api"]);
    for (const call of deploys(w)) {
      assert.deepEqual(call.args.slice(-4), ["--env", "staging", "--message", fakeSha("main")]);
      assert.ok(!call.args.includes("--secrets-file"));
    }
    assert.deepEqual(result.gates, {
      main: "ok",
      flag: "on",
      dryRun: "previous_step",
      schema: "ok",
      configuration: "ok",
      challenge: "ok",
      brokerSecrets: "ok",
      census: "ok",
      flagBeforeBroker: "on",
      flagBeforeOrchestrator: "on",
      flagBeforeConnector: "on",
      flagBeforeApi: "on",
      flagAfterApi: "on",
    });
    for (const key of deployOrder) {
      assert.match(result.versions[key].previous, /^[0-9a-f-]{36}$/);
      assert.match(result.versions[key].current, /^[0-9a-f-]{36}$/);
      assert.notEqual(result.versions[key].previous, result.versions[key].current);
      assert.equal(result.versions[key].outcome, "deployed");
    }
    assert.equal(result.health.ready, true);
    assert.deepEqual(result.smoke.failures, []);
    assert.deepEqual(result.censusBefore.findings, []);
    assert.deepEqual(result.census.findings, []);
    // M2 PR-2: the deployed connector binds the broker's ConnectorBroker entrypoint, and
    // M3 PR-2 the deployed orchestrator its RuntimeBroker entrypoint; the census allow
    // table admits both, so continuous deploy keeps running after each merge.
    assert.deepEqual(
      result.census.scripts
        .filter((s) => s.bindsBroker)
        .map((s) => [s.name, s.brokerEntrypoints])
        .sort(),
      [
        ["morrow-staging-api", ["ApiBroker"]],
        ["morrow-staging-connector", ["ConnectorBroker"]],
        ["morrow-staging-orchestrator", ["RuntimeBroker"]],
      ],
    );
    // CI never reads a variable through the API (its token cannot); it re-reads the
    // workflow's state at gate 2, before every upload and after the api deploy.
    const ghApi = w.fake.calls.filter((c) => c.tool === "gh").map((c) => c.args.join(" "));
    assert.ok(!ghApi.some((a) => /\/variables\//.test(a)), ghApi.join("\n"));
    assert.equal(ghApi.filter((a) => /deploy-staging\.yml$/.test(a)).length, 6);
    // The report goes through the closed projection before and after every upload, then
    // once more at the end, always to the same path.
    assert.ok(w.reports.every((r) => r.name === "staging/deploy-report.json"));
    assert.equal(w.reports.length, 2 * deployOrder.length + 1);
    for (const [i, key] of deployOrder.entries()) {
      const before = w.reports[2 * i].value;
      assert.equal(before.outcome, "running");
      assert.equal(before.versions[key].outcome, "in_flight", key);
      assert.equal(w.reports[2 * i + 1].value.versions[key].outcome, "deployed", key);
    }
    assert.equal(w.reports.at(-1).value.outcome, "deployed");
  } finally {
    w.planted.cleanup();
  }
});

test("AC04: a superseded sha, a flag other than 1 or a disabled workflow exit 0 with no wrangler call", async () => {
  for (const [label, options, outcome] of [
    [
      "superseded",
      { environment: ciEnvironment(), gh: { mainTip: fakeSha("newer") } },
      "superseded",
    ],
    ["ci flag 0", { environment: ciEnvironment({ deployEnabled: "0" }) }, "disabled"],
    ["ci flag unset", { environment: ciEnvironment({ deployEnabled: "" }) }, "disabled"],
    [
      "ci workflow disabled",
      { environment: ciEnvironment(), gh: { workflow: "disabled_manually" } },
      "disabled",
    ],
    ["local flag 0", { gh: { values: { STAGING_DEPLOY_ENABLED: "0" } } }, "disabled"],
    ["local workflow disabled", { gh: { workflow: "disabled_manually" } }, "disabled"],
  ]) {
    const w = await world(options);
    try {
      const argv = options.environment ? ["deploy", "--ci"] : ["deploy"];
      const { code, result } = await w.run(argv);
      assert.equal(code, 0, label + " " + JSON.stringify(result));
      assert.equal(result.outcome, outcome, label);
      assert.deepEqual(wranglerCalls(w), [], label);
      assert.deepEqual(w.cloud.calls, [], label);
    } finally {
      w.planted.cleanup();
    }
  }
});

test("AC04: a mismatched schema head, digest or broker secret name, or a failed dry-run, deploys nothing", async () => {
  for (const [label, options, code] of [
    [
      "schema ci",
      { environment: ciEnvironment({ schemaHead: "f".repeat(64) }) },
      "STAGING_SCHEMA_HEAD_MISMATCH",
    ],
    [
      "schema local",
      { gh: { values: { STAGING_SCHEMA_HEAD: "f".repeat(64) } } },
      "STAGING_SCHEMA_HEAD_MISMATCH",
    ],
    [
      "digest ci",
      { environment: ciEnvironment({ loginDigest: "d".repeat(64) }) },
      "STAGING_KEYRING_ROTATION_NEEDED",
    ],
    [
      "digest local",
      { gh: { values: { STAGING_LOGIN_CONFIGURATION_DIGEST: "d".repeat(64) } } },
      "STAGING_KEYRING_ROTATION_NEEDED",
    ],
    [
      "broker missing a name",
      {
        environment: ciEnvironment(),
        wrangler: { secrets: { broker: constants.brokerSecrets.slice(1) } },
      },
      "STAGING_BROKER_SECRETS_MISMATCH",
    ],
    [
      "broker extra name",
      {
        environment: ciEnvironment(),
        wrangler: { secrets: { broker: [...constants.brokerSecrets, "STRAY_SECRET"] } },
      },
      "STAGING_BROKER_SECRETS_MISMATCH",
    ],
    [
      "account mismatch",
      { environment: ciEnvironment({ accountId: "f".repeat(32) }) },
      "STAGING_ACCOUNT_MISMATCH",
    ],
    [
      "dry-run",
      {
        overrides: {
          gate5: async () => {
            throw new StagingError("STAGING_GATE5_FAILED", { step: "edge:dry-run", status: 1 });
          },
        },
      },
      "STAGING_GATE5_FAILED",
    ],
  ]) {
    const w = await world(options);
    try {
      const { code: exit, result } = await w.run(
        options.environment ? ["deploy", "--ci"] : ["deploy"],
      );
      assert.equal(exit, 1, label);
      assert.equal(result.outcome, "failed", label);
      assert.equal(result.code, code, label);
      assert.deepEqual(deploys(w), [], label);
      if (label === "dry-run") assert.deepEqual(wranglerCalls(w), []);
      if (label.startsWith("schema"))
        assert.equal(result.next, "run_staging_migrate_then_gh_run_rerun");
    } finally {
      w.planted.cleanup();
    }
  }
});

// P05.T01ab reconciliation (D1, D5; ADR-0019 items 6-8): gate 4 also requires the api's
// LOGIN_CHALLENGE_JSON and the broker's TURNSTILE_CONFIGURATION_JSON, in agreement, so no
// api is uploaded that would map to API_ENV_ABUSE_GUARD_MISSING and no broker whose health
// is false. Both carry PR-D part 1 identifiers; the committed staging config passes.
test("AC04: gate 4 refuses a missing or inconsistent challenge configuration and deploys nothing", async () => {
  const host = new URL(origin).hostname;
  const apiVar = (patch = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      provider: "turnstile",
      siteKey: labSiteKey,
      actions: stagingChallengeActions,
      ...patch,
    });
  const brokerVar = (patch = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      hostname: host,
      actions: stagingChallengeActions,
      ...patch,
    });
  // Two broker vars that JSON.parse reads as the valid one, but the broker's own parser
  // (loginJson: no duplicate member, at most 1024 bytes) refuses after upload.
  const duplicate =
    `{"schemaVersion":1,"hostname":"evil.example","hostname":${JSON.stringify(host)},` +
    `"actions":${JSON.stringify(stagingChallengeActions)}}`;
  const oversized = brokerVar() + " ".repeat(1025 - brokerVar().length);
  for (const lenient of [duplicate, oversized])
    assert.deepEqual(JSON.parse(lenient), JSON.parse(brokerVar()));
  assert.equal(new TextEncoder().encode(oversized).length, 1025);
  for (const [label, challengeVars, code, reason] of [
    ["api var absent", { api: null }, "STAGING_CHALLENGE_CONFIGURATION_MISSING"],
    ["broker var absent", { broker: null }, "STAGING_CHALLENGE_CONFIGURATION_MISSING"],
    ["api var empty", { api: "" }, "STAGING_CHALLENGE_CONFIGURATION_MISSING"],
    [
      "login configuration absent on both sides",
      { apiLogin: null, brokerLogin: null },
      "STAGING_CHALLENGE_CONFIGURATION_MISSING",
      "shared_vars",
    ],
    [
      "binding absent on both sides",
      { apiBinding: null, brokerBinding: null },
      "STAGING_CHALLENGE_CONFIGURATION_MISSING",
      "shared_vars",
    ],
    [
      "binding empty on both sides",
      { apiBinding: "", brokerBinding: "" },
      "STAGING_CHALLENGE_CONFIGURATION_MISSING",
      "shared_vars",
    ],
    [
      "broker login configuration absent",
      { brokerLogin: null },
      "STAGING_CHALLENGE_CONFIGURATION_MISSING",
      "shared_vars",
    ],
    [
      "broker duplicate hostname member",
      { broker: duplicate },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "broker",
    ],
    [
      "broker var over 1024 bytes",
      { broker: oversized },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "broker",
    ],
    [
      "dummy site key",
      { api: apiVar({ siteKey: "1x00000000000000000000AA" }) },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "api",
    ],
    // Another well-formed key than staging.json's widget's (`cloudflare.turnstile.site_key`).
    [
      "swapped well-formed site key",
      { api: apiVar({ siteKey: labSiteKey.slice(0, -1) + "z" }) },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "site_key",
    ],
    [
      "api provider none",
      { api: JSON.stringify({ provider: "none" }) },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "api",
    ],
    [
      "broker extra key",
      { broker: brokerVar({ secret: "x" }) },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "broker",
    ],
    [
      "actions differ",
      {
        broker: brokerVar({ actions: { login: "account_login", signup: "other_signup" } }),
      },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "actions",
    ],
    [
      "actions reordered",
      {
        api: apiVar({ actions: { signup: "organization_signup", login: "account_login" } }),
        broker: brokerVar({ actions: { signup: "organization_signup", login: "account_login" } }),
      },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "actions",
    ],
    [
      "not D1's actions",
      {
        api: apiVar({ actions: { login: "a_login", signup: "a_signup" } }),
        broker: brokerVar({ actions: { login: "a_login", signup: "a_signup" } }),
      },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "actions",
    ],
    [
      "hostname is not the origin's",
      { broker: brokerVar({ hostname: "morrow-staging-broker.lab.workers.dev" }) },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "hostname",
    ],
    [
      "broker login configuration differs",
      { brokerLogin: '{"schemaVersion":1}' },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "shared_vars",
    ],
    [
      "broker binding differs",
      { brokerBinding: '{"schemaVersion":1}' },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "shared_vars",
    ],
  ]) {
    for (const ci of [false, true]) {
      const w = await world({
        challengeVars,
        ...(ci ? { environment: ciEnvironment() } : {}),
      });
      try {
        const { code: exit, result } = await w.run(ci ? ["deploy", "--ci"] : ["deploy"]);
        assert.equal(exit, 1, label);
        assert.equal(result.outcome, "failed", label);
        assert.equal(result.code, code, label);
        assert.equal(result.failure?.reason, reason, label);
        assert.equal(
          result.gates.challenge,
          code.endsWith("_MISSING") ? "missing" : "invalid",
          label,
        );
        assert.equal(result.gates.brokerSecrets, undefined, label);
        assert.deepEqual(wranglerCalls(w), [], label);
      } finally {
        w.planted.cleanup();
      }
    }
  }
  // The consistent pair passes gate 4 and the deploy goes on (the other AC04 cases). The
  // shared vars are real text on both sides, so this is not null equalling null.
  const ok = await world({ environment: ciEnvironment() });
  try {
    const loaded = await ok.ctx.config();
    for (const value of [
      loaded.loginConfigurationJson,
      loaded.bindingJson,
      loaded.broker.loginConfigurationJson,
      loaded.broker.bindingJson,
    ])
      assert.ok(typeof value === "string" && value.length > 0);
    const { result } = await ok.run(["deploy", "--ci"]);
    assert.equal(result.gates.challenge, "ok");
    assert.equal(result.outcome, "deployed");
  } finally {
    ok.planted.cleanup();
  }
  // P04.T01i PR-D part 1: the committed staging configuration passes gate 4's challenge
  // check (D1's actions, the origin's hostname, the broker's shared vars byte-equal).
  const committed = await import("../scripts/staging.mjs").then((m) =>
    m.loadStagingConfiguration(process.cwd()),
  );
  assert.deepEqual(await checkChallengeConfiguration(committed), {
    provider: "turnstile",
    hostname: "morrow-staging-api.sultanibneusman0.workers.dev",
    actions: stagingChallengeActions,
  });
  assert.equal(
    JSON.parse(committed.challengeJson).siteKey,
    committed.staging.cloudflare.turnstile.site_key,
  );
  // staging.json records another well-formed key, or none: the committed vars fail gate 4.
  for (const turnstile of [
    { ...committed.staging.cloudflare.turnstile, site_key: "0x4AAAAAAFdwF1eDox4vfBd3" },
    null,
  ])
    await assert.rejects(
      checkChallengeConfiguration({
        ...committed,
        staging: {
          ...committed.staging,
          cloudflare: { ...committed.staging.cloudflare, turnstile },
        },
      }),
      (error) =>
        error.code === "STAGING_CHALLENGE_CONFIGURATION_INVALID" &&
        error.details.reason === "site_key",
    );
});

// P04.T01i PR-D part 1: gate 4's digest step reads the committed login configuration with
// the runtime's parser (the real context, no fake): a staging tier and the staging origin.
// Its configurationDigest is what `staging:keyring` binds and the deploy compares with
// STAGING_LOGIN_CONFIGURATION_DIGEST.
test("AC04: the committed login configuration passes gate 4's digest step", async () => {
  const { defaultContext, loadStagingConfiguration } = await import("../scripts/staging.mjs");
  const committed = await loadStagingConfiguration(process.cwd());
  const parsed = await defaultContext().loginConfiguration(committed);
  assert.equal(parsed.retentionTier, "staging");
  assert.equal(parsed.origin, committed.staging.cloudflare.origin);
  assert.equal(parsed.binding.redirectUri, parsed.origin + "/auth/workos/callback");
  assert.match(parsed.configurationDigest, /^[0-9a-f]{64}$/);
  // Another origin in staging.json than the committed configuration's fails closed.
  await assert.rejects(
    defaultContext().loginConfiguration({
      ...committed,
      staging: {
        ...committed.staging,
        cloudflare: { ...committed.staging.cloudflare, origin: "https://other.example" },
      },
    }),
    { code: "STAGING_LOGIN_CONFIGURATION_INVALID" },
  );
});

// M5 PR-1 and the Stripe switch (owner decision (c), 2026-10-21). Gate 4 holds the Stripe
// vars to the committed switch before anything is uploaded: off (committed), neither
// Worker carries MORROW_STRIPE_MODE and the broker no STRIPE_CONFIGURATION_JSON; on, both
// carry "test" and the broker's configuration parses with its own parser. Anything else
// is STAGING_STRIPE_SWITCH_MIXED (or _CONFIGURATION_INVALID) and deploys nothing. Gate 6
// then expects the broker's fourteen names off and sixteen on.
test("AC04: gate 4 holds the Stripe vars to the switch; gate 6 its secrets; a mixed state deploys nothing", async () => {
  const valid = {
    schemaVersion: 1,
    portalConfigurationId: "bpc_" + "A".repeat(24),
    automaticTax: false,
    billingAddressCollection: "auto",
  };
  const committed = await import("../scripts/staging.mjs").then((m) =>
    m.loadStagingConfiguration(process.cwd()),
  );
  assert.equal(committed.broker.stripeJson, null);
  assert.equal(committed.broker.stripeMode, null);
  assert.equal(committed.stripeMode, null);
  assert.deepEqual(await checkStripeConfiguration(committed), { stripe: "off", present: false });
  assert.deepEqual(await checkStripeConfiguration(committed, "off"), {
    stripe: "off",
    present: false,
  });
  const on = (change = {}, broker = {}) => ({
    stripeMode: "test",
    ...change,
    broker: { stripeJson: JSON.stringify(valid), stripeMode: "test", ...broker },
  });
  assert.deepEqual(await checkStripeConfiguration(on(), "on"), {
    stripe: "on",
    present: true,
    automaticTax: false,
  });
  // Mixed states, either way.
  for (const [loaded, stripe] of [
    [{ broker: { stripeJson: JSON.stringify(valid) } }, "off"],
    [{ stripeMode: "test", broker: {} }, "off"],
    [{ broker: { stripeMode: "test" } }, "off"],
    [on(), "off"],
    [committed, "on"],
    [on({}, { stripeJson: null }), "on"],
    [on({ stripeMode: null }), "on"],
    [on({}, { stripeMode: null }), "on"],
    [on({ stripeMode: "live" }), "on"],
    [on({}, { stripeMode: "TEST" }), "on"],
    [on(), "maybe"],
  ])
    await assert.rejects(
      checkStripeConfiguration(loaded, stripe),
      { code: "STAGING_STRIPE_SWITCH_MIXED" },
      stripe + ":" + JSON.stringify(loaded),
    );
  for (const bad of [
    { ...valid, extra: 1 },
    { ...valid, portalConfigurationId: "bpc_short" },
    { ...valid, portalConfigurationId: "pc_" + "A".repeat(24) },
    { ...valid, automaticTax: "false" },
    { ...valid, billingAddressCollection: "never" },
    { ...valid, schemaVersion: 2 },
  ])
    await assert.rejects(
      checkStripeConfiguration(on({}, { stripeJson: JSON.stringify(bad) }), "on"),
      { code: "STAGING_STRIPE_CONFIGURATION_INVALID" },
      JSON.stringify(bad),
    );
  await assert.rejects(checkStripeConfiguration(on({}, { stripeJson: "{" }), "on"), {
    code: "STAGING_STRIPE_CONFIGURATION_INVALID",
  });
  // Through the deploy, local and CI: nothing reaches wrangler.
  for (const [label, options, code] of [
    [
      "configuration while off",
      { challengeVars: { brokerStripe: JSON.stringify(valid) } },
      "STAGING_STRIPE_SWITCH_MIXED",
    ],
    [
      "api mode while off",
      { challengeVars: { apiStripeMode: "test" } },
      "STAGING_STRIPE_SWITCH_MIXED",
    ],
    [
      "no configuration while on",
      { stripe: "on", challengeVars: { brokerStripe: null } },
      "STAGING_STRIPE_SWITCH_MIXED",
    ],
    [
      "malformed while on",
      { stripe: "on", challengeVars: { brokerStripe: JSON.stringify({ ...valid, x: 1 }) } },
      "STAGING_STRIPE_CONFIGURATION_INVALID",
    ],
  ])
    for (const ci of [false, true]) {
      const bad = await world({ ...options, ...(ci ? { environment: ciEnvironment() } : {}) });
      try {
        const { code: exit, result } = await bad.run(ci ? ["deploy", "--ci"] : ["deploy"]);
        assert.equal(exit, 1, label);
        assert.equal(result.outcome, "failed", label);
        assert.equal(result.code, code, label);
        assert.equal(result.gates.challenge, "invalid", label);
        assert.deepEqual(wranglerCalls(bad), [], label);
      } finally {
        bad.planted.cleanup();
      }
    }
  // Gate 6 follows the switch: off, a broker that holds the Stripe names (or, on, one that
  // lacks them) stops before any upload.
  const { brokerRequiredSecrets } = await import("../packages/identity/src/broker-protocol.ts");
  for (const [label, options] of [
    ["stripe names while off", { wrangler: { secrets: { broker: constantsOn.brokerSecrets } } }],
    [
      "no stripe names while on",
      { stripe: "on", wrangler: { secrets: { broker: [...brokerRequiredSecrets] } } },
    ],
  ]) {
    const mismatch = await world({ ...options, environment: ciEnvironment() });
    try {
      const { result } = await mismatch.run(["deploy", "--ci"]);
      assert.equal(result.gates.challenge, "ok", label);
      assert.equal(result.gates.brokerSecrets, "mismatch", label);
      assert.equal(result.code, "STAGING_BROKER_SECRETS_MISMATCH", label);
      assert.deepEqual(deploys(mismatch), [], label);
    } finally {
      mismatch.planted.cleanup();
    }
  }
  // The committed state (off, fourteen names) and the switch on (sixteen) both deploy.
  for (const options of [{}, { stripe: "on" }]) {
    const ok = await world({ ...options, environment: ciEnvironment() });
    try {
      const { result } = await ok.run(["deploy", "--ci"]);
      assert.equal(result.gates.challenge, "ok");
      assert.equal(result.gates.brokerSecrets, "ok");
      assert.equal(result.outcome, "deployed");
    } finally {
      ok.planted.cleanup();
    }
  }
});

test("AC04: a local deploy refuses a HEAD that is not origin/main, a missing or failed foundation, a dirty tree", async () => {
  for (const [label, options, code] of [
    ["head", { git: { head: fakeSha("other") } }, "STAGING_NOT_MAIN"],
    ["dirty", { git: { status: " M scripts/staging.mjs\n" } }, "STAGING_TREE_DIRTY"],
    ["missing", { gh: { checkRuns: [] } }, "STAGING_FOUNDATION_MISSING"],
    [
      "failed",
      {
        gh: {
          checkRuns: [
            {
              name: "foundation",
              head_sha: fakeSha("main"),
              status: "completed",
              conclusion: "failure",
            },
          ],
        },
      },
      "STAGING_FOUNDATION_NOT_GREEN",
    ],
  ]) {
    const w = await world(options);
    try {
      const { code: exit, result } = await w.run(["deploy"]);
      assert.equal(exit, 1, label);
      assert.equal(result.code, code, label);
      assert.deepEqual(wranglerCalls(w), [], label);
    } finally {
      w.planted.cleanup();
    }
  }
  // CI mode only in CI; local modes never in CI; no card, no deploy.
  const local = await world();
  try {
    assert.equal((await local.run(["deploy", "--ci"])).result.code, "STAGING_CI_ONLY");
    assert.equal((await local.run(["deploy", "--rollback"])).code, 2);
  } finally {
    local.planted.cleanup();
  }
  const ci = await world({ environment: ciEnvironment() });
  try {
    assert.equal((await ci.run(["deploy"])).result.code, "STAGING_LOCAL_ONLY");
    assert.equal((await ci.run(["deploy", "--first"])).result.code, "STAGING_LOCAL_ONLY");
  } finally {
    ci.planted.cleanup();
  }
  const expired = await world({
    environment: ciEnvironment(),
    card: approvedCard("2026-09-01"),
  });
  try {
    const { code, result } = await expired.run(["deploy", "--ci"]);
    assert.equal(code, 1);
    assert.deepEqual(result, {
      command: "deploy",
      code: "STAGING_CARD_INACTIVE",
      reason: "expired",
    });
    assert.deepEqual(wranglerCalls(expired), []);
  } finally {
    expired.planted.cleanup();
  }
});

test("AC04: a failed upload is reconciled: unchanged is not deployed, anything else is unknown", async () => {
  const kept = await world({
    environment: ciEnvironment(),
    tools: { deployFails: (w) => w === "orchestrator", deployLands: (w) => w !== "orchestrator" },
  });
  try {
    const { code, result } = await kept.run(["deploy", "--ci"]);
    assert.equal(code, 1);
    assert.equal(result.outcome, "failed");
    assert.equal(result.code, "STAGING_DEPLOY_FAILED");
    assert.equal(result.worker, "orchestrator");
    assert.equal(result.versions.orchestrator.outcome, "not_deployed");
    assert.deepEqual(deployedWorkers(kept), ["broker", "workers"]);
  } finally {
    kept.planted.cleanup();
  }
  const landed = await world({
    environment: ciEnvironment(),
    tools: { deployFails: (w) => w === "connector" },
  });
  try {
    const { code, result } = await landed.run(["deploy", "--ci"]);
    assert.equal(code, 1);
    assert.equal(
      result.outcome,
      "unknown",
      "a new version the tool did not confirm is never success",
    );
    assert.equal(result.versions.connector.outcome, "unknown");
    assert.equal(result.versions.api.outcome, "pending");
    assert.ok(!deployedWorkers(landed).includes("api"));
    assert.deepEqual(result.census.findings, [], "the census still runs after an unknown upload");
  } finally {
    landed.planted.cleanup();
  }
});

// ADR-0019 item 2, OQ-3 C: a census before any upload, and one on every path that
// started an upload, whatever the outcome.
test("AC04: a census finding before any upload deploys nothing; every path with an upload is censused", async () => {
  const bound = await world({
    environment: ciEnvironment(),
    scripts: [
      ...Object.values(scriptOf).map((name) => ({
        name,
        enabled: name === scriptOf.api,
        previews: false,
        bindings:
          name === scriptOf.api ? [{ service: scriptOf.broker, entrypoint: "ApiBroker" }] : [],
      })),
      { name: "other-product", enabled: false, previews: false, bindings: [scriptOf.broker] },
    ],
  });
  try {
    const { code, result } = await bound.run(["deploy", "--ci"]);
    assert.equal(code, 1);
    assert.equal(result.code, "STAGING_CENSUS_FINDINGS");
    assert.equal(result.gates.census, "findings");
    assert.deepEqual(result.censusBefore.findings.map((f) => f.code).sort(), [
      "BROKER_BOUND_ELSEWHERE",
      "NOT_MORROW_SCRIPT",
    ]);
    assert.deepEqual(deploys(bound), []);
    assert.equal(result.census, null, "no upload, so nothing changed to census");
  } finally {
    bound.planted.cleanup();
  }
  // The broker is exposed while the deploy runs, and the connector upload then fails:
  // the run fails on the upload, and its census still records the exposure.
  const exposed = await world({
    environment: ciEnvironment(),
    tools: { deployFails: (k) => k === "connector", deployLands: (k) => k !== "connector" },
  });
  try {
    exposed.hooks.onDeploy = (worker) => {
      if (worker === "orchestrator")
        exposed.cloud.scripts.find((s) => s.name === scriptOf.broker).enabled = true;
    };
    const { code, result } = await exposed.run(["deploy", "--ci"]);
    assert.equal(code, 1);
    assert.equal(result.code, "STAGING_DEPLOY_FAILED");
    assert.equal(result.worker, "connector");
    assert.deepEqual(result.census.findings, [
      { code: "WORKERS_DEV_EXPOSED", name: scriptOf.broker },
    ]);
    assert.equal(exposed.reports.at(-1).value.census.findings[0].code, "WORKERS_DEV_EXPOSED");
  } finally {
    exposed.planted.cleanup();
  }
  // A census that cannot be read after the uploads fails a run that would have passed.
  const unreadable = await world({ environment: ciEnvironment() });
  try {
    unreadable.hooks.onDeploy = (worker) => {
      if (worker === "api")
        unreadable.cloud.api.list = async () => {
          throw new StagingError("STAGING_CLOUDFLARE_REQUEST_FAILED", { status: 403 });
        };
    };
    const { code, result } = await unreadable.run(["deploy", "--ci"]);
    assert.equal(code, 1);
    assert.equal(result.outcome, "failed");
    assert.equal(result.code, "STAGING_CLOUDFLARE_REQUEST_FAILED");
    assert.deepEqual(result.census, { failed: true, code: "STAGING_CLOUDFLARE_REQUEST_FAILED" });
    assert.equal(result.health.ready, true);
  } finally {
    unreadable.planted.cleanup();
  }
});

// ADR-0019 item 13: the report is the record unknown outcomes are reconciled against, so
// it exists before each upload starts, not only when the run ends.
test("AC04: a run that dies during an upload leaves a report naming that upload in flight", async () => {
  const w = await world({ environment: ciEnvironment() });
  try {
    let seen = null;
    w.hooks.onDeploy = (worker) => {
      if (worker === "orchestrator") seen = w.reports.at(-1).value;
    };
    await w.run(["deploy", "--ci"]);
    assert.equal(seen.command, "deploy");
    assert.equal(seen.outcome, "running");
    assert.equal(seen.versions.broker.outcome, "deployed");
    assert.match(seen.versions.broker.current, /^[0-9a-f-]{36}$/);
    assert.equal(seen.versions.orchestrator.outcome, "in_flight");
    assert.equal(seen.versions.orchestrator.previous, fakeUuid(3));
    assert.equal(seen.versions.api.outcome, "pending");
    assert.equal(seen.gates.flagBeforeOrchestrator, "on");
  } finally {
    w.planted.cleanup();
  }
});

// Finding: the schema head is a cached variable, so `migrate` withdraws it before it
// touches the database; a reset that is followed by a failed migrate cannot deploy.
test("AC04: migrate withdraws the schema head first, so a deploy after a reset stops at gate 3", async () => {
  const ownerUrl = `postgresql://neondb_owner:${"o".repeat(24)}@ep-lab-runner-000001.us-east-1.aws.neon.tech/morrow?sslmode=require`;
  const w = await world({ files: { "neon-owner-url": ownerUrl } });
  try {
    assert.equal(w.fake.state.values.STAGING_SCHEMA_HEAD, head);
    // The owner's reset leaves an empty database; the rerun of migrate then fails.
    let atConnect = null;
    w.ctx.database = () => ({
      async connect() {
        atConnect = w.fake.state.values.STAGING_SCHEMA_HEAD;
        throw new StagingError("STAGING_DATABASE_UNAVAILABLE");
      },
    });
    const migrate = await w.run(["migrate"]);
    assert.equal(migrate.code, 1);
    assert.equal(migrate.result.code, "STAGING_DATABASE_UNAVAILABLE");
    assert.equal(atConnect, "0", "withdrawn before the first database statement");
    assert.equal(w.fake.state.values.STAGING_SCHEMA_HEAD, "0");
    const { code, result } = await w.run(["deploy"]);
    assert.equal(code, 1);
    assert.equal(result.code, "STAGING_SCHEMA_HEAD_MISMATCH");
    assert.deepEqual(deploys(w), []);
  } finally {
    w.planted.cleanup();
  }
  // A HEAD that is not origin/main never reaches the variable or the database.
  const branch = await world({
    files: { "neon-owner-url": ownerUrl },
    git: { head: fakeSha("branch") },
  });
  try {
    let connected = false;
    branch.ctx.database = () => ({
      async connect() {
        connected = true;
        throw new StagingError("STAGING_DATABASE_UNAVAILABLE");
      },
    });
    const { code, result } = await branch.run(["migrate"]);
    assert.equal(code, 1);
    assert.equal(result.code, "STAGING_NOT_MAIN");
    assert.equal(connected, false);
    assert.equal(branch.fake.state.values.STAGING_SCHEMA_HEAD, head);
  } finally {
    branch.planted.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC05 (trimmed): ready:false fails the run with both api version ids; no rollback.
test("AC05: ready:false within 90 s fails the run, keeps both api version ids and rolls nothing back", async () => {
  const w = await world({ environment: ciEnvironment(), ready: false });
  try {
    const { code, result } = await w.run(["deploy", "--ci"]);
    assert.equal(code, 1);
    assert.equal(result.outcome, "failed");
    assert.equal(result.code, "STAGING_HEALTH_NOT_READY");
    assert.equal(result.rollback, "suspended_e11");
    assert.equal(result.next, "roll_forward_from_main_or_kill");
    assert.equal(result.versions.api.previous, fakeUuid(1));
    assert.match(result.versions.api.current, /^[0-9a-f-]{36}$/);
    assert.notEqual(result.versions.api.current, result.versions.api.previous);
    assert.equal(result.health.ready, false);
    assert.equal(result.health.last, "not_ready");
    assert.ok(result.health.waitedMs <= 90000 && result.health.polls >= 18);
    assert.ok(!wranglerCalls(w).some((c) => c.args.includes("rollback")));
    assert.equal(w.reports.at(-1).value.versions.api.previous, fakeUuid(1));
    assert.deepEqual(result.census.findings, [], "a health failure is censused too");
    assert.equal(commands.has("rollback"), false, "E11 is suspended: no rollback subcommand");
  } finally {
    w.planted.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC14 (fake runner): the kill wins both races; the hosted drill is deferred past launch.
test("AC14: a kill between gate 2 and the api deploy means no api deploy", async () => {
  for (const environment of [ciEnvironment(), {}]) {
    const w = await world({ environment });
    try {
      w.hooks.onDeploy = async (worker) => {
        if (worker === "connector") assert.equal(await main(["kill"], w.ctx), 0);
      };
      const { code, result } = await w.run(environment.ci ? ["deploy", "--ci"] : ["deploy"]);
      assert.equal(code, 1);
      assert.equal(result.code, "STAGING_KILLED");
      assert.equal(result.worker, "api");
      assert.equal(result.gates.flagBeforeConnector, "on");
      assert.equal(result.gates.flagBeforeApi, "off");
      assert.equal(result.versions.api.outcome, "not_deployed");
      assert.ok(!deployedWorkers(w).includes("api"));
      assert.equal(w.cloud.workersDev(scriptOf.api), false);
      assert.deepEqual(result.census.findings, []);
    } finally {
      w.planted.cleanup();
    }
  }
});

test("AC14: a kill during gate 5 or an earlier upload stops before the next upload", async () => {
  // Local and --first runs build for minutes after gate 2; the flag is read again before
  // the broker, so a kill during the build deploys nothing.
  const w = await world();
  try {
    w.ctx.gate5 = async () => assert.equal(await main(["kill"], w.ctx), 0);
    const { code, result } = await w.run(["deploy"]);
    assert.equal(code, 1);
    assert.equal(result.code, "STAGING_KILLED");
    assert.equal(result.worker, "broker");
    assert.equal(result.gates.flag, "on");
    assert.equal(result.gates.flagBeforeBroker, "off");
    for (const key of deployOrder) assert.equal(result.versions[key].outcome, "not_deployed");
    assert.deepEqual(deploys(w), []);
    assert.equal(result.census, null);
  } finally {
    w.planted.cleanup();
  }
  for (const environment of [ciEnvironment(), {}]) {
    const early = await world({ environment });
    try {
      early.hooks.onDeploy = async (worker) => {
        if (worker === "broker") assert.equal(await main(["kill"], early.ctx), 0);
      };
      const { code, result } = await early.run(environment.ci ? ["deploy", "--ci"] : ["deploy"]);
      assert.equal(code, 1);
      assert.equal(result.code, "STAGING_KILLED");
      assert.equal(result.worker, "orchestrator");
      assert.equal(result.versions.broker.outcome, "deployed");
      for (const key of ["orchestrator", "connector", "api"])
        assert.equal(result.versions[key].outcome, "not_deployed", key);
      assert.deepEqual(deployedWorkers(early), ["broker"]);
      assert.deepEqual(result.census.findings, []);
    } finally {
      early.planted.cleanup();
    }
  }
});

test("AC14: a kill during the api deploy means the post-check turns workers.dev off again", async () => {
  for (const environment of [ciEnvironment(), {}]) {
    const w = await world({ environment });
    try {
      w.hooks.onDeploy = async (worker) => {
        // The kill runs while the api upload is in flight; the upload then lands and
        // re-enables workers.dev, exactly the race the post-deploy re-read closes.
        if (worker === "api") assert.equal(await main(["kill"], w.ctx), 0);
      };
      const { code, result } = await w.run(environment.ci ? ["deploy", "--ci"] : ["deploy"]);
      assert.equal(code, 1);
      assert.equal(result.code, "STAGING_KILLED_DURING_DEPLOY");
      assert.equal(result.workersDev, "disabled");
      assert.equal(result.gates.flagBeforeApi, "on");
      assert.equal(result.gates.flagAfterApi, "off");
      assert.equal(w.cloud.workersDev(scriptOf.api), false);
      assert.equal(result.health, null, "no health check or smoke after a kill");
      assert.equal(result.smoke, null);
      assert.deepEqual(result.census.findings, [], "the read-only census still runs");
    } finally {
      w.planted.cleanup();
    }
  }
});

test("AC14: kill sets the flag to 0, disables the workflow, cancels queued and running deploys, turns workers.dev off and checks three times", async () => {
  const w = await world({
    gh: {
      runs: [
        { id: 11, status: "queued" },
        { id: 12, status: "in_progress" },
        { id: 13, status: "completed" },
        { id: 14, status: "waiting" },
      ],
    },
  });
  try {
    // The hostname comes back once (a cancelled upload landing late) before the 2-minute
    // check; the kill turns it off again.
    const sleep = w.ctx.sleep;
    w.ctx.sleep = async (ms) => {
      await sleep(ms);
      if (ms === 110000) w.cloud.deploy(scriptOf.api, fakeUuid(900), { workersDev: true });
    };
    const { code, result } = await w.run(["kill"]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.equal(w.fake.state.values.STAGING_DEPLOY_ENABLED, "0");
    assert.equal(w.fake.state.workflow, "disabled_manually");
    assert.deepEqual(
      w.fake.state.runs.map((r) => [r.id, r.status]),
      [
        [11, "completed"],
        [12, "completed"],
        [13, "completed"],
        [14, "completed"],
      ],
    );
    assert.equal(result.steps.runs.cancelled, 3);
    assert.equal(result.steps.workersDev.script, "disabled");
    assert.deepEqual(
      result.checks.map((c) => [c.at, c.serving, c.redisabled]),
      [
        ["now", false, false],
        ["after2m", true, true],
        ["after10m", false, false],
      ],
    );
    assert.deepEqual(
      w.sleeps,
      killChecks.map(([, ms]) => ms),
    );
    assert.equal(
      killChecks.reduce((sum, [, ms]) => sum + ms, 0),
      600000,
    );
    assert.equal(w.cloud.workersDev(scriptOf.api), false);
  } finally {
    w.planted.cleanup();
  }
});

test("AC14: kill needs no card, runs every step when one fails, and exits non-zero with the dashboard fallback", async () => {
  const w = await world({
    card: { ...approvedCard(), status: "proposed", approvedOn: null, expiresOn: null },
    tools: { fail: { gh: (args) => args[0] === "variable" } },
    cloudflare: { subdomainFails: true },
  });
  try {
    const { code, result } = await w.run(["kill"]);
    assert.equal(code, 1);
    assert.equal(result.steps.flag.ok, false);
    assert.equal(result.steps.flag.code, "STAGING_GH_FAILED");
    assert.equal(result.steps.workflow.ok, true);
    assert.equal(result.steps.runs.ok, true);
    assert.equal(result.steps.workersDev.ok, false);
    assert.equal(result.fallback, "dashboard_workers_dev_disable_and_github_workflow_disable");
    assert.equal(w.fake.state.workflow, "disabled_manually");
    assert.equal(result.checks.length, 3);
  } finally {
    w.planted.cleanup();
  }
});

test("AC14: unkill needs the card, and restores workers.dev, the workflow and the flag only when ready", async () => {
  const proposed = await world({
    card: { ...approvedCard(), status: "proposed", approvedOn: null, expiresOn: null },
  });
  try {
    assert.equal(await main(["kill"], proposed.ctx), 0);
    const { code, result } = await proposed.run(["unkill"]);
    assert.equal(code, 1);
    assert.equal(result.code, "STAGING_CARD_INACTIVE");
    assert.equal(proposed.fake.state.workflow, "disabled_manually");
  } finally {
    proposed.planted.cleanup();
  }
  const w = await world();
  try {
    assert.equal(await main(["kill"], w.ctx), 0);
    const { code, result } = await w.run(["unkill"]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.equal(w.cloud.workersDev(scriptOf.api), true);
    assert.equal(w.fake.state.workflow, "active");
    assert.equal(w.fake.state.values.STAGING_DEPLOY_ENABLED, "1");
    // After unkill the next CD deploy proceeds again.
    const again = await w.run(["deploy"]);
    assert.equal(again.result.outcome, "deployed");
  } finally {
    w.planted.cleanup();
  }
  const unready = await world({ ready: false });
  try {
    assert.equal(await main(["kill"], unready.ctx), 0);
    const { code, result } = await unready.run(["unkill"]);
    assert.equal(code, 1);
    assert.equal(result.code, "STAGING_UNKILL_NOT_READY");
    assert.equal(unready.cloud.workersDev(scriptOf.api), false);
    assert.equal(unready.fake.state.workflow, "disabled_manually");
    assert.equal(unready.fake.state.values.STAGING_DEPLOY_ENABLED, "0");
  } finally {
    unready.planted.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The CI step without the token: card, gate 1 and gate 2, and the step output.
test("ci-gates: proceed only for an active card, the main tip and an enabled flag; stops exit 0", async () => {
  for (const [label, options, proceed, reason] of [
    ["go", { environment: ciEnvironment() }, "true", null],
    [
      "superseded",
      { environment: ciEnvironment(), gh: { mainTip: fakeSha("newer") } },
      "false",
      "superseded",
    ],
    ["flag", { environment: ciEnvironment({ deployEnabled: "0" }) }, "false", "flag_off"],
    [
      "workflow",
      { environment: ciEnvironment(), gh: { workflow: "disabled_manually" } },
      "false",
      "flag_off",
    ],
    [
      "card",
      { environment: ciEnvironment(), card: approvedCard("2026-09-01") },
      "false",
      "card_inactive",
    ],
  ]) {
    const w = await world(options);
    try {
      const { code, result } = await w.run(["ci-gates"]);
      assert.equal(code, 0, label);
      assert.equal(w.outputs.proceed, proceed, label);
      assert.equal(result.reason, reason, label);
      assert.deepEqual(wranglerCalls(w), [], label);
    } finally {
      w.planted.cleanup();
    }
  }
  const failing = await world({ environment: ciEnvironment(), tools: { fail: { gh: true } } });
  try {
    const { code, result } = await failing.run(["ci-gates"]);
    assert.equal(code, 1);
    assert.equal(result.code, "STAGING_GH_FAILED");
    assert.equal(failing.outputs.proceed, "false");
  } finally {
    failing.planted.cleanup();
  }
  const local = await world();
  try {
    assert.equal((await local.run(["ci-gates"])).result.code, "STAGING_CI_ONLY");
  } finally {
    local.planted.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The first deploy (D2 `--first`, D9 step 10).
const firstFiles = () => ({
  "tmp/broker-secrets.json": JSON.stringify(
    Object.fromEntries(constants.brokerSecrets.map((n) => [n, "v-" + n.toLowerCase()])),
  ),
  "tmp/api-secrets.json": JSON.stringify({ LOGIN_CAPSULE_KEYRING: '{"keyring":"first"}' }),
});
test("first deploy: secret files go to the broker and the api by path, then are unlinked; the digest is published", async () => {
  const w = await world({
    scripts: [],
    files: firstFiles(),
    gh: { values: { STAGING_DEPLOY_ENABLED: "0" } },
  });
  // Before the first deploy the digest variable does not exist yet.
  delete w.fake.state.values.STAGING_LOGIN_CONFIGURATION_DIGEST;
  try {
    const { code, result } = await w.run(["deploy", "--first"]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.equal(result.outcome, "deployed");
    assert.equal(result.gates.flag, "first");
    assert.equal(result.gates.configuration, "keyring_bound");
    assert.equal(result.gates.digest, "published");
    const byWorker = Object.fromEntries(
      deploys(w).map((c) => [
        configWorker[c.args[c.args.indexOf("--config") + 1].split("/")[1]],
        c.args,
      ]),
    );
    assert.equal(byWorker.broker.at(-1), join(w.planted.directory, "tmp/broker-secrets.json"));
    assert.equal(byWorker.api.at(-1), join(w.planted.directory, "tmp/api-secrets.json"));
    assert.ok(!byWorker.orchestrator.includes("--secrets-file"));
    assert.ok(!byWorker.connector.includes("--secrets-file"));
    for (const call of deploys(w))
      assert.ok(!call.args.join(" ").includes("v-workos_api_key"), "values never reach argv");
    assert.equal(existsSync(join(w.planted.directory, "tmp/broker-secrets.json")), false);
    assert.equal(existsSync(join(w.planted.directory, "tmp/api-secrets.json")), false);
    assert.equal(w.fake.state.values.STAGING_LOGIN_CONFIGURATION_DIGEST, digest);
    assert.equal(w.fake.state.values.STAGING_DEPLOY_ENABLED, "0", "CD is turned on separately");
    const record = JSON.parse(
      readFileSync(join(w.planted.directory, "rotation-record.json"), "utf8"),
    );
    assert.equal(record.secrets.LOGIN_CAPSULE_KEYRING.versionId, result.versions.api.current);
    assert.equal(record.secrets.WORKOS_API_KEY.versionId, result.versions.broker.current);
    assert.equal(result.versions.api.previous, null);
  } finally {
    w.planted.cleanup();
  }
});

test("first deploy: the digest is published before any upload, so a failed publish can simply run again", async () => {
  let failing = true;
  const w = await world({
    scripts: [],
    files: firstFiles(),
    gh: { values: { STAGING_DEPLOY_ENABLED: "0" } },
    tools: { fail: { gh: (args) => failing && args[0] === "variable" && args[1] === "set" } },
  });
  delete w.fake.state.values.STAGING_LOGIN_CONFIGURATION_DIGEST;
  try {
    const first = await w.run(["deploy", "--first"]);
    assert.equal(first.code, 1);
    assert.equal(first.result.code, "STAGING_GH_FAILED");
    assert.deepEqual(deploys(w), [], "nothing is uploaded before the digest is published");
    assert.equal(first.result.census, null);
    assert.ok(existsSync(join(w.planted.directory, "tmp/broker-secrets.json")));
    assert.ok(existsSync(join(w.planted.directory, "tmp/api-secrets.json")));
    assert.equal(w.fake.state.values.STAGING_LOGIN_CONFIGURATION_DIGEST, undefined);
    failing = false;
    const again = await w.run(["deploy", "--first"]);
    assert.equal(again.code, 0, JSON.stringify(again.result));
    assert.equal(again.result.outcome, "deployed");
    assert.equal(w.fake.state.values.STAGING_LOGIN_CONFIGURATION_DIGEST, digest);
    const calls = w.fake.calls.map((c) => c.tool + " " + c.args.slice(0, 2).join(" "));
    assert.ok(
      calls.lastIndexOf("gh variable set") < calls.indexOf("wrangler deploy --config"),
      "published before the first upload",
    );
  } finally {
    w.planted.cleanup();
  }
});

test("first deploy: refuses an existing api, CD already on, a killed workflow, wrong files or an unbound keyring", async () => {
  const cases = [
    [
      "api exists",
      { files: firstFiles(), gh: { values: { STAGING_DEPLOY_ENABLED: "0" } } },
      "STAGING_FIRST_API_EXISTS",
    ],
    ["flag on", { scripts: [], files: firstFiles() }, "STAGING_FIRST_FLAG_ON"],
    [
      "killed",
      {
        scripts: [],
        files: firstFiles(),
        gh: { values: { STAGING_DEPLOY_ENABLED: "0" }, workflow: "disabled_manually" },
      },
      "STAGING_KILLED",
    ],
    [
      "broker file keys",
      {
        scripts: [],
        files: {
          ...firstFiles(),
          "tmp/broker-secrets.json": JSON.stringify({ WORKOS_API_KEY: "x" }),
        },
        gh: { values: { STAGING_DEPLOY_ENABLED: "0" } },
      },
      "STAGING_FILE_FORMAT",
    ],
    [
      "keyring",
      {
        scripts: [],
        files: firstFiles(),
        gh: { values: { STAGING_DEPLOY_ENABLED: "0" } },
        overrides: {
          checkKeyring: async () => {
            throw new StagingError("STAGING_KEYRING_INVALID");
          },
        },
      },
      "STAGING_KEYRING_INVALID",
    ],
  ];
  for (const [label, options, code] of cases) {
    const w = await world(options);
    try {
      const { code: exit, result } = await w.run(["deploy", "--first"]);
      assert.equal(exit, 1, label);
      assert.equal(result.code, code, label);
      assert.deepEqual(deploys(w), [], label);
      if (options.files?.["tmp/api-secrets.json"] && code !== "STAGING_FILE_FORMAT")
        assert.ok(existsSync(join(w.planted.directory, "tmp/api-secrets.json")), label);
    } finally {
      w.planted.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// D7: the unattended smoke.
test("smoke: the unattended checks pass on a healthy staging and record routing", async () => {
  const w = await world();
  try {
    const { code, result } = await w.run(["smoke"]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.deepEqual(result.failures, []);
    assert.equal(result.checks.health, "ready");
    assert.deepEqual(result.checks.spa, { status: 200, csp: true });
    assert.deepEqual(result.checks.routing, {
      navigate: 200,
      plain: 200,
      apiStatus: 404,
      apiJson: true,
    });
    assert.deepEqual(result.checks.guard, { configured: true, start: 403 });
    assert.equal(result.checks.databasePath, 401);
    assert.deepEqual(result.checks.others, {
      broker: { status: 404, json: false },
      orchestrator: { status: 404, json: false },
      connector: { status: 404, json: false },
    });
    assert.equal(result.checks.limiter, undefined);
    assert.equal(w.site.flowsCreated(), 0);
  } finally {
    w.planted.cleanup();
  }
});

test("smoke: no guard means no login start; failures name the check; --acceptance needs a 429", async () => {
  const unguarded = await world({ guard: false });
  try {
    const { code, result } = await unguarded.run(["smoke"]);
    assert.equal(code, 1);
    assert.deepEqual(result.failures, ["SMOKE_GUARD_ABSENT"]);
    assert.equal(unguarded.site.flowsCreated(), 0, "no login flow is started without the guard");
    assert.ok(!unguarded.site.requests.some((r) => r.path === "/auth/login"));
  } finally {
    unguarded.planted.cleanup();
  }
  const exposed = await world();
  try {
    const fetch = exposed.ctx.fetch;
    // An exposed broker or orchestrator answers every path as the real Workers do
    // (apps/broker/src/index.ts, apps/workers/src/orchestrator.ts): their own JSON 404.
    const workerNotFound = () =>
      new Response('{"code":"not_found"}', {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    exposed.ctx.fetch = async (url, init) => {
      const { host, pathname } = new URL(url);
      if (host.startsWith("morrow-staging-broker.")) return workerNotFound();
      if (host.startsWith("morrow-staging-orchestrator."))
        return new Response('{"code":"not_found"}', { status: 404 });
      if (host.startsWith("morrow-staging-api.") && pathname === "/")
        return new Response("", {
          status: 200,
          headers: { "content-security-policy": "default-src *" },
        });
      return fetch(url, init);
    };
    const { code, result } = await exposed.run(["smoke"]);
    assert.equal(code, 1);
    assert.deepEqual(result.failures.sort(), [
      "SMOKE_SPA",
      "SMOKE_WORKERS_DEV_EXPOSED_BROKER",
      "SMOKE_WORKERS_DEV_EXPOSED_ORCHESTRATOR",
    ]);
    assert.deepEqual(result.checks.others.broker, { status: 404, json: true });
    assert.deepEqual(result.checks.others.connector, { status: 404, json: false });
  } finally {
    exposed.planted.cleanup();
  }
  const acceptance = await world();
  try {
    const { code, result } = await acceptance.run(["smoke", "--acceptance"]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.equal(result.checks.limiter.sent, 11);
    assert.ok(result.checks.limiter.limited >= 1);
  } finally {
    acceptance.planted.cleanup();
  }
  const unlimited = await world();
  try {
    const fetch = unlimited.ctx.fetch;
    unlimited.ctx.fetch = async (url, init) => {
      const reply = await fetch(url, init);
      return reply.status === 429 ? new Response("{}", { status: 403 }) : reply;
    };
    const { code, result } = await unlimited.run(["smoke", "--acceptance"]);
    assert.equal(code, 1);
    assert.deepEqual(result.failures, ["SMOKE_LIMITER_ABSENT"]);
  } finally {
    unlimited.planted.cleanup();
  }
  const unset = await world({ staging: unsetStaging() });
  try {
    assert.equal((await unset.run(["smoke"])).result.code, "STAGING_IDENTIFIERS_UNSET");
  } finally {
    unset.planted.cleanup();
  }
});

// ---------------------------------------------------------------------------
// D7: the assisted smoke skeleton (card E8).
test("assisted smoke: cookie attributes are recorded without values", () => {
  const value = "A".repeat(42) + "E";
  const attributes = cookieAttributes(
    `__Host-morrow_session=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200`,
  );
  assert.deepEqual(attributes, {
    name: "__Host-morrow_session",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    domain: false,
    maxAge: 43200,
  });
  assert.ok(!JSON.stringify(attributes).includes(value));
  assert.equal(cookieAttributesOk(attributes), true);
  for (const header of [
    `__Host-morrow_session=${value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=60`,
    `__Host-morrow_session=${value}; Path=/; Secure; SameSite=Lax; Max-Age=60`,
    `__Host-morrow_session=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Domain=x.dev; Max-Age=60`,
    `__Host-morrow_session=${value}; Path=/a; Secure; HttpOnly; SameSite=Lax; Max-Age=60`,
  ])
    assert.equal(cookieAttributesOk(cookieAttributes(header)), false, header);
  assert.equal(cookieAttributes("other=1; Path=/"), null);
});

function fakeChromium({ replayStatus = 401 } = {}) {
  const value = "B".repeat(42) + "E";
  const record = { launches: [], contexts: [], closed: false, requests: [] };
  let session = null;
  let polls = 0;
  const page = {
    handlers: {},
    on(event, fn) {
      this.handlers[event] = fn;
    },
    async goto() {},
  };
  const setCookie = (header) =>
    page.handlers.response?.({
      url: () => origin + "/auth/workos/callback",
      headersArray: async () => [{ name: "Set-Cookie", value: header }],
    });
  const context = {
    async newPage() {
      return page;
    },
    async cookies() {
      polls++;
      if (polls === 3) {
        await setCookie(
          `__Host-morrow_login=${"L".repeat(42)}E; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
        );
        await setCookie(
          `__Host-morrow_session=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200`,
        );
        session = { name: "__Host-morrow_session", value };
      }
      if (polls === 6) session = null;
      return session ? [session] : [];
    },
    request: {
      async get(url, { headers }) {
        record.requests.push({ url, cookie: headers.Cookie ? "replayed" : "context" });
        const replay = headers.Cookie?.includes(value);
        return {
          status: () => (replay ? replayStatus : 200),
          text: async () =>
            replay ? "{}" : JSON.stringify({ onboarding: "available", workspaces: [] }),
        };
      },
    },
  };
  return {
    record,
    value,
    chromium: {
      async launch(options) {
        record.launches.push(options);
        return {
          async newContext(options) {
            record.contexts.push(options);
            return context;
          },
          async close() {
            record.closed = true;
          },
        };
      },
    },
  };
}

test("assisted smoke: a headed fresh profile, sign-in and sign-out by the owner, the old cookie refused", async () => {
  const fake = fakeChromium();
  const w = await world({
    overrides: { interactive: () => true, browser: async () => fake.chromium },
  });
  try {
    const { code, result } = await w.run(["smoke", "--assisted"]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.deepEqual(fake.record.launches, [{ headless: false }]);
    assert.deepEqual(assistedLaunchOptions, { headless: false });
    assert.deepEqual(fake.record.contexts, [{ ...assistedContextOptions }]);
    for (const key of ["recordHar", "recordVideo", "storageState"])
      assert.ok(!(key in fake.record.contexts[0]), key);
    assert.equal(fake.record.closed, true);
    assert.equal(result.signIn, "ok");
    assert.deepEqual(result.list, { status: 200, onboarding: "available" });
    assert.equal(result.signOut, "ok");
    assert.equal(result.oldCookieAfterSignOut, 401);
    assert.deepEqual(
      result.cookies.map((c) => [c.name, c.ok]),
      [
        ["__Host-morrow_login", true],
        ["__Host-morrow_session", true],
      ],
    );
    assert.equal(result.pending.length, 2);
    assert.ok(!w.out.join("\n").includes(fake.value));
    assert.ok(!w.notices.join("\n").includes(fake.value));
  } finally {
    w.planted.cleanup();
  }
  const accepted = fakeChromium({ replayStatus: 200 });
  const replayed = await world({
    overrides: { interactive: () => true, browser: async () => accepted.chromium },
  });
  try {
    const { code, result } = await replayed.run(["smoke", "--assisted"]);
    assert.equal(code, 1);
    assert.equal(result.oldCookieAfterSignOut, 200);
  } finally {
    replayed.planted.cleanup();
  }
  const headless = await world();
  try {
    assert.equal(
      (await headless.run(["smoke", "--assisted"])).result.code,
      "STAGING_ASSISTED_NEEDS_TERMINAL",
    );
  } finally {
    headless.planted.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The bring-up subcommands.
const files = () => ({
  "workos-api-key": "sk_test_" + "W".repeat(24),
  "turnstile-secret": "0x4AAAAAAA" + "t".repeat(26),
  "neon-owner-url": `postgresql://neondb_owner:${"o".repeat(24)}@ep-lab-runner-000001.us-east-1.aws.neon.tech/morrow?sslmode=require`,
  "neon-project-api-key": "napi_" + "n".repeat(48),
  "cloudflare-operator-token": "R".repeat(40),
  // M2 PR-1: the owner's vault KEK (`npm run vault -- kek`).
  "vault-kek-v1": "5eed".repeat(16),
  // M5 PR-1: the owner's Stripe restricted test key and webhook signing secret (read only
  // while the Stripe switch is on).
  "stripe-restricted-key": "rk_test_" + "K".repeat(32),
  "stripe-webhook-secret": "whsec_" + "H".repeat(32),
});
test("preflight: reports pending owner steps without values and blocks on the card or a tool pin", async () => {
  const w = await world({ files: files() });
  try {
    const { code, result } = await w.run(["preflight"]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.deepEqual(result.blocking, []);
    assert.ok(result.pending.includes("identifier:rootBranchId"));
    assert.ok(!result.pending.includes("identifier:challenge"));
    assert.ok(!result.pending.some((p) => p.startsWith("file:")));
    assert.deepEqual(result.tools.wrangler, { pinned: "4.116.0", installed: "4.116.0" });
    assert.equal(result.tools.neonctl.installed, result.tools.neonctl.pinned);
    assert.equal(result.git.clean, true);
    assert.equal(result.card.active, true);
    const text = w.out.join("\n");
    for (const value of Object.values(files())) assert.ok(!text.includes(value));
  } finally {
    w.planted.cleanup();
  }
  // P05.T01ab: without the broker's TURNSTILE_CONFIGURATION_JSON (a PR-D identifier) the
  // challenge configuration is a pending owner step, not a blocker.
  const unset = await world({ files: files(), challengeVars: { broker: null } });
  try {
    const { code, result } = await unset.run(["preflight"]);
    assert.equal(code, 0);
    assert.ok(result.pending.includes("identifier:challenge"));
  } finally {
    unset.planted.cleanup();
  }
  // P04.T01i PR-D part 1: with the committed configuration every identifier is set,
  // the binding and the challenge included, so none is pending.
  const committed = await world({
    files: files(),
    overrides: {
      config: async () =>
        (await import("../scripts/staging.mjs")).loadStagingConfiguration(process.cwd()),
    },
  });
  try {
    const { code, result } = await committed.run(["preflight"]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.ok(
      Object.values(result.identifiers).every((set) => set === true),
      result.identifiers,
    );
    assert.deepEqual(Object.keys(result.identifiers).sort(), [
      "accountId",
      "binding",
      "branchId",
      "challenge",
      "origin",
      "projectId",
      "regionId",
      "rootBranchId",
      "workersDevSubdomain",
    ]);
    assert.ok(!result.pending.some((p) => p.startsWith("identifier:")));
  } finally {
    committed.planted.cleanup();
  }
  // M2 PR-1: until the owner writes the vault KEK file, it is a pending owner step.
  const { "vault-kek-v1": _kek, ...withoutKek } = files();
  const noKek = await world({ files: withoutKek });
  try {
    const { code, result } = await noKek.run(["preflight"]);
    assert.equal(code, 0);
    assert.deepEqual(
      result.pending.filter((p) => p.startsWith("file:")),
      ["file:vault-kek-v1"],
    );
  } finally {
    noKek.planted.cleanup();
  }
  const blocked = await world({
    card: { ...approvedCard(), status: "proposed", approvedOn: null, expiresOn: null },
    tools: { fail: { gh: (args) => args[0] === "auth" } },
  });
  try {
    const { code, result } = await blocked.run(["preflight"]);
    assert.equal(code, 1);
    assert.ok(result.blocking.includes("card:proposed"));
    assert.ok(result.blocking.includes("tool:gh"));
    assert.ok(result.pending.includes("file:workos-api-key"));
  } finally {
    blocked.planted.cleanup();
  }
});

test("status: the flag, the last deploy, the deployed versions, workers.dev and health, all closed", async () => {
  const w = await world({
    gh: {
      runs: [{ id: 7, status: "completed", conclusion: "success", head_sha: fakeSha("main") }],
    },
  });
  try {
    const { code, result } = await w.run(["status"]);
    assert.equal(code, 0);
    assert.deepEqual(result.flag, { value: "1", workflow: "active" });
    assert.deepEqual(result.lastDeploy, {
      id: 7,
      status: "completed",
      conclusion: "success",
      sha: fakeSha("main"),
    });
    assert.deepEqual(result.schema, { committed: head, matches: true });
    assert.equal(result.workers.api.versionId, fakeUuid(1));
    assert.equal(result.workers.api.workersDev, "enabled");
    assert.equal(result.health, "ready");
    assert.deepEqual(result.problems, []);
  } finally {
    w.planted.cleanup();
  }
});

test("queues: creates only the missing staging queues, reconciles a lost reply, and needs the card", async () => {
  const w = await world({
    cloudflare: { queues: [{ queue_name: "morrow-staging-dispatch-dlq" }] },
  });
  try {
    const { code, result } = await w.run(["queues"]);
    assert.equal(code, 0);
    assert.deepEqual(result.queues, [
      { name: "morrow-staging-dispatch-dlq", state: "present" },
      { name: "morrow-staging-dispatch", state: "created" },
    ]);
    assert.deepEqual(
      w.cloud.calls.filter((c) => c.startsWith("POST")),
      ["POST queues"],
    );
  } finally {
    w.planted.cleanup();
  }
  const lost = await world({ cloudflare: { queueCreate: () => "lost" } });
  try {
    const { code, result } = await lost.run(["queues"]);
    assert.equal(code, 0);
    assert.deepEqual(
      result.queues.map((q) => q.state),
      ["created", "created"],
    );
  } finally {
    lost.planted.cleanup();
  }
  const failed = await world({ cloudflare: { queueCreate: () => "fail" } });
  try {
    const { code, result } = await failed.run(["queues"]);
    assert.equal(code, 1);
    assert.equal(result.code, "STAGING_QUEUE_CREATE_FAILED");
  } finally {
    failed.planted.cleanup();
  }
  const proposed = await world({
    card: { ...approvedCard(), status: "proposed", approvedOn: null, expiresOn: null },
  });
  try {
    assert.equal((await proposed.run(["queues"])).result.code, "STAGING_CARD_INACTIVE");
    assert.deepEqual(proposed.cloud.calls, []);
  } finally {
    proposed.planted.cleanup();
  }
});

test("turnstile-create: the secret goes only to a new 0600 file; the site key is the only output", async () => {
  const secret = "0x4AAAAAAA" + "q".repeat(24);
  const w = await world({
    cloudflare: { widgetReply: { sitekey: "0x4AAAAAAA" + "K".repeat(14), secret } },
  });
  try {
    const { code, result } = await w.run(["turnstile-create"]);
    assert.equal(code, 0, JSON.stringify(result));
    assert.deepEqual(result, {
      command: "turnstile-create",
      widget: "morrow-staging",
      siteKey: "0x4AAAAAAA" + "K".repeat(14),
      hostname: "morrow-staging-api.lab.workers.dev",
      mode: "invisible",
      file: "turnstile-secret",
    });
    const path = join(w.planted.directory, "turnstile-secret");
    assert.equal(readFileSync(path, "utf8"), secret);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!w.out.join("\n").includes(secret));
    assert.deepEqual(w.cloud.widgets[0].domains, ["morrow-staging-api.lab.workers.dev"]);
    const record = JSON.parse(
      readFileSync(join(w.planted.directory, "rotation-record.json"), "utf8"),
    );
    assert.equal(record.secrets.TURNSTILE_SECRET_KEY.worker, "broker");
    // A second run stops at the existing file, before any API call.
    const calls = w.cloud.calls.length;
    assert.equal((await w.run(["turnstile-create"])).result.code, "STAGING_FILE_EXISTS");
    assert.equal(w.cloud.calls.length, calls);
  } finally {
    w.planted.cleanup();
  }
  for (const [label, cloudflare, code] of [
    ["exists", { widgets: [{ name: "morrow-staging" }] }, "STAGING_TURNSTILE_WIDGET_EXISTS"],
    ["lost", { widgetCreate: "lost" }, "STAGING_TURNSTILE_SECRET_LOST"],
    ["failed", { widgetCreate: "fail" }, "STAGING_TURNSTILE_CREATE_FAILED"],
  ]) {
    const v = await world({ cloudflare });
    try {
      const { code: exit, result } = await v.run(["turnstile-create"]);
      assert.equal(exit, 1, label);
      assert.equal(result.code, code, label);
      assert.equal(existsSync(join(v.planted.directory, "turnstile-secret")), false, label);
    } finally {
      v.planted.cleanup();
    }
  }
});

// 2026-10-20 (docs/evidence/live/2026-10-20-cloudflare-turnstile-widget.md): a refused
// create names Cloudflare's HTTP status and numeric codes only, after the widget list shows
// no widget; any other detail of the refusal, and Cloudflare's messages, stay out.
test("turnstile-create: a refused create reports Cloudflare's status and numeric codes only", async () => {
  const refused = await world({ cloudflare: { widgetCreate: "refuse" } });
  try {
    const { code, result } = await refused.run(["turnstile-create"]);
    assert.equal(code, 1);
    assert.deepEqual(result, {
      command: "turnstile-create",
      code: "STAGING_TURNSTILE_CREATE_FAILED",
      status: 403,
      codes: [10000],
    });
    assert.ok(!refused.err.join("\n").includes("relayed_detail"));
    // The create, then the reconciling list that found no widget.
    assert.deepEqual(refused.cloud.calls.slice(-2), [
      "POST challenges/widgets",
      "challenges/widgets",
    ]);
    assert.equal(existsSync(join(refused.planted.directory, "turnstile-secret")), false);
  } finally {
    refused.planted.cleanup();
  }
  // A failure that is not a Cloudflare refusal has neither a status nor codes.
  const unavailable = await world({ cloudflare: { widgetCreate: "fail" } });
  try {
    const { result } = await unavailable.run(["turnstile-create"]);
    assert.deepEqual(result, {
      command: "turnstile-create",
      code: "STAGING_TURNSTILE_CREATE_FAILED",
      status: null,
      codes: [],
    });
  } finally {
    unavailable.planted.cleanup();
  }
});

// neon-probe: a fake neonctl and a scripted probe connection.
const probeStaging = () => {
  const base = JSON.parse(readFileSync("infra/environments/staging.json", "utf8"));
  return {
    ...base,
    cloudflare: {
      ...base.cloudflare,
      account_id: accountId,
      workers_dev_subdomain: "lab",
      origin,
    },
    neon: {
      ...base.neon,
      project_id: "lab-project-runner",
      root_branch_id: "br-root-000001",
      branch_id: "br-lab-runner-000001",
    },
  };
};
// `verifier`: "accepted", "refused" (another refusal) or "neon" (Neon's control-plane
// refusal, as measured 2026-10-20); `stats` overrides the statement-statistics row of the
// binding's database (`morrow` on the probe branch) and `scratchStats` that of `neondb`;
// `plaintext`: "accepted" or "refused"; `readable`: pg_authid readable, with SCRAM rows,
// or "error"; `target`: "unavailable" fails the connection to `morrow`; `residue`: entries
// left after the reset; `cleanup`: "error" fails the role's NOLOGIN cleanup.
const quietLogging = {
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
};
const neonModule = { track: "top", track_utility: "on" };
function probeWorld({
  revoke = "warning",
  verifier = "accepted",
  createFails = false,
  stats = {},
  scratchStats = {},
  plaintext = "accepted",
  readable = false,
  target = "connected",
  residue = 0,
  cleanup = "done",
} = {}) {
  const password = "probepw" + "x".repeat(20);
  const statements = [];
  const scratch = { extension: false, created: 0, dropped: 0 };
  const neonctl = (args) => {
    if (args[0] === "branches" && args[1] === "create") {
      if (createFails) return null;
      const name = args[args.indexOf("--name") + 1];
      return {
        status: 0,
        stdout: JSON.stringify({
          branch: { id: "br-probe-000001", name },
          endpoints: [{ host: "ep-probe-000001.us-east-1.aws.neon.tech" }],
        }),
        stderr: "",
      };
    }
    if (args[0] === "branches" && args[1] === "list")
      return { status: 0, stdout: JSON.stringify([]), stderr: "" };
    if (args[0] === "connection-string")
      return {
        status: 0,
        stdout: `postgresql://neondb_owner:${password}@ep-probe-000001.us-east-1.aws.neon.tech/neondb?sslmode=require\n`,
        stderr: "",
      };
    if (args[0] === "branches" && args[1] === "reset")
      return { status: 0, stdout: "{}", stderr: "" };
    if (args[0] === "branches" && args[1] === "get")
      return {
        status: 0,
        stdout: JSON.stringify({ branch: { id: "br-probe-000001" } }),
        stderr: "",
      };
    return null;
  };
  const connectProbe = async (url) => {
    const database = url.database;
    statements.push({ connect: url.host, database });
    if (database === "morrow" && target === "unavailable") throw Error("no such database");
    return {
      async query(text, params = []) {
        statements.push({ text, params, database });
        if (/session_user::text AS session_role/.test(text))
          return [
            {
              session_role: "neondb_owner",
              current_role: "neondb_owner",
              database,
              version: 170011,
              superuser: false,
              createrole: true,
              login: true,
            },
          ];
        if (/pg_auth_members/.test(text))
          return [
            {
              admin: true,
              inherit: false,
              set: false,
              grantor: "cloud_admin",
              grantor_superuser: true,
            },
          ];
        if (/AS extension, current_setting/.test(text))
          return [
            database === "morrow"
              ? { extension: false, track: null, track_utility: null, ...quietLogging, ...stats }
              : {
                  extension: scratch.extension,
                  track: stats.track ?? null,
                  track_utility: stats.track_utility ?? null,
                  ...quietLogging,
                  ...scratchStats,
                },
          ];
        if (/FROM pg_catalog\.pg_database WHERE datname/.test(text)) return [{ present: true }];
        if (/pg_catalog\.pg_extension e JOIN/.test(text))
          return scratch.extension ? [{ schema: "public" }] : [];
        if (/clock_timestamp/.test(text)) return [{ before: "2026-10-20 19:00:00.000001+00" }];
        if (/pg_stat_statements_reset/.test(text)) return [{ reset: "x" }];
        if (/pg_stat_statements_info/.test(text))
          return [{ full_reset: true, same_instance: true, remaining: residue }];
        if (/ AS instance$/.test(text)) return [{ instance: "1792526146.012127/10.0.0.1/5432" }];
        if (/^SELECT EXISTS \(SELECT 1 FROM pg_catalog\.pg_extension/.test(text))
          return [
            { extension: database === "morrow" ? stats.extension === true : scratch.extension },
          ];
        if (/has_table_privilege/.test(text)) {
          if (readable === "error") throw Error("permission denied " + password);
          return [{ readable }];
        }
        if (/FROM pg_catalog\.pg_authid/.test(text)) return [{ n: 1 }];
        if (/count\(\*\)::int AS n/.test(text)) return [{ n: 0 }];
        return [];
      },
      async exec(text) {
        statements.push({ text, database });
        if (/^REVOKE/.test(text) && revoke === "error") {
          const error = Error("must have admin option");
          error.code = "42501";
          throw error;
        }
        if (/PASSWORD 'SCRAM/.test(text) && verifier === "refused") {
          const error = Error("password is too weak " + password);
          error.code = "22023";
          throw error;
        }
        if (/PASSWORD 'SCRAM/.test(text) && verifier === "neon") {
          // Neon's reply text, which carries a request body: reduced to a fixed reason.
          const error = Error(
            'Received HTTP code 400 from control plane: {"request_id":"' +
              password +
              '","error":"Neon only supports being given plaintext passwords"}',
          );
          error.code = "XX000";
          throw error;
        }
        if (/PASSWORD '[A-Za-z0-9_-]{43}'$/.test(text) && plaintext === "refused") {
          const error = Error("control plane said no " + password);
          error.code = "XX000";
          throw error;
        }
        if (/NOLOGIN PASSWORD NULL$/.test(text) && cleanup === "error") {
          const error = Error("cleanup refused " + password);
          error.code = "XX000";
          throw error;
        }
        if (text === "CREATE EXTENSION pg_stat_statements") {
          scratch.extension = true;
          scratch.created++;
        }
        if (text === "DROP EXTENSION pg_stat_statements") {
          scratch.extension = false;
          scratch.dropped++;
        }
      },
      async close() {},
    };
  };
  return { password, statements, scratch, neonctl, connectProbe };
}
const probeRun = async (options) => {
  const probe = probeWorld(options);
  const w = await world({
    staging: probeStaging(),
    tools: { neonctl: probe.neonctl },
    overrides: { probeDatabase: probe.connectProbe },
  });
  try {
    const { code, result } = await w.run(["neon-probe"]);
    return { probe, w, code, result, out: w.out.join("\n") };
  } finally {
    w.planted.cleanup();
  }
};
const plaintextStatement =
  /^ALTER ROLE morrow_probe_[0-9a-f]{8} WITH LOGIN PASSWORD '[A-Za-z0-9_-]{43}'$/;
test("neon-probe: M-N1, M-N3 and M-N4 on a fresh expiring child of the root, never another branch", async () => {
  const { probe, w, code, result, out } = await probeRun();
  assert.equal(code, 0, JSON.stringify(result));
  const create = w.fake.calls.find((c) => c.tool === "neonctl" && c.args[1] === "create").args;
  assert.equal(create[create.indexOf("--parent") + 1], "br-root-000001");
  assert.equal(create[create.indexOf("--project-id") + 1], "lab-project-runner");
  assert.ok(create.includes("--no-secrets"));
  assert.match(create[create.indexOf("--name") + 1], /^morrow-probe-[0-9a-f]{8}$/);
  assert.equal(Date.parse(create[create.indexOf("--expires-at") + 1]) - w.ctx.now(), 2 * 3600000);
  // Only the created branch is reset; the root and the bound branch are never named.
  const reset = w.fake.calls.find((c) => c.tool === "neonctl" && c.args[1] === "reset").args;
  assert.equal(reset[2], "br-probe-000001");
  for (const call of w.fake.calls.filter((c) => c.tool === "neonctl")) {
    assert.ok(!call.args.includes("br-lab-runner-000001"), call.args.join(" "));
    if (call.args.includes("br-root-000001"))
      assert.equal(call.args[call.args.indexOf("br-root-000001") - 1], "--parent");
  }
  assert.deepEqual(result.mN1, {
    selfGrantRow: { admin: true, inherit: false, set: false },
    grantor: "cloud_admin",
    grantorSuperuser: true,
    revokeRefused: true,
    revokeSqlstate: null,
  });
  assert.deepEqual(result.mN3, {
    verifierAccepted: true,
    verifierSqlstate: null,
    verifierRefusal: null,
    target: "connected",
    statementStats: {
      checked: true,
      extension: false,
      module: false,
      track: null,
      trackUtility: null,
      recording: false,
    },
    passwordEncryption: "scram-sha-256",
    logging: {
      logStatement: "none",
      logMinDurationStatement: "disabled",
      logMinDurationSample: "disabled",
      logStatementSampleRate: "1",
      logMinErrorStatement: "panic",
      logDuration: "off",
      debugPrintParse: "off",
      debugPrintRewritten: "off",
      debugPrintPlan: "off",
    },
    refusal: null,
    plaintextSent: true,
    plaintextAccepted: true,
    plaintextSqlstate: null,
    storedForm: "unreadable",
    wipe: null,
    targetExtension: false,
    roleCleanup: { done: true, sqlstate: null },
  });
  assert.deepEqual(result.mN4, {
    branchIdKept: true,
    hostKept: true,
    rolesDropped: true,
    expirySupported: true,
  });
  assert.equal(result.cleanup, "branch_expires_at");
  const sent = JSON.stringify(probe.statements);
  assert.ok(!sent.includes(probe.password));
  // The verifier in neondb; then, in the binding's database, the facts and one generated
  // plaintext; then none.
  const texts = probe.statements.map((s) => s.text ?? "");
  const verifierAt = texts.findIndex((t) => /PASSWORD 'SCRAM-SHA-256\$4096:/.test(t));
  const statsAt = texts.findIndex((t) => /AS extension, current_setting/.test(t));
  const plain = probe.statements.filter((s) => plaintextStatement.test(s.text ?? ""));
  assert.equal(plain.length, 1);
  assert.equal(probe.statements[verifierAt].database, "neondb");
  assert.equal(probe.statements[statsAt].database, "morrow");
  assert.equal(plain[0].database, "morrow");
  assert.ok(verifierAt >= 0 && verifierAt < statsAt && statsAt < texts.indexOf(plain[0].text));
  assert.match(texts.filter((t) => /^ALTER ROLE/.test(t)).at(-1), /WITH NOLOGIN PASSWORD NULL$/);
  // No module loaded: no scratch session, no extension statement.
  assert.ok(!texts.some((t) => /EXTENSION|pg_stat_statements_reset/.test(t)));
  const generated = /'([A-Za-z0-9_-]{43})'$/.exec(plain[0].text)[1];
  assert.ok(!out.includes(probe.password));
  assert.ok(!out.includes(generated));
});

// Neon's staging shape, measured 2026-10-20: the verifier refused through the control
// plane, the plaintext accepted, and pg_stat_statements preloaded with utility tracking.
// The probe wipes from neondb exactly as provision-roles does; the binding's database
// never gains the extension; the reply's text and the plaintext never reach the report.
test("neon-probe: on Neon's shape, the plaintext, the wipe from neondb and the verification", async () => {
  const { probe, code, result, out } = await probeRun({
    verifier: "neon",
    readable: true,
    stats: neonModule,
  });
  assert.equal(code, 0);
  assert.equal(result.mN3.verifierAccepted, false);
  assert.equal(result.mN3.verifierSqlstate, "XX000");
  assert.equal(result.mN3.verifierRefusal, "neon_plaintext_only");
  assert.deepEqual(result.mN3.statementStats, {
    checked: true,
    extension: false,
    module: true,
    track: "top",
    trackUtility: "on",
    recording: true,
  });
  assert.equal(result.mN3.refusal, null);
  assert.equal(result.mN3.plaintextAccepted, true);
  assert.equal(result.mN3.storedForm, "SCRAM-SHA-256");
  assert.deepEqual(result.mN3.wipe, { wiped: true, entriesRemaining: 0 });
  assert.equal(result.mN3.targetExtension, false);
  assert.deepEqual([probe.scratch.created, probe.scratch.dropped], [1, 1]);
  assert.ok(
    probe.statements
      .filter((s) => /EXTENSION|pg_stat_statements_/.test(s.text ?? ""))
      .every((s) => s.database === "neondb"),
  );
  // The plaintext: once, in its ALTER ROLE (morrow). The verification in neondb carries
  // only its SHA-256 digest and the instance read before the plaintext was sent.
  const plain = probe.statements.find((s) => plaintextStatement.test(s.text ?? ""));
  const generated = /'([A-Za-z0-9_-]{43})'$/.exec(plain.text)[1];
  const carrying = probe.statements.filter((s) =>
    ((s.text ?? "") + JSON.stringify(s.params ?? [])).includes(generated),
  );
  assert.deepEqual(carrying, [plain]);
  const verify = probe.statements.find((s) => /pg_stat_statements_info/.test(s.text ?? ""));
  assert.equal(verify.database, "neondb");
  assert.deepEqual(JSON.parse(verify.params[1]), [
    createHash("sha256").update(generated).digest("hex"),
  ]);
  assert.equal(verify.params[2], "1792526146.012127/10.0.0.1/5432");
  assert.ok(probe.statements.indexOf(plain) < probe.statements.indexOf(verify));
  const instanceReads = probe.statements.filter((s) => / AS instance$/.test(s.text ?? ""));
  assert.deepEqual(
    instanceReads.map((s) => s.database),
    ["morrow", "neondb"],
  );
  assert.ok(probe.statements.indexOf(instanceReads[1]) < probe.statements.indexOf(plain));
  for (const value of [
    probe.password,
    generated,
    "control plane",
    "request_id",
    "plaintext passwords",
  ])
    assert.ok(!out.includes(value), value);
});

test("neon-probe: refusals send no plaintext, and failures after it keep what was measured", async () => {
  // The provisioning gate refuses: the plaintext is never sent, and the record says why.
  for (const [options, refusal] of [
    [
      { stats: { extension: true } },
      {
        code: "STAGING_STATEMENT_STATS_PRESENT",
        reason: "extension",
        extension: true,
        module: false,
      },
    ],
    [
      { stats: { log_statement: "ddl" } },
      { code: "STAGING_STATEMENT_LOGGING", reason: "log_statement", database: "binding" },
    ],
    [
      { stats: neonModule, scratchStats: { log_min_error_statement: "error" } },
      { code: "STAGING_STATEMENT_LOGGING", reason: "log_min_error_statement", database: "scratch" },
    ],
    [
      { stats: { debug_print_parse: "on" } },
      { code: "STAGING_STATEMENT_LOGGING", reason: "debug_print_parse", database: "binding" },
    ],
    [{ stats: { password_encryption: "md5" } }, { code: "STAGING_PASSWORD_ENCRYPTION" }],
  ]) {
    const { probe, code, result } = await probeRun({ verifier: "neon", ...options });
    const name = JSON.stringify(options);
    assert.equal(code, 0, name);
    assert.deepEqual(result.mN3.refusal, refusal, name);
    assert.equal(result.mN3.plaintextSent, false, name);
    assert.equal(result.mN3.plaintextAccepted, null, name);
    assert.ok(
      !probe.statements.some((s) => /PASSWORD '[A-Za-z0-9_-]{43}'$/.test(s.text ?? "")),
      name,
    );
    assert.deepEqual(result.mN3.roleCleanup, { done: true, sqlstate: null }, name);
  }
  // The binding's database is not on the probe branch: nothing is sent, M-N1 is kept.
  const absent = await probeRun({ target: "unavailable" });
  assert.equal(absent.code, 0);
  assert.equal(absent.result.mN3.target, "unavailable");
  assert.equal(absent.result.mN3.plaintextSent, false);
  assert.equal(absent.result.mN1.grantor, "cloud_admin");
  // A residue after the wipe, a failing stored-form read and a failing role cleanup are
  // recorded; M-N1, M-N3 and M-N4 survive, and the exit is 0.
  const kept = await probeRun({
    verifier: "neon",
    stats: neonModule,
    residue: 1,
    readable: "error",
    cleanup: "error",
  });
  assert.equal(kept.code, 0, JSON.stringify(kept.result));
  assert.deepEqual(kept.result.mN3.wipe, {
    wiped: false,
    code: "STAGING_STATEMENT_STATS_RESIDUE",
    stage: "verify",
    entriesRemaining: 1,
    fullReset: true,
    sameInstance: true,
  });
  assert.equal(kept.result.mN3.storedForm, "error");
  assert.deepEqual(kept.result.mN3.roleCleanup, { done: false, sqlstate: "XX000" });
  assert.equal(kept.result.mN3.plaintextAccepted, true);
  assert.equal(kept.result.mN1.grantor, "cloud_admin");
  assert.equal(kept.result.mN4.rolesDropped, true);
  assert.deepEqual([kept.probe.scratch.created, kept.probe.scratch.dropped], [1, 1]);
  assert.ok(!kept.out.includes(kept.probe.password));

  const refused = await probeRun({ revoke: "error", verifier: "refused" });
  assert.equal(refused.code, 0);
  assert.equal(refused.result.mN1.revokeSqlstate, "42501");
  assert.equal(refused.result.mN3.verifierAccepted, false);
  assert.equal(refused.result.mN3.verifierSqlstate, "22023");
  assert.equal(refused.result.mN3.verifierRefusal, "other");
  assert.ok(!refused.out.includes(refused.probe.password));

  const plaintextRefused = await probeRun({ verifier: "neon", plaintext: "refused" });
  assert.equal(plaintextRefused.code, 0);
  assert.equal(plaintextRefused.result.mN3.plaintextSent, true);
  assert.equal(plaintextRefused.result.mN3.plaintextAccepted, false);
  assert.equal(plaintextRefused.result.mN3.plaintextSqlstate, "XX000");
  assert.equal(plaintextRefused.result.mN3.storedForm, null);
  assert.ok(!plaintextRefused.out.includes(plaintextRefused.probe.password));

  const failed = probeWorld({ createFails: true });
  const f = await world({
    staging: probeStaging(),
    tools: { neonctl: failed.neonctl, fail: { neonctl: (args) => args[1] === "create" } },
  });
  try {
    const { code, result } = await f.run(["neon-probe"]);
    assert.equal(code, 1);
    assert.equal(result.code, "STAGING_NEON_PROBE_CREATE_FAILED");
    assert.equal(result.branch, "absent");
  } finally {
    f.planted.cleanup();
  }
  const unset = await world({ staging: unsetStaging() });
  try {
    assert.equal((await unset.run(["neon-probe"])).result.code, "STAGING_IDENTIFIERS_UNSET");
  } finally {
    unset.planted.cleanup();
  }
});

test("cli: the trimmed PR-B's subcommands, and nothing for rollback, rotation drills or the keyring deploy", () => {
  assert.deepEqual([...commands.keys()].sort(), [
    // M5 PR-1 (review): the operator path for a held customer operation.
    "billing-customer-resolve",
    "census",
    "ci-gates",
    "connections",
    "deploy",
    "keyring",
    "kill",
    "migrate",
    "neon-probe",
    // M3 PR-1: the owner-run platform stop (tests/platform-stop.test.mjs).
    "platform-stop",
    "preflight",
    "provision-roles",
    "put-secret",
    "queues",
    "schema-head",
    "secrets-status",
    "seed-platform",
    "smoke",
    "status",
    // The staging test entitlement (owner decision (b), 2026-10-21; card E13).
    "test-entitlement",
    "turnstile-create",
    "unkill",
  ]);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  for (const name of commands.keys())
    assert.equal(pkg.scripts["staging:" + name], "node scripts/staging.mjs " + name, name);
  // The deploy workflow file names the two CI subcommands only.
  const workflow = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
  assert.deepEqual(
    [...workflow.matchAll(/node scripts\/staging\.mjs ([a-z-]+)/g)].map((m) => m[1]),
    ["ci-gates", "deploy"],
  );
});

// D9 step 4 (c)-(e): every neonctl command the owner runs exists, with those options, in
// the CLI that package.json pins (neonctl 8.8.0 is a shim for `neon` 8.8.0). Read from the
// installed sources only; the CLI is never run, so nothing reaches Neon.
test("D9: the owner's neonctl commands exist in the pinned Neon CLI, read without running it", () => {
  const packet = readFileSync("docs/packets/P04.T01i.md", "utf8");
  const commands = [
    ...packet.matchAll(/npx --no-install neonctl ([a-z-]+(?: [a-z-]+)?)([^`)>]*)/g),
  ];
  const pins = JSON.parse(readFileSync("package.json", "utf8")).devDependencies;
  assert.equal(pins.neonctl, "8.8.0");
  const shim = JSON.parse(readFileSync("node_modules/neonctl/package.json", "utf8"));
  assert.equal(shim.version, "8.8.0");
  assert.equal(shim.dependencies.neon, "8.8.0");
  assert.equal(JSON.parse(readFileSync("node_modules/neon/package.json", "utf8")).version, "8.8.0");
  const source = (file) => readFileSync(join("node_modules/neon/dist/commands", file), "utf8");
  // Each D9 command: its source file, the text that defines the (sub)command, its options.
  const definitions = {
    auth: ["auth.js", ['const command = "login"', 'const aliases = ["auth"]']],
    "databases create": ["databases.js", ['const command = "databases"', '.command("create"']],
    "branches create": ["branches.js", ['const command = "branches"', '.command("create"']],
    "connection-string staging": [
      "connection_string.js",
      ['const command = "connection-string [branch]"'],
    ],
  };
  const seen = new Set();
  for (const [, name, rest] of commands) {
    const key = name.startsWith("connection-string") ? "connection-string staging" : name;
    assert.ok(Object.hasOwn(definitions, key), "unknown D9 neonctl command: " + name);
    seen.add(key);
    const [file, defining] = definitions[key];
    const text = source(file);
    for (const piece of defining) assert.ok(text.includes(piece), `${key}: ${piece}`);
    for (const [, option] of rest.matchAll(/--([a-z-]+)/g))
      assert.ok(
        text.includes(`"${option}":`) || new RegExp(`[\\s{,]${option}: `).test(text),
        `${key}: --${option}`,
      );
  }
  assert.deepEqual([...seen].sort(), Object.keys(definitions).sort());
  // connection-string defaults to the direct (unpooled) host with sslmode=require, which
  // the runner's owner-URL grammar requires.
  const cs = source("connection_string.js");
  assert.match(cs, /pooled: \{\s+type: "boolean",[^}]*default: false/);
  assert.match(cs, /ssl: \{[^}]*default: "require"/);
});
