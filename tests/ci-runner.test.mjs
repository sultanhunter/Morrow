import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  CiRunnerError,
  childEnvironments,
  ciRunner,
  createTools,
  parseArguments,
  parseContainers,
  parseRegistration,
  parseRunners,
  redactedTail,
  runChild,
  runCiRunner,
  runnerNamespaceStale,
  variableValue,
} from "../scripts/ci-runner.mjs";
import { repositoryRoot } from "../scripts/artifacts.mjs";

// scripts/ci-runner.mjs against a simulated GitHub and Docker Desktop: no gh or docker
// child runs here. The Mac runner stack itself is checked in tests/ci-workflow.test.mjs.

const token = "AAAAMORROWFAKEREGISTRATIONTOKEN1";
const composePath = join(repositoryRoot, ciRunner.composeFile);
const runnersPath = `repos/${ciRunner.repository}/actions/runners`;
const variablePath = `repos/${ciRunner.repository}/actions/variables/${ciRunner.variable}`;
const hostedLabels = ["self-hosted", "Linux", "ARM64", "morrow-mac"];

// A small world: the repository variable, GitHub's runner list, each project's
// registration volume and containers, and every call made.
function world({
  variable = null,
  runners = [],
  registrations = {},
  docker = "linux|aarch64|Docker Desktop",
  onlineAfter = 1,
  labels = hostedLabels,
  registerFails = false,
  staleOnce = false,
} = {}) {
  const state = {
    variable,
    runners: runners.map((runner) => ({ ...runner })),
    registrations: { ...registrations },
    containers: {},
    calls: [],
    polls: 0,
    nextId: 100,
    staleOnce,
  };
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const fail = (stderr = "") => ({ status: 1, stdout: "", stderr });
  const projectOf = (args) => args[args.indexOf("--project-name") + 1];
  const nameOf = (project) =>
    Object.values(ciRunner.instances).find((instance) => instance.project === project).name;
  const tools = {
    root: repositoryRoot,
    async gh(args) {
      state.calls.push({ tool: "gh", args: [...args] });
      const [first, ...rest] = args;
      if (first === "auth") return ok();
      if (first === "api" && args[1] === runnersPath + "?per_page=100") {
        state.polls++;
        for (const runner of state.runners)
          if (runner.started && state.polls > runner.started + onlineAfter - 1)
            runner.status = "online";
        return ok(
          JSON.stringify({
            total_count: state.runners.length,
            runners: [
              { id: 7, name: "someone-else", status: "online", busy: false, labels: [] },
              ...state.runners.map(({ started, ...runner }) => runner),
            ],
          }),
        );
      }
      if (first === "api" && args[1] === variablePath)
        return state.variable === null
          ? fail("gh: Not Found (HTTP 404)")
          : ok(JSON.stringify({ name: ciRunner.variable, value: state.variable }));
      if (first === "api" && args[2] === "POST") {
        assert.deepEqual(rest, [
          "-X",
          "POST",
          runnersPath + "/registration-token",
          "--jq",
          ".token",
        ]);
        return ok(token + "\n");
      }
      if (first === "api" && args[2] === "DELETE") {
        const id = Number(args[3].slice(runnersPath.length + 1));
        state.runners = state.runners.filter((runner) => runner.id !== id);
        return ok();
      }
      if (first === "variable" && args[1] === "set") {
        assert.deepEqual(args, [
          "variable",
          "set",
          ciRunner.variable,
          "--repo",
          ciRunner.repository,
          "--body",
          variableValue,
        ]);
        state.variable = args[6];
        return ok();
      }
      if (first === "variable" && args[1] === "delete") {
        assert.deepEqual(args, [
          "variable",
          "delete",
          ciRunner.variable,
          "--repo",
          ciRunner.repository,
        ]);
        state.variable = null;
        return ok();
      }
      throw Error("unexpected gh call " + JSON.stringify(args));
    },
    async docker(args, { input } = {}) {
      state.calls.push({ tool: "docker", args: [...args], input });
      if (args[0] === "info") return ok(docker + "\n");
      if (args[0] === "inspect") {
        const stale = state.staleOnce;
        state.staleOnce = false;
        return ok(
          JSON.stringify([
            { Id: "d".repeat(64), State: { StartedAt: "2026-10-22T10:00:00Z" } },
            {
              Id: "e".repeat(64),
              State: { StartedAt: stale ? "2026-10-22T09:00:00Z" : "2026-10-22T10:00:05Z" },
              HostConfig: { NetworkMode: "container:" + "d".repeat(64) },
            },
          ]),
        );
      }
      assert.equal(args[0], "compose");
      if (args[1] === "version") return ok("5.5.1\n");
      assert.deepEqual(args.slice(1, 4), ["--file", composePath, "--project-name"]);
      const project = projectOf(args);
      const sub = args.slice(5);
      const containers = state.containers[project] ?? [];
      if (sub.join(" ") === "--profile register pull --quiet") return ok();
      if (sub[0] === "run" && sub.includes("--entrypoint")) {
        const registration = state.registrations[project];
        return registration
          ? ok(
              "\uFEFF" +
                JSON.stringify({
                  agentId: registration.id,
                  agentName: registration.name,
                  poolId: 1,
                  gitHubUrl: "https://github.com/" + ciRunner.repository,
                  workFolder: "_work",
                }),
            )
          : fail();
      }
      if (
        sub.join(" ") ===
        `run --rm --no-deps -T --env MORROW_CI_RUNNER_NAME=${nameOf(project)} register`
      ) {
        if (registerFails)
          return { status: 1, stdout: "Http response code: NotFound\n" + token, stderr: "" };
        assert.equal(input, token + "\n");
        const name = nameOf(project);
        const id = state.nextId++;
        state.registrations[project] = { id, name };
        state.runners = state.runners.filter((runner) => runner.name !== name);
        state.runners.push({ id, name, status: "offline", busy: false, labels: [] });
        return ok("√ Runner successfully added\nMORROW_CI_RUNNER_REGISTERED\n");
      }
      if (sub[0] === "up") {
        state.containers[project] = [
          { ID: "d".repeat(64), Service: "dind", State: "running", Health: "healthy" },
          { ID: "e".repeat(64), Service: "runner", State: "running", Health: "" },
        ];
        const registration = state.registrations[project];
        for (const runner of state.runners)
          if (registration && runner.id === registration.id) {
            runner.started = state.polls;
            runner.labels = labels.map((name) => ({ name }));
          }
        return ok();
      }
      if (sub.join(" ") === "ps --all --format json")
        return ok(containers.map((row) => JSON.stringify(row)).join("\n"));
      if (sub[0] === "stop") {
        state.containers[project] = containers.map((row) => ({ ...row, State: "exited" }));
        for (const runner of state.runners)
          if (runner.id === state.registrations[project]?.id) runner.status = "offline";
        return ok();
      }
      if (sub[0] === "down") {
        delete state.containers[project];
        delete state.registrations[project];
        return ok();
      }
      throw Error("unexpected docker call " + JSON.stringify(args));
    },
  };
  return { state, tools };
}

