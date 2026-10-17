import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createStandaloneLoginBridge } from "../packages/identity/src/standalone-login.ts";
import { createStandaloneLoginFixture } from "../scripts/fixtures/standalone-login-fixture.ts";
import { appliedLegacyLoginControllerProtocol } from "../scripts/fixtures/standalone-login-fixture.mjs";
import { buildWorkosAuthenticationEvidenceFixture } from "./fixtures/workos-authentication-evidence.mjs";
const native = buildWorkosAuthenticationEvidenceFixture();
const origin = "https://workspace.example.test";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fixture(options = {}) {
  const f = createStandaloneLoginFixture({ ...native, page: native.page(), ...options });
  return f;
}
function startRequest(change = {}) {
  return new Request(origin + "/auth/login", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      ...change.headers,
    },
    body: change.body ?? JSON.stringify({ schemaVersion: 1, workspaceId: "workspace_a" }),
    ...(change.signal ? { signal: change.signal } : {}),
  });
}
async function started(bridge) {
  const response = await bridge.fetch(startRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["authorizationUrl", "schemaVersion"]);
  const authorization = new URL(body.authorizationUrl);
  const set = response.headers.getSetCookie();
  assert.equal(set.length, 1);
  return {
    state: authorization.searchParams.get("state"),
    cookie: set[0].split(";")[0],
    response,
    authorization,
  };
}
function callbackRequest(flow, change = {}) {
  return new Request(
    origin + (change.path ?? `/auth/workos/callback?code=synthetic-code&state=${flow.state}`),
    {
      headers: { Cookie: flow.cookie, ...change.headers },
      ...(change.signal ? { signal: change.signal } : {}),
    },
  );
}
test("start → real owning76/77/M composition emits only opaque cookie, then replay never resends", async () => {
  const f = fixture(),
    bridge = await createStandaloneLoginBridge(f),
    flow = await started(bridge);
  assert.equal(
    flow.authorization.origin + flow.authorization.pathname,
    "https://api.workos.com/user_management/authorize",
  );
  assert.deepEqual([...flow.authorization.searchParams.keys()].sort(), [
    "client_id",
    "code_challenge",
    "code_challenge_method",
    "provider",
    "redirect_uri",
    "response_type",
    "state",
  ]);
  const result = await bridge.fetch(callbackRequest(flow));
  assert.equal(result.status, 303);
  assert.equal(result.headers.get("location"), "/");
  const cookies = result.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(
    cookies[0],
    /^__Host-morrow_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=900$/,
  );
  assert.equal(await result.text(), "");
  assert.deepEqual(
    f.external.map((v) => v.kind),
    ["exchange", "keyset", "page"],
  );
  const rows = f.calls.filter((v) => v.role === "sessions" && v.stage === "admit");
  assert.equal(rows.length, 1);
  const secret = cookies[0].split("=")[1].split(";")[0];
  assert.equal(rows[0].values[17], createHash("sha256").update(secret).digest("hex"));
  assert.equal(
    f.releases.every((v) => v.completed),
    true,
  );
  const replay = await bridge.fetch(callbackRequest(flow));
  assert.equal(replay.headers.get("location"), "/auth/result");
  assert.equal(replay.headers.has("set-cookie"), false);
  assert.equal(f.external.length, 3);
});
for (const [name, body] of Object.entries({
  extra: '{"schemaVersion":1,"workspaceId":"workspace_a","role":"admin"}',
  duplicate: '{"schemaVersion":1,"workspaceId":"workspace_a","workspaceId":"workspace_b"}',
  bad_id: '{"schemaVersion":1,"workspaceId":"../admin"}',
  syntax: "{",
  large: " ".repeat(513),
  invalid_utf8: new Uint8Array([255]),
}))
  test("start validation before SQL: " + name, async () => {
    const f = fixture(),
      b = await createStandaloneLoginBridge(f),
      r = await b.fetch(startRequest({ body }));
    assert.equal(r.status, 400);
    assert.equal(r.headers.has("set-cookie"), false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.external.length, 0);
  });
