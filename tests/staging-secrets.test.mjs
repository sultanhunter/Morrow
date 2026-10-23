// P04.T01i AC07 (no secret marker reaches stdout, stderr, argv, the environment, logs,
// errors or the report, from any source, including malformed files, bad URLs and failing
// child processes) and AC08 (`secrets-status` reports presence, mode, format and age
// without values, and exits non-zero on a missing or extra secret or a wrong mode).
// Every secret here is a synthetic marker in a temporary HOME; nothing reads the
// operator's ~/.config/morrow or reaches a provider.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { captureConsole, edgeRateLimits, loadWranglerApi } from "../scripts/edge.mjs";
import { identityConstants, main, workerConfigs } from "../scripts/staging.mjs";
import { createTools, toolJson } from "../scripts/staging-tools.mjs";
import { syntheticCredential, syntheticGithubCredential } from "../scripts/staging-token.mjs";
import {
  fakeContext,
  fakeDatabase,
  fakeTools,
  labBinding,
  plantedHome,
} from "./fixtures/staging-fakes.mjs";

const alnum = (n) => randomBytes(n).toString("hex");
const markers = {
  workos: "WOS" + alnum(10),
  turnstile: "tsk" + alnum(12),
  url: "urlpw" + alnum(10),
  neonKey: "neonkey" + alnum(18),
  operator: "op" + alnum(19),
  token: "envtok" + alnum(17),
  envWorkos: "envwos" + alnum(10),
  envNeon: "envneon" + alnum(10),
  envDb: "envdb" + alnum(10),
  tool: "toolout" + alnum(10),
  database: "dberr" + alnum(10),
  malformed: "badfile" + alnum(10),
  // M2 PR-1: the owner's vault KEK, 64 lowercase hex characters.
  kek: alnum(32),
  // M5 PR-1: the owner's Stripe restricted test key and webhook signing secret.
  stripeKey: "stripekey" + alnum(12),
  stripeWebhook: "stripehook" + alnum(12),
  // Build order PR 7: the owner's E2B API key.
  e2b: "e2bkey" + alnum(12),
};
const files = () => ({
  "workos-api-key": "sk_test_" + markers.workos,
  "turnstile-secret": "0x4AAAAAAA" + markers.turnstile,
  "neon-owner-url": `postgresql://neondb_owner:${markers.url}@${labBinding.hostname}/morrow?sslmode=require`,
  "neon-project-api-key": "napi_" + markers.neonKey,
  "cloudflare-operator-token": markers.operator,
  "vault-kek-v1": markers.kek,
  "stripe-restricted-key": "rk_test_" + markers.stripeKey,
  "stripe-webhook-secret": "whsec_" + markers.stripeWebhook,
  "e2b-api-key": "e2b_" + markers.e2b,
});
const everyMarker = () => Object.values(markers);
const contains = (text, values) => values.filter((value) => value && String(text).includes(value));

// ---------------------------------------------------------------------------
// AC08: secrets-status in-process over fakes.
const now = Date.parse("2026-10-20T12:00:00Z");
const daysAgo = (d) => new Date(now - d * 86400000).toISOString();
async function status({
  plant = files(),
  modes = {},
  links = {},
  directoryMode,
  tools = {},
  database = {},
  ages = {},
  // M5: the Stripe switch (owner decision (c), 2026-10-21); off is the committed state.
  stripe = "off",
  // Build order PR 7: the runtime switch; off is the committed state.
  runtime = "off",
} = {}) {
  const planted = plantedHome(plant, { modes, links, directoryMode });
  try {
    const constants = (
      await fakeContext({ home: planted.home, tools: fakeTools().tools, stripe, runtime })
    ).constants;
    const tracked = [...constants.brokerSecrets, "LOGIN_CAPSULE_KEYRING"];
    const record = {
      schemaVersion: 1,
      secrets: Object.fromEntries(
        tracked
          .filter((name) => ages[name] !== null)
          .map((name) => [
            name,
            {
              rotatedAt: daysAgo(ages[name] ?? 10),
              worker: name === "LOGIN_CAPSULE_KEYRING" ? "api" : "broker",
              versionId: null,
            },
          ]),
      ),
    };
    writeFileSync(join(planted.directory, "rotation-record.json"), JSON.stringify(record), {
      mode: 0o600,
    });
    const fake = fakeTools({
      wrangler: {
        secrets: {
          api: ["LOGIN_CAPSULE_KEYRING"],
          broker: constants.brokerSecrets,
          orchestrator: [],
          connector: [],
          ...(tools.secrets ?? {}),
        },
      },
      gh: tools.gh,
      ...(tools.extra ?? {}),
    });
    const db = fakeDatabase({ roles: constants.roles, provisioned: true, ...database });
    const { ctx, out, err } = await fakeContext({
      home: planted.home,
      tools: fake.tools,
      database: db.connector,
      now,
      stripe,
      runtime,
    });
    const code = await main(["secrets-status"], ctx);
    const report = JSON.parse(out[0] ?? err[0]);
    return { code, report, text: out.join("\n") + err.join("\n"), calls: fake.calls };
  } finally {
    planted.cleanup();
  }
}