async function run(argv, setup, options = {}) {
  const lines = [];
  const promise = runCiRunner(parseArguments(argv), {
    tools: setup.tools,
    write: (line) => lines.push(line),
    sleep: async () => {},
    pollMs: 1,
    waitMs: 5,
    ...options,
  });
  return { promise, lines };
}
const index = (state, predicate) => state.calls.findIndex(predicate);
const isVariableSet = (call) =>
  call.tool === "gh" && call.args[0] === "variable" && call.args[1] === "set";

test("arguments are a closed set: four commands, and --instance=2 except for pause", () => {
  assert.deepEqual(parseArguments(["up"]), { command: "up", instance: 1 });
  assert.deepEqual(parseArguments(["down", "--instance=2"]), { command: "down", instance: 2 });
  assert.deepEqual(parseArguments(["status", "--instance=1"]), { command: "status", instance: 1 });
  for (const argv of [
    [],
    ["start"],
    ["up", "--instance=3"],
    ["up", "--instance", "2"],
    ["pause", "--instance=2"],
    ["up", "--token=x"],
    ["status", "--instance=2", "x"],
  ])
    assert.throws(() => parseArguments(argv), CiRunnerError, JSON.stringify(argv));
});

test("up registers once, keeps the token off argv and output, and sets the variable only once online", async () => {
  const setup = world();
  const { promise, lines } = await run(["up"], setup);
  await promise;
  const { state } = setup;
  // The token went to exactly one child, on the register run's stdin, and nowhere else.
  for (const call of state.calls) assert.ok(!call.args.join(" ").includes(token), call.args);
  const carriers = state.calls.filter((call) => call.input !== undefined);
  assert.equal(carriers.length, 1);
  assert.equal(carriers[0].input, token + "\n");
  assert.deepEqual(carriers[0].args.slice(5), [
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "--env",
    "MORROW_CI_RUNNER_NAME=morrow-mac-1",
    "register",
  ]);
  assert.ok(!lines.join("\n").includes(token));
  // A fresh registration recreates the containers, then the variable follows an online read.
  const up = state.calls.find((call) => call.args[5] === "up");
  assert.ok(up.args.includes("--force-recreate"));
  const set = index(state, isVariableSet);
  assert.ok(set > index(state, (call) => call.args[5] === "up"));
  assert.equal(state.variable, variableValue);
  assert.deepEqual(lines, [
    "docker: Docker Desktop, linux/aarch64",
    "images: the pinned digests are present",
    "registration: registered morrow-mac-1 (id 100)",
    "stack morrow-ci-runner: dind running healthy, runner running",
    "runner morrow-mac-1: online, idle, labels as expected",
    "MORROW_CI_RUNS_ON: set: ci.yml runs on the Mac runners",
  ]);
  // Every compose call names the one compose file and this instance's project.
  for (const call of state.calls.filter((c) => c.args[0] === "compose" && c.args[1] !== "version"))
    assert.deepEqual(call.args.slice(1, 5), [
      "--file",
      composePath,
      "--project-name",
      "morrow-ci-runner",
    ]);
});

