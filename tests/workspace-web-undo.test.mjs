// v1 PR 4: the workspace SPA's side of Undo, the history's undo state, "Approve several at
// once" and the product picker, on fakes. Closed requests (an empty undo body; the batch
// document sent back exactly with the typed phrase; the catalogue's closed query parameters),
// closed decoders that accept exactly the server's shapes, the fixture adapter's flows, the
// picker's list helpers, and the history's undo line rendered as text. lab:catalog-undo
// decodes the server's real replies with the same decoders.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { requests } from "../apps/workspace-web/src/http/api.ts";
import { composed } from "../apps/workspace-web/src/http/composed.ts";
import {
  decodeBatchDecided,
  decodeBatchDocument,
  decodeOperationsOfTask,
  decodeReview,
  decodeUndoRequested,
} from "../apps/workspace-web/src/http/review-decoders.ts";
import {
  decodeCatalogCollections,
  decodeCatalogProducts,
} from "../apps/workspace-web/src/http/catalog-decoders.ts";
import { createFixtureAdapter } from "../apps/workspace-web/src/fixtures/adapter.ts";
import { fixtureStore, fixtureWorkspace } from "../apps/workspace-web/src/fixtures/seed.ts";
import { portMethods } from "../packages/workspace-ui/src/port.ts";
import { copy } from "../packages/workspace-ui/src/copy.ts";
import { UndoLine } from "../packages/workspace-ui/src/screens/review.tsx";
import {
  listedProducts,
  normaliseSearch,
  withProduct,
  withoutProduct,
} from "../packages/workspace-ui/src/screens/product-picker.tsx";
import { ServicesProvider } from "../packages/workspace-ui/src/services.tsx";
import { lazyScreen } from "../packages/workspace-ui/src/screens/lazy.tsx";
import { readdirSync, readFileSync } from "node:fs";
import { inspectLazyChunks, lazyModules } from "../scripts/workspace-web-checks.mjs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
const ws = "ws-1";
const hex = (c) => c.repeat(64);
const opId = "00000000-0000-4000-8000-0000000000a1";
const operation = (over = {}) => ({
  operationId: opId,
  taskId: "task_root",
  storeId: "store_a",
  proposalId: "proposal_1",
  productId: "product:7",
  targetIndex: 0,
  status: "verified",
  reason: "readback_matched",
  uncertaintyReason: null,
  verdict: "approved",
  attempt: 1,
  sendStartedAt: "2026-10-23T10:00:00.000Z",
  submittedAt: "2026-10-23T10:00:01.000Z",
  createdAt: "2026-10-23T09:59:59.000Z",
  updatedAt: "2026-10-23T10:00:02.000Z",
  ...over,
});
const undo = (over = {}) => ({
  operationId: opId,
  state: "available",
  availableUntil: "2027-01-21T10:00:00.000Z",
  undoProposalId: null,
  undoOfOperationId: null,
  ...over,
});
const ref = (kind, id) => ({
  organizationId: "org_o",
  workspaceId: "ws_w",
  storeId: kind === "proposal" ? "store_a" : null,
  kind,
  id,
  revision: 1,
  digest: hex("a"),
});

test("the port: Undo, the batch and the picker's reads are port methods, composed over HTTP", () => {
  for (const method of [
    "review.undo",
    "review.batch",
    "review.decideBatch",
    "catalog.products",
    "catalog.collections",
  ]) {
    assert.ok(portMethods.includes(method), method);
    assert.equal(composed[method], true, method);
  }
});

