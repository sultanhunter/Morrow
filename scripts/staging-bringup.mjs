// The first bring-up's remaining staging subcommands (P04.T01i D3, D8 and Phase 0):
//   preflight         read-only: card, identifiers, credential files, pinned tools, git,
//                     the GitHub names; exits non-zero when a card effect cannot start
//   status            read-only: the deploy flag, the last deploy run, the deployed
//                     versions, the api's workers.dev state and health
//   neon-probe        M-N1, M-N3 and M-N4 on a throwaway child branch with an expiry (E3)
//   queues            E4: the two staging queues, created only when missing
//   turnstile-create  E5: the invisible widget for the staging hostname; its secret goes
//                     only to a new 0600 file
// Provider replies are parsed to closed values; a provider's text is never relayed. A
// create whose reply is lost is reconciled by listing before anything else, and an
// outcome that cannot be read back is reported as unknown, never as success.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StagingError, failureRecord } from "./staging-common.mjs";
import { createOwnerFile, parseOwnerUrl, recordRotation } from "./staging-files.mjs";
import { generatePassword, scramVerifier, sessionIdentity, sqlFailure } from "./staging-runner.mjs";
import { toolJson, toolOk } from "./staging-tools.mjs";
import {
  deployWorkflow,
  deployedVersion,
  readVariable,
  workflowState,
  workersDevState,
} from "./staging-deploy.mjs";
import { probeHealth } from "./staging-smoke.mjs";

const section = async (problems, label, fn) => {
  try {
    return await fn();
  } catch (error) {
    problems.push(label + ":" + failureRecord(error).code);
    return null;
  }
};

