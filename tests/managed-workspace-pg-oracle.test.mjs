import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  createManagedWorkspacePgOracle,
  managedWorkspaceExpectedScript,
  managedWorkspaceWireSql,
} from "../scripts/fixtures/managed-workspace-pg-oracle.mjs";
import { resolveControlledNeonPostgresqlEndpoint } from "../scripts/fixtures/controlled-neon-postgresql.mjs";

const marker = ["Morrow", "workspace", "oracle", "synthetic", "only"].join("_");
const i16 = (value) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(value);
  return b;
};
const i32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value);
  return b;
};
const zero = (text) => Buffer.concat([Buffer.from(text), Buffer.from([0])]);
const frame = (type, body = Buffer.alloc(0)) =>
  Buffer.concat([Buffer.from(type), i32(body.length + 4), body]);
const startup = (entries) => {
  const body = Buffer.concat([
    i32(196608),
    ...entries.flatMap(([key, value]) => [zero(key), zero(value)]),
    Buffer.from([0]),
  ]);
  return Buffer.concat([i32(body.length + 4), body]);
};
const query = (text) => frame("Q", zero(text));
const parse = (text) => frame("P", Buffer.concat([zero(""), zero(text), i16(0)]));
const bind = (values) =>
  frame(
    "B",
    Buffer.concat([
      zero(""),
      zero(""),
      i16(0),
      i16(values.length),
      ...values.flatMap((value) => [i32(Buffer.byteLength(value)), Buffer.from(value)]),
      i16(0),
    ]),
  );
const describe = () => frame("D", Buffer.concat([Buffer.from("P"), zero("")]));
const execute = () => frame("E", Buffer.concat([zero(""), i32(0)]));
function backendRows(chunks) {
  const bytes = Buffer.concat(
      chunks.filter((b) => b instanceof Uint8Array).map((b) => Buffer.from(b)),
    ),
    rows = [];
  for (let at = 0; at < bytes.length; ) {
    const type = bytes.toString("ascii", at, at + 1),
      length = bytes.readInt32BE(at + 1),
      end = at + length + 1;
    assert.ok(length >= 4 && end <= bytes.length);
    if (type === "D") {
      let position = at + 7;
      const count = bytes.readInt16BE(at + 5),
        row = [];
      for (let n = 0; n < count; n++) {
        const size = bytes.readInt32BE(position);
        position += 4;
        row.push(size === -1 ? null : bytes.toString("utf8", position, position + size));
        if (size !== -1) position += size;
      }
      assert.equal(position, end);
      rows.push(row);
    }
    at = end;
  }
  return rows;
}
const names = ["identityPool", "linkingPool", "logoutPool"];
const app = (number, kind = "p") =>
  "morrow_t88_" + number.toString(16).padStart(32, "0") + "_" + kind;
function setup(options = {}) {
  const name = options.name ?? "identityPool",
    profile = managedWorkspaceWireSql[name];
  const operation = options.operation ?? { statement: "begin" };
  const script = managedWorkspaceExpectedScript(name, [operation]);
  const oracle = createManagedWorkspacePgOracle({
    password: marker,
    poolNames: options.poolNames ?? [name],
    scripts: { [name]: script },
    ...options.oracle,
  });
  const open = (
    poolName = name,
    applicationName = app(1),
    mutate = () => {},
    acknowledgeClose = true,
  ) => {
    const p = managedWorkspaceWireSql[poolName],
      chunks = [],
      observation = { closes: 0 };
    let connection;
    connection = oracle.accept({
      send(data) {
        chunks.push(data);
      },
      close() {
        observation.closes++;
        if (acknowledgeClose) connection.transportClosed();
      },
    });
    const values = [
      ["user", p.role],
      ["database", "morrow"],
      ["application_name", applicationName],
      ["statement_timeout", p.statementTimeout],
      ["idle_in_transaction_session_timeout", p.idleTimeout],
      ["client_encoding", "UTF8"],
    ];
    mutate(values);
    return {
      connection,
      values,
      chunks,
      observation,
      start() {
        connection.receive(startup(values));
      },
      authenticate() {
        this.start();
        connection.receive(frame("p", zero(marker)));
      },
      metadata() {
        connection.receive(query(managedWorkspaceWireSql.primary));
        return backendRows(chunks).at(-1);
      },
    };
  };
  return { name, profile, operation, script, oracle, open };
}
function extended(connection, text, values) {
  connection.receive(parse(text));
  connection.receive(bind(values));
  connection.receive(describe());
  connection.receive(execute());
  connection.receive(frame("H"));
  connection.receive(frame("S"));
}

