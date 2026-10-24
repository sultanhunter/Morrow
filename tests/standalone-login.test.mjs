import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createStandaloneLoginBridge,
  loginCallbackFailureLine,
  loginCallbackStages,
} from "../packages/identity/src/standalone-login.ts";
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
    body: change.body ?? JSON.stringify({ schemaVersion: 2 }),
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
test("P05.T01y-AC30: the callback cookie lives min(1800, remaining) seconds and needs at least one", async () => {
  for (const [lifetime, maxAge] of [
    [1800000, "1800"],
    [1799999, "1799"],
    [900000, "900"],
  ]) {
    const bridge = await createStandaloneLoginBridge(fixture({ admissionLifetimeMs: lifetime }));
    const result = await bridge.fetch(callbackRequest(await started(bridge)));
    assert.equal(result.headers.get("location"), "/");
    const cookies = result.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].endsWith("; Max-Age=" + maxAge), true);
  }
  // Under one second of remaining time no session cookie is delivered.
  const bridge = await createStandaloneLoginBridge(fixture({ admissionLifetimeMs: 999 }));
  const result = await bridge.fetch(callbackRequest(await started(bridge)));
  assert.equal(result.headers.get("location"), "/auth/result");
  assert.equal(result.headers.has("set-cookie"), false);
});
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
  const rows = f.calls.filter((v) => v.role === "sessions" && v.stage === "admitAccount");
  assert.equal(rows.length, 1);
  const secret = cookies[0].split("=")[1].split(";")[0];
  assert.equal(rows[0].values[16], createHash("sha256").update(secret).digest("hex"));
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
  // Account login (P05.T01x): the v1 workspace body is refused; only {"schemaVersion":2}.
  v1_workspace: '{"schemaVersion":1,"workspaceId":"workspace_a"}',
  extra: '{"schemaVersion":2,"role":"admin"}',
  workspace: '{"schemaVersion":2,"workspaceId":"workspace_a"}',
  duplicate: '{"schemaVersion":2,"schemaVersion":2}',
  version: '{"schemaVersion":3}',
  string_version: '{"schemaVersion":"2"}',
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
      f.calls.some((v) => v.role === "sessions" && v.stage === "admitAccount"),
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
  assert.equal(
    f.calls.filter((v) => v.role === "sessions" && v.stage === "admitAccount").length,
    1,
  );
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
  assert.equal(
    f.calls.filter((v) => v.role === "sessions" && v.stage === "admitAccount").length,
    1,
  );
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
  "sessions:admitAccount",
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
      f.calls.filter((v) => v.role === "sessions" && v.stage === "admitAccount").length,
      stage.startsWith("sessions") ? 1 : 0,
    );
    assert.ok(f.external.filter((v) => v.kind === "exchange").length <= 1);
    if (stage === "sessions:admitAccount") assert.equal(f.calls.at(-1).stage, "admitAccount");
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
  assert.equal(
    f.calls.filter((v) => v.role === "sessions" && v.stage === "admitAccount").length,
    1,
  );
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
    createStandaloneLoginBridge({ ...f, sessionPool: f.loginPool }),
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
      f.calls.some((v) => v.role === "sessions" && v.stage === "admitAccount"),
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
  assert.equal(
    f.calls.filter((v) => v.role === "sessions" && v.stage === "admitAccount").length,
    1,
  );
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
            if (name === "sessions:connect") state.setTime(native.at + after);
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
          f.calls.filter((v) => v.role === "sessions" && v.stage === "admitAccount").length,
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
// fix-signin-clock-and-stage-log: the callback's stage diagnostic. A failed callback emits
// exactly one line from closed sets; a successful one emits none.
const stages = [
  "setup",
  "input",
  "claim",
  "capsule_open",
  "preauth_admit",
  "eligible_before_exchange",
  "exchange",
  "eligible_after_exchange",
  "jwks",
  "verify_token",
  "observe_session",
  "evidence_read",
  "admission",
  "finalize",
];
const subs = [
  "prepare",
  "connect",
  "session_setup",
  "role",
  "admit_query",
  "decode_shape",
  "decode_lifetime",
  "denied",
  "conflict",
  "commit",
  "release",
  "deadline",
];
const leads = ["expired", "lead_le_1s", "lead_le_5s", "lead_le_60s", "lead_gt_60s"];
const closedLine = (line) => {
  const row = JSON.parse(line);
  assert.deepEqual(Object.keys(row), ["event", "stage", "sub", "lead"]);
  assert.equal(row.event, "morrow_login_callback_failed");
  assert.ok(stages.includes(row.stage), line);
  if (row.stage === "admission") assert.ok(row.sub === null || subs.includes(row.sub), line);
  else assert.equal(row.sub, null);
  if (row.sub === "decode_lifetime") assert.ok(row.lead === null || leads.includes(row.lead), line);
  else assert.equal(row.lead, null);
  return row;
};
const once = (name) => {
  let hit = false;
  return (stage, state, effect) => {
    if (stage !== name || hit) return false;
    hit = true;
    if (effect) effect(state);
    else throw Error("PRIVATE_SYNTHETIC_DETAIL user_01ABC session_01ABC code=synthetic-code");
    return true;
  };
};
async function failedLine(t, options = {}, request) {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  let armed = false;
  const trigger = options.trigger ? once(options.trigger) : null;
  const f = fixture({
      ...options.fixture,
      stage: async (name, state) => {
        if (armed && trigger) trigger(name, state, options.effect);
      },
    }),
    b = await createStandaloneLoginBridge(f),
    flow = await started(b);
  assert.deepEqual(lines, [], "start emits nothing");
  armed = true;
  const r = await b.fetch(request ? request(flow) : callbackRequest(flow));
  t.mock.restoreAll();
  return { r, lines, f };
}
for (const [expected, options, request] of [
  [{ stage: "input" }, {}, () => new Request(origin + "/auth/workos/callback?error=access_denied")],
  [{ stage: "input" }, {}, (flow) => callbackRequest(flow, { headers: { Cookie: "" } })],
  [{ stage: "claim" }, { trigger: "login:claimCallback" }],
  [{ stage: "capsule_open" }, { fixture: { claimChange: { aad_digest: "a".repeat(64) } } }],
  [{ stage: "preauth_admit" }, { trigger: "preauth:admit" }],
  [{ stage: "eligible_before_exchange" }, { fixture: { eligibility: false } }],
  [{ stage: "exchange" }, { trigger: "provider:exchange" }],
  [{ stage: "exchange" }, { fixture: { exchangeOutput: "{}" } }],
  [
    { stage: "eligible_after_exchange" },
    { trigger: "provider:exchange", effect: (state) => state.setEligible(false) },
  ],
  [{ stage: "jwks" }, { trigger: "provider:keyset" }],
  [
    { stage: "verify_token" },
    {
      fixture: {
        exchangeOutput: JSON.stringify({ schemaVersion: 1, accessToken: "a.b.c-PRIVATE_TOKEN" }),
      },
    },
  ],
  [{ stage: "observe_session" }, { trigger: "provider:page" }],
  [{ stage: "observe_session" }, { fixture: { providerPage: "{}" } }],
  [{ stage: "admission", sub: "connect" }, { trigger: "sessions:connect" }],
  [{ stage: "admission", sub: "session_setup" }, { trigger: "sessions:begin" }],
  [{ stage: "admission", sub: "role" }, { trigger: "sessions:role" }],
  [{ stage: "admission", sub: "admit_query" }, { trigger: "sessions:admitAccount" }],
  [{ stage: "admission", sub: "commit" }, { trigger: "sessions:commit" }],
  [{ stage: "admission", sub: "release" }, { trigger: "sessions:release" }],
  // The database's expiry beyond the SQL's own bound (evidence lease end + 30 minutes).
  [
    { stage: "admission", sub: "decode_lifetime", lead: "lead_le_5s" },
    { fixture: { admissionLifetimeMs: 1805000 } },
  ],
  [
    { stage: "admission", sub: "decode_lifetime", lead: "lead_le_60s" },
    { fixture: { admissionLifetimeMs: 1806000 } },
  ],
  // Under one second of cookie: the session was committed, the callback still fails.
  [{ stage: "finalize" }, { fixture: { admissionLifetimeMs: 999 } }],
])
  test(
    "a failed callback emits one closed stage line: " +
      [expected.stage, expected.sub, expected.lead].filter(Boolean).join("/"),
    async (t) => {
      const { r, lines, f } = await failedLine(t, options, request);
      assert.equal(r.headers.get("location"), "/auth/result");
      assert.equal(r.headers.has("set-cookie"), false);
      assert.equal(lines.length, 1, lines.join("\n"));
      const row = closedLine(lines[0]);
      assert.deepEqual(row, {
        event: "morrow_login_callback_failed",
        stage: expected.stage,
        sub: expected.sub ?? null,
        lead: expected.lead ?? null,
      });
      // Nothing from the request, the provider, a token, the database or an error.
      for (const secret of [
        "synthetic-code",
        "PRIVATE",
        "user_0",
        "workos",
        "http",
        native.token.slice(0, 24),
        ...f.flows.flatMap((flow) => Object.values(flow).filter((v) => v.length >= 8)),
      ])
        assert.equal(lines[0].includes(secret), false, secret);
      assert.doesNotMatch(lines[0], /(?:user|session|client|app|environment)_[A-Z0-9]{26}/);
      assert.doesNotMatch(lines[0], /[0-9]{4,}|[a-f0-9]{8}-/);
    },
  );
