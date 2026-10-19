import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  createSelfRotationControl,
  selfRotationSql,
} from "../packages/identity/src/self-session-rotation-control.ts";
import { selfLogoutSql } from "../packages/identity/src/self-logout-control.ts";
import { createRotationPool, rotationRole } from "./fixtures/session-rotation-pool.mjs";

// P05.T01y §3/§7: the self-rotation control. Synthetic pool; SQL behaviour is in the labs.
const sha = (v) => createHash("sha256").update(v).digest("hex");
function input(changes = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    commandId: randomUUID(),
    requestDigest: sha("request"),
    configurationDigest: sha("configuration"),
    environmentId: "environment_" + "A".repeat(26),
    applicationId: "app_" + "B".repeat(26),
    clientId: "client_" + "C".repeat(26),
    profileId: "profile_a",
    presentedDigest: sha("presented"),
    newDigest: sha("new"),
    newGenerationId: randomUUID(),
    ...changes,
  });
}
async function run(options = {}, text = input()) {
  const fixture = createRotationPool(options);
  const control = createSelfRotationControl({ pool: fixture.pool, now: fixture.now });
  let invoked = 0;
  const answer = await control.rotate(
    text,
    { deadlineMs: fixture.now() + 5000, signal: new AbortController().signal },
    () => {
      invoked++;
    },
  );
  return { fixture, answer, invoked, stages: fixture.calls.map((c) => c.stage) };
}

test("the rotation envelope reuses the logout executor's statements plus one definer", () => {
  assert.deepEqual(Object.keys(selfRotationSql), [
    "begin",
    "role",
    "timeout",
    "idleTimeout",
    "rotate",
    "commit",
    "rollback",
  ]);
  for (const key of ["begin", "role", "timeout", "idleTimeout", "commit", "rollback"])
    assert.equal(selfRotationSql[key], selfLogoutSql[key]);
  assert.equal(
    selfRotationSql.rotate,
    "SELECT outcome,idle_expires_at_ms,absolute_expires_at_ms FROM morrow_identity.rotate_self_browser_generation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
  );
  assert.ok(Object.isFrozen(selfRotationSql));
});

test("rotated commits; the ten parameters are the closed input in definer order", async () => {
  const text = input();
  const { fixture, answer, invoked, stages } = await run({}, text);
  const at = fixture.now();
  assert.deepEqual(answer, {
    outcome: "rotated",
    idleExpiresAtMs: at + 1800000,
    absoluteExpiresAtMs: at + 40000000,
  });
  assert.equal(invoked, 1);
  assert.deepEqual(stages, [
    "connect",
    "begin",
    "role",
    "timeout",
    "idleTimeout",
    "rotate",
    "commit",
  ]);
  assert.deepEqual(fixture.releases, [true]);
  const v = JSON.parse(text);
  assert.deepEqual(fixture.calls.find((c) => c.stage === "rotate").values, [
    v.commandId,
    v.requestDigest,
    v.configurationDigest,
    v.environmentId,
    v.applicationId,
    v.clientId,
    v.profileId,
    v.presentedDigest,
    v.newDigest,
    v.newGenerationId,
  ]);
});

test("reuse commits its revocation; current and denied roll back and write nothing", async () => {
  const nulls = { idle_expires_at_ms: null, absolute_expires_at_ms: null };
  for (const [row, outcome, end] of [
    [{ outcome: "reuse_revoked", ...nulls }, "reuse_revoked", "commit"],
    [{ outcome: "denied", ...nulls }, "denied", "rollback"],
    [
      {
        outcome: "current",
        idle_expires_at_ms: "1800000900000",
        absolute_expires_at_ms: "1800040000000",
      },
      "current",
      "rollback",
    ],
  ]) {
    const { answer, stages } = await run({ row: () => row });
    assert.equal(answer.outcome, outcome);
    assert.equal(stages.at(-1), end);
  }
});

test("closed input: a malformed or ambiguous request is denied before any connection", async () => {
  for (const text of [
    input({ schemaVersion: 2 }),
    input({ commandId: "not-a-uuid" }),
    input({ newGenerationId: "A".repeat(36) }),
    input({ presentedDigest: sha("same"), newDigest: sha("same") }),
    (() => {
      const id = randomUUID();
      return input({ commandId: id, newGenerationId: id });
    })(),
    input({ profileId: "../profile" }),
    input({ environmentId: "environment_lower" }),
    input({ extra: true }),
    "{}",
    "not json",
    { toString: () => input() },
  ]) {
    const { answer, fixture } = await run({}, text);
    assert.equal(answer.outcome, "denied");
    assert.equal(fixture.connections, 0);
  }
});

test("a role mismatch is unavailable before the definer; a malformed reply is unknown", async () => {
  const unsafe = await run({ role: rotationRole({ owner_member: true }) });
  assert.equal(unsafe.answer.outcome, "unavailable");
  assert.equal(unsafe.invoked, 0);
  assert.equal(unsafe.stages.includes("rotate"), false);
  for (const row of [
    { outcome: "rotated", idle_expires_at_ms: null, absolute_expires_at_ms: "1" },
    {
      outcome: "rotated",
      idle_expires_at_ms: "1800000900000",
      absolute_expires_at_ms: "1800000800000",
    },
    { outcome: "denied", idle_expires_at_ms: "1", absolute_expires_at_ms: null },
    { outcome: "revoked", idle_expires_at_ms: null, absolute_expires_at_ms: null },
    { outcome: "rotated", idle_expires_at_ms: "1e12", absolute_expires_at_ms: "1800040000000" },
    { outcome: "current", idle_expires_at_ms: "1", absolute_expires_at_ms: "2", extra: 1 },
  ]) {
    const { answer, stages } = await run({ row: () => row });
    assert.equal(answer.outcome, "unknown");
    assert.equal(stages.at(-1), "rotate");
  }
});

test("a loss before the rotate statement is unavailable; after it, unknown, never retried", async () => {
  for (const stage of [
    "connect",
    "begin",
    "role",
    "timeout",
    "idleTimeout",
    "rotate",
    "commit",
    "release",
  ]) {
    const { answer, stages } = await run({
      stage(name) {
        if (name === stage) throw Error("private-marker");
      },
    });
    const sent = ["rotate", "commit", "release"].includes(stage);
    assert.equal(answer.outcome, sent ? "unknown" : "unavailable", stage);
    assert.equal(
      stages.filter((s) => s === "rotate").length,
      ["connect", "begin", "role", "timeout", "idleTimeout"].includes(stage) ? 0 : 1,
    );
    assert.equal(stages.includes("rollback"), false, stage);
  }
});

test("an expired attempt or a clock regression after the effect never returns rotated", async () => {
  for (const fault of ["expiry", "clock"]) {
    const { answer } = await run({
      stage(name, state) {
        if (name === "commit")
          state.setTime(fault === "expiry" ? state.now() + 5000 : state.now() - 1);
      },
    });
    assert.equal(answer.outcome, "unknown");
  }
});
