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
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot, writeArtifact } from "./artifacts.mjs";
import { captureConsole, loadWranglerApi, reviewedStripeRecord } from "./edge.mjs";
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
  billingTermsSeedRows,
  connectionCensus,
  customerResolutionInput,
  grantTestEntitlement,
  neonConnector,
  platformSeedRows,
  platformStop,
  checkPlatformStopInput,
  provisionRoles,
  resolveHeldCustomerOperation,
  roleControlFacts,
  runMigrations,
  seedBillingTerms,
  seedPlatform,
  sessionIdentity,
  checkIdentity,
  liveEvidenceRef,
  statementStatsScratchDatabase,
  testEntitlementApproval,
  testEntitlementInput,
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

// M5, the Stripe switch (owner decision (c), 2026-10-21): the committed
// docs/decisions/stripe-staging.json `switch`, checked with edge:check's own rule
// (reviewedStripeRecord). "off" (the committed state) or "on"; anything else stops the
// command before any effect.
export function stagingStripeSwitch(root) {
  try {
    return reviewedStripeRecord(
      JSON.parse(readFileSync(join(root, "docs/decisions/stripe-staging.json"), "utf8")),
    ).switch;
  } catch {
    throw new StagingError("STAGING_STRIPE_RECORD_INVALID");
  }
}