test("up with a valid registration requests no token, and a second up changes nothing", async () => {
  const setup = world({
    registrations: { "morrow-ci-runner-2": { id: 42, name: "morrow-mac-2" } },
    runners: [{ id: 42, name: "morrow-mac-2", status: "offline", busy: false, labels: [] }],
  });
  await (
    await run(["up", "--instance=2"], setup)
  ).promise;
  const posts = (state) => state.calls.filter((c) => c.args[2] === "POST").length;
  assert.equal(posts(setup.state), 0);
  assert.ok(!setup.state.calls.some((c) => c.args.includes("--force-recreate")));
  assert.ok(!setup.state.calls.some((c) => c.input !== undefined));
  assert.equal(setup.state.variable, variableValue);
  const before = setup.state.calls.filter(isVariableSet).length;
  await (
    await run(["up", "--instance=2"], setup)
  ).promise;
  assert.equal(posts(setup.state), 0);
  assert.equal(setup.state.calls.filter(isVariableSet).length, before);
});

test("up re-registers when GitHub no longer lists the local registration", async () => {
  const setup = world({ registrations: { "morrow-ci-runner": { id: 41, name: "morrow-mac-1" } } });
  await (
    await run(["up"], setup)
  ).promise;
  assert.equal(setup.state.calls.filter((c) => c.args[2] === "POST").length, 1);
  assert.equal(setup.state.registrations["morrow-ci-runner"].id, 100);
});

test("up never sets the variable when the runner stays offline or carries other labels", async () => {
  const offline = world({ onlineAfter: 100 });
  await assert.rejects((await run(["up"], offline)).promise, { code: "CI_RUNNER_NOT_ONLINE" });
  assert.equal(index(offline.state, isVariableSet), -1);
  assert.equal(offline.state.variable, null);
  const labels = world({ labels: ["self-hosted", "Linux", "X64", "morrow-mac"] });
  await assert.rejects((await run(["up"], labels)).promise, {
    code: "CI_RUNNER_LABELS_UNEXPECTED",
  });
  assert.equal(labels.state.variable, null);
});

test("a failed registration prints its last lines with the token removed and stops", async () => {
  const setup = world({ registerFails: true });
  const { promise, lines } = await run(["up"], setup);
  await assert.rejects(promise, { code: "CI_RUNNER_REGISTER_FAILED" });
  assert.ok(!lines.join("\n").includes(token));
  assert.deepEqual(lines.slice(-2), [
    "  register: Http response code: NotFound",
    "  register: [redacted]",
  ]);
  assert.equal(
    index(setup.state, (call) => call.args[5] === "up"),
    -1,
  );
  assert.equal(setup.state.variable, null);
});

