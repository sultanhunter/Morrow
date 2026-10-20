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
import "./staging-token.mjs"; // FIRST: removes CLOUDFLARE_API_TOKEN and GH_TOKEN from process.env.
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot, writeArtifact } from "./artifacts.mjs";
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
  vaultKekFile,
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
import { cloudflareCredential, githubCredential } from "./staging-token.mjs";
import {
  cloudflareApi,
  createTools,
  githubNames,
  newestVersionId,
  runChild,
  secretNames,
  toolJson,
  toolOk,
} from "./staging-tools.mjs";
import {
  ciGates,
  collectCensus,
  deployOrder,
  githubVariables,
  runDeploy,
  runKill,
  runUnkill,
  setVariable,
} from "./staging-deploy.mjs";
import {
  createQueues,
  createTurnstile,
  neonProbe,
  preflight,
  status as stagingStatus,
} from "./staging-bringup.mjs";
import { assistedSmoke, unattendedSmoke } from "./staging-smoke.mjs";

export { censusFindings } from "./staging-deploy.mjs";
export { githubVariables };

// ---------------------------------------------------------------------------
// Configuration: staging.json, the card record, and the resolved staging vars of the api
// and the broker (the database binding, the login configuration and the two challenge
// vars: the reviewed identifiers of P04.T01i PR-D part 1, held by verify-config).
export const workerConfigs = Object.freeze({
  api: "apps/api/wrangler.jsonc",
  broker: "apps/broker/wrangler.jsonc",
  orchestrator: "apps/workers/wrangler.jsonc",
  connector: "apps/shopify-connector/wrangler.jsonc",
});
export const githubSecrets = Object.freeze(["CLOUDFLARE_API_TOKEN"]);

export async function identityConstants() {
  const { tsImport } = await import("tsx/esm/api");
  const protocol = await tsImport("../packages/identity/src/broker-protocol.ts", import.meta.url);
  return Object.freeze({
    // The broker's database logins that provisioning controls: the ten leased roles
    // (brokerNeonRoles) and M2 PR-1's own vault login, which is never leased (ADR-0022
    // item 7). Each gets LOGIN, the limit, both timeouts and a generated password.
    roles: [...protocol.brokerNeonRoleNames, protocol.brokerVaultRole],
    passwordSecret: protocol.brokerPasswordSecret,
    // The broker's fourteen names (D1, AC02): WORKOS_API_KEY, P05.T01ab's
    // TURNSTILE_SECRET_KEY, the eleven role passwords and M2 PR-1's MORROW_VAULT_KEK_V1.
    // brokerRequiredSecrets is the one list: the wrangler `secrets.required` of development
    // and staging, verify-config, gate 6, secrets-status and the first-deploy file all use
    // it (production requires its vault-free subset, brokerRequiredSecretsFor).
    brokerSecrets: [...protocol.brokerRequiredSecrets].sort(),
    // The vault KEKs (ADR-0022 item 7) are the owner's: each is read from its owner file
    // (`vault-kek-v<n>`, written by `npm run vault -- kek`) and never generated here.
    vaultKekSecrets: [...protocol.brokerVaultKekSecrets],
    parseBinding: protocol.parseBrokerDatabaseBinding,
  });
}