test("requests: an empty undo, the batch document sent back exactly, the catalogue's closed query", () => {
  const k = randomUUID();
  assert.deepEqual(requests.undo(ws, opId, { key: k, body: {} }), {
    method: "POST",
    path: "/workspace/ws-1/work/operations/" + opId + "/undo",
    body: "{}",
    key: k,
  });
  assert.equal(requests.undo(ws, opId, { key: k, body: { set: { title: "x" } } }), null);
  assert.equal(requests.undo(ws, "not-an-operation", { key: k, body: {} }), null);
  assert.equal(requests.undo(ws, opId, { key: "NOT-A-KEY", body: {} }), null);
  assert.deepEqual(requests.batch(ws, "proposal_1"), {
    method: "GET",
    path: "/workspace/ws-1/work/proposals/proposal_1/batch",
  });
  const item = (n) => ({
    proposalId: "proposal_" + n,
    digest: hex(String(n)),
    approvalId: "approval_" + n,
    revision: 1,
  });
  const body = {
    documentDigest: hex("d"),
    issuedAt: "2026-10-24T10:00:00.000Z",
    soloOwnerConfirmation: "approve 2 changes for 2 credits",
    items: [item(1), item(2)],
  };
  assert.deepEqual(requests.decideBatch(ws, "proposal_1", { key: k, body }), {
    method: "POST",
    path: "/workspace/ws-1/work/proposals/proposal_1/batch-decision",
    body: JSON.stringify(body),
    key: k,
  });
  for (const bad of [
    { ...body, items: [item(1)] },
    { ...body, items: [item(1), item(1)] },
    { ...body, documentDigest: "x" },
    { ...body, issuedAt: "today" },
    { ...body, soloOwnerConfirmation: "" },
    { ...body, items: [item(1), { ...item(2), revision: 0 }] },
  ])
    assert.equal(requests.decideBatch(ws, "proposal_1", { key: k, body: bad }), null);
  // The picker: a search of letters and digits, or one collection, never both.
  assert.deepEqual(
    requests.catalogProducts(ws, "store_a", { after: null, collectionId: null, query: "linen 2" }),
    { method: "GET", path: "/workspace/ws-1/stores/store_a/catalog/products?query=linen%202" },
  );
  assert.deepEqual(
    requests.catalogProducts(ws, "store_a", {
      after: "abc=",
      collectionId: "collection:21",
      query: null,
    }),
    {
      method: "GET",
      path: "/workspace/ws-1/stores/store_a/catalog/products?after=abc%3D&collectionId=collection%3A21",
    },
  );
  assert.deepEqual(requests.catalogCollections(ws, "store_a", null), {
    method: "GET",
    path: "/workspace/ws-1/stores/store_a/catalog/collections",
  });
  for (const q of [
    { after: null, collectionId: "collection:21", query: "linen" },
    { after: null, collectionId: null, query: "title:*" },
    { after: null, collectionId: null, query: "a  b" },
    { after: null, collectionId: null, query: "a b c d e f" },
    { after: null, collectionId: "product:1", query: null },
    { after: "not a cursor", collectionId: null, query: null },
  ])
    assert.equal(requests.catalogProducts(ws, "store_a", q), null, JSON.stringify(q));
  assert.equal(
    requests.catalogProducts(ws, "../x", { after: null, collectionId: null, query: null }),
    null,
  );
});

