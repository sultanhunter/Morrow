import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSessionBrowserProof,
  readSchemaVersionBody,
  SESSION_COOKIE_CLEAR,
  sessionCookie,
  sessionCookieSecret,
} from "../packages/identity/src/request-primitives.ts";
import { LoginInputError } from "../packages/identity/src/standalone-login-protocol.ts";

// P05.T01y §7: the session cookie primitives shared by logout and rotate.
const origin = "https://workspace.example.test";
const secret = "A".repeat(43);
const wait = { wait: (pending) => pending };
const request = (headers = {}, body = '{"schemaVersion":1}', method = "POST") =>
  new Request(origin + "/auth/rotate", {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      ...headers,
    },
    ...(body === null ? {} : { body }),
  });
const status = async (pending) => {
  try {
    await pending;
    return 0;
  } catch (error) {
    assert.ok(error instanceof LoginInputError);
    return error.status;
  }
};

test("P05.T01y-AC26: the clear is the fixed-name session cookie with Max-Age=0", () => {
  assert.equal(
    SESSION_COOKIE_CLEAR,
    "__Host-morrow_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
  );
  assert.equal(sessionCookieSecret(SESSION_COOKIE_CLEAR.split(";")[0]), null);
});

test("P05.T01y-AC30: a session cookie lives min(1800, floor(remaining)) seconds, never under one", () => {
  const prefix = "__Host-morrow_session=" + secret + "; Path=/; Secure; HttpOnly; SameSite=Lax;";
  for (const [ms, age] of [
    [1800000, 1800],
    [43200000, 1800],
    [1799999, 1799],
    [1000, 1],
    [1999, 1],
  ])
    assert.equal(sessionCookie(secret, ms), prefix + " Max-Age=" + age);
  for (const ms of [999, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
    assert.equal(sessionCookie(secret, ms), null);
  for (const bad of ["A".repeat(42), "A".repeat(42) + "B", "A".repeat(44), "", null])
    assert.equal(sessionCookie(bad, 1800000), null);
});

test("session browser proof: exact origin, JSON, X-Morrow-Request and same-origin metadata", async () => {
  assert.doesNotThrow(() => assertSessionBrowserProof(request(), origin));
  assert.doesNotThrow(() =>
    assertSessionBrowserProof(
      request({
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
      }),
      origin,
    ),
  );
  for (const headers of [
    { Origin: "https://evil.example" },
    { Origin: "" },
    { "Content-Type": "text/plain" },
    { "Content-Type": "application/json; charset=utf-8" },
    { "X-Morrow-Request": "0" },
    { "Idempotency-Key": "5c6b0b9e-7f8d-4c55-9e2b-1d0c0a3b4f21" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" },
    { "Sec-Fetch-Mode": "navigate" },
    { "Sec-Fetch-Dest": "document" },
  ])
    assert.equal(
      await status(
        Promise.resolve().then(() => assertSessionBrowserProof(request(headers), origin)),
      ),
      403,
    );
  const missing = new Request(origin + "/auth/rotate", { method: "POST", body: "{}" });
  assert.equal(
    await status(Promise.resolve().then(() => assertSessionBrowserProof(missing, origin))),
    403,
  );
});

test('schema-version body: at most 256 bytes of exactly {"schemaVersion":1}', async () => {
  assert.equal(await status(readSchemaVersionBody(request(), wait)), 0);
  assert.equal(await status(readSchemaVersionBody(request({}, ' {"schemaVersion":1} '), wait)), 0);
  for (const body of [
    "",
    "{}",
    '{"schemaVersion":2}',
    '{"schemaVersion":"1"}',
    '{"schemaVersion":1,"extra":true}',
    '{"schemaVersion":1,"schemaVersion":1}',
    "[1]",
    "x".repeat(257),
    '{"schemaVersion":1}' + " ".repeat(240),
  ])
    assert.equal(
      await status(readSchemaVersionBody(request({}, body), wait)),
      400,
      body.slice(0, 40),
    );
  assert.equal(
    await status(readSchemaVersionBody(request({ "Content-Length": "300" }), wait)),
    400,
  );
  assert.equal(await status(readSchemaVersionBody(request({}, null, "GET"), wait)), 400);
});
