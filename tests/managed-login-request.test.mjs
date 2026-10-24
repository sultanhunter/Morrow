import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createLoginAttempt,
  parseLoginConfiguration,
  parseLoginConfigurationWithAttempt,
} from "../packages/identity/src/standalone-login-protocol.ts";
import {
  createWorkersManagedLoginHandler,
  snapshotManagedLoginResponseMetrics,
} from "../packages/identity/src/managed-login-request.ts";
import { createStandaloneLoginFixture } from "../scripts/fixtures/standalone-login-fixture.ts";
import { buildWorkosAuthenticationEvidenceFixture } from "./fixtures/workos-authentication-evidence.mjs";
import { runControlledPreauth } from "../packages/identity/src/login-preauth-control.ts";

// Real crypto is used throughout. Fake ctx/denying broker tests here are CPU
// composition evidence, never a claim about native request lifetime or SQL.
const native = buildWorkosAuthenticationEvidenceFixture();
const fixed = createStandaloneLoginFixture({ ...native, page: native.page() });
const configurationJson = fixed.configurationJson;
const configuration = await parseLoginConfiguration(configurationJson);
const origin = configuration.origin;
const epoch = native.at;
const bindingJson = JSON.stringify({
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-managed-unit",
  branchId: "br-managed-unit",
  hostname: "ep-managed-unit.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
});
const tick = () => new Promise((done) => setImmediate(done));
function keyring(change = {}) {
  const keyId = randomUUID();
  return JSON.stringify({
    schemaVersion: 1,
    purpose: "morrow.login.capsule/1",
    configurationDigest: configuration.configurationDigest,
    currentKeyId: keyId,
    versions: [
      {
        keyId,
        material: randomBytes(32).toString("base64url"),
        encryptFromMs: epoch - 1000,
        encryptUntilMs: epoch + 600000,
        decryptUntilMs: epoch + 900000,
      },
    ],
    ...change,
  });
}
function fixture(change = {}) {
  let now = epoch;
  const borrows = [],
    registered = [],
    calls = [];
  const dependencies = {
    configurationJson,
    capsuleKeyringJson: keyring(),
    bindingJson,
    now: () => now,
    credentialBroker: {
      async borrow(namespace, control) {
        borrows.push({ namespace, deadline: control.deadlineMs, aborted: control.signal.aborted });
        throw Error("SYNTHETIC_NO_CREDENTIAL_NO_DIAL");
      },
    },
    providerPort: {
      async exchange() {
        calls.push("exchange");
        throw Error("NO_PROVIDER");
      },
      async readPublicKeyset() {
        calls.push("keys");
        throw Error("NO_PROVIDER");
      },
      async readSessionPage() {
        calls.push("sessions");
        throw Error("NO_PROVIDER");
      },
    },
    ...change,
  };
  const ctx = {
    waitUntil(pending) {
      registered.push(pending);
    },
  };
  return {
    dependencies,
    ctx,
    borrows,
    registered,
    calls,
    setTime(v) {
      now = v;
    },
    async drain() {
      await Promise.allSettled(registered);
    },
  };
}
const request = (path = "/auth/login", signal) =>
  new Request(origin + path, {
    method: path.startsWith("/auth/workos/callback") ? "GET" : "POST",
    headers: { origin, "content-type": "application/json", "x-morrow-request": "1" },
    ...(path.startsWith("/auth/workos/callback")
      ? {}
      : {
          body: JSON.stringify({ schemaVersion: 2 }),
        }),
    ...(signal ? { signal } : {}),
  });
async function heldResponse(handler, f, path) {
  const response = await handler.fetch(request(path), undefined, f.ctx);
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.deepEqual(f.calls, []);
  await f.drain();
  return { response, metrics: snapshotManagedLoginResponseMetrics(response) };
}