test("decoders: the history's undo states, the undo, the batch and the picker, exactly", () => {
  const history = decodeOperationsOfTask(
    { schemaVersion: 1, operations: [operation()], undo: [undo()] },
    "task_root",
  );
  assert.deepEqual(history?.[0].undo, {
    state: "available",
    availableUntil: "2027-01-21T10:00:00.000Z",
    undoProposalId: null,
    undoOfOperationId: null,
  });
  for (const wider of [
    { schemaVersion: 1, operations: [operation()] },
    { schemaVersion: 1, operations: [operation()], undo: [] },
    { schemaVersion: 1, operations: [operation()], undo: [undo({ operationId: "other" })] },
    { schemaVersion: 1, operations: [operation()], undo: [undo({ state: "maybe" })] },
    { schemaVersion: 1, operations: [operation()], undo: [undo({ availableUntil: null })] },
    {
      schemaVersion: 1,
      operations: [operation()],
      undo: [undo({ state: "undone" })], // undone with an until is not a server shape
    },
    { schemaVersion: 1, operations: [operation()], undo: [{ ...undo(), before: "Linen" }] },
  ])
    assert.equal(decodeOperationsOfTask(wider, "task_root"), null, JSON.stringify(wider.undo));
  const requested = {
    schemaVersion: 1,
    outcome: "applied",
    proposalId: "proposal_undo",
    proposalDigest: hex("e"),
    approvalId: "approval_undo",
    status: "pending",
    expiresAt: "2026-10-27T10:00:00.000Z",
    operationId: opId,
  };
  assert.equal(decodeUndoRequested(requested, opId)?.proposalId, "proposal_undo");
  assert.equal(decodeUndoRequested({ ...requested, outcome: "replayed" }, opId)?.status, "pending");
  assert.equal(decodeUndoRequested(requested, "other"), null);
  assert.equal(decodeUndoRequested({ ...requested, set: {} }, opId), null);
  // The review of an undo names the change it undoes.
  const review = decodeReview(
    {
      schemaVersion: 1,
      proposal: {
        id: "proposal_undo",
        digest: hex("e"),
        storeId: "store_a",
        taskId: "task_root",
        capabilityId: "catalog.content.publish",
        risk: "external",
        targetCount: 1,
        expiresAt: "2026-10-26T10:00:00.000Z",
        contextTaint: "tainted",
        partialApproval: "allowed",
        derivedFromId: null,
        selectedTargetIndexes: null,
      },
      proposalRef: { ...ref("proposal", "proposal_undo"), digest: hex("e") },
      approval: null,
      approvalRef: null,
      viewerRole: "reviewer",
      actionable: true,
      blocked: null,
      confirmation: { required: false, phrase: "approve 1 change for 0 credits" },
      products: [],
      claim: null,
      undoOf: {
        operationId: opId,
        proposalId: "proposal_1",
        productId: "product:7",
        appliedAt: "2026-10-23T10:00:00.000Z",
      },
    },
    "proposal_undo",
  );
  assert.equal(review?.undoOf?.operationId, opId);
  const item = (n) => ({
    proposalId: "proposal_" + n,
    digest: hex(String(n)),
    approvalId: "approval_" + n,
    revision: 1,
    targetCount: 2,
    expiresAt: "2026-10-26T10:00:00.000Z",
  });
  const document = {
    schemaVersion: 1,
    proposalId: "proposal_1",
    taskId: "task_root",
    storeId: "store_a",
    items: [item(1), item(2)],
    unavailable: null,
    confirmation: { required: true, phrase: "approve 4 changes for 4 credits" },
    issuedAt: "2026-10-24T10:00:00.000Z",
    expiresAt: "2026-10-24T10:05:00.000Z",
    documentDigest: hex("d"),
  };
  assert.equal(
    decodeBatchDocument(document, "proposal_1")?.confirmation.phrase,
    document.confirmation.phrase,
  );
  assert.ok(
    decodeBatchDocument(
      { ...document, confirmation: { required: false, phrase: null } },
      "proposal_1",
    ),
  );
  assert.ok(
    decodeBatchDocument(
      {
        ...document,
        items: [item(1)],
        unavailable: "too_few",
        confirmation: { required: true, phrase: null },
      },
      "proposal_1",
    ),
  );
  for (const wider of [
    { ...document, extra: 1 },
    { ...document, unavailable: "too_few" },
    { ...document, items: [item(1)] },
    { ...document, items: [item(1), item(1)] },
    { ...document, confirmation: { required: true, phrase: null } },
    { ...document, confirmation: { required: false, phrase: "approve 4 changes for 4 credits" } },
    { ...document, confirmation: { required: true, phrase: "approve <b>4</b>" } },
    { ...document, unavailable: "mixed_confirmation" },
    { ...document, items: [item(1), { ...item(2), title: "Linen" }] },
  ])
    assert.equal(
      decodeBatchDocument(wider, "proposal_1"),
      null,
      JSON.stringify(wider).slice(0, 90),
    );
  assert.ok(
    decodeBatchDocument(
      {
        ...document,
        unavailable: "mixed_confirmation",
        confirmation: { required: true, phrase: null },
      },
      "proposal_1",
    ),
  );
  assert.equal(decodeBatchDocument(document, "proposal_9"), null);
  const decided = {
    schemaVersion: 1,
    outcome: "applied",
    decided: [1, 2].map((n) => ({
      proposalRef: ref("proposal", "proposal_" + n),
      approvalRef: ref("approval", "approval_" + n),
      status: "approved",
      expiresAt: "2026-10-26T10:00:00.000Z",
    })),
  };
  assert.equal(decodeBatchDecided(decided)?.decided.length, 2);
  assert.equal(decodeBatchDecided({ ...decided, decided: decided.decided.slice(0, 1) }), null);
  assert.equal(decodeBatchDecided({ ...decided, outcome: "refused" }), null);
  // The picker: ids, titles and status only, of exactly the store asked.
  const products = {
    schemaVersion: 1,
    storeId: "store_a",
    products: [{ id: "product:7", title: "<b>Linen</b>", status: "active" }],
    nextCursor: "abc=",
  };
  assert.deepEqual(decodeCatalogProducts(products, "store_a"), {
    items: [{ id: "product:7", title: "<b>Linen</b>", status: "active" }],
    nextCursor: "abc=",
  });
  for (const wider of [
    { ...products, storeId: "store_b" },
    { ...products, products: [{ id: "product:7", title: "x", status: "active", vendor: "y" }] },
    { ...products, products: [{ id: "gid://shopify/Product/7", title: "x", status: "active" }] },
    { ...products, nextCursor: "not a cursor" },
    { ...products, extra: 1 },
  ])
    assert.equal(decodeCatalogProducts(wider, "store_a"), null);
  assert.equal(
    decodeCatalogCollections(
      {
        schemaVersion: 1,
        storeId: "store_a",
        collections: [{ id: "collection:21", title: "Summer" }],
        nextCursor: null,
      },
      "store_a",
    )?.items[0].title,
    "Summer",
  );
});

