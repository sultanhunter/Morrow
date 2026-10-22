// The self-hosted runner that runs ci.yml on the owner's Mac (ADR-0014, amendment of
// 2026-10-22; docs/development/ci.md, "Self-hosted runner on the owner's Mac"). The owner
// runs it, or an agent with the owner's per-action go-ahead in chat.
//   up [--instance=2]      refuse unless Docker Desktop's File sharing is narrowed and
//                          workflows from fork pull requests stay off; pull the pinned
//                          images; register the runner unless its registration is still
//                          valid (one registration token, kept in memory and written only
//                          to the stdin of a one-off `docker compose run`); start the stack;
//                          wait until GitHub lists the runner online with exactly the
//                          expected labels; then set the repository variable MORROW_CI_RUNS_ON
//   status [--instance=2]  the runners' GitHub status, the stack's containers, the variable,
//                          Docker Desktop's File sharing
//   pause                  delete MORROW_CI_RUNS_ON, so ci.yml goes back to GitHub-hosted
//                          runners, then stop both stacks: the runners go offline but keep
//                          their registration and volumes
//   down [--instance=2]    delete MORROW_CI_RUNS_ON (kept while the other instance is
//                          online), stop the stack, delete the runner from GitHub (which
//                          revokes its key), then remove the stack's containers, network
//                          and volumes
// `pause` and `down` change the variable before they check Docker: it needs only gh, so a
// broken or quit Docker Desktop never keeps ci.yml waiting for an offline runner.
// Every argument is fixed: no caller-supplied path, name, label, repository or token.
// Children run without a shell and with a reduced environment; their output is parsed
// with closed parsers and never relayed, except the last lines of a failed registration
// with the token removed. The output is statuses only.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./artifacts.mjs";

export class CiRunnerError extends Error {
  constructor(code) {
    super(code);
    this.name = "CiRunnerError";
    this.code = code;
  }
}

export const ciRunner = Object.freeze({
  repository: "sultanhunter/Morrow",
  variable: "MORROW_CI_RUNS_ON",
  // The value of MORROW_CI_RUNS_ON: ci.yml's runs-on reads it with fromJSON. A runner
  // registered with `--labels morrow-mac` carries self-hosted, Linux and ARM64 by default.
  labels: Object.freeze(["self-hosted", "linux", "arm64", "morrow-mac"]),
  composeFile: "infra/ci-runner/compose.yaml",
  instances: Object.freeze({
    1: Object.freeze({ project: "morrow-ci-runner", name: "morrow-mac-1" }),
    2: Object.freeze({ project: "morrow-ci-runner-2", name: "morrow-mac-2" }),
  }),
  docker: Object.freeze({ osType: "linux", architecture: "aarch64", system: "Docker Desktop" }),
});
export const variableValue = JSON.stringify(ciRunner.labels);
const githubUrl = "https://github.com/" + ciRunner.repository;
const runnersPath = `repos/${ciRunner.repository}/actions/runners`;
const variablePath = `repos/${ciRunner.repository}/actions/variables/${ciRunner.variable}`;
const forkPath = `repos/${ciRunner.repository}/actions/permissions/fork-pr-workflows-private-repos`;
const registrationFiles = Object.freeze([".runner", ".credentials", ".credentials_rsaparams"]);
const registrationCheck =
  registrationFiles
    .slice(1)
    .map((file) => "test -s /morrow/registration/" + file)
    .join(" && ") + " && cat /morrow/registration/.runner";
const usage =
  "CI_RUNNER_USAGE: up | status | pause | down, with --instance=2 for the second runner";

export function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 2) throw new CiRunnerError(usage);
  const [command, option] = argv;
  if (!["up", "status", "pause", "down"].includes(command)) throw new CiRunnerError(usage);
  let instance = 1;
  if (option !== undefined) {
    // pause is global: it deletes the one repository variable.
    if (command === "pause" || !/^--instance=[12]$/.test(option)) throw new CiRunnerError(usage);
    instance = Number(option.slice("--instance=".length));
  }
  return Object.freeze({ command, instance });
}

