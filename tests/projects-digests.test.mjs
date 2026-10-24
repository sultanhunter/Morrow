// The project flow's digests (PR 18; ADR-0033 item 5, ADR-0034 items 3 and 5) run on Web
// Crypto, so the same code serves Node and the api Worker. Each digest is sha256 hex over
// the UTF-8 bytes of a canonical JSON text, which the definers store and hash again in SQL
// (sha256 over the text's UTF-8 bytes). These vectors were computed by the node:crypto
// implementation they replaced, so a change to the canonical text or the hash breaks them,
// and the node:crypto oracle below is the same function the SQL side computes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalText, sha256Hex } from "../packages/policy/src/projects/digest.ts";
import {
  areaStartRecords,
  buildPlanStartDocument,
  checkStartAttempt,
  finishResultsDigest,
  grantSummaryDigest,
  nonceDigest,
  planDraftDigest,
  planDraftValid,
  startRecords,
  startTarget,
} from "../packages/policy/src/projects/index.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

// What SQL computes: encode(sha256(convert_to(text, 'UTF8')), 'hex').
const oracle = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const vectors = Object.freeze({
  planDraft: "002048cc4c2b4f93c96f69f5f03bd06ea6c9c28e8a169683e7e64fb2c7e2e6f9",
  finishResults: "3d68f9d59a548f966149ca81512f52e4448de6e5ec805eb2b03531c941a2a5d9",
  grantSummary: "81f1b31287464c995143d2a07eaceadd6bb045183adcb5ce47df1ad7d0279c9e",
  cardDocument: "f1aa921e658f840ea39555bb36f9ec5e2f49d106036aa29c6f098b4611e99585",
  areaDocument: "2bc590c3d4909173ae570feff8f63f4fe82082d15fff5369d343a7d23ceac3f2",
  nonce: "fd153582db1fb24e8be48beb90dc778b1c925ca4c9beaabb9023394bd51375ff",
});

const now = Date.parse("2026-10-24T10:30:00.000Z");
const maya = {
  kind: "human",
  principalId: "principal_maya",
  organizationId: "org_a",
  workspaceId: "workspace_a",
  membershipId: "membership_maya",
  installationId: null,
  mandateId: null,
};
// Non-ASCII text on purpose: the hash is over UTF-8 bytes on both sides.
const draft = {
  schemaVersion: 1,
  kind: "project",
  title: "Everyday Tote in AI answers",
  why: "AI assistants should be able to name the tote — café crème ✓",
  doneWhen: "The page has all 12 facts.",
  goals: [
    {
      key: "facts",
      description: "Page complete",
      measure: {
        kind: "checklist",
        checklistId: "product_facts_complete",
        productIds: ["product:1"],
        target: 12,
        dueAt: null,
        startRef: null,
      },
    },
  ],
  steps: [
    {
      key: "channel",
      title: "Check the AI channel",
      assignee: { kind: "person", principalId: "principal_maya" },
      dependsOn: [],
      repeat: null,
    },
    {
      key: "update",
      title: "Update the page",
      assignee: { kind: "agent", installationId: "installation_listings" },
      dependsOn: ["channel"],
      repeat: null,
    },
  ],
  target: { kind: "new_project", dueAt: "2026-12-04T00:00:00Z" },
};
const workspace = {
  organizationId: "org_a",
  workspaceId: "workspace_a",
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: "workspace_a",
};
const grant = (capabilityId, fields, extra = {}) => ({
  id: `grant_${capabilityId}`,
  principal: structuredClone(maya),
  capabilityId,
  verbs: ["view", "execute"],
  scope: {
    organizationId: "org_a",
    workspaceId: "workspace_a",
    storeIds: [],
    accountIds: [],
    resources: [structuredClone(workspace)],
    fields,
  },
  issuedBy: structuredClone(maya),
  validFrom: "2026-10-01T00:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  policyRevision: 1,
  ...extra,
});
const grants = [
  grant("workspace.task.create", ["objective", "goalId", "allowedResources"], {
    verbs: ["execute", "view"],
  }),
  grant("workspace.goal.create", ["successCriteria", "objective", "storeIds"], {
    expiresAt: "2026-11-01T00:00:00.000Z",
  }),
  grant("workspace.project.create", ["title", "goalId", "tabs"]),
  // Revoked, expired and other-capability grants are not in the summary.
  grant("workspace.project.pin", ["pinned"], { revokedAt: "2026-10-02T00:00:00.000Z" }),
  grant("workspace.task.assign", ["taskId"], { expiresAt: "2026-10-20T00:00:00.000Z" }),
  grant("catalog.products.read", ["title"]),
];
const capabilities = [
  "workspace.goal.create",
  "workspace.project.create",
  "workspace.project.pin",
  "workspace.task.create",
  "workspace.task.assign",
];

