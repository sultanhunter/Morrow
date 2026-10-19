// Staging operations (P04.T01i D2–D8, ADR-0019, ADR-0020; card staging-card-1).
//   node scripts/staging.mjs <subcommand> [options]      (npm run staging:<subcommand>)
// Every subcommand prints one JSON line on stdout (closed values only) and exits 0, or
// prints one JSON line {"command","code",…} on stderr and exits 1 (2 for usage). Raw
// wrangler, gh, git, neonctl, driver or database text is never printed; credentials are
// read in-process from ~/.config/morrow/staging and leave only through a child's
// environment (the Cloudflare token), stdin (`wrangler secret bulk`) or a new 0600 file.
// Effects need the active staging card (docs/decisions/approvals/staging-card.json);
// reads and local commands do not. `ctx` is the one injection seam: tests and the
// PostgreSQL lab pass fakes for tools, the Cloudflare API and the database.
import "./staging-token.mjs"; // FIRST: removes CLOUDFLARE_API_TOKEN from process.env.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./artifacts.mjs";
import { captureConsole, loadWranglerApi } from "./edge.mjs";
import { buildLoginKeyring } from "./login-keyring.mjs";
import { loadMigrationChain, schemaHead } from "./migration-chain.mjs";
import { StagingError, closedValue, failureRecord } from "./staging-common.mjs";
import {
  createOwnerFile,
  credentialDirectory,
  inspectCredentialFile,
  inspectDirectory,
  parseOwnerUrl,
  readCredentialFile,
  readRotationRecord,
  recordRotation,
  stagingFileSpecs,
} from "./staging-files.mjs";
import {
  connectionCensus,
  neonConnector,
  platformSeedRows,
  provisionRoles,
  roleControlFacts,
  runMigrations,
  seedPlatform,
  sessionIdentity,
  checkIdentity,
} from "./staging-runner.mjs";
import { cloudflareCredential } from "./staging-token.mjs";
import {
  cloudflareApi,
  createTools,
  githubNames,
  newestVersionId,
  secretNames,
  toolJson,
  toolOk,
} from "./staging-tools.mjs";

// ---------------------------------------------------------------------------
// Configuration: staging.json, the card record, and the resolved staging vars of the api
// (the database binding and the login configuration; identifiers arrive in PR-D).
export const workerConfigs = Object.freeze({
  api: "apps/api/wrangler.jsonc",
  broker: "apps/broker/wrangler.jsonc",
  orchestrator: "apps/workers/wrangler.jsonc",
  connector: "apps/shopify-connector/wrangler.jsonc",
});
export const githubVariables = Object.freeze([
  "CLOUDFLARE_ACCOUNT_ID",
  "STAGING_DEPLOY_ENABLED",
  "STAGING_LOGIN_CONFIGURATION_DIGEST",
  "STAGING_SCHEMA_HEAD",
]);
export const githubSecrets = Object.freeze(["CLOUDFLARE_API_TOKEN"]);

export async function identityConstants() {
  const { tsImport } = await import("tsx/esm/api");
  const protocol = await tsImport("../packages/identity/src/broker-protocol.ts", import.meta.url);
  return Object.freeze({
    roles: [...protocol.brokerNeonRoleNames],
    passwordSecret: protocol.brokerPasswordSecret,
    // The broker's ten names (D1): brokerRequiredSecrets plus the Turnstile secret,
    // which P05.T01ab adds to brokerRequiredSecrets itself.
    brokerSecrets: [...new Set([...protocol.brokerRequiredSecrets, "TURNSTILE_SECRET_KEY"])].sort(),
    parseBinding: protocol.parseBrokerDatabaseBinding,
  });
}

