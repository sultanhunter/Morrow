import assert from "node:assert/strict";
import test from "node:test";
import {
  createPgFrontendParser,
  createControlledNeonPgOracle,
  controlledNeonWireSql,
  controlledNeonExpectedScript,
  decodePgFrontendMessage,
  encodePgBackendMessage,
  pgAuthentication,
  pgDataRow,
  pgRowDescription,
  pgRows,
} from "../scripts/fixtures/controlled-neon-pg-wire-oracle.mjs";
const int16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const int32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const zero = (s) => Buffer.concat([Buffer.from(s), Buffer.from([0])]);
const startup = (...values) => {
  const body = Buffer.concat([int32(196608), ...values.map(zero), Buffer.from([0])]);
  return Buffer.concat([int32(body.length + 4), body]);
};
const query = (sql) => {
  const body = zero(sql);
  return Buffer.concat([Buffer.from("Q"), int32(body.length + 4), body]);
};
const parser = (options = {}) => {
  const starts = [],
    messages = [];
  return {
    starts,
    messages,
    value: createPgFrontendParser({
      onStartup: (value) => starts.push(value),
      onMessage: (value) => messages.push(value),
      ...options,
    }),
  };
};
test("independent parser handles arbitrary fragmentation and coalesced frontend frames", () => {
  const p = parser();
  const all = Buffer.concat([
    startup("user", "morrow_identity_login", "database", "morrow", "client_encoding", "UTF8"),
    query("BEGIN"),
    query("COMMIT"),
  ]);
  for (const b of all) p.value.push(Uint8Array.of(b));
  p.value.finish();
  assert.equal(p.starts[0].parameters.user, "morrow_identity_login");
  assert.deepEqual(
    p.messages.map((r) => r.text),
    ["BEGIN", "COMMIT"],
  );
  assert.equal(p.value.metrics.frontendFrames, 2);
});
test("startup duplicate keys, wrong protocol and SSL/cancel are held", () => {
  const bad = [
    startup("user", "a", "user", "b"),
    Buffer.concat([int32(8), int32(80877103)]),
    Buffer.concat([int32(16), int32(80877102), int32(1), int32(2)]),
  ];
  for (const message of bad)
    assert.throws(() => parser().value.push(message), /PG_WIRE_ORACLE_REJECTED/);
});
test("length, incomplete and total byte bounds fail before an incomplete verdict", () => {
  assert.throws(() => parser().value.push(int32(-1)), /PG_WIRE_ORACLE_REJECTED/);
  const p = parser();
  p.value.push(startup("user", "a"));
  p.value.push(Buffer.from([81, 0]));
  assert.throws(() => p.value.finish(), /PG_WIRE_ORACLE_REJECTED/);
  assert.throws(
    () =>
      parser({ maxFrameBytes: 16, maxBufferedBytes: 32, maxTotalBytes: 64 }).value.push(
        startup("user", "a very long user"),
      ),
    /PG_WIRE_ORACLE_REJECTED/,
  );
});
test("decoded parameters are copied, strict UTF8 and text format only", () => {
  const value = Buffer.from("﻿copied value");
  const payload = Buffer.concat([
    zero(""),
    zero(""),
    int16(0),
    int16(1),
    int32(value.length),
    value,
    int16(0),
  ]);
  const decoded = decodePgFrontendMessage("B", payload);
  payload.fill(0);
  assert.deepEqual(decoded.parameters, ["﻿copied value"]);
  assert.ok(Object.isFrozen(decoded.parameters));
  assert.throws(
    () =>
      decodePgFrontendMessage(
        "B",
        Buffer.concat([zero(""), zero(""), int16(1), int16(1), int16(0), int16(0)]),
      ),
    /PG_WIRE_ORACLE_REJECTED/,
  );
});
test("Parse Describe Execute Sync and Terminate decode independent protocol fields", () => {
  const parsed = decodePgFrontendMessage(
    "P",
    Buffer.concat([zero(""), zero("SELECT $1"), int16(1), int32(25)]),
  );
  assert.equal(parsed.text, "SELECT $1");
  assert.deepEqual(parsed.parameterTypes, [25]);
  assert.deepEqual(decodePgFrontendMessage("D", Buffer.from([80, 0])), {
    type: "D",
    target: "P",
    name: "",
  });
  assert.deepEqual(decodePgFrontendMessage("E", Buffer.concat([zero(""), int32(0)])), {
    type: "E",
    portal: "",
    maximumRows: 0,
  });
  assert.deepEqual(decodePgFrontendMessage("S", Buffer.alloc(0)), { type: "S" });
  assert.deepEqual(decodePgFrontendMessage("X", Buffer.alloc(0)), { type: "X" });
});
test("password frames remain copied opaque bytes for transparent SCRAM observation", () => {
  const payload = Buffer.from([83, 0, 1, 2, 3]);
  const decoded = decodePgFrontendMessage("p", payload);
  payload.fill(0);
  assert.deepEqual([...decoded.data], [83, 0, 1, 2, 3]);
});
test("unsupported frontend types and trailing data are rejected", () => {
  assert.throws(() => decodePgFrontendMessage("Y", Buffer.alloc(0)), /PG_WIRE_ORACLE_REJECTED/);
  assert.throws(
    () => decodePgFrontendMessage("Q", Buffer.from([65, 0, 99])),
    /PG_WIRE_ORACLE_REJECTED/,
  );
  assert.throws(() => decodePgFrontendMessage("Q", Buffer.from([255, 0])));
});
test("backend framing and authentication request bytes match PostgreSQLv3 layout", () => {
  assert.deepEqual([...pgAuthentication(3)], [82, 0, 0, 0, 8, 0, 0, 0, 3]);
  const packet = encodePgBackendMessage("1");
  assert.deepEqual([...packet], [49, 0, 0, 0, 4]);
});
test("row metadata and values encode explicit text OIDs and nullable fields", () => {
  const description = pgRowDescription([{ name: "value", oid: 25 }]);
  assert.equal(description[0], 84);
  assert.equal(description.readInt32BE(1), description.length - 1);
  assert.equal(description.readInt16BE(5), 1);
  const row = pgDataRow(["hello", null]);
  assert.equal(row[0], 68);
  assert.equal(row.readInt16BE(5), 2);
  assert.equal(row.readInt32BE(row.length - 4), -1);
  const result = pgRows([{ name: "value" }], [["hello"]]);
  assert.ok(result.includes(Buffer.from("SELECT 1\0")));
  assert.deepEqual([...result.subarray(-6)], [90, 0, 0, 0, 5, 73]);
});
test("parser state cannot be reused after malformed bytes", () => {
  const p = parser();
  assert.throws(() => p.value.push(int32(0)), /PG_WIRE_ORACLE_REJECTED/);
  assert.throws(() => p.value.push(startup("user", "a")), /PG_WIRE_ORACLE_REJECTED/);
});

