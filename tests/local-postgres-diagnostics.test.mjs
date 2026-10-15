import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  localPostgresFailureDiagnostic,
  localPostgresWaitingCaseDiagnostic,
} from "../scripts/local-postgres-lab.mjs";

test("failure projection distinguishes spawn errors, process signals and psql exit status", () => {
  assert.deepEqual(localPostgresFailureDiagnostic("exec", "ETIMEDOUT", null, "SIGTERM"), {
    commandKind: "exec",
    processError: "ETIMEDOUT",
    exitCode: null,
    signal: "SIGTERM",
  });
  assert.deepEqual(localPostgresFailureDiagnostic("exec", null, 3, null), {
    commandKind: "exec",
    processError: null,
    exitCode: 3,
    signal: null,
  });
  assert.deepEqual(localPostgresFailureDiagnostic("run", "EAGAIN", null, null), {
    commandKind: "run",
    processError: "EAGAIN",
    exitCode: null,
    signal: null,
  });
});

test("projection discards arbitrary strings, invalid exits and raw Error contents", () => {
  const privateText = "synthetic-private-sql-proof-body-canary";
  const error = Object.assign(new Error(privateText), { code: privateText, cause: privateText });
  for (const exit of [-1, 256, 1.5, NaN, Infinity, "3", error]) {
    const result = localPostgresFailureDiagnostic(privateText, error, exit, privateText);
    assert.deepEqual(result, {
      commandKind: "other",
      processError: "other",
      exitCode: null,
      signal: "other",
    });
    assert.equal(JSON.stringify(result).includes(privateText), false);
    assert.equal(Object.isFrozen(result), true);
  }
});

test("primitive projection never reflects on hostile objects or coerces their fields", () => {
  let traps = 0;
  const hostile = new Proxy(Object.create(null), {
    get() {
      traps++;
      throw Error("private getter");
    },
    ownKeys() {
      traps++;
      throw Error("private keys");
    },
    getPrototypeOf() {
      traps++;
      throw Error("private prototype");
    },
  });
  assert.deepEqual(localPostgresFailureDiagnostic(hostile, hostile, hostile, hostile), {
    commandKind: "other",
    processError: "other",
    exitCode: null,
    signal: "other",
  });
  assert.equal(localPostgresWaitingCaseDiagnostic(hostile), "other_case");
  assert.equal(traps, 0);
});

test("waiting-case diagnostics disclose only the five fixed expiry cases", () => {
  for (const name of ["handoff", "review", "proof", "session", "grant"]) {
    const value = name + "_expiry_after_wait";
    assert.equal(localPostgresWaitingCaseDiagnostic(value), value);
  }
  for (const value of [
    undefined,
    null,
    1,
    "grant_expiry_after_wait\nprivate",
    "SELECT private",
    new Error("private"),
  ])
    assert.equal(localPostgresWaitingCaseDiagnostic(value), "other_case");
});

// Run the actual driver in a fresh process with only a temporary fake docker on
// PATH. This exercises its failure/allowFailure behavior without Docker/network.
function runDriver(t, script, allowFailure = false, breakDiagnosticSink = false) {
  const root = mkdtempSync(join(tmpdir(), "morrow-local-diagnostic-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (script !== null) writeFileSync(join(root, "docker"), "#!/bin/sh\n" + script, { mode: 0o700 });
  const moduleUrl = new URL("../scripts/local-postgres-lab.mjs", import.meta.url).href;
  const program = `
    import { containerCommand } from ${JSON.stringify(moduleUrl)};
    ${breakDiagnosticSink ? 'console.error = () => { throw Error("private sink failure"); };' : ""}
    try {
      const result = containerCommand(["exec", "synthetic-private-argument"], "synthetic-private-stdin", ${allowFailure});
      console.log(JSON.stringify({ returned: true, status: result.status }));
    } catch (error) {
      console.log(JSON.stringify({ originalFailure: error.message === "LOCAL_LAB_COMMAND_FAILED:exec" }));
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    env: { PATH: root },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  return { result: JSON.parse(child.stdout), stderr: child.stderr };
}
function diagnostic(stderr) {
  assert.match(stderr, /^LOCAL_LAB_DIAGNOSTIC \{[^\n]+\}\n$/);
  return JSON.parse(stderr.slice("LOCAL_LAB_DIAGNOSTIC ".length));
}

test("real driver reports exit3 without exposing process I/O, SQL or argument canaries", (t) => {
  const child = runDriver(
    t,
    "printf 'synthetic-private-stdout\\n'\nprintf 'synthetic-private-stderr\\n' >&2\nexit 3\n",
  );
  assert.deepEqual(child.result, { originalFailure: true });
  assert.deepEqual(diagnostic(child.stderr), {
    commandKind: "exec",
    processError: null,
    exitCode: 3,
    signal: null,
  });
  assert.equal(child.stderr.includes("synthetic-private"), false);
});

test("real missing executable reports ENOENT without its path or error text", (t) => {
  const child = runDriver(t, null);
  assert.deepEqual(child.result, { originalFailure: true });
  assert.deepEqual(diagnostic(child.stderr), {
    commandKind: "exec",
    processError: "ENOENT",
    exitCode: null,
    signal: null,
  });
});

test("real signalled subprocess preserves original failure and records only the signal", (t) => {
  const child = runDriver(t, "kill -TERM $$\n");
  assert.deepEqual(child.result, { originalFailure: true });
  assert.deepEqual(diagnostic(child.stderr), {
    commandKind: "exec",
    processError: null,
    exitCode: null,
    signal: "SIGTERM",
  });
});

test("expected allowFailure probes emit no diagnostic and keep returning the result", (t) => {
  const child = runDriver(t, "printf 'synthetic-private-probe\\n' >&2\nexit 7\n", true);
  assert.deepEqual(child.result, { returned: true, status: 7 });
  assert.equal(child.stderr, "");
  const absent = runDriver(t, null, true);
  assert.deepEqual(absent.result, { returned: true, status: null });
  assert.equal(absent.stderr, "");
});

test("diagnostic sink failure never replaces the existing command failure", (t) => {
  const child = runDriver(t, "exit 3\n", false, true);
  assert.deepEqual(child.result, { originalFailure: true });
  assert.equal(child.stderr, "");
});

test("successful commands produce no failure diagnostic", (t) => {
  const child = runDriver(t, "exit 0\n");
  assert.deepEqual(child.result, { returned: true, status: 0 });
  assert.equal(child.stderr, "");
});
