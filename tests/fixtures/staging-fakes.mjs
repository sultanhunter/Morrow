// Fakes for the staging tools (P04.T01i PR-B): wrangler, gh, git and neonctl as
// in-process functions with the real tools' result shape {status, stdout, stderr}, a
// Cloudflare API, a scriptable database, and a context builder. No fake ever starts a
// process or touches the network; every call is recorded (args, stdin, environment
// keys) so tests can prove where each value went. `emit` makes a fake print marker text
// on stdout and stderr, and `fail` makes it exit non-zero, so tests can show that tool
// output never reaches the staging tool's own output.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StagingError } from "../../scripts/staging-common.mjs";

export const fakeSha = (seed) => createHash("sha1").update(String(seed)).digest("hex");
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

export function fakeTools(options = {}) {
  const calls = [];
  const state = {
    main: options.git?.main ?? fakeSha("main"),
    head: options.git?.head ?? options.git?.main ?? fakeSha("main"),
    status: options.git?.status ?? "",
    diff: options.git?.diff ?? "",
    checkRuns: options.gh?.checkRuns ?? null,
    ghSecrets: options.gh?.secrets ?? [
      { name: "CLOUDFLARE_API_TOKEN", updatedAt: "2026-10-19T10:00:00Z" },
    ],
    ghVariables: options.gh?.variables ?? [
      { name: "CLOUDFLARE_ACCOUNT_ID", updatedAt: "2026-10-19T10:00:00Z" },
      { name: "STAGING_DEPLOY_ENABLED", updatedAt: "2026-10-19T10:00:00Z" },
    ],
    variables: {},
    workerSecrets: structuredClone(
      options.wrangler?.secrets ?? { api: [], broker: [], orchestrator: [], connector: [] },
    ),
    versions: options.wrangler?.versions ?? [
      {
        id: "00000000-0000-4000-8000-000000000001",
        metadata: { created_on: "2026-10-19T10:00:00Z" },
      },
    ],
    bulkInputs: [],
  };
  const emit = options.emit ?? null;
  const decorate = (result) =>
    emit
      ? { ...result, stdout: result.stdout + (result.status === 0 ? "" : emit), stderr: emit }
      : result;
  const failure = (tool, args) => {
    const rule = options.fail?.[tool];
    if (!rule) return null;
    if (typeof rule === "function" ? rule(args) : true)
      return { status: options.failStatus ?? 1, stdout: emit ?? "", stderr: emit ?? "" };
    return null;
  };
  const record = (tool, args, extra = {}) => calls.push({ tool, args: [...args], ...extra });
  const workerOf = (args) => {
    const config = args[args.indexOf("--config") + 1] ?? "";
    return /apps\/(api|broker)\//.test(config)
      ? /apps\/api\//.test(config)
        ? "api"
        : "broker"
      : /apps\/workers\//.test(config)
        ? "orchestrator"
        : "connector";
  };
  const tools = {
    async git(args) {
      record("git", args);
      const failed = failure("git", args);
      if (failed) return failed;
      if (args[0] === "fetch") return ok();
      if (args[0] === "status") return ok(state.status);
      if (args[0] === "rev-parse")
        return ok((args.includes("HEAD^{commit}") ? state.head : state.main) + "\n");
      if (args[0] === "diff") return ok(state.diff);
      return { status: 2, stdout: "", stderr: "" };
    },
    async gh(args, { input } = {}) {
      record("gh", args, { input: input ?? null });
      const failed = failure("gh", args);
      if (failed) return failed;
      if (args[0] === "api" && /check-runs/.test(args[1])) {
        const runs = state.checkRuns ?? [
          { name: "foundation", head_sha: state.main, status: "completed", conclusion: "success" },
        ];
        return decorate(ok(JSON.stringify({ total_count: runs.length, check_runs: runs })));
      }
      if (args[0] === "secret" && args[1] === "list")
        return decorate(ok(JSON.stringify(state.ghSecrets)));
      if (args[0] === "variable" && args[1] === "list")
        return decorate(ok(JSON.stringify(state.ghVariables)));
      if (args[0] === "variable" && args[1] === "set") {
        state.variables[args[2]] = args[args.indexOf("--body") + 1];
        return decorate(ok());
      }
      return { status: 2, stdout: "", stderr: "" };
    },
    async wrangler(args, { input } = {}) {
      record("wrangler", args, { input: input ?? null });
      const failed = failure("wrangler", args);
      if (failed) return failed;
      const worker = workerOf(args);
      if (args[0] === "secret" && args[1] === "list")
        return decorate(
          ok(
            JSON.stringify(
              (state.workerSecrets[worker] ?? []).map((name) => ({ name, type: "secret_text" })),
            ),
          ),
        );
      if (args[0] === "secret" && args[1] === "bulk") {
        state.bulkInputs.push({ worker, input });
        const names = Object.keys(JSON.parse(input));
        state.workerSecrets[worker] = [
          ...new Set([...(state.workerSecrets[worker] ?? []), ...names]),
        ].sort();
        state.versions = [
          ...state.versions,
          {
            id: "00000000-0000-4000-8000-" + String(state.versions.length + 1).padStart(12, "0"),
            metadata: {
              created_on:
                "2026-10-19T11:" + String(state.versions.length).padStart(2, "0") + ":00Z",
            },
          },
        ];
        return decorate(ok("✨ Successfully created secret for key"));
      }
      if (args[0] === "versions" && args[1] === "list")
        return decorate(ok(JSON.stringify(state.versions)));
      return { status: 2, stdout: "", stderr: "" };
    },
    async neonctl(args, { input } = {}) {
      record("neonctl", args, { input: input ?? null });
      const failed = failure("neonctl", args);
      if (failed) return failed;
      return { status: 2, stdout: "", stderr: "" };
    },
  };
  return { tools, calls, state };
}

