import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createWorkosOperatorController,
  validateWorkosOperatorActivation,
} from "../scripts/workos-operator-controller.mjs";
import {
  createWorkosOperatorJournal,
  inspectWorkosOperatorJournal,
} from "../scripts/workos-operator-journal.mjs";

const hash = (v) => createHash("sha256").update(v).digest("hex");
const profileJson = await fs.readFile(
  new URL("../docs/decisions/workos-operator-qualification.json", import.meta.url),
  "utf8",
);
const p = JSON.parse(profileJson);
const bindingJson = JSON.stringify({
  bindingId: p.binding_id,
  bindingRevision: p.binding_revision,
  environmentId: p.environment_id,
  applicationId: p.application_id,
  clientId: p.client_id,
  redirectUri: p.origin + p.callback_path,
  returnPath: p.return_path,
});
const scope = {
  schemaVersion: 1,
  planSequence: 70,
  planDigest: "a".repeat(64),
  sourceDigest: "b".repeat(64),
  profileDigest: hash(profileJson),
  bindingDigest: hash(bindingJson),
  profileJson,
  bindingJson,
};
async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "morrow-workos-test-")));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const meta = await fs.stat(root, { bigint: true });
  let time = Date.now();
  const activation = {
    schemaVersion: 1,
    mode: "synthetic",
    operationId: randomUUID(),
    activationId: randomUUID(),
    beginCommandId: randomUUID(),
    callbackCommandId: randomUUID(),
    planSequence: 70,
    planDigest: scope.planDigest,
    sourceDigest: scope.sourceDigest,
    profileDigest: scope.profileDigest,
    bindingDigest: scope.bindingDigest,
    environmentId: p.environment_id,
    applicationId: p.application_id,
    clientId: p.client_id,
    bindingId: p.binding_id,
    bindingRevision: 1,
    ownerUid: process.getuid(),
    rootDevice: String(meta.dev),
    rootInode: String(meta.ino),
    expiresAt: new Date(time + 300000).toISOString(),
    tokenEndpoint: p.token_endpoint,
    maxInitiations: 1,
    maxPosts: 1,
    ownerApproved: true,
    callbackRegistered: true,
    cleanupBaseline: true,
    ...options.activation,
  };
  const state = randomBytes(32).toString("base64url"),
    browserProof = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url"),
    challengeId = randomUUID(),
    admissionId = randomUUID();
  const material = {
    state,
    browserProof,
    verifier,
    challengeId,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    codeChallengeMethod: "S256",
  };
  const calls = { begin: 0, admit: 0, reconcile: 0, post: 0, current: 0 };
  const admission = {
    async begin() {
      calls.begin++;
      return material;
    },
    async admit() {
      calls.admit++;
      return { outcome: "newly_reserved", admissionId, commandId: activation.callbackCommandId };
    },
    async reconcile() {
      calls.reconcile++;
      return { outcome: "held", admissionId, commandId: activation.callbackCommandId };
    },
    ...options.admission,
  };
  const transport = {
    mode: "synthetic",
    async exchangeOnce() {
      calls.post++;
      return {
        outcome: "response_shape_received",
        category: "response_shape_received",
        statusClass: "2xx",
        providerSessionCleanup: "unknown",
      };
    },
    ...options.transport,
  };
  let scopeJson = JSON.stringify(scope);
  const config = {
    scopeJson,
    activationJson: JSON.stringify(activation),
    journalRoot: root,
    admission,
    transport,
    currentScope: async () => {
      calls.current++;
      return scopeJson;
    },
    clock: () => time,
    journalFault: options.journalFault,
  };
  return {
    root,
    activation,
    calls,
    material,
    config,
    admission,
    transport,
    setTime(v) {
      time = v;
    },
    time: () => time,
    setScope(v) {
      scopeJson = JSON.stringify(v);
    },
    callback: (code = "synthetic opaque code+%/雪") =>
      JSON.stringify({ state, browserProof, code }),
    create: async () => {
      const controller = await createWorkosOperatorController(config);
      t.after(() => controller.close());
      return controller;
    },
  };
}
test("qualified fresh controller uses real durability order and preserves secret-free records", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  assert.equal(c.status().state, "ready");
  assert.equal(f.calls.begin, 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, "claim.json"))).record, "claim");
  const started = await c.start();
  assert.deepEqual(Object.keys(started).sort(), [
    "authorizationUrl",
    "browserProof",
    "expiresAt",
    "state",
  ]);
  assert.equal(new URL(started.authorizationUrl).origin, "https://api.workos.com");
  assert.equal(
    new URL(started.authorizationUrl).searchParams.get("code_challenge"),
    f.material.codeChallenge,
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(f.root, "initiation_started.json"))).challengeId,
    f.material.challengeId,
  );
  const beforePost = f.transport.exchangeOnce;
  f.transport.exchangeOnce = async (...args) => {
    assert.equal(
      JSON.parse(await fs.readFile(path.join(f.root, "send_requested.json"))).codeDigest,
      hash("synthetic opaque code+%/雪"),
    );
    return beforePost(...args);
  };
  assert.equal((await c.complete(f.callback())).state, "response_shape_received");
  assert.deepEqual(f.calls, { begin: 1, admit: 1, reconcile: 2, post: 1, current: 8 });
  const saved = (
    await Promise.all(
      (await fs.readdir(f.root)).map((n) => fs.readFile(path.join(f.root, n), "utf8")),
    )
  ).join("");
  for (const secret of [
    f.material.state,
    f.material.browserProof,
    f.material.verifier,
    "synthetic opaque code+%/雪",
  ])
    assert.equal(saved.includes(secret), false);
  assert.equal((await inspectWorkosOperatorJournal(f.root)).state, "held");
  assert.equal((await f.create()).status().state, "held");
  assert.equal(f.calls.post, 1);
});
for (const flag of ["ownerApproved", "callbackRegistered", "cleanupBaseline"])
  test(`absent ${flag} holds before journal SQL or network`, async (t) => {
    const f = await fixture(t, { activation: { [flag]: false } }),
      c = await f.create();
    assert.equal(c.status().state, "held");
    assert.deepEqual(await fs.readdir(f.root), []);
    assert.equal(f.calls.current, 0);
    await assert.rejects(c.start(), { code: "WORKOS_OPERATOR_HELD" });
    assert.equal(f.calls.begin + f.calls.post, 0);
  });