test("the picker adds and removes product numbers in the list, once each", () => {
  assert.equal(normaliseSearch("  linen   shirt "), "linen shirt");
  assert.equal(normaliseSearch(""), "");
  assert.equal(normaliseSearch("title:*"), null);
  assert.equal(normaliseSearch("a b c d e f"), null);
  assert.equal(normaliseSearch("x".repeat(65)), null);
  assert.equal(normaliseSearch("Größe 42"), "Größe 42");
  assert.equal(withProduct("", "product:7"), "7");
  assert.equal(withProduct("11\nproduct:12", "product:7"), "11\nproduct:12\n7");
  assert.equal(withProduct("product:7", "product:7"), "product:7");
  assert.equal(withProduct("7", "collection:7"), "7");
  assert.equal(withoutProduct("11\nproduct:7\n12", "product:7"), "11\n12");
  assert.equal(withoutProduct("7\n7", "product:7"), "");
  assert.deepEqual(listedProducts("11\n\nproduct:12\nnot one\n11"), ["product:11", "product:12"]);
});

test("fixture: Undo makes a new change back, which is approved and applied like any other", async () => {
  const port = createFixtureAdapter("ready");
  const id = fixtureWorkspace.id;
  const k = () => randomUUID();
  const review = await port.review.get(id, "proposal-sample-1", null);
  assert.equal(review.kind, "ok");
  const decided = await port.review.decide(id, "proposal-sample-1", {
    key: k(),
    body: {
      decision: "approve",
      selectedTargetIndexes: null,
      expectedDecisionDigest: review.value.proposal.digest,
      soloOwnerConfirmation: null,
      expectedRevision: 1,
    },
  });
  assert.equal(decided.kind, "ok");
  const applied = await port.review.apply(id, "proposal-sample-1", {
    key: k(),
    body: { proposalRef: decided.value.proposalRef, approvalRef: decided.value.approvalRef },
  });
  assert.equal(applied.kind, "ok");
  const taskId = review.value.proposal.taskId;
  const history = await port.review.operationsOfTask(id, taskId);
  assert.deepEqual(
    history.value.map((o) => o.undo.state),
    ["available", "available"],
  );
  const first = history.value[0];
  const made = await port.review.undo(id, first.operationId, { key: k(), body: {} });
  assert.equal(made.kind, "ok");
  // The undo is its own review: the change's "proposed" values are now "now", and back.
  const undoReview = await port.review.get(id, made.value.proposalId, null);
  assert.equal(undoReview.kind, "ok");
  assert.equal(undoReview.value.undoOf.operationId, first.operationId);
  assert.equal(undoReview.value.products.length, 1);
  const titles = review.value.products[0].changes[0];
  assert.deepEqual(undoReview.value.products[0].changes[0], {
    field: "title",
    before: titles.after,
    after: titles.before,
  });
  // A second undo while one waits is refused.
  const again = await port.review.undo(id, first.operationId, { key: k(), body: {} });
  assert.equal(again.kind, "conflict");
  const waiting = await port.review.operationsOfTask(id, taskId);
  assert.equal(waiting.value[0].undo.state, "requested");
  assert.equal(waiting.value[0].undo.undoProposalId, made.value.proposalId);
  // Approved and applied, the change shows undone and its own change says what it undid.
  const undoDecided = await port.review.decide(id, made.value.proposalId, {
    key: k(),
    body: {
      decision: "approve",
      selectedTargetIndexes: null,
      expectedDecisionDigest: undoReview.value.proposal.digest,
      soloOwnerConfirmation: null,
      expectedRevision: 1,
    },
  });
  assert.equal(undoDecided.kind, "ok");
  const undoApplied = await port.review.apply(id, made.value.proposalId, {
    key: k(),
    body: {
      proposalRef: undoDecided.value.proposalRef,
      approvalRef: undoDecided.value.approvalRef,
    },
  });
  assert.equal(undoApplied.kind, "ok");
  const after = await port.review.operationsOfTask(id, taskId);
  assert.equal(after.value.find((o) => o.operationId === first.operationId).undo.state, "undone");
  const ids = new Set(after.value.map((o) => o.operationId));
  assert.equal(ids.size, after.value.length);
  assert.ok(after.value.some((o) => o.undo.undoOfOperationId === first.operationId));
});

