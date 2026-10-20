// M3 PR-1: the workspace SPA's side of the agents routes on a fake fetch. Closed requests
// (ids, the stop reason, opaque model keys, PUT under the POST rules), closed decoders
// that accept exactly what the server sends (the server's own read bodies are decoded
// here) and refuse anything wider (a document granting execute on publish, a provider
// model string), the outcome mapping, and the fixture adapter's Enable, Stop and resume
// flow and model default. No browser and no network; lab:listings-authority proves the
// server side over PostgreSQL 17.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "../apps/workspace-web/src/http/client.ts";
import { createHttpPort, requests } from "../apps/workspace-web/src/http/api.ts";
import { composed, loginBodyVersion } from "../apps/workspace-web/src/http/composed.ts";
import {
  decodeListingsChange,
  decodeListingsDocument,
  decodeListingsStatus,
  decodeModelDefaultRevised,
  decodeModels,
} from "../apps/workspace-web/src/http/agents-decoders.ts";
import { createFixtureAdapter } from "../apps/workspace-web/src/fixtures/adapter.ts";
import { fixtureStore, fixtureWorkspace } from "../apps/workspace-web/src/fixtures/seed.ts";
import { createPending } from "../apps/workspace-web/src/pending.ts";
import { portMethods } from "../packages/workspace-ui/src/port.ts";
import { copy } from "../packages/workspace-ui/src/copy.ts";
import { runAgentRead } from "../packages/work/src/agents/commands.ts";
import { buildInstallationDocument } from "../packages/work/src/agents/listings.ts";
import { storeResource } from "../packages/policy/src/store-resource.ts";
import { json, MemoryStorage, recordingTransport } from "./fixtures/workspace-web.mjs";

const ws = "ws-1";
const store = "store-1";
const key = () => randomUUID();
const hex = (c) => c.repeat(64);

test("the port: six new methods, all composed over HTTP", () => {
  for (const method of [
    "agents.listingsStatus",
    "agents.listingsDocument",
    "agents.listingsEnable",
    "agents.listingsStop",
    "models.list",
    "models.reviseDefault",
  ]) {
    assert.ok(portMethods.includes(method), method);
    assert.equal(composed[method], true, method);
  }
});

test("requests: fixed paths under /workspace/:ws, closed bodies, refused before sending", () => {
  assert.deepEqual(requests.listingsStatus(ws, store), {
    method: "GET",
    path: "/workspace/ws-1/stores/store-1/agents/listings",
  });
  const k = key();
  assert.deepEqual(requests.listingsDocument(ws, store, { key: k, body: {} }), {
    method: "POST",
    path: "/workspace/ws-1/stores/store-1/agents/listings/document",
    body: "{}",
    key: k,
  });
  assert.deepEqual(
    requests.listingsEnable(ws, store, {
      key: k,
      body: { documentDigest: hex("a"), nonce: hex("b") },
    }),
    {
      method: "POST",
      path: "/workspace/ws-1/stores/store-1/agents/listings",
      body: JSON.stringify({ documentDigest: hex("a"), nonce: hex("b") }),
      key: k,
    },
  );
  assert.deepEqual(requests.listingsStop(ws, store, { key: k, body: { reason: "Pause it" } }), {
    method: "POST",
    path: "/workspace/ws-1/stores/store-1/agents/listings/stop",
    body: JSON.stringify({ control: { reason: "Pause it", sourceProposalRef: null } }),
    key: k,
  });
  assert.deepEqual(requests.models(ws), { method: "GET", path: "/workspace/ws-1/models" });
  const revise = {
    model: "claude_opus_5_5",
    effort: "high",
    maxCreditsPerProduct: 6,
    expectedRevision: null,
  };
  assert.deepEqual(requests.reviseModelDefault(ws, { key: k, body: revise }), {
    method: "PUT",
    path: "/workspace/ws-1/settings/model-default",
    body: JSON.stringify(revise),
    key: k,
  });
  // Refused before sending: bad ids, a body with keys, a short digest, a blank or long
  // reason, a provider model string, a ceiling out of range, a non-revision.
  for (const refused of [
    requests.listingsStatus("bad id", store),
    requests.listingsStatus(ws, "store/../x"),
    requests.listingsDocument(ws, store, { key: k, body: { installationId: "x" } }),
    requests.listingsEnable(ws, store, { key: k, body: { documentDigest: "a", nonce: hex("b") } }),
    requests.listingsStop(ws, store, { key: k, body: { reason: "   " } }),
    requests.listingsStop(ws, store, { key: k, body: { reason: "x".repeat(1025) } }),
    requests.listingsStop(ws, store, { key: k, body: { reason: "a\0b" } }),
    requests.reviseModelDefault(ws, { key: k, body: { ...revise, model: "claude-opus-5-5" } }),
    requests.reviseModelDefault(ws, { key: k, body: { ...revise, effort: "High" } }),
    requests.reviseModelDefault(ws, { key: k, body: { ...revise, maxCreditsPerProduct: 0 } }),
    requests.reviseModelDefault(ws, { key: k, body: { ...revise, maxCreditsPerProduct: 100 } }),
    requests.reviseModelDefault(ws, { key: k, body: { ...revise, expectedRevision: 0 } }),
    requests.reviseModelDefault(ws, { key: "NOT-A-KEY", body: revise }),
  ])
    assert.equal(refused, null);
});

