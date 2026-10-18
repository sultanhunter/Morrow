// P06.T01a PostgreSQL 17 acceptance laboratory: AC01-AC11, AC13-AC17, AC20, AC24
// and AC25 through the real @morrow/work handler, an isolated network-none engine
// and the full migration manifest (applied with `executeAs`, a fresh connection
// per migration). AC12, AC21-AC23 and the AC16 lease signal are in
// lab:work-workers; AC18-AC19 (S1-S6, P1-P6) in lab:tenant-conformance.
// Owner-seeded synthetic fixtures only; no provider, credential or merchant data.
// MORROW_WORK_SOAK=1 adds the nightly 4x500 soak and the full race matrix.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { createWorkApiHandler } from "../packages/work/src/http.ts";
import { workStatements } from "../packages/work/src/sql.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import {
  asApi,
  asCommandRole,
  fixtureActor,
  fixtureGrant,
  capabilityFields,
  literal,
  restoreSql,
  revocationSql,
  seedWorkFixtures,
  sleep,
  withWorkDatabase,
  workFixtureOrigin,
  workRequest,
  workspaceResource,
} from "../tests/tenant-conformance/harness.mjs";
import { writeArtifact } from "./artifacts.mjs";

const soak = process.env.MORROW_WORK_SOAK === "1";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const checks = [];
let unavailableRetries = 0;
const failures = [];
function check(name, passed) {
  checks.push({ name, passed: passed === true });
  if (passed !== true) failures.push(name);
  return passed === true;
}
// Worker console output is captured (AC17): one fixed line per request.
const consoleLines = [];
const print = console.log.bind(console);
console.log = (...args) => consoleLines.push(args.map(String).join(" "));

const transitions = JSON.parse(readFileSync("docs/contracts/state-transitions.json", "utf8"));
const v1Rows = (machine) =>
  transitions.transitions[machine].filter(
    (r) => r.since === undefined && r.superseded_in === undefined,
  );
const criteria = (description = "Revenue grows") => [
  { description, verificationCapabilityId: null, evidenceRequired: false },
];
const goalBody = (objective = "Grow repeat purchases", description) => ({
  objective,
  storeIds: [],
  successCriteria: criteria(description),
});
const statement = (name) => workStatements[name];
const isCommand = (record) => /FROM morrow_work\.cmd_/.test(record.text);

// A request that ends without reaching its hook fails the case instead of hanging.
async function reached(hold, request) {
  await Promise.race([
    hold.arrived,
    request.then((reply) => {
      throw Error("HOOK_NOT_REACHED_" + reply.status);
    }),
  ]);
}
function gate() {
  let open, arrive;
  const opened = new Promise((resolve) => (open = resolve));
  const arrived = new Promise((resolve) => (arrive = resolve));
  return {
    opened,
    arrived,
    open,
    async wait(connection) {
      arrive(connection);
      await opened;
    },
  };
}

