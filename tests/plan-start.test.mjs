// PR 18 (ADR-0034 items 5, 6 and 10): the person-bound, single-use plan start. Code checks
// (eligibility, the route gate, the document, its single use and staleness, every piece
// under the person's live grants, the runs after commit); the definer's twins under lock
// are proved by lab:work-postgresql.
import assert from "node:assert/strict";
import test from "node:test";
import { createHumanPolicyService } from "../packages/policy/src/index.ts";
import {
  areaStartRecords,
  buildPlanStartDocument,
  checkStartAttempt,
  decideStartPieces,
  grantSummaryDigest,
  nonceDigest,
  planDraftDigest,
  planStartWindowMs,
  planStepRuns,
  startChecks,
  startEligible,
  startRecords,
  startRouteGate,
  startTarget,
} from "../packages/policy/src/projects/index.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";

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
const leo = { ...maya, principalId: "principal_leo", membershipId: "membership_leo" };
const workspace = {
  organizationId: "org_a",
  workspaceId: "workspace_a",
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: "workspace_a",
};
const checklist = {
  kind: "checklist",
  checklistId: "product_facts_complete",
  productIds: ["product:1"],
  target: 12,
  dueAt: null,
  startRef: null,
};
const draft = {
  schemaVersion: 1,
  kind: "project",
  title: "Everyday Tote in AI answers",
  why: "AI assistants should be able to name the tote.",
  doneWhen: "The page has all 12 facts.",
  goals: [{ key: "facts", description: "Page complete", measure: checklist }],
  steps: [
    {
      key: "channel",
      title: "Check the AI channel",
      assignee: { kind: "person", principalId: "principal_maya" },
      dependsOn: [],
      repeat: null,
    },
    {
      key: "checkup",
      title: "AI answers check-up",
      assignee: { kind: "specialist", purpose: "Find missing facts" },
      dependsOn: ["channel"],
      repeat: null,
    },
    {
      key: "photos",
      title: "Add photos",
      assignee: { kind: "person", principalId: "principal_leo" },
      dependsOn: [],
      repeat: null,
    },
    {
      key: "update",
      title: "Update the page",
      assignee: { kind: "agent", installationId: "installation_listings" },
      dependsOn: ["checkup"],
      repeat: null,
    },
    {
      key: "seo",
      title: "Search listing pass",
      assignee: { kind: "agent", installationId: "installation_listings" },
      dependsOn: [],
      repeat: null,
    },
    {
      key: "monthly",
      title: "Check AI answers",
      assignee: { kind: "person", principalId: "principal_maya" },
      dependsOn: [],
      repeat: { cadence: "monthly", goalKey: "facts" },
    },
  ],
  target: { kind: "new_project", dueAt: "2026-12-04T00:00:00Z" },
};
const card = (extra = {}) => ({
  kind: "draft",
  messageId: "message_a",
  revision: 1,
  digest: planDraftDigest(draft),
  draft,
  askerPrincipalId: "principal_maya",
  contextTaint: "none",
  currentDueAt: null,
  ...extra,
});
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
const ownerGrants = () => [
  grant("workspace.goal.create", [
    "objective",
    "storeIds",
    "successCriteria",
    "status",
    "scope",
    "owner",
    "taskIds",
  ]),
  grant("workspace.project.create", ["goalId", "title", "tabs"]),
  grant("workspace.project.pin", ["pinned", "beforeProjectId"]),
  grant("workspace.task.create", ["goalId", "objective", "allowedResources"]),
  grant("workspace.task.assign", ["taskId", "assigneeId", "expectedRevision"]),
  grant("workspace.routine.configure", [
    "installationId",
    "schedule",
    "mandate",
    "goalId",
    "goalKey",
  ]),
  grant("workspace.goal.revise", [
    "goalId",
    "expectedRevision",
    "objective",
    "dueAt",
    "successCriteria",
  ]),
];
const decider = (grants, actor = maya) => {
  const service = createHumanPolicyService(
    {
      async readCurrent() {
        return {
          actor,
          policyRevision: 2,
          grantsRevision: 2,
          principalActive: true,
          organizationActive: true,
          workspaceActive: true,
          membershipActive: true,
          sessionCurrent: true,
          resource: workspace,
          accountId: null,
          providerAllowed: true,
          entitlementAllowed: false,
          grants,
        };
      },
    },
    () => new Date(now),
  );
  return {
    async decide(check) {
      const r = await service.decide({
        capabilityId: check.capabilityId,
        verb: check.verb,
        resource: workspace,
        accountId: null,
        fields: [...check.fields],
      });
      return { allowed: r.decision.allowed, reason: r.decision.reason };
    },
  };
};
const capabilities = [
  "workspace.goal.create",
  "workspace.project.create",
  "workspace.project.pin",
  "workspace.task.create",
  "workspace.task.assign",
  "workspace.routine.configure",
  "workspace.goal.revise",
];