test("managed construction is synchronous, inert, frozen and has one method", () => {
  const f = fixture();
  let clockCalls = 0;
  f.dependencies.now = () => {
    clockCalls++;
    return epoch;
  };
  const handler = createWorkersManagedLoginHandler(f.dependencies);
  assert.ok(Object.isFrozen(handler));
  assert.deepEqual(Object.keys(handler), ["fetch"]);
  assert.equal(clockCalls, 0);
  assert.deepEqual(f.borrows, []);
  assert.deepEqual(f.calls, []);
});
test("constructor rejects extra or accessor inputs without invoking a getter", () => {
  const f = fixture();
  assert.throws(
    () => createWorkersManagedLoginHandler({ ...f.dependencies, crypto() {} }),
    /STANDALONE_LOGIN_CONFIGURATION_INVALID/,
  );
  let invoked = false;
  const d = { ...f.dependencies };
  Object.defineProperty(d, "capsuleKeyringJson", {
    get() {
      invoked = true;
      return keyring();
    },
  });
  assert.throws(() => createWorkersManagedLoginHandler(d), /CONFIGURATION_INVALID/);
  assert.equal(invoked, false);
});
test("invalid whole configuration/keyring refuses before broker/provider/cache", async () => {
  for (const change of [
    { configurationJson: "{}" },
    { capsuleKeyringJson: "{}" },
    { capsuleKeyringJson: keyring({ configurationDigest: "f".repeat(64) }) },
  ]) {
    const f = fixture(change),
      handler = createWorkersManagedLoginHandler(f.dependencies);
    const { response, metrics } = await heldResponse(handler, f);
    assert.equal(response.status, 503);
    assert.equal(metrics.cacheResolved, false);
    assert.equal(metrics.scope.publicationAttempts, 0);
    assert.deepEqual(f.borrows, []);
  }
});
test("original begin ceiling reaches broker, then closed response metrics are independent", async () => {
  const f = fixture(),
    handler = createWorkersManagedLoginHandler(f.dependencies);
  const { response, metrics } = await heldResponse(handler, f);
  assert.equal(response.status, 503);
  assert.equal(metrics.enteredAtMs, epoch);
  assert.equal(metrics.initialDeadlineMs, epoch + 25000);
  assert.equal(metrics.finalDeadlineMs, epoch + 5000);
  assert.equal(metrics.attemptEnded, true);
  assert.equal(f.borrows.length, 1);
  assert.equal(f.borrows[0].deadline, epoch + 5000);
  assert.equal(f.borrows[0].aborted, false);
  assert.equal(metrics.cacheHit, false);
  assert.equal(metrics.cacheResolved, true);
  assert.equal(metrics.scope.publicationAccepted, 1);
  assert.ok(Object.isFrozen(metrics));
  assert.ok(Object.isFrozen(metrics.scope));
  assert.throws(() => snapshotManagedLoginResponseMetrics(new Response("foreign")), /HELD/);
  const serialized = JSON.stringify(metrics);
  assert.ok(
    !serialized.includes(JSON.parse(f.dependencies.capsuleKeyringJson).versions[0].material),
  );
  assert.ok(!serialized.includes(f.borrows[0].namespace));
  assert.ok(!serialized.includes(configuration.configurationDigest));
});
test("resolved cache is reused without caching pending request imports or scope", async (t) => {
  const f = fixture(),
    handler = createWorkersManagedLoginHandler(f.dependencies);
  const original = crypto.subtle.importKey;
  let imports = 0;
  crypto.subtle.importKey = function (...args) {
    imports++;
    return Reflect.apply(original, this, args);
  };
  t.after(() => {
    crypto.subtle.importKey = original;
  });
  const a = await heldResponse(handler, f);
  const b = await heldResponse(handler, f);
  assert.equal(imports, 1);
  assert.equal(a.metrics.cacheHit, false);
  assert.equal(b.metrics.cacheHit, true);
  assert.equal(a.metrics.scope.publicationAccepted, 1);
  assert.equal(b.metrics.scope.publicationAccepted, 1);
  assert.equal(a.metrics.scope.publicationAttempts, 1);
  assert.equal(b.metrics.scope.publicationAttempts, 1);
});
for (const path of ["/auth/login", "/auth/workos/callback?code=fixed&state=fixed"])
  test("real cold import cannot restart expired entry budget: " + path, async (t) => {
    const f = fixture(),
      handler = createWorkersManagedLoginHandler(f.dependencies);
    const original = crypto.subtle.importKey;
    let imports = 0;
    crypto.subtle.importKey = function (...args) {
      imports++;
      return Reflect.apply(original, this, args).then((key) => {
        f.setTime(epoch + (path.startsWith("/auth/login") ? 5000 : 25000));
        return key;
      });
    };
    t.after(() => {
      crypto.subtle.importKey = original;
    });
    const { response, metrics } = await heldResponse(handler, f, path);
    assert.equal(response.status, path.startsWith("/auth/login") ? 503 : 303);
    assert.equal(imports, 1, "real native import was invoked");
    assert.equal(metrics.cacheResolved, false);
    assert.deepEqual(f.borrows, []);
  });
