// "Disconnect store": the workspace SPA's side of the connection routes on a fake fetch.
// Closed requests (ids and the person's reason, under the POST rules with one command key),
// closed decoders that accept exactly what the server's own handler sends (its bodies are
// produced here by the real handler over a scripted connection) and refuse anything wider,
// the outcome mapping, the fixture adapter's disconnect, and the screen's copy (what
// happens, and that reconnecting needs a new install). No browser and no network;
// lab:disconnect-store proves the server side over PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "../apps/workspace-web/src/http/client.ts";
import { createHttpPort, requests } from "../apps/workspace-web/src/http/api.ts";
import { composed, loginBodyVersion } from "../apps/workspace-web/src/http/composed.ts";
import {
  decodeDisconnectResult,
  decodeDisconnectStatus,
} from "../apps/workspace-web/src/http/disconnect-decoders.ts";
import { createFixtureAdapter } from "../apps/workspace-web/src/fixtures/adapter.ts";
import { fixtureStore, fixtureWorkspace } from "../apps/workspace-web/src/fixtures/seed.ts";
import { markerStorageKey, readMarkers } from "../apps/workspace-web/src/pending.ts";
import { portMethods } from "../packages/workspace-ui/src/port.ts";
import { copy } from "../packages/workspace-ui/src/copy.ts";
import { disconnectFields } from "../packages/policy/src/store-link-template.ts";
import { storeResource } from "../packages/policy/src/store-resource.ts";
import { createConnectionsApiHandler } from "../packages/work/src/connections/http.ts";
import { workStatements } from "../packages/work/src/sql.ts";
import { workGuardOrigin, workGuardSecret } from "./fixtures/work-guard-cases.mjs";
import { json, MemoryStorage, recordingTransport } from "./fixtures/workspace-web.mjs";

const ws = "ws-1";
const conn = "conn-1";
const key = () => randomUUID();

test("the port: two new methods, both composed over HTTP", () => {
  for (const method of ["connections.disconnectStatus", "connections.disconnect"]) {
    assert.ok(portMethods.includes(method), method);
    assert.equal(composed[method], true, method);
  }
  // Its pending marker is text-free like every other command's: a workspace, a kind, a time.
  const storage = new MemoryStorage();
  storage.setItem(
    markerStorageKey,
    JSON.stringify([
      { workspaceId: ws, kind: "disconnect", at: 1 },
      { workspaceId: ws, kind: "disconnect", at: 2, reason: "Moving stores" },
    ]),
  );
  assert.deepEqual(readMarkers(storage), [{ workspaceId: ws, kind: "disconnect", at: 1 }]);
});

test("requests: fixed paths under /workspace/:ws/connections, a closed body, refused before sending", () => {
  assert.deepEqual(requests.disconnectStatus(ws, conn), {
    method: "GET",
    path: "/workspace/ws-1/connections/conn-1/disconnect",
  });
  const k = key();
  assert.deepEqual(requests.disconnect(ws, conn, { key: k, body: { reason: "Moving stores" } }), {
    method: "POST",
    path: "/workspace/ws-1/connections/conn-1/disconnect",
    body: JSON.stringify({ control: { reason: "Moving stores", sourceProposalRef: null } }),
    key: k,
  });
  for (const built of [
    requests.disconnectStatus("a/b", conn),
    requests.disconnectStatus(ws, "a/b"),
    requests.disconnect(ws, "a/b", { key: k, body: { reason: "x" } }),
    requests.disconnect(ws, conn, { key: k, body: { reason: "   " } }),
    requests.disconnect(ws, conn, { key: k, body: { reason: "x".repeat(1025) } }),
    requests.disconnect(ws, conn, { key: k, body: { reason: "a\0b" } }),
    requests.disconnect(ws, conn, { key: "NOT-A-KEY", body: { reason: "x" } }),
  ])
    assert.equal(built, null);
});

// The server's own bodies, from the real handler over a scripted work connection.
const O = "org-1",
  S = "store-1",
  I = "inst-1";