test("the route gate: 503 while held; while off, only code-built cards", () => {
  assert.equal(startRouteGate({ kind: "draft" }), "unavailable", "committed held");
  assert.equal(startRouteGate({ kind: "area" }), "unavailable");
  const ready = (s) => ({ switch: s, start_routes: "ready" });
  assert.equal(startRouteGate({ kind: "draft" }, ready("off")), "plan_drafts_off");
  for (const kind of ["area", "quick_tasks"])
    assert.equal(startRouteGate({ kind }, ready("off")), "ok");
  assert.equal(startRouteGate({ kind: "draft" }, ready("on")), "ok");
});

test("only the asker, a human on a standalone session, gets a document", () => {
  const asker = { kind: "human", principalId: "principal_maya", membershipId: "membership_maya" };
  assert.equal(startEligible(asker, "standalone", card()), "ok");
  for (const [name, actor, surface] of [
    ["a non-asker", { ...asker, principalId: "principal_leo" }, "standalone"],
    ["an agent", { ...asker, kind: "agent", membershipId: null }, "standalone"],
    ["a service", { ...asker, kind: "service" }, "standalone"],
    ["an embedded session", asker, "embedded"],
    ["an email session", asker, "email"],
    ["no membership", { ...asker, membershipId: null }, "standalone"],
  ])
    assert.equal(startEligible(actor, surface, card()), "actor_ineligible", name);
  // A code-built card: the person who opens it (any member; the kernel decides the rest).
  const leoActor = { kind: "human", principalId: "principal_leo", membershipId: "membership_leo" };
  assert.equal(startEligible(leoActor, "standalone", { kind: "quick_tasks" }), "ok");
  assert.equal(
    startEligible(leoActor, "embedded", { kind: "area", areaTemplateId: "stock" }),
    "actor_ineligible",
  );
});

test("the records code computes, and one kernel check per piece", () => {
  const records = startRecords(card());
  assert.equal(validateCurrentDefinition("PlanStartRecords", records), true);
  assert.equal(records.goal.dueAt, "2026-12-04T00:00:00Z");
  assert.equal(records.goal.areaTemplateId, null);
  assert.equal(records.goal.successCriteria[0].measure.startRef, null);
  assert.deepEqual(records.project, { title: "Everyday Tote in AI answers", pin: true });
  assert.deepEqual(
    records.tasks.map((t) => t.stepKey),
    ["channel", "checkup", "photos", "update", "seo"],
  );
  assert.deepEqual(records.repeating, [
    {
      stepKey: "monthly",
      title: "Check AI answers",
      cadence: "monthly",
      goalKey: "facts",
      agent: false,
    },
  ]);
  const checks = startChecks(card(), records, "principal_maya");
  assert.deepEqual(
    checks.map((c) => [c.piece, c.capabilityId, c.verb]),
    [
      ["goal", "workspace.goal.create", "execute"],
      ["project", "workspace.project.create", "execute"],
      ["pin", "workspace.project.pin", "execute"],
      ["task:channel", "workspace.task.create", "execute"],
      ["task:checkup", "workspace.task.create", "execute"],
      ["task:photos", "workspace.task.create", "execute"],
      ["assign:photos", "workspace.task.assign", "execute"],
      ["task:update", "workspace.task.create", "execute"],
      ["task:seo", "workspace.task.create", "execute"],
      ["repeating:monthly", "workspace.routine.configure", "execute"],
    ],
  );
  // A plan change revises the goal record (workspace.goal.revise, human_only).
  const change = {
    ...draft,
    kind: "plan_change",
    target: { kind: "existing_project", projectId: "project_a", goalRevision: 3 },
  };
  const changeCard = card({
    draft: change,
    digest: planDraftDigest(change),
    currentDueAt: "2026-12-04T00:00:00Z",
  });
  const changeRecords = startRecords(changeCard);
  assert.equal(changeRecords.project, null);
  assert.equal(changeRecords.goal.dueAt, "2026-12-04T00:00:00Z");
  assert.equal(
    startChecks(changeCard, changeRecords, "principal_maya")[0].capabilityId,
    "workspace.goal.revise",
  );
  // An invalid draft computes nothing.
  assert.equal(startRecords(card({ draft: { ...draft, title: "x" } })), null);
});