// `stripe` is the Stripe switch (stagingStripeSwitch): off by default, so a caller that
// does not read the record never expects a Stripe secret.
export async function identityConstants({ stripe = "off" } = {}) {
  if (stripe !== "off" && stripe !== "on") throw new StagingError("STAGING_STRIPE_RECORD_INVALID");
  const { tsImport } = await import("tsx/esm/api");
  const protocol = await tsImport("../packages/identity/src/broker-protocol.ts", import.meta.url);
  return Object.freeze({
    // The broker's database logins that provisioning controls: the ten leased roles
    // (brokerNeonRoles) and M2 PR-1's own vault login, which is never leased (ADR-0022
    // item 7). Each gets LOGIN, the limit, both timeouts and a generated password.
    roles: [...protocol.brokerNeonRoleNames, protocol.brokerVaultRole],
    passwordSecret: protocol.brokerPasswordSecret,
    // The broker's names (D1, AC02): WORKOS_API_KEY, P05.T01ab's TURNSTILE_SECRET_KEY, the
    // eleven role passwords and M2 PR-1's MORROW_VAULT_KEK_V1 (fourteen), and, only while
    // the Stripe switch is on, M5 PR-1's STRIPE_RESTRICTED_KEY and STRIPE_WEBHOOK_SECRET
    // (sixteen). brokerRequiredSecretsFor("staging", stripe) is the one list: the staging
    // wrangler `secrets.required`, verify-config, gate 6, secrets-status and the
    // first-deploy file all use it (production requires its vault-free subset).
    brokerSecrets: [...protocol.brokerRequiredSecretsFor("staging", stripe)].sort(),
    // The vault KEKs (ADR-0022 item 7) are the owner's: each is read from its owner file
    // (`vault-kek-v<n>`, written by `npm run vault -- kek`) and never generated here.
    vaultKekSecrets: [...protocol.brokerVaultKekSecrets],
    // M5: the switch, and the Stripe secrets it requires (none while off), read from their
    // owner files like the WorkOS key.
    stripe,
    stripeSecrets: stripe === "on" ? [...protocol.brokerStripeSecrets] : [],
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
      // M5 PR-1: the saved portal configuration and tax flags, a reviewed identifier that
      // arrives on the PR-D path, and the Stripe switch's mode; both only while the switch
      // is on (checkStripeConfiguration).
      stripeJson: text(brokerVars, "STRIPE_CONFIGURATION_JSON"),
      stripeMode: text(brokerVars, "MORROW_STRIPE_MODE"),
    }),
    // M5: the api's Stripe switch mode (only while the switch is on).
    stripeMode: text(vars, "MORROW_STRIPE_MODE"),
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

// M5 PR-1 and the Stripe switch (owner decision (c), 2026-10-21), part of gate 4 before
// any upload. Off (the committed state): neither Worker carries MORROW_STRIPE_MODE and the
// broker carries no STRIPE_CONFIGURATION_JSON (gate 6 then expects no Stripe secret). On:
// both carry MORROW_STRIPE_MODE "test", and the broker's STRIPE_CONFIGURATION_JSON is
// present and the closed shape the broker itself parses (parseStripeConfiguration). Any
// other combination is STAGING_STRIPE_SWITCH_MIXED; edge:check (gate 5) also pins the
// configuration to its reviewed record.
export async function checkStripeConfiguration(loaded, stripe = "off") {
  const json = loaded?.broker?.stripeJson ?? null;
  const modes = [loaded?.stripeMode ?? null, loaded?.broker?.stripeMode ?? null];
  if (stripe === "off") {
    if (json !== null || modes.some((mode) => mode !== null))
      throw new StagingError("STAGING_STRIPE_SWITCH_MIXED", { stripe });
    return Object.freeze({ stripe, present: false });
  }
  if (stripe !== "on" || json === null || modes.some((mode) => mode !== "test"))
    throw new StagingError("STAGING_STRIPE_SWITCH_MIXED", {
      stripe: stripe === "on" ? "on" : null,
    });
  const { tsImport } = await import("tsx/esm/api");
  const { parseStripeConfiguration } = await tsImport(
    "../packages/identity/src/broker-protocol.ts",
    import.meta.url,
  );
  try {
    const parsed = parseStripeConfiguration(json);
    return Object.freeze({ stripe, present: true, automaticTax: parsed.automaticTax });
  } catch {
    throw new StagingError("STAGING_STRIPE_CONFIGURATION_INVALID");
  }
}

// M5 PR-1: one environment's published billing terms (docs/decisions/billing-terms.json),
// parsed again with the billing module (parseTermsDocument, the published digest) before
// any database effect. staging has no revision until the owner's test-mode Price exists.
export async function stagingBillingTermsRows(root, environment = "staging") {
  let revisions;
  try {
    revisions = JSON.parse(readFileSync(join(root, "docs/decisions/billing-terms.json"), "utf8"))
      .environments[environment];
  } catch {
    throw new StagingError("STAGING_TERMS_INVALID");
  }
  const { tsImport } = await import("tsx/esm/api");
  const { parseTermsDocument, termsDocumentDigest } = await tsImport(
    "../packages/work/src/billing/terms.ts",
    import.meta.url,
  );
  if (!Array.isArray(revisions)) throw new StagingError("STAGING_TERMS_INVALID");
  for (const revision of revisions) {
    try {
      parseTermsDocument(revision?.terms, revision?.offers);
    } catch {
      throw new StagingError("STAGING_TERMS_INVALID");
    }
    if ((await termsDocumentDigest(revision.terms, revision.offers)) !== revision.digest)
      throw new StagingError("STAGING_TERMS_INVALID");
  }
  return billingTermsSeedRows(revisions);
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
    // The scratch database the statement-statistics wipe runs from (M-N3 as amended
    // 2026-10-20): the same endpoint and administrator, never the binding database.
    const scratch = {
      database: statementStatsScratchDatabase,
      connect: ctx.database({
        ownerUrl,
        binding: { ...binding, database: statementStatsScratchDatabase },
      }).connect,
    };
    if (options.mode === "first") {
      // One source of names: the file holds brokerRequiredSecrets exactly (the list gate 6
      // and the first deploy's file check use). The names are checked before any file is
      // read or created and before any role is touched, and the written keys again.
      const fileNames = (names) => [...names].sort().join("\n");
      const expected = fileNames(constants.brokerSecrets);
      const kekNames = constants.vaultKekSecrets;
      const stripeNames = constants.stripeSecrets;
      const planned = [
        "WORKOS_API_KEY",
        "TURNSTILE_SECRET_KEY",
        ...roles.map(constants.passwordSecret),
        ...kekNames,
        // M5 PR-1: the two Stripe secrets, from their owner files, only while the Stripe
        // switch is on (none while it is off: the owner files are then never read).
        ...stripeNames,
      ];
      if (
        new Set(planned).size !== planned.length ||
        fileNames(planned) !== expected ||
        !kekNames.every((name) => vaultKekFile(name) !== null) ||
        !stripeNames.every((name) => Object.hasOwn(stripeSecretFiles, name))
      )
        throw new StagingError("STAGING_BROKER_FILE_NAMES_INVALID");
      const workos = readCredentialFile(ctx.directory, "workos-api-key", specs);
      const turnstile = readCredentialFile(ctx.directory, "turnstile-secret", specs);
      const stripeValues = Object.fromEntries(
        stripeNames.map((name) => [
          name,
          readCredentialFile(ctx.directory, stripeSecretFiles[name], specs),
        ]),
      );
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
          scratch,
        });
      } catch (error) {
        handle.abandon();
        throw error;
      }
      const secrets = {
        WORKOS_API_KEY: workos,
        TURNSTILE_SECRET_KEY: turnstile,
        ...stripeValues,
        ...keks,
      };
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
      return {
        mode: "first",
        roles,
        file: "tmp/broker-secrets.json",
        controls: "verified",
        passwordStorage: provisioned.passwordStorage,
        statementStats: provisioned.statementStats,
      };
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
      scratch,
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
    return {
      mode: "rotate",
      roles: selected,
      versionId,
      controls: "verified",
      passwordStorage: provisioned.passwordStorage,
      statementStats: provisioned.statementStats,
    };
  },
});

