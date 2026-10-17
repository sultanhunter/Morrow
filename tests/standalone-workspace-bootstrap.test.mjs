import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createStandaloneWorkspaceBootstrap } from "../packages/identity/src/standalone-workspace-bootstrap.ts";
import {
  createStandaloneRequestGuard,
  standaloneJson,
} from "../packages/identity/src/standalone-request-guard.ts";
import { identitySql } from "../packages/identity/src/index.ts";

const origin = "https://workspace.example.test";
const secret = Buffer.alloc(32, 27).toString("base64url");
const token = Buffer.alloc(32, 31).toString("base64url");
const command = "e519ea9d-c5eb-4613-906c-26a870c0e9e8";
const sessionDigest = createHash("sha256").update(secret).digest("hex");
const config = JSON.stringify({ schemaVersion: 1, mode: "https", origin });
const row = {
  principal_id: "human_a",
  organization_id: "org_a",
  workspace_id: "workspace_a",
  membership_id: "membership_a",
  policy_revision: "1",
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function request({
  path = "/workspace/workspace_a/bootstrap",
  headers = {},
  method = "GET",
  signal,
  body,
  url = origin + path,
} = {}) {
  return new Request(url, {
    method,
    headers: { Cookie: `__Host-morrow_session=${secret}`, ...headers },
    ...(signal ? { signal } : {}),
    ...(body !== undefined ? { body } : {}),
  });
}
function fixture(options = {}) {
  let at = 100000,
    calls = [],
    releases = [],
    connects = 0;
  const client = {
    async query(text, values, control) {
      calls.push({ text, values, control });
      assert.ok(Object.isFrozen(control));
      assert.ok(Object.isFrozen(values));
      assert.equal(control.deadlineMs, 105000);
      await options.stage?.(Object.entries(identitySql).find(([, value]) => value === text)?.[0], {
        setTime: (v) => {
          at = v;
        },
        control,
      });
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
              ...options.role,
            },
          ],
        };
      if (text === identitySql.resolve)
        return { rows: options.missing ? [] : [{ ...row, ...options.context }] };
      if (text === identitySql.workspace)
        return {
          rows: options.revokedWorkspace
            ? []
            : [
                {
                  id: "workspace_a",
                  organization_id: "org_a",
                  display_name: "Synthetic A",
                  ...options.workspace,
                },
              ],
        };
      if (text === identitySql.workspaceAuthority)
        return {
          rows: options.revokedAuthority
            ? []
            : [{ ...row, policy_revision: "2", grants: [], ...options.authority }],
        };
      return { rows: [] };
    },
    async release(discard) {
      releases.push(discard);
      await options.release?.();
    },
  };
  const pool = {
    async connect(control) {
      connects++;
      await options.connect?.(control);
      return client;
    },
  };
  const api = createStandaloneWorkspaceBootstrap({
    configurationJson: options.configuration ?? config,
    pool,
    now: () => at,
  });
  return {
    api,
    calls,
    releases,
    get connects() {
      return connects;
    },
    setTime(v) {
      at = v;
    },
  };
}
test("canonical cookie reads current workspace/policy through unchanged parameterized SQL", async () => {
  const f = fixture();
  const response = await f.api.fetch(
    request({
      headers: {
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        Cookie: `other=ok; __Host-morrow_session=${secret}; empty=`,
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    workspace: { id: "workspace_a", displayName: "Synthetic A" },
    policyRevision: 2,
  });
  assert.deepEqual(f.calls.find((call) => call.text === identitySql.bind).values, [
    sessionDigest,
    "workspace_a",
  ]);
  assert.equal(f.calls.at(-1).text, identitySql.commit);
  assert.deepEqual(f.releases, [true]);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  assert.ok(f.calls.every((call) => !call.text.includes(secret)));
});
for (const [name, value] of [
  ["caller object", {}],
  ["unknown field", JSON.stringify({ schemaVersion: 1, mode: "https", origin, enabled: true })],
  [
    "duplicate field",
    `{"schemaVersion":1,"mode":"https","origin":"${origin}","origin":"${origin}"}`,
  ],
  [
    "insecure https mode",
    JSON.stringify({ schemaVersion: 1, mode: "https", origin: "http://example.test" }),
  ],
  [
    "noncanonical origin",
    JSON.stringify({ schemaVersion: 1, mode: "https", origin: origin + "/" }),
  ],
  [
    "wrong loopback host",
    JSON.stringify({
      schemaVersion: 1,
      mode: "loopback_qualification",
      origin: "http://localhost:4111",
    }),
  ],
  [
    "bad loopback port",
    JSON.stringify({
      schemaVersion: 1,
      mode: "loopback_qualification",
      origin: "http://127.0.0.1:99999",
    }),
  ],
])
  test("configuration rejects " + name, () =>
    assert.throws(() => fixture({ configuration: value }), /CONFIG_INVALID/),
  );
test("configuration rejects hostile object before reflection", () => {
  let traps = 0;
  assert.throws(
    () =>
      createStandaloneRequestGuard(
        new Proxy(
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
        ),
        Date.now,
      ),
    /CONFIG_INVALID/,
  );
  assert.equal(traps, 0);
});
for (const [name, cookie] of [
  ["missing", ""],
  ["absent named cookie", "other=ok"],
  ["short", "__Host-morrow_session=abc"],
  ["padding", `__Host-morrow_session=${secret}=`],
  ["unused padding bits", `__Host-morrow_session=${secret.slice(0, -1)}B`],
  ["quoted", `__Host-morrow_session="${secret}"`],
  ["percent encoded", `__Host-morrow_session=%41${secret.slice(1)}`],
  ["duplicate", `__Host-morrow_session=${secret}; __Host-morrow_session=${secret}`],
  ["comma merge", `__Host-morrow_session=${secret},__Host-morrow_session=${secret}`],
  ["case mismatch", `__host-morrow_session=${secret}`],
  ["empty pair", `__Host-morrow_session=${secret};`],
  [
    "too many pairs",
    `__Host-morrow_session=${secret};` + Array.from({ length: 32 }, (_, i) => `c${i}=a`).join(";"),
  ],
  ["too long", `__Host-morrow_session=${secret};other=` + "a".repeat(4096)],
])
  test("cookie denies " + name + " before SQL", async () => {
    const f = fixture();
    const response = await f.api.fetch(request({ headers: { Cookie: cookie } }));
    assert.equal(response.status, 401);
    assert.equal(f.connects, 0);
  });
for (const [name, change, status] of [
  ["query credential", { path: "/workspace/workspace_a/bootstrap?session=" + secret }, 403],
  ["fragment", { path: "/workspace/workspace_a/bootstrap#x" }, 403],
  ["encoded identifier", { path: "/workspace/%77orkspace_a/bootstrap" }, 404],
  ["extra segment", { path: "/workspace/workspace_a/bootstrap/extra" }, 404],
  ["post method", { method: "POST", body: "{}" }, 405],
  [
    "foreign URL origin",
    { url: "https://foreign.example.test/workspace/workspace_a/bootstrap" },
    403,
  ],
  ["foreign Host", { headers: { Host: "foreign.example.test" } }, 403],
  ["merged Host", { headers: { Host: "workspace.example.test,workspace.example.test" } }, 403],
  ["foreign Origin", { headers: { Origin: "https://foreign.example.test" } }, 403],
  ["null Origin", { headers: { Origin: "null" } }, 403],
  ["same-site fetch", { headers: { "Sec-Fetch-Site": "same-site" } }, 403],
  ["cross-site fetch", { headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
  ["Bearer fallback", { headers: { Authorization: "Bearer " + secret } }, 401],
  ["claimed body", { headers: { "Content-Length": "1" } }, 400],
  ["content type", { headers: { "Content-Type": "application/json" } }, 400],
  ["idempotency header", { headers: { "Idempotency-Key": command } }, 400],
  ["CSRF header", { headers: { "X-Morrow-CSRF": secret } }, 400],
])
  test("transport denies " + name + " before SQL", async () => {
    const f = fixture();
    const response = await f.api.fetch(request(change));
    assert.equal(response.status, status);
    assert.equal(f.connects, 0);
    if (status === 405) assert.equal(response.headers.get("Allow"), "GET");
  });
for (const [name, options] of [
  ["foreign workspace", { context: { workspace_id: "workspace_b" } }],
  ["inactive family", { missing: true }],
  ["workspace revoked after resolution", { revokedWorkspace: true }],
  ["membership revoked before final authority", { revokedAuthority: true }],
  ["organization changed", { authority: { organization_id: "org_b" } }],
  ["principal changed", { authority: { principal_id: "human_b" } }],
  ["membership changed", { authority: { membership_id: "membership_b" } }],
  ["unsafe SQL role", { role: { rolsuper: true } }],
])
  test("current SQL denies " + name, async () => {
    const f = fixture(options);
    const response = await f.api.fetch(request());
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { code: "authentication_required" });
    assert.deepEqual(f.releases, [true]);
  });
test("asynchronous disposal completes before success", async () => {
  const release = deferred();
  const f = fixture({ release: () => release.promise });
  let answered = false;
  const pending = f.api.fetch(request()).then((r) => {
    answered = true;
    return r;
  });
  while (!f.releases.length) await tick();
  assert.equal(answered, false);
  release.resolve();
  assert.equal((await pending).status, 200);
});
for (const stage of ["begin", "resolve", "workspace", "workspaceAuthority", "commit"])
  test("lost " + stage + " acknowledgement closes before any further SQL", async () => {
    const release = deferred();
    const f = fixture({
      stage(current) {
        if (current === stage) throw Error("PRIVATE_UNCERTAIN_QUERY");
      },
      release: () => release.promise,
    });
    let answered = false;
    const pending = f.api.fetch(request()).then((response) => {
      answered = true;
      return response;
    });
    while (!f.releases.length) await tick();
    assert.equal(answered, false);
    assert.equal(f.calls.at(-1).text, identitySql[stage]);
    assert.ok(!f.calls.some((call) => call.text === identitySql.rollback));
    release.resolve();
    assert.equal((await pending).status, 503);
    assert.deepEqual(f.releases, [true]);
  });
test("known completed semantic denial still permits read-only transaction rollback", async () => {
  const f = fixture({ missing: true });
  assert.equal((await f.api.fetch(request())).status, 401);
  assert.equal(f.calls.at(-1).text, identitySql.rollback);
});
test("release failure suppresses success and redacts its error", async () => {
  const f = fixture({
    release() {
      throw Error("PRIVATE_SQL_ERROR_" + secret);
    },
  });
  const response = await f.api.fetch(request());
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(text, '{"code":"unavailable"}');
  assert.ok(!text.includes(secret) && !text.includes(sessionDigest));
});
for (const stage of ["role", "resolve", "workspace", "workspaceAuthority", "commit"])
  test("deadline after " + stage + " suppresses success and closes client", async () => {
    const f = fixture({
      stage(current, { setTime }) {
        if (current === stage) setTime(105000);
      },
    });
    assert.equal((await f.api.fetch(request())).status, 503);
    assert.deepEqual(f.releases, [true]);
  });
test("clock regression fails closed", async () => {
  const f = fixture({
    stage(current, { setTime }) {
      if (current === "resolve") setTime(99999);
    },
  });
  assert.equal((await f.api.fetch(request())).status, 503);
});
test("request cancellation discards an in-flight query without late response", async () => {
  const blocked = deferred(),
    controller = new AbortController();
  const f = fixture({
    stage(current) {
      if (current === "workspace") return blocked.promise;
    },
  });
  const pending = f.api.fetch(request({ signal: controller.signal }));
  while (!f.calls.some((call) => call.text === identitySql.workspace)) await tick();
  controller.abort();
  assert.equal((await pending).status, 503);
  blocked.resolve();
  await tick();
  assert.deepEqual(f.releases, [true]);
  assert.ok(!f.calls.some((call) => call.text === identitySql.commit));
});
test("late acquisition after disconnect is eventually disposed and never queried", async () => {
  const acquired = deferred(),
    controller = new AbortController();
  const f = fixture({ connect: () => acquired.promise });
  const pending = f.api.fetch(request({ signal: controller.signal }));
  while (!f.connects) await tick();
  controller.abort();
  assert.equal((await pending).status, 503);
  acquired.resolve();
  await tick();
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.calls.length, 0);
});
test("expired disposal cannot return the already constructed successful body", async () => {
  let f;
  f = fixture({
    release() {
      f.setTime(105000);
    },
  });
  assert.equal((await f.api.fetch(request())).status, 503);
});
test("fixed loopback qualification configuration works without trusting forwarded headers", async () => {
  const f = fixture({
    configuration: JSON.stringify({
      schemaVersion: 1,
      mode: "loopback_qualification",
      origin: "http://127.0.0.1:4111",
    }),
  });
  assert.equal(
    (
      await f.api.fetch(
        request({
          url: "http://127.0.0.1:4111/workspace/workspace_a/bootstrap",
          headers: { "X-Forwarded-Host": "foreign.example.test" },
        }),
      )
    ).status,
    200,
  );
});

function mutation(route, change = {}) {
  const suffix = route === "apply" ? "" : "/" + route;
  return request({
    method: "POST",
    path: `/workspace/workspace_a/store-links${suffix}`,
    body: JSON.stringify({ handoffToken: token }),
    ...change,
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      "Idempotency-Key": command,
      ...change.headers,
    },
  });
}
test("private mutation guard derives independent HMAC, hashes and request tuple", async () => {
  const guard = createStandaloneRequestGuard(config, () => 100000);
  const response = await guard.handle(mutation("preview"), "preview", async (context) => {
    assert.equal(context.sessionDigest, sessionDigest);
    assert.equal(context.nonceDigest, createHash("sha256").update(token).digest("hex"));
    assert.equal(context.commandId, command);
    const expected = createHmac("sha256", Buffer.from(secret, "base64url"))
      .update(JSON.stringify(["morrow.store-links.csrf", 1, "workspace_a", command, token]))
      .digest("base64url");
    assert.equal(context.csrfToken, expected);
    return standaloneJson(200, { csrfToken: context.csrfToken });
  });
  assert.equal(response.status, 200);
  const csrf = (await response.json()).csrfToken;
  assert.equal(
    (
      await guard.handle(
        mutation("apply", { headers: { "X-Morrow-CSRF": csrf } }),
        "apply",
        async () => standaloneJson(200, { applied: true }),
      )
    ).status,
    200,
  );
  for (const change of [
    {
      headers: { "Idempotency-Key": "1519ea9d-c5eb-4613-906c-26a870c0e9e8", "X-Morrow-CSRF": csrf },
    },
    { body: JSON.stringify({ handoffToken: secret }), headers: { "X-Morrow-CSRF": csrf } },
    { path: "/workspace/workspace_b/store-links", headers: { "X-Morrow-CSRF": csrf } },
    { headers: { Cookie: `__Host-morrow_session=${token}`, "X-Morrow-CSRF": csrf } },
  ]) {
    let called = false;
    const denied = await guard.handle(mutation("apply", change), "apply", async () => {
      called = true;
      return standaloneJson(200, {});
    });
    assert.equal(denied.status, 403);
    assert.equal(called, false);
  }
});
for (const [name, change, expected] of [
  ["missing origin", { headers: { Origin: "" } }, 403],
  ["same-site metadata", { headers: { "Sec-Fetch-Site": "same-site" } }, 403],
  ["missing marker", { headers: { "X-Morrow-Request": "" } }, 403],
  ["wrong content type", { headers: { "Content-Type": "text/plain" } }, 403],
  ["merged command", { headers: { "Idempotency-Key": `${command},${command}` } }, 400],
  ["extra body authority", { body: JSON.stringify({ handoffToken: token, approved: true }) }, 400],
  ["duplicate body key", { body: `{"handoffToken":"${token}","handoffToken":"${token}"}` }, 400],
  ["bad token bits", { body: JSON.stringify({ handoffToken: token.slice(0, -1) + "B" }) }, 400],
  ["oversized body", { body: " ".repeat(257) }, 400],
  ["invalid UTF8", { body: new Uint8Array([0xff]) }, 400],
])
  test("mutation guard rejects " + name + " before trusted lookup", async () => {
    let calls = 0;
    const guard = createStandaloneRequestGuard(config, () => 100000);
    const response = await guard.handle(mutation("preview", change), "preview", async () => {
      calls++;
      return standaloneJson(200, {});
    });
    assert.equal(response.status, expected);
    assert.equal(calls, 0);
  });
test("apply requires its request-bound canonical CSRF token", async () => {
  let calls = 0;
  const guard = createStandaloneRequestGuard(config, () => 100000);
  assert.equal(
    (
      await guard.handle(mutation("apply"), "apply", async () => {
        calls++;
        return standaloneJson(200, {});
      })
    ).status,
    403,
  );
  assert.equal(calls, 0);
});

const validCsrf = () =>
  createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(JSON.stringify(["morrow.store-links.csrf", 1, "workspace_a", command, token]))
    .digest("base64url");
for (const mode of ["expiry", "abort", "throw"])
  test("apply callback " + mode + " returns only conservative outcome_unknown", async () => {
    let at = 100000;
    const controller = new AbortController();
    const guard = createStandaloneRequestGuard(config, () => at);
    const response = await guard.handle(
      mutation("apply", { signal: controller.signal, headers: { "X-Morrow-CSRF": validCsrf() } }),
      "apply",
      async () => {
        if (mode === "expiry") at = 105000;
        if (mode === "abort") controller.abort();
        if (mode === "throw") throw Error("PRIVATE_MUTATION_DETAIL_" + secret);
        return standaloneJson(200, { outcome: "applied" });
      },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { schemaVersion: 1, outcome: "outcome_unknown" });
  });
test("apply callback completing after disconnect cannot return cached success", async () => {
  const controller = new AbortController(),
    blocked = deferred();
  let started = false;
  const guard = createStandaloneRequestGuard(config, () => 100000);
  const pending = guard.handle(
    mutation("apply", { signal: controller.signal, headers: { "X-Morrow-CSRF": validCsrf() } }),
    "apply",
    async () => {
      started = true;
      await blocked.promise;
      return standaloneJson(200, { outcome: "applied" });
    },
  );
  while (!started) await tick();
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { schemaVersion: 1, outcome: "outcome_unknown" });
  blocked.resolve();
  await tick();
});
