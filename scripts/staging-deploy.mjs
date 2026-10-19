// Deploy, kill and unkill for staging (P04.T01i D2 and D8, trimmed by ADR-0021), and the
// account census they share with `staging:census`.
//   deploy   gates 1–6 of ADR-0019 item 4, a census before any upload, the order broker →
//            orchestrator → connector → api, the deploy flag re-read just before every
//            upload and just after the api deploy, the health check, the unattended smoke,
//            and a census on every path that started an upload. On ready:false the run
//            fails and keeps both api version ids. There is no rollback: card effect E11
//            is suspended until the rollback refusal exists, so staging rolls forward.
//   kill     anyone, any time: the flag to 0, the deploy workflow disabled, queued and
//            running deploys cancelled, the api's workers.dev off, then the hostname
//            checked now, after 2 minutes and after 10 minutes.
//   unkill   only under an active card: workers.dev on, ready, the workflow on, the flag 1.
// The flag is two facts: the STAGING_DEPLOY_ENABLED variable and the deploy workflow's
// state. Locally both are read live. In CI the workflow's GITHUB_TOKEN cannot read
// variables (GitHub grants no Environments or Variables scope to it), so the variable is
// the value the job started with and the live re-read is the workflow's state, which the
// kill disables; the job has `actions: read` for that read alone.
// This module imports no other staging command module; staging.mjs resolves the
// configuration and passes plain values in.
import { StagingError, failureRecord } from "./staging-common.mjs";
import { secretNames, toolJson, toolOk } from "./staging-tools.mjs";
import { probeHealth, serving, unattendedSmoke, waitReady } from "./staging-smoke.mjs";