// AC02 after P05.T01ab (D1, ADR-0019 items 6 and 8), M2 PR-1 (ADR-0022 items 7-8) and M5
// PR-1 (ADR-0022 items 7 and 12) with the Stripe switch (owner decision (c), 2026-10-21):
// the broker's exact secret set is `brokerRequiredSecretsFor("staging", switch)`. Off (the
// committed switch in docs/decisions/stripe-staging.json), fourteen names, the deployed
// broker's: WORKOS_API_KEY, TURNSTILE_SECRET_KEY, the eleven role passwords (the ten leased
// roles and the broker's own `morrow_vault_broker`) and MORROW_VAULT_KEK_V1. On, sixteen
// with STRIPE_RESTRICTED_KEY and STRIPE_WEBHOOK_SECRET. secrets-status, gate 6 and the
// first-deploy file all use that set, and it is the broker's wrangler `secrets.required` in
// staging (development is always off); production requires its vault-free and Stripe-free
// subset (twelve names, `brokerRequiredSecretsFor("production")`) until the ADR-0007 item 9
// custody ADR. ADR-0022's Anthropic and Shopify credentials join only with their
// milestones. The staging api keeps P05.T01ab's three limiters and no required secret.
test("AC02: the broker's secret names follow the Stripe switch and wrangler's secrets.required", async () => {
  const { stagingStripeSwitch } = await import("../scripts/staging.mjs");
  const committed = stagingStripeSwitch(process.cwd());
  assert.equal(committed, "off");
  const constants = await identityConstants({ stripe: committed });
  assert.equal(constants.roles.length, 11);
  assert.equal(constants.roles.at(-1), "morrow_vault_broker");
  assert.deepEqual(constants.vaultKekSecrets, ["MORROW_VAULT_KEK_V1"]);
  assert.equal(constants.stripe, "off");
  assert.deepEqual(constants.stripeSecrets, []);
  const expected = [
    "WORKOS_API_KEY",
    "TURNSTILE_SECRET_KEY",
    ...constants.roles.map((role) => constants.passwordSecret(role)),
    "MORROW_VAULT_KEK_V1",
  ].sort();
  assert.equal(constants.brokerSecrets.length, 14);
  assert.deepEqual(constants.brokerSecrets, expected);
  // The default is off, whatever the record says.
  assert.deepEqual((await identityConstants()).brokerSecrets, expected);
  const on = await identityConstants({ stripe: "on" });
  assert.equal(on.stripe, "on");
  assert.deepEqual(on.stripeSecrets, ["STRIPE_RESTRICTED_KEY", "STRIPE_WEBHOOK_SECRET"]);
  assert.equal(on.brokerSecrets.length, 16);
  assert.deepEqual(
    on.brokerSecrets,
    [...expected, "STRIPE_RESTRICTED_KEY", "STRIPE_WEBHOOK_SECRET"].sort(),
  );
  await assert.rejects(identityConstants({ stripe: "test" }), {
    code: "STAGING_STRIPE_RECORD_INVALID",
  });
  const { brokerRequiredSecretsFor } = await import("../packages/identity/src/broker-protocol.ts");
  const production = [...brokerRequiredSecretsFor("production")].sort();
  assert.equal(production.length, 12);
  assert.deepEqual(
    production,
    constants.brokerSecrets.filter(
      (name) => !["MORROW_DB_PASSWORD_MORROW_VAULT_BROKER", "MORROW_VAULT_KEK_V1"].includes(name),
    ),
  );
  const { unstable_readConfig } = await loadWranglerApi();
  const resolved = (worker, env) =>
    captureConsole(() => unstable_readConfig({ config: workerConfigs[worker], env }, {})).value;
  for (const env of [undefined, "staging", "production"])
    assert.deepEqual(
      [...resolved("broker", env).secrets.required].sort(),
      env === "production" ? production : constants.brokerSecrets,
      String(env),
    );
  const api = resolved("api", "staging");
  assert.deepEqual(api.ratelimits, edgeRateLimits("staging"));
  assert.deepEqual(api.secrets.required, []);
});