// The server's own bodies, from its read functions over a scripted transaction.
const O = "org_o",
  W = "ws_w",
  S = "store_a";
const owner = {
  kind: "human",
  principalId: "person_owner",
  organizationId: O,
  workspaceId: W,
  membershipId: "membership_owner",
  installationId: null,
  mandateId: null,
};
function serverRead(read, replies) {
  const tx = {
    async run(name) {
      const reply = replies[name];
      return reply ?? [];
    },
    markSubmitted() {},
    rollbackOnly() {},
  };
  return runAgentRead(
    tx,
    {
      route: { method: "GET", pattern: "", query: [] },
      workspaceId: W,
      params: read === "listings.status" ? { storeId: S } : {},
      query: new Map(),
      sessionDigest: "d".repeat(64),
      commandId: null,
      body: null,
    },
    read,
  );
}
const contextRow = {
  principal_id: owner.principalId,
  organization_id: O,
  workspace_id: W,
  membership_id: owner.membershipId,
  policy_revision: "1",
  grants: "[]",
  grant_count: "0",
  grants_digest: "e".repeat(64),
  database_now_us: String(Date.parse("2026-10-20T12:00:00.000Z") * 1000),
};

test("decoders accept the server's own bodies exactly", async () => {
  const models = await serverRead("models.list", { enterContext: [contextRow] });
  const decoded = decodeModels({ schemaVersion: 1, ...models.body });
  assert.equal(decoded?.catalogueVersion, 1);
  assert.equal(decoded.entries.length, 9);
  assert.deepEqual(decoded.workspaceDefault, { model: "claude_sonnet_5_5", effort: "low" });
  assert.equal(decoded.canRevise, false);
  const status = await serverRead("listings.status", {
    enterContext: [contextRow],
    storeAssociation: [{ store_id: S, connection_id: "c", database_now: "x" }],
  });
  assert.deepEqual(decodeListingsStatus({ schemaVersion: 1, ...status.body }, S), {
    storeId: S,
    linked: true,
    installation: null,
    actions: { enable: false, resume: false, stop: false },
  });
  // The document the server builds (step 1 reply shape).
  const built = await buildInstallationDocument({
    id: randomUUID(),
    purpose: "enable",
    store: storeResource(O, W, S, "connection_a"),
    installationId: "installation_a",
    actor: owner,
    createdAtMs: Date.parse("2026-10-20T12:00:00.000Z"),
  });
  const reply = {
    schemaVersion: 1,
    documentId: built.document.id,
    documentDigest: built.digest,
    installationId: "installation_a",
    purpose: "enable",
    expiresAt: built.document.expiresAt,
    document: built.document,
    nonce: hex("c"),
  };
  const document = decodeListingsDocument(JSON.parse(JSON.stringify(reply)), S);
  assert.deepEqual(document, {
    documentDigest: built.digest,
    nonce: hex("c"),
    purpose: "enable",
    installationId: "installation_a",
    expiresAt: "2026-10-20T12:05:00.000Z",
    releaseRevision: 1,
    grants: [
      { capabilityId: "catalog.content.propose", verbs: ["execute"] },
      { capabilityId: "catalog.content.publish", verbs: ["propose"] },
      { capabilityId: "catalog.products.read", verbs: ["view"] },
    ],
    fields: ["descriptionHtml", "seo.description", "seo.title", "tags", "title"],
  });
  // Every capability and field the document names has a label.
  for (const g of document.grants) assert.ok(copy.agents.capabilities[g.capabilityId]);
  for (const f of document.fields) assert.ok(copy.agents.fieldLabels[f]);
  for (const e of decoded.entries) {
    assert.ok(copy.models.labels[e.model], e.model);
    assert.ok(copy.models.labels[e.effort], e.effort);
  }
  // Anything wider or different is refused.
  const widened = JSON.parse(JSON.stringify(reply));
  widened.document.grants[1].verbs = ["propose", "execute"];
  const otherStore = JSON.parse(JSON.stringify(reply));
  otherStore.document.store.storeId = "store_b";
  const otherField = JSON.parse(JSON.stringify(reply));
  otherField.document.grants[0].scope.fields = ["vendor"];
  for (const bad of [
    widened,
    otherStore,
    otherField,
    { ...reply, nonce: "x" },
    { ...reply, extra: 1 },
  ])
    assert.equal(decodeListingsDocument(bad, S), null);
  const modelsBody = { schemaVersion: 1, ...models.body };
  for (const bad of [
    { ...modelsBody, entries: [{ ...modelsBody.entries[0], model: "claude-opus-5-5" }] },
    { ...modelsBody, workspaceDefault: { model: "claude_opus_9", effort: "low" } },
    { ...modelsBody, ceiling: 0 },
    { ...modelsBody, price: "0.01" },
  ])
    assert.equal(decodeModels(bad), null);
  for (const bad of [
    { ...status.body, schemaVersion: 1, storeId: "store_b" },
    { schemaVersion: 1, ...status.body, actions: { enable: true, resume: false, stop: true } },
    { schemaVersion: 1, ...status.body, extra: true },
  ])
    assert.equal(decodeListingsStatus(bad, S), null);
  assert.deepEqual(
    decodeListingsChange({
      schemaVersion: 1,
      installationId: "i",
      status: "disabled",
      revision: 2,
      priorStateObserved: "active",
    }),
    { installationId: "i", status: "disabled", revision: 2 },
  );
  assert.equal(
    decodeListingsChange({ schemaVersion: 1, installationId: "i", status: "deleted", revision: 2 }),
    null,
  );
  assert.deepEqual(decodeModelDefaultRevised({ schemaVersion: 1, revision: 3, model: "x" }), {
    revision: 3,
  });
  assert.equal(decodeModelDefaultRevised({ schemaVersion: 1, revision: 0 }), null);
});

