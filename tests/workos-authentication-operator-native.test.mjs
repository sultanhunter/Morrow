import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { buildWorkosAuthenticationEvidenceFixture } from "./fixtures/workos-authentication-evidence.mjs";
import { createSyntheticWorkosAuthenticationOperatorNativePermit } from "../scripts/workos-authentication-operator-input.mjs";
import {
  createNativeWorkosAuthenticationOperatorTransport,
  createSyntheticWorkosAuthenticationOperatorTransport,
} from "../scripts/workos-authentication-operator-native.mjs";

const profileTemplate = JSON.parse(
  readFileSync(
    new URL("../docs/decisions/workos-authentication-operator-qualification.json", import.meta.url),
    "utf8",
  ),
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const id = (prefix, n) => `${prefix}_${String(n).padStart(26, "0")}`;
const environmentKeys = Object.keys(process.env).filter(
  (key) =>
    /^WORKOS_/i.test(key) ||
    /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|NODE_OPTIONS|SSL_CERT_FILE|SSL_CERT_DIR|NODE_TLS_REJECT_UNAUTHORIZED)$/i.test(
      key,
    ),
);
const previousEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);
for (const key of environmentKeys) delete process.env[key];
test.after(() => {
  for (const key of environmentKeys) process.env[key] = previousEnvironment[key];
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
});
function response(url, value, options = {}) {
  const body =
    typeof value === "string" || value instanceof Uint8Array || value instanceof ReadableStream
      ? value
      : JSON.stringify(value);
  const result = new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
    ...options,
  });
  Object.defineProperty(result, "url", { value: url });
  return result;
}
function fixture(options = {}) {
  const f = buildWorkosAuthenticationEvidenceFixture(options.fixture);
  let at = f.at,
    sourceAllowed = true,
    targetSaved = false,
    pageIntent = 0,
    keyReads = 0;
  const binding = {
    schemaVersion: 1,
    providerId: "workos",
    environmentId: f.profile.environmentId,
    applicationId: f.profile.applicationId,
    clientId: f.profile.clientId,
    approvedSubjectId: f.claims.sub,
  };
  const bindingJson = JSON.stringify(binding);
  const profile = { ...profileTemplate, protectedBindingDigest: sha256(bindingJson) };
  const events = [],
    calls = [],
    targets = [],
    observations = [];
  const fakeKey = randomBytes(24).toString("hex");
  const permit = createSyntheticWorkosAuthenticationOperatorNativePermit({
    profileJson: JSON.stringify(profile),
    bindingJson,
    approvedSubjectId: binding.approvedSubjectId,
    priorSessionIds: options.priorSessionIds ?? [],
    operationId: "924c6ca6-cc84-4a91-834d-eccf54d385ee",
    activationId: "33513873-0180-42fa-a96d-94be7e2d8e08",
    sourceDigest: sha256("synthetic-native-source"),
    expiresAtMs: f.at + 60000,
    credentialExpiresAtMs: f.at + 60000,
    current: () => {
      options.current?.(api);
      return sourceAllowed;
    },
    credential: () => {
      events.push("key");
      keyReads++;
      assert.equal(targetSaved, true);
      assert.ok(pageIntent > 0);
      return options.credential ? options.credential(api) : fakeKey;
    },
  });
  const defaultFetch = async (url, init) => {
    calls.push({ url, init });
    events.push(init.method === "POST" ? "post" : url.includes("/sso/jwks/") ? "jwks" : "page");
    if (options.fetch) return options.fetch(url, init, api);
    if (url.includes("/sso/jwks/")) return response(url, options.jwks ?? f.snapshot.jwks);
    if (init.method === "POST")
      return response(url, {
        access_token: options.token ?? f.sign(),
        refresh_token: randomBytes(32).toString("base64url"),
        user: { id: options.responseSubject ?? f.claims.sub },
        ignored: "not authority",
      });
    return response(
      url,
      options.page
        ? options.page(calls.filter((call) => call.url.includes("/sessions?")).length, api)
        : f.page(),
    );
  };
  const controller = new AbortController();
  const callbacks = {
    beforeJwks: async () => {
      events.push("jwks_intent");
      return options.beforeJwks ? options.beforeJwks(api) : true;
    },
    beforePost: async () => {
      events.push("post_intent");
      return options.beforePost ? options.beforePost(api) : true;
    },
    onVerifiedTarget: async (value) => {
      events.push("target");
      targets.push(JSON.parse(value));
      if (options.onVerifiedTarget && (await options.onVerifiedTarget(value, api)) !== true)
        return false;
      targetSaved = true;
      return true;
    },
    beforePage: async (value, control) => {
      events.push(`page_${control.pageNumber}_intent`);
      assert.equal(targetSaved, true);
      assert.equal(JSON.parse(value).subjectId, f.claims.sub);
      assert.equal(control.pageNumber, pageIntent + 1);
      if (options.beforePage && (await options.beforePage(value, control, api)) !== true)
        return false;
      pageIntent++;
      return true;
    },
    onEvidenceObservation: async (value) => {
      events.push("observation");
      observations.push(JSON.parse(value));
      return options.onEvidenceObservation ? options.onEvidenceObservation(value, api) : true;
    },
  };
  const api = {
    f,
    profile,
    binding,
    permit,
    calls,
    events,
    targets,
    observations,
    fakeKey,
    callbacks,
    controller,
    get at() {
      return at;
    },
    set at(value) {
      at = value;
    },
    get keyReads() {
      return keyReads;
    },
    set sourceAllowed(value) {
      sourceAllowed = value;
    },
    clock: () => at,
  };
  const transport = createSyntheticWorkosAuthenticationOperatorTransport(permit, {
    fetch: defaultFetch,
    clock: api.clock,
  });
  api.transport = transport;
  api.run = (
    changes = {},
    value = JSON.stringify({
      code: "opaque-code-Δ",
      verifier: Buffer.alloc(32, 7).toString("base64url"),
    }),
  ) =>
    transport.completeOnce(value, {
      signal: controller.signal,
      deadlineMs: f.at + 25000,
      ...callbacks,
      ...changes,
    });
  return api;
}
const held = (result) => {
  assert.equal(result.outcome, "held");
  assert.equal(result.providerSessionCleanup, "unknown");
  assert.equal(result.tokenProvenance, null);
};