test("fixture: one typed confirmation approves every change waiting on the task, or none", async () => {
  const port = createFixtureAdapter("review_batch");
  const id = fixtureWorkspace.id;
  const document = await port.review.batch(id, "proposal-sample-1");
  assert.equal(document.kind, "ok");
  assert.equal(document.value.unavailable, null);
  assert.equal(document.value.items.length, 2);
  assert.equal(document.value.confirmation.phrase, "approve 3 changes for 3 credits");
  const body = (phrase) => ({
    documentDigest: document.value.documentDigest,
    issuedAt: document.value.issuedAt,
    soloOwnerConfirmation: phrase,
    items: document.value.items.map(({ proposalId, digest, approvalId, revision }) => ({
      proposalId,
      digest,
      approvalId,
      revision,
    })),
  });
  const wrong = await port.review.decideBatch(id, "proposal-sample-1", {
    key: randomUUID(),
    body: body("approve 2 changes for 2 credits"),
  });
  assert.equal(wrong.kind, "conflict");
  const pendingBefore = await port.review.listPending(id);
  assert.equal(pendingBefore.value.length, 2);
  const decided = await port.review.decideBatch(id, "proposal-sample-1", {
    key: randomUUID(),
    body: body(document.value.confirmation.phrase),
  });
  assert.equal(decided.kind, "ok");
  assert.deepEqual(
    decided.value.decided.map((d) => [d.proposalRef.id, d.status]),
    [
      ["proposal-sample-1", "approved"],
      ["proposal-sample-2", "approved"],
    ],
  );
  assert.equal((await port.review.listPending(id)).value.length, 0);
  // The same document again changes nothing.
  const reuse = await port.review.decideBatch(id, "proposal-sample-1", {
    key: randomUUID(),
    body: body(document.value.confirmation.phrase),
  });
  assert.equal(reuse.kind, "conflict");
  // In the ready scenario only one change waits: no batch is offered.
  const single = await createFixtureAdapter("ready").review.batch(id, "proposal-sample-1");
  assert.equal(single.value.unavailable, "too_few");
});

