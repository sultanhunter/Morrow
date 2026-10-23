import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  bundleExclusions,
  bundleSizeFailure,
  edgeBundleLimits,
  edgeChildEnvironment,
  edgeConnectorRateLimits,
  edgeEnvironments,
  devBindingTables,
  edgeObservability,
  edgePlacementRegion,
  edgePlacementWorkers,
  edgeRateLimits,
  edgeRefusals,
  edgeStripeModeVar,
  edgeStripeNamesRequired,
  edgeStripeSecretNames,
  edgeStripeVarNames,
  edgeModelNamesRequired,
  edgeModelVarNames,
  edgeRuntimeNamesRequired,
  edgeRuntimeVarNames,
  edgePublicWorkers,
  edgeVarNames,
  edgeWorkers,
  edgeWorkersDev,
  orchestratorPackageAllowlist,
  resolvedEdgeConfig,
  reviewedModelRecord,
  reviewedRuntimeRecord,
  reviewedStripeRecord,
  runWrangler,
  verifyEdgeConfig,
  wranglerInvocation,
} from "../scripts/edge.mjs";
import { scanSecrets } from "../scripts/delivery-checks.mjs";
import { reservedWorkerPaths } from "../apps/api/src/reserved-paths.ts";

// P04.T02a AC01, AC04, AC24 and the static half of AC22. Configuration is read
// with the pinned wrangler (no account, credential or network).
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "morrow-edge-config-")));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
let copies = 0;
// The committed configs are JSONC: whole-line comments and trailing commas only.
const parseConfig = (text) =>
  JSON.parse(
    text
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")
      .replace(/,(\s*[}\]])/g, "$1"),
  );
function tree(mutate = {}) {
  const root = join(scratch, "tree-" + ++copies);
  for (const worker of edgeWorkers) {
    mkdirSync(join(root, worker.dir), { recursive: true });
    const config = parseConfig(readFileSync(join(worker.dir, "wrangler.jsonc"), "utf8"));
    mutate[worker.key]?.(config);
    writeFileSync(join(root, worker.dir, "wrangler.jsonc"), JSON.stringify(config, null, 2));
  }
  return root;
}
const verify = (root, routesPath, records = {}) =>
  verifyEdgeConfig({ root, ...(routesPath ? { routesPath } : {}), ...records });
const codes = (verdict) =>
  [...new Set(verdict.problems.map((problem) => problem.split(":")[0]))].sort();

test("AC01/AC04: the committed configuration resolves cleanly for 4 Workers x 3 environments", async () => {
  const verdict = await verify(resolve("."));
  assert.deepEqual(verdict.problems, []);
  assert.equal(Object.keys(verdict.resolved).length, edgeWorkers.length * edgeEnvironments.length);
  for (const environment of edgeEnvironments) {
    assert.deepEqual(verdict.resolved["api:" + environment].services, [
      { binding: "BROKER", service: `morrow-${environment}-broker`, entrypoint: "ApiBroker" },
    ]);
    // v1 PR 1 (ADR-0035 item 2): the staging connector also carries its two reviewed
    // identifiers (its own origin and the api's; the database binding byte-equal to the
    // api's); development and production carry MORROW_ENVIRONMENT only.
    assert.deepEqual(
      verdict.resolved["connector:" + environment].bindings,
      edgeVarNames("connector", environment),
    );
    assert.deepEqual(
      verdict.resolved["connector:" + environment].bindings,
      environment === "staging"
        ? ["MORROW_ENVIRONMENT", "CONNECTOR_CONFIGURATION_JSON", "MORROW_DATABASE_BINDING_JSON"]
        : ["MORROW_ENVIRONMENT"],
    );
    // M3 PR-2: the orchestrator carries MORROW_ENVIRONMENT and binds the broker's
    // RuntimeBroker entrypoint; with the model-provider switch off, nothing else.
    assert.deepEqual(verdict.resolved["orchestrator:" + environment].bindings, [
      "MORROW_ENVIRONMENT",
    ]);
    assert.deepEqual(verdict.resolved["orchestrator:" + environment].services, [
      { binding: "BROKER", service: `morrow-${environment}-broker`, entrypoint: "RuntimeBroker" },
    ]);
    // P04.T01i PR-D part 1: only the staging api and broker carry configuration vars.
    assert.deepEqual(
      verdict.resolved["api:" + environment].bindings,
      edgeVarNames("api", environment),
    );
    // The broker's vars (MORROW_ENVIRONMENT; in staging also its three configuration vars),
    // WORKOS_API_KEY, TURNSTILE_SECRET_KEY (P05.T01ab) and the eight role passwords
    // (P06.T01a adds morrow_api_worker); M2 PR-1 adds the connector's and the
    // orchestrator's role passwords, the vault login's password and the vault KEK (ADR-0022
    // items 7-8). The vault is held in production until the ADR-0007 item 9 custody ADR,
    // so production binds neither vault secret. M5 PR-1's Stripe names join staging only
    // while the Stripe switch is on; it is off (owner decision (c), 2026-10-21), so no
    // Worker binds any Stripe name.
    assert.equal(
      verdict.resolved["broker:" + environment].bindings.length,
      { development: 15, staging: 18, production: 13 }[environment],
      environment,
    );
    assert.ok(verdict.resolved["broker:" + environment].bindings.includes("TURNSTILE_SECRET_KEY"));
    for (const worker of edgeWorkers)
      assert.ok(
        !verdict.resolved[worker.key + ":" + environment].bindings.some((name) =>
          /STRIPE/.test(name),
        ),
        worker.key + ":" + environment,
      );
  }
  assert.equal(verdict.stripeSwitch, "off");
  assert.deepEqual(verdict.reservedWorkerPaths, [...reservedWorkerPaths]);
  assert.deepEqual((await verify(tree())).problems, []);
});

test("AC01: an unknown field such as run_worker_frist, or any wrangler warning, fails", async () => {
  const typo = await verify(
    tree({
      api: (config) => {
        config.assets.run_worker_frist = config.assets.run_worker_first;
        delete config.assets.run_worker_first;
      },
    }),
  );
  assert.ok(codes(typo).includes("EDGE_CONFIG_DIAGNOSTIC"));
  const misplaced = await verify(
    tree({ broker: (config) => (config.env.staging.send_metrics = false) }),
  );
  assert.ok(codes(misplaced).includes("EDGE_CONFIG_DIAGNOSTIC"));
});

test("AC04: cross-environment broker, extra secret or credential name outside the broker fails", async () => {
  const cases = [
    [
      { api: (c) => (c.env.staging.services[0].service = "morrow-development-broker") },
      "EDGE_API_BROKER_BINDING",
    ],
    [{ api: (c) => (c.services[0].entrypoint = "Other") }, "EDGE_API_BROKER_BINDING"],
    [{ api: (c) => delete c.services[0].entrypoint }, "EDGE_API_BROKER_BINDING"],
    [
      { broker: (c) => c.env.production.secrets.required.push("SHOPIFY_API_SECRET") },
      "EDGE_BROKER_SECRETS",
    ],
    [{ broker: (c) => c.secrets.required.splice(5, 1) }, "EDGE_BROKER_SECRETS"],
    // wrangler itself rejects a duplicate required secret, which also fails closed.
    [
      { broker: (c) => c.env.staging.secrets.required.push("WORKOS_API_KEY") },
      "EDGE_CONFIG_UNREADABLE",
    ],
    [
      { connector: (c) => (c.vars.SHOPIFY_API_SECRET = "x") },
      "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
    ],
    [
      { api: (c) => c.secrets.required.push("LOGIN_CAPSULE_KEYRING") },
      "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
    ],
    [
      { orchestrator: (c) => (c.secrets.required = ["OPENAI_API_KEY"]) },
      "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
    ],
    [
      { orchestrator: (c) => (c.secrets.required = ["ANTHROPIC_API_KEY"]) },
      "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
    ],
    [{ api: (c) => (c.vars.ANTHROPIC_BASE_URL = "x") }, "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER"],
    // M5 PR-1: every STRIPE_ name is broker-only, the configuration included.
    [
      { api: (c) => c.env.staging.secrets.required.push("STRIPE_RESTRICTED_KEY") },
      "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
    ],
    [
      { connector: (c) => (c.vars.STRIPE_CONFIGURATION_JSON = "{}") },
      "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
    ],
    [
      { orchestrator: (c) => (c.secrets.required = ["STRIPE_WEBHOOK_SECRET"]) },
      "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
    ],
    // Production holds Stripe until the production custody ADR; development never carries
    // it; and with the switch off (committed) staging carries none either.
    [
      { broker: (c) => c.env.production.secrets.required.push("STRIPE_RESTRICTED_KEY") },
      "EDGE_BROKER_SECRETS",
    ],
    [{ broker: (c) => c.secrets.required.push("STRIPE_WEBHOOK_SECRET") }, "EDGE_BROKER_SECRETS"],
    [
      { broker: (c) => c.env.staging.secrets.required.push("STRIPE_RESTRICTED_KEY") },
      "EDGE_STRIPE_SWITCH_MIXED",
    ],
    // M2 PR-1: the vault KEK is broker-only (ADR-0022 item 7).
    [
      { connector: (c) => c.env.staging.secrets.required.push("MORROW_VAULT_KEK_V1") },
      "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
    ],
    [
      { orchestrator: (c) => (c.secrets.required = ["MORROW_VAULT_KEK_V1"]) },
      "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
    ],
    [
      {
        broker: (c) =>
          c.secrets.required.splice(c.secrets.required.indexOf("MORROW_VAULT_KEK_V1"), 1),
      },
      "EDGE_BROKER_SECRETS",
    ],
    // Production holds the vault until the production custody ADR: requiring a KEK or the
    // vault login's password there fails the check.
    [
      { broker: (c) => c.env.production.secrets.required.push("MORROW_VAULT_KEK_V1") },
      "EDGE_BROKER_SECRETS",
    ],
    [
      {
        broker: (c) =>
          c.env.production.secrets.required.push("MORROW_DB_PASSWORD_MORROW_VAULT_BROKER"),
      },
      "EDGE_BROKER_SECRETS",
    ],
    [{ api: (c) => (c.workers_dev = true) }, "EDGE_FLAG_WORKERS_DEV"],
    [{ connector: (c) => (c.env.production.preview_urls = true) }, "EDGE_FLAG_PREVIEW_URLS"],
    [{ broker: (c) => (c.observability.enabled = true) }, "EDGE_FLAG_OBSERVABILITY"],
    [{ orchestrator: (c) => (c.upload_source_maps = true) }, "EDGE_FLAG_UPLOAD_SOURCE_MAPS"],
    [{ api: (c) => (c.compatibility_flags = ["nodejs_compat"]) }, "EDGE_COMPATIBILITY"],
    [{ broker: (c) => (c.compatibility_date = "2026-07-31") }, "EDGE_COMPATIBILITY"],
    [{ connector: (c) => (c.env.staging.name = "morrow-staging-connector-x") }, "EDGE_WORKER_NAME"],
    [
      { api: (c) => (c.kv_namespaces = [{ binding: "KV", id: "x" }]) },
      "EDGE_UNEXPECTED_BINDING_KV_NAMESPACES",
    ],
    [
      { broker: (c) => (c.services = [{ binding: "API", service: "morrow-development-api" }]) },
      "EDGE_UNEXPECTED_BINDING_SERVICES",
    ],
    [
      {
        orchestrator: (c) =>
          (c.queues.producers = [{ binding: "Q", queue: "morrow-development-dispatch" }]),
      },
      "EDGE_ORCHESTRATOR_BINDINGS",
    ],
    [
      { broker: (c) => (c.vars.LOGIN_CLIENT = "client_" + "A".repeat(26)) },
      "EDGE_COMMITTED_IDENTIFIER_WORKOS_CLIENT",
    ],
    // M5 PR-1: Stripe markers are never committed, even on the broker.
    [
      { broker: (c) => (c.vars.NOTE = "rk_" + "test_" + "A".repeat(24)) },
      "EDGE_COMMITTED_IDENTIFIER_STRIPE_RESTRICTED_KEY",
    ],
    [
      { broker: (c) => (c.vars.NOTE = "whsec_" + "A".repeat(24)) },
      "EDGE_COMMITTED_IDENTIFIER_STRIPE_WEBHOOK_SECRET",
    ],
    [
      { broker: (c) => (c.env.staging.vars.NOTE = "bpc_" + "A".repeat(24)) },
      "EDGE_COMMITTED_IDENTIFIER_STRIPE_PORTAL_CONFIGURATION",
    ],
    // The reviewed portal configuration var is the staging broker's only, and only while
    // the switch is on; so is the switch's mode var (the api's and the broker's).
    [{ broker: (c) => (c.vars.STRIPE_CONFIGURATION_JSON = "{}") }, "EDGE_VARS"],
    [{ broker: (c) => (c.env.production.vars.STRIPE_CONFIGURATION_JSON = "{}") }, "EDGE_VARS"],
    [{ api: (c) => (c.env.staging.vars.MORROW_STRIPE_MODE = "test") }, "EDGE_STRIPE_SWITCH_MIXED"],
    [{ connector: (c) => (c.vars.MORROW_STRIPE_MODE = "test") }, "EDGE_STRIPE_SWITCH_MIXED"],
    [
      { api: (c) => (c.routes = [{ pattern: "example.test/*", zone_name: "example.test" }]) },
      "EDGE_ROUTES",
    ],
    [{ api: (c) => c.assets.run_worker_first.push("/admin/*") }, "EDGE_API_ASSETS"],
    [{ api: (c) => (c.assets.binding = "ASSETS") }, "EDGE_API_ASSETS"],
    [{ api: (c) => (c.dev.ip = "0.0.0.0") }, "EDGE_API_DEV"],
    [{ api: (c) => (c.env.staging.vars.MORROW_ENVIRONMENT = "production") }, "EDGE_VARS"],
    // P05.T01ab: the limiter bindings are exact per environment.
    [{ api: (c) => (c.ratelimits[0].simple.limit = 100) }, "EDGE_API_RATELIMITS"],
    [{ api: (c) => (c.env.staging.ratelimits[2].namespace_id = "7003") }, "EDGE_API_RATELIMITS"],
    [{ api: (c) => c.env.production.ratelimits.pop() }, "EDGE_API_RATELIMITS"],
    [{ api: (c) => delete c.env.staging.ratelimits }, "EDGE_API_RATELIMITS"],
    [{ api: (c) => (c.ratelimits[1].simple.period = 10) }, "EDGE_API_RATELIMITS"],
    // The session routes' limiter: exact too, never another environment's or the connector's.
    [{ api: (c) => (c.env.staging.ratelimits[3].namespace_id = "7006") }, "EDGE_API_RATELIMITS"],
    [{ api: (c) => (c.env.staging.ratelimits[3].namespace_id = "7104") }, "EDGE_API_RATELIMITS"],
    [{ api: (c) => (c.env.production.ratelimits[3].simple.limit = 1200) }, "EDGE_API_RATELIMITS"],
    [{ api: (c) => (c.ratelimits = c.ratelimits.slice(0, 3)) }, "EDGE_API_RATELIMITS"],
    [
      { broker: (c) => (c.ratelimits = structuredClone(edgeRateLimits("development"))) },
      "EDGE_UNEXPECTED_BINDING_RATELIMITS",
    ],
    // M2 PR-2 review: the connector's ingress limiters are exact per environment.
    [{ connector: (c) => (c.ratelimits[0].simple.limit = 1000) }, "EDGE_CONNECTOR_RATELIMITS"],
    [{ connector: (c) => delete c.env.staging.ratelimits }, "EDGE_CONNECTOR_RATELIMITS"],
    [
      { connector: (c) => (c.env.production.ratelimits[1].namespace_id = "7201") },
      "EDGE_CONNECTOR_RATELIMITS",
    ],
    [
      {
        orchestrator: (c) =>
          (c.ratelimits = structuredClone(edgeConnectorRateLimits("development"))),
      },
      "EDGE_UNEXPECTED_BINDING_RATELIMITS",
    ],
    // M2 PR-3: the connector's one cron trigger, exact per environment; no other Worker has
    // a trigger.
    [{ connector: (c) => (c.triggers.crons = ["* * * * *"]) }, "EDGE_CONNECTOR_TRIGGERS"],
    [{ connector: (c) => (c.env.production.triggers = { crons: [] }) }, "EDGE_CONNECTOR_TRIGGERS"],
    [
      { connector: (c) => c.env.staging.triggers.crons.push("0 * * * *") },
      "EDGE_CONNECTOR_TRIGGERS",
    ],
    [{ api: (c) => (c.triggers = { crons: ["*/5 * * * *"] }) }, "EDGE_UNEXPECTED_BINDING_TRIGGERS"],
    [
      {
        broker: (c) =>
          (c.env.staging.secrets.required = c.env.staging.secrets.required
            .slice(0, 1)
            .concat(c.env.staging.secrets.required.slice(2))),
      },
      "EDGE_BROKER_SECRETS",
    ],
    [
      { api: (c) => (c.env.staging.vars.TURNSTILE_SECRET_KEY = "0x" + "A".repeat(30)) },
      "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
    ],
  ];
  for (const [index, [mutate, expected]] of cases.entries()) {
    const found = codes(await verify(tree(mutate)));
    assert.ok(found.includes(expected), index + ": " + expected + " not in " + found.join(","));
  }
});

