import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeBootstrap,
  decodeLoginStart,
  decodeLogout,
  identityOutcome,
  retryAfter,
} from "../apps/workspace-web/src/http/identity-decoders.ts";
import { decodeErrorEnvelope, workOutcome } from "../apps/workspace-web/src/http/work-decoders.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import { copy, statusLabel } from "../packages/workspace-ui/src/copy.ts";

// P14.T01a AC09: every §4.8 row, and every row of the P05.T01x §9 and P06.T01a §4.9
// tables, maps to its Outcome through the right decoder.
const reply = (status, body, headers = {}) => ({
  kind: "response",
  status,
  headers: new Headers(headers),
  body,
  json: body !== undefined,
});
const identity = (outcome) => ({ schemaVersion: 1, outcome });
const envelope = (code, retryClass, extra = {}) => ({
  schemaVersion: 1,
  code,
  retryClass,
  safeMessage: "Fixed message",
  correlationId: "corr-1",
  operationId: null,
  retryAfterSeconds: null,
  inputRequestIds: [],
  ...extra,
});
const decodeSignup = (body) =>
  body && typeof body.workspaceId === "string" ? { workspaceId: body.workspaceId } : null;
const created = { schemaVersion: 1, outcome: "created", organizationId: "o-1", workspaceId: "w-1" };