test("fixture: the picker reads the linked store's products by search or collection", async () => {
  const port = createFixtureAdapter("ready");
  const id = fixtureWorkspace.id;
  const store = fixtureStore.storeId;
  const all = await port.catalog.products(id, store, {
    after: null,
    collectionId: null,
    query: null,
  });
  assert.equal(all.kind, "ok");
  assert.ok(all.value.items.length >= 5);
  const search = await port.catalog.products(id, store, {
    after: null,
    collectionId: null,
    query: "shirt 15",
  });
  assert.deepEqual(
    search.value.items.map((p) => p.id),
    ["product:15"],
  );
  const collections = await port.catalog.collections(id, store, null);
  const summer = await port.catalog.products(id, store, {
    after: null,
    collectionId: collections.value.items[0].id,
    query: null,
  });
  assert.ok(summer.value.items.length >= 1 && summer.value.items.length < all.value.items.length);
  assert.equal(
    (
      await port.catalog.products(id, "store_other", {
        after: null,
        collectionId: null,
        query: null,
      })
    ).kind,
    "not_found",
  );
});

test("the history's undo line: Undo only where the server offers it; every state in words", () => {
  const services = { composed, port: createFixtureAdapter("ready") };
  const render = (u) =>
    renderToStaticMarkup(
      React.createElement(
        ServicesProvider,
        { value: services },
        React.createElement(UndoLine, {
          ws,
          operation: { ...operation(), undo: { ...undo(), ...u } },
          onChanged() {},
        }),
      ),
    );
  const available = render({});
  assert.ok(available.includes(">" + copy.review.undo + "<"));
  assert.ok(available.includes(copy.review.undoAvailable));
  for (const [state, text] of [
    ["requested", copy.review.undoWaiting],
    ["undone", copy.review.undone],
    ["changed", copy.review.undoChanged],
    ["unavailable", copy.review.undoUnavailable],
  ]) {
    const html = render({
      state,
      availableUntil: null,
      undoProposalId: state === "requested" || state === "undone" ? "proposal_undo" : null,
    });
    // React escapes the apostrophe in static markup.
    assert.ok(html.includes(text.replaceAll("'", "&#x27;")), state);
    assert.ok(!html.includes(">" + copy.review.undo + "<"), state);
    if (state === "requested" || state === "undone")
      assert.ok(html.includes(copy.review.undoOpen), state);
  }
  // Not confirmed in Shopify: no undo at all.
  assert.equal(render({ state: "none", availableUntil: null }), "");
  // A change that was itself an undo says so.
  assert.ok(
    render({ state: "none", availableUntil: null, undoOfOperationId: opId }).includes(
      copy.review.undoOf,
    ),
  );
  // Uncomposed, no Undo button is offered.
  const off = renderToStaticMarkup(
    React.createElement(
      ServicesProvider,
      { value: { ...services, composed: { ...composed, "review.undo": false } } },
      React.createElement(UndoLine, {
        ws,
        operation: { ...operation(), undo: undo() },
        onChanged() {},
      }),
    ),
  );
  assert.ok(!off.includes(">" + copy.review.undo + "<"));
});