test("AC22 (static): run_worker_first is the shared list and no SPA route is shadowed", async () => {
  // P05.T01x adds the exact account routes; `/` stays the SPA's account route.
  assert.deepEqual(
    [...reservedWorkerPaths],
    [
      "/auth",
      "/auth/*",
      "/workspace",
      "/workspace/*",
      "/workspaces",
      "/organizations",
      "/api",
      "/api/*",
      "/healthz",
    ],
  );
  const routes = JSON.parse(readFileSync("docs/contracts/workspace-routes.json", "utf8"));
  const shadowing = join(scratch, "routes.json");
  writeFileSync(
    shadowing,
    JSON.stringify({
      ...routes,
      routes: [...routes.routes, { id: "shadow", pattern: "/api/export" }],
    }),
  );
  const verdict = await verify(tree(), shadowing);
  assert.deepEqual(verdict.problems, ["EDGE_ROUTE_SHADOWED_BY_WORKER:shadow"]);
  const headers = readFileSync("apps/workspace-web/public/_headers", "utf8");
  for (const line of [
    // P05.T01ab: exactly challenges.cloudflare.com for the Turnstile script and frame.
    "Content-Security-Policy: default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: no-referrer",
    "Cross-Origin-Opener-Policy: same-origin",
    "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
    "Cache-Control: public, max-age=31536000, immutable",
  ])
    assert.ok(headers.includes("  " + line + "\n"), line);
});

test("AC24: the scanner flags sk_ and npg_ markers in .dev.vars and wrangler.jsonc and skips .wrangler/", () => {
  const root = join(scratch, "planted");
  mkdirSync(join(root, "apps/broker/.wrangler/state"), { recursive: true });
  mkdirSync(join(root, "apps/api"), { recursive: true });
  const key = ["sk", "test", "Q".repeat(24)].join("_");
  const password = ["npg", "R".repeat(16)].join("_");
  writeFileSync(join(root, "apps/broker/.dev.vars"), "WORKOS_API_KEY=" + key + "\n");
  writeFileSync(
    join(root, "apps/broker/.dev.vars.staging"),
    "MORROW_DB_PASSWORD_MORROW_API=" + password + "\n",
  );
  writeFileSync(join(root, "apps/api/wrangler.jsonc"), '{ "vars": { "X": "' + password + '" } }\n');
  writeFileSync(join(root, "apps/broker/.wrangler/state/cache.json"), '{"k":"' + key + '"}');
  const { paths, findings } = scanSecrets(root);
  assert.deepEqual(
    findings.sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "apps/api/wrangler.jsonc", kind: "neon_password" },
      { path: "apps/broker/.dev.vars", kind: "workos_key" },
      { path: "apps/broker/.dev.vars.staging", kind: "neon_password" },
    ],
  );
  assert.ok(!paths.some((path) => path.includes(".wrangler")));
  assert.ok(
    JSON.stringify(findings).indexOf(key) < 0 && JSON.stringify(findings).indexOf(password) < 0,
  );
});