export async function loadStagingConfiguration(root) {
  const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const staging = read("infra/environments/staging.json");
  const card = read("docs/decisions/approvals/staging-card.json");
  const { unstable_readConfig } = await loadWranglerApi();
  let vars;
  try {
    vars = captureConsole(() =>
      unstable_readConfig({ config: join(root, workerConfigs.api), env: "staging" }, {}),
    ).value.vars;
  } catch {
    throw new StagingError("STAGING_CONFIGURATION_UNREADABLE");
  }
  return Object.freeze({
    staging,
    card,
    bindingJson:
      typeof vars?.MORROW_DATABASE_BINDING_JSON === "string"
        ? vars.MORROW_DATABASE_BINDING_JSON
        : null,
    loginConfigurationJson:
      typeof vars?.LOGIN_CONFIGURATION_JSON === "string" ? vars.LOGIN_CONFIGURATION_JSON : null,
  });
}

// The card is active only when the record says approved, 30 days have not passed, and no
// production resource exists (staging.md "Valid until").
export function cardState(card, now) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (card?.schemaVersion !== 1 || card.id !== "staging-card-1")
    return { active: false, reason: "invalid" };
  if (card.status !== "approved")
    return { active: false, reason: card.status === "proposed" ? "proposed" : "invalid" };
  if (!day.test(card.approvedOn ?? "") || !day.test(card.expiresOn ?? ""))
    return { active: false, reason: "invalid" };
  const approved = Date.parse(card.approvedOn + "T00:00:00Z");
  const expires = Date.parse(card.expiresOn + "T00:00:00Z");
  if (expires - approved !== 30 * 86400000) return { active: false, reason: "invalid" };
  if (card.productionResourceCreated !== false) return { active: false, reason: "production" };
  if (!(now < expires + 86400000)) return { active: false, reason: "expired" };
  return { active: true, reason: null };
}
export function requireActiveCard(card, now) {
  const state = cardState(card, now);
  if (!state.active) throw new StagingError("STAGING_CARD_INACTIVE", { reason: state.reason });
}

const repositoryOf = (staging) => {
  const repository = staging?.github?.repository;
  if (typeof repository !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository))
    throw new StagingError("STAGING_REPOSITORY_INVALID");
  return repository;
};
const githubScope = (staging) => {
  const scope = staging?.github?.scope;
  if (scope === "environment") return ["--env", "staging"];
  if (scope === "repository") return [];
  throw new StagingError("STAGING_GITHUB_SCOPE_INVALID");
};
async function stagingBinding(ctx, config) {
  if (config.bindingJson === null) throw new StagingError("STAGING_IDENTIFIERS_UNSET");
  const constants = await ctx.constants();
  let binding;
  try {
    binding = constants.parseBinding(config.bindingJson);
  } catch {
    throw new StagingError("STAGING_BINDING_INVALID");
  }
  const neon = config.staging.neon ?? {};
  if (
    binding.environment !== "staging" ||
    neon.project_id === null ||
    neon.branch_id === null ||
    binding.projectId !== neon.project_id ||
    binding.branchId !== neon.branch_id
  )
    throw new StagingError("STAGING_BINDING_INVALID");
  return binding;
}
// The owner URL names the bound direct host, the bound database and the administrator.
function ownerUrlFor(ctx, binding, specs) {
  const url = parseOwnerUrl(readCredentialFile(ctx.directory, "neon-owner-url", specs));
  if (url.host !== binding.hostname) throw new StagingError("STAGING_HOST_MISMATCH");
  if (url.database !== binding.database) throw new StagingError("STAGING_DATABASE_MISMATCH");
  if (url.user !== ctx.administrator.name) throw new StagingError("STAGING_SESSION_ROLE");
  return url;
}

