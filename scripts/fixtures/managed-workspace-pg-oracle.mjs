import assert from "node:assert/strict";
import {
  createPgFrontendParser,
  encodePgBackendMessage,
  pgAuthentication,
  pgBackendKeyData,
  pgCommand,
  pgDataRow,
  pgParameterStatus,
  pgReady,
  pgRowDescription,
} from "./controlled-neon-pg-wire-oracle.mjs";

// Independently literalized wire expectations, never production SQL/profile imports.
// This endpoint proves a registered byte transcript, not PostgreSQL/RLS or SCRAM.
const held = () => Error("MANAGED_WORKSPACE_PG_ORACLE_REJECTED");
const require = (value) => {
  if (!value) throw held();
};
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const freeze = (value) => Object.freeze(value);
export const managedWorkspaceWireBinding = freeze({
  schemaVersion: 1,
  environment: "staging",
  projectId: "morrow-controlled-lab",
  branchId: "br-controlled-lab",
  hostname: "ep-controlled-fixture.c-14.us-east-1.aws.neon.tech",
  database: "morrow",
});
const primaryMetadata = `SELECT pg_catalog.pg_backend_pid()::text AS backend_pid,
current_user::text AS current_role,session_user::text AS session_role,
pg_catalog.current_database()::text AS database_name,
a.pid::text AS self_pid,a.datname::text AS self_database,a.usename::text AS self_role,
a.application_name::text AS application_name,
pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start
FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`;
const observerMetadata = `SELECT pg_catalog.pg_backend_pid()::text AS backend_pid,
current_user::text AS current_role,session_user::text AS session_role,
pg_catalog.current_database()::text AS database_name,
a.pid::text AS self_pid,a.datname::text AS self_database,a.usename::text AS self_role,
a.application_name::text AS application_name,
pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,
EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity p
WHERE p.pid=$1::integer AND p.backend_start=$2::timestamptz
AND p.datname=$3::name AND p.usename=$4::name AND p.application_name=$5::text) AS primary_present
FROM pg_catalog.pg_stat_activity a WHERE a.pid=pg_catalog.pg_backend_pid()`;
const apiSql = freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
  role: "SELECT current_user AS role, session_user AS login, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, pg_catalog.pg_has_role(current_user, 'morrow_identity_owner', 'MEMBER') AS owner_member FROM pg_catalog.pg_roles WHERE rolname = current_user",
  timeout: "SET LOCAL statement_timeout = '5s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '10s'",
  bind: "SELECT pg_catalog.set_config('morrow.session_digest', $1, true) IS NOT NULL AND pg_catalog.set_config('morrow.requested_workspace', $2, true) IS NOT NULL AS configured",
  resolve:
    "SELECT principal_id, organization_id, workspace_id, membership_id, policy_revision::text FROM morrow_identity.resolved_context()",
  workspace:
    "SELECT id::text, organization_id::text, display_name FROM morrow_identity.workspaces WHERE id::text = $1",
  workspaceAuthority: `WITH context AS MATERIALIZED (SELECT * FROM morrow_identity.resolved_context())
SELECT c.principal_id, c.organization_id, c.workspace_id, c.membership_id, c.policy_revision::text,
COALESCE((SELECT jsonb_agg(g.payload ORDER BY g.id) FROM
 (SELECT id, payload FROM morrow_identity.grants
  WHERE organization_id::text=c.organization_id AND workspace_id::text=c.workspace_id
    AND membership_id::text=c.membership_id AND principal_id::text=c.principal_id
  ORDER BY id LIMIT 1001) g), '[]'::jsonb) AS grants
FROM context c JOIN morrow_identity.workspaces w ON w.id::text=c.workspace_id AND w.organization_id::text=c.organization_id`,
  commit: "COMMIT",
  rollback: "ROLLBACK",
});
const linkingSql = freeze({
  readOnlyBegin: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
  readRole: `SELECT current_user AS role, session_user AS login, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
pg_catalog.pg_has_role(current_user, 'morrow_identity_owner','MEMBER') AS owner_member,
(EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) OR (SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid)>1 OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles u ON u.oid=m.member WHERE m.roleid=r.oid AND NOT (m.grantor=10 AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option AND u.rolname NOT LIKE 'morrow\\_%' AND NOT u.rolsuper))) AS role_member,r.rolreplication
FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE",
  role: `SELECT current_user AS role, session_user AS login, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
pg_catalog.pg_has_role(current_user, 'morrow_identity_owner', 'MEMBER') AS owner_member,
(EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) OR (SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid)>1 OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles u ON u.oid=m.member WHERE m.roleid=r.oid AND NOT (m.grantor=10 AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option AND u.rolname NOT LIKE 'morrow\\_%' AND NOT u.rolsuper))) AS role_member
FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  timeout: "SET LOCAL statement_timeout = '5s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '10s'",
  lookup:
    "SELECT handoff_id,command_id,request_digest,session_digest,nonce_digest,organization_id,workspace_id,installation_id,purpose,expected_policy_revision,expected_ownership_revision FROM morrow_identity.lookup_workspace_store_link($1,$2,$3,$4)",
  status:
    "SELECT outcome,link_id,ownership_revision,policy_revision,audit_id FROM morrow_identity.workspace_store_link_status($1,$2,$3,$4)",
  apply:
    "SELECT outcome,link_id,ownership_revision,policy_revision,audit_id FROM morrow_identity.link_workspace_store($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
  commit: "COMMIT",
  rollback: "ROLLBACK",
});
const logoutSql = freeze({
  begin: "BEGIN ISOLATION LEVEL READ COMMITTED",
  role: "SELECT current_user AS role,session_user AS login,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolinherit,pg_catalog.pg_has_role(current_user,'morrow_identity_owner','MEMBER') AS owner_member,(EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) OR (SELECT count(*) FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid)>1 OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles u ON u.oid=m.member WHERE m.roleid=r.oid AND NOT (m.grantor=10 AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option AND u.rolname NOT LIKE 'morrow\\_%' AND NOT u.rolsuper))) AS role_member FROM pg_catalog.pg_roles r WHERE r.rolname=current_user",
  timeout: "SET LOCAL statement_timeout = '1s'",
  idleTimeout: "SET LOCAL idle_in_transaction_session_timeout = '5s'",
  end: "SELECT outcome,audit_id FROM morrow_identity.end_self_browser_family($1,$2,$3,$4,$5,$6,$7,$8)",
  commit: "COMMIT",
  rollback: "ROLLBACK",
});
export const managedWorkspaceWireSql = freeze({
  primary: primaryMetadata,
  observer: observerMetadata,
  identityPool: freeze({
    role: "morrow_api",
    statementTimeout: "5000",
    idleTimeout: "10000",
    statements: apiSql,
    arities: freeze({
      begin: 0,
      role: 0,
      timeout: 0,
      idleTimeout: 0,
      bind: 2,
      resolve: 0,
      workspace: 1,
      workspaceAuthority: 0,
      commit: 0,
      rollback: 0,
    }),
  }),
  linkingPool: freeze({
    role: "morrow_identity_linking",
    statementTimeout: "5000",
    idleTimeout: "10000",
    statements: linkingSql,
    arities: freeze({
      readOnlyBegin: 0,
      readRole: 0,
      begin: 0,
      role: 0,
      timeout: 0,
      idleTimeout: 0,
      lookup: 4,
      status: 4,
      apply: 11,
      commit: 0,
      rollback: 0,
    }),
  }),
  logoutPool: freeze({
    role: "morrow_identity_logout",
    statementTimeout: "1000",
    idleTimeout: "5000",
    statements: logoutSql,
    arities: freeze({
      begin: 0,
      role: 0,
      timeout: 0,
      idleTimeout: 0,
      end: 8,
      commit: 0,
      rollback: 0,
    }),
  }),
});
const poolNames = freeze(["identityPool", "linkingPool", "logoutPool"]);
const timestamp = "2026-10-17T00:00:00.123456Z";
function parameters(values, arity) {
  require(Array.isArray(values) && values.length === arity);
  require(
    values.every(
      (value) => typeof value === "string" && /^[\x01-\x7f]*$/.test(value) && value.length <= 128,
    ),
  );
  require(values.reduce((total, value) => total + value.length, 0) <= 16384);
  return freeze([...values]);
}