test("wrangler children get a scrubbed environment and refuse local secrets or Cloudflare tokens", () => {
  const env = edgeChildEnvironment("/tmp/isolated-home", {
    PATH: "/bin",
    HOME: "/Users/owner",
    LANG: "C",
    WORKOS_API_KEY: "x",
    MORROW_DB_PASSWORD_MORROW_API: "y",
    CLOUDFLARE_API_TOKEN: "z",
    NODE_OPTIONS: "--inspect",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "CLOUDFLARE_CF_FETCH_ENABLED",
    "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV",
    "HOME",
    "LANG",
    "PATH",
    "WRANGLER_CACHE_DIR",
    "WRANGLER_HIDE_BANNER",
    "WRANGLER_SEND_METRICS",
    "npm_registry",
  ]);
  assert.equal(env.HOME, "/tmp/isolated-home");
  assert.equal(env.WRANGLER_SEND_METRICS, "false");
  const root = join(scratch, "refusals");
  mkdirSync(join(root, "apps/broker"), { recursive: true });
  assert.deepEqual(edgeRefusals(root, {}), []);
  writeFileSync(join(root, "apps/broker/.dev.vars"), "");
  writeFileSync(join(root, "apps/broker/.env.local"), "");
  assert.deepEqual(
    edgeRefusals(root, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" }).sort(),
    [
      "EDGE_CLOUDFLARE_CREDENTIAL_SET:CLOUDFLARE_ACCOUNT_ID",
      "EDGE_CLOUDFLARE_CREDENTIAL_SET:CLOUDFLARE_API_TOKEN",
      "EDGE_LOCAL_SECRET_FILE:apps/broker/.dev.vars",
      "EDGE_LOCAL_SECRET_FILE:apps/broker/.env.local",
    ],
  );
  assert.deepEqual(edgeRefusals(resolve("."), {}), []);
});

test("a .env or .dev.vars at the repository root, or in a run's working directory, is refused", () => {
  const root = join(scratch, "root-dotenv");
  mkdirSync(join(root, "apps/api"), { recursive: true });
  writeFileSync(join(root, ".env"), "CLOUDFLARE_API_TOKEN=planted\n");
  writeFileSync(join(root, ".dev.vars.staging"), "");
  assert.deepEqual(edgeRefusals(root, {}), [
    "EDGE_LOCAL_SECRET_FILE:.dev.vars.staging",
    "EDGE_LOCAL_SECRET_FILE:.env",
  ]);
  assert.throws(() => runWrangler(["--version"], { cwd: root }), {
    message: "EDGE_REFUSED: EDGE_LOCAL_SECRET_FILE:.dev.vars.staging, EDGE_LOCAL_SECRET_FILE:.env",
  });
});

test("every wrangler child gets an empty --env-file, so a planted root .env never reaches it", () => {
  const home = join(scratch, "invocation-home");
  mkdirSync(home);
  const invocation = wranglerInvocation(["deploy", "--dry-run"], home);
  const flag = "--env-file=" + join(home, "empty.env");
  assert.equal(invocation.args.at(-1), flag);
  assert.equal(readFileSync(join(home, "empty.env"), "utf8"), "");
  assert.ok(
    !wranglerInvocation(["types"], home, { envFile: false }).args.some((arg) =>
      arg.startsWith("--env-file"),
    ),
  );
  // A scratch project (outside the checkout) whose root .env sets WRANGLER_LOG=debug.
  // The refusal is bypassed on purpose: this is the second layer on its own.
  const project = join(scratch, "dotenv-project");
  mkdirSync(project);
  writeFileSync(join(project, ".env"), "WRANGLER_LOG=debug\n");
  writeFileSync(join(project, "worker.js"), "export default { fetch: () => new Response('') };\n");
  writeFileSync(
    join(project, "wrangler.jsonc"),
    JSON.stringify({ name: "dotenv-probe", main: "worker.js", compatibility_date: "2026-07-30" }),
  );
  const dryRun = (envFile) => {
    const childHome = mkdtempSync(join(scratch, "probe-home-"));
    const run = wranglerInvocation(
      ["deploy", "--dry-run", "--outdir=" + join(childHome, "out")],
      childHome,
      { envFile },
    );
    const result = spawnSync(process.execPath, run.args, {
      cwd: project,
      env: run.env,
      encoding: "utf8",
      timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout + result.stderr;
  };
  // WRANGLER_LOG=debug shows as "Metrics dispatcher: ..." lines.
  assert.match(
    dryRun(false),
    /Metrics dispatcher/,
    "negative control: without --env-file the root .env applies",
  );
  const isolated = dryRun(true);
  assert.doesNotMatch(isolated, /Metrics dispatcher/);
  assert.match(isolated, /--dry-run: exiting now\./);
});

test("dev binding tables are parsed per Worker", () => {
  const output = [
    "morrow-development-api has access to the following bindings:",
    "Binding                     Resource                  Mode",
    "env.BROKER (morrow-development-broker#ApiBroker)   Worker   local [not connected]",
    'env.MORROW_ENVIRONMENT ("development")   Environment Variable   local',
    "",
    "morrow-development-broker has access to the following bindings:",
    "Binding                     Resource                  Mode",
    'env.MORROW_ENVIRONMENT ("development")   Environment Variable   local',
    'env.WORKOS_API_KEY ("(hidden)")   Environment Variable   local',
    "",
  ].join("\n");
  assert.deepEqual(devBindingTables(output), {
    "morrow-development-api": ["BROKER", "MORROW_ENVIRONMENT"],
    "morrow-development-broker": ["MORROW_ENVIRONMENT", "WORKOS_API_KEY"],
  });
});

test("AC05 (rules): bundle exclusions name the forbidden inputs", () => {
  const [api, broker] = edgeWorkers;
  assert.deepEqual(
    bundleExclusions(api, ["apps/api/src/deployed-worker.ts"], "export default {}"),
    [],
  );
  assert.deepEqual(
    bundleExclusions(
      api,
      [
        "apps/broker/src/index.ts",
        "node_modules/ajv/dist/compile/index.js",
        "node_modules/unenv/dist/runtime/node/http.mjs",
      ],
      'import "node:http";',
    ),
    ["broker_source", "ajv_compile", "node_http", "node_http_import"],
  );
  assert.deepEqual(
    bundleExclusions(
      broker,
      [
        "node_modules/@neondatabase/serverless/index.mjs",
        "packages/identity/src/controlled-neon-login-pool.ts",
        "packages/contracts/src/generated/runtime-validators.mjs",
        "apps/api/src/worker.ts",
      ],
      "",
    ),
    // M2 PR-2: the Neon driver is the vault login's own transport (vault-database.ts).
    ["neon_pool", "runtime_validators", "api_source"],
  );
  // No @shopify/ library is ever deployed (ADR-0008 item 1 as amended, owner answer 4):
  // not in the broker, which hand-writes its Shopify calls, and not in the api.
  assert.deepEqual(
    bundleExclusions(broker, ["node_modules/@shopify/shopify-api/dist/esm/index.mjs"], ""),
    ["shopify_library"],
  );
  assert.deepEqual(
    bundleExclusions(api, ["node_modules/@shopify/admin-api-client/dist/index.mjs"], ""),
    ["shopify_library"],
  );
  // M2 PR-2: the connector may include only its reviewed packages/ allowlist, never
  // another Worker's source, the validators or a Shopify library (ADR-0008 item 1).
  const connector = edgeWorkers.find((worker) => worker.key === "connector");
  assert.equal(connector.entry, "worker/index.ts");
  assert.deepEqual(
    bundleExclusions(
      connector,
      [
        "apps/shopify-connector/worker/index.ts",
        "node_modules/@neondatabase/serverless/index.mjs",
        "packages/identity/src/broker-protocol.ts",
        "packages/identity/src/edge-limiter.ts",
        "packages/identity/src/executor-role-preflight.ts",
        "packages/identity/src/standalone-login-protocol.ts",
        "packages/identity/src/workos-session-status-json.ts",
      ],
      "",
    ),
    [],
  );
  assert.deepEqual(
    bundleExclusions(
      connector,
      [
        "apps/broker/src/vault.ts",
        "packages/contracts/src/generated/runtime-validators.mjs",
        "node_modules/@shopify/shopify-api/dist/esm/index.mjs",
        "packages/identity/src/controlled-neon-login-pool.ts",
      ],
      "",
    ),
    ["other_worker_source", "runtime_validators", "shopify_library", "package_source"],
  );
});

test("AC02 (rules): bundle size bounds; the broker is at most 384 KiB minified", () => {
  // 2026-10-22: 256 KiB until M2 PR-3 plus M3 PR-2 measured 264,479 bytes.
  assert.deepEqual(edgeBundleLimits, {
    apiGzipBytes: 3_145_728,
    apiWarnGzipBytes: 1_048_576,
    brokerBytes: 393_216,
    orchestratorGzipBytes: 3_145_728,
  });
  assert.ok(Object.isFrozen(edgeBundleLimits));
  const row = (worker, bytes, gzipBytes) => ({ worker, bytes, gzipBytes });
  assert.equal(bundleSizeFailure(row("broker", 264_479, 90_000)), null);
  assert.equal(bundleSizeFailure(row("broker", 393_216, 130_000)), null);
  assert.equal(bundleSizeFailure(row("broker", 393_217, 130_000)), "EDGE_BROKER_BUNDLE_TOO_LARGE");
  // The broker bound is on raw bytes, the api's and (M3 PR-2) the orchestrator's on gzipped
  // bytes; the connector has none.
  assert.equal(bundleSizeFailure(row("api", 9_000_000, 3_145_728)), null);
  assert.equal(bundleSizeFailure(row("api", 9_000_000, 3_145_729)), "EDGE_API_BUNDLE_TOO_LARGE");
  assert.equal(bundleSizeFailure(row("connector", 9_000_000, 9_000_000)), null);
  assert.equal(bundleSizeFailure(row("orchestrator", 9_000_000, 3_145_728)), null);
  assert.equal(
    bundleSizeFailure(row("orchestrator", 9_000_000, 3_145_729)),
    "EDGE_ORCHESTRATOR_BUNDLE_TOO_LARGE",
  );
});

test("M2 PR-2 review: the connector's ingress limiter bindings, exact per environment", () => {
  const expected = (base) => [
    { name: "INSTALL_LIMITER", namespace_id: String(base), simple: { limit: 20, period: 60 } },
    { name: "WEBHOOK_LIMITER", namespace_id: String(base + 1), simple: { limit: 300, period: 60 } },
  ];
  assert.deepEqual(edgeConnectorRateLimits("development"), expected(7004));
  assert.deepEqual(edgeConnectorRateLimits("staging"), expected(7104));
  assert.deepEqual(edgeConnectorRateLimits("production"), expected(7204));
  const config = parseConfig(readFileSync("apps/shopify-connector/wrangler.jsonc", "utf8"));
  assert.deepEqual(config.ratelimits, expected(7004));
  assert.deepEqual(config.env.staging.ratelimits, expected(7104));
  assert.deepEqual(config.env.production.ratelimits, expected(7204));
  // No namespace is shared with the api's sign-in limiters.
  const namespaces = edgeEnvironments.flatMap((environment) =>
    [...edgeRateLimits(environment), ...edgeConnectorRateLimits(environment)].map(
      (limiter) => limiter.namespace_id,
    ),
  );
  assert.equal(new Set(namespaces).size, namespaces.length);
});

test("P05.T01ab: the api's limiter bindings are the packet's D1 values and the session limit", () => {
  const expected = (base) => [
    { name: "LOGIN_START_LIMITER", namespace_id: String(base), simple: { limit: 10, period: 60 } },
    {
      name: "LOGIN_CALLBACK_LIMITER",
      namespace_id: String(base + 1),
      simple: { limit: 20, period: 60 },
    },
    { name: "SIGNUP_LIMITER", namespace_id: String(base + 2), simple: { limit: 5, period: 60 } },
    // The session routes' limiter (apps/api/src/session-limit.ts): after the connector's block.
    {
      name: "SESSION_LIMITER",
      namespace_id: String(base + 5),
      simple: { limit: 120, period: 60 },
    },
  ];
  assert.deepEqual(edgeRateLimits("development"), expected(7001));
  assert.deepEqual(edgeRateLimits("staging"), expected(7101));
  assert.deepEqual(edgeRateLimits("production"), expected(7201));
  const config = parseConfig(readFileSync("apps/api/wrangler.jsonc", "utf8"));
  assert.deepEqual(config.ratelimits, expected(7001));
  assert.deepEqual(config.env.staging.ratelimits, expected(7101));
  assert.deepEqual(config.env.production.ratelimits, expected(7201));
  // P04.T01i PR-D part 1: the challenge configuration (the site key) is staging's only.
  for (const environment of [config, config.env.production])
    assert.deepEqual(Object.keys(environment.vars), ["MORROW_ENVIRONMENT"]);
  assert.deepEqual(Object.keys(config.env.staging.vars), edgeVarNames("api", "staging"));
});

// ---------------------------------------------------------------------------
// P04.T01i AC01 and AC02 (PR-D part 1): the staging settings, the var allowlists and the
// reviewed staging values. Every case starts from the committed configuration.
const committedStaging = JSON.parse(readFileSync("infra/environments/staging.json", "utf8"));
const committedWorkos = JSON.parse(readFileSync("docs/decisions/workos-staging.json", "utf8"));
const committedStripe = JSON.parse(readFileSync("docs/decisions/stripe-staging.json", "utf8"));
const committedModel = JSON.parse(
  readFileSync("docs/decisions/model-provider-staging.json", "utf8"),
);
const committedRuntime = JSON.parse(readFileSync("docs/decisions/runtime-staging.json", "utf8"));
const stagingOrigin = committedStaging.cloudflare.origin;
const reviewedClient = committedWorkos.client_id;
// Rewrites one JSON var: `patch` replaces members, keeping the others in place.
const patchVar = (vars, name, patch) =>
  (vars[name] = JSON.stringify({ ...JSON.parse(vars[name]), ...patch }));
// Rewrites a member of the login configuration's nested binding or profile JSON.
const patchNested = (vars, member, patch) => {
  const login = JSON.parse(vars.LOGIN_CONFIGURATION_JSON);
  login[member] = JSON.stringify({ ...JSON.parse(login[member]), ...patch });
  vars.LOGIN_CONFIGURATION_JSON = JSON.stringify(login);
};
// The same edit on the api's and the broker's staging vars (the shared vars stay equal).
const both = (edit) => ({
  api: (c) => edit(c.env.staging.vars),
  broker: (c) => edit(c.env.staging.vars),
});
// The record files, each patched; `evidence: false` leaves out the runtime record's
// qualification file, which is otherwise written under the returned evidenceRoot.
const records = (patch = {}, { evidence = true } = {}) => {
  const path = join(scratch, "records-" + ++copies);
  mkdirSync(path);
  const staging = structuredClone(committedStaging);
  patch.staging?.(staging);
  const workos = structuredClone(committedWorkos);
  patch.workos?.(workos);
  const stripe = structuredClone(committedStripe);
  patch.stripe?.(stripe);
  const model = structuredClone(committedModel);
  patch.model?.(model);
  const runtime = structuredClone(committedRuntime);
  patch.runtime?.(runtime);
  writeFileSync(join(path, "staging.json"), JSON.stringify(staging));
  writeFileSync(join(path, "workos-staging.json"), JSON.stringify(workos));
  writeFileSync(join(path, "stripe-staging.json"), JSON.stringify(stripe));
  writeFileSync(join(path, "model-provider-staging.json"), JSON.stringify(model));
  writeFileSync(join(path, "runtime-staging.json"), JSON.stringify(runtime));
  if (evidence && typeof runtime.qualification_record === "string") {
    mkdirSync(join(path, "docs/evidence/live"), { recursive: true });
    writeFileSync(join(path, runtime.qualification_record), "# Runtime qualification\n");
  }
  return {
    evidenceRoot: path,
    stagingPath: join(path, "staging.json"),
    workosPath: join(path, "workos-staging.json"),
    stripePath: join(path, "stripe-staging.json"),
    modelPath: join(path, "model-provider-staging.json"),
    runtimePath: join(path, "runtime-staging.json"),
  };
};

test("P04.T01i AC01/AC02: the committed staging blocks are D1's and pass every value rule", async () => {
  const verdict = await verify(resolve("."));
  assert.deepEqual(verdict.problems, []);
  for (const worker of edgeWorkers)
    for (const environment of edgeEnvironments) {
      const config = await resolvedEdgeConfig(worker.key, environment);
      // v1 PR 1 (ADR-0035 item 2): the api and the connector are the public Workers.
      assert.equal(
        config.workers_dev,
        ["api", "connector"].includes(worker.key) && environment === "staging",
      );
      assert.equal(config.workers_dev, edgeWorkersDev(worker.key, environment));
      assert.equal(config.preview_urls, false);
      assert.deepEqual(config.observability, edgeObservability(environment));
      assert.deepEqual(Object.keys(config.vars ?? {}), edgeVarNames(worker.key, environment));
      assert.ok(config.routes === undefined || config.routes.length === 0);
    }
  // D1's exact observability block: Workers Logs on, invocation logs and traces off.
  assert.deepEqual(edgeObservability("staging"), {
    enabled: true,
    head_sampling_rate: 1,
    traces: { enabled: false },
    logs: { enabled: true, invocation_logs: false, head_sampling_rate: 1, persist: true },
  });
  const api = (await resolvedEdgeConfig("api", "staging")).vars;
  const broker = (await resolvedEdgeConfig("broker", "staging")).vars;
  // The broker's two shared vars are byte-equal to the api's.
  assert.equal(broker.LOGIN_CONFIGURATION_JSON, api.LOGIN_CONFIGURATION_JSON);
  assert.equal(broker.MORROW_DATABASE_BINDING_JSON, api.MORROW_DATABASE_BINDING_JSON);
  const login = JSON.parse(api.LOGIN_CONFIGURATION_JSON);
  const authentication = JSON.parse(login.authenticationBindingJson);
  assert.equal(login.origin, "https://morrow-staging-api.sultanibneusman0.workers.dev");
  assert.equal(login.origin, stagingOrigin);
  assert.equal(authentication.redirectUri, stagingOrigin + "/auth/workos/callback");
  assert.deepEqual(
    [authentication.environmentId, authentication.applicationId, authentication.clientId],
    [committedWorkos.environment_id, committedWorkos.application_id, reviewedClient],
  );
  assert.equal(JSON.parse(api.WORKSPACE_CONFIGURATION_JSON).origin, stagingOrigin);
  assert.equal(JSON.parse(api.LOGOUT_CONFIGURATION_JSON).origin, stagingOrigin);
  assert.deepEqual(JSON.parse(api.MORROW_DATABASE_BINDING_JSON), {
    schemaVersion: 1,
    environment: "staging",
    projectId: committedStaging.neon.project_id,
    branchId: committedStaging.neon.branch_id,
    hostname: "ep-hidden-mouse-b7e6ff6l.c-13.us-east-1.aws.neon.tech",
    database: "morrow",
  });
  // v1 PR 1: the connector's own origin and the api's, and the api's database binding.
  const connector = (await resolvedEdgeConfig("connector", "staging")).vars;
  assert.equal(
    connector.CONNECTOR_CONFIGURATION_JSON,
    JSON.stringify({
      schemaVersion: 1,
      origin: "https://morrow-staging-connector.sultanibneusman0.workers.dev",
      apiOrigin: stagingOrigin,
    }),
  );
  assert.equal(connector.MORROW_DATABASE_BINDING_JSON, api.MORROW_DATABASE_BINDING_JSON);
  const challenge = JSON.parse(api.LOGIN_CHALLENGE_JSON);
  const turnstile = JSON.parse(broker.TURNSTILE_CONFIGURATION_JSON);
  assert.equal(challenge.siteKey, "0x4AAAAAAFdwF1eDox4vfBd2");
  assert.equal(turnstile.hostname, new URL(stagingOrigin).hostname);
  assert.equal(JSON.stringify(challenge.actions), JSON.stringify(turnstile.actions));
});

test("P04.T01i AC01: workers.dev, previews, observability and routes are exact per Worker", async () => {
  const cases = [
    [{ api: (c) => (c.env.staging.workers_dev = false) }, "EDGE_FLAG_WORKERS_DEV"],
    // AC01: a broker with workers_dev:true fails.
    [{ broker: (c) => (c.env.staging.workers_dev = true) }, "EDGE_FLAG_WORKERS_DEV"],
    // v1 PR 1: the staging connector is on workers.dev; off, or on in production, fails.
    [{ connector: (c) => (c.env.staging.workers_dev = false) }, "EDGE_FLAG_WORKERS_DEV"],
    [{ connector: (c) => (c.env.production.workers_dev = true) }, "EDGE_FLAG_WORKERS_DEV"],
    [{ connector: (c) => (c.workers_dev = true) }, "EDGE_FLAG_WORKERS_DEV"],
    [{ orchestrator: (c) => (c.env.staging.workers_dev = true) }, "EDGE_FLAG_WORKERS_DEV"],
    [{ api: (c) => (c.env.production.workers_dev = true) }, "EDGE_FLAG_WORKERS_DEV"],
    [{ api: (c) => (c.env.staging.preview_urls = true) }, "EDGE_FLAG_PREVIEW_URLS"],
    [{ broker: (c) => (c.env.staging.preview_urls = true) }, "EDGE_FLAG_PREVIEW_URLS"],
    [
      { api: (c) => (c.env.staging.observability.logs.invocation_logs = true) },
      "EDGE_FLAG_OBSERVABILITY",
    ],
    [
      { broker: (c) => (c.env.staging.observability.traces.enabled = true) },
      "EDGE_FLAG_OBSERVABILITY",
    ],
    [
      { connector: (c) => (c.env.staging.observability.head_sampling_rate = 0.5) },
      "EDGE_FLAG_OBSERVABILITY",
    ],
    [{ broker: (c) => delete c.env.staging.observability.logs.persist }, "EDGE_FLAG_OBSERVABILITY"],
    // Without its own block, a staging Worker inherits development's logging off.
    [{ orchestrator: (c) => delete c.env.staging.observability }, "EDGE_FLAG_OBSERVABILITY"],
    [
      {
        api: (c) => (c.env.production.observability = structuredClone(c.env.staging.observability)),
      },
      "EDGE_FLAG_OBSERVABILITY",
    ],
    [
      {
        orchestrator: (c) =>
          (c.env.staging.routes = [{ pattern: "example.test/*", zone_name: "example.test" }]),
      },
      "EDGE_ROUTES",
    ],
  ];
  for (const [index, [mutate, expected]] of cases.entries()) {
    const found = codes(await verify(tree(mutate)));
    assert.ok(found.includes(expected), index + ": " + expected + " not in " + found.join(","));
  }
});

test("P04.T01i AC01: each Worker's staging vars are exactly its allowlist", async () => {
  const cases = [
    { api: (c) => (c.env.staging.vars.EXTRA_JSON = "{}") },
    { api: (c) => delete c.env.staging.vars.LOGIN_CHALLENGE_JSON },
    { api: (c) => delete c.env.staging.vars.WORKSPACE_CONFIGURATION_JSON },
    // A var must be a string, as the mapper reads it.
    {
      api: (c) =>
        (c.env.staging.vars.LOGIN_CHALLENGE_JSON = JSON.parse(
          c.env.staging.vars.LOGIN_CHALLENGE_JSON,
        )),
    },
    { broker: (c) => delete c.env.staging.vars.TURNSTILE_CONFIGURATION_JSON },
    { broker: (c) => (c.env.staging.vars.WORKSPACE_CONFIGURATION_JSON = "{}") },
    // v1 PR 1: the staging connector's two reviewed identifiers, exactly.
    { connector: (c) => (c.env.staging.vars.EXTRA_JSON = "{}") },
    { connector: (c) => delete c.env.staging.vars.CONNECTOR_CONFIGURATION_JSON },
    { connector: (c) => delete c.env.staging.vars.MORROW_DATABASE_BINDING_JSON },
    { connector: (c) => (c.env.production.vars.CONNECTOR_CONFIGURATION_JSON = "{}") },
    { orchestrator: (c) => (c.env.staging.vars = {}) },
    { orchestrator: (c) => (c.env.staging.vars.NOTE = "x") },
    // Development and production stay unbound.
    { api: (c) => (c.env.production.vars.LOGIN_CHALLENGE_JSON = "{}") },
    { broker: (c) => (c.vars.TURNSTILE_CONFIGURATION_JSON = "{}") },
  ];
  for (const [index, mutate] of cases.entries()) {
    const found = codes(await verify(tree(mutate)));
    assert.ok(found.includes("EDGE_VARS"), index + ": " + found.join(","));
  }
});

// v1 PR 1 (ADR-0035 item 2, amending ADR-0019 item 2 and ADR-0022 item 6): the staging
// connector is the second public Worker. Its CONNECTOR_CONFIGURATION_JSON names exactly its
// own workers.dev origin and the api's, its MORROW_DATABASE_BINDING_JSON is the api's byte
// for byte, and its origin is admitted in that one var only.
test("v1 PR 1: the staging connector's configuration names its own origin and the api's; the binding is the api's", async () => {
  assert.deepEqual([...edgePublicWorkers], ["api", "connector"]);
  const connectorOrigin = "https://morrow-staging-connector.sultanibneusman0.workers.dev";
  const configure = (value) => ({
    connector: (c) => (c.env.staging.vars.CONNECTOR_CONFIGURATION_JSON = value),
  });
  const json = (value) => JSON.stringify({ schemaVersion: 1, ...value });
  const cases = [
    // Another Worker's hostname as the connector's origin, or the api's twice.
    [
      configure(
        json({
          origin: "https://morrow-staging-broker.sultanibneusman0.workers.dev",
          apiOrigin: stagingOrigin,
        }),
      ),
      "EDGE_STAGING_CONNECTOR_CONFIGURATION",
    ],
    [
      configure(json({ origin: stagingOrigin, apiOrigin: stagingOrigin })),
      "EDGE_STAGING_CONNECTOR_CONFIGURATION",
    ],
    // The api origin on another subdomain, a path, plain http, an extra member, or the same
    // values in another member order (not the canonical text).
    [
      configure(
        json({
          origin: connectorOrigin,
          apiOrigin: "https://morrow-staging-api.lab0.workers.dev",
        }),
      ),
      "EDGE_STAGING_CONNECTOR_CONFIGURATION",
    ],
    [
      configure(json({ origin: connectorOrigin + "/shopify", apiOrigin: stagingOrigin })),
      "EDGE_STAGING_CONNECTOR_CONFIGURATION",
    ],
    [
      configure(
        json({ origin: connectorOrigin.replace("https:", "http:"), apiOrigin: stagingOrigin }),
      ),
      "EDGE_STAGING_CONNECTOR_CONFIGURATION",
    ],
    [
      configure(json({ origin: connectorOrigin, apiOrigin: stagingOrigin, note: "x" })),
      "EDGE_STAGING_CONNECTOR_CONFIGURATION",
    ],
    [
      configure(
        JSON.stringify({ apiOrigin: stagingOrigin, origin: connectorOrigin, schemaVersion: 1 }),
      ),
      "EDGE_STAGING_CONNECTOR_CONFIGURATION",
    ],
    [configure("not json"), "EDGE_STAGING_CONNECTOR_CONFIGURATION"],
    // The binding differs from the api's (another database, the same in another order).
    [
      {
        connector: (c) =>
          patchVar(c.env.staging.vars, "MORROW_DATABASE_BINDING_JSON", { database: "other" }),
      },
      "EDGE_STAGING_SHARED_VARS",
    ],
    [
      {
        connector: (c) =>
          (c.env.staging.vars.MORROW_DATABASE_BINDING_JSON = JSON.stringify(
            Object.fromEntries(
              Object.entries(JSON.parse(c.env.staging.vars.MORROW_DATABASE_BINDING_JSON)).reverse(),
            ),
          )),
      },
      "EDGE_STAGING_SHARED_VARS",
    ],
    // The connector's origin anywhere else is an unreviewed URL and hostname.
    [
      {
        api: (c) =>
          patchVar(c.env.staging.vars, "WORKSPACE_CONFIGURATION_JSON", {
            origin: connectorOrigin,
          }),
      },
      "EDGE_STAGING_VALUE_URL",
    ],
  ];
  for (const [index, [mutate, expected]] of cases.entries()) {
    const found = codes(await verify(tree(mutate)));
    assert.ok(found.includes(expected), index + ": " + expected + " not in " + found.join(","));
  }
  // staging.json's connector name must be the connector's resolved staging name.
  const renamed = codes(
    await verify(
      tree(),
      undefined,
      records({ staging: (s) => (s.cloudflare.workers.connector = "morrow-staging-other") }),
    ),
  );
  assert.ok(renamed.includes("EDGE_STAGING_ORIGIN"), renamed.join(","));
});

test("P04.T01i AC01: every origin use is https://<api>.<workers_dev_subdomain>.workers.dev", async () => {
  // Another subdomain everywhere: the values agree with each other, not with staging.json.
  const moved = both((vars) => {
    for (const name of Object.keys(vars))
      vars[name] = vars[name].replaceAll("sultanibneusman0", "lab0");
  });
  const found = codes(await verify(tree(moved)));
  for (const code of [
    "EDGE_STAGING_ORIGIN",
    "EDGE_STAGING_VALUE_URL",
    "EDGE_STAGING_VALUE_HOSTNAME",
  ])
    assert.ok(found.includes(code), code + " not in " + found.join(","));
  const cases = [
    // One use differs: the workspace origin, the logout origin, the redirect base.
    [
      {
        api: (c) =>
          patchVar(c.env.staging.vars, "WORKSPACE_CONFIGURATION_JSON", {
            origin: "https://morrow-staging-api.lab0.workers.dev",
          }),
      },
      "EDGE_STAGING_LOGIN_CONFIGURATION",
    ],
    [
      {
        api: (c) =>
          patchVar(c.env.staging.vars, "LOGOUT_CONFIGURATION_JSON", {
            origin: "https://morrow-staging-broker.sultanibneusman0.workers.dev",
          }),
      },
      "EDGE_STAGING_LOGIN_CONFIGURATION",
    ],
    [
      both((vars) =>
        patchNested(vars, "authenticationBindingJson", {
          redirectUri: stagingOrigin + "/auth/callback",
        }),
      ),
      "EDGE_STAGING_LOGIN_CONFIGURATION",
    ],
    // The Turnstile hostname is the origin's.
    [
      {
        broker: (c) =>
          patchVar(c.env.staging.vars, "TURNSTILE_CONFIGURATION_JSON", {
            hostname: "morrow-staging-broker.sultanibneusman0.workers.dev",
          }),
      },
      "EDGE_STAGING_ORIGIN",
    ],
    // The retention tier is staging's.
    [
      both((vars) => patchVar(vars, "LOGIN_CONFIGURATION_JSON", { retentionTier: "development" })),
      "EDGE_STAGING_LOGIN_CONFIGURATION",
    ],
  ];
  for (const [index, [mutate, expected]] of cases.entries()) {
    const found = codes(await verify(tree(mutate)));
    assert.ok(found.includes(expected), index + ": " + expected + " not in " + found.join(","));
  }
  // staging.json is the source: another origin or subdomain there fails the committed vars.
  for (const patch of [
    { staging: (s) => (s.cloudflare.origin = "https://morrow-staging-api.lab0.workers.dev") },
    { staging: (s) => (s.cloudflare.workers_dev_subdomain = "lab0") },
    { staging: (s) => (s.cloudflare.workers_dev_subdomain = null) },
  ]) {
    const found = codes(await verify(tree(), undefined, records(patch)));
    assert.ok(found.includes("EDGE_STAGING_ORIGIN"), found.join(","));
  }
  const missing = await verify(tree(), undefined, {
    stagingPath: join(scratch, "absent-staging.json"),
  });
  assert.ok(codes(missing).includes("EDGE_STAGING_RECORD_UNREADABLE"));
});

test("P04.T01i AC01: shared vars byte-equal, challenge actions byte-equal, a direct binding", async () => {
  const cases = [
    // The same JSON, other bytes: re-serialized with spaces, or members reordered.
    [
      {
        broker: (c) =>
          (c.env.staging.vars.LOGIN_CONFIGURATION_JSON = JSON.stringify(
            JSON.parse(c.env.staging.vars.LOGIN_CONFIGURATION_JSON),
            null,
            1,
          )),
      },
      "EDGE_STAGING_SHARED_VARS",
    ],
    [
      {
        broker: (c) => {
          const { database, ...rest } = JSON.parse(c.env.staging.vars.MORROW_DATABASE_BINDING_JSON);
          c.env.staging.vars.MORROW_DATABASE_BINDING_JSON = JSON.stringify({ database, ...rest });
        },
      },
      "EDGE_STAGING_SHARED_VARS",
    ],
    [
      {
        broker: (c) =>
          patchVar(c.env.staging.vars, "TURNSTILE_CONFIGURATION_JSON", {
            actions: { signup: "organization_signup", login: "account_login" },
          }),
      },
      "EDGE_STAGING_CHALLENGE_ACTIONS",
    ],
    [
      {
        api: (c) =>
          patchVar(c.env.staging.vars, "LOGIN_CHALLENGE_JSON", {
            actions: { login: "account_login", signup: "workspace_signup" },
          }),
      },
      "EDGE_STAGING_CHALLENGE_ACTIONS",
    ],
    [
      { api: (c) => patchVar(c.env.staging.vars, "LOGIN_CHALLENGE_JSON", { siteKey: "0x1" }) },
      "EDGE_STAGING_CHALLENGE",
    ],
    [
      {
        api: (c) => patchVar(c.env.staging.vars, "LOGIN_CHALLENGE_JSON", { provider: "none" }),
      },
      "EDGE_STAGING_CHALLENGE",
    ],
    // A member twice: JSON.parse keeps the last, the broker's parser refuses it.
    [
      {
        broker: (c) =>
          (c.env.staging.vars.TURNSTILE_CONFIGURATION_JSON =
            c.env.staging.vars.TURNSTILE_CONFIGURATION_JSON.replace(
              "{",
              '{"hostname":"evil.example",',
            )),
      },
      "EDGE_STAGING_CHALLENGE",
    ],
    // The binding: never a -pooler host, the committed project and staging branch only.
    [
      both((vars) =>
        patchVar(vars, "MORROW_DATABASE_BINDING_JSON", {
          hostname: "ep-hidden-mouse-b7e6ff6l-pooler.c-13.us-east-1.aws.neon.tech",
        }),
      ),
      "EDGE_STAGING_BINDING",
    ],
    [
      both((vars) =>
        patchVar(vars, "MORROW_DATABASE_BINDING_JSON", {
          branchId: committedStaging.neon.root_branch_id,
        }),
      ),
      "EDGE_STAGING_BINDING",
    ],
    [
      both((vars) =>
        patchVar(vars, "MORROW_DATABASE_BINDING_JSON", { projectId: "other-project" }),
      ),
      "EDGE_STAGING_BINDING",
    ],
    [
      both((vars) =>
        patchVar(vars, "MORROW_DATABASE_BINDING_JSON", {
          hostname: "ep-hidden-mouse-b7e6ff6l.c-13.eastus2.azure.neon.tech",
        }),
      ),
      "EDGE_STAGING_BINDING",
    ],
    [
      both((vars) => patchVar(vars, "MORROW_DATABASE_BINDING_JSON", { database: "neondb" })),
      "EDGE_STAGING_BINDING",
    ],
    // Other well-formed direct `ep-` hosts than staging.json's endpoint_host: the root
    // branch's (as the PR-D review names it), a one-character change, another cell.
    ...[
      "ep-falling-math-b78o6uzn.c-13.us-east-1.aws.neon.tech",
      "ep-hidden-mouse-b7e6ff6m.c-13.us-east-1.aws.neon.tech",
      "ep-hidden-mouse-b7e6ff6l.c-12.us-east-1.aws.neon.tech",
    ].map((hostname) => [
      both((vars) => patchVar(vars, "MORROW_DATABASE_BINDING_JSON", { hostname })),
      "EDGE_STAGING_BINDING",
    ]),
  ];
  for (const [index, [mutate, expected]] of cases.entries()) {
    const found = codes(await verify(tree(mutate)));
    assert.ok(found.includes(expected), index + ": " + expected + " not in " + found.join(","));
  }
  // staging.json binds another branch or endpoint, or none: the committed binding no longer
  // matches.
  for (const patch of [
    (s) => (s.neon.branch_id = "br-other-branch-a1b2c3d4"),
    (s) => (s.neon.endpoint_host = "ep-falling-math-b78o6uzn.c-13.us-east-1.aws.neon.tech"),
    (s) => (s.neon.endpoint_host = null),
    (s) => delete s.neon.endpoint_host,
  ]) {
    const found = codes(await verify(tree(), undefined, records({ staging: patch })));
    assert.ok(found.includes("EDGE_STAGING_BINDING"), found.join(","));
  }
  // The -pooler refusal holds even when staging.json names the pooler host.
  const pooler = "ep-hidden-mouse-b7e6ff6l-pooler.c-13.us-east-1.aws.neon.tech";
  const pooled = codes(
    await verify(
      tree(both((vars) => patchVar(vars, "MORROW_DATABASE_BINDING_JSON", { hostname: pooler }))),
      undefined,
      records({ staging: (s) => (s.neon.endpoint_host = pooler) }),
    ),
  );
  assert.ok(pooled.includes("EDGE_STAGING_BINDING"), pooled.join(","));
});

test("P04.T01i AC01: the site key is staging.json's widget's; another well-formed 0x key fails", async () => {
  const reviewed = committedStaging.cloudflare.turnstile.site_key;
  assert.equal(reviewed, "0x4AAAAAAFdwF1eDox4vfBd2");
  // A swapped key of the same shape in the committed var.
  const swapped = "0x4AAAAAAFdwF1eDox4vfBd3";
  const found = codes(
    await verify(
      tree({
        api: (c) => patchVar(c.env.staging.vars, "LOGIN_CHALLENGE_JSON", { siteKey: swapped }),
      }),
    ),
  );
  assert.ok(found.includes("EDGE_STAGING_VALUE_SITE_KEY"), found.join(","));
  // staging.json records another key, or none: the committed var no longer matches.
  for (const patch of [
    (s) => (s.cloudflare.turnstile.site_key = swapped),
    (s) => (s.cloudflare.turnstile = null),
    (s) => delete s.cloudflare.turnstile,
  ]) {
    const verdict = await verify(tree(), undefined, records({ staging: patch }));
    assert.deepEqual(verdict.problems, [
      "EDGE_STAGING_VALUE_SITE_KEY:api:staging:LOGIN_CHALLENGE_JSON",
    ]);
  }
});

test("P04.T01i AC01 (P04.T02a AC24 narrowed): staging vars name only the reviewed identifiers", async () => {
  // Fields the parsers accept freely (record ids) carry each other identifier kind.
  const asProfileId = (value) =>
    both((vars) => {
      patchVar(vars, "LOGIN_CONFIGURATION_JSON", { profileId: value });
      if (vars.LOGOUT_CONFIGURATION_JSON)
        patchVar(vars, "LOGOUT_CONFIGURATION_JSON", { profileId: value });
    });
  const cases = [
    [asProfileId("user_" + "A".repeat(26)), "EDGE_STAGING_VALUE_WORKOS_USER"],
    [asProfileId("a".repeat(32)), "EDGE_STAGING_VALUE_CLOUDFLARE_ACCOUNT"],
    [asProfileId(["npg", "R".repeat(16)].join("_")), "EDGE_STAGING_VALUE_NEON_PASSWORD"],
    [asProfileId("br-other-branch-a1b2c3d4"), "EDGE_STAGING_VALUE_NEON_BRANCH"],
    [asProfileId("0x4AAAAAAFdwF1eDox4vfBd2"), "EDGE_STAGING_VALUE_SITE_KEY"],
    [asProfileId("other.workers.dev"), "EDGE_STAGING_VALUE_HOSTNAME"],
    // A well-formed WorkOS client or environment that is not the reviewed one.
    [
      both((vars) => {
        const other = "client_" + "C".repeat(26);
        for (const name of Object.keys(vars))
          vars[name] = vars[name].replaceAll(reviewedClient, other);
      }),
      "EDGE_STAGING_VALUE_WORKOS_CLIENT",
    ],
    [
      both((vars) => {
        const other = "environment_" + "E".repeat(26);
        for (const name of Object.keys(vars))
          vars[name] = vars[name].replaceAll(committedWorkos.environment_id, other);
      }),
      "EDGE_STAGING_VALUE_WORKOS_ENVIRONMENT",
    ],
  ];
  for (const [index, [mutate, expected]] of cases.entries()) {
    const found = codes(await verify(tree(mutate)));
    assert.ok(found.includes(expected), index + ": " + expected + " not in " + found.join(","));
    // The identifier kinds are refused in the committed file text too.
    const committed = expected.replace("EDGE_STAGING_VALUE_", "EDGE_COMMITTED_IDENTIFIER_");
    if (!/SITE_KEY|HOSTNAME/.test(expected))
      assert.ok(found.includes(committed), index + ": " + committed + " not in " + found.join(","));
  }
  // An unreviewed client also makes the issuer an unreviewed URL.
  const issuer = codes(
    await verify(
      tree(),
      undefined,
      records({ workos: (w) => (w.client_id = "client_" + "D".repeat(26)) }),
    ),
  );
  for (const code of [
    "EDGE_STAGING_VALUE_WORKOS_CLIENT",
    "EDGE_STAGING_VALUE_URL",
    "EDGE_COMMITTED_IDENTIFIER_WORKOS_CLIENT",
  ])
    assert.ok(issuer.includes(code), code + " not in " + issuer.join(","));
  // The committed text: a reviewed identifier only inside the api's or the broker's own
  // env.staging.vars values. A comment, another block or a second copy is a remainder.
  const appended = (worker, line) => {
    const root = tree();
    const path = join(root, worker.dir, "wrangler.jsonc");
    writeFileSync(path, readFileSync(path, "utf8") + "\n// " + line + "\n");
    return root;
  };
  const [api, broker, , connector] = edgeWorkers;
  assert.deepEqual((await verify(appended(api, committedStaging.neon.branch_id))).problems, [
    "EDGE_COMMITTED_IDENTIFIER_NEON_BRANCH:api",
  ]);
  assert.deepEqual((await verify(appended(broker, committedStaging.neon.endpoint_host))).problems, [
    "EDGE_COMMITTED_IDENTIFIER_NEON_ENDPOINT:broker",
  ]);
  assert.deepEqual((await verify(appended(api, reviewedClient))).problems, [
    "EDGE_COMMITTED_IDENTIFIER_WORKOS_CLIENT:api",
  ]);
  assert.deepEqual((await verify(appended(connector, committedStaging.neon.branch_id))).problems, [
    "EDGE_COMMITTED_IDENTIFIER_NEON_BRANCH:connector",
  ]);
  // Another block of the same file: the staging binding copied into production's vars.
  const elsewhere = codes(
    await verify(
      tree({
        broker: (c) =>
          (c.env.production.vars.MORROW_DATABASE_BINDING_JSON =
            c.env.staging.vars.MORROW_DATABASE_BINDING_JSON),
      }),
    ),
  );
  for (const code of [
    "EDGE_VARS",
    "EDGE_COMMITTED_IDENTIFIER_NEON_BRANCH",
    "EDGE_COMMITTED_IDENTIFIER_NEON_ENDPOINT",
  ])
    assert.ok(elsewhere.includes(code), code + " not in " + elsewhere.join(","));
  assert.deepEqual((await verify(appended(api, "environment_" + "F".repeat(26)))).problems, [
    "EDGE_COMMITTED_IDENTIFIER_WORKOS_ENVIRONMENT:api",
  ]);
  assert.deepEqual((await verify(appended(api, "79ff672d013b8f0956437af6eea3c213"))).problems, [
    "EDGE_COMMITTED_IDENTIFIER_CLOUDFLARE_ACCOUNT:api",
  ]);
});

// ---------------------------------------------------------------------------
// M5 PR-1: the staging broker's STRIPE_CONFIGURATION_JSON arrives on the reviewed
// identifier path, and with the Stripe switch (owner decision (c), 2026-10-21) only while
// docs/decisions/stripe-staging.json `switch` is "on". The record pins the portal
// configuration id and the tax flags; the var must be byte-equal to the text that record
// admits, and that id is admitted inside that one var only (never another var, block,
// Worker or comment). On, the staging api and broker also carry MORROW_STRIPE_MODE "test"
// and the broker the two Stripe secrets; off, none of it; anything between is mixed.
const reviewedPortal = "bpc_" + "1Rv" + "S".repeat(21);
const withPortal = (stripe) => {
  stripe.portal_configuration_id = reviewedPortal;
  stripe.observed_on = "2026-10-21";
};
const switchedOn = (stripe) => {
  withPortal(stripe);
  stripe.switch = "on";
};
const stripeVar = (patch = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    portalConfigurationId: reviewedPortal,
    automaticTax: false,
    billingAddressCollection: "auto",
    ...patch,
  });
const withStripeVar = (value) => ({
  broker: (c) => (c.env.staging.vars.STRIPE_CONFIGURATION_JSON = value),
});
// The whole "on" state of the committed wrangler files, as one reviewed commit makes it.
const turnedOn = ({ api, broker } = {}) => ({
  api: (c) => {
    c.env.staging.vars.MORROW_STRIPE_MODE = "test";
    api?.(c);
  },
  broker: (c) => {
    c.env.staging.vars.MORROW_STRIPE_MODE = "test";
    c.env.staging.vars.STRIPE_CONFIGURATION_JSON = stripeVar();
    c.env.staging.secrets.required.push("STRIPE_RESTRICTED_KEY", "STRIPE_WEBHOOK_SECRET");
    broker?.(c);
  },
});

test("M5: the committed Stripe record is test mode, switched off, with no portal configuration", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(committedStripe).filter(([key]) => !["scope"].includes(key))),
    {
      schema_version: 1,
      environment_kind: "staging",
      switch: "off",
      mode: "test",
      portal_configuration_id: null,
      automatic_tax: false,
      billing_address_collection: "auto",
      observed_on: null,
    },
  );
  // The names the switch governs: the staging api's mode var; the staging broker's mode
  // var, configuration and two secrets. Nowhere else.
  assert.equal(edgeStripeModeVar, "MORROW_STRIPE_MODE");
  assert.deepEqual(edgeStripeSecretNames, ["STRIPE_RESTRICTED_KEY", "STRIPE_WEBHOOK_SECRET"]);
  assert.deepEqual(edgeStripeVarNames("api", "staging"), ["MORROW_STRIPE_MODE"]);
  assert.deepEqual(edgeStripeVarNames("broker", "staging"), [
    "MORROW_STRIPE_MODE",
    "STRIPE_CONFIGURATION_JSON",
  ]);
  assert.deepEqual(edgeStripeNamesRequired("broker", "staging", "on"), [
    "MORROW_STRIPE_MODE",
    "STRIPE_CONFIGURATION_JSON",
    "STRIPE_RESTRICTED_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]);
  assert.deepEqual(edgeStripeNamesRequired("api", "staging", "on"), ["MORROW_STRIPE_MODE"]);
  for (const worker of ["api", "broker", "connector", "orchestrator"])
    assert.deepEqual(edgeStripeNamesRequired(worker, "staging", "off"), [], worker);
  for (const [worker, environment] of [
    ["broker", "development"],
    ["broker", "production"],
    ["api", "development"],
    ["api", "production"],
    ["connector", "staging"],
    ["orchestrator", "staging"],
  ]) {
    assert.deepEqual(edgeStripeVarNames(worker, environment), [], worker + ":" + environment);
    assert.deepEqual(edgeStripeNamesRequired(worker, environment, "on"), []);
    assert.deepEqual(edgeVarNames(worker, environment, "on"), edgeVarNames(worker, environment));
  }
  assert.deepEqual(edgeVarNames("broker", "staging", "on"), [
    ...edgeVarNames("broker", "staging"),
    "MORROW_STRIPE_MODE",
    "STRIPE_CONFIGURATION_JSON",
  ]);
  // The record admits nothing while off, also with a recorded portal configuration.
  const record = structuredClone(committedStripe);
  assert.deepEqual({ ...reviewedStripeRecord(record) }, { switch: "off", configurationJson: null });
  withPortal(record);
  assert.deepEqual({ ...reviewedStripeRecord(record) }, { switch: "off", configurationJson: null });
  // On: exactly the record's id and flags, in the parser's member order.
  record.switch = "on";
  assert.deepEqual(
    { ...reviewedStripeRecord(record) },
    { switch: "on", configurationJson: stripeVar() },
  );
  for (const edit of [
    (r) => (r.mode = "live"),
    (r) => (r.switch = "test"),
    (r) => (r.switch = true),
    (r) => delete r.switch,
    // On means fully configured: the saved portal configuration is required.
    (r) => {
      r.portal_configuration_id = null;
      r.observed_on = null;
    },
    (r) => (r.portal_configuration_id = "bpc_short"),
    (r) => (r.portal_configuration_id = "bps_" + "S".repeat(24)),
    (r) => (r.observed_on = null),
    (r) => (r.automatic_tax = "false"),
    (r) => (r.billing_address_collection = "never"),
    (r) => (r.extra = true),
  ]) {
    const bad = structuredClone(record);
    edit(bad);
    assert.throws(() => reviewedStripeRecord(bad), /EDGE_STAGING_STRIPE_RECORD/);
  }
});

test("M5: switched off, any Stripe var or secret is a mixed state", async () => {
  // The committed state passes, with or without a recorded portal configuration.
  assert.deepEqual((await verify(tree())).problems, []);
  assert.deepEqual((await verify(tree(), undefined, records({ stripe: withPortal }))).problems, []);
  for (const [index, [mutate, expected]] of [
    // The whole "on" set of the wrangler files without the record's switch.
    [turnedOn(), ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_VARS", "EDGE_BROKER_SECRETS"]],
    // Each part on its own.
    [
      { broker: (c) => (c.env.staging.vars.MORROW_STRIPE_MODE = "test") },
      ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_VARS"],
    ],
    [
      withStripeVar(stripeVar()),
      ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_VARS", "EDGE_STAGING_STRIPE_CONFIGURATION"],
    ],
    [
      {
        broker: (c) =>
          c.env.staging.secrets.required.push("STRIPE_RESTRICTED_KEY", "STRIPE_WEBHOOK_SECRET"),
      },
      ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_BROKER_SECRETS"],
    ],
    [
      { api: (c) => (c.env.staging.vars.MORROW_STRIPE_MODE = "test") },
      ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_VARS"],
    ],
  ].entries()) {
    const found = codes(await verify(tree(mutate), undefined, records({ stripe: withPortal })));
    for (const code of expected)
      assert.ok(found.includes(code), index + ": " + code + " not in " + found.join(","));
  }
});

test("M5: switched on, the full Stripe set is required and the reviewed configuration admitted", async () => {
  const on = records({ stripe: switchedOn });
  // One reviewed commit: the record's switch, both modes, the configuration and both
  // secrets.
  const verdict = await verify(tree(turnedOn()), undefined, on);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.stripeSwitch, "on");
  assert.equal(verdict.resolved["broker:staging"].bindings.length, 22);
  assert.ok(verdict.resolved["api:staging"].bindings.includes("MORROW_STRIPE_MODE"));
  // Development and production stay off with the switch on.
  for (const environment of ["development", "production"])
    assert.ok(
      !verdict.resolved["broker:" + environment].bindings.some((name) => /STRIPE/.test(name)),
    );
  // The switch on with the wrangler files still off.
  assert.ok(codes(await verify(tree(), undefined, on)).includes("EDGE_STRIPE_SWITCH_MIXED"));
  const cases = [
    // Each part missing.
    [
      turnedOn({ api: (c) => delete c.env.staging.vars.MORROW_STRIPE_MODE }),
      ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_VARS"],
    ],
    [
      turnedOn({ broker: (c) => delete c.env.staging.vars.MORROW_STRIPE_MODE }),
      ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_VARS"],
    ],
    [
      turnedOn({ broker: (c) => delete c.env.staging.vars.STRIPE_CONFIGURATION_JSON }),
      ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_VARS"],
    ],
    [
      turnedOn({ broker: (c) => c.env.staging.secrets.required.pop() }),
      ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_BROKER_SECRETS"],
    ],
    // The mode is exactly "test".
    [turnedOn({ api: (c) => (c.env.staging.vars.MORROW_STRIPE_MODE = "live") }), ["EDGE_VARS"]],
    [turnedOn({ broker: (c) => (c.env.staging.vars.MORROW_STRIPE_MODE = "on") }), ["EDGE_VARS"]],
    // Never in development or production, never on another Worker.
    [
      turnedOn({ broker: (c) => (c.vars.MORROW_STRIPE_MODE = "test") }),
      ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_VARS"],
    ],
    [
      turnedOn({ broker: (c) => c.env.production.secrets.required.push("STRIPE_WEBHOOK_SECRET") }),
      ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_BROKER_SECRETS"],
    ],
    [
      { ...turnedOn(), connector: (c) => (c.env.staging.vars.MORROW_STRIPE_MODE = "test") },
      ["EDGE_STRIPE_SWITCH_MIXED", "EDGE_VARS"],
    ],
    // Malformed: the broker's own parser refuses it.
    [
      turnedOn({ broker: (c) => (c.env.staging.vars.STRIPE_CONFIGURATION_JSON = "{}") }),
      ["EDGE_STAGING_STRIPE_CONFIGURATION"],
    ],
    [
      turnedOn({ broker: (c) => (c.env.staging.vars.STRIPE_CONFIGURATION_JSON = "not json") }),
      ["EDGE_STAGING_STRIPE_CONFIGURATION"],
    ],
    // Another well-formed portal configuration than the reviewed one.
    [
      turnedOn({
        broker: (c) =>
          (c.env.staging.vars.STRIPE_CONFIGURATION_JSON = stripeVar({
            portalConfigurationId: "bpc_" + "Other".repeat(5),
          })),
      }),
      [
        "EDGE_STAGING_STRIPE_CONFIGURATION",
        "EDGE_STAGING_VALUE_STRIPE_PORTAL_CONFIGURATION",
        "EDGE_COMMITTED_IDENTIFIER_STRIPE_PORTAL_CONFIGURATION",
      ],
    ],
    // The tax flags are pinned too.
    [
      turnedOn({
        broker: (c) =>
          (c.env.staging.vars.STRIPE_CONFIGURATION_JSON = stripeVar({ automaticTax: true })),
      }),
      ["EDGE_STAGING_STRIPE_CONFIGURATION"],
    ],
    [
      turnedOn({
        broker: (c) =>
          (c.env.staging.vars.STRIPE_CONFIGURATION_JSON = stripeVar({
            billingAddressCollection: "required",
          })),
      }),
      ["EDGE_STAGING_STRIPE_CONFIGURATION"],
    ],
    // Same members, other bytes (spacing): pinned to the exact text.
    [
      turnedOn({
        broker: (c) =>
          (c.env.staging.vars.STRIPE_CONFIGURATION_JSON = JSON.stringify(
            JSON.parse(stripeVar()),
            null,
            1,
          )),
      }),
      ["EDGE_STAGING_STRIPE_CONFIGURATION"],
    ],
    // The reviewed id outside its var: another broker staging var, or the api's.
    [
      turnedOn({
        broker: (c) =>
          patchVar(c.env.staging.vars, "TURNSTILE_CONFIGURATION_JSON", { note: reviewedPortal }),
      }),
      ["EDGE_STAGING_VALUE_STRIPE_PORTAL_CONFIGURATION"],
    ],
    [
      turnedOn({ api: (c) => (c.env.staging.vars.STRIPE_CONFIGURATION_JSON = stripeVar()) }),
      [
        "EDGE_VARS",
        "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
        "EDGE_STRIPE_SWITCH_MIXED",
        "EDGE_STAGING_VALUE_STRIPE_PORTAL_CONFIGURATION",
        "EDGE_COMMITTED_IDENTIFIER_STRIPE_PORTAL_CONFIGURATION",
      ],
    ],
    // Development or production: no Stripe var there.
    [
      turnedOn({ broker: (c) => (c.env.production.vars.STRIPE_CONFIGURATION_JSON = stripeVar()) }),
      ["EDGE_VARS", "EDGE_COMMITTED_IDENTIFIER_STRIPE_PORTAL_CONFIGURATION"],
    ],
  ];
  for (const [index, [mutate, expected]] of cases.entries()) {
    const found = codes(await verify(tree(mutate), undefined, on));
    for (const code of expected)
      assert.ok(found.includes(code), index + ": " + code + " not in " + found.join(","));
  }
  // A record that is not the reviewed shape fails on its own, and counts as off.
  const live = codes(
    await verify(tree(turnedOn()), undefined, records({ stripe: (r) => (r.mode = "live") })),
  );
  assert.ok(live.includes("EDGE_STAGING_STRIPE_RECORD"));
  assert.ok(live.includes("EDGE_STRIPE_SWITCH_MIXED"));
  // A second copy of the reviewed id in the file (a comment) is a remainder.
  const root = tree(turnedOn());
  const path = join(root, "apps/broker/wrangler.jsonc");
  writeFileSync(path, readFileSync(path, "utf8") + "\n// " + reviewedPortal + "\n");
  assert.deepEqual((await verify(root, undefined, on)).problems, [
    "EDGE_COMMITTED_IDENTIFIER_STRIPE_PORTAL_CONFIGURATION:broker",
  ]);
  // An unreadable record is its own problem, and counts as off.
  const missing = records({ stripe: switchedOn });
  rmSync(missing.stripePath);
  const unreadable = (await verify(tree(turnedOn()), undefined, missing)).problems;
  assert.ok(unreadable.includes("EDGE_STAGING_RECORD_UNREADABLE:stripe-staging.json"));
  assert.ok(unreadable.includes("EDGE_STRIPE_SWITCH_MIXED:broker:staging"));
});
// ---------------------------------------------------------------------------
// P04.T01i D1 (placement, 2026-10-21): the staging api and broker run in the region of the
// committed Neon endpoint; no other Worker or environment has placement.
const targeted = (region) => ({ mode: "targeted", region });

test("P04.T01i D1: placement is targeted at staging.json's Neon region on the staging api and broker only", async () => {
  assert.equal(committedStaging.neon.region_id, "aws-us-east-1");
  assert.equal(edgePlacementRegion(committedStaging.neon.region_id), "aws:us-east-1");
  assert.ok(committedStaging.neon.endpoint_host.endsWith(".us-east-1.aws.neon.tech"));
  assert.deepEqual([...edgePlacementWorkers], ["api", "broker"]);
  const verdict = await verify(resolve("."));
  assert.deepEqual(verdict.problems, []);
  for (const worker of edgeWorkers)
    for (const environment of edgeEnvironments) {
      const expected =
        environment === "staging" && edgePlacementWorkers.includes(worker.key)
          ? targeted("aws:us-east-1")
          : undefined;
      assert.deepEqual(
        (await resolvedEdgeConfig(worker.key, environment)).placement,
        expected,
        worker.key + ":" + environment,
      );
      assert.deepEqual(
        verdict.resolved[worker.key + ":" + environment].placement,
        expected ?? null,
      );
    }
  // Neon's AWS region ids map to Cloudflare's; every other shape is refused.
  assert.equal(edgePlacementRegion("aws-eu-central-1"), "aws:eu-central-1");
  assert.equal(edgePlacementRegion("aws-ap-southeast-2"), "aws:ap-southeast-2");
  for (const other of [
    "azure-eastus2",
    "aws:us-east-1",
    "us-east-1",
    "aws-us-east-1 ",
    "AWS-US-EAST-1",
    "aws-us-east-0",
    "",
    null,
    undefined,
    1,
  ])
    assert.equal(edgePlacementRegion(other), null, String(other));
});

test("P04.T01i D1: a staging placement that is missing, not targeted or not exact fails", async () => {
  const cases = [
    { api: (c) => delete c.env.staging.placement },
    { broker: (c) => delete c.env.staging.placement },
    { api: (c) => (c.env.staging.placement = { mode: "smart" }) },
    { broker: (c) => (c.env.staging.placement = { mode: "smart", hint: "aws:us-east-1" }) },
    { api: (c) => (c.env.staging.placement = { mode: "off" }) },
    // wrangler accepts a targeted region without `mode`; the committed text names it.
    { api: (c) => (c.env.staging.placement = { region: "aws:us-east-1" }) },
    {
      broker: (c) => (c.env.staging.placement = { mode: "targeted", host: "db.example.test:5432" }),
    },
    {
      api: (c) => (c.env.staging.placement = { mode: "targeted", hostname: "db.example.test" }),
    },
  ];
  for (const [index, mutate] of cases.entries()) {
    const found = codes(await verify(tree(mutate)));
    assert.ok(found.includes("EDGE_PLACEMENT_STAGING"), index + ": " + found.join(","));
  }
  // Inherited from the top level when the staging block names none.
  const inherited = await verify(
    tree({
      api: (c) => {
        delete c.env.staging.placement;
        c.placement = targeted("aws:us-east-1");
      },
    }),
  );
  assert.deepEqual(inherited.problems.sort(), [
    "EDGE_PLACEMENT_ENVIRONMENT:api:development",
    "EDGE_PLACEMENT_ENVIRONMENT:api:production",
  ]);
});

test("P04.T01i D1: the staging placement region is staging.json's neon.region_id, mapped", async () => {
  for (const region of ["aws:us-east-2", "aws:eu-central-1", "gcp:us-east4", "aws-us-east-1"]) {
    for (const worker of ["api", "broker"]) {
      const verdict = await verify(
        tree({ [worker]: (c) => (c.env.staging.placement = targeted(region)) }),
      );
      assert.deepEqual(verdict.problems, ["EDGE_PLACEMENT_REGION:" + worker + ":staging"], region);
    }
  }
  // staging.json names another region, another cloud or none: the committed placements and
  // the committed endpoint no longer match it.
  for (const patch of [
    (s) => (s.neon.region_id = "aws-eu-central-1"),
    (s) => (s.neon.region_id = "azure-eastus2"),
    (s) => (s.neon.region_id = "aws:us-east-1"),
    (s) => (s.neon.region_id = null),
    (s) => delete s.neon.region_id,
  ]) {
    const verdict = await verify(tree(), undefined, records({ staging: patch }));
    assert.deepEqual(verdict.problems.sort(), [
      "EDGE_PLACEMENT_REGION:api:staging",
      "EDGE_PLACEMENT_REGION:broker:staging",
      "EDGE_PLACEMENT_REGION:staging.json",
    ]);
  }
  // Placements and region_id moved together, the endpoint left in us-east-1: the endpoint
  // must lie in the region too.
  const moved = {
    api: (c) => (c.env.staging.placement = targeted("aws:eu-central-1")),
    broker: (c) => (c.env.staging.placement = targeted("aws:eu-central-1")),
  };
  const stranded = await verify(
    tree(moved),
    undefined,
    records({ staging: (s) => (s.neon.region_id = "aws-eu-central-1") }),
  );
  assert.deepEqual(stranded.problems, ["EDGE_PLACEMENT_REGION:staging.json"]);
  // The rule follows staging.json, not a fixed region: the placements, region_id, the
  // endpoint and both bindings moved together verify cleanly.
  const host = "ep-hidden-mouse-b7e6ff6l.c-13.eu-central-1.aws.neon.tech";
  const all = { ...moved };
  for (const worker of ["api", "broker"])
    all[worker] = (c) => {
      moved[worker](c);
      patchVar(c.env.staging.vars, "MORROW_DATABASE_BINDING_JSON", { hostname: host });
    };
  // v1 PR 1: the connector's copy of the binding moves with the api's.
  all.connector = (c) =>
    patchVar(c.env.staging.vars, "MORROW_DATABASE_BINDING_JSON", { hostname: host });
  const relocated = await verify(
    tree(all),
    undefined,
    records({
      staging: (s) => {
        s.neon.region_id = "aws-eu-central-1";
        s.neon.endpoint_host = host;
      },
    }),
  );
  assert.deepEqual(relocated.problems, []);
});

test("P04.T01i D1: no placement outside the staging api and broker, an explicit off included", async () => {
  const cases = [
    [{ api: (c) => (c.placement = { mode: "smart" }) }, "EDGE_PLACEMENT_ENVIRONMENT"],
    [
      { api: (c) => (c.env.production.placement = targeted("aws:us-east-1")) },
      "EDGE_PLACEMENT_ENVIRONMENT",
    ],
    [{ api: (c) => (c.env.production.placement = { mode: "off" }) }, "EDGE_PLACEMENT_ENVIRONMENT"],
    [{ broker: (c) => (c.placement = targeted("aws:us-east-1")) }, "EDGE_PLACEMENT_ENVIRONMENT"],
    [
      { broker: (c) => (c.env.production.placement = { mode: "smart" }) },
      "EDGE_PLACEMENT_ENVIRONMENT",
    ],
    [
      { connector: (c) => (c.env.staging.placement = targeted("aws:us-east-1")) },
      "EDGE_PLACEMENT_WORKER",
    ],
    [
      { orchestrator: (c) => (c.env.staging.placement = targeted("aws:us-east-1")) },
      "EDGE_PLACEMENT_WORKER",
    ],
    [{ orchestrator: (c) => (c.placement = { mode: "smart" }) }, "EDGE_PLACEMENT_WORKER"],
    [{ connector: (c) => (c.env.production.placement = { mode: "off" }) }, "EDGE_PLACEMENT_WORKER"],
  ];
  for (const [index, [mutate, expected]] of cases.entries()) {
    const found = codes(await verify(tree(mutate)));
    assert.ok(found.includes(expected), index + ": " + expected + " not in " + found.join(","));
    assert.ok(!found.includes("EDGE_UNEXPECTED_BINDING_PLACEMENT"), index + ": " + found.join(","));
  }
});

// ---------------------------------------------------------------------------
// M3 PR-2: the orchestrator's bindings (ListingsRunWorkflow, the RuntimeBroker entrypoint,
// the cron of pending starts), its reviewed package allowlist, and the model-provider
// switch (committed off; the Stripe switch's protocol).
test("M3 PR-2: the orchestrator binds exactly ListingsRunWorkflow, RuntimeBroker and the one-minute cron", async () => {
  for (const environment of edgeEnvironments) {
    const config = await resolvedEdgeConfig("orchestrator", environment);
    assert.deepEqual(config.workflows, [
      {
        name: `morrow-${environment}-listings-run`,
        binding: "LISTINGS_RUN",
        class_name: "ListingsRunWorkflow",
      },
    ]);
    assert.deepEqual(config.triggers, { crons: ["* * * * *"] });
    assert.deepEqual(config.vars, { MORROW_ENVIRONMENT: environment });
  }
  for (const [index, mutate] of [
    { orchestrator: (c) => (c.workflows[0].class_name = "MorrowWorkWorkflow") },
    { orchestrator: (c) => (c.env.staging.workflows[0].name = "morrow-staging-work") },
    { orchestrator: (c) => (c.services[0].entrypoint = "ApiBroker") },
    { orchestrator: (c) => (c.env.staging.services[0].service = "morrow-development-broker") },
    { orchestrator: (c) => delete c.env.production.services },
    { orchestrator: (c) => (c.triggers.crons = ["*/5 * * * *"]) },
    { orchestrator: (c) => (c.env.staging.triggers = { crons: [] }) },
    { orchestrator: (c) => c.workflows.push({ name: "x", binding: "X", class_name: "X" }) },
  ].entries()) {
    const found = codes(await verify(tree(mutate)));
    assert.ok(found.includes("EDGE_ORCHESTRATOR_BINDINGS"), index + ": " + found.join(","));
  }
  // No secret, credential or other binding kind on the orchestrator.
  for (const [mutate, code] of [
    [
      { orchestrator: (c) => (c.vars.ANTHROPIC_API_KEY = "x") },
      "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER",
    ],
    [
      { orchestrator: (c) => (c.kv_namespaces = [{ binding: "KV", id: "x" }]) },
      "EDGE_UNEXPECTED_BINDING_KV_NAMESPACES",
    ],
  ]) {
    const found = codes(await verify(tree(mutate)));
    assert.ok(found.includes(code), code + " not in " + found.join(","));
  }
});

test("M3 PR-2 (AC05): the orchestrator bundles only its reviewed packages/ allowlist", () => {
  const orchestrator = edgeWorkers.find((worker) => worker.key === "orchestrator");
  assert.deepEqual(
    bundleExclusions(
      orchestrator,
      [
        "apps/workers/src/orchestrator.ts",
        "node_modules/@neondatabase/serverless/index.mjs",
        ...orchestratorPackageAllowlist,
      ],
      "",
    ),
    [],
  );
  assert.deepEqual(
    bundleExclusions(
      orchestrator,
      [
        "apps/broker/src/vault.ts",
        "apps/api/src/worker.ts",
        "node_modules/ajv/dist/compile/index.js",
        "node_modules/@shopify/shopify-api/dist/esm/index.mjs",
        "packages/work/src/http.ts",
      ],
      "",
    ),
    ["other_worker_source", "ajv_compile", "shopify_library", "package_source"],
  );
  // The run's own modules, the lease steps and the kernels are on it; no api handler is.
  for (const path of [
    "packages/work/src/runs/workflow.ts",
    "packages/work/src/runtime/leases.ts",
    "packages/policy/src/agent-authority.ts",
    // Each run's call budget comes from the catalogue's data, not its rules module.
    "packages/policy/src/generated/model-catalogue.ts",
  ])
    assert.ok(orchestratorPackageAllowlist.includes(path), path);
  for (const path of [
    "packages/policy/src/model-catalogue.ts",
    "packages/work/src/runs/http.ts",
    "packages/work/src/runs/commands.ts",
    "packages/work/src/agents/commands.ts",
  ])
    assert.ok(!orchestratorPackageAllowlist.includes(path), path);
});

const modelOn = (r) => {
  r.switch = "on";
  r.monthly_spend_limit_usd = "50.00";
  r.observed_on = "2026-10-22";
};
const modelTurnedOn = ({ api, broker, orchestrator } = {}) => ({
  api: (c) => {
    c.env.staging.vars.MORROW_MODEL_PROVIDER = "anthropic";
    api?.(c);
  },
  broker: (c) => {
    c.env.staging.vars.MORROW_MODEL_PROVIDER = "anthropic";
    c.env.staging.secrets.required.push("ANTHROPIC_API_KEY");
    broker?.(c);
  },
  orchestrator: (c) => {
    c.env.staging.vars.MORROW_MODEL_PROVIDER = "anthropic";
    // The binding byte-equal to the api's (the reviewed staging identifiers).
    c.env.staging.vars.MORROW_DATABASE_BINDING_JSON = committedApiBinding;
    orchestrator?.(c);
  },
});
const committedApiBinding = parseConfig(readFileSync("apps/api/wrangler.jsonc", "utf8")).env.staging
  .vars.MORROW_DATABASE_BINDING_JSON;

test("M3 PR-2: the committed model-provider record is off, and the record rule", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(committedModel).filter(([key]) => key !== "scope")),
    {
      schema_version: 1,
      environment_kind: "staging",
      provider: "anthropic",
      switch: "off",
      monthly_spend_limit_usd: null,
      observed_on: null,
    },
  );
  assert.deepEqual({ ...reviewedModelRecord(committedModel) }, { switch: "off" });
  const on = structuredClone(committedModel);
  modelOn(on);
  assert.deepEqual({ ...reviewedModelRecord(on) }, { switch: "on" });
  for (const edit of [
    (r) => (r.switch = "on"),
    (r) => (r.provider = "openai"),
    (r) => (r.switch = true),
    (r) => delete r.switch,
    (r) => (r.extra = 1),
    (r) => (r.monthly_spend_limit_usd = "50"),
    (r) => ((r.monthly_spend_limit_usd = "-1"), (r.observed_on = "2026-10-22")),
    (r) => (r.observed_on = "2026-10-22"),
    (r) => (r.environment_kind = "production"),
  ]) {
    const record = structuredClone(committedModel);
    edit(record);
    assert.throws(() => reviewedModelRecord(record), /EDGE_STAGING_MODEL_RECORD/);
  }
  // The names each Worker carries while on, none while off or outside staging.
  assert.deepEqual(edgeModelVarNames("api", "staging"), ["MORROW_MODEL_PROVIDER"]);
  assert.deepEqual(edgeModelNamesRequired("broker", "staging", "on"), [
    "MORROW_MODEL_PROVIDER",
    "ANTHROPIC_API_KEY",
  ]);
  assert.deepEqual(edgeModelNamesRequired("orchestrator", "staging", "on"), [
    "MORROW_MODEL_PROVIDER",
    "MORROW_DATABASE_BINDING_JSON",
  ]);
  for (const worker of ["api", "broker", "connector", "orchestrator"]) {
    assert.deepEqual(edgeModelNamesRequired(worker, "staging", "off"), [], worker);
    for (const environment of ["development", "production"])
      assert.deepEqual(edgeModelNamesRequired(worker, environment, "on"), [], worker);
  }
  assert.deepEqual(edgeModelNamesRequired("connector", "staging", "on"), []);
});