export const deployWorkflow = "deploy-staging.yml";
export const deployOrder = Object.freeze(["broker", "orchestrator", "connector", "api"]);
export const githubVariables = Object.freeze([
  "CLOUDFLARE_ACCOUNT_ID",
  "STAGING_DEPLOY_ENABLED",
  "STAGING_LOGIN_CONFIGURATION_DIGEST",
  "STAGING_SCHEMA_HEAD",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const commit = /^[0-9a-f]{40}$/;
const runStates = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

// ---------------------------------------------------------------------------
// GitHub: `github` is {repository, environment} from staging.json (environment null for
// the OQ-2 B shape). Every reply is parsed to closed values; gh's text is never relayed.
const variablePath = (github, name) =>
  github.environment
    ? `repos/${github.repository}/environments/${github.environment}/variables/${name}`
    : `repos/${github.repository}/actions/variables/${name}`;
const scopeArgs = (github) => (github.environment ? ["--env", github.environment] : []);

export async function readVariable(ctx, github, name) {
  if (!githubVariables.includes(name)) throw new StagingError("STAGING_VARIABLE_INVALID");
  const reply = await toolJson(ctx.tools, "gh", ["api", variablePath(github, name)]);
  if (
    reply?.name !== name ||
    typeof reply.value !== "string" ||
    !/^[A-Za-z0-9]{0,128}$/.test(reply.value)
  )
    throw new StagingError("STAGING_GH_OUTPUT_INVALID");
  return reply.value;
}
export async function setVariable(ctx, github, name, value) {
  if (!githubVariables.includes(name) || !/^[A-Za-z0-9]{1,128}$/.test(value))
    throw new StagingError("STAGING_VARIABLE_INVALID");
  await toolOk(ctx.tools, "gh", [
    "variable",
    "set",
    name,
    "--repo",
    github.repository,
    ...scopeArgs(github),
    "--body",
    value,
  ]);
}
export async function workflowState(ctx, github) {
  const reply = await toolJson(ctx.tools, "gh", [
    "api",
    `repos/${github.repository}/actions/workflows/${deployWorkflow}`,
  ]);
  if (typeof reply?.state !== "string" || !/^[a-z_]{1,32}$/.test(reply.state))
    throw new StagingError("STAGING_GH_OUTPUT_INVALID");
  return reply.state;
}
export async function mainTip(ctx, github) {
  const reply = await toolJson(ctx.tools, "gh", [
    "api",
    `repos/${github.repository}/git/ref/heads/main`,
  ]);
  const sha = reply?.object?.sha;
  if (typeof sha !== "string" || !commit.test(sha))
    throw new StagingError("STAGING_GH_OUTPUT_INVALID");
  return sha;
}
// The flag: the variable (live locally; the job's start value in CI) and the workflow.
export async function readDeployFlag(ctx, github) {
  const value = ctx.environment.ci
    ? ctx.environment.deployEnabled
    : await readVariable(ctx, github, "STAGING_DEPLOY_ENABLED");
  const workflow = await workflowState(ctx, github);
  return { value, workflow, enabled: value === "1" && workflow === "active" };
}

// ---------------------------------------------------------------------------
// Cloudflare: deployed versions and the workers.dev switch, through the direct API.
const notFound = (error) =>
  error?.code === "STAGING_CLOUDFLARE_REQUEST_FAILED" && error.details?.status === 404;
export async function deployedVersion(api, script) {
  let reply;
  try {
    reply = await api.get(["workers", "scripts", script, "deployments"]);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
  const deployments = reply?.deployments;
  if (!Array.isArray(deployments)) throw new StagingError("STAGING_CLOUDFLARE_RESPONSE_INVALID");
  if (deployments.length === 0) return null;
  const latest = [...deployments].sort((a, b) =>
    String(b?.created_on ?? "").localeCompare(String(a?.created_on ?? "")),
  )[0];
  const versions = Array.isArray(latest?.versions) ? latest.versions : [];
  const id = (versions.find((v) => v?.percentage === 100) ?? versions[0])?.version_id;
  if (typeof id !== "string" || !uuid.test(id))
    throw new StagingError("STAGING_CLOUDFLARE_RESPONSE_INVALID");
  return id;
}
export async function setWorkersDev(api, script, enabled) {
  const reply = await api.request("POST", ["workers", "scripts", script, "subdomain"], {
    body: { enabled, previews_enabled: false },
  });
  if (reply?.result?.enabled !== enabled)
    throw new StagingError("STAGING_CLOUDFLARE_RESPONSE_INVALID");
}
export async function workersDevState(api, script) {
  try {
    const reply = await api.get(["workers", "scripts", script, "subdomain"]);
    return reply?.enabled === true ? "enabled" : reply?.enabled === false ? "disabled" : "unknown";
  } catch (error) {
    if (notFound(error)) return "absent";
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The account census (M-C2; at every deploy): every script with its workers.dev and
// preview state, every service binding naming the staging broker (scripts and Pages),
// dispatch namespaces and members.
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
export async function collectCensus(api, staging) {
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
  return { ...snapshot, findings: censusFindings(snapshot, staging) };
}

// ---------------------------------------------------------------------------
// One `wrangler deploy`. The version id comes from wrangler's structured output file
// (WRANGLER_OUTPUT_FILE_PATH, set by the tool runner), never from its text. A failed
// child is reconciled against the deployed version before anything else happens: the
// same version means not deployed; anything else is an unknown outcome, never success.
export function deployOutputVersion(entries, workerName) {
  if (!Array.isArray(entries)) return null;
  const entry = entries.find(
    (e) => e?.type === "deploy" && e?.worker_name === workerName && uuid.test(e?.version_id ?? ""),
  );
  return entry ? entry.version_id : null;
}
async function deployWorker(ctx, api, { config, name, sha, secretsFile, previous }) {
  const args = ["deploy", "--config", config, "--env", "staging", "--message", sha];
  if (secretsFile) args.push("--secrets-file", secretsFile);
  const started = ctx.now();
  const result = await ctx.tools.wrangler(args, { outputFile: true });
  const durationMs = ctx.now() - started;
  if (result?.status === 0) {
    const versionId = deployOutputVersion(result.output, name);
    return versionId
      ? { outcome: "deployed", versionId, durationMs }
      : { outcome: "unknown", versionId: null, durationMs };
  }
  let current;
  try {
    current = await deployedVersion(api, name);
  } catch {
    return { outcome: "unknown", versionId: null, durationMs };
  }
  return current === previous
    ? { outcome: "not_deployed", versionId: null, durationMs }
    : { outcome: "unknown", versionId: null, durationMs };
}

// The deploy. `plan` holds resolved values only:
//   mode            "ci" | "local" | "first"
//   staging, configs (worker key -> wrangler config path), names (key -> script name)
//   github          {repository, environment}
//   brokerSecrets   the broker's exact secret names (gate 6)
//   schemaHead      the committed chain's head (gate 3)
//   loginDigest     () -> the committed login configuration's digest (gate 4)
//   preconditions   () -> {sourceCommit} (local: clean tree, HEAD = origin/main, green
//                   foundation on that sha)
//   firstFiles      () -> {broker, api} absolute paths of the first-deploy secret files,
//                   checked (exact key sets, keyring bound to the digest) before use
//   afterFirst      (versions) -> unlinks the first-deploy files and records the rotation
//   checkpoint      (report) -> writes the report as it stands (before and after every
//                   upload), so a cancelled or timed-out run still leaves the record
//   csp             the committed CSP of the SPA (smoke)
// A thrown failure ends the run as "failed" with its fixed code; the report keeps
// everything recorded before it (gates, version ids).
export async function runDeploy(ctx, plan) {
  const report = {
    mode: plan.mode,
    sha: null,
    gates: {},
    versions: {},
    health: null,
    smoke: null,
    censusBefore: null,
    census: null,
    outcome: "running",
    code: null,
  };
  // `uploads` counts the `wrangler deploy` calls started; `api` is the Cloudflare client.
  const run = { api: null, uploads: 0 };
  try {
    await deployBody(ctx, plan, report, run);
  } catch (error) {
    const { code, ...details } = failureRecord(error);
    Object.assign(report, { outcome: "failed", code, failure: details });
  }
  if (run.uploads > 0) await finalCensus(plan, report, run.api);
  return report;
}

// The census at every deploy (ADR-0019 item 2, OQ-3 C) runs on every path that started
// an upload: success, a failed or unknown upload, a kill, a health or smoke failure, or a
// thrown error. Its findings are recorded even when the run has already failed. They fail
// a run that would otherwise be "deployed", and never change a failure or an unknown
// outcome into anything else.
async function finalCensus(plan, report, api) {
  let failure = null;
  try {
    report.census = await collectCensus(api, plan.staging);
  } catch (error) {
    failure = failureRecord(error);
    report.census = { failed: true, code: failure.code };
  }
  if (report.outcome !== "deployed") return;
  if (failure) {
    const { code, ...details } = failure;
    Object.assign(report, { outcome: "failed", code, failure: details });
  } else if (report.census.findings.length)
    Object.assign(report, { outcome: "failed", code: "STAGING_CENSUS_FINDINGS" });
}

const flagGate = (key) => "flagBefore" + key[0].toUpperCase() + key.slice(1);

async function deployBody(ctx, plan, report, run) {
  const stop = (outcome, code = null, extra = {}) => {
    Object.assign(report, { outcome, code }, extra);
    return report;
  };
  const github = plan.github;
  const names = plan.names;
  // Gate 1: the sha is the main tip with a green foundation.
  if (plan.mode === "ci") {
    const sha = ctx.environment.headSha;
    if (typeof sha !== "string" || !commit.test(sha))
      return stop("failed", "STAGING_CI_SHA_INVALID");
    report.sha = sha;
    if ((await mainTip(ctx, github)) !== sha) {
      report.gates.main = "superseded";
      return stop("superseded");
    }
    report.gates.main = "ok";
    if (ctx.environment.accountId !== plan.staging.cloudflare.account_id)
      return stop("failed", "STAGING_ACCOUNT_MISMATCH");
  } else {
    report.sha = (await plan.preconditions()).sourceCommit;
    report.gates.main = "ok";
  }
  // Gate 2: the flag. A first deploy runs while CD is still off (flag 0) and the
  // workflow is enabled, and only when the api does not exist yet.
  const flag = await readDeployFlag(ctx, github);
  if (plan.mode === "first") {
    if (flag.workflow !== "active") {
      report.gates.flag = "killed";
      return stop("failed", "STAGING_KILLED");
    }
    if (flag.value !== "0") {
      report.gates.flag = "on";
      return stop("failed", "STAGING_FIRST_FLAG_ON");
    }
    report.gates.flag = "first";
  } else if (!flag.enabled) {
    report.gates.flag = "off";
    return stop("disabled");
  } else report.gates.flag = "on";
  // Gate 5: build, edge:check and edge:dry-run (in CI, the step before this one).
  if (plan.mode === "ci") report.gates.dryRun = "previous_step";
  else {
    await ctx.gate5();
    report.gates.dryRun = "ok";
  }
  // Gate 3: the schema head.
  const schemaHead = ctx.environment.ci
    ? ctx.environment.schemaHead
    : await readVariable(ctx, github, "STAGING_SCHEMA_HEAD");
  if (schemaHead !== plan.schemaHead) {
    report.gates.schema = "mismatch";
    return stop("failed", "STAGING_SCHEMA_HEAD_MISMATCH", {
      next: "run_staging_migrate_then_gh_run_rerun",
    });
  }
  report.gates.schema = "ok";
  // Gate 4: the login configuration digest.
  const digest = await plan.loginDigest();
  let firstFiles = null;
  if (plan.mode === "first") {
    firstFiles = await plan.firstFiles(digest);
    report.gates.configuration = "keyring_bound";
  } else {
    const expected = ctx.environment.ci
      ? ctx.environment.loginDigest
      : await readVariable(ctx, github, "STAGING_LOGIN_CONFIGURATION_DIGEST");
    if (expected !== digest) {
      report.gates.configuration = "mismatch";
      return stop("failed", "STAGING_KEYRING_ROTATION_NEEDED");
    }
    report.gates.configuration = "ok";
  }
  // Gate 6: the broker's deployed secret names (a first deploy brings them in its file).
  const api = await ctx.cloudflareApi(plan.staging.cloudflare.account_id);
  run.api = api;
  const brokerNames = async () =>
    secretNames(
      await toolJson(ctx.tools, "wrangler", [
        "secret",
        "list",
        "--config",
        plan.configs.broker,
        "--env",
        "staging",
        "--format",
        "json",
      ]),
    );
  const sameNames = (names) => names.join() === [...plan.brokerSecrets].sort().join();
  if (plan.mode === "first") {
    if ((await deployedVersion(api, names.api)) !== null) {
      report.gates.brokerSecrets = "first";
      return stop("failed", "STAGING_FIRST_API_EXISTS");
    }
    report.gates.brokerSecrets = "first";
  } else {
    if (!sameNames(await brokerNames())) {
      report.gates.brokerSecrets = "mismatch";
      return stop("failed", "STAGING_BROKER_SECRETS_MISMATCH");
    }
    report.gates.brokerSecrets = "ok";
  }
  // The census before any upload: an existing finding (another script binding the broker,
  // a workers.dev hostname other than the api's) stops the run before anything changes.
  report.censusBefore = await collectCensus(api, plan.staging);
  if (report.censusBefore.findings.length) {
    report.gates.census = "findings";
    return stop("failed", "STAGING_CENSUS_FINDINGS");
  }
  report.gates.census = "ok";
  // E10 for a first deploy, before any upload: harmless while the flag is 0, and a failure
  // here leaves nothing deployed, so `deploy --first` can simply run again.
  if (plan.mode === "first") {
    await setVariable(ctx, github, "STAGING_LOGIN_CONFIGURATION_DIGEST", digest);
    report.gates.digest = "published";
  }
  // The previous versions, then the deploys in order.
  const previous = {};
  for (const key of deployOrder) {
    previous[key] = await deployedVersion(api, names[key]);
    report.versions[key] = { previous: previous[key], current: null, outcome: "pending" };
  }
  // The flag: "on", "off" (killed) or "unreadable" (which stops the run too).
  const flagState = async () => {
    const flag = await readDeployFlag(ctx, github).catch(() => null);
    const go = plan.mode === "first" ? flag?.workflow === "active" : flag?.enabled === true;
    return go ? "on" : flag ? "off" : "unreadable";
  };
  const checkpoint = async () => plan.checkpoint?.(report);
  for (const key of deployOrder) {
    // The re-read just before every upload: a kill during gate 5 or an earlier upload
    // stops the run here, and the remaining Workers are not deployed.
    const before = await flagState();
    report.gates[flagGate(key)] = before;
    if (before !== "on") {
      for (const rest of deployOrder.slice(deployOrder.indexOf(key)))
        report.versions[rest].outcome = "not_deployed";
      return stop("failed", "STAGING_KILLED", { worker: key });
    }
    // A run cancelled or timed out from here on leaves a report naming this upload as
    // in flight: an unknown outcome to reconcile, never a success.
    report.versions[key].outcome = "in_flight";
    await checkpoint();
    run.uploads++;
    const result = await deployWorker(ctx, api, {
      config: plan.configs[key],
      name: names[key],
      sha: report.sha,
      secretsFile: firstFiles?.[key] ?? null,
      previous: previous[key],
    });
    Object.assign(report.versions[key], {
      current: result.versionId,
      outcome: result.outcome,
      durationMs: result.durationMs,
    });
    await checkpoint();
    if (key === "api") {
      // The post-deploy re-read: a kill during the api deploy wins.
      const after = await flagState();
      report.gates.flagAfterApi = after;
      if (after !== "on") {
        let workersDev = "disabled";
        try {
          await setWorkersDev(api, names.api, false);
        } catch {
          workersDev = "unknown";
        }
        return stop("failed", "STAGING_KILLED_DURING_DEPLOY", { workersDev });
      }
    }
    if (result.outcome !== "deployed")
      return stop(result.outcome === "unknown" ? "unknown" : "failed", "STAGING_DEPLOY_FAILED", {
        worker: key,
      });
    if (key === "broker" && plan.mode === "first" && !sameNames(await brokerNames()))
      return stop("failed", "STAGING_BROKER_SECRETS_MISMATCH");
  }
  if (plan.mode === "first") await plan.afterFirst(report.versions);
  // Health within 90 s. No rollback (E11 suspended): the run fails and keeps both ids.
  report.health = await waitReady(ctx, plan.staging.cloudflare.origin);
  if (!report.health.ready)
    return stop("failed", "STAGING_HEALTH_NOT_READY", {
      rollback: "suspended_e11",
      next: "roll_forward_from_main_or_kill",
    });
  // The unattended smoke; the census follows in runDeploy, on this path as on every other.
  report.smoke = await unattendedSmoke(ctx, { staging: plan.staging, csp: plan.csp });
  if (report.smoke.failures.length) return stop("failed", "STAGING_SMOKE_FAILED");
  return stop("deployed");
}

// The CI step without the token: card, gate 1 and gate 2. It never fails on a stop: a
// superseded sha, an off flag or an inactive card are a successful no-op.
export async function ciGates(ctx, { github, cardActive }) {
  const sha = ctx.environment.headSha;
  if (typeof sha !== "string" || !commit.test(sha))
    throw new StagingError("STAGING_CI_SHA_INVALID");
  if (!cardActive) return { proceed: false, reason: "card_inactive", sha };
  if ((await mainTip(ctx, github)) !== sha) return { proceed: false, reason: "superseded", sha };
  const flag = await readDeployFlag(ctx, github);
  if (!flag.enabled) return { proceed: false, reason: "flag_off", workflow: flag.workflow, sha };
  return { proceed: true, reason: null, sha };
}

// ---------------------------------------------------------------------------
// The kill switch. Every step runs even when an earlier one failed; the exit code is
// non-zero when any step failed or the hostname still serves at the last check.
async function step(steps, name, fn) {
  try {
    steps[name] = { ok: true, ...((await fn()) ?? {}) };
  } catch (error) {
    steps[name] = { ok: false, ...failureRecord(error) };
  }
  return steps[name].ok;
}
export const killChecks = Object.freeze([
  ["now", 10000],
  ["after2m", 110000],
  ["after10m", 480000],
]);
export async function runKill(ctx, { github, staging }) {
  const steps = {};
  const script = staging.cloudflare.workers.api;
  await step(steps, "flag", () => setVariable(ctx, github, "STAGING_DEPLOY_ENABLED", "0"));
  await step(steps, "workflow", async () => {
    await toolOk(ctx.tools, "gh", [
      "api",
      "-X",
      "PUT",
      `repos/${github.repository}/actions/workflows/${deployWorkflow}/disable`,
    ]);
  });
  await step(steps, "runs", async () => {
    const reply = await toolJson(ctx.tools, "gh", [
      "api",
      `repos/${github.repository}/actions/workflows/${deployWorkflow}/runs?per_page=50`,
    ]);
    const runs = Array.isArray(reply?.workflow_runs) ? reply.workflow_runs : null;
    if (!runs) throw new StagingError("STAGING_GH_OUTPUT_INVALID");
    let cancelled = 0;
    let failed = 0;
    for (const run of runs) {
      if (!runStates.has(run?.status) || !Number.isSafeInteger(run?.id)) continue;
      const result = await ctx.tools.gh([
        "api",
        "-X",
        "POST",
        `repos/${github.repository}/actions/runs/${run.id}/cancel`,
      ]);
      if (result?.status === 0) cancelled++;
      else failed++;
    }
    if (failed) throw new StagingError("STAGING_RUN_CANCEL_FAILED", { cancelled, failed });
    return { cancelled };
  });
  let api = null;
  await step(steps, "workersDev", async () => {
    if (staging.cloudflare.account_id === null) throw new StagingError("STAGING_IDENTIFIERS_UNSET");
    api = await ctx.cloudflareApi(staging.cloudflare.account_id);
    if ((await workersDevState(api, script)) === "absent") return { script: "absent" };
    await setWorkersDev(api, script, false);
    return { script: "disabled" };
  });
  const checks = [];
  const origin = staging.cloudflare.origin;
  if (typeof origin !== "string") checks.push({ at: "now", state: "origin_unset" });
  else
    for (const [at, waitMs] of killChecks) {
      await ctx.sleep(waitMs);
      const state = await probeHealth(ctx, origin);
      const check = { at, serving: serving(state), redisabled: false };
      if (check.serving && api) {
        try {
          await setWorkersDev(api, script, false);
          check.redisabled = true;
        } catch {
          check.redisabled = false;
        }
      }
      checks.push(check);
    }
  const stillServing = checks.length > 0 && checks.at(-1).serving === true;
  const ok = Object.values(steps).every((s) => s.ok) && !stillServing;
  return {
    steps,
    checks,
    fallback: ok ? null : "dashboard_workers_dev_disable_and_github_workflow_disable",
    exitCode: ok ? 0 : 1,
  };
}

// Undo (needs the active card, checked by the caller): workers.dev on, ready within 90 s
// (otherwise off again), then the workflow and the flag.
export async function runUnkill(ctx, { github, staging }) {
  const script = staging.cloudflare.workers.api;
  if (staging.cloudflare.account_id === null || typeof staging.cloudflare.origin !== "string")
    throw new StagingError("STAGING_IDENTIFIERS_UNSET");
  const api = await ctx.cloudflareApi(staging.cloudflare.account_id);
  await setWorkersDev(api, script, true);
  const health = await waitReady(ctx, staging.cloudflare.origin);
  if (!health.ready) {
    await setWorkersDev(api, script, false).catch(() => {});
    throw new StagingError("STAGING_UNKILL_NOT_READY", { polls: health.polls });
  }
  await toolOk(ctx.tools, "gh", [
    "api",
    "-X",
    "PUT",
    `repos/${github.repository}/actions/workflows/${deployWorkflow}/enable`,
  ]);
  await setVariable(ctx, github, "STAGING_DEPLOY_ENABLED", "1");
  return {
    workersDev: "enabled",
    health: { ready: true, polls: health.polls },
    workflow: "active",
    flag: "1",
  };
}
