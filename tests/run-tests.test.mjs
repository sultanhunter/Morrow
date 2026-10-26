import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  listUnitFiles,
  parseArguments,
  planTests,
  readSerialList,
  runTests,
  serialListPath,
  testCommands,
} from "../scripts/run-tests.mjs";
import { repositoryRoot } from "../scripts/artifacts.mjs";

// P03.T04e AC03 and AC06: the runner's sets are complete and disjoint, shards partition
// each set, empty sets and shards spawn nothing, bad input is rejected, and every test
// server listens on an ephemeral loopback port.

const files = listUnitFiles();
const serialText = readFileSync(join(repositoryRoot, serialListPath), "utf8");
const serial = readSerialList(serialText, files);
const json = (value) => JSON.stringify(value);

// Runs the runner with an injected spawner that records every spawn and returns the
// given exit codes in order.
async function recordRun(argv, { names = files, text = serialText, codes = [] } = {}) {
  const spawned = [];
  const output = [];
  const code = await runTests(argv, {
    files: names,
    serialText: text,
    parallelism: 8,
    spawnChild: async (args, options) => {
      spawned.push({ args, cwd: options.cwd });
      return codes[spawned.length - 1] ?? 0;
    },
    write: (line) => output.push(line),
  });
  return { code, spawned, output: output.join("") };
}

