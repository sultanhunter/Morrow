// lab:plan-start (PR 18; ADR-0033, ADR-0034): the goal and plan-start routes through the
// real projects handler against PostgreSQL 17 with the whole migration manifest, applied
// by the Neon-shaped createrole administrator. The committed switch answers 503 with no
// document, lock or record; with the routes ready (this lab's own configuration, never a
// committed one) a person's tap starts Quick tasks and a Morrow card in one transaction
// under that person's live grants: only the asker, only the digest the server holds, a
// single-use nonce, the session it was issued on, a grant issued since the document, an
// edit, a stopped refusal path and repeating steps all refuse with nothing written. Then
// the goal record's CHECKs and guards (a client-sent start value, more than 3 measured
// goals, `achieved` without Finish's results record, `cancelled` with open tasks, a
// customer-tagged value, a clockless order value), a person's hand check, revise and the
// per-viewer progress read. Review fixes: two cards (or an edit back to revision 1) with
// one draft, Quick tasks only by the Owner and never revised, paused or ended, an area
// that never ends, a project's 1 to 3 measured goals, a bounded values read and a daily
// check cap, hand checks judged on the current measure, and a customer-class goal hidden
// from the goal reads. Second review: every goal revision appends goal.revised, and a plan
// change answers goal view and hidden goals as revise does and never drops a customer-class
// goal (refused under lock). Synthetic fixtures only; no provider, credential or merchant data.
// Run by `npm run lab:plan-start` (CI's postgres `work` leg).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createWorkApiHandler } from "../../packages/work/src/http.ts";
import { createProjectsApiHandler } from "../../packages/work/src/projects/http.ts";
import { projectStatements } from "../../packages/work/src/projects/sql.ts";
import {
  goalProgress,
  planDraftsRecord,
  planDraftValid,
} from "../../packages/policy/src/projects/index.ts";
import { validateCurrentDefinition } from "../../packages/contracts/src/validation.ts";
import {
  asApi,
  asCommandRole,
  fixtureGrant,
  grantInsert,
  literal,
  seedWorkFixtures,
  withWorkDatabase,
  workFixtureOrigin,
  workRequest,
  workspaceResource,
} from "../tenant-conformance/harness.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const canonical = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? "[" + v.map(canonical).join(",") + "]"
      : "{" +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
          .join(",") +
        "}";
const now = "date_trunc('milliseconds',clock_timestamp())";
let db, release, started, P, held, open, work;
before(async () => {
  let ready;
  const opened = new Promise((resolve) => (ready = resolve));
  started = withWorkDatabase(
    "PR18.plan-start",
    (context) => {
      db = context;
      ready();
      return new Promise((resolve) => (release = resolve));
    },
    { administrator: "createrole" },
  );
  await Promise.race([opened, started]);
  P = seedWorkFixtures(db);
  // The project grants every person who starts or revises holds (A, R and S: full owners).
  const extra = [];
  for (const p of [P.A, P.R, P.S]) {
    for (const [capability, verbs, fields] of [
      ["workspace.project.create", ["view", "execute"], ["goalId", "tabs", "title"]],
      ["workspace.project.pin", ["execute"], ["beforeProjectId", "pinned"]],
      [
        "workspace.goal.revise",
        ["execute", "administer"],
        ["dueAt", "expectedRevision", "goalId", "objective", "successCriteria"],
      ],
      [
        "workspace.goal.measure.record",
        ["execute"],
        ["answers", "assistant", "goalId", "key", "productId"],
      ],
    ])
      extra.push(grantInsert(p, fixtureGrant(p, capability, verbs, fields)));
  }
  db.admin(extra.join("\n"));
  // A is the workspace's Owner (ADR-0024: the organization's founding signup).
  db.admin(`INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES('profile_plan_start','workos','environment_${"A".repeat(26)}','app_${"A".repeat(26)}','client_${"A".repeat(26)}','https://api.workos.com/user_management/client_${"A".repeat(26)}',1,${literal("a".repeat(64))},1,'active');
INSERT INTO morrow_identity.organization_signups VALUES(${literal(P.A.principal)},${literal(randomUUID())},${literal("b".repeat(64))},'profile_plan_start',${literal(P.A.org)},${literal(P.A.workspace)},${literal(P.A.membership)},'owner-bootstrap-v1',clock_timestamp());`);
  work = createWorkApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
  });
  const configured = (planDrafts, goals) =>
    createProjectsApiHandler({
      origin: workFixtureOrigin,
      connector: db.connector(),
      now: Date.now,
      goals,
      planDrafts,
    });
  held = configured(planDraftsRecord, false);
  open = configured({ switch: "on", start_routes: "ready" }, true);
});
after(async () => {
  release?.();
  await started;
});

const quietly = async (body) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await body();
  } finally {
    console.log = log;
  }
};
async function send(handler, p, method, path, body, options) {
  return quietly(async () => {
    const response = await handler.fetch(workRequest(p, method, path, body, options), undefined, {
      waitUntil() {},
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) };
  });
}
const count = (table, where = "true") =>
  Number(db.sql(`SELECT count(*) FROM morrow_work.${table} WHERE ${where};`));
const counts = () =>
  Object.fromEntries(
    ["goals", "projects", "tasks", "plan_start_documents", "goal_measure_values"].map((t) => [
      t,
      count(t),
    ]),
  );
const commandRole = (p, statements) => db.tryRun(asCommandRole(p, statements, { end: "COMMIT" }));
// A definer called straight from the api role in p's own context (TypeScript bypassed), so
// its own checks under lock are proved, not the Worker's.
const asApiRole = (p, statement) => db.tryRun(asApi(p, statement), { user: "morrow_api_worker" });
const lastLine = (r) => r.stdout.trim().split("\n").at(-1);
// A start document written straight by the command role, shaped as cmd_plan_start_document
// stores it, so cmd_plan_start's own checks are reached even where the Worker refuses first.
function insertDocument(p, { purpose, target, records, draft = null }) {
  const id = randomUUID();
  const nonce = sha("nonce:" + id);
  const summary = sha("summary:" + id);
  const targetId =
    target.kind === "existing_project"
      ? literal(target.projectId)
      : target.kind === "area"
        ? literal(target.areaTemplateId)
        : "NULL";
  const targetRevision = target.kind === "existing_project" ? String(target.goalRevision) : "NULL";
  const draftSql =
    draft === null
      ? "NULL::jsonb"
      : `jsonb_build_object('messageId',${literal(draft.messageId)},'revision',${draft.revision},'digest',${literal(draft.digest)})`;
  const r = commandRole(
    p,
    `INSERT INTO morrow_work.plan_start_documents(organization_id,workspace_id,id,purpose,message_id,draft_revision,draft_digest,target_kind,target_id,target_revision,actor_principal_id,actor_membership_id,session_digest,nonce_digest,grant_summary_digest,canonical,digest,command_id,created_at,expires_at,consumed_at,consumed_command_id,purge_after)
 SELECT ${literal(p.org)},${literal(p.workspace)},${literal(id)},${literal(purpose)},${draft ? literal(draft.messageId) : "NULL"},${draft ? draft.revision : "NULL"},${draft ? literal(draft.digest) : "NULL"},${literal(target.kind)},${targetId},${targetRevision},${literal(p.principal)},${literal(p.membership)},${literal(p.digest)},${literal(sha(nonce))},${literal(summary)},c,morrow_work.sha256_text(c),${literal(randomUUID())},t,t+interval '5 minutes',NULL,NULL,t+interval '5 minutes'+interval '24 hours'
 FROM (SELECT t,jsonb_build_object('schemaVersion',1,'id',${literal(id)},'purpose',${literal(purpose)},'organizationId',${literal(p.org)},'workspaceId',${literal(p.workspace)},'actor',jsonb_build_object('principalId',${literal(p.principal)},'membershipId',${literal(p.membership)}),'draft',${draftSql},'target',${literal(JSON.stringify(target))}::jsonb,'records',${literal(JSON.stringify(records))}::jsonb,'grantSummaryDigest',${literal(summary)},'createdAt',morrow_work.utc_text(t),'expiresAt',morrow_work.utc_text(t+interval '5 minutes'))::text AS c FROM (SELECT ${now} AS t) x) y;`,
  );
  assert.ok(r.ok, r.stderr);
  const digest = db.sql(
    `SELECT digest FROM morrow_work.plan_start_documents WHERE id=${literal(id)};`,
  );
  return { id, digest, nonce, summary };
}
const startDefiner = (p, doc) =>
  asApiRole(
    p,
    `SELECT outcome FROM morrow_work.cmd_plan_start(${literal(randomUUID())},${literal(sha(randomUUID()))},'lab-plan-start',${literal(doc.digest)},${literal(sha(doc.nonce))},${literal(doc.summary)},'{}');`,
  );

