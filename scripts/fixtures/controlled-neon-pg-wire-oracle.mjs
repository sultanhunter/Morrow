import assert from "node:assert/strict";

// Independent PostgreSQL v3 bytes. No SDK, adapter, SQL owner or production
// parser/encoder is imported. Raw frames/passwords/parameters stay in memory.
const fail = () => {
  throw Error("PG_WIRE_ORACLE_REJECTED");
};
const integer = (value, minimum, maximum) =>
  Number.isInteger(value) && value >= minimum && value <= maximum;
const bytes = (value) => {
  if (!(value instanceof Uint8Array)) fail();
  return Buffer.from(value);
};
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
const text = (value) => {
  if (typeof value !== "string" || value.includes("\0")) fail();
  return Buffer.from(value, "utf8");
};
const cstring = (value) => Buffer.concat([text(value), Buffer.from([0])]);
const utf8 = (value) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
function cursor(payload) {
  const data = bytes(payload);
  let at = 0;
  const take = (n) => {
    if (!integer(n, 0, data.length - at)) fail();
    const value = Buffer.from(data.subarray(at, at + n));
    at += n;
    return value;
  };
  return {
    string() {
      const end = data.indexOf(0, at);
      if (end < at) fail();
      const value = utf8(take(end - at));
      take(1);
      return value;
    },
    int16() {
      return take(2).readInt16BE();
    },
    int32() {
      return take(4).readInt32BE();
    },
    take,
    done() {
      if (at !== data.length) fail();
    },
  };
}

export function decodePgFrontendMessage(type, payload) {
  if (typeof type !== "string" || type.length !== 1) fail();
  const c = cursor(payload);
  let fields;
  if (type === "Q") fields = { text: c.string() };
  else if (type === "P") {
    const statement = c.string(),
      query = c.string(),
      count = c.int16();
    if (!integer(count, 0, 1024)) fail();
    const parameterTypes = Array.from({ length: count }, () => c.int32());
    fields = { statement, text: query, parameterTypes: Object.freeze(parameterTypes) };
  } else if (type === "B") {
    const portal = c.string(),
      statement = c.string(),
      formats = c.int16();
    if (!integer(formats, 0, 1024)) fail();
    const formatCodes = Array.from({ length: formats }, () => c.int16());
    const count = c.int16();
    if (
      !integer(count, 0, 1024) ||
      ![0, 1, count].includes(formats) ||
      formatCodes.some((n) => n !== 0)
    )
      fail();
    const parameters = Array.from({ length: count }, () => {
      const length = c.int32();
      if (length === -1) return null;
      return utf8(c.take(length));
    });
    const results = c.int16();
    if (!integer(results, 0, 1024)) fail();
    const resultFormats = Array.from({ length: results }, () => c.int16());
    if (resultFormats.some((n) => n !== 0)) fail();
    fields = {
      portal,
      statement,
      parameters: Object.freeze(parameters),
      formatCodes: Object.freeze(formatCodes),
      resultFormats: Object.freeze(resultFormats),
    };
  } else if (type === "D" || type === "C") {
    const target = String.fromCharCode(c.take(1)[0]);
    if (target !== "S" && target !== "P") fail();
    fields = { target, name: c.string() };
  } else if (type === "E") fields = { portal: c.string(), maximumRows: c.int32() };
  else if (type === "S" || type === "H" || type === "X") fields = {};
  else if (type === "p") {
    // Authentication mode owns interpretation. SCRAM messages are binary and
    // are transparently observable without pretending they are cleartext.
    return Object.freeze({ type, data: bytes(payload) });
  } else fail();
  c.done();
  return Object.freeze({ type, ...fields });
}