// A Cloudflare API with the census reads. `failWith` makes every request fail with a
// fixed code, as the real client does for an error reply.
export function fakeCloudflare(options = {}) {
  const calls = [];
  const scripts = options.scripts ?? [
    {
      name: "morrow-staging-api",
      enabled: true,
      previews: false,
      bindings: ["morrow-staging-broker"],
    },
    { name: "morrow-staging-broker", enabled: false, previews: false, bindings: [] },
    { name: "morrow-staging-orchestrator", enabled: false, previews: false, bindings: [] },
    { name: "morrow-staging-connector", enabled: false, previews: false, bindings: [] },
  ];
  const api = {
    async get(segments) {
      calls.push(segments.join("/"));
      if (options.failWith) throw new StagingError(options.failWith, { status: 403 });
      const path = segments.join("/");
      if (path === "workers/scripts") return scripts.map((s) => ({ id: s.name }));
      const match = /^workers\/scripts\/([^/]+)\/(subdomain|settings)$/.exec(path);
      if (match) {
        const script = scripts.find((s) => s.name === match[1]);
        return match[2] === "subdomain"
          ? { enabled: script.enabled, previews_enabled: script.previews }
          : {
              bindings: script.bindings.map((service) => ({
                type: "service",
                name: "BROKER",
                service,
              })),
            };
      }
      if (path === "workers/dispatch/namespaces") return options.namespaces ?? [];
      throw new StagingError("STAGING_CLOUDFLARE_REQUEST_FAILED", { status: 404 });
    },
    async list(segments) {
      calls.push(segments.join("/"));
      if (options.failWith) throw new StagingError(options.failWith, { status: 403 });
      const path = segments.join("/");
      if (path === "pages/projects") return options.pages ?? [];
      if (path === "members") return options.members ?? [{ id: "member-1" }];
      throw new StagingError("STAGING_CLOUDFLARE_REQUEST_FAILED", { status: 404 });
    },
  };
  return { api, calls };
}

// A scriptable database for the commands' SQL paths without PostgreSQL. `rules` map a
// statement pattern to rows (or a function returning rows, or an Error to throw). Every
// statement and parameter list is recorded.
export function fakeDatabase(options = {}) {
  const statements = [];
  const roles = options.roles ?? [];
  const identity = {
    session_role: "neondb_owner",
    current_role: "neondb_owner",
    database: "morrow",
    version: 170011,
    superuser: false,
    createrole: true,
    login: true,
    ...(options.identity ?? {}),
  };
  const provisioned = new Set(options.provisioned ? roles : []);
  const rules = [
    [/^SELECT session_user::text AS session_role/, () => [identity]],
    [
      /FROM pg_catalog\.pg_roles WHERE rolname IN/,
      () => [{ n: options.presentRoles ?? roles.length }],
    ],
    [
      /pg_db_role_setting/,
      () =>
        roles.map((role) => ({
          role,
          login: options.controlsOk !== false && provisioned.has(role),
          connection_limit: provisioned.has(role) ? 10 : -1,
          settings: provisioned.has(role)
            ? "statement_timeout=5s,idle_in_transaction_session_timeout=10s"
            : "",
        })),
    ],
    [/privilege_type = 'TEMPORARY'/, () => [{ revoked: provisioned.size > 0 }]],
    [/pg_stat_activity WHERE datname/, () => options.activity ?? []],
    [/pg_auth_members/, () => [{ n: 0 }]],
  ];
  const answer = (text) => {
    for (const [pattern, result] of [...(options.rules ?? []), ...rules]) {
      if (!pattern.test(text)) continue;
      const value = typeof result === "function" ? result(text) : result;
      if (value instanceof Error) throw value;
      return value;
    }
    return [];
  };
  return {
    statements,
    connector: () => ({
      async connect() {
        if (options.connectError) throw options.connectError;
        return {
          async query(text, params = []) {
            statements.push({ text, params: [...params] });
            return answer(text);
          },
          async exec(text) {
            statements.push({ text, params: [] });
            const role = /^ALTER ROLE (morrow_[a-z_]+) WITH LOGIN/.exec(text)?.[1];
            if (role) provisioned.add(role);
            if (options.execError && options.execError.pattern.test(text))
              throw options.execError.error;
          },
          async close() {},
        };
      },
    }),
  };
}