// D3/D2 preconditions: a clean tree, `origin/main` freshly fetched, and a green
// `foundation` check run on that sha. "migrations" scope also requires migrations/ and
// the prerequisite files to equal origin/main; "head" requires HEAD to be origin/main.
export async function mainPreconditions(ctx, repository, scope) {
  await toolOk(ctx.tools, "git", ["fetch", "--quiet", "--no-tags", "origin", "main"]);
  const status = await toolOk(ctx.tools, "git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status.trim() !== "") throw new StagingError("STAGING_TREE_DIRTY");
  const main = (
    await toolOk(ctx.tools, "git", ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"])
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(main)) throw new StagingError("STAGING_GIT_OUTPUT_INVALID");
  if (scope === "head") {
    const head = (
      await toolOk(ctx.tools, "git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
    ).trim();
    if (head !== main) throw new StagingError("STAGING_NOT_MAIN");
  } else {
    const diff = await toolOk(ctx.tools, "git", [
      "diff",
      "--name-only",
      main,
      "--",
      "migrations",
      "infra",
    ]);
    const changed = diff
      .split("\n")
      .filter(
        (path) => /^migrations\//.test(path) || /^infra\/[^/]+-prerequisites\.sql$/.test(path),
      );
    if (changed.length)
      throw new StagingError("STAGING_MANIFEST_NOT_MAIN", { files: changed.length });
  }
  const reply = await toolJson(ctx.tools, "gh", [
    "api",
    `repos/${repository}/commits/${main}/check-runs?check_name=foundation&filter=latest`,
  ]);
  const runs = Array.isArray(reply?.check_runs)
    ? reply.check_runs.filter((run) => run?.name === "foundation" && run?.head_sha === main)
    : null;
  if (runs === null) throw new StagingError("STAGING_GH_OUTPUT_INVALID");
  if (runs.length === 0) throw new StagingError("STAGING_FOUNDATION_MISSING");
  if (!runs.every((run) => run.status === "completed" && run.conclusion === "success"))
    throw new StagingError("STAGING_FOUNDATION_NOT_GREEN");
  return { sourceCommit: main };
}
async function publishVariable(ctx, staging, name, value) {
  if (!githubVariables.includes(name) || !/^[A-Za-z0-9]{1,128}$/.test(value))
    throw new StagingError("STAGING_VARIABLE_INVALID");
  await toolOk(ctx.tools, "gh", [
    "variable",
    "set",
    name,
    "--repo",
    repositoryOf(staging),
    ...githubScope(staging),
    "--body",
    value,
  ]);
}
const brokerList = async (ctx) =>
  secretNames(
    await toolJson(ctx.tools, "wrangler", [
      "secret",
      "list",
      "--config",
      workerConfigs.broker,
      "--env",
      "staging",
      "--format",
      "json",
    ]),
  );
// One broker version per call: JSON on stdin, never argv or a lasting file.
async function brokerBulk(ctx, secrets) {
  const result = await ctx.tools.wrangler(
    ["secret", "bulk", "--config", workerConfigs.broker, "--env", "staging"],
    { input: JSON.stringify(secrets) },
  );
  return result?.status === 0 ? null : Number.isSafeInteger(result?.status) ? result.status : -1;
}
const brokerVersion = async (ctx) =>
  newestVersionId(
    await toolJson(ctx.tools, "wrangler", [
      "versions",
      "list",
      "--config",
      workerConfigs.broker,
      "--env",
      "staging",
      "--json",
    ]),
  );

// ---------------------------------------------------------------------------
// Subcommands. Each has a closed argument parser and returns closed values.
const noArguments = (args) => {
  if (args.length) throw new StagingError("STAGING_USAGE");
  return {};
};
export const commands = new Map();
const command = (name, spec) => commands.set(name, Object.freeze({ name, ...spec }));

command("schema-head", {
  usage: "schema-head",
  parse: noArguments,
  async run(ctx) {
    const chain = ctx.chain();
    return { schemaHead: schemaHead(chain), entries: chain.length };
  },
});

command("migrate", {
  usage: "migrate",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    const binding = await stagingBinding(ctx, config);
    const chain = ctx.chain();
    const repository = repositoryOf(config.staging);
    const { sourceCommit } = await mainPreconditions(ctx, repository, "migrations");
    const specs = await ctx.specs();
    const ownerUrl = ownerUrlFor(ctx, binding, specs);
    const result = await runMigrations({
      connect: ctx.database({ ownerUrl, binding }).connect,
      chain,
      binding,
      administrator: ctx.administrator,
      sourceCommit,
    });
    const head = schemaHead(chain);
    await publishVariable(ctx, config.staging, "STAGING_SCHEMA_HEAD", head);
    return { ...result, schemaHead: head, sourceCommit };
  },
});

command("provision-roles", {
  usage: "provision-roles --first | --rotate <role|all>",
  parse(args) {
    if (args.length === 1 && args[0] === "--first") return { mode: "first" };
    if (args.length === 2 && args[0] === "--rotate" && /^(all|morrow_[a-z_]{1,48})$/.test(args[1]))
      return { mode: "rotate", target: args[1] };
    throw new StagingError("STAGING_USAGE");
  },
  async run(ctx, options) {
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    const binding = await stagingBinding(ctx, config);
    const constants = await ctx.constants();
    const specs = await ctx.specs();
    const ownerUrl = ownerUrlFor(ctx, binding, specs);
    const roles = constants.roles;
    const connect = ctx.database({ ownerUrl, binding }).connect;
    if (options.mode === "first") {
      const workos = readCredentialFile(ctx.directory, "workos-api-key", specs);
      const turnstile = readCredentialFile(ctx.directory, "turnstile-secret", specs);
      const handle = createOwnerFile(ctx.directory, "tmp/broker-secrets.json");
      let provisioned;
      try {
        provisioned = await provisionRoles({
          connect,
          binding,
          administrator: ctx.administrator,
          roles,
          passwordRoles: roles,
        });
      } catch (error) {
        handle.abandon();
        throw error;
      }
      const secrets = { WORKOS_API_KEY: workos, TURNSTILE_SECRET_KEY: turnstile };
      for (const role of roles)
        secrets[constants.passwordSecret(role)] = provisioned.passwords.get(role);
      handle.write(JSON.stringify(secrets) + "\n");
      recordRotation(ctx.directory, roles.map(constants.passwordSecret), {
        worker: "broker",
        versionId: null,
        now: ctx.now(),
      });
      return { mode: "first", roles, file: "tmp/broker-secrets.json", controls: "verified" };
    }
    const selected =
      options.target === "all" ? roles : roles.filter((role) => role === options.target);
    if (!selected.length) throw new StagingError("STAGING_ROLE_INVALID");
    const names = selected.map(constants.passwordSecret);
    // The broker must exist and already hold these names, so bulk never creates a Worker.
    const listed = await brokerList(ctx);
    if (!names.every((name) => listed.includes(name)))
      throw new StagingError("STAGING_BROKER_SECRETS_MISMATCH");
    const provisioned = await provisionRoles({
      connect,
      binding,
      administrator: ctx.administrator,
      roles,
      passwordRoles: selected,
    });
    const status = await brokerBulk(
      ctx,
      Object.fromEntries(
        selected.map((role) => [constants.passwordSecret(role), provisioned.passwords.get(role)]),
      ),
    );
    if (status !== null) throw new StagingError("STAGING_ROTATION_PARTIAL", { status });
    let versionId = null;
    try {
      versionId = await brokerVersion(ctx);
    } finally {
      recordRotation(ctx.directory, names, { worker: "broker", versionId, now: ctx.now() });
    }
    return { mode: "rotate", roles: selected, versionId, controls: "verified" };
  },
});

const putSecretFiles = Object.freeze({
  WORKOS_API_KEY: "workos-api-key",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
});
command("put-secret", {
  usage: "put-secret WORKOS_API_KEY|TURNSTILE_SECRET_KEY",
  parse(args) {
    if (args.length !== 1 || !Object.hasOwn(putSecretFiles, args[0]))
      throw new StagingError("STAGING_USAGE");
    return { name: args[0] };
  },
  async run(ctx, { name }) {
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    const value = readCredentialFile(ctx.directory, putSecretFiles[name], await ctx.specs());
    await brokerList(ctx);
    const status = await brokerBulk(ctx, { [name]: value });
    if (status !== null) throw new StagingError("STAGING_PUT_SECRET_FAILED", { status });
    let versionId = null;
    try {
      versionId = await brokerVersion(ctx);
    } finally {
      recordRotation(ctx.directory, [name], { worker: "broker", versionId, now: ctx.now() });
    }
    return { secret: name, versionId };
  },
});

command("seed-platform", {
  usage: "seed-platform [--self-service]",
  parse(args) {
    if (args.length === 0) return { selfService: false };
    if (args.length === 1 && args[0] === "--self-service") return { selfService: true };
    throw new StagingError("STAGING_USAGE");
  },
  async run(ctx, options) {
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    const binding = await stagingBinding(ctx, config);
    let selfService = null;
    if (options.selfService) {
      // Card E7: only after the owner's chat confirmation is recorded in a live record.
      const e7 = config.card.e7;
      if (
        !e7 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(e7.confirmedOn ?? "") ||
        !/^docs\/evidence\/live\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(e7.record ?? "") ||
        !existsSync(join(ctx.root, e7.record))
      )
        throw new StagingError("STAGING_SELF_SERVICE_UNCONFIRMED");
      selfService = { approvalRef: "staging-card-1.e7" };
    }
    const configuration = await ctx.loginConfiguration(config);
    await mainPreconditions(ctx, repositoryOf(config.staging), "head");
    const ownerUrl = ownerUrlFor(ctx, binding, await ctx.specs());
    const rows = platformSeedRows(configuration, JSON.parse(configuration.verificationProfileJson));
    const written = await seedPlatform({
      connect: ctx.database({ ownerUrl, binding }).connect,
      binding,
      administrator: ctx.administrator,
      rows,
      selfService,
    });
    return { ...written, origin: configuration.origin };
  },
});

command("connections", {
  usage: "connections",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    const binding = await stagingBinding(ctx, config);
    const ownerUrl = ownerUrlFor(ctx, binding, await ctx.specs());
    const census = await connectionCensus({
      connect: ctx.database({ ownerUrl, binding }).connect,
      binding,
      administrator: ctx.administrator,
      knownRoles: (await ctx.constants()).roles,
    });
    return { ...census, flagged: census.unknownApplications + census.otherRoles > 0 };
  },
});

command("keyring", {
  usage: "keyring",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    const configuration = await ctx.loginConfiguration(config);
    const { keyringJson, metadata } = buildLoginKeyring(
      configuration.configurationDigest,
      ctx.now(),
    );
    await ctx.checkKeyring(keyringJson, configuration.configurationDigest);
    const handle = createOwnerFile(ctx.directory, "tmp/api-secrets.json");
    handle.write(JSON.stringify({ LOGIN_CAPSULE_KEYRING: keyringJson }) + "\n");
    return { ...metadata, file: "tmp/api-secrets.json" };
  },
});

