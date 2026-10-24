// Deployable composition root tooling (P04.T02a D9). Every subcommand works with
// no Cloudflare account, credential or network:
//   types [--check]   Env typings, generated in a clean temporary copy of each Worker
//   typecheck         Worker sources against the pinned 2026-07-30 runtime types
//   verify-config     resolved wrangler configuration of all 4 Workers x 3 environments,
//                     and the reviewed staging values (P04.T01i D1)
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
      entry: "worker/index.ts",
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
    // M2 PR-2: the api composes the policy package's connection kernel
    // (packages/policy/src/connection-authority.ts), consumed the same way: through its
    // emitted declarations, at their repository-relative paths.
    const policy = spawnSync(
      process.execPath,
      [
        tscBin,
        "-p",
        "packages/policy/tsconfig.json",
        "--noEmit",
        "false",
        "--declaration",
        "--emitDeclarationOnly",
        "--rootDir",
        ".",
        "--outDir",
        staging,
      ],
      { cwd: root, encoding: "utf8" },
    );
    if (policy.status !== 0)
      throw Error("EDGE_POLICY_DECLARATIONS_FAILED\n" + policy.stdout + policy.stderr);
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
  // Checked exactly below (EDGE_PLACEMENT_*).
  "placement",
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
  // M3 PR-2: the orchestrator binds the broker's RuntimeBroker entrypoint, its one var
  // (two more while the model-provider switch is on) and the cron of pending starts.
  orchestrator: ["vars", "services", "workflows", "queues", "triggers", "secrets"],
  // M2 PR-2: the connector binds the broker's ConnectorBroker entrypoint and, since the
  // PR-2 review, its two per-address ingress limits (edgeConnectorRateLimits). M2 PR-3: its
  // one cron trigger (edgeConnectorCrons).
  connector: ["vars", "services", "secrets", "ratelimits", "triggers"],
});
// The reviewed packages/ files the connector bundle may include (M2 PR-2): the shared
// broker protocol and the role preflight text, with the JSON helpers they import, and the
// per-address limiter key (WebCrypto only). No pool, SQL module, validator or policy code.
export const connectorPackageAllowlist = Object.freeze([
  "packages/identity/src/broker-protocol.ts",
  "packages/identity/src/edge-limiter.ts",
  "packages/identity/src/executor-role-preflight.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/workos-session-status-json.ts",
]);
// The reviewed packages/ files the orchestrator bundle may include (M3 PR-2, replacing
// P04.T02a's ban on all package source): ListingsRunWorkflow's logic (runs/), the run lease
// steps (runtime/), the agent kernel and its SQL fact reader, M5's billing facts reader, the
// review library the producer uses, the generated validators (the drafts are validated
// against ListingDraft@1 and CatalogContentChangeSet@1) and the broker protocol. No api
// handler, command definer client, pool of another login, Shopify library or broker source.
// A new import is a reviewed change to this list.
export const orchestratorPackageAllowlist = Object.freeze([
  "packages/contracts/src/generated/runtime-validators.mjs",
  "packages/contracts/src/validation.ts",
  "packages/identity/src/broker-protocol.ts",
  "packages/identity/src/executor-role-preflight.ts",
  "packages/identity/src/fixed-sql-transaction.ts",
  "packages/identity/src/index.ts",
  "packages/identity/src/standalone-login-protocol.ts",
  "packages/identity/src/workos-session-status-json.ts",
  "packages/policy/src/agent-authority.ts",
  "packages/policy/src/billing-state.ts",
  // M3 PR-2 review: the catalogue's data only (each run's call budget from its effort's
  // max_tokens); the broker ships the same file.
  "packages/policy/src/generated/model-catalogue.ts",
  "packages/policy/src/index.ts",
  "packages/policy/src/json-boundary.ts",
  "packages/policy/src/paid-work.ts",
  "packages/policy/src/review-facts.ts",
  "packages/policy/src/review.ts",
  "packages/policy/src/store-link-template.ts",
  "packages/policy/src/store-resource.ts",
  "packages/work/src/agents/delegation-reader.ts",
  "packages/work/src/approvals/digests.ts",
  "packages/work/src/billing-route.ts",
  "packages/work/src/billing/facts.ts",
  "packages/work/src/context.ts",
  "packages/work/src/digest.ts",
  "packages/work/src/runs/drafting.ts",
  "packages/work/src/runs/html.ts",
  // v1 PR 3: the one canonical listing snapshot text drafting.ts builds its snapshots with
  // (pure, validator-free; the broker's pre-send check uses the same file).
  "packages/work/src/runs/listing-canonical.ts",
  "packages/work/src/runs/producer.ts",
  "packages/work/src/runs/workflow.ts",
  "packages/work/src/runtime/leases.ts",
  "packages/work/src/runtime/run-steps.ts",
  "packages/work/src/spine-sql.ts",
]);
// MORROW_VAULT_ (the vault KEKs, ADR-0022 item 7) binds only to the broker as well, and so
// does STRIPE_ (M5 PR-1: the restricted key, the webhook secret and the configuration).
const providerCredentialName =
  /^(WORKOS_|MORROW_DB_PASSWORD_|MORROW_VAULT_|SHOPIFY_|ANTHROPIC_|OPENAI_|E2B_|NEON_|PG|STRIPE_)/i;
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
  // M5 PR-1: a Stripe restricted key or a webhook signing secret is never committed; a
  // portal configuration only as the reviewed id of docs/decisions/stripe-staging.json,
  // inside the staging broker's STRIPE_CONFIGURATION_JSON and nowhere else.
  ["stripe_restricted_key", /\brk_(?:test|live)_/],
  ["stripe_webhook_secret", /\bwhsec_/],
  ["stripe_portal_configuration", /\bbpc_[A-Za-z0-9]+/],
  ["cloudflare_account", /"account_id"|\b[0-9a-f]{32}\b/],
  ["route", /"routes?"\s*:/],
]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// P05.T01ab (ADR-0019 item 8): the api's per-address sign-in limits, exact per
// environment: login start 10, the callback 20 and signup 5 per 60 s, in namespaces
// 7001-7003 (development), 7101-7103 (staging) and 7201-7203 (production). The session
// routes' limit (ADR-0019 item 8 applied to them; apps/api/src/session-limit.ts) is 120 per
// 60 s in 7006, 7106 and 7206, the api's next ids after the connector's 7004-7005 block.
// Each environment keeps its own hundred (70xx, 71xx, 72xx); no namespace is shared.
export function edgeRateLimits(environment) {
  const base = { development: 7000, staging: 7100, production: 7200 }[environment];
  return [
    ["LOGIN_START_LIMITER", 1, 10],
    ["LOGIN_CALLBACK_LIMITER", 2, 20],
    ["SIGNUP_LIMITER", 3, 5],
    ["SESSION_LIMITER", 6, 120],
  ].map(([name, offset, limit]) => ({
    name,
    namespace_id: String(base + offset),
    simple: { limit, period: 60 },
  }));
}

