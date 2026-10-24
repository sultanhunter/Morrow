// The runtime port conformance suite (ADR-0029 item 2; build order PR 7). Every runtime
// adapter must pass it: the deterministic fake today (tests/runtime-port-conformance.test.mjs)
// and the E2B adapter of PR 8 against its wire fixture. An adapter is driven only through the
// port (apps/broker/src/runtime-provider.ts); a harness supplies what only the provider side
// can know:
//   make()  -> {
//     adapter,           the RuntimeProvider under test
//     credential,        the one key the provider side accepts
//     template,          a template the provider side knows
//     advance(ms),       moves the provider's clock
//     alive(),           the provider's truth: [{ ref, operationId }] alive now
//     created(),         how many sandboxes the provider ever created
//     inject(fault),     one of `faults` below, answered once
//     guest(),           everything a sandbox could observe: { creates, files, commands }
//     script(spec),      program bytes that, run by the profile's command, exit with
//                        spec.exitCode, print spec.stdout and write spec.files ({path: bytes})
//                        or, with spec.hang, run past the command's timeout
//   }
// Faults: create_lost_created, create_lost_absent, create_quota, create_billing,
// status_unknown, status_paused, kill_lost_killed, write_unknown, exec_unknown, read_unknown.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { computerProfile } from "../../packages/policy/src/runtime-computer.ts";
import { sandboxRefPattern } from "../../apps/broker/src/runtime-provider.ts";

const outcomes = Object.freeze({
  create: ["created", "not_sent", "quota_exhausted", "billing_blocked", "unknown_effect"],
  status: ["running", "paused", "not_found", "unknown"],
  kill: ["killed", "not_found", "unknown"],
  write: ["written", "unknown"],
  exec: ["exited", "timed_out", "unknown"],
  read: ["read", "missing", "too_large", "unknown"],
});
const budget = 30_000;
const request = (template, operationId = randomUUID()) => ({
  operationId,
  template,
  timeoutSeconds: computerProfile.sandboxTimeoutSeconds,
  internet: false,
  metadata: { operation: operationId },
});
const command = Object.freeze({
  argv: computerProfile.command,
  cwd: computerProfile.workDirectory,
  user: computerProfile.user,
  timeoutSeconds: computerProfile.execTimeoutSeconds,
});
const closed = (kind, result) => {
  assert.ok(result && typeof result === "object", kind);
  assert.ok(outcomes[kind].includes(result.outcome), kind + ":" + result?.outcome);
  return result;
};
async function created(h, operationId) {
  const r = closed(
    "create",
    await h.adapter.create(request(h.template, operationId), h.credential, budget),
  );
  assert.equal(r.outcome, "created");
  assert.match(r.sandboxRef, sandboxRefPattern);
  return { sandboxRef: r.sandboxRef, accessToken: r.accessToken };
}
// Values that must never reach a sandbox: the provider credential, the sandbox's own token,
// any URL, a shop domain.
function assertGuestClean(h, extra = []) {
  const view = h.guest();
  const text = JSON.stringify({
    creates: view.creates,
    commands: view.commands,
    files: view.files.map((f) => ({ path: f.path, text: new TextDecoder().decode(f.bytes) })),
  });
  for (const secret of [h.credential, ...extra])
    if (secret) assert.ok(!text.includes(secret), "secret in guest");
  assert.doesNotMatch(text, /https?:\/\/|myshopify\.com|workers\.dev/);
  for (const c of view.creates) {
    assert.equal(c.internet, false);
    assert.deepEqual(Object.keys(c.metadata), ["operation"]);
    assert.ok(c.timeoutSeconds <= computerProfile.sandboxTimeoutSeconds);
  }
  for (const c of view.commands) {
    assert.deepEqual(c.environment, {});
    assert.equal(c.user, "agent");
  }
}

