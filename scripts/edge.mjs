// Deployable composition root tooling (P04.T02a D9). Every subcommand works with
// no Cloudflare account, credential or network:
//   types [--check]   Env typings, generated in a clean temporary copy of each Worker
//   typecheck         Worker sources against the pinned 2026-07-30 runtime types
//   verify-config     resolved wrangler configuration of all 4 Workers x 3 environments
//   dry-run           `wrangler deploy --dry-run` bundles, metafiles and sizes.json
//   dev               unbound local api + broker on https://127.0.0.1:8787
//   smoke-dev         dev over http, then https: /healthz, /, SIGTERM, port closed
//   measure           report-only local api cold start (median of 5)
// Every wrangler child gets a scrubbed environment, a throwaway HOME (so the
// Cloudflare login and config under the real HOME are out of reach) and
// `--env-file=<empty file>` (so no .env or .dev.vars in its working directory or
// next to a config is loaded; Env type generation, whose header records its flags,
// runs instead in a clean staged copy outside the checkout). Runs refuse
// Cloudflare credentials in the parent environment and any .env*/.dev.vars* at
// the repository root, under apps/ or in the child's working directory. Metrics,
// cf.json and the npm update check are off. Outputs go through
// scripts/artifacts.mjs under edge/.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { artifactPath, repositoryRoot, writeArtifact } from "./artifacts.mjs";

export const edgeWorkers = Object.freeze(
  [
    {
      key: "api",
      dir: "apps/api",
      entry: "src/deployed-worker.ts",
      tsconfig: "tsconfig.worker.json",
    },
    { key: "broker", dir: "apps/broker", entry: "src/index.ts", tsconfig: "tsconfig.json" },
    {
      key: "orchestrator",
      dir: "apps/workers",
      entry: "src/orchestrator.ts",
      tsconfig: "tsconfig.worker.json",
    },
    {
      key: "connector",
      dir: "apps/shopify-connector",
      entry: "worker/placeholder.ts",
      tsconfig: "tsconfig.worker.json",
    },
  ].map((worker) => Object.freeze(worker)),
);
export const edgeEnvironments = Object.freeze(["development", "staging", "production"]);
export const edgeCompatibility = Object.freeze({
  date: "2026-07-30",
  flags: Object.freeze(["nodejs_compat", "nodejs_compat_do_not_populate_process_env"]),
});
export const edgeDevOrigin = Object.freeze({ host: "127.0.0.1", port: 8787 });
const wranglerBin = join(repositoryRoot, "node_modules/wrangler/bin/wrangler.js");
const tscBin = join(repositoryRoot, "node_modules/typescript/bin/tsc");
const spaIndex = join(repositoryRoot, "apps/workspace-web/dist/index.html");
const stripColour = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
// Any wrangler warning or error is a failure (AC01).
export const wranglerDiagnostic = (output) => /\[(WARNING|ERROR)\]/.test(stripColour(output));
const environmentFlag = (environment) =>
  "--env=" + (environment === "development" ? "" : environment);
export const workerConfigPath = (worker, root = repositoryRoot) =>
  join(root, worker.dir, "wrangler.jsonc");

// Only PATH, TMPDIR, LANG, TERM and CI pass through; HOME is a throwaway directory.
export function edgeChildEnvironment(home, source = process.env) {
  const env = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "TERM", "CI"])
    if (typeof source[name] === "string") env[name] = source[name];
  return Object.assign(env, {
    HOME: home,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_HIDE_BANNER: "true",
    CLOUDFLARE_CF_FETCH_ENABLED: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_CACHE_DIR: join(home, "wrangler-cache"),
    // Wrangler also runs its npm update check after unknown-field config warnings
    // and on possible-bug errors, not only from the (hidden) banner.
    // (update-check reads the registry through rc("npm"), i.e. `npm_registry`).
    npm_registry: "http://127.0.0.1:9/",
  });
}

const localSecretName = (name) => /^\.dev\.vars/.test(name) || /^\.env/.test(name);
// The .env*/.dev.vars* entries directly in one directory (wrangler's CLI reads
// .env files from its working directory, `dev` reads .dev.vars next to a config).
export function localSecretFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(localSecretName).sort();
}

// Refuse to run with Cloudflare credentials in the environment or with any local
// secret file (.dev.vars* or .env*) at the repository root or under apps/.
export function edgeRefusals(root = repositoryRoot, source = process.env) {
  const refusals = [];
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"])
    if (typeof source[name] === "string" && source[name] !== "")
      refusals.push("EDGE_CLOUDFLARE_CREDENTIAL_SET:" + name);
  for (const name of localSecretFiles(root)) refusals.push("EDGE_LOCAL_SECRET_FILE:" + name);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (localSecretName(entry.name))
        refusals.push("EDGE_LOCAL_SECRET_FILE:" + relative(root, path).replaceAll("\\", "/"));
      else if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) walk(path);
    }
  };
  if (existsSync(join(root, "apps"))) walk(join(root, "apps"));
  return refusals;
}
// Labs build the SPA when it is missing; `npm run build` normally produces it.
export function ensureWorkspaceDist() {
  if (existsSync(spaIndex)) return;
  const built = spawnSync(
    process.execPath,
    [join(repositoryRoot, "node_modules/vite/bin/vite.js"), "build"],
    { cwd: join(repositoryRoot, "apps/workspace-web"), encoding: "utf8" },
  );
  if (built.status !== 0 || !existsSync(spaIndex))
    throw Error("EDGE_SPA_BUILD_FAILED\n" + built.stdout + built.stderr);
}
function refuseUnsafe(root = repositoryRoot) {
  const refusals = edgeRefusals(root);
  if (refusals.length) throw Error("EDGE_REFUSED: " + refusals.join(", "));
}

