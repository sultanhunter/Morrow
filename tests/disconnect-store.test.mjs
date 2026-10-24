// "Disconnect store" (ADR-0022 items 2, 3, 13 and 15 with the amendments of 2026-10-22,
// owner decision 8; ADR-0005): the pure target step and its KillSwitchRecord
// (packages/work/src/stops.ts), the connection routes in Node over a scripted work
// connection (packages/work/src/connections/http.ts), the api Worker's dispatch row and the
// api's broker adapter for the token's destruction. Every guard and body refusal is decided
// before any SQL connection opens; a passing command runs the session's authority, the
// replay check, the connection's target, the human kernel (governance.connection.disconnect
// {execute} on the store resource) and the kill-switch target check, then the one definer;
// the token's destruction follows COMMIT and never undoes the disconnect.
// lab:disconnect-store runs the same handler against PostgreSQL 17 (the backfill, the
// definer, the stop's effect on every read, run and operation lease, the broker's vault
// destruction and the connector's re-drive).
import assert from "node:assert/strict";
import test from "node:test";
import { createBrokerCredentialDestroyer } from "../apps/api/src/broker-client.ts";
import { apiDispatch } from "../apps/api/src/worker.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { KillSwitchBoundaryError } from "../packages/policy/src/kill-switch.ts";
import { disconnectFields } from "../packages/policy/src/store-link-template.ts";
import { storeResource } from "../packages/policy/src/store-resource.ts";
import { connectionRequestDigest } from "../packages/work/src/connections/commands.ts";
import {
  connectionRoutes,
  connectionsPathPattern,
  createConnectionsApiHandler,
} from "../packages/work/src/connections/http.ts";
import { connectionStatements } from "../packages/work/src/connections/sql.ts";
import { canonicalJson, sha256Hex } from "../packages/work/src/digest.ts";
import { workStatements } from "../packages/work/src/sql.ts";
import {
  StopBoundaryError,
  disconnectRecord,
  planDisconnect,
  stopReasonCodes,
} from "../packages/work/src/stops.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import { workGuardOrigin, workGuardSecret } from "./fixtures/work-guard-cases.mjs";

// ---------------------------------------------------------------------------
// The target step and the record.
const tenant = { organizationId: "org_a", workspaceId: "workspace_a" };
const actor = {
  kind: "human",
  principalId: "human_owner",
  ...tenant,
  membershipId: "membership_owner",
  installationId: null,
  mandateId: null,
};
const target = (id, change = {}) => ({
  kind: "connection",
  id,
  ...tenant,
  storeId: "store_a",
  connectionId: id,
  revision: null,
  digest: null,
  ...change,
});
const facts = (change = {}) => ({
  ...tenant,
  records: [
    target("connection_a"),
    target("connection_storeless", { storeId: null }),
    target("connection_ungranted", { storeId: "store_b" }),
    target("connection_foreign", { organizationId: "org_b", workspaceId: "workspace_b" }),
    target("connection_misnamed", { connectionId: "connection_other" }),
  ],
  grants: [
    { storeIds: ["store_a"], connectionIds: ["connection_a", "connection_misnamed"] },
    { storeIds: [], connectionIds: [] },
  ],
  sourceProposal: null,
  ownership: {
    ownerPrincipalId: "human_owner",
    ownerMembershipId: "membership_owner",
    activeHumanMembershipCount: 1,
    lastMembershipChangeAt: null,
  },
  ...change,
});
const disconnect = (connectionId, reason = "The store is moving to a new owner.") => ({
  capabilityId: "governance.connection.disconnect",
  input: { connectionId, control: { reason, sourceProposalRef: null } },
});
const command = (change = {}) => ({
  id: "kill_1",
  createdAt: "2026-10-23T10:00:00.000Z",
  commandId: "command_1",
  requestDigest: "a".repeat(64),
  priorStateObserved: "active",
  ...change,
});