test("M3 PR-2: switched off, any model-provider var or key is a mixed state", async () => {
  assert.equal((await verify(tree())).modelSwitch, "off");
  for (const [index, [mutate, expected]] of [
    [modelTurnedOn(), ["EDGE_MODEL_SWITCH_MIXED", "EDGE_VARS", "EDGE_BROKER_SECRETS"]],
    [
      { api: (c) => (c.env.staging.vars.MORROW_MODEL_PROVIDER = "anthropic") },
      ["EDGE_MODEL_SWITCH_MIXED", "EDGE_VARS"],
    ],
    [
      { broker: (c) => c.env.staging.secrets.required.push("ANTHROPIC_API_KEY") },
      ["EDGE_MODEL_SWITCH_MIXED", "EDGE_BROKER_SECRETS"],
    ],
    [
      {
        orchestrator: (c) =>
          (c.env.staging.vars.MORROW_DATABASE_BINDING_JSON = committedApiBinding),
      },
      ["EDGE_MODEL_SWITCH_MIXED", "EDGE_VARS"],
    ],
    [
      { connector: (c) => (c.vars.MORROW_MODEL_PROVIDER = "anthropic") },
      ["EDGE_MODEL_SWITCH_MIXED", "EDGE_VARS"],
    ],
  ].entries()) {
    const found = codes(await verify(tree(mutate)));
    for (const code of expected)
      assert.ok(found.includes(code), index + ": " + code + " not in " + found.join(","));
  }
});