test("every piece under live grants: a Member without project.create, a revoked grant", async () => {
  const records = startRecords(card());
  const checks = startChecks(card(), records, "principal_maya");
  assert.deepEqual(await decideStartPieces(checks, decider(ownerGrants())), { ok: true });
  // A Member without workspace.project.create: nothing is created.
  const member = ownerGrants().filter((g) => g.capabilityId !== "workspace.project.create");
  assert.deepEqual(await decideStartPieces(checks, decider(member)), {
    ok: false,
    refusal: "denied",
    piece: "project",
    reason: "capability_denied",
  });
  // A grant revoked before commit.
  const revoked = ownerGrants().map((g) =>
    g.capabilityId === "workspace.routine.configure"
      ? { ...g, revokedAt: "2026-10-24T10:00:00.000Z" }
      : g,
  );
  const r = await decideStartPieces(checks, decider(revoked));
  assert.equal(r.ok, false);
  assert.equal(r.piece, "repeating:monthly");
  // A grant missing a field the piece writes.
  const narrow = ownerGrants().map((g) =>
    g.capabilityId === "workspace.task.create"
      ? { ...g, scope: { ...g.scope, fields: ["goalId"] } }
      : g,
  );
  assert.equal((await decideStartPieces(checks, decider(narrow))).reason, "field_denied");
  // An agent actor never passes the human kernel.
  const agent = { ...maya, kind: "agent", membershipId: null, installationId: "installation_a" };
  assert.equal(
    (await decideStartPieces(checks, decider(ownerGrants(), agent))).reason,
    "origin_denied",
  );
});

test("the document binds the draft, target, records, estimate and grant summary; 5 minutes", () => {
  const records = startRecords(card());
  const summary = grantSummaryDigest(ownerGrants(), capabilities, now);
  const built = buildPlanStartDocument({
    id: "4f9c1d2e-0000-4000-8000-000000000001",
    card: card(),
    actor: maya,
    target: startTarget(card()),
    records,
    estimate: { creditsLow: 60, creditsHigh: 100 },
    grantSummaryDigest: summary,
    nowMs: now + 123,
  });
  assert.equal(validateCurrentDefinition("PlanStartDocument", built.document), true);
  assert.equal(built.document.purpose, "plan_card");
  assert.deepEqual(built.document.draft, {
    messageId: "message_a",
    revision: 1,
    digest: planDraftDigest(draft),
  });
  assert.equal(
    Date.parse(built.document.expiresAt) - Date.parse(built.document.createdAt),
    planStartWindowMs,
  );
  assert.match(built.digest, /^[a-f0-9]{64}$/);
  // A tainted card's document says so.
  const tainted = buildPlanStartDocument({
    id: "4f9c1d2e-0000-4000-8000-000000000002",
    card: card({ contextTaint: "untrusted_external" }),
    actor: maya,
    target: startTarget(card()),
    records,
    estimate: { creditsLow: 60, creditsHigh: 100 },
    grantSummaryDigest: summary,
    nowMs: now,
  });
  assert.equal(tainted.document.contextTaint, "untrusted_external");
  assert.throws(
    () =>
      buildPlanStartDocument({
        id: "4f9c1d2e-0000-4000-8000-000000000003",
        card: card(),
        actor: maya,
        target: startTarget(card()),
        records,
        estimate: { creditsLow: 101, creditsHigh: 100 },
        grantSummaryDigest: summary,
        nowMs: now,
      }),
    /PLAN_START_DOCUMENT_INVALID/,
  );
  // An area card: code-built, no draft, its own target.
  const area = buildPlanStartDocument({
    id: "4f9c1d2e-0000-4000-8000-000000000004",
    card: { kind: "area", areaTemplateId: "stock" },
    actor: leo,
    target: startTarget({ kind: "area", areaTemplateId: "stock" }),
    records: areaStartRecords("stock"),
    estimate: { creditsLow: 0, creditsHigh: 0 },
    grantSummaryDigest: summary,
    nowMs: now,
  });
  assert.deepEqual([area.document.purpose, area.document.draft], ["area", null]);
});

