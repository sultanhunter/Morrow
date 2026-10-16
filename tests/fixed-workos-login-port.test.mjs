import test from "node:test";
import assert from "node:assert/strict";
import {
  createFixedWorkosLoginPort,
  createSyntheticFixedWorkosLoginPort,
} from "../packages/identity/src/fixed-workos-login-port.ts";

const at = 1800000000000;
const id = (prefix, n) => `${prefix}_${String(n).padStart(26, "0")}`;
const profile = {
  schemaVersion: 1,
  providerId: "workos",
  environmentId: id("environment", 1),
  applicationId: id("app", 2),
  clientId: id("client", 3),
  issuer: `https://api.workos.com/user_management/${id("client", 3)}`,
  revision: 7,
  audiencePolicy: "absent",
};
const configuration = {
  schemaVersion: 1,
  controllerProtocol: "morrow-local-login-84",
  origin: "https://workspace.example.test",
  retentionTier: "staging",
  authenticationBindingJson: JSON.stringify({
    bindingId: "fixed-binding",
    bindingRevision: 1,
    environmentId: profile.environmentId,
    applicationId: profile.applicationId,
    clientId: profile.clientId,
    redirectUri: "https://workspace.example.test/auth/workos/callback",
    returnPath: "/",
  }),
  verificationProfileJson: JSON.stringify(profile),
  profileId: "fixed-profile",
  profileRecordRevision: 1,
};
const exchange = {
  schemaVersion: 1,
  admissionId: "11111111-2222-3333-4444-555555555555",
  code: "opaque authorization code",
  verifier: Buffer.alloc(32, 5).toString("base64url"),
  clientId: profile.clientId,
  redirectUri: "https://workspace.example.test/auth/workos/callback",
};
const selector = {
  schemaVersion: 1,
  subjectId: id("user", 4),
  after: null,
  limit: 100,
  order: "asc",
};
const namespace = JSON.stringify({
  schemaVersion: 1,
  providerId: "workos",
  environmentId: profile.environmentId,
  applicationId: profile.applicationId,
  clientId: profile.clientId,
  purpose: "list_active_sessions",
});
const managementMarker = "synthetic-management-marker-only";
const key = {
  kty: "RSA",
  kid: "public-key",
  n: "AQ",
  e: "AQAB",
  alg: "RS256",
  use: "sig",
  key_ops: ["verify"],
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function response(url, body = JSON.stringify({ access_token: "e30.e30.c2ln" }), options = {}) {
  const result = new Response(body, {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers },
  });
  Object.defineProperty(result, "url", { value: options.url ?? String(url) });
  if (options.redirected) Object.defineProperty(result, "redirected", { value: true });
  return result;
}
function fixture(change = {}) {
  let clock = at;
  const calls = [],
    borrows = [],
    releases = [];
  const parent = new AbortController(),
    revocation = new AbortController();
  const lease = {
    namespaceJson: namespace,
    credential: managementMarker,
    expiresAtMs: at + 60000,
    revocationSignal: revocation.signal,
    async release(control) {
      releases.push(control);
    },
    ...change.lease,
  };
  const now = change.now ?? (() => clock);
  const dependencies = {
    configurationJson: change.configurationJson ?? JSON.stringify(configuration),
    now,
    sessionCredentialBroker: {
      async borrow(text, control) {
        borrows.push({ text, control });
        return change.borrow ? change.borrow(text, control, lease) : lease;
      },
    },
    async fetch(url, init) {
      calls.push({ url: String(url), init });
      if (change.fetch) return change.fetch(url, init);
      return response(
        url,
        String(url).includes("/sso/jwks/")
          ? JSON.stringify({ keys: [key] })
          : String(url).includes("/sessions?")
            ? '{"object":"list","data":[],"list_metadata":{"before":null,"after":null}}'
            : JSON.stringify({
                access_token: "e30.e30.c2ln",
                refresh_token: "DROP-REFRESH",
                user: { marker: "DROP-USER" },
                oauth_tokens: ["DROP-OAUTH"],
              }),
      );
    },
  };
  return {
    dependencies,
    calls,
    borrows,
    releases,
    lease,
    parent,
    revocation,
    setClock(value) {
      clock = value;
    },
    control: (deadlineMs = clock + 20000) => Object.freeze({ deadlineMs, signal: parent.signal }),
    create: () => createSyntheticFixedWorkosLoginPort(dependencies),
  };
}
const rejectsHeld = (promise) =>
  assert.rejects(
    promise,
    (error) => error instanceof Error && error.message === "WORKOS_LOGIN_PORT_HELD",
  );