const fixturePassword = "MorrowSynthetic-T88-PG-password-only";
function wireSession(options = {}) {
  const oracle = createControlledNeonPgOracle({
    password: fixturePassword,
    poolNames: ["loginPool"],
    ...options,
  });
  const emitted = [];
  let closed = 0;
  const session = oracle.accept({
    send: (value) => emitted.push(Buffer.from(value)),
    close: () => closed++,
  });
  const begin = (overrides = {}) =>
    session.receive(
      startup(
        ...Object.entries({
          user: "morrow_identity_login",
          database: "morrow",
          application_name: "morrow_t88_" + "1".repeat(32) + "_p",
          statement_timeout: "1000",
          idle_in_transaction_session_timeout: "5000",
          client_encoding: "UTF8",
          ...overrides,
        }).flat(),
      ),
    );
  const authenticate = () => session.receive(encodePgBackendMessage("p", zero(fixturePassword)));
  return { oracle, emitted, session, begin, authenticate, closed: () => closed };
}
test("independent endpoint challenges then verifies password before metadata", () => {
  const a = wireSession();
  a.begin();
  assert.deepEqual(a.emitted[0], pgAuthentication(3));
  assert.throws(
    () => a.session.receive(query(controlledNeonWireSql.primary)),
    /PG_WIRE_ORACLE_REJECTED/,
  );
  const b = wireSession();
  b.begin();
  b.authenticate();
  b.session.receive(query(controlledNeonWireSql.primary));
  assert.equal(b.oracle.snapshot().authenticated, 1);
  assert.equal(b.oracle.snapshot().primaryMetadata, 1);
});
test("startup exact role database app session settings and extra parameters are checked independently", () => {
  for (const override of [
    { user: "morrow_identity_api" },
    { database: "foreign" },
    { application_name: "foreign" },
    { statement_timeout: "0" },
    { idle_in_transaction_session_timeout: "0" },
    { options: "-c role=owner" },
  ]) {
    const f = wireSession();
    assert.throws(() => f.begin(override), /PG_WIRE_ORACLE_REJECTED/);
  }
});
test("wrong password is never accepted by the endpoint", () => {
  const f = wireSession();
  f.begin();
  assert.throws(
    () => f.session.receive(encodePgBackendMessage("p", zero("different password"))),
    /PG_WIRE_ORACLE_REJECTED/,
  );
  assert.equal(f.oracle.snapshot().authenticated, 0);
});
test("query order and exact pre-registered parameters are endpoint-owned", () => {
  const script = controlledNeonExpectedScript("loginPool", ["value-one", "value-two"]);
  const f = wireSession({ scripts: { loginPool: script } });
  f.begin();
  f.authenticate();
  f.session.receive(query(controlledNeonWireSql.primary));
  assert.throws(() => f.session.receive(query("COMMIT")), /PG_WIRE_ORACLE_REJECTED/);
  const g = wireSession({ scripts: { loginPool: script } });
  g.begin();
  g.authenticate();
  g.session.receive(query(controlledNeonWireSql.primary));
  for (const item of script.slice(0, 4)) g.session.receive(query(item.text));
  g.session.receive(
    encodePgBackendMessage("P", Buffer.concat([zero(""), zero(script[4].text), int16(0)])),
  );
  const badBind = Buffer.concat([
    zero(""),
    zero(""),
    int16(0),
    int16(2),
    int32(9),
    Buffer.from("value-two"),
    int32(9),
    Buffer.from("value-one"),
    int16(0),
  ]);
  assert.throws(
    () => g.session.receive(encodePgBackendMessage("B", badBind)),
    /PG_WIRE_ORACLE_REJECTED/,
  );
});
test("observer is rejected while the independent primary tuple is alive", () => {
  const f = wireSession();
  f.begin();
  f.authenticate();
  f.session.receive(query(controlledNeonWireSql.primary));
  const observer = f.oracle.accept({ send: () => {}, close: () => {} });
  assert.throws(
    () =>
      observer.receive(
        startup(
          "user",
          "morrow_identity_login",
          "database",
          "morrow",
          "application_name",
          "morrow_t88_" + "2".repeat(32) + "_o",
          "statement_timeout",
          "1000",
          "idle_in_transaction_session_timeout",
          "5000",
          "client_encoding",
          "UTF8",
        ),
      ),
    /PG_WIRE_ORACLE_REJECTED/,
  );
  assert.equal(f.oracle.snapshot().activePrimaryTuples, 1);
});
test("transport absence is distinct from merely receiving Terminate", () => {
  const f = wireSession();
  f.begin();
  f.authenticate();
  f.session.receive(query(controlledNeonWireSql.primary));
  f.session.receive(encodePgBackendMessage("X"));
  assert.equal(f.closed(), 1);
  assert.equal(f.oracle.snapshot().activePrimaryTuples, 1);
  f.session.transportClosed();
  assert.equal(f.oracle.snapshot().activePrimaryTuples, 0);
});