// M5 PR-1 adds the two Stripe secrets, only while the Stripe switch is on (owner decision
// (c), 2026-10-21). While it is off put-secret refuses both (STAGING_STRIPE_OFF) before
// any effect: gate 6 and secrets-status then expect the broker to hold neither. Once a
// reviewed commit turns the switch on, this deliberately reverses the P04.T01i note that
// put-secret only re-places names the running broker already holds: the running broker
// lacks both Stripe names and gate 6 holds every deploy until the owner places them, so
// put-secret adds them (docs/packets/P04.T01i.md, the M5 PR-1 note).
const stripeSecretFiles = Object.freeze({
  STRIPE_RESTRICTED_KEY: "stripe-restricted-key",
  STRIPE_WEBHOOK_SECRET: "stripe-webhook-secret",
});
const putSecretFiles = Object.freeze({
  WORKOS_API_KEY: "workos-api-key",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
  ...stripeSecretFiles,
});
// M2 PR-1: a vault KEK (MORROW_VAULT_KEK_V<n>) is re-placed from the owner's own file,
// with the same value; a new KEK is a new version, never a new value under an old name.
const putSecretFile = (name) =>
  Object.hasOwn(putSecretFiles, name) ? putSecretFiles[name] : vaultKekFile(name);
command("put-secret", {
  usage:
    "put-secret WORKOS_API_KEY|TURNSTILE_SECRET_KEY|STRIPE_RESTRICTED_KEY|STRIPE_WEBHOOK_SECRET|MORROW_VAULT_KEK_V1",
  parse(args) {
    if (args.length !== 1 || putSecretFile(args[0]) === null)
      throw new StagingError("STAGING_USAGE");
    return { name: args[0] };
  },
  async run(ctx, { name }) {
    const constants = await ctx.constants();
    if (!Object.hasOwn(putSecretFiles, name) && !constants.vaultKekSecrets.includes(name))
      throw new StagingError("STAGING_USAGE");
    if (Object.hasOwn(stripeSecretFiles, name) && !constants.stripeSecrets.includes(name))
      throw new StagingError("STAGING_STRIPE_OFF");
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
    // M5 PR-1: the billing terms, checked before any effect.
    const terms = await ctx.billingTerms();
    const written = await seedPlatform({
      connect: ctx.database({ ownerUrl, binding }).connect,
      binding,
      administrator: ctx.administrator,
      rows,
      selfService,
    });
    const billing = await seedBillingTerms({
      connect: ctx.database({ ownerUrl, binding }).connect,
      binding,
      administrator: ctx.administrator,
      rows: terms,
    });
    return { ...written, ...billing, origin: configuration.origin };
  },
});