for (const [name, headers] of Object.entries({
  origin: { Origin: "https://evil.example" },
  null_origin: { Origin: "null" },
  marker: { "X-Morrow-Request": "0" },
  site: { "Sec-Fetch-Site": "cross-site" },
  mode: { "Sec-Fetch-Mode": "navigate" },
  dest: { "Sec-Fetch-Dest": "document" },
  bearer: { Authorization: "Bearer private-marker" },
}))
  test("start forbidden headers: " + name, async () => {
    const f = fixture(),
      b = await createStandaloneLoginBridge(f),
      r = await b.fetch(startRequest({ headers }));
    assert.equal(r.status, 403);
    assert.equal(f.calls.length, 0);
    assert.equal(r.headers.has("set-cookie"), false);
  });
for (const [name, path] of Object.entries({
  denial: "/auth/workos/callback?error=access_denied",
  missing: "/auth/workos/callback",
  extra: "/auth/workos/callback?code=x&state=STATE&scope=x",
  duplicate: "/auth/workos/callback?code=x&code=y",
  encoded_key: "/auth/workos/callback?%63ode=x&state=STATE",
  malformed: "/auth/workos/callback?code=%FF&state=STATE",
  fragment: "/auth/workos/callback?code=x&state=STATE#secret",
}))
  test("callback malformed clean redirect without SQL: " + name, async () => {
    const f = fixture(),
      b = await createStandaloneLoginBridge(f),
      r = await b.fetch(new Request(origin + path));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/auth/result");
    assert.equal(r.headers.has("set-cookie"), false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.external.length, 0);
    assert.equal(await r.text(), "");
  });
for (const [name, cookie] of Object.entries({
  missing: "",
  quoted: '__Host-morrow_login="PROOF"',
  duplicate: "__Host-morrow_login=PROOF;__Host-morrow_login=PROOF",
  case: "__host-morrow_login=PROOF",
  encoded: "__Host-morrow_login=%41PROOF",
  padding: "__Host-morrow_login=PROOF=",
}))
  test("callback cookie denial: " + name, async () => {
    const f = fixture(),
      b = await createStandaloneLoginBridge(f),
      flow = await started(b),
      before = f.calls.length;
    const r = await b.fetch(
      callbackRequest(flow, {
        headers: { Cookie: cookie.replaceAll("PROOF", flow.cookie.split("=")[1]) },
      }),
    );
    assert.equal(r.headers.get("location"), "/auth/result");
    assert.equal(r.headers.has("set-cookie"), false);
    assert.equal(f.calls.length, before);
    assert.equal(f.external.length, 0);
  });
test("profile7 revoked during69 reservation denies before every provider port", async () => {
  const f = fixture({
      stage: async (name, state) => {
        if (name === "preauth:admit") state.setEligible(false);
      },
    }),
    b = await createStandaloneLoginBridge(f),
    flow = await started(b),
    r = await b.fetch(callbackRequest(flow));
  assert.equal(r.headers.get("location"), "/auth/result");
  assert.equal(f.external.length, 0);
  assert.equal(f.calls.filter((v) => v.stage === "observeEligibility").length, 1);
});
for (const stage of ["provider:exchange", "provider:keyset"])
  test("current eligibility checked again after " + stage, async () => {
    const f = fixture({
        stage: async (name, state) => {
          if (name === stage) state.setEligible(false);
        },
      }),
      b = await createStandaloneLoginBridge(f),
      flow = await started(b),
      r = await b.fetch(callbackRequest(flow));
    assert.equal(r.headers.get("location"), "/auth/result");
    assert.deepEqual(
      f.external.map((v) => v.kind),
      stage.endsWith("exchange") ? ["exchange"] : ["exchange", "keyset"],
    );
    assert.equal(
      f.calls.some((v) => v.role === "sessions" && v.stage === "admit"),
      false,
    );
  });