// M-C2 / D2 census: every script with its workers.dev and preview state, every service
// binding naming the staging broker (scripts and Pages), dispatch namespaces, members.
export function censusFindings(snapshot, staging) {
  const workers = staging.cloudflare.workers;
  const morrow = new Set(Object.values(workers));
  const findings = [];
  for (const script of snapshot.scripts) {
    if (!morrow.has(script.name)) findings.push({ code: "NOT_MORROW_SCRIPT", name: script.name });
    if (script.workersDev && script.name !== workers.api)
      findings.push({ code: "WORKERS_DEV_EXPOSED", name: script.name });
    if (script.previews) findings.push({ code: "PREVIEWS_ENABLED", name: script.name });
    if (script.bindsBroker && script.name !== workers.api)
      findings.push({ code: "BROKER_BOUND_ELSEWHERE", name: script.name });
  }
  for (const project of snapshot.pages) {
    findings.push({ code: "PAGES_PROJECT", name: project.name });
    if (project.bindsBroker) findings.push({ code: "BROKER_BOUND_ELSEWHERE", name: project.name });
  }
  if (snapshot.dispatchNamespaces > 0)
    findings.push({ code: "DISPATCH_NAMESPACES", count: snapshot.dispatchNamespaces });
  if (snapshot.members !== 1) findings.push({ code: "ACCOUNT_MEMBERS", count: snapshot.members });
  return findings;
}
const printableName = (name) =>
  typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)
    ? name
    : "[unprintable]";