test("aborted native import installs no resolved cache or broker work", async (t) => {
  const f = fixture(),
    handler = createWorkersManagedLoginHandler(f.dependencies);
  const abort = new AbortController(),
    original = crypto.subtle.importKey;
  let imported = false;
  crypto.subtle.importKey = function (...args) {
    return Reflect.apply(original, this, args).then((key) => {
      imported = true;
      abort.abort();
      return key;
    });
  };
  t.after(() => {
    crypto.subtle.importKey = original;
  });
  await assert.rejects(
    handler.fetch(request("/auth/login", abort.signal), undefined, f.ctx),
    /HELD/,
  );
  await tick();
  assert.equal(imported, true);
  assert.deepEqual(f.borrows, []);
});
test(
  "concurrent cold requests do not share an import Promise or scope",
  { timeout: 3000 },
  async (t) => {
    const f = fixture(),
      handler = createWorkersManagedLoginHandler(f.dependencies);
    const original = crypto.subtle.importKey;
    const pending = [];
    let admitted;
    const bothImports = new Promise((done) => {
      admitted = done;
    });
    let release;
    const barrier = new Promise((done) => {
      release = done;
    });
    crypto.subtle.importKey = function (...args) {
      const nativeImport = Reflect.apply(original, this, args);
      const owned = nativeImport.then(async (key) => {
        await barrier;
        return key;
      });
      pending.push(owned);
      if (pending.length === 2) admitted();
      return owned;
    };
    t.after(() => {
      release();
      crypto.subtle.importKey = original;
    });
    const a = handler.fetch(request(), undefined, f.ctx);
    const b = handler.fetch(request(), undefined, f.ctx);
    await bothImports;
    assert.equal(pending.length, 2);
    assert.notEqual(pending[0], pending[1]);
    release();
    const pair = await Promise.all([a, b]);
    await f.drain();
    for (const response of pair) {
      const m = snapshotManagedLoginResponseMetrics(response);
      assert.equal(response.status, 503);
      assert.equal(m.cacheHit, false);
      assert.equal(m.scope.publicationAttempts, 1);
    }
  },
);
test("constructor captures full immutable definition, keeping handlers' keys separate", async (t) => {
  const f = fixture(),
    original = crypto.subtle.importKey;
  let imports = 0;
  crypto.subtle.importKey = function (...args) {
    imports++;
    return Reflect.apply(original, this, args);
  };
  t.after(() => {
    crypto.subtle.importKey = original;
  });
  const a = createWorkersManagedLoginHandler(f.dependencies);
  f.dependencies.capsuleKeyringJson = keyring();
  const b = createWorkersManagedLoginHandler(f.dependencies);
  await heldResponse(a, f);
  await heldResponse(b, f);
  assert.equal(imports, 2);
});
test("warm cache cannot revive a backwards trusted clock", async () => {
  const f = fixture(),
    handler = createWorkersManagedLoginHandler(f.dependencies);
  await heldResponse(handler, f);
  const before = f.borrows.length;
  f.setTime(epoch - 1);
  const { response } = await heldResponse(handler, f);
  assert.equal(response.status, 503);
  assert.equal(f.borrows.length, before);
  f.setTime(epoch + 1);
  await heldResponse(handler, f);
  assert.equal(f.borrows.length, before, "clock failure is sticky for this construction");
});
test("ordinary and controlled parser preserve raw-profile configuration transcript", async (t) => {
  const raw = JSON.parse(configurationJson);
  raw.verificationProfileJson = "  " + raw.verificationProfileJson + "\n";
  const text = JSON.stringify(raw);
  const attempt = createLoginAttempt(() => epoch, new AbortController().signal, 5000);
  t.after(() => attempt.end());
  const ordinary = await parseLoginConfiguration(text);
  const controlled = await parseLoginConfigurationWithAttempt(text, attempt);
  assert.deepEqual(controlled, ordinary);
  assert.notEqual(controlled.configurationDigest, configuration.configurationDigest);
  assert.equal(controlled.verificationProfileJson, raw.verificationProfileJson);
});
for (const mode of ["abort", "expiry"])
  test(
    "no second real configuration hash after first digest loses authority: " + mode,
    async (t) => {
      let at = epoch,
        calls = 0;
      const abort = new AbortController();
      const attempt = createLoginAttempt(() => at, abort.signal, 5000);
      const original = crypto.subtle.digest;
      crypto.subtle.digest = function (...args) {
        calls++;
        return Reflect.apply(original, this, args).then((bytes) => {
          if (calls === 1) {
            if (mode === "abort") abort.abort();
            else at = epoch + 5000;
          }
          return bytes;
        });
      };
      t.after(() => {
        crypto.subtle.digest = original;
        attempt.end();
      });
      await assert.rejects(
        parseLoginConfigurationWithAttempt(configurationJson, attempt),
        /CONFIGURATION_INVALID/,
      );
      await tick();
      assert.equal(calls, 1, "the first hash delegates to real WebCrypto; no second invocation");
    },
  );

