import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  createManagedStandaloneRequestGuard,
  createStandaloneRequestGuard,
  standaloneJson,
} from "../packages/identity/src/standalone-request-guard.ts";
import { executeStandaloneWorkspaceBootstrap } from "../packages/identity/src/standalone-workspace-bootstrap.ts";
import { identitySql } from "../packages/identity/src/index.ts";

const origin = "https://workspace.example.test";
const configuration = JSON.stringify({ schemaVersion: 1, mode: "https", origin });
const secret = Buffer.alloc(32, 27).toString("base64url");
const token = Buffer.alloc(32, 31).toString("base64url");
const command = "e519ea9d-c5eb-4613-906c-26a870c0e9e8";
const digest = (text) => createHash("sha256").update(text).digest("hex");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function request(change = {}) {
  const { path = "/workspace/workspace_a/bootstrap", headers = {}, ...options } = change;
  return new Request(origin + path, {
    headers: { Cookie: `__Host-morrow_session=${secret}`, ...headers },
    ...options,
  });
}
function mutation(change = {}) {
  return request({
    path: "/workspace/workspace_a/store-links/preview",
    method: "POST",
    body: JSON.stringify({ handoffToken: token }),
    ...change,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      "Idempotency-Key": command,
      ...change.headers,
    },
  });
}
async function execute(guard, input, route, callback, before) {
  const owner = guard.begin(input);
  try {
    before?.(owner.attempt);
    return await owner.handle(route, callback);
  } finally {
    owner.attempt.end();
  }
}
function replaceCrypto(name, implementation) {
  const subtle = crypto.subtle;
  const own = Object.getOwnPropertyDescriptor(subtle, name);
  const original = subtle[name].bind(subtle);
  Object.defineProperty(subtle, name, { configurable: true, value: implementation(original) });
  return () => {
    if (own) Object.defineProperty(subtle, name, own);
    else delete subtle[name];
  };
}

test("managed parser keeps its original entry deadline across setup and independent HMAC derivation", async () => {
  let at = 100000;
  const guard = createManagedStandaloneRequestGuard(configuration, () => at);
  const response = await execute(
    guard,
    mutation(),
    "preview",
    async (context) => {
      assert.equal(context.control.deadlineMs, 105000);
      assert.equal(context.sessionDigest, digest(secret));
      assert.equal(context.nonceDigest, digest(token));
      assert.equal(context.commandId, command);
      assert.equal(
        context.csrfToken,
        createHmac("sha256", Buffer.from(secret, "base64url"))
          .update(JSON.stringify(["morrow.store-links.csrf", 1, "workspace_a", command, token]))
          .digest("base64url"),
      );
      return standaloneJson(200, { ok: true });
    },
    () => {
      at = 104000;
    },
  );
  assert.equal(response.status, 200);
});

const parityCases = [
  ["canonical bootstrap", () => request(), "bootstrap", 200],
  ["missing cookie", () => request({ headers: { Cookie: "" } }), "bootstrap", 401],
  [
    "duplicate cookie",
    () =>
      request({
        headers: { Cookie: `__Host-morrow_session=${secret};__Host-morrow_session=${secret}` },
      }),
    "bootstrap",
    401,
  ],
  ["query", () => request({ path: "/workspace/workspace_a/bootstrap?x=1" }), "bootstrap", 403],
  ["encoded id", () => request({ path: "/workspace/%77orkspace_a/bootstrap" }), "bootstrap", 404],
  [
    "extra path",
    () => request({ path: "/workspace/workspace_a/bootstrap/extra" }),
    "bootstrap",
    404,
  ],
  ["wrong method", () => request({ method: "POST", body: "{}" }), "bootstrap", 405],
  [
    "foreign origin",
    () => request({ headers: { Origin: "https://foreign.example.test" } }),
    "bootstrap",
    403,
  ],
  ["foreign host", () => request({ headers: { Host: "foreign.example.test" } }), "bootstrap", 403],
  ["same site", () => request({ headers: { "Sec-Fetch-Site": "same-site" } }), "bootstrap", 403],
  ["bearer", () => request({ headers: { Authorization: "Bearer fake" } }), "bootstrap", 401],
  ["canonical preview", () => mutation(), "preview", 200],
  ["missing marker", () => mutation({ headers: { "X-Morrow-Request": "" } }), "preview", 403],
  [
    "extra body field",
    () => mutation({ body: JSON.stringify({ handoffToken: token, role: "owner" }) }),
    "preview",
    400,
  ],
  [
    "duplicate body field",
    () => mutation({ body: `{"handoffToken":"${token}","handoffToken":"${token}"}` }),
    "preview",
    400,
  ],
  ["invalid UTF8", () => mutation({ body: new Uint8Array([255]) }), "preview", 400],
  [
    "bad CSRF",
    () =>
      mutation({
        path: "/workspace/workspace_a/store-links",
        headers: { "X-Morrow-CSRF": secret },
      }),
    "apply",
    403,
  ],
];
for (const [name, build, route, status] of parityCases) {
  test("managed and legacy guard preserve route/status policy: " + name, async () => {
    let legacyCalls = 0,
      managedCalls = 0;
    const legacy = createStandaloneRequestGuard(configuration, () => 100000);
    const managed = createManagedStandaloneRequestGuard(configuration, () => 100000);
    const left = await legacy.handle(build(), route, async () => {
      legacyCalls++;
      return standaloneJson(200, { ok: true });
    });
    const right = await execute(managed, build(), route, async () => {
      managedCalls++;
      return standaloneJson(200, { ok: true });
    });
    assert.equal(left.status, status);
    assert.equal(right.status, status);
    assert.equal(await left.text(), await right.text());
    assert.equal(left.headers.get("allow"), right.headers.get("allow"));
    assert.equal(managedCalls, legacyCalls);
    if (status !== 200) assert.equal(managedCalls, 0);
    assert.equal(right.headers.has("set-cookie"), false);
  });
}

