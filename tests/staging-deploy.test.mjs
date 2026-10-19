// P04.T01i PR-B, trimmed by ADR-0021: the deploy (AC03 gate steps, AC04 gates, AC05
// health without rollback), the kill switch and unkill (AC14, fake runner), the
// unattended and assisted smokes (D7), and the bring-up subcommands (preflight, status,
// neon-probe, queues, turnstile-create). Everything runs over fake wrangler, gh, neonctl,
// Cloudflare API, database and HTTP; nothing reaches a provider.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  checkChallengeConfiguration,
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
} from "./fixtures/staging-fakes.mjs";

const head = schemaHead(loadMigrationChain());
const digest = "c".repeat(64);
const csp = committedCsp(process.cwd());
const constants = await identityConstants();
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
        broker: constants.brokerSecrets,
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
// is false. Both carry PR-D identifiers, so today's committed staging config stops here.
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
  for (const [label, challengeVars, code, reason] of [
    ["api var absent", { api: null }, "STAGING_CHALLENGE_CONFIGURATION_MISSING"],
    ["broker var absent", { broker: null }, "STAGING_CHALLENGE_CONFIGURATION_MISSING"],
    [
      "dummy site key",
      { api: apiVar({ siteKey: "1x00000000000000000000AA" }) },
      "STAGING_CHALLENGE_CONFIGURATION_INVALID",
      "api",
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
  // The consistent pair passes gate 4 and the deploy goes on (the other AC04 cases).
  const ok = await world({ environment: ciEnvironment() });
  try {
    const { result } = await ok.run(["deploy", "--ci"]);
    assert.equal(result.gates.challenge, "ok");
    assert.equal(result.outcome, "deployed");
  } finally {
    ok.planted.cleanup();
  }
  // The committed staging configuration has no challenge vars until PR-D.
  const committed = await import("../scripts/staging.mjs").then((m) =>
    m.loadStagingConfiguration(process.cwd()),
  );
  assert.equal(committed.challengeJson, null);
  assert.equal(committed.broker.turnstileJson, null);
  await assert.rejects(checkChallengeConfiguration(committed), {
    code: "STAGING_CHALLENGE_CONFIGURATION_MISSING",
  });
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
        bindings: name === scriptOf.api ? [scriptOf.broker] : [],
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
  const unset = await world({
    staging: {
      ...JSON.parse(readFileSync("infra/environments/staging.json", "utf8")),
    },
  });
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
function probeWorld({ revoke = "warning", verifier = "accepted", createFails = false } = {}) {
  const password = "probepw" + "x".repeat(20);
  const statements = [];
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
    statements.push({ connect: url.host });
    return {
      async query(text, params = []) {
        statements.push({ text, params });
        if (/session_user::text AS session_role/.test(text))
          return [
            {
              session_role: "neondb_owner",
              current_role: "neondb_owner",
              database: "neondb",
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
        if (/count\(\*\)::int AS n/.test(text)) return [{ n: 0 }];
        return [];
      },
      async exec(text) {
        statements.push({ text });
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
      },
      async close() {},
    };
  };
  return { password, statements, neonctl, connectProbe };
}
test("neon-probe: M-N1, M-N3 and M-N4 on a fresh expiring child of the root, never another branch", async () => {
  const probe = probeWorld();
  const w = await world({
    staging: probeStaging(),
    tools: { neonctl: probe.neonctl },
    overrides: { probeDatabase: probe.connectProbe },
  });
  try {
    const { code, result } = await w.run(["neon-probe"]);
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
    assert.deepEqual(result.mN3, { verifierAccepted: true, sqlstate: null });
    assert.deepEqual(result.mN4, {
      branchIdKept: true,
      hostKept: true,
      rolesDropped: true,
      expirySupported: true,
    });
    assert.equal(result.cleanup, "branch_expires_at");
    const sent = JSON.stringify(probe.statements);
    assert.ok(!sent.includes(probe.password));
    assert.match(sent, /PASSWORD 'SCRAM-SHA-256\$4096:/);
    assert.ok(!w.out.join("\n").includes(probe.password));
  } finally {
    w.planted.cleanup();
  }
  const refused = probeWorld({ revoke: "error", verifier: "refused" });
  const r = await world({
    staging: probeStaging(),
    tools: { neonctl: refused.neonctl },
    overrides: { probeDatabase: refused.connectProbe },
  });
  try {
    const { code, result } = await r.run(["neon-probe"]);
    assert.equal(code, 0);
    assert.equal(result.mN1.revokeSqlstate, "42501");
    assert.deepEqual(result.mN3, { verifierAccepted: false, sqlstate: "22023" });
    assert.ok(!r.out.join("\n").includes(refused.password));
  } finally {
    r.planted.cleanup();
  }
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
  const unset = await world();
  try {
    assert.equal((await unset.run(["neon-probe"])).result.code, "STAGING_IDENTIFIERS_UNSET");
  } finally {
    unset.planted.cleanup();
  }
});

test("cli: the trimmed PR-B's subcommands, and nothing for rollback, rotation drills or the keyring deploy", () => {
  assert.deepEqual([...commands.keys()].sort(), [
    "census",
    "ci-gates",
    "connections",
    "deploy",
    "keyring",
    "kill",
    "migrate",
    "neon-probe",
    "preflight",
    "provision-roles",
    "put-secret",
    "queues",
    "schema-head",
    "secrets-status",
    "seed-platform",
    "smoke",
    "status",
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