// ---------------------------------------------------------------------------
// preflight. `p`: {staging, cardState, bindingSet, challengeSet, files (inspected), directory
// (inspected), github, root, pins (package.json devDependencies)}.
export const pinnedTools = Object.freeze({
  wrangler: "node_modules/wrangler/package.json",
  neonctl: "node_modules/neonctl/package.json",
  playwright: "node_modules/playwright/package.json",
});
export async function preflight(ctx, p) {
  const blocking = [];
  const pending = [];
  const card = { ...p.cardState, expiresOn: p.card?.expiresOn ?? null };
  if (!card.active) blocking.push("card:" + card.reason);
  const cloudflare = p.staging.cloudflare ?? {};
  const neon = p.staging.neon ?? {};
  const identifiers = {
    accountId: cloudflare.account_id !== null,
    workersDevSubdomain: cloudflare.workers_dev_subdomain !== null,
    origin: cloudflare.origin !== null,
    projectId: neon.project_id !== null,
    rootBranchId: neon.root_branch_id !== null,
    branchId: neon.branch_id !== null,
    regionId: neon.region_id !== null,
    binding: p.bindingSet,
    // P05.T01ab: the api's LOGIN_CHALLENGE_JSON and the broker's
    // TURNSTILE_CONFIGURATION_JSON (PR-D part 1 identifiers; gate 4 checks them).
    challenge: p.challengeSet,
  };
  for (const [name, set] of Object.entries(identifiers))
    if (!set) pending.push("identifier:" + name);
  if (!p.directory.ok) blocking.push("credential_directory");
  for (const facts of p.files) if (facts.required && !facts.ok) pending.push("file:" + facts.file);
  const tools = {};
  for (const [name, path] of Object.entries(pinnedTools)) {
    let version = null;
    try {
      version = JSON.parse(readFileSync(join(p.root, path), "utf8")).version;
    } catch {
      version = null;
    }
    tools[name] = { pinned: p.pins[name] ?? null, installed: closedVersion(version) };
    if (tools[name].installed === null || tools[name].installed !== tools[name].pinned)
      blocking.push("tool:" + name);
  }
  const gh = await ctx.tools.gh(["auth", "status"]);
  tools.gh = { authenticated: gh?.status === 0 };
  if (!tools.gh.authenticated) blocking.push("tool:gh");
  const problems = [];
  const git = await section(problems, "git", async () => {
    const status = await toolOk(ctx.tools, "git", [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    const head = (
      await toolOk(ctx.tools, "git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
    ).trim();
    const main = (
      await toolOk(ctx.tools, "git", ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"])
    ).trim();
    return { clean: status.trim() === "", headIsMain: head === main };
  });
  const github = await section(problems, "github", async () => {
    const scope = p.github.environment ? ["--env", p.github.environment] : [];
    const list = async (kind) =>
      (
        await toolJson(ctx.tools, "gh", [
          kind,
          "list",
          "--repo",
          p.github.repository,
          ...scope,
          "--json",
          "name",
        ])
      )
        .map((entry) => entry?.name)
        .filter((name) => typeof name === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(name));
    const variables = await list("variable");
    const secrets = await list("secret");
    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "STAGING_DEPLOY_ENABLED"])
      if (!variables.includes(name)) pending.push("github_variable:" + name);
    if (!secrets.includes("CLOUDFLARE_API_TOKEN"))
      pending.push("github_secret:CLOUDFLARE_API_TOKEN");
    return { variables: variables.sort(), secrets: secrets.sort() };
  });
  for (const problem of problems) blocking.push(problem);
  return {
    card,
    identifiers,
    directory: p.directory,
    files: p.files,
    tools,
    git,
    github,
    blocking,
    pending,
    exitCode: blocking.length ? 1 : 0,
  };
}
const closedVersion = (value) =>
  typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) ? value : null;

// ---------------------------------------------------------------------------
// status. `p`: {staging, github, names, schemaHead}.
export async function status(ctx, p) {
  const problems = [];
  const flag = await section(problems, "flag", async () => ({
    value: await readVariable(ctx, p.github, "STAGING_DEPLOY_ENABLED"),
    workflow: await workflowState(ctx, p.github),
  }));
  const lastDeploy = await section(problems, "last_deploy", async () => {
    const reply = await toolJson(ctx.tools, "gh", [
      "api",
      `repos/${p.github.repository}/actions/workflows/${deployWorkflow}/runs?per_page=1`,
    ]);
    const run = Array.isArray(reply?.workflow_runs) ? reply.workflow_runs[0] : undefined;
    if (run === undefined) return null;
    return {
      id: Number.isSafeInteger(run?.id) ? run.id : null,
      status: /^[a-z_]{1,32}$/.test(run?.status ?? "") ? run.status : null,
      conclusion: /^[a-z_]{1,32}$/.test(run?.conclusion ?? "") ? run.conclusion : null,
      sha: /^[0-9a-f]{40}$/.test(run?.head_sha ?? "") ? run.head_sha : null,
    };
  });
  const schema = await section(problems, "schema", async () => {
    const variable = await readVariable(ctx, p.github, "STAGING_SCHEMA_HEAD");
    return { committed: p.schemaHead, matches: variable === p.schemaHead };
  });
  let workers = null;
  let health = null;
  const accountId = p.staging.cloudflare?.account_id ?? null;
  if (accountId === null) problems.push("workers:STAGING_IDENTIFIERS_UNSET");
  else
    workers = await section(problems, "workers", async () => {
      const api = await ctx.cloudflareApi(accountId);
      const out = {};
      for (const [key, name] of Object.entries(p.names))
        out[key] = { versionId: await deployedVersion(api, name) };
      out.api.workersDev = await workersDevState(api, p.names.api);
      return out;
    });
  if (typeof p.staging.cloudflare?.origin === "string")
    health = await probeHealth(ctx, p.staging.cloudflare.origin);
  return { flag, lastDeploy, schema, workers, health, problems };
}

// ---------------------------------------------------------------------------
// neon-probe (M-N1, M-N3, M-N4). `p`: {staging, administrator, connectProbe(url)}. Only
// a branch it creates is touched: a fresh `morrow-probe-<hex>` child of the root branch
// with an expiry, never the root or the bound `staging` branch. The probe's connection
// strings are read in-process from neonctl's stdout and never printed.
const branchId = /^br-[a-z0-9-]{1,60}$/;
export async function neonProbe(ctx, p) {
  const neon = p.staging.neon ?? {};
  if (neon.project_id === null || neon.root_branch_id === null)
    throw new StagingError("STAGING_IDENTIFIERS_UNSET");
  const project = neon.project_id;
  const name = "morrow-probe-" + randomBytes(4).toString("hex");
  const expiresAt = new Date(ctx.now() + 2 * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const neonJson = (args) => toolJson(ctx.tools, "neonctl", [...args, "--output", "json"]);
  const created = await ctx.tools.neonctl([
    "branches",
    "create",
    "--project-id",
    project,
    "--name",
    name,
    "--parent",
    neon.root_branch_id,
    "--expires-at",
    expiresAt,
    "--no-secrets",
    "--output",
    "json",
  ]);
  if (created?.status !== 0) {
    let branch = "unknown";
    try {
      const listed = await neonJson(["branches", "list", "--project-id", project]);
      const rows = Array.isArray(listed) ? listed : listed?.branches;
      if (Array.isArray(rows)) branch = rows.some((b) => b?.name === name) ? "present" : "absent";
    } catch {
      branch = "unknown";
    }
    throw new StagingError("STAGING_NEON_PROBE_CREATE_FAILED", { branch, name });
  }
  let reply;
  try {
    reply = JSON.parse(created.stdout);
  } catch {
    throw new StagingError("STAGING_NEONCTL_OUTPUT_INVALID");
  }
  const branch = reply?.branch ?? reply;
  const id = branch?.id;
  if (
    typeof id !== "string" ||
    !branchId.test(id) ||
    branch?.name !== name ||
    id === neon.root_branch_id ||
    id === neon.branch_id
  )
    throw new StagingError("STAGING_NEONCTL_OUTPUT_INVALID");
  const ownerUrl = async () => {
    const text = await toolOk(ctx.tools, "neonctl", [
      "connection-string",
      id,
      "--project-id",
      project,
      "--role-name",
      p.administrator.name,
      "--database-name",
      "neondb",
    ]);
    return parseOwnerUrl(text.trim());
  };
  const report = {
    branch: { name, id, expiresAt },
    mN1: null,
    mN3: null,
    mN4: null,
    cleanup: "branch_expires_at",
  };
  const first = await ownerUrl();
  const role = "morrow_probe_" + randomBytes(4).toString("hex");
  const connection = await p.connectProbe(first);
  try {
    const identity = await sessionIdentity(connection);
    if (identity?.session_role !== p.administrator.name || identity.superuser)
      throw new StagingError("STAGING_ADMINISTRATOR_SHAPE");
    await connection.exec(`CREATE ROLE ${role} NOLOGIN`);
    const selfGrant = async () =>
      (
        await connection.query(
          "SELECT m.admin_option AS admin, m.inherit_option AS inherit, m.set_option AS set, g.rolname::text AS grantor, g.rolsuper AS grantor_superuser FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid = m.grantor WHERE m.roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1) AND m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = session_user)",
          [role],
        )
      )[0] ?? null;
    const row = await selfGrant();
    let revokeSqlstate = null;
    try {
      await connection.exec(`REVOKE ${role} FROM ${p.administrator.name}`);
    } catch (error) {
      revokeSqlstate = failureRecord(sqlFailure("STAGING_PROBE_REVOKE", error)).sqlstate ?? null;
    }
    const after = await selfGrant();
    report.mN1 = {
      selfGrantRow: row ? { admin: row.admin, inherit: row.inherit, set: row.set } : null,
      grantor: row && /^[a-z_][a-z0-9_]{0,62}$/.test(row.grantor) ? row.grantor : null,
      grantorSuperuser: row ? row.grantor_superuser === true : null,
      revokeRefused: after !== null,
      revokeSqlstate,
    };
    // M-N3: a SCRAM verifier, so no plaintext reaches the server.
    const verifier = scramVerifier(generatePassword());
    try {
      await connection.exec(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${verifier}'`);
      report.mN3 = { verifierAccepted: true, sqlstate: null };
    } catch (error) {
      report.mN3 = {
        verifierAccepted: false,
        sqlstate: failureRecord(sqlFailure("STAGING_PROBE_VERIFIER", error)).sqlstate ?? null,
      };
    }
    await connection.exec(`ALTER ROLE ${role} WITH NOLOGIN PASSWORD NULL`);
  } catch (error) {
    throw sqlFailure("STAGING_NEON_PROBE_SQL", error);
  } finally {
    await connection.close();
  }
  // M-N4: reset to the parent keeps the branch id and host and drops the child's roles.
  const reset = await ctx.tools.neonctl([
    "branches",
    "reset",
    id,
    "--parent",
    "--project-id",
    project,
    "--output",
    "json",
  ]);
  if (reset?.status !== 0)
    throw new StagingError("STAGING_NEON_PROBE_RESET_FAILED", { outcome: "unknown" });
  const got = await neonJson(["branches", "get", id, "--project-id", project]);
  const second = await ownerUrl();
  const again = await p.connectProbe(second);
  try {
    const [present] = await again.query(
      "SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname = $1",
      [role],
    );
    report.mN4 = {
      branchIdKept: (got?.branch ?? got)?.id === id,
      hostKept: second.host === first.host,
      rolesDropped: present?.n === 0,
      expirySupported: true,
    };
  } catch (error) {
    throw sqlFailure("STAGING_NEON_PROBE_SQL", error);
  } finally {
    await again.close();
  }
  return report;
}

// ---------------------------------------------------------------------------
// queues (E4). `p`: {staging}.
export const stagingQueues = Object.freeze([
  "morrow-staging-dispatch-dlq",
  "morrow-staging-dispatch",
]);
const queueNames = (rows) => {
  if (!Array.isArray(rows)) throw new StagingError("STAGING_CLOUDFLARE_RESPONSE_INVALID");
  return rows.map((q) => q?.queue_name).filter((n) => typeof n === "string");
};
export async function createQueues(ctx, p) {
  const api = await ctx.cloudflareApi(p.staging.cloudflare.account_id);
  const present = queueNames(await api.get(["queues"]));
  const queues = [];
  for (const name of stagingQueues) {
    if (present.includes(name)) {
      queues.push({ name, state: "present" });
      continue;
    }
    try {
      await api.request("POST", ["queues"], { body: { queue_name: name } });
    } catch {
      let listed;
      try {
        listed = queueNames(await api.get(["queues"]));
      } catch {
        throw new StagingError("STAGING_QUEUE_OUTCOME_UNKNOWN", { queue: name });
      }
      if (!listed.includes(name))
        throw new StagingError("STAGING_QUEUE_CREATE_FAILED", { queue: name });
    }
    queues.push({ name, state: "created" });
  }
  return { queues };
}

// ---------------------------------------------------------------------------
// turnstile-create (E5, M-T1's widget). `p`: {staging, directory}.
export const turnstileWidget = "morrow-staging";
const siteKeyFormat = /^0x[0-9A-Za-z_-]{10,64}$/;
const secretFormat = /^0x[0-9A-Za-z_-]{20,128}$/;
export async function createTurnstile(ctx, p) {
  const origin = p.staging.cloudflare?.origin;
  if (typeof origin !== "string" || p.staging.cloudflare.account_id === null)
    throw new StagingError("STAGING_IDENTIFIERS_UNSET");
  const hostname = new URL(origin).hostname;
  // Reserve the secret file first: an existing file stops before any effect.
  const handle = createOwnerFile(p.directory, "turnstile-secret");
  let api;
  const widgetsNamed = async () =>
    (await api.list(["challenges", "widgets"], 25)).filter((w) => w?.name === turnstileWidget);
  try {
    api = await ctx.cloudflareApi(p.staging.cloudflare.account_id);
    if ((await widgetsNamed()).length) throw new StagingError("STAGING_TURNSTILE_WIDGET_EXISTS");
  } catch (error) {
    handle.abandon();
    throw error;
  }
  let result;
  try {
    result = (
      await api.request("POST", ["challenges", "widgets"], {
        body: { name: turnstileWidget, domains: [hostname], mode: "invisible", region: "world" },
      })
    )?.result;
  } catch (error) {
    handle.abandon();
    let existing;
    try {
      existing = await widgetsNamed();
    } catch {
      throw new StagingError("STAGING_TURNSTILE_OUTCOME_UNKNOWN");
    }
    if (existing.length) throw new StagingError("STAGING_TURNSTILE_SECRET_LOST");
    // A refused create names Cloudflare's status and numeric codes only (never its messages).
    const refused = error?.code === "STAGING_CLOUDFLARE_REQUEST_FAILED" ? error.details : null;
    throw new StagingError("STAGING_TURNSTILE_CREATE_FAILED", {
      status: refused?.status ?? null,
      codes: Array.isArray(refused?.codes) ? refused.codes : [],
    });
  }
  const siteKey = result?.sitekey;
  const secret = result?.secret;
  if (
    typeof siteKey !== "string" ||
    !siteKeyFormat.test(siteKey) ||
    typeof secret !== "string" ||
    !secretFormat.test(secret)
  ) {
    handle.abandon();
    throw new StagingError("STAGING_TURNSTILE_SECRET_LOST");
  }
  handle.write(secret);
  recordRotation(p.directory, ["TURNSTILE_SECRET_KEY"], {
    worker: "broker",
    versionId: null,
    now: ctx.now(),
  });
  return {
    widget: turnstileWidget,
    siteKey,
    hostname,
    mode: "invisible",
    file: "turnstile-secret",
  };
}