test("managed guard neither ends its supplied attempt nor permits a second execution", async () => {
  const guard = createManagedStandaloneRequestGuard(configuration, () => 100000);
  const owner = guard.begin(request());
  let called = 0;
  try {
    assert.equal(
      (
        await owner.handle("bootstrap", async () => {
          called++;
          return standaloneJson(200, {});
        })
      ).status,
      200,
    );
    assert.equal(owner.attempt.check(), 100000);
    assert.equal(owner.attempt.control().signal.aborted, false);
    assert.equal(
      (
        await owner.handle("bootstrap", async () => {
          called++;
          return standaloneJson(200, {});
        })
      ).status,
      503,
    );
    assert.equal(called, 1);
  } finally {
    owner.attempt.end();
  }
  assert.equal(owner.attempt.control().signal.aborted, true);
});

test("managed sticky backwards-clock denial survives between requests", async () => {
  let at = 100000;
  const guard = createManagedStandaloneRequestGuard(configuration, () => at);
  assert.equal(
    (await execute(guard, request(), "bootstrap", async () => standaloneJson(200, {}))).status,
    200,
  );
  at = 99999;
  assert.throws(() => guard.begin(request()));
  at = 100001;
  assert.throws(() => guard.begin(request()));
});

test("setup cannot renew the deadline or start a digest after entry expiry", async () => {
  let at = 100000,
    cryptoCalls = 0,
    callbacks = 0;
  const restore = replaceCrypto("digest", (original) => (...args) => {
    cryptoCalls++;
    return original(...args);
  });
  try {
    const guard = createManagedStandaloneRequestGuard(configuration, () => at);
    const response = await execute(
      guard,
      request(),
      "bootstrap",
      async () => {
        callbacks++;
        return standaloneJson(200, {});
      },
      () => {
        at = 105000;
      },
    );
    assert.equal(response.status, 503);
    assert.equal(cryptoCalls, 0);
    assert.equal(callbacks, 0);
  } finally {
    restore();
  }
});

for (const late of [false, true]) {
  test(
    "managed crypto wipes its owned result " +
      (late ? "after caller unwind" : "across wait postcheck expiry"),
    async () => {
      let at = 100000,
        release,
        input,
        calls = 0;
      const abort = new AbortController();
      const output = new Uint8Array(32).fill(77);
      const restore = replaceCrypto("digest", () => (_algorithm, bytes) => {
        input = bytes;
        return new Promise((resolve) => {
          release = () => resolve(output.buffer);
        });
      });
      try {
        const guard = createManagedStandaloneRequestGuard(configuration, () => at);
        const response = execute(
          guard,
          request({ signal: abort.signal }),
          "bootstrap",
          async () => {
            calls++;
            return standaloneJson(200, {});
          },
        );
        await tick();
        assert.equal(typeof release, "function");
        if (late) abort.abort();
        else {
          at = 105000;
          release();
        }
        assert.equal((await response).status, 503);
        assert.ok([...input].every((byte) => byte === 0));
        if (late) {
          assert.ok(output.some((byte) => byte !== 0));
          release();
          await tick();
        }
        assert.ok(output.every((byte) => byte === 0));
        assert.equal(calls, 0);
      } finally {
        restore();
      }
    },
  );
}