test("M3 PR-2: switched on, the full model set is required and the orchestrator binding is the api's", async () => {
  const on = records({ model: modelOn });
  const verdict = await verify(tree(modelTurnedOn()), undefined, on);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.modelSwitch, "on");
  assert.ok(verdict.resolved["broker:staging"].bindings.includes("ANTHROPIC_API_KEY"));
  assert.deepEqual(verdict.resolved["orchestrator:staging"].bindings.sort(), [
    "MORROW_DATABASE_BINDING_JSON",
    "MORROW_ENVIRONMENT",
    "MORROW_MODEL_PROVIDER",
  ]);
  // Development and production stay off; the files off with the record on is mixed.
  for (const environment of ["development", "production"])
    assert.ok(!verdict.resolved["broker:" + environment].bindings.includes("ANTHROPIC_API_KEY"));
  assert.ok(codes(await verify(tree(), undefined, on)).includes("EDGE_MODEL_SWITCH_MIXED"));
  for (const [index, [mutate, expected]] of [
    [
      modelTurnedOn({ broker: (c) => c.env.staging.secrets.required.pop() }),
      ["EDGE_MODEL_SWITCH_MIXED", "EDGE_BROKER_SECRETS"],
    ],
    [
      modelTurnedOn({ api: (c) => (c.env.staging.vars.MORROW_MODEL_PROVIDER = "openai") }),
      ["EDGE_VARS"],
    ],
    [
      modelTurnedOn({
        orchestrator: (c) => delete c.env.staging.vars.MORROW_DATABASE_BINDING_JSON,
      }),
      ["EDGE_MODEL_SWITCH_MIXED", "EDGE_VARS"],
    ],
    [
      modelTurnedOn({
        orchestrator: (c) =>
          (c.env.staging.vars.MORROW_DATABASE_BINDING_JSON = committedApiBinding.replace(
            '"database":"morrow"',
            '"database":"other"',
          )),
      }),
      ["EDGE_STAGING_SHARED_VARS"],
    ],
    [
      modelTurnedOn({ orchestrator: (c) => (c.vars.MORROW_MODEL_PROVIDER = "anthropic") }),
      ["EDGE_MODEL_SWITCH_MIXED", "EDGE_VARS"],
    ],
  ].entries()) {
    const found = codes(await verify(tree(mutate), undefined, on));
    for (const code of expected)
      assert.ok(found.includes(code), index + ": " + code + " not in " + found.join(","));
  }
});