test("initial wait denial still consumes a later rejection of already-started work", async (t) => {
  const parent = new AbortController();
  const attempt = createLoginAttempt(() => epoch, parent.signal, 5000);
  t.after(() => attempt.end());
  let rejectPending;
  const pending = new Promise((_, reject) => {
    rejectPending = reject;
  });
  parent.abort();
  await assert.rejects(attempt.wait(pending), /STANDALONE_LOGIN_HELD/);
  rejectPending(Error("FIXED_ALREADY_STARTED_LATE_REJECTION"));
  await tick();
  assert.equal(attempt.control().deadlineMs, epoch + 5000);
  assert.equal(parent.signal.aborted, true);
});

test("real callback hash aggregate is sunk when its initial wait loses authority", async (t) => {
  const parent = new AbortController();
  const originalDigest = crypto.subtle.digest;
  let digestCalls = 0;
  let nativeCompletions = 0;
  let abortIssued = false;
  let allCompleted;
  const completed = new Promise((resolve) => {
    allCompleted = resolve;
  });
  const f = fixture({
    now() {
      if (digestCalls === 5 && !abortIssued) {
        abortIssued = true;
        parent.abort();
      }
      return epoch;
    },
  });
  const handler = createWorkersManagedLoginHandler(f.dependencies);
  crypto.subtle.digest = function (...args) {
    const call = ++digestCalls;
    return Reflect.apply(originalDigest, this, args).then((buffer) => {
      nativeCompletions++;
      if (nativeCompletions === 5) allCompleted();
      // Failure-only injection follows an actual native digest. It never
      // supplies a fabricated successful cryptographic result.
      if (call === 5) throw Error("FIXED_CALLBACK_DIGEST_LATE_REJECTION");
      return buffer;
    });
  };
  t.after(() => {
    crypto.subtle.digest = originalDigest;
  });
  const callback = new Request(
    origin + "/auth/workos/callback?code=fixed&state=" + randomBytes(32).toString("base64url"),
    {
      headers: { cookie: "__Host-morrow_login=" + randomBytes(32).toString("base64url") },
      signal: parent.signal,
    },
  );
  await assert.rejects(handler.fetch(callback, undefined, f.ctx), /HELD/);
  await completed;
  await tick();
  assert.equal(digestCalls, 5, "two configuration and three callback hashes actually invoked");
  assert.equal(nativeCompletions, 5);
  assert.equal(abortIssued, true);
  assert.deepEqual(f.borrows, []);
  assert.deepEqual(f.registered, []);
  assert.deepEqual(f.calls, []);
});

