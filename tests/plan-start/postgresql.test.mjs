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
// per-viewer progress read. Synthetic fixtures only; no provider, credential or merchant
// data. Run by `npm run lab:plan-start` (CI's postgres `work` leg).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createProjectsApiHandler } from "../../packages/work/src/projects/http.ts";
import { planDraftsRecord, planDraftValid } from "../../packages/policy/src/projects/index.ts";
import { validateCurrentDefinition } from "../../packages/contracts/src/validation.ts";
import {
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
let db, release, started, P, held, open;
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
test("Quick tasks: the person's own tap creates the one record; single use, one session, one actor", async () => {
  const before = counts();
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
 VALUES(${literal(p.org)},${literal(p.workspace)},${literal(messageId)},${revision},${literal(draft.kind)},${literal(text)},${literal(sha(text))},${literal(P.A.principal)},${literal(P.A.membership)},${editorSql},${literal(taint)},'[]',${now});`,
  );
  return { ...r, digest: sha(text) };
}

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
  assert.match(r.stderr, /goals_valid_criteria/);
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
  // `achieved` needs Finish's code-computed results record at that revision.
  r = commandRole(
    P.A,
    `UPDATE morrow_work.goals SET status='achieved',revision=3,updated_at=${now} WHERE id='goal_area';`,
  );
  assert.equal(r.ok, false);
  assert.match(r.stderr, /GOAL_FINISH_RESULTS_MISSING/);
  const results = canonical({ goalId: "goal_area", goalRevision: 3, outcome: "achieved" });
  const withResults = db.tryRun(
    asCommandRole(
      P.A,
      `INSERT INTO morrow_work.goal_finish_results VALUES(${literal(P.A.org)},${literal(P.A.workspace)},'goal_area',3,'achieved',${literal(results)},${literal(sha(results))},${literal(randomUUID())},${literal(P.A.principal)},${literal(P.A.membership)},${now});
 UPDATE morrow_work.goals SET status='achieved',revision=3,updated_at=${now} WHERE id='goal_area';
 SELECT status FROM morrow_work.goals WHERE id='goal_area';`,
    ),
  );
  assert.ok(withResults.ok, withResults.stderr);
  assert.equal(withResults.stdout.split("\n").at(-1), "achieved");
  assert.equal(
    db.sql("SELECT status FROM morrow_work.goals WHERE id='goal_area';"),
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
  r = value([{ storeId: "store_a", capabilityId: "support.case.read" }], "work", "NULL");
  assert.match(r.stderr, /goal_measure_values_no_customer/);
  r = value([{ storeId: "store_a", capabilityId: "orders.read" }], "order_aggregates", "NULL");
  assert.match(r.stderr, /goal_measure_values_clock/);
  r = value(
    [{ storeId: "store_a", capabilityId: "orders.read" }],
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

  const progress = await send(open, P.A, "GET", "/goals/goal_area/progress");
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  assert.ok(validateCurrentDefinition("GoalProgress", progress.body.progress));
  assert.deepEqual(progress.body.progress.goals.map((g) => g.key).sort(), [
    "ai_named",
    "pages_complete",
  ]);
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
  assert.equal(
    (await send(open, P.A, "POST", "/goals/goal_area/revise", body())).status,
    409,
    "an old expectedRevision",
  );
  // Quick tasks is never revised.
  const quickRevision = Number(
    db.sql(`SELECT revision FROM morrow_work.goals WHERE id=${literal(quick.goalId)};`),
  );
  const quickRevise = await send(open, P.A, "POST", `/goals/${quick.goalId}/revise`, {
    expectedRevision: quickRevision,
    objective: "Quick tasks",
    dueAt: null,
    successCriteria: [
      {
        description: "One-off jobs that fit nowhere else",
        verificationCapabilityId: null,
        evidenceRequired: false,
        key: "quick_tasks",
        measure: null,
      },
    ],
  });
  assert.equal(quickRevise.status, 409);
});