for (const field of [
  "ciphertext",
  "encryption_nonce",
  "aad_digest",
  "key_id",
  "workspace_id",
  "expires_at_ms",
])
  test("sealed capsule refuses changed " + field, async () => {
    const values = {
      ciphertext: "A".repeat(202),
      encryption_nonce: "A".repeat(16),
      aad_digest: "a".repeat(64),
      key_id: "10000000-0000-0000-0000-000000000000",
      workspace_id: "workspace_b",
      expires_at_ms: String(native.at + 299000),
    };
    const f = fixture({ claimChange: { [field]: values[field] } }),
      b = await createStandaloneLoginBridge(f),
      flow = await started(b),
      r = await b.fetch(callbackRequest(flow));
    assert.equal(r.headers.get("location"), "/auth/result");
    assert.equal(f.external.length, 0);
    assert.equal(r.headers.has("set-cookie"), false);
  });
test("ephemeral key loss never rebuilds a proof", async () => {
  const f = fixture(),
    first = await createStandaloneLoginBridge(f),
    flow = await started(first),
    second = await createStandaloneLoginBridge(f),
    r = await second.fetch(callbackRequest(flow));
  assert.equal(r.headers.get("location"), "/auth/result");
  assert.equal(f.external.length, 0);
  assert.equal(r.headers.has("set-cookie"), false);
});
for (const stage of ["preauth:begin", "preauth:create", "preauth:admit", "preauth:commit"])
  test("unknown69 query closes before legacy rollback: " + stage, async () => {
    let armed = stage === "preauth:admit" ? false : true;
    const f = fixture({
        stage: async (name) => {
          if (armed && name === stage) throw Error("PRIVATE_SQL_ERROR");
        },
      }),
      b = await createStandaloneLoginBridge(f);
    if (stage === "preauth:admit") {
      const flow = await started(b);
      armed = true;
      await b.fetch(callbackRequest(flow));
    } else await b.fetch(startRequest());
    const first = f.calls.findIndex((v) => v.role + ":" + v.stage === stage);
    assert.ok(first >= 0);
    assert.equal(
      f.calls.slice(first + 1).some((v) => v.role === "preauth"),
      false,
    );
    assert.equal(f.external.length, 0);
    assert.equal(
      f.releases.every((v) => v.completed),
      true,
    );
  });