test("P05.T01x §9 rows through the identity decoder (command)", () => {
  const rows = [
    [reply(201, created), { kind: "ok", value: { workspaceId: "w-1" }, replayed: false }],
    [
      reply(200, { ...created, outcome: "replayed" }),
      { kind: "ok", value: { workspaceId: "w-1" }, replayed: true },
    ],
    [reply(400, identity("invalid_name")), { kind: "invalid", field: "name" }],
    [reply(401, { code: "authentication_required" }), { kind: "unauthenticated" }],
    [reply(403, identity("signup_unavailable")), { kind: "denied", message: "", reference: null }],
    [reply(409, identity("already_onboarded")), { kind: "conflict", recheck: true, message: "" }],
    [
      reply(409, identity("idempotency_conflict")),
      { kind: "conflict", recheck: false, message: "" },
    ],
    [
      reply(429, identity("rate_limited"), { "retry-after": "600" }),
      { kind: "rate_limited", retryAfterSeconds: 600 },
    ],
    [reply(503, { code: "unavailable" }), { kind: "unavailable", offline: false }],
    [reply(503, identity("outcome_unknown")), { kind: "uncertain" }],
    [reply(201, { schemaVersion: 1 }), { kind: "uncertain" }],
    [reply(200, undefined), { kind: "uncertain" }],
    [reply(403, { surprise: true }), { kind: "uncertain" }],
    [reply(502, undefined), { kind: "uncertain" }],
    [{ kind: "lost" }, { kind: "uncertain" }],
    [{ kind: "timeout" }, { kind: "uncertain" }],
    [
      { kind: "not_sent", offline: true },
      { kind: "unavailable", offline: true },
    ],
  ];
  for (const [input, expected] of rows)
    assert.deepEqual(
      identityOutcome(input, "command", decodeSignup),
      expected,
      JSON.stringify(input.body ?? input.kind),
    );
});
test("the account list read: a non-decoding 200, 503 or lost reply is unavailable, never uncertain", () => {
  for (const input of [
    reply(200, { nope: 1 }),
    reply(503, { code: "unavailable" }),
    { kind: "lost" },
    { kind: "aborted" },
  ])
    assert.deepEqual(
      identityOutcome(input, "read", () => null),
      { kind: "unavailable", offline: false },
    );
  assert.deepEqual(
    identityOutcome(reply(401, { code: "authentication_required" }), "read", () => null),
    {
      kind: "unauthenticated",
    },
  );
});
test("Retry-After is an integer from 1 to 86400, 600 otherwise", () => {
  const h = (value) => new Headers(value === null ? {} : { "retry-after": value });
  assert.equal(retryAfter(h("30")), 30);
  assert.equal(retryAfter(h("86400")), 86400);
  for (const value of [null, "0", "86401", "-1", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT", "99999"])
    assert.equal(retryAfter(h(value)), 600, String(value));
});
test("P06.T01a §4.9 rows through the ErrorEnvelope decoder (command and read)", () => {
  const rows = [
    [
      reply(201, { schemaVersion: 1, goalId: "g-1", revision: 1 }),
      { kind: "ok", value: "g-1", replayed: false },
      null,
    ],
    [
      reply(200, { schemaVersion: 1, goalId: "g-1", revision: 1, replayed: true }),
      { kind: "ok", value: "g-1", replayed: true },
      null,
    ],
    [
      reply(401, envelope("denied", "never")),
      { kind: "unauthenticated" },
      { kind: "unauthenticated" },
    ],
    [
      reply(400, envelope("missing_input", "never")),
      { kind: "invalid", field: null },
      { kind: "invalid", field: null },
    ],
    [
      reply(403, envelope("denied", "never")),
      { kind: "denied", message: "Fixed message", reference: "corr-1" },
      { kind: "denied", message: "Fixed message", reference: "corr-1" },
    ],
    [reply(404, envelope("denied", "never")), { kind: "not_found" }, { kind: "not_found" }],
    [
      reply(409, envelope("conflict", "recheck_before_retry")),
      { kind: "conflict", recheck: true, message: "Fixed message" },
      null,
    ],
    [
      reply(409, envelope("conflict", "never")),
      { kind: "conflict", recheck: false, message: "Fixed message" },
      null,
    ],
    [
      reply(503, envelope("unavailable", "recheck_before_retry")),
      { kind: "unavailable", offline: false },
      { kind: "unavailable", offline: false },
    ],
    [
      reply(503, envelope("uncertain", "reconcile_before_retry")),
      { kind: "uncertain" },
      { kind: "unavailable", offline: false },
    ],
    [
      reply(429, envelope("rate_limited", "safe_read_retry", { retryAfterSeconds: 30 })),
      { kind: "rate_limited", retryAfterSeconds: 30 },
      { kind: "rate_limited", retryAfterSeconds: 30 },
    ],
    [
      reply(403, { code: "denied" }),
      { kind: "uncertain" },
      { kind: "unavailable", offline: false },
    ],
    [reply(200, "<html>"), { kind: "uncertain" }, { kind: "unavailable", offline: false }],
    [reply(500, undefined), { kind: "uncertain" }, { kind: "unavailable", offline: false }],
    [{ kind: "lost" }, { kind: "uncertain" }, { kind: "unavailable", offline: false }],
  ];
  const decode = (body) => (body && typeof body.goalId === "string" ? body.goalId : null);
  for (const [input, command, read] of rows) {
    const label = `${input.status ?? input.kind} ${JSON.stringify(input.body)?.slice(0, 40)}`;
    assert.deepEqual(workOutcome(input, "command", decode), command, "command " + label);
    if (read) assert.deepEqual(workOutcome(input, "read", decode), read, "read " + label);
  }
});
test("decoder and validator agree on every ErrorEnvelope fixture (parity)", () => {
  const fixtures = JSON.parse(readFileSync("docs/contracts/fixtures/P01.A02.json", "utf8")).filter(
    (f) => f.definition === "ErrorEnvelope",
  );
  assert.ok(fixtures.length >= 1);
  const valid = fixtures[0].value;
  const variants = [
    valid,
    { ...valid, unknownExtra: 1 },
    { ...valid, code: "teapot" },
    { ...valid, safeMessage: "" },
    { ...valid, safeMessage: "x".repeat(513) },
    { ...valid, correlationId: "bad id" },
    { ...valid, retryAfterSeconds: 0 },
    { ...valid, retryClass: "sometimes" },
    { ...valid, inputRequestIds: ["ok", "not ok"] },
    { ...valid, schemaVersion: 2 },
  ];
  for (const fixture of fixtures)
    assert.equal(decodeErrorEnvelope(fixture.value) !== null, fixture.valid, fixture.id);
  for (const variant of variants) {
    const validator = validateDefinition("core", "ErrorEnvelope", variant);
    const decoded = decodeErrorEnvelope(variant) !== null;
    // The decoder ignores unknown properties; every field it renders matches the schema.
    if (Object.hasOwn(variant, "unknownExtra")) assert.equal(decoded, true);
    else assert.equal(decoded, validator, JSON.stringify(variant).slice(0, 80));
  }
});
test("identity bodies: login, logout and bootstrap", () => {
  assert.equal(decodeLoginStart(reply(400, identity("login_unavailable"))).kind, "unavailable");
  assert.deepEqual(decodeLogout(reply(200, identity("session_ended"))), {
    kind: "ok",
    value: "ended",
    replayed: false,
  });
  assert.deepEqual(decodeLogout(reply(403, identity("logout_unavailable"))), {
    kind: "denied",
    message: "",
    reference: null,
  });
  assert.deepEqual(decodeLogout(reply(503, identity("logout_unavailable"))), {
    kind: "unavailable",
    offline: false,
  });
  assert.deepEqual(decodeLogout(reply(503, identity("logout_outcome_unknown"))), {
    kind: "uncertain",
  });
  assert.deepEqual(decodeLogout({ kind: "lost" }), { kind: "uncertain" });
  const boot = {
    schemaVersion: 1,
    workspace: { id: "w-1", displayName: "Linen" },
    policyRevision: 4,
  };
  assert.deepEqual(decodeBootstrap(reply(200, boot), "w-1"), {
    kind: "ok",
    value: { id: "w-1", displayName: "Linen", policyRevision: 4 },
    replayed: false,
  });
  assert.equal(
    decodeBootstrap(reply(200, boot), "w-2").kind,
    "unavailable",
    "another workspace's reply",
  );
  assert.equal(
    decodeBootstrap(reply(401, { code: "authentication_required" }), "w-1").kind,
    "unauthenticated",
  );
  assert.equal(decodeBootstrap(reply(503, { code: "unavailable" }), "w-1").kind, "unavailable");
  assert.equal(
    decodeBootstrap(reply(200, { ...boot, workspace: { id: "w-1", displayName: "" } }), "w-1").kind,
    "unavailable",
  );
});
test("every v1 status has a label and an unknown status renders as its own text", () => {
  const core = JSON.parse(readFileSync("docs/contracts/schemas/v1/core.schema.json", "utf8")).$defs;
  for (const [family, definition] of [
    ["task", "TaskStatus"],
    ["goal", "GoalStatus"],
    ["question", "QuestionStatus"],
  ]) {
    assert.deepEqual(
      Object.keys(copy.status[family]).sort(),
      [...core[definition].enum].sort(),
      definition,
    );
    for (const value of core[definition].enum) assert.notEqual(statusLabel(family, value), value);
  }
  assert.equal(statusLabel("task", "archived_by_future_version"), "archived_by_future_version");
  assert.equal(statusLabel("task", "constructor"), "constructor");
});