for (const name of names) {
  test(
    name + " independently checks startup/password/metadata and one exact registered statement",
    () => {
      const f = setup({ name, oracle: { fragmentBytes: 1 } }),
        c = f.open();
      c.authenticate();
      const tuple = c.metadata();
      assert.equal(tuple[1], f.profile.role);
      assert.equal(tuple[1], tuple[2]);
      assert.equal(tuple[3], "morrow");
      assert.equal(tuple[8], "2026-10-17T00:00:00.123456Z");
      c.connection.receive(query(f.profile.statements.begin));
      c.connection.receive(frame("X"));
      const measured = f.oracle.snapshot();
      assert.equal(measured.startups, 1);
      assert.equal(measured.authenticated, 1);
      assert.equal(measured.statements, 1);
      assert.equal(measured.activePrimaryTuples, 0);
      assert.equal(measured.activeTransports, 0);
      assert.equal(c.observation.closes, 1);
      assert.ok(measured.sentFrames > 20);
    },
  );
}
test("exactly three workspace profiles and distinct linking begin/role SQL are frozen", () => {
  assert.deepEqual(
    Object.keys(managedWorkspaceWireSql).sort(),
    ["primary", "observer", ...names].sort(),
  );
  assert.equal(managedWorkspaceWireSql.identityPool.role, "morrow_api");
  assert.equal(managedWorkspaceWireSql.linkingPool.role, "morrow_identity_linking");
  assert.equal(managedWorkspaceWireSql.logoutPool.role, "morrow_identity_logout");
  const p = managedWorkspaceWireSql.linkingPool;
  assert.notEqual(p.statements.begin, p.statements.readOnlyBegin);
  assert.notEqual(p.statements.role, p.statements.readRole);
  assert.equal(p.arities.apply, 11);
  assert.equal(p.arities.lookup, 4);
  assert.equal(p.arities.status, 4);
  assert.ok(Object.isFrozen(p.statements));
});
for (const [name, expected] of [
  ["identityPool", ["bind", 2]],
  ["linkingPool", ["apply", 11]],
  ["logoutPool", ["end", 8]],
]) {
  test(
    name + " actual extended frames must match pre-registered parameters and Flush/Sync order",
    () => {
      const [statement, count] = expected,
        values = Array.from({ length: count }, (_, n) => "registered_" + n);
      const f = setup({
          name,
          operation: {
            statement,
            parameters: values,
            fields: [{ name: "wire_marker" }],
            rows: [["copied_result"]],
          },
        }),
        c = f.open();
      c.authenticate();
      c.metadata();
      extended(c.connection, f.profile.statements[statement], values);
      assert.equal(f.oracle.snapshot().parameterQueries, 1);
      assert.equal(backendRows(c.chunks).at(-1)[0], "copied_result");
      c.connection.receive(frame("X"));
    },
  );
}
test("registered parameters/results are snapshotted before the client supplies bytes", () => {
  const params = ["a", "b"],
    fields = [{ name: "result" }],
    rows = [["before"]];
  const script = managedWorkspaceExpectedScript("identityPool", [
    { statement: "bind", parameters: params, fields, rows },
  ]);
  params[0] = "mutated";
  fields[0].name = "changed";
  rows[0][0] = "after";
  const f = setup({ oracle: { scripts: { identityPool: script } } }),
    c = f.open();
  c.authenticate();
  c.metadata();
  extended(c.connection, f.profile.statements.bind, ["a", "b"]);
  assert.equal(backendRows(c.chunks).at(-1)[0], "before");
  c.connection.receive(frame("X"));
});
for (const change of [
  "wrong_role",
  "database",
  "timeout",
  "idle",
  "encoding",
  "extra",
  "duplicate",
  "app",
]) {
  test("startup rejects " + change + " before authentication or metadata", () => {
    const f = setup(),
      c = f.open("identityPool", app(1), (values) => {
        const index = { wrong_role: 0, database: 1, timeout: 3, idle: 4, encoding: 5, app: 2 }[
          change
        ];
        if (index !== undefined) values[index][1] = change === "wrong_role" ? "postgres" : "wrong";
        else
          values.push(
            change === "duplicate" ? ["user", "morrow_api"] : ["options", "-c role=postgres"],
          );
      });
    assert.throws(() => c.start(), /MANAGED_WORKSPACE_PG_ORACLE_REJECTED/);
    assert.equal(f.oracle.snapshot().authenticated, 0);
    assert.equal(f.oracle.snapshot().primaryMetadata, 0);
    assert.equal(f.oracle.snapshot().statements, 0);
    c.connection.transportClosed();
  });
}
test("wrong password and unauthenticated query are sticky protocol holds", () => {
  for (const message of [frame("p", zero("wrong")), query("SELECT 1")]) {
    const f = setup(),
      c = f.open();
    c.start();
    assert.throws(() => c.connection.receive(message), /MANAGED_WORKSPACE_PG_ORACLE_REJECTED/);
    assert.throws(() => c.connection.receive(frame("p", zero(marker))), /MANAGED_WORKSPACE/);
    assert.equal(f.oracle.snapshot().authenticated, 0);
    c.connection.transportClosed();
  }
});
test("normal SQL cannot precede exact primary self-attribution", () => {
  const f = setup(),
    c = f.open();
  c.authenticate();
  assert.throws(() => c.connection.receive(query(f.profile.statements.begin)), /MANAGED_WORKSPACE/);
  assert.equal(f.oracle.snapshot().primaryMetadata, 0);
  c.connection.transportClosed();
});
test("changed parameter value, wrong arity and unregistered statement are held", () => {
  for (const parameters of [["wrong", "b"], ["a"], ["a", "b", "c"]]) {
    const f = setup({ operation: { statement: "bind", parameters: ["a", "b"] } }),
      c = f.open();
    c.authenticate();
    c.metadata();
    c.connection.receive(parse(f.profile.statements.bind));
    assert.throws(() => c.connection.receive(bind(parameters)), /MANAGED_WORKSPACE/);
    assert.equal(f.oracle.snapshot().statements, 0);
    c.connection.transportClosed();
  }
  const f = setup(),
    c = f.open();
  c.authenticate();
  c.metadata();
  assert.throws(() => c.connection.receive(query("SET ROLE postgres")), /MANAGED_WORKSPACE/);
  c.connection.transportClosed();
});
test("observer admission requires independently observed primary transport closure", () => {
  const f = setup(),
    p = f.open("identityPool", app(1), undefined, false);
  p.authenticate();
  p.metadata();
  p.connection.receive(frame("X"));
  assert.equal(p.observation.closes, 1);
  assert.equal(f.oracle.snapshot().activePrimaryTuples, 1);
  const observer = f.open("identityPool", app(2, "o"));
  assert.throws(() => observer.start(), /MANAGED_WORKSPACE/);
  p.connection.transportClosed();
  observer.connection.transportClosed();
});
test("fresh same-role observer must query the complete exact closed primary tuple", () => {
  const f = setup(),
    p = f.open();
  p.authenticate();
  const tuple = p.metadata();
  p.connection.receive(frame("X"));
  const observer = f.open("identityPool", app(2, "o"));
  observer.authenticate();
  extended(observer.connection, managedWorkspaceWireSql.observer, [
    tuple[0],
    tuple[8],
    tuple[3],
    tuple[1],
    tuple[7],
  ]);
  assert.equal(backendRows(observer.chunks).at(-1).at(-1), "f");
  observer.connection.receive(frame("X"));
  const result = f.oracle.snapshot();
  assert.equal(result.observerMetadata, 1);
  assert.equal(result.activePrimaryTuples, 0);
  assert.equal(result.activeTransports, 0);
});
test("observer tuple mutation cannot be hidden behind role or backend PID alone", () => {
  for (const field of [0, 1, 2, 3, 4]) {
    const f = setup(),
      p = f.open();
    p.authenticate();
    const tuple = p.metadata();
    p.connection.receive(frame("X"));
    const o = f.open("identityPool", app(2, "o"));
    o.authenticate();
    const values = [tuple[0], tuple[8], tuple[3], tuple[1], tuple[7]];
    values[field] += "x";
    o.connection.receive(parse(managedWorkspaceWireSql.observer));
    assert.throws(() => o.connection.receive(bind(values)), /MANAGED_WORKSPACE/);
    assert.equal(f.oracle.snapshot().observerMetadata, 0);
    o.connection.transportClosed();
  }
});
test("observer cannot perform business SQL after one absence observation", () => {
  const f = setup(),
    p = f.open();
  p.authenticate();
  const tuple = p.metadata();
  p.connection.receive(frame("X"));
  const o = f.open("identityPool", app(2, "o"));
  o.authenticate();
  extended(o.connection, managedWorkspaceWireSql.observer, [
    tuple[0],
    tuple[8],
    tuple[3],
    tuple[1],
    tuple[7],
  ]);
  assert.throws(() => o.connection.receive(query(f.profile.statements.begin)), /MANAGED_WORKSPACE/);
  o.connection.transportClosed();
});
test("duplicate primary application identity and second primary beyond registered allowance are denied", () => {
  for (const number of [1, 2]) {
    const f = setup(),
      a = f.open();
    a.authenticate();
    a.metadata();
    const b = f.open("identityPool", app(number));
    assert.throws(() => b.start(), /MANAGED_WORKSPACE/);
    a.connection.transportClosed();
    b.connection.transportClosed();
  }
});
test("concurrent source-registered primaries retain independent tuples and parameters", () => {
  const f = setup({ poolNames: ["identityPool", "identityPool"] }),
    a = f.open(),
    b = f.open("identityPool", app(2));
  a.authenticate();
  b.authenticate();
  const ta = a.metadata(),
    tb = b.metadata();
  assert.notEqual(ta[0], tb[0]);
  assert.notEqual(ta[7], tb[7]);
  a.connection.receive(query(f.profile.statements.begin));
  b.connection.receive(query(f.profile.statements.begin));
  a.connection.transportClosed();
  assert.equal(f.oracle.snapshot().activePrimaryTuples, 1);
  b.connection.transportClosed();
  assert.equal(f.oracle.snapshot().activePrimaryTuples, 0);
});
test("accepted pending statement can terminate and late output is discarded without a false resource acknowledgement", () => {
  const callbacks = [],
    events = [],
    f = setup({
      oracle: {
        fault: "slow_query",
        schedule(callback) {
          callbacks.push(callback);
        },
        onEvent(kind, row) {
          events.push({ kind, ...row });
        },
      },
    }),
    c = f.open();
  c.authenticate();
  c.metadata();
  c.connection.receive(query(f.profile.statements.begin));
  assert.equal(events.length, 1);
  assert.equal(callbacks.length, 1);
  const before = c.chunks.length;
  c.connection.receive(frame("X"));
  callbacks[0]();
  assert.equal(c.chunks.length, before);
  assert.equal(f.oracle.snapshot().lateOutputDiscards, 1);
  assert.equal(f.oracle.snapshot().activeTransports, 0);
});
test("extended Sync cannot finish a delayed statement before its data and command", () => {
  const callbacks = [],
    f = setup({
      operation: {
        statement: "bind",
        parameters: ["a", "b"],
        fields: [{ name: "accepted" }],
        rows: [["yes"]],
      },
      oracle: {
        fault: "slow_query",
        schedule(callback) {
          callbacks.push(callback);
        },
      },
    }),
    c = f.open();
  c.authenticate();
  c.metadata();
  c.chunks.length = 0;
  extended(c.connection, f.profile.statements.bind, ["a", "b"]);
  const types = () => {
    const bytes = Buffer.concat(c.chunks.map(Buffer.from)),
      result = [];
    for (let at = 0; at < bytes.length; ) {
      result.push(String.fromCharCode(bytes[at]));
      at += 1 + bytes.readInt32BE(at + 1);
      assert.ok(at <= bytes.length);
    }
    return result;
  };
  assert.equal(callbacks.length, 1);
  assert.deepEqual(types(), ["1", "2", "T"]);
  callbacks[0]();
  assert.deepEqual(types(), ["1", "2", "T", "D", "C", "Z"]);
  assert.deepEqual(backendRows(c.chunks), [["yes"]]);
  c.connection.receive(frame("X"));
  assert.equal(f.oracle.snapshot().activeTransports, 0);
});
test("lost COMMIT response is explicitly withheld, never actual PostgreSQL commit proof", () => {
  const f = setup({ operation: { statement: "commit" }, oracle: { fault: "commit_unknown" } }),
    c = f.open();
  c.authenticate();
  c.metadata();
  const before = c.chunks.length;
  c.connection.receive(query("COMMIT"));
  assert.equal(c.chunks.length, before);
  assert.equal(f.oracle.snapshot().committedResponsesWithheld, 1);
  c.connection.transportClosed();
});
test("Flush before Execute and duplicate Bind are protocol holds", () => {
  for (const mode of ["flush", "bind"]) {
    const f = setup({ operation: { statement: "bind", parameters: ["a", "b"] } }),
      c = f.open();
    c.authenticate();
    c.metadata();
    c.connection.receive(parse(f.profile.statements.bind));
    c.connection.receive(bind(["a", "b"]));
    assert.throws(
      () => c.connection.receive(mode === "flush" ? frame("H") : bind(["a", "b"])),
      /MANAGED_WORKSPACE/,
    );
    c.connection.transportClosed();
  }
});
test("registration denies arbitrary role/SQL/fault and 129/nonASCII parameters, accepts128", () => {
  assert.throws(
    () => createManagedWorkspacePgOracle({ password: marker, poolNames: ["loginPool"] }),
    /MANAGED_WORKSPACE/,
  );
  assert.throws(
    () =>
      createManagedWorkspacePgOracle({
        password: marker,
        poolNames: ["identityPool"],
        fault: "invented",
      }),
    /MANAGED_WORKSPACE/,
  );
  assert.throws(
    () => managedWorkspaceExpectedScript("identityPool", [{ statement: "arbitrary" }]),
    /MANAGED_WORKSPACE/,
  );
  for (const value of ["x".repeat(129), "é", "\0"])
    assert.throws(
      () =>
        managedWorkspaceExpectedScript("identityPool", [
          { statement: "workspace", parameters: [value] },
        ]),
      /MANAGED_WORKSPACE/,
    );
  assert.equal(
    managedWorkspaceExpectedScript("identityPool", [
      { statement: "workspace", parameters: ["x".repeat(128)] },
    ])[0].parameters[0].length,
    128,
  );
});
test("oracle imports only old raw codecs and never production or the four-role oracle", () => {
  const source = readFileSync(
      new URL("../scripts/fixtures/managed-workspace-pg-oracle.mjs", import.meta.url),
      "utf8",
    ),
    file = ts.createSourceFile(
      "oracle.mjs",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    imports = file.statements.filter(ts.isImportDeclaration);
  assert.deepEqual(
    imports.map((node) => node.moduleSpecifier.text),
    ["node:assert/strict", "./controlled-neon-pg-wire-oracle.mjs"],
  );
  const names = imports[1].importClause.namedBindings.elements.map((node) => node.name.text);
  assert.ok(names.includes("createPgFrontendParser"));
  assert.ok(!names.some((name) => /controlledNeon|createControlled/.test(name)));
});
test("public snapshots omit bearer password, expected parameter values and raw application tuples", () => {
  const f = setup({
      operation: { statement: "bind", parameters: ["private_parameter", "workspace"] },
    }),
    c = f.open();
  c.authenticate();
  c.metadata();
  const text = JSON.stringify(f.oracle.snapshot());
  assert.ok(!text.includes(marker));
  assert.ok(!text.includes("private_parameter"));
  assert.ok(!text.includes(app(1)));
  c.connection.transportClosed();
});

const engineSource = readFileSync(
  new URL("../scripts/fixtures/controlled-neon-postgresql.mjs", import.meta.url),
  "utf8",
);
const engineAst = ts.createSourceFile(
  "engine.mjs",
  engineSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
function visit(node, predicate) {
  if (predicate(node)) return node;
  let found;
  node.forEachChild((child) => {
    found ??= visit(child, predicate);
  });
  return found;
}
function fixedProfiles() {
  const declarations = engineAst.statements.filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((decl) =>
        ["roles", "loginProfile", "workspaceProfile"].includes(decl.name.getText(engineAst)),
      ),
  );
  assert.equal(declarations.length, 3);
  const wrappers = engineAst.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ["controlledNeonPostgresqlLab", "managedWorkspacePostgresqlLab"].includes(node.name.text),
  );
  assert.equal(wrappers.length, 2);
  const context = vm.createContext({ ownedPostgresqlLab: (_use, profile) => profile, Object });
  vm.runInContext(
    declarations.map((node) => node.getText(engineAst)).join("\n") +
      "\n" +
      wrappers.map((node) => node.getText(engineAst).replace("export async", "async")).join("\n") +
      "\n globalThis.exports={controlledNeonPostgresqlLab,managedWorkspacePostgresqlLab};",
    context,
  );
  return context.exports;
}
test("two named engine wrappers select only fixed frozen four/seven role profiles", async () => {
  const exports = fixedProfiles(),
    original = await exports.controlledNeonPostgresqlLab(),
    next = await exports.managedWorkspacePostgresqlLab();
  assert.equal(original.roles.length, 4);
  assert.equal(next.roles.length, 7);
  assert.deepEqual(
    [...next.roles],
    [...original.roles, "morrow_api", "morrow_identity_linking", "morrow_identity_logout"],
  );
  assert.ok(Object.isFrozen(original));
  assert.ok(Object.isFrozen(next.roles));
  assert.equal((await exports.controlledNeonPostgresqlLab(null, next)).roles.length, 4);
  assert.equal(
    resolveControlledNeonPostgresqlEndpoint(Object.freeze({ host: "127.0.0.1", port: 5432 })),
    null,
  );
});
async function offeredProbeRun(roles, badRole) {
  const method = visit(
    engineAst,
    (node) => ts.isMethodDeclaration(node) && node.name.getText(engineAst) === "sealSetup",
  );
  assert.ok(method);
  const calls = [],
    phases = [];
  let sqlReads = 0;
  const context = vm.createContext({
    roles,
    setupPhase: (name) => phases.push(name),
    require(value) {
      assert.ok(value);
    },
    phase: "setup",
    passwordByRole: Object.fromEntries(roles.map((role) => [role, marker])),
    literal: (value) => "'" + value + "'",
    gateway: "172.20.0.1",
    containerId: "inert_not_a_container",
    command: async () => ({}),
    sql: async (text) => (text.includes("pg_reload_conf") ? "t" : String(++sqlReads)),
    authenticationProbe: async (_target, role) => {
      calls.push(role);
      return role === badRole
        ? "other"
        : ["postgres", "morrow_identity_owner"].includes(role)
          ? "rejected"
          : "scram";
    },
    target: Object.freeze({ inert: true }),
  });
  vm.runInContext(
    "globalThis.run=async function sealSetup()" + method.body.getText(engineAst),
    context,
  );
  return { promise: context.run(), calls, phases };
}
test("engine counts only completed SCRAM offers and closed denied probes for both profiles", async () => {
  const profiles = fixedProfiles();
  for (const profile of [
    await profiles.controlledNeonPostgresqlLab(),
    await profiles.managedWorkspacePostgresqlLab(),
  ]) {
    const run = await offeredProbeRun([...profile.roles]);
    const result = await run.promise;
    assert.equal(result.scramOfferedRoles, profile.roles.length);
    assert.equal(result.probeConnectionsClosed, profile.roles.length + 2);
    assert.deepEqual(run.calls, [...profile.roles, "postgres", "morrow_identity_owner"]);
    assert.ok(run.phases.includes("requests_callback"));
  }
});
test("failed role or denied-probe observation cannot produce a successful engine receipt", async () => {
  const profile = await fixedProfiles().managedWorkspacePostgresqlLab();
  for (const bad of [profile.roles[2], "postgres", "morrow_identity_owner"]) {
    const run = await offeredProbeRun([...profile.roles], bad);
    await assert.rejects(run.promise);
    assert.ok(!run.phases.includes("requests_callback"));
  }
});