test("a successful callback emits nothing; a database clock lead within the SQL bound signs in", async (t) => {
  for (const lifetime of [900000, 1800000, 1800001, 1803000, 1804999]) {
    const { r, lines } = await failedLine(t, { fixture: { admissionLifetimeMs: lifetime } });
    assert.equal(r.headers.get("location"), "/", String(lifetime));
    const cookies = r.headers.getSetCookie();
    assert.equal(cookies.length, 1);
    assert.ok(cookies[0].endsWith("; Max-Age=" + Math.min(1800, lifetime / 1000)));
    assert.deepEqual(lines, []);
  }
  // A start never emits the callback line, even when it fails.
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  const f = fixture({
    stage: async (name) => {
      if (name === "login:createAccountIntent") throw Error("PRIVATE");
    },
  });
  const b = await createStandaloneLoginBridge(f);
  assert.equal((await b.fetch(startRequest())).status, 503);
  assert.equal((await b.fetch(new Request(origin + "/auth/result"))).status, 200);
  t.mock.restoreAll();
  assert.deepEqual(lines, []);
});
test("an aborted callback still emits its one line and delivers nothing", async (t) => {
  const abort = new AbortController(),
    lines = [];
  let armed = false;
  const f = fixture({
      stage: async (name) => {
        if (armed && name === "provider:keyset") abort.abort();
      },
    }),
    b = await createStandaloneLoginBridge(f),
    flow = await started(b);
  armed = true;
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  let delivered = 0;
  await b.dispatch(callbackRequest(flow, { signal: abort.signal }), () => {
    delivered++;
  });
  t.mock.restoreAll();
  assert.equal(delivered, 0);
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.equal(closedLine(lines[0]).stage, "jwks");
});
test("the stage line admits only closed values, whatever it is handed", () => {
  for (const [progress, expected] of [
    [null, ["setup", null, null]],
    [undefined, ["setup", null, null]],
    ["claim", ["setup", null, null]],
    [{ stage: "claim", sub: "role", lead: "expired" }, ["claim", null, null]],
    [{ stage: "admission", sub: "role", lead: "expired" }, ["admission", "role", null]],
    [
      { stage: "admission", sub: "decode_lifetime", lead: "lead_gt_60s" },
      ["admission", "decode_lifetime", "lead_gt_60s"],
    ],
    [
      { stage: "admission", sub: "decode_lifetime", lead: "1806000" },
      ["admission", "decode_lifetime", null],
    ],
    [{ stage: "admission", sub: "code=abc" }, ["admission", null, null]],
    [{ stage: "https://x.example/auth/workos/callback?code=abc" }, ["setup", null, null]],
    [{ stage: { toString: () => "claim" } }, ["setup", null, null]],
    [
      new Proxy(
        {},
        {
          get() {
            throw Error("PRIVATE");
          },
        },
      ),
      ["setup", null, null],
    ],
  ]) {
    const line = loginCallbackFailureLine(progress);
    const row = closedLine(line);
    assert.deepEqual([row.stage, row.sub, row.lead], expected, line);
  }
  assert.deepEqual([...loginCallbackStages], stages);
});
