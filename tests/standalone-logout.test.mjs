import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createStandaloneLogout } from "../packages/identity/src/standalone-logout.ts";
import {
  createStandaloneLogoutFixture,
  logoutFixtureRequest,
  logoutFixtureConfiguration,
} from "../scripts/fixtures/standalone-logout-fixture.ts";
const secret = "A".repeat(43),
  second = "B".repeat(42) + "A";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const setup = async (options) => {
  const fixture = createStandaloneLogoutFixture(options);
  await fixture.register(secret);
  await fixture.register(second);
  return { fixture, handler: await createStandaloneLogout(fixture) };
};
async function fixed(response, status, outcome) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { schemaVersion: 1, outcome });
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  for (const name of ["location", "access-control-allow-origin"])
    assert.equal(response.headers.get(name), null);
}
test("one captured text proof: exact independent digest transcripts, awaited cleanup and no cookies", async () => {
  const { fixture, handler } = await setup();
  assert.deepEqual(Object.keys(handler).sort(), ["dispatch", "fetch"]);
  assert.ok(Object.isFrozen(handler));
  await fixed(await handler.fetch(logoutFixtureRequest()), 200, "session_ended");
  const tuple = fixture.calls.find((c) => c.stage === "end").values;
  assert.equal(tuple[7], sha(secret));
  assert.notEqual(tuple[7], sha(Buffer.from(secret, "base64url")));
  const configuration = sha(
    JSON.stringify([
      "morrow.browser.self_logout.configuration",
      "1",
      logoutFixtureConfiguration.protocol,
      logoutFixtureConfiguration.origin,
      "workos",
      logoutFixtureConfiguration.environmentId,
      logoutFixtureConfiguration.applicationId,
      logoutFixtureConfiguration.clientId,
      logoutFixtureConfiguration.profileId,
    ]),
  );
  assert.equal(tuple[2], configuration);
  assert.equal(
    tuple[1],
    sha(
      JSON.stringify([
        "morrow.browser.self_logout",
        "1",
        tuple[0],
        configuration,
        "workos",
        ...tuple.slice(3, 8),
      ]),
    ),
  );
  assert.deepEqual(
    fixture.calls.map((c) => c.stage),
    ["connect", "begin", "role", "timeout", "idleTimeout", "end", "commit", "release"],
  );
  assert.equal(fixture.metrics.releaseCompletions, 1);
  assert.equal(fixture.metrics.effects, 1);
  assert.ok(Object.values(fixture.evidence).every(Boolean));
});
const invalidBodies = {
  extra: '{"schemaVersion":1,"familyId":"other"}',
  duplicate: '{"schemaVersion":1,"schemaVersion":1}',
  array: "[]",
  null: "null",
  malformed: "{",
  version: '{"schemaVersion":2}',
  string: '"x"',
  oversized: " ".repeat(257),
  invalidUTF8: new Uint8Array([255]),
};
for (const [name, body] of Object.entries(invalidBodies))
  test("body " + name + " denied with zero SQL", async () => {
    const { fixture, handler } = await setup();
    await fixed(await handler.fetch(logoutFixtureRequest({ body })), 400, "logout_unavailable");
    assert.equal(fixture.metrics.connections, 0);
  });
const invalidHeaders = {
  foreignOrigin: { Origin: "https://evil.test" },
  missingOrigin: { Origin: "" },
  nullOrigin: { Origin: "null" },
  media: { "Content-Type": "application/json; charset=utf-8" },
  marker: { "X-Morrow-Request": "0" },
  authorization: { Authorization: "Bearer private-marker" },
  idempotency: { "Idempotency-Key": "private-marker" },
  site: { "Sec-Fetch-Site": "cross-site" },
  mode: { "Sec-Fetch-Mode": "navigate" },
  destination: { "Sec-Fetch-Dest": "document" },
};
for (const [name, headers] of Object.entries(invalidHeaders))
  test("CSRF/header " + name + " denied with zero SQL", async () => {
    const { fixture, handler } = await setup();
    await fixed(await handler.fetch(logoutFixtureRequest({ headers })), 403, "logout_unavailable");
    assert.equal(fixture.metrics.connections, 0);
  });