test("held and off: the committed switch answers 503 with no document, lock or record", async () => {
  const before = counts();
  for (const [method, path, body] of [
    ["POST", "/plans/start-document", { card: { kind: "quick_tasks" } }],
    ["POST", "/plans/start", { documentDigest: "a".repeat(64), nonce: "b".repeat(64) }],
    ["GET", "/goals/goal_unknown/progress"],
  ]) {
    const r = await send(held, P.A, method, path, body);
    assert.equal(r.status, 503, path);
    assert.equal(r.body.code, "unavailable", path);
  }
  assert.deepEqual(counts(), before);
});

let quick;
test("Quick tasks: the Owner's own tap creates the one record; single use, one session, one actor", async () => {
  const before = counts();
  // Only the Owner (A) gets a Quick tasks document (ADR-0033 item 7): R holds every grant A
  // holds but is not the Owner.
  const notOwner = await send(open, P.R, "POST", "/plans/start-document", {
    card: { kind: "quick_tasks" },
  });
  assert.equal(notOwner.status, 403);
  assert.equal(notOwner.body.safeMessage, "Only the workspace owner can set up Quick tasks.");
  // A Member without workspace.project.create gets no document.
  const member = await send(open, P.C, "POST", "/plans/start-document", {
    card: { kind: "quick_tasks" },
  });
  assert.equal(member.status, 403);
  // An area waits for its agent (none is added in this lab).
  const area = await send(open, P.A, "POST", "/plans/start-document", {
    card: { kind: "area", areaTemplateId: "product_pages" },
  });
  assert.equal(area.status, 409);
  assert.equal(area.body.safeMessage, "Add this area's agent first.");
  assert.deepEqual(counts(), before);

  const issued = await send(open, P.A, "POST", "/plans/start-document", {
    card: { kind: "quick_tasks" },
  });
  assert.equal(issued.status, 201);
  const { document, documentDigest, nonce } = issued.body;
  assert.ok(validateCurrentDefinition("PlanStartDocument", document));
  assert.equal(document.purpose, "quick_tasks");
  const [row] = db.rows(
    `SELECT session_digest::text AS session,nonce_digest::text AS nonce,digest::text AS digest,canonical,consumed_at,(expires_at-created_at)::text AS window FROM morrow_work.plan_start_documents WHERE id=${literal(document.id)}`,
  );
  assert.equal(row.session, P.A.digest);
  assert.equal(row.nonce, sha(nonce));
  assert.equal(row.digest, documentDigest);
  assert.equal(sha(row.canonical), documentDigest);
  assert.equal(row.window, "00:05:00");
  assert.equal(row.consumed_at, null);

  // Another actor, even with the same grants, reads nothing: stale, nothing consumed.
  const other = await send(open, P.R, "POST", "/plans/start", { documentDigest, nonce });
  assert.equal(other.status, 409);
  // Another nonce: stale. Another session of the same person: actor_ineligible. Both are
  // refused by the definer under lock, and nothing is consumed.
  const wrongNonce = await send(open, P.A, "POST", "/plans/start", {
    documentDigest,
    nonce: "f".repeat(64),
  });
  assert.equal(wrongNonce.status, 409);
  const secondSecret = createHash("sha256").update(randomUUID()).digest().toString("base64url");
  db.admin(
    `INSERT INTO morrow_identity.sessions VALUES('session_a_second',${literal(P.A.principal)},${literal(P.A.org)},${literal(sha(secondSecret))},'workos','provider_session_a_second',clock_timestamp()+interval '1 day',NULL);`,
  );
  const otherSession = await send(
    open,
    P.A,
    "POST",
    "/plans/start",
    { documentDigest, nonce },
    { secret: secondSecret },
  );
  assert.equal(otherSession.status, 403);
  assert.equal(otherSession.body.safeMessage, "Only the person who asked can start this card.");
  assert.equal(count("plan_start_documents", "consumed_at IS NOT NULL"), 0);
  assert.equal(count("goals", "area_template_id IS NOT NULL"), 0);

  const key = randomUUID();
  const done = await send(open, P.A, "POST", "/plans/start", { documentDigest, nonce }, { key });
  assert.equal(done.status, 201);
  const { schemaVersion, ...result } = done.body;
  assert.equal(schemaVersion, 1);
  assert.ok(validateCurrentDefinition("PlanStartResult", result));
  assert.deepEqual([result.taskIds, result.routineIds, result.runs], [[], [], []]);
  quick = result;
  const [goal] = db.rows(
    `SELECT status,revision::int AS revision,area_template_id,due_at,owner_principal_id::text AS owner FROM morrow_work.goals WHERE id=${literal(quick.goalId)}`,
  );
  assert.deepEqual(goal, {
    status: "active",
    revision: 2,
    area_template_id: "quick_tasks",
    due_at: null,
    owner: P.A.principal,
  });
  const [project] = db.rows(
    `SELECT title,pin_position,goal_id::text AS goal,created_by_principal_id::text AS creator FROM morrow_work.projects WHERE id=${literal(quick.projectId)}`,
  );
  assert.deepEqual(project, {
    title: "Quick tasks",
    pin_position: null,
    goal: quick.goalId,
    creator: P.A.principal,
  });
  assert.equal(count("plan_start_documents", "consumed_at IS NOT NULL"), 1);
  assert.equal(count("commands", "command_type='plan.start'"), 1);
  // A replay returns the recorded result; the nonce is single use.
  const replay = await send(open, P.A, "POST", "/plans/start", { documentDigest, nonce }, { key });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.goalId, quick.goalId);
  assert.equal(replay.body.replayed, true);
  const reused = await send(open, P.A, "POST", "/plans/start", { documentDigest, nonce });
  assert.equal(reused.status, 409);
  // At most one Quick tasks record per workspace.
  const again = await send(open, P.A, "POST", "/plans/start-document", {
    card: { kind: "quick_tasks" },
  });
  assert.equal(again.status, 409);
  assert.equal(count("goals", "area_template_id='quick_tasks'"), 1);

  // The definers check the Owner themselves, before anything else: R's own document request
  // and R's own document (written straight, as if the Worker had issued it) are refused;
  // the Owner's same calls pass that check and meet the existing record.
  const issueAs = (p) => {
    const id = randomUUID();
    const summary = sha("summary:" + id);
    return lastLine(
      asApiRole(
        p,
        `SELECT r.outcome FROM (SELECT jsonb_build_object('schemaVersion',1,'id',${literal(id)},'purpose','quick_tasks','organizationId',${literal(p.org)},'workspaceId',${literal(p.workspace)},'actor',jsonb_build_object('principalId',${literal(p.principal)},'membershipId',${literal(p.membership)}),'draft',NULL::jsonb,'target',jsonb_build_object('kind','quick_tasks'),'records',jsonb_build_object('goal',jsonb_build_object('areaTemplateId','quick_tasks')),'grantSummaryDigest',${literal(summary)},'createdAt',to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text AS c) d,
 LATERAL morrow_work.cmd_plan_start_document(${literal(randomUUID())},${literal(sha(id))},'lab-plan-start',${literal(id)},d.c,encode(sha256(convert_to(d.c,'UTF8')),'hex'),${literal(sha("nonce:" + id))},${literal(summary)}) r;`,
      ),
    );
  };
  assert.equal(issueAs(P.R), "owner_only");
  assert.equal(issueAs(P.A), "state_conflict");
  const quickRecords = {
    goal: {
      objective: "Quick tasks",
      dueAt: null,
      areaTemplateId: "quick_tasks",
      successCriteria: [
        {
          description: "One-off jobs that fit nowhere else",
          verificationCapabilityId: null,
          evidenceRequired: false,
          key: "quick_tasks",
          measure: null,
        },
      ],
    },
    project: { title: "Quick tasks", pin: false },
    tasks: [],
    repeating: [],
  };
  const quickDocument = (p) =>
    insertDocument(p, {
      purpose: "quick_tasks",
      target: { kind: "quick_tasks" },
      records: quickRecords,
    });
  assert.equal(lastLine(startDefiner(P.R, quickDocument(P.R))), "owner_only");
  assert.equal(lastLine(startDefiner(P.A, quickDocument(P.A))), "state_conflict");
  assert.equal(count("goals", "area_template_id='quick_tasks'"), 1);
});