test("start waits for physical69 disposal before exposing authorization or cookie", async () => {
  const gate = deferred(),
    entered = deferred();
  const f = fixture({
      stage: async (name) => {
        if (name === "preauth:release") {
          entered.resolve();
          await gate.promise;
        }
      },
    }),
    b = await createStandaloneLoginBridge(f);
  let finished = false;
  const pending = b.fetch(startRequest()).then((r) => {
    finished = true;
    return r;
  });
  await entered.promise;
  await tick();
  assert.equal(finished, false);
  gate.resolve();
  assert.equal((await pending).status, 200);
});
test("final expiry after M commit/disposal withholds cookie and does not reissue", async () => {
  const f = fixture({
      stage: async (name, state) => {
        if (name === "sessions:release") state.setTime(native.at + 5001);
      },
    }),
    b = await createStandaloneLoginBridge(f),
    flow = await started(b),
    r = await b.fetch(callbackRequest(flow));
  assert.equal(r.headers.get("location"), "/auth/result");
  assert.equal(r.headers.has("set-cookie"), false);
  assert.equal(f.calls.filter((v) => v.role === "sessions" && v.stage === "admit").length, 1);
});
test("disconnect after M release prevents synchronous transport handoff", async () => {
  const abort = new AbortController();
  const f = fixture({
      stage: async (name) => {
        if (name === "sessions:release") abort.abort();
      },
    }),
    b = await createStandaloneLoginBridge(f),
    flow = await started(b);
  let sinks = 0;
  await b.dispatch(callbackRequest(flow, { signal: abort.signal }), () => {
    sinks++;
  });
  assert.equal(sinks, 0);
  assert.equal(f.calls.filter((v) => v.role === "sessions" && v.stage === "admit").length, 1);
});
test("synchronous sink snapshots immutable output and cannot trigger credential resend", async () => {
  const f = fixture(),
    b = await createStandaloneLoginBridge(f),
    flow = await started(b);
  let sinks = 0;
  await assert.rejects(
    b.dispatch(callbackRequest(flow), (output) => {
      sinks++;
      assert.ok(Object.isFrozen(output));
      assert.ok(Object.isFrozen(output.headers));
      assert.ok(output.headers.every(Object.isFrozen));
      assert.ok(Object.isFrozen(output.cookies));
      assert.equal(output.cookies.length, 1);
      throw Error("TRANSPORT_FAULT");
    }),
    /TRANSPORT_UNKNOWN/,
  );
  assert.equal(sinks, 1);
  const replay = await b.fetch(callbackRequest(flow));
  assert.equal(replay.headers.has("set-cookie"), false);
  assert.equal(f.external.length, 3);
});
test("async sink is unsupported and never invoked twice", async () => {
  const f = fixture(),
    b = await createStandaloneLoginBridge(f);
  let count = 0;
  await assert.rejects(
    b.dispatch(startRequest(), () => {
      count++;
      return Promise.resolve();
    }),
    /TRANSPORT_UNKNOWN/,
  );
  assert.equal(count, 1);
});
test("generic result has no SQL, cookie or reflected query", async () => {
  const f = fixture(),
    b = await createStandaloneLoginBridge(f),
    r = await b.fetch(new Request(origin + "/auth/result"));
  assert.equal(r.status, 200);
  assert.equal(r.headers.has("set-cookie"), false);
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(f.calls.length, 0);
});
for (const stage of [
  "login:claimCallback",
  "login:commit",
  "login:release",
  "preauth:release",
  "sessions:admit",
  "sessions:commit",
  "sessions:release",
])
  test("callback uncertain stage never retries or sends cookie: " + stage, async () => {
    let armed = false,
      hit = false;
    const f = fixture({
        stage: async (name) => {
          if (armed && name === stage && !hit) {
            hit = true;
            throw Error("PRIVATE_UNKNOWN_MARKER");
          }
        },
      }),
      b = await createStandaloneLoginBridge(f),
      flow = await started(b);
    armed = true;
    const r = await b.fetch(callbackRequest(flow));
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/auth/result");
    assert.equal(r.headers.has("set-cookie"), false);
    assert.equal(await r.text(), "");
    assert.equal(hit, true);
    assert.equal(
      f.calls.filter((v) => v.role === "sessions" && v.stage === "admit").length,
      stage.startsWith("sessions") ? 1 : 0,
    );
    assert.ok(f.external.filter((v) => v.kind === "exchange").length <= 1);
    if (stage === "sessions:admit") assert.equal(f.calls.at(-1).stage, "admit");
  });
