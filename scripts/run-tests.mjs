// The repository test runner behind `npm test`, `npm run test:shard` and the heavy
// unit-stress leg (P03.T04e §2). It lists the top-level tests/*.test.mjs files, runs
// the parallel-safe ones with --test-concurrency=<k>, then the timing-sensitive files
// named in tests/serial-tests.json one at a time, and exits 1 if either run failed.
//
// Sharding is computed here, not with --test-shard: file j (0-based, sorted) of each set
// goes to shard (j mod n) + 1. Every spawn passes an explicit, non-empty file list, and a
// set or shard with no files is never spawned, because `node --test` without file
// arguments falls back to default discovery. No shell is used and nothing touches the
// network.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { artifactPath, repositoryRoot } from "./artifacts.mjs";

const usage =
  "usage: node scripts/run-tests.mjs [--set=unit] [--shard=i/n] [--concurrency=k] " +
  "[--repeat=r] [--junit=<artifact dir>] [--list]";
const sets = ["unit"];
const artifactSegment = /^[a-z0-9][a-z0-9._-]*$/;
export const serialListPath = "tests/serial-tests.json";
const limits = Object.freeze({
  concurrency: [1, 16],
  repeat: [1, 10],
  shards: [1, 64],
  reason: [20, 300],
});

const rejected = (code, detail) => Error(`RUN_TESTS_${code}: ${detail}`);

function boundedInteger(flag, value, [min, max]) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/.test(value))
    throw rejected("INVALID_VALUE", flag);
  const number = Number(value);
  if (number < min || number > max)
    throw rejected("OUT_OF_RANGE", `${flag} must be ${min}..${max}`);
  return number;
}

// Parses the command line into closed options. Every flag appears at most once, and
// values are validated here, before anything is read or spawned.
export function parseArguments(argv, { parallelism = availableParallelism() } = {}) {
  const options = {
    set: "unit",
    shard: { index: 1, count: 1 },
    concurrency: Math.min(4, Math.max(1, parallelism)),
    repeat: 1,
    junit: null,
    list: false,
  };
  const seen = new Set();
  for (const argument of argv) {
    const flag = /^--([a-z]+)(?:=(.*))?$/s.exec(argument);
    if (!flag) throw rejected("UNKNOWN_FLAG", argument);
    const [, name, value] = flag;
    if (seen.has(name)) throw rejected("DUPLICATE_FLAG", name);
    seen.add(name);
    switch (name) {
      case "set":
        if (!sets.includes(value)) throw rejected("INVALID_VALUE", "--set");
        options.set = value;
        break;
      case "shard": {
        const shard = /^([1-9][0-9]?)\/([1-9][0-9]?)$/.exec(value ?? "");
        if (!shard) throw rejected("INVALID_VALUE", "--shard");
        const index = Number(shard[1]);
        const count = Number(shard[2]);
        if (count > limits.shards[1] || index > count)
          throw rejected("OUT_OF_RANGE", "--shard must be i/n with 1 <= i <= n <= 64");
        options.shard = { index, count };
        break;
      }
      case "concurrency":
        options.concurrency = boundedInteger("--concurrency", value, limits.concurrency);
        break;
      case "repeat":
        options.repeat = boundedInteger("--repeat", value, limits.repeat);
        break;
      case "junit":
        if (typeof value !== "string" || !value.split("/").every((p) => artifactSegment.test(p)))
          throw rejected("INVALID_VALUE", "--junit");
        options.junit = value;
        break;
      case "list":
        if (value !== undefined) throw rejected("INVALID_VALUE", "--list");
        options.list = true;
        break;
      default:
        throw rejected("UNKNOWN_FLAG", argument);
    }
  }
  return options;
}