test("closed primitive scope and activation reject getters/proxies without reading them", async (t) => {
  const f = await fixture(t);
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
    },
  );
  for (const value of [hostile, {}, null, JSON.stringify({ ...scope, unknown: true }), "{"])
    await assert.rejects(createWorkosOperatorController({ ...f.config, scopeJson: value }), {
      code: "WORKOS_OPERATOR_INPUT_INVALID",
    });
  assert.throws(() => validateWorkosOperatorActivation(f.config.scopeJson, hostile), {
    code: "WORKOS_OPERATOR_INPUT_INVALID",
  });
  assert.equal(traps, 0);
});
test("wrong closure selectors root owner identity and mode cannot claim", async (t) => {
  for (const change of [
    { sourceDigest: "c".repeat(64) },
    { clientId: "foreign" },
    { rootInode: "0" },
    { ownerUid: process.getuid() + 1 },
    { mode: "native" },
  ]) {
    const f = await fixture(t, { activation: change });
    try {
      assert.equal((await f.create()).status().state, "held");
    } catch (error) {
      assert.equal(error.code, "WORKOS_OPERATOR_INPUT_INVALID");
    }
    assert.equal(f.calls.begin + f.calls.post, 0);
  }
});
test("start and first locally valid callback latch before await", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  const first = c.start();
  await assert.rejects(c.start());
  await first;
  assert.throws(
    () =>
      c.complete(
        JSON.stringify({
          state: "A".repeat(43),
          browserProof: f.material.browserProof,
          code: "wrong",
        }),
      ),
    { code: "WORKOS_OPERATOR_INPUT_INVALID" },
  );
  let release;
  f.admission.admit = async () => {
    f.calls.admit++;
    await new Promise((r) => (release = r));
    return {
      outcome: "newly_reserved",
      admissionId: randomUUID(),
      commandId: f.activation.callbackCommandId,
    };
  };
  const pending = c.complete(f.callback());
  assert.throws(() => c.complete(f.callback()), { code: "WORKOS_OPERATOR_INPUT_INVALID" });
  await new Promise((r) => setImmediate(r));
  release();
  await pending;
  assert.equal(f.calls.admit, 1);
  assert.equal(f.calls.post, 0);
});
test("malformed and boxed callback data cannot consume the valid callback", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  await c.start();
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error();
      },
      ownKeys() {
        traps++;
        throw Error();
      },
    },
  );
  for (const v of [
    hostile,
    {},
    "{",
    JSON.stringify({
      state: f.material.state,
      browserProof: f.material.browserProof,
      code: "\ud800",
    }),
    JSON.stringify({
      state: f.material.state,
      browserProof: f.material.browserProof,
      code: "x",
      extra: true,
    }),
    JSON.stringify({
      state: f.material.state,
      browserProof: f.material.browserProof,
      code: "x".repeat(4097),
    }),
  ])
    assert.throws(() => c.complete(v), { code: "WORKOS_OPERATOR_INPUT_INVALID" });
  assert.equal(traps, 0);
  assert.equal(f.calls.admit, 0);
  assert.equal((await c.complete(f.callback())).state, "response_shape_received");
});
for (const outcome of ["held", "denied", "conflict", "uncertain"])
  test(`SQL ${outcome} never produces send marker`, async (t) => {
    const f = await fixture(t),
      c = await f.create();
    await c.start();
    f.admission.admit = async () => {
      if (outcome === "uncertain") throw Error("sensitive error");
      return { outcome, admissionId: null, commandId: f.activation.callbackCommandId };
    };
    assert.equal((await c.complete(f.callback())).state, "held");
    assert.equal(f.calls.post, 0);
    assert.equal((await fs.readdir(f.root)).includes("send_requested.json"), false);
  });
