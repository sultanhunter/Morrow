import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeOperationalEvent,
  operationalMetricDimensions,
} from "../packages/infrastructure/src/operations.ts";
const event = {
  schemaVersion: 1,
  environment: "development",
  service: "workers",
  code: "WORKER_CONNECTION_LOST",
  correlationId: "00000000-0000-4000-8000-000000000001",
  at: "2026-10-06T12:00:00.000Z",
};
test("operational signals preserve opaque correlation but metrics exclude individual identifiers", () => {
  assert.deepEqual(JSON.parse(encodeOperationalEvent(event)), event);
  assert.deepEqual(operationalMetricDimensions(event), {
    Environment: "development",
    Service: "workers",
    Code: "WORKER_CONNECTION_LOST",
  });
});
test("payloads, arbitrary error text, credentials and hostile IDs never serialize", () => {
  for (const changed of [
    { ...event, message: "Bearer synthetic-private" },
    { ...event, customer: { email: "synthetic@example.invalid" } },
    { ...event, code: "connection failed: password=synthetic" },
    { ...event, correlationId: "shop-name.example.invalid" },
    { ...event, environment: "production/customer" },
    { ...event, durationMs: Infinity },
    { ...event, at: "2026-02-31T12:00:00.000Z" },
  ])
    assert.throws(() => encodeOperationalEvent(changed), /INVALID_OPERATIONAL_EVENT/);
});
test("hostile getters and toJSON cannot run during telemetry encoding", () => {
  let called = false;
  const hostile = {
    ...event,
    get durationMs() {
      called = true;
      throw Error("sensitive");
    },
  };
  assert.throws(() => encodeOperationalEvent(hostile), /INVALID_OPERATIONAL_EVENT/);
  assert.equal(called, false);
  assert.throws(
    () =>
      encodeOperationalEvent({
        ...event,
        toJSON() {
          called = true;
        },
      }),
    /INVALID_OPERATIONAL_EVENT/,
  );
  assert.equal(called, false);
});