test("signed evidence stays private; durable target and page intent precede first key and request", async () => {
  const a = fixture();
  const r = await a.run();
  assert.deepEqual(r, {
    outcome: "verified_active_evidence",
    category: "evidence_observed",
    statusClass: "2xx",
    jwksGetCount: 1,
    codePostCount: 1,
    sessionGetCount: 1,
    tokenProvenance: "signature_verified",
    sessionClientBinding: "expected_only",
    sessionLiveness: "not_guaranteed",
    providerSessionCleanup: "unknown",
  });
  assert.deepEqual(a.events, [
    "jwks_intent",
    "jwks",
    "post_intent",
    "post",
    "target",
    "page_1_intent",
    "key",
    "page",
    "observation",
  ]);
  assert.equal(a.targets[0].subjectId, a.f.claims.sub);
  assert.equal(a.targets[0].providerSessionId, a.f.claims.sid);
  assert.deepEqual(Object.keys(a.targets[0]), [
    "schemaVersion",
    "operationId",
    "activationId",
    "sourceDigest",
    "environmentId",
    "applicationId",
    "clientId",
    "issuer",
    "subjectId",
    "providerSessionId",
    "tokenProfileDigest",
    "keySetDigest",
    "verifiedAtMs",
    "tokenExpiresAtMs",
  ]);
  const publicText = JSON.stringify([r, ...a.observations]);
  for (const value of [
    a.f.claims.sub,
    a.f.claims.sid,
    a.f.profile.clientId,
    a.fakeKey,
    a.f.token,
    "opaque-code-Δ",
  ])
    assert.equal(publicText.includes(value), false);
  assert.equal(a.calls[0].init.headers.authorization, undefined);
  assert.equal(a.calls[1].init.headers.authorization, undefined);
  const wire = JSON.parse(a.calls[1].init.body);
  assert.equal(wire.code, "opaque-code-Δ");
  assert.equal(wire.grant_type, "authorization_code");
  assert.equal(a.calls[2].init.headers.authorization, `Bearer ${a.fakeKey}`);
  held(await a.run());
  assert.equal(a.calls.length, 3);
});