// CI (run 40135757823): this PR's screens took the workspace entry past its 150 KB gzip
// budget, so Review, the task's history and Ask with its picker load as their own chunks.
test("a lazy screen shows the loading state, then the screen; a chunk that fails offers Retry", async () => {
  const tick = () => new Promise((r) => setImmediate(r));
  const page = (state) => React.createElement("div", { className: "page" }, state);
  const render = (Screen) => renderToStaticMarkup(React.createElement(Screen, { name: "Linen" }));
  let release;
  const chunk = new Promise((r) => (release = r));
  let loads = 0;
  const Lazy = lazyScreen(() => (loads++, chunk), page);
  assert.equal(loads, 0, "nothing is fetched before the screen is shown");
  const loading = render(Lazy);
  assert.match(loading, /^<div class="page"><div class="state-view state-loading" role="status"/);
  release(({ name }) => React.createElement("h1", null, "Review " + name));
  await tick();
  assert.equal(render(Lazy), "<h1>Review Linen</h1>");
  assert.equal(render(Lazy), "<h1>Review Linen</h1>");
  assert.equal(loads, 1, "a loaded chunk is fetched once");

  // A chunk that cannot load (offline, or a deploy replaced the tab's chunks): "This couldn't
  // load" with Retry, inside the same frame, never the screen and never a thrown error.
  let attempts = 0;
  const Failing = lazyScreen(
    () => (attempts++, Promise.reject(new Error("chunk fetch failed"))),
    page,
    () => {},
  );
  assert.match(render(Failing), /state-loading/);
  await tick();
  const failed = render(Failing);
  assert.match(failed, /^<div class="page"><div class="state-view state-unavailable"/);
  assert.ok(failed.includes(copy.states.unavailable.replaceAll("'", "&#x27;")));
  assert.ok(failed.includes(">" + copy.states.retry + "<"));
  assert.equal(render(Failing), failed);
  assert.equal(attempts, 1, "Retry reloads the page; a render never refetches");
});

test("Review, the history, Ask and the exception screen are reached only through the lazy screens", () => {
  const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const lazyNames = lazyModules.map((m) =>
    m
      .split("/")
      .at(-1)
      .replace(/\.tsx$/, ""),
  );
  assert.deepEqual(lazyNames, ["review", "ask", "product-picker", "exception"]);
  const statics = (text) =>
    [...text.matchAll(/^(?:import|export)\b[^;]*?from "([^"]+)";/gms)].map((m) => m[1]);
  // The barrel and the task screen import none of them statically.
  for (const [path, prefix] of [
    ["packages/workspace-ui/src/index.ts", "./screens/"],
    ["packages/workspace-ui/src/screens/task.tsx", "./"],
  ])
    for (const name of lazyNames)
      assert.ok(!statics(read(path)).includes(prefix + name), `${path} imports ${name}`);
  // Merging v1 PR 15: no other screen imports one statically either (the exception screen
  // takes Review's OperationList, so it is itself one of the lazy modules).
  const screens = new URL("../packages/workspace-ui/src/screens/", import.meta.url);
  for (const file of readdirSync(screens).filter((f) => /\.tsx?$/.test(f))) {
    const own = file.replace(/\.tsx?$/, "");
    if (own === "lazy" || lazyNames.includes(own)) continue;
    for (const name of lazyNames)
      assert.ok(
        !statics(readFileSync(new URL(file, screens), "utf8")).includes("./" + name),
        `screens/${file} imports ${name}`,
      );
  }
  // The dist check names a lazy screen bundled into an entry, or one missing from the build.
  const entry = { fileName: "assets/main.js", isEntry: true, moduleIds: ["apps/x.tsx"] };
  const split = { fileName: "assets/review.js", isEntry: false, moduleIds: [...lazyModules] };
  assert.deepEqual(inspectLazyChunks({ chunks: [entry, split] }), []);
  assert.deepEqual(
    inspectLazyChunks({ chunks: [{ ...entry, moduleIds: [lazyModules[2]] }, split] }),
    ["MODULE_LAZY_IN_ENTRY:" + lazyModules[2]],
  );
  assert.deepEqual(inspectLazyChunks({ chunks: [entry] }), [
    ...lazyModules.map((m) => "MODULE_LAZY_MISSING:" + m),
  ]);
});