// A temporary HOME with ~/.config/morrow/staging (0700, tmp/ too) and the given files,
// each written 0600 unless `modes` says otherwise; `links` become symlinks.
export function plantedHome(files = {}, { modes = {}, links = {}, directoryMode = 0o700 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "morrow-staging-test-home-"));
  const directory = join(home, ".config", "morrow", "staging");
  mkdirSync(join(directory, "tmp"), { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".config", "morrow"), 0o700);
  chmodSync(directory, directoryMode);
  chmodSync(join(directory, "tmp"), 0o700);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(directory, name), value, { mode: 0o600 });
    chmodSync(join(directory, name), modes[name] ?? 0o600);
  }
  for (const [name, target] of Object.entries(links)) symlinkSync(target, join(directory, name));
  return { home, directory, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export const approvedCard = (approvedOn = "2026-10-19") => {
  const expires = new Date(Date.parse(approvedOn + "T00:00:00Z") + 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  return {
    schemaVersion: 1,
    id: "staging-card-1",
    record: "docs/decisions/approvals/staging.md",
    status: "approved",
    approvedOn,
    expiresOn: expires,
    productionResourceCreated: false,
    e7: null,
  };
};

export const labBinding = Object.freeze({
  schemaVersion: 1,
  environment: "staging",
  projectId: "lab-project-runner",
  branchId: "br-lab-runner-000001",
  hostname: "ep-lab-runner-000001.us-east-1.aws.neon.tech",
  database: "morrow",
});

// A context for scripts/staging.mjs over fakes. Every seam is replaceable through
// `overrides`; nothing reaches a real tool, provider or the operator's HOME.
export async function fakeContext({
  home,
  root,
  tools,
  cloudflare,
  database,
  card = approvedCard(),
  staging,
  binding = labBinding,
  loginConfiguration = null,
  administrator = { name: "neondb_owner", mode: "createrole" },
  now = Date.parse("2026-10-20T12:00:00Z"),
  overrides = {},
}) {
  const { identityConstants } = await import("../../scripts/staging.mjs");
  const { stagingFileSpecs, credentialDirectory } = await import("../../scripts/staging-files.mjs");
  const { loadMigrationChain } = await import("../../scripts/migration-chain.mjs");
  const { readFileSync } = await import("node:fs");
  const constants = await identityConstants();
  const realRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
  const repoRoot = root ?? realRoot;
  const baseStaging = JSON.parse(
    readFileSync(join(realRoot, "infra/environments/staging.json"), "utf8"),
  );
  const stagingValue = staging ?? {
    ...baseStaging,
    cloudflare: {
      ...baseStaging.cloudflare,
      account_id: "0".repeat(31) + "1",
      workers_dev_subdomain: "lab",
      origin: "https://morrow-staging-api.lab.workers.dev",
    },
    neon: {
      ...baseStaging.neon,
      project_id: binding?.projectId ?? null,
      branch_id: binding?.branchId ?? null,
    },
  };
  const out = [];
  const err = [];
  const ctx = {
    root: repoRoot,
    home,
    directory: credentialDirectory(home),
    now: () => now,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    administrator,
    constants: async () => constants,
    specs: async () => stagingFileSpecs({ brokerSecretNames: constants.brokerSecrets }),
    config: async () => ({
      staging: stagingValue,
      card,
      bindingJson: binding === null ? null : JSON.stringify(binding),
      loginConfigurationJson: loginConfiguration,
    }),
    chain: () => loadMigrationChain({ root: repoRoot }),
    tools,
    cloudflareApi: async () => {
      if (!cloudflare) throw new StagingError("STAGING_CLOUDFLARE_UNCONFIGURED");
      return cloudflare;
    },
    database:
      database ??
      (() => ({
        connect: async () => {
          throw new StagingError("STAGING_DATABASE_UNAVAILABLE");
        },
      })),
    async loginConfiguration() {
      throw new StagingError("STAGING_LOGIN_CONFIGURATION_MISSING");
    },
    async checkKeyring() {},
    ...overrides,
  };
  return { ctx, out, err, constants };
}