export function createPgFrontendParser({
  onStartup,
  onMessage,
  maxFrameBytes = 131072,
  maxBufferedBytes = 262144,
  maxTotalBytes = 2097152,
}) {
  if (
    typeof onStartup !== "function" ||
    typeof onMessage !== "function" ||
    !integer(maxFrameBytes, 8, 1048576) ||
    !integer(maxBufferedBytes, maxFrameBytes, 2097152) ||
    !integer(maxTotalBytes, maxBufferedBytes, 16777216)
  )
    fail();
  let pending = Buffer.alloc(0),
    startup = false,
    held = false;
  const metrics = {
    startupPackets: 0,
    frontendFrames: 0,
    totalBytes: 0,
    pushes: 0,
    partialBuffers: 0,
  };
  return {
    push(chunk) {
      try {
        if (held) fail();
        const copied = bytes(chunk);
        metrics.totalBytes += copied.length;
        metrics.pushes++;
        if (metrics.totalBytes > maxTotalBytes || pending.length + copied.length > maxBufferedBytes)
          fail();
        pending = Buffer.concat([pending, copied]);
        for (;;) {
          const offset = startup ? 1 : 0;
          if (pending.length < offset + 4) break;
          const length = pending.readInt32BE(offset);
          if (!integer(length, startup ? 4 : 8, maxFrameBytes)) fail();
          const total = length + offset;
          if (pending.length < total) break;
          const frame = Buffer.from(pending.subarray(offset + 4, total));
          const type = startup ? String.fromCharCode(pending[0]) : undefined;
          pending = Buffer.from(pending.subarray(total));
          if (!startup) {
            const c = cursor(frame),
              protocolVersion = c.int32();
            if (protocolVersion !== 196608) fail();
            const parameters = Object.create(null);
            for (;;) {
              const key = c.string();
              if (key === "") break;
              if (Object.hasOwn(parameters, key)) fail();
              parameters[key] = c.string();
            }
            c.done();
            startup = true;
            metrics.startupPackets++;
            onStartup(Object.freeze({ protocolVersion, parameters: Object.freeze(parameters) }));
          } else {
            metrics.frontendFrames++;
            onMessage(decodePgFrontendMessage(type, frame));
          }
        }
        if (pending.length) metrics.partialBuffers++;
      } catch {
        held = true;
        throw Error("PG_WIRE_ORACLE_REJECTED");
      }
    },
    finish() {
      if (!startup || pending.length || held) fail();
    },
    metrics,
  };
}

export function encodePgBackendMessage(type, payload = new Uint8Array()) {
  if (typeof type !== "string" || !/^[A-Za-z0-9]$/.test(type)) fail();
  const body = bytes(payload);
  if (body.length > 1048576) fail();
  return Buffer.concat([Buffer.from(type, "ascii"), i32(body.length + 4), body]);
}
export const pgAuthentication = (code, payload = new Uint8Array()) =>
  encodePgBackendMessage("R", Buffer.concat([i32(code), bytes(payload)]));
export const pgParameterStatus = (key, value) =>
  encodePgBackendMessage("S", Buffer.concat([cstring(key), cstring(value)]));
export const pgBackendKeyData = (pid, key) =>
  encodePgBackendMessage("K", Buffer.concat([i32(pid), i32(key)]));
export const pgReady = (state = "I") => encodePgBackendMessage("Z", Buffer.from(state, "ascii"));
export const pgCommand = (command) => encodePgBackendMessage("C", cstring(command));
export const pgError = () =>
  encodePgBackendMessage(
    "E",
    Buffer.concat([
      Buffer.from("S"),
      cstring("ERROR"),
      Buffer.from("C"),
      cstring("XX000"),
      Buffer.from("M"),
      cstring("synthetic protocol refusal"),
      Buffer.from([0]),
    ]),
  );
export function pgRowDescription(fields) {
  return encodePgBackendMessage(
    "T",
    Buffer.concat([
      i16(fields.length),
      ...fields.map((field) =>
        Buffer.concat([
          cstring(field.name),
          i32(0),
          i16(0),
          i32(field.oid ?? 25),
          i16(field.size ?? -1),
          i32(-1),
          i16(0),
        ]),
      ),
    ]),
  );
}
export function pgDataRow(values) {
  return encodePgBackendMessage(
    "D",
    Buffer.concat([
      i16(values.length),
      ...values.map((value) =>
        value === null
          ? i32(-1)
          : (() => {
              const data = Buffer.from(String(value), "utf8");
              return Buffer.concat([i32(data.length), data]);
            })(),
      ),
    ]),
  );
}
export function pgRows(fields, rows, command = "SELECT " + rows.length, ready = true) {
  assert.ok(rows.every((row) => row.length === fields.length));
  return Buffer.concat([
    pgRowDescription(fields),
    ...rows.map(pgDataRow),
    pgCommand(command),
    ...(ready ? [pgReady()] : []),
  ]);
}

