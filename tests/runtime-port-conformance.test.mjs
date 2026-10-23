// ADR-0029's runtime port conformance (build order PR 7): the suite every runtime adapter must
// pass (tests/fixtures/runtime-conformance.mjs), run here against the deterministic fake
// (apps/broker/src/runtime-fake.ts). PR 8 runs the same suite against the E2B adapter and its
// wire fixture. Unknown outcomes are never flattened: a lost create is unknown_effect and is
// found again by its metadata, a lost kill is unknown and read back, not_found is never
// killed, a wrong key is never not_found, and nothing a sandbox can observe carries a
// credential, a token, a URL or a shop domain.
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeRuntime } from "../apps/broker/src/runtime-fake.ts";
import { runtimePortConformance } from "./fixtures/runtime-conformance.mjs";

const credential = "e2b_" + "c0ffee".repeat(7);
function fakeHarness() {
  let now = Date.parse("2026-10-23T10:00:00.000Z");
  const fake = createFakeRuntime({ credential, now: () => now });
  const faults = {
    create_lost_created: { op: "create", outcome: "unknown_effect", created: true },
    create_lost_absent: { op: "create", outcome: "unknown_effect" },
    create_quota: { op: "create", outcome: "quota_exhausted" },
    create_billing: { op: "create", outcome: "billing_blocked" },
    status_unknown: { op: "status", outcome: "unknown" },
    status_paused: { op: "status", outcome: "paused" },
    kill_lost_killed: { op: "kill", outcome: "unknown", killed: true },
    write_unknown: { op: "write", outcome: "unknown" },
    exec_unknown: { op: "exec", outcome: "unknown" },
    read_unknown: { op: "read", outcome: "unknown" },
  };
  return {
    adapter: fake,
    credential,
    template: "morrow-computer-fake-v1",
    advance: (ms) => {
      now += ms;
    },
    alive: () => fake.alive().map(({ ref, operationId }) => ({ ref, operationId })),
    created: () => fake.created(),
    inject: (name) => {
      assert.ok(Object.hasOwn(faults, name), name);
      fake.fault(faults[name]);
    },
    guest: () => fake.guest,
    script: (spec) => {
      const lines = ["# synthetic job"];
      if (spec.hang) lines.push("#!fake hang");
      if (spec.stdout) lines.push("#!fake stdout " + spec.stdout);
      for (const [path, bytes] of Object.entries(spec.files ?? {}))
        lines.push("#!fake write " + path + " " + Buffer.from(bytes).toString("base64"));
      if (spec.exitCode !== undefined) lines.push("#!fake exit " + spec.exitCode);
      return new TextEncoder().encode(lines.join("\n") + "\n");
    },
  };
}

const names = runtimePortConformance(test, "fake", async () => fakeHarness());

test("the suite covers every closed outcome kind the port defines", () => {
  assert.ok(names.length >= 15);
  for (const kind of ["create", "kill", "status", "files", "lifetime", "never throws"])
    assert.ok(
      names.some((n) => n.startsWith(kind)),
      kind,
    );
});