// M2 PR-2 review (ADR-0019 items 6 and 8 applied to the connector, the second public
// Worker): the connector's per-address Shopify ingress limits, exact per environment:
// launch, status and callback 20 and webhooks 300 per 60 s, in namespaces 7004-7005
// (development), 7104-7105 (staging) and 7204-7205 (production), after the api's. Webhooks
// are keyed by address too, never by app key (an unknown app key would be a fresh budget,
// and a public one would let anyone starve that store's deliveries), with the higher limit
// because Shopify's delivery addresses carry every store's webhooks.
export function edgeConnectorRateLimits(environment) {
  const base = { development: 7004, staging: 7104, production: 7204 }[environment];
  return [
    ["INSTALL_LIMITER", 20],
    ["WEBHOOK_LIMITER", 300],
  ].map(([name, limit], i) => ({
    name,
    namespace_id: String(base + i),
    simple: { limit, period: 60 },
  }));
}

// M2 PR-3 (review finding B8): the connector's one cron trigger, exact in every
// environment: every five minutes it re-drives, by id only, the webhook inbox rows still
// received two minutes after they arrived and the tokens of ended installations whose
// destruction is not yet recorded. It is a schedule on the existing Worker, not a new
// resource: the inbox row is the queue (no Queue binding), and no other Worker has a
// trigger.
export const edgeConnectorCrons = Object.freeze(["*/5 * * * *"]);

// P04.T01i D1 and D6 (AC01, AC02): only the staging api is on workers.dev; every staging
// Worker keeps Workers Logs (invocation logs and traces off); development and production
// keep observability off. Compared exactly, per Worker and environment.
export const edgeStagingObservability = Object.freeze({
  enabled: true,
  head_sampling_rate: 1,
  traces: Object.freeze({ enabled: false }),
  logs: Object.freeze({
    enabled: true,
    invocation_logs: false,
    head_sampling_rate: 1,
    persist: true,
  }),
});
export const edgeObservability = (environment) =>
  environment === "staging" ? edgeStagingObservability : Object.freeze({ enabled: false });
// v1 PR 1 (ADR-0035 item 2, amending ADR-0019 item 2 and ADR-0022 item 6): the staging
// connector too, so that Shopify can reach its launch, callback and webhook paths. These
// two are the public Workers; the broker and the orchestrator never are.
export const edgePublicWorkers = Object.freeze(["api", "connector"]);
export const edgeWorkersDev = (worker, environment) =>
  edgePublicWorkers.includes(worker) && environment === "staging";
// P04.T01i D1 (placement, 2026-10-21): the staging api and broker run in the region of the
// committed Neon endpoint, so the api's sequential database round trips stay inside that
// region instead of crossing from the edge nearest the caller (the first deploy's
// SMOKE_DATABASE_PATH). It is a performance setting and changes no binding, route, secret
// or trust boundary. Development has no hosted database and production waits for its own,
// so neither has placement; the orchestrator and the connector never have it.
export const edgePlacementWorkers = Object.freeze(["api", "broker"]);
// Neon's AWS region id ("aws-us-east-1") and its Cloudflare targeted-placement region
// ("aws:us-east-1"). Any other shape, another cloud included, is null and fails the check.
const neonAwsRegion = (regionId) =>
  typeof regionId === "string"
    ? (/^aws-([a-z]{2}-[a-z]+-[1-9])$/.exec(regionId)?.[1] ?? null)
    : null;
export function edgePlacementRegion(regionId) {
  const region = neonAwsRegion(regionId);
  return region === null ? null : "aws:" + region;
}
// P04.T01i D1 (AC01): each Worker's var names, exactly, per environment. Only the staging
// api and broker carry configuration; the orchestrator carries MORROW_ENVIRONMENT (M3 PR-2).
// M5: while the staging Stripe switch is on, the staging api and broker also carry its vars
// (edgeStripeVarNames); while it is off, neither has them. M3 PR-2: likewise the
// model-provider switch's vars (edgeModelVarNames) on the staging api, broker and
// orchestrator. v1 PR 3: likewise the apply switch's var (edgeApplyVarNames) on the staging
// api and broker.
export function edgeVarNames(worker, environment, stripe = "off", model = "off", apply = "off") {
  const modelVars = model === "on" ? edgeModelVarNames(worker, environment) : [];
  if (worker === "orchestrator") return ["MORROW_ENVIRONMENT", ...modelVars];
  if (environment !== "staging") return ["MORROW_ENVIRONMENT"];
  // v1 PR 1: the staging connector's two reviewed identifiers (its own origin and the
  // api's; the database binding byte-equal to the api's).
  if (worker === "connector")
    return ["MORROW_ENVIRONMENT", "CONNECTOR_CONFIGURATION_JSON", "MORROW_DATABASE_BINDING_JSON"];
  const stripeVars = [
    ...(stripe === "on" ? edgeStripeVarNames(worker, environment) : []),
    ...(apply === "on" ? edgeApplyVarNames(worker, environment) : []),
  ];
  return worker === "api"
    ? [
        "MORROW_ENVIRONMENT",
        "LOGIN_CONFIGURATION_JSON",
        "WORKSPACE_CONFIGURATION_JSON",
        "LOGOUT_CONFIGURATION_JSON",
        "MORROW_DATABASE_BINDING_JSON",
        "LOGIN_CHALLENGE_JSON",
        ...stripeVars,
        ...modelVars,
      ]
    : [
        "MORROW_ENVIRONMENT",
        "LOGIN_CONFIGURATION_JSON",
        "MORROW_DATABASE_BINDING_JSON",
        "TURNSTILE_CONFIGURATION_JSON",
        ...stripeVars,
        ...modelVars,
      ];
}
// M3 PR-2, the model-provider switch (ADR-0022 items 7 and 10; committed off): its runtime
// image is the var MORROW_MODEL_PROVIDER ("anthropic") on the staging api, broker and
// orchestrator, the orchestrator's reviewed MORROW_DATABASE_BINDING_JSON (byte-equal to the
// api's), and the broker's ANTHROPIC_API_KEY (brokerRequiredSecretsFor("staging", stripe,
// "on")). Development's committed config never carries them, and production has no switch.
export const edgeModelProviderVar = "MORROW_MODEL_PROVIDER";
export const edgeModelProviderValue = "anthropic";
export const edgeModelSecretNames = Object.freeze(["ANTHROPIC_API_KEY"]);
export function edgeModelVarNames(worker, environment) {
  if (environment !== "staging") return [];
  if (worker === "api" || worker === "broker") return [edgeModelProviderVar];
  if (worker === "orchestrator") return [edgeModelProviderVar, "MORROW_DATABASE_BINDING_JSON"];
  return [];
}
// Every model-switch name a Worker's resolved configuration may carry, and the set the switch
// requires there: all of the Worker's own while it is on in staging, none otherwise. (The
// orchestrator's database binding counts only on the orchestrator: the api and broker carry
// theirs whatever the switch.)
export function edgeModelNamesRequired(worker, environment, model) {
  if (model !== "on") return [];
  const names = edgeModelVarNames(worker, environment);
  return worker === "broker" && names.length ? [...names, ...edgeModelSecretNames] : names;
}
const edgeModelNames = (worker) =>
  worker === "orchestrator"
    ? [edgeModelProviderVar, "MORROW_DATABASE_BINDING_JSON", ...edgeModelSecretNames]
    : [edgeModelProviderVar, ...edgeModelSecretNames];