test("SQL begin acknowledgement loss keeps claim held without exposing initiation", async (t) => {
  const f = await fixture(t, {
      admission: {
        async begin() {
          throw Error("raw-secret");
        },
      },
    }),
    c = await f.create();
  await assert.rejects(c.start(), { code: "WORKOS_OPERATOR_HELD" });
  assert.deepEqual(await fs.readdir(f.root), ["claim.json"]);
  assert.equal((await f.create()).status().state, "held");
});
test("read-only admission/config recheck must identify original reservation", async (t) => {
  for (const kind of ["missing", "different", "throw", "drift"]) {
    const f = await fixture(t),
      c = await f.create();
    await c.start();
    if (kind === "drift") f.setScope({ ...scope, sourceDigest: "c".repeat(64) });
    else
      f.admission.reconcile = async () => {
        if (kind === "throw") throw Error();
        return {
          outcome: "held",
          admissionId: kind === "missing" ? null : randomUUID(),
          commandId: f.activation.callbackCommandId,
        };
      };
    assert.equal((await c.complete(f.callback())).state, "held");
    assert.equal(f.calls.post, 0);
  }
});
test("expiry after asynchronous reservation or send marker prevents POST", async (t) => {
  for (const stage of ["reservation", "marker"]) {
    let f;
    f = await fixture(t, {
      journalFault: async (name, phase) => {
        if (
          stage === "marker" &&
          name === "send_requested.json" &&
          phase === "after_directory_sync"
        )
          f.setTime(f.time() + 300001);
      },
    });
    const c = await f.create();
    await c.start();
    if (stage === "reservation") {
      const prior = f.admission.admit;
      f.admission.admit = async () => {
        const r = await prior();
        f.setTime(f.time() + 300001);
        return r;
      };
    }
    assert.equal((await c.complete(f.callback())).state, "held");
    assert.equal(f.calls.post, 0);
  }
});
for (const name of [
  "claim.json",
  "initiation_started.json",
  "send_requested.json",
  "observation.json",
])
  for (const phase of [
    "before_open",
    "after_open",
    "after_write",
    "after_file_sync",
    "after_close",
    "after_directory_sync",
  ])
    test(`filesystem uncertainty ${name} ${phase} yields no fresh handle`, async (t) => {
      const f = await fixture(t, {
          journalFault: async (n, p) => {
            if (n === name && p === phase) throw Error("synthetic io acknowledgement loss");
          },
        }),
        c = await f.create();
      if (name === "claim.json") assert.equal(c.status().state, "held");
      else if (name === "initiation_started.json")
        await assert.rejects(c.start(), { code: "WORKOS_OPERATOR_HELD" });
      else {
        await c.start();
        assert.equal((await c.complete(f.callback())).state, "held");
        assert.throws(() => c.complete(f.callback()));
      }
      assert.equal(f.calls.post, name === "observation.json" ? 1 : 0);
      if ((await fs.readdir(f.root)).length)
        assert.equal((await f.create()).status().state, "held");
    });