// M5 PR-1 (review): the operator path for a customer operation the broker held (Stripe
// proved neither outcome). Under the active staging card, only with the live-evidence
// record of the operator's Stripe inspection or correction committed at --evidence; the
// definer re-checks the hold and the window. Prints the outcome only.
command("billing-customer-resolve", {
  usage:
    "billing-customer-resolve --operation <uuid> --resolution retry|abandon --evidence-code <code> --evidence <docs/evidence/live/....md> --operator <id>",
  parse(args) {
    const flags = {};
    for (let i = 0; i < args.length; i += 2) {
      const [flag, value] = [args[i], args[i + 1]];
      if (
        !["--operation", "--resolution", "--evidence-code", "--evidence", "--operator"].includes(
          flag,
        ) ||
        typeof value !== "string" ||
        Object.hasOwn(flags, flag)
      )
        throw new StagingError("STAGING_USAGE");
      flags[flag] = value;
    }
    const input = {
      operatorId: flags["--operator"],
      operationId: flags["--operation"],
      resolution: flags["--resolution"],
      evidenceCode: flags["--evidence-code"],
      evidenceRef: flags["--evidence"],
    };
    customerResolutionInput(input);
    return { input };
  },
  async run(ctx, { input }) {
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    if (!existsSync(join(ctx.root, input.evidenceRef)))
      throw new StagingError("STAGING_EVIDENCE_MISSING");
    const binding = await stagingBinding(ctx, config);
    await mainPreconditions(ctx, repositoryOf(config.staging));
    const ownerUrl = ownerUrlFor(ctx, binding, await ctx.specs());
    return resolveHeldCustomerOperation({
      connect: ctx.database({ ownerUrl, binding }).connect,
      binding,
      administrator: ctx.administrator,
      input,
    });
  },
});

// The staging test entitlement (owner decision (b), 2026-10-21; the ADR-0022 item 5
// amendment; card E13). Each use needs the owner's own approval in chat for this workspace,
// recorded in a docs/evidence/live record committed to main before the run: the record
// must name the approval reference and the workspace (requireTestEntitlementRecord), and it
// is read from the commit mainPreconditions verified (committedRecord), never from the
// working tree. Under the active card that carries E13, with an approval reference of that
// card and effect dated from the amendment to today.
// Prints the closed result: the outcome, ids, credit units, the terms revision and the
// period, with the approval reference, the record's path and the commit it was read at.
export function requireTestEntitlementApproval(card, approvalRef, now) {
  const e13 = card?.e13;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (
    !e13 ||
    typeof e13 !== "object" ||
    Object.keys(e13).join() !== "amendedOn" ||
    !day.test(e13.amendedOn ?? "") ||
    !(e13.amendedOn >= card.approvedOn && e13.amendedOn <= card.expiresOn)
  )
    throw new StagingError("STAGING_CARD_EFFECT_MISSING", { effect: "E13" });
  const match = testEntitlementApproval.exec(approvalRef);
  const today = new Date(now).toISOString().slice(0, 10);
  if (
    !match ||
    match[1] !== card.id ||
    match[2] !== "e13" ||
    !Number.isFinite(Date.parse(match[3] + "T00:00:00Z")) ||
    match[3] < e13.amendedOn ||
    match[3] > today
  )
    throw new StagingError("STAGING_APPROVAL_INVALID");
}
// The record names the run on two labelled lines, each exactly once: a plain line or a
// Markdown list item, the label optionally in bold, the value alone, bare or in backticks:
//   - Approval reference: `staging-card-1.e13.2026-10-22.1`
//   - Workspace: `ws_...`
// Each value must equal the run's approval reference or workspace id exactly. A substring
// never matches (approval .1 is not named by a record of .10, nor a workspace id by a
// longer one), and a labelled line whose value is not one delimited token, or a second
// line with the same label, refuses the run.
const recordLabel =
  /^(?:[-*] +)?(?:\*\*(Approval reference|Workspace):\*\*|(Approval reference|Workspace):)(.*)$/;
