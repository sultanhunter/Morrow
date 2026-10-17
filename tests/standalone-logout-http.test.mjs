import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpsRequest } from "node:https";
import { createServer as createPlainServer, request as httpRequest } from "node:http";
import { createAuthHttpListener } from "../apps/api/src/auth-http.ts";
import { createWorkspaceApiHttpListener } from "../apps/api/src/workspace-router.ts";
import { createLocalLoginTlsFixture } from "../scripts/fixtures/login-https.mjs";
let tls;
before(async () => {
  tls = await createLocalLoginTlsFixture();
});
after(async () => {
  await tls?.cleanup();
});
const ended = '{"schemaVersion":1,"outcome":"session_ended"}';
const unavailable = '{"schemaVersion":1,"outcome":"logout_unavailable"}';
const unknown = '{"schemaVersion":1,"outcome":"logout_outcome_unknown"}';
function plan(
  status = 200,
  { bodyText = status === 200 ? ended : unavailable, headers = [], cookies = [] } = {},
) {
  return Object.freeze({
    status,
    bodyText,
    headers: Object.freeze(
      [
        ["content-type", "application/json; charset=utf-8"],
        ["cache-control", "no-store"],
        ["x-content-type-options", "nosniff"],
        ["referrer-policy", "no-referrer"],
        ...headers,
      ].map(Object.freeze),
    ),
    cookies: Object.freeze(cookies),
  });
}
async function serve(make, run, router = false) {
  let listener = createAuthHttpListener();
  const server = createServer({ ...tls.serverOptions, maxHeaderSize: 8192 }, (q, s) =>
    listener(q, s),
  );
  server.headersTimeout = server.requestTimeout = 5000;
  server.maxHeadersCount = 64;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `https://127.0.0.1:${server.address().port}`;
  listener = (router ? createWorkspaceApiHttpListener : createAuthHttpListener)(make?.(origin));
  try {
    await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
function raw(
  origin,
  { path = "/auth/logout", method = "POST", headers = [], body = '{"schemaVersion":1}' } = {},
) {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path,
        method,
        headers: ["Host", u.host, ...headers],
        ca: tls.ca,
        rejectUnauthorized: true,
      },
      (reply) => {
        let text = "";
        reply.on("data", (c) => (text += c));
        reply.once("end", () =>
          resolve({ status: reply.statusCode, body: text, headers: reply.headers }),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}
const binding = (origin, dispatch) => ({
  origin,
  auth: {
    dispatch: async () => {
      throw Error("LOGIN_MUST_NOT_RECEIVE_LOGOUT");
    },
  },
  logout: { dispatch },
});
function noCookie(r) {
  assert.equal(r.headers["set-cookie"], undefined);
  assert.equal(r.headers.location, undefined);
  assert.equal(r.headers["access-control-allow-origin"], undefined);
}
test("logout is denied without its dedicated binding and never reaches login", async () => {
  let calls = 0;
  await serve(
    (origin) => ({
      origin,
      auth: {
        dispatch: async () => {
          calls++;
        },
      },
    }),
    async (origin) => {
      const r = await raw(origin);
      assert.equal(r.status, 404);
      noCookie(r);
    },
  );
  assert.equal(calls, 0);
});
test("default router remains denied for logout and workspace", async () => {
  await serve(
    undefined,
    async (origin) => {
      const a = await raw(origin);
      assert.equal(a.status, 404);
      noCookie(a);
      const b = await tls.fetch(origin + "/workspace/demo/bootstrap");
      assert.equal(b.status, 401);
      assert.equal(b.headers.getSetCookie().length, 0);
    },
    true,
  );
});
for (const status of [200, 400, 403, 404, 405, 503])
  test(`dedicated logout fixed ${status} response has no cookie operation`, async () => {
    let calls = 0;
    await serve(
      (origin) =>
        binding(origin, async (req, sink) => {
          calls++;
          assert.equal(req.url, origin + "/auth/logout");
          assert.equal(await req.text(), '{"schemaVersion":1}');
          sink(plan(status));
        }),
      async (origin) => {
        const r = await raw(origin);
        assert.equal(r.status, status);
        assert.equal(r.body, status === 200 ? ended : unavailable);
        noCookie(r);
        assert.equal(r.headers["cache-control"], "no-store");
      },
      true,
    );
    assert.equal(calls, 1);
  });
test("unknown outcome remains fixed and private", async () => {
  await serve(
    (origin) => binding(origin, async (_, sink) => sink(plan(503, { bodyText: unknown }))),
    async (origin) => {
      const r = await raw(origin);
      assert.equal(r.status, 503);
      assert.equal(r.body, unknown);
      noCookie(r);
    },
  );
});
for (const [name, output, method] of [
  [
    "session cookie",
    plan(200, {
      cookies: [
        "__Host-morrow_session=" +
          "A".repeat(43) +
          "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900",
      ],
    }),
  ],
  [
    "preauth cookie",
    plan(200, {
      cookies: [
        "__Host-morrow_login=" +
          "A".repeat(43) +
          "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300",
      ],
    }),
  ],
  ["redirect", plan(303, { headers: [["location", "/"]] })],
  ["CORS", plan(200, { headers: [["access-control-allow-origin", "*"]] })],
  ["private body", plan(200, { bodyText: '{"family_id":"private"}' })],
  ["wrong-method success", plan(200), "GET"],
])
  test(`logout transport refuses ${name} without emitting it`, async () => {
    await serve(
      (origin) => binding(origin, async (_, sink) => sink(output)),
      async (origin) => {
        const r = await raw(origin, {
          method: method ?? "POST",
          body: method === "GET" ? null : '{"schemaVersion":1}',
        });
        assert.equal(r.status, 503);
        assert.equal(r.body, unknown);
        noCookie(r);
      },
    );
  });
test("a successful logout response is handed off once even if dispatch subsequently rejects", async () => {
  let calls = 0;
  await serve(
    (origin) =>
      binding(origin, async (_, sink) => {
        calls++;
        sink(plan());
        throw Error("PRIVATE_AFTER_HANDOFF");
      }),
    async (origin) => {
      const r = await raw(origin);
      assert.equal(r.status, 200);
      assert.equal(r.body, ended);
      noCookie(r);
    },
  );
  assert.equal(calls, 1);
});
test("a missing or failed logout sink remains unknown rather than definite failure", async () => {
  for (const dispatch of [
    async () => {},
    async () => {
      throw Error("PRIVATE_FAILURE");
    },
  ])
    await serve(
      (origin) => binding(origin, dispatch),
      async (origin) => {
        const r = await raw(origin);
        assert.equal(r.status, 503);
        assert.equal(r.body, unknown);
        noCookie(r);
      },
    );
});
for (const name of [
  "Cookie",
  "Origin",
  "X-Morrow-Request",
  "Sec-Fetch-Site",
  "Content-Type",
  "Authorization",
])
  test(`raw duplicate ${name} is rejected before logout dispatch`, async () => {
    let calls = 0;
    await serve(
      (origin) =>
        binding(origin, async () => {
          calls++;
        }),
      async (origin) => {
        const r = await raw(origin, { headers: [name, "x", name, "x"] });
        assert.equal(r.status, 400);
        noCookie(r);
      },
    );
    assert.equal(calls, 0);
  });
test("native logout body stream is bounded at257 bytes and still delivers400 before closing", async () => {
  let seen = 0;
  await serve(
    (origin) =>
      binding(origin, async (req, sink) => {
        const bytes = new Uint8Array(await req.arrayBuffer());
        seen = bytes.length;
        sink(plan(400));
      }),
    async (origin) => {
      const r = await raw(origin, {
        headers: ["Transfer-Encoding", "chunked"],
        body: "x".repeat(8192),
      });
      assert.equal(r.status, 400);
      assert.equal(r.body, unavailable);
      assert.equal(r.headers.connection, "close");
      noCookie(r);
    },
  );
  assert.equal(seen, 257);
});
test("plaintext transport cannot invoke logout even with a configured HTTPS origin", async () => {
  let listener,
    calls = 0;
  const server = createPlainServer((q, s) => listener(q, s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  listener = createAuthHttpListener(
    binding(`https://127.0.0.1:${port}`, async () => {
      calls++;
    }),
  );
  try {
    const r = await new Promise((resolve, reject) => {
      const q = httpRequest(
        { host: "127.0.0.1", port, path: "/auth/logout", method: "POST" },
        (reply) => {
          reply.resume();
          reply.once("end", () => resolve(reply));
        },
      );
      q.once("error", reject);
      q.end();
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.headers["set-cookie"], undefined);
    assert.equal(calls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test("disconnect aborts the captured request and a late logout completion cannot resend", async () => {
  const entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  let aborted = false,
    late = false;
  await serve(
    (origin) =>
      binding(origin, async (req, sink) => {
        req.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            gate.resolve();
          },
          { once: true },
        );
        entered.resolve();
        await gate.promise;
        assert.throws(() => sink(plan()), /HELD/);
        late = true;
      }),
    async (origin) => {
      const u = new URL(origin);
      const q = httpsRequest({
        hostname: u.hostname,
        port: u.port,
        path: "/auth/logout",
        method: "POST",
        ca: tls.ca,
        rejectUnauthorized: true,
      });
      q.on("error", () => {});
      q.end('{"schemaVersion":1}');
      await entered.promise;
      q.destroy();
      await gate.promise;
      await new Promise((r) => setTimeout(r, 10));
    },
  );
  assert.equal(aborted, true);
  assert.equal(late, true);
});

test(
  "native entry deadline aborts a stalled logout and reports fixed unknown without resend",
  { timeout: 6500 },
  async () => {
    let aborted = false,
      late = false;
    await serve(
      (origin) =>
        binding(origin, async (req, sink) => {
          await new Promise((resolve) =>
            req.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            ),
          );
          assert.throws(() => sink(plan()), /HELD/);
          late = true;
        }),
      async (origin) => {
        const response = await raw(origin);
        assert.equal(response.status, 503);
        assert.equal(response.body, unknown);
        noCookie(response);
      },
    );
    assert.equal(aborted, true);
    assert.equal(late, true);
  },
);