// A Morrow card, written as T4's Coordinator will (revision 1, no editor), asked by A.
const dueAt = new Date(Math.floor(Date.now() / 86400000) * 86400000 + 30 * 86400000).toISOString();
const projectCard = (over = {}) => ({
  schemaVersion: 1,
  kind: "project",
  title: "Tote in AI answers",
  why: "AI assistants should be able to name the tote.",
  doneWhen: "The tote's page has all 12 facts.",
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
      key: "photos",
      title: "Add the missing photos",
      assignee: { kind: "person", principalId: "person_b" },
      dependsOn: [],
      repeat: null,
    },
    {
      key: "review",
      title: "Review the page",
      assignee: { kind: "person", principalId: "person_a" },
      dependsOn: ["photos"],
      repeat: null,
    },
  ],
  target: { kind: "new_project", dueAt },
  ...over,
});
function insertCard(p, messageId, revision, draft, { taint = "none", editor = null } = {}) {
  assert.ok(planDraftValid(draft), "the lab's card is a valid PlanDraft@1");
  const text = canonical(draft);
  const editorSql =
    editor === null ? "NULL,NULL" : `${literal(editor.principal)},${literal(editor.membership)}`;
  const r = commandRole(
    p,
    `INSERT INTO morrow_work.plan_draft_revisions(organization_id,workspace_id,message_id,revision,kind,canonical,digest,asker_principal_id,asker_membership_id,editor_principal_id,editor_membership_id,context_taint,restricted_sources,created_at)
 VALUES(${literal(p.org)},${literal(p.workspace)},${literal(messageId)},${revision},${literal(draft.kind)},${literal(text)},${literal(sha(text))},${literal(p.principal)},${literal(p.membership)},${editorSql},${literal(taint)},'[]',${now});`,
  );
  return { ...r, digest: sha(text) };
}

