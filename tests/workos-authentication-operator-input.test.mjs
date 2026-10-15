import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  prepareSyntheticWorkosAuthenticationOperatorRun as fixture,
  readWorkosAuthenticationOperatorRun as read,
  adoptWorkosAuthenticationOperatorRun as adopt,
  consumeWorkosAuthenticationOperatorNativePermit as consume,
  releaseWorkosAuthenticationOperatorRun as release,
  claimWorkosAuthenticationOperatorRun as claim,
  inspectWorkosAuthenticationOperatorRun as inspect,
  parseWorkosAuthenticationOperatorProfile as profile,
} from "../scripts/workos-authentication-operator-input.mjs";
import {
  authenticationOperatorHash as hash,
  authenticationOperatorReadPrivate as privateRead,
} from "../scripts/workos-authentication-operator-journal.mjs";
const parent = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "morrow-l-input-"));
const data = (root, n) => JSON.parse(fs.readFileSync(path.join(root, n), "utf8"));
const save = (root, n, value) =>
  fs.writeFileSync(path.join(root, n), JSON.stringify(value) + "\n", { mode: 0o600 });
function withRun(fn, options = {}) {
  const dir = parent(),
    root = path.join(dir, "run");
  let run;
  try {
    run = fixture(root, options);
    return fn(run, root);
  } finally {
    if (run) release(run);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a durable claim precedes allocation and native credential authority; adoption and child permit are once only", () =>
  withRun((run, root) => {
    assert.equal(fs.existsSync(path.join(root, "claim.json")), true);
    assert.equal(fs.existsSync(path.join(root, "controller_lock.json")), true);
    const context = read(run);
    assert.equal(context.current(), true);
    assert.equal(context.mode, "synthetic");
    assert.equal(context.binding.approvedSubjectId.startsWith("user_"), true);
    assert.equal(JSON.parse(context.admissionBindingJson).clientId, context.binding.clientId);
    assert.equal(JSON.parse(context.bindingJson).schemaVersion, 1);
    const owned = adopt(run);
    assert.throws(() => adopt(run), /WORKOS_AUTHENTICATION_OPERATOR_HELD/);
    const native = consume(owned.nativeSubpermit);
    assert.equal(native.mode, "synthetic");
    assert.throws(() => native.credential(), /WORKOS_AUTHENTICATION_OPERATOR_HELD/);
    assert.throws(() => consume(owned.nativeSubpermit), /WORKOS_AUTHENTICATION_OPERATOR_HELD/);
    assert.equal(inspect(root).effectHandles, 0);
  }));

test("forged, serialized and hostile run/permit objects confer no authority or getter calls", () => {
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      getPrototypeOf() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
    },
  );
  for (const fake of [null, {}, "{}", hostile]) {
    assert.throws(() => read(fake));
    assert.throws(() => adopt(fake));
    assert.throws(() => consume(fake));
  }
  assert.equal(traps, 0);
  // Source-only CLI invocation cannot even inspect a private native root.
  assert.equal(claim(hostile), null);
  assert.equal(traps, 0);
});