export const controlledNeonWireBinding = Object.freeze({
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-controlled-lab",
  branchId: "br-controlled-lab",
  hostname: "ep-controlled-fixture.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
});
const commonRole =
  "SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,\npg_catalog.pg_has_role(current_user,'morrow_identity_owner','MEMBER') AS owner_member,\nEXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS role_member\nFROM pg_catalog.pg_roles r WHERE r.rolname=current_user";
// These literals are the independent expected wire contract, not imports from
// the adapter's allowlist. The lab registers exact parameter values in advance.
export const controlledNeonWireSql = Object.freeze({
  primary: `SELECT pg_catalog.pg_backend_pid()::text AS backend_pid,
current_user::text AS current_role,session_user::text AS session_role,
pg_catalog.current_database()::text AS database_name,
a.pid::text AS self_pid,a.datname::text AS self_database,a.usename::text AS self_role,
a.application_name::text AS application_name,
pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start
FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`,
  observer: `SELECT pg_catalog.pg_backend_pid()::text AS backend_pid,
current_user::text AS current_role,session_user::text AS session_role,
pg_catalog.current_database()::text AS database_name,
a.pid::text AS self_pid,a.datname::text AS self_database,a.usename::text AS self_role,
a.application_name::text AS application_name,
pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,
EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity p
WHERE p.pid=$1::integer AND p.backend_start=$2::timestamptz
AND p.datname=$3::name AND p.usename=$4::name AND p.application_name=$5::text) AS primary_present
FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`,
  loginPool: Object.freeze({
    role: "morrow_identity_login",
    statementTimeout: "1000",
    idleTimeout: "5000",
    begin: "BEGIN ISOLATION LEVEL READ COMMITTED",
    roleQuery:
      "SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,pg_catalog.pg_has_role(current_user,'morrow_identity_owner','MEMBER') AS owner_member,EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS role_member FROM pg_catalog.pg_roles r WHERE r.rolname=current_user",
    timeout: "SET LOCAL statement_timeout = '1s'",
    idleTimeoutQuery: "SET LOCAL idle_in_transaction_session_timeout = '5s'",
    domain:
      "SELECT matches,database_now_ms FROM morrow_identity.observe_login_flow_eligibility($1,$2)",
    arity: 2,
  }),
  preauthPool: Object.freeze({
    role: "morrow_identity_preauth",
    statementTimeout: "5000",
    idleTimeout: "10000",
    begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
    roleQuery:
      "SELECT current_user AS role, session_user AS login, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolinherit,\npg_catalog.pg_has_role(current_user, 'morrow_identity_owner', 'MEMBER') AS owner_member,\nEXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS role_member\nFROM pg_catalog.pg_roles r WHERE r.rolname=current_user",
    timeout: "SET LOCAL statement_timeout = '5s'",
    idleTimeoutQuery: "SET LOCAL idle_in_transaction_session_timeout = '10s'",
    domain:
      "SELECT outcome,admission_id FROM morrow_identity.admit_authentication_exchange($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    arity: 13,
  }),
  selectionPool: Object.freeze({
    role: "morrow_identity_resolution",
    statementTimeout: "1000",
    idleTimeout: "5000",
    begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
    roleQuery: commonRole,
    timeout: "SET LOCAL statement_timeout = '1s'",
    idleTimeoutQuery: "SET LOCAL idle_in_transaction_session_timeout = '5s'",
    domain:
      "SELECT profile_id,profile_record_revision,mapping_id,mapping_revision,binding_revision,principal_id,organization_id,workspace_id,membership_id,policy_revision FROM morrow_identity.resolve_provider_subject_selection($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    arity: 9,
  }),
  sessionPool: Object.freeze({
    role: "morrow_identity_sessions",
    statementTimeout: "1000",
    idleTimeout: "5000",
    begin: "BEGIN ISOLATION LEVEL READ COMMITTED",
    roleQuery: commonRole,
    timeout: "SET LOCAL statement_timeout = '1s'",
    idleTimeoutQuery: "SET LOCAL idle_in_transaction_session_timeout = '5s'",
    domain:
      "SELECT outcome,family_id,generation_id,provider_binding_id,expires_at_ms,audit_id FROM morrow_identity.admit_browser_family($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)",
    arity: 27,
  }),
});
export function controlledNeonExpectedScript(poolName, parameters) {
  const p = controlledNeonWireSql[poolName];
  if (
    !p?.role ||
    !Array.isArray(parameters) ||
    parameters.length !== p.arity ||
    parameters.some((v) => typeof v !== "string")
  )
    fail();
  const roleNames = [
    "role",
    "login",
    "rolsuper",
    "rolbypassrls",
    "rolcreatedb",
    "rolcreaterole",
    ...(poolName === "preauthPool" ? [] : ["rolreplication"]),
    "rolinherit",
    "owner_member",
    "role_member",
  ];
  return [
    { text: p.begin, parameters: [], fields: [], rows: [], command: "BEGIN" },
    {
      text: p.roleQuery,
      parameters: [],
      fields: roleNames.map((name) => ({
        name,
        ...(name === "role" || name === "login" ? {} : { oid: 16, size: 1 }),
      })),
      rows: [roleNames.map((name) => (name === "role" || name === "login" ? p.role : "f"))],
    },
    { text: p.timeout, parameters: [], fields: [], rows: [], command: "SET" },
    { text: p.idleTimeoutQuery, parameters: [], fields: [], rows: [], command: "SET" },
    {
      text: p.domain,
      parameters: [...parameters],
      fields: [{ name: "wire_marker" }],
      rows: [["independent_wire_result"]],
    },
    { text: "COMMIT", parameters: [], fields: [], rows: [], command: "COMMIT" },
  ];
}

