import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createWorkspaceHttpListener } from "../apps/api/src/workspace-http.ts";

async function serve(make, run) {
  let listener = createWorkspaceHttpListener();
  const server = createServer({ maxHeaderSize: 8192 }, (req, res) => listener(req, res));
  server.headersTimeout = server.requestTimeout = 5000;
  server.maxHeadersCount = 64;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = "http://127.0.0.1:" + server.address().port;
  listener = createWorkspaceHttpListener(make?.(origin));
  try {
    await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
const response = () =>
  new Response('{"ok":true}', {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
function raw(origin, path, headers = [], method = "GET", body) {
  return new Promise((resolve, reject) => {
    const u = new URL(origin);
    const req = httpRequest(
      { hostname: u.hostname, port: u.port, path, method, headers },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: text, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
test("ordinary API scaffold keeps workspace entry denied and health available", async () => {
  await serve(undefined, async (origin) => {
    const health = await fetch(origin + "/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).mode, "scaffold");
    const denied = await fetch(origin + "/workspace/demo/bootstrap");
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { code: "authentication_required" });
    assert.equal(denied.headers.get("cache-control"), "no-store");
  });
});
test("configured Node adapter hands exact host and route to the common Fetch handler", async () => {
  let called = 0;
  await serve(
    (origin) => ({
      origin,
      bootstrap: {
        async fetch(req) {
          called++;
          assert.equal(req.url, origin + "/workspace/one/bootstrap");
          assert.equal(req.headers.get("cookie"), "__Host-morrow_session=synthetic");
          return response();
        },
      },
    }),
    async (origin) => {
      const r = await fetch(origin + "/workspace/one/bootstrap", {
        headers: { cookie: "__Host-morrow_session=synthetic" },
      });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true });
    },
  );
  assert.equal(called, 1);
});
for (const name of [
  "Cookie",
  "Host",
  "Origin",
  "Content-Type",
  "Idempotency-Key",
  "X-Morrow-Request",
  "X-Morrow-CSRF",
  "Sec-Fetch-Site",
]) {
  test("raw duplicate " + name + " is denied before Fetch normalization", async () => {
    let called = 0;
    await serve(
      (origin) => ({
        origin,
        bootstrap: {
          async fetch() {
            called++;
            return response();
          },
        },
      }),
      async (origin) => {
        const host = new URL(origin).host;
        const headers =
          name === "Host"
            ? ["Host", host, "Host", host]
            : ["Host", host, name, "synthetic", name, "synthetic"];
        const r = await raw(origin, "/workspace/one/bootstrap", headers);
        assert.equal(r.status, 400);
        assert.equal(called, 0);
      },
    );
  });
}
for (const target of [
  "/workspace/one/../one/bootstrap",
  "/workspace/one/./bootstrap",
  "//foreign.invalid/workspace/one/bootstrap",
  "http://foreign.invalid/workspace/one/bootstrap",
  "/workspace\\one/bootstrap",
]) {
  test("raw request target normalization cannot select another route: " + target, async () => {
    let called = 0;
    await serve(
      (origin) => ({
        origin,
        bootstrap: {
          async fetch() {
            called++;
            return response();
          },
        },
      }),
      async (origin) => {
        const r = await raw(origin, target, ["Host", new URL(origin).host]);
        assert.equal(r.status, 400);
        assert.equal(called, 0);
      },
    );
  });
}
test("Host cannot be replaced by forwarded headers", async () => {
  let called = 0;
  await serve(
    (origin) => ({
      origin,
      bootstrap: {
        async fetch() {
          called++;
          return response();
        },
      },
    }),
    async (origin) => {
      const r = await raw(origin, "/workspace/one/bootstrap", [
        "Host",
        "foreign.invalid",
        "X-Forwarded-Host",
        new URL(origin).host,
      ]);
      assert.equal(r.status, 400);
      assert.equal(called, 0);
    },
  );
});
test("GET with a declared body cannot reach the protected handler", async () => {
  let called = 0;
  await serve(
    (origin) => ({
      origin,
      bootstrap: {
        async fetch() {
          called++;
          return response();
        },
      },
    }),
    async (origin) => {
      const r = await raw(
        origin,
        "/workspace/one/bootstrap",
        ["Host", new URL(origin).host, "Content-Length", "2"],
        "GET",
        "{}",
      );
      assert.equal(r.status, 400);
      assert.equal(called, 0);
    },
  );
});
test("POST reaches the same streaming Fetch body and linking handler", async () => {
  await serve(
    (origin) => ({
      origin,
      bootstrap: {
        async fetch() {
          throw Error();
        },
      },
      linking: {
        async fetch(req) {
          assert.equal(req.method, "POST");
          assert.deepEqual(await req.json(), { handoffToken: "synthetic" });
          return response();
        },
      },
    }),
    async (origin) => {
      const r = await fetch(origin + "/workspace/one/store-links/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"handoffToken":"synthetic"}',
      });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true });
    },
  );
});
test("browser disconnect aborts the in-flight request passed to the handler", async () => {
  let entered, aborted;
  const entry = new Promise((r) => {
    entered = r;
  });
  const abort = new Promise((r) => {
    aborted = r;
  });
  await serve(
    (origin) => ({
      origin,
      bootstrap: {
        async fetch(req) {
          entered();
          await new Promise((r) => req.signal.addEventListener("abort", r, { once: true }));
          aborted();
          return response();
        },
      },
    }),
    async (origin) => {
      const u = new URL(origin),
        req = httpRequest({ hostname: u.hostname, port: u.port, path: "/workspace/one/bootstrap" });
      req.on("error", () => {});
      req.end();
      await entry;
      req.destroy();
      await Promise.race([
        abort,
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(Error("missing abort")), 1000);
          t.unref();
        }),
      ]);
    },
  );
});
for (const kind of ["oversized", "cookie", "throw"]) {
  test("unsafe or failed handler output is redacted: " + kind, async () => {
    await serve(
      (origin) => ({
        origin,
        bootstrap: {
          async fetch() {
            if (kind === "throw") throw Error("PRIVATE_SQL_FAILURE");
            return kind === "oversized"
              ? new Response("x".repeat(8193))
              : new Response("private", { headers: { "Set-Cookie": "unqualified=private" } });
          },
        },
      }),
      async (origin) => {
        const r = await fetch(origin + "/workspace/one/bootstrap");
        assert.equal(r.status, 503);
        assert.equal(r.headers.has("set-cookie"), false);
        assert.deepEqual(await r.json(), { code: "workspace_unavailable" });
      },
    );
  });
}