// ---------------------------------------------------------------------------
// Build order PR 7 (ADR-0029 item 10; ADR-0035 item 6): the runtime switch, committed off.
const runtimeQualified = (r) => {
  r.qualified_on = "2026-10-30";
  r.qualification_record = "docs/evidence/live/2026-10-30-e2b-qualification.md";
};
const runtimeOn = (r) => {
  runtimeQualified(r);
  r.switch = "on";
};
// A root holding the qualification record runtimeQualified names, and one without it.
const runtimeEvidence = join(scratch, "runtime-evidence");
mkdirSync(join(runtimeEvidence, "docs/evidence/live"), { recursive: true });
writeFileSync(
  join(runtimeEvidence, "docs/evidence/live/2026-10-30-e2b-qualification.md"),
  "# Runtime qualification\n",
);
const runtimeNoEvidence = join(scratch, "runtime-no-evidence");
mkdirSync(join(runtimeNoEvidence, "docs/evidence/live/2026-10-30-e2b-qualification.md"), {
  recursive: true,
});
const runtimeTurnedOn = (value = "on", { broker } = {}) => ({
  broker: (c) => {
    c.env.staging.vars.MORROW_RUNTIME_SWITCH = value;
    c.env.staging.secrets.required.push("E2B_API_KEY");
    broker?.(c);
  },
});