test("--list gives complete, disjoint parallel and serial sets of every top-level test file", async () => {
  assert.ok(files.length > 50, "the unit set lists the repository test files");
  const onDisk = readdirSync(join(repositoryRoot, "tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => "tests/" + name)
    .sort();
  assert.deepEqual(files, onDisk);
  const { code, spawned, output } = await recordRun(["--list"]);
  assert.equal(code, 0);
  assert.equal(spawned.length, 0, "--list runs nothing");
  const plan = JSON.parse(output);
  assert.deepEqual(Object.keys(plan), ["set", "parallel", "serial", "concurrency", "shard"]);
  assert.equal(plan.set, "unit");
  assert.equal(plan.shard, "1/1");
  assert.equal(plan.concurrency, 4, "default concurrency is min(4, available parallelism)");
  assert.deepEqual(plan.serial, serial);
  assert.deepEqual([...plan.parallel, ...plan.serial].sort(), files);
  assert.equal(new Set([...plan.parallel, ...plan.serial]).size, files.length, "disjoint");
});

test("every shard partition covers each file exactly once, in each set", () => {
  for (let count = 1; count <= 5; count++) {
    const seen = new Map();
    for (let index = 1; index <= count; index++) {
      const plan = planTests({
        set: "unit",
        files,
        serial,
        shard: { index, count },
        concurrency: 2,
      });
      for (const file of plan.serial) assert.ok(serial.includes(file));
      for (const file of plan.parallel) assert.ok(!serial.includes(file));
      for (const file of [...plan.parallel, ...plan.serial])
        seen.set(file, (seen.get(file) ?? 0) + 1);
    }
    assert.deepEqual([...seen.keys()].sort(), files, `${count} shards`);
    assert.ok(
      [...seen.values()].every((n) => n === 1),
      `${count} shards`,
    );
  }
  // File j of a set goes to shard (j mod n) + 1.
  const names = ["tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs", "tests/d.test.mjs"];
  const plan = (index) =>
    planTests({
      set: "unit",
      files: names,
      serial: ["tests/b.test.mjs"],
      shard: { index, count: 2 },
      concurrency: 1,
    });
  assert.deepEqual(plan(1).parallel, ["tests/a.test.mjs", "tests/d.test.mjs"]);
  assert.deepEqual(plan(1).serial, ["tests/b.test.mjs"]);
  assert.deepEqual(plan(2).parallel, ["tests/c.test.mjs"]);
  assert.deepEqual(plan(2).serial, []);
});

test("the parallel set runs at --test-concurrency=k and the serial set at 1, both with explicit files", async () => {
  const names = ["tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs"];
  const text = json({
    schemaVersion: 1,
    serial: [{ file: "tests/b.test.mjs", reason: "a fixed wall-clock deadline window" }],
  });
  const { code, spawned } = await recordRun(["--concurrency=3"], { names, text });
  assert.equal(code, 0);
  assert.deepEqual(spawned, [
    {
      args: [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=3",
        "--test-timeout=300000",
        "tests/a.test.mjs",
        "tests/c.test.mjs",
      ],
      cwd: repositoryRoot,
    },
    {
      args: [
        "--import",
        "tsx",
        "--test",
        "--test-concurrency=1",
        "--test-timeout=300000",
        "tests/b.test.mjs",
      ],
      cwd: repositoryRoot,
    },
  ]);
});

test("every spawn limits each test to five minutes, once, before its file list", async () => {
  const names = ["tests/a.test.mjs", "tests/b.test.mjs"];
  const text = json({
    schemaVersion: 1,
    serial: [{ file: "tests/b.test.mjs", reason: "a fixed wall-clock deadline window" }],
  });
  const { spawned } = await recordRun([], { names, text });
  assert.equal(spawned.length, 2);
  for (const { args } of spawned) {
    const limits = args.filter((a) => a.startsWith("--test-timeout="));
    assert.deepEqual(limits, ["--test-timeout=300000"]);
    const firstFile = args.findIndex((a) => a.startsWith("tests/"));
    assert.ok(args.indexOf("--test-timeout=300000") < firstFile, "the limit precedes the files");
  }
});

test("a failing set fails the run, and the other set still runs", async () => {
  const names = ["tests/a.test.mjs", "tests/b.test.mjs"];
  const text = json({
    schemaVersion: 1,
    serial: [{ file: "tests/b.test.mjs", reason: "a fixed wall-clock deadline window" }],
  });
  for (const codes of [
    [1, 0],
    [0, 1],
  ]) {
    const { code, spawned, output } = await recordRun([], { names, text, codes });
    assert.equal(code, 1);
    assert.equal(spawned.length, 2);
    assert.match(output, /failed/);
  }
});

test("an empty set or shard is never spawned", async () => {
  const names = ["tests/a.test.mjs", "tests/b.test.mjs", "tests/c.test.mjs"];
  const empty = json({ schemaVersion: 1, serial: [] });
  const parallelOnly = await recordRun([], { names, text: empty });
  assert.equal(parallelOnly.spawned.length, 1, "an empty serial list spawns only the parallel set");
  assert.deepEqual(parallelOnly.spawned[0].args.slice(5), names);
  const nothing = await recordRun(["--shard=4/4"], { names, text: empty });
  assert.equal(nothing.code, 0);
  assert.equal(nothing.spawned.length, 0, "shard 4/4 over 3 files spawns nothing");
  assert.match(nothing.output, /nothing spawned/);
  const allSerial = await recordRun([], {
    names: ["tests/a.test.mjs"],
    text: json({
      schemaVersion: 1,
      serial: [{ file: "tests/a.test.mjs", reason: "a fixed wall-clock deadline window" }],
    }),
  });
  assert.deepEqual(
    allSerial.spawned.map((s) => s.args[3]),
    ["--test-concurrency=1"],
    "an empty parallel set spawns only the serial set",
  );
});

test("--repeat spawns a fresh child per repetition and --junit adds a report per spawn", async () => {
  const names = ["tests/a.test.mjs", "tests/b.test.mjs"];
  const text = json({
    schemaVersion: 1,
    serial: [{ file: "tests/b.test.mjs", reason: "a fixed wall-clock deadline window" }],
  });
  // Reports go under the artifacts root; point it at a temporary directory here.
  const saved = process.env.MORROW_ARTIFACTS_DIR;
  const root = mkdtempSync(join(tmpdir(), "morrow-run-tests-"));
  process.env.MORROW_ARTIFACTS_DIR = root;
  try {
    const { spawned } = await recordRun(["--repeat=2", "--junit=heavy/unit", "--shard=1/1"], {
      names,
      text,
    });
    assert.equal(spawned.length, 4);
    const directory = join(root, "heavy", "unit");
    assert.ok(statSync(directory).isDirectory(), "the report directory exists before any spawn");
    for (const [index, name] of [
      "unit-parallel-shard1of1-run1.xml",
      "unit-serial-shard1of1-run1.xml",
      "unit-parallel-shard1of1-run2.xml",
      "unit-serial-shard1of1-run2.xml",
    ].entries())
      assert.deepEqual(spawned[index].args.slice(3, 9), [
        index % 2 === 0 ? "--test-concurrency=4" : "--test-concurrency=1",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=junit",
        "--test-reporter-destination=" + join(directory, name),
        "--test-timeout=300000",
      ]);
  } finally {
    if (saved === undefined) delete process.env.MORROW_ARTIFACTS_DIR;
    else process.env.MORROW_ARTIFACTS_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
  const none = planTests({
    set: "unit",
    files: [],
    serial: [],
    shard: { index: 1, count: 1 },
    concurrency: 1,
  });
  assert.deepEqual(testCommands(none, { repeat: 3, junit: "heavy/unit" }), []);
});

test("unknown flags, malformed values and out-of-range values are rejected", () => {
  assert.deepEqual(parseArguments([], { parallelism: 2 }), {
    set: "unit",
    shard: { index: 1, count: 1 },
    concurrency: 2,
    repeat: 1,
    junit: null,
    list: false,
  });
  assert.equal(parseArguments([], { parallelism: 32 }).concurrency, 4);
  assert.equal(parseArguments(["--concurrency=16"]).concurrency, 16);
  assert.equal(parseArguments(["--repeat=10"]).repeat, 10);
  assert.deepEqual(parseArguments(["--shard=2/2"]).shard, { index: 2, count: 2 });
  const cases = [
    [["--verbose"], /RUN_TESTS_UNKNOWN_FLAG/],
    [["tests/a.test.mjs"], /RUN_TESTS_UNKNOWN_FLAG/],
    [["-l"], /RUN_TESTS_UNKNOWN_FLAG/],
    [["--set=postgresql"], /RUN_TESTS_INVALID_VALUE/],
    [["--set"], /RUN_TESTS_INVALID_VALUE/],
    [["--shard="], /RUN_TESTS_INVALID_VALUE/],
    [["--shard=$TEST_SHARD"], /RUN_TESTS_INVALID_VALUE/],
    [["--shard=0/2"], /RUN_TESTS_INVALID_VALUE/],
    [["--shard=3/2"], /RUN_TESTS_OUT_OF_RANGE/],
    [["--shard=1/0"], /RUN_TESTS_INVALID_VALUE/],
    [["--shard=1/65"], /RUN_TESTS_OUT_OF_RANGE/],
    [["--shard=1/100"], /RUN_TESTS_INVALID_VALUE/],
    [["--concurrency=0"], /RUN_TESTS_INVALID_VALUE/],
    [["--concurrency=17"], /RUN_TESTS_OUT_OF_RANGE/],
    [["--concurrency=2.5"], /RUN_TESTS_INVALID_VALUE/],
    [["--concurrency=04"], /RUN_TESTS_INVALID_VALUE/],
    [["--repeat=11"], /RUN_TESTS_OUT_OF_RANGE/],
    [["--repeat"], /RUN_TESTS_INVALID_VALUE/],
    [["--junit=../outside"], /RUN_TESTS_INVALID_VALUE/],
    [["--junit=/tmp/report"], /RUN_TESTS_INVALID_VALUE/],
    [["--junit=Heavy"], /RUN_TESTS_INVALID_VALUE/],
    [["--junit="], /RUN_TESTS_INVALID_VALUE/],
    [["--list=yes"], /RUN_TESTS_INVALID_VALUE/],
    [["--repeat=2", "--repeat=3"], /RUN_TESTS_DUPLICATE_FLAG/],
  ];
  for (const [argv, error] of cases) assert.throws(() => parseArguments(argv), error, json(argv));
});

test("the command line rejects bad input with exit 2 and lists a shard as JSON", () => {
  const cli = (...argv) =>
    spawnSync(process.execPath, ["scripts/run-tests.mjs", ...argv], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  for (const argv of [["--bogus"], ["--shard="], ["--repeat=11"]]) {
    const result = cli(...argv);
    assert.equal(result.status, 2, json(argv));
    assert.match(
      result.stderr,
      /^RUN_TESTS_[A-Z_]+: .*\nusage: node scripts\/run-tests\.mjs/,
      json(argv),
    );
    assert.equal(result.stdout, "");
  }
  const listed = cli("--list", "--shard=2/2", "--concurrency=2");
  assert.equal(listed.status, 0);
  assert.deepEqual(
    JSON.parse(listed.stdout),
    planTests({ set: "unit", files, serial, shard: { index: 2, count: 2 }, concurrency: 2 }),
  );
});

test("malformed serial lists are rejected before anything is spawned", async () => {
  const names = ["tests/a.test.mjs", "tests/b.test.mjs"];
  const reason = "a fixed wall-clock deadline window";
  const cases = [
    "not json",
    json([]),
    json({ schemaVersion: 2, serial: [] }),
    json({ schemaVersion: 1 }),
    json({ schemaVersion: 1, serial: {} }),
    json({ schemaVersion: 1, serial: [], extra: true }),
    json({ schemaVersion: 1, serial: ["tests/a.test.mjs"] }),
    json({ schemaVersion: 1, serial: [{ file: "tests/a.test.mjs" }] }),
    json({ schemaVersion: 1, serial: [{ file: "tests/a.test.mjs", reason, note: "x" }] }),
    json({ schemaVersion: 1, serial: [{ file: "tests/missing.test.mjs", reason }] }),
    json({ schemaVersion: 1, serial: [{ file: "tests/postgresql/a.test.mjs", reason }] }),
    json({ schemaVersion: 1, serial: [{ file: "scripts/run-tests.mjs", reason }] }),
    json({ schemaVersion: 1, serial: [{ file: "a.test.mjs", reason }] }),
    json({
      schemaVersion: 1,
      serial: [
        { file: "tests/a.test.mjs", reason },
        { file: "tests/a.test.mjs", reason },
      ],
    }),
    json({ schemaVersion: 1, serial: [{ file: "tests/a.test.mjs", reason: "x".repeat(19) }] }),
    json({ schemaVersion: 1, serial: [{ file: "tests/a.test.mjs", reason: "x".repeat(301) }] }),
    json({ schemaVersion: 1, serial: [{ file: "tests/a.test.mjs", reason: 42 }] }),
  ];
  for (const text of cases) {
    const spawned = [];
    await assert.rejects(
      runTests([], {
        files: names,
        serialText: text,
        spawnChild: async (args) => (spawned.push(args), 0),
        write: () => {},
      }),
      /RUN_TESTS_SERIAL_INVALID/,
      text,
    );
    assert.equal(spawned.length, 0);
  }
  assert.deepEqual(
    readSerialList(
      json({ schemaVersion: 1, serial: [{ file: "tests/a.test.mjs", reason: "x".repeat(20) }] }),
      names,
    ),
    ["tests/a.test.mjs"],
  );
});

test("the repository serial list names each file with its timing reason", () => {
  const entries = JSON.parse(serialText).serial;
  assert.deepEqual(
    entries.map((e) => e.file),
    serial,
  );
  for (const entry of entries) assert.ok(files.includes(entry.file), entry.file);
});

// AC06: every test server binds an ephemeral loopback port. The exact form also refuses
// starting the fixed-port operator listeners, which tests may construct and close only.
const listenCall = "." + "listen(";
const allowedListen = listenCall + '0, "127.0.0.1"';
function listenViolations(text) {
  const violations = [];
  for (let at = text.indexOf(listenCall); at >= 0; at = text.indexOf(listenCall, at + 1))
    if (!text.startsWith(allowedListen, at)) violations.push(text.slice(at, at + 32));
  return violations;
}
function testSources(directory = join(repositoryRoot, "tests")) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testSources(path);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [path] : [];
  });
}

test("every listen in tests/**/*.mjs is an ephemeral loopback port", () => {
  const sources = testSources();
  assert.ok(sources.some((path) => path.endsWith("run-tests.test.mjs")));
  let listens = 0;
  for (const path of sources) {
    const text = readFileSync(path, "utf8");
    assert.deepEqual(listenViolations(text), [], relative(repositoryRoot, path));
    listens += text.split(allowedListen).length - 1;
  }
  assert.ok(listens > 0, "the check sees the existing test servers");
  for (const planted of [
    "server" + listenCall + "4110);",
    "server" + listenCall + '4110, "127.0.0.1");',
    "listener" + listenCall + ");",
    "server" + listenCall + '0, "0.0.0.0");',
    "server" + listenCall + "0);",
    "server" + listenCall + "{ port: 0 });",
  ])
    assert.equal(listenViolations(planted).length, 1, planted);
  assert.deepEqual(listenViolations("server" + allowedListen + ", resolve);"), []);
});