export async function loadStagingConfiguration(root) {
  const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const staging = read("infra/environments/staging.json");
  const card = read("docs/decisions/approvals/staging-card.json");
  const { unstable_readConfig } = await loadWranglerApi();
  const varsOf = (worker) =>
    captureConsole(() =>
      unstable_readConfig({ config: join(root, workerConfigs[worker]), env: "staging" }, {}),
    ).value.vars;
  let vars, brokerVars;
  try {
    vars = varsOf("api");
    brokerVars = varsOf("broker");
  } catch {
    throw new StagingError("STAGING_CONFIGURATION_UNREADABLE");
  }
  const text = (record, name) => (typeof record?.[name] === "string" ? record[name] : null);
  return Object.freeze({
    staging,
    card,
    bindingJson: text(vars, "MORROW_DATABASE_BINDING_JSON"),
    loginConfigurationJson: text(vars, "LOGIN_CONFIGURATION_JSON"),
    // P05.T01ab (D1, D5): the api's challenge configuration and the broker's own vars.
    // Both JSON vars name reviewed identifiers (the site key, the workers.dev host),
    // committed by PR-D part 1; a missing one is null and a deploy stops before upload.
    challengeJson: text(vars, "LOGIN_CHALLENGE_JSON"),
    broker: Object.freeze({
      turnstileJson: text(brokerVars, "TURNSTILE_CONFIGURATION_JSON"),
      loginConfigurationJson: text(brokerVars, "LOGIN_CONFIGURATION_JSON"),
      bindingJson: text(brokerVars, "MORROW_DATABASE_BINDING_JSON"),
    }),
  });
}