test("the HTTP port: reads, PUT under the POST rules, and the outcome mapping", async () => {
  const replies = [];
  const recorded = recordingTransport(() => replies.shift());
  const port = createHttpPort({
    client: createClient({ transport: recorded.transport, online: () => true }),
    composed,
    loginBodyVersion,
    navigationSignal: () => undefined,
  });
  replies.push(
    json(200, {
      schemaVersion: 1,
      storeId: store,
      linked: true,
      installation: null,
      actions: { enable: true, resume: false, stop: false },
    }),
  );
  const status = await port.agents.listingsStatus(ws, store);
  assert.equal(status.kind, "ok");
  assert.equal(recorded.calls[0].init.method, "GET");
  replies.push(
    json(200, { schemaVersion: 1, revision: 1, model: "m", effort: "e", maxCreditsPerProduct: 1 }),
  );
  const k = key();
  const saved = await port.models.reviseDefault(ws, {
    key: k,
    body: {
      model: "claude_sonnet_5_5",
      effort: "low",
      maxCreditsPerProduct: 1,
      expectedRevision: null,
    },
  });
  assert.deepEqual(saved, { kind: "ok", value: { revision: 1 }, replayed: false });
  const put = recorded.calls[1];
  assert.equal(put.path, "/workspace/ws-1/settings/model-default");
  assert.equal(put.init.method, "PUT");
  const h = new Headers(put.init.headers);
  assert.equal(h.get("Idempotency-Key"), k);
  assert.equal(h.get("X-Morrow-Request"), "1");
  assert.equal(h.get("Content-Type"), "application/json");
  assert.equal(put.init.credentials, "same-origin");
  // A refused request sends nothing and is terminal (invalid), never uncertain.
  const before = recorded.calls.length;
  assert.deepEqual(
    await port.agents.listingsStop(ws, store, { key: key(), body: { reason: " " } }),
    {
      kind: "invalid",
      field: null,
    },
  );
  assert.equal(recorded.calls.length, before);
  // Envelopes map to the fixed outcomes; an undecodable 2xx is uncertain for a command.
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
  replies.push(
    envelope(409, "conflict", "recheck_before_retry", "A precondition for this change is not met."),
  );
  const conflict = await port.agents.listingsEnable(ws, store, {
    key: key(),
    body: { documentDigest: hex("a"), nonce: hex("b") },
  });
  assert.equal(conflict.kind, "conflict");
  replies.push(envelope(403, "denied", "never", "This operation is not permitted."));
  assert.equal(
    (await port.agents.listingsDocument(ws, store, { key: key(), body: {} })).kind,
    "denied",
  );
  // A replayed document has no nonce (returned once): a terminal conflict, never uncertain.
  replies.push(
    json(200, { schemaVersion: 1, documentDigest: hex("a"), nonce: null, replayed: true }),
  );
  assert.equal(
    (await port.agents.listingsDocument(ws, store, { key: key(), body: {} })).kind,
    "conflict",
  );
  replies.push(json(200, { schemaVersion: 1, surprise: true }));
  assert.equal(
    (await port.agents.listingsStop(ws, store, { key: key(), body: { reason: "Pause" } })).kind,
    "uncertain",
  );
});