test("construction is inert and exchange is exactly one keyless four-field POST with token-only projection", async () => {
  const f = fixture(),
    port = await f.create();
  assert(Object.isFrozen(port));
  assert.deepEqual(Object.keys(port).sort(), ["exchange", "readPublicKeyset", "readSessionPage"]);
  assert.equal(f.calls.length, 0);
  const result = await port.exchange(JSON.stringify(exchange), f.control());
  assert.deepEqual(JSON.parse(result), { schemaVersion: 1, accessToken: "e30.e30.c2ln" });
  assert.equal(f.borrows.length, 0);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.url, "https://api.workos.com/user_management/authenticate");
  assert.equal(call.init.method, "POST");
  assert.deepEqual(call.init.headers, {
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(call.init.body), {
    client_id: profile.clientId,
    grant_type: "authorization_code",
    code: exchange.code,
    code_verifier: exchange.verifier,
  });
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.cache, "no-store");
  assert.equal(call.init.referrer, "");
  assert.equal(call.init.referrerPolicy, "no-referrer");
  assert(call.init.signal instanceof AbortSignal);
  assert.notEqual(call.init.signal, f.parent.signal);
  assert(!result.includes("DROP-"));
});
test("anonymous keyset projects bounded public fields and discards checked certificate metadata", async () => {
  const f = fixture({
    fetch: async (url) =>
      response(
        url,
        JSON.stringify({
          keys: [
            {
              ...key,
              x5c: [Buffer.from("test certificate").toString("base64")],
              "x5t#S256": Buffer.alloc(32, 9).toString("base64url"),
            },
          ],
        }),
      ),
  });
  const result = JSON.parse(await (await f.create()).readPublicKeyset(f.control()));
  assert.deepEqual(result, {
    schemaVersion: 1,
    profileRevision: 7,
    environmentId: profile.environmentId,
    applicationId: profile.applicationId,
    clientId: profile.clientId,
    observedAtMs: at,
    expiresAtMs: at + 300000,
    jwks: { keys: [key] },
  });
  assert.equal(f.borrows.length, 0);
  assert.equal(f.calls[0].url, `https://api.workos.com/sso/jwks/${profile.clientId}`);
  assert.deepEqual(f.calls[0].init.headers, { accept: "application/json" });
});
test("session GET uses only bound management lease and acknowledges release inside its original cap", async () => {
  const f = fixture({ lease: { expiresAtMs: at + 9000 } });
  const result = await (
    await f.create()
  ).readSessionPage(JSON.stringify({ ...selector, after: id("session", 5) }), f.control());
  assert.deepEqual(JSON.parse(result).data, []);
  assert.equal(f.borrows.length, 1);
  assert.equal(f.borrows[0].text, namespace);
  assert.equal(
    f.calls[0].url,
    `https://api.workos.com/user_management/users/${selector.subjectId}/sessions?limit=100&order=asc&after=${id("session", 5)}`,
  );
  assert.deepEqual(f.calls[0].init.headers, {
    accept: "application/json",
    authorization: "Bearer " + managementMarker,
  });
  assert.equal(f.releases.length, 1);
  assert.equal(f.releases[0].deadlineMs, at + 9000);
  assert(f.releases[0].signal.aborted); // closed only after the success check
});
test("independent callbacks share no used/user/cursor latch", async () => {
  const f = fixture(),
    port = await f.create();
  const results = await Promise.all([
    port.exchange(JSON.stringify(exchange), f.control()),
    port.exchange(
      JSON.stringify({
        ...exchange,
        admissionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        code: "second-code",
      }),
      f.control(),
    ),
    port.readSessionPage(JSON.stringify(selector), f.control()),
    port.readSessionPage(JSON.stringify({ ...selector, subjectId: id("user", 6) }), f.control()),
    port.readPublicKeyset(f.control()),
  ]);
  assert.equal(results.length, 5);
  assert.equal(f.calls.length, 5);
  assert.equal(f.borrows.length, 2);
  // A broker must provide independent lease handles for independent borrows;
  // the same synthetic object is still released once by each operation.
  assert.equal(f.releases.length, 2);
  assert.equal(f.calls.filter((v) => v.init.headers.authorization).length, 2);
});

