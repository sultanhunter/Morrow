// v1 PR 3: the workspace SPA's side of review, approve and apply on a fake fetch. Closed
// requests (ids, a selection of indexes, the exact refs the review returned; never a tenant, a
// value or a store), closed decoders that accept exactly the server's shapes and refuse
// anything wider, the fixture adapter's review flow (approve all, approve some, apply, the
// history), and the screens' rendering: product text and description HTML are text, never
// markup. lab:catalog-apply decodes the server's real replies with the same decoders.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { requests } from "../apps/workspace-web/src/http/api.ts";
import { composed } from "../apps/workspace-web/src/http/composed.ts";
import {
  decodeApplied,
  decodeDecided,
  decodeOperation,
  decodeOperationsOfTask,
  decodePendingApprovals,
  decodeRechecked,
  decodeRef,
  decodeReview,
} from "../apps/workspace-web/src/http/review-decoders.ts";
import { createFixtureAdapter } from "../apps/workspace-web/src/fixtures/adapter.ts";
import { fixtureWorkspace } from "../apps/workspace-web/src/fixtures/seed.ts";
import { portMethods } from "../packages/workspace-ui/src/port.ts";
import { copy } from "../packages/workspace-ui/src/copy.ts";
import { OperationList, operationNote } from "../packages/workspace-ui/src/screens/review.tsx";
import { ServicesProvider } from "../packages/workspace-ui/src/services.tsx";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
const ws = "ws-1";
const key = () => randomUUID();
const hex = (c) => c.repeat(64);
const opId = "00000000-0000-4000-8000-0000000000a1";
const ref = (kind, id, over = {}) => ({
  organizationId: "org_o",
  workspaceId: "ws_w",
  storeId: kind === "proposal" ? "store_a" : null,
  kind,
  id,
  revision: 1,
  digest: hex("a"),
  ...over,
});
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
const reviewBody = (over = {}) => ({
  schemaVersion: 1,
  proposal: {
    id: "proposal_1",
    digest: hex("a"),
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
  proposalRef: ref("proposal", "proposal_1"),
  approval: {
    id: "approval_proposal_1",
    revision: 1,
    status: "pending",
    effectiveAt: null,
    expiresAt: "2026-10-26T10:00:00.000Z",
  },
  approvalRef: ref("approval", "approval_proposal_1", { digest: hex("b") }),
  viewerRole: "reviewer",
  actionable: true,
  blocked: null,
  confirmation: { required: false, phrase: "approve 1 change for 1 credits" },
  products: [
    {
      targetIndex: 0,
      productId: "product:7",
      source: "available",
      changes: [
        { field: "title", before: "Linen shirt", after: "Linen shirt - improved" },
        {
          field: "descriptionHtml",
          before: "<p>Old</p>",
          after: '<p>New <img src=x onerror="alert(1)"></p>',
        },
        { field: "tags", before: ["a"], after: ["a", "b"] },
      ],
      tags: { added: ["b"], removed: [] },
      flags: { newUrls: 1, newEmails: 0, newPhones: 0, tagsAdded: 1, tagsRemoved: 0 },
    },
  ],
  claim: null,
  ...over,
});

test("the port: six review methods, all composed over HTTP", () => {
  for (const method of [
    "review.listPending",
    "review.get",
    "review.decide",
    "review.apply",
    "review.operationsOfTask",
    "review.recheck",
  ]) {
    assert.ok(portMethods.includes(method), method);
    assert.equal(composed[method], true, method);
  }
});

test("requests: fixed paths, closed bodies, the exact refs; refused before sending", () => {
  const k = key();
  assert.deepEqual(requests.pendingApprovals(ws), {
    method: "GET",
    path: "/workspace/ws-1/work/approvals?limit=25",
  });
  assert.deepEqual(requests.review(ws, "proposal_1", null), {
    method: "GET",
    path: "/workspace/ws-1/work/proposals/proposal_1/review",
  });
  assert.deepEqual(requests.review(ws, "proposal_1", [2, 0]), {
    method: "GET",
    path: "/workspace/ws-1/work/proposals/proposal_1/review?selected=0,2",
  });
  const decision = {
    decision: "approve",
    selectedTargetIndexes: [2, 0],
    expectedDecisionDigest: hex("c"),
    soloOwnerConfirmation: null,
    expectedRevision: 1,
  };
  assert.deepEqual(requests.decide(ws, "proposal_1", { key: k, body: decision }), {
    method: "POST",
    path: "/workspace/ws-1/work/proposals/proposal_1/decision",
    body: JSON.stringify({
      decision: {
        decision: "approve",
        selectedTargetIndexes: [0, 2],
        expectedDecisionDigest: hex("c"),
        soloOwnerConfirmation: null,
        comment: null,
      },
      expectedRevision: 1,
    }),
    key: k,
  });
  const refs = { proposalRef: ref("proposal", "proposal_1"), approvalRef: ref("approval", "a_1") };
  assert.deepEqual(requests.apply(ws, "proposal_1", { key: k, body: refs }), {
    method: "POST",
    path: "/workspace/ws-1/work/proposals/proposal_1/apply",
    body: JSON.stringify(refs),
    key: k,
  });
  assert.deepEqual(requests.operationsOfTask(ws, "task_root"), {
    method: "GET",
    path: "/workspace/ws-1/work/tasks/task_root/operations",
  });
  assert.deepEqual(requests.recheck(ws, opId, { key: k, body: {} }), {
    method: "POST",
    path: "/workspace/ws-1/work/operations/" + opId + "/reconcile",
    body: "{}",
    key: k,
  });
  for (const refused of [
    requests.review("bad id", "proposal_1", null),
    requests.review(ws, "proposal_1", []),
    requests.review(ws, "proposal_1", [0, 0]),
    requests.review(ws, "proposal_1", [100]),
    requests.decide(ws, "proposal_1", { key: k, body: { ...decision, decision: "cancel" } }),
    requests.decide(ws, "proposal_1", {
      key: k,
      body: { ...decision, decision: "reject" },
    }),
    requests.decide(ws, "proposal_1", {
      key: k,
      body: { ...decision, expectedDecisionDigest: "x" },
    }),
    requests.decide(ws, "proposal_1", { key: "NOT-A-KEY", body: decision }),
    requests.apply(ws, "proposal_2", { key: k, body: refs }),
    requests.apply(ws, "proposal_1", {
      key: k,
      body: { ...refs, approvalRef: { ...refs.approvalRef, kind: "proposal" } },
    }),
    requests.apply(ws, "proposal_1", {
      key: k,
      body: { ...refs, proposalRef: { ...refs.proposalRef, extra: 1 } },
    }),
    requests.operationsOfTask(ws, "task/../x"),
    requests.recheck(ws, "not-an-operation", { key: k, body: {} }),
    requests.recheck(ws, opId, { key: k, body: { all: true } }),
  ])
    assert.equal(refused, null);
});

test("decoders: exactly the server's shapes; anything wider or foreign is null", () => {
  const view = decodeReview(reviewBody(), "proposal_1");
  assert.ok(view);
  assert.equal(view.products[0].changes[1].after, '<p>New <img src=x onerror="alert(1)"></p>');
  assert.deepEqual(view.confirmation, {
    required: false,
    phrase: "approve 1 change for 1 credits",
  });
  // A derived preview names its root; any other proposal does not decode.
  assert.ok(
    decodeReview(
      reviewBody({
        proposal: {
          ...reviewBody().proposal,
          id: "proposal_1d",
          derivedFromId: "proposal_1",
          selectedTargetIndexes: [0],
        },
        proposalRef: ref("proposal", "proposal_1d"),
        approval: null,
        approvalRef: null,
      }),
      "proposal_1",
    ),
  );
  for (const wider of [
    reviewBody({ extra: true }),
    reviewBody({ proposalRef: ref("proposal", "proposal_2") }),
    reviewBody({ proposalRef: ref("proposal", "proposal_1", { digest: hex("f") }) }),
    reviewBody({ proposal: { ...reviewBody().proposal, capabilityId: "catalog.content.propose" } }),
    reviewBody({
      products: [
        { ...reviewBody().products[0], changes: [{ field: "price", before: null, after: "1" }] },
      ],
    }),
    reviewBody({ products: [{ ...reviewBody().products[0], vendor: "x" }] }),
    reviewBody({
      claim: {
        mine: true,
        approvalId: "a",
        proposalId: "p",
        operations: [{ ...operation(), token: "x" }],
      },
    }),
  ])
    assert.equal(decodeReview(wider, "proposal_1"), null);
  assert.equal(decodeReview(reviewBody(), "proposal_9"), null);
  assert.ok(decodeRef(ref("approval", "a"), "approval"));
  assert.equal(decodeRef(ref("approval", "a"), "proposal"), null);
  assert.ok(decodeOperation(operation()));
  assert.equal(decodeOperation(operation({ status: "Verified!" })), null);
  assert.equal(decodeOperation({ ...operation(), title: "Linen" }), null);
  const decided = {
    schemaVersion: 1,
    outcome: "applied",
    proposalRef: ref("proposal", "proposal_1"),
    approvalRef: ref("approval", "a_1"),
    status: "approved",
    effectiveAt: "2026-10-23T10:00:00.000Z",
    expiresAt: "2026-10-24T10:00:00.000Z",
  };
  assert.equal(decodeDecided(decided)?.status, "approved");
  assert.equal(decodeDecided({ ...decided, outcome: "refused" }), null);
  assert.deepEqual(
    decodeApplied({ schemaVersion: 1, replayed: false, pending: 0, operations: [operation()] })
      ?.pending,
    0,
  );
  assert.equal(
    decodeApplied({ schemaVersion: 1, replayed: false, pending: 0, operations: [] }),
    null,
  );
  assert.equal(
    decodeOperationsOfTask({ schemaVersion: 1, operations: [operation()] }, "task_root")?.length,
    1,
  );
  assert.equal(
    decodeOperationsOfTask({ schemaVersion: 1, operations: [operation()] }, "task_x"),
    null,
  );
  assert.equal(
    decodeRechecked({ schemaVersion: 1, outcome: "recorded", operation: operation() }, opId)
      ?.status,
    "verified",
  );
  assert.equal(
    decodeRechecked({ schemaVersion: 1, outcome: "recorded", operation: operation() }, "other"),
    null,
  );
  const pending = {
    schemaVersion: 1,
    items: [
      {
        proposalId: "proposal_1",
        proposalDigest: hex("a"),
        storeId: "store_a",
        approvalId: "approval_proposal_1",
        capabilityId: "catalog.content.publish",
        risk: "external",
        targetCount: 3,
        expiresAt: "2026-10-26T10:00:00.000Z",
        viewerRole: "reviewer",
      },
    ],
    next: null,
  };
  assert.equal(decodePendingApprovals(pending)?.[0].targetCount, 3);
  assert.equal(
    decodePendingApprovals({ ...pending, items: [{ ...pending.items[0], title: "x" }] }),
    null,
  );
});

test("fixture: approve all, apply and the history; a selection binds its own digest", async () => {
  const port = createFixtureAdapter("ready");
  const id = fixtureWorkspace.id;
  const pending = await port.review.listPending(id);
  assert.equal(pending.kind, "ok");
  const proposalId = pending.value[0].proposalId;
  const review = await port.review.get(id, proposalId, null);
  assert.equal(review.kind, "ok");
  // A decision on another digest conflicts and changes nothing.
  const stale = await port.review.decide(id, proposalId, {
    key: randomUUID(),
    body: {
      decision: "approve",
      selectedTargetIndexes: null,
      expectedDecisionDigest: hex("f"),
      soloOwnerConfirmation: null,
      expectedRevision: 1,
    },
  });
  assert.equal(stale.kind, "conflict");
  // Approve some: the preview's digest.
  const preview = await port.review.get(id, proposalId, [1]);
  assert.equal(preview.kind, "ok");
  assert.notEqual(preview.value.proposal.digest, review.value.proposal.digest);
  const decided = await port.review.decide(id, proposalId, {
    key: randomUUID(),
    body: {
      decision: "approve",
      selectedTargetIndexes: [1],
      expectedDecisionDigest: preview.value.proposal.digest,
      soloOwnerConfirmation: null,
      expectedRevision: 1,
    },
  });
  assert.equal(decided.kind, "ok");
  const applied = await port.review.apply(id, decided.value.proposalRef.id, {
    key: randomUUID(),
    body: { proposalRef: decided.value.proposalRef, approvalRef: decided.value.approvalRef },
  });
  assert.equal(applied.kind, "ok");
  assert.deepEqual(
    applied.value.operations.map((o) => [o.targetIndex, o.status]),
    [[1, "verified"]],
  );
  const history = await port.review.operationsOfTask(id, review.value.proposal.taskId);
  assert.equal(history.kind, "ok");
  assert.equal(history.value.length, 1);
});

test("the results render as text: each status and why a product was not applied", () => {
  const services = { composed, port: createFixtureAdapter("ready") };
  const html = renderToStaticMarkup(
    React.createElement(
      ServicesProvider,
      { value: services },
      React.createElement(OperationList, {
        ws,
        operations: [
          decodeOperation(operation()),
          decodeOperation(
            operation({
              operationId: opId.replace("a1", "a2"),
              status: "failed",
              reason: "source_changed",
            }),
          ),
          decodeOperation(
            operation({
              operationId: opId.replace("a1", "a3"),
              status: "uncertain",
              reason: "readback_differs",
              uncertaintyReason: "partial_result",
            }),
          ),
        ],
        onChanged() {},
      }),
    ),
  );
  assert.ok(html.includes(copy.status.operation.verified));
  assert.ok(html.includes(copy.review.reasons.source_changed));
  assert.ok(html.includes(copy.review.reasons.readback_differs));
  assert.ok(html.includes(copy.review.checkAgain));
  assert.equal(
    operationNote(decodeOperation(operation({ status: "uncertain", reason: null }))),
    copy.review.uncertain,
  );
  assert.equal(operationNote(decodeOperation(operation())), null);
});