test("planDisconnect: the kill-switch target check, then one connection stop by a person", () => {
  const result = planDisconnect(actor, disconnect("connection_a"), facts());
  assert.equal(result.allowed, true);
  assert.deepEqual(result.plan, {
    scope: "connection",
    ...tenant,
    storeId: "store_a",
    targetId: "connection_a",
    setBy: { kind: "human", principalId: "human_owner", membershipId: "membership_owner" },
    reasonCode: "human_disconnect",
    reason: "The store is moving to a new owner.",
  });
  assert.equal(stopReasonCodes.disconnect, "human_disconnect");
  // The record's one target is the connection itself, on its store.
  assert.deepEqual(result.targets, [
    {
      ...tenant,
      storeId: "store_a",
      connectionId: "connection_a",
      kind: "connection",
      id: "connection_a",
    },
  ]);
  assert.ok(validateCurrentDefinition("KillSwitchConnectionTarget", result.targets[0]));
  const record = disconnectRecord(actor, disconnect("connection_a"), result, command());
  assert.ok(validateCurrentDefinition("KillSwitchRecord", record));
  assert.equal(record.capabilityId, "governance.connection.disconnect");
  assert.equal(record.storeId, "store_a");
  assert.deepEqual(record.actor, actor);
  assert.deepEqual(record.control, {
    reason: "The store is moving to a new owner.",
    sourceProposalRef: null,
  });
  const again = disconnectRecord(
    actor,
    disconnect("connection_a"),
    result,
    command({ priorStateObserved: "already_stopped" }),
  );
  assert.equal(again.priorStateObserved, "already_stopped");
  // A malformed command value is refused, never recorded.
  for (const change of [{ createdAt: "yesterday" }, { requestDigest: "x" }, { id: "" }])
    assert.throws(
      () => disconnectRecord(actor, disconnect("connection_a"), result, command(change)),
      StopBoundaryError,
    );
  // "Stop AI work"'s request is not this record's.
  assert.throws(
    () =>
      disconnectRecord(
        actor,
        {
          capabilityId: "agents.installation.disable",
          input: { installationId: "i", control: { reason: "x", sourceProposalRef: null } },
        },
        result,
        command(),
      ),
    StopBoundaryError,
  );
});

test("planDisconnect: unknown, foreign, ungranted, storeless and misnamed connections get one denial", () => {
  for (const id of [
    "connection_absent",
    "connection_foreign",
    "connection_ungranted",
    "connection_storeless",
    "connection_misnamed",
  ])
    assert.deepEqual(
      planDisconnect(actor, disconnect(id), facts()),
      {
        allowed: false,
        code: "TARGET_NOT_FOUND",
        category: "denied",
        retry: "never",
        safeMessage: "The requested target is not available.",
      },
      id,
    );
  // With no current execute grant, nothing is a target.
  assert.equal(
    planDisconnect(actor, disconnect("connection_a"), facts({ grants: [] })).allowed,
    false,
  );
});

test("planDisconnect: only a human member of the tenant, only for this kill switch", () => {
  for (const who of [
    { ...actor, kind: "agent" },
    { ...actor, installationId: "installation_listings" },
    { ...actor, organizationId: "org_b" },
    { ...actor, workspaceId: "workspace_b" },
    { ...actor, membershipId: null },
  ])
    assert.throws(
      () => planDisconnect(who, disconnect("connection_a"), facts()),
      (e) => e instanceof StopBoundaryError && e.code === "STOP_INPUT_INVALID",
    );
  assert.throws(
    () =>
      planDisconnect(
        actor,
        {
          capabilityId: "agents.installation.disable",
          input: { installationId: "i", control: { reason: "x", sourceProposalRef: null } },
        },
        facts(),
      ),
    StopBoundaryError,
  );
  // The kill-switch library's own boundary still applies (a blank reason).
  assert.throws(
    () => planDisconnect(actor, disconnect("connection_a", " "), facts()),
    KillSwitchBoundaryError,
  );
});