const servicesBind = (services, broker) =>
  Object.values(services ?? {}).some((service) => service?.service === broker);
command("census", {
  usage: "census",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    const staging = config.staging;
    if (staging.cloudflare?.account_id === null)
      throw new StagingError("STAGING_IDENTIFIERS_UNSET");
    const api = await ctx.cloudflareApi(staging.cloudflare.account_id);
    const broker = staging.cloudflare.workers.broker;
    const listed = await api.get(["workers", "scripts"]);
    if (!Array.isArray(listed)) throw new StagingError("STAGING_CLOUDFLARE_RESPONSE_INVALID");
    const scripts = [];
    for (const entry of listed) {
      const name = printableName(entry?.id);
      if (name === "[unprintable]") {
        scripts.push({ name, workersDev: true, previews: true, bindsBroker: false });
        continue;
      }
      const subdomain = await api.get(["workers", "scripts", name, "subdomain"]);
      const settings = await api.get(["workers", "scripts", name, "settings"]);
      scripts.push({
        name,
        workersDev: subdomain?.enabled !== false,
        previews: subdomain?.previews_enabled !== false,
        bindsBroker: (settings?.bindings ?? []).some(
          (b) => b?.type === "service" && b?.service === broker,
        ),
      });
    }
    const pages = (await api.list(["pages", "projects"], 10)).map((project) => ({
      name: printableName(project?.name),
      bindsBroker:
        servicesBind(project?.deployment_configs?.production?.services, broker) ||
        servicesBind(project?.deployment_configs?.preview?.services, broker),
    }));
    const namespaces = await api.get(["workers", "dispatch", "namespaces"]);
    const members = await api.list(["members"]);
    const snapshot = {
      scripts,
      pages,
      dispatchNamespaces: Array.isArray(namespaces) ? namespaces.length : 1,
      members: members.length,
    };
    const findings = censusFindings(snapshot, staging);
    return { ...snapshot, findings, exitCode: findings.length ? 1 : 0 };
  },
});