test("authorization error is final redacted observation without admission or POST", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  await c.start();
  const pending = c.authorizationNotCompleted(
    JSON.stringify({ state: f.material.state, browserProof: f.material.browserProof }),
  );
  assert.throws(() => c.complete(f.callback()));
  assert.equal((await pending).state, "authorization_not_completed");
  assert.equal(f.calls.admit + f.calls.post, 0);
});
test("transport failure and malformed response are held without retry or leaked data", async (t) => {
  for (const response of ["throw", "malformed", "rejected"]) {
    const f = await fixture(t),
      c = await f.create();
    await c.start();
    f.transport.exchangeOnce = async () => {
      f.calls.post++;
      if (response === "throw") throw Error("raw-provider-secret");
      if (response === "malformed") return { token: "secret" };
      return {
        outcome: "held",
        category: "http_rejected",
        statusClass: "4xx",
        providerSessionCleanup: "unknown",
      };
    };
    assert.equal((await c.complete(f.callback())).state, "held");
    assert.equal(f.calls.post, 1);
    assert.equal((await f.create()).status().state, "held");
  }
});
test("unsafe files directories links and a partial marker are held without SQL", async (t) => {
  for (const kind of ["directory_mode", "symlink", "hardlink", "partial", "late_marker"]) {
    const f = await fixture(t);
    if (kind === "directory_mode") await fs.chmod(f.root, 0o755);
    if (kind === "partial")
      await fs.writeFile(path.join(f.root, "claim.json"), "{", { mode: 0o600 });
    if (kind === "late_marker")
      await fs.writeFile(path.join(f.root, "send_requested.json"), "{}", { mode: 0o600 });
    if (kind === "symlink") {
      await fs.writeFile(path.join(f.root, "other"), "{}", { mode: 0o600 });
      await fs.symlink(path.join(f.root, "other"), path.join(f.root, "claim.json"));
    }
    if (kind === "hardlink") {
      await fs.writeFile(path.join(f.root, "other"), "{}", { mode: 0o600 });
      await fs.link(path.join(f.root, "other"), path.join(f.root, "claim.json"));
    }
    assert.equal((await f.create()).status().state, "held");
    assert.equal(f.calls.begin, 0);
    assert.equal((await inspectWorkosOperatorJournal(f.root)).state, "held");
  }
});
test("inspection is read-only and cannot reconstruct a private send handle", async (t) => {
  const f = await fixture(t);
  assert.equal((await inspectWorkosOperatorJournal(f.root)).state, "empty");
  assert.deepEqual(await fs.readdir(f.root), []);
  const journal = await createWorkosOperatorJournal(f.root, f.config.activationJson);
  await journal.markInitiationStarted(
    JSON.stringify({
      beginCommandId: randomUUID(),
      challengeId: randomUUID(),
      expiresAt: new Date().toISOString(),
    }),
  );
  const handle = await journal.markSendRequested(
    JSON.stringify({
      callbackCommandId: randomUUID(),
      challengeId: randomUUID(),
      admissionId: randomUUID(),
      codeDigest: "a".repeat(64),
      requestDigest: "b".repeat(64),
    }),
  );
  await assert.rejects(journal.consumeSend({}));
  await assert.rejects(journal.consumeSend(JSON.parse(JSON.stringify(handle))));
  await journal.consumeSend(handle);
  await assert.rejects(journal.consumeSend(handle));
  await journal.hold();
  const before = await fs.readFile(path.join(f.root, "send_requested.json"), "utf8");
  assert.equal((await inspectWorkosOperatorJournal(f.root)).state, "held");
  assert.equal(await fs.readFile(path.join(f.root, "send_requested.json"), "utf8"), before);
});
test("post-marker recheck detects changed bytes and byte-identical inode replacement", async (t) => {
  for (const kind of ["bytes", "inode", "root"]) {
    const f = await fixture(t),
      c = await f.create();
    await c.start();
    const prior = f.admission.reconcile;
    let reads = 0;
    f.admission.reconcile = async () => {
      const result = await prior();
      if (++reads === 2) {
        const file = path.join(f.root, "send_requested.json");
        if (kind === "bytes") await fs.appendFile(file, " ");
        if (kind === "inode") {
          const text = await fs.readFile(file);
          await fs.writeFile(file + ".replacement", text, { mode: 0o600 });
          await fs.rename(file + ".replacement", file);
        }
        if (kind === "root") {
          const previous = f.root + "-previous";
          await fs.rename(f.root, previous);
          await fs.mkdir(f.root, { mode: 0o700 });
          t.after(() => fs.rm(previous, { recursive: true, force: true }));
        }
      }
      return result;
    };
    assert.equal((await c.complete(f.callback())).state, "held");
    assert.equal(f.calls.post, 0);
  }
});
test("journal payloads are closed primitive commitments and cannot overwrite envelope fields", async (t) => {
  const f = await fixture(t),
    journal = await createWorkosOperatorJournal(f.root, f.config.activationJson);
  for (const payload of [
    {},
    JSON.stringify({
      beginCommandId: randomUUID(),
      challengeId: randomUUID(),
      expiresAt: new Date().toISOString(),
      record: "fake",
      code: "raw",
    }),
  ])
    await assert.rejects(journal.markInitiationStarted(payload));
  assert.deepEqual(await fs.readdir(f.root), ["claim.json"]);
  await journal.hold();
});
test("independent concurrent processes share one fixed irreversible claim", async (t) => {
  const f = await fixture(t);
  const url = new URL("../scripts/workos-operator-journal.mjs", import.meta.url).href;
  const child = () =>
    new Promise((resolve, reject) => {
      const p = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {createWorkosOperatorJournal} from ${JSON.stringify(url)};let input='';for await(const c of process.stdin)input+=c;const {root,activation}=JSON.parse(input);try{const j=await createWorkosOperatorJournal(root,activation);await j.hold();process.stdout.write('won');}catch{process.stdout.write('held');}`,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let out = "",
        err = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (err += c));
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0 && err === "" ? resolve(out) : reject(Error("CHILD_FAILED")),
      );
      p.stdin.end(JSON.stringify({ root: f.root, activation: f.config.activationJson }));
    });
  const results = await Promise.all([child(), child(), child(), child()]);
  assert.equal(results.filter((v) => v === "won").length, 1);
  assert.equal(results.filter((v) => v === "held").length, 3);
  assert.equal((await f.create()).status().state, "held");
});
test("closing during pending admission prevents later send and retains the claim", async (t) => {
  const f = await fixture(t),
    c = await f.create();
  await c.start();
  let resume;
  const original = f.admission.admit;
  f.admission.admit = async () => {
    await new Promise((r) => (resume = r));
    return original();
  };
  const pending = c.complete(f.callback());
  await new Promise((r) => setImmediate(r));
  assert.equal((await c.close()).state, "held");
  resume();
  assert.equal((await pending).state, "held");
  assert.equal(f.calls.post, 0);
  assert.equal((await f.create()).status().state, "held");
});