test("concurrent callbacks can reserve/exchange/issue only once", async () => {
  const gate = deferred(),
    entered = deferred();
  const f = fixture({
      stage: async (name) => {
        if (name === "provider:exchange") {
          entered.resolve();
          await gate.promise;
        }
      },
    }),
    b = await createStandaloneLoginBridge(f),
    flow = await started(b);
  const first = b.fetch(callbackRequest(flow));
  await entered.promise;
  const second = await b.fetch(callbackRequest(flow));
  assert.equal(second.headers.get("location"), "/auth/result");
  assert.equal(second.headers.has("set-cookie"), false);
  gate.resolve();
  assert.equal((await first).headers.get("location"), "/");
  assert.equal(f.external.filter((v) => v.kind === "exchange").length, 1);
  assert.equal(f.calls.filter((v) => v.role === "sessions" && v.stage === "admit").length, 1);
});
test("clock regression before provider prevents dispatch", async () => {
  const f = fixture({
      stage: async (name, state) => {
        if (name === "preauth:admit") state.setTime(native.at - 1);
      },
    }),
    b = await createStandaloneLoginBridge(f),
    flow = await started(b),
    r = await b.fetch(callbackRequest(flow));
  assert.equal(r.headers.get("location"), "/auth/result");
  assert.equal(r.headers.has("set-cookie"), false);
  assert.equal(f.external.length, 0);
});
test("abort in claimed-capsule disposal never reaches69 or provider", async () => {
  const abort = new AbortController();
  let armed = false;
  const f = fixture({
      stage: async (name, state) => {
        if (armed && name === "login:release" && state.flow?.phase === "claimed") abort.abort();
      },
    }),
    b = await createStandaloneLoginBridge(f),
    flow = await started(b);
  armed = true;
  let delivered = 0;
  await b.dispatch(callbackRequest(flow, { signal: abort.signal }), () => {
    delivered++;
  });
  assert.equal(delivered, 0);
  assert.equal(
    f.calls.some((v) => v.role === "preauth" && v.stage === "admit"),
    false,
  );
  assert.equal(f.external.length, 0);
});
test("factory refuses shared pool identity and insecure cookie origin", async () => {
  const f = fixture();
  await assert.rejects(
    createStandaloneLoginBridge({ ...f, sessionPool: f.selectionPool }),
    /CONFIGURATION_INVALID/,
  );
  const c = JSON.parse(f.configurationJson);
  c.origin = "http://127.0.0.1:4110";
  await assert.rejects(
    createStandaloneLoginBridge({ ...f, configurationJson: JSON.stringify(c) }),
    /CONFIGURATION_INVALID/,
  );
});
test("configuration accepts only the morrow-login-v1 controller protocol", async () => {
  const f = fixture(),
    c = JSON.parse(f.configurationJson);
  assert.equal(c.controllerProtocol, "morrow-login-v1");
  // The retired value comes from the applied 0010 bytes; no current source names it.
  for (const controllerProtocol of [
    appliedLegacyLoginControllerProtocol(),
    "morrow-login-v2",
    "MORROW-LOGIN-V1",
    "morrow-login-v1 ",
    "",
  ])
    await assert.rejects(
      createStandaloneLoginBridge({
        ...f,
        configurationJson: JSON.stringify({ ...c, controllerProtocol }),
      }),
      /CONFIGURATION_INVALID/,
    );
  assert.equal(f.external.length, 0);
});
for (const change of [
  JSON.stringify({ schemaVersion: 1, accessToken: "private-marker", authenticated: true }),
  '{"schemaVersion":1,"accessToken":"a","accessToken":"b"}',
  JSON.stringify({ schemaVersion: 1, accessToken: "x".repeat(16385) }),
])
  test("provider projection cannot inject authority or malformed/oversized token", async () => {
    const f = fixture({ exchangeOutput: change }),
      b = await createStandaloneLoginBridge(f),
      flow = await started(b),
      r = await b.fetch(callbackRequest(flow));
    assert.equal(r.headers.get("location"), "/auth/result");
    assert.equal(r.headers.has("set-cookie"), false);
    assert.equal(f.external.length, 1);
    assert.equal(
      f.calls.some((v) => v.role === "sessions" && v.stage === "admit"),
      false,
    );
  });