for (const [name, change] of Object.entries({
  extra: { extra: "caller-choice" },
  foreignClient: { clientId: id("client", 9) },
  foreignCallback: { redirectUri: "https://foreign.example/auth/workos/callback" },
  upperUuid: { admissionId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" },
  invalidUuid: { admissionId: "not-uuid" },
  emptyCode: { code: "" },
  oversizedCode: { code: "x".repeat(4097) },
  malformedSurrogate: { code: "\ud800" },
  invalidVerifier: { verifier: "!".repeat(43) },
  noncanonicalVerifier: { verifier: "A".repeat(42) + "B" },
  shortVerifier: { verifier: "A".repeat(42) },
  wrongVersion: { schemaVersion: 2 },
}))
  test(`exchange input ${name} holds without any transport or broker`, async () => {
    const f = fixture();
    await rejectsHeld(
      (await f.create()).exchange(JSON.stringify({ ...exchange, ...change }), f.control()),
    );
    assert.equal(f.calls.length + f.borrows.length, 0);
  });
test("duplicate exchange members and object inputs cannot cross the wire", async () => {
  const f = fixture(),
    port = await f.create();
  await rejectsHeld(
    port.exchange(
      JSON.stringify(exchange).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      f.control(),
    ),
  );
  await rejectsHeld(port.exchange(exchange, f.control()));
  assert.equal(f.calls.length + f.borrows.length, 0);
});
for (const [name, change] of Object.entries({
  extra: { keyReference: "foreign" },
  subjectPath: { subjectId: "user_x/../x" },
  lowercaseSubject: { subjectId: "user_" + "a".repeat(26) },
  cursor: { after: "session_x?override=true" },
  limit: { limit: 101 },
  order: { order: "desc" },
  missingCursor: { after: undefined },
  wrongVersion: { schemaVersion: 2 },
}))
  test(`session selector ${name} holds before borrowing`, async () => {
    const f = fixture();
    await rejectsHeld(
      (await f.create()).readSessionPage(JSON.stringify({ ...selector, ...change }), f.control()),
    );
    assert.equal(f.calls.length + f.borrows.length, 0);
  });
for (const [name, change] of Object.entries({
  additionalConfiguration: { extra: true },
  foreignIssuer: {
    verificationProfileJson: JSON.stringify({ ...profile, issuer: "https://foreign.example" }),
  },
  foreignOrigin: { origin: "http://workspace.example.test" },
  wrongProtocol: { controllerProtocol: "foreign" },
}))
  test(`invalid existing84 configuration ${name} is inert`, async () => {
    const f = fixture({ configurationJson: JSON.stringify({ ...configuration, ...change }) });
    await rejectsHeld(f.create());
    assert.equal(f.calls.length + f.borrows.length, 0);
  });
test("synthetic transport is mandatory and native constructor rejects injection properties", async () => {
  const f = fixture();
  await rejectsHeld(createSyntheticFixedWorkosLoginPort({ ...f.dependencies, fetch: undefined }));
  await rejectsHeld(createFixedWorkosLoginPort(f.dependencies));
  assert.equal(f.calls.length, 0);
});
for (const [name, value] of Object.entries({
  WORKOS_API_KEY: "hidden",
  HTTPS_PROXY: "http://proxy.invalid",
  NODE_OPTIONS: "--require=fake",
  NODE_EXTRA_CA_CERTS: "/private/fake",
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  SSL_CERT_FILE: "/private/fake",
}))
  test(`native construction denies ambient ${name} without a request`, async () => {
    const old = process.env[name];
    process.env[name] = value;
    const f = fixture();
    try {
      const { fetch: unused, ...native } = f.dependencies;
      await rejectsHeld(createFixedWorkosLoginPort(native));
      assert.equal(f.calls.length + f.borrows.length, 0);
    } finally {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    }
  });

for (const [name, options, body] of [
  ["redirect", { status: 302 }, "{}"],
  ["rate-limit", { status: 429, headers: { "retry-after": "0" } }, "{}"],
  ["server", { status: 500 }, "{}"],
  ["foreign-final-url", { url: "https://foreign.example/" }, "{}"],
  ["redirected-flag", { redirected: true }, "{}"],
  ["html", { headers: { "content-type": "text/html" } }, "{}"],
  [
    "extra-media-parameter",
    { headers: { "content-type": "application/json; charset=utf-8; x=y" } },
    "{}",
  ],
  ["noncanonical-length", { headers: { "content-length": "01" } }, "{}"],
  ["negative-length", { headers: { "content-length": "-1" } }, "{}"],
  ["declared-oversize", { headers: { "content-length": "131073" } }, "{}"],
  ["duplicate", {}, '{"access_token":"e30.e30.c2ln","access_token":"changed"}'],
  ["BOM", {}, "\ufeff{}"],
  ["UTF8", {}, Uint8Array.of(0xc3, 0x28)],
  ["body-oversize", {}, " ".repeat(131073)],
  ["not-compact-token", {}, '{"access_token":"a token with spaces"}'],
  ["token-oversize", {}, JSON.stringify({ access_token: "a".repeat(16381) + ".b.c" })],
])
  test(`response ${name} is held after exactly one POST and never reflected`, async () => {
    const f = fixture({ fetch: async (url) => response(url, body, options) });
    await rejectsHeld((await f.create()).exchange(JSON.stringify(exchange), f.control()));
    assert.equal(f.calls.length, 1);
    assert.equal(f.borrows.length, 0);
  });
test("JSON media is case insensitive and decoded length need not equal compressed content length", async () => {
  const f = fixture({
    fetch: async (url) =>
      response(url, JSON.stringify({ access_token: "e30.e30.c2ln" }), {
        headers: {
          "content-type": "APPLICATION/JSON; CHARSET=UTF-8",
          "content-length": "1",
          "content-encoding": "gzip",
        },
      }),
  });
  assert.deepEqual(
    JSON.parse(await (await f.create()).exchange(JSON.stringify(exchange), f.control())),
    { schemaVersion: 1, accessToken: "e30.e30.c2ln" },
  );
});
for (const [name, keyChange] of Object.entries({
  privateD: { d: "private" },
  certificateEmpty: { x5c: [""] },
  certificateNoncanonical: { x5c: ["YR=="] },
  certificateOversize: { x5c: [Buffer.alloc(8193).toString("base64")] },
  certificateTotal: { x5c: Array(3).fill(Buffer.alloc(8192).toString("base64")) },
  thumbNoncanonical: { "x5t#S256": "A".repeat(42) + "B" },
  extraField: { issuer: "unknown" },
}))
  test(`keyset ${name} rejects material without borrowing`, async () => {
    const f = fixture({
      fetch: async (url) => response(url, JSON.stringify({ keys: [{ ...key, ...keyChange }] })),
    });
    await rejectsHeld((await f.create()).readPublicKeyset(f.control()));
    assert.equal(f.borrows.length, 0);
    assert.equal(f.calls.length, 1);
  });
test("keyset top-level shape/count/snapshot size are independently bounded", async () => {
  for (const body of [
    { keys: [] },
    { keys: Array(17).fill(key) },
    { keys: [key], extra: 1 },
    { keys: [{ ...key, n: "A".repeat(66000) }] },
  ]) {
    const f = fixture({ fetch: async (url) => response(url, JSON.stringify(body)) });
    await rejectsHeld((await f.create()).readPublicKeyset(f.control()));
  }
});
test("normal stream chunks are copied before a later read can mutate prior bytes", async () => {
  const first = new TextEncoder().encode('{"access_token":"e30.'),
    second = new TextEncoder().encode('e30.c2ln"}');
  let pulls = 0;
  const f = fixture({
    fetch: async (url) =>
      response(
        url,
        new ReadableStream(
          {
            pull(controller) {
              if (pulls++ === 0) controller.enqueue(first);
              else {
                first.fill(0xff);
                controller.enqueue(second);
                controller.close();
              }
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  });
  assert.equal(
    JSON.parse(await (await f.create()).exchange(JSON.stringify(exchange), f.control()))
      .accessToken,
    "e30.e30.c2ln",
  );
});
test("non-byte stream chunks and absent bodies hold", async () => {
  for (const body of [
    null,
    new ReadableStream({
      start(controller) {
        controller.enqueue("not bytes");
        controller.close();
      },
    }),
  ]) {
    const f = fixture({ fetch: async (url) => response(url, body) });
    await rejectsHeld((await f.create()).exchange(JSON.stringify(exchange), f.control()));
  }
});
test("abort before invocation, invalid deadline and regressing clock cause no request", async () => {
  const f = fixture(),
    port = await f.create();
  f.parent.abort();
  await rejectsHeld(port.exchange(JSON.stringify(exchange), f.control()));
  for (const value of [NaN, Infinity, -1, 1.5, at]) {
    const g = fixture();
    await rejectsHeld((await g.create()).readPublicKeyset(g.control(value)));
    assert.equal(g.calls.length, 0);
  }
  let calls = 0;
  const g = fixture({ now: () => (calls++ === 0 ? at : at - 1) });
  await rejectsHeld((await g.create()).readPublicKeyset(g.control(at + 10000)));
  assert.equal(g.calls.length + f.calls.length, 0);
});
test("late attributable response is cancelled once after abort and cannot yield a token", async () => {
  const pending = deferred();
  let cancelled = 0;
  const f = fixture({ fetch: () => pending.promise }),
    port = await f.create();
  const result = port.exchange(JSON.stringify(exchange), f.control());
  await tick();
  f.parent.abort();
  await rejectsHeld(result);
  pending.resolve(
    response(
      "https://api.workos.com/user_management/authenticate",
      new ReadableStream({
        cancel() {
          cancelled++;
          return Promise.reject(Error("hidden cancellation error"));
        },
      }),
    ),
  );
  await tick();
  await tick();
  assert.equal(cancelled, 1);
  assert.equal(f.calls.length, 1);
});
test("aborted active reader is cancelled once, while failed cancellation never authorizes output", async () => {
  let cancelled = 0;
  const f = fixture({
    fetch: async (url) =>
      response(
        url,
        new ReadableStream({
          pull() {},
          cancel() {
            cancelled++;
            return Promise.reject(Error("hidden"));
          },
        }),
      ),
  });
  const result = (await f.create()).exchange(JSON.stringify(exchange), f.control());
  await tick();
  f.parent.abort();
  await rejectsHeld(result);
  await tick();
  assert.equal(cancelled, 1);
  assert.equal(f.calls.length, 1);
});
test("deadline covers body reading and does not accept a body after expiry", async () => {
  let sent;
  const f = fixture({
    fetch: async (url) =>
      response(
        url,
        new ReadableStream({
          start(c) {
            sent = c;
          },
        }),
      ),
  });
  const result = (await f.create()).exchange(JSON.stringify(exchange), f.control(at + 100));
  await tick();
  f.setClock(at + 100);
  sent.enqueue(new TextEncoder().encode('{"access_token":"e30.e30.c2ln"}'));
  sent.close();
  await rejectsHeld(result);
  assert.equal(f.calls.length, 1);
});
test("lease arriving after abort gets one separate bounded release and zero GETs", async () => {
  const pending = deferred(),
    f = fixture({ borrow: () => pending.promise }),
    port = await f.create();
  const result = port.readSessionPage(JSON.stringify(selector), f.control(at + 20));
  await tick();
  f.parent.abort();
  await rejectsHeld(result);
  f.setClock(at + 30);
  pending.resolve(f.lease);
  await tick();
  await tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.releases.length, 1);
  assert.equal(f.releases[0].deadlineMs, at + 1030);
  assert.notEqual(f.releases[0].signal, f.parent.signal);
});
for (const [name, lease] of Object.entries({
  namespace: { namespaceJson: namespace + " " },
  expired: { expiresAtMs: at },
  short: { credential: "short" },
  newline: { credential: "bad\n" + "x".repeat(20) },
  nonAscii: { credential: "é".repeat(20) },
  oversize: { credential: "x".repeat(4097) },
  extra: { injectedReference: "not accepted" },
}))
  test(`invalid releasable lease ${name} is retired once without GET`, async () => {
    const f = fixture({ lease });
    await rejectsHeld((await f.create()).readSessionPage(JSON.stringify(selector), f.control()));
    await tick();
    assert.equal(f.calls.length, 0);
    assert.equal(f.releases.length, 1);
  });
test("revocation before or during GET holds and does not retry", async () => {
  const f = fixture();
  f.revocation.abort();
  await rejectsHeld((await f.create()).readSessionPage(JSON.stringify(selector), f.control()));
  await tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.releases.length, 1);
  const pending = deferred(),
    g = fixture({ fetch: () => pending.promise });
  const result = (await g.create()).readSessionPage(JSON.stringify(selector), g.control());
  await tick();
  g.revocation.abort();
  await rejectsHeld(result);
  await tick();
  pending.reject(Error("opaque late network failure"));
  await tick();
  assert.equal(g.calls.length, 1);
  assert.equal(g.releases.length, 1);
});
test("rejected normal release holds permanently and is never invoked twice", async () => {
  let invoked = 0;
  const f = fixture({
    lease: {
      release: async () => {
        invoked++;
        throw Error(managementMarker);
      },
    },
  });
  await rejectsHeld((await f.create()).readSessionPage(JSON.stringify(selector), f.control()));
  await tick();
  assert.equal(invoked, 1);
  assert.equal(f.calls.length, 1);
});
test("unacknowledged release consumes original real deadline; late acknowledgement cannot forward page", async () => {
  const pending = deferred();
  let invoked = 0;
  const f = fixture({
    now: Date.now,
    lease: {
      expiresAtMs: Date.now() + 2000,
      release: () => {
        invoked++;
        return pending.promise;
      },
    },
  });
  const result = (await f.create()).readSessionPage(
    JSON.stringify(selector),
    f.control(Date.now() + 50),
  );
  await rejectsHeld(result);
  pending.resolve();
  await tick();
  assert.equal(invoked, 1);
  assert.equal(f.calls.length, 1);
});
test("release that advances past original observation deadline cannot create a fresh lifetime", async () => {
  const f = fixture({
    lease: {
      release: async () => {
        f.releases.push("attempt");
        f.setClock(at + 5000);
      },
    },
  });
  await rejectsHeld(
    (await f.create()).readSessionPage(JSON.stringify(selector), f.control(at + 5000)),
  );
  assert.equal(f.releases.length, 1);
});
test("late cleanup can remain unverified without hanging the held caller or retrying release", async () => {
  const pending = deferred();
  let invoked = 0,
    cleanupSignal;
  const f = fixture({
    borrow: () => pending.promise,
    lease: {
      release(control) {
        invoked++;
        cleanupSignal = control.signal;
        return new Promise(() => {});
      },
    },
  });
  const result = (await f.create()).readSessionPage(JSON.stringify(selector), f.control());
  await tick();
  f.parent.abort();
  await rejectsHeld(result);
  pending.resolve(f.lease);
  await tick();
  assert.equal(invoked, 1);
  assert.equal(f.calls.length, 0);
  await delay(1050);
  assert(cleanupSignal.aborted);
  assert.equal(invoked, 1);
});
test("getter-based lease is rejected without executing getter or sending credential", async () => {
  let read = 0;
  const f = fixture({
    borrow(_selector, _control, lease) {
      const raw = { ...lease };
      Object.defineProperty(raw, "credential", {
        enumerable: true,
        get() {
          read++;
          return managementMarker;
        },
      });
      return raw;
    },
  });
  await rejectsHeld((await f.create()).readSessionPage(JSON.stringify(selector), f.control()));
  await tick();
  assert.equal(read, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.releases.length, 1);
});