let cardProject;
test("a Morrow card: only the asker, only the held digest; an edit keeps its taint; the start creates every piece", async () => {
  const first = insertCard(P.A, "message_card", 1, projectCard(), { taint: "untrusted_external" });
  assert.ok(first.ok, first.stderr);
  const before = counts();
  // Not the asker (owner question 2): R holds the same grants.
  const notAsker = await send(open, P.R, "POST", "/plans/start-document", {
    messageId: "message_card",
    draftDigest: first.digest,
  });
  assert.equal(notAsker.status, 403);
  // A digest the server does not hold.
  const unknown = await send(open, P.A, "POST", "/plans/start-document", {
    messageId: "message_card",
    draftDigest: "e".repeat(64),
  });
  assert.equal(unknown.status, 409);
  const v1 = await send(open, P.A, "POST", "/plans/start-document", {
    messageId: "message_card",
    draftDigest: first.digest,
  });
  assert.equal(v1.status, 201);
  assert.equal(v1.body.document.contextTaint, "untrusted_external");
  assert.deepEqual(v1.body.document.draft, {
    messageId: "message_card",
    revision: 1,
    digest: first.digest,
  });

  // A person's edit: a new revision naming its editor; it can never clear the taint.
  const cleared = insertCard(P.A, "message_card", 2, projectCard({ title: "Tote in answers" }), {
    editor: P.A,
  });
  assert.equal(cleared.ok, false);
  assert.match(cleared.stderr, /PLAN_DRAFT_INVALID/);
  const edited = insertCard(P.A, "message_card", 2, projectCard({ title: "Tote in answers" }), {
    taint: "untrusted_external",
    editor: P.A,
  });
  assert.ok(edited.ok, edited.stderr);
  // The document for revision 1 is now stale; nothing is written.
  const stale = await send(open, P.A, "POST", "/plans/start", {
    documentDigest: v1.body.documentDigest,
    nonce: v1.body.nonce,
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(counts(), { ...before, plan_start_documents: before.plan_start_documents + 1 });

  const v2 = await send(open, P.A, "POST", "/plans/start-document", {
    messageId: "message_card",
    draftDigest: edited.digest,
  });
  assert.equal(v2.status, 201);
  // A grant issued since the document changes the grant summary: stale, nothing written.
  const issued = fixtureGrant(
    P.A,
    "workspace.project.create",
    ["view", "execute"],
    ["goalId", "tabs", "title"],
    {
      id: "grant_a_project_create_2",
    },
  );
  db.admin(grantInsert(P.A, issued));
  const changed = await send(open, P.A, "POST", "/plans/start", {
    documentDigest: v2.body.documentDigest,
    nonce: v2.body.nonce,
  });
  assert.equal(changed.status, 409);
  assert.equal(count("projects"), before.projects);
  // Revoking that grant restores the summary the document bound (a revoked grant counts
  // for nothing), and the start goes through under A's live grants.
  db.admin(
    `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id='grant_a_project_create_2';`,
  );
  const done = await send(open, P.A, "POST", "/plans/start", {
    documentDigest: v2.body.documentDigest,
    nonce: v2.body.nonce,
  });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(done.body.taskIds.length, 2);
  assert.deepEqual(done.body.runs, []);
  cardProject = { projectId: done.body.projectId, goalId: done.body.goalId };
  const [goal] = db.rows(
    `SELECT status,area_template_id,to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS due,success_criteria FROM morrow_work.goals WHERE id=${literal(done.body.goalId)}`,
  );
  assert.equal(goal.status, "active");
  assert.equal(goal.area_template_id, null);
  assert.equal(goal.due, dueAt);
  assert.equal(goal.success_criteria[0].key, "facts");
  assert.equal(goal.success_criteria[0].measure.startRef, null);
  const [project] = db.rows(
    `SELECT title,pin_position FROM morrow_work.projects WHERE id=${literal(done.body.projectId)}`,
  );
  assert.deepEqual(project, { title: "Tote in answers", pin_position: 0 });
  const tasks = db.rows(
    `SELECT objective,owner_principal_id::text AS owner,initiator_principal_id::text AS initiator FROM morrow_work.tasks WHERE goal_id=${literal(done.body.goalId)} ORDER BY objective`,
  );
  assert.deepEqual(tasks, [
    { objective: "Add the missing photos", owner: P.B.principal, initiator: P.A.principal },
    { objective: "Review the page", owner: P.A.principal, initiator: P.A.principal },
  ]);
  assert.equal(count("task_assignments", `assignee_principal_id=${literal(P.B.principal)}`), 1);

  // `cancelled` needs every task ended (ADR-0033 item 5): both tasks are open.
  const cancel = commandRole(
    P.A,
    `UPDATE morrow_work.goals SET status='cancelled',revision=revision+1,updated_at=${now} WHERE id=${literal(done.body.goalId)};`,
  );
  assert.equal(cancel.ok, false);
  assert.match(cancel.stderr, /GOAL_TASKS_OPEN/);

  // Repeating steps wait for T5's routine records: refused, nothing written.
  const repeating = insertCard(
    P.A,
    "message_repeat",
    1,
    projectCard({
      title: "Weekly tote check",
      steps: [
        {
          key: "check",
          title: "Check the tote page",
          assignee: { kind: "person", principalId: "person_a" },
          dependsOn: [],
          repeat: { cadence: "weekly", goalKey: "facts" },
        },
      ],
    }),
  );
  assert.ok(repeating.ok, repeating.stderr);
  // Without workspace.routine.configure the kernel refuses the whole start.
  const denied = await send(open, P.A, "POST", "/plans/start-document", {
    messageId: "message_repeat",
    draftDigest: repeating.digest,
  });
  assert.equal(denied.status, 403);
  db.admin(
    grantInsert(
      P.A,
      fixtureGrant(
        P.A,
        "workspace.routine.configure",
        ["execute"],
        ["goalId", "goalKey", "installationId", "mandate", "schedule"],
      ),
    ),
  );
  const r1 = await send(open, P.A, "POST", "/plans/start-document", {
    messageId: "message_repeat",
    draftDigest: repeating.digest,
  });
  assert.equal(r1.status, 201);
  const beforeRepeat = counts();
  const r2 = await send(open, P.A, "POST", "/plans/start", {
    documentDigest: r1.body.documentDigest,
    nonce: r1.body.nonce,
  });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.safeMessage, "Repeating tasks can't be started from a card yet.");
  assert.deepEqual(counts(), beforeRepeat);
});

test("card digests: two cards with one draft, and an edit back to revision 1, are all kept", async () => {
  // The digest covers only the draft (PlanDraft has no message id), so two cards Morrow
  // drafts the same, for a repeated request or two people asking the same thing, share it.
  const same = projectCard({ title: "Same tote card" });
  const a = insertCard(P.A, "message_same_a", 1, same);
  assert.ok(a.ok, a.stderr);
  const b = insertCard(P.R, "message_same_b", 1, same);
  assert.ok(b.ok, b.stderr);
  assert.equal(a.digest, b.digest);
  // Each asker gets a document for their own card, by the shared digest.
  const forA = await send(open, P.A, "POST", "/plans/start-document", {
    messageId: "message_same_a",
    draftDigest: a.digest,
  });
  assert.equal(forA.status, 201, JSON.stringify(forA.body));
  assert.deepEqual(forA.body.document.draft, {
    messageId: "message_same_a",
    revision: 1,
    digest: a.digest,
  });
  // A person edits revision 1, then edits it back: revision 3 holds revision 1's draft.
  const second = insertCard(P.A, "message_same_a", 2, projectCard({ title: "Other tote card" }), {
    editor: P.A,
  });
  assert.ok(second.ok, second.stderr);
  const back = insertCard(P.A, "message_same_a", 3, same, { editor: P.A });
  assert.ok(back.ok, back.stderr);
  assert.equal(back.digest, a.digest);
  assert.equal(count("plan_draft_revisions", `digest=${literal(a.digest)}`), 3);
  // Revision 1's document is stale though its digest is current again: it binds revision 1.
  const before = counts();
  const stale = await send(open, P.A, "POST", "/plans/start", {
    documentDigest: forA.body.documentDigest,
    nonce: forA.body.nonce,
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(counts(), before);
  // A new document names revision 3.
  const forBack = await send(open, P.A, "POST", "/plans/start-document", {
    messageId: "message_same_a",
    draftDigest: a.digest,
  });
  assert.equal(forBack.status, 201, JSON.stringify(forBack.body));
  assert.equal(forBack.body.document.draft.revision, 3);
});

test("a plan change: revised against the project's current revision; another member's record needs administer", async () => {
  const revisionOf = () =>
    Number(
      db.sql(`SELECT revision FROM morrow_work.goals WHERE id=${literal(cardProject.goalId)};`),
    );
  const revision = revisionOf();
  const change = (p, goalRevision, title = "Add a photo check") => ({
    schemaVersion: 1,
    kind: "plan_change",
    title,
    why: "The photos need a second look.",
    doneWhen: "The tote's page has all 12 facts and its photos.",
    goals: [
      projectCard().goals[0],
      {
        key: "photos",
        description: "Three photos",
        measure: {
          kind: "checklist",
          checklistId: "product_facts_complete",
          productIds: ["product:2"],
          target: 12,
          dueAt: null,
          startRef: null,
        },
      },
    ],
    steps: [
      {
        key: "photo_check",
        title: "Check the photos",
        assignee: { kind: "person", principalId: p.principal },
        dependsOn: [],
        repeat: null,
      },
    ],
    target: { kind: "existing_project", projectId: cardProject.projectId, goalRevision },
  });
  const own = insertCard(P.A, "message_change", 1, change(P.A, revision));
  assert.ok(own.ok, own.stderr);
  const d = await send(open, P.A, "POST", "/plans/start-document", {
    messageId: "message_change",
    draftDigest: own.digest,
  });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.document.records.project, null);
  assert.equal(d.body.document.records.goal.dueAt, dueAt);
  const tasksBefore = count("tasks", `goal_id=${literal(cardProject.goalId)}`);
  const r = await send(open, P.A, "POST", "/plans/start", {
    documentDigest: d.body.documentDigest,
    nonce: d.body.nonce,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.goalId, r.body.projectId], [cardProject.goalId, null]);
  assert.equal(revisionOf(), revision + 1);
  // The revision is on the stream: one goal.revised (ids and revision only), so the goal's
  // aggregate revisions stay contiguous.
  const goalEvents = db.rows(
    `SELECT event_type,aggregate_revision::int AS revision,payload FROM morrow_work.outbox_events WHERE aggregate_type='goal' AND aggregate_id=${literal(cardProject.goalId)} ORDER BY aggregate_revision`,
  );
  assert.deepEqual(
    goalEvents.map((e) => e.revision),
    Array.from({ length: revision + 1 }, (_, i) => i + 1),
  );
  assert.deepEqual(goalEvents.at(-1), {
    event_type: "goal.revised",
    revision: revision + 1,
    payload: {},
  });
  const [goal] = db.rows(
    `SELECT success_criteria FROM morrow_work.goals WHERE id=${literal(cardProject.goalId)}`,
  );
  assert.deepEqual(
    goal.success_criteria.map((c) => c.key),
    ["facts", "photos"],
  );
  assert.equal(count("tasks", `goal_id=${literal(cardProject.goalId)}`), tasksBefore + 1);
  assert.equal(count("projects", `goal_id=${literal(cardProject.goalId)}`), 1);
  // A card drafted against the old revision is stale.
  const old = insertCard(P.A, "message_change_old", 1, change(P.A, revision, "Add a size check"));
  assert.ok(old.ok, old.stderr);
  const stale = await send(open, P.A, "POST", "/plans/start-document", {
    messageId: "message_change_old",
    draftDigest: old.digest,
  });
  assert.equal(stale.status, 409);
  // Another member's goal record: execute on workspace.goal.revise is not enough (the
  // revise route's own -> execute, other -> administer); administer is.
  db.admin(
    grantInsert(
      P.C,
      fixtureGrant(
        P.C,
        "workspace.goal.revise",
        ["execute"],
        ["dueAt", "expectedRevision", "goalId", "objective", "successCriteria"],
      ),
    ),
  );
  const theirs = insertCard(
    P.C,
    "message_change_c",
    1,
    change(P.C, revision + 1, "Add a care check"),
  );
  assert.ok(theirs.ok, theirs.stderr);
  const askC = () =>
    send(open, P.C, "POST", "/plans/start-document", {
      messageId: "message_change_c",
      draftDigest: theirs.digest,
    });
  // Without goal view the target is not found (the goal reads' rule), before any kernel.
  const unseen = await askC();
  assert.equal(unseen.status, 404, JSON.stringify(unseen.body));
  db.admin(
    grantInsert(
      P.C,
      fixtureGrant(
        P.C,
        "workspace.goal.create",
        ["view"],
        ["objective", "owner", "scope", "status", "successCriteria", "taskIds"],
      ),
    ),
  );
  const refused = await askC();
  assert.equal(refused.status, 403);
  const admin = insertCard(
    P.R,
    "message_change_r",
    1,
    change(P.R, revision + 1, "Add a fit check"),
  );
  assert.ok(admin.ok, admin.stderr);
  const allowed = await send(open, P.R, "POST", "/plans/start-document", {
    messageId: "message_change_r",
    draftDigest: admin.digest,
  });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));

  // Quick tasks is never revised (ADR-0033 item 7): a plan change aimed at its project is
  // refused by the Worker before any document, and by the start definer under lock.
  const quickRevision = Number(
    db.sql(`SELECT revision FROM morrow_work.goals WHERE id=${literal(quick.goalId)};`),
  );
  const toQuick = {
    ...change(P.A, quickRevision, "Measure quick tasks"),
    target: { kind: "existing_project", projectId: quick.projectId, goalRevision: quickRevision },
  };
  const quickCard = insertCard(P.A, "message_change_quick", 1, toQuick);
  assert.ok(quickCard.ok, quickCard.stderr);
  const before = counts();
  const refusedQuick = await send(open, P.A, "POST", "/plans/start-document", {
    messageId: "message_change_quick",
    draftDigest: quickCard.digest,
  });
  assert.equal(refusedQuick.status, 409, JSON.stringify(refusedQuick.body));
  assert.deepEqual(counts(), before);
  const forced = insertDocument(P.A, {
    purpose: "plan_card",
    target: toQuick.target,
    draft: { messageId: "message_change_quick", revision: 1, digest: quickCard.digest },
    records: {
      goal: {
        objective: toQuick.doneWhen,
        dueAt: null,
        areaTemplateId: null,
        successCriteria: toQuick.goals.map((g) => ({
          description: g.description,
          verificationCapabilityId: null,
          evidenceRequired: false,
          key: g.key,
          measure: g.measure,
        })),
      },
      project: null,
      tasks: [],
      repeating: [],
    },
  });
  assert.equal(lastLine(startDefiner(P.A, forced)), "state_conflict");
  const [quickGoal] = db.rows(
    `SELECT objective,revision::int AS revision,success_criteria FROM morrow_work.goals WHERE id=${literal(quick.goalId)}`,
  );
  assert.equal(quickGoal.objective, "Quick tasks");
  assert.equal(quickGoal.revision, quickRevision);
  assert.equal(quickGoal.success_criteria[0].measure, null);
});