// A deliberately small PostgreSQL endpoint. It proves bytes, not SQL truth.
// The real PostgreSQL bridge/lab owns SQL/RLS/backend-absence qualification.
export function createControlledNeonPgOracle({
  password,
  poolNames,
  scripts = {},
  fault = "none",
  fragmentBytes = 0,
  onEvent = () => {},
  schedule = (callback, ms) => setTimeout(callback, ms),
}) {
  if (
    typeof password !== "string" ||
    !Array.isArray(poolNames) ||
    !poolNames.length ||
    poolNames.some((name) => !controlledNeonWireSql[name]?.role)
  )
    fail();
  const allowed = new Map(
    poolNames.map((name) => [
      controlledNeonWireSql[name].role,
      {
        name,
        profile: controlledNeonWireSql[name],
        maximum: poolNames.filter((n) => n === name).length,
      },
    ]),
  );
  const sessions = [],
    catalog = new Map();
  const totals = {
    sessions: 0,
    startups: 0,
    authenticated: 0,
    primaryMetadata: 0,
    observerMetadata: 0,
    statements: 0,
    parameterQueries: 0,
    terminates: 0,
    protocolRejections: 0,
    transportClosed: 0,
    sentFrames: 0,
    sentBytes: 0,
    receivedFrames: 0,
    queryResponses: 0,
    committedResponsesWithheld: 0,
    lateOutputDiscards: 0,
  };
  function accept({ send, close }) {
    if (typeof send !== "function" || typeof close !== "function") fail();
    totals.sessions++;
    const id = 10000 + totals.sessions;
    const state = {
      id,
      role: null,
      kind: null,
      app: null,
      step: 0,
      authenticated: false,
      closed: false,
      terminated: false,
      parserHeld: false,
      metadata: false,
      scriptStep: 0,
      extended: null,
    };
    sessions.push(state);
    const emit = (data) => {
      if (state.closed) {
        totals.lateOutputDiscards++;
        return;
      }
      const dataCopy = Buffer.from(data);
      if (fragmentBytes > 0)
        for (let i = 0; i < dataCopy.length; i += fragmentBytes) {
          const frame = dataCopy.subarray(i, i + fragmentBytes);
          totals.sentFrames++;
          totals.sentBytes += frame.length;
          send(Uint8Array.from(frame));
        }
      else {
        totals.sentFrames++;
        totals.sentBytes += dataCopy.length;
        send(Uint8Array.from(dataCopy));
      }
    };
    const noRows = (command) => ({ fields: [], rows: [], command });
    const metadata = (observer) => {
      const keys = [
        "backend_pid",
        "current_role",
        "session_role",
        "database_name",
        "self_pid",
        "self_database",
        "self_role",
        "application_name",
        "backend_start",
      ];
      const values = [
        String(id),
        state.role,
        state.role,
        "morrow",
        String(id),
        "morrow",
        state.role,
        state.app,
        "2026-10-16T00:00:00.123456Z",
      ];
      if (!observer) {
        if (fault === "wrong_role") values[1] = "morrow_identity_api";
        if (fault === "wrong_database") values[3] = "foreign_database";
        if (fault === "wrong_pid") values[4] = String(id + 1);
        if (fault === "wrong_app") values[7] = "foreign_application";
        if (fault === "bad_timestamp") values[8] = "2026-02-30T00:00:00.123456Z";
        if (fault === "missing_field") {
          keys.pop();
          values.pop();
        }
      }
      if (observer) {
        if (fault === "observer_wrong_role") values[1] = "morrow_identity_api";
        if (fault === "observer_wrong_database") values[3] = "foreign_database";
        if (fault === "observer_wrong_pid") values[4] = String(id + 1);
        if (fault === "observer_wrong_app") values[7] = "foreign_application";
        if (fault === "observer_millisecond_timestamp") values[8] = "2026-10-16T00:00:00.123Z";
        if (fault === "observer_hidden_self") values[4] = null;
        if (fault === "observer_null_field") values[8] = null;
      }
      const fields = keys.map((name) => ({ name }));
      if (observer) {
        fields.push({ name: "primary_present", oid: 16, size: 1 });
        values.push(fault === "observer_primary_present" ? "t" : "f");
      }
      return {
        fields,
        rows:
          observer && fault === "observer_empty"
            ? []
            : !observer && fault === "extra_row"
              ? [values, [...values]]
              : [values],
      };
    };
    function expected(textValue, parameters) {
      if (!state.authenticated || state.terminated || state.closed) fail();
      const profile = allowed.get(state.role);
      if (!state.metadata) {
        if (state.kind === "p") {
          assert.equal(textValue, controlledNeonWireSql.primary);
          assert.deepEqual(parameters, []);
          state.metadata = true;
          totals.primaryMetadata++;
          catalog.set(state.app, {
            pid: String(id),
            start: "2026-10-16T00:00:00.123456Z",
            database: "morrow",
            role: state.role,
            app: state.app,
            alive: true,
          });
          return metadata(false);
        }
        assert.equal(textValue, controlledNeonWireSql.observer);
        assert.equal(parameters.length, 5);
        const primary = catalog.get(parameters[4]);
        assert.ok(primary);
        assert.deepEqual(parameters, [
          primary.pid,
          primary.start,
          primary.database,
          primary.role,
          primary.app,
        ]);
        assert.equal(primary.role, state.role);
        assert.equal(primary.alive, false);
        state.metadata = true;
        totals.observerMetadata++;
        return metadata(true);
      }
      if (state.kind !== "p") fail();
      const script = scripts[profile.name] ?? [];
      const item = script[state.scriptStep++];
      assert.ok(item);
      assert.equal(textValue, item.text);
      assert.deepEqual(parameters, item.parameters);
      totals.statements++;
      if (parameters.length) totals.parameterQueries++;
      onEvent("statement", { poolName: profile.name, index: state.scriptStep - 1 });
      return item;
    }
    function response(answer, extended) {
      const command = answer.command ?? "SELECT " + answer.rows.length;
      if (fault === "commit_unknown" && command === "COMMIT") {
        totals.committedResponsesWithheld++;
        return;
      }
      const output = [];
      if (!extended && answer.fields.length) output.push(pgRowDescription(answer.fields));
      output.push(...answer.rows.map(pgDataRow), pgCommand(command));
      if (!extended) output.push(pgReady(command === "BEGIN" ? "T" : "I"));
      totals.queryResponses++;
      const deliver = () => emit(Buffer.concat(output));
      if (fault === "slow_query" && state.metadata && state.scriptStep > 0) schedule(deliver, 500);
      else deliver();
    }
    const parser = createPgFrontendParser({
      onStartup({ parameters }) {
        const profile = allowed.get(parameters.user);
        assert.ok(profile);
        assert.deepEqual(
          Object.keys(parameters).sort(),
          [
            "user",
            "database",
            "application_name",
            "statement_timeout",
            "idle_in_transaction_session_timeout",
            "client_encoding",
          ].sort(),
        );
        assert.equal(parameters.database, "morrow");
        assert.equal(parameters.client_encoding, "UTF8");
        assert.equal(parameters.statement_timeout, profile.profile.statementTimeout);
        assert.equal(parameters.idle_in_transaction_session_timeout, profile.profile.idleTimeout);
        assert.match(parameters.application_name, /^morrow_id_[a-f0-9]{32}_[po]$/);
        state.kind = parameters.application_name.endsWith("_p") ? "p" : "o";
        state.role = parameters.user;
        state.app = parameters.application_name;
        assert.ok(
          sessions.filter((s) => s.role === state.role && s.kind === state.kind).length <=
            profile.maximum,
        );
        if (state.kind === "o")
          assert.ok([...catalog.values()].some((p) => p.role === state.role && !p.alive));
        totals.startups++;
        if (fault === "text_backend") {
          send("not a PostgreSQL binary message");
          return;
        }
        if (fault === "oversize_backend") {
          emit(Buffer.alloc(262145));
          return;
        }
        emit(pgAuthentication(3));
      },
      onMessage(message) {
        totals.receivedFrames++;
        if (message.type === "X" && !state.authenticated) {
          state.terminated = true;
          totals.terminates++;
          close();
          return;
        }
        if (!state.authenticated) {
          assert.equal(message.type, "p");
          assert.deepEqual(message.data, Buffer.concat([Buffer.from(password), Buffer.from([0])]));
          state.authenticated = true;
          totals.authenticated++;
          if (fault === "malformed_backend") {
            emit(Buffer.from([82, 0, 0, 0, 3]));
            return;
          }
          emit(
            Buffer.concat([
              pgAuthentication(0),
              pgParameterStatus("server_version", "17.0"),
              pgParameterStatus("client_encoding", "UTF8"),
              pgBackendKeyData(id, id + 200),
              pgReady(),
            ]),
          );
          return;
        }
        if (message.type === "X") {
          assert.equal(state.extended, null);
          state.terminated = true;
          totals.terminates++;
          if (fault !== "withheld_close") close();
          return;
        }
        if (message.type === "Q") {
          assert.equal(state.extended, null);
          const answer = expected(message.text, []);
          response(answer, false);
          return;
        }
        if (message.type === "P") {
          assert.equal(state.extended, null);
          assert.equal(message.statement, "");
          assert.deepEqual(message.parameterTypes, []);
          state.extended = { text: message.text, bound: false, described: false, executed: false };
          emit(encodePgBackendMessage("1"));
          return;
        }
        const query = state.extended;
        assert.ok(query);
        if (message.type === "B") {
          assert.equal(query.bound, false);
          assert.equal(message.portal, "");
          assert.equal(message.statement, "");
          query.answer = expected(query.text, message.parameters);
          query.bound = true;
          emit(encodePgBackendMessage("2"));
        } else if (message.type === "D") {
          assert.ok(query.bound && !query.described);
          assert.equal(message.target, "P");
          assert.equal(message.name, "");
          query.described = true;
          emit(
            query.answer.fields.length
              ? pgRowDescription(query.answer.fields)
              : encodePgBackendMessage("n"),
          );
        } else if (message.type === "E") {
          assert.ok(query.bound && query.described && !query.executed);
          assert.equal(message.portal, "");
          assert.equal(message.maximumRows, 0);
          query.executed = true;
          response(query.answer, true);
        } else if (message.type === "H") {
          // PostgreSQL Flush asks for output; it is not Sync/ReadyForQuery.
          assert.ok(query.bound && query.described && query.executed);
        } else if (message.type === "S") {
          assert.ok(query.executed);
          state.extended = null;
          emit(pgReady());
        } else fail();
      },
    });
    return Object.freeze({
      receive(data) {
        if (state.closed) fail();
        try {
          parser.push(data);
        } catch {
          state.parserHeld = true;
          totals.protocolRejections++;
          throw Error("PG_WIRE_ORACLE_REJECTED");
        }
      },
      transportClosed() {
        if (!state.closed) {
          state.closed = true;
          totals.transportClosed++;
          const primary = catalog.get(state.app);
          if (primary) primary.alive = false;
        }
      },
      snapshot() {
        return {
          ...state,
          app: undefined,
          role: state.role,
          extended: state.extended ? "pending" : null,
          parser: { ...parser.metrics },
        };
      },
    });
  }
  return Object.freeze({
    accept,
    snapshot() {
      return {
        ...totals,
        activeTransports: sessions.filter((s) => !s.closed).length,
        activePrimaryTuples: [...catalog.values()].filter((p) => p.alive).length,
        sessions: sessions.map((s) => ({
          role: s.role,
          kind: s.kind,
          metadata: s.metadata,
          authenticated: s.authenticated,
          closed: s.closed,
          terminated: s.terminated,
          scriptStep: s.scriptStep,
          parserHeld: s.parserHeld,
        })),
      };
    },
  });
}