for (const [name, cookie] of Object.entries({
  missing: "",
  duplicate: `__Host-morrow_session=${secret}; __Host-morrow_session=${secret}`,
  case: `__host-morrow_session=${secret}`,
  otherCase: `__Host-morrow_session=${secret}; __host-morrow_login=${secret}`,
  loginDuplicate: `__Host-morrow_session=${secret}; __Host-morrow_login=${secret}; __Host-morrow_login=${secret}`,
  paddingBits: "__Host-morrow_session=" + "A".repeat(42) + "B",
  quoted: `__Host-morrow_session="${secret}"`,
  padded: `__Host-morrow_session=${secret}=`,
  encoded: `__Host-morrow_session=%41${secret}`,
  pairs:
    `__Host-morrow_session=${secret}; ` +
    Array.from({ length: 32 }, (_, i) => `k${i}=v`).join("; "),
  large: `__Host-morrow_session=${secret}; k=` + "x".repeat(4096),
  malformed: `__Host-morrow_session=${secret}; bad`,
}))
  test("cookie " + name + " denied with zero SQL", async () => {
    const { fixture, handler } = await setup();
    await fixed(await handler.fetch(logoutFixtureRequest({ cookie })), 403, "logout_unavailable");
    assert.equal(fixture.metrics.connections, 0);
  });
for (const [name, options, status] of [
  ["route", { path: "/auth/other" }, 404],
  ["method", { method: "GET" }, 405],
  ["query", { path: "/auth/logout?x=1" }, 400],
  ["encoded", { path: "/auth/%6cout" }, 404],
  ["host", { headers: { Host: "evil.test" } }, 400],
  ["length", { headers: { "Content-Length": "1" } }, 400],
  ["lengthLeadingZero", { headers: { "Content-Length": "019" } }, 400],
  [
    "ambiguousFraming",
    { headers: { "Content-Length": "19", "Transfer-Encoding": "chunked" } },
    400,
  ],
  ["headerBudget", { headers: { "X-Large": "x".repeat(8200) } }, 400],
  [
    "headerCount",
    { headers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => ["X-K" + i, "v"])) },
    400,
  ],
])
  test(name + " bounded without SQL", async () => {
    const { fixture, handler } = await setup();
    await fixed(await handler.fetch(logoutFixtureRequest(options)), status, "logout_unavailable");
    assert.equal(fixture.metrics.connections, 0);
  });
test("normal preauth cookie may coexist, logout never clears it", async () => {
  const { handler } = await setup();
  await fixed(
    await handler.fetch(
      logoutFixtureRequest({
        cookie: `__Host-morrow_login=${second}; __Host-morrow_session=${secret}`,
      }),
    ),
    200,
    "session_ended",
  );
});
test("unknown proof denied without mutation and safe role rejection precedes function", async () => {
  for (const options of [{ denied: true }, { roleUnsafe: true }]) {
    const { fixture, handler } = await setup(options);
    await fixed(
      await handler.fetch(logoutFixtureRequest()),
      options.roleUnsafe ? 503 : 403,
      "logout_unavailable",
    );
    assert.equal(fixture.metrics.effects, 0);
    if (options.roleUnsafe) assert.equal(fixture.metrics.invocationCount, 0);
  }
});
for (const stage of [
  "connect",
  "begin",
  "role",
  "timeout",
  "idleTimeout",
  "end",
  "commit",
  "release",
])
  test(
    "lost " + stage + " acknowledgement keeps uncertainty boundary and no subsequent SQL",
    async () => {
      const { fixture, handler } = await setup({
        stage(name) {
          if (name === stage) throw Error("private-marker");
        },
      });
      const invoked = ["end", "commit", "release"].includes(stage);
      await fixed(
        await handler.fetch(logoutFixtureRequest()),
        503,
        invoked ? "logout_outcome_unknown" : "logout_unavailable",
      );
      const sql = fixture.calls.filter((c) => c.stage !== "release");
      assert.equal(sql.at(-1).stage, stage === "release" ? "commit" : stage);
      assert.equal(fixture.metrics.effects, ["commit", "release"].includes(stage) ? 1 : 0);
      assert.equal(fixture.metrics.connections, 1);
    },
  );