// The actions of D1's LOGIN_CHALLENGE_JSON, in this order (P05.T01ab).
export const stagingChallengeActions = Object.freeze({
  login: "account_login",
  signup: "organization_signup",
});
// P05.T01ab (D1, D5; ADR-0019 items 6-8): the api's LOGIN_CHALLENGE_JSON and the broker's
// TURNSTILE_CONFIGURATION_JSON must both be present and agree before anything is uploaded.
// Without them the api maps to API_ENV_ABUSE_GUARD_MISSING and the broker's health is
// false, so a deploy would only fail later, at the health gate. The checks are the
// runtimes' own parsers (parseLoginChallengeConfiguration; parseTurnstileConfiguration,
// which the broker itself uses, so a duplicate member or more than 1024 bytes stops here)
// plus D1's cross-Worker rules: the site key equal to staging.json's widget's
// (`cloudflare.turnstile.site_key`), the same actions (D1's values, in the same order), the
// Turnstile hostname equal to the origin's, and the broker's login configuration and
// database binding present and byte-equal to the api's. The broker compares the hostname
// with its own login configuration's origin; that text is byte-equal to the api's, whose
// origin the digest step of gate 4 (ctx.loginConfiguration) holds to the staging origin.
// Fixed codes only.
const presentText = (value) => typeof value === "string" && value.length > 0;
export async function checkChallengeConfiguration(loaded) {
  const broker = loaded?.broker ?? {};
  if (!presentText(loaded?.challengeJson) || !presentText(broker.turnstileJson))
    throw new StagingError("STAGING_CHALLENGE_CONFIGURATION_MISSING");
  // Absent on both sides would otherwise compare equal below.
  if (
    ![
      loaded.loginConfigurationJson,
      loaded.bindingJson,
      broker.loginConfigurationJson,
      broker.bindingJson,
    ].every(presentText)
  )
    throw new StagingError("STAGING_CHALLENGE_CONFIGURATION_MISSING", { reason: "shared_vars" });
  const invalid = (reason) =>
    new StagingError("STAGING_CHALLENGE_CONFIGURATION_INVALID", { reason });
  const { tsImport } = await import("tsx/esm/api");
  const { parseLoginChallengeConfiguration } = await tsImport(
    "../apps/api/src/abuse-guard.ts",
    import.meta.url,
  );
  const { parseTurnstileConfiguration, turnstileHostnameMismatch } = await tsImport(
    "../packages/identity/src/broker-protocol.ts",
    import.meta.url,
  );
  let challenge, apiActions, brokerActions;
  try {
    challenge = parseLoginChallengeConfiguration(loaded.challengeJson);
    apiActions = JSON.stringify(JSON.parse(loaded.challengeJson).actions);
  } catch {
    throw invalid("api");
  }
  const siteKey = loaded.staging?.cloudflare?.turnstile?.site_key;
  if (typeof siteKey !== "string" || challenge.siteKey !== siteKey) throw invalid("site_key");
  const origin = loaded.staging?.cloudflare?.origin;
  let turnstile;
  try {
    turnstile = parseTurnstileConfiguration(broker.turnstileJson, origin);
  } catch (error) {
    throw invalid(error?.message === turnstileHostnameMismatch ? "hostname" : "broker");
  }
  // The strict parse passed (no duplicate members), so JSON.parse reads the same members;
  // it keeps their order, which D1 fixes.
  try {
    brokerActions = JSON.stringify(JSON.parse(broker.turnstileJson).actions);
  } catch {
    throw invalid("broker");
  }
  if (apiActions !== brokerActions || apiActions !== JSON.stringify(stagingChallengeActions))
    throw invalid("actions");
  if (
    broker.loginConfigurationJson !== loaded.loginConfigurationJson ||
    broker.bindingJson !== loaded.bindingJson
  )
    throw invalid("shared_vars");
  return Object.freeze({
    provider: challenge.provider,
    hostname: turnstile.hostname,
    actions: challenge.actions,
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
// {repository, environment}: the OQ-2 A shape names the `staging` environment.
const githubTarget = (staging) => ({
  repository: repositoryOf(staging),
  environment: githubScope(staging).length ? "staging" : null,
});
// The committed binding, held to staging.json: the `staging` branch of the project, through
// that branch's direct endpoint (`neon.endpoint_host`). The parser already refuses a
// `-pooler` host; any other well-formed `ep-` host (the root branch's, say) fails here, so
// the owner URL check below cannot follow a binding to another endpoint.
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
    typeof neon.endpoint_host !== "string" ||
    binding.projectId !== neon.project_id ||
    binding.branchId !== neon.branch_id ||
    binding.hostname !== neon.endpoint_host ||
    binding.hostname.split(".")[0].includes("-pooler")
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

// D2/D3 preconditions for every effect on the hosted database or the broker's secrets
// (`migrate`, `provision-roles`, `put-secret`, `seed-platform`) and for a local deploy: a
// clean tree, HEAD equal to a freshly fetched `origin/main`, and a green `foundation`
// check run on that sha. So the runner, the chain and the manifest are all reviewed code
// from main, never an unmerged branch. `kill` needs none of this.
export async function mainPreconditions(ctx, repository) {
  await toolOk(ctx.tools, "git", ["fetch", "--quiet", "--no-tags", "origin", "main"]);
  const status = await toolOk(ctx.tools, "git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status.trim() !== "") throw new StagingError("STAGING_TREE_DIRTY");
  const main = (
    await toolOk(ctx.tools, "git", ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"])
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(main)) throw new StagingError("STAGING_GIT_OUTPUT_INVALID");
  const head = (
    await toolOk(ctx.tools, "git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
  ).trim();
  if (head !== main) throw new StagingError("STAGING_NOT_MAIN");
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
const publishVariable = (ctx, staging, name, value) =>
  setVariable(ctx, githubTarget(staging), name, value);
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

// The value STAGING_SCHEMA_HEAD holds while the database may be behind the chain. It
// matches no chain head, so gate 3 stops every deploy until `migrate` succeeds.
export const schemaHeadWithdrawn = "0";

command("migrate", {
  usage: "migrate",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    const binding = await stagingBinding(ctx, config);
    const chain = ctx.chain();
    const repository = repositoryOf(config.staging);
    const { sourceCommit } = await mainPreconditions(ctx, repository);
    const specs = await ctx.specs();
    const ownerUrl = ownerUrlFor(ctx, binding, specs);
    // Workers never deploy ahead of their schema (ADR-0019 item 4): the head is withdrawn
    // before the first database statement and published again only after the whole
    // chain is applied, so a failed or unknown run leaves it withdrawn.
    await publishVariable(ctx, config.staging, "STAGING_SCHEMA_HEAD", schemaHeadWithdrawn);
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
    await mainPreconditions(ctx, repositoryOf(config.staging));
    const constants = await ctx.constants();
    const specs = await ctx.specs();
    const ownerUrl = ownerUrlFor(ctx, binding, specs);
    const roles = constants.roles;
    const connect = ctx.database({ ownerUrl, binding }).connect;
    if (options.mode === "first") {
      // One source of names: the file holds brokerRequiredSecrets exactly (the list gate 6
      // and the first deploy's file check use). The names are checked before any file is
      // read or created and before any role is touched, and the written keys again.
      const fileNames = (names) => [...names].sort().join("\n");
      const expected = fileNames(constants.brokerSecrets);
      const kekNames = constants.vaultKekSecrets;
      const planned = [
        "WORKOS_API_KEY",
        "TURNSTILE_SECRET_KEY",
        ...roles.map(constants.passwordSecret),
        ...kekNames,
      ];
      if (
        new Set(planned).size !== planned.length ||
        fileNames(planned) !== expected ||
        !kekNames.every((name) => vaultKekFile(name) !== null)
      )
        throw new StagingError("STAGING_BROKER_FILE_NAMES_INVALID");
      const workos = readCredentialFile(ctx.directory, "workos-api-key", specs);
      const turnstile = readCredentialFile(ctx.directory, "turnstile-secret", specs);
      // M2 PR-1: the owner's KEK files, read like the WorkOS key; the tool never makes one.
      const keks = Object.fromEntries(
        kekNames.map((name) => [
          name,
          readCredentialFile(ctx.directory, vaultKekFile(name), specs),
        ]),
      );
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
      const secrets = { WORKOS_API_KEY: workos, TURNSTILE_SECRET_KEY: turnstile, ...keks };
      for (const role of roles)
        secrets[constants.passwordSecret(role)] = provisioned.passwords.get(role);
      if (fileNames(Object.keys(secrets)) !== expected) {
        handle.abandon();
        throw new StagingError("STAGING_BROKER_FILE_NAMES_INVALID");
      }
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
// M2 PR-1: a vault KEK (MORROW_VAULT_KEK_V<n>) is re-placed from the owner's own file,
// with the same value; a new KEK is a new version, never a new value under an old name.
const putSecretFile = (name) =>
  Object.hasOwn(putSecretFiles, name) ? putSecretFiles[name] : vaultKekFile(name);
command("put-secret", {
  usage: "put-secret WORKOS_API_KEY|TURNSTILE_SECRET_KEY|MORROW_VAULT_KEK_V1",
  parse(args) {
    if (args.length !== 1 || putSecretFile(args[0]) === null)
      throw new StagingError("STAGING_USAGE");
    return { name: args[0] };
  },
  async run(ctx, { name }) {
    if (
      !Object.hasOwn(putSecretFiles, name) &&
      !(await ctx.constants()).vaultKekSecrets.includes(name)
    )
      throw new StagingError("STAGING_USAGE");
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    await mainPreconditions(ctx, repositoryOf(config.staging));
    const value = readCredentialFile(ctx.directory, putSecretFile(name), await ctx.specs());
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
    await mainPreconditions(ctx, repositoryOf(config.staging));
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

// M-C2 / D2 census (scripts/staging-deploy.mjs collects it; every deploy runs it too).
command("census", {
  usage: "census",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    const staging = config.staging;
    if (staging.cloudflare?.account_id === null)
      throw new StagingError("STAGING_IDENTIFIERS_UNSET");
    const census = await collectCensus(
      await ctx.cloudflareApi(staging.cloudflare.account_id),
      staging,
    );
    return { ...census, exitCode: census.findings.length ? 1 : 0 };
  },
});

// D4 `secrets status`: presence, mode, owner, format and age of every file; the
// deployed secret names of each Worker against exact sets; the GitHub secret and variable
// names and dates; the role controls. No value is shown. Non-zero on any mismatch.
// A vault KEK has no age limit: it is replaced by a new KEK version, not rotated in place
// (ADR-0022 item 7), so its age is reported and never warned about.
const ageLimits = (name) =>
  name === "LOGIN_CAPSULE_KEYRING"
    ? { warn: 50, due: 60 }
    : vaultKekFile(name) !== null
      ? null
      : { warn: 80, due: 90 };
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
      if (limits !== null && days > limits.due) mismatches.push("age:" + name);
      else if (limits !== null && days >= limits.warn) warnings.push("age:" + name);
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
// The first bring-up and continuous deploy (P04.T01i D2, D7, D8; trimmed by ADR-0021).
const identifiersSet = (staging) => {
  const cloudflare = staging?.cloudflare ?? {};
  if (
    cloudflare.account_id === null ||
    cloudflare.origin === null ||
    cloudflare.workers_dev_subdomain === null
  )
    throw new StagingError("STAGING_IDENTIFIERS_UNSET");
};
// The CSP the SPA's _headers commits for `/*` (the smoke compares the hosted header).
export function committedCsp(root) {
  const lines = readFileSync(join(root, "apps/workspace-web/public/_headers"), "utf8").split("\n");
  const block = lines.indexOf("/*");
  for (const line of lines.slice(block + 1)) {
    if (!/^\s/.test(line)) break;
    const match = /^\s+Content-Security-Policy: (.+)$/.exec(line);
    if (match) return match[1];
  }
  throw new StagingError("STAGING_CSP_MISSING");
}
const firstFiles = Object.freeze({
  broker: "tmp/broker-secrets.json",
  api: "tmp/api-secrets.json",
});

// The CI step without the token: card, gate 1 (main tip) and gate 2 (flag). It sets the
// step output `proceed` and exits 0 on every stop.
command("ci-gates", {
  usage: "ci-gates",
  parse: noArguments,
  async run(ctx) {
    if (!ctx.environment.ci) throw new StagingError("STAGING_CI_ONLY");
    const config = await ctx.config();
    let result;
    try {
      result = await ciGates(ctx, {
        github: githubTarget(config.staging),
        cardActive: cardState(config.card, ctx.now()).active,
      });
    } finally {
      ctx.setOutput("proceed", result?.proceed === true ? "true" : "false");
    }
    return result;
  },
});

command("deploy", {
  usage: "deploy [--first | --ci]",
  parse(args) {
    if (args.length === 0) return { mode: "local" };
    if (args.length === 1 && args[0] === "--first") return { mode: "first" };
    if (args.length === 1 && args[0] === "--ci") return { mode: "ci" };
    throw new StagingError("STAGING_USAGE");
  },
  async run(ctx, { mode }) {
    if ((mode === "ci") !== ctx.environment.ci)
      throw new StagingError(mode === "ci" ? "STAGING_CI_ONLY" : "STAGING_LOCAL_ONLY");
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    const staging = config.staging;
    identifiersSet(staging);
    const github = githubTarget(staging);
    const constants = await ctx.constants();
    const specs = await ctx.specs();
    const writeReport = (report) =>
      ctx.writeReport("staging/deploy-report.json", closedReport({ command: "deploy", ...report }));
    const report = await runDeploy(ctx, {
      mode,
      staging,
      github,
      configs: workerConfigs,
      names: staging.cloudflare.workers,
      brokerSecrets: constants.brokerSecrets,
      schemaHead: schemaHead(ctx.chain()),
      csp: committedCsp(ctx.root),
      checkpoint: writeReport,
      preconditions: () => mainPreconditions(ctx, github.repository),
      loginDigest: async () => (await ctx.loginConfiguration(config)).configurationDigest,
      challenge: () => ctx.challengeConfiguration(config),
      // The two owner files: exact key sets (their format checks), and the keyring bound
      // to the committed login configuration's digest.
      async firstFiles(digest) {
        readCredentialFile(ctx.directory, firstFiles.broker, specs);
        let keyring;
        try {
          keyring = JSON.parse(
            readCredentialFile(ctx.directory, firstFiles.api, specs),
          ).LOGIN_CAPSULE_KEYRING;
        } catch (error) {
          throw error instanceof StagingError ? error : new StagingError("STAGING_KEYRING_INVALID");
        }
        await ctx.checkKeyring(keyring, digest);
        return {
          broker: join(ctx.directory, firstFiles.broker),
          api: join(ctx.directory, firstFiles.api),
        };
      },
      // After the four uploads: unlink both files and record the versions that carry the
      // new secrets. The digest (E10) was published before the first upload.
      async afterFirst(versions) {
        for (const file of Object.values(firstFiles))
          try {
            unlinkSync(join(ctx.directory, file));
          } catch {
            // Already gone.
          }
        recordRotation(ctx.directory, constants.brokerSecrets, {
          worker: "broker",
          versionId: versions.broker.current,
          now: ctx.now(),
        });
        recordRotation(ctx.directory, ["LOGIN_CAPSULE_KEYRING"], {
          worker: "api",
          versionId: versions.api.current,
          now: ctx.now(),
        });
      },
    });
    writeReport(report);
    const ok = ["deployed", "superseded", "disabled"].includes(report.outcome);
    return { ...report, exitCode: ok ? 0 : 1 };
  },
});

// Anyone, any time, no card (D8). It reads only staging.json, so a broken wrangler
// configuration cannot stop it.
command("kill", {
  usage: "kill",
  parse: noArguments,
  async run(ctx) {
    let staging;
    try {
      staging = (await ctx.config()).staging;
    } catch {
      staging = JSON.parse(readFileSync(join(ctx.root, "infra/environments/staging.json"), "utf8"));
    }
    return runKill(ctx, { github: githubTarget(staging), staging });
  },
});

command("unkill", {
  usage: "unkill",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    identifiersSet(config.staging);
    return runUnkill(ctx, { github: githubTarget(config.staging), staging: config.staging });
  },
});

command("smoke", {
  usage: "smoke [--acceptance | --assisted]",
  parse(args) {
    if (args.length === 0) return { mode: "unattended" };
    if (args.length === 1 && args[0] === "--acceptance") return { mode: "acceptance" };
    if (args.length === 1 && args[0] === "--assisted") return { mode: "assisted" };
    throw new StagingError("STAGING_USAGE");
  },
  async run(ctx, { mode }) {
    const config = await ctx.config();
    identifiersSet(config.staging);
    if (mode !== "unattended") requireActiveCard(config.card, ctx.now());
    if (mode === "assisted") return assistedSmoke(ctx, { staging: config.staging });
    const result = await unattendedSmoke(ctx, {
      staging: config.staging,
      csp: committedCsp(ctx.root),
      acceptance: mode === "acceptance",
    });
    return { ...result, exitCode: result.failures.length ? 1 : 0 };
  },
});

command("preflight", {
  usage: "preflight",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    const specs = await ctx.specs();
    const pins = JSON.parse(readFileSync(join(ctx.root, "package.json"), "utf8")).devDependencies;
    return preflight(ctx, {
      staging: config.staging,
      card: config.card,
      cardState: cardState(config.card, ctx.now()),
      bindingSet: config.bindingJson !== null,
      challengeSet: config.challengeJson != null && config.broker?.turnstileJson != null,
      directory: inspectDirectory(ctx.directory),
      files: Object.keys(specs)
        .filter((name) => specs[name].required)
        .map((name) => inspectCredentialFile(ctx.directory, name, specs)),
      github: githubTarget(config.staging),
      root: ctx.root,
      pins: {
        wrangler: pins?.wrangler ?? null,
        neonctl: pins?.neonctl ?? null,
        playwright: pins?.playwright ?? null,
      },
    });
  },
});

command("status", {
  usage: "status",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    return stagingStatus(ctx, {
      staging: config.staging,
      github: githubTarget(config.staging),
      names: Object.fromEntries(
        deployOrder.map((key) => [key, config.staging.cloudflare.workers[key]]),
      ),
      schemaHead: schemaHead(ctx.chain()),
    });
  },
});

command("neon-probe", {
  usage: "neon-probe",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    return neonProbe(ctx, {
      staging: config.staging,
      administrator: ctx.administrator,
      connectProbe: (url) => ctx.probeDatabase(url),
    });
  },
});

command("queues", {
  usage: "queues",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    if (config.staging.cloudflare?.account_id === null)
      throw new StagingError("STAGING_IDENTIFIERS_UNSET");
    return createQueues(ctx, { staging: config.staging });
  },
});

command("turnstile-create", {
  usage: "turnstile-create",
  parse: noArguments,
  async run(ctx) {
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    return createTurnstile(ctx, { staging: config.staging, directory: ctx.directory });
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

// The deploy workflow's non-secret values (deploy-staging.yml). Only the CI deploy and
// ci-gates read them; the token itself is captured by staging-token.mjs.
export function ciEnvironment(source = process.env) {
  const ci = source.GITHUB_ACTIONS === "true" && source.CI === "true";
  const value = (name) => (typeof source[name] === "string" ? source[name] : null);
  return Object.freeze({
    ci,
    headSha: value("MORROW_DEPLOY_SHA"),
    deployEnabled: value("STAGING_DEPLOY_ENABLED"),
    schemaHead: value("STAGING_SCHEMA_HEAD"),
    loginDigest: value("STAGING_LOGIN_CONFIGURATION_DIGEST"),
    accountId: value("STAGING_CLOUDFLARE_ACCOUNT_ID"),
  });
}
// Gate 5's children (build, edge:check, edge:dry-run) get no credential: edge.mjs
// refuses any CLOUDFLARE_* variable, and the token was removed from process.env.
const gateEnvironment = (home) => {
  const env = { HOME: home, LANG: "C" };
  for (const name of ["PATH", "TMPDIR", "CI"])
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  return env;
};

// The real context. HOME is read before the wrangler API loads (it replaces HOME with a
// throwaway directory for its own children). The Cloudflare credential is resolved only
// when a command first needs wrangler or the API: from the CI step's environment, or
// from the operator's file locally.
export function defaultContext() {
  const home = homedir();
  const root = repositoryRoot;
  const directory = credentialDirectory(home);
  const environment = ciEnvironment();
  const ci = environment.ci;
  let constants, specs, config, credential;
  const ctx = {
    root,
    home,
    directory,
    environment,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    fetch: (url, init) => globalThis.fetch(url, init),
    interactive: () => process.stdin.isTTY === true && process.stderr.isTTY === true,
    notice: (text) => process.stderr.write(text + "\n"),
    browser: async () => (await import("playwright")).chromium,
    writeReport: (name, value) => writeArtifact(name, value),
    // A step output of the CI job (`proceed`), never a value from a provider.
    setOutput(name, value) {
      const path = process.env.GITHUB_OUTPUT;
      if (
        ci &&
        typeof path === "string" &&
        path !== "" &&
        /^[a-z]+=(true|false)$/.test(name + "=" + value)
      )
        appendFileSync(path, name + "=" + value + "\n");
    },
    async gate5() {
      for (const script of ["build", "edge:check", "edge:dry-run"]) {
        const result = await runChild("npm", ["run", "--silent", script], {
          cwd: root,
          env: gateEnvironment(home),
          timeoutMs: 900000,
        });
        if (result.status !== 0)
          throw new StagingError("STAGING_GATE5_FAILED", { step: script, status: result.status });
      }
    },
    probeDatabase: (url) =>
      neonConnector({
        ownerUrl: url,
        binding: { hostname: url.host, database: url.database },
        applicationName: "morrow-staging-probe",
      }).connect(),
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
    challengeConfiguration: (loaded) => checkChallengeConfiguration(loaded),
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
  // gh gets the captured GH_TOKEN (CI) in its own environment only; git gets none.
  const plain = createTools({ root, home, github: githubCredential() });
  // neonctl gets the project-scoped key (neon-project-api-key) in its environment only.
  let neon;
  const neonTools = async () =>
    (neon ??= createTools({
      root,
      home,
      neonApiKey: readCredentialFile(directory, "neon-project-api-key", await ctx.specs()),
    }));
  ctx.tools = Object.freeze({
    wrangler: async (args, options) => (await tools()).wrangler(args, options),
    gh: (args, options) => plain.gh(args, options),
    git: (args) => plain.git(args),
    neonctl: async (args, options) => (await neonTools()).neonctl(args, options),
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
