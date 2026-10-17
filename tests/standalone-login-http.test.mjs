import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpsRequest } from "node:https";
import { createServer as createPlainServer, request as plainRequest } from "node:http";
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
const secret = "A".repeat(43);
const cookie = (name = "session", age = 120) =>
  `__Host-morrow_${name}=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
function plan(status = 303, { cookies = [cookie()], headers = [], bodyText = "" } = {}) {
  return Object.freeze({
    status,
    headers: Object.freeze(
      [
        ["cache-control", "no-store"],
        ["x-content-type-options", "nosniff"],
        ["referrer-policy", "no-referrer"],
        ...(status === 303 ? [["location", "/"]] : []),
        ...headers,
      ].map(Object.freeze),
    ),
    cookies: Object.freeze(cookies),
    bodyText,
  });
}
async function serve(make, run, router = false) {
  let listener = createAuthHttpListener();
  const server = createServer({ ...tls.serverOptions, maxHeaderSize: 8192 }, (req, res) =>
    listener(req, res),
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
    await new Promise((resolve) => server.close(resolve));
  }
}
function raw(origin, path, headers = [], method = "GET", body) {
  return new Promise((resolve, reject) => {
    const u = new URL(origin);
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path,
        method,
        headers,
        ca: tls.ca,
        rejectUnauthorized: true,
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: text,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const bound = (origin, dispatch) => ({ origin, auth: { dispatch } });
test("default router keeps both auth and workspace denied", async () => {
  await serve(
    undefined,
    async (origin) => {
      const r = await tls.fetch(origin + "/auth/login", { method: "POST" });
      assert.equal(r.status, 404);
      assert.equal(r.headers.getSetCookie().length, 0);
      assert.equal((await tls.fetch(origin + "/workspace/demo/bootstrap")).status, 401);
    },
    true,
  );
});
test("auth transport accepts only canonical HTTPS source binding", () => {
  for (const origin of [
    "http://127.0.0.1:4110",
    "https://example.com/",
    "https://u:p@example.com",
    "https://example.com:443",
  ])
    assert.throws(() => createAuthHttpListener(bound(origin, async () => {})), /CONFIGURATION/);
});
test("a configured HTTPS authority cannot issue a cookie through a plaintext socket", async () => {
  let listener,
    calls = 0;
  const server = createPlainServer((request, response) => listener(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  listener = createAuthHttpListener(
    bound(`https://127.0.0.1:${port}`, async () => {
      calls++;
    }),
  );
  try {
    const response = await new Promise((resolve, reject) => {
      const req = plainRequest(
        { hostname: "127.0.0.1", port, path: "/auth/workos/callback" },
        (reply) => {
          reply.resume();
          reply.once("end", () => resolve(reply));
        },
      );
      req.once("error", reject);
      req.end();
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(response.headers.connection, "close");
    assert.equal(calls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test(
  "raw rejection closes after its fixed response without draining an unfinished body",
  { timeout: 6000 },
  async () => {
    let calls = 0;
    await serve(
      (origin) =>
        bound(origin, async () => {
          calls++;
        }),
      async (origin) => {
        const u = new URL(origin);
        const response = await new Promise((resolve, reject) => {
          const req = httpsRequest(
            {
              hostname: u.hostname,
              port: u.port,
              path: "/auth/login",
              method: "POST",
              ca: tls.ca,
              rejectUnauthorized: true,
              headers: [
                "Host",
                u.host,
                "Content-Length",
                "99999999",
                "X-Morrow-Request",
                "1",
                "X-Morrow-Request",
                "1",
              ],
            },
            (reply) => {
              reply.resume();
              reply.once("end", () => {
                resolve(reply);
                req.destroy();
              });
            },
          );
          req.once("error", reject);
          req.setTimeout(3000, () => req.destroy(Error("LOCAL_REJECTION_TIMEOUT")));
          req.flushHeaders(); // Intentionally neither send nor terminate that body.
        });
        assert.equal(response.statusCode, 400);
        assert.equal(response.headers["set-cookie"], undefined);
        assert.equal(response.headers.connection, "close");
      },
    );
    assert.equal(calls, 0);
  },
);
test("synchronous sink writes a separate exact session Set-Cookie before dispatch resumes", async () => {
  let calls = 0;
  await serve(
    (origin) =>
      bound(origin, async (req, sink) => {
        calls++;
        assert.equal(req.url, origin + "/auth/workos/callback?code=x&state=y");
        const out = plan();
        sink(out);
        assert.ok(Object.isFrozen(out.cookies));
        throw Error("fixed post-handoff failure");
      }),
    async (origin) => {
      const r = await raw(origin, "/auth/workos/callback?code=x&state=y", [
        "Host",
        new URL(origin).host,
      ]);
      assert.equal(r.status, 303);
      assert.equal(r.headers.location, "/");
      assert.deepEqual(r.headers["set-cookie"], [cookie()]);
      assert.equal(r.body, "");
      assert.equal(r.rawHeaders.filter((x) => x.toLowerCase() === "set-cookie").length, 1);
    },
  );
  assert.equal(calls, 1);
});
test("successful JSON start delivers only one preauth cookie", async () => {
  await serve(
    (origin) =>
      bound(origin, async (req, sink) => {
        assert.equal(await req.text(), "{}");
        sink(
          plan(200, {
            cookies: [cookie("login", 300)],
            headers: [["content-type", "application/json; charset=utf-8"]],
            bodyText:
              '{"schemaVersion":1,"authorizationUrl":"https://api.workos.com/user_management/authorize"}',
          }),
        );
      }),
    async (origin) => {
      const r = await tls.fetch(origin + "/auth/login", { method: "POST", body: "{}" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.headers.getSetCookie(), [cookie("login", 300)]);
      assert.equal(r.headers.get("access-control-allow-origin"), null);
    },
  );
});
for (const name of [
  "Cookie",
  "Host",
  "Origin",
  "Authorization",
  "Content-Type",
  "Content-Length",
  "X-Morrow-Request",
  "Sec-Fetch-Site",
  "Sec-Fetch-Mode",
  "Sec-Fetch-Dest",
  "Sec-Fetch-User",
])
  test("raw duplicate " + name + " is rejected before auth dispatch", async () => {
    let calls = 0;
    await serve(
      (origin) =>
        bound(origin, async () => {
          calls++;
        }),
      async (origin) => {
        const host = new URL(origin).host;
        const headers =
          name === "Host" ? ["Host", host, "hOSt", host] : ["Host", host, name, "x", name, "x"];
        const r = await raw(origin, "/auth/workos/callback", headers);
        assert.equal(r.status, 400);
        assert.equal(r.headers["set-cookie"], undefined);
      },
    );
    assert.equal(calls, 0);
  });
for (const path of [
  "//other.example/auth/login",
  "/auth/../auth/login",
  "/auth/login#fragment",
  "/auth/%6cogin",
])
  test("raw target cannot be normalized into a different auth route: " + path, async () => {
    let calls = 0;
    await serve(
      (origin) =>
        bound(origin, async () => {
          calls++;
        }),
      async (origin) => {
        const r = await raw(origin, path, ["Host", new URL(origin).host]);
        assert.ok([400, 404].includes(r.status));
        assert.equal(r.headers["set-cookie"], undefined);
      },
    );
    assert.equal(calls, 0);
  });
test("foreign Host and Authorization deny before the controller", async () => {
  let calls = 0;
  await serve(
    (origin) =>
      bound(origin, async () => {
        calls++;
      }),
    async (origin) => {
      for (const h of [
        ["Host", "foreign.example"],
        ["Host", new URL(origin).host, "Authorization", "Bearer fixed"],
      ])
        assert.equal((await raw(origin, "/auth/workos/callback", h)).status, 400);
    },
  );
  assert.equal(calls, 0);
});
test("GET framing body is rejected before controller", async () => {
  let calls = 0;
  await serve(
    (origin) =>
      bound(origin, async () => {
        calls++;
      }),
    async (origin) => {
      const r = await raw(
        origin,
        "/auth/workos/callback",
        ["Host", new URL(origin).host, "Content-Length", "1"],
        "GET",
        "x",
      );
      assert.equal(r.status, 400);
    },
  );
  assert.equal(calls, 0);
});
for (const [name, output] of [
  ["comma-combined cookie", plan(303, { cookies: [cookie() + ", " + cookie()] })],
  ["Domain attribute", plan(303, { cookies: [cookie() + "; Domain=example.com"] })],
  ["session lifetime extension", plan(303, { cookies: [cookie("session", 901)] })],
  ["preauth on callback", plan(303, { cookies: [cookie("login")] })],
  ["cookie as a response header", plan(303, { headers: [["set-cookie", cookie()]] })],
  ["unbounded body", plan(303, { bodyText: "x".repeat(8193) })],
  ["mutable delivery", { ...plan() }],
  ["extra delivery field", Object.freeze({ ...plan(), authority: "unsupported" })],
  ["multiple credentials", plan(303, { cookies: [cookie(), cookie()] })],
  ["redirect without credential", plan(303, { cookies: [] })],
])
  test("unsafe delivery snapshot is held without cookies: " + name, async () => {
    await serve(
      (origin) => bound(origin, async (_req, sink) => sink(output)),
      async (origin) => {
        const r = await tls.fetch(origin + "/auth/workos/callback");
        assert.equal(r.status, 503);
        assert.equal(r.headers.getSetCookie().length, 0);
        assert.deepEqual(await r.json(), { schemaVersion: 1, outcome: "login_unavailable" });
      },
    );
  });
test("throw before handoff is generic and contains no private exception", async () => {
  await serve(
    (origin) =>
      bound(origin, async () => {
        throw Error("PRIVATE_TEST_MARKER");
      }),
    async (origin) => {
      const r = await tls.fetch(origin + "/auth/workos/callback");
      assert.equal(r.status, 503);
      assert.equal(r.headers.getSetCookie().length, 0);
      assert.ok(!(await r.text()).includes("PRIVATE_TEST_MARKER"));
    },
  );
});
test("a sink cannot be reused after its first synchronous handoff", async () => {
  let rejected = false;
  await serve(
    (origin) =>
      bound(origin, async (_req, sink) => {
        sink(plan());
        try {
          sink(plan());
        } catch {
          rejected = true;
        }
      }),
    async (origin) => {
      const r = await tls.fetch(origin + "/auth/workos/callback");
      assert.equal(r.status, 303);
      assert.equal(r.headers.getSetCookie().length, 1);
    },
  );
  assert.equal(rejected, true);
});
test("disconnect aborts the owned request and suppresses a late cookie handoff", async () => {
  let enteredResolve, closedResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const closed = new Promise((resolve) => {
    closedResolve = resolve;
  });
  let held = false;
  await serve(
    (origin) =>
      bound(origin, async (input, sink) => {
        enteredResolve();
        await new Promise((resolve) =>
          input.signal.addEventListener("abort", resolve, { once: true }),
        );
        try {
          sink(plan());
        } catch {
          held = true;
        }
        closedResolve();
      }),
    async (origin) => {
      const u = new URL(origin);
      const req = httpsRequest({
        hostname: u.hostname,
        port: u.port,
        path: "/auth/workos/callback",
        ca: tls.ca,
        rejectUnauthorized: true,
      });
      req.on("error", () => {});
      req.end();
      await entered;
      req.destroy();
      await closed;
    },
  );
  assert.equal(held, true);
});
test(
  "HTTP entry timeout aborts an unresponsive start and emits no cookie",
  { timeout: 8000 },
  async () => {
    let aborted = false;
    await serve(
      (origin) =>
        bound(origin, async (input, sink) => {
          await new Promise((resolve) =>
            input.signal.addEventListener("abort", resolve, { once: true }),
          );
          aborted = input.signal.aborted;
          assert.throws(() => sink(plan(200, { cookies: [cookie("login")] })), /HELD/);
        }),
      async (origin) => {
        const response = await tls.fetch(origin + "/auth/login", { method: "POST" });
        assert.equal(response.status, 503);
        assert.equal(response.headers.getSetCookie().length, 0);
        assert.deepEqual(await response.json(), { schemaVersion: 1, outcome: "login_unavailable" });
      },
    );
    assert.equal(aborted, true);
  },
);
test("router preserves the existing workspace response-cookie prohibition", async () => {
  let authCalls = 0;
  await serve(
    (origin) => ({
      ...bound(origin, async () => {
        authCalls++;
      }),
      bootstrap: {
        async fetch() {
          return new Response("{}", { headers: { "Set-Cookie": cookie() } });
        },
      },
    }),
    async (origin) => {
      const r = await tls.fetch(origin + "/workspace/demo/bootstrap");
      assert.equal(r.status, 503);
      assert.equal(r.headers.getSetCookie().length, 0);
    },
    true,
  );
  assert.equal(authCalls, 0);
});