test("PR 7: the committed runtime record is off, and the record rule", async () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(committedRuntime).filter(([key]) => key !== "scope")),
    {
      schema_version: 1,
      environment_kind: "staging",
      provider: "e2b",
      profile: "morrow.computer@1",
      switch: "off",
      admission: "synthetic_only",
      monthly_budget_usd: "10.00",
      provider_usage_limit_usd: "20.00",
      qualified_on: null,
      qualification_record: null,
    },
  );
  assert.deepEqual(
    { ...reviewedRuntimeRecord(committedRuntime) },
    { switch: "off", admission: "synthetic_only" },
  );
  // The record's budget is the code's (and migration 0043's), below the provider's limit.
  const { runtimeCaps } = await import("../packages/policy/src/runtime-computer.ts");
  assert.equal(committedRuntime.monthly_budget_usd, runtimeCaps.monthlyBudgetUsd);
  assert.equal(committedRuntime.provider_usage_limit_usd, runtimeCaps.providerUsageLimitUsd);
  // The staging tools' owner-file format is the broker's key shape.
  const { e2bKeyPattern } = await import("../packages/identity/src/broker-protocol.ts");
  const { e2bKeyFormat } = await import("../scripts/staging-files.mjs");
  assert.equal(e2bKeyFormat.source, e2bKeyPattern.source);
  // cleanup_only needs no qualification; on needs it; merchant needs on.
  const cleanup = { ...structuredClone(committedRuntime), switch: "cleanup_only" };
  assert.deepEqual(
    { ...reviewedRuntimeRecord(cleanup) },
    { switch: "cleanup_only", admission: "synthetic_only" },
  );
  const on = structuredClone(committedRuntime);
  runtimeOn(on);
  assert.deepEqual(
    { ...reviewedRuntimeRecord(on, runtimeEvidence) },
    { switch: "on", admission: "synthetic_only" },
  );
  on.admission = "merchant";
  assert.deepEqual(
    { ...reviewedRuntimeRecord(on, runtimeEvidence) },
    { switch: "on", admission: "merchant" },
  );
  // The qualification record must be a committed file, not a name: none in the repository
  // (the default root), none under another root, or a directory in its place, refuses it,
  // whether the switch is on or the record is only qualified.
  const qualified = structuredClone(committedRuntime);
  runtimeQualified(qualified);
  assert.deepEqual(
    { ...reviewedRuntimeRecord(qualified, runtimeEvidence) },
    { switch: "off", admission: "synthetic_only" },
  );
  for (const record of [on, qualified]) {
    assert.throws(() => reviewedRuntimeRecord(record), /EDGE_STAGING_RUNTIME_RECORD/);
    assert.throws(
      () => reviewedRuntimeRecord(record, runtimeNoEvidence),
      /EDGE_STAGING_RUNTIME_RECORD/,
    );
    assert.throws(
      () => reviewedRuntimeRecord(record, join(scratch, "runtime-absent")),
      /EDGE_STAGING_RUNTIME_RECORD/,
    );
  }
  for (const edit of [
    (r) => (r.switch = "on"),
    (r) => ((r.switch = "cleanup_only"), (r.admission = "merchant")),
    (r) => (r.admission = "merchant"),
    (r) => (r.switch = true),
    (r) => (r.switch = "paused"),
    (r) => (r.provider = "daytona"),
    (r) => (r.profile = "morrow.computer@2"),
    (r) => delete r.switch,
    (r) => (r.extra = 1),
    (r) => (r.monthly_budget_usd = "20.00"),
    (r) => (r.monthly_budget_usd = "25.00"),
    (r) => (r.monthly_budget_usd = "0.00"),
    (r) => (r.monthly_budget_usd = 10),
    (r) => (r.qualified_on = "2026-10-30"),
    (r) => (r.qualification_record = "docs/evidence/live/2026-10-30-e2b.md"),
    (r) => (
      (r.qualified_on = "soon"),
      (r.qualification_record = "docs/evidence/live/2026-10-30-e2b.md")
    ),
    (r) => (
      (r.qualified_on = "2026-10-30"),
      (r.qualification_record = "https://example.test/x.md")
    ),
    (r) => (r.environment_kind = "production"),
  ]) {
    const record = structuredClone(committedRuntime);
    edit(record);
    assert.throws(
      () => reviewedRuntimeRecord(record, runtimeEvidence),
      /EDGE_STAGING_RUNTIME_RECORD/,
    );
  }
  // Only the staging broker carries runtime names, and only while the switch is not off.
  assert.deepEqual(edgeRuntimeVarNames("broker", "staging"), ["MORROW_RUNTIME_SWITCH"]);
  for (const runtime of ["on", "cleanup_only"])
    assert.deepEqual(edgeRuntimeNamesRequired("broker", "staging", runtime), [
      "MORROW_RUNTIME_SWITCH",
      "E2B_API_KEY",
    ]);
  for (const worker of ["api", "broker", "connector", "orchestrator"]) {
    assert.deepEqual(edgeRuntimeNamesRequired(worker, "staging", "off"), [], worker);
    for (const environment of ["development", "production"])
      assert.deepEqual(edgeRuntimeNamesRequired(worker, environment, "on"), [], worker);
  }
  for (const worker of ["api", "connector", "orchestrator"])
    assert.deepEqual(edgeRuntimeNamesRequired(worker, "staging", "on"), [], worker);
  assert.deepEqual(edgeVarNames("broker", "staging", "off", "off", "on"), [
    ...edgeVarNames("broker", "staging"),
    "MORROW_RUNTIME_SWITCH",
  ]);
});