// D4 `secrets status`: presence, mode, owner, format and age of every file; the
// deployed secret names of each Worker against exact sets; the GitHub secret and variable
// names and dates; the role controls. No value is shown. Non-zero on any mismatch.
const ageLimits = (name) =>
  name === "LOGIN_CAPSULE_KEYRING" ? { warn: 50, due: 60 } : { warn: 80, due: 90 };
command("secrets-status", {
  usage: "secrets-status",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    const constants = await ctx.constants();
    const specs = await ctx.specs();
    const mismatches = [];
    const warnings = [];
    const section = async (label, fn) => {
      try {
        return await fn();
      } catch (error) {
        mismatches.push(label + ":" + failureRecord(error).code);
        return null;
      }
    };
    const directory = inspectDirectory(ctx.directory);
    const tmp = inspectDirectory(join(ctx.directory, "tmp"));
    if (!directory.ok) mismatches.push("directory");
    if (tmp.exists && !tmp.ok) mismatches.push("tmp_directory");
    const files = Object.keys(specs).map((name) =>
      inspectCredentialFile(ctx.directory, name, specs),
    );
    for (const facts of files) {
      if (facts.required && !facts.ok) mismatches.push("file:" + facts.file);
      if (!facts.required && facts.exists) {
        warnings.push("transient_present:" + facts.file);
        if (!facts.ok) mismatches.push("file:" + facts.file);
      }
    }
    const expected = {
      api: ["LOGIN_CAPSULE_KEYRING"],
      broker: constants.brokerSecrets,
      orchestrator: [],
      connector: [],
    };
    const workers = {};
    for (const key of Object.keys(workerConfigs))
      workers[key] = await section("worker:" + key, async () => {
        const names = secretNames(
          await toolJson(ctx.tools, "wrangler", [
            "secret",
            "list",
            "--config",
            workerConfigs[key],
            "--env",
            "staging",
            "--format",
            "json",
          ]),
        );
        const missing = expected[key].filter((n) => !names.includes(n));
        const extra = names.filter((n) => !expected[key].includes(n));
        if (missing.length || extra.length) mismatches.push("worker:" + key);
        return { names, missing, extra };
      });
    const repository = repositoryOf(config.staging);
    const scope = githubScope(config.staging);
    const github = await section("github", async () => {
      const secrets = githubNames(
        await toolJson(ctx.tools, "gh", [
          "secret",
          "list",
          "--repo",
          repository,
          ...scope,
          "--json",
          "name,updatedAt",
        ]),
      );
      const variables = githubNames(
        await toolJson(ctx.tools, "gh", [
          "variable",
          "list",
          "--repo",
          repository,
          ...scope,
          "--json",
          "name,updatedAt",
        ]),
      );
      const secretNamesSeen = secrets.map((s) => s.name).sort();
      if (secretNamesSeen.join() !== [...githubSecrets].sort().join())
        mismatches.push("github:secrets");
      const variableNames = variables.map((v) => v.name);
      if (
        variableNames.some((n) => !githubVariables.includes(n)) ||
        !["CLOUDFLARE_ACCOUNT_ID", "STAGING_DEPLOY_ENABLED"].every((n) => variableNames.includes(n))
      )
        mismatches.push("github:variables");
      return { secrets, variables };
    });
    const roles = await section("roles", async () => {
      const binding = await stagingBinding(ctx, config);
      const ownerUrl = ownerUrlFor(ctx, binding, specs);
      const connection = await ctx.database({ ownerUrl, binding }).connect();
      try {
        checkIdentity(await sessionIdentity(connection), binding, ctx.administrator);
        const facts = await roleControlFacts(connection, constants.roles);
        if (!facts.ok) mismatches.push("roles:controls");
        return facts;
      } finally {
        await connection.close();
      }
    });
    const record = await section("rotation_record", async () => readRotationRecord(ctx.directory));
    const tracked = [...constants.brokerSecrets, "LOGIN_CAPSULE_KEYRING"];
    const ages = tracked.map((name) => {
      const entry = record?.secrets?.[name];
      if (!entry) {
        warnings.push("age_unknown:" + name);
        return { name, days: null };
      }
      const days = Math.floor((ctx.now() - Date.parse(entry.rotatedAt)) / 86400000);
      const limits = ageLimits(name);
      if (days > limits.due) mismatches.push("age:" + name);
      else if (days >= limits.warn) warnings.push("age:" + name);
      return { name, days, versionId: entry.versionId };
    });
    return {
      directory,
      tmpDirectory: tmp,
      files,
      workers,
      github,
      roles,
      ages,
      warnings,
      mismatches,
      exitCode: mismatches.length ? 1 : 0,
    };
  },
});