const owner = {
  kind: "human",
  principalId: "person-1",
  organizationId: O,
  workspaceId: ws,
  membershipId: "membership-1",
  installationId: null,
  mandateId: null,
};
const grant = {
  id: "grant-1",
  principal: owner,
  capabilityId: "governance.connection.disconnect",
  verbs: ["execute"],
  scope: {
    organizationId: O,
    workspaceId: ws,
    storeIds: [S],
    accountIds: [],
    resources: [storeResource(O, ws, S, conn)],
    fields: [...disconnectFields],
  },
  issuedBy: { ...owner, kind: "service", principalId: "morrow.linking", membershipId: null },
  validFrom: "2026-10-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  policyRevision: 1,
};
async function serverBody(
  method,
  { stop = null, begin = { outcome: "new" }, status = "linked" } = {},
) {
  const names = new Map(Object.entries(workStatements).map(([name, text]) => [text, name]));
  const rows = {
    enterContext: [
      {
        principal_id: owner.principalId,
        organization_id: O,
        workspace_id: ws,
        membership_id: owner.membershipId,
        policy_revision: "1",
        grants: JSON.stringify([grant]),
        grant_count: "1",
        grants_digest: "a".repeat(64),
        database_now_us: String(Date.UTC(2026, 9, 23) * 1000),
      },
    ],
    beginConnectionCommand: [begin],
    connectionTarget: [
      { connection_id: conn, store_id: S, installation_id: I, status, database_now: "x" },
    ],
    connectionStop: stop ? [stop] : [],
    reviewContext: [
      {
        owner_principal_id: owner.principalId,
        owner_membership_id: owner.membershipId,
        active_human_membership_count: "1",
        last_membership_change_at: null,
      },
    ],
    cmdStoreDisconnect: [
      {
        outcome: "applied",
        result: JSON.stringify({
          status: "disconnected",
          killSwitchRecordId: "kill-1",
          priorStateObserved: stop ? "already_stopped" : "active",
          stopId: "stop-1",
          connectionId: conn,
          storeId: S,
          installationId: I,
          installation: "suspended",
          endReason: "disconnected",
        }),
      },
    ],
  };
  const handler = createConnectionsApiHandler({
    origin: workGuardOrigin,
    connector: {
      open: async () => ({
        async query(text) {
          return { rows: rows[names.get(text)] ?? [] };
        },
        async close() {},
      }),
    },
    now: Date.now,
    credentials: { destroy: async () => "destroyed" },
  });
  const headers = {
    Cookie: "__Host-morrow_session=" + workGuardSecret,
    "Sec-Fetch-Site": "same-origin",
  };
  if (method === "POST")
    Object.assign(headers, {
      Origin: workGuardOrigin,
      "Content-Type": "application/json",
      "X-Morrow-Request": "1",
      "Idempotency-Key": key(),
    });
  const log = console.log;
  console.log = () => {};
  try {
    const response = await handler.fetch(
      new Request(`${workGuardOrigin}/workspace/${ws}/connections/${conn}/disconnect`, {
        method,
        headers,
        body:
          method === "POST"
            ? JSON.stringify({ control: { reason: "Moving stores", sourceProposalRef: null } })
            : undefined,
      }),
      undefined,
      { waitUntil() {} },
    );
    assert.equal(response.status, 200);
    return await response.json();
  } finally {
    console.log = log;
  }
}

test("decoders: the server's own bodies decode, and nothing wider", async () => {
  const status = await serverBody("GET");
  assert.deepEqual(decodeDisconnectStatus(status, conn), {
    connectionId: conn,
    storeId: S,
    installationStatus: "linked",
    stop: null,
    actions: { disconnect: true },
  });
  const stop = {
    id: "stop-1",
    set_by_kind: "human",
    reason_code: "human_disconnect",
    created_at: "2026-10-23T10:00:00.000Z",
  };
  const stopped = await serverBody("GET", { stop, status: "suspended" });
  assert.deepEqual(decodeDisconnectStatus(stopped, conn), {
    connectionId: conn,
    storeId: S,
    installationStatus: "suspended",
    stop: { setBy: "human", reasonCode: "human_disconnect", createdAt: "2026-10-23T10:00:00.000Z" },
    actions: { disconnect: false },
  });
  const done = await serverBody("POST");
  assert.deepEqual(decodeDisconnectResult(done, conn), {
    priorStateObserved: "active",
    credential: "destroyed",
  });
  const replayed = await serverBody("POST", {
    begin: {
      outcome: "replay",
      aggregate_type: "connection",
      aggregate_id: conn,
      result: JSON.stringify({ ...done, schemaVersion: undefined, credential: undefined }),
    },
  });
  assert.equal(replayed.replayed, true);
  assert.deepEqual(decodeDisconnectResult(replayed, conn), {
    priorStateObserved: "active",
    credential: "destroyed",
  });
  // Wider or inconsistent bodies decode to null (an unconfirmed read, an uncertain command).
  for (const bad of [
    { ...status, schemaVersion: 2 },
    { ...status, connectionId: "conn-2" },
    { ...status, token: "x" },
    { ...status, installationStatus: "unlinked" },
    { ...status, actions: { disconnect: "yes" } },
    { ...status, actions: { disconnect: true, enable: true } },
    { ...stopped, actions: { disconnect: true } },
    { ...stopped, stop: { ...stopped.stop, reason: "Moving stores" } },
    { ...stopped, stop: { ...stopped.stop, setBy: "agent" } },
    { ...stopped, stop: { ...stopped.stop, createdAt: "yesterday" } },
    null,
    [],
  ])
    assert.equal(decodeDisconnectStatus(bad, conn), null, JSON.stringify(bad));
  for (const bad of [
    { ...done, credential: "erased" },
    { ...done, status: "linked" },
    { ...done, connectionId: "conn-2" },
    { ...done, reason: "Moving stores" },
    { ...done, replayed: false },
    { ...done, priorStateObserved: "unknown" },
    { ...done, stopId: 7 },
  ])
    assert.equal(decodeDisconnectResult(bad, conn), null, JSON.stringify(bad));
});