// The reviewed staging model-provider record (M3 PR-2; committed off): provider anthropic;
// `switch` "off" until one reviewed commit turns it "on"; the Anthropic Console workspace's
// monthly spend limit (a decimal USD string, required while on) and the date the owner
// observed it. Returns the switch, or throws.
export function reviewedModelRecord(record) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join() !==
      "environment_kind,monthly_spend_limit_usd,observed_on,provider,schema_version,scope,switch" ||
    record.schema_version !== 1 ||
    record.environment_kind !== "staging" ||
    record.provider !== "anthropic" ||
    (record.switch !== "off" && record.switch !== "on") ||
    typeof record.scope !== "string" ||
    (record.monthly_spend_limit_usd !== null &&
      (typeof record.monthly_spend_limit_usd !== "string" ||
        !/^[1-9][0-9]{0,5}(\.[0-9]{2})?$/.test(record.monthly_spend_limit_usd) ||
        typeof record.observed_on !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(record.observed_on))) ||
    (record.monthly_spend_limit_usd === null && record.observed_on !== null) ||
    // On means a spend-limited Console workspace exists (ADR-0022 item 10 "Accounts").
    (record.switch === "on" && record.monthly_spend_limit_usd === null)
  )
    throw Error("EDGE_STAGING_MODEL_RECORD");
  return Object.freeze({ switch: record.switch });
}
// v1 PR 3, the apply switch (ADR-0022 items 7 and 9; committed off): its runtime image is
// the var MORROW_SHOPIFY_WRITE ("on") on the staging api and broker; no secret (the store
// tokens are already the vault's). Development's committed config never carries it, and
// production has no switch until the ADR-0007 item 9 custody ADR.
export const edgeApplyVar = "MORROW_SHOPIFY_WRITE";
export const edgeApplyValue = "on";
export function edgeApplyVarNames(worker, environment) {
  if (environment !== "staging") return [];
  return worker === "api" || worker === "broker" ? [edgeApplyVar] : [];
}
// The reviewed staging apply record (v1 PR 3; committed off): `switch` "off" until one
// reviewed commit turns it "on". Returns the switch, or throws.
export function reviewedApplyRecord(record) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join() !== "environment_kind,schema_version,scope,switch" ||
    record.schema_version !== 1 ||
    record.environment_kind !== "staging" ||
    (record.switch !== "off" && record.switch !== "on") ||
    typeof record.scope !== "string"
  )
    throw Error("EDGE_STAGING_APPLY_RECORD");
  return Object.freeze({ switch: record.switch });
}
// M5, the Stripe switch (owner decision (c), 2026-10-21): its runtime image is the var
// MORROW_STRIPE_MODE ("test") on the staging api and broker, and on the broker also the
// reviewed STRIPE_CONFIGURATION_JSON (docs/decisions/stripe-staging.json) and the two
// Stripe secrets (brokerRequiredSecretsFor("staging", "on")). Development's committed
// config never carries them (it may name no reviewed identifier), and production holds
// Stripe until the ADR-0007 item 9 custody ADR.
export const edgeStripeModeVar = "MORROW_STRIPE_MODE";
export const edgeStripeModeTest = "test";
export const edgeStripeSecretNames = Object.freeze([
  "STRIPE_RESTRICTED_KEY",
  "STRIPE_WEBHOOK_SECRET",
]);
export function edgeStripeVarNames(worker, environment) {
  if (environment !== "staging") return [];
  if (worker === "api") return [edgeStripeModeVar];
  if (worker === "broker") return [edgeStripeModeVar, "STRIPE_CONFIGURATION_JSON"];
  return [];
}
// Every Stripe name a Worker's resolved configuration may carry (vars and required
// secrets), and the set the switch requires there: all of the Worker's own while it is on
// in staging, none otherwise. Any difference is a mixed state.
const edgeStripeNames = [edgeStripeModeVar, "STRIPE_CONFIGURATION_JSON", ...edgeStripeSecretNames];
export function edgeStripeNamesRequired(worker, environment, stripe) {
  if (stripe !== "on") return [];
  const names = edgeStripeVarNames(worker, environment);
  return worker === "broker" && names.length ? [...names, ...edgeStripeSecretNames] : names;
}
// The reviewed staging Stripe record (M5 PR-1; the switch, owner decision (c), 2026-10-21):
// test mode; `switch`, "off" until one reviewed commit turns it "on"; the portal
// configuration id (null until the owner creates it, and required while the switch is on)
// and the tax flags. Returns the switch and the exact STRIPE_CONFIGURATION_JSON text the
// record admits while the switch is on (null while it is off), or throws.
export function reviewedStripeRecord(record) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join() !==
      "automatic_tax,billing_address_collection,environment_kind,mode,observed_on,portal_configuration_id,schema_version,scope,switch" ||
    record.schema_version !== 1 ||
    record.environment_kind !== "staging" ||
    record.mode !== "test" ||
    (record.switch !== "off" && record.switch !== "on") ||
    typeof record.automatic_tax !== "boolean" ||
    !["auto", "required"].includes(record.billing_address_collection) ||
    typeof record.scope !== "string" ||
    (record.portal_configuration_id !== null &&
      (typeof record.portal_configuration_id !== "string" ||
        !/^bpc_[A-Za-z0-9]{8,64}$/.test(record.portal_configuration_id) ||
        typeof record.observed_on !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(record.observed_on))) ||
    (record.portal_configuration_id === null && record.observed_on !== null) ||
    // On means fully configured: without the saved portal configuration the broker would
    // hold Stripe after the api had already opened the checkout's rows.
    (record.switch === "on" && record.portal_configuration_id === null)
  )
    throw Error("EDGE_STAGING_STRIPE_RECORD");
  return Object.freeze({
    switch: record.switch,
    configurationJson:
      record.switch === "on"
        ? JSON.stringify({
            schemaVersion: 1,
            portalConfigurationId: record.portal_configuration_id,
            automaticTax: record.automatic_tax,
            billingAddressCollection: record.billing_address_collection,
          })
        : null,
  });
}
// Key-order-free comparison for the observability blocks.
const canonicalJson = (value) =>
  JSON.stringify(value, (_key, child) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(
          Object.keys(child)
            .sort()
            .map((key) => [key, child[key]]),
        )
      : child,
  );