// ---------------------------------------------------------------------------
// Output: closed values only. Anything else is replaced, never stringified.
export function closedReport(value, depth = 0) {
  if (depth > 8) return "[omitted]";
  if (Array.isArray(value)) return value.slice(0, 256).map((v) => closedReport(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value))
      if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) out[key] = closedReport(child, depth + 1);
    return out;
  }
  const closed = closedValue(value);
  return closed === undefined ? "[omitted]" : closed;
}

export async function main(argv, ctx) {
  const [name, ...args] = argv;
  const spec = commands.get(name);
  if (!spec) {
    ctx.stderr(JSON.stringify({ code: "STAGING_USAGE", commands: [...commands.keys()] }));
    return 2;
  }
  let options;
  try {
    options = spec.parse(args);
  } catch {
    ctx.stderr(JSON.stringify({ command: name, code: "STAGING_USAGE", usage: spec.usage }));
    return 2;
  }
  try {
    const { exitCode = 0, ...result } = await spec.run(ctx, options);
    ctx.stdout(JSON.stringify(closedReport({ command: name, ...result })));
    return exitCode === 0 ? 0 : 1;
  } catch (error) {
    ctx.stderr(JSON.stringify(closedReport({ command: name, ...failureRecord(error) })));
    return 1;
  }
}