/** The cases, each named; `test` is node:test's (or any (name, fn) runner). */
export function runtimePortConformance(test, label, make) {
  const cases = {
    "create: one sandbox, internet off, metadata only the operation, found by its operation":
      async () => {
        const h = await make();
        const op = randomUUID();
        const sandbox = await created(h, op);
        assert.deepEqual(h.alive(), [{ ref: sandbox.sandboxRef, operationId: op }]);
        const found = closed("status", await h.adapter.status(op, null, h.credential, budget));
        assert.deepEqual(found, { outcome: "running", sandboxRef: sandbox.sandboxRef });
        assert.deepEqual(
          closed("status", await h.adapter.status(op, sandbox.sandboxRef, h.credential, budget)),
          found,
        );
        assertGuestClean(h, [sandbox.accessToken]);
      },
    "create: a lost reply is unknown_effect, never retried, and the sandbox is found by its metadata":
      async () => {
        const h = await make();
        const op = randomUUID();
        h.inject("create_lost_created");
        assert.equal(
          closed("create", await h.adapter.create(request(h.template, op), h.credential, budget))
            .outcome,
          "unknown_effect",
        );
        assert.equal(h.created(), 1, "exactly one create reached the provider");
        const found = closed("status", await h.adapter.status(op, null, h.credential, budget));
        assert.equal(found.outcome, "running");
        assert.equal(
          closed("kill", await h.adapter.kill(found.sandboxRef, h.credential, budget)).outcome,
          "killed",
        );
        assert.deepEqual(h.alive(), []);
      },
    "create: a lost reply with nothing created is still unknown_effect, and a lookup says not_found":
      async () => {
        const h = await make();
        const op = randomUUID();
        h.inject("create_lost_absent");
        assert.equal(
          closed("create", await h.adapter.create(request(h.template, op), h.credential, budget))
            .outcome,
          "unknown_effect",
        );
        assert.equal(
          closed("status", await h.adapter.status(op, null, h.credential, budget)).outcome,
          "not_found",
        );
      },
    "create: quota and billing blocks are their own outcomes, never not_sent or created":
      async () => {
        const h = await make();
        h.inject("create_quota");
        assert.equal(
          closed("create", await h.adapter.create(request(h.template), h.credential, budget))
            .outcome,
          "quota_exhausted",
        );
        h.inject("create_billing");
        assert.equal(
          closed("create", await h.adapter.create(request(h.template), h.credential, budget))
            .outcome,
          "billing_blocked",
        );
      },
    "create: a wrong key never yields a sandbox, and a lookup with it is unknown, never not_found":
      async () => {
        const h = await make();
        const op = randomUUID();
        const r = closed(
          "create",
          await h.adapter.create(request(h.template, op), "e2b_" + "0".repeat(40), budget),
        );
        assert.notEqual(r.outcome, "created");
        const sandbox = await created(h, randomUUID());
        assert.equal(
          closed("status", await h.adapter.status(op, null, "e2b_" + "1".repeat(40), budget))
            .outcome,
          "unknown",
        );
        assert.equal(
          closed("kill", await h.adapter.kill(sandbox.sandboxRef, "e2b_" + "1".repeat(40), budget))
            .outcome,
          "unknown",
        );
        assert.equal(h.alive().length, 1, "a refused kill kills nothing");
      },
    "create: a request that is not the profile's is refused before it leaves (not_sent)":
      async () => {
        const h = await make();
        const op = randomUUID();
        for (const bad of [
          { ...request(h.template, op), internet: true },
          { ...request(h.template, op), metadata: { operation: op, shop: "x" } },
          { ...request(h.template, op), metadata: { operation: randomUUID() } },
          { ...request(h.template, op), timeoutSeconds: 3600 },
          { ...request(h.template, op), operationId: "not-a-uuid" },
        ])
          assert.equal(
            closed("create", await h.adapter.create(bad, h.credential, budget)).outcome,
            "not_sent",
          );
        assert.equal(h.created(), 0);
      },
    "kill: killed once, then not_found; not_found is never killed": async () => {
      const h = await make();
      const op = randomUUID();
      const sandbox = await created(h, op);
      assert.deepEqual(
        closed("kill", await h.adapter.kill(sandbox.sandboxRef, h.credential, budget)),
        { outcome: "killed" },
      );
      assert.deepEqual(
        closed("kill", await h.adapter.kill(sandbox.sandboxRef, h.credential, budget)),
        { outcome: "not_found" },
      );
      assert.equal(
        closed("status", await h.adapter.status(op, sandbox.sandboxRef, h.credential, budget))
          .outcome,
        "not_found",
      );
    },
    "kill: a lost reply is unknown, and the truth is read back by status": async () => {
      const h = await make();
      const op = randomUUID();
      const sandbox = await created(h, op);
      h.inject("kill_lost_killed");
      assert.equal(
        closed("kill", await h.adapter.kill(sandbox.sandboxRef, h.credential, budget)).outcome,
        "unknown",
      );
      assert.equal(
        closed("status", await h.adapter.status(op, null, h.credential, budget)).outcome,
        "not_found",
      );
    },
    "status: unknown is not not_found, and a paused sandbox is reported as paused": async () => {
      const h = await make();
      const op = randomUUID();
      const sandbox = await created(h, op);
      h.inject("status_unknown");
      assert.equal(
        closed("status", await h.adapter.status(op, null, h.credential, budget)).outcome,
        "unknown",
      );
      h.inject("status_paused");
      assert.deepEqual(closed("status", await h.adapter.status(op, null, h.credential, budget)), {
        outcome: "paused",
        sandboxRef: sandbox.sandboxRef,
      });
    },
    "lifetime: past its timeout the sandbox is gone (never paused)": async () => {
      const h = await make();
      const op = randomUUID();
      await created(h, op);
      h.advance((computerProfile.sandboxTimeoutSeconds + 1) * 1000);
      assert.deepEqual(h.alive(), []);
      assert.equal(
        closed("status", await h.adapter.status(op, null, h.credential, budget)).outcome,
        "not_found",
      );
    },
    "files and the command: written, run as agent with no environment, read back; missing and too large":
      async () => {
        const h = await make();
        const sandbox = await created(h, randomUUID());
        const csv = new TextEncoder().encode("a,b\n1,2\n");
        assert.deepEqual(
          closed(
            "write",
            await h.adapter.writeFile(sandbox, "/home/agent/input/products.csv", csv, budget),
          ),
          {
            outcome: "written",
          },
        );
        const png = new Uint8Array([1, 2, 3, 4]);
        const script = h.script({
          exitCode: 0,
          stdout: "done",
          files: { "/home/agent/output/chart.png": png },
        });
        assert.equal(
          closed(
            "write",
            await h.adapter.writeFile(sandbox, computerProfile.jobPath, script, budget),
          ).outcome,
          "written",
        );
        const ran = closed("exec", await h.adapter.exec(sandbox, command, budget));
        assert.equal(ran.outcome, "exited");
        assert.equal(ran.exitCode, 0);
        assert.match(ran.stdout, /done/);
        assert.deepEqual(
          [
            ...closed(
              "read",
              await h.adapter.readFile(sandbox, "/home/agent/output/chart.png", 1024, budget),
            ).bytes,
          ],
          [...png],
        );
        assert.equal(
          closed(
            "read",
            await h.adapter.readFile(sandbox, "/home/agent/output/table.csv", 1024, budget),
          ).outcome,
          "missing",
        );
        assert.equal(
          closed(
            "read",
            await h.adapter.readFile(sandbox, "/home/agent/output/chart.png", 2, budget),
          ).outcome,
          "too_large",
        );
        const commands = h.guest().commands;
        assert.deepEqual(commands.at(-1).argv, [...computerProfile.command]);
        assert.equal(commands.at(-1).cwd, computerProfile.workDirectory);
        assertGuestClean(h, [sandbox.accessToken]);
      },
    "the command: a non-zero exit and a run past the timeout are their own outcomes": async () => {
      const h = await make();
      const sandbox = await created(h, randomUUID());
      await h.adapter.writeFile(
        sandbox,
        computerProfile.jobPath,
        h.script({ exitCode: 3, stdout: "" }),
        budget,
      );
      assert.deepEqual(closed("exec", await h.adapter.exec(sandbox, command, budget)).exitCode, 3);
      await h.adapter.writeFile(sandbox, computerProfile.jobPath, h.script({ hang: true }), budget);
      assert.equal(
        closed("exec", await h.adapter.exec(sandbox, command, budget)).outcome,
        "timed_out",
      );
    },
    "lost replies on write, exec and read are unknown": async () => {
      const h = await make();
      const sandbox = await created(h, randomUUID());
      h.inject("write_unknown");
      assert.equal(
        closed(
          "write",
          await h.adapter.writeFile(
            sandbox,
            computerProfile.jobPath,
            h.script({ exitCode: 0 }),
            budget,
          ),
        ).outcome,
        "unknown",
      );
      await h.adapter.writeFile(
        sandbox,
        computerProfile.jobPath,
        h.script({ exitCode: 0 }),
        budget,
      );
      h.inject("exec_unknown");
      assert.equal(
        closed("exec", await h.adapter.exec(sandbox, command, budget)).outcome,
        "unknown",
      );
      h.inject("read_unknown");
      assert.equal(
        closed("read", await h.adapter.readFile(sandbox, "/home/agent/output/x.csv", 10, budget))
          .outcome,
        "unknown",
      );
    },
    "a killed sandbox and a forged handle reach nothing": async () => {
      const h = await make();
      const sandbox = await created(h, randomUUID());
      await h.adapter.kill(sandbox.sandboxRef, h.credential, budget);
      assert.equal(
        closed(
          "write",
          await h.adapter.writeFile(
            sandbox,
            computerProfile.jobPath,
            h.script({ exitCode: 0 }),
            budget,
          ),
        ).outcome,
        "unknown",
      );
      assert.equal(
        closed("exec", await h.adapter.exec(sandbox, command, budget)).outcome,
        "unknown",
      );
      const other = await created(h, randomUUID());
      const forged = { sandboxRef: other.sandboxRef, accessToken: sandbox.accessToken };
      assert.equal(
        closed("exec", await h.adapter.exec(forged, command, budget)).outcome,
        "unknown",
      );
    },
    "never throws: garbage in is a closed outcome out": async () => {
      const h = await make();
      const junk = { sandboxRef: "nope", accessToken: null };
      closed("status", await h.adapter.status("nope", null, h.credential, budget));
      closed("kill", await h.adapter.kill("nope", h.credential, budget));
      closed("write", await h.adapter.writeFile(junk, "/etc/passwd", new Uint8Array(1), budget));
      closed("read", await h.adapter.readFile(junk, "/etc/passwd", 10, budget));
      closed("exec", await h.adapter.exec(junk, command, budget));
    },
  };
  for (const [name, fn] of Object.entries(cases)) test(label + ": " + name, fn);
  return Object.keys(cases);
}