const globalPattern = (pattern) =>
  new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
const matchesOf = (pattern, text) => [...text.matchAll(globalPattern(pattern))].map((m) => m[0]);
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

// The runtimes' own parsers, loaded once per process.
let stagingParsers;
const loadStagingParsers = () =>
  (stagingParsers ??= (async () => {
    const { tsImport } = await import("tsx/esm/api");
    const here = import.meta.url;
    const [binding, login, protocol, guard, connector] = await Promise.all([
      tsImport("../packages/identity/src/managed-workspace-binding.ts", here),
      tsImport("../packages/identity/src/standalone-login-protocol.ts", here),
      tsImport("../packages/identity/src/broker-protocol.ts", here),
      tsImport("../apps/api/src/abuse-guard.ts", here),
      // v1 PR 1: the connector's own configuration parser.
      tsImport("../apps/shopify-connector/worker/environment.ts", here),
    ]);
    return Object.freeze({
      captureManagedWorkspaceBinding: binding.captureManagedWorkspaceBinding,
      parseLoginConfiguration: login.parseLoginConfiguration,
      parseBrokerDatabaseBinding: protocol.parseBrokerDatabaseBinding,
      parseTurnstileConfiguration: protocol.parseTurnstileConfiguration,
      parseStripeConfiguration: protocol.parseStripeConfiguration,
      turnstileHostnameMismatch: protocol.turnstileHostnameMismatch,
      parseLoginChallengeConfiguration: guard.parseLoginChallengeConfiguration,
      parseConnectorConfiguration: connector.parseConnectorConfiguration,
    });
  })());