// Host registers exact expectations before the native client submits bytes.
// Result rows are synthetic; a successful script does not confer SQL authority.
export function managedWorkspaceExpectedScript(poolName, operations) {
  require(poolNames.includes(poolName) && Array.isArray(operations) && operations.length <= 64);
  const profile = managedWorkspaceWireSql[poolName];
  let registeredResultBytes = 0;
  return freeze(
    operations.map((operation) => {
      require(
        operation &&
          Object.keys(operation).every((key) =>
            ["statement", "parameters", "fields", "rows", "command"].includes(key),
          ),
      );
      require(Object.hasOwn(profile.statements, operation.statement));
      const fields = operation.fields ?? [],
        rows = operation.rows ?? [];
      require(
        Array.isArray(fields) && fields.length <= 32 && Array.isArray(rows) && rows.length <= 1001,
      );
      const copiedFields = freeze(
        fields.map((field) => {
          require(
            field &&
              Object.keys(field).every((key) => ["name", "oid", "size"].includes(key)) &&
              typeof field.name === "string" &&
              /^[a-z_][a-z0-9_]{0,127}$/.test(field.name),
          );
          require(field.oid === undefined || integer(field.oid, 0, 2147483647));
          require(field.size === undefined || integer(field.size, -1, 32767));
          return freeze({ ...field });
        }),
      );
      const copiedRows = freeze(
        rows.map((row) => {
          require(
            Array.isArray(row) &&
              row.length === fields.length &&
              row.every(
                (v) => v === null || (typeof v === "string" && Buffer.byteLength(v) <= 1048576),
              ),
          );
          registeredResultBytes +=
            7 +
            row.length * 4 +
            row.reduce((n, value) => n + (value === null ? 0 : Buffer.byteLength(value)), 0);
          require(registeredResultBytes <= 1048576);
          return freeze([...row]);
        }),
      );
      const defaultCommand = operation.statement.toLowerCase().includes("begin")
        ? "BEGIN"
        : ["commit", "rollback"].includes(operation.statement)
          ? operation.statement.toUpperCase()
          : ["timeout", "idleTimeout"].includes(operation.statement)
            ? "SET"
            : "SELECT " + rows.length;
      const command = operation.command ?? defaultCommand;
      require(typeof command === "string" && /^[A-Z]+(?: [0-9]+)?$/.test(command));
      return freeze({
        text: profile.statements[operation.statement],
        parameters: parameters(operation.parameters ?? [], profile.arities[operation.statement]),
        fields: copiedFields,
        rows: copiedRows,
        command,
      });
    }),
  );
}