test("legal extended Flush emits no synthetic completion before Sync", () => {
  const values = ["value-one", "value-two"],
    script = controlledNeonExpectedScript("loginPool", values);
  const f = wireSession({ scripts: { loginPool: script } });
  f.begin();
  f.authenticate();
  f.session.receive(query(controlledNeonWireSql.primary));
  for (const item of script.slice(0, 4)) f.session.receive(query(item.text));
  f.session.receive(
    encodePgBackendMessage("P", Buffer.concat([zero(""), zero(script[4].text), int16(0)])),
  );
  f.session.receive(
    encodePgBackendMessage(
      "B",
      Buffer.concat([
        zero(""),
        zero(""),
        int16(0),
        int16(values.length),
        ...values.flatMap((v) => [int32(Buffer.byteLength(v)), Buffer.from(v)]),
        int16(0),
      ]),
    ),
  );
  f.session.receive(encodePgBackendMessage("D", Buffer.from([80, 0])));
  f.session.receive(encodePgBackendMessage("E", Buffer.concat([zero(""), int32(0)])));
  const before = f.emitted.length;
  f.session.receive(encodePgBackendMessage("H"));
  assert.equal(f.emitted.length, before);
  f.session.receive(encodePgBackendMessage("S"));
  assert.equal(f.emitted.length, before + 1);
  assert.equal(f.emitted.at(-1)[0], 90);
  assert.equal(f.oracle.snapshot().protocolRejections, 0);
});

test("Terminate before authentication is cleanup, never an authentication verdict", () => {
  const f = wireSession();
  f.begin();
  f.session.receive(encodePgBackendMessage("X"));
  assert.equal(f.closed(), 1);
  assert.equal(f.oracle.snapshot().terminates, 1);
  assert.equal(f.oracle.snapshot().authenticated, 0);
  assert.equal(f.oracle.snapshot().primaryMetadata, 0);
});