// Top-level unit test files, as sorted repository-relative paths. Subdirectories
// (fixtures, and the Docker-backed suites of later packets) are never included.
export function listUnitFiles(root = repositoryRoot) {
  return readdirSync(join(root, "tests"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => "tests/" + entry.name)
    .sort();
}

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
const hasExactKeys = (value, keys) =>
  isPlainObject(value) && Object.keys(value).sort().join() === [...keys].sort().join();

// Validates tests/serial-tests.json against the listed files and returns the serial
// file names. Each entry names one listed file once, with a reason of 20..300 characters.
export function readSerialList(text, files) {
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    throw rejected("SERIAL_INVALID", "not JSON");
  }
  if (!hasExactKeys(list, ["schemaVersion", "serial"]) || list.schemaVersion !== 1)
    throw rejected("SERIAL_INVALID", "expected {schemaVersion: 1, serial: [...]}");
  if (!Array.isArray(list.serial)) throw rejected("SERIAL_INVALID", "serial must be an array");
  const seen = new Set();
  for (const entry of list.serial) {
    if (!hasExactKeys(entry, ["file", "reason"]))
      throw rejected("SERIAL_INVALID", "entries are {file, reason}");
    if (typeof entry.file !== "string" || !files.includes(entry.file))
      throw rejected("SERIAL_INVALID", "not a listed top-level tests/*.test.mjs file");
    if (seen.has(entry.file)) throw rejected("SERIAL_INVALID", "duplicate " + entry.file);
    const [min, max] = limits.reason;
    if (typeof entry.reason !== "string" || entry.reason.length < min || entry.reason.length > max)
      throw rejected("SERIAL_INVALID", `reason must be ${min}..${max} characters`);
    seen.add(entry.file);
  }
  return [...seen];
}

// Splits the files into the parallel and serial sets, then keeps this shard's share of
// each set.
export function planTests({ set, files, serial, shard, concurrency }) {
  const serialFiles = new Set(serial);
  const share = (list) => list.filter((_, j) => j % shard.count === shard.index - 1);
  return {
    set,
    parallel: share(files.filter((file) => !serialFiles.has(file))),
    serial: share(files.filter((file) => serialFiles.has(file))),
    concurrency,
    shard: `${shard.index}/${shard.count}`,
  };
}

// One `node --test` invocation per non-empty set and repetition, parallel set first.
// With --junit, each invocation also writes a JUnit report under the artifacts root
// (MORROW_ARTIFACTS_DIR in CI), named after its set, shard and repetition.
export function testCommands(plan, { repeat = 1, junit = null } = {}) {
  const commands = [];
  const shard = plan.shard.replace("/", "of");
  for (let run = 1; run <= repeat; run++)
    for (const [kind, files, concurrency] of [
      ["parallel", plan.parallel, plan.concurrency],
      ["serial", plan.serial, 1],
    ]) {
      if (files.length === 0) continue;
      const args = ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`];
      const report = junit
        ? artifactPath(`${junit}/${plan.set}-${kind}-shard${shard}-run${run}.xml`)
        : null;
      if (report)
        args.push(
          "--test-reporter=spec",
          "--test-reporter-destination=stdout",
          "--test-reporter=junit",
          `--test-reporter-destination=${report}`,
        );
      commands.push({ kind, run, files: [...files], args: [...args, ...files], report });
    }
  return commands;
}

function spawnNode(args, { cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, stdio: "inherit", shell: false });
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(signal === null && code === 0 ? 0 : 1));
  });
}

// Runs the selected tests and resolves to the process exit code. The file listing,
// serial list text and spawner can be injected by tests.
export async function runTests(argv, options = {}) {
  const {
    root = repositoryRoot,
    parallelism,
    files = listUnitFiles(root),
    serialText = readFileSync(join(root, serialListPath), "utf8"),
    spawnChild = spawnNode,
    write = (text) => process.stdout.write(text),
  } = options;
  const parsed = parseArguments(argv, { parallelism });
  const serial = readSerialList(serialText, files);
  const plan = planTests({ ...parsed, files, serial });
  if (parsed.list) {
    write(JSON.stringify(plan) + "\n");
    return 0;
  }
  const commands = testCommands(plan, parsed);
  if (commands.length === 0) {
    write(`run-tests: no ${plan.set} test files in shard ${plan.shard}; nothing spawned\n`);
    return 0;
  }
  // Every command runs even after a failure, so one run reports both sets (and, under
  // --repeat, every repetition). The test totals are the sum of each run's `ℹ tests`.
  const results = [];
  let failed = 0;
  for (const command of commands) {
    if (command.report) mkdirSync(dirname(command.report), { recursive: true });
    const passed = (await spawnChild(command.args, { cwd: root })) === 0;
    if (!passed) failed++;
    results.push(
      `${command.kind} run ${command.run} (${command.files.length} files) ${passed ? "passed" : "failed"}`,
    );
  }
  write(`run-tests: ${plan.set} shard ${plan.shard}: ${results.join("; ")}\n`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runTests(process.argv.slice(2));
  } catch (error) {
    if (!String(error?.message).startsWith("RUN_TESTS_")) throw error;
    console.error(error.message + "\n" + usage);
    process.exitCode = 2;
  }
}