// The real context. HOME is read before the wrangler API loads (it replaces HOME with a
// throwaway directory for its own children). The Cloudflare credential is resolved only
// when a command first needs wrangler or the API: from the CI step's environment, or
// from the operator's file locally.
export function defaultContext() {
  const home = homedir();
  const root = repositoryRoot;
  const directory = credentialDirectory(home);
  const ci = process.env.GITHUB_ACTIONS === "true" && process.env.CI === "true";
  let constants, specs, config, credential;
  const ctx = {
    root,
    home,
    directory,
    now: () => Date.now(),
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
    administrator: Object.freeze({ name: "neondb_owner", mode: "createrole" }),
    constants: async () => (constants ??= await identityConstants()),
    specs: async () =>
      (specs ??= stagingFileSpecs({ brokerSecretNames: (await ctx.constants()).brokerSecrets })),
    config: async () => (config ??= await loadStagingConfiguration(root)),
    chain: () => loadMigrationChain({ root }),
    credential: async () =>
      (credential ??= cloudflareCredential({
        source: ci ? "environment" : "operator-file",
        readOperatorToken: () =>
          readCredentialFile(
            directory,
            "cloudflare-operator-token",
            stagingFileSpecs({ brokerSecretNames: [] }),
          ),
      })),
    async cloudflareApi(accountId) {
      return cloudflareApi({ credential: await ctx.credential(), accountId });
    },
    database: ({ ownerUrl, binding }) => neonConnector({ ownerUrl, binding }),
    async loginConfiguration(loaded) {
      if (loaded.loginConfigurationJson === null)
        throw new StagingError("STAGING_LOGIN_CONFIGURATION_MISSING");
      const { tsImport } = await import("tsx/esm/api");
      const { parseLoginConfiguration } = await tsImport(
        "../packages/identity/src/standalone-login-protocol.ts",
        import.meta.url,
      );
      let parsed;
      try {
        parsed = await parseLoginConfiguration(loaded.loginConfigurationJson);
      } catch {
        throw new StagingError("STAGING_LOGIN_CONFIGURATION_INVALID");
      }
      if (parsed.retentionTier !== "staging" || parsed.origin !== loaded.staging.cloudflare?.origin)
        throw new StagingError("STAGING_LOGIN_CONFIGURATION_INVALID");
      return parsed;
    },
    async checkKeyring(keyringJson, digest) {
      const { tsImport } = await import("tsx/esm/api");
      const { parseManagedLoginKeyring } = await tsImport(
        "../packages/identity/src/managed-login-capsule.ts",
        import.meta.url,
      );
      try {
        parseManagedLoginKeyring(keyringJson, digest);
      } catch {
        throw new StagingError("STAGING_KEYRING_INVALID");
      }
    },
  };
  const real = { tools: null };
  const tools = async () =>
    (real.tools ??= createTools({
      root,
      home,
      credential: await ctx.credential(),
      accountId: (await ctx.config()).staging.cloudflare?.account_id ?? null,
    }));
  const plain = createTools({ root, home });
  ctx.tools = Object.freeze({
    wrangler: async (args, options) => (await tools()).wrangler(args, options),
    gh: (args, options) => plain.gh(args, options),
    git: (args) => plain.git(args),
    neonctl: async () => {
      throw new StagingError("STAGING_NEON_UNCONFIGURED");
    },
  });
  return ctx;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv.slice(2), defaultContext()).catch(() => {
    process.stderr.write(JSON.stringify({ code: "STAGING_INTERNAL_ERROR" }) + "\n");
    return 1;
  });
  process.exit(code);
}