test("the fixture adapter: enable through the document, stop, resume, and the model default", async () => {
  const port = createFixtureAdapter("ready");
  const W = fixtureWorkspace.id;
  const S = fixtureStore.id;
  const status = await port.agents.listingsStatus(W, S);
  assert.equal(status.value.actions.enable, true);
  const doc = await port.agents.listingsDocument(W, S, { key: key(), body: {} });
  assert.equal(doc.kind, "ok");
  assert.equal(doc.value.purpose, "enable");
  // The wrong nonce is a conflict; the document's own enables once.
  const wrong = await port.agents.listingsEnable(W, S, {
    key: key(),
    body: { documentDigest: doc.value.documentDigest, nonce: hex("0") },
  });
  assert.equal(wrong.kind, "conflict");
  const confirm = {
    key: key(),
    body: { documentDigest: doc.value.documentDigest, nonce: doc.value.nonce },
  };
  const enabled = await port.agents.listingsEnable(W, S, confirm);
  assert.equal(enabled.value.status, "active");
  assert.equal((await port.agents.listingsEnable(W, S, confirm)).replayed, true);
  assert.equal(
    (await port.agents.listingsEnable(W, S, { ...confirm, key: key() })).kind,
    "conflict",
  );
  const stopped = await port.agents.listingsStop(W, S, { key: key(), body: { reason: "Pause" } });
  assert.equal(stopped.value.status, "disabled");
  const after = await port.agents.listingsStatus(W, S);
  assert.equal(after.value.installation.stopped, true);
  assert.equal(after.value.actions.resume, true);
  const resumeDoc = await port.agents.listingsDocument(W, S, { key: key(), body: {} });
  assert.equal(resumeDoc.value.purpose, "resume");
  const resumed = await port.agents.listingsEnable(W, S, {
    key: key(),
    body: { documentDigest: resumeDoc.value.documentDigest, nonce: resumeDoc.value.nonce },
  });
  assert.equal(resumed.value.status, "active");
  // The model default: first revision from null, a stale one conflicts, a ceiling below
  // the default's credits is invalid.
  const models = await port.models.list(W);
  assert.equal(models.value.revision, null);
  assert.equal(
    (
      await port.models.reviseDefault(W, {
        key: key(),
        body: {
          model: "claude_opus_5_5",
          effort: "high",
          maxCreditsPerProduct: 5,
          expectedRevision: null,
        },
      })
    ).kind,
    "invalid",
  );
  const first = await port.models.reviseDefault(W, {
    key: key(),
    body: {
      model: "claude_opus_5_5",
      effort: "high",
      maxCreditsPerProduct: 6,
      expectedRevision: null,
    },
  });
  assert.deepEqual(first.value, { revision: 1 });
  assert.equal(
    (
      await port.models.reviseDefault(W, {
        key: key(),
        body: {
          model: "claude_sonnet_5_5",
          effort: "low",
          maxCreditsPerProduct: 1,
          expectedRevision: null,
        },
      })
    ).kind,
    "conflict",
  );
  const raised = await port.models.list(W);
  assert.equal(raised.value.ceiling, 6);
  assert.ok(raised.value.entries.every((e) => e.allowedForMember));
});

test("re-entry markers know the agent and model-default commands", () => {
  const pending = createPending(new MemoryStorage());
  for (const kind of ["agent", "model_default"]) {
    const marker = pending.addMarker(ws, kind);
    assert.equal(marker.kind, kind);
    assert.ok(copy.reentry.kinds[kind]);
  }
});