test("KillSwitchRecord v1.1: a connection target names the connection; v1 targets keep the store rule", () => {
  const result = planDisconnect(actor, disconnect("connection_a"), facts());
  const record = disconnectRecord(actor, disconnect("connection_a"), result, command());
  const withTarget = (t) => ({ ...record, targets: [t] });
  // The schema admits the target; the code rule requires id === connectionId.
  const misnamed = { ...record.targets[0], id: "connection_b" };
  assert.ok(validateDefinition("core-v1.1", "KillSwitchRecord", withTarget(misnamed)));
  assert.equal(validateCurrentDefinition("KillSwitchRecord", withTarget(misnamed)), false);
  // A connection target needs its store and connection (never storeless).
  for (const change of [{ storeId: null }, { connectionId: null }, { extra: 1 }])
    assert.equal(
      validateCurrentDefinition(
        "KillSwitchRecord",
        withTarget({ ...record.targets[0], ...change }),
      ),
      false,
      JSON.stringify(change),
    );
  // A v1 ResourceRef target ("Stop AI work"'s installation) is unchanged; v1 has no store
  // kind, so a store resource is not a record target.
  const installation = {
    ...tenant,
    storeId: "store_a",
    connectionId: "connection_a",
    kind: "installation",
    id: "installation_a",
  };
  assert.ok(validateCurrentDefinition("KillSwitchRecord", withTarget(installation)));
  const store = storeResource("org_a", "workspace_a", "store_a", "connection_a");
  assert.equal(validateCurrentDefinition("KillSwitchRecord", withTarget(store)), false);
  // It is a record target only: never a grant or scope resource.
  assert.equal(validateCurrentDefinition("ResourceRef", record.targets[0]), false);
});

// ---------------------------------------------------------------------------
// The routes.
const ctx = { waitUntil() {} };
const O = "org_o",
  W = "ws_w",
  S = "store_a",
  C = "connection_a",
  I = "storeinst_a";
const path = (connectionId = C) => `/workspace/${W}/connections/${connectionId}/disconnect`;
const key = "0b6f2c1e-5d4a-4f8e-9c3b-2a1d0e9f8c7b";
const body = (reason = "The store is moving to a new owner.") =>
  JSON.stringify({ control: { reason, sourceProposalRef: null } });
const headersFor = (method, overrides = {}) => {
  const h = {
    Cookie: "__Host-morrow_session=" + workGuardSecret,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
  };
  if (method !== "GET")
    Object.assign(h, {
      Origin: workGuardOrigin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      "Idempotency-Key": key,
    });
  Object.assign(h, overrides);
  for (const [name, value] of Object.entries(h)) if (value === null) delete h[name];
  return h;
};
const request = (method, p = path(), overrides = {}, b = method === "GET" ? undefined : body()) =>
  new Request(workGuardOrigin + p, { method, headers: headersFor(method, overrides), body: b });