// GET repos/<repo>/actions/runners -> the runners whose names start with morrow-mac-.
export function parseRunners(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CiRunnerError("CI_RUNNER_GH_OUTPUT_INVALID");
  }
  if (!Array.isArray(value?.runners)) throw new CiRunnerError("CI_RUNNER_GH_OUTPUT_INVALID");
  const rows = [];
  for (const runner of value.runners) {
    if (typeof runner?.name !== "string" || !runner.name.startsWith("morrow-mac-")) continue;
    if (
      !/^morrow-mac-[0-9]{1,2}$/.test(runner.name) ||
      !Number.isSafeInteger(runner.id) ||
      !["online", "offline"].includes(runner.status) ||
      typeof runner.busy !== "boolean" ||
      !Array.isArray(runner.labels) ||
      !runner.labels.every((label) => typeof label?.name === "string")
    )
      throw new CiRunnerError("CI_RUNNER_GH_OUTPUT_INVALID");
    rows.push(
      Object.freeze({
        id: runner.id,
        name: runner.name,
        status: runner.status,
        busy: runner.busy,
        labels: Object.freeze(runner.labels.map((label) => label.name.toLowerCase()).sort()),
      }),
    );
  }
  return Object.freeze(rows.sort((a, b) => a.name.localeCompare(b.name)));
}

export const labelsMatch = (runner) =>
  JSON.stringify(runner.labels) === JSON.stringify([...ciRunner.labels].sort());

