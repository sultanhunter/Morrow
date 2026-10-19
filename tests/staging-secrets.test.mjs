// P04.T01i AC07 (no secret marker reaches stdout, stderr, argv, the environment, logs,
// errors or the report, from any source, including malformed files, bad URLs and failing
// child processes) and AC08 (`secrets-status` reports presence, mode, format and age
// without values, and exits non-zero on a missing or extra secret or a wrong mode).
// Every secret here is a synthetic marker in a temporary HOME; nothing reads the
// operator's ~/.config/morrow or reaches a provider.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { main } from "../scripts/staging.mjs";
import { createTools, toolJson } from "../scripts/staging-tools.mjs";
import { syntheticCredential } from "../scripts/staging-token.mjs";
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
};
const files = () => ({
  "workos-api-key": "sk_test_" + markers.workos,
  "turnstile-secret": "0x4AAAAAAA" + markers.turnstile,
  "neon-owner-url": `postgresql://neondb_owner:${markers.url}@${labBinding.hostname}/morrow?sslmode=require`,
  "neon-project-api-key": "napi_" + markers.neonKey,
  "cloudflare-operator-token": markers.operator,
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
} = {}) {
  const planted = plantedHome(plant, { modes, links, directoryMode });
  try {
    const constants = (await fakeContext({ home: planted.home, tools: fakeTools().tools }))
      .constants;
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
    });
    const code = await main(["secrets-status"], ctx);
    const report = JSON.parse(out[0] ?? err[0]);
    return { code, report, text: out.join("\n") + err.join("\n"), calls: fake.calls };
  } finally {
    planted.cleanup();
  }
}

test("AC08: a healthy staging reports presence, mode, format and age, and exits 0", async () => {
  const { code, report, text } = await status();
  assert.equal(code, 0, JSON.stringify(report.mismatches));
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.directory.ok, true);
  assert.equal(report.directory.mode, "0700");
  const required = report.files.filter((f) => f.required);
  assert.equal(required.length, 5);
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

test("AC08: a missing, extra or malformed secret, a wrong mode or a symlink exits non-zero", async () => {
  const cases = [
    [{ plant: (({ "workos-api-key": _, ...rest }) => rest)(files()) }, "file:workos-api-key"],
    [{ modes: { "turnstile-secret": 0o644 } }, "file:turnstile-secret"],
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
function noMarkers(run, extra = []) {
  const secrets = [...everyMarker(), ...extra];
  assert.deepEqual(contains(run.stdout, secrets), [], "stdout");
  assert.deepEqual(contains(run.stderr, secrets), [], "stderr");
  for (const call of run.dump?.calls ?? [])
    assert.deepEqual(contains(call.args.join(" "), secrets), [], call.tool + " argv");
  for (const statement of run.dump?.statements ?? [])
    assert.deepEqual(
      contains(statement.text + JSON.stringify(statement.params), secrets),
      [],
      "sql",
    );
}

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

test("AC07: role passwords reach only the 0600 first-deploy file or `secret bulk` stdin", () => {
  const first = runChild("provision-first");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(oneLine(first, "stdout").file, "tmp/broker-secrets.json");
  assert.equal(first.brokerMode, 0o600);
  const secrets = JSON.parse(first.brokerFile);
  const passwords = Object.entries(secrets)
    .filter(([name]) => name.startsWith("MORROW_DB_PASSWORD_"))
    .map(([, value]) => value);
  assert.equal(passwords.length, 8);
  assert.equal(secrets.WORKOS_API_KEY, "sk_test_" + markers.workos);
  noMarkers(first, passwords);
  assert.equal(
    first.dump.statements.filter((s) => /PASSWORD 'SCRAM-SHA-256\$4096:/.test(s.text)).length,
    8,
  );

  const failed = runChild("provision-first-sql-error");
  assert.equal(failed.status, 1);
  assert.equal(failed.brokerFile, null, "the reserved file is removed when provisioning fails");
  noMarkers(failed);

  const rotate = runChild("provision-rotate");
  assert.equal(rotate.status, 0, rotate.stderr);
  const result = oneLine(rotate, "stdout");
  assert.equal(result.roles.length, 8);
  assert.match(result.versionId, /^[0-9a-f-]{36}$/);
  assert.equal(rotate.dump.bulkInputs.length, 1);
  const delivered = Object.values(JSON.parse(rotate.dump.bulkInputs[0].input));
  assert.equal(delivered.length, 8);
  noMarkers(rotate, delivered);
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
  noMarkers(partial, Object.values(JSON.parse(partial.dump.bulkInputs[0]?.input ?? "{}")));

  const put = runChild("put-secret");
  assert.equal(put.status, 0, put.stderr);
  assert.deepEqual(JSON.parse(put.dump.bulkInputs[0].input), {
    WORKOS_API_KEY: "sk_test_" + markers.workos,
  });
  noMarkers(put);
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
    const savedGh = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghs_" + markers.tool;
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
    // The workflow's GH_TOKEN reaches gh only.
    assert.equal(dumps.gh.env.GH_TOKEN, "ghs_" + markers.tool);
    assert.equal(dumps.wrangler.env.GH_TOKEN, undefined);
    assert.equal(dumps.cli.env.GH_TOKEN, undefined);
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