test("the grant summary changes with any issued, revoked, narrowed or expiring grant", () => {
  const base = grantSummaryDigest(ownerGrants(), capabilities, now);
  assert.equal(
    grantSummaryDigest([...ownerGrants()].reverse(), capabilities, now),
    base,
    "order-free",
  );
  const changed = (grants) => grantSummaryDigest(grants, capabilities, now) !== base;
  assert.ok(changed(ownerGrants().slice(1)), "revoked");
  assert.ok(
    changed([...ownerGrants(), grant("workspace.task.assign", ["taskId"], { id: "grant_new" })]),
    "issued",
  );
  assert.ok(
    changed(ownerGrants().map((g, i) => (i === 0 ? { ...g, verbs: ["view"] } : g))),
    "narrowed",
  );
  assert.ok(
    changed(
      ownerGrants().map((g, i) => (i === 0 ? { ...g, expiresAt: "2026-10-25T00:00:00.000Z" } : g)),
    ),
    "expiry",
  );
  // A grant on another capability does not matter.
  assert.equal(
    grantSummaryDigest(
      [...ownerGrants(), grant("catalog.products.read", ["title"])],
      capabilities,
      now,
    ),
    base,
  );
});

test("single use: expired, reused, unknown, edited or changed documents are stale", () => {
  const records = startRecords(card());
  const summary = grantSummaryDigest(ownerGrants(), capabilities, now);
  const built = buildPlanStartDocument({
    id: "4f9c1d2e-0000-4000-8000-000000000001",
    card: card(),
    actor: maya,
    target: startTarget(card()),
    records,
    estimate: { creditsLow: 60, creditsHigh: 100 },
    grantSummaryDigest: summary,
    nowMs: now,
  });
  const stored = {
    canonical: built.canonical,
    digest: built.digest,
    actorPrincipalId: "principal_maya",
    actorMembershipId: "membership_maya",
    sessionDigest: "s".repeat(64).replace(/s/g, "a"),
    nonceDigest: nonceDigest("nonce_a"),
    expiresAtMs: Date.parse(built.document.expiresAt),
    consumed: false,
  };
  const attempt = {
    actor: { kind: "human", principalId: "principal_maya", membershipId: "membership_maya" },
    surface: "standalone",
    sessionDigest: stored.sessionDigest,
    nonce: "nonce_a",
    nowMs: now + 60_000,
    currentDraft: { revision: 1, digest: planDraftDigest(draft) },
    currentTargetRevision: null,
    liveGrantSummaryDigest: summary,
    assigneesCurrent: true,
  };
  assert.equal(checkStartAttempt(stored, attempt), "ok");
  for (const [name, s, a, expected] of [
    ["unknown", null, attempt, "stale"],
    ["reused", { ...stored, consumed: true }, attempt, "stale"],
    ["expired", stored, { ...attempt, nowMs: stored.expiresAtMs }, "stale"],
    ["wrong nonce", stored, { ...attempt, nonce: "nonce_b" }, "stale"],
    [
      "tampered",
      { ...stored, canonical: stored.canonical.replace("Everyday", "Holiday") },
      attempt,
      "stale",
    ],
    [
      "an edited card",
      stored,
      { ...attempt, currentDraft: { revision: 2, digest: "b".repeat(64) } },
      "stale",
    ],
    ["a revoked grant", stored, { ...attempt, liveGrantSummaryDigest: "c".repeat(64) }, "stale"],
    ["a stopped or removed assignee", stored, { ...attempt, assigneesCurrent: false }, "stale"],
    [
      "another member",
      stored,
      { ...attempt, actor: { ...attempt.actor, principalId: "principal_leo" } },
      "actor_ineligible",
    ],
    ["another session", stored, { ...attempt, sessionDigest: "d".repeat(64) }, "actor_ineligible"],
    [
      "an agent",
      stored,
      { ...attempt, actor: { ...attempt.actor, kind: "agent" } },
      "actor_ineligible",
    ],
    ["an embedded session", stored, { ...attempt, surface: "embedded" }, "actor_ineligible"],
    ["an email session", stored, { ...attempt, surface: "email" }, "actor_ineligible"],
  ])
    assert.equal(checkStartAttempt(s, a), expected, name);
  // A plan change binds the project's revision.
  const change = {
    ...draft,
    kind: "plan_change",
    target: { kind: "existing_project", projectId: "project_a", goalRevision: 3 },
  };
  const changeCard = card({ draft: change, digest: planDraftDigest(change) });
  const changeDoc = buildPlanStartDocument({
    id: "4f9c1d2e-0000-4000-8000-000000000005",
    card: changeCard,
    actor: maya,
    target: startTarget(changeCard),
    records: startRecords(changeCard),
    estimate: { creditsLow: 0, creditsHigh: 10 },
    grantSummaryDigest: summary,
    nowMs: now,
  });
  const changeStored = { ...stored, canonical: changeDoc.canonical, digest: changeDoc.digest };
  const changeAttempt = {
    ...attempt,
    currentDraft: { revision: 1, digest: planDraftDigest(change) },
  };
  assert.equal(
    checkStartAttempt(changeStored, { ...changeAttempt, currentTargetRevision: 3 }),
    "ok",
  );
  assert.equal(
    checkStartAttempt(changeStored, { ...changeAttempt, currentTargetRevision: 4 }),
    "stale",
  );
});