for (const fault of [
  "wrong_role",
  "wrong_database",
  "wrong_pid",
  "wrong_app",
  "bad_timestamp",
  "missing_field",
  "extra_row",
]) {
  test("independent primary metadata fault remains observable: " + fault, () => {
    const f = setup({ oracle: { fault } }),
      c = f.open();
    c.authenticate();
    const value = c.metadata(),
      rows = backendRows(c.chunks);
    if (fault === "wrong_role") assert.equal(value[1], "foreign_role");
    if (fault === "wrong_database") assert.equal(value[3], "foreign_database");
    if (fault === "wrong_pid") assert.notEqual(value[0], value[4]);
    if (fault === "wrong_app") assert.equal(value[7], "foreign_application");
    if (fault === "bad_timestamp") assert.equal(value[8], "2026-02-30T00:00:00.123456Z");
    if (fault === "missing_field") assert.equal(value.length, 8);
    if (fault === "extra_row") assert.equal(rows.length, 2);
    c.connection.transportClosed();
  });
}
for (const fault of [
  "observer_wrong_role",
  "observer_wrong_database",
  "observer_wrong_pid",
  "observer_wrong_app",
  "observer_millisecond_timestamp",
  "observer_hidden_self",
  "observer_null_field",
  "observer_empty",
  "observer_primary_present",
]) {
  test(
    "independent observer fault does not mutate its prerequisite primary observation: " + fault,
    () => {
      const f = setup({ oracle: { fault } }),
        p = f.open();
      p.authenticate();
      const tuple = p.metadata();
      assert.equal(tuple[1], "morrow_api");
      assert.equal(tuple[8], "2026-10-17T00:00:00.123456Z");
      p.connection.receive(frame("X"));
      const o = f.open("identityPool", app(2, "o"));
      o.authenticate();
      extended(o.connection, managedWorkspaceWireSql.observer, [
        tuple[0],
        tuple[8],
        tuple[3],
        tuple[1],
        tuple[7],
      ]);
      const rows = backendRows(o.chunks),
        value = rows.at(-1);
      if (fault === "observer_empty") assert.equal(rows.length, 0);
      else {
        if (fault === "observer_wrong_role") assert.equal(value[1], "foreign_role");
        if (fault === "observer_wrong_database") assert.equal(value[3], "foreign_database");
        if (fault === "observer_wrong_pid") assert.notEqual(value[0], value[4]);
        if (fault === "observer_wrong_app") assert.equal(value[7], "foreign_application");
        if (fault === "observer_millisecond_timestamp")
          assert.equal(value[8], "2026-10-17T00:00:00.123Z");
        if (fault === "observer_hidden_self") assert.equal(value[4], null);
        if (fault === "observer_null_field") assert.equal(value[8], null);
        if (fault === "observer_primary_present") assert.equal(value[9], "t");
      }
      o.connection.receive(frame("X"));
    },
  );
}
test("withheld transport closure and exhausted two-handle allowance cannot be called acknowledged", () => {
  const f = setup({ oracle: { fault: "withheld_close" } }),
    c = f.open();
  c.authenticate();
  c.metadata();
  c.connection.receive(frame("X"));
  assert.equal(c.observation.closes, 0);
  assert.equal(f.oracle.snapshot().activeTransports, 1);
  c.connection.transportClosed();
  const second = f.open("identityPool", app(2, "o"));
  second.connection.transportClosed();
  assert.throws(() => f.open("identityPool", app(3)), /MANAGED_WORKSPACE/);
});
test("registered result bytes have an aggregate bound independent of result-row count", () => {
  assert.throws(
    () =>
      managedWorkspaceExpectedScript("identityPool", [
        {
          statement: "workspaceAuthority",
          fields: [{ name: "grants" }],
          rows: [["x".repeat(600000)], ["y".repeat(600000)]],
        },
      ]),
    /MANAGED_WORKSPACE/,
  );
});