test("malformed private result after invocation unknown, no COMMIT or rollback", async () => {
  const { fixture, handler } = await setup({ malformed: true });
  await fixed(await handler.fetch(logoutFixtureRequest()), 503, "logout_outcome_unknown");
  assert.equal(fixture.metrics.effects, 0);
  assert.equal(fixture.calls.filter((c) => c.stage !== "release").at(-1).stage, "end");
});
test("success waits actual physical disposal rather than release attempt", async () => {
  let open, reached;
  const gate = new Promise((r) => (open = r)),
    entered = new Promise((r) => (reached = r));
  const { fixture, handler } = await setup({
    stage: async (name) => {
      if (name === "release") {
        reached();
        await gate;
      }
    },
  });
  let settled = false;
  const pending = handler.fetch(logoutFixtureRequest()).then((r) => {
    settled = true;
    return r;
  });
  await entered;
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  assert.equal(fixture.metrics.releaseAttempts, 1);
  assert.equal(fixture.metrics.releaseCompletions, 0);
  open();
  await fixed(await pending, 200, "session_ended");
  assert.equal(fixture.metrics.releaseCompletions, 1);
});
for (const fault of ["expiry", "clock", "abort"])
  test(fault + " after acknowledged effect never returns success", async () => {
    const abort = new AbortController();
    const h = await setup({
      stage(name, f) {
        if (name === "commit") {
          if (fault === "abort") abort.abort();
          else f.setTime(fault === "expiry" ? f.now() + 5000 : f.now() - 1);
        }
      },
    });
    if (fault === "abort")
      await assert.rejects(
        h.handler.fetch(logoutFixtureRequest({ signal: abort.signal })),
        /STANDALONE_LOGOUT_HELD/,
      );
    else await fixed(await h.handler.fetch(logoutFixtureRequest()), 503, "logout_outcome_unknown");
    assert.equal(h.fixture.metrics.effects, 1);
    assert.equal(
      h.fixture.calls.some((c) => c.stage === "rollback"),
      false,
    );
  });