// A measured area record, written directly by the command role (the area card needs an
// added agent, which this lab does not install): Product pages with its checklist and a
// hand check in ChatGPT over one product row.
const scope = (p) =>
  JSON.stringify({
    organizationId: p.org,
    workspaceId: p.workspace,
    storeIds: [],
    accountIds: [],
    resources: [workspaceResource(p.org, p.workspace)],
    fields: [],
  });
const areaCriteria = (over = {}) => [
  {
    description: "Every product has a complete listing",
    verificationCapabilityId: null,
    evidenceRequired: false,
    key: "pages_complete",
    measure: {
      kind: "checklist",
      checklistId: "product_facts_complete",
      productIds: [],
      target: 100,
      dueAt: null,
      startRef: null,
    },
  },
  {
    description: "AI assistants name your products",
    verificationCapabilityId: null,
    evidenceRequired: false,
    key: "ai_named",
    measure: {
      kind: "manual",
      assistant: "chatgpt",
      cadenceWeeks: 4,
      rows: [
        {
          productId: "product:1",
          checkItems: ["Does it name the tote?", "Does it give the price?"],
        },
      ],
      target: 2,
      dueAt: null,
      startRef: null,
      ...over,
    },
  },
];
const insertGoal = (p, id, criteria, { due = "NULL", area = "NULL" } = {}) =>
  commandRole(
    p,
    `INSERT INTO morrow_work.goals(organization_id,workspace_id,id,revision,status,objective,scope,success_criteria,owner_principal_id,owner_membership_id,created_by_principal_id,created_by_membership_id,created_at,updated_at,due_at,area_template_id)
 SELECT ${literal(p.org)},${literal(p.workspace)},${literal(id)},1,'draft','Every product has a complete listing',${literal(scope(p))}::jsonb,${literal(JSON.stringify(criteria))}::jsonb,${literal(p.principal)},${literal(p.membership)},${literal(p.principal)},${literal(p.membership)},t,t,${due},${area} FROM (SELECT ${now} AS t) x;`,
  );