test("unchanged preauthentication queued query is sunk after the first wait check aborts", async (t) => {
  const parent = new AbortController();
  let connected = 0,
    queried = 0,
    released = 0,
    checksAfterConnection = 0;
  const attempt = createLoginAttempt(
    () => {
      // Connect's post-await check, query's precheck, then wait's initial check
      // over the original already-created queued query Promise.
      if (connected && ++checksAfterConnection === 3) parent.abort();
      return epoch;
    },
    parent.signal,
    25000,
  );
  t.after(() => attempt.end());
  const pool = {
    async connect() {
      connected++;
      return {
        async query() {
          queried++;
          return { rows: [] };
        },
        async release() {
          released++;
        },
      };
    },
  };
  await assert.rejects(
    runControlledPreauth(pool, configuration.authenticationBindingJson, attempt, (service) =>
      service.begin(JSON.stringify({ commandId: "10500000-0000-4000-8000-000000000001" })),
    ),
    /STANDALONE_LOGIN_PREAUTH_HELD/,
  );
  await tick();
  await tick();
  assert.equal(parent.signal.aborted, true);
  assert.equal(connected, 1);
  assert.equal(queried, 0, "queued work never reaches the synthetic SQL boundary");
  assert.equal(released, 1, "the already-owned handle is disposed exactly once");
  assert.equal(attempt.control().deadlineMs, epoch + 25000);
});
// fix-signin-clock-and-stage-log: Workers Logs attaches the request URL, with WorkOS's code and
// the state, to every line. A callback that fails before claim (setup, input) has asked no pool
// for a connection and so has logged no cleanup event; it emits no stage line either. From
// claim on, the stage line joins the cleanup events the request already logs with that URL.
test("the callback stage line is written only once a pool has published a cleanup", async (t) => {
  const callback = (cookie) =>
    new Request(
      origin + "/auth/workos/callback?code=fixed&state=" + randomBytes(32).toString("base64url"),
      cookie ? { headers: { cookie: "__Host-morrow_login=" + cookie } } : {},
    );
  for (const [name, change, withCookie, expected] of [
    ["setup", { capsuleKeyringJson: "{}" }, true, null],
    ["input", {}, false, null],
    ["claim", {}, true, "claim"],
  ]) {
    const lines = [],
      cleanups = [];
    t.mock.method(console, "log", (line) => lines.push(String(line)));
    t.mock.method(console, "debug", (line) => cleanups.push(String(line)));
    const f = fixture(change),
      handler = createWorkersManagedLoginHandler(f.dependencies);
    const response = await handler.fetch(
      callback(withCookie ? randomBytes(32).toString("base64url") : null),
      undefined,
      f.ctx,
    );
    await f.drain();
    await tick();
    t.mock.restoreAll();
    assert.equal(response.status, 303, name);
    assert.equal(response.headers.get("location"), "/auth/result", name);
    assert.equal(response.headers.getSetCookie().length, 0, name);
    assert.deepEqual(f.calls, [], name);
    const published = snapshotManagedLoginResponseMetrics(response).scope.publicationAttempts;
    assert.equal(cleanups.length, published, name);
    for (const line of cleanups)
      assert.equal(JSON.parse(line).event, "morrow_managed_login_cleanup_settled", name);
    if (expected === null) {
      assert.equal(published, 0, name);
      assert.deepEqual(f.borrows, [], name);
      assert.deepEqual(lines, [], name);
    } else {
      assert.equal(published, 1, name);
      assert.equal(f.borrows.length, 1, name);
      assert.deepEqual(
        lines.map((line) => JSON.parse(line)),
        [{ event: "morrow_login_callback_failed", stage: expected, sub: null, lead: null }],
        name,
      );
    }
  }
});