// P04.T01i D1 "Rules" (AC01) on the staging vars, with the runtimes' own parsers, and the
// narrowed P04.T02a AC24: a staging var may name only the reviewed WorkOS environment,
// application and client (docs/decisions/workos-staging.json), and from staging.json the
// bound `br-…` branch, the branch's direct endpoint (`neon.endpoint_host`, never `-pooler`),
// the Turnstile site key (`cloudflare.turnstile.site_key`, in LOGIN_CHALLENGE_JSON only) and
// the origin. Every origin use is D1's
// `https://${env.staging.name}.${workers_dev_subdomain}.workers.dev`, with the subdomain read
// from staging.json; the only other URLs are its callback and the WorkOS issuer, which the
// login parser fixes to the client. M5 PR-1: the broker's STRIPE_CONFIGURATION_JSON (only
// while the Stripe switch is on) must be byte-equal to the text
// docs/decisions/stripe-staging.json admits (its portal configuration id and tax flags) and
// parse with the broker's own parser; that id is then admitted inside that one var only.
// `stripe` is the reviewed record (reviewedStripeRecord), or null when it is unreadable or
// invalid (already a problem). Returns the problems, the identifiers a committed file may
// name, and `allowedIn(worker, name)`, the identifiers admitted in one var.
// v1 PR 1 (ADR-0035 item 2): the staging connector's CONNECTOR_CONFIGURATION_JSON names
// exactly its own origin, `https://${connector env.staging.name}.${workers_dev_subdomain}
// .workers.dev`, and the api's origin, parsed with the connector's own parser; its
// MORROW_DATABASE_BINDING_JSON is the api's, byte for byte. The connector's origin and
// hostname are admitted inside that one var only.
async function stagingValueChecks({ vars, apiName, connectorName, staging, workos, stripe }) {
  const {
    captureManagedWorkspaceBinding,
    parseLoginConfiguration,
    parseBrokerDatabaseBinding,
    parseTurnstileConfiguration,
    parseStripeConfiguration,
    turnstileHostnameMismatch,
    parseLoginChallengeConfiguration,
    parseConnectorConfiguration,
  } = await loadStagingParsers();
  const problems = [];
  const problem = (code, where) => problems.push(code + ":" + where);
  const text = (worker, name) =>
    typeof vars[worker]?.[name] === "string" ? vars[worker][name] : null;
  const subdomain = staging?.cloudflare?.workers_dev_subdomain;
  const subdomainOk =
    typeof subdomain === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain);
  const origin = subdomainOk ? `https://${apiName}.${subdomain}.workers.dev` : null;
  if (origin === null || staging?.cloudflare?.origin !== origin)
    problem("EDGE_STAGING_ORIGIN", "staging.json");
  // v1 PR 1: the connector's own origin, from its resolved staging name and staging.json's
  // subdomain; it must be the connector of staging.json's Worker names.
  const connectorOrigin =
    subdomainOk &&
    typeof connectorName === "string" &&
    connectorName === staging?.cloudflare?.workers?.connector
      ? `https://${connectorName}.${subdomain}.workers.dev`
      : null;
  if (connectorOrigin === null) problem("EDGE_STAGING_ORIGIN", "connector:staging");
  else
    try {
      const parsed = parseConnectorConfiguration(
        text("connector", "CONNECTOR_CONFIGURATION_JSON"),
        "staging",
      );
      if (
        parsed === null ||
        parsed.origin !== connectorOrigin ||
        parsed.apiOrigin !== origin ||
        text("connector", "CONNECTOR_CONFIGURATION_JSON") !==
          JSON.stringify({ schemaVersion: 1, origin: connectorOrigin, apiOrigin: origin })
      )
        problem("EDGE_STAGING_CONNECTOR_CONFIGURATION", "connector:staging");
    } catch {
      problem("EDGE_STAGING_CONNECTOR_CONFIGURATION", "connector:staging");
    }
  if (
    text("connector", "MORROW_DATABASE_BINDING_JSON") === null ||
    text("connector", "MORROW_DATABASE_BINDING_JSON") !==
      text("api", "MORROW_DATABASE_BINDING_JSON")
  )
    problem("EDGE_STAGING_SHARED_VARS", "connector:staging:MORROW_DATABASE_BINDING_JSON");
  const neon = staging?.neon ?? {};
  const allowed = new Set(
    [workos?.environment_id, workos?.application_id, workos?.client_id, neon.branch_id].filter(
      (value) => typeof value === "string",
    ),
  );
  // The api's four configuration values together, as mapper step 7 reads them, then the
  // full login parser the broker and gate 4 use.
  const login = text("api", "LOGIN_CONFIGURATION_JSON");
  try {
    const captured = captureManagedWorkspaceBinding({
      loginConfigurationJson: login,
      workspaceConfigurationJson: text("api", "WORKSPACE_CONFIGURATION_JSON"),
      logoutConfigurationJson: text("api", "LOGOUT_CONFIGURATION_JSON"),
      bindingJson: text("api", "MORROW_DATABASE_BINDING_JSON"),
    });
    const parsed = await parseLoginConfiguration(login);
    if (parsed.retentionTier !== "staging" || parsed.origin !== captured.origin)
      problem("EDGE_STAGING_LOGIN_CONFIGURATION", "api:staging");
    // The login, workspace and logout origins and the redirect base are one value here.
    if (origin === null || captured.origin !== origin)
      problem("EDGE_STAGING_ORIGIN", "api:staging");
  } catch {
    problem("EDGE_STAGING_LOGIN_CONFIGURATION", "api:staging");
  }
  // The binding: the committed `staging` branch of the committed project, through that
  // branch's committed direct endpoint (any other well-formed `ep-` host, such as the root
  // branch's, fails), never a pooler.
  try {
    const binding = parseBrokerDatabaseBinding(text("api", "MORROW_DATABASE_BINDING_JSON"));
    const label = binding.hostname.split(".")[0];
    if (
      binding.environment !== "staging" ||
      binding.projectId !== neon.project_id ||
      binding.branchId !== neon.branch_id ||
      binding.branchId === neon.root_branch_id ||
      binding.database !== "morrow" ||
      typeof neon.endpoint_host !== "string" ||
      binding.hostname !== neon.endpoint_host ||
      label.includes("-pooler") ||
      !binding.hostname.endsWith(".aws.neon.tech")
    )
      throw Error("EDGE_STAGING_BINDING");
    allowed.add(binding.hostname);
  } catch {
    problem("EDGE_STAGING_BINDING", "api:staging");
  }
  for (const name of ["LOGIN_CONFIGURATION_JSON", "MORROW_DATABASE_BINDING_JSON"])
    if (text("broker", name) === null || text("broker", name) !== text("api", name))
      problem("EDGE_STAGING_SHARED_VARS", "broker:staging:" + name);
  // M3 PR-2: the orchestrator's binding (only while the model-provider switch is on) is the
  // api's, byte for byte.
  if (
    text("orchestrator", "MORROW_DATABASE_BINDING_JSON") !== null &&
    text("orchestrator", "MORROW_DATABASE_BINDING_JSON") !==
      text("api", "MORROW_DATABASE_BINDING_JSON")
  )
    problem("EDGE_STAGING_SHARED_VARS", "orchestrator:staging:MORROW_DATABASE_BINDING_JSON");
  // The two challenge vars: each runtime's parser, the Turnstile hostname the origin's, and
  // the actions byte-equal (both parsers refuse a duplicate member, so JSON.parse agrees).
  // The site key is staging.json's widget's: another well-formed `0x` key fails.
  const reviewedSiteKey = staging?.cloudflare?.turnstile?.site_key;
  let siteKey = null;
  let apiActions = null;
  let brokerActions = null;
  try {
    siteKey = parseLoginChallengeConfiguration(text("api", "LOGIN_CHALLENGE_JSON")).siteKey;
    apiActions = JSON.stringify(JSON.parse(text("api", "LOGIN_CHALLENGE_JSON")).actions);
  } catch {
    problem("EDGE_STAGING_CHALLENGE", "api:staging");
  }
  try {
    parseTurnstileConfiguration(text("broker", "TURNSTILE_CONFIGURATION_JSON"), origin);
    brokerActions = JSON.stringify(
      JSON.parse(text("broker", "TURNSTILE_CONFIGURATION_JSON")).actions,
    );
  } catch (error) {
    problem(
      error?.message === turnstileHostnameMismatch
        ? "EDGE_STAGING_ORIGIN"
        : "EDGE_STAGING_CHALLENGE",
      "broker:staging",
    );
  }
  if (apiActions !== null && brokerActions !== null && apiActions !== brokerActions)
    problem("EDGE_STAGING_CHALLENGE_ACTIONS", "staging");
  // M5 PR-1: the Stripe configuration, pinned to its reviewed record (none while off).
  const scoped = new Map();
  const reviewedStripe = stripe?.configurationJson ?? null;
  const stripeJson = vars.broker?.STRIPE_CONFIGURATION_JSON;
  if (stripeJson !== undefined) {
    let parsed = null;
    try {
      parsed = parseStripeConfiguration(stripeJson);
    } catch {
      parsed = null;
    }
    if (parsed === null || reviewedStripe === null || stripeJson !== reviewedStripe)
      problem("EDGE_STAGING_STRIPE_CONFIGURATION", "broker:staging");
    else scoped.set("broker:STRIPE_CONFIGURATION_JSON", new Set([parsed.portalConfigurationId]));
  }
  const allowedIn = (worker, name) => scoped.get(worker + ":" + name) ?? new Set();
  // Every value of every staging Worker: identifiers, URLs, workers.dev hosts and keys.
  const urls = new Set(
    origin === null
      ? []
      : [
          origin,
          origin + "/auth/workos/callback",
          "https://api.workos.com/user_management/" + workos?.client_id,
        ],
  );
  const host = origin === null ? null : new URL(origin).hostname;
  // v1 PR 1: the connector's origin and hostname, inside its configuration var only.
  const connectorVar = (worker, name) =>
    connectorOrigin !== null && worker === "connector" && name === "CONNECTOR_CONFIGURATION_JSON";
  const connectorHost = connectorOrigin === null ? null : new URL(connectorOrigin).hostname;
  for (const [worker, record] of Object.entries(vars))
    for (const [name, value] of Object.entries(record ?? {})) {
      if (typeof value !== "string") continue;
      const where = worker + ":staging:" + name;
      for (const [kind, pattern] of committedIdentifierPatterns)
        if (
          matchesOf(pattern, value).some(
            (match) => !allowed.has(match) && !allowedIn(worker, name).has(match),
          )
        )
          problem("EDGE_STAGING_VALUE_" + kind.toUpperCase(), where);
      if (
        matchesOf(/https?:\/\/[^\s"\\]*/i, value).some(
          (url) => !urls.has(url) && !(connectorVar(worker, name) && url === connectorOrigin),
        )
      )
        problem("EDGE_STAGING_VALUE_URL", where);
      if (
        matchesOf(/[A-Za-z0-9.-]*\.workers\.dev\b/i, value).some(
          (match) => match !== host && !(connectorVar(worker, name) && match === connectorHost),
        )
      )
        problem("EDGE_STAGING_VALUE_HOSTNAME", where);
      const keys = matchesOf(/\b0x[0-9A-Za-z_-]*/, value);
      if (
        keys.length &&
        (worker !== "api" ||
          name !== "LOGIN_CHALLENGE_JSON" ||
          typeof reviewedSiteKey !== "string" ||
          keys.some((key) => key !== siteKey || key !== reviewedSiteKey))
      )
        problem("EDGE_STAGING_VALUE_SITE_KEY", where);
    }
  return { problems, allowed, allowedIn };
}