const recordValue = /^ +(?:`([^`\s]+)`|([^`\s]+)) *$/;
export function requireTestEntitlementRecord(text, { approvalRef, workspaceId }) {
  const named = { "Approval reference": [], Workspace: [] };
  for (const line of String(text).split(/\r?\n/)) {
    const label = recordLabel.exec(line.trim());
    if (!label) continue;
    const value = recordValue.exec(label[3]);
    named[label[1] ?? label[2]].push(value ? (value[1] ?? value[2]) : null);
  }
  const approvals = named["Approval reference"];
  const workspaces = named.Workspace;
  if (
    approvals.length !== 1 ||
    approvals[0] !== approvalRef ||
    workspaces.length !== 1 ||
    workspaces[0] !== workspaceId
  )
    throw new StagingError("STAGING_EVIDENCE_MISMATCH");
}
// The record as committed at `commit` (the origin/main head mainPreconditions verified),
// never the working tree: an ignored or untracked file, or one edited after the clean-tree
// check, cannot stand in for it. One regular blob (mode 100644) at exactly that path, read
// by its object id; a missing path, a symbolic link, an executable file or a directory is
// STAGING_EVIDENCE_MISSING.
const committedEntry = /^100644 blob ([0-9a-f]{40})\t([^\0]+)\0$/;
export async function committedRecord(ctx, commit, path) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit))
    throw new StagingError("STAGING_GIT_OUTPUT_INVALID");
  if (typeof path !== "string" || !liveEvidenceRef.test(path))
    throw new StagingError("STAGING_USAGE");
  const listing = await toolOk(ctx.tools, "git", [
    "ls-tree",
    "-z",
    "--full-tree",
    commit,
    "--",
    path,
  ]);
  const entry = committedEntry.exec(listing);
  if (!entry || entry[2] !== path) throw new StagingError("STAGING_EVIDENCE_MISSING");
  return toolOk(ctx.tools, "git", ["cat-file", "blob", entry[1]]);
}
command("test-entitlement", {
  usage:
    "test-entitlement --workspace <id> --approval <staging-card-1.e13.YYYY-MM-DD.n> --record <docs/evidence/live/....md> --operator <id>",
  parse(args) {
    const flags = {};
    for (let i = 0; i < args.length; i += 2) {
      const [flag, value] = [args[i], args[i + 1]];
      if (
        !["--workspace", "--approval", "--record", "--operator"].includes(flag) ||
        typeof value !== "string" ||
        Object.hasOwn(flags, flag)
      )
        throw new StagingError("STAGING_USAGE");
      flags[flag] = value;
    }
    const input = {
      operatorId: flags["--operator"],
      workspaceId: flags["--workspace"],
      approvalRef: flags["--approval"],
      evidenceRef: flags["--record"],
    };
    testEntitlementInput(input);
    return { input };
  },
  async run(ctx, { input }) {
    const config = await ctx.config();
    requireActiveCard(config.card, ctx.now());
    requireTestEntitlementApproval(config.card, input.approvalRef, ctx.now());
    const binding = await stagingBinding(ctx, config);
    const { sourceCommit } = await mainPreconditions(ctx, repositoryOf(config.staging));
    requireTestEntitlementRecord(
      await committedRecord(ctx, sourceCommit, input.evidenceRef),
      input,
    );
    const ownerUrl = ownerUrlFor(ctx, binding, await ctx.specs());
    const granted = await grantTestEntitlement({
      connect: ctx.database({ ownerUrl, binding }).connect,
      binding,
      administrator: ctx.administrator,
      input,
    });
    return {
      ...granted,
      approvalRef: input.approvalRef,
      record: input.evidenceRef,
      recordCommit: sourceCommit,
    };
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
      // Gate 4 also checks the Stripe switch's vars against the committed switch (M5): none
      // while it is off; while it is on, both modes and a broker configuration that parses.
      async challenge() {
        await ctx.challengeConfiguration(config);
        await checkStripeConfiguration(config, constants.stripe);
      },
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

// M3 PR-1 (ADR-0022 item 15; ADR-0005): the owner-run platform stop. `set` needs no card,
// like `kill`: a person may always stop AI work and Shopify effects platform-wide. `lift`
// needs the active card. Neither needs main or the foundation check, so a stop is never
// held behind a deploy gate. The reason is a person's text: a parameter, never echoed.
// Any hosted run is an administrator effect outside staging-card-1, so it needs the
// owner's per-action approval and a docs/evidence/live/ record.
command("platform-stop", {
  usage: "platform-stop set|lift --operator <id> --reason <text>",
  parse(args) {
    if (
      args.length !== 5 ||
      (args[0] !== "set" && args[0] !== "lift") ||
      args[1] !== "--operator" ||
      args[3] !== "--reason"
    )
      throw new StagingError("STAGING_USAGE");
    return checkPlatformStopInput({ action: args[0], operatorId: args[2], reason: args[4] });
  },
  async run(ctx, options) {
    const config = await ctx.config();
    if (options.action === "lift") requireActiveCard(config.card, ctx.now());
    const binding = await stagingBinding(ctx, config);
    const ownerUrl = ownerUrlFor(ctx, binding, await ctx.specs());
    return platformStop({
      connect: ctx.database({ ownerUrl, binding }).connect,
      binding,
      administrator: ctx.administrator,
      ...options,
    });
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
    // M-N3: the probe sends its plaintext in the binding's database (on the probe branch)
    // and wipes the statistics from the scratch database, as provision-roles does.
    let database = null;
    if (config.bindingJson !== null)
      try {
        database = (await ctx.constants()).parseBinding(config.bindingJson).database;
      } catch {
        throw new StagingError("STAGING_BINDING_INVALID");
      }
    return neonProbe(ctx, {
      staging: config.staging,
      administrator: ctx.administrator,
      database,
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
    constants: async () =>
      (constants ??= await identityConstants({ stripe: stagingStripeSwitch(root) })),
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
    billingTerms: () => stagingBillingTermsRows(root, "staging"),
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

// Node's happy-eyeballs connect (autoSelectFamily): each address attempt gets this long
// before the next address is tried. Node's default (250 ms) is shorter than a connect
// from the operator's network to Neon's us-east-1 endpoints, so every connection there
// (TLS, the Neon driver's WebSocket, HTTPS) failed with ETIMEDOUT and the tools reported
// STAGING_DATABASE_UNAVAILABLE; 3000 ms connected in about 575 ms (2026-10-20,
// docs/evidence/live/2026-10-20-neon-probe-rerun.md). The connector's own deadlines
// (25 s connect, 2 s end) still bound every attempt.
export const connectAttemptTimeoutMs = 3000;

// The CLI entry: the connect timeout is set before the context exists and before any
// network call, so every connection this process opens uses it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setDefaultAutoSelectFamilyAttemptTimeout(connectAttemptTimeoutMs);
  const code = await main(process.argv.slice(2), defaultContext()).catch(() => {
    process.stderr.write(JSON.stringify({ code: "STAGING_INTERNAL_ERROR" }) + "\n");
    return 1;
  });
  process.exit(code);
}