test("old request completion and replay cannot end newer separately captured family", async () => {
  let open,
    reached,
    held = true;
  const gate = new Promise((r) => (open = r)),
    entered = new Promise((r) => (reached = r));
  const { fixture, handler } = await setup({
    stage: async (name) => {
      if (name === "release" && held) {
        held = false;
        reached();
        await gate;
      }
    },
  });
  const old = logoutFixtureRequest();
  const replay = old.clone();
  const pending = handler.fetch(old);
  await entered;
  assert.equal(await fixture.ended(secret), true);
  assert.equal(await fixture.ended(second), false);
  open();
  await fixed(await pending, 200, "session_ended");
  await fixed(await handler.fetch(replay), 200, "session_ended");
  assert.equal(fixture.metrics.effects, 1);
  assert.equal(await fixture.ended(second), false);
  await fixed(
    await handler.fetch(logoutFixtureRequest({ cookie: "__Host-morrow_session=" + second })),
    200,
    "session_ended",
  );
  assert.equal(fixture.metrics.effects, 2);
});
for (const mode of ["throw", "reject", "pending"])
  test("same-stack sink " + mode + " never sends another plan", async () => {
    const { fixture, handler } = await setup();
    let count = 0;
    await assert.rejects(
      handler.dispatch(logoutFixtureRequest(), (p) => {
        count++;
        assert.ok(
          Object.isFrozen(p) &&
            Object.isFrozen(p.headers) &&
            p.headers.every(Object.isFrozen) &&
            Object.isFrozen(p.cookies),
        );
        assert.equal(p.cookies.length, 0);
        if (mode === "reject") return Promise.reject(Error("private-marker"));
        if (mode === "pending") return new Promise(() => {});
        throw Error("private-marker");
      }),
      /STANDALONE_LOGOUT_TRANSPORT_UNKNOWN/,
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(count, 1);
    assert.equal(fixture.metrics.effects, 1);
  });
test("trusted configuration is primitive closed JSON and no public authority seam", async () => {
  for (const value of [
    { ...logoutFixtureConfiguration },
    JSON.stringify({ ...logoutFixtureConfiguration, profileId: "../bad" }),
    JSON.stringify({ ...logoutFixtureConfiguration, origin: "http://workspace.example.test" }),
    JSON.stringify({ ...logoutFixtureConfiguration, extra: true }),
  ]) {
    const fixture = createStandaloneLogoutFixture();
    await assert.rejects(
      createStandaloneLogout({ ...fixture, configurationJson: value }),
      /STANDALONE_LOGOUT_CONFIGURATION_INVALID/,
    );
    assert.equal(fixture.metrics.connections, 0);
  }
});
test("aborted late acquisition disposes exactly once and never invokes the function", async () => {
  let open, reached;
  const gate = new Promise((r) => (open = r)),
    arrival = new Promise((r) => (reached = r));
  const abort = new AbortController();
  const { fixture, handler } = await setup({
    stage: async (name) => {
      if (name === "connect") {
        reached();
        await gate;
      }
    },
  });
  const pending = handler.fetch(logoutFixtureRequest({ signal: abort.signal }));
  await arrival;
  abort.abort();
  await assert.rejects(pending, /STANDALONE_LOGOUT_HELD/);
  assert.equal(fixture.metrics.invocationCount, 0);
  open();
  for (let i = 0; i < 20 && fixture.metrics.releaseCompletions === 0; i++)
    await new Promise((r) => setImmediate(r));
  assert.equal(fixture.metrics.releaseAttempts, 1);
  assert.equal(fixture.metrics.releaseCompletions, 1);
  assert.equal(fixture.metrics.queryAttempts, 0);
});
test("body cancellation before SQL and pre-aborted Requests produce no late handoff", async () => {
  const { fixture, handler } = await setup();
  const abort = new AbortController();
  let cancelled = false,
    entered;
  const arrival = new Promise((r) => (entered = r));
  const stream = new ReadableStream(
    {
      pull() {
        entered();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(logoutFixtureConfiguration.origin + "/auth/logout", {
    method: "POST",
    headers: {
      Origin: logoutFixtureConfiguration.origin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      Cookie: "__Host-morrow_session=" + secret,
    },
    body: stream,
    duplex: "half",
    signal: abort.signal,
  });
  const pending = handler.fetch(request);
  await arrival;
  abort.abort();
  await assert.rejects(pending, /STANDALONE_LOGOUT_HELD/);
  assert.equal(cancelled, true);
  assert.equal(fixture.metrics.connections, 0);
  let handoff = 0;
  await handler.dispatch(logoutFixtureRequest({ signal: abort.signal }), () => handoff++);
  assert.equal(handoff, 0);
});
test("completed scope denial commits no effect and awaits its bounded rollback/disposal", async () => {
  const { fixture, handler } = await setup({ denied: true });
  await fixed(await handler.fetch(logoutFixtureRequest()), 403, "logout_unavailable");
  assert.equal(fixture.calls.filter((c) => c.stage !== "release").at(-1).stage, "rollback");
  assert.equal(fixture.metrics.releaseCompletions, 1);
  assert.equal(fixture.metrics.effects, 0);
});