// One Worker's resolved wrangler configuration (no account, credential or network).
export async function resolvedEdgeConfig(workerKey, environment, root = repositoryRoot) {
  const worker = edgeWorkers.find((candidate) => candidate.key === workerKey);
  if (!worker || !edgeEnvironments.includes(environment)) throw Error("EDGE_USAGE");
  const { unstable_readConfig } = await loadWranglerApi();
  return captureConsole(() =>
    unstable_readConfig(
      {
        config: workerConfigPath(worker, root),
        env: environment === "development" ? undefined : environment,
      },
      {},
    ),
  ).value;
}

// Resolved-configuration checks for AC01, AC04, AC22 (static) and AC24, and P04.T01i AC01
// and AC02.
export async function verifyEdgeConfig({
  root = repositoryRoot,
  routesPath = join(repositoryRoot, "docs/contracts/workspace-routes.json"),
  stagingPath = join(repositoryRoot, "infra/environments/staging.json"),
  workosPath = join(repositoryRoot, "docs/decisions/workos-staging.json"),
  stripePath = join(repositoryRoot, "docs/decisions/stripe-staging.json"),
  modelPath = join(repositoryRoot, "docs/decisions/model-provider-staging.json"),
  applyPath = join(repositoryRoot, "docs/decisions/shopify-write-staging.json"),
} = {}) {
  const { tsImport } = await import("tsx/esm/api");
  const here = import.meta.url;
  const { selectedConfiguration } = await tsImport(
    "../packages/infrastructure/src/selected-stack.ts",
    here,
  );
  const {
    brokerRequiredSecretsFor,
    brokerStripeSecrets,
    stripeModeTest,
    stripeModeVar,
    brokerModelSecrets,
    modelProviderVar,
    modelProviderAnthropic,
    shopifyWriteVar,
    shopifyWriteOn,
  } = await tsImport("../packages/identity/src/broker-protocol.ts", here);
  const { reservedWorkerPaths } = await tsImport("../apps/api/src/reserved-paths.ts", here);
  const { unstable_readConfig } = await loadWranglerApi();
  const problems = [];
  const resolved = {};
  const texts = {};
  const stagingVars = {};
  const stagingPlacements = {};
  let apiStagingName = null;
  let connectorStagingName = null;
  const problem = (code, where) => problems.push(code + ":" + where);
  // M5, the Stripe switch (owner decision (c), 2026-10-21): the reviewed record decides it
  // for the staging Workers; an unreadable or invalid record is a problem and counts as off,
  // so nothing Stripe is admitted. Development and production are always off.
  const stripeRecord = readJson(stripePath);
  let stripe = null;
  if (stripeRecord === null) problem("EDGE_STAGING_RECORD_UNREADABLE", "stripe-staging.json");
  else
    try {
      stripe = reviewedStripeRecord(stripeRecord);
    } catch {
      problem("EDGE_STAGING_STRIPE_RECORD", "stripe-staging.json");
    }
  const stripeSwitch = (environment) =>
    environment === "staging" && stripe?.switch === "on" ? "on" : "off";
  // M3 PR-2, the model-provider switch: the same protocol as Stripe's.
  const modelRecord = readJson(modelPath);
  let model = null;
  if (modelRecord === null)
    problem("EDGE_STAGING_RECORD_UNREADABLE", "model-provider-staging.json");
  else
    try {
      model = reviewedModelRecord(modelRecord);
    } catch {
      problem("EDGE_STAGING_MODEL_RECORD", "model-provider-staging.json");
    }
  const modelSwitch = (environment) =>
    environment === "staging" && model?.switch === "on" ? "on" : "off";
  // v1 PR 3, the apply switch: the same protocol, with no secret.
  const applyRecord = readJson(applyPath);
  let applied = null;
  if (applyRecord === null) problem("EDGE_STAGING_RECORD_UNREADABLE", "shopify-write-staging.json");
  else
    try {
      applied = reviewedApplyRecord(applyRecord);
    } catch {
      problem("EDGE_STAGING_APPLY_RECORD", "shopify-write-staging.json");
    }
  const applySwitch = (environment) =>
    environment === "staging" && applied?.switch === "on" ? "on" : "off";
  if (shopifyWriteVar !== edgeApplyVar || shopifyWriteOn !== edgeApplyValue)
    problem("EDGE_APPLY_SWITCH_NAMES", "broker-protocol");
  if (
    modelProviderVar !== edgeModelProviderVar ||
    modelProviderAnthropic !== edgeModelProviderValue ||
    !same([...brokerModelSecrets], [...edgeModelSecretNames])
  )
    problem("EDGE_MODEL_SWITCH_NAMES", "broker-protocol");
  // The names checked here are the ones the api and the broker read.
  if (
    stripeModeVar !== edgeStripeModeVar ||
    stripeModeTest !== edgeStripeModeTest ||
    !same([...brokerStripeSecrets], [...edgeStripeSecretNames])
  )
    problem("EDGE_STRIPE_SWITCH_NAMES", "broker-protocol");
  for (const worker of edgeWorkers) {
    const path = workerConfigPath(worker, root);
    texts[worker.key] = readFileSync(path, "utf8");
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
      if (config.workers_dev !== edgeWorkersDev(worker.key, environment))
        problem("EDGE_FLAG_WORKERS_DEV", where);
      for (const key of [
        "preview_urls",
        "logpush",
        "upload_source_maps",
        "keep_vars",
        "send_metrics",
      ])
        if (config[key] !== false) problem("EDGE_FLAG_" + key.toUpperCase(), where);
      if (canonicalJson(config.observability) !== canonicalJson(edgeObservability(environment)))
        problem("EDGE_FLAG_OBSERVABILITY", where);
      if (!emptyValue(config.routes) || !emptyValue(config.route)) problem("EDGE_ROUTES", where);
      // Placement (P04.T01i D1): exactly {mode: "targeted", region} on the staging api and
      // broker, its region checked against staging.json below; absent everywhere else, an
      // explicit `{mode: "off"}` included.
      const placement = config.placement;
      if (!edgePlacementWorkers.includes(worker.key)) {
        if (placement !== undefined) problem("EDGE_PLACEMENT_WORKER", where);
      } else if (environment !== "staging") {
        if (placement !== undefined) problem("EDGE_PLACEMENT_ENVIRONMENT", where);
      } else if (
        placement === null ||
        typeof placement !== "object" ||
        !same(Object.keys(placement).sort(), ["mode", "region"]) ||
        placement.mode !== "targeted" ||
        typeof placement.region !== "string"
      )
        problem("EDGE_PLACEMENT_STAGING", where);
      else stagingPlacements[worker.key] = placement.region;
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
      // The var allowlist (P04.T01i AC01): exactly these names (with, M5, the Stripe
      // switch's vars while it is on), string values, the Worker's own environment and the
      // switch's one mode.
      const switched = stripeSwitch(environment);
      const modelSwitched = modelSwitch(environment);
      const applySwitched = applySwitch(environment);
      const varNames = edgeVarNames(
        worker.key,
        environment,
        switched,
        modelSwitched,
        applySwitched,
      );
      if (
        vars === null ||
        typeof vars !== "object" ||
        !same(Object.keys(vars).sort(), [...varNames].sort()) ||
        Object.values(vars).some((value) => typeof value !== "string") ||
        (varNames.includes("MORROW_ENVIRONMENT") && vars.MORROW_ENVIRONMENT !== environment) ||
        (varNames.includes(edgeStripeModeVar) && vars[edgeStripeModeVar] !== edgeStripeModeTest) ||
        (varNames.includes(edgeModelProviderVar) &&
          vars[edgeModelProviderVar] !== edgeModelProviderValue) ||
        (varNames.includes(edgeApplyVar) && vars[edgeApplyVar] !== edgeApplyValue)
      )
        problem("EDGE_VARS", where);
      // v1 PR 3: no mixed apply state: while the switch is off no Worker carries its var;
      // while it is on, exactly the staging api and broker do.
      const applyCarried =
        vars !== null && typeof vars === "object" && Object.hasOwn(vars, edgeApplyVar);
      const applyRequired =
        applySwitched === "on" ? edgeApplyVarNames(worker.key, environment) : [];
      if (applyCarried !== applyRequired.length > 0) problem("EDGE_APPLY_SWITCH_MIXED", where);
      // M3 PR-2: no mixed model-provider state, as for Stripe.
      const modelCarried = edgeModelNames(worker.key).filter(
        (name) =>
          (worker.key === "orchestrator" || name !== "MORROW_DATABASE_BINDING_JSON") &&
          ((vars !== null && typeof vars === "object" && Object.hasOwn(vars, name)) ||
            (Array.isArray(required) && required.includes(name))),
      );
      if (
        !same(
          modelCarried.sort(),
          [...edgeModelNamesRequired(worker.key, environment, modelSwitched)].sort(),
        )
      )
        problem("EDGE_MODEL_SWITCH_MIXED", where);
      // M5: no mixed Stripe state. While the switch is off no Worker carries a Stripe var or
      // secret; while it is on the staging api carries its mode and the staging broker its
      // mode, its configuration and both secrets.
      const carried = edgeStripeNames.filter(
        (name) =>
          (vars !== null && typeof vars === "object" && Object.hasOwn(vars, name)) ||
          (Array.isArray(required) && required.includes(name)),
      );
      if (
        !same(
          carried.sort(),
          [...edgeStripeNamesRequired(worker.key, environment, switched)].sort(),
        )
      )
        problem("EDGE_STRIPE_SWITCH_MIXED", where);
      if (environment === "staging") {
        stagingVars[worker.key] = vars;
        if (worker.key === "api") apiStagingName = config.name;
        if (worker.key === "connector") connectorStagingName = config.name;
      }
      if (worker.key === "broker") {
        if (
          !Array.isArray(required) ||
          new Set(required).size !== required.length ||
          !same(
            [...required].sort(),
            [
              ...brokerRequiredSecretsFor(
                environment,
                stripeSwitch(environment),
                modelSwitch(environment),
              ),
            ].sort(),
          )
        )
          problem("EDGE_BROKER_SECRETS", where);
      } else if (!same(required, [])) problem("EDGE_SECRETS_REQUIRED_NOT_EMPTY", where);
      if (
        worker.key === "connector" &&
        !same(config.services, [
          { binding: "BROKER", service: expected.broker, entrypoint: "ConnectorBroker" },
        ])
      )
        problem("EDGE_CONNECTOR_BROKER_BINDING", where);
      if (
        worker.key === "connector" &&
        !same(config.ratelimits, edgeConnectorRateLimits(environment))
      )
        problem("EDGE_CONNECTOR_RATELIMITS", where);
      if (worker.key === "connector" && !same(config.triggers, { crons: [...edgeConnectorCrons] }))
        problem("EDGE_CONNECTOR_TRIGGERS", where);
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
        // M3 PR-2: ListingsRunWorkflow replaces MorrowWorkWorkflow; the broker's
        // RuntimeBroker entrypoint and the one-minute cron of pending starts.
        if (
          !same(config.workflows, [
            {
              name: prefix + "-listings-run",
              binding: "LISTINGS_RUN",
              class_name: "ListingsRunWorkflow",
            },
          ]) ||
          !same(config.services, [
            { binding: "BROKER", service: expected.broker, entrypoint: "RuntimeBroker" },
          ]) ||
          !same(config.triggers, { crons: ["* * * * *"] }) ||
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
      resolved[where] = {
        name: config.name,
        bindings: names,
        services: config.services ?? [],
        placement: placement ?? null,
      };
    }
  }
  // P04.T01i D1: the staging values, then the committed text. A reviewed staging identifier
  // may appear only inside the api's or the broker's own env.staging.vars values. Each
  // file's matches are counted as a multiset, the reviewed matches inside that Worker's
  // resolved staging values are taken away, and any remainder (a comment, another block,
  // a second copy) is refused; the other Workers' files name none.
  const staging = readJson(stagingPath);
  const workos = readJson(workosPath);
  if (staging === null) problem("EDGE_STAGING_RECORD_UNREADABLE", "staging.json");
  if (workos === null) problem("EDGE_STAGING_RECORD_UNREADABLE", "workos-staging.json");
  const checked = await stagingValueChecks({
    vars: stagingVars,
    apiName: apiStagingName ?? selectedConfiguration("staging").cloudflare.workers.api,
    connectorName: connectorStagingName,
    staging,
    workos,
    stripe,
  });
  problems.push(...checked.problems);
  // The placement region is the region of staging.json's Neon project (`neon.region_id`,
  // Neon's `aws-<region>`), and the committed endpoint lies in that region, so the staging
  // api and broker run beside the database the binding names.
  const placementRegion = edgePlacementRegion(staging?.neon?.region_id);
  const endpointHost = staging?.neon?.endpoint_host;
  if (
    placementRegion === null ||
    typeof endpointHost !== "string" ||
    !endpointHost.endsWith("." + neonAwsRegion(staging.neon.region_id) + ".aws.neon.tech")
  )
    problem("EDGE_PLACEMENT_REGION", "staging.json");
  for (const [worker, region] of Object.entries(stagingPlacements))
    if (placementRegion === null || region !== placementRegion)
      problem("EDGE_PLACEMENT_REGION", worker + ":staging");
  for (const worker of edgeWorkers)
    for (const [kind, pattern] of committedIdentifierPatterns) {
      const remaining = new Map();
      for (const match of matchesOf(pattern, texts[worker.key]))
        remaining.set(match, (remaining.get(match) ?? 0) + 1);
      if (["api", "broker", "orchestrator", "connector"].includes(worker.key))
        for (const [name, value] of Object.entries(stagingVars[worker.key] ?? {}))
          if (typeof value === "string")
            for (const match of matchesOf(pattern, value))
              if (checked.allowed.has(match) || checked.allowedIn(worker.key, name).has(match))
                remaining.set(match, (remaining.get(match) ?? 0) - 1);
      if ([...remaining.values()].some((count) => count > 0))
        problem("EDGE_COMMITTED_IDENTIFIER_" + kind.toUpperCase(), worker.key);
    }
  // No SPA route may fall under a Worker-reserved prefix (AC22).
  const routes = JSON.parse(readFileSync(routesPath, "utf8")).routes;
  const bases = [...new Set(reservedWorkerPaths.map((path) => path.replace(/\/\*$/, "")))];
  for (const route of routes)
    if (bases.some((base) => route.pattern === base || route.pattern.startsWith(base + "/")))
      problem("EDGE_ROUTE_SHADOWED_BY_WORKER", route.id);
  return {
    problems,
    resolved,
    reservedWorkerPaths: [...reservedWorkerPaths],
    stripeSwitch: stripeSwitch("staging"),
    modelSwitch: modelSwitch("staging"),
    applySwitch: applySwitch("staging"),
  };
}