test("goal records: CHECKs and guards refuse start values, a 4th measure, both kinds, achieved without Finish", () => {
  // A client-sent start value (startRef) never reaches a stored record.
  const withStart = areaCriteria({ startRef: "value_1" });
  let r = insertGoal(P.A, "goal_start", withStart, { area: "'product_pages'" });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /goals_valid_criteria/);
  // At most 3 measured goals.
  const four = [0, 1, 2, 3].map((i) => ({ ...areaCriteria()[0], key: "goal_" + i }));
  r = insertGoal(P.A, "goal_four", four, { area: "'product_pages'" });
  assert.match(r.stderr, /goals_(valid|project)_criteria/);
  assert.equal(r.ok, false);
  // A dated project or an area holds 1 to 3 goals, every one measured (ADR-0033 item 1).
  const note = {
    description: "A note",
    verificationCapabilityId: null,
    evidenceRequired: false,
    key: "note",
    measure: null,
  };
  r = insertGoal(P.A, "goal_unmeasured", [areaCriteria()[0], note], {
    due: `${now}+interval '30 days'`,
  });
  assert.match(r.stderr, /goals_project_criteria/);
  r = insertGoal(P.A, "goal_area_unmeasured", [note], { area: "'stock'" });
  assert.match(r.stderr, /goals_project_criteria/);
  // A dated record is never an area.
  r = insertGoal(P.A, "goal_both", areaCriteria(), {
    due: `${now}+interval '30 days'`,
    area: "'product_pages'",
  });
  assert.match(r.stderr, /goals_due_or_area/);
  // An unknown template.
  r = insertGoal(P.A, "goal_unknown", areaCriteria(), { area: "'warehouse'" });
  assert.match(r.stderr, /goals_area_template/);
  // The valid area record, made active.
  r = insertGoal(P.A, "goal_area", areaCriteria(), { area: "'product_pages'" });
  assert.ok(r.ok, r.stderr);
  r = commandRole(
    P.A,
    `UPDATE morrow_work.goals SET status='active',revision=2,updated_at=${now} WHERE id='goal_area';`,
  );
  assert.ok(r.ok, r.stderr);
  // A second Product pages record in the same workspace.
  r = insertGoal(P.A, "goal_area_2", areaCriteria(), { area: "'product_pages'" });
  assert.match(r.stderr, /goals_one_area/);
  // An area stays undated.
  r = commandRole(
    P.A,
    `UPDATE morrow_work.goals SET due_at=${now}+interval '1 day',revision=3,updated_at=${now} WHERE id='goal_area';`,
  );
  assert.match(r.stderr, /GOAL_KIND_IMMUTABLE/);
  // An area never ends, so its template is never blocked (at most one per template): with
  // no task at all, neither cancelled nor achieved (even with a results record).
  const areaResults = canonical({ goalId: "goal_area", goalRevision: 3, outcome: "achieved" });
  for (const statement of [
    `UPDATE morrow_work.goals SET status='cancelled',revision=3,updated_at=${now} WHERE id='goal_area';`,
    `INSERT INTO morrow_work.goal_finish_results VALUES(${literal(P.A.org)},${literal(P.A.workspace)},'goal_area',3,'achieved',${literal(areaResults)},${literal(sha(areaResults))},${literal(randomUUID())},${literal(P.A.principal)},${literal(P.A.membership)},${now});
 UPDATE morrow_work.goals SET status='achieved',revision=3,updated_at=${now} WHERE id='goal_area';`,
  ]) {
    r = commandRole(P.A, statement);
    assert.equal(r.ok, false);
    assert.match(r.stderr, /AREA_NEVER_ENDS/);
  }
  // Quick tasks is always open: never paused, cancelled or achieved.
  for (const status of ["paused", "cancelled", "achieved"]) {
    r = commandRole(
      P.A,
      `UPDATE morrow_work.goals SET status=${literal(status)},revision=revision+1,updated_at=${now} WHERE id=${literal(quick.goalId)};`,
    );
    assert.equal(r.ok, false, status);
    assert.match(r.stderr, /QUICK_TASKS_ALWAYS_OPEN/, status);
  }
  assert.equal(
    db.sql(`SELECT status FROM morrow_work.goals WHERE id=${literal(quick.goalId)};`),
    "active",
  );
  // `achieved` needs Finish's code-computed results record at that revision (a dated
  // project, made active).
  r = insertGoal(P.A, "goal_dated", areaCriteria(), { due: `${now}+interval '30 days'` });
  assert.ok(r.ok, r.stderr);
  r = commandRole(
    P.A,
    `UPDATE morrow_work.goals SET status='active',revision=2,updated_at=${now} WHERE id='goal_dated';`,
  );
  assert.ok(r.ok, r.stderr);
  r = commandRole(
    P.A,
    `UPDATE morrow_work.goals SET status='achieved',revision=3,updated_at=${now} WHERE id='goal_dated';`,
  );
  assert.equal(r.ok, false);
  assert.match(r.stderr, /GOAL_FINISH_RESULTS_MISSING/);
  const results = canonical({
    goalId: "goal_dated",
    goalRevision: 3,
    outcome: "achieved",
    goals: [{ key: "pages_complete", health: "done" }],
  });
  const withResults = db.tryRun(
    asCommandRole(
      P.A,
      `INSERT INTO morrow_work.goal_finish_results VALUES(${literal(P.A.org)},${literal(P.A.workspace)},'goal_dated',3,'achieved',${literal(results)},${literal(sha(results))},${literal(randomUUID())},${literal(P.A.principal)},${literal(P.A.membership)},${now});
 UPDATE morrow_work.goals SET status='achieved',revision=3,updated_at=${now} WHERE id='goal_dated';
 SELECT status FROM morrow_work.goals WHERE id='goal_dated';`,
    ),
  );
  assert.ok(withResults.ok, withResults.stderr);
  assert.equal(withResults.stdout.split("\n").at(-1), "achieved");
  assert.equal(
    db.sql("SELECT status FROM morrow_work.goals WHERE id='goal_dated';"),
    "active",
    "rolled back",
  );
  // Values: a customer-tagged value is never stored here; an order value keeps its clock.
  const value = (tags, cls, expires) =>
    commandRole(
      P.A,
      `INSERT INTO morrow_work.goal_measure_values(organization_id,workspace_id,id,goal_id,key,product_id,value,observed_at,recorder_kind,recorder_principal_id,recorder_membership_id,assistant,answers,counted,read_tags,data_class,expires_at,created_at)
 SELECT ${literal(P.A.org)},${literal(P.A.workspace)},${literal(randomUUID())},'goal_area','pages_complete',NULL,40,t,'code',NULL,NULL,NULL,'[]',true,${literal(JSON.stringify(tags))}::jsonb,${literal(cls)},${expires},t FROM (SELECT ${now} AS t) x;`,
    );
  r = value([{ storeId: "store_a", capability: "support.case.read" }], "work", "NULL");
  assert.match(r.stderr, /goal_measure_values_no_customer/);
  r = value([{ storeId: "store_a", capability: "orders.read" }], "order_aggregates", "NULL");
  assert.match(r.stderr, /goal_measure_values_clock/);
  r = value(
    [{ storeId: "store_a", capability: "orders.read" }],
    "order_aggregates",
    `${now}+interval '91 days'`,
  );
  assert.match(r.stderr, /goal_measure_values_clock/);
  r = value([], "work", "NULL");
  assert.ok(r.ok, r.stderr);
  r = commandRole(P.A, "UPDATE morrow_work.goal_measure_values SET value=41;");
  assert.equal(r.ok, false);
});