test("sha256Hex is Web Crypto SHA-256 over UTF-8, equal to node:crypto and SQL", async () => {
  // FIPS 180-2 vectors.
  assert.equal(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  for (const text of ["café ✓", "日本語", "🙂 emoji", "line\nbreak\u0000nul", "lone \ud800"])
    assert.equal(await sha256Hex(text), oracle(text), JSON.stringify(text));
  assert.ok(sha256Hex("x") instanceof Promise);
});

test("canonicalText sorts keys by UTF-16 code unit and adds no whitespace", () => {
  assert.equal(
    canonicalText({ b: [1, { z: null, a: "é" }], a: true, B: 2.5, é: "x" }),
    '{"B":2.5,"a":true,"b":[1,{"a":"é","z":null}],"é":"x"}',
  );
  assert.equal(canonicalText(["morrow", 1, []]), '["morrow",1,[]]');
});

test("PlanDraft@1 digest vector", async () => {
  assert.equal(planDraftValid(draft), true);
  const digest = await planDraftDigest(draft);
  assert.equal(digest, vectors.planDraft);
  assert.equal(digest, oracle(canonicalText(draft)));
  // Key order is not part of the draft.
  const reordered = Object.fromEntries(Object.entries(structuredClone(draft)).reverse());
  assert.equal(await planDraftDigest(reordered), digest);
});

test("Finish results record digest vector", async () => {
  const record = {
    goalId: "goal_dated",
    goalRevision: 3,
    outcome: "achieved",
    goals: [
      { key: "facts", health: "done" },
      { key: "named", health: "done" },
    ],
    computedAt: "2026-10-24T10:30:00.000Z",
  };
  const text =
    '{"computedAt":"2026-10-24T10:30:00.000Z","goalId":"goal_dated","goalRevision":3,' +
    '"goals":[{"health":"done","key":"facts"},{"health":"done","key":"named"}],' +
    '"outcome":"achieved"}';
  assert.equal(canonicalText(record), text);
  const digest = await finishResultsDigest(record);
  assert.equal(digest, vectors.finishResults);
  assert.equal(digest, oracle(text));
});

test("grant summary, PlanStartDocument@1 and nonce digest vectors", async () => {
  const summary = await grantSummaryDigest(grants, capabilities, now);
  assert.equal(summary, vectors.grantSummary);
  assert.equal(
    summary,
    oracle(
      canonicalText([
        "morrow.plan_start.grant_summary",
        1,
        [
          {
            id: "grant_workspace.goal.create",
            capabilityId: "workspace.goal.create",
            verbs: ["execute", "view"],
            fields: ["objective", "storeIds", "successCriteria"],
            expiresAt: "2026-11-01T00:00:00.000Z",
          },
          {
            id: "grant_workspace.project.create",
            capabilityId: "workspace.project.create",
            verbs: ["execute", "view"],
            fields: ["goalId", "tabs", "title"],
            expiresAt: null,
          },
          {
            id: "grant_workspace.task.create",
            capabilityId: "workspace.task.create",
            verbs: ["execute", "view"],
            fields: ["allowedResources", "goalId", "objective"],
            expiresAt: null,
          },
        ],
      ]),
    ),
  );
  const card = {
    kind: "draft",
    messageId: "message_a",
    revision: 1,
    digest: vectors.planDraft,
    draft,
    askerPrincipalId: "principal_maya",
    contextTaint: "none",
    currentDueAt: null,
  };
  const built = await buildPlanStartDocument({
    id: "4f9c1d2e-0000-4000-8000-000000000001",
    card,
    actor: maya,
    target: startTarget(card),
    records: startRecords(card),
    estimate: { creditsLow: 60, creditsHigh: 100 },
    grantSummaryDigest: summary,
    nowMs: now + 123,
  });
  assert.equal(validateCurrentDefinition("PlanStartDocument", built.document), true);
  assert.equal(built.canonical, canonicalText(built.document));
  assert.equal(built.digest, vectors.cardDocument);
  assert.equal(built.digest, oracle(built.canonical));
  const areaCard = { kind: "area", areaTemplateId: "stock" };
  const area = await buildPlanStartDocument({
    id: "4f9c1d2e-0000-4000-8000-000000000004",
    card: areaCard,
    actor: maya,
    target: startTarget(areaCard),
    records: areaStartRecords("stock"),
    estimate: { creditsLow: 0, creditsHigh: 0 },
    grantSummaryDigest: summary,
    nowMs: now,
  });
  assert.equal(area.digest, vectors.areaDocument);
  assert.equal(area.digest, oracle(area.canonical));
  assert.equal(await nonceDigest("nonce_a"), vectors.nonce);
  assert.equal(vectors.nonce, oracle("nonce_a"));
  // The stored document checks against the same digests.
  assert.equal(
    await checkStartAttempt(
      {
        canonical: built.canonical,
        digest: vectors.cardDocument,
        actorPrincipalId: "principal_maya",
        actorMembershipId: "membership_maya",
        sessionDigest: "a".repeat(64),
        nonceDigest: vectors.nonce,
        expiresAtMs: Date.parse(built.document.expiresAt),
        consumed: false,
      },
      {
        actor: { kind: "human", principalId: "principal_maya", membershipId: "membership_maya" },
        surface: "standalone",
        sessionDigest: "a".repeat(64),
        nonce: "nonce_a",
        nowMs: now + 60_000,
        currentDraft: { revision: 1, digest: vectors.planDraft },
        currentTargetRevision: null,
        liveGrantSummaryDigest: vectors.grantSummary,
        assigneesCurrent: true,
      },
    ),
    "ok",
  );
});