test("up refuses any Docker other than Docker Desktop on arm64 before asking GitHub for a token", async () => {
  for (const docker of ["linux|x86_64|Docker Desktop", "linux|aarch64|Ubuntu 24.04", "windows||"]) {
    const setup = world({ docker });
    await assert.rejects((await run(["up"], setup)).promise, {
      code: "CI_RUNNER_DOCKER_NOT_DOCKER_DESKTOP_ARM64",
    });
    assert.ok(!setup.state.calls.some((call) => call.args[2] === "POST"));
  }
});

test("up recreates a runner left in a restarted dind's old network namespace", async () => {
  const setup = world({ staleOnce: true });
  const { promise, lines } = await run(["up"], setup);
  await promise;
  const ups = setup.state.calls.filter((call) => call.args[5] === "up");
  assert.equal(ups.length, 2);
  assert.deepEqual(ups[1].args.slice(6), [
    "--detach",
    "--wait",
    "--force-recreate",
    "--no-deps",
    "runner",
  ]);
  assert.ok(lines.includes("runner network: was stale, runner recreated"));
});

test("pause deletes the variable only when it is set and touches nothing else", async () => {
  const set = world({ variable: variableValue });
  const first = await run(["pause"], set);
  await first.promise;
  assert.equal(set.state.variable, null);
  assert.ok(first.lines[0].startsWith("MORROW_CI_RUNS_ON: deleted;"));
  assert.ok(!set.state.calls.some((call) => call.tool === "docker"));
  const unset = world();
  await (
    await run(["pause"], unset)
  ).promise;
  assert.ok(!unset.state.calls.some((call) => call.args[1] === "delete"));
});

test("down deletes the variable first, then stops, deregisters and removes the volumes", async () => {
  const setup = world({ variable: variableValue });
  await (
    await run(["up"], setup)
  ).promise;
  setup.state.calls.length = 0;
  const { promise, lines } = await run(["down"], setup);
  await promise;
  const { state } = setup;
  const at = (predicate) => index(state, predicate);
  const del = at((c) => c.args[0] === "variable" && c.args[1] === "delete");
  const stop = at((c) => c.args[5] === "stop");
  const deregister = at((c) => c.args[2] === "DELETE");
  const down = at((c) => c.args[5] === "down");
  assert.ok(0 <= del && del < stop && stop < deregister && deregister < down);
  assert.deepEqual(state.calls[deregister].args, ["api", "-X", "DELETE", `${runnersPath}/100`]);
  assert.deepEqual(state.calls[down].args.slice(5), [
    "down",
    "--volumes",
    "--remove-orphans",
    "--timeout",
    "30",
  ]);
  assert.equal(state.variable, null);
  assert.equal(state.runners.length, 0);
  assert.ok(!state.calls.some((c) => c.args[2] === "POST"));
  assert.deepEqual(lines.at(-1), "stack morrow-ci-runner: containers, network and volumes removed");
});

test("down of one instance keeps the variable while the other is online", async () => {
  const setup = world();
  await (
    await run(["up"], setup)
  ).promise;
  await (
    await run(["up", "--instance=2"], setup)
  ).promise;
  const { promise, lines } = await run(["down", "--instance=2"], setup);
  await promise;
  assert.equal(setup.state.variable, variableValue);
  assert.equal(lines[0], "MORROW_CI_RUNS_ON: kept, morrow-mac-1 is still online");
  assert.deepEqual(
    setup.state.runners.map((runner) => runner.name),
    ["morrow-mac-1"],
  );
});

test("status reads the variable, the runners and the stack, and changes nothing", async () => {
  const setup = world({ variable: variableValue });
  await (
    await run(["up"], setup)
  ).promise;
  setup.state.calls.length = 0;
  const { promise, lines } = await run(["status"], setup);
  await promise;
  assert.deepEqual(lines, [
    "MORROW_CI_RUNS_ON: set: ci.yml runs on the Mac runners",
    "runner morrow-mac-1: online, idle, labels as expected",
    "stack morrow-ci-runner: dind running healthy, runner running",
  ]);
  for (const call of setup.state.calls)
    assert.ok(
      (call.tool === "gh" && ["api", "auth"].includes(call.args[0]) && call.args[1] !== "-X") ||
        (call.tool === "docker" && !["up", "stop", "down", "run"].includes(call.args[5])),
      JSON.stringify(call.args),
    );
});