test("HTTP port: one keyed POST under the POST rules; refusals send nothing; envelopes map", async () => {
  const replies = [];
  const recorded = recordingTransport(() => replies.shift());
  const port = createHttpPort({
    client: createClient({ transport: recorded.transport, online: () => true }),
    composed,
    loginBodyVersion,
    navigationSignal: () => undefined,
  });
  replies.push(json(200, await serverBody("POST")));
  const k = key();
  assert.deepEqual(
    await port.connections.disconnect(ws, conn, { key: k, body: { reason: "Moving stores" } }),
    {
      kind: "ok",
      value: { priorStateObserved: "active", credential: "destroyed" },
      replayed: false,
    },
  );
  const post = recorded.calls[0];
  assert.equal(post.path, "/workspace/ws-1/connections/conn-1/disconnect");
  assert.equal(post.init.method, "POST");
  const h = new Headers(post.init.headers);
  assert.equal(h.get("Idempotency-Key"), k);
  assert.equal(h.get("X-Morrow-Request"), "1");
  assert.equal(h.get("Content-Type"), "application/json");
  assert.equal(post.init.credentials, "same-origin");
  assert.equal(post.init.redirect, "error");
  // A refused request sends nothing and is terminal (invalid), never uncertain.
  const before = recorded.calls.length;
  assert.deepEqual(
    await port.connections.disconnect(ws, conn, { key: key(), body: { reason: " " } }),
    {
      kind: "invalid",
      field: null,
    },
  );
  assert.equal(recorded.calls.length, before);
  const envelope = (status, code, retryClass, safeMessage) =>
    json(status, {
      schemaVersion: 1,
      code,
      retryClass,
      safeMessage,
      correlationId: "c-1",
      operationId: null,
      retryAfterSeconds: null,
      inputRequestIds: [],
    });
  replies.push(envelope(403, "denied", "never", "This operation is not permitted."));
  assert.equal(
    (await port.connections.disconnect(ws, conn, { key: key(), body: { reason: "x" } })).kind,
    "denied",
  );
  // An undecodable 2xx is uncertain for a command, never success.
  replies.push(json(200, { schemaVersion: 1, surprise: true }));
  assert.equal(
    (await port.connections.disconnect(ws, conn, { key: key(), body: { reason: "x" } })).kind,
    "uncertain",
  );
  replies.push(json(200, await serverBody("GET")));
  const read = await port.connections.disconnectStatus(ws, conn);
  assert.equal(read.kind, "ok");
  assert.equal(read.value.actions.disconnect, true);
  assert.equal(recorded.calls.at(-1).init.method, "GET");
});

test("the fixture adapter: disconnect once, then the stop stands and a repeat is already_stopped", async () => {
  const port = createFixtureAdapter("ready");
  const W = fixtureWorkspace.id;
  const C = fixtureStore.connectionId;
  const linked = (await port.connections.list(W)).value.installations.find(
    (i) => i.connectionId === C,
  );
  assert.equal(linked?.status, "linked");
  const status = await port.connections.disconnectStatus(W, C);
  assert.equal(status.value.actions.disconnect, true);
  const c = { key: key(), body: { reason: "Moving stores" } };
  const first = await port.connections.disconnect(W, C, c);
  assert.deepEqual(first.value, { priorStateObserved: "active", credential: "destroyed" });
  assert.equal((await port.connections.disconnect(W, C, c)).replayed, true);
  const after = await port.connections.disconnectStatus(W, C);
  assert.equal(after.value.stop.setBy, "human");
  assert.equal(after.value.installationStatus, "suspended");
  assert.equal(after.value.actions.disconnect, false);
  assert.equal(
    (await port.connections.disconnect(W, C, { key: key(), body: { reason: "Again" } })).value
      .priorStateObserved,
    "already_stopped",
  );
  // No AI work runs on the store any more.
  assert.equal((await port.agents.listingsStatus(W, fixtureStore.storeId)).value.blocked, true);
});

test("copy: what a disconnect does, and that reconnecting needs a new install", () => {
  const d = copy.connections.disconnect;
  assert.equal(d.button, "Disconnect store");
  const said = [d.intro, ...d.dialogBody].join(" ");
  for (const fact of ["Stops all AI work", "access token", "uninstall"])
    assert.ok(said.includes(fact), fact);
  assert.ok(d.reconnectNote.includes("new install"));
  assert.ok(d.reconnectNote.includes("can't undo"));
  assert.ok(d.credential.pending.includes("already disconnected"));
  assert.ok(!("disconnectLater" in copy.connections));
  assert.equal(copy.reentry.kinds.disconnect, "disconnecting a store");
});