// The runner's own .runner file (no secret in it): the registered name, repository and id.
export function parseRegistration(text) {
  let value;
  try {
    value = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (
    typeof value?.agentName !== "string" ||
    !Number.isSafeInteger(value.agentId) ||
    typeof value.gitHubUrl !== "string"
  )
    return null;
  return Object.freeze({
    id: value.agentId,
    name: value.agentName,
    repository: value.gitHubUrl.toLowerCase() === githubUrl.toLowerCase(),
  });
}

// `docker compose ps --all --format json`: one object per line (or one array).
export function parseContainers(text) {
  const trimmed = String(text).trim();
  if (trimmed === "") return Object.freeze([]);
  let rows;
  try {
    rows = trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : trimmed.split("\n").map((line) => JSON.parse(line));
  } catch {
    throw new CiRunnerError("CI_RUNNER_DOCKER_OUTPUT_INVALID");
  }
  if (!Array.isArray(rows)) throw new CiRunnerError("CI_RUNNER_DOCKER_OUTPUT_INVALID");
  return Object.freeze(
    rows.map((row) => {
      if (
        !["dind", "runner", "register"].includes(row?.Service) ||
        typeof row.ID !== "string" ||
        !/^[a-f0-9]{12,64}$/.test(row.ID) ||
        typeof row.State !== "string" ||
        !/^[a-z]{1,16}$/.test(row.State)
      )
        throw new CiRunnerError("CI_RUNNER_DOCKER_OUTPUT_INVALID");
      const health = typeof row.Health === "string" && /^[a-z]{1,16}$/.test(row.Health);
      return Object.freeze({
        service: row.Service,
        id: row.ID,
        state: row.State,
        health: health ? row.Health : "",
      });
    }),
  );
}

// The runner shares dind's network namespace. If Docker's restart policy restarted dind
// alone, the runner keeps the old namespace: no bridge, no job containers' addresses.
export function runnerNamespaceStale(inspectText) {
  let rows;
  try {
    rows = JSON.parse(inspectText);
  } catch {
    throw new CiRunnerError("CI_RUNNER_DOCKER_OUTPUT_INVALID");
  }
  if (!Array.isArray(rows) || rows.length !== 2)
    throw new CiRunnerError("CI_RUNNER_DOCKER_OUTPUT_INVALID");
  const [dind, runner] = rows;
  const started = (row) => Date.parse(row?.State?.StartedAt ?? "");
  if (!Number.isFinite(started(dind)) || !Number.isFinite(started(runner)))
    throw new CiRunnerError("CI_RUNNER_DOCKER_OUTPUT_INVALID");
  return (
    runner?.HostConfig?.NetworkMode !== "container:" + dind?.Id || started(dind) > started(runner)
  );
}

// Printable ASCII only, the token removed, at most the last six lines of 200 characters.
export function redactedTail(text, token) {
  let value = String(text ?? "");
  if (typeof token === "string" && token.length) value = value.split(token).join("[redacted]");
  return value
    .split("\n")
    .map((line) => line.replace(/[^\x20-\x7e]/g, "").trim())
    .filter(Boolean)
    .slice(-6)
    .map((line) => line.slice(0, 200));
}

// Docker Desktop shares these host folders with its Linux VM, readable and writable with
// the owner's permissions, and any CI job reaches that VM through the privileged dind
// (ADR-0014, amendment of 2026-10-22, risk (b)). Without the setting, Docker Desktop shares
// its defaults: /Users, /Volumes, /private, /tmp and /var/folders. `up` accepts only a list
// in which no folder is or holds the home folder or /Volumes; none is, holds or lies inside
// the checkout or a temporary folder (/tmp, where agents keep their worktrees, and
// /var/folders); and none lies inside ~/Library or a dot entry of the home folder
// (~/.config, ~/.ssh, the shell files). Returns null or the refusal code.
export const dockerSettingsFile = "Library/Group Containers/group.com.docker/settings-store.json";
export function hostShareProblem(text, { home, root }) {
  // APFS is case-insensitive; /tmp, /var and /etc link into /private; /System/Volumes/Data
  // is the data volume behind /.
  const canonical = (path) => {
    if (typeof path !== "string" || !path.startsWith("/")) return null;
    const value =
      posix
        .normalize(path)
        .toLowerCase()
        .replace(/\/+$/, "")
        .replace(/^\/system\/volumes\/data(?=\/|$)/, "") || "/";
    return /^\/(?:tmp|var|etc)(?:\/|$)/.test(value) ? "/private" + value : value;
  };
  const inside = (path, folder) =>
    folder === "/" || path === folder || path.startsWith(folder + "/");
  const homePath = canonical(home);
  const rootPath = canonical(root);
  if (text === null || homePath === null || homePath === "/" || rootPath === null)
    return "CI_RUNNER_HOST_SHARE_UNKNOWN";
  let settings;
  try {
    settings = JSON.parse(String(text));
  } catch {
    return "CI_RUNNER_HOST_SHARE_UNKNOWN";
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings))
    return "CI_RUNNER_HOST_SHARE_UNKNOWN";
  const list = settings.FilesharingDirectories ?? settings.filesharingDirectories;
  if (list === undefined) return "CI_RUNNER_HOST_SHARE_TOO_BROAD";
  if (!Array.isArray(list)) return "CI_RUNNER_HOST_SHARE_UNKNOWN";
  const held = [homePath, "/volumes"];
  const apart = [rootPath, "/private/tmp", "/private/var/folders"];
  for (const entry of list) {
    const path = canonical(entry);
    if (path === null) return "CI_RUNNER_HOST_SHARE_UNKNOWN";
    if (
      held.some((folder) => inside(folder, path)) ||
      apart.some((folder) => inside(folder, path) || inside(path, folder))
    )
      return "CI_RUNNER_HOST_SHARE_TOO_BROAD";
    const first = inside(path, homePath) ? path.slice(homePath.length + 1).split("/")[0] : "";
    if (first.startsWith(".") || first === "library") return "CI_RUNNER_HOST_SHARE_TOO_BROAD";
  }
  return null;
}

