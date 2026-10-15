import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import {
  createWorkosOperatorHandler,
  createWorkosOperatorListener,
} from "../scripts/workos-operator-listener.mjs";
const profile = readFileSync("docs/decisions/workos-operator-qualification.json", "utf8"),
  p = JSON.parse(profile);
const now = 1792000000000,
  state = Buffer.alloc(32, 1).toString("base64url"),
  browserProof = Buffer.alloc(32, 2).toString("base64url"),
  challenge = Buffer.alloc(32, 3).toString("base64url");
function fixture(options = {}) {
  let starts = 0,
    callbacks = 0,
    errors = 0,
    current = now,
    latched = false;
  const received = [],
    url = new URL(p.authorize_endpoint);
  for (const [key, value] of Object.entries({
    provider: "authkit",
    response_type: "code",
    client_id: p.client_id,
    redirect_uri: p.origin + p.callback_path,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    url.searchParams.set(key, value);
  const controller = {
    async start() {
      starts++;
      if (options.startWait) await options.startWait;
      if (options.startError) throw Error("private_start");
      return {
        state,
        browserProof,
        authorizationUrl: options.authorizationUrl ?? url.href,
        expiresAt: new Date(now + 299000).toISOString(),
      };
    },
    complete(text) {
      const value = JSON.parse(text);
      callbacks++;
      received.push(value);
      if (options.throwComplete && callbacks === 1) throw Error("private_controller");
      assert.equal(latched, false);
      latched = true;
      return options.completion ?? Promise.resolve();
    },
    authorizationNotCompleted(text) {
      errors++;
      received.push(JSON.parse(text));
      assert.equal(latched, false);
      latched = true;
      return Promise.resolve();
    },
    status() {
      return { state: options.status ?? "awaiting_callback", providerSessionCleanup: "unknown" };
    },
  };
  const handler = createWorkosOperatorHandler(profile, controller, { clock: () => current });
  return {
    handler,
    controller,
    received,
    get starts() {
      return starts;
    },
    get callbacks() {
      return callbacks;
    },
    get errors() {
      return errors;
    },
    advance(ms) {
      current += ms;
    },
  };
}
async function dispatch(
  f,
  { method = "GET", url = p.start_path, headers = [], body = "", host = "127.0.0.1:4110" } = {},
) {
  const request = new PassThrough();
  request.method = method;
  request.url = url;
  request.rawHeaders = ["Host", host, ...headers.flat()];
  const response = {
    headers: {},
    statusCode: 200,
    writableEnded: false,
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(value = "") {
      this.body = value;
      this.writableEnded = true;
    },
  };
  const pending = f.handler(request, response);
  queueMicrotask(() => request.end(body));
  await pending;
  assert.equal(
    response.headers["referrer-policy"],
    method === "GET" && url === p.start_path && response.statusCode === 200
      ? "same-origin"
      : "no-referrer",
  );
  return response;
}
function cookieValue(response, name) {
  const values = [response.headers["set-cookie"]].flat();
  return values.find((value) => value?.startsWith(name + "="))?.split(";")[0];
}
async function start(f) {
  const landing = await dispatch(f),
    csrf = landing.body.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)[1],
    bootstrap = cookieValue(landing, "morrow_operator_bootstrap");
  const begun = await dispatch(f, {
    method: "POST",
    headers: [
      ["Origin", p.origin],
      ["Cookie", bootstrap],
      ["Content-Type", "application/x-www-form-urlencoded"],
    ],
    body: "csrf=" + csrf,
  });
  return { begun, csrf, bootstrap, proof: cookieValue(begun, "morrow_operator_browser") };
}
const callbackUrl = (code = "opaque code", suffix = "") =>
  `${p.callback_path}?code=${encodeURIComponent(code)}&state=${state}${suffix}`;
function privateHeaders(response, referrerPolicy = "no-referrer") {
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], referrerPolicy);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.ok(response.headers["content-security-policy"].includes("default-src 'none'"));
  assert.equal(response.headers["access-control-allow-origin"], undefined);
}
test("GET start is only a protected form; valid POST begins once and presents a static authorization link", async () => {
  const f = fixture(),
    landing = await dispatch(f);
  assert.equal(landing.statusCode, 200);
  assert.equal(f.starts, 0);
  privateHeaders(landing, "same-origin");
  const { begun, csrf, bootstrap } = await start(f);
  assert.equal(begun.statusCode, 200);
  assert.equal(f.starts, 1);
  assert.ok(begun.body.includes("Continue to WorkOS"));
  assert.ok(begun.body.includes('rel="noreferrer"'));
  assert.ok(!begun.body.includes(browserProof));
  assert.ok(!begun.body.includes(csrf));
  assert.match(begun.headers["set-cookie"][0], /HttpOnly; SameSite=Lax/);
  assert.ok(!begun.headers["set-cookie"][0].includes("Domain="));
  assert.ok(!begun.headers["set-cookie"][0].includes("Secure"));
  privateHeaders(begun);
  const duplicate = await dispatch(f, {
    method: "POST",
    headers: [
      ["Origin", p.origin],
      ["Cookie", bootstrap],
      ["Content-Type", "application/x-www-form-urlencoded"],
    ],
    body: "csrf=" + csrf,
  });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(f.starts, 1);
});
test("start requires exact Origin, bootstrap and CSRF without consuming an invalid initiation", async () => {
  for (const patch of [
    { origin: undefined },
    { origin: "null" },
    { origin: "https://foreign.example" },
    { cookie: undefined },
    { csrf: "wrong" },
    { type: "application/json" },
  ]) {
    const f = fixture(),
      landing = await dispatch(f),
      csrf = landing.body.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)[1],
      bootstrap = cookieValue(landing, "morrow_operator_bootstrap");
    const origin = Object.hasOwn(patch, "origin") ? patch.origin : p.origin,
      cookie = Object.hasOwn(patch, "cookie") ? patch.cookie : bootstrap;
    const headers = [
      ["Content-Type", patch.type ?? "application/x-www-form-urlencoded"],
      ...(origin ? [["Origin", origin]] : []),
      ...(cookie ? [["Cookie", cookie]] : []),
    ];
    assert.equal(
      (await dispatch(f, { method: "POST", headers, body: "csrf=" + (patch.csrf ?? csrf) }))
        .statusCode,
      400,
    );
    assert.equal(f.starts, 0);
    assert.equal((await start(f)).begun.statusCode, 200);
    assert.equal(f.starts, 1);
  }
});
test("same-origin policy applies only to the successful clean start form; null Origin remains denied", async () => {
  const f = fixture(),
    landing = await dispatch(f),
    csrf = landing.body.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)[1],
    bootstrap = cookieValue(landing, "morrow_operator_bootstrap");
  privateHeaders(landing, "same-origin");
  for (const request of [
    { url: p.start_path + "?" },
    { url: p.start_path + "?code=not-a-clean-start" },
    { url: p.start_path + "/" },
    { host: "localhost:4110" },
  ]) {
    const rejected = await dispatch(f, request);
    assert.ok(rejected.statusCode >= 400);
    privateHeaders(rejected);
  }
  const rejected = await dispatch(f, {
    method: "POST",
    headers: [
      ["Origin", "null"],
      ["Cookie", bootstrap],
      ["Content-Type", "application/x-www-form-urlencoded"],
    ],
    body: "csrf=" + csrf,
  });
  assert.equal(rejected.statusCode, 400);
  privateHeaders(rejected);
  assert.equal(f.starts, 0);
  const { begun, proof } = await start(f);
  privateHeaders(begun);
  const noLongerClean = await dispatch(f);
  assert.equal(noLongerClean.statusCode, 409);
  privateHeaders(noLongerClean);
  const callback = await dispatch(f, {
    url: callbackUrl(),
    headers: [["Cookie", proof]],
  });
  assert.equal(callback.statusCode, 303);
  privateHeaders(callback);
  privateHeaders(await dispatch(f, { url: p.result_path }));
  assert.equal(f.starts, 1);
  assert.equal(f.callbacks, 1);
});
test("concurrent valid start requests latch once before the controller await", async () => {
  let finish;
  const startWait = new Promise((resolve) => {
      finish = resolve;
    }),
    f = fixture({ startWait });
  const landing = await dispatch(f),
    csrf = landing.body.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)[1],
    headers = [
      ["Origin", p.origin],
      ["Cookie", cookieValue(landing, "morrow_operator_bootstrap")],
      ["Content-Type", "application/x-www-form-urlencoded"],
    ];
  const one = dispatch(f, { method: "POST", headers, body: "csrf=" + csrf });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await dispatch(f, { method: "POST", headers, body: "csrf=" + csrf })).statusCode,
    400,
  );
  assert.equal(f.starts, 1);
  finish();
  assert.equal((await one).statusCode, 200);
});
test("valid callback without Origin immediately303s while completion remains pending; replay cannot call twice", async () => {
  let finish;
  const completion = new Promise((resolve) => {
      finish = resolve;
    }),
    f = fixture({ completion });
  const { proof } = await start(f);
  const response = await dispatch(f, {
    url: callbackUrl(" exact e\u0301 😀 + "),
    headers: [["Cookie", proof]],
  });
  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.location, p.origin + p.result_path);
  assert.equal(response.body, "");
  assert.equal(f.callbacks, 1);
  assert.equal(f.received[0].code, " exact e\u0301 😀 + ");
  privateHeaders(response);
  assert.equal(
    (await dispatch(f, { url: callbackUrl(), headers: [["Cookie", proof]] })).statusCode,
    400,
  );
  assert.equal(f.callbacks, 1);
  finish();
});
test("callback rejects wrong/duplicate proofs, unknown/duplicate query fields and malformed UTF8 without consuming valid flow", async () => {
  const cases = [
    callbackUrl() + "&code=second",
    callbackUrl() + "&extra=x",
    `${p.callback_path}?code=%FF&state=${state}`,
    `${p.callback_path}?code=%ED%A0%80&state=${state}`,
    `${p.callback_path}?code=%ZZ&state=${state}`,
    `${p.callback_path}?code=%&state=${state}`,
    `${p.callback_path}?code=&state=${state}`,
    `${p.callback_path}?code=x&state=wrong`,
    `${p.callback_path}?%63ode=x&state=${state}`,
    `${p.callback_path}?code=x&state=${state}&state=${state}`,
    `${p.callback_path}?code=x&state=${state}&error=cancel`,
  ];
  for (const url of cases) {
    const f = fixture(),
      { proof } = await start(f);
    assert.equal((await dispatch(f, { url, headers: [["Cookie", proof]] })).statusCode, 400);
    assert.equal(f.callbacks, 0);
    assert.equal(
      (await dispatch(f, { url: callbackUrl(), headers: [["Cookie", proof]] })).statusCode,
      303,
    );
    assert.equal(f.callbacks, 1);
  }
  for (const headers of [
    [],
    [["Cookie", "morrow_operator_browser=" + state]],
    [
      [
        "Cookie",
        `morrow_operator_browser=${browserProof}; morrow_operator_browser=${browserProof}`,
      ],
    ],
    [
      ["Cookie", "morrow_operator_browser=" + browserProof],
      ["Origin", "https://foreign.example"],
    ],
  ]) {
    const f = fixture();
    await start(f);
    assert.equal((await dispatch(f, { url: callbackUrl(), headers })).statusCode, 400);
    assert.equal(f.callbacks, 0);
  }
});
test("strict form-plus decoding preserves opaque values without Unicode normalization", async () => {
  const f = fixture(),
    { proof } = await start(f);
  assert.equal(
    (
      await dispatch(f, {
        url: `${p.callback_path}?code=+e%CC%81+%2B+%00&state=${state}`,
        headers: [["Cookie", proof]],
      })
    ).statusCode,
    303,
  );
  assert.equal(f.received[0].code, " e\u0301 + \u0000");
});
test("closed provider-error callback requires valid browser/state and exposes no description", async () => {
  const f = fixture(),
    { proof } = await start(f),
    response = await dispatch(f, {
      url: `${p.callback_path}?error=access_denied&error_description=private_provider_details&state=${state}`,
      headers: [["Cookie", proof]],
    });
  assert.equal(response.statusCode, 303);
  assert.equal(response.body, "");
  assert.equal(f.errors, 1);
  assert.equal(f.callbacks, 0);
  assert.deepEqual(Object.keys(f.received[0]).sort(), ["browserProof", "state"]);
});
test("exact Host/raw path/method/Origin/cookie cardinality rejects aliases before controller work", async () => {
  for (const options of [
    { host: "localhost:4110" },
    { host: "127.0.0.1:4111" },
    { headers: [["Host", "127.0.0.1:4110"]] },
    {
      headers: [
        ["Origin", p.origin],
        ["Origin", p.origin],
      ],
    },
    {
      headers: [
        ["Cookie", "a=b"],
        ["Cookie", "c=d"],
      ],
    },
    { url: p.start_path + "?" },
    { url: "/operator/workos/%73tart" },
    { url: "//127.0.0.1:4110" + p.start_path },
    { url: p.origin + p.start_path },
    { method: "PUT" },
  ]) {
    const f = fixture(),
      response = await dispatch(f, options);
    assert.ok(response.statusCode >= 400);
    privateHeaders(response);
    assert.equal(f.starts, 0);
    assert.equal(f.callbacks, 0);
  }
});
test("URI/header/cookie/body/code bounds and live flow expiry reject without SQL/provider calls", async () => {
  for (const options of [
    { url: p.callback_path + "?" + "x".repeat(65536) },
    { headers: [["X-Filler", "x".repeat(98304)]] },
    { headers: [["Cookie", "x".repeat(4097)]] },
  ]) {
    const f = fixture();
    assert.ok((await dispatch(f, options)).statusCode >= 400);
    assert.equal(f.starts, 0);
  }
  const f = fixture(),
    { proof } = await start(f);
  assert.equal(
    (await dispatch(f, { url: callbackUrl("x".repeat(4097)), headers: [["Cookie", proof]] }))
      .statusCode,
    400,
  );
  f.advance(299000);
  assert.equal(
    (await dispatch(f, { url: callbackUrl(), headers: [["Cookie", proof]] })).statusCode,
    400,
  );
  assert.equal(f.callbacks, 0);
  const g = fixture(),
    landing = await dispatch(g),
    csrf = landing.body.match(/name="csrf" value="([A-Za-z0-9_-]{43})"/)[1];
  assert.equal(
    (
      await dispatch(g, {
        method: "POST",
        headers: [
          ["Origin", p.origin],
          ["Cookie", cookieValue(landing, "morrow_operator_bootstrap")],
          ["Content-Type", "application/x-www-form-urlencoded"],
          ["Content-Length", "1025"],
        ],
        body: "csrf=" + csrf,
      })
    ).statusCode,
    413,
  );
  assert.equal(g.starts, 0);
});
test("invalid controller validation cannot consume the listener callback latch", async () => {
  const f = fixture({ throwComplete: true }),
    { proof } = await start(f);
  assert.equal(
    (await dispatch(f, { url: callbackUrl(), headers: [["Cookie", proof]] })).statusCode,
    400,
  );
  assert.equal(
    (await dispatch(f, { url: callbackUrl(), headers: [["Cookie", proof]] })).statusCode,
    303,
  );
  assert.equal(f.callbacks, 2);
});
test("result GET is read-only, sanitized and bounded; malformed controller status never echoes", async () => {
  const f = fixture(),
    result = await dispatch(f, { url: p.result_path });
  assert.equal(result.statusCode, 200);
  privateHeaders(result);
  assert.equal(f.starts, 0);
  assert.equal(f.callbacks, 0);
  assert.ok(!result.body.includes(state));
  const g = fixture({ status: "private_provider_message" });
  assert.equal((await dispatch(g, { url: p.result_path })).statusCode, 400);
  for (let i = 0; i < 65; i++) {
    const r = await dispatch(f, { url: p.result_path });
    if (i === 64) assert.equal(r.statusCode, 429);
  }
});
test("foreign authorization URLs are never exposed and fixed listener has no alternate port API", async () => {
  const f = fixture({ authorizationUrl: "https://foreign.example/private" });
  assert.equal((await start(f)).begun.statusCode, 400);
  assert.equal(f.starts, 1);
  const listener = createWorkosOperatorListener(profile, fixture().controller);
  assert.equal(listener.origin, p.origin);
  assert.ok(Object.isFrozen(listener));
  await listener.close();
});
