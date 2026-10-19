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
  edgeChildEnvironment,
  edgeEnvironments,
  devBindingTables,
  edgeRefusals,
  edgeWorkers,
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
const verify = (root, routesPath) =>
  verifyEdgeConfig({ root, ...(routesPath ? { routesPath } : {}) });
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
    assert.deepEqual(verdict.resolved["connector:" + environment].bindings, ["MORROW_ENVIRONMENT"]);
    // MORROW_ENVIRONMENT, WORKOS_API_KEY and the eight role passwords (P06.T01a adds
    // morrow_api_worker).
    assert.equal(verdict.resolved["broker:" + environment].bindings.length, 10);
  }
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
    [
      { api: (c) => (c.routes = [{ pattern: "example.test/*", zone_name: "example.test" }]) },
      "EDGE_ROUTES",
    ],
    [{ api: (c) => c.assets.run_worker_first.push("/admin/*") }, "EDGE_API_ASSETS"],
    [{ api: (c) => (c.assets.binding = "ASSETS") }, "EDGE_API_ASSETS"],
    [{ api: (c) => (c.dev.ip = "0.0.0.0") }, "EDGE_API_DEV"],
    [{ api: (c) => (c.env.staging.vars.MORROW_ENVIRONMENT = "production") }, "EDGE_VARS"],
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
    "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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
    ["neon_driver", "neon_pool", "runtime_validators", "api_source"],
  );
});