test("after commit: runs are admitted on their own; none while the loop is off", () => {
  const off = planStepRuns(card(), { actorIsOwner: true, agentLoop: "off" });
  assert.deepEqual(off.admit, []);
  assert.deepEqual(
    off.runs.map((r) => [r.stepKey, r.status, r.reason]),
    [
      ["checkup", "not_started", "agent_loop_off"],
      ["update", "not_started", "agent_loop_off"],
      ["seo", "not_started", "agent_loop_off"],
    ],
  );
  for (const r of off.runs) assert.equal(validateCurrentDefinition("PlanStepRun", r), true);
  // The Owner's tap: the specialist draft run and the ready agent step; the later step waits.
  const owner = planStepRuns(card(), { actorIsOwner: true, agentLoop: "on" });
  assert.deepEqual(owner.admit, [
    { stepKey: "checkup", kind: "specialist_draft" },
    { stepKey: "seo", kind: "agent_step" },
  ]);
  assert.deepEqual(owner.runs, [
    { stepKey: "update", status: "not_started", reason: "waits_for_step" },
  ]);
  // A teammate's tap: "Ask [Owner]" for the specialist.
  const teammate = planStepRuns(card(), { actorIsOwner: false, agentLoop: "on" });
  assert.deepEqual(teammate.admit, [{ stepKey: "seo", kind: "agent_step" }]);
  assert.deepEqual(teammate.runs[0], {
    stepKey: "checkup",
    status: "not_started",
    reason: "ask_owner",
  });
  // Code-built cards start no run.
  assert.deepEqual(planStepRuns({ kind: "quick_tasks" }, { actorIsOwner: true, agentLoop: "on" }), {
    admit: [],
    runs: [],
  });
});
