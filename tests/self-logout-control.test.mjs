import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  createSelfLogoutControl,
  selfLogoutSql as sql,
} from "../packages/identity/src/self-logout-control.ts";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const selected = () => ({
  schemaVersion: 1,
  commandId: randomUUID(),
  requestDigest: hash("request"),
  configurationDigest: hash("configuration"),
  environmentId: "environment_" + "A".repeat(26),
  applicationId: "app_" + "B".repeat(26),
  clientId: "client_" + "C".repeat(26),
  profileId: "profile_local",
  sessionDigest: hash("synthetic-cookie-text"),
});
const role = () => ({
  role: "morrow_identity_logout",
  login: "morrow_identity_logout",
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolinherit: false,
  owner_member: false,
  role_member: false,
});
const control = (deadlineMs = 6000, signal = new AbortController().signal) => ({
  deadlineMs,
  signal,
});
const tick = () => new Promise((r) => setTimeout(r, 0));
function harness(options = {}) {
  const calls = [],
    releases = [],
    audit = randomUUID();
  let at = 1000;
  const client = {
    async query(statement, values, c) {
      calls.push({ statement, values, control: c });
      if (options.query) return options.query(statement, values, c, calls);
      return {
        rows:
          statement === sql.role
            ? [options.role ?? role()]
            : statement === sql.end
              ? [options.reply ?? { outcome: "ended", audit_id: audit }]
              : [],
      };
    },
    async release(discard) {
      releases.push(discard);
      if (options.release) await options.release();
    },
  };
  const service = createSelfLogoutControl({
    pool: {
      connect: async (c) => {
        if (options.connect) return options.connect(c, client);
        return client;
      },
    },
    now: () => at,
  });
  return {
    service,
    calls,
    releases,
    client,
    audit,
    clock(value) {
      at = value;
    },
  };
}
test("acknowledged one fixed transaction drops audit and waits for disposable release", async () => {
  let finish;
  const h = harness({
    release: () =>
      new Promise((r) => {
        finish = r;
      }),
  });
  let settled = false,
    notified = 0;
  const v = selected(),
    pending = h.service
      .end(JSON.stringify(v), control(), () => {
        notified++;
      })
      .then((x) => {
        settled = true;
        return x;
      });
  while (!finish) await tick();
  assert.equal(settled, false);
  assert.equal(notified, 1);
  assert.deepEqual(h.releases, [true]);
  finish();
  assert.deepEqual(await pending, { outcome: "ended" });
  assert.deepEqual(
    h.calls.map((x) => x.statement),
    [sql.begin, sql.role, sql.timeout, sql.idleTimeout, sql.end, sql.commit],
  );
  assert.deepEqual(h.calls[4].values, [
    v.commandId,
    v.requestDigest,
    v.configurationDigest,
    v.environmentId,
    v.applicationId,
    v.clientId,
    v.profileId,
    v.sessionDigest,
  ]);
  assert.ok(Object.isFrozen(h.calls[4].values));
  assert.ok(h.calls.every((x) => x.control.deadlineMs === 6000));
});
test("completed denial rolls back exactly once and exposes no audit", async () => {
  const h = harness({ reply: { outcome: "denied", audit_id: null } });
  assert.deepEqual(await h.service.end(JSON.stringify(selected()), control()), {
    outcome: "denied",
  });
  assert.equal(h.calls.at(-1).statement, sql.rollback);
  assert.deepEqual(h.releases, [true]);
});
test("primitive boundary rejects raw getters and proxies with zero traps/acquisition", async () => {
  let traps = 0;
  const h = harness();
  const raw = new Proxy(
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
      getPrototypeOf() {
        traps++;
        throw Error();
      },
    },
  );
  assert.deepEqual(await h.service.end(raw, control()), { outcome: "denied" });
  assert.deepEqual(
    await h.service.end(
      {
        get schemaVersion() {
          traps++;
          throw Error();
        },
      },
      control(),
    ),
    { outcome: "denied" },
  );
  assert.equal(traps, 0);
  assert.equal(h.calls.length, 0);
});
test("closed duplicate-free scalar input denies malformed or authority additions before connect", async () => {
  for (const input of [
    "{}",
    "[1]",
    " ".repeat(4097),
    '{"schemaVersion":1,"schemaVersion":1}',
    JSON.stringify({ ...selected(), familyId: "foreign" }),
    JSON.stringify({ ...selected(), schemaVersion: "1" }),
    JSON.stringify({ ...selected(), commandId: "command" }),
    JSON.stringify({ ...selected(), sessionDigest: "a".repeat(63) }),
  ]) {
    const h = harness();
    assert.deepEqual(await h.service.end(input, control()), { outcome: "denied" });
    assert.equal(h.calls.length, 0);
  }
});
test("every unsafe executor flag/login/membership fails before end function", async () => {
  for (const key of Object.keys(role())) {
    const changed = role();
    changed[key] = key === "role" || key === "login" ? "morrow_api" : true;
    const h = harness({ role: changed });
    assert.deepEqual(await h.service.end(JSON.stringify(selected()), control()), {
      outcome: "unavailable",
    });
    assert.equal(
      h.calls.some((x) => x.statement === sql.end),
      false,
    );
    assert.deepEqual(h.releases, [true]);
  }
});
test("uncertain setup query cannot issue rollback/end or retry", async () => {
  const h = harness({
    query: async (s) => {
      if (s === sql.begin)
        throw {
          get message() {
            throw Error();
          },
        };
    },
  });
  assert.deepEqual(await h.service.end(JSON.stringify(selected()), control()), {
    outcome: "unavailable",
  });
  assert.deepEqual(
    h.calls.map((x) => x.statement),
    [sql.begin],
  );
  assert.deepEqual(h.releases, [true]);
});
test("end-function rejection is unknown, closes before propagation and never follows with SQL", async () => {
  let h;
  h = harness({
    query: async (s) => {
      if (s === sql.role) return { rows: [role()] };
      if (s === sql.end)
        throw new Proxy(
          {},
          {
            get() {
              throw Error();
            },
          },
        );
      return { rows: [] };
    },
  });
  assert.deepEqual(await h.service.end(JSON.stringify(selected()), control()), {
    outcome: "unknown",
  });
  assert.equal(h.calls.at(-1).statement, sql.end);
  assert.deepEqual(h.releases, [true]);
});
test("malformed post-invocation rows hold without commit/rollback and redact all values", async () => {
  for (const reply of [
    { outcome: "ended", audit_id: null },
    { outcome: "denied", audit_id: randomUUID() },
    { outcome: "applied", audit_id: randomUUID() },
    { outcome: "ended", audit_id: randomUUID(), family_id: "private" },
  ]) {
    const h = harness({ reply });
    const r = await h.service.end(JSON.stringify(selected()), control());
    assert.deepEqual(r, { outcome: "unknown" });
    assert.equal(h.calls.at(-1).statement, sql.end);
    assert.deepEqual(Object.keys(r), ["outcome"]);
  }
});
test("COMMIT acknowledgement loss is unknown and no rollback follows", async () => {
  const h = harness({
    query: async (s) => {
      if (s === sql.role) return { rows: [role()] };
      if (s === sql.end) return { rows: [{ outcome: "ended", audit_id: randomUUID() }] };
      if (s === sql.commit) throw Error();
      return { rows: [] };
    },
  });
  assert.deepEqual(await h.service.end(JSON.stringify(selected()), control()), {
    outcome: "unknown",
  });
  assert.equal(h.calls.at(-1).statement, sql.commit);
  assert.deepEqual(h.releases, [true]);
});
test("release acknowledgement loss cannot return ended", async () => {
  const h = harness({
    release: async () => {
      throw Error();
    },
  });
  assert.deepEqual(await h.service.end(JSON.stringify(selected()), control()), {
    outcome: "unknown",
  });
  assert.deepEqual(h.releases, [true]);
});
test("pre-abort and expired external budget acquire no connection", async () => {
  const h = harness(),
    a = new AbortController();
  a.abort();
  assert.deepEqual(await h.service.end(JSON.stringify(selected()), control(6000, a.signal)), {
    outcome: "unavailable",
  });
  assert.deepEqual(await h.service.end(JSON.stringify(selected()), control(1000)), {
    outcome: "unavailable",
  });
  assert.equal(h.calls.length, 0);
});
test("late connection is discarded once and performs zero queries", async () => {
  let deliver;
  const h = harness({
    connect: (_c, client) =>
      new Promise((r) => {
        deliver = () => r(client);
      }),
  });
  assert.deepEqual(await h.service.end(JSON.stringify(selected()), control(1010)), {
    outcome: "unavailable",
  });
  deliver();
  await tick();
  await tick();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.releases, [true]);
});
test("aborted in-flight end holds and a late reply never triggers another statement", async () => {
  const a = new AbortController();
  let finish;
  const h = harness({
    query: async (s) => {
      if (s === sql.role) return { rows: [role()] };
      if (s === sql.end)
        return new Promise((r) => {
          finish = r;
        });
      return { rows: [] };
    },
  });
  const pending = h.service.end(JSON.stringify(selected()), control(6000, a.signal));
  while (!finish) await tick();
  a.abort();
  assert.deepEqual(await pending, { outcome: "unknown" });
  finish({ rows: [{ outcome: "ended", audit_id: randomUUID() }] });
  await tick();
  assert.equal(h.calls.at(-1).statement, sql.end);
  assert.deepEqual(h.releases, [true]);
});
test("nonsettling physical disposal is unknown at the original budget", async () => {
  const h = harness({ release: () => new Promise(() => {}) });
  assert.deepEqual(await h.service.end(JSON.stringify(selected()), control(1020)), {
    outcome: "unknown",
  });
  assert.deepEqual(h.releases, [true]);
});
test("post-release clock expiry and regression cannot revive a successful outcome", async () => {
  let h;
  h = harness({
    release: async () => {
      h.clock(6000);
    },
  });
  assert.deepEqual(await h.service.end(JSON.stringify(selected()), control()), {
    outcome: "unknown",
  });
  h.clock(1000);
  assert.deepEqual(await h.service.end(JSON.stringify(selected()), control()), {
    outcome: "unavailable",
  });
  const regression = harness();
  regression.clock(999);
  await regression.service.end(JSON.stringify(selected()), control());
  regression.clock(998);
  assert.deepEqual(await regression.service.end(JSON.stringify(selected()), control()), {
    outcome: "unavailable",
  });
});
test("notification throws/async promises are unknown with zero end calls and no rejection leak", async () => {
  const errors = [];
  const listener = (e) => errors.push(e);
  process.on("unhandledRejection", listener);
  try {
    for (const notify of [
      () => {
        throw Error();
      },
      () => Promise.reject(Error()),
      () => new Promise(() => {}),
    ]) {
      const h = harness();
      assert.deepEqual(await h.service.end(JSON.stringify(selected()), control(), notify), {
        outcome: "unknown",
      });
      assert.equal(
        h.calls.some((x) => x.statement === sql.end),
        false,
      );
      assert.deepEqual(h.releases, [true]);
    }
    await tick();
    assert.deepEqual(errors, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});
test("independent attempts use separate owned connections and never retain family/audit facts", async () => {
  const identities = [];
  const h = harness({
    connect: async (_control, template) => {
      const client = { query: template.query, release: template.release };
      identities.push(client);
      return client;
    },
  });
  const replies = await Promise.all([
    h.service.end(JSON.stringify(selected()), control()),
    h.service.end(JSON.stringify(selected()), control()),
  ]);
  assert.equal(identities.length, 2);
  assert.notEqual(identities[0], identities[1]);
  assert.deepEqual(replies, [{ outcome: "ended" }, { outcome: "ended" }]);
  assert.deepEqual(h.releases, [true, true]);
  assert.equal(h.calls.filter((x) => x.statement === sql.end).length, 2);
});