test("start outputs contain no PKCE verifier/proof and SQL contains no raw protocol secret", async () => {
  const f = fixture(),
    b = await createStandaloneLoginBridge(f),
    flow = await started(b);
  await b.fetch(callbackRequest(flow));
  const exchange = JSON.parse(f.external[0].input);
  const serialized = JSON.stringify(f.calls);
  assert.equal(serialized.includes(exchange.verifier), false);
  assert.equal(serialized.includes("synthetic-code"), false);
  assert.equal(serialized.includes(flow.state), false);
  assert.equal(serialized.includes(flow.cookie.split("=")[1]), false);
  assert.equal(JSON.stringify([...flow.response.headers]).includes(exchange.verifier), false);
});
test("Workers envelope enforces UTF8 header byte budget before SQL", async () => {
  const f = fixture(),
    b = await createStandaloneLoginBridge(f);
  const response = await b.fetch(
    startRequest({ headers: { "X-Synthetic-Latin1": "é".repeat(4100) } }),
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(f.calls.length, 0);
});
test("late69 connection after disconnect is physically disposed without a query", async () => {
  const entered = deferred(),
    gate = deferred(),
    abort = new AbortController();
  const f = fixture({
      stage: async (name) => {
        if (name === "preauth:connect") {
          entered.resolve();
          await gate.promise;
        }
      },
    }),
    b = await createStandaloneLoginBridge(f);
  const pending = b.fetch(startRequest({ signal: abort.signal }));
  await entered.promise;
  abort.abort();
  await assert.rejects(pending, /HELD/);
  gate.resolve();
  await tick();
  await tick();
  assert.equal(
    f.calls.some((v) => v.role === "preauth"),
    false,
  );
  assert.equal(f.releases.filter((v) => v.role === "preauth").length, 1);
  assert.equal(f.releases.filter((v) => v.role === "preauth")[0].completed, true);
});
test("abort during asynchronous M disposal never emits a cookie or repeats cleanup", async () => {
  const entered = deferred(),
    gate = deferred(),
    abort = new AbortController();
  const f = fixture({
      stage: async (name) => {
        if (name === "sessions:release") {
          entered.resolve();
          await gate.promise;
        }
      },
    }),
    b = await createStandaloneLoginBridge(f),
    flow = await started(b);
  let delivered = 0;
  const pending = b.dispatch(callbackRequest(flow, { signal: abort.signal }), () => {
    delivered++;
  });
  await entered.promise;
  abort.abort();
  await pending;
  assert.equal(delivered, 0);
  assert.equal(f.releases.filter((v) => v.role === "sessions").length, 1);
  assert.equal(f.releases.filter((v) => v.role === "sessions")[0].completed, false);
  gate.resolve();
  await tick();
  assert.equal(f.releases.filter((v) => v.role === "sessions")[0].completed, true);
  assert.equal(f.calls.filter((v) => v.role === "sessions" && v.stage === "admit").length, 1);
});
for (const [name, after, success] of [
  ["valid", 11000, true],
  ["expired", 13000, false],
])
  test(
    "real verification clock8s then SQL3s retains only original observation lease: " + name,
    async () => {
      const f = fixture({
          stage: async (name, state) => {
            if (name === "selection:resolve") state.setTime(native.at + after);
          },
        }),
        b = await createStandaloneLoginBridge(f),
        flow = await started(b);
      const original = crypto.subtle.verify;
      crypto.subtle.verify = async function (...args) {
        const verified = await Reflect.apply(original, this, args);
        f.setTime(native.at + 8000);
        return verified;
      };
      try {
        const r = await b.fetch(callbackRequest(flow));
        assert.equal(r.headers.get("location"), success ? "/" : "/auth/result");
        assert.equal(r.headers.getSetCookie().length, success ? 1 : 0);
        assert.equal(
          f.calls.filter((v) => v.role === "sessions" && v.stage === "admit").length,
          success ? 1 : 0,
        );
      } finally {
        crypto.subtle.verify = original;
      }
    },
  );
test("rejected native Promise sink is suppressed without a second handoff", async () => {
  const f = fixture(),
    b = await createStandaloneLoginBridge(f);
  let calls = 0;
  await assert.rejects(
    b.dispatch(startRequest(), () => {
      calls++;
      return Promise.reject(Error("PRIVATE_REJECTED_SINK"));
    }),
    /TRANSPORT_UNKNOWN/,
  );
  await tick();
  assert.equal(calls, 1);
});
test("nonsettling native Promise sink never holds dispatch or retries", async () => {
  const f = fixture(),
    b = await createStandaloneLoginBridge(f);
  let calls = 0;
  await assert.rejects(
    b.dispatch(startRequest(), () => {
      calls++;
      return new Promise(() => {});
    }),
    /TRANSPORT_UNKNOWN/,
  );
  assert.equal(calls, 1);
});