test("children get a reduced environment, and stdin only when a run is given input", async () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/Users/owner",
    GH_TOKEN: "x",
    GH_HOST: "example.invalid",
    GH_REPO: "other/repo",
    GH_CONFIG_DIR: "/Users/owner/.config/gh",
    COMPOSE_FILE: "/tmp/other.yaml",
    COMPOSE_PROJECT_NAME: "other",
    COMPOSE_PROFILES: "register",
    DOCKER_HOST: "tcp://example.invalid:2375",
    ACTIONS_RUNNER_INPUT_TOKEN: "y",
  };
  const env = childEnvironments(source);
  assert.deepEqual(env.docker, { PATH: "/usr/bin", HOME: "/Users/owner", LANG: "C" });
  assert.deepEqual(env.gh, {
    PATH: "/usr/bin",
    HOME: "/Users/owner",
    LANG: "C",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    GH_CONFIG_DIR: "/Users/owner/.config/gh",
  });
  // A real child (this Node) echoes its stdin: the input arrives once, and nothing without it.
  const echo = ["-e", "process.stdin.pipe(process.stdout)"];
  const childEnv = { PATH: process.env.PATH ?? "" };
  assert.deepEqual(await runChild(process.execPath, echo, { env: childEnv, input: "abc\n" }), {
    status: 0,
    stdout: "abc\n",
    stderr: "",
  });
  assert.equal((await runChild(process.execPath, echo, { env: childEnv })).stdout, "");
  await assert.rejects(runChild(process.execPath, [1]), { code: "CI_RUNNER_TOOL_ARGUMENTS" });
  assert.equal(typeof createTools({ source }).docker, "function");
});

test("the parsers accept only closed shapes", () => {
  assert.deepEqual(
    parseRunners(
      JSON.stringify({
        runners: [
          { id: 1, name: "other", status: "online", busy: true, labels: [] },
          {
            id: 9,
            name: "morrow-mac-1",
            status: "online",
            busy: false,
            labels: hostedLabels.map((name) => ({ name })),
          },
        ],
      }),
    ),
    [
      {
        id: 9,
        name: "morrow-mac-1",
        status: "online",
        busy: false,
        labels: ["arm64", "linux", "morrow-mac", "self-hosted"],
      },
    ],
  );
  for (const text of [
    "not json",
    "{}",
    JSON.stringify({ runners: [{ id: "9", name: "morrow-mac-1" }] }),
    JSON.stringify({
      runners: [{ id: 9, name: "morrow-mac-x", status: "online", busy: false, labels: [] }],
    }),
  ])
    assert.throws(() => parseRunners(text), { code: "CI_RUNNER_GH_OUTPUT_INVALID" });
  assert.equal(parseRegistration("nope"), null);
  assert.deepEqual(
    parseRegistration(
      '\uFEFF{"agentId":3,"agentName":"morrow-mac-1","gitHubUrl":"https://github.com/other/repo"}',
    ),
    { id: 3, name: "morrow-mac-1", repository: false },
  );
  assert.deepEqual(parseContainers(""), []);
  assert.throws(() => parseContainers('{"ID":"x;rm","Service":"dind","State":"running"}'), {
    code: "CI_RUNNER_DOCKER_OUTPUT_INVALID",
  });
  assert.throws(() => parseContainers('{"ID":"abcdefabcdef","Service":"web","State":"running"}'), {
    code: "CI_RUNNER_DOCKER_OUTPUT_INVALID",
  });
  const inspect = (dindStart, runnerStart, mode = "container:" + "d".repeat(64)) =>
    JSON.stringify([
      { Id: "d".repeat(64), State: { StartedAt: dindStart } },
      { Id: "e".repeat(64), State: { StartedAt: runnerStart }, HostConfig: { NetworkMode: mode } },
    ]);
  assert.equal(
    runnerNamespaceStale(inspect("2026-10-22T10:00:00Z", "2026-10-22T10:00:01Z")),
    false,
  );
  assert.equal(runnerNamespaceStale(inspect("2026-10-22T10:00:02Z", "2026-10-22T10:00:01Z")), true);
  assert.equal(
    runnerNamespaceStale(inspect("2026-10-22T10:00:00Z", "2026-10-22T10:00:01Z", "host")),
    true,
  );
  assert.deepEqual(redactedTail(`a\n${token}\n\u0007b\n`, token), ["a", "[redacted]", "b"]);
});
