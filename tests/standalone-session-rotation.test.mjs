import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  createStandaloneRotation,
  dispatchStandaloneRotationWithAttempt,
} from "../packages/identity/src/standalone-session-rotation.ts";
import { parseStandaloneLogoutConfiguration } from "../packages/identity/src/standalone-logout.ts";
import { createLoginAttempt } from "../packages/identity/src/standalone-login-protocol.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import {
  logoutFixtureConfiguration,
  logoutFixtureOrigin as origin,
} from "../scripts/fixtures/standalone-logout-fixture.ts";
import { createRotationPool } from "./fixtures/session-rotation-pool.mjs";

// P05.T01y-AC22..AC25, AC30: the POST /auth/rotate dispatcher over a synthetic pool.
const sha = (v) => createHash("sha256").update(v).digest("hex");
const secret = "A".repeat(43);
const authenticationRequired = '{"code":"authentication_required"}';
function rotateRequest(options = {}) {
  const method = options.method ?? "POST";
  return new Request(origin + (options.path ?? "/auth/rotate"), {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      ...(options.cookie === null
        ? {}
        : { Cookie: options.cookie ?? "__Host-morrow_session=" + secret }),
      ...options.headers,
    },
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: options.body ?? '{"schemaVersion":1}' }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
async function setup(options = {}) {
  const fixture = createRotationPool(options);
  const handler = await createStandaloneRotation({
    configurationJson: JSON.stringify(logoutFixtureConfiguration),
    pool: fixture.pool,
    now: fixture.now,
  });
  return { fixture, handler };
}
function expectJsonHeaders(response) {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
}
const sqlCalls = (fixture) => fixture.calls.filter((c) => c.stage !== "connect").length;

test("AC22: rotated → 200, one exact cookie for the new secret, a valid SessionRotationResult", async () => {
  const { fixture, handler } = await setup();
  const response = await handler.fetch(rotateRequest());
  assert.equal(response.status, 200);
  expectJsonHeaders(response);
  const body = await response.json();
  assert.deepEqual(body, {
    schemaVersion: 1,
    outcome: "rotated",
    idleRemainingMs: 1800000,
    absoluteRemainingMs: 40000000,
  });
  assert.equal(validateCurrentDefinition("SessionRotationResult", body), true);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  const match =
    /^__Host-morrow_session=([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=1800$/.exec(
      cookies[0],
    );
  assert.ok(match);
  const issued = match[1];
  assert.notEqual(issued, secret);
  assert.equal(Buffer.from(issued, "base64url").length, 32);
  const values = fixture.calls.find((c) => c.stage === "rotate").values;
  // Only digests leave the Worker: the presented one and the new one.
  assert.equal(values[7], sha(secret));
  assert.equal(values[8], sha(issued));
  assert.equal(JSON.stringify(fixture.calls).includes(issued), false);
  assert.equal(JSON.stringify(fixture.calls).includes(secret), false);
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
  assert.equal(values[2], configuration);
  assert.equal(
    values[1],
    sha(
      JSON.stringify([
        "morrow.browser.self_rotate",
        "1",
        values[0],
        configuration,
        "workos",
        ...values.slice(3, 10),
      ]),
    ),
  );
  assert.deepEqual(
    fixture.calls.map((c) => c.stage),
    ["connect", "begin", "role", "timeout", "idleTimeout", "rotate", "commit"],
  );
});

test("AC22/AC30: remaining times are the SQL expiries minus the delivery clock; Max-Age follows", async () => {
  for (const [idle, maxAge] of [
    [1799999, "1799"],
    [1500, "1"],
    [43200000, "1800"],
  ]) {
    const { handler } = await setup({
      row: (state) => ({
        outcome: "rotated",
        idle_expires_at_ms: String(state.now() + idle),
        absolute_expires_at_ms: String(state.now() + 43200000),
      }),
    });
    const response = await handler.fetch(rotateRequest());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).idleRemainingMs, idle);
    assert.ok(response.headers.getSetCookie()[0].endsWith("; Max-Age=" + maxAge));
  }
  // Under one second left: no cookie, the 401 bytes.
  const { handler } = await setup({
    row: (state) => ({
      outcome: "rotated",
      idle_expires_at_ms: String(state.now() + 999),
      absolute_expires_at_ms: String(state.now() + 999),
    }),
  });
  const short = await handler.fetch(rotateRequest());
  assert.equal(short.status, 401);
  assert.equal(await short.text(), authenticationRequired);
  assert.equal(short.headers.getSetCookie().length, 0);
});

// fix-signin-clock-and-stage-log: the expiries are the database's clock. A family rotated
// moments after its admission, by a database whose clock leads the Worker's, has an absolute
// expiry just past the Worker's at + 12 hours: up to 5 s past it reads as the 12-hour bound,
// beyond it the answer is not trusted (503 unknown, no cookie).
test("a database clock lead of up to 5 s reads as the 12-hour bound; more is unknown", async () => {
  for (const [lead, accepted] of [
    [1, true],
    [1000, true],
    [5000, true],
    [5001, false],
    [60000, false],
  ])
    for (const outcome of ["rotated", "current"]) {
      const { handler } = await setup({
        row: (state) => ({
          outcome,
          idle_expires_at_ms: String(state.now() + 1800000 + Math.min(lead, 5000)),
          absolute_expires_at_ms: String(state.now() + 43200000 + lead),
        }),
      });
      const response = await handler.fetch(rotateRequest());
      if (accepted) {
        assert.equal(response.status, 200, outcome + " " + lead);
        const body = await response.json();
        assert.deepEqual(body, {
          schemaVersion: 1,
          outcome,
          idleRemainingMs: 1800000 + lead,
          absoluteRemainingMs: 43200000,
        });
        assert.equal(validateCurrentDefinition("SessionRotationResult", body), true);
        const cookies = response.headers.getSetCookie();
        if (outcome === "rotated") {
          assert.equal(cookies.length, 1);
          assert.ok(cookies[0].endsWith("; Max-Age=1800"));
        } else assert.equal(cookies.length, 0);
      } else {
        assert.equal(response.status, 503, outcome + " " + lead);
        assert.deepEqual(await response.json(), {
          schemaVersion: 1,
          outcome: "rotation_outcome_unknown",
        });
        assert.equal(response.headers.getSetCookie().length, 0);
      }
    }
  // The idle expiry is bounded the same way.
  const { handler } = await setup({
    row: (state) => ({
      outcome: "rotated",
      idle_expires_at_ms: String(state.now() + 43205001),
      absolute_expires_at_ms: String(state.now() + 43200000),
    }),
  });
  assert.equal((await handler.fetch(rotateRequest())).status, 503);
});

test("AC24: current → 200 without a cookie; denied and reuse → identical 401 bytes, no cookie", async () => {
  const current = await (
    await setup({
      row: (state) => ({
        outcome: "current",
        idle_expires_at_ms: String(state.now() + 1790000),
        absolute_expires_at_ms: String(state.now() + 43000000),
      }),
    })
  ).handler.fetch(rotateRequest());
  assert.equal(current.status, 200);
  assert.equal(current.headers.getSetCookie().length, 0);
  assert.deepEqual(await current.json(), {
    schemaVersion: 1,
    outcome: "current",
    idleRemainingMs: 1790000,
    absoluteRemainingMs: 43000000,
  });
  const bodies = [];
  for (const outcome of ["denied", "reuse_revoked"]) {
    const { fixture, handler } = await setup({
      row: () => ({ outcome, idle_expires_at_ms: null, absolute_expires_at_ms: null }),
    });
    const response = await handler.fetch(rotateRequest());
    assert.equal(response.status, 401);
    expectJsonHeaders(response);
    assert.equal(response.headers.getSetCookie().length, 0);
    bodies.push(await response.text());
    assert.equal(fixture.calls.at(-1).stage, outcome === "denied" ? "rollback" : "commit");
  }
  assert.deepEqual(bodies, [authenticationRequired, authenticationRequired]);
});

test("AC23: method, request proof and body failures → rotation_unavailable with zero SQL", async () => {
  const cases = [
    [{ method: "GET" }, 405],
    [{ path: "/auth/rotated" }, 404],
    [{ headers: { Origin: "https://evil.example" } }, 403],
    [{ headers: { "X-Morrow-Request": "0" } }, 403],
    [{ headers: { "Content-Type": "text/plain" } }, 403],
    [{ headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
    [{ headers: { "Idempotency-Key": "5c6b0b9e-7f8d-4c55-9e2b-1d0c0a3b4f21" } }, 403],
    [{ headers: { Authorization: "Bearer x" } }, 403],
    [{ body: '{"schemaVersion":2}' }, 400],
    [{ body: "x".repeat(257) }, 400],
    [{ body: "{}" }, 400],
  ];
  for (const [options, status] of cases) {
    const { fixture, handler } = await setup();
    const response = await handler.fetch(rotateRequest(options));
    assert.equal(response.status, status, JSON.stringify(options));
    expectJsonHeaders(response);
    assert.deepEqual(await response.json(), { schemaVersion: 1, outcome: "rotation_unavailable" });
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(fixture.connections, 0);
  }
});

test("AC23: zero, two or malformed session cookies → the 401 bytes with zero SQL", async () => {
  for (const cookie of [
    null,
    "",
    "__Host-morrow_login=" + secret,
    `__Host-morrow_session=${secret}; __Host-morrow_session=${secret}`,
    "__Host-morrow_session=" + "A".repeat(42),
    "__Host-morrow_session=" + "A".repeat(42) + "B",
    "__host-morrow_session=" + secret,
    "__Host-morrow_session=" + secret + "; bad",
  ]) {
    const { fixture, handler } = await setup();
    const response = await handler.fetch(rotateRequest({ cookie }));
    assert.equal(response.status, 401, String(cookie));
    assert.equal(await response.text(), authenticationRequired);
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(fixture.connections, 0);
  }
});

test("AC25: a loss before the statement → 503 unavailable; after it → 503 unknown; never a cookie", async () => {
  for (const stage of ["connect", "begin", "role", "idleTimeout", "rotate", "commit", "release"]) {
    const { fixture, handler } = await setup({
      stage(name) {
        if (name === stage) throw Error("private-marker");
      },
    });
    const response = await handler.fetch(rotateRequest());
    const sent = ["rotate", "commit", "release"].includes(stage);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      schemaVersion: 1,
      outcome: sent ? "rotation_outcome_unknown" : "rotation_unavailable",
    });
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(fixture.calls.filter((c) => c.stage === "rotate").length, sent ? 1 : 0);
  }
});

test("an aborted transport gets no late delivery; a provided attempt keeps its own deadline", async () => {
  const abort = new AbortController();
  const { handler } = await setup({
    stage(name) {
      if (name === "commit") abort.abort();
    },
  });
  let handoff = 0;
  await handler.dispatch(rotateRequest({ signal: abort.signal }), () => handoff++);
  assert.equal(handoff, 0);
  const fixture = createRotationPool();
  const config = await parseStandaloneLogoutConfiguration(
    JSON.stringify(logoutFixtureConfiguration),
  );
  const attempt = createLoginAttempt(fixture.now, new AbortController().signal, 5000);
  const entered = fixture.now();
  try {
    fixture.setTime(entered + 4000);
    let delivery;
    await dispatchStandaloneRotationWithAttempt(
      rotateRequest(),
      (plan) => {
        delivery = plan;
      },
      attempt,
      config,
      fixture.pool,
    );
    assert.equal(delivery.status, 200);
    assert.ok(Object.isFrozen(delivery) && Object.isFrozen(delivery.cookies));
    assert.equal(delivery.cookies.length, 1);
    assert.equal(fixture.calls[0].control.deadlineMs, entered + 5000);
    assert.equal(attempt.check(), entered + 4000);
  } finally {
    attempt.end();
  }
});