test("late native Promise rejection after abort stays consumed without later work", async () => {
  let reject,
    called = 0;
  const abort = new AbortController();
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  const restore = replaceCrypto(
    "digest",
    () => () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  process.on("unhandledRejection", listener);
  try {
    const guard = createManagedStandaloneRequestGuard(configuration, () => 100000);
    const pending = execute(guard, request({ signal: abort.signal }), "bootstrap", async () => {
      called++;
      return standaloneJson(200, {});
    });
    await tick();
    abort.abort();
    assert.equal((await pending).status, 503);
    reject(Error("synthetic late crypto rejection"));
    await tick();
    await tick();
    assert.deepEqual(unhandled, []);
    assert.equal(called, 0);
  } finally {
    restore();
    process.off("unhandledRejection", listener);
  }
});

test("real WebCrypto key import expiry prevents signing or domain execution", async () => {
  let at = 100000,
    signs = 0,
    called = 0,
    keyInput;
  const restoreImport = replaceCrypto("importKey", (original) => (...args) => {
    keyInput = args[1];
    return original(...args).then((key) => {
      at = 105000;
      return key;
    });
  });
  const restoreSign = replaceCrypto("sign", (original) => (...args) => {
    signs++;
    return original(...args);
  });
  try {
    const guard = createManagedStandaloneRequestGuard(configuration, () => at);
    const response = await execute(guard, mutation(), "preview", async () => {
      called++;
      return standaloneJson(200, {});
    });
    assert.equal(response.status, 503);
    assert.ok([...keyInput].every((byte) => byte === 0));
    assert.equal(signs, 0);
    assert.equal(called, 0);
  } finally {
    restoreSign();
    restoreImport();
  }
});

test("an invoked managed mutation interrupted at D remains outcome_unknown", async () => {
  let at = 100000;
  const guard = createManagedStandaloneRequestGuard(configuration, () => at);
  const csrf = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(JSON.stringify(["morrow.store-links.csrf", 1, "workspace_a", command, token]))
    .digest("base64url");
  const response = await execute(
    guard,
    mutation({ path: "/workspace/workspace_a/store-links", headers: { "X-Morrow-CSRF": csrf } }),
    "apply",
    async () => {
      at = 105000;
      return standaloneJson(200, { outcome: "applied" });
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { schemaVersion: 1, outcome: "outcome_unknown" });
});

test("unchanged bootstrap SQL owner consumes the one original managed control", async () => {
  let at = 100000;
  const guard = createManagedStandaloneRequestGuard(configuration, () => at);
  const contextRow = {
    principal_id: "human_a",
    organization_id: "org_a",
    workspace_id: "workspace_a",
    membership_id: "membership_a",
    policy_revision: "1",
  };
  const queries = [],
    releases = [];
  const pool = {
    async connect(control) {
      assert.equal(control.deadlineMs, 105000);
      return {
        async query(text, values, active) {
          assert.equal(active.deadlineMs, 105000);
          assert.equal(active.signal, control.signal);
          queries.push(text);
          if (text === identitySql.role)
            return {
              rows: [
                {
                  role: "morrow_api",
                  login: "morrow_api",
                  rolsuper: false,
                  rolbypassrls: false,
                  rolcreatedb: false,
                  rolcreaterole: false,
                  owner_member: false,
                },
              ],
            };
          if (text === identitySql.resolve) return { rows: [contextRow] };
          if (text === identitySql.workspace)
            return {
              rows: [{ id: "workspace_a", organization_id: "org_a", display_name: "Synthetic A" }],
            };
          if (text === identitySql.workspaceAuthority)
            return { rows: [{ ...contextRow, grants: [] }] };
          return { rows: [] };
        },
        async release(discard) {
          releases.push(discard);
        },
      };
    },
  };
  const response = await execute(
    guard,
    request(),
    "bootstrap",
    (context) => executeStandaloneWorkspaceBootstrap(pool, context),
    () => {
      at = 104000;
    },
  );
  assert.equal(response.status, 200);
  assert.equal(queries.at(-1), identitySql.commit);
  assert.deepEqual(releases, [true]);
  assert.equal(response.headers.has("set-cookie"), false);
});