test("PR 7: switched off, the runtime var or the E2B key anywhere is a mixed state", async () => {
  const verdict = await verify(tree());
  assert.equal(verdict.runtimeSwitch, "off");
  assert.deepEqual(verdict.problems, []);
  for (const [index, [mutate, expected]] of [
    [runtimeTurnedOn(), ["EDGE_RUNTIME_SWITCH_MIXED", "EDGE_VARS", "EDGE_BROKER_SECRETS"]],
    [
      { broker: (c) => c.env.staging.secrets.required.push("E2B_API_KEY") },
      ["EDGE_RUNTIME_SWITCH_MIXED", "EDGE_BROKER_SECRETS"],
    ],
    [
      { broker: (c) => (c.env.staging.vars.MORROW_RUNTIME_SWITCH = "on") },
      ["EDGE_RUNTIME_SWITCH_MIXED", "EDGE_VARS"],
    ],
    [
      { api: (c) => (c.env.staging.vars.MORROW_RUNTIME_SWITCH = "on") },
      ["EDGE_RUNTIME_SWITCH_MIXED", "EDGE_VARS"],
    ],
    [
      { orchestrator: (c) => (c.env.staging.vars.MORROW_RUNTIME_SWITCH = "on") },
      ["EDGE_RUNTIME_SWITCH_MIXED", "EDGE_VARS"],
    ],
    [
      { orchestrator: (c) => c.env.staging.secrets.required.push("E2B_API_KEY") },
      ["EDGE_RUNTIME_SWITCH_MIXED", "EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER"],
    ],
    [
      { connector: (c) => (c.vars.MORROW_RUNTIME_SWITCH = "on") },
      ["EDGE_RUNTIME_SWITCH_MIXED", "EDGE_VARS"],
    ],
  ].entries()) {
    const found = codes(await verify(tree(mutate)));
    for (const code of expected)
      assert.ok(found.includes(code), index + ": " + code + " not in " + found.join(","));
  }
  // An invalid record is a problem and counts as off.
  const invalid = await verify(tree(), undefined, records({ runtime: (r) => (r.switch = "on") }));
  assert.ok(codes(invalid).includes("EDGE_STAGING_RUNTIME_RECORD"));
  assert.equal(invalid.runtimeSwitch, "off");
  // So is "on" naming a qualification record that was never committed (review R3), even with
  // the broker's files switched on to match.
  const unrecorded = await verify(
    tree(runtimeTurnedOn()),
    undefined,
    records({ runtime: runtimeOn }, { evidence: false }),
  );
  assert.ok(codes(unrecorded).includes("EDGE_STAGING_RUNTIME_RECORD"));
  assert.equal(unrecorded.runtimeSwitch, "off");
});

test("PR 7: switched on or cleanup-only, the staging broker carries exactly its var and the key", async () => {
  for (const [value, patch] of [
    ["on", runtimeOn],
    ["cleanup_only", (r) => (r.switch = "cleanup_only")],
  ]) {
    const record = records({ runtime: patch });
    const verdict = await verify(tree(runtimeTurnedOn(value)), undefined, record);
    assert.deepEqual(verdict.problems, [], value);
    assert.equal(verdict.runtimeSwitch, value);
    assert.ok(verdict.resolved["broker:staging"].bindings.includes("E2B_API_KEY"));
    assert.ok(verdict.resolved["broker:staging"].bindings.includes("MORROW_RUNTIME_SWITCH"));
    for (const environment of ["development", "production"])
      assert.ok(!verdict.resolved["broker:" + environment].bindings.includes("E2B_API_KEY"));
    // The files off with the record on (or the other way round) is mixed.
    assert.ok(codes(await verify(tree(), undefined, record)).includes("EDGE_RUNTIME_SWITCH_MIXED"));
    for (const [index, [mutate, expected]] of [
      [
        runtimeTurnedOn(value, { broker: (c) => c.env.staging.secrets.required.pop() }),
        ["EDGE_RUNTIME_SWITCH_MIXED", "EDGE_BROKER_SECRETS"],
      ],
      [runtimeTurnedOn(value === "on" ? "cleanup_only" : "on"), ["EDGE_VARS"]],
      [runtimeTurnedOn("true"), ["EDGE_VARS"]],
    ].entries()) {
      const found = codes(await verify(tree(mutate), undefined, record));
      for (const code of expected)
        assert.ok(
          found.includes(code),
          value + " " + index + ": " + code + " not in " + found.join(","),
        );
    }
  }
});