const owner = {
  kind: "human",
  principalId: "person_a",
  organizationId: O,
  workspaceId: W,
  membershipId: "membership_a",
  installationId: null,
  mandateId: null,
};
const disconnectGrant = (overrides = {}) => ({
  id: "grant_disconnect",
  principal: owner,
  capabilityId: "governance.connection.disconnect",
  verbs: ["execute"],
  scope: {
    organizationId: O,
    workspaceId: W,
    storeIds: [S],
    accountIds: [],
    resources: [storeResource(O, W, S, C)],
    fields: [...disconnectFields],
  },
  issuedBy: { ...owner, kind: "service", principalId: "morrow.linking", membershipId: null },
  validFrom: "2026-10-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  policyRevision: 1,
  ...overrides,
});
const appliedResult = (change = {}) => ({
  status: "disconnected",
  killSwitchRecordId: "kill_1",
  priorStateObserved: "active",
  stopId: "stop_1",
  connectionId: C,
  storeId: S,
  installationId: I,
  installation: "suspended",
  endReason: "disconnected",
  ...change,
});
// A scripted work connection, recording every statement name and its values.
function scripted({
  grants = [disconnectGrant()],
  begin = { outcome: "new", aggregate_type: null, aggregate_id: null, result: null },
  targetRow = {
    connection_id: C,
    store_id: S,
    installation_id: I,
    status: "linked",
    database_now: "2026-10-23T00:00:00.000Z",
  },
  stop = null,
  cmd = () => ({ outcome: "applied", result: JSON.stringify(appliedResult()) }),
} = {}) {
  const sent = [];
  const names = new Map(Object.entries(workStatements).map(([name, text]) => [text, name]));
  let opens = 0;
  const connection = {
    async query(text, values) {
      const name = names.get(text) ?? text;
      sent.push([name, values]);
      if (name === "enterContext")
        return {
          rows: [
            {
              principal_id: owner.principalId,
              organization_id: O,
              workspace_id: W,
              membership_id: owner.membershipId,
              policy_revision: "1",
              grants: JSON.stringify(grants),
              grant_count: String(grants.length),
              grants_digest: "a".repeat(64),
              database_now_us: String(Date.UTC(2026, 9, 23) * 1000),
            },
          ],
        };
      if (name === "beginConnectionCommand") return { rows: [begin] };
      if (name === "connectionTarget") return { rows: targetRow ? [targetRow] : [] };
      if (name === "connectionStop") return { rows: stop ? [stop] : [] };
      if (name === "reviewContext")
        return {
          rows: [
            {
              owner_principal_id: owner.principalId,
              owner_membership_id: owner.membershipId,
              active_human_membership_count: "1",
              last_membership_change_at: null,
            },
          ],
        };
      if (name === "cmdStoreDisconnect") {
        const reply = cmd(values);
        if (reply instanceof Error) throw reply;
        return { rows: [reply] };
      }
      return { rows: [] };
    },
    async close() {},
  };
  return {
    sent,
    names: () => sent.map(([name]) => name),
    opens: () => opens,
    connector: {
      open: async () => {
        opens++;
        return connection;
      },
    },
  };
}
const destroyer = (reply = "destroyed") => {
  const calls = [];
  return {
    calls,
    credentials: {
      async destroy(installationId) {
        calls.push(installationId);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
};
const handlerOf = (db, credentials) =>
  createConnectionsApiHandler({
    origin: workGuardOrigin,
    connector: db.connector,
    now: Date.now,
    credentials,
  });
const quiet = async (t, run) => {
  const lines = [];
  t.mock.method(console, "log", (line) => lines.push(String(line)));
  const result = await run();
  return { result, lines };
};
async function envelope(response, status, name) {
  assert.equal(response.status, status, name);
  const json = await response.json();
  assert.ok(validateDefinition("core", "ErrorEnvelope", json), name);
  assert.equal(response.headers.has("set-cookie"), false, name);
  assert.equal(response.headers.get("cache-control"), "no-store", name);
  return json;
}

test("the route table and dispatch: exactly /connections/:connectionId/disconnect, GET and POST", () => {
  assert.deepEqual(
    connectionRoutes.map((r) => [r.method, r.pattern, r.path, [...r.query], r.op]),
    [
      [
        "GET",
        "/:connectionId/disconnect",
        "/connections/:connectionId/disconnect",
        [],
        "connection.disconnect_status",
      ],
      [
        "POST",
        "/:connectionId/disconnect",
        "/connections/:connectionId/disconnect",
        [],
        "connection.disconnect",
      ],
    ],
  );
  assert.equal(apiDispatch(path()), "connections");
  // Every other /connections path stays the managed workspace handler's.
  for (const other of [
    `/workspace/${W}/connections`,
    `/workspace/${W}/connections/${C}`,
    `/workspace/${W}/connections/${C}/disconnect/x`,
    `/workspace/${W}/connections//disconnect`,
  ])
    assert.equal(apiDispatch(other), "workspace", other);
  assert.ok(!connectionsPathPattern.test(`/workspace/${W}/work/goals`));
  // The statements are fixed, parameter-only and part of the one statement table.
  for (const [name, text] of Object.entries(connectionStatements)) {
    assert.equal(workStatements[name], text, name);
    assert.doesNotMatch(text, /\$\{|;/, name);
  }
});

test("guard and body refusals are decided before any SQL connection opens; unbound is 401", async (t) => {
  const db = scripted();
  const handler = handlerOf(db, destroyer().credentials);
  const cases = [
    ["put", request("PUT"), 405],
    ["no_cookie", request("POST", path(), { Cookie: null }), 401],
    ["foreign_origin", request("POST", path(), { Origin: "https://evil.example.test" }), 403],
    ["cross_site", request("POST", path(), { "Sec-Fetch-Site": "cross-site" }), 403],
    ["no_custom_header", request("POST", path(), { "X-Morrow-Request": null }), 403],
    ["no_key", request("POST", path(), { "Idempotency-Key": null }), 400],
    ["bad_connection", request("POST", `/workspace/${W}/connections/%20/disconnect`), 400],
    ["query", request("GET", path() + "?x=1"), 400],
    ["blank_reason", request("POST", path(), {}, body(" ")), 400],
    ["long_reason", request("POST", path(), {}, body("x".repeat(1025))), 400],
    [
      "source_proposal",
      request(
        "POST",
        path(),
        {},
        JSON.stringify({ control: { reason: "x", sourceProposalRef: { id: "p" } } }),
      ),
      400,
    ],
    [
      "tenant_in_body",
      request(
        "POST",
        path(),
        {},
        JSON.stringify({ control: { reason: "x", sourceProposalRef: null }, connectionId: C }),
      ),
      400,
    ],
    ["not_json", request("POST", path(), {}, "{"), 400],
  ];
  await quiet(t, async () => {
    for (const [name, req, status] of cases)
      await envelope(await handler.fetch(req, undefined, ctx), status, name);
  });
  assert.equal(db.opens(), 0);
  const { result } = await quiet(t, () =>
    createConnectionsApiHandler().fetch(request("POST"), undefined, ctx),
  );
  await envelope(result, 401, "unbound");
  assert.throws(
    () =>
      createConnectionsApiHandler({
        origin: workGuardOrigin,
        connector: db.connector,
        now: Date.now,
        credentials: {},
      }),
    /CONNECTIONS_API_CONFIGURATION_INVALID/,
  );
});

test("a disconnect: kernel, target check, one definer, then the token after COMMIT", async (t) => {
  const db = scripted();
  const d = destroyer();
  const { result, lines } = await quiet(t, () =>
    handlerOf(db, d.credentials).fetch(request("POST"), undefined, ctx),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    schemaVersion: 1,
    ...appliedResult(),
    credential: "destroyed",
  });
  assert.deepEqual(db.names(), [
    "prologueReadWrite",
    "enterContext",
    "beginConnectionCommand",
    "connectionTarget",
    "reviewContext",
    "connectionStop",
    "cmdStoreDisconnect",
    "commit",
  ]);
  const digest = await connectionRequestDigest("connection.disconnect", W, C, JSON.parse(body()));
  assert.deepEqual(db.sent[2][1], ["connection.disconnect", key, digest]);
  assert.deepEqual(db.sent[3][1], [C]);
  assert.deepEqual(db.sent[4][1], ["governance.connection.disconnect", null]);
  // The definer receives the command, the path's connection and the exact record.
  const [commandId, requestDigest, correlationId, connectionId, canonical, recordDigest] =
    db.sent[6][1];
  assert.equal(commandId, key);
  assert.equal(requestDigest, digest);
  assert.match(correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(connectionId, C);
  assert.equal(recordDigest, await sha256Hex(canonical));
  const record = JSON.parse(canonical);
  assert.equal(canonicalJson(record), canonical);
  assert.ok(validateCurrentDefinition("KillSwitchRecord", record));
  assert.equal(record.capabilityId, "governance.connection.disconnect");
  assert.deepEqual(record.targets, [
    { organizationId: O, workspaceId: W, storeId: S, connectionId: C, kind: "connection", id: C },
  ]);
  assert.equal(record.priorStateObserved, "active");
  assert.equal(record.commandId, key);
  assert.equal(record.requestDigest, digest);
  // The token: once, for the disconnected installation, after COMMIT.
  assert.deepEqual(d.calls, [I]);
  // One fixed log line: route and outcome, never the reason.
  assert.equal(lines.length, 1);
  const log = JSON.parse(lines[0]);
  assert.equal(log.event, "morrow_connections");
  assert.equal(log.route, "POST /connections/:connectionId/disconnect");
  assert.equal(log.outcome, "applied_credential_destroyed");
  assert.ok(!lines[0].includes("new owner"));
});

test("the token: anything but a confirmed destruction is pending, and the disconnect stands", async (t) => {
  for (const [name, d, result, expected] of [
    ["already", destroyer("already_destroyed"), appliedResult(), ["destroyed", 1]],
    ["ineligible", destroyer("ineligible"), appliedResult(), ["pending", 1]],
    ["not_found", destroyer("not_found"), appliedResult(), ["pending", 1]],
    ["broker_held", destroyer(Error("API_BROKER_HELD")), appliedResult(), ["pending", 1]],
    ["no_broker", { calls: [], credentials: null }, appliedResult(), ["pending", 0]],
    // An installation that ended another way first is that end's to destroy.
    [
      "uninstalled_first",
      destroyer(),
      appliedResult({ installation: "uninstalled", endReason: "uninstalled" }),
      ["pending", 0],
    ],
  ]) {
    const db = scripted({ cmd: () => ({ outcome: "applied", result: JSON.stringify(result) }) });
    const { result: response } = await quiet(t, () =>
      handlerOf(db, d.credentials).fetch(request("POST"), undefined, ctx),
    );
    assert.equal(response.status, 200, name);
    const json = await response.json();
    assert.equal(json.status, "disconnected", name);
    assert.equal(json.credential, expected[0], name);
    assert.equal(d.calls.length, expected[1], name);
    assert.equal(db.names().at(-1), "commit", name);
  }
});

test("only a holder of the capability on this connection disconnects; a denial writes nothing", async (t) => {
  const now = Date.UTC(2026, 9, 23);
  for (const [name, grants] of [
    ["no_grant", []],
    ["revoked", [disconnectGrant({ revokedAt: "2026-10-02T00:00:00.000Z" })]],
    ["expired", [disconnectGrant({ expiresAt: new Date(now - 1000).toISOString() })]],
    [
      "other_connection",
      [
        disconnectGrant({
          scope: {
            ...disconnectGrant().scope,
            resources: [storeResource(O, W, S, "connection_b")],
          },
        }),
      ],
    ],
    [
      "no_control_field",
      [disconnectGrant({ scope: { ...disconnectGrant().scope, fields: ["connectionId"] } })],
    ],
    ["stop_ai_work_only", [disconnectGrant({ capabilityId: "agents.installation.disable" })]],
  ]) {
    const db = scripted({ grants });
    const d = destroyer();
    const { result } = await quiet(t, () =>
      handlerOf(db, d.credentials).fetch(request("POST"), undefined, ctx),
    );
    await envelope(result, 403, name);
    assert.ok(!db.names().includes("cmdStoreDisconnect"), name);
    assert.ok(!db.names().includes("commit"), name);
    assert.equal(d.calls.length, 0, name);
  }
  // An unknown connection, another tenant's or one never linked here: 404, nothing written.
  const db = scripted({ targetRow: null });
  const { result } = await quiet(t, () =>
    handlerOf(db, destroyer().credentials).fetch(request("POST"), undefined, ctx),
  );
  await envelope(result, 404, "not_found");
  assert.ok(!db.names().includes("cmdStoreDisconnect"));
});

test("idempotent: a replay returns the recorded result and asks the broker again; a repeat is already_stopped", async (t) => {
  const recorded = appliedResult();
  const db = scripted({
    begin: {
      outcome: "replay",
      aggregate_type: "connection",
      aggregate_id: C,
      result: JSON.stringify(recorded),
    },
  });
  const d = destroyer("already_destroyed");
  const { result } = await quiet(t, () =>
    handlerOf(db, d.credentials).fetch(request("POST"), undefined, ctx),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    schemaVersion: 1,
    ...recorded,
    replayed: true,
    credential: "destroyed",
  });
  assert.deepEqual(db.names(), [
    "prologueReadWrite",
    "enterContext",
    "beginConnectionCommand",
    "rollback",
  ]);
  assert.deepEqual(d.calls, [I]);
  // The same key with another body is a conflict and changes nothing.
  const conflicting = scripted({ begin: { outcome: "conflict" } });
  const { result: conflict } = await quiet(t, () =>
    handlerOf(conflicting, destroyer().credentials).fetch(request("POST"), undefined, ctx),
  );
  await envelope(conflict, 409, "command_conflict");
  // A new disconnect of a stopped connection records the person's KillSwitchRecord as
  // already_stopped (the stop that stands, whoever set it).
  const stopped = scripted({
    stop: {
      id: "stop_1",
      set_by_kind: "system",
      reason_code: "shopify_app_uninstalled",
      created_at: "2026-10-22T00:00:00.000Z",
    },
    cmd: (values) => {
      assert.equal(JSON.parse(values[4]).priorStateObserved, "already_stopped");
      return {
        outcome: "applied",
        result: JSON.stringify(appliedResult({ priorStateObserved: "already_stopped" })),
      };
    },
  });
  const { result: again } = await quiet(t, () =>
    handlerOf(stopped, destroyer().credentials).fetch(request("POST"), undefined, ctx),
  );
  assert.equal((await again.json()).priorStateObserved, "already_stopped");
});

test("definer refusals roll back; an unknown outcome is uncertain and never success", async (t) => {
  for (const [outcome, status] of [
    ["state_conflict", 409],
    ["stale_authority", 409],
    ["command_conflict", 409],
    ["not_found", 404],
    ["invalid", 400],
    ["ineligible", 401],
    ["something_else", 503],
  ]) {
    const db = scripted({ cmd: () => ({ outcome, result: null }) });
    const d = destroyer();
    const { result } = await quiet(t, () =>
      handlerOf(db, d.credentials).fetch(request("POST"), undefined, ctx),
    );
    await envelope(result, status, outcome);
    assert.equal(db.names().at(-1), "rollback", outcome);
    assert.equal(d.calls.length, 0, outcome);
  }
  // The definer's reply is lost: the outcome is unknown, never reported as done.
  const lost = scripted({ cmd: () => Error("connection reset") });
  const d = destroyer();
  const { result } = await quiet(t, () =>
    handlerOf(lost, d.credentials).fetch(request("POST"), undefined, ctx),
  );
  const json = await envelope(result, 503, "uncertain");
  assert.equal(json.code, "uncertain");
  assert.equal(d.calls.length, 0);
});

test("the status read: who may disconnect, and the stop that stands", async (t) => {
  const read = async (options) => {
    const db = scripted(options);
    const { result } = await quiet(t, () =>
      handlerOf(db, destroyer().credentials).fetch(request("GET"), undefined, ctx),
    );
    return { db, status: result.status, json: await result.json() };
  };
  const holder = await read();
  assert.equal(holder.status, 200);
  assert.deepEqual(holder.json, {
    schemaVersion: 1,
    connectionId: C,
    storeId: S,
    installationStatus: "linked",
    stop: null,
    actions: { disconnect: true },
  });
  assert.deepEqual(holder.db.names(), [
    "prologueReadOnly",
    "enterContext",
    "connectionTarget",
    "connectionStop",
    "commit",
  ]);
  assert.equal((await read({ grants: [] })).json.actions.disconnect, false);
  const stopped = await read({
    stop: {
      id: "stop_1",
      set_by_kind: "human",
      reason_code: "human_disconnect",
      created_at: "2026-10-23T00:00:00.000Z",
    },
  });
  assert.deepEqual(stopped.json.stop, {
    setBy: "human",
    reasonCode: "human_disconnect",
    createdAt: "2026-10-23T00:00:00.000Z",
  });
  assert.equal(stopped.json.actions.disconnect, false);
  const suspended = await read({
    targetRow: {
      connection_id: C,
      store_id: S,
      installation_id: I,
      status: "suspended",
      database_now: "2026-10-23T00:00:00.000Z",
    },
  });
  assert.equal(suspended.json.actions.disconnect, false);
  assert.equal((await read({ targetRow: null })).status, 404);
  // A row outside the fixed shape is 503, never a guess.
  const odd = await read({
    targetRow: {
      connection_id: C,
      store_id: S,
      installation_id: I,
      status: "unlinked",
      database_now: "x",
    },
  });
  assert.equal(odd.status, 503);
});

test("the api's broker adapter: closed input, the decoded closed result, never a retry", async () => {
  const calls = [];
  const broker = {
    async shopifyCredentialDestroy(...args) {
      calls.push(args);
      return JSON.stringify({ schemaVersion: 1, outcome: "destroyed" });
    },
  };
  const adapter = createBrokerCredentialDestroyer(broker);
  assert.equal(await adapter.destroy(I, new AbortController().signal), "destroyed");
  // The reason is the broker's to fix: the api passes the installation alone.
  assert.deepEqual(calls, [[I]]);
  for (const bad of ["", " x", "a/b", "x".repeat(129), null])
    await assert.rejects(adapter.destroy(bad, new AbortController().signal), /API_BROKER_HELD/);
  assert.equal(calls.length, 1);
  const odd = createBrokerCredentialDestroyer({
    async shopifyCredentialDestroy() {
      return JSON.stringify({ schemaVersion: 1, outcome: "destroyed", token: "x" });
    },
  });
  await assert.rejects(odd.destroy(I, new AbortController().signal));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(adapter.destroy(I, aborted.signal), /API_BROKER_HELD/);
});
