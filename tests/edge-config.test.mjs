import assert from "node:assert/strict";
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
  edgeRefusals,
  edgeWorkers,
  verifyEdgeConfig,
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
    assert.equal(verdict.resolved["broker:" + environment].bindings.length, 9);
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
  assert.deepEqual(
    [...reservedWorkerPaths],
    ["/auth", "/auth/*", "/workspace", "/workspace/*", "/api", "/api/*", "/healthz"],
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