const started = Date.now();
await withWorkDatabase("P06.T01a.work-postgresql", async (db) => {
  const P = seedWorkFixtures(db);
  const ctx = { waitUntil() {} };
  const handlerWith = (hooks = {}) =>
    createWorkApiHandler({
      origin: workFixtureOrigin,
      connector: db.connector(hooks),
      now: Date.now,
    });
  const plain = handlerWith();
  const responses = [];
  async function send(p, method, path, body, options = {}) {
    const handler = options.handler ?? plain;
    for (let attempt = 1; ; attempt++) {
      const response = await handler.fetch(
        workRequest(p, method, path, body, options),
        undefined,
        ctx,
      );
      const text = await response.text();
      const reply = {
        status: response.status,
        text,
        body: JSON.parse(text),
        headers: response.headers,
      };
      responses.push(text);
      // Reads are safe_read_retry: a loaded host may time a read out, and the
      // contract allows the client to retry it unchanged.
      if (
        method === "GET" &&
        reply.status === 503 &&
        reply.body.retryClass === "safe_read_retry" &&
        attempt < 4
      ) {
        unavailableRetries++;
        await sleep(250);
        continue;
      }
      return reply;
    }
  }
  // Fixture setup that must apply: retried with the same key (reconcile, never re-apply).
  async function applied(p, path, body, expected) {
    const key = randomUUID();
    for (let attempt = 1; attempt <= 6; attempt++) {
      const reply = await send(p, "POST", path, body, { key });
      if (reply.status === expected || (reply.status === 200 && reply.body.replayed === true))
        return reply;
      if (reply.status !== 503)
        throw Error("FIXTURE_" + path.split("/")[1].toUpperCase() + "_" + reply.status);
      unavailableRetries++;
      await sleep(250);
    }
    throw Error("FIXTURE_UNDECIDED");
  }
  const count = (table, where = "true") =>
    Number(db.sql(`SELECT count(*) FROM morrow_work.${table} WHERE ${where};`));
  const totals = () => ({
    goals: count("goals"),
    tasks: count("tasks"),
    questions: count("questions"),
    answers: count("question_answers"),
    assignments: count("task_assignments"),
    commands: count("commands"),
    events: count("outbox_events"),
  });
  const same = (a, b) => isDeepStrictEqual(a, b);
  const strip = (text) => JSON.stringify({ ...JSON.parse(text), correlationId: null });
  const only = process.env.MORROW_WORK_LAB_ONLY?.split(",") ?? null;
  async function section(name, body) {
    if (only && !only.includes(name)) return;
    try {
      await body();
    } catch (error) {
      check(name + ":completed", false);
      print("SECTION_FAILED " + name + " " + (error instanceof Error ? error.message : "unknown"));
    }
  }
  // Every page of a list, following its opaque cursor.
  async function pages(p, path) {
    const items = [];
    let next = null,
      status = 200;
    do {
      const reply = await send(p, "GET", path + (next ? "&after=" + next : ""));
      status = reply.status;
      if (status !== 200) break;
      items.push(...reply.body.items);
      next = reply.body.next;
    } while (next);
    return { status, body: { items } };
  }
  async function goal(p = P.A, objective) {
    return (await applied(p, "/goals", goalBody(objective), 201)).body.goalId;
  }
  async function task(goalId, p = P.A) {
    const body = { goalId, objective: "Draft the brief", allowedResources: [] };
    return (await applied(p, "/tasks", body, 201)).body.taskId;
  }
  async function question(taskId, respondent = P.B, p = P.A) {
    const body = { question: "Which audience first?", respondentId: respondent.principal };
    return (await applied(p, "/tasks/" + taskId + "/questions", body, 201)).body.questionId;
  }

  // Warm-up: plans and caches, so the first measured request is not the first ever.
  await send(P.A, "GET", "/goals");
  await goal(P.A, "Warm-up");

  await section("AC01", async () => {
    const before = totals();
    const head = Number(db.sql("SELECT COALESCE(max(position),0) FROM morrow_work.outbox_events;"));
    const reply = await send(P.A, "POST", "/goals", goalBody());
    check(
      "AC01:created_201",
      reply.status === 201 && reply.body.revision === 1 && reply.body.schemaVersion === 1,
    );
    const [row] = db.rows(
      `SELECT status, revision::int AS revision, scope FROM morrow_work.goals WHERE id=${literal(reply.body.goalId)}`,
    );
    check("AC01:draft_goal", row?.status === "draft" && row.revision === 1);
    check(
      "AC01:scope_O_W_W",
      same(row?.scope, {
        organizationId: P.A.org,
        workspaceId: P.A.workspace,
        storeIds: [],
        accountIds: [],
        resources: [workspaceResource(P.A.org, P.A.workspace)],
        fields: [],
      }),
    );
    const events = db.rows(
      `SELECT position::int AS position, event_type, aggregate_revision::int AS revision FROM morrow_work.outbox_events WHERE aggregate_id=${literal(reply.body.goalId)}`,
    );
    check(
      "AC01:one_event_at_head",
      events.length === 1 &&
        events[0].event_type === "goal.created" &&
        events[0].position === head + 1,
    );
    const after = totals();
    check(
      "AC01:one_commit",
      after.goals === before.goals + 1 &&
        after.commands === before.commands + 1 &&
        after.events === before.events + 1,
    );
  });

  await section("AC02-AC03", async () => {
    const key = randomUUID();
    const body = goalBody("Replay me");
    const first = await send(P.A, "POST", "/goals", body, { key });
    const before = totals();
    const reordered =
      '{ "successCriteria" : [ { "evidenceRequired":false, "verificationCapabilityId":null, "description":"Revenue grows" } ],\n "storeIds":[], "objective" : "Replay me" }';
    const replay = await send(P.A, "POST", "/goals", reordered, { key });
    check("AC02:replayed_200", replay.status === 200 && replay.body.replayed === true);
    check(
      "AC02:identical_result",
      replay.body.goalId === first.body.goalId && replay.body.revision === first.body.revision,
    );
    check("AC02:no_new_rows", same(totals(), before));
    const misuse = await send(P.A, "POST", "/goals", goalBody("Different"), { key });
    check(
      "AC03:conflict_never",
      misuse.status === 409 &&
        misuse.body.code === "conflict" &&
        misuse.body.retryClass === "never",
    );
    check("AC03:nothing_written", same(totals(), before));
    // B's commands live under B's own keys: the same value applies as B's command.
    const t = await task(first.body.goalId);
    const q = await question(t);
    const b = await send(
      P.B,
      "POST",
      "/questions/" + q + "/answer",
      { text: "Returning buyers", expectedRevision: 1 },
      { key },
    );
    check("AC03:other_actor_applies", b.status === 200 && b.body.answerRevision === 2);
    check("AC03:discloses_nothing", !b.text.includes(first.body.goalId));
  });

  await section("AC04", async () => {
    const key = randomUUID();
    const body = goalBody("Concurrent duplicate");
    const hold = gate();
    const first = handlerWith({
      async beforeQuery(record, connection) {
        if (record.text === statement("commit")) await hold.wait(connection);
      },
    });
    const one = send(P.A, "POST", "/goals", body, { key, handler: first });
    await reached(hold, one);
    const two = send(P.A, "POST", "/goals", body, { key });
    const waiting = await db.waitForLockWait("wait_event='advisory'");
    hold.open();
    const [a, b] = await Promise.all([one, two]);
    check("AC04:second_waited_on_key", waiting);
    check(
      "AC04:one_effect",
      a.status === 201 &&
        b.status === 200 &&
        b.body.replayed === true &&
        b.body.goalId === a.body.goalId,
    );
    check("AC04:one_goal", count("goals", "objective='Concurrent duplicate'") === 1);
  });

  await section("AC05", async () => {
    const g = await goal(P.A, "Optimistic");
    const hold = gate();
    const first = handlerWith({
      async beforeQuery(record, connection) {
        if (record.text === statement("commit")) await hold.wait(connection);
      },
    });
    const one = send(
      P.A,
      "POST",
      "/goals/" + g + "/status",
      { to: "active", expectedRevision: 1 },
      { handler: first },
    );
    await reached(hold, one);
    const two = send(P.A, "POST", "/goals/" + g + "/status", { to: "active", expectedRevision: 1 });
    const waiting = await db.waitForLockWait("application_name LIKE 'morrow_work_lab_%'");
    hold.open();
    const [a, b] = await Promise.all([one, two]);
    check("AC05:winner", a.status === 200 && a.body.revision === 2);
    check("AC05:loser_recheck", b.status === 409 && b.body.retryClass === "recheck_before_retry");
    check("AC05:serialized", waiting);
  });

  await section("AC06", async () => {
    const statuses = {
      goal: ["draft", "active", "paused", "achieved", "cancelled"],
      question: ["open", "answered", "cancelled", "expired"],
    };
    const edges = (machine) => new Set(v1Rows(machine).map((r) => r.from + ">" + r.to));
    // Reach any goal status through owner maintenance along real edges.
    const path = {
      draft: [],
      active: ["active"],
      paused: ["active", "paused"],
      achieved: ["active", "achieved"],
      cancelled: ["cancelled"],
    };
    let refusedApi = 0,
      refusedOwner = 0,
      pairs = 0;
    for (const from of statuses.goal)
      for (const to of statuses.goal) {
        if (from === to || edges("goal").has(from + ">" + to)) continue;
        pairs++;
        const g = await goal(P.A, "Machine " + from + " " + to);
        let revision = 1;
        for (const step of path[from]) {
          db.workOwner(
            `UPDATE morrow_work.goals SET status=${literal(step)},revision=revision+1,updated_at=clock_timestamp() WHERE id=${literal(g)};`,
          );
          revision++;
        }
        const reply = await send(P.A, "POST", "/goals/" + g + "/status", {
          to,
          expectedRevision: revision,
        });
        if (reply.status === 409 && reply.body.code === "conflict") refusedApi++;
        const owner = db.tryRun(
          `SET ROLE morrow_work_owner; UPDATE morrow_work.goals SET status=${literal(to)},revision=revision+1,updated_at=clock_timestamp() WHERE id=${literal(g)};`,
        );
        if (!owner.ok && /WORK_STATE_INVALID/.test(owner.stderr)) refusedOwner++;
      }
    check("AC06:goal_pairs_13", pairs === 13);
    check("AC06:goal_function_refused", refusedApi === pairs);
    check("AC06:goal_owner_update_refused", refusedOwner === pairs);
    // Questions: every pair outside the JSON, by owner UPDATE, and through the answer
    // and cancel functions where one exists.
    const g = await goal(P.A, "Question machine");
    const t = await task(g);
    let qPairs = 0,
      qOwner = 0,
      qFunction = 0,
      qFunctionPairs = 0;
    for (const from of statuses.question)
      for (const to of statuses.question) {
        if (from === to || edges("question").has(from + ">" + to)) continue;
        qPairs++;
        const q = await question(t);
        if (from !== "open")
          db.workOwner(
            `UPDATE morrow_work.questions SET status=${literal(from)},revision=2,updated_at=clock_timestamp() WHERE id=${literal(q)};`,
          );
        const revision = from === "open" ? 1 : 2;
        if (to === "answered" || to === "cancelled") {
          qFunctionPairs++;
          const reply =
            to === "answered"
              ? await send(P.B, "POST", "/questions/" + q + "/answer", {
                  text: "Late",
                  expectedRevision: revision,
                })
              : await send(P.A, "POST", "/questions/" + q + "/status", {
                  to: "cancelled",
                  expectedRevision: revision,
                });
          if (reply.status === 409) qFunction++;
        }
        const owner = db.tryRun(
          `SET ROLE morrow_work_owner; UPDATE morrow_work.questions SET status=${literal(to)},revision=revision+1,updated_at=clock_timestamp() WHERE id=${literal(q)};`,
        );
        if (!owner.ok && /WORK_STATE_INVALID/.test(owner.stderr)) qOwner++;
      }
    check("AC06:question_pairs_9", qPairs === 9);
    check("AC06:question_owner_update_refused", qOwner === qPairs);
    check("AC06:question_function_refused", qFunction === qFunctionPairs && qFunctionPairs === 4);
    // Task statuses other than draft and ready fail.
    const taskStatuses = [
      "queued",
      "running",
      "waiting_input",
      "waiting_approval",
      "paused",
      "cancelling",
      "cancelled",
      "succeeded",
      "failed",
    ];
    let taskRefused = 0;
    for (const status of taskStatuses) {
      const r = db.tryRun(
        `SET ROLE morrow_work_owner; UPDATE morrow_work.tasks SET status=${literal(status)},revision=revision+1,updated_at=clock_timestamp() WHERE id=${literal(t)};`,
      );
      if (!r.ok && /tasks_status_check|WORK_STATE_INVALID/.test(r.stderr)) taskRefused++;
    }
    check("AC06:task_status_check", taskRefused === taskStatuses.length);
    // Inserts must start at the initial status and revision 1.
    const scope = JSON.stringify({
      organizationId: P.A.org,
      workspaceId: P.A.workspace,
      storeIds: [],
      accountIds: [],
      resources: [],
      fields: [],
    });
    const insertGoal = (status, revision) =>
      db.tryRun(
        `SET ROLE morrow_work_owner; INSERT INTO morrow_work.goals VALUES(${literal(P.A.org)},${literal(P.A.workspace)},${literal("g_" + randomUUID())},${revision},${literal(status)},'x',${literal(scope)},${literal(JSON.stringify(criteria()))},${literal(P.A.principal)},${literal(P.A.membership)},${literal(P.A.principal)},${literal(P.A.membership)},now(),now());`,
      );
    check(
      "AC06:insert_initial_only",
      !insertGoal("active", 1).ok && !insertGoal("draft", 2).ok && insertGoal("draft", 1).ok,
    );
    const rules = db.rows(
      "SELECT machine, from_status, to_status, actor, guard FROM morrow_work.transition_rules",
    );
    const expected = ["goal", "task", "question"].flatMap((m) =>
      v1Rows(m).map((r) => [m, r.from, r.to, r.actor, r.guard].join("|")),
    );
    check(
      "AC06:transition_rules_equal_json_v1",
      same(
        rules
          .map((r) => [r.machine, r.from_status, r.to_status, r.actor, r.guard].join("|"))
          .sort(),
        expected.sort(),
      ) && expected.length === 30,
    );
  });

  await section("AC07", async () => {
    // draft→ready under a cancelled goal (owner maintenance cancels the goal).
    const g1 = await goal(P.A, "Guard ready");
    const t1 = await task(g1);
    db.workOwner(
      `UPDATE morrow_work.goals SET status='cancelled',revision=revision+1,updated_at=clock_timestamp() WHERE id=${literal(g1)};`,
    );
    const ready = await send(P.A, "POST", "/tasks/" + t1 + "/status", {
      to: "ready",
      expectedRevision: 1,
    });
    check(
      "AC07:ready_under_cancelled_goal",
      ready.status === 409 && ready.body.retryClass === "recheck_before_retry",
    );
    const create = await send(P.A, "POST", "/tasks", {
      goalId: g1,
      objective: "Late",
      allowedResources: [],
    });
    check("AC07:create_under_cancelled_goal", create.status === 409);
    // active→cancelled with a draft or a ready child.
    for (const childReady of [false, true]) {
      const g = await goal(P.A, "Guard cancel");
      const t = await task(g);
      if (childReady)
        await send(P.A, "POST", "/tasks/" + t + "/status", { to: "ready", expectedRevision: 1 });
      await send(P.A, "POST", "/goals/" + g + "/status", { to: "active", expectedRevision: 1 });
      const cancel = await send(P.A, "POST", "/goals/" + g + "/status", {
        to: "cancelled",
        expectedRevision: 2,
      });
      check(
        "AC07:cancel_with_" + (childReady ? "ready" : "draft") + "_child",
        cancel.status === 409,
      );
    }
    const g2 = await goal(P.A, "Guard achieved");
    await send(P.A, "POST", "/goals/" + g2 + "/status", { to: "active", expectedRevision: 1 });
    const achieved = await send(P.A, "POST", "/goals/" + g2 + "/status", {
      to: "achieved",
      expectedRevision: 2,
    });
    check(
      "AC07:achieved_guard_failed",
      achieved.status === 409 && achieved.body.safeMessage.includes("precondition"),
    );
    // The 201st task and the 51st open question.
    const g3 = await goal(P.A, "Caps");
    const scope = JSON.stringify({
      organizationId: P.A.org,
      workspaceId: P.A.workspace,
      storeIds: [],
      accountIds: [],
      resources: [],
      fields: [],
    });
    db.workOwner(
      `INSERT INTO morrow_work.tasks SELECT ${literal(P.A.org)},${literal(P.A.workspace)},'cap_task_'||i,1,${literal(g3)},'draft','Cap',${literal(scope)}::jsonb,${literal(P.A.principal)},${literal(P.A.membership)},${literal(P.A.principal)},${literal(P.A.membership)},now(),now() FROM generate_series(1,200) i;`,
    );
    const over = await send(P.A, "POST", "/tasks", {
      goalId: g3,
      objective: "201st",
      allowedResources: [],
    });
    check(
      "AC07:task_cap_limit_reached",
      over.status === 409 &&
        over.body.retryClass === "never" &&
        count("tasks", `goal_id=${literal(g3)}`) === 200,
    );
    const t3 = await task(await goal(P.A, "Question cap"));
    db.workOwner(
      `INSERT INTO morrow_work.questions SELECT ${literal(P.A.org)},${literal(P.A.workspace)},'cap_question_'||i,1,${literal(t3)},'open','Cap?',${literal(P.A.principal)},${literal(P.A.membership)},${literal(P.B.principal)},${literal(P.B.membership)},now(),now() FROM generate_series(1,50) i;`,
    );
    const q51 = await send(P.A, "POST", "/tasks/" + t3 + "/questions", {
      question: "51st?",
      respondentId: P.B.principal,
    });
    check("AC07:question_cap_limit_reached", q51.status === 409 && q51.body.retryClass === "never");
  });

  await section("AC08", async () => {
    // A hook pauses one transaction after begin_command; the other completes first.
    async function race(first, second) {
      const hold = gate();
      const paused = handlerWith({
        async afterQuery(record, connection) {
          if (record.text === statement("beginCommand")) await hold.wait(connection);
        },
      });
      const a = first(paused);
      await reached(hold, a);
      const b = await second(plain);
      hold.open();
      return [await a, b];
    }
    const rounds = soak ? 10 : 1;
    for (let round = 0; round < rounds; round++) {
      // Goal cancel against task create, both orders.
      const g1 = await goal(P.A, "Race cancel create");
      await send(P.A, "POST", "/goals/" + g1 + "/status", { to: "active", expectedRevision: 1 });
      const [create, cancel] = await race(
        (h) =>
          send(
            P.A,
            "POST",
            "/tasks",
            { goalId: g1, objective: "Racer", allowedResources: [] },
            { handler: h },
          ),
        (h) =>
          send(
            P.A,
            "POST",
            "/goals/" + g1 + "/status",
            { to: "cancelled", expectedRevision: 2 },
            { handler: h },
          ),
      );
      check(
        "AC08:cancel_then_create",
        cancel.status === 200 &&
          create.status === 409 &&
          count("tasks", `goal_id=${literal(g1)}`) === 0,
      );
      const g2 = await goal(P.A, "Race create cancel");
      await send(P.A, "POST", "/goals/" + g2 + "/status", { to: "active", expectedRevision: 1 });
      const [cancel2, create2] = await race(
        (h) =>
          send(
            P.A,
            "POST",
            "/goals/" + g2 + "/status",
            { to: "cancelled", expectedRevision: 2 },
            { handler: h },
          ),
        (h) =>
          send(
            P.A,
            "POST",
            "/tasks",
            { goalId: g2, objective: "Racer", allowedResources: [] },
            { handler: h },
          ),
      );
      const [g2row] = db.rows(`SELECT status FROM morrow_work.goals WHERE id=${literal(g2)}`);
      check(
        "AC08:create_then_cancel",
        create2.status === 201 && cancel2.status === 409 && g2row.status === "active",
      );
      // Goal cancel against draft→ready.
      const g3 = await goal(P.A, "Race cancel ready");
      const t3 = await task(g3);
      const [cancel3, ready3] = await race(
        (h) =>
          send(
            P.A,
            "POST",
            "/goals/" + g3 + "/status",
            { to: "cancelled", expectedRevision: 1 },
            { handler: h },
          ),
        (h) =>
          send(
            P.A,
            "POST",
            "/tasks/" + t3 + "/status",
            { to: "ready", expectedRevision: 1 },
            { handler: h },
          ),
      );
      check("AC08:ready_and_cancel_consistent", ready3.status === 200 && cancel3.status === 409);
      // Two creates for the 200th slot.
      const g4 = await goal(P.A, "Race slot");
      const scope = JSON.stringify({
        organizationId: P.A.org,
        workspaceId: P.A.workspace,
        storeIds: [],
        accountIds: [],
        resources: [],
        fields: [],
      });
      db.workOwner(
        `INSERT INTO morrow_work.tasks SELECT ${literal(P.A.org)},${literal(P.A.workspace)},'slot_'||${round}||'_'||i,1,${literal(g4)},'draft','Slot',${literal(scope)}::jsonb,${literal(P.A.principal)},${literal(P.A.membership)},${literal(P.A.principal)},${literal(P.A.membership)},now(),now() FROM generate_series(1,199) i;`,
      );
      const [x, y] = await race(
        (h) =>
          send(
            P.A,
            "POST",
            "/tasks",
            { goalId: g4, objective: "Slot A", allowedResources: [] },
            { handler: h },
          ),
        (h) =>
          send(
            P.A,
            "POST",
            "/tasks",
            { goalId: g4, objective: "Slot B", allowedResources: [] },
            { handler: h },
          ),
      );
      check(
        "AC08:one_slot_winner",
        y.status === 201 && x.status === 409 && count("tasks", `goal_id=${literal(g4)}`) === 200,
      );
    }
  });

  await section("AC09", async () => {
    const g = await goal(P.A, "Nested scope");
    const W = workspaceResource(P.A.org, P.A.workspace);
    for (const [name, resources] of [
      ["empty", []],
      ["workspace", [W]],
    ]) {
      const r = await send(P.A, "POST", "/tasks", {
        goalId: g,
        objective: "Scoped " + name,
        allowedResources: resources,
      });
      check("AC09:accepts_" + name, r.status === 201);
    }
    const before = totals();
    const opened = { n: 0 };
    const counting = handlerWith({ beforeOpen: async () => void opened.n++ });
    const cases = {
      foreign_workspace: [{ ...W, workspaceId: P.A2.workspace, id: P.A2.workspace }],
      store: [{ ...W, storeId: "store_1" }],
      connection: [{ ...W, connectionId: "connection_1" }],
      kind: [{ ...W, kind: "goal" }],
      duplicate: [W, W],
      partial: [
        {
          organizationId: W.organizationId,
          workspaceId: W.workspaceId,
          kind: "workspace",
          id: W.id,
        },
      ],
    };
    for (const [name, resources] of Object.entries(cases)) {
      const r = await send(
        P.A,
        "POST",
        "/tasks",
        { goalId: g, objective: "Bad " + name, allowedResources: resources },
        { handler: counting },
      );
      check("AC09:400_" + name, r.status === 400);
    }
    check("AC09:no_sql_before_400", opened.n === 0);
    const foreignOrg = await send(P.A, "POST", "/tasks", {
      goalId: g,
      objective: "Bad org",
      allowedResources: [{ ...W, organizationId: P.Y.org }],
    });
    check("AC09:400_foreign_organization", foreignOrg.status === 400);
    check("AC09:nothing_written", same(totals(), before));
    // The same values straight to cmd_task_create, TypeScript bypassed.
    let invalid = 0;
    for (const resources of [...Object.values(cases), [{ ...W, organizationId: P.Y.org }]]) {
      const out = db.sql(
        asApi(
          P.A,
          `SELECT outcome FROM morrow_work.cmd_task_create('${randomUUID()}','${"f".repeat(64)}','corr',${literal(g)},'Direct',${literal(JSON.stringify(resources))});`,
        ),
        { user: "morrow_api_worker" },
      );
      if (out.split("\n").at(-1) === "invalid") invalid++;
    }
    check("AC09:function_invalid", invalid === 7);
    const direct = db.tryRun(
      asCommandRole(
        P.A,
        `INSERT INTO morrow_work.tasks VALUES(${literal(P.A.org)},${literal(P.A.workspace)},'direct_task',1,${literal(g)},'draft','Direct',${literal(JSON.stringify({ organizationId: P.A.org, workspaceId: P.A.workspace, storeIds: ["store_1"], accountIds: [], resources: [], fields: [] }))},${literal(P.A.principal)},${literal(P.A.membership)},${literal(P.A.principal)},${literal(P.A.membership)},now(),now());`,
      ),
    );
    check(
      "AC09:command_role_insert_violates_valid_scope",
      !direct.ok && /tasks_valid_scope/.test(direct.stderr),
    );
    const store = await send(P.A, "POST", "/goals", {
      ...goalBody("Store scoped"),
      storeIds: ["s1"],
    });
    check("AC09:store_ids_403", store.status === 403);
  });

  // A goal, task, question and answer that every read case shares.
  const g = await goal(P.A, "Read model");
  const t = await task(g);
  const q = await question(t);
  await send(P.B, "POST", "/questions/" + q + "/answer", {
    text: "Lapsed buyers",
    expectedRevision: 1,
  });

  await section("AC10", async () => {
    const reads = [
      "/goals",
      "/goals/" + g,
      "/tasks",
      "/tasks/" + t,
      "/tasks/" + t + "/questions",
      "/questions?respondent=me",
      "/questions/" + q,
      "/questions/" + q + "/answer",
    ];
    let valid = true;
    for (const path of reads) {
      const r = await send(P.V, "GET", path);
      check(
        "AC10:V_reads_" + path.split("/")[1].split("?")[0] + "_" + reads.indexOf(path),
        r.status === 200,
      );
      for (const item of r.body.items ?? [])
        valid &&= validateDefinition(
          "core",
          path.startsWith("/goals")
            ? "Goal"
            : path.startsWith("/tasks") && !path.endsWith("questions")
              ? "Task"
              : "Question",
          item,
        );
      if (r.body.goal) valid &&= validateDefinition("core", "Goal", r.body.goal);
      if (r.body.task) valid &&= validateDefinition("core", "Task", r.body.task);
      if (r.body.question) valid &&= validateDefinition("core", "Question", r.body.question);
    }
    check("AC10:objects_validate", valid);
    const commands = [
      ["POST", "/goals", goalBody("V")],
      ["POST", "/goals/" + g + "/status", { to: "active", expectedRevision: 1 }],
      ["POST", "/tasks", { goalId: g, objective: "V", allowedResources: [] }],
      ["POST", "/tasks/" + t + "/status", { to: "ready", expectedRevision: 1 }],
      ["POST", "/tasks/" + t + "/assignment", { assigneeId: P.B.principal, expectedRevision: 1 }],
      ["POST", "/tasks/" + t + "/questions", { question: "V?", respondentId: P.B.principal }],
      ["POST", "/questions/" + q + "/answer", { text: "V", expectedRevision: 2 }],
      ["POST", "/questions/" + q + "/status", { to: "cancelled", expectedRevision: 2 }],
    ];
    let denied = 0;
    for (const [method, path, body] of commands)
      if ((await send(P.V, method, path, body)).status === 403) denied++;
    check("AC10:V_403_every_command", denied === commands.length);
    let listDenied = 0;
    for (const path of [
      "/goals",
      "/tasks",
      "/questions?respondent=me",
      "/tasks/" + t + "/questions",
    ])
      if ((await send(P.X, "GET", path)).status === 403) listDenied++;
    check("AC10:X_403_lists", listDenied === 4);
    const hidden = await send(P.X, "GET", "/tasks/" + t);
    const absent = await send(P.X, "GET", "/tasks/task_absent_" + randomUUID());
    check(
      "AC10:X_404_identical",
      hidden.status === 404 && strip(hidden.text) === strip(absent.text),
    );
    const v2list = await send(P.V2, "GET", "/goals");
    const v2one = await send(P.V2, "GET", "/goals/" + g);
    check(
      "AC10:V2_field_denied",
      v2list.status === 403 &&
        v2one.status === 403 &&
        v2one.body.safeMessage === "The requested fields are not permitted." &&
        !v2one.text.includes("objective"),
    );
  });

  await section("AC11", async () => {
    const g11 = await goal(P.A, "Ownership");
    const ready = async (p, taskId, revision = 1) =>
      send(p, "POST", "/tasks/" + taskId + "/status", { to: "ready", expectedRevision: revision });
    check("AC11:own_200", (await ready(P.A, await task(g11))).status === 200);
    check("AC11:C_other_403", (await ready(P.C, await task(g11))).status === 403);
    check("AC11:D_administer_200", (await ready(P.D, await task(g11))).status === 200);
    const owned = await task(g11);
    const assign = await send(P.A, "POST", "/tasks/" + owned + "/assignment", {
      assigneeId: P.C.principal,
      expectedRevision: 1,
    });
    // C keeps view but loses execute after the assignment.
    const viewOnly = fixtureGrant(
      P.C,
      "workspace.task.create",
      ["view"],
      capabilityFields().get("workspace.task.create"),
    );
    db.admin(
      `UPDATE morrow_identity.grants SET payload=${literal(JSON.stringify(viewOnly))}::jsonb WHERE id=${literal(viewOnly.id)};`,
    );
    const revoked = await ready(P.C, owned, 2);
    check("AC11:revoked_owner_403", assign.status === 200 && revoked.status === 403);
    const restored = fixtureGrant(
      P.C,
      "workspace.task.create",
      ["view", "execute"],
      capabilityFields().get("workspace.task.create"),
    );
    db.admin(
      `UPDATE morrow_identity.grants SET payload=${literal(JSON.stringify(restored))}::jsonb WHERE id=${literal(restored.id)};`,
    );
  });

  await section("AC13", async () => {
    const t13 = await task(await goal(P.A, "Assignment"));
    const grantsBefore = db.sql(
      "SELECT md5(string_agg(payload::text,'' ORDER BY id)) FROM morrow_identity.grants;",
    );
    const ok = await send(P.A, "POST", "/tasks/" + t13 + "/assignment", {
      assigneeId: P.B.principal,
      expectedRevision: 1,
    });
    const [row] = db.rows(
      `SELECT owner_principal_id::text AS owner, revision::int AS revision FROM morrow_work.tasks WHERE id=${literal(t13)}`,
    );
    const events = db.rows(
      `SELECT event_type, payload FROM morrow_work.outbox_events WHERE aggregate_id=${literal(t13)} AND event_type='task.assigned'`,
    );
    check(
      "AC13:assigned",
      ok.status === 200 &&
        ok.body.revision === 2 &&
        row.owner === P.B.principal &&
        row.revision === 2,
    );
    check(
      "AC13:event",
      events.length === 1 &&
        events[0].payload.ownerPrincipalId === P.B.principal &&
        events[0].payload.assignmentId === ok.body.assignmentId,
    );
    check(
      "AC13:grants_unchanged",
      db.sql(
        "SELECT md5(string_agg(payload::text,'' ORDER BY id)) FROM morrow_identity.grants;",
      ) === grantsBefore,
    );
    const notFound = [];
    for (const target of [P.Y.principal, "person_unknown", P.A2.principal])
      notFound.push(
        await send(P.A, "POST", "/tasks/" + t13 + "/assignment", {
          assigneeId: target,
          expectedRevision: 2,
        }),
      );
    check(
      "AC13:identical_404s",
      notFound.every((r) => r.status === 404) &&
        new Set(notFound.map((r) => strip(r.text))).size === 1,
    );
    const ineligible = await send(P.A, "POST", "/tasks/" + t13 + "/assignment", {
      assigneeId: P.X.principal,
      expectedRevision: 2,
    });
    check(
      "AC13:X_target_ineligible",
      ineligible.status === 409 && ineligible.body.retryClass === "never",
    );
  });

  await section("AC14", async () => {
    const t14 = await task(await goal(P.A, "Questions"));
    const q14 = await question(t14);
    const answer = await send(P.B, "POST", "/questions/" + q14 + "/answer", {
      text: "Gift buyers",
      expectedRevision: 1,
    });
    const [qrow] = db.rows(`SELECT status FROM morrow_work.questions WHERE id=${literal(q14)}`);
    const sameCommit = db.rows(
      `SELECT count(*)::int AS n FROM morrow_work.outbox_events e JOIN morrow_work.commands c ON c.correlation_id=e.correlation_id AND c.aggregate_id=e.aggregate_id WHERE e.aggregate_id=${literal(q14)} AND e.event_type='question.answered' AND c.command_type='question.answer' AND e.xmin=c.xmin`,
    );
    check("AC14:answered", answer.status === 200 && qrow.status === "answered");
    check(
      "AC14:answer_digest",
      answer.body.answerRef.digest === sha("Gift buyers") &&
        validateDefinition("core", "AnswerRef", answer.body.answerRef),
    );
    check("AC14:event_same_transaction", sameCommit[0].n === 1);
    const q2 = await question(t14);
    const forB = await send(P.A, "POST", "/questions/" + q2 + "/answer", {
      text: "Not mine",
      expectedRevision: 1,
    });
    check("AC14:A_answering_for_B_403", forB.status === 403);
    const second = await send(P.B, "POST", "/questions/" + q14 + "/answer", {
      text: "Again",
      expectedRevision: 2,
    });
    check("AC14:second_answer_409", second.status === 409);
    const askE = await send(P.A, "POST", "/tasks/" + t14 + "/questions", {
      question: "E?",
      respondentId: P.E.principal,
    });
    check("AC14:E_target_ineligible", askE.status === 409 && askE.body.retryClass === "never");
    const askY = await send(P.A, "POST", "/tasks/" + t14 + "/questions", {
      question: "Y?",
      respondentId: P.Y.principal,
    });
    check("AC14:Y_404", askY.status === 404);
    // §4.7 step 4: C cannot view questions, so A's question is not found for C (404);
    // a viewer who is neither the requester nor an administrator gets 403.
    const cCancel = await send(P.C, "POST", "/questions/" + q2 + "/status", {
      to: "cancelled",
      expectedRevision: 1,
    });
    const vCancel = await send(P.V, "POST", "/questions/" + q2 + "/status", {
      to: "cancelled",
      expectedRevision: 1,
    });
    check("AC14:non_requester_refused", cCancel.status === 404 && vCancel.status === 403);
    const cancel = await send(P.A, "POST", "/questions/" + q2 + "/status", {
      to: "cancelled",
      expectedRevision: 1,
    });
    check("AC14:requester_cancels", cancel.status === 200 && cancel.body.status === "cancelled");
    const q3 = await question(t14);
    const open = await pages(P.B, "/questions?respondent=me&status=open");
    check(
      "AC14:open_for_me",
      open.status === 200 &&
        open.body.items.length > 0 &&
        open.body.items.every(
          (i) => i.status === "open" && same(i.eligibleRespondentIds, [P.B.principal]),
        ) &&
        open.body.items.some((i) => i.id === q3) &&
        !open.body.items.some((i) => i.id === q14 || i.id === q2),
    );
    const otherOpen = await pages(P.A, "/questions?respondent=me&status=open");
    check(
      "AC14:not_listed_for_others",
      otherOpen.status === 200 && !otherOpen.body.items.some((i) => i.id === q3),
    );
  });

  await section("AC15", async () => {
    const revokerApp = "morrow_work_revoker";
    async function windowed(
      p,
      during,
      { beforeCommit = false, key, body = goalBody("Window " + randomUUID()) } = {},
    ) {
      const hold = gate();
      const handler = handlerWith({
        async beforeQuery(record, connection) {
          if (beforeCommit ? record.text === statement("commit") : isCommand(record))
            await hold.wait(connection);
        },
      });
      const reply = send(p, "POST", "/goals", body, { handler, key });
      await reached(hold, reply);
      const result = await during(hold);
      hold.open();
      return [await reply, result];
    }
    // (a) A revocation waits for the share lock of a command paused before COMMIT.
    let revocation;
    const [a] = await windowed(
      P.R,
      async () => {
        revocation = db.runAsync(revocationSql(P.R), { applicationName: revokerApp });
        return db.waitForLockWait(`application_name='${revokerApp}'`);
      },
      { beforeCommit: true },
    );
    const revoked = await revocation;
    const afterA = await send(P.R, "GET", "/goals");
    check("AC15:a_command_commits_first", a.status === 201 && revoked.ok);
    check("AC15:a_next_request_401", afterA.status === 401);
    db.sql(restoreSql(P.R));
    // (b) The actor's revocation commits inside the window: 401, nothing written.
    const beforeB = totals();
    const [b] = await windowed(P.R, async () => db.runAsync(revocationSql(P.R)));
    check("AC15:b_ineligible_401", b.status === 401 && same(totals(), beforeB));
    db.sql(restoreSql(P.R));
    // (c) Another member of O is revoked inside the window: 409, then a same-key retry applies.
    const key = randomUUID();
    const body = goalBody("Retry after stale " + key);
    const beforeC = totals();
    const [c] = await windowed(P.R, async () => db.runAsync(revocationSql(P.S)), { key, body });
    check(
      "AC15:c_stale_authority",
      c.status === 409 && c.body.retryClass === "recheck_before_retry" && same(totals(), beforeC),
    );
    db.sql(restoreSql(P.S));
    const retry = await send(P.R, "POST", "/goals", body, { key });
    check("AC15:c_retry_applies", retry.status === 201);
    // (d) A maintenance edit to the actor's grant inside the window.
    const grant = P.R.grants.find((x) => x.capabilityId === "workspace.goal.create");
    const edited = {
      ...grant,
      scope: { ...grant.scope, fields: [...grant.scope.fields].reverse() },
    };
    const beforeD = totals();
    const [d] = await windowed(P.R, async () =>
      db.runAsync(
        `SET ROLE morrow_identity_owner; UPDATE morrow_identity.grants SET payload=${literal(JSON.stringify(edited))}::jsonb WHERE id=${literal(grant.id)};`,
      ),
    );
    check("AC15:d_grant_edit_stale", d.status === 409 && same(totals(), beforeD));
    // (d) The grant's expiresAt passes inside the window.
    const expiresAt = new Date(Date.now() + 2500).toISOString();
    const expiring = { ...grant, expiresAt };
    db.admin(
      `UPDATE morrow_identity.grants SET payload=${literal(JSON.stringify(expiring))}::jsonb WHERE id=${literal(grant.id)};`,
    );
    const [e] = await windowed(P.R, async () => {
      await sleep(Math.max(0, Date.parse(expiresAt) - Date.now() + 200));
    });
    check("AC15:d_grant_expiry_stale", e.status === 409 && same(totals(), beforeD));
    db.admin(
      `UPDATE morrow_identity.grants SET payload=${literal(JSON.stringify(grant))}::jsonb WHERE id=${literal(grant.id)};`,
    );
  });

  await section("AC16", async () => {
    for (const [name, lose, expectedRetry] of [
      ["command_reply", (record) => isCommand(record), 201],
      ["commit_reply", (record) => record.text === statement("commit"), 200],
    ]) {
      const objective = "Unknown " + name + " " + randomUUID();
      const key = randomUUID();
      const handler = handlerWith({
        async afterQuery(record, connection) {
          if (lose(record)) await connection.loseReply();
        },
      });
      const first = await send(P.A, "POST", "/goals", goalBody(objective), { key, handler });
      const retry = await send(P.A, "POST", "/goals", goalBody(objective), { key });
      check(
        "AC16:" + name + "_uncertain",
        first.status === 503 &&
          first.body.code === "uncertain" &&
          first.body.retryClass === "reconcile_before_retry",
      );
      check(
        "AC16:" + name + "_retry_" + expectedRetry,
        retry.status === expectedRetry && (expectedRetry === 201 || retry.body.replayed === true),
      );
      check(
        "AC16:" + name + "_one_effect",
        count("goals", `objective=${literal(objective)}`) === 1,
      );
    }
  });

  await section("AC17", async () => {
    const marker = "MARKER" + randomUUID().replaceAll("-", "");
    const g17 = await goal(P.A, "Objective " + marker);
    await send(P.A, "POST", "/goals", goalBody("Criteria", "Criterion " + marker));
    const t17 = await task(g17);
    const q17 = (
      await send(P.A, "POST", "/tasks/" + t17 + "/questions", {
        question: "Prompt " + marker,
        respondentId: P.B.principal,
      })
    ).body.questionId;
    await send(P.B, "POST", "/questions/" + q17 + "/answer", {
      text: "Answer " + marker,
      expectedRevision: 1,
    });
    // TypeScript bypassed: each forced failure is decided before any CHECK fires.
    const qc = await question(t17);
    await send(P.A, "POST", "/questions/" + qc + "/status", {
      to: "cancelled",
      expectedRevision: 1,
    });
    const k = () => randomUUID();
    const d = "9".repeat(64);
    const forced = {
      oversize_objective: `SELECT outcome FROM morrow_work.cmd_goal_create('${k()}','${d}','corr',${literal(marker.repeat(300))},'[]')`,
      nul_criteria: `SELECT outcome FROM morrow_work.cmd_goal_create('${k()}','${d}','corr','ok',${literal('[{"description":"' + marker + '\\u0000","verificationCapabilityId":null,"evidenceRequired":false}]')})`,
      oversize_prompt: `SELECT outcome FROM morrow_work.cmd_question_request('${k()}','${d}','corr',${literal(t17)},${literal(marker.repeat(300))},${literal(P.B.principal)})`,
      wrong_tenant_scope: `SELECT outcome FROM morrow_work.cmd_task_create('${k()}','${d}','corr',${literal(g17)},${literal(marker)},${literal(JSON.stringify([{ ...workspaceResource(P.Y.org, P.A.workspace) }]))})`,
      oversize_answer: `SELECT outcome FROM morrow_work.cmd_question_answer('${k()}','${d}','corr',${literal(qc)},'${k()}',${literal(marker.repeat(300))},'2')`,
    };
    let decided = 0;
    for (const [name, call] of Object.entries(forced)) {
      const out = db
        .sql(asApi(P.A, call + ";"), { user: "morrow_api_worker" })
        .split("\n")
        .at(-1);
      if (out === "invalid") decided++;
      else print("AC17 forced " + name + " -> " + out);
    }
    const afterCancel = db
      .sql(
        asApi(
          P.B,
          `SELECT outcome FROM morrow_work.cmd_question_answer('${k()}','${d}','corr',${literal(qc)},'${k()}',${literal("Late " + marker)},'2');`,
        ),
        { user: "morrow_api_worker" },
      )
      .split("\n")
      .at(-1);
    check("AC17:forced_failures_decided", decided === 5 && afterCancel === "state_conflict");
    const outbox = db.sql("SELECT string_agg(payload::text,'') FROM morrow_work.outbox_events;");
    check("AC17:outbox_has_no_markers", !outbox.includes(marker));
    check(
      "AC17:errors_have_no_markers",
      !responses.filter((r) => r.includes('"code"')).some((r) => r.includes(marker)),
    );
    check(
      "AC17:console_has_no_markers",
      consoleLines.length > 0 && !consoleLines.some((l) => l.includes(marker)),
    );
    const logs = db.logs();
    check("AC17:postgres_log_has_no_markers", !logs.includes(marker));
    check("AC17:postgres_log_has_no_failing_row", !logs.includes("Failing row contains"));
  });

  await section("AC20", async () => {
    const owner = P.A2;
    const observed = [];
    let running = true;
    const observer = (async () => {
      while (running) {
        const r = await db.runAsync(
          `SELECT count(*)||'|'||COALESCE(max(position),0) FROM morrow_work.outbox_events WHERE workspace_id=${literal(owner.workspace)};`,
        );
        if (r.ok) observed.push(r.stdout.split("\n").at(-1));
      }
    })();
    // Every command is retried with its own key until it is decided: an unknown or
    // unavailable outcome is reconciled by the same key, never by a new effect.
    async function decided(path, body) {
      const key = randomUUID();
      for (let attempt = 0; attempt < 20; attempt++) {
        const reply = await send(owner, "POST", path, body, { key });
        if (reply.status !== 503) return reply;
        await sleep(100);
      }
      throw Error("AC20_UNDECIDED");
    }
    const sequence = ["active", "paused", "active", "paused"];
    const worker = async () => {
      for (let i = 0; i < 10; i++) {
        const created = await decided("/goals", goalBody("Outbox " + randomUUID()));
        let revision = 1;
        for (const to of sequence) {
          const r = await decided("/goals/" + created.body.goalId + "/status", {
            to,
            expectedRevision: revision,
          });
          if (r.status !== 200) throw Error("AC20_TRANSITION_" + r.status);
          revision = r.body.revision;
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    running = false;
    await observer;
    const ws = literal(owner.workspace);
    const positions = db
      .rows(
        `SELECT position::int AS p FROM morrow_work.outbox_events WHERE workspace_id=${ws} ORDER BY position`,
      )
      .map((r) => r.p);
    check(
      "AC20:positions_1_200",
      positions.length === 200 && positions.every((p, i) => p === i + 1),
    );
    check(
      "AC20:commit_order_never_gapped",
      observed.length > 0 && observed.every((o) => o.split("|")[0] === o.split("|")[1]),
    );
    const paired = db.rows(
      `SELECT count(*)::int AS n FROM morrow_work.commands c JOIN morrow_work.outbox_events e ON e.organization_id=c.organization_id AND e.workspace_id=c.workspace_id AND e.aggregate_id=c.aggregate_id AND e.aggregate_revision=c.aggregate_revision AND e.correlation_id=c.correlation_id AND e.xmin=c.xmin WHERE c.workspace_id=${ws}`,
    );
    check(
      "AC20:one_event_per_command_same_commit",
      paired[0].n === 200 && count("commands", `workspace_id=${ws}`) === 200,
    );
    const gaps = db.rows(
      `SELECT aggregate_id, array_agg(aggregate_revision::int ORDER BY aggregate_revision) AS r FROM morrow_work.outbox_events WHERE workspace_id=${ws} GROUP BY aggregate_id`,
    );
    check(
      "AC20:contiguous_revisions",
      gaps.length === 40 && gaps.every((g) => same(g.r, [1, 2, 3, 4, 5])),
    );
    const keys = db.rows(
      `SELECT DISTINCT event_type, (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(payload) k) AS keys FROM morrow_work.outbox_events`,
    );
    const allow = {
      "goal.created": ["status"],
      "goal.status_changed": ["from", "to"],
      "task.status_changed": ["from", "to"],
      "task.created": ["goalId", "status"],
      "task.assigned": ["assignmentId", "ownerPrincipalId"],
      "question.requested": ["respondentPrincipalId"],
      "question.answered": ["answerId"],
      "question.cancelled": null,
    };
    check(
      "AC20:payload_allowlist",
      keys.every((k) => same(k.keys, allow[k.event_type])),
    );
  });

  await section("AC24", async () => {
    const result = db.sql(
      "SELECT pg_get_function_result('morrow_identity.session_eligibility(text,text)'::regprocedure);",
    );
    check(
      "AC24:five_columns",
      result ===
        "TABLE(principal_id text, organization_id text, workspace_id text, membership_id text, policy_revision bigint)",
    );
    const drop = db.tryRun(
      "BEGIN; SET LOCAL ROLE morrow_identity_owner; DROP FUNCTION morrow_identity.session_eligibility(text,text); ROLLBACK;",
    );
    check(
      "AC24:drop_blocked_by_bridge",
      !drop.ok && /other objects depend on it|work_session_context/.test(drop.stderr),
    );
  });

  await section("AC25", async () => {
    const G = {
      key: "G",
      principal: "person_g",
      membership: "membership_g",
      org: P.A.org,
      workspace: P.A.workspace,
    };
    const secret = createHash("sha256").update(randomUUID()).digest().toString("base64url");
    G.secret = secret;
    G.digest = sha(secret);
    const actor = JSON.stringify(fixtureActor(G));
    const scope = JSON.stringify({
      organizationId: G.org,
      workspaceId: G.workspace,
      storeIds: [],
      accountIds: [],
      resources: [workspaceResource(G.org, G.workspace)],
      fields: ["status"],
    });
    db.admin(`INSERT INTO morrow_identity.principals VALUES('person_g','human',true);
INSERT INTO morrow_identity.memberships VALUES('membership_g',${literal(G.org)},'person_g',true);
INSERT INTO morrow_identity.workspace_memberships VALUES(${literal(G.org)},${literal(G.workspace)},'membership_g',true);
INSERT INTO morrow_identity.sessions VALUES('session_g','person_g',${literal(G.org)},${literal(G.digest)},'workos','provider_session_g',clock_timestamp()+interval '1 day',NULL);
INSERT INTO morrow_identity.grants SELECT 'grant_g_'||i,${literal(G.org)},${literal(G.workspace)},'membership_g','person_g',jsonb_build_object('id','grant_g_'||i,'principal',${literal(actor)}::jsonb,'capabilityId','workspace.goal.create','verbs','["view","execute"]'::jsonb,'scope',${literal(scope)}::jsonb,'issuedBy',${literal(actor)}::jsonb,'validFrom','2026-01-01T00:00:00.000Z','expiresAt',NULL,'revokedAt',NULL,'policyRevision',1) FROM generate_series(1,1001) i;`);
    const before = totals();
    const read = await send(G, "GET", "/goals");
    const command = await send(G, "POST", "/goals", goalBody("Overflow"));
    check("AC25:read_403", read.status === 403);
    check("AC25:command_403", command.status === 403);
    check("AC25:nothing_written", same(totals(), before));
  });

  if (soak)
    await section("soak", async () => {
      const deadlocks = () =>
        Number(db.sql("SELECT deadlocks FROM pg_stat_database WHERE datname='morrow';"));
      const start = deadlocks();
      const worker = async () => {
        for (let i = 0; i < 100; i++) {
          const created = await send(P.A, "POST", "/goals", goalBody("Soak " + randomUUID()));
          if (created.status !== 201) continue;
          const taskReply = await send(P.A, "POST", "/tasks", {
            goalId: created.body.goalId,
            objective: "Soak",
            allowedResources: [],
          });
          await send(P.A, "POST", "/goals/" + created.body.goalId + "/status", {
            to: "active",
            expectedRevision: 1,
          });
          if (taskReply.status === 201) {
            await send(P.A, "POST", "/tasks/" + taskReply.body.taskId + "/status", {
              to: "ready",
              expectedRevision: 1,
            });
            await send(P.A, "POST", "/tasks/" + taskReply.body.taskId + "/questions", {
              question: "Soak?",
              respondentId: P.B.principal,
            });
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      check("soak:zero_deadlocks", deadlocks() === start);
    });
});

console.log = print;
const report = {
  task: "P06.T01a",
  qualification: "local_postgresql17_network_none_work_api_acceptance",
  mode: soak ? "soak_and_full_race_matrix" : "pull_request",
  observedAt: new Date().toISOString(),
  durationMs: Date.now() - started,
  checks,
  workerLogLines: consoleLines.length,
  // Load-induced 503s retried as the contract allows (reads, and same-key setup).
  unavailableRetries,
  limitations: [
    "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data.",
    "The 0004 revocation is reproduced by owner maintenance with the same lock order and effects, not through its lifecycle receipts.",
    "AC12, AC21-AC23 and the lease revocation signal of AC16 are qualified in workerd by lab:work-workers.",
  ],
};
writeArtifact("labs/work-postgresql.json", report);
if (failures.length) {
  print("FAILED: " + failures.join(", "));
  process.exitCode = 1;
} else print(`PASS: ${checks.length} P06.T01a PostgreSQL checks${soak ? " (soak)" : ""}.`);