// wrangler's CLI loads .env, .env.local, .env.<env> and .env.<env>.local from its
// working directory into its own environment on every command, whatever
// CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV says, unless --env-file names other files;
// with --env-file, `dev` also stops reading .dev.vars. Every child therefore gets
// an empty env file in its throwaway HOME. The one exception is Env type
// generation (`edgeTypes`), whose committed header records every flag: it runs
// only in a clean staged copy of the Worker outside the checkout.
export function wranglerInvocation(args, home, { envFile = true } = {}) {
  const empty = join(home, "empty.env");
  if (envFile) writeFileSync(empty, "", { mode: 0o600 });
  return Object.freeze({
    args: [wranglerBin, ...args, ...(envFile ? ["--env-file=" + empty] : [])],
    env: edgeChildEnvironment(home),
  });
}
function refuseLocalSecretFiles(cwd) {
  const found = localSecretFiles(cwd);
  if (found.length)
    throw Error(
      "EDGE_REFUSED: " + found.map((name) => "EDGE_LOCAL_SECRET_FILE:" + name).join(", "),
    );
}

export function runWrangler(args, { cwd = repositoryRoot, timeout = 180000, envFile = true } = {}) {
  refuseLocalSecretFiles(cwd);
  const home = mkdtempSync(join(tmpdir(), "morrow-edge-home-"));
  try {
    const invocation = wranglerInvocation(args, home, { envFile });
    const result = spawnSync(process.execPath, invocation.args, {
      cwd,
      env: invocation.env,
      encoding: "utf8",
      timeout,
      maxBuffer: 32 << 20,
    });
    return {
      status: result.status,
      output: stripColour((result.stdout ?? "") + (result.stderr ?? "")),
      error: result.error?.message ?? null,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// In-process wrangler API (readConfig, getMiniflareWorkerOptions) behind the same
// scrubbed settings: a throwaway HOME, no provider variables in process.env, and
// Miniflare options built with the empty env file (no .dev.vars, no .env).
let wranglerApi;
export async function loadWranglerApi() {
  if (!wranglerApi) {
    for (const name of Object.keys(process.env))
      if (
        /^(WORKOS_|MORROW_DB_PASSWORD_|SHOPIFY_|ANTHROPIC_|OPENAI_|E2B_|NEON_|PG|CLOUDFLARE_|CF_|WRANGLER_)/i.test(
          name,
        )
      )
        delete process.env[name];
    const home = mkdtempSync(join(tmpdir(), "morrow-edge-home-"));
    Object.assign(process.env, edgeChildEnvironment(home, {}));
    const envFiles = [join(home, "empty.env")];
    writeFileSync(envFiles[0], "", { mode: 0o600 });
    const api = await import(
      pathToFileURL(join(repositoryRoot, "node_modules/wrangler/wrangler-dist/cli.js")).href
    );
    wranglerApi = Object.freeze({
      ...api,
      unstable_getMiniflareWorkerOptions: (config, environment, options) =>
        api.unstable_getMiniflareWorkerOptions(config, environment, {
          ...options,
          envFiles: [...envFiles],
        }),
    });
  }
  return wranglerApi;
}
// Runs fn while capturing everything wrangler prints; any output is a diagnostic.
export function captureConsole(fn) {
  const lines = [];
  const saved = {};
  for (const name of ["log", "info", "warn", "error", "debug"]) {
    saved[name] = console[name];
    console[name] = (...parts) => lines.push(stripColour(parts.join(" ")));
  }
  try {
    return { value: fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

// A clean temporary copy of one Worker: never .dev.vars*, .env*, node_modules or build output.
function stageWorker(worker, root, staging, { keepTypes = false } = {}) {
  const target = join(staging, worker.dir);
  cpSync(join(root, worker.dir), target, {
    recursive: true,
    filter: (source) => {
      const name = basename(source);
      return !(
        ["node_modules", "dist", "build", ".react-router", ".wrangler"].includes(name) ||
        /^\.dev\.vars/.test(name) ||
        /^\.env/.test(name) ||
        (!keepTypes && name === "worker-configuration.d.ts")
      );
    },
  });
  return target;
}
const typesArgs = ["types", "--include-runtime=false", "--config=wrangler.jsonc"];

export function edgeTypes({ check = false, root = repositoryRoot } = {}) {
  refuseUnsafe(root);
  const results = [];
  for (const worker of edgeWorkers) {
    const committed = join(root, worker.dir, "worker-configuration.d.ts");
    const staging = mkdtempSync(join(tmpdir(), "morrow-edge-types-"));
    try {
      const fresh = stageWorker(worker, root, staging);
      const generated = runWrangler(typesArgs, { cwd: fresh, envFile: false });
      if (generated.status !== 0 || wranglerDiagnostic(generated.output))
        throw Error("EDGE_TYPES_FAILED:" + worker.key + "\n" + generated.output);
      const text = readFileSync(join(fresh, "worker-configuration.d.ts"), "utf8");
      if (!check) {
        writeFileSync(committed, text);
        results.push({ worker: worker.key, written: true });
        continue;
      }
      if (!existsSync(committed) || readFileSync(committed, "utf8") !== text)
        throw Error("EDGE_TYPES_STALE:" + worker.key + " (run npm run edge:types)");
      const checked = mkdtempSync(join(tmpdir(), "morrow-edge-types-check-"));
      try {
        const copy = stageWorker(worker, root, checked, { keepTypes: true });
        const verdict = runWrangler(["types", "--check", ...typesArgs.slice(1)], {
          cwd: copy,
          envFile: false,
        });
        if (verdict.status !== 0 || wranglerDiagnostic(verdict.output))
          throw Error("EDGE_TYPES_CHECK_FAILED:" + worker.key + "\n" + verdict.output);
      } finally {
        rmSync(checked, { recursive: true, force: true });
      }
      results.push({ worker: worker.key, upToDate: true });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return results;
}

// Worker-owned sources are checked against the pinned runtime types. The DOM-typed
// identity and work packages (checked by `npm run typecheck`) are consumed through
// their emitted declarations, so runtime and DOM libraries never meet in one program.
export function edgeTypecheck({ root = repositoryRoot } = {}) {
  refuseUnsafe(root);
  const staging = mkdtempSync(join(tmpdir(), "morrow-edge-typecheck-"));
  try {
    const runtime = runWrangler(
      [
        "types",
        "--include-env=false",
        "--path=" + join(staging, "runtime.d.ts"),
        "--config=" + workerConfigPath(edgeWorkers[1], root),
      ],
      { cwd: root },
    );
    if (runtime.status !== 0 || wranglerDiagnostic(runtime.output))
      throw Error("EDGE_RUNTIME_TYPES_FAILED\n" + runtime.output);
    const header = readFileSync(join(staging, "runtime.d.ts"), "utf8").split("\n", 2)[1] ?? "";
    if (!header.includes("workerd@1.20260730.1 2026-07-30 " + edgeCompatibility.flags.join(",")))
      throw Error("EDGE_RUNTIME_TYPES_UNPINNED: " + header);
    const declarations = spawnSync(
      process.execPath,
      [
        tscBin,
        "-p",
        "packages/identity/tsconfig.json",
        "--noEmit",
        "false",
        "--declaration",
        "--emitDeclarationOnly",
        "--outDir",
        join(staging, "packages/identity/src"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (declarations.status !== 0)
      throw Error(
        "EDGE_IDENTITY_DECLARATIONS_FAILED\n" + declarations.stdout + declarations.stderr,
      );
    // @morrow/work (P06.T01a) imports identity sources relatively, so its rootDir is
    // packages/; its identity declarations are the same files emitted above.
    const work = spawnSync(
      process.execPath,
      [
        tscBin,
        "-p",
        "packages/work/tsconfig.json",
        "--noEmit",
        "false",
        "--declaration",
        "--emitDeclarationOnly",
        "--rootDir",
        "packages",
        "--outDir",
        join(staging, "packages"),
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (work.status !== 0)
      throw Error("EDGE_WORK_DECLARATIONS_FAILED\n" + work.stdout + work.stderr);
    cpSync(join(root, "tsconfig.base.json"), join(staging, "tsconfig.base.json"));
    symlinkSync(join(root, "node_modules"), join(staging, "node_modules"), "dir");
    const results = [];
    for (const worker of edgeWorkers) {
      const copy = stageWorker(worker, root, staging, { keepTypes: true });
      writeFileSync(
        join(copy, "tsconfig.edge.json"),
        JSON.stringify({
          extends: "./" + worker.tsconfig,
          compilerOptions: { skipLibCheck: true },
          files: ["../../runtime.d.ts"],
        }),
      );
      const checked = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.edge.json"], {
        cwd: copy,
        encoding: "utf8",
      });
      if (checked.status !== 0)
        throw Error("EDGE_TYPECHECK_FAILED:" + worker.key + "\n" + checked.stdout + checked.stderr);
      results.push({ worker: worker.key, runtimeTypes: header.slice(3).trim(), passed: true });
    }
    return results;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const emptyValue = (value) =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((child) => emptyValue(child)));
// Resolved keys that bind nothing; every other key must be empty unless the
// Worker's own allowlist names it.
const settingKeys = new Set([
  "configPath",
  "userConfigPath",
  "topLevelName",
  "definedEnvironments",
  "targetEnvironment",
  "send_metrics",
  "keep_vars",
  "compatibility_date",
  "compatibility_flags",
  "jsx_factory",
  "jsx_fragment",
  "rules",
  "name",
  "main",
  "build",
  "workers_dev",
  "preview_urls",
  "logpush",
  "upload_source_maps",
  "observability",
  "python_modules",
  "dev",
  "no_bundle",
  "minify",
  "keep_names",
  "first_party_worker",
  "base_dir",
  "find_additional_modules",
  "preserve_file_names",
  "tsconfig",
]);
const allowedBindings = Object.freeze({
  api: ["vars", "services", "secrets", "assets", "ratelimits"],
  broker: ["vars", "secrets"],
  orchestrator: ["workflows", "queues", "secrets"],
  connector: ["vars", "secrets"],
});
const providerCredentialName =
  /^(WORKOS_|MORROW_DB_PASSWORD_|SHOPIFY_|ANTHROPIC_|OPENAI_|E2B_|NEON_|PG)/i;
const credentialWord = /KEY|SECRET|PASSWORD|TOKEN/i;
// Hosted identifiers that P04.T02a must not commit (P04.T01i later allows only the
// reviewed staging identifiers in env.staging.vars).
export const committedIdentifierPatterns = Object.freeze([
  ["workos_client", /client_[A-Z0-9]{26}/],
  ["workos_environment", /environment_[A-Z0-9]{26}/],
  ["workos_application", /\bapp_[A-Z0-9]{26}/],
  ["workos_user", /\buser_[A-Z0-9]{26}/],
  ["neon_endpoint", /\bep-[a-z0-9-]+\.[a-z0-9.-]*neon\.tech/],
  ["neon_branch", /\bbr-[a-z0-9-]+/],
  ["neon_password", /\bnpg_[A-Za-z0-9]/],
  ["workos_key", /\bsk_(?:test|live)_/],
  ["cloudflare_account", /"account_id"|\b[0-9a-f]{32}\b/],
  ["route", /"routes?"\s*:/],
]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// P05.T01ab (ADR-0019 item 8): the api's per-address sign-in limits, exact per
// environment: login start 10, the callback 20 and signup 5 per 60 s, in namespaces
// 7001-7003 (development), 7101-7103 (staging) and 7201-7203 (production).
export function edgeRateLimits(environment) {
  const base = { development: 7001, staging: 7101, production: 7201 }[environment];
  return [
    ["LOGIN_START_LIMITER", 10],
    ["LOGIN_CALLBACK_LIMITER", 20],
    ["SIGNUP_LIMITER", 5],
  ].map(([name, limit], i) => ({
    name,
    namespace_id: String(base + i),
    simple: { limit, period: 60 },
  }));
}

// Resolved-configuration checks for AC01, AC04, AC22 (static) and AC24.
export async function verifyEdgeConfig({
  root = repositoryRoot,
  routesPath = join(repositoryRoot, "docs/contracts/workspace-routes.json"),
} = {}) {
  const { tsImport } = await import("tsx/esm/api");
  const here = import.meta.url;
  const { selectedConfiguration } = await tsImport(
    "../packages/infrastructure/src/selected-stack.ts",
    here,
  );
  const { brokerRequiredSecrets } = await tsImport(
    "../packages/identity/src/broker-protocol.ts",
    here,
  );
  const { reservedWorkerPaths } = await tsImport("../apps/api/src/reserved-paths.ts", here);
  const { unstable_readConfig } = await loadWranglerApi();
  const problems = [];
  const resolved = {};
  const problem = (code, where) => problems.push(code + ":" + where);
  for (const worker of edgeWorkers) {
    const path = workerConfigPath(worker, root);
    const text = readFileSync(path, "utf8");
    for (const [kind, pattern] of committedIdentifierPatterns)
      if (pattern.test(text))
        problem("EDGE_COMMITTED_IDENTIFIER_" + kind.toUpperCase(), worker.key);
    for (const environment of edgeEnvironments) {
      const where = worker.key + ":" + environment;
      let config;
      try {
        const read = captureConsole(() =>
          unstable_readConfig(
            { config: path, env: environment === "development" ? undefined : environment },
            {},
          ),
        );
        config = read.value;
        if (read.lines.some((line) => line.trim() !== "")) problem("EDGE_CONFIG_DIAGNOSTIC", where);
      } catch {
        problem("EDGE_CONFIG_UNREADABLE", where);
        continue;
      }
      const expected = selectedConfiguration(environment).cloudflare.workers;
      if (config.name !== expected[worker.key]) problem("EDGE_WORKER_NAME", where);
      if (config.main !== resolve(root, worker.dir, worker.entry)) problem("EDGE_MAIN", where);
      if (
        config.compatibility_date !== edgeCompatibility.date ||
        !same(config.compatibility_flags, edgeCompatibility.flags)
      )
        problem("EDGE_COMPATIBILITY", where);
      for (const key of [
        "workers_dev",
        "preview_urls",
        "logpush",
        "upload_source_maps",
        "keep_vars",
        "send_metrics",
      ])
        if (config[key] !== false) problem("EDGE_FLAG_" + key.toUpperCase(), where);
      if (
        config.observability?.enabled !== false ||
        !same(Object.keys(config.observability), ["enabled"])
      )
        problem("EDGE_FLAG_OBSERVABILITY", where);
      if (!emptyValue(config.routes) || !emptyValue(config.route)) problem("EDGE_ROUTES", where);
      const allowed = allowedBindings[worker.key];
      for (const [key, value] of Object.entries(config))
        if (!settingKeys.has(key) && !allowed.includes(key) && !emptyValue(value))
          problem("EDGE_UNEXPECTED_BINDING_" + key.toUpperCase(), where);
      const vars = config.vars ?? {};
      const required = config.secrets?.required;
      if (!Array.isArray(required) || !same(Object.keys(config.secrets), ["required"]))
        problem("EDGE_SECRETS_SHAPE", where);
      const names = [...Object.keys(vars), ...(Array.isArray(required) ? required : [])];
      if (
        worker.key !== "broker" &&
        names.some((name) => providerCredentialName.test(name) || credentialWord.test(name))
      )
        problem("EDGE_CREDENTIAL_BINDING_OUTSIDE_BROKER", where);
      const environmentVars = { MORROW_ENVIRONMENT: environment };
      if (worker.key === "orchestrator") {
        if (!emptyValue(vars)) problem("EDGE_VARS", where);
      } else if (!same(vars, environmentVars)) problem("EDGE_VARS", where);
      if (worker.key === "broker") {
        if (
          !Array.isArray(required) ||
          new Set(required).size !== required.length ||
          !same([...required].sort(), [...brokerRequiredSecrets].sort())
        )
          problem("EDGE_BROKER_SECRETS", where);
      } else if (!same(required, [])) problem("EDGE_SECRETS_REQUIRED_NOT_EMPTY", where);
      if (worker.key === "api") {
        if (
          !same(config.services, [
            { binding: "BROKER", service: expected.broker, entrypoint: "ApiBroker" },
          ])
        )
          problem("EDGE_API_BROKER_BINDING", where);
        const assets = config.assets ?? {};
        if (
          resolve(root, worker.dir, assets.directory ?? "") !==
            resolve(root, "apps/workspace-web/dist") ||
          assets.not_found_handling !== "single-page-application" ||
          !same(assets.run_worker_first, [...reservedWorkerPaths]) ||
          assets.binding !== undefined ||
          !same(Object.keys(assets).sort(), ["directory", "not_found_handling", "run_worker_first"])
        )
          problem("EDGE_API_ASSETS", where);
        if (!same(config.ratelimits, edgeRateLimits(environment)))
          problem("EDGE_API_RATELIMITS", where);
        if (
          config.dev?.ip !== edgeDevOrigin.host ||
          config.dev?.port !== edgeDevOrigin.port ||
          config.dev?.local_protocol !== "https"
        )
          problem("EDGE_API_DEV", where);
      }
      if (worker.key === "orchestrator") {
        const prefix = "morrow-" + environment;
        if (
          !same(config.workflows, [
            { name: prefix + "-work", binding: "WORK", class_name: "MorrowWorkWorkflow" },
          ]) ||
          !same(config.queues, {
            consumers: [
              {
                queue: prefix + "-dispatch",
                max_batch_size: 1,
                max_retries: 3,
                dead_letter_queue: prefix + "-dispatch-dlq",
              },
            ],
          })
        )
          problem("EDGE_ORCHESTRATOR_BINDINGS", where);
      }
      resolved[where] = { name: config.name, bindings: names, services: config.services ?? [] };
    }
  }
  // No SPA route may fall under a Worker-reserved prefix (AC22).
  const routes = JSON.parse(readFileSync(routesPath, "utf8")).routes;
  const bases = [...new Set(reservedWorkerPaths.map((path) => path.replace(/\/\*$/, "")))];
  for (const route of routes)
    if (bases.some((base) => route.pattern === base || route.pattern.startsWith(base + "/")))
      problem("EDGE_ROUTE_SHADOWED_BY_WORKER", route.id);
  return { problems, resolved, reservedWorkerPaths: [...reservedWorkerPaths] };
}

const normalisedInputs = (meta, worker, root) =>
  Object.keys(meta.inputs).map((input) =>
    relative(root, resolve(root, worker.dir, input)).replaceAll("\\", "/"),
  );
// Bundle exclusions (AC05).
export function bundleExclusions(worker, inputs, bundleText) {
  const failures = [];
  const banned =
    worker.key === "api"
      ? [
          [/^apps\/broker\//, "broker_source"],
          [/(^|\/)ajv\/dist\/compile\//, "ajv_compile"],
          [/(^|\/)node_modules\/unenv\/.*\/node\/https?(\/|\.mjs$)/, "node_http"],
        ]
      : worker.key === "broker"
        ? [
            [/@neondatabase\/serverless/, "neon_driver"],
            [/controlled-neon-login-pool\.ts$/, "neon_pool"],
            [/runtime-validators\.mjs$/, "runtime_validators"],
            [/^apps\/api\//, "api_source"],
          ]
        : [[/^packages\//, "package_source"]];
  for (const [pattern, name] of banned)
    if (inputs.some((input) => pattern.test(input))) failures.push(name);
  if (
    worker.key === "api" &&
    /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'](?:node:)?https?["']/.test(bundleText)
  )
    failures.push("node_http_import");
  return failures;
}

export function edgeDryRun({
  root = repositoryRoot,
  outRoot = artifactPath("edge/dry-run"),
  workers = edgeWorkers,
  environments = edgeEnvironments,
  report = true,
} = {}) {
  refuseUnsafe(root);
  if (!existsSync(join(root, "apps/workspace-web/dist/index.html")))
    throw Error("EDGE_SPA_DIST_MISSING: run `npm run build -w @morrow/workspace-web` first");
  const rows = [];
  const failures = [];
  for (const worker of workers)
    for (const environment of environments) {
      const outdir = join(outRoot, worker.key, environment);
      rmSync(outdir, { recursive: true, force: true });
      mkdirSync(outdir, { recursive: true });
      const metafile = join(outdir, "meta.json");
      const run = runWrangler(
        [
          "deploy",
          "--dry-run",
          "--config=" + workerConfigPath(worker, root),
          environmentFlag(environment),
          "--outdir=" + outdir,
          "--metafile=" + metafile,
        ],
        { cwd: root },
      );
      const where = worker.key + ":" + environment;
      if (run.status !== 0 || wranglerDiagnostic(run.output)) {
        failures.push("EDGE_DRY_RUN_FAILED:" + where + "\n" + run.output);
        continue;
      }
      const bundlePath = join(outdir, basename(worker.entry).replace(/\.ts$/, ".js"));
      const bundle = readFileSync(bundlePath);
      const inputs = normalisedInputs(JSON.parse(readFileSync(metafile, "utf8")), worker, root);
      const excluded = bundleExclusions(worker, inputs, bundle.toString("utf8"));
      for (const name of excluded)
        failures.push("EDGE_BUNDLE_INCLUDES_" + name.toUpperCase() + ":" + where);
      const row = {
        worker: worker.key,
        environment,
        bundle: relative(outRoot, bundlePath).replaceAll("\\", "/"),
        bytes: bundle.length,
        gzipBytes: gzipSync(bundle).length,
        inputs: inputs.length,
      };
      if (worker.key === "api" && row.gzipBytes > 3 * 1024 * 1024)
        failures.push("EDGE_API_BUNDLE_TOO_LARGE:" + where);
      if (worker.key === "broker" && row.bytes > 256 * 1024)
        failures.push("EDGE_BROKER_BUNDLE_TOO_LARGE:" + where);
      if (worker.key === "api" && row.gzipBytes > 1024 * 1024)
        row.warning = "api_bundle_over_1_MiB_gzipped";
      rows.push(row);
    }
  if (report)
    writeArtifact("edge/sizes.json", {
      generated_at: new Date().toISOString(),
      scope:
        "wrangler 4.116.0 `deploy --dry-run` bundles (esbuild 0.28.1); no account, credential or network. Local sizes only; hosted limits are measured in P04.T01i.",
      limits: {
        apiGzipBytes: 3 * 1024 * 1024,
        apiWarnGzipBytes: 1024 * 1024,
        brokerBytes: 256 * 1024,
      },
      bundles: rows,
      failures: failures.map((failure) => failure.split("\n")[0]),
    });
  if (failures.length) throw Error(failures.join("\n"));
  return rows;
}

function devArgs(protocol) {
  return [
    "dev",
    "--config=" + workerConfigPath(edgeWorkers[0]),
    "--config=" + workerConfigPath(edgeWorkers[1]),
    environmentFlag("development"),
    ...(protocol ? ["--local-protocol=" + protocol] : []),
  ];
}
// `extraEnvironment` exists only for the smoke's negative control (provider
// markers placed directly in wrangler's own environment).
function startDev(protocol, stdio, extraEnvironment = {}) {
  refuseLocalSecretFiles(repositoryRoot);
  const home = mkdtempSync(join(tmpdir(), "morrow-edge-home-"));
  const invocation = wranglerInvocation(devArgs(protocol), home);
  const child = spawn(process.execPath, invocation.args, {
    cwd: repositoryRoot,
    env: { ...invocation.env, ...extraEnvironment },
    stdio,
  });
  child.on("exit", () => rmSync(home, { recursive: true, force: true }));
  return child;
}
const portOpen = (host, port) =>
  new Promise((done) => {
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
const portFree = (host, port) =>
  new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => done(true)));
  });

// One local request with Node's own client: the https phase accepts wrangler's
// throwaway self-signed certificate, which never leaves the run.
const localRequest = (protocol, path, method = "GET") =>
  new Promise((done, failed) => {
    const { host, port } = edgeDevOrigin;
    const client = protocol === "https" ? httpsRequest : httpRequest;
    const request = client(
      { host, port, path, method, rejectUnauthorized: false, timeout: 2000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          done({ status: response.statusCode, headers: response.headers, body }),
        );
        response.on("error", failed);
      },
    );
    request.on("timeout", () => request.destroy(Error("EDGE_LOCAL_REQUEST_TIMEOUT")));
    request.on("error", failed);
    request.end();
  });
// The "<worker> has access to the following bindings:" tables wrangler dev prints.
export function devBindingTables(output) {
  const tables = {};
  const pattern = /^(\S+) has access to the following bindings:\n[^\n]*\n((?:env\.[^\n]*\n)*)/gm;
  for (const match of stripColour(output).matchAll(pattern))
    tables[match[1]] = [...match[2].matchAll(/^env\.([A-Za-z0-9_]+)/gm)].map((row) => row[1]);
  return tables;
}
const nonLoopbackIpv4 = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((row) => row && row.family === "IPv4" && !row.internal)
    .map((row) => row.address);

// AC23: the unbound dev pair over http (as in CI), then over https (the committed
// `dev.local_protocol`). Negative control: the provider markers are placed in
// wrangler's own environment, as if the scrub had failed; the broker must still
// bind none of them and no marker value may appear in the output.
async function smokeDevPhase(protocol, markers, check) {
  const { host, port } = edgeDevOrigin;
  if (!(await portFree(host, port))) throw Error("EDGE_DEV_PORT_IN_USE:" + port);
  const label = (name) => protocol + ":" + name;
  let output = "";
  const child = startDev(
    protocol === "http" ? "http" : undefined,
    ["ignore", "pipe", "pipe"],
    Object.fromEntries(markers),
  );
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  const started = Date.now();
  let exit = { code: null, signal: null };
  try {
    let health;
    while (Date.now() - started < 30000) {
      try {
        health = await localRequest(protocol, "/healthz");
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 250));
      }
    }
    check(label("healthz_reachable_within_30s"), health !== undefined);
    check(
      label("healthz_unbound_not_ready"),
      health.status === 200 && health.body === '{"schemaVersion":1,"service":"api","ready":false}',
    );
    check(label("healthz_no_store"), health.headers["cache-control"] === "no-store");
    const spa = await localRequest(protocol, "/");
    check(
      label("spa_index_served"),
      spa.status === 200 && spa.body.includes('<div id="root"></div>'),
    );
    check(
      label("spa_headers_applied"),
      /frame-ancestors 'none'/.test(spa.headers["content-security-policy"] ?? "") &&
        spa.headers["x-content-type-options"] === "nosniff",
    );
    const login = await localRequest(protocol, "/auth/login", "POST");
    check(
      label("unbound_login_unavailable"),
      login.status === 503 && login.body === '{"code":"unavailable"}',
    );
    if (protocol === "https") {
      const plain = await localRequest("http", "/healthz").catch(() => null);
      check(label("plain_http_not_served"), plain === null || plain.status !== 200);
    }
    const tables = devBindingTables(output);
    check(
      label("broker_binds_only_morrow_environment"),
      JSON.stringify(tables["morrow-development-broker"]) === '["MORROW_ENVIRONMENT"]',
    );
    // P05.T01ab adds the three per-address limiters; still no text or secret binding.
    check(
      label("api_binds_only_broker_environment_and_limiters"),
      JSON.stringify([...(tables["morrow-development-api"] ?? [])].sort()) ===
        JSON.stringify(
          [
            "BROKER",
            "LOGIN_CALLBACK_LIMITER",
            "LOGIN_START_LIMITER",
            "MORROW_ENVIRONMENT",
            "SIGNUP_LIMITER",
          ].sort(),
        ),
    );
    const missing = /Missing required secrets: ([^\n]*)/.exec(stripColour(output))?.[1] ?? "";
    check(
      label("broker_reports_marker_secrets_missing"),
      markers.every(([name]) => missing.split(/[ ,.]+/).includes(name)),
    );
    check(label("loopback_ipv6_not_listening"), !(await portOpen("::1", port)));
    const addresses = nonLoopbackIpv4();
    const reachable = [];
    for (const address of addresses) if (await portOpen(address, port)) reachable.push(address);
    check(label("no_non_loopback_ipv4_listening"), reachable.length === 0);
  } finally {
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 10000);
    exit = await exited;
    clearTimeout(killer);
  }
  check(label("exited_after_sigterm"), exit.signal !== "SIGKILL");
  await new Promise((done) => setTimeout(done, 500));
  check(label("port_closed_after_exit"), !(await portOpen(host, port)));
  check(
    label("no_marker_in_dev_output"),
    markers.every(([, value]) => !output.includes(value)),
  );
}

// P14.T01a `ui:edge`: the unbound dev pair serving the production dist (the same
// `dev` invocation), over http so the browser needs no certificate exception. Resolves
// once /healthz answers; the caller stops it. Output is never written anywhere.
export async function startEdgeDev({ protocol = "http", timeoutMs = 60000 } = {}) {
  refuseUnsafe();
  if (!existsSync(spaIndex)) throw Error("EDGE_SPA_DIST_MISSING: run `npm run build` first");
  const { host, port } = edgeDevOrigin;
  if (!(await portFree(host, port))) throw Error("EDGE_DEV_PORT_IN_USE:" + port);
  const child = startDev(protocol === "http" ? "http" : undefined, ["ignore", "pipe", "pipe"]);
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 10000);
    await exited;
    clearTimeout(killer);
  };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await localRequest(protocol, "/healthz")).status === 200)
        return { origin: `${protocol}://${host}:${port}`, stop };
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  await stop();
  throw Error("EDGE_DEV_NOT_READY");
}

export async function edgeSmokeDev() {
  refuseUnsafe();
  if (!existsSync(spaIndex)) throw Error("EDGE_SPA_DIST_MISSING: run `npm run build` first");
  const markers = [
    [
      "WORKOS_API_KEY",
      ["sk", "test", Math.random().toString(36).slice(2).padEnd(16, "x")].join("_"),
    ],
    [
      "MORROW_DB_PASSWORD_MORROW_API",
      "synthetic-" + Math.random().toString(36).slice(2) + "-marker",
    ],
  ];
  const checks = [];
  const check = (name, passed) => {
    checks.push({ name, passed });
    if (!passed) throw Error("EDGE_SMOKE_FAILED:" + name);
  };
  // First layer: markers in the parent shell never reach a wrangler child.
  const scrubbed = edgeChildEnvironment(tmpdir(), {
    ...process.env,
    ...Object.fromEntries(markers),
  });
  check(
    "parent_markers_scrubbed_from_child_environment",
    markers.every(
      ([name, value]) => !Object.hasOwn(scrubbed, name) && !Object.values(scrubbed).includes(value),
    ),
  );
  // Second layer, end to end, with the markers inside wrangler's own environment.
  await smokeDevPhase("http", markers, check);
  await smokeDevPhase("https", markers, check);
  writeArtifact("edge/smoke-dev.json", {
    generated_at: new Date().toISOString(),
    scope:
      "Unbound `wrangler dev` of api + broker on 127.0.0.1:8787 over http and then https, with an isolated HOME, an empty --env-file and synthetic provider markers placed in wrangler's own environment as a negative control; no account, credential or network.",
    nonLoopbackIpv4Checked: nonLoopbackIpv4().length,
    checks,
  });
  return checks;
}

// Report-only local api cold start: Miniflare construction to first /healthz, median of 5.
export async function edgeMeasure() {
  refuseUnsafe();
  const outRoot = mkdtempSync(join(tmpdir(), "morrow-edge-measure-"));
  try {
    edgeDryRun({
      outRoot,
      workers: edgeWorkers.slice(0, 2),
      environments: ["development"],
      report: false,
    });
    const { unstable_getMiniflareWorkerOptions } = await loadWranglerApi();
    const { Log, LogLevel, Miniflare } = await import("miniflare");
    const options = (worker) => {
      const read = captureConsole(() =>
        unstable_getMiniflareWorkerOptions(workerConfigPath(worker), undefined),
      ).value;
      return {
        ...read.workerOptions,
        name: worker.key === "api" ? "morrow-development-api" : "morrow-development-broker",
        modules: true,
        script: readFileSync(
          join(outRoot, worker.key, "development", basename(worker.entry).replace(/\.ts$/, ".js")),
          "utf8",
        ),
      };
    };
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const mf = new Miniflare({
        log: new Log(LogLevel.NONE),
        cf: { colo: "LAB", country: "US" },
        workers: [options(edgeWorkers[0]), options(edgeWorkers[1])],
      });
      try {
        const response = await mf.dispatchFetch("https://lab.morrow.test/healthz");
        await response.text();
        samples.push(Math.round(performance.now() - started));
      } finally {
        await mf.dispose();
      }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const result = { samplesMs: samples, medianMs: sorted[2] };
    writeArtifact("edge/measure.json", {
      generated_at: new Date().toISOString(),
      scope:
        "Report-only local Miniflare cold start of the unbound api bundle; no threshold. Hosted startup limits are measured in P04.T01i.",
      ...result,
    });
    return result;
  } finally {
    rmSync(outRoot, { recursive: true, force: true });
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "types") {
    if (rest.length > 1 || (rest.length && rest[0] !== "--check")) throw Error("EDGE_USAGE");
    const results = edgeTypes({ check: rest[0] === "--check" });
    console.log(JSON.stringify({ types: results }));
  } else if (command === "typecheck" && !rest.length) {
    console.log(JSON.stringify({ typecheck: edgeTypecheck() }));
  } else if (command === "verify-config" && !rest.length) {
    refuseUnsafe();
    const verdict = await verifyEdgeConfig();
    writeArtifact("edge/verify-config.json", {
      generated_at: new Date().toISOString(),
      scope:
        "Resolved wrangler 4.116.0 configuration of 4 Workers x 3 environments; no account, credential or network.",
      ...verdict,
    });
    if (verdict.problems.length) throw Error("EDGE_CONFIG_INVALID\n" + verdict.problems.join("\n"));
    console.log(`PASS: ${Object.keys(verdict.resolved).length} Worker environments verified.`);
  } else if (command === "dry-run" && !rest.length) {
    const rows = edgeDryRun();
    console.log(`PASS: ${rows.length} dry-run bundles; sizes in edge/sizes.json.`);
  } else if (command === "dev" && !rest.length) {
    refuseUnsafe();
    if (!existsSync(spaIndex)) throw Error("EDGE_SPA_DIST_MISSING: run `npm run build` first");
    const child = startDev(undefined, "inherit");
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.on("exit", (code) => process.exit(code ?? 1));
  } else if (command === "smoke-dev" && !rest.length) {
    const checks = await edgeSmokeDev();
    console.log(`PASS: ${checks.length} local dev checks.`);
  } else if (command === "measure" && !rest.length) {
    console.log(JSON.stringify(await edgeMeasure()));
  } else
    throw Error(
      "EDGE_USAGE: types [--check] | typecheck | verify-config | dry-run | dev | smoke-dev | measure",
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? String(error));
    process.exit(1);
  });
