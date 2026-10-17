import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import {
  createNativeWorkosSessionStatusTransport,
  createSyntheticWorkosSessionStatusTransport,
  workosSessionStatusEnvironmentAllowed,
} from "../scripts/workos-session-status-transport.mjs";
import { workosSessionStatusObserverProfile } from "../scripts/workos-session-status-input.mjs";
const profile = readFileSync("docs/decisions/workos-session-status-qualification.json", "utf8");
const subjectId = "user_" + "A".repeat(26),
  sid = (n) => "session_" + String(n).padStart(26, "0"),
  query = JSON.stringify({ schemaVersion: 1, subjectId, providerSessionId: sid(1) });
const select = (after) =>
  JSON.stringify({ schemaVersion: 1, subjectId, after, limit: 100, order: "asc" });
function response(body, url, options = {}) {
  const r = new Response(body, {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers },
  });
  Object.defineProperty(r, "url", { value: options.url ?? url });
  if (options.redirected) Object.defineProperty(r, "redirected", { value: true });
  return r;
}
function fixture(fetcher, options = {}) {
  let now = 1000;
  const calls = [];
  const transport = createSyntheticWorkosSessionStatusTransport(profile, query, {
    fetch: async (...args) => {
      calls.push(args);
      return fetcher
        ? fetcher(...args)
        : response(
            '{"object":"list","data":[],"list_metadata":{"before":null,"after":null}}',
            args[0],
          );
    },
    clock: () => now,
    fakeCredential: "synthetic-private-key-canary",
    observerProfileJson: workosSessionStatusObserverProfile(profile),
    ...options,
  });
  return {
    transport,
    calls,
    setNow: (n) => {
      now = n;
    },
    read: (after = null, control = {}) =>
      transport.readPage(select(after), {
        deadlineMs: 11000,
        signal: new AbortController().signal,
        ...control,
      }),
  };
}
const denied = (f) => assert.rejects(f, /^Error: WORKOS_SESSION_STATUS_TRANSPORT_HELD$/);
test("fixed GET serialization sends only owned user path, paging and fake auth header", async () => {
  const f = fixture();
  const text = await f.read();
  assert.equal(typeof text, "string");
  assert.equal(f.calls.length, 1);
  const [url, init] = f.calls[0];
  assert.equal(
    url,
    `https://api.workos.com/user_management/users/${subjectId}/sessions?limit=100&order=asc`,
  );
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
  assert.equal(init.credentials, "omit");
  assert.equal(init.body, undefined);
  assert.deepEqual(init.headers, {
    accept: "application/json",
    authorization: "Bearer synthetic-private-key-canary",
  });
  assert.ok(init.signal instanceof AbortSignal);
  const status = JSON.stringify(f.transport.status());
  assert.equal(status.includes(subjectId), false);
  assert.equal(status.includes("private-key"), false);
});
test("at most4 sequential bounded cursor GETs and no restart/cycle/arbitrary user", async () => {
  const f = fixture();
  for (const after of [null, sid(2), sid(3), sid(4)]) await f.read(after);
  await denied(() => f.read(sid(5)));
  assert.equal(f.calls.length, 4);
  for (const selectors of [
    [null, null],
    [null, sid(2), sid(2)],
  ]) {
    const g = fixture();
    for (let i = 0; i < selectors.length - 1; i++) await g.read(selectors[i]);
    await denied(() => g.read(selectors.at(-1)));
  }
  const g = fixture();
  await denied(() =>
    g.transport.readPage(
      JSON.stringify({
        schemaVersion: 1,
        subjectId: "user_" + "Z".repeat(26),
        after: null,
        limit: 100,
        order: "asc",
      }),
      { deadlineMs: 11000, signal: new AbortController().signal },
    ),
  );
  assert.equal(g.calls.length, 0);
});
test("native factory rejects caller credentials/fetch and forged or serialized permits", () => {
  for (const value of [{}, Object.freeze({}), "{}", null, undefined])
    assert.throws(() => createNativeWorkosSessionStatusTransport(value), /HELD|UNAVAILABLE/);
  assert.throws(
    () => createNativeWorkosSessionStatusTransport({}, { fetch: async () => {} }),
    /HELD/,
  );
  const p = JSON.parse(profile);
  for (const patch of [
    { api_origin: "https://foreign.test" },
    { max_gets: 5 },
    { max_seconds: 11 },
    { page_bytes: 131073 },
    { plan_sequence: 74 },
  ])
    assert.throws(
      () =>
        createSyntheticWorkosSessionStatusTransport(JSON.stringify({ ...p, ...patch }), query, {
          fetch: async () => {},
          fakeCredential: "synthetic-key",
        }),
      /UNAVAILABLE/,
    );
  assert.throws(
    () =>
      createSyntheticWorkosSessionStatusTransport(profile, query, {
        fetch: async () => {},
        fakeCredential: "real-key",
      }),
    /HELD/,
  );
});
test("hostile selectors and fixed provider errors cannot invoke getters or leak details", async () => {
  let traps = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        traps++;
        throw Error("private");
      },
      getPrototypeOf() {
        traps++;
        throw Error("private");
      },
      ownKeys() {
        traps++;
        throw Error("private");
      },
    },
  );
  const f = fixture();
  await denied(() =>
    f.transport.readPage(hostile, { deadlineMs: 11000, signal: new AbortController().signal }),
  );
  assert.equal(f.calls.length, 0);
  const g = fixture(async () => {
    throw hostile;
  });
  await denied(() => g.read());
  assert.equal(g.transport.status().category, "transport_failed");
  assert.equal(traps, 0);
  assert.equal(JSON.stringify(g.transport.status()).includes("private"), false);
});
test("exact origin/status/content/declared size and streamed byte guards reject", async () => {
  const cases = [
    { url: "https://foreign.test", category: "response_origin_denied" },
    { redirected: true, category: "response_origin_denied" },
    { status: 302, category: "http_rejected" },
    { status: 401, category: "http_rejected" },
    { headers: { "content-type": "text/plain" }, category: "content_denied" },
    { headers: { "content-length": "131073" }, category: "body_denied" },
    { body: "x".repeat(131073), category: "body_denied" },
    { body: new Uint8Array([255]), category: "shape_denied" },
    { body: '{"data":[],"data":[]}', category: "shape_denied" },
    { body: new Uint8Array([239, 187, 191, 123, 125]), category: "shape_denied" },
  ];
  for (const c of cases) {
    const f = fixture(async (url) => response(c.body ?? "{}", url, c));
    await denied(() => f.read());
    assert.equal(f.transport.status().category, c.category);
    assert.equal(f.calls.length, 1);
    await denied(() => f.read());
    assert.equal(f.calls.length, 1);
  }
});
test("page and total caps accept exactly4x128KiB public JSON but nothing above", async () => {
  const text = "{}" + " ".repeat(131070),
    f = fixture(async (url) => response(text, url));
  for (const after of [null, sid(2), sid(3), sid(4)])
    assert.equal((await f.read(after)).length, 131072);
  assert.equal(f.calls.length, 4);
  await denied(() => f.read(sid(5)));
});
test("shared monotonic deadline, current source and TLS recheck prevent later GET", async () => {
  const f = fixture();
  await f.read();
  f.setNow(11000);
  await denied(() => f.read(sid(2)));
  assert.equal(f.calls.length, 1);
  assert.equal(f.transport.status().category, "timeout");
  const g = fixture();
  await g.read();
  g.setNow(999);
  await denied(() => g.read(sid(2)));
  assert.equal(g.calls.length, 1);
  let valid = true;
  const h = fixture(undefined, { current: () => valid });
  await h.read();
  valid = false;
  await denied(() => h.read(sid(2)));
  assert.equal(h.calls.length, 1);
  const old = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    const i = fixture(undefined, {
      current: () => {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        return true;
      },
    });
    await denied(() => i.read());
    assert.equal(i.calls.length, 0);
  } finally {
    if (old === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = old;
  }
});
test("ambient key/proxy/TLS configuration is denied rather than used", async () => {
  for (const key of [
    "WORKOS_API_KEY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_USE_ENV_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "SSL_CERT_FILE",
  ]) {
    const old = process.env[key];
    try {
      process.env[key] = "synthetic-value";
      assert.equal(workosSessionStatusEnvironmentAllowed(), false);
      const f = fixture();
      await denied(() => f.read());
      assert.equal(f.calls.length, 0);
    } finally {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  }
});
test("real overall timer cancels stalled readers and late responses after return", async () => {
  for (const mode of ["stalled_fetch", "stalled_body", "late_fetch"]) {
    let release,
      cancelled = 0;
    const wait = new Promise((r) => {
      release = r;
    });
    const f = fixture(async (url) =>
      mode === "stalled_body"
        ? response(
            new ReadableStream({
              cancel() {
                cancelled++;
              },
            }),
            url,
          )
        : wait,
    );
    const started = Date.now();
    await denied(() => f.read(null, { deadlineMs: 1015 }));
    assert.ok(Date.now() - started < 1000);
    assert.equal(f.transport.status().category, "timeout");
    if (mode === "stalled_body") assert.equal(cancelled, 1);
    if (mode === "late_fetch") {
      const r = response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        f.calls[0][0],
      );
      release(r);
      await new Promise((r) => setImmediate(r));
      assert.equal(cancelled, 1);
      assert.equal(r.body.locked, false);
    }
    assert.equal(f.calls.length, 1);
  }
});
test("source checks consume the existing overall timer budget before a stalled GET", async () => {
  let now = 1000;
  const f = fixture(async () => new Promise(() => {}), {
    clock: () => now,
    current: () => {
      now = 10999;
      return true;
    },
  });
  const started = Date.now();
  await denied(() => f.read());
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.transport.status().category, "timeout");
});
test("preflight and in-flight cancellation never repeat or expose response data", async () => {
  const c = new AbortController();
  c.abort();
  const f = fixture();
  await denied(() => f.read(null, { signal: c.signal }));
  assert.equal(f.calls.length, 0);
  const d = new AbortController(),
    g = fixture(async () => {
      d.abort();
      return new Promise(() => {});
    });
  await denied(() => g.read(null, { signal: d.signal }));
  assert.equal(g.calls.length, 1);
  assert.equal(g.transport.status().category, "cancelled");
});
test("overlapping page requests and replay stop the attempt", async () => {
  let release;
  const wait = new Promise((r) => {
    release = r;
  });
  const f = fixture(async (url) => {
    await wait;
    return response("{}", url);
  });
  const first = f.read();
  await denied(() => f.read());
  release();
  await denied(() => first);
  assert.equal(f.calls.length, 1);
});
test("synthetic real HTTP exercises fake Authorization without native URL override", async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"object":"list","data":[],"list_metadata":{"before":null,"after":null}}');
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const f = fixture(async (url, init) => {
    assert.ok(url.startsWith("https://api.workos.com/user_management/users/"));
    const local = new URL(url);
    local.protocol = "http:";
    local.hostname = "127.0.0.1";
    local.port = String(server.address().port);
    const r = await fetch(local, init);
    Object.defineProperty(r, "url", { value: url });
    return r;
  });
  await f.read();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].authorization, "Bearer synthetic-private-key-canary");
  assert.ok(seen[0].url.endsWith("?limit=100&order=asc"));
});