const faults = freeze([
  "none",
  "slow_query",
  "commit_unknown",
  "wrong_role",
  "wrong_database",
  "wrong_pid",
  "wrong_app",
  "bad_timestamp",
  "missing_field",
  "extra_row",
  "observer_primary_present",
  "observer_empty",
  "observer_hidden_self",
  "observer_millisecond_timestamp",
  "observer_wrong_role",
  "observer_wrong_database",
  "observer_wrong_pid",
  "observer_wrong_app",
  "observer_null_field",
  "text_backend",
  "oversize_backend",
  "malformed_backend",
  "withheld_close",
]);
export function createManagedWorkspacePgOracle({
  password,
  poolNames: requestedPools,
  scripts = {},
  fault = "none",
  fragmentBytes = 0,
  onEvent = () => {},
  schedule = (callback, ms) => setTimeout(callback, ms),
}) {
  require(
    typeof password === "string" &&
      password.length >= 16 &&
      password.length <= 128 &&
      /^[\x21-\x7e]+$/.test(password),
  );
  require(
    Array.isArray(requestedPools) &&
      requestedPools.length > 0 &&
      requestedPools.length <= 16 &&
      requestedPools.every((name) => poolNames.includes(name)),
  );
  require(
    faults.includes(fault) &&
      integer(fragmentBytes, 0, 262144) &&
      typeof onEvent === "function" &&
      typeof schedule === "function",
  );
  require(scripts && Object.keys(scripts).every((name) => requestedPools.includes(name)));
  const expectedScripts = new Map();
  for (const name of new Set(requestedPools)) {
    const source = scripts[name] ?? [];
    require(Array.isArray(source) && source.length <= 64);
    const profile = managedWorkspaceWireSql[name];
    expectedScripts.set(
      name,
      freeze(
        source.map((item) => {
          const statement = Object.keys(profile.statements).find(
            (key) => profile.statements[key] === item.text,
          );
          require(statement !== undefined);
          return managedWorkspaceExpectedScript(name, [
            {
              statement,
              parameters: item.parameters,
              fields: item.fields,
              rows: item.rows,
              command: item.command,
            },
          ])[0];
        }),
      ),
    );
  }
  const allowed = new Map(
    [...new Set(requestedPools)].map((name) => [
      managedWorkspaceWireSql[name].role,
      {
        name,
        profile: managedWorkspaceWireSql[name],
        maximum: requestedPools.filter((pool) => pool === name).length,
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
  const accept = ({ send, close }) => {
    require(typeof send === "function" && typeof close === "function");
    require(totals.sessions < requestedPools.length * 2);
    const id = 20000 + ++totals.sessions;
    const state = {
      id,
      role: null,
      pool: null,
      kind: null,
      app: null,
      authenticated: false,
      closed: false,
      terminated: false,
      parserHeld: false,
      metadata: false,
      scriptStep: 0,
      extended: null,
      transaction: "I",
    };
    sessions.push(state);
    const emit = (input) => {
      if (state.closed) {
        totals.lateOutputDiscards++;
        return;
      }
      const bytes = Buffer.from(input);
      const width = fragmentBytes || bytes.length;
      for (let at = 0; at < bytes.length; at += width) {
        const part = bytes.subarray(at, at + width);
        totals.sentFrames++;
        totals.sentBytes += part.length;
        send(Uint8Array.from(part));
      }
    };
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
        timestamp,
      ];
      const scoped = observer ? fault.replace(/^observer_/, "") : fault;
      if (scoped === "wrong_role") values[1] = "foreign_role";
      if (scoped === "wrong_database") values[3] = "foreign_database";
      if (scoped === "wrong_pid") values[4] = String(id + 1);
      if (scoped === "wrong_app") values[7] = "foreign_application";
      if (scoped === "bad_timestamp") values[8] = "2026-02-30T00:00:00.123456Z";
      if (scoped === "missing_field") {
        keys.pop();
        values.pop();
      }
      if (observer && scoped === "millisecond_timestamp") values[8] = "2026-10-17T00:00:00.123Z";
      if (observer && scoped === "hidden_self") values[4] = null;
      if (observer && scoped === "null_field") values[8] = null;
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
    const expected = (text, values) => {
      require(state.authenticated && !state.closed && !state.terminated);
      if (!state.metadata) {
        if (state.kind === "p") {
          assert.equal(text, primaryMetadata);
          assert.deepEqual(values, []);
          state.metadata = true;
          totals.primaryMetadata++;
          catalog.set(state.app, {
            pid: String(id),
            start: timestamp,
            database: "morrow",
            role: state.role,
            app: state.app,
            alive: true,
          });
          return metadata(false);
        }
        assert.equal(text, observerMetadata);
        assert.equal(values.length, 5);
        const primary = catalog.get(values[4]);
        require(primary && primary.alive === false && primary.role === state.role);
        assert.deepEqual(values, [
          primary.pid,
          primary.start,
          primary.database,
          primary.role,
          primary.app,
        ]);
        state.metadata = true;
        totals.observerMetadata++;
        return metadata(true);
      }
      require(state.kind === "p");
      const item = expectedScripts.get(state.pool)[state.scriptStep];
      require(item);
      assert.equal(text, item.text);
      assert.deepEqual(values, item.parameters);
      state.scriptStep++;
      totals.statements++;
      if (values.length) totals.parameterQueries++;
      onEvent("statement", { poolName: state.pool, index: state.scriptStep - 1 });
      return item;
    };
    const respond = (answer, extended) => {
      const command = answer.command ?? "SELECT " + answer.rows.length;
      if (command === "BEGIN") state.transaction = "T";
      if (["COMMIT", "ROLLBACK"].includes(command)) state.transaction = "I";
      if (fault === "commit_unknown" && command === "COMMIT") {
        totals.committedResponsesWithheld++;
        return;
      }
      const packets = [];
      if (!extended && answer.fields.length) packets.push(pgRowDescription(answer.fields));
      packets.push(...answer.rows.map(pgDataRow), pgCommand(command));
      if (!extended) packets.push(pgReady(state.transaction));
      totals.queryResponses++;
      const deliver = () => {
        if (state.closed) {
          totals.lateOutputDiscards++;
          return;
        }
        if (extended) {
          extended.responseDelivered = true;
          if (extended.syncReceived) {
            packets.push(pgReady(state.transaction));
            state.extended = null;
          }
        }
        emit(Buffer.concat(packets));
      };
      if (fault === "slow_query" && state.scriptStep > 0) schedule(deliver, 500);
      else deliver();
    };
    const parser = createPgFrontendParser({
      onStartup({ parameters: start }) {
        const chosen = allowed.get(start.user);
        require(chosen);
        assert.deepEqual(
          Object.keys(start).sort(),
          [
            "user",
            "database",
            "application_name",
            "statement_timeout",
            "idle_in_transaction_session_timeout",
            "client_encoding",
          ].sort(),
        );
        assert.equal(start.database, "morrow");
        assert.equal(start.client_encoding, "UTF8");
        assert.equal(start.statement_timeout, chosen.profile.statementTimeout);
        assert.equal(start.idle_in_transaction_session_timeout, chosen.profile.idleTimeout);
        assert.match(start.application_name, /^morrow_id_[a-f0-9]{32}_[po]$/);
        require(!sessions.some((other) => other !== state && other.app === start.application_name));
        state.kind = start.application_name.endsWith("_p") ? "p" : "o";
        state.role = start.user;
        state.pool = chosen.name;
        state.app = start.application_name;
        require(
          sessions.filter((other) => other.role === state.role && other.kind === state.kind)
            .length <= chosen.maximum,
        );
        if (state.kind === "o")
          require(
            [...catalog.values()].some((primary) => primary.role === state.role && !primary.alive),
          );
        totals.startups++;
        if (fault === "text_backend") {
          send("not PostgreSQL binary data");
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
        if (message.type === "X") {
          state.terminated = true;
          totals.terminates++;
          if (fault !== "withheld_close") close();
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
              pgParameterStatus("server_version", "17.11"),
              pgParameterStatus("client_encoding", "UTF8"),
              pgBackendKeyData(id, id + 200),
              pgReady(),
            ]),
          );
          return;
        }
        if (message.type === "Q") {
          require(state.extended === null);
          respond(expected(message.text, []), null);
          return;
        }
        if (message.type === "P") {
          require(state.extended === null);
          assert.equal(message.statement, "");
          assert.deepEqual(message.parameterTypes, []);
          state.extended = {
            text: message.text,
            bound: false,
            described: false,
            executed: false,
            responseDelivered: false,
            syncReceived: false,
          };
          emit(encodePgBackendMessage("1"));
          return;
        }
        const query = state.extended;
        require(query);
        if (message.type === "B") {
          require(!query.bound);
          assert.equal(message.portal, "");
          assert.equal(message.statement, "");
          query.answer = expected(query.text, message.parameters);
          query.bound = true;
          emit(encodePgBackendMessage("2"));
        } else if (message.type === "D") {
          require(query.bound && !query.described);
          assert.equal(message.target, "P");
          assert.equal(message.name, "");
          query.described = true;
          emit(
            query.answer.fields.length
              ? pgRowDescription(query.answer.fields)
              : encodePgBackendMessage("n"),
          );
        } else if (message.type === "E") {
          require(query.bound && query.described && !query.executed);
          assert.equal(message.portal, "");
          assert.equal(message.maximumRows, 0);
          query.executed = true;
          respond(query.answer, query);
        } else if (message.type === "H") require(query.bound && query.described && query.executed);
        else if (message.type === "S") {
          require(query.executed && !query.syncReceived);
          query.syncReceived = true;
          if (query.responseDelivered) {
            state.extended = null;
            emit(pgReady(state.transaction));
          }
        } else throw held();
      },
    });
    return freeze({
      receive(data) {
        require(!state.closed && !state.terminated && !state.parserHeld);
        try {
          parser.push(data);
        } catch {
          state.parserHeld = true;
          totals.protocolRejections++;
          throw held();
        }
      },
      transportClosed() {
        if (state.closed) return;
        state.closed = true;
        totals.transportClosed++;
        const primary = catalog.get(state.app);
        if (primary) primary.alive = false;
      },
      snapshot() {
        return {
          role: state.role,
          kind: state.kind,
          authenticated: state.authenticated,
          metadata: state.metadata,
          scriptStep: state.scriptStep,
          closed: state.closed,
          terminated: state.terminated,
          parserHeld: state.parserHeld,
          parser: { ...parser.metrics },
        };
      },
    });
  };
  return freeze({
    accept,
    snapshot() {
      return {
        ...totals,
        activeTransports: sessions.filter((state) => !state.closed).length,
        activePrimaryTuples: [...catalog.values()].filter((entry) => entry.alive).length,
        sessions: sessions.map((state) => ({
          role: state.role,
          kind: state.kind,
          metadata: state.metadata,
          authenticated: state.authenticated,
          closed: state.closed,
          terminated: state.terminated,
          scriptStep: state.scriptStep,
          parserHeld: state.parserHeld,
        })),
      };
    },
  });
}
