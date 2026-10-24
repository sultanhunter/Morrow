// Tenant-isolation probes P1-P6 (P06.T01a §4.12; P5 is AC15 in the PostgreSQL lab)
// against a real PostgreSQL 17 engine. Run by `npm run lab:tenant-conformance`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createWorkApiHandler } from "../../packages/work/src/http.ts";
import {
  normalizeInvoice,
  stripeObjectDigest,
} from "../../packages/work/src/billing/stripe-objects.ts";
import { stripeFixture } from "../fixtures/stripe-fixtures.mjs";
import {
  asApi,
  asCommandRole,
  literal,
  restoreSql,
  revocationSql,
  seedWorkFixtures,
  sha,
  storeInstallationSql,
  withWorkDatabase,
  workFixtureOrigin,
  workRequest,
  workspaceResource,
} from "./harness.mjs";
import { workFunctions, workRouteProbes, workRoutes, workTables } from "./registry.mjs";
import { conformanceReport, recordConformance } from "./report.mjs";

conformanceReport("probes");
let db, release, started, P, handler;
const records = {};
before(async () => {
  let ready;
  const opened = new Promise((resolve) => (ready = resolve));
  // The hosted administrator shape (ADR-0020, P04.T01j D7): a non-superuser CREATEROLE
  // login applies the chain with the D4 runner protocol.
  started = withWorkDatabase(
    "P06.T01a.conformance-probes",
    (context) => {
      db = context;
      ready();
      return new Promise((resolve) => (release = resolve));
    },
    { administrator: "createrole" },
  );
  await Promise.race([opened, started]);
  P = seedWorkFixtures(db);
  handler = createWorkApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
  });
  // One goal, task and question per tenant: A in W, A2 in W2, Y in W'.
  for (const [owner, respondent] of [
    [P.A, P.B],
    [P.A2, P.A2],
    [P.Y, P.Y],
  ]) {
    const goal = await send(owner, "POST", "/goals", goalBody());
    const task = await send(owner, "POST", "/tasks", {
      goalId: goal.body.goalId,
      objective: "Probe task",
      allowedResources: [],
    });
    const question = await send(owner, "POST", "/tasks/" + task.body.taskId + "/questions", {
      question: "Probe question?",
      respondentId: respondent.principal,
    });
    assert.deepEqual([goal.status, task.status, question.status], [201, 201, 201]);
    records[owner.key] = {
      goal: goal.body.goalId,
      task: task.body.taskId,
      question: question.body.questionId,
    };
  }
});
after(async () => {
  release?.();
  await started;
});
function goalBody() {
  return {
    objective: "Probe goal",
    storeIds: [],
    successCriteria: [
      { description: "Probe", verificationCapabilityId: null, evidenceRequired: false },
    ],
  };
}
async function send(p, method, path, body, options) {
  const response = await handler.fetch(workRequest(p, method, path, body, options), undefined, {
    waitUntil() {},
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}
const withoutCorrelation = (text) => JSON.stringify({ ...JSON.parse(text), correlationId: null });
// A cmd_proposal_submit call whose scalars and document shape are valid, built in
// SQL so createdAt is database time and every digest covers its text.
function submitProbe(command, digest, task, basis = "own") {
  const doc = `jsonb_build_object('id','proposal_probe','capabilityId','governance.grants.revise','createdAt',to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt','2026-12-31T00:00:00.000Z','targets',jsonb_build_array('{}'::jsonb),'maximumCredits','0','partialApproval','all_or_nothing','beneficiaryPrincipalIds','[]'::jsonb,'parametersRef',jsonb_build_object('id','params_probe'),'derivedFrom',NULL,'taskId','${task}')::text`;
  return `SELECT x.outcome FROM (SELECT ${doc} AS c) d, morrow_work.cmd_proposal_submit('${command}','${digest}','corr','${task}','${basis}','${randomUUID()}',NULL,'${"a".repeat(64)}','{}','${sha("{}")}',d.c,encode(sha256(convert_to(d.c,'UTF8')),'hex'),'{}') x`;
}
const apiSql = (p, statements, options) =>
  db.sql(asApi(p, statements, options), { user: "morrow_api_worker" });
const counts = () =>
  db.rows(
    "SELECT " +
      Object.keys(workTables)
        .map((t) => `(SELECT count(*) FROM morrow_work.${t})::int AS ${t}`)
        .join(","),
  )[0];

test("P1: with no context both roles see zero rows and every api function is ineligible", () => {
  const readable = Object.entries(workTables)
    .filter(([, t]) => t.class === "tenant_readable")
    .map(([name]) => name);
  for (const table of readable) {
    const out = db.sql(
      `BEGIN READ ONLY; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM morrow_work.${table}; COMMIT;`,
      { user: "morrow_api_worker" },
    );
    assert.equal(out, "0", table);
  }
  for (const table of Object.keys(workTables).filter((t) => workTables[t].class !== "platform")) {
    const out = db.sql(
      `BEGIN READ ONLY; SET LOCAL ROLE morrow_work_command; SELECT count(*) FROM morrow_work.${table}; COMMIT;`,
    );
    assert.equal(out, "0", table);
  }
  const uuid = randomUUID(),
    digest = "a".repeat(64);
  const calls = {
    "begin_command(text,text,text)": `SELECT outcome FROM morrow_work.begin_command('goal.create','${uuid}','${digest}')`,
    "cmd_goal_create(text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_goal_create('${uuid}','${digest}','corr','x','[{"description":"d","verificationCapabilityId":null,"evidenceRequired":false}]')`,
    "cmd_goal_transition(text,text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_goal_transition('${uuid}','${digest}','corr','${records.A.goal}','active','1','own')`,
    "cmd_task_create(text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_task_create('${uuid}','${digest}','corr','${records.A.goal}','x','[]')`,
    "cmd_task_ready(text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_task_ready('${uuid}','${digest}','corr','${records.A.task}','1','own')`,
    "cmd_task_assign(text,text,text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_task_assign('${uuid}','${digest}','corr','${records.A.task}','${P.B.principal}','1','own','${digest}')`,
    "cmd_question_request(text,text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_question_request('${uuid}','${digest}','corr','${records.A.task}','x','${P.B.principal}','${digest}')`,
    "cmd_question_answer(text,text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_question_answer('${uuid}','${digest}','corr','${records.A.question}','${randomUUID()}','x','1')`,
    "cmd_question_cancel(text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_question_cancel('${uuid}','${digest}','corr','${records.A.question}','1','own')`,
    // P06.T01b: every scalar is well-formed, so only the missing context refuses.
    "begin_approval_command(text,text,text)": `SELECT outcome FROM morrow_work.begin_approval_command('approval.decide','${uuid}','${digest}')`,
    "cmd_proposal_submit(text,text,text,text,text,text,text,text,text,text,text,text,text)":
      submitProbe(uuid, digest, records.A.task),
    "cmd_approval_decide(text,text,text,text,text,text,text,text,text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_approval_decide('${uuid}','${digest}','corr','proposal_absent','1','approve',NULL,'${digest}',NULL,NULL,NULL,NULL,NULL,'{"evaluatedAt":"2026-10-19T00:00:00.000Z","reviewers":[]}')`,
    "cmd_approval_withdraw(text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_approval_withdraw('${uuid}','${digest}','corr','proposal_absent','1')`,
    // M3 PR-1: the agent commands, each with well-formed scalars and documents.
    "begin_agent_command(text,text,text)": `SELECT outcome FROM morrow_work.begin_agent_command('installation.stop','${uuid}','${digest}')`,
    "cmd_listings_enable_document(text,text,text,text,text,text,text,text,text,text)": `SELECT x.outcome FROM (SELECT '{"createdAt":"2026-10-20T00:00:00.000Z"}'::text AS c) d, morrow_work.cmd_listings_enable_document('${uuid}','${digest}','corr','store_probe','enable','installation_probe','${randomUUID()}',d.c,encode(sha256(convert_to(d.c,'UTF8')),'hex'),'${digest}') x`,
    "cmd_listings_enable(text,text,text,text,text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_listings_enable('${uuid}','${digest}','corr','store_probe','${digest}','${digest}',NULL,NULL,NULL,NULL)`,
    "cmd_stop_ai_work(text,text,text,text,text,text,text)": `SELECT x.outcome FROM (SELECT '{"id":"record_probe","createdAt":"2026-10-20T00:00:00.000Z"}'::text AS c) d, morrow_work.cmd_stop_ai_work('${uuid}','${digest}','corr','store_probe','installation_probe',d.c,encode(sha256(convert_to(d.c,'UTF8')),'hex')) x`,
    "cmd_model_default_revise(text,text,text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_model_default_revise('${uuid}','${digest}','corr','1','claude_sonnet_5_5','low','1',NULL)`,
    // M2 PR-3: the catalogue routes' read lease.
    "catalog_read_lease(text,text)": `SELECT outcome FROM morrow_work.catalog_read_lease('store_probe','connection_probe')`,
    // M3 PR-2: run admission and reconciliation, every scalar well-formed.
    "begin_run_command(text,text,text)": `SELECT outcome FROM morrow_work.begin_run_command('run.admit','${uuid}','${digest}')`,
    "cmd_run_admit(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)": `SELECT x.outcome FROM (SELECT '{"schemaVersion":1}'::text AS c) d, morrow_work.cmd_run_admit('${uuid}','${digest}','corr','${records.A.task}','store_probe','${randomUUID()}','${randomUUID()}','${randomUUID()}','${randomUUID()}','1','claude_sonnet_5_5','low','false','["product:1"]','["title"]',d.c,encode(sha256(convert_to(d.c,'UTF8')),'hex'),'agent_${randomUUID()}','${randomUUID()}','listings-run@1') x`,
    "cmd_runs_reconcile(text,text,text)": `SELECT outcome FROM morrow_work.cmd_runs_reconcile('${uuid}','${digest}','corr')`,
    // v1 PR 2: "Disconnect store", every scalar and the record well-formed.
    "begin_connection_command(text,text,text)": `SELECT outcome FROM morrow_work.begin_connection_command('connection.disconnect','${uuid}','${digest}')`,
    "cmd_store_disconnect(text,text,text,text,text,text)": `SELECT x.outcome FROM (SELECT '{"id":"record_probe","createdAt":"2026-10-23T00:00:00.000Z"}'::text AS c) d, morrow_work.cmd_store_disconnect('${uuid}','${digest}','corr','connection_probe',d.c,encode(sha256(convert_to(d.c,'UTF8')),'hex')) x`,
    // v1 PR 3: the claim (a well-formed item list) and one operation's dispatch check.
    "cmd_catalog_apply(text,text,text,text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_catalog_apply('${uuid}','${digest}','approval_absent','1','${digest}','proposal_absent','${digest}','{"evaluatedAt":"2026-10-23T00:00:00.000Z","reviewers":[]}','[{"targetIndex":0,"canonical":"{}","digest":"${digest}"}]')`,
    "cmd_catalog_dispatch(text,text)": `SELECT outcome FROM morrow_work.cmd_catalog_dispatch('${randomUUID()}',NULL)`,
    "cmd_catalog_set_aside(text)": `SELECT outcome FROM morrow_work.cmd_catalog_set_aside('${randomUUID()}')`,
    // PR 18 (0046): the goal and plan-start commands, every scalar and document well-formed.
    "begin_project_command(text,text,text)": `SELECT outcome FROM morrow_work.begin_project_command('plan.start','${uuid}','${digest}')`,
    "cmd_goal_revise(text,text,text,text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_goal_revise('${uuid}','${digest}','corr','${records.A.goal}','1','own','x',NULL,'[{"description":"d","verificationCapabilityId":null,"evidenceRequired":false}]')`,
    "cmd_goal_check(text,text,text,text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_goal_check('${uuid}','${digest}','corr','${records.A.goal}','named','product:1','chatgpt','["named_no_shop"]','${randomUUID()}')`,
    "cmd_plan_start_document(text,text,text,text,text,text,text,text)": (() => {
      const id = randomUUID();
      const doc = JSON.stringify({
        schemaVersion: 1,
        id,
        purpose: "quick_tasks",
        createdAt: "2026-10-24T00:00:00.000Z",
        grantSummaryDigest: digest,
        records: { goal: { areaTemplateId: "quick_tasks" } },
        target: { kind: "quick_tasks" },
        draft: null,
      });
      return `SELECT x.outcome FROM (SELECT '${doc}'::text AS c) d, morrow_work.cmd_plan_start_document('${uuid}','${digest}','corr','${id}',d.c,encode(sha256(convert_to(d.c,'UTF8')),'hex'),'${digest}','${digest}') x`;
    })(),
    "cmd_plan_start(text,text,text,text,text,text,text)": `SELECT outcome FROM morrow_work.cmd_plan_start('${uuid}','${digest}','corr','${digest}','${digest}','${digest}','{}')`,
  };
  for (const [signature, spec] of Object.entries(workFunctions).filter(
    ([, f]) => f.kind === "api",
  )) {
    if (signature === "enter_context(text,text)") {
      // Only the api Worker's login may enter a context; a superuser session may not.
      assert.equal(
        db.sql(
          `SET ROLE morrow_work_command; SELECT count(*) FROM morrow_work.enter_context('${P.A.digest}','${P.A.workspace}');`,
        ),
        "0",
      );
      continue;
    }
    if (signature === "run_interrupted(text)") {
      // M3 PR-2: the scalar read answers null without a context.
      const out = db.sql(
        `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT COALESCE(morrow_work.run_interrupted('${randomUUID()}')::text,'null'); COMMIT;`,
        { user: "morrow_api_worker" },
      );
      assert.equal(out, "null", signature);
      continue;
    }
    if (spec.read) {
      // The P06.T01b read definers return no row without a context.
      const call = {
        "review_context(text,text)": "morrow_work.review_context('governance.grants.revise',NULL)",
        "review_candidates(text,text,text,text)":
          "morrow_work.review_candidates('governance.grants.revise','[]',NULL,'25')",
        "reviewer_snapshot(text,text)": `morrow_work.reviewer_snapshot('governance.grants.revise','["${P.B.principal}"]')`,
        // M3 PR-1.
        "store_association(text)": "morrow_work.store_association('store_probe')",
        "agent_enable_document(text)": `morrow_work.agent_enable_document('${"a".repeat(64)}')`,
        // v1 PR 2.
        "connection_target(text)": "morrow_work.connection_target('connection_probe')",
        // v1 PR 3.
        "catalog_review_sources(text)": "morrow_work.catalog_review_sources('proposal_absent')",
        "catalog_claim_of(text)": "morrow_work.catalog_claim_of('proposal_absent')",
        // PR 18: the actor's own start document.
        "plan_start_document(text)": `morrow_work.plan_start_document('${"a".repeat(64)}')`,
      }[signature];
      assert.ok(call, signature);
      const out = db.sql(
        `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM ${call}; COMMIT;`,
        { user: "morrow_api_worker" },
      );
      assert.equal(out, "0", signature);
      continue;
    }
    if (signature === "target_member(text)") {
      const out = db.sql(
        `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM morrow_work.target_member('${P.B.principal}'); COMMIT;`,
        { user: "morrow_api_worker" },
      );
      assert.equal(out, "0");
      continue;
    }
    assert.ok(calls[signature], "probe for " + signature + " " + spec.kind);
    const out = db.sql(`BEGIN; SET LOCAL ROLE morrow_work_api; ${calls[signature]}; ROLLBACK;`, {
      user: "morrow_api_worker",
    });
    assert.equal(out, "ineligible", signature);
  }
  recordConformance("P1", true);
});

test("P2: random, cross-tenant, session-level and forged-snapshot contexts confer nothing", async () => {
  const W = P.A.workspace;
  // A random digest; Y's (organization P) digest with A's workspace.
  for (const digest of [sha(randomUUID()), P.Y.digest]) {
    assert.equal(
      apiSql(P.A, "SELECT count(*) FROM morrow_work.goals;", { digest }).split("\n").at(-1),
      "0",
    );
    const forged = db.sql(
      `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT set_config('morrow.work_session_digest',${literal(digest)},true),set_config('morrow.work_workspace',${literal(W)},true) IS NOT NULL; SELECT count(*) FROM morrow_work.goals; ROLLBACK;`,
      { user: "morrow_api_worker" },
    );
    assert.equal(forged.split("\n").at(-1), "0");
  }
  // A session-level SET of a forged digest, then a valid enter_context: refused.
  const sessionLevel = db.sql(
    `SET morrow.work_session_digest=${literal(sha(randomUUID()))}; SET morrow.work_workspace=${literal(W)};
BEGIN; SET LOCAL ROLE morrow_work_api; SELECT count(*) FROM morrow_work.enter_context(${literal(P.A.digest)},${literal(W)}); SELECT count(*) FROM morrow_work.goals; ROLLBACK;`,
    { user: "morrow_api_worker" },
  );
  assert.deepEqual(sessionLevel.split("\n").slice(-2), ["0", "0"]);
  // Forged snapshot settings after a valid enter_context: the command is refused.
  for (const [setting, value] of [
    ["morrow.work_policy_revision", "999"],
    ["morrow.work_grants_digest", "b".repeat(64)],
    ["morrow.work_principal_id", P.B.principal],
    ["morrow.work_evaluated_at_us", "9000000000000000"],
  ]) {
    const out = apiSql(
      P.A,
      `SELECT set_config(${literal(setting)},${literal(value)},true) IS NOT NULL; SELECT outcome FROM morrow_work.cmd_goal_transition('${randomUUID()}','${"c".repeat(64)}','corr',${literal(records.A.goal)},'active','1','own');`,
    );
    assert.ok(["ineligible", "stale_authority"].includes(out.split("\n").at(-1)), setting);
  }
  // None survives a revocation.
  db.sql(revocationSql(P.R));
  try {
    assert.equal(apiSql(P.R, "SELECT count(*) FROM morrow_work.goals;").split("\n").at(-1), "0");
    const forged = db.sql(
      `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT set_config('morrow.work_session_digest',${literal(P.R.digest)},true),set_config('morrow.work_workspace',${literal(W)},true) IS NOT NULL; SELECT count(*) FROM morrow_work.goals; ROLLBACK;`,
      { user: "morrow_api_worker" },
    );
    assert.equal(forged.split("\n").at(-1), "0");
  } finally {
    db.sql(restoreSql(P.R));
  }
  recordConformance("P2", true);
});

test("P3: foreign IDs are byte-identical not-found everywhere and writes cannot cross tenants", async () => {
  const before = counts();
  const absent = {
    goal: "goal_absent_" + randomUUID(),
    task: "task_absent_" + randomUUID(),
    question: "question_absent_" + randomUUID(),
  };
  const bodies = {
    task_create: (ids) => ({ goalId: ids.goal, objective: "Foreign", allowedResources: [] }),
    assign: () => ({ assigneeId: P.B.principal, expectedRevision: 1 }),
    question: () => ({ question: "Foreign?", respondentId: P.B.principal }),
  };
  const path = (route, ids) =>
    route.pattern
      .replace(":goalId", ids.goal)
      .replace(":taskId", ids.task)
      .replace(":questionId", ids.question);
  let probed = 0;
  for (const route of workRoutes) {
    const name = route.method + " " + route.pattern;
    const probe = workRouteProbes[name];
    if (probe.records.length === 0) continue;
    const request = async (ids) => {
      const body =
        route.method === "GET"
          ? undefined
          : typeof probe.body === "string"
            ? bodies[probe.body](ids)
            : probe.body;
      const suffix = name === "GET /tasks" ? "?goalId=" + ids.goal : "";
      return send(P.A, route.method, path(route, ids) + suffix, body);
    };
    const reference = await request(absent);
    assert.equal(reference.status, 404, name);
    for (const foreign of [records.A2, records.Y]) {
      const reply = await request(foreign);
      assert.equal(reply.status, 404, name);
      assert.equal(withoutCorrelation(reply.text), withoutCorrelation(reference.text), name);
    }
    probed++;
  }
  assert.ok(probed >= 12);
  // Lists never include foreign rows.
  for (const list of ["/goals", "/tasks", "/questions?respondent=me"]) {
    const reply = await send(P.A, "GET", list);
    assert.equal(reply.status, 200);
    const ids = reply.body.items.map((i) => i.id);
    for (const foreign of [records.A2, records.Y])
      assert.ok(!Object.values(foreign).some((id) => ids.includes(id)), list);
  }
  // Every command function in A's context with foreign IDs: not_found, nothing written.
  for (const foreign of [records.A2, records.Y]) {
    const k = () => randomUUID();
    const d = "d".repeat(64);
    const calls = [
      `SELECT outcome FROM morrow_work.cmd_goal_transition('${k()}','${d}','corr','${foreign.goal}','active','1','other')`,
      `SELECT outcome FROM morrow_work.cmd_task_create('${k()}','${d}','corr','${foreign.goal}','x','[]')`,
      `SELECT outcome FROM morrow_work.cmd_task_ready('${k()}','${d}','corr','${foreign.task}','1','other')`,
      `SELECT outcome FROM morrow_work.cmd_task_assign('${k()}','${d}','corr','${foreign.task}','${P.B.principal}','1','other','${d}')`,
      `SELECT outcome FROM morrow_work.cmd_question_request('${k()}','${d}','corr','${foreign.task}','x','${P.B.principal}','${d}')`,
      `SELECT outcome FROM morrow_work.cmd_question_answer('${k()}','${d}','corr','${foreign.question}','${k()}','x','1')`,
      `SELECT outcome FROM morrow_work.cmd_question_cancel('${k()}','${d}','corr','${foreign.question}','1','other')`,
      // P06.T01b: a foreign task to attach to, and proposals no tenant policy shows.
      submitProbe(k(), d, foreign.task, "other"),
      `SELECT outcome FROM morrow_work.cmd_approval_decide('${k()}','${d}','corr','${foreign.task}','1','approve',NULL,'${d}',NULL,NULL,NULL,NULL,NULL,'{"evaluatedAt":"2026-10-19T00:00:00.000Z","reviewers":[]}')`,
      `SELECT outcome FROM morrow_work.cmd_approval_withdraw('${k()}','${d}','corr','${foreign.task}','1')`,
    ];
    for (const call of calls)
      assert.equal(
        apiSql(P.A, call + ";", { end: "COMMIT" })
          .split("\n")
          .at(-1),
        "not_found",
        call,
      );
  }
  // A foreign respondent or assignee is not found either (Y in O', A2 in W2 only).
  for (const target of [P.Y.principal, P.A2.principal])
    assert.equal(
      apiSql(
        P.A,
        `SELECT outcome FROM morrow_work.cmd_task_assign('${randomUUID()}','${"e".repeat(64)}','corr','${records.A.task}','${target}','1','own','${"e".repeat(64)}');`,
      )
        .split("\n")
        .at(-1),
      "not_found",
    );
  // Foreign principals are not review candidates or reviewers of A's workspace.
  for (const foreign of [P.Y.principal, P.A2.principal])
    assert.equal(
      apiSql(
        P.A,
        `SELECT count(*) FROM morrow_work.reviewer_snapshot('governance.grants.revise','["${foreign}"]');`,
      )
        .split("\n")
        .at(-1),
      "0",
    );
  const unchanged = counts();
  // The stream rows of P1-P3 SQL probes are rolled back or never created.
  assert.deepEqual(unchanged, before);
  // A direct command-role INSERT or UPDATE with a foreign tenant fails WITH CHECK.
  const W = workspaceResource(P.A.org, P.A.workspace);
  const insert = db.tryRun(
    asCommandRole(
      P.A,
      `INSERT INTO morrow_work.goals(organization_id,workspace_id,id,revision,status,objective,scope,success_criteria,owner_principal_id,owner_membership_id,created_by_principal_id,created_by_membership_id,created_at,updated_at) VALUES('${P.Y.org}','${P.Y.workspace}','forged',1,'draft','x',${literal(JSON.stringify({ organizationId: P.Y.org, workspaceId: P.Y.workspace, storeIds: [], accountIds: [], resources: [], fields: [] }))},'[{"description":"d","verificationCapabilityId":null,"evidenceRequired":false}]','${P.Y.principal}','${P.Y.membership}','${P.Y.principal}','${P.Y.membership}',now(),now());`,
    ),
  );
  assert.equal(insert.ok, false);
  assert.match(insert.stderr, /row-level security/);
  const move = db.tryRun(
    asCommandRole(
      P.A,
      `UPDATE morrow_work.workspace_streams SET workspace_id='${P.A2.workspace}' WHERE workspace_id='${W.workspaceId}';`,
    ),
  );
  assert.equal(move.ok, false);
  assert.match(move.stderr, /permission denied/);
  const hidden = db.sql(
    asCommandRole(
      P.A,
      `UPDATE morrow_work.goals SET revision=revision+1,updated_at=now() WHERE organization_id='${P.Y.org}'; SELECT count(*) FROM morrow_work.goals WHERE organization_id='${P.Y.org}';`,
    ),
  );
  assert.equal(hidden.split("\n").at(-1), "0");
  recordConformance("P3", true, { routesProbed: probed });
});

test("P4: a revoked member gets 401, an unlocked read on the same connection sees nothing, replay discloses nothing", async () => {
  const key = randomUUID();
  const goal = await send(P.R, "POST", "/goals", goalBody(), { key });
  assert.equal(goal.status, 201);
  const connector = db.connector();
  const connection = await connector.open({
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 60000,
    waitUntil() {},
  });
  const signal = new AbortController().signal;
  const prologue = "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY; SET LOCAL ROLE morrow_work_api";
  try {
    await connection.query(prologue, [], signal);
    await connection.query(
      "SELECT count(*) FROM morrow_work.enter_context($1,$2)",
      [P.R.digest, P.R.workspace],
      signal,
    );
    const visible = await connection.query(
      "SELECT count(*)::text AS n FROM morrow_work.goals",
      [],
      signal,
    );
    assert.notEqual(visible.rows[0].n, "0");
    await connection.query("COMMIT", [], signal);
    db.sql(revocationSql(P.R));
    await connection.query(prologue, [], signal);
    const entered = await connection.query(
      "SELECT count(*)::text AS n FROM morrow_work.enter_context($1,$2)",
      [P.R.digest, P.R.workspace],
      signal,
    );
    assert.equal(entered.rows[0].n, "0");
    await connection.query(
      "SELECT set_config('morrow.work_session_digest',$1,true) AS d",
      [P.R.digest],
      signal,
    );
    await connection.query(
      "SELECT set_config('morrow.work_workspace',$1,true) AS w",
      [P.R.workspace],
      signal,
    );
    const after = await connection.query(
      "SELECT count(*)::text AS n FROM morrow_work.goals",
      [],
      signal,
    );
    assert.equal(after.rows[0].n, "0");
    await connection.query("COMMIT", [], signal);
  } finally {
    await connection.close();
  }
  const next = await send(P.R, "GET", "/goals");
  assert.equal(next.status, 401);
  const replay = await send(P.R, "POST", "/goals", goalBody(), { key });
  assert.equal(replay.status, 401);
  assert.ok(!replay.text.includes(goal.body.goalId));
  db.sql(restoreSql(P.R));
  recordConformance("P4", true);
});

test("P6: one connection reused across tenants keeps no context and no role", async () => {
  const connection = await db.connector().open({
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 60000,
    waitUntil() {},
  });
  const signal = new AbortController().signal;
  const run = (text, values = []) => connection.query(text, values, signal);
  try {
    for (const [p, foreign] of [
      [P.A, records.Y],
      [P.Y, records.A],
    ]) {
      await run("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY; SET LOCAL ROLE morrow_work_api");
      await run("SELECT count(*) FROM morrow_work.enter_context($1,$2)", [p.digest, p.workspace]);
      const seen = await run("SELECT DISTINCT workspace_id::text AS w FROM morrow_work.goals");
      assert.deepEqual(
        seen.rows.map((r) => r.w),
        [p.workspace],
      );
      const other = await run("SELECT count(*)::text AS n FROM morrow_work.goals WHERE id=$1", [
        foreign.goal,
      ]);
      assert.equal(other.rows[0].n, "0");
      const gucs = await run(
        "SELECT current_setting('morrow.work_session_digest',true) AS d, current_setting('morrow.work_policy_revision',true) AS r",
      );
      assert.equal(gucs.rows[0].d, p.digest);
      assert.ok(/^[1-9]/.test(gucs.rows[0].r));
      await run(p === P.A ? "COMMIT" : "ROLLBACK");
      const reset = await run(
        "SELECT current_user::text AS c, session_user::text AS s, COALESCE(current_setting('morrow.work_session_digest',true),'') AS d, COALESCE(current_setting('morrow.work_evaluated_at_us',true),'') AS e",
      );
      assert.deepEqual(reset.rows[0], {
        c: "morrow_api_worker",
        s: "morrow_api_worker",
        d: "",
        e: "",
      });
    }
    await run("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY; SET LOCAL ROLE morrow_work_api");
    const none = await run("SELECT count(*)::text AS n FROM morrow_work.goals");
    assert.equal(none.rows[0].n, "0");
    await run("COMMIT");
  } finally {
    await connection.close();
  }
  for (const role of [
    "morrow_work_owner",
    "morrow_work_command",
    "morrow_identity_owner",
    "morrow_api",
  ]) {
    const attempt = db.tryRun(`SET ROLE ${role};`, { user: "morrow_api_worker" });
    assert.equal(attempt.ok, false, role);
  }
  recordConformance("P6", true);
});

// M2 PR-1 (spine §5): the lease context. A lab-only definer owned by the command role
// reports what the tenant_lease policies show; it is created by the local superuser as
// scaffolding and is not a migration object.
const leaseView = `CREATE SCHEMA lab_probe;
CREATE FUNCTION lab_probe.lease_view() RETURNS TABLE(organization_id text,workspace_id text,operations bigint,stops bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT (SELECT c.organization_id FROM morrow_work.current_lease() c),(SELECT c.workspace_id FROM morrow_work.current_lease() c),
  (SELECT count(*) FROM morrow_work.operations),(SELECT count(*) FROM morrow_work.stop_controls WHERE organization_id IS NOT NULL) $$;
ALTER FUNCTION lab_probe.lease_view() OWNER TO morrow_work_command;
REVOKE ALL ON FUNCTION lab_probe.lease_view() FROM PUBLIC;
GRANT USAGE ON SCHEMA lab_probe TO morrow_runtime_executor,morrow_api_worker;
GRANT EXECUTE ON FUNCTION lab_probe.lease_view() TO morrow_runtime_executor,morrow_api_worker;`;
const marker =
  "(extract(epoch FROM transaction_timestamp())*1000000)::bigint::text||':'||pg_backend_pid()::text";
function openLease(p, kind, subject) {
  const out = db.sql(
    asCommandRole(
      p,
      `SELECT outcome||'|'||COALESCE(lease_id,'') FROM morrow_work.lease_open(${literal(kind)},${literal(subject)},'store_p7','connection_p7',${kind === "read" ? "NULL" : "'installation_p7'"});`,
      { end: "COMMIT" },
    ),
  );
  const [outcome, id] = out.split("\n").at(-1).split("|");
  assert.equal(outcome, "opened");
  return id;
}
const runtime = (text) => db.sql(text, { user: "morrow_runtime_executor" });
const view = (prefix) =>
  runtime(
    `BEGIN; ${prefix} SELECT concat_ws('|',COALESCE(organization_id,'-'),operations,stops) FROM lab_probe.lease_view(); ROLLBACK;`,
  )
    .split("\n")
    .at(-1);

test("P7: a lease selects one tenant; a forged, stale or foreign lease setting yields zero rows", () => {
  db.sql(leaseView);
  const A = openLease(P.A, "run", "p7_run_a");
  const Y = openLease(P.Y, "run", "p7_run_y");
  // One taskless billing operation per tenant, written in each tenant's session context.
  // operation_guard (0020) requires updated_at = created_at on insert, so both come from
  // one clock reading: two clock_timestamp() calls can straddle a millisecond and fail the
  // insert (hosted run 40055651915).
  for (const p of [P.A, P.Y])
    db.sql(
      asCommandRole(
        p,
        `INSERT INTO morrow_work.operations(organization_id,workspace_id,id,revision,kind,capability_id,status,request_digest,attempt,created_at,updated_at) SELECT ${literal(p.org)},${literal(p.workspace)},'p7_operation',1,'stripe_write','governance.billing.manage','planned',${literal("f".repeat(64))},0,stamp,stamp FROM (SELECT date_trunc('milliseconds',clock_timestamp()) AS stamp) clock;`,
        { end: "COMMIT" },
      ),
    );
  const enter = (id, generation = "1") =>
    `SELECT outcome FROM morrow_work.enter_lease(${literal(id)},${literal(generation)});`;
  // Entered: exactly the lease's tenant.
  assert.equal(view(enter(A)), `${P.A.org}|1|0`);
  assert.equal(view(enter(Y)), `${P.Y.org}|1|0`);
  // Forged settings without enter_lease, or naming another generation or an unknown
  // lease: zero rows, and a refused enter_lease leaves no context behind. The runtime
  // login itself can compute any value it likes for the entry setting (here the 0020
  // part-1 marker, and a random nonce), but only enter_lease writes the entry proof, so
  // even its own lease, at the right generation, resolves nothing (the review's case).
  const set = (id, generation, entered) =>
    `SELECT set_config('morrow.work_lease_id',${literal(id)},true),set_config('morrow.work_lease_generation',${literal(generation)},true)${entered ? `,set_config('morrow.work_lease_entered',${entered},true)` : ""} IS NOT NULL;`;
  assert.equal(view(set(A, "1", null)), "-|0|0");
  assert.equal(view(set(A, "1", marker)), "-|0|0");
  assert.equal(view(set(A, "1", literal(randomUUID()))), "-|0|0");
  assert.equal(view(set(A, "2", marker)), "-|0|0");
  assert.equal(view(set(randomUUID(), "1", marker)), "-|0|0");
  // Entered A, then the settings retargeted to Y's lease with A's own nonce: the proof
  // names A, so nothing resolves; and clearing the settings does not allow a second entry.
  assert.equal(
    view(`${enter(A)} SELECT set_config('morrow.work_lease_id',${literal(Y)},true) IS NOT NULL;`),
    "-|0|0",
  );
  assert.deepEqual(
    runtime(
      `BEGIN; ${enter(A)} SELECT concat(set_config('morrow.work_lease_id','',true),set_config('morrow.work_lease_generation','',true),set_config('morrow.work_lease_entered','',true)) IS NOT NULL; ${enter(Y)} SELECT concat_ws('|',COALESCE(organization_id,'-'),operations) FROM lab_probe.lease_view(); ROLLBACK;`,
    ).split("\n"),
    ["entered", "t", "denied", "-|0"],
  );
  for (const [id, generation, outcome] of [
    [A, "2", "not_found"],
    [randomUUID(), "1", "not_found"],
    ["not-a-lease", "1", "denied"],
  ]) {
    const out = runtime(
      `BEGIN; ${enter(id, generation)} SELECT concat_ws('|',COALESCE(organization_id,'-'),operations) FROM lab_probe.lease_view(); SELECT '['||COALESCE(current_setting('morrow.work_lease_id',true),'')||']'; ROLLBACK;`,
    ).split("\n");
    assert.deepEqual(out, [outcome, "-|0", "[]"], id);
  }
  // A session-level setting made in an earlier transaction is stale in the next one, and
  // blocks enter_lease on that connection.
  const stale = runtime(
    `SELECT set_config('morrow.work_lease_id',${literal(A)},false),set_config('morrow.work_lease_generation','1',false),set_config('morrow.work_lease_entered',${marker},false) IS NOT NULL;
BEGIN; SELECT concat_ws('|',COALESCE(organization_id,'-'),operations) FROM lab_probe.lease_view(); ${enter(A)} ROLLBACK;`,
  ).split("\n");
  assert.deepEqual(stale.slice(-2), ["-|0", "denied"]);
  // The same setting from any other login resolves nothing: the api Worker's login with a
  // well-formed lease context (and its role's session definers never see a lease).
  assert.equal(
    db
      .sql(
        `BEGIN; ${set(A, "1", marker)} SELECT concat_ws('|',COALESCE(organization_id,'-'),operations,stops) FROM lab_probe.lease_view(); ROLLBACK;`,
        { user: "morrow_api_worker" },
      )
      .split("\n")
      .at(-1),
    "-|0|0",
  );
  // A removed member's lease is revoked in the removing transaction (0024), so it resolves
  // nothing, and stays ended when the membership returns.
  const R = openLease(P.R, "run", "p7_run_r");
  db.sql(revocationSql(P.R));
  try {
    assert.equal(
      runtime(`BEGIN; ${enter(R)} ROLLBACK;`)
        .split("\n")
        .at(-1),
      "ended",
    );
  } finally {
    db.sql(restoreSql(P.R));
  }
  assert.equal(
    runtime(`BEGIN; ${enter(R)} ROLLBACK;`)
      .split("\n")
      .at(-1),
    "ended",
  );
  assert.equal(
    db.rows(
      `SELECT status||'|'||revoked_reason AS s FROM morrow_work.work_leases WHERE id=${literal(R)}`,
    )[0].s,
    "revoked|membership",
  );
  recordConformance("P7", true);
});

test("P8: a lease context calling a session definer is refused, and a session never reaches a lease definer", () => {
  const A = openLease(P.A, "run", "p8_run_a");
  const enter = `SELECT outcome FROM morrow_work.enter_lease(${literal(A)},'1');`;
  const sessionCalls = [
    `SELECT count(*) FROM morrow_work.enter_context(${literal(P.A.digest)},${literal(P.A.workspace)})`,
    `SELECT count(*) FROM morrow_work.current_tenant()`,
    `SELECT outcome FROM morrow_work.cmd_goal_create('${randomUUID()}','${"a".repeat(64)}','corr','x','[]')`,
    `SELECT count(*) FROM morrow_work.review_context('governance.grants.revise',NULL)`,
    `SELECT count(*) FROM morrow_work.goals`,
    `SELECT count(*) FROM morrow_work.operations`,
  ];
  for (const call of sessionCalls) {
    const r = db.tryRun(`BEGIN; ${enter} ${call}; ROLLBACK;`, { user: "morrow_runtime_executor" });
    assert.equal(r.ok, false, call);
    assert.match(r.stderr, /permission denied/, call);
  }
  // The api login, in a valid session context, cannot call any lease definer.
  for (const call of [
    enter,
    "SELECT count(*) FROM morrow_work.pending_starts();",
    "SELECT morrow_work.lease_mark_started();",
    "SELECT morrow_work.lease_release();",
    "SELECT count(*) FROM morrow_work.current_lease();",
  ]) {
    const r = db.tryRun(asApi(P.A, call), { user: "morrow_api_worker" });
    assert.equal(r.ok, false, call);
    assert.match(r.stderr, /permission denied/, call);
  }
  // A session context cannot enter a lease: enter_lease refuses any login but the runtime
  // executor, even the command role with a valid session context.
  assert.equal(db.sql(asCommandRole(P.A, enter)).split("\n").at(-1), "denied");
  // M3 PR-1: the api login in a session context reaches neither the runtime's agent facts
  // nor the broker's resolver, and the command role in a session context (or the runtime
  // login without an entered lease) gets nothing from them.
  const factsCall = `SELECT count(*) FROM morrow_work.delegation_facts('envelope_p8','installation_1','catalog.products.read')`;
  const resolveCall = `SELECT outcome FROM morrow_vault.resolve_call(${literal(A)},'1','model','p8_run_a')`;
  for (const call of [factsCall + ";", resolveCall + ";"]) {
    const r = db.tryRun(asApi(P.A, call), { user: "morrow_api_worker" });
    assert.equal(r.ok, false, call);
    assert.match(r.stderr, /permission denied/, call);
  }
  assert.equal(
    db
      .sql(asCommandRole(P.A, factsCall + ";"))
      .split("\n")
      .at(-1),
    "0",
  );
  assert.equal(
    db
      .sql(asCommandRole(P.A, resolveCall + ";"))
      .split("\n")
      .at(-1),
    "denied",
  );
  assert.equal(
    db
      .sql(`BEGIN; ${factsCall}; ROLLBACK;`, { user: "morrow_runtime_executor" })
      .split("\n")
      .at(-1),
    "0",
  );
  // The runtime login cannot call the broker's resolver, nor the broker the runtime's facts.
  assert.match(
    db.tryRun(`${resolveCall};`, { user: "morrow_runtime_executor" }).stderr,
    /permission denied/,
  );
  assert.match(
    db.tryRun(`${factsCall};`, { user: "morrow_vault_broker" }).stderr,
    /permission denied/,
  );
  // A broker-context setting forged outside resolve_call reaches no lease, stop or
  // installation row: the broker login has no table privilege, and the command role reads
  // them only through resolve_call's own settings while the session user is the broker.
  assert.match(
    db.tryRun(
      `BEGIN; SELECT set_config('morrow.vault_resolve_lease',${literal(A)},true); SELECT count(*) FROM morrow_work.work_leases; ROLLBACK;`,
      { user: "morrow_vault_broker" },
    ).stderr,
    /permission denied/,
  );
  assert.equal(
    db
      .sql(
        `BEGIN; SET LOCAL ROLE morrow_work_command; SELECT set_config('morrow.vault_resolve_lease',${literal(A)},true),set_config('morrow.vault_resolve_tenant','x',true) IS NOT NULL; SELECT (SELECT count(*) FROM morrow_work.work_leases)+(SELECT count(*) FROM morrow_work.agent_installations); ROLLBACK;`,
      )
      .split("\n")
      .at(-1),
    "0",
  );
  recordConformance("P8", true);
});

// M5 PR-1 (ADR-0022 item 9 amendment): the receipt-only ingress. The api login can set any
// setting, but only receipt_begin writes the entry proof (receipt_entries), so a forged
// receipt context reads and writes nothing; the ingress definers refuse a session context
// and every other login; the broker definers run only as the vault login. lab:billing E
// probes the same edges with recorded receipts.
test("P9: a forged receipt context confers nothing; ingress and broker definers refuse every other caller", async () => {
  // A receipt the broker's own login really recorded (unattributed: no customer mapping),
  // so a wrongly accepted forged context would reach the receipt and its plan.
  const ids = { customer: "cus_ProbeUnmapped01", invoice: "in_ProbeForged00001" };
  const object = normalizeInvoice(
    stripeFixture("invoice.paid.subscription_create", ids),
    stripeFixture("subscription.active", ids),
  );
  const digest = await stripeObjectDigest(object);
  const [recorded, receipt] = db
    .sql(
      `SELECT outcome||'|'||receipt_id FROM morrow_billing.stripe_receipt_record(${literal("evt_probeforged" + randomUUID().replaceAll("-", ""))},'invoice.paid','false','invoice',${literal(object.id)},${literal(object.customer)},${literal(JSON.stringify(object))},${literal(digest)},${literal(String(Date.now()))});`,
      { user: "morrow_vault_broker" },
    )
    .split("\n")
    .at(-1)
    .split("|");
  assert.equal(recorded, "recorded");
  const plan = JSON.stringify({
    schemaVersion: 1,
    outcome: "applied",
    code: null,
    payment: { action: "fix_route_and_grant", outcome: "granted", code: null, termsRevision: 1 },
    snapshot: { revision: 1 },
    intent: null,
  });
  const forge = `SELECT set_config('morrow.billing_receipt_entered',${literal(randomUUID())},true) IS NOT NULL;`;
  // A forged context, then the api role's own reads: nothing, as with no context.
  const reads = db
    .sql(
      `BEGIN; SET LOCAL ROLE morrow_work_api; ${forge}
SELECT (SELECT count(*) FROM morrow_billing.workspace_billing_routes)+(SELECT count(*) FROM morrow_billing.billing_accounts)+(SELECT count(*) FROM morrow_billing.credit_wallets)+(SELECT count(*) FROM morrow_billing.credit_grants); ROLLBACK;`,
      { user: "morrow_api_worker" },
    )
    .split("\n")
    .at(-1);
  assert.equal(reads, "0");
  // The forged context reaching receipt_apply directly on the recorded receipt (no
  // receipt_begin, so no entry proof): denied, exactly; never the plan's own refusal.
  const applied = db
    .sql(
      `BEGIN; SET LOCAL ROLE morrow_work_api; ${forge}
SELECT outcome FROM morrow_billing.receipt_apply(${literal(receipt)},${literal(digest)},${literal(plan)}); COMMIT;`,
      { user: "morrow_api_worker" },
    )
    .split("\n")
    .at(-1);
  assert.equal(applied, "denied");
  // Under a session context every ingress definer refuses.
  for (const call of [
    `SELECT outcome FROM morrow_billing.receipt_begin(${literal(receipt)},${literal(digest)})`,
    `SELECT outcome FROM morrow_billing.receipt_status(${literal(receipt)})`,
  ])
    assert.equal(
      db.sql(asApi(P.A, call), { user: "morrow_api_worker" }).split("\n").at(-1),
      "denied",
      call,
    );
  // No other login executes an ingress definer, and only the vault login a broker definer.
  for (const login of [
    "morrow_runtime_executor",
    "morrow_connector_ingress",
    "morrow_vault_broker",
  ]) {
    const r = db.tryRun(`SELECT * FROM morrow_billing.receipt_status(${literal(receipt)});`, {
      user: login,
    });
    assert.equal(r.ok, false, login);
    assert.match(r.stderr, /permission denied/, login);
  }
  for (const login of ["morrow_api_worker", "morrow_runtime_executor", "morrow_connector_ingress"])
    for (const call of [
      `SELECT * FROM morrow_billing.stripe_op_begin(${literal(randomUUID())})`,
      `SELECT morrow_billing.stripe_op_settle(${literal(randomUUID())},'uncertain',NULL,NULL)`,
    ]) {
      const r = db.tryRun(call + ";", { user: login });
      assert.equal(r.ok, false, login + " " + call);
      assert.match(r.stderr, /permission denied/, login);
    }
  // Nothing was written by any of it.
  assert.equal(
    db.rows("SELECT count(*)::text AS n FROM morrow_billing.receipt_applications")[0].n,
    "0",
  );
  recordConformance("P9", true);
});

// M2 PR-3 (review finding B3): the connector's context. Its policies admit rows only while
// the session user is the connector's login and only for the tenant, store and connection
// that connector_inbox_apply wrote from the broker-recorded inbox row, after overwriting
// both settings on entry. A setting the connector login forges reaches nothing (it holds no
// table privilege, and the applier overwrites it), and the same settings from any other
// login reach nothing either.
test("P10: a forged connector context confers nothing; the applier acts only on its inbox row's tenant", () => {
  const stores = {};
  for (const [key, p] of [
    ["a", P.A],
    ["y", P.Y],
  ]) {
    const store = {
      storeId: "p10_store_" + key,
      connectionId: "p10_conn_" + key,
      installationId: "p10_inst_" + key,
    };
    db.sql(
      storeInstallationSql({
        org: p.org,
        workspace: p.workspace,
        principal: p.principal,
        ...store,
      }),
    );
    const row = db.rows(
      `SELECT app_key,shop_id,shop_domain FROM morrow_identity.store_installations WHERE id=${literal(store.installationId)}`,
    )[0];
    db.sql(
      `INSERT INTO morrow_vault.credentials(organization_id,workspace_id,id,version,provider,kind,subject_id,status,kek_version,wrapped_key,sealed_value,created_at,destroyed_at,destroy_reason) VALUES(${literal(p.org)},${literal(p.workspace)},${literal("credential_" + store.installationId)},1,'shopify','shopify_offline_token',${literal(store.installationId)},'active',1,decode(repeat('ab',60),'hex'),decode(repeat('cd',40),'hex'),date_trunc('milliseconds',clock_timestamp()),NULL,NULL);`,
    );
    const lease = db
      .sql(
        asCommandRole(
          p,
          `SELECT outcome||'|'||COALESCE(lease_id,'') FROM morrow_work.lease_open('read',${literal("p10_read_" + key)},${literal(store.storeId)},${literal(store.connectionId)},NULL);`,
          { end: "COMMIT" },
        ),
      )
      .split("\n")
      .at(-1)
      .split("|");
    assert.equal(lease[0], "opened");
    stores[key] = { ...store, ...row, p, lease: lease[1] };
  }
  const { a, y } = stores;
  const stopSetting = (s) => `${s.p.org}|${s.p.workspace}|${s.storeId}|${s.connectionId}`;
  const forge = (s) =>
    `SELECT set_config('morrow.connector_stop',${literal(stopSetting(s))},true),set_config('morrow.connector_redact',${literal(`${s.p.org}|${s.p.workspace}|${s.storeId}`)},true) IS NOT NULL;`;
  // The connector login holds no table privilege: a forged setting reads nothing directly.
  for (const table of [
    "morrow_work.stop_controls",
    "morrow_work.work_leases",
    "morrow_work.proposal_parameters",
  ]) {
    const r = db.tryRun(`BEGIN; ${forge(y)} SELECT count(*) FROM ${table}; ROLLBACK;`, {
      user: "morrow_connector_ingress",
    });
    assert.equal(r.ok, false, table);
    assert.match(r.stderr, /permission denied/, table);
  }
  // The same settings from every other login, and in the command role from any session
  // user but the connector's: zero rows.
  for (const user of ["morrow_vault_broker", "morrow_runtime_executor", "morrow_api_worker"]) {
    const r = db.tryRun(
      `BEGIN; ${forge(y)} SELECT count(*) FROM morrow_work.stop_controls; ROLLBACK;`,
      { user },
    );
    assert.equal(r.ok, false, user);
  }
  assert.equal(
    db
      .sql(
        `BEGIN; SET LOCAL ROLE morrow_work_command; ${forge(y)} SELECT (SELECT count(*) FROM morrow_work.work_leases)+(SELECT count(*) FROM morrow_work.stop_controls WHERE organization_id IS NOT NULL)+(SELECT count(*) FROM morrow_work.proposals); ROLLBACK;`,
      )
      .split("\n")
      .at(-1),
    "0",
  );
  // A's uninstall, recorded by the broker's login; the connector applies it with Y's
  // settings forged first: only A's installation, stop and lease change.
  const inbox = db
    .sql(
      `SELECT inbox_id FROM morrow_vault.shopify_webhook_record(${literal(a.app_key)},${literal(a.shop_domain)},'app/uninstalled','p10-uninstall','2026-10',${literal(JSON.stringify({ shopId: a.shop_id }))});`,
      { user: "morrow_vault_broker" },
    )
    .split("\n")
    .at(-1);
  assert.match(inbox, /^[a-f0-9-]{36}$/);
  const applied = db
    .sql(
      `BEGIN; ${forge(y)} SELECT outcome||'|'||topic||'|'||credential FROM morrow_work.connector_inbox_apply(${literal(inbox)}); SELECT '['||current_setting('morrow.connector_stop',true)||']['||current_setting('morrow.connector_redact',true)||']'; COMMIT;`,
      { user: "morrow_connector_ingress" },
    )
    .split("\n");
  assert.deepEqual(applied.slice(-2), ["applied|app/uninstalled|pending", "[][]"]);
  const state = (s) =>
    db.rows(
      `SELECT (SELECT status FROM morrow_identity.store_installations WHERE id=${literal(s.installationId)}) AS installation,(SELECT status||'|'||COALESCE(revoked_reason,'') FROM morrow_work.work_leases WHERE id=${literal(s.lease)}) AS lease,(SELECT count(*)::int FROM morrow_work.stop_controls WHERE scope='connection' AND target_id=${literal(s.connectionId)}) AS stops`,
    )[0];
  assert.deepEqual(state(a), { installation: "uninstalled", lease: "revoked|stop", stops: 1 });
  assert.deepEqual(state(y), { installation: "linked", lease: "active|", stops: 0 });
  // A connector context reaches no session or lease definer, and no other login reaches
  // the connector's definers.
  for (const call of [
    `SELECT count(*) FROM morrow_work.enter_context(${literal(P.A.digest)},${literal(P.A.workspace)})`,
    `SELECT outcome FROM morrow_work.cmd_goal_create('${randomUUID()}','${"a".repeat(64)}','corr','x','[]')`,
    `SELECT outcome FROM morrow_work.catalog_read_lease(${literal(a.storeId)},${literal(a.connectionId)})`,
    `SELECT outcome FROM morrow_work.enter_lease(${literal(a.lease)},'1')`,
    `SELECT outcome FROM morrow_vault.shopify_credential_destroy(${literal(a.installationId)},'uninstalled')`,
  ]) {
    const r = db.tryRun(`BEGIN; ${forge(a)} ${call}; ROLLBACK;`, {
      user: "morrow_connector_ingress",
    });
    assert.equal(r.ok, false, call);
    assert.match(r.stderr, /permission denied/, call);
  }
  for (const user of ["morrow_vault_broker", "morrow_runtime_executor", "morrow_api_worker"])
    for (const call of [
      `SELECT * FROM morrow_work.connector_inbox_apply(${literal(inbox)})`,
      "SELECT * FROM morrow_work.connector_inbox_pending()",
      "SELECT * FROM morrow_work.connector_credentials_pending()",
      "SELECT * FROM morrow_work.connector_privacy_overdue()",
    ]) {
      const r = db.tryRun(call + ";", { user });
      assert.equal(r.ok, false, user + " " + call);
      assert.match(r.stderr, /permission denied/, user);
    }
  // The command role with a forged connector context and no connector session gets
  // "denied" from the applier and changes nothing.
  assert.equal(
    db
      .sql(
        `BEGIN; SET LOCAL ROLE morrow_work_command; ${forge(y)} SELECT outcome FROM morrow_work.connector_inbox_apply(${literal(inbox)}); ROLLBACK;`,
      )
      .split("\n")
      .at(-1),
    "denied",
  );
  assert.deepEqual(state(y), { installation: "linked", lease: "active|", stops: 0 });
  recordConformance("P10", true);
});