const outputLimit = 4 << 20;
// One child, no shell. stdin carries `input` when given and is closed otherwise; output is
// captured, never inherited.
export function runChild(command, args, { cwd, env, input, timeoutMs = 120000 } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    return Promise.reject(new CiRunnerError("CI_RUNNER_TOOL_ARGUMENTS"));
  return new Promise((resolve) => {
    let child;
    try {
      const stdin = input === undefined ? "ignore" : "pipe";
      child = spawn(command, args, { cwd, env, stdio: [stdin, "pipe", "pipe"], shell: false });
    } catch {
      resolve({ status: null, stdout: "", stderr: "" });
      return;
    }
    let stdout = "",
      stderr = "",
      overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > outputLimit) overflow = true;
      else stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length <= outputLimit) stderr += chunk;
    });
    child.on("error", () => {});
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ status: overflow ? null : code, stdout: overflow ? "" : stdout, stderr });
    });
  });
}

// gh keeps the owner's own login (keyring or config under the real HOME); GH_TOKEN,
// GH_HOST, GH_REPO and the like do not pass. docker gets PATH, HOME and LANG only, so its
// context is the owner's (Docker Desktop) and no COMPOSE_* or DOCKER_* variable can change
// the file, project, profiles or daemon.
export function childEnvironments(source = process.env) {
  const base = { PATH: source.PATH ?? "", HOME: source.HOME ?? "", LANG: "C" };
  return Object.freeze({
    gh: Object.freeze({
      ...base,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
      ...(source.GH_CONFIG_DIR ? { GH_CONFIG_DIR: source.GH_CONFIG_DIR } : {}),
    }),
    docker: Object.freeze(base),
  });
}
export function createTools({ root = repositoryRoot, source = process.env } = {}) {
  const env = childEnvironments(source);
  const home = source.HOME ?? "";
  return Object.freeze({
    root,
    home,
    // Docker Desktop's own settings file: no secret in it. null when it cannot be read.
    readDockerSettings: () => {
      if (!home.startsWith("/")) return null;
      try {
        return readFileSync(join(home, dockerSettingsFile), "utf8");
      } catch {
        return null;
      }
    },
    gh: (args, { timeoutMs } = {}) => runChild("gh", args, { cwd: root, env: env.gh, timeoutMs }),
    docker: (args, { input, timeoutMs } = {}) =>
      runChild("docker", args, { cwd: root, env: env.docker, input, timeoutMs }),
  });
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runCiRunner(
  { command, instance },
  { tools, write = (line) => console.log(line), sleep = sleepFor, pollMs = 5000, waitMs = 180000 },
) {
  const target = ciRunner.instances[instance];
  if (!target) throw new CiRunnerError(usage);
  const other = ciRunner.instances[instance === 1 ? 2 : 1];
  const composePath = join(tools.root, ciRunner.composeFile);
  const composeFor =
    (project) =>
    (...rest) => ["compose", "--file", composePath, "--project-name", project, ...rest];
  const compose = composeFor(target.project);

  const gh = async (args, code, options) => {
    const result = await tools.gh(args, options);
    if (result.status !== 0) throw new CiRunnerError(code);
    return result.stdout;
  };
  const listRunners = async () =>
    parseRunners(await gh(["api", runnersPath + "?per_page=100"], "CI_RUNNER_GH_RUNNERS_FAILED"));
  const readVariable = async () => {
    const result = await tools.gh(["api", variablePath]);
    if (result.status !== 0) {
      if (/HTTP 404/.test(result.stderr)) return null;
      throw new CiRunnerError("CI_RUNNER_GH_VARIABLE_FAILED");
    }
    let value;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new CiRunnerError("CI_RUNNER_GH_OUTPUT_INVALID");
    }
    if (value?.name !== ciRunner.variable || typeof value.value !== "string")
      throw new CiRunnerError("CI_RUNNER_GH_OUTPUT_INVALID");
    return value.value;
  };
  const deleteVariable = async () => {
    if ((await readVariable()) === null) return false;
    await gh(
      ["variable", "delete", ciRunner.variable, "--repo", ciRunner.repository],
      "CI_RUNNER_GH_VARIABLE_DELETE_FAILED",
    );
    return true;
  };
  const describeVariable = (value) =>
    value === null
      ? "unset: ci.yml runs on GitHub-hosted runners"
      : value === variableValue
        ? "set: ci.yml runs on the Mac runners"
        : "set to an unexpected value: check ci.yml's runs-on before relying on it";
  const describeRunner = (runner) =>
    `runner ${runner.name}: ${runner.status}, ${runner.busy ? "busy" : "idle"}, labels ${
      labelsMatch(runner) ? "as expected" : "UNEXPECTED (" + runner.labels.join(",") + ")"
    }`;

  const dockerOk = async (args, code, options) => {
    const result = await tools.docker(args, options);
    if (result.status !== 0) throw new CiRunnerError(code);
    return result.stdout;
  };
  const checkDocker = async () => {
    if (existsSync(join(tools.root, "infra/ci-runner/.env")))
      throw new CiRunnerError("CI_RUNNER_ENV_FILE_PRESENT");
    const info = (
      await dockerOk(
        ["info", "--format", "{{.OSType}}|{{.Architecture}}|{{.OperatingSystem}}"],
        "CI_RUNNER_DOCKER_UNAVAILABLE",
      )
    ).trim();
    const { osType, architecture, system } = ciRunner.docker;
    if (info !== [osType, architecture, system].join("|"))
      throw new CiRunnerError("CI_RUNNER_DOCKER_NOT_DOCKER_DESKTOP_ARM64");
    await dockerOk(["compose", "version", "--short"], "CI_RUNNER_DOCKER_COMPOSE_UNAVAILABLE");
  };
  // `pause` and `down` call this after the variable is settled, so a Docker failure says
  // what is left to do instead of leaving ci.yml on a runner that may be offline.
  const checkDockerAfterVariable = async () => {
    try {
      await checkDocker();
    } catch (error) {
      write(
        `docker: ${error?.code ?? "CI_RUNNER_DOCKER_UNAVAILABLE"}; the variable is settled, the stack is unchanged: run \`${command}\` again once Docker Desktop runs`,
      );
      throw error;
    }
  };
  const shareProblem = () =>
    hostShareProblem(tools.readDockerSettings(), { home: tools.home, root: tools.root });
  const sharesNarrowed = "narrowed (no home, /Volumes, temporary or checkout folder)";
  // While the runner is online, any workflow run of this repository can reach it (risk (a)).
  const checkForkWorkflows = async () => {
    const text = await gh(["api", forkPath], "CI_RUNNER_GH_FORK_SETTING_FAILED");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new CiRunnerError("CI_RUNNER_GH_OUTPUT_INVALID");
    }
    if (value?.run_workflows_from_fork_pull_requests !== false)
      throw new CiRunnerError("CI_RUNNER_FORK_PR_WORKFLOWS_ON");
  };
  const checkGh = () => gh(["auth", "status", "--hostname", "github.com"], "CI_RUNNER_GH_AUTH");
  const containers = async (project = target.project) =>
    parseContainers(
      await dockerOk(
        composeFor(project)("ps", "--all", "--format", "json"),
        "CI_RUNNER_DOCKER_PS_FAILED",
      ),
    );
  const describeContainers = (rows) =>
    `stack ${target.project}: ` +
    (rows.length === 0
      ? "no containers"
      : rows
          .map((row) => `${row.service} ${row.state}${row.health ? " " + row.health : ""}`)
          .join(", "));
  const namespaceStale = async (rows) => {
    const dind = rows.find((row) => row.service === "dind");
    const runner = rows.find((row) => row.service === "runner");
    if (!dind || !runner || dind.state !== "running" || runner.state !== "running") return false;
    return runnerNamespaceStale(
      await dockerOk(["inspect", dind.id, runner.id], "CI_RUNNER_DOCKER_INSPECT_FAILED"),
    );
  };

  // GitHub cannot keep a repository runner to one workflow, so deleting the variable is not
  // enough: an online runner still takes any job that names its labels (risk (a)).
  if (command === "pause") {
    await checkGh();
    const deleted = await deleteVariable();
    write(
      `${ciRunner.variable}: ${deleted ? "deleted" : "already unset"}; ci.yml runs on GitHub-hosted runners`,
    );
    for (const runner of await listRunners())
      if (runner.busy) write(`runner ${runner.name}: was busy; its job ends unfinished`);
    await checkDockerAfterVariable();
    for (const instance of Object.values(ciRunner.instances)) {
      if ((await containers(instance.project)).length === 0) {
        write(`stack ${instance.project}: no containers`);
        continue;
      }
      await dockerOk(
        composeFor(instance.project)("stop", "--timeout", "30"),
        "CI_RUNNER_DOCKER_STOP_FAILED",
        { timeoutMs: 180000 },
      );
      write(
        `stack ${instance.project}: stopped; ${instance.name} is offline and keeps its registration and volumes (GitHub deletes a runner offline for 14 days); \`up\` starts it again, \`down\` revokes it`,
      );
    }
    return;
  }

  if (command === "status") {
    await checkGh();
    write(`${ciRunner.variable}: ${describeVariable(await readVariable())}`);
    const runners = await listRunners();
    if (runners.length === 0) write("runners: none registered");
    for (const runner of runners) write(describeRunner(runner));
    write(`docker file sharing: ${shareProblem() ?? sharesNarrowed}`);
    try {
      await checkDocker();
    } catch (error) {
      write("docker: " + (error?.code ?? "CI_RUNNER_DOCKER_UNAVAILABLE"));
      return;
    }
    const rows = await containers();
    write(describeContainers(rows));
    if (await namespaceStale(rows))
      write("runner network: stale (dind restarted after the runner); run `up` again");
    return;
  }

  if (command === "up") {
    await checkGh();
    await checkDocker();
    write("docker: Docker Desktop, linux/aarch64");
    const problem = shareProblem();
    if (problem) throw new CiRunnerError(problem);
    write(`docker file sharing: ${sharesNarrowed}`);
    await checkForkWorkflows();
    write("fork pull requests: run no workflows in this repository");
    await dockerOk(
      compose("--profile", "register", "pull", "--quiet"),
      "CI_RUNNER_DOCKER_PULL_FAILED",
      { timeoutMs: 1800000 },
    );
    write("images: the pinned digests are present");

    const localRegistration = async () => {
      const result = await tools.docker(
        compose(
          "run",
          "--rm",
          "--no-deps",
          "-T",
          "--entrypoint",
          "/bin/sh",
          "register",
          "-c",
          registrationCheck,
        ),
        { timeoutMs: 120000 },
      );
      return result.status === 0 ? parseRegistration(result.stdout) : null;
    };
    const remote = (await listRunners()).find((runner) => runner.name === target.name);
    const local = await localRegistration();
    const valid =
      local !== null &&
      local.repository &&
      local.name === target.name &&
      remote !== undefined &&
      remote.id === local.id;
    let registeredNow = false;
    if (valid) write(`registration: ${target.name} is registered (id ${local.id})`);
    else {
      // The token lives only in this variable and in the register run's stdin.
      const reply = await tools.gh([
        "api",
        "-X",
        "POST",
        runnersPath + "/registration-token",
        "--jq",
        ".token",
      ]);
      if (reply.status !== 0) throw new CiRunnerError("CI_RUNNER_GH_TOKEN_FAILED");
      let token = reply.stdout.trim();
      if (!/^[A-Za-z0-9_-]{16,256}$/.test(token))
        throw new CiRunnerError("CI_RUNNER_GH_OUTPUT_INVALID");
      try {
        const result = await tools.docker(
          compose(
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "--env",
            "MORROW_CI_RUNNER_NAME=" + target.name,
            "register",
          ),
          { input: token + "\n", timeoutMs: 300000 },
        );
        if (result.status !== 0 || !result.stdout.includes("MORROW_CI_RUNNER_REGISTERED")) {
          for (const line of redactedTail(result.stdout + "\n" + result.stderr, token))
            write("  register: " + line);
          throw new CiRunnerError("CI_RUNNER_REGISTER_FAILED");
        }
      } finally {
        token = null;
      }
      const fresh = await localRegistration();
      if (fresh === null || !fresh.repository || fresh.name !== target.name)
        throw new CiRunnerError("CI_RUNNER_REGISTRATION_UNREADABLE");
      registeredNow = true;
      write(`registration: registered ${target.name} (id ${fresh.id})`);
    }

    // A new registration reaches a running runner only through a new container.
    await dockerOk(
      compose(
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "180",
        ...(registeredNow ? ["--force-recreate"] : []),
        "dind",
        "runner",
      ),
      "CI_RUNNER_DOCKER_UP_FAILED",
      { timeoutMs: 600000 },
    );
    let rows = await containers();
    if (await namespaceStale(rows)) {
      await dockerOk(
        compose("up", "--detach", "--wait", "--force-recreate", "--no-deps", "runner"),
        "CI_RUNNER_DOCKER_UP_FAILED",
        { timeoutMs: 600000 },
      );
      rows = await containers();
      write("runner network: was stale, runner recreated");
    }
    write(describeContainers(rows));

    let online;
    for (let waited = 0; ; waited += pollMs) {
      online = (await listRunners()).find(
        (runner) => runner.name === target.name && runner.status === "online",
      );
      if (online) break;
      if (waited >= waitMs) throw new CiRunnerError("CI_RUNNER_NOT_ONLINE");
      await sleep(pollMs);
    }
    write(describeRunner(online));
    if (!labelsMatch(online)) throw new CiRunnerError("CI_RUNNER_LABELS_UNEXPECTED");
    if ((await readVariable()) !== variableValue)
      await gh(
        [
          "variable",
          "set",
          ciRunner.variable,
          "--repo",
          ciRunner.repository,
          "--body",
          variableValue,
        ],
        "CI_RUNNER_GH_VARIABLE_SET_FAILED",
      );
    write(`${ciRunner.variable}: ${describeVariable(variableValue)}`);
    return;
  }

  if (command === "down") {
    await checkGh();
    const before = await listRunners();
    const otherOnline = before.some(
      (runner) => runner.name === other.name && runner.status === "online",
    );
    if (otherOnline) write(`${ciRunner.variable}: kept, ${other.name} is still online`);
    else
      write(
        `${ciRunner.variable}: ${(await deleteVariable()) ? "deleted" : "already unset"}; ci.yml runs on GitHub-hosted runners`,
      );
    const busy = before.find((runner) => runner.name === target.name && runner.busy);
    if (busy) write(`runner ${target.name}: was busy; its job ends unfinished`);
    await checkDockerAfterVariable();
    await dockerOk(compose("stop", "--timeout", "30"), "CI_RUNNER_DOCKER_STOP_FAILED", {
      timeoutMs: 180000,
    });
    write(`stack ${target.project}: stopped`);
    const runner = (await listRunners()).find((row) => row.name === target.name);
    if (runner) {
      await gh(
        ["api", "-X", "DELETE", `${runnersPath}/${runner.id}`],
        "CI_RUNNER_GH_RUNNER_DELETE_FAILED",
      );
      write(`runner ${target.name}: deleted from GitHub (id ${runner.id})`);
    } else write(`runner ${target.name}: not registered on GitHub`);
    await dockerOk(
      compose("down", "--volumes", "--remove-orphans", "--timeout", "30"),
      "CI_RUNNER_DOCKER_DOWN_FAILED",
      { timeoutMs: 300000 },
    );
    write(`stack ${target.project}: containers, network and volumes removed`);
    return;
  }
  throw new CiRunnerError(usage);
}

async function main(argv) {
  await runCiRunner(parseArguments(argv), { tools: createTools() });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof CiRunnerError ? error.code : "CI_RUNNER_FAILED");
    process.exit(1);
  });