test("a person's hand check, revise and the per-viewer progress", async () => {
  // Answers per question, from the closed set; the value is how many named the product.
  const check = (p, over = {}) =>
    send(open, p, "POST", "/goals/goal_area/checks", {
      key: "ai_named",
      productId: "product:1",
      assistant: "chatgpt",
      answers: ["named_this_product", "named_no_shop"],
      ...over,
    });
  const counted = await check(P.A);
  assert.equal(counted.status, 201, JSON.stringify(counted.body));
  assert.equal(counted.body.counted, true);
  const elsewhere = await check(P.A, { assistant: "gemini" });
  assert.equal(elsewhere.status, 201);
  assert.equal(elsewhere.body.counted, false);
  const [row] = db.rows(
    `SELECT value::int AS value,recorder_kind,recorder_principal_id::text AS recorder,data_class,expires_at FROM morrow_work.goal_measure_values WHERE id=${literal(counted.body.valueId)}`,
  );
  assert.deepEqual(row, {
    value: 1,
    recorder_kind: "human",
    recorder: P.A.principal,
    data_class: "work",
    expires_at: null,
  });
  // One answer per question; another product row; a measure that is not a hand check.
  assert.equal((await check(P.A, { answers: ["named_this_product"] })).status, 400);
  assert.equal((await check(P.A, { productId: "product:2" })).status, 400);
  assert.equal((await check(P.A, { key: "pages_complete" })).status, 400);
  // A viewer without workspace.goal.measure.record.
  assert.equal((await check(P.V)).status, 403);
  // At most 3 checks per goal, key, product row and UTC day: the third (both questions name
  // the product) is kept, a fourth is refused and nothing is written.
  const third = await check(P.A, { answers: ["named_this_product", "named_this_product"] });
  assert.equal(third.status, 201, JSON.stringify(third.body));
  const valuesBefore = count("goal_measure_values", "goal_id='goal_area'");
  const fourth = await check(P.A);
  assert.equal(fourth.status, 409, JSON.stringify(fourth.body));
  assert.equal(fourth.body.code, "conflict");
  assert.equal(count("goal_measure_values", "goal_id='goal_area'"), valuesBefore);

  const progress = await send(open, P.A, "GET", "/goals/goal_area/progress");
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  assert.ok(validateCurrentDefinition("GoalProgress", progress.body.progress));
  assert.deepEqual(progress.body.progress.goals.map((g) => g.key).sort(), [
    "ai_named",
    "pages_complete",
  ]);
  // One check day in ChatGPT: the starting point, the day's latest counted check (2 named).
  const named = (body) => body.progress.goals.find((g) => g.key === "ai_named");
  assert.deepEqual(
    [named(progress.body).reason, named(progress.body).value.value],
    ["starting_point", 2],
  );
  // No goal view: the same 404 as an unknown record.
  assert.equal((await send(open, P.X, "GET", "/goals/goal_area/progress")).status, 404);
  assert.equal((await send(open, P.A, "GET", "/goals/goal_none/progress")).status, 404);

  // Revise: a person within 3 measured goals; never a start value; an area stays undated.
  const revision = Number(db.sql("SELECT revision FROM morrow_work.goals WHERE id='goal_area';"));
  const body = (over = {}) => ({
    expectedRevision: revision,
    objective: "Every product has a complete listing",
    dueAt: null,
    successCriteria: areaCriteria({ target: 3 }),
    ...over,
  });
  assert.equal(
    (
      await send(
        open,
        P.A,
        "POST",
        "/goals/goal_area/revise",
        body({ successCriteria: areaCriteria({ startRef: "v" }) }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await send(open, P.A, "POST", "/goals/goal_area/revise", body({ dueAt: dueAt }))).status,
    409,
  );
  assert.equal((await send(open, P.V, "POST", "/goals/goal_area/revise", body())).status, 403);
  const revised = await send(open, P.A, "POST", "/goals/goal_area/revise", body());
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.revision, revision + 1);
  // One goal.revised at the new revision, with the command's correlation; a refused revise
  // appends nothing.
  assert.deepEqual(
    db.rows(
      `SELECT aggregate_revision::int AS revision,payload FROM morrow_work.outbox_events WHERE event_type='goal.revised' AND aggregate_id='goal_area'`,
    ),
    [{ revision: revision + 1, payload: {} }],
  );
  assert.equal(
    (await send(open, P.A, "POST", "/goals/goal_area/revise", body())).status,
    409,
    "an old expectedRevision",
  );
  // A project's goals are 1 to 3, every one measured (ADR-0033 item 1): the body parser
  // refuses an unmeasured one, and so does the definer when the Worker is passed.
  const note = {
    description: "A note",
    verificationCapabilityId: null,
    evidenceRequired: false,
    key: "note",
    measure: null,
  };
  const withNote = [areaCriteria()[0], note];
  assert.equal(
    (
      await send(
        open,
        P.A,
        "POST",
        "/goals/goal_area/revise",
        body({ expectedRevision: revision + 1, successCriteria: withNote }),
      )
    ).status,
    400,
  );
  assert.equal(
    lastLine(
      asApiRole(
        P.A,
        `SELECT outcome FROM morrow_work.cmd_goal_revise(${literal(randomUUID())},${literal(sha(randomUUID()))},'lab-plan-start','goal_area',${literal(String(revision + 1))},'own','Every product has a complete listing',NULL,${literal(JSON.stringify(withNote))});`,
      ),
    ),
    "invalid",
  );
  // A revise to another assistant: the ChatGPT checks, stored as counted, no longer count
  // (ADR-0033 item 3), and the earlier Gemini check was never counted.
  const switched = await send(
    open,
    P.A,
    "POST",
    "/goals/goal_area/revise",
    body({
      expectedRevision: revision + 1,
      successCriteria: areaCriteria({ assistant: "gemini" }),
    }),
  );
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  const afterSwitch = await send(open, P.A, "GET", "/goals/goal_area/progress");
  assert.equal(afterSwitch.status, 200, JSON.stringify(afterSwitch.body));
  assert.deepEqual(
    [named(afterSwitch.body).reason, named(afterSwitch.body).value],
    ["not_checked_yet", null],
  );
  // A plain v1 goal record (neither a date nor an area) is not a project: never revised here.
  const plain = insertGoal(
    P.A,
    "goal_plain",
    [areaCriteria()[0]].map(({ key, measure, ...c }) => c),
  );
  assert.ok(plain.ok, plain.stderr);
  const plainRevise = await send(open, P.A, "POST", "/goals/goal_plain/revise", {
    expectedRevision: 1,
    objective: "Grow repeat purchases",
    dueAt: null,
    successCriteria: areaCriteria(),
  });
  assert.equal(plainRevise.status, 409);
  // Quick tasks is never revised: its unmeasured list is not a project's (400), and a
  // measured one meets the definer's refusal (409).
  const quickRevision = Number(
    db.sql(`SELECT revision FROM morrow_work.goals WHERE id=${literal(quick.goalId)};`),
  );
  const quickRevise = (successCriteria) =>
    send(open, P.A, "POST", `/goals/${quick.goalId}/revise`, {
      expectedRevision: quickRevision,
      objective: "Quick tasks",
      dueAt: null,
      successCriteria,
    });
  assert.equal(
    (
      await quickRevise([
        {
          description: "One-off jobs that fit nowhere else",
          verificationCapabilityId: null,
          evidenceRequired: false,
          key: "quick_tasks",
          measure: null,
        },
      ])
    ).status,
    400,
  );
  assert.equal((await quickRevise(areaCriteria())).status, 409);
});

test("a goal's values read stays bounded: thousands of values, the same judgement", async () => {
  // 2,400 code values for the dated project's checklist goal, 72 minutes apart over 120
  // days. The read once refused past 2,000 values; it now reads only what the judgement
  // uses, and the judgement equals code's over every value.
  const r = commandRole(
    P.A,
    `INSERT INTO morrow_work.goal_measure_values(organization_id,workspace_id,id,goal_id,key,product_id,value,observed_at,recorder_kind,recorder_principal_id,recorder_membership_id,assistant,answers,counted,read_tags,data_class,expires_at,created_at)
 SELECT ${literal(P.A.org)},${literal(P.A.workspace)},gen_random_uuid()::text,'goal_dated','pages_complete',NULL,(n%50)+10,t-make_interval(mins=>n*72),'code',NULL,NULL,NULL,'[]',true,'[]','work',NULL,t
 FROM (SELECT ${now} AS t) x,generate_series(1,2400) n;`,
  );
  assert.ok(r.ok, r.stderr);
  assert.equal(count("goal_measure_values", "goal_id='goal_dated'"), 2400);
  // The statement itself returns at most three rows for this one group of values.
  const read = asApiRole(
    P.A,
    `PREPARE goal_values(text) AS ${projectStatements.goalValues};
EXECUTE goal_values('goal_dated');`,
  );
  assert.ok(read.ok, read.stderr);
  const rows = read.stdout
    .trim()
    .split("\n")
    .filter((line) => line.includes("|"));
  assert.ok(rows.length >= 2 && rows.length <= 3, rows.join("\n"));

  const progress = await send(open, P.A, "GET", "/goals/goal_dated/progress");
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  const [record] = db.rows(
    `SELECT revision::int AS revision,status,success_criteria,(extract(epoch FROM created_at)*1000)::bigint AS created_ms,(extract(epoch FROM due_at)*1000)::bigint AS due_ms FROM morrow_work.goals WHERE id='goal_dated'`,
  );
  const all = db.rows(
    `SELECT key,value::float8 AS value,(extract(epoch FROM observed_at)*1000)::bigint AS at FROM morrow_work.goal_measure_values WHERE goal_id='goal_dated'`,
  );
  const expected = goalProgress(
    {
      id: "goal_dated",
      revision: record.revision,
      status: record.status,
      createdAtMs: Number(record.created_ms),
      dueAtMs: Number(record.due_ms),
      areaTemplateId: null,
      successCriteria: record.success_criteria,
    },
    all.map((v) => ({
      key: v.key,
      productId: null,
      value: v.value,
      observedAtMs: Number(v.at),
      counted: true,
      assistant: null,
      readTags: [],
      dataClass: "work",
      expiresAtMs: null,
    })),
    { mayView: () => true },
    {
      nowMs: Date.parse(progress.body.progress.computedAt),
      storeIds: [],
      finished: null,
      waitingOnViewer: false,
      audience: "viewer",
    },
  );
  assert.deepEqual(progress.body.progress, expected);
  const latest = all.reduce((a, b) => (Number(b.at) > Number(a.at) ? b : a));
  const facts = progress.body.progress.goals.find((g) => g.key === "pages_complete");
  assert.equal(facts.value.value, latest.value);
});

test("goal reads: a customer-class goal is seen only by members who may read customer data", async () => {
  const replied = {
    description: "Replied within a day",
    verificationCapabilityId: null,
    evidenceRequired: false,
    key: "replied_in_a_day",
    measure: {
      kind: "metric",
      metricId: "replied_within_a_day",
      target: 95,
      dueAt: null,
      startRef: null,
    },
  };
  let r = insertGoal(P.A, "goal_emails", [replied], { area: "'customer_emails'" });
  assert.ok(r.ok, r.stderr);
  r = insertGoal(P.A, "goal_mixed", [areaCriteria()[0], replied], {
    due: `${now}+interval '30 days'`,
  });
  assert.ok(r.ok, r.stderr);
  // No member here may view support.case.read on a store (none is installed), not even the
  // Owner: the Customer emails record holds only its customer goal, so it reads as absent;
  // the mixed record shows its other goal only.
  assert.equal((await send(work, P.A, "GET", "/goals/goal_emails")).status, 404);
  const mixed = await send(work, P.A, "GET", "/goals/goal_mixed");
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
  assert.ok(validateCurrentDefinition("Goal", mixed.body.goal));
  assert.deepEqual(
    mixed.body.goal.successCriteria.map((c) => c.key),
    ["pages_complete"],
  );
  assert.doesNotMatch(JSON.stringify(mixed.body), /replied/);
  // The list leaves the Customer emails record out and trims the mixed one.
  const listed = [];
  for (let after = null; ; ) {
    const page = await send(
      work,
      P.A,
      "GET",
      "/goals?limit=3" + (after === null ? "" : "&after=" + encodeURIComponent(after)),
    );
    assert.equal(page.status, 200, JSON.stringify(page.body));
    listed.push(...page.body.items);
    if (page.body.next === null) break;
    after = page.body.next;
  }
  const ids = listed.map((g) => g.id);
  assert.ok(!ids.includes("goal_emails"));
  assert.ok(ids.includes("goal_mixed") && ids.includes("goal_area") && ids.includes(quick.goalId));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, count("goals") - 1);
  assert.doesNotMatch(JSON.stringify(listed), /replied/);
  // The progress read and a revise answer the same 404 for the Customer emails record; a
  // revise of the mixed record is refused (it would replace a goal its author cannot see).
  assert.equal((await send(open, P.A, "GET", "/goals/goal_emails/progress")).status, 404);
  const revise = (goalId, dueAtValue) =>
    send(open, P.A, "POST", `/goals/${goalId}/revise`, {
      expectedRevision: 1,
      objective: "Every product has a complete listing",
      dueAt: dueAtValue,
      successCriteria: [areaCriteria()[0]],
    });
  assert.equal((await revise("goal_emails", null)).status, 404);
  assert.equal((await revise("goal_mixed", dueAt)).status, 403);
  const progress = await send(open, P.A, "GET", "/goals/goal_mixed/progress");
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  assert.deepEqual(
    progress.body.progress.goals.map((g) => g.key),
    ["pages_complete"],
  );
  assert.equal(
    db.sql(
      "SELECT jsonb_array_length(success_criteria) FROM morrow_work.goals WHERE id='goal_mixed';",
    ),
    "2",
  );

  // A plan change applies as revise does (ADR-0034 item 5). Both records become projects.
  for (const [project, goalId] of [
    ["project_mixed", "goal_mixed"],
    ["project_emails", "goal_emails"],
  ]) {
    const made = commandRole(
      P.A,
      `INSERT INTO morrow_work.projects(organization_id,workspace_id,id,revision,goal_id,title,pin_position,created_by_principal_id,created_by_membership_id,created_at,updated_at)
 SELECT ${literal(P.A.org)},${literal(P.A.workspace)},${literal(project)},1,${literal(goalId)},${literal(project)},NULL,${literal(P.A.principal)},${literal(P.A.membership)},t,t FROM (SELECT ${now} AS t) x;`,
    );
    assert.ok(made.ok, made.stderr);
  }
  const page = {
    key: "photos",
    description: "Three photos",
    measure: {
      kind: "checklist",
      checklistId: "product_facts_complete",
      productIds: ["product:2"],
      target: 12,
      dueAt: null,
      startRef: null,
    },
  };
  const change = (projectId, goals) => ({
    schemaVersion: 1,
    kind: "plan_change",
    title: "Photos too",
    why: "The photos need a look.",
    doneWhen: "Every page has its photos.",
    goals,
    steps: [
      {
        key: "photo_check",
        title: "Check the photos",
        assignee: { kind: "person", principalId: P.A.principal },
        dependsOn: [],
        repeat: null,
      },
    ],
    target: { kind: "existing_project", projectId, goalRevision: 1 },
  });
  const documentFor = async (messageId, draft) => {
    const card = insertCard(P.A, messageId, 1, draft);
    assert.ok(card.ok, card.stderr);
    return {
      card,
      response: await send(open, P.A, "POST", "/plans/start-document", {
        messageId,
        draftDigest: card.digest,
      }),
    };
  };
  const before = counts();
  // A goal-changing card for the mixed record would replace a goal A may not see: 403. The
  // Customer emails record reads as absent: 404 for any card. A steps-only card goes on.
  const hiddenChange = await documentFor("message_mixed", change("project_mixed", [page]));
  assert.equal(hiddenChange.response.status, 403, JSON.stringify(hiddenChange.response.body));
  assert.equal(
    (await documentFor("message_emails", change("project_emails", []))).response.status,
    404,
  );
  assert.deepEqual(counts(), before);
  const steps = await documentFor("message_mixed_steps", change("project_mixed", []));
  assert.equal(steps.response.status, 201, JSON.stringify(steps.response.body));
  assert.equal(steps.response.body.document.records.goal, null);
  // Under lock: a plan change that would drop the customer-class goal is refused, nothing
  // written; one that keeps it unchanged applies, with its goal.revised.
  const records = (criteria) => ({
    goal: {
      objective: "Every page has its photos.",
      dueAt,
      areaTemplateId: null,
      successCriteria: criteria,
    },
    project: null,
    tasks: [],
    repeating: [],
  });
  const criterion = {
    description: page.description,
    verificationCapabilityId: null,
    evidenceRequired: false,
    key: page.key,
    measure: page.measure,
  };
  const forced = (criteria) =>
    insertDocument(P.A, {
      purpose: "plan_card",
      target: { kind: "existing_project", projectId: "project_mixed", goalRevision: 1 },
      draft: { messageId: "message_mixed", revision: 1, digest: hiddenChange.card.digest },
      records: records(criteria),
    });
  const revisedEvents = () =>
    count("outbox_events", "event_type='goal.revised' AND aggregate_id='goal_mixed'");
  assert.equal(lastLine(startDefiner(P.A, forced([criterion]))), "state_conflict");
  assert.equal(
    lastLine(
      startDefiner(
        P.A,
        forced([criterion, { ...replied, measure: { ...replied.measure, target: 50 } }]),
      ),
    ),
    "state_conflict",
  );
  assert.equal(db.sql("SELECT revision FROM morrow_work.goals WHERE id='goal_mixed';"), "1");
  assert.equal(revisedEvents(), 0);
  // The same definer call, committed this time.
  const kept = forced([criterion, replied]);
  const committed = db.tryRun(
    asApi(
      P.A,
      `SELECT outcome FROM morrow_work.cmd_plan_start(${literal(randomUUID())},${literal(sha(randomUUID()))},'lab-plan-start',${literal(kept.digest)},${literal(sha(kept.nonce))},${literal(kept.summary)},'{}');`,
      { end: "COMMIT" },
    ),
    { user: "morrow_api_worker" },
  );
  assert.equal(lastLine(committed), "applied", committed.stderr);
  const [mixedGoal] = db.rows(
    "SELECT revision::int AS revision,success_criteria FROM morrow_work.goals WHERE id='goal_mixed'",
  );
  assert.equal(mixedGoal.revision, 2);
  assert.deepEqual(
    mixedGoal.success_criteria.map((c) => c.key),
    ["photos", "replied_in_a_day"],
  );
  assert.deepEqual(
    db.rows(
      "SELECT aggregate_revision::int AS revision,payload FROM morrow_work.outbox_events WHERE event_type='goal.revised' AND aggregate_id='goal_mixed'",
    ),
    [{ revision: 2, payload: {} }],
  );
});