test("false, expired and incorrectly bound approvals fail before lock or claim mutation", () => {
  for (const change of [
    "false",
    "expired",
    "source",
    "receipt",
    "baseline",
    "stale_baseline",
    "future_baseline",
  ]) {
    const dir = parent(),
      root = path.join(dir, "run");
    try {
      assert.throws(() =>
        fixture(root, {
          clock: () => 1000000,
          beforeClaim(r) {
            const a = data(r, "activation.json"),
              receipt = data(r, "receipt.json");
            if (change === "false") a.ownerApproved = false;
            if (change === "expired") {
              a.preparedAtMs = 1;
              a.expiresAtMs = 2;
            }
            if (change === "source") a.sourceDigest = "f".repeat(64);
            save(r, "activation.json", a);
            receipt.activationSha256 = hash(fs.readFileSync(path.join(r, "activation.json")));
            if (change === "receipt") receipt.approvalReference = "different_owner_action";
            if (["baseline", "stale_baseline", "future_baseline"].includes(change)) {
              const b = data(r, "baseline.json");
              if (change === "baseline") b.approvedSubjectId = "user_" + "Z".repeat(26);
              if (change === "stale_baseline") b.observedAtMs = 699999;
              if (change === "future_baseline") b.observedAtMs = 1000001;
              save(r, "baseline.json", b);
              receipt.baselineSha256 = hash(fs.readFileSync(path.join(r, "baseline.json")));
            }
            save(r, "receipt.json", receipt);
          },
        }),
      );
      assert.equal(fs.existsSync(path.join(root, "claim.json")), false, change);
      assert.equal(fs.existsSync(path.join(root, "controller_lock.json")), false, change);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("symlink ancestors are rejected before mkdir and private parents/regular files are required", () => {
  const dir = parent(),
    real = path.join(dir, "real"),
    link = path.join(dir, "link");
  try {
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, link);
    assert.throws(() => fixture(path.join(link, "run")));
    assert.equal(fs.existsSync(path.join(real, "run")), false);
    const loose = path.join(dir, "loose");
    fs.mkdirSync(loose, { mode: 0o755 });
    const file = path.join(loose, "binding.json");
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    assert.throws(() => privateRead(file));
    fs.chmodSync(loose, 0o700);
    assert.equal(privateRead(file).text, "{}");
    const extra = path.join(loose, "other.json");
    fs.linkSync(file, extra);
    assert.throws(() => privateRead(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("private byte or same-file identity drift invalidates a run permanently", () =>
  withRun((run, root) => {
    const context = read(run),
      file = path.join(root, "baseline.json"),
      raw = fs.readFileSync(file);
    fs.writeFileSync(file, raw);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
    assert.throws(() => context.current());
    fs.writeFileSync(file, raw);
    assert.throws(() => context.current());
  }));

test("current source and clock are checked after the trusted callback and cannot revive", () => {
  let now = 1000000,
    armed = false;
  withRun(
    (run) => {
      const context = read(run);
      armed = true;
      assert.throws(() => context.current());
      now = 1000000;
      assert.throws(() => context.current());
    },
    {
      clock: () => now,
      currentScope: (expected) => {
        if (armed) now = 1600000;
        return expected;
      },
    },
  );
});

test("release removes only the owned temporary key and lock, retaining irreversible claim evidence", () =>
  withRun((run, root) => {
    const result = release(run);
    assert.deepEqual(result, { credentialRemoved: true, lockReleased: true });
    assert.equal(fs.existsSync(path.join(root, "credential.txt")), false);
    assert.equal(fs.existsSync(path.join(root, "controller_lock.json")), false);
    assert.equal(fs.existsSync(path.join(root, "claim.json")), true);
    assert.throws(() => read(run));
    assert.deepEqual(release(run), { credentialRemoved: false, lockReleased: false });
  }));

test("foreign key replacement is never deleted during cleanup", () =>
  withRun((run, root) => {
    const file = path.join(root, "credential.txt");
    fs.unlinkSync(file);
    fs.writeFileSync(file, "foreign synthetic credential", { mode: 0o600 });
    const cleanup = release(run);
    assert.equal(cleanup.credentialRemoved, false);
    assert.equal(fs.existsSync(file), true);
  }));

test("public profile rejects reflective/nonstring inputs, endpoint changes and extra authority", () =>
  withRun((run) => {
    const p = JSON.parse(read(run).profileJson);
    let calls = 0;
    const raw = new Proxy(
      {},
      {
        get() {
          calls++;
          throw Error();
        },
        ownKeys() {
          calls++;
          throw Error();
        },
      },
    );
    assert.throws(() => profile(raw));
    assert.equal(calls, 0);
    assert.throws(() => profile(JSON.stringify({ ...p, apiOrigin: "https://foreign.invalid" })));
    assert.throws(() => profile(JSON.stringify({ ...p, key: "synthetic" })));
    assert.equal(profile(JSON.stringify(p)).protocolSequence, 80);
  }));

test("baseline freshness is checked at durable claim, including source work and fsync acknowledgment", () => {
  for (const phase of ["before", "after"]) {
    const dir = parent(),
      root = path.join(dir, "run");
    let at = 1000000,
      reads = 0;
    try {
      assert.throws(
        () =>
          fixture(root, {
            clock: () => at,
            currentScope(expected) {
              if (++reads === 2 && phase === "before") at = 1300001;
              return expected;
            },
            fault(point) {
              if (phase === "after" && point === "after_write:claim.json") at = 1300001;
            },
          }),
        /WORKOS_AUTHENTICATION_OPERATOR_HELD/,
      );
      assert.equal(fs.existsSync(path.join(root, "claim.json")), phase === "after");
      assert.equal(fs.existsSync(path.join(root, "controller_lock.json")), true);
      assert.equal(fs.existsSync(path.join(root, "initiation_started.json")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  let at = 1000000,
    reads = 0;
  withRun(
    (run, root) => {
      assert.equal(data(root, "claim.json").claimedAtMs, 1000001);
      assert.equal(read(run).current(), true);
    },
    {
      clock: () => at,
      currentScope(expected) {
        if (++reads === 2) at++;
        return expected;
      },
    },
  );
});