const normalisedInputs = (meta, worker, root) =>
  Object.keys(meta.inputs).map((input) =>
    relative(root, resolve(root, worker.dir, input)).replaceAll("\\", "/"),
  );
// Bundle size bounds (AC02), also written to sizes.json. The broker bound is on the
// minified bytes. It was 256 KiB until 2026-10-22, when M2 PR-3 plus M3 PR-2 measured
// 264,479 bytes (the Neon driver is 56%); 384 KiB still keeps the broker small and
// auditable, and the hand-written Shopify checks (ADR-0008) and the plain HTTPS Claude
// adapter remain the choice. Confirmed by the owner on 2026-10-22 ("yes to all
// recommended"); 512 KiB would be this one line.
export const edgeBundleLimits = Object.freeze({
  apiGzipBytes: 3 * 1024 * 1024,
  apiWarnGzipBytes: 1024 * 1024,
  brokerBytes: 384 * 1024,
  // M3 PR-2: the orchestrator bundles the validators and the kernels; it keeps the api's
  // limit (3 MiB gzipped, the Workers free-plan cap).
  orchestratorGzipBytes: 3 * 1024 * 1024,
});
export function bundleSizeFailure(row) {
  if (row.worker === "api" && row.gzipBytes > edgeBundleLimits.apiGzipBytes)
    return "EDGE_API_BUNDLE_TOO_LARGE";
  if (row.worker === "broker" && row.bytes > edgeBundleLimits.brokerBytes)
    return "EDGE_BROKER_BUNDLE_TOO_LARGE";
  if (row.worker === "orchestrator" && row.gzipBytes > edgeBundleLimits.orchestratorGzipBytes)
    return "EDGE_ORCHESTRATOR_BUNDLE_TOO_LARGE";
  return null;
}
// Bundle exclusions (AC05).
export function bundleExclusions(worker, inputs, bundleText) {
  const failures = [];
  const banned =
    worker.key === "api"
      ? [
          [/^apps\/broker\//, "broker_source"],
          [/(^|\/)ajv\/dist\/compile\//, "ajv_compile"],
          [/(^|\/)node_modules\/unenv\/.*\/node\/https?(\/|\.mjs$)/, "node_http"],
          [/(^|\/)@shopify\//, "shopify_library"],
        ]
      : worker.key === "broker"
        ? [
            // M2 PR-2: the Neon driver is allowed (the vault login's transport,
            // vault-database.ts); the pool, the validators and the api stay out.
            [/controlled-neon-login-pool\.ts$/, "neon_pool"],
            [/runtime-validators\.mjs$/, "runtime_validators"],
            [/^apps\/api\//, "api_source"],
            // ADR-0008 item 1 as amended (owner answer 4): Shopify calls are hand-written
            // in the broker; no @shopify/ library is ever deployed.
            [/(^|\/)@shopify\//, "shopify_library"],
          ]
        : worker.key === "connector"
          ? [
              [/^apps\/(api|broker|workers|workspace-web)\//, "other_worker_source"],
              [/runtime-validators\.mjs$/, "runtime_validators"],
              [/(^|\/)@shopify\//, "shopify_library"],
            ]
          : [
              // M3 PR-2: the orchestrator includes only its reviewed packages/ allowlist.
              [/^apps\/(api|broker|shopify-connector|workspace-web)\//, "other_worker_source"],
              [/(^|\/)ajv\/dist\/compile\//, "ajv_compile"],
              [/(^|\/)@shopify\//, "shopify_library"],
            ];
  for (const [pattern, name] of banned)
    if (inputs.some((input) => pattern.test(input))) failures.push(name);
  // The connector may include only its reviewed packages/ allowlist.
  if (
    worker.key === "connector" &&
    inputs.some(
      (input) => input.startsWith("packages/") && !connectorPackageAllowlist.includes(input),
    )
  )
    failures.push("package_source");
  if (
    worker.key === "orchestrator" &&
    inputs.some(
      (input) => input.startsWith("packages/") && !orchestratorPackageAllowlist.includes(input),
    )
  )
    failures.push("package_source");
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
      const tooLarge = bundleSizeFailure(row);
      if (tooLarge) failures.push(tooLarge + ":" + where);
      if (worker.key === "api" && row.gzipBytes > edgeBundleLimits.apiWarnGzipBytes)
        row.warning = "api_bundle_over_1_MiB_gzipped";
      rows.push(row);
    }
  if (report)
    writeArtifact("edge/sizes.json", {
      generated_at: new Date().toISOString(),
      scope:
        "wrangler 4.116.0 `deploy --dry-run` bundles (esbuild 0.28.1); no account, credential or network. Local sizes only; hosted limits are measured in P04.T01i.",
      limits: edgeBundleLimits,
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
    // P05.T01ab adds the three per-address sign-in limiters and the session routes their
    // own fourth; still no text or secret binding.
    check(
      label("api_binds_only_broker_environment_and_limiters"),
      JSON.stringify([...(tables["morrow-development-api"] ?? [])].sort()) ===
        JSON.stringify(
          [
            "BROKER",
            "LOGIN_CALLBACK_LIMITER",
            "LOGIN_START_LIMITER",
            "MORROW_ENVIRONMENT",
            "SESSION_LIMITER",
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