test("native rejects forged or synthetic permits and injected options; synthetic is one-use branded", () => {
  assert.throws(() => createNativeWorkosAuthenticationOperatorTransport({}));
  const a = fixture();
  assert.throws(() => createNativeWorkosAuthenticationOperatorTransport(a.permit));
  assert.throws(() => createNativeWorkosAuthenticationOperatorTransport({}, {}));
  assert.throws(() =>
    createSyntheticWorkosAuthenticationOperatorTransport(
      {},
      { fetch: async () => {}, clock: Date.now },
    ),
  );
  assert.throws(() =>
    createSyntheticWorkosAuthenticationOperatorTransport(
      {},
      { fetch: async () => {}, clock: Date.now, key: "forbidden" },
    ),
  );
});

test("primitive closed input rejects proxy traps, duplicates, malformed Unicode and verifier without requests", async () => {
  let traps = 0;
  const proxy = new Proxy(
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
  const values = [
    proxy,
    {},
    '{"code":"one","code":"two","verifier":"x"}',
    JSON.stringify({ code: "\ud800", verifier: Buffer.alloc(32).toString("base64url") }),
    JSON.stringify({ code: "x".repeat(4097), verifier: Buffer.alloc(32).toString("base64url") }),
    JSON.stringify({ code: "x", verifier: "a".repeat(43) }),
    JSON.stringify({ code: "x", verifier: Buffer.alloc(32).toString("base64url"), extra: true }),
  ];
  for (const value of values) {
    const a = fixture();
    held(await a.run({}, value));
    assert.equal(a.calls.length, 0);
    assert.equal(a.keyReads, 0);
  }
  assert.equal(traps, 0);
});

test("JWKS observed metadata is projected but unknown/private/invalid keys deny before POST", async () => {
  const f = buildWorkosAuthenticationEvidenceFixture();
  const key = f.snapshot.jwks.keys[0];
  const positive = fixture({
    jwks: {
      keys: [
        {
          ...key,
          x5c: [Buffer.from("synthetic certificate metadata").toString("base64")],
          "x5t#S256": Buffer.alloc(32, 2).toString("base64url"),
        },
      ],
    },
  });
  assert.equal((await positive.run()).outcome, "verified_active_evidence");
  for (const change of [
    { d: "private" },
    { jku: "https://foreign.invalid" },
    { x5c: [] },
    { x5c: ["AB=="] },
    { x5c: [Buffer.alloc(8193).toString("base64")] },
    { "x5t#S256": "a".repeat(43) },
    { e: "Aw" },
    { n: Buffer.alloc(256, 2).toString("base64url") },
  ]) {
    const a = fixture({ jwks: { keys: [{ ...key, ...change }] } });
    held(await a.run());
    assert.equal(a.calls.length, 1);
    assert.equal(a.keyReads, 0);
  }
});

test("HTTP origin, redirects, status, content, malformed UTF8 and duplicate JSON hold with no POST", async () => {
  const makers = [
    (url) => response("https://foreign.invalid/", {}),
    (url) => {
      const r = response(url, {});
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
    (url) => response(url, {}, { status: 503 }),
    (url) => response(url, {}, { headers: { "content-type": "text/plain" } }),
    (url) => response(url, new Uint8Array([0xc3, 0x28])),
    (url) => response(url, '{"keys":[],"k\\u0065ys":[]}'),
    (url) =>
      response(
        url,
        {},
        { headers: { "content-type": "application/json", "content-length": "65537" } },
      ),
  ];
  for (const maker of makers) {
    const a = fixture({ fetch: async (url) => maker(url) });
    held(await a.run());
    assert.equal(a.calls.length, 1);
    assert.equal(a.keyReads, 0);
  }
});

test("post-GET intent/source/cancel/TLS drift prevents the single POST", async () => {
  for (const kind of ["false", "source", "cancel", "clock", "tls"]) {
    const a = fixture({
      beforePost(api) {
        if (kind === "source") api.sourceAllowed = false;
        if (kind === "cancel") api.controller.abort();
        if (kind === "clock") api.at += 15000;
        if (kind === "tls") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        return kind !== "false";
      },
    });
    try {
      held(await a.run());
      assert.equal(a.calls.length, 1);
      assert.equal(a.keyReads, 0);
    } finally {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  }
});

test("token signature, subject, response subject and baseline SID gates precede target/key/catalogue", async () => {
  const f = buildWorkosAuthenticationEvidenceFixture();
  const cases = [
    { token: f.token.slice(0, -2) + "xx" },
    { token: f.sign({ sub: id("user", 9) }) },
    { responseSubject: id("user", 9) },
    { priorSessionIds: [f.claims.sid] },
    { token: f.sign({ exp: f.at / 1000 }) },
    { token: f.sign({ act: { sub: id("user", 9) } }) },
  ];
  for (const options of cases) {
    const a = fixture(options);
    held(await a.run());
    assert.equal(a.targets.length, 0);
    assert.equal(a.keyReads, 0);
    assert.equal(a.calls.length, 2);
  }
});

test("target durability failure, target expiry and page intent failure never read key", async () => {
  for (const options of [
    { onVerifiedTarget: () => false },
    {
      onVerifiedTarget: (_value, a) => {
        a.at += 15000;
        return true;
      },
    },
    { beforePage: () => false },
  ]) {
    const a = fixture(options);
    held(await a.run());
    assert.equal(a.calls.length, 2);
    assert.equal(a.keyReads, 0);
  }
});

test("complete pagination after early match; selected policy accepts each of eight methods", async () => {
  const methods = [
    "cross_app_auth",
    "external_auth",
    "magic_code",
    "migrated_session",
    "oauth",
    "passkey",
    "password",
    "sso",
  ];
  for (const method of methods) {
    const a = fixture({ page: (_n, api) => api.f.page([api.f.session({ auth_method: method })]) });
    assert.equal((await a.run()).outcome, "verified_active_evidence", method);
  }
  const a = fixture({
    page: (n, api) =>
      n === 1
        ? api.f.page([api.f.session()], id("session", 8))
        : api.f.page(
            [
              api.f.session({
                id: id("session", 9),
                auth_method: "unknown_future",
                impersonator: { email: "fixture@invalid.test", reason: null },
              }),
            ],
            null,
            id("session", 8),
          ),
  });
  const r = await a.run();
  assert.equal(r.outcome, "verified_active_evidence");
  assert.equal(r.sessionGetCount, 2);
  assert.equal(a.keyReads, 2);
});

test("unknown/impersonated target, complete miss, malformed later page and fifth page remain held", async () => {
  for (const changes of [
    { auth_method: "unknown" },
    { auth_method: "OAuth" },
    { auth_method: " oauth" },
    { auth_method: null },
    { auth_method: "impersonation" },
    { impersonator: { email: "synthetic@invalid.test", reason: null } },
  ]) {
    const a = fixture({ page: (_n, api) => api.f.page([api.f.session(changes)]) });
    held(await a.run());
    assert.equal(a.targets.length, 1);
  }
  const miss = fixture({ page: (_n, a) => a.f.page([]) });
  held(await miss.run());
  const malformed = fixture({
    page: (n, a) =>
      n === 1 ? a.f.page([a.f.session()], id("session", 8)) : '{"object":"list","data":[]}',
  });
  held(await malformed.run());
  assert.equal(malformed.keyReads, 2);
  const fifth = fixture({
    page: (n, a) =>
      a.f.page(
        n === 1 ? [a.f.session()] : [a.f.session({ id: id("session", 30 + n) })],
        id("session", 10 + n),
        n === 1 ? null : id("session", 9 + n),
      ),
  });
  const r = await fifth.run();
  held(r);
  assert.equal(r.sessionGetCount, 4);
  assert.equal(fifth.keyReads, 4);
});

test("key failure, per-page source drift and malformed session bytes stop further GETs", async () => {
  const badKey = fixture({
    credential() {
      throw Error("never expose private key path");
    },
  });
  held(await badKey.run());
  assert.equal(badKey.calls.length, 2);
  const drift = fixture({
    page: (_n, a) => a.f.page([a.f.session()], id("session", 8)),
    beforePage(_v, c, a) {
      if (c.pageNumber === 2) a.sourceAllowed = false;
      return true;
    },
  });
  held(await drift.run());
  assert.equal(drift.keyReads, 1);
  assert.equal(drift.calls.length, 3);
  const oversized = fixture({ page: () => " ".repeat(131073) });
  held(await oversized.run());
  assert.equal(oversized.calls.length, 3);
});

test("evidence expires during awaited observation: historical success never overrides fresh handle", async () => {
  const a = fixture({
    onEvidenceObservation(_value, api) {
      api.at += 5000;
      return true;
    },
  });
  const r = await a.run();
  held(r);
  assert.equal(a.observations.length, 1);
  assert.equal(a.observations[0].outcome, "evidence_observed");
  assert.equal(r.category, "observation_denied");
  const failedWrite = fixture({
    onEvidenceObservation() {
      throw new Proxy(
        {},
        {
          get() {
            throw Error("hostile getter");
          },
        },
      );
    },
  });
  held(await failedWrite.run());
  assert.equal(failedWrite.targets.length, 1);
  assert.equal(failedWrite.observations.length, 1);
});

test("late callbacks after cancellation cannot read keys or issue another effect", async () => {
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const a = fixture({ beforePost: () => waiting });
  const pending = a.run();
  while (!a.events.includes("post_intent")) await new Promise((resolve) => setTimeout(resolve, 1));
  a.controller.abort();
  const r = await pending;
  held(r);
  assert.equal(r.category, "cancelled");
  release(true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(a.calls.length, 1);
});

test("late GET and POST bodies are disposed locally after the outer timeout", async () => {
  for (const lateStage of ["jwks", "post"]) {
    let release, entered;
    let cancelCount = 0;
    const entry = new Promise((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const a = fixture({
      fetch: async (url, init, api) => {
        if (
          (lateStage === "jwks" && url.includes("/sso/jwks/")) ||
          (lateStage === "post" && init.method === "POST")
        ) {
          entered(url);
          return waiting;
        }
        return response(url, api.f.snapshot.jwks);
      },
    });
    const pending = a.run({ deadlineMs: a.f.at + (lateStage === "jwks" ? 30 : 1000) });
    const url = await entry;
    const r = await pending;
    held(r);
    assert.equal(r.category, "timeout");
    const stream = new ReadableStream({
      cancel() {
        cancelCount++;
      },
    });
    release(response(url, stream));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cancelCount, 1);
    assert.equal(stream.locked, false);
    assert.equal(a.calls.length, lateStage === "jwks" ? 1 : 2);
    assert.equal(a.keyReads, 0);
  }
});

test("hostile thrown objects are never inspected or serialized; cancellation is coarse", async () => {
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
  const a = fixture({
    fetch() {
      throw hostile;
    },
  });
  const r = await a.run();
  held(r);
  assert.equal(r.category, "transport_failed");
  assert.equal(traps, 0);
  const cancelled = fixture();
  cancelled.controller.abort();
  held(await cancelled.run());
  assert.equal(cancelled.calls.length, 0);
});

test("clock regression, synchronous source-check time and close cannot yield fresh success", async () => {
  let checks = 0;
  const a = fixture({
    current(api) {
      if (++checks === 8) api.at -= 1;
    },
  });
  held(await a.run());
  let slow = false;
  const b = fixture({
    current(api) {
      if (slow) api.at += 15000;
    },
    beforeJwks() {
      slow = true;
      return true;
    },
  });
  held(await b.run());
  assert.equal(b.calls.length, 0);
  const c = fixture();
  c.transport.close();
  held(await c.run());
  assert.equal(c.calls.length, 0);
});

test("close promptly settles an abort-ignoring request and cancels its late body", async () => {
  let release,
    entered,
    cancelled = 0;
  const entry = new Promise((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const a = fixture({
    fetch: async (url) => {
      entered(url);
      return waiting;
    },
  });
  const pending = a.run();
  const url = await entry;
  a.transport.close();
  const r = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(Error("close did not settle")), 100)),
  ]);
  held(r);
  assert.equal(r.category, "cancelled");
  const stream = new ReadableStream({
    cancel() {
      cancelled++;
    },
  });
  release(response(url, stream));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cancelled, 1);
  assert.equal(a.calls.length, 1);
  assert.equal(a.keyReads, 0);
});

test("shared phase budgets include synchronous callbacks and do not reset after JWKS or target", async () => {
  for (const stage of ["jwks", "post", "target", "page"]) {
    const a = fixture({
      beforeJwks(api) {
        if (stage === "jwks") api.at += 15000;
        return true;
      },
      beforePost(api) {
        if (stage === "post") api.at += 15000;
        return true;
      },
      onVerifiedTarget(_value, api) {
        if (stage === "target") api.at += 15000;
        return true;
      },
      beforePage(_value, _control, api) {
        if (stage === "page") api.at += 10000;
        return true;
      },
    });
    const r = await a.run();
    held(r);
    assert.equal(r.category, "timeout", stage);
    assert.equal(a.calls.length, stage === "jwks" ? 0 : stage === "post" ? 1 : 2);
    assert.equal(a.keyReads, 0);
  }
  const a = fixture({
    beforePost(api) {
      api.at += 14000;
      return true;
    },
    beforePage(_value, _control, api) {
      api.at += 4000;
      return true;
    },
  });
  assert.equal((await a.run()).outcome, "verified_active_evidence");
  assert.equal(a.at - a.f.at, 18000);
});

test("exchange shape and duplicate JSON are denied before verified target or credential", async () => {
  const variants = ["empty", "nonjson", "duplicate", "missing_refresh", "wrong_user", "huge_token"];
  for (const variant of variants) {
    const a = fixture({
      fetch: async (url, init, api) => {
        if (init.method === "GET") return response(url, api.f.snapshot.jwks);
        const data = {
          access_token: api.f.sign(),
          refresh_token: randomBytes(24).toString("hex"),
          user: { id: api.f.claims.sub },
        };
        if (variant === "empty") return response(url, "");
        if (variant === "nonjson") return response(url, "not JSON");
        if (variant === "duplicate") return response(url, '{"user":{},"u\\u0073er":{}}');
        if (variant === "missing_refresh") delete data.refresh_token;
        if (variant === "wrong_user") data.user.id = null;
        if (variant === "huge_token") data.access_token = "x".repeat(16385);
        return response(url, data);
      },
    });
    held(await a.run());
    assert.equal(a.targets.length, 0);
    assert.equal(a.keyReads, 0);
    assert.equal(a.calls.length, 2);
  }
});

test("session HTTP failures and duplicate or malformed rows do not relax catalogue parsing", async () => {
  for (const variant of [
    "foreign",
    "redirect",
    "status",
    "utf8",
    "duplicate",
    "too_many",
    "repeat",
    "cycle",
  ]) {
    const a = fixture({
      fetch: async (url, init, api) => {
        if (url.includes("/sso/jwks/")) return response(url, api.f.snapshot.jwks);
        if (init.method === "POST")
          return response(url, {
            access_token: api.f.sign(),
            refresh_token: randomBytes(24).toString("hex"),
            user: { id: api.f.claims.sub },
          });
        if (variant === "foreign") return response("https://foreign.invalid/", api.f.page());
        if (variant === "redirect") {
          const r = response(url, api.f.page());
          Object.defineProperty(r, "redirected", { value: true });
          return r;
        }
        if (variant === "status") return response(url, {}, { status: 503 });
        if (variant === "utf8") return response(url, new Uint8Array([0xed, 0xa0, 0x80]));
        if (variant === "duplicate")
          return response(
            url,
            '{"object":"list","data":[],"d\\u0061ta":[],"list_metadata":{"before":null,"after":null}}',
          );
        if (variant === "too_many")
          return response(
            url,
            api.f.page(
              Array.from({ length: 101 }, (_, n) => api.f.session({ id: id("session", n + 20) })),
            ),
          );
        if (variant === "repeat")
          return response(url, api.f.page([api.f.session(), api.f.session()]));
        return response(
          url,
          api.f.page(
            [api.f.session({ id: api.calls.length === 3 ? api.f.claims.sid : id("session", 30) })],
            id("session", 20),
          ),
        );
      },
    });
    const r = await a.run();
    held(r);
    assert.ok(r.sessionGetCount >= 1 && r.sessionGetCount <= 2);
    assert.equal(a.targets.length, 1);
  }
});

test("stalled body cancellation and a late session response are disposed without extra requests", async () => {
  let entered,
    release,
    cancelCount = 0;
  const entry = new Promise((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const a = fixture({
    fetch: async (url, init, api) => {
      if (url.includes("/sso/jwks/")) return response(url, api.f.snapshot.jwks);
      if (init.method === "POST")
        return response(url, {
          access_token: api.f.sign(),
          refresh_token: randomBytes(24).toString("hex"),
          user: { id: api.f.claims.sub },
        });
      entered(url);
      return waiting;
    },
  });
  const pending = a.run();
  const url = await entry;
  a.controller.abort();
  held(await pending);
  const stream = new ReadableStream({
    cancel() {
      cancelCount++;
    },
  });
  release(response(url, stream));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cancelCount, 1);
  assert.equal(stream.locked, false);
  assert.equal(a.keyReads, 1);
  assert.equal(a.calls.length, 3);
  let bodyEntered,
    bodyCancelled = 0;
  const bodyEntry = new Promise((resolve) => {
    bodyEntered = resolve;
  });
  const b = fixture({
    fetch: async (requestUrl) =>
      response(
        requestUrl,
        new ReadableStream({
          start() {
            bodyEntered();
          },
          cancel() {
            bodyCancelled++;
          },
        }),
      ),
  });
  const bodyPending = b.run();
  await bodyEntry;
  b.controller.abort();
  held(await bodyPending);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(bodyCancelled, 1);
  assert.equal(b.calls.length, 1);
});

test("beforePage cancellation and TLS drift occur before key reads; observation failure retains target only", async () => {
  for (const kind of ["cancel", "tls", "false"]) {
    const a = fixture({
      beforePage(_value, _control, api) {
        if (kind === "cancel") api.controller.abort();
        if (kind === "tls") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        return kind !== "false";
      },
    });
    try {
      held(await a.run());
      assert.equal(a.keyReads, 0);
      assert.equal(a.calls.length, 2);
      assert.equal(a.targets.length, 1);
    } finally {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  }
  const a = fixture({ onEvidenceObservation: () => false });
  const r = await a.run();
  held(r);
  assert.equal(r.category, "observation_record_denied");
  assert.equal(a.targets.length, 1);
  assert.equal(a.observations.length, 1);
});

test("the final source checkpoint cannot return evidence after its lease expires", async () => {
  let advancedCases = 0,
    cleanCases = 0;
  for (let slowCheck = 1; slowCheck <= 24; slowCheck++) {
    let observationSaved = false,
      checks = 0,
      advanced = false;
    const a = fixture({
      onEvidenceObservation() {
        observationSaved = true;
        return true;
      },
      current(api) {
        if (observationSaved && ++checks === slowCheck) {
          api.at += 5000;
          advanced = true;
        }
      },
    });
    const r = await a.run();
    if (advanced) {
      advancedCases++;
      held(r);
    } else {
      cleanCases++;
      assert.equal(r.outcome, "verified_active_evidence");
    }
  }
  assert.ok(advancedCases > 0);
  assert.ok(cleanCases > 0);
});