// M5: the switch is read with edge:check's own record rule; an invalid record stops the
// staging tools before any effect.
test("M5: the staging tools read the Stripe switch from the reviewed record only", async () => {
  const { stagingStripeSwitch } = await import("../scripts/staging.mjs");
  const root = mkdtempSync(join(tmpdir(), "morrow-stripe-switch-"));
  try {
    mkdirSync(join(root, "docs/decisions"), { recursive: true });
    const committed = JSON.parse(readFileSync("docs/decisions/stripe-staging.json", "utf8"));
    const write = (record) =>
      writeFileSync(join(root, "docs/decisions/stripe-staging.json"), JSON.stringify(record));
    write(committed);
    assert.equal(stagingStripeSwitch(root), "off");
    write({
      ...committed,
      switch: "on",
      portal_configuration_id: "bpc_" + "Switch".padEnd(24, "0"),
      observed_on: "2026-10-21",
    });
    assert.equal(stagingStripeSwitch(root), "on");
    for (const record of [
      { ...committed, switch: "test" },
      { ...committed, switch: "on" },
      (({ switch: _, ...rest }) => rest)(committed),
      { ...committed, mode: "live" },
    ]) {
      write(record);
      assert.throws(() => stagingStripeSwitch(root), { code: "STAGING_STRIPE_RECORD_INVALID" });
    }
    rmSync(join(root, "docs/decisions/stripe-staging.json"));
    assert.throws(() => stagingStripeSwitch(root), { code: "STAGING_STRIPE_RECORD_INVALID" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AC08: a healthy staging reports presence, mode, format and age, and exits 0", async () => {
  const { code, report, text } = await status();
  assert.equal(code, 0, JSON.stringify(report.mismatches));
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.directory.ok, true);
  assert.equal(report.directory.mode, "0700");
  const required = report.files.filter((f) => f.required);
  // Five operator files and M2 PR-1's vault KEK (`vault-kek-v1`, the owner's own). With the
  // Stripe switch off no Stripe file is required or read (the planted ones are ignored).
  assert.equal(required.length, 6);
  assert.ok(required.some((f) => f.file === "vault-kek-v1"));
  assert.ok(!report.files.some((f) => f.file.startsWith("stripe-")));
  assert.equal(report.workers.broker.names.length, 14);
  for (const f of required)
    assert.deepEqual(
      [f.exists, f.mode, f.owner, f.nonEmpty, f.format, f.ok],
      [true, "0600", true, true, true, true],
    );
  assert.deepEqual(report.workers.broker.missing, []);
  assert.deepEqual(report.workers.api.names, ["LOGIN_CAPSULE_KEYRING"]);
  assert.deepEqual(
    report.github.secrets.map((s) => s.name),
    ["CLOUDFLARE_API_TOKEN"],
  );
  assert.equal(report.roles.ok, true);
  assert.equal(report.roles.publicTempRevoked, true);
  assert.ok(report.ages.every((a) => a.days === 10));
  assert.deepEqual(contains(text, everyMarker()), []);
});

// M5 PR-1 with the switch on: the two Stripe owner files are required and the broker holds
// sixteen names.
test("AC08: with the Stripe switch on, the Stripe files are required and the broker holds 16", async () => {
  const { code, report } = await status({ stripe: "on" });
  assert.equal(code, 0, JSON.stringify(report.mismatches));
  const required = report.files.filter((f) => f.required);
  assert.equal(required.length, 8);
  for (const file of ["stripe-restricted-key", "stripe-webhook-secret"])
    assert.ok(
      required.some((f) => f.file === file && f.ok),
      file,
    );
  assert.equal(report.workers.broker.names.length, 16);
  assert.ok(report.ages.some((a) => a.name === "STRIPE_WEBHOOK_SECRET"));
  // On, a broker still without them (deployed while the switch was off) is a mismatch until
  // the owner places them with put-secret.
  const { brokerRequiredSecrets } = await import("../packages/identity/src/broker-protocol.ts");
  const missing = await status({
    stripe: "on",
    tools: { secrets: { broker: [...brokerRequiredSecrets] } },
  });
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.report.workers.broker.missing, [
    "STRIPE_RESTRICTED_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]);
  assert.ok(missing.report.mismatches.includes("worker:broker"));
  // Off, a broker that holds them is the mixed state: a mismatch (extra names).
  const extra = await status({
    tools: {
      secrets: {
        broker: [...brokerRequiredSecrets, "STRIPE_RESTRICTED_KEY", "STRIPE_WEBHOOK_SECRET"],
      },
    },
  });
  assert.equal(extra.code, 1);
  assert.deepEqual(extra.report.workers.broker.extra, [
    "STRIPE_RESTRICTED_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]);
});

test("AC08: a missing, extra or malformed secret, a wrong mode or a symlink exits non-zero", async () => {
  const cases = [
    [{ plant: (({ "workos-api-key": _, ...rest }) => rest)(files()) }, "file:workos-api-key"],
    [{ modes: { "turnstile-secret": 0o644 } }, "file:turnstile-secret"],
    [{ plant: (({ "vault-kek-v1": _, ...rest }) => rest)(files()) }, "file:vault-kek-v1"],
    [{ plant: { ...files(), "vault-kek-v1": markers.malformed } }, "file:vault-kek-v1"],
    [{ modes: { "vault-kek-v1": 0o640 } }, "file:vault-kek-v1"],
    // M5 PR-1, with the Stripe switch on: only a restricted test key and a webhook signing
    // secret are admitted.
    [
      { stripe: "on", plant: (({ "stripe-restricted-key": _, ...rest }) => rest)(files()) },
      "file:stripe-restricted-key",
    ],
    [
      {
        stripe: "on",
        plant: { ...files(), "stripe-restricted-key": "sk_test_" + markers.malformed },
      },
      "file:stripe-restricted-key",
    ],
    [
      {
        stripe: "on",
        plant: { ...files(), "stripe-restricted-key": "rk_live_" + markers.malformed },
      },
      "file:stripe-restricted-key",
    ],
    [
      { stripe: "on", plant: { ...files(), "stripe-webhook-secret": "wh_" + markers.malformed } },
      "file:stripe-webhook-secret",
    ],
    [{ stripe: "on", modes: { "stripe-webhook-secret": 0o644 } }, "file:stripe-webhook-secret"],
    [
      { plant: { ...files(), "workos-api-key": "pk_live_" + markers.malformed } },
      "file:workos-api-key",
    ],
    [
      {
        plant: {
          ...files(),
          "neon-owner-url": "postgresql://neondb_owner:" + markers.malformed + "@[bad",
        },
      },
      "file:neon-owner-url",
    ],
    [{ plant: { ...files(), "workos-api-key": "" } }, "file:workos-api-key"],
    [
      {
        plant: (({ "neon-project-api-key": _, ...rest }) => rest)(files()),
        links: { "neon-project-api-key": "/etc/hosts" },
      },
      "file:neon-project-api-key",
    ],
    [{ directoryMode: 0o755 }, "directory"],
    [{ tools: { secrets: { api: ["LOGIN_CAPSULE_KEYRING", "EXTRA_NAME"] } } }, "worker:api"],
    [{ tools: { secrets: { broker: ["WORKOS_API_KEY"] } } }, "worker:broker"],
    [{ tools: { secrets: { orchestrator: ["STRAY"] } } }, "worker:orchestrator"],
    [
      {
        tools: {
          gh: {
            variables: [
              { name: "CLOUDFLARE_ACCOUNT_ID" },
              { name: "STAGING_DEPLOY_ENABLED" },
              { name: "ROGUE" },
            ],
          },
        },
      },
      "github:variables",
    ],
    [{ tools: { gh: { secrets: [] } } }, "github:secrets"],
    [{ database: { controlsOk: false } }, "roles:controls"],
    [{ ages: { MORROW_DB_PASSWORD_MORROW_API: 95 } }, "age:MORROW_DB_PASSWORD_MORROW_API"],
    [{ ages: { LOGIN_CAPSULE_KEYRING: 61 } }, "age:LOGIN_CAPSULE_KEYRING"],
    [
      {
        plant: { ...files(), "tmp/broker-secrets.json": '{"WORKOS_API_KEY":"' + markers.malformed },
      },
      "file:tmp/broker-secrets.json",
    ],
  ];
  for (const [change, mismatch] of cases) {
    const { code, report, text } = await status(change);
    assert.equal(code, 1, mismatch);
    assert.ok(
      report.mismatches.includes(mismatch),
      mismatch + " in " + JSON.stringify(report.mismatches),
    );
    assert.deepEqual(contains(text, everyMarker()), [], mismatch);
  }
  const extra = await status({
    tools: { secrets: { api: ["LOGIN_CAPSULE_KEYRING", "EXTRA_NAME"] } },
  });
  assert.deepEqual(extra.report.workers.api.extra, ["EXTRA_NAME"]);
  const mode = await status({ modes: { "turnstile-secret": 0o640 } });
  assert.equal(mode.report.files.find((f) => f.file === "turnstile-secret").mode, "0640");
});

test("AC08: ages warn at 80 days (50 for the keyring); transient files are reported", async () => {
  const aging = await status({
    ages: { WORKOS_API_KEY: 85, LOGIN_CAPSULE_KEYRING: 55, TURNSTILE_SECRET_KEY: null },
  });
  assert.equal(aging.code, 0);
  assert.ok(aging.report.warnings.includes("age:WORKOS_API_KEY"));
  assert.ok(aging.report.warnings.includes("age:LOGIN_CAPSULE_KEYRING"));
  assert.ok(aging.report.warnings.includes("age_unknown:TURNSTILE_SECRET_KEY"));
  // A vault KEK is replaced by a new version, never rotated in place: its age is reported
  // and never warned about or failed (M2 PR-1, ADR-0022 item 7).
  const kek = await status({ ages: { MORROW_VAULT_KEK_V1: 400 } });
  assert.equal(kek.code, 0, JSON.stringify(kek.report.mismatches));
  assert.equal(kek.report.ages.find((a) => a.name === "MORROW_VAULT_KEK_V1").days, 400);
  assert.ok(!kek.report.warnings.some((w) => w.startsWith("age:MORROW_VAULT_KEK")));
  const transient = await status({ plant: { ...files(), "cloudflare-ci-token": "c".repeat(40) } });
  assert.equal(transient.code, 0);
  assert.ok(transient.report.warnings.includes("transient_present:cloudflare-ci-token"));
  assert.deepEqual(contains(transient.text, ["c".repeat(40)]), []);
});

// ---------------------------------------------------------------------------
// AC07: every subcommand path in a child process, captured at the descriptor level.
const child = new URL("./fixtures/staging-marker-child.mjs", import.meta.url).pathname;
function runChild(scenario, plant = files()) {
  const planted = plantedHome(plant);
  const work = mkdtempSync(join(tmpdir(), "morrow-staging-marker-"));
  try {
    writeFileSync(join(work, "markers.json"), JSON.stringify(markers));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        child,
        scenario,
        planted.home,
        join(work, "markers.json"),
        join(work, "dump.json"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 120000,
        env: {
          PATH: process.env.PATH,
          HOME: planted.home,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
          CLOUDFLARE_API_TOKEN: markers.token,
          WORKOS_API_KEY: markers.envWorkos,
          NEON_API_KEY: markers.envNeon,
          MORROW_DB_PASSWORD_MORROW_API: markers.envDb,
        },
      },
    );
    const dump = existsSync(join(work, "dump.json"))
      ? JSON.parse(readFileSync(join(work, "dump.json"), "utf8"))
      : null;
    const read = (name) =>
      existsSync(join(planted.directory, name))
        ? readFileSync(join(planted.directory, name), "utf8")
        : null;
    const mode = (name) =>
      existsSync(join(planted.directory, name))
        ? statSync(join(planted.directory, name)).mode & 0o777
        : null;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      dump,
      brokerFile: read("tmp/broker-secrets.json"),
      brokerMode: mode("tmp/broker-secrets.json"),
      apiFile: read("tmp/api-secrets.json"),
      apiMode: mode("tmp/api-secrets.json"),
      turnstileFile: read("turnstile-secret"),
    };
  } finally {
    planted.cleanup();
    rmSync(work, { recursive: true, force: true });
  }
}
// Exactly one JSON line on the expected stream and nothing else: no relayed tool text.
function oneLine(run, stream) {
  const text = run[stream].trimEnd();
  assert.equal(text.split("\n").length, 1, stream + ": " + text);
  const other = stream === "stdout" ? run.stderr : run.stdout;
  assert.equal(other, "");
  return JSON.parse(text);
}
// The one statement a role password may appear in (M-N3 as amended 2026-10-20, owner
// decisions "Plaintext over TLS" and "Plaintext, then wipe stats"): its own role's ALTER
// ROLE, as a literal, sent once. When a loaded pg_stat_statements is wiped, the
// verification query in the scratch database receives only each password's SHA-256
// digest, never the password.
const passwordStatement =
  /^ALTER ROLE (morrow_[a-z0-9_]+) WITH LOGIN CONNECTION LIMIT 10 PASSWORD '([A-Za-z0-9_-]{43})'$/;
const verificationQuery = /pg_stat_statements_info/;
const digest = (password) => createHash("sha256").update(password).digest("hex");
// `passwords` maps role -> plaintext: each must be in exactly one statement, its own
// ALTER ROLE, and nowhere else (stdout, stderr, argv, other SQL including the
// verification, the report); its digest must be in the verification's parameter exactly
// `verified` times (0 or 1).
function noMarkers(run, extra = [], passwords = {}, { verified = 0 } = {}) {
  const secrets = [...everyMarker(), ...extra, ...Object.values(passwords)];
  assert.deepEqual(contains(run.stdout, secrets), [], "stdout");
  assert.deepEqual(contains(run.stderr, secrets), [], "stderr");
  for (const call of run.dump?.calls ?? [])
    assert.deepEqual(contains(call.args.join(" "), secrets), [], call.tool + " argv");
  const sent = Object.fromEntries(Object.keys(passwords).map((role) => [role, 0]));
  const checked = Object.fromEntries(Object.keys(passwords).map((role) => [role, 0]));
  for (const statement of run.dump?.statements ?? []) {
    let text = statement.text + JSON.stringify(statement.params);
    const [, role, password] = passwordStatement.exec(statement.text) ?? [];
    if (role !== undefined && passwords[role] === password && statement.params.length === 0) {
      sent[role]++;
      text = statement.text.replace(password, "");
    }
    if (statement.database === "neondb" && verificationQuery.test(statement.text)) {
      const listed = JSON.parse(statement.params[1]);
      for (const [name, value] of Object.entries(passwords))
        if (listed.includes(digest(value))) checked[name]++;
    }
    assert.deepEqual(contains(text, secrets), [], "sql");
  }
  for (const [role, count] of Object.entries(sent)) assert.equal(count, 1, role + " sent once");
  for (const [role, count] of Object.entries(checked))
    assert.equal(count, verified, role + " verified");
  assert.deepEqual(contains(JSON.stringify(run.dump?.reports ?? []), secrets), [], "report");
}
const sentPasswords = (run) =>
  Object.fromEntries(
    (run.dump?.statements ?? [])
      .map((statement) => passwordStatement.exec(statement.text))
      .filter(Boolean)
      .map(([, role, password]) => [role, password]),
  );
const rolePasswords = (constants, secrets) =>
  Object.fromEntries(
    constants.roles
      .filter((role) => constants.passwordSecret(role) in secrets)
      .map((role) => [role, secrets[constants.passwordSecret(role)]]),
  );

test("AC07: failing and noisy tools, database errors and bad files never reach the output", () => {
  for (const [scenario, stream, code] of [
    ["status-failing-tools", "stdout", null],
    ["status-noisy-tools", "stdout", null],
    ["migrate-failing-git", "stderr", "STAGING_GIT_FAILED"],
    ["migrate-database-error", "stderr", "STAGING_DATABASE_UNAVAILABLE"],
    ["migrate-query-error", "stderr", "STAGING_DATABASE_UNAVAILABLE"],
    ["census-fails", "stderr", "STAGING_CLOUDFLARE_REQUEST_FAILED"],
    ["put-secret-fails", "stderr", "STAGING_PUT_SECRET_FAILED"],
    ["seed-database-error", "stderr", "STAGING_SEED_FAILED"],
  ]) {
    const run = runChild(scenario);
    assert.equal(run.status, 1, scenario + " " + run.stderr);
    const line = oneLine(run, stream);
    if (code) assert.equal(line.code, code, scenario);
    noMarkers(run);
  }
  const seeded = runChild("seed-database-error");
  assert.deepEqual(oneLine(seeded, "stderr"), {
    command: "seed-platform",
    code: "STAGING_SEED_FAILED",
    sqlstate: "XX000",
    server: null,
  });
  const malformed = runChild("migrate-database-error", {
    ...files(),
    "neon-owner-url": `postgresql://neondb_owner:${markers.malformed}@[::1`,
  });
  assert.equal(oneLine(malformed, "stderr").code, "STAGING_FILE_FORMAT");
  noMarkers(malformed);
  const unreadable = runChild("status-failing-tools", {
    ...files(),
    "tmp/broker-secrets.json": "{" + markers.malformed,
    "tmp/api-secrets.json": "not json " + markers.malformed,
  });
  assert.ok(oneLine(unreadable, "stdout").mismatches.includes("file:tmp/broker-secrets.json"));
  noMarkers(unreadable);
});

test("AC07: role passwords reach only their ALTER ROLE, then the 0600 first-deploy file or `secret bulk` stdin", async () => {
  const constants = await identityConstants();
  const first = runChild("provision-first");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(oneLine(first, "stdout").file, "tmp/broker-secrets.json");
  assert.equal(first.brokerMode, 0o600);
  const secrets = JSON.parse(first.brokerFile);
  const passwords = Object.entries(secrets)
    .filter(([name]) => name.startsWith("MORROW_DB_PASSWORD_"))
    .map(([, value]) => value);
  // The ten leased roles and the broker's own vault login (M2 PR-1).
  assert.equal(passwords.length, 11);
  assert.equal(secrets.WORKOS_API_KEY, "sk_test_" + markers.workos);
  // The owner's KEK file, byte for byte: the tool reads it and generates none.
  assert.equal(secrets.MORROW_VAULT_KEK_V1, markers.kek);
  // M5: with the Stripe switch off (committed) the file holds the fourteen names and no
  // Stripe value, although both Stripe owner files are planted.
  assert.equal(Object.keys(secrets).length, 14);
  assert.deepEqual(Object.keys(secrets).sort(), constants.brokerSecrets);
  noMarkers(first, [], rolePasswords(constants, secrets));
  // M5 PR-1, the switch on: the owner's two Stripe files, byte for byte (sixteen names).
  const firstStripe = runChild("provision-first-stripe");
  assert.equal(firstStripe.status, 0, firstStripe.stderr);
  const stripeSecrets = JSON.parse(firstStripe.brokerFile);
  assert.equal(stripeSecrets.STRIPE_RESTRICTED_KEY, "rk_test_" + markers.stripeKey);
  assert.equal(stripeSecrets.STRIPE_WEBHOOK_SECRET, "whsec_" + markers.stripeWebhook);
  assert.equal(Object.keys(stripeSecrets).length, 16);
  noMarkers(firstStripe, [], rolePasswords(constants, stripeSecrets));
  assert.deepEqual(sentPasswords(first), rolePasswords(constants, secrets));
  assert.equal(first.dump.statements.filter((s) => / PASSWORD /.test(s.text)).length, 11);
  assert.ok(first.dump.statements.every((s) => !s.text.includes("SCRAM-SHA-256$")));

  const failed = runChild("provision-first-sql-error");
  assert.equal(failed.status, 1);
  assert.equal(failed.brokerFile, null, "the reserved file is removed when provisioning fails");
  // The refused statement carried a plaintext; the server's error (with markers) and that
  // plaintext stay out of every output.
  assert.equal(Object.keys(sentPasswords(failed)).length, 1);
  noMarkers(failed, [], sentPasswords(failed));

  // Neon's shape: the wipe and its verification run from the scratch database; each
  // password's digest (never the password) is that query's bind parameter once, and the
  // report carries only counts.
  const neon = runChild("provision-first-neon");
  assert.equal(neon.status, 0, neon.stderr);
  assert.deepEqual(oneLine(neon, "stdout").statementStats, {
    recording: true,
    wiped: true,
    entriesRemaining: 0,
  });
  const neonSecrets = JSON.parse(neon.brokerFile);
  noMarkers(neon, [], rolePasswords(constants, neonSecrets), { verified: 1 });
  assert.deepEqual(sentPasswords(neon), rolePasswords(constants, neonSecrets));
  // A residue stops the rotation before `secret bulk`; a failing reset's server text
  // (with markers) never reaches the output.
  const residue = runChild("provision-rotate-residue");
  assert.equal(residue.status, 1);
  assert.deepEqual(oneLine(residue, "stderr"), {
    command: "provision-roles",
    code: "STAGING_STATEMENT_STATS_RESIDUE",
    stage: "verify",
    entriesRemaining: 3,
    fullReset: true,
    sameInstance: true,
  });
  assert.equal(residue.dump.bulkInputs.length, 0);
  noMarkers(residue, [], sentPasswords(residue), { verified: 1 });
  const wipeError = runChild("provision-first-wipe-error");
  assert.equal(wipeError.status, 1);
  assert.deepEqual(oneLine(wipeError, "stderr"), {
    command: "provision-roles",
    code: "STAGING_STATEMENT_STATS_RESIDUE",
    stage: "reset",
    entriesRemaining: null,
    fullReset: null,
    sameInstance: null,
  });
  assert.equal(wipeError.brokerFile, null);
  noMarkers(wipeError, [], sentPasswords(wipeError));

  const rotate = runChild("provision-rotate");
  assert.equal(rotate.status, 0, rotate.stderr);
  const result = oneLine(rotate, "stdout");
  assert.equal(result.roles.length, 11);
  assert.match(result.versionId, /^[0-9a-f-]{36}$/);
  assert.equal(rotate.dump.bulkInputs.length, 1);
  const deliveredSecrets = JSON.parse(rotate.dump.bulkInputs[0].input);
  assert.equal(Object.keys(deliveredSecrets).length, 11);
  noMarkers(rotate, [], rolePasswords(constants, deliveredSecrets));
  assert.deepEqual(sentPasswords(rotate), rolePasswords(constants, deliveredSecrets));
  const bulk = rotate.dump.calls.find((c) => c.tool === "wrangler" && c.args[1] === "bulk");
  assert.deepEqual(bulk.args, [
    "secret",
    "bulk",
    "--config",
    "apps/broker/wrangler.jsonc",
    "--env",
    "staging",
  ]);
  assert.equal(rotate.brokerFile, null);

  const partial = runChild("provision-rotate-bulk-fails");
  assert.equal(partial.status, 1);
  assert.deepEqual(oneLine(partial, "stderr"), {
    command: "provision-roles",
    code: "STAGING_ROTATION_PARTIAL",
    status: 1,
  });
  // The failing `secret bulk` recorded no input: the password is read back from its
  // ALTER ROLE statement, the one place it was sent.
  const partialSent = sentPasswords(partial);
  assert.deepEqual(Object.keys(partialSent), ["morrow_api"]);
  noMarkers(partial, [], partialSent);

  const put = runChild("put-secret");
  assert.equal(put.status, 0, put.stderr);
  assert.deepEqual(JSON.parse(put.dump.bulkInputs[0].input), {
    WORKOS_API_KEY: "sk_test_" + markers.workos,
  });
  noMarkers(put);

  // M2 PR-1: the owner's KEK reaches the broker only through `secret bulk` stdin.
  const kek = runChild("put-secret-kek");
  assert.equal(kek.status, 0, kek.stderr);
  assert.equal(oneLine(kek, "stdout").secret, "MORROW_VAULT_KEK_V1");
  assert.deepEqual(JSON.parse(kek.dump.bulkInputs[0].input), { MORROW_VAULT_KEK_V1: markers.kek });
  noMarkers(kek);

  // M5: with the Stripe switch off put-secret refuses a Stripe name before reading its
  // file or running any tool.
  const off = runChild("put-secret-stripe-off");
  assert.equal(off.status, 1);
  assert.deepEqual(oneLine(off, "stderr"), { command: "put-secret", code: "STAGING_STRIPE_OFF" });
  assert.deepEqual(off.dump.bulkInputs, []);
  assert.deepEqual(off.dump.calls, []);
  noMarkers(off);
  // M5 PR-1, the switch on: each Stripe owner file reaches the broker only through
  // `secret bulk` stdin, also when the running broker does not hold the name yet (placed
  // after the reviewed commit that turns the switch on).
  for (const [scenario, name, value] of [
    ["put-secret-stripe-key", "STRIPE_RESTRICTED_KEY", "rk_test_" + markers.stripeKey],
    ["put-secret-stripe-webhook", "STRIPE_WEBHOOK_SECRET", "whsec_" + markers.stripeWebhook],
  ]) {
    const stripe = runChild(scenario);
    assert.equal(stripe.status, 0, stripe.stderr);
    assert.equal(oneLine(stripe, "stdout").secret, name);
    assert.deepEqual(JSON.parse(stripe.dump.bulkInputs[0].input), { [name]: value });
    noMarkers(stripe);
  }
});

// Build order PR 7 (ADR-0029 item 3; ADR-0035 item 6): the E2B key comes only from the owner's
// chmod-600 file and reaches the broker only through `secret bulk` stdin, never argv. With the
// runtime switch off (committed) put-secret refuses it before reading the file or running any
// tool, unless the owner passes --while-runtime-off; with the switch on the key is required
// and the flag is refused. The flag belongs to E2B_API_KEY alone.
test("PR 7: put-secret E2B_API_KEY refuses while the runtime switch is off unless the owner says so", () => {
  const off = runChild("put-secret-e2b-off");
  assert.equal(off.status, 1);
  assert.deepEqual(oneLine(off, "stderr"), { command: "put-secret", code: "STAGING_RUNTIME_OFF" });
  assert.deepEqual(off.dump.bulkInputs, []);
  assert.deepEqual(off.dump.calls, []);
  noMarkers(off);
  const whileOff = runChild("put-secret-e2b-while-off");
  assert.equal(whileOff.status, 0, whileOff.stderr);
  assert.deepEqual(
    { ...oneLine(whileOff, "stdout"), versionId: null },
    { command: "put-secret", secret: "E2B_API_KEY", versionId: null, runtime: "off" },
  );
  assert.deepEqual(JSON.parse(whileOff.dump.bulkInputs[0].input), {
    E2B_API_KEY: "e2b_" + markers.e2b,
  });
  noMarkers(whileOff);
  // On: placed on a broker that does not hold it yet, without the flag.
  const on = runChild("put-secret-e2b-on");
  assert.equal(on.status, 0, on.stderr);
  assert.equal(oneLine(on, "stdout").secret, "E2B_API_KEY");
  assert.deepEqual(JSON.parse(on.dump.bulkInputs[0].input), { E2B_API_KEY: "e2b_" + markers.e2b });
  noMarkers(on);
  for (const scenario of ["put-secret-e2b-on-flag", "put-secret-flag-other"]) {
    const refused = runChild(scenario);
    assert.notEqual(refused.status, 0, scenario);
    assert.equal(oneLine(refused, "stderr").code, "STAGING_USAGE", scenario);
    assert.deepEqual(refused.dump?.bulkInputs ?? [], [], scenario);
    noMarkers(refused);
  }
  // A malformed or missing owner file is refused by name, never echoed.
  const malformed = runChild("put-secret-e2b-while-off", {
    ...files(),
    "e2b-api-key": "sk-" + markers.malformed,
  });
  assert.equal(malformed.status, 1);
  assert.deepEqual(oneLine(malformed, "stderr"), {
    command: "put-secret",
    code: "STAGING_FILE_FORMAT",
    file: "e2b-api-key",
  });
  assert.deepEqual(malformed.dump.bulkInputs, []);
  noMarkers(malformed);
  const missing = runChild(
    "put-secret-e2b-while-off",
    (({ "e2b-api-key": _, ...rest }) => rest)(files()),
  );
  assert.equal(missing.status, 1);
  assert.equal(oneLine(missing, "stderr").code, "STAGING_FILE_MISSING");
  noMarkers(missing);
});

// Build order PR 7: the runtime switch is read with edge:check's own record rule; the broker's
// names follow it (E2B_API_KEY required while on or cleanup-only, optional while off), and
// gate 6's and secrets-status's sets follow the constants.
test("PR 7: the runtime switch sets the broker's required and optional E2B names", async () => {
  const { stagingRuntimeSwitch } = await import("../scripts/staging.mjs");
  assert.equal(stagingRuntimeSwitch(process.cwd()), "off");
  const off = await identityConstants({ runtime: "off" });
  assert.equal(off.brokerSecrets.length, 14);
  assert.ok(!off.brokerSecrets.includes("E2B_API_KEY"));
  assert.deepEqual(off.brokerOptionalSecrets, ["E2B_API_KEY"]);
  assert.equal(off.runtime, "off");
  for (const runtime of ["on", "cleanup_only"]) {
    const on = await identityConstants({ runtime });
    assert.deepEqual(on.brokerSecrets, [...off.brokerSecrets, "E2B_API_KEY"].sort());
    assert.deepEqual(on.brokerOptionalSecrets, []);
  }
  await assert.rejects(identityConstants({ runtime: "yes" }), {
    code: "STAGING_RUNTIME_RECORD_INVALID",
  });
  const root = mkdtempSync(join(tmpdir(), "morrow-runtime-switch-"));
  try {
    mkdirSync(join(root, "docs/decisions"), { recursive: true });
    const committed = JSON.parse(readFileSync("docs/decisions/runtime-staging.json", "utf8"));
    const write = (record) =>
      writeFileSync(join(root, "docs/decisions/runtime-staging.json"), JSON.stringify(record));
    write({ ...committed, switch: "cleanup_only" });
    assert.equal(stagingRuntimeSwitch(root), "cleanup_only");
    for (const record of [
      { ...committed, switch: "on" },
      { ...committed, switch: true },
      { ...committed, admission: "merchant" },
      { ...committed, provider: "daytona" },
    ]) {
      write(record);
      assert.throws(() => stagingRuntimeSwitch(root), { code: "STAGING_RUNTIME_RECORD_INVALID" });
    }
    rmSync(join(root, "docs/decisions/runtime-staging.json"));
    assert.throws(() => stagingRuntimeSwitch(root), { code: "STAGING_RUNTIME_RECORD_INVALID" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PR 7: secrets-status accepts the E2B key present or absent while off, and requires it while on", async () => {
  // Off, a broker holding the key placed ahead of the switch is no mismatch, nor is one
  // without it; the optional owner file is checked when present and never a warning.
  const { brokerRequiredSecrets } = await import("../packages/identity/src/broker-protocol.ts");
  for (const broker of [[...brokerRequiredSecrets], [...brokerRequiredSecrets, "E2B_API_KEY"]]) {
    const { code, report } = await status({ tools: { secrets: { broker } } });
    assert.equal(code, 0, JSON.stringify(report.mismatches));
    assert.deepEqual(report.workers.broker.extra, []);
    assert.deepEqual(report.warnings, []);
    const file = report.files.find((f) => f.file === "e2b-api-key");
    assert.deepEqual([file.required, file.ok], [false, true]);
  }
  const absent = await status({ plant: (({ "e2b-api-key": _, ...rest }) => rest)(files()) });
  assert.equal(absent.code, 0, JSON.stringify(absent.report.mismatches));
  const bad = await status({ plant: { ...files(), "e2b-api-key": "e2b_" } });
  assert.equal(bad.code, 1);
  assert.ok(bad.report.mismatches.includes("file:e2b-api-key"));
  // On, the key and its file are required.
  const on = await status({ runtime: "on" });
  assert.equal(on.code, 0, JSON.stringify(on.report.mismatches));
  assert.equal(on.report.workers.broker.names.length, 15);
  const missing = await status({
    runtime: "on",
    tools: { secrets: { broker: [...brokerRequiredSecrets] } },
  });
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.report.workers.broker.missing, ["E2B_API_KEY"]);
  const noFile = await status({
    runtime: "on",
    plant: (({ "e2b-api-key": _, ...rest }) => rest)(files()),
  });
  assert.ok(noFile.report.mismatches.includes("file:e2b-api-key"));
});

test("AC07: connections count unknown names without printing them; keyring prints metadata only", () => {
  const connections = runChild("connections");
  assert.equal(connections.status, 0, connections.stderr);
  const report = oneLine(connections, "stdout");
  assert.equal(report.flagged, true);
  assert.equal(report.byRole.morrow_api, 2);
  assert.equal(report.byRole.other, 1);
  assert.equal(report.byApplication.identity_pool, 2);
  assert.equal(report.byApplication.unknown, 1);
  noMarkers(connections);

  const keyring = runChild("keyring");
  assert.equal(keyring.status, 0, keyring.stderr);
  const metadata = oneLine(keyring, "stdout");
  assert.equal(keyring.apiMode, 0o600);
  const keyringJson = JSON.parse(keyring.apiFile).LOGIN_CAPSULE_KEYRING;
  const material = JSON.parse(keyringJson).versions[0].material;
  assert.match(material, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(metadata.configurationDigest, "c".repeat(64));
  assert.match(metadata.keyId, /^[0-9a-f-]{36}$/);
  noMarkers(keyring, [material]);
});

test("AC07: turnstile-create, the Neon probe, the kill and the deploy never print a marker", async () => {
  const { identityConstants } = await import("../scripts/staging.mjs");
  const constants = await identityConstants();
  const without = (name) => Object.fromEntries(Object.entries(files()).filter(([k]) => k !== name));
  // The Turnstile secret goes only to its new 0600 file; a lost reply leaves no file.
  const created = runChild("turnstile-create", without("turnstile-secret"));
  assert.equal(created.status, 0, created.stderr);
  assert.equal(oneLine(created, "stdout").siteKey, "0x4AAAAAAA" + "S".repeat(14));
  assert.equal(created.turnstileFile, "0x4AAAAAAA" + markers.turnstile);
  noMarkers(created);
  const lost = runChild("turnstile-lost", without("turnstile-secret"));
  assert.equal(lost.status, 1);
  assert.equal(oneLine(lost, "stderr").code, "STAGING_TURNSTILE_SECRET_LOST");
  assert.equal(lost.turnstileFile, null);
  noMarkers(lost);
  // The probe's connection string (with its password) and server errors stay inside.
  const probe = runChild("neon-probe");
  assert.equal(probe.status, 0, probe.stderr);
  const report = oneLine(probe, "stdout");
  assert.equal(report.mN3.verifierAccepted, false);
  assert.equal(report.mN3.verifierSqlstate, "XX000");
  assert.equal(report.mN3.verifierRefusal, "neon_plaintext_only");
  assert.equal(report.mN3.plaintextAccepted, true);
  assert.equal(report.mN1.revokeSqlstate, "XX000");
  // The generated plaintext was sent once and is in no output.
  const plaintexts = probe.dump.probeStatements
    .map(
      (s) =>
        /^ALTER ROLE morrow_probe_[0-9a-f]{8} WITH LOGIN PASSWORD '([A-Za-z0-9_-]{43})'$/.exec(
          s.text,
        )?.[1],
    )
    .filter(Boolean);
  assert.equal(plaintexts.length, 1);
  noMarkers(probe, plaintexts);
  assert.ok(!(probe.stdout + probe.stderr).includes("control plane"));
  // Neon's shape: the wipe from neondb verified the plaintext's absence with only its
  // digest as a bind parameter; a failing stored-form read (with markers) is recorded as
  // "error", and the measurements survive it.
  assert.deepEqual(report.mN3.wipe, { wiped: true, entriesRemaining: 0 });
  assert.equal(report.mN3.storedForm, "error");
  assert.equal(report.mN3.targetExtension, false);
  const carrying = probe.dump.probeStatements.filter((s) =>
    (s.text + JSON.stringify(s.params)).includes(plaintexts[0]),
  );
  assert.equal(carrying.length, 1);
  assert.equal(carrying[0].database, "morrow");
  const verification = probe.dump.probeStatements.filter((s) => verificationQuery.test(s.text));
  assert.equal(verification.length, 1);
  assert.equal(verification[0].database, "neondb");
  assert.deepEqual(JSON.parse(verification[0].params[1]), [digest(plaintexts[0])]);
  // A kill with every tool failing and a failing fetch still prints one closed line.
  const kill = runChild("kill-failing");
  assert.equal(kill.status, 1);
  assert.equal(
    oneLine(kill, "stdout").fallback,
    "dashboard_workers_dev_disable_and_github_workflow_disable",
  );
  noMarkers(kill);
  // A failed upload with noisy wrangler output: an unknown outcome, no relayed text.
  const failing = runChild("deploy-failing");
  assert.equal(failing.status, 1);
  assert.equal(oneLine(failing, "stdout").outcome, "unknown");
  noMarkers(failing);
  // The first deploy hands the secret files to wrangler by path, then unlinks them.
  const brokerSecrets = Object.fromEntries(
    constants.brokerSecrets.map((name, i) => [
      name,
      name === "WORKOS_API_KEY" ? "sk_test_" + markers.workos : "pw" + i + markers.envDb,
    ]),
  );
  const first = runChild("deploy-first", {
    ...files(),
    "tmp/broker-secrets.json": JSON.stringify(brokerSecrets),
    "tmp/api-secrets.json": JSON.stringify({
      LOGIN_CAPSULE_KEYRING: "keyring" + markers.malformed,
    }),
  });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(oneLine(first, "stdout").outcome, "deployed");
  assert.equal(first.brokerFile, null);
  assert.equal(first.apiFile, null);
  const secretsFiles = first.dump.calls
    .filter((c) => c.tool === "wrangler" && c.args.includes("--secrets-file"))
    .map((c) => c.args.at(-1).replace(/^.*\/staging\//, ""));
  assert.deepEqual(secretsFiles, ["tmp/broker-secrets.json", "tmp/api-secrets.json"]);
  noMarkers(first, Object.values(brokerSecrets));
});

// ---------------------------------------------------------------------------
// The real tool runners: credentials only in a child's environment, never argv; output
// of a failing child never relayed; other provider variables never passed.
test("AC07: tool children get the token or Neon key in their environment only, never argv", async () => {
  const root = mkdtempSync(join(tmpdir(), "morrow-staging-tools-"));
  const bin = mkdtempSync(join(tmpdir(), "morrow-staging-bin-"));
  const savedPath = process.env.PATH;
  const savedSecret = process.env.WORKOS_API_KEY;
  try {
    const recorder = (name) =>
      `import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nlet input = "";\nprocess.stdin.on("data", (c) => (input += c));\nprocess.stdin.on("end", () => {\n  writeFileSync(join(${JSON.stringify(root)}, ${JSON.stringify(name)} + "-" + process.pid + ".json"), JSON.stringify({ argv: process.argv.slice(2), env: process.env, input, cwd: process.cwd() }));\n  process.stdout.write("noisy " + (process.env.CLOUDFLARE_API_TOKEN ?? "") + (process.env.NEON_API_KEY ?? ""));\n  process.stderr.write("failing " + (process.env.CLOUDFLARE_API_TOKEN ?? "") + (process.env.NEON_API_KEY ?? ""));\n  process.exit(3);\n});\n`;
    for (const [dir, name] of [
      ["node_modules/wrangler/bin", "wrangler.js"],
      ["node_modules/neonctl/bin", "cli.js"],
    ]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, name), recorder(name.replace(".js", "")));
    }
    writeFileSync(join(bin, "gh"), "#!" + process.execPath + "\n" + recorder("gh"));
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = bin + ":" + savedPath;
    process.env.WORKOS_API_KEY = markers.envWorkos;
    // A GH_TOKEN still in process.env (staging-token.mjs removes it at startup) reaches no
    // child; gh gets only the captured handle's token.
    const savedGh = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghs_env" + markers.envDb;
    after(() =>
      savedGh === undefined ? delete process.env.GH_TOKEN : (process.env.GH_TOKEN = savedGh),
    );
    const token = markers.operator;
    const tools = createTools({
      root,
      home: "/nonexistent-home",
      credential: syntheticCredential(token),
      accountId: "a".repeat(32),
      neonApiKey: "napi_" + markers.neonKey,
      github: syntheticGithubCredential("ghs_" + markers.tool),
    });
    for (const [tool, args] of [
      [
        "wrangler",
        [
          "secret",
          "list",
          "--config",
          "apps/broker/wrangler.jsonc",
          "--env",
          "staging",
          "--format",
          "json",
        ],
      ],
      ["neonctl", ["branches", "list", "--project-id", "p"]],
      ["gh", ["secret", "list", "--json", "name"]],
    ])
      await assert.rejects(toolJson(tools, tool, args), (error) => {
        assert.equal(error.code, "STAGING_" + tool.toUpperCase() + "_FAILED");
        assert.deepEqual(error.details, { status: 3 });
        assert.deepEqual(
          contains(error.message + JSON.stringify(error.details), [token, markers.neonKey]),
          [],
        );
        return true;
      });
    const dumps = Object.fromEntries(
      ["wrangler", "cli", "gh"].map((name) => {
        const file = spawnSync("ls", [root], { encoding: "utf8" })
          .stdout.split("\n")
          .find((f) => f.startsWith(name + "-"));
        return [name, JSON.parse(readFileSync(join(root, file), "utf8"))];
      }),
    );
    // wrangler: the token in its environment (ADR-0019 item 14), with the account, a
    // throwaway HOME and an empty env file; never in argv.
    assert.equal(dumps.wrangler.env.CLOUDFLARE_API_TOKEN, token);
    assert.equal(dumps.wrangler.env.CLOUDFLARE_ACCOUNT_ID, "a".repeat(32));
    assert.notEqual(dumps.wrangler.env.HOME, homedir());
    assert.match(dumps.wrangler.argv.at(-1), /^--env-file=.*empty\.env$/);
    assert.deepEqual(contains(dumps.wrangler.argv.join(" "), [token]), []);
    assert.equal(dumps.wrangler.env.WORKOS_API_KEY, undefined);
    // neonctl: NEON_API_KEY in its environment only, analytics off.
    assert.equal(dumps.cli.env.NEON_API_KEY, "napi_" + markers.neonKey);
    assert.ok(dumps.cli.argv.includes("--no-analytics"));
    assert.equal(dumps.cli.env.CLOUDFLARE_API_TOKEN, undefined);
    assert.deepEqual(contains(dumps.cli.argv.join(" "), [markers.neonKey]), []);
    // gh: neither credential, and no inherited provider variable.
    for (const name of ["CLOUDFLARE_API_TOKEN", "NEON_API_KEY", "WORKOS_API_KEY"])
      assert.equal(dumps.gh.env[name], undefined);
    // The workflow's GH_TOKEN reaches gh only, from the captured handle.
    assert.equal(dumps.gh.env.GH_TOKEN, "ghs_" + markers.tool);
    assert.equal(dumps.wrangler.env.GH_TOKEN, undefined);
    assert.equal(dumps.cli.env.GH_TOKEN, undefined);
    for (const dump of Object.values(dumps))
      assert.deepEqual(contains(JSON.stringify(dump.env), [markers.envDb]), []);
    assert.deepEqual(
      Object.keys(dumps.gh.env).filter(
        (k) =>
          !/^(PATH|HOME|LANG|GH_PROMPT_DISABLED|GH_NO_UPDATE_NOTIFIER|NO_COLOR|GH_CONFIG_DIR|GH_TOKEN|__CF_USER_TEXT_ENCODING)$/.test(
            k,
          ),
      ),
      [],
    );
  } finally {
    process.env.PATH = savedPath;
    if (savedSecret === undefined) delete process.env.WORKOS_API_KEY;
    else process.env.WORKOS_API_KEY = savedSecret;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("AC07: credential files must be owner-only regular files in an owner-only directory", async () => {
  const { readCredentialFile, stagingFileSpecs, createOwnerFile, credentialDirectory } =
    await import("../scripts/staging-files.mjs");
  const specs = stagingFileSpecs({ brokerSecretNames: ["WORKOS_API_KEY"] });
  const cases = [
    [{ modes: { "workos-api-key": 0o644 } }, "STAGING_FILE_MODE"],
    [{ plant: {} }, "STAGING_FILE_MISSING"],
    [{ plant: {}, links: { "workos-api-key": "/etc/hosts" } }, "STAGING_FILE_NOT_REGULAR"],
    [{ plant: { "workos-api-key": "sk_live_" + markers.malformed } }, "STAGING_FILE_FORMAT"],
    [{ plant: { "workos-api-key": "" } }, "STAGING_FILE_EMPTY"],
    [{ directoryMode: 0o750 }, "STAGING_CREDENTIAL_DIRECTORY"],
  ];
  for (const [change, code] of cases) {
    const planted = plantedHome(change.plant ?? files(), {
      modes: change.modes,
      links: change.links,
      directoryMode: change.directoryMode,
    });
    try {
      assert.throws(
        () => readCredentialFile(credentialDirectory(planted.home), "workos-api-key", specs),
        (error) => {
          assert.equal(error.code, code);
          assert.deepEqual(
            contains(error.message + JSON.stringify(error.details), everyMarker()),
            [],
          );
          return true;
        },
      );
    } finally {
      planted.cleanup();
    }
  }
  const planted = plantedHome(files());
  try {
    assert.equal(
      readCredentialFile(planted.directory, "workos-api-key", specs),
      "sk_test_" + markers.workos,
    );
    writeFileSync(join(planted.directory, "neon-owner-url"), files()["neon-owner-url"] + "\n", {
      mode: 0o600,
    });
    const handle = createOwnerFile(planted.directory, "tmp/api-secrets.json");
    handle.write("{}\n");
    assert.equal(statSync(join(planted.directory, "tmp/api-secrets.json")).mode & 0o777, 0o600);
    assert.throws(() => createOwnerFile(planted.directory, "tmp/api-secrets.json"), {
      code: "STAGING_FILE_EXISTS",
    });
    assert.throws(() => createOwnerFile(planted.directory, "../escape"), {
      code: "STAGING_FILE_UNKNOWN",
    });
  } finally {
    planted.cleanup();
  }
});
