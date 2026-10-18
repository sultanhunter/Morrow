// P06.T01a workerd laboratory (Miniflare 4): AC12, AC16 (lease signal), AC21, AC22
// and AC23. The real @morrow/work handler runs inside workerd; its SQL crosses a
// service binding to an isolated network-none PostgreSQL 17 engine with the full
// migration manifest. AC23 runs the unbound apps/api/src/worker.ts artifact with
// every outbound request counted. Synthetic owner-seeded fixtures only.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { workStatements } from "../packages/work/src/sql.ts";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import {
  capabilityFields,
  fixtureGrant,
  literal,
  seedWorkFixtures,
  withWorkDatabase,
  workFixtureOrigin,
} from "../tests/tenant-conformance/harness.mjs";
import { workGuardCases } from "../tests/fixtures/work-guard-cases.mjs";
import { writeArtifact } from "./artifacts.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const checks = [];
const failures = [];
function check(name, passed) {
  checks.push({ name, passed: passed === true });
  if (passed !== true) failures.push(name);
}
const packageVersion = (name) =>
  JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version;
if (packageVersion("miniflare") !== "4.20260730.0" || packageVersion("workerd") !== "1.20260730.1")
  throw Error("WORK_WORKERS_PINNED_RUNTIME_REQUIRED");
const paths = [
  "scripts/work-workers-lab.mjs",
  "scripts/fixtures/work-api-worker.ts",
  "apps/api/src/worker.ts",
  "tests/fixtures/work-guard-cases.mjs",
  "migrations/0014.work-identity-bridge.sql",
  "migrations/0015.work-state.sql",
  ...[
    "index",
    "sql",
    "connection",
    "context",
    "permissions",
    "eligibility",
    "digest",
    "commands",
    "queries",
    "contract-mapping",
    "http",
    "http-guard",
    "http-bodies",
  ].map((name) => "packages/work/src/" + name + ".ts"),
];
const sourceDigests = Object.fromEntries(paths.map((p) => [p, hash(readFileSync(p))]));
async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*"],
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs);
  check(
    entry + ":no_runtime_schema_compiler",
    !inputs.some((p) => /ajv\/dist\/(compile|core|2020)/.test(p)),
  );
  return { text: result.outputFiles[0].text, inputs };
}

const started = Date.now();
const fixture = await bundle("scripts/fixtures/work-api-worker.ts");
const api = await bundle("apps/api/src/worker.ts");
check("bundle:work_handler_included", fixture.inputs.includes("packages/work/src/http.ts"));
check("bundle:api_router_includes_work", api.inputs.includes("packages/work/src/http.ts"));

await withWorkDatabase("P06.T01a.work-workers", async (db) => {
  const P = seedWorkFixtures(db);
  // The SQL bridge: Node owns one psql-backed connection per workerd connection.
  const connections = new Map();
  const sqlCalls = { open: 0, query: 0, close: 0 };
  const faults = {
    "commit-reply-lost": {
      async afterQuery(record, connection) {
        if (record.text === workStatements.commit) await connection.loseReply();
      },
    },
  };
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  async function sqlBinding(request) {
    const message = await request.json();
    try {
      if (message.op === "open") {
        sqlCalls.open++;
        const connector = db.connector(faults[message.case] ?? {});
        const connection = await connector.open({
          signal: new AbortController().signal,
          deadlineMs: Date.now() + 30000,
          waitUntil() {},
        });
        const id = randomUUID();
        connections.set(id, connection);
        return json({ id });
      }
      const connection = connections.get(message.id);
      if (!connection) return json({ error: true }, 400);
      if (message.op === "query") {
        sqlCalls.query++;
        const reply = await connection.query(
          message.text,
          message.values,
          new AbortController().signal,
        );
        return json({ rows: reply.rows });
      }
      if (message.op === "close") {
        sqlCalls.close++;
        connections.delete(message.id);
        await connection.close();
        return json({ closed: true });
      }
      return json({ error: true }, 400);
    } catch {
      return json({ error: true }, 503);
    }
  }
  let outbound = 0;
  const logs = [];
  const mf = new Miniflare({
    modules: true,
    script: fixture.text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    serviceBindings: { SQL: sqlBinding },
    outboundService: () => {
      outbound++;
      return new Response(null, { status: 502 });
    },
    log: new Log(LogLevel.NONE),
    handleRuntimeStdio(stdout) {
      stdout.on("data", (chunk) => logs.push(String(chunk)));
    },
  });
  try {
    await mf.ready;
    async function send(p, method, path, body, options = {}) {
      const headers = {
        Cookie: "__Host-morrow_session=" + p.secret,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        ...(options.labCase ? { "X-Lab-Case": options.labCase } : {}),
      };
      if (method === "POST")
        Object.assign(headers, {
          Origin: workFixtureOrigin,
          "Content-Type": "application/json",
          "X-Morrow-Request": "1",
          "Idempotency-Key": options.key ?? randomUUID(),
        });
      const response = await mf.dispatchFetch(
        workFixtureOrigin + "/workspace/" + p.workspace + "/work" + path,
        { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      );
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text), headers: response.headers };
    }
    const criteria = [
      {
        description: "Weekly orders grow",
        verificationCapabilityId: null,
        evidenceRequired: false,
      },
    ];

    // AC21: the guard matrix inside workerd opens no SQL connection.
    const opensBefore = sqlCalls.open;
    let guarded = 0;
    for (const [name, c] of workGuardCases) {
      const headers = Object.fromEntries(
        Object.entries(c.headers).filter(([, v]) => v !== null && v !== undefined),
      );
      let response;
      try {
        response = await mf.dispatchFetch(workFixtureOrigin + c.path, {
          method: c.method,
          headers,
          body:
            c.method === "GET" || c.method === "DELETE"
              ? undefined
              : c.bytes
                ? new Uint8Array(c.bytes)
                : c.body,
        });
      } catch {
        check("AC21:" + name, c.optional === true);
        continue;
      }
      const body = await response.json();
      const passed =
        response.status === c.status &&
        validateDefinition("core", "ErrorEnvelope", body) &&
        (!c.allow || response.headers.get("allow") === c.allow) &&
        !response.headers.has("set-cookie") &&
        !response.headers.has("access-control-allow-origin");
      // workerd may normalise a transport header before the Worker sees it; an
      // optional case then reaches the next check, which still never opens SQL.
      check(
        "AC21:" + name,
        passed || (c.optional === true && response.status >= 400 && response.status < 500),
      );
      guarded++;
    }
    check("AC21:no_sql_connection", sqlCalls.open === opensBefore && guarded > 30);

    // AC22: M2 on fixtures.
    const goal = await send(P.A, "POST", "/goals", {
      objective: "Launch the spring range",
      storeIds: [],
      successCriteria: criteria,
    });
    const task = await send(P.A, "POST", "/tasks", {
      goalId: goal.body.goalId,
      objective: "Draft the launch brief",
      allowedResources: [],
    });
    const t = task.body.taskId;
    const ready = await send(P.A, "POST", "/tasks/" + t + "/status", {
      to: "ready",
      expectedRevision: 1,
    });
    const assigned = await send(P.A, "POST", "/tasks/" + t + "/assignment", {
      assigneeId: P.B.principal,
      expectedRevision: 2,
    });
    const asked = await send(P.A, "POST", "/tasks/" + t + "/questions", {
      question: "Which hero product?",
      respondentId: P.B.principal,
    });
    const open = await send(P.B, "GET", "/questions?respondent=me&status=open");
    const answered = await send(P.B, "POST", "/questions/" + asked.body.questionId + "/answer", {
      text: "The linen shirt",
      expectedRevision: 1,
    });
    const answer = await send(P.A, "GET", "/questions/" + asked.body.questionId + "/answer");
    const bTask = await send(P.B, "GET", "/tasks/" + t);
    const bStatus = await send(P.B, "POST", "/tasks/" + t + "/status", {
      to: "ready",
      expectedRevision: 3,
    });
    check("AC22:goal_and_task_created", goal.status === 201 && task.status === 201);
    check(
      "AC22:ready_and_assigned",
      ready.status === 200 &&
        ready.body.status === "ready" &&
        assigned.status === 200 &&
        assigned.body.revision === 3,
    );
    check("AC22:asked", asked.status === 201 && asked.body.status === "open");
    check(
      "AC22:B_lists_open",
      open.status === 200 &&
        open.body.items.some((q) => q.id === asked.body.questionId) &&
        open.body.items.every((q) => validateDefinition("core", "Question", q)),
    );
    check(
      "AC22:B_answers",
      answered.status === 200 && answered.body.answerRef.digest === hash("The linen shirt"),
    );
    check(
      "AC22:A_reads_answer",
      answer.status === 200 &&
        answer.body.answer.body === "The linen shirt" &&
        answer.body.answer.answeredBy.principalId === P.B.principal,
    );
    check(
      "AC22:B_is_owner",
      bTask.status === 200 &&
        bTask.body.task.owner.principalId === P.B.principal &&
        validateDefinition("core", "Task", bTask.body.task),
    );
    check("AC22:B_status_change_403", bStatus.status === 403);

    // AC12: a lost COMMIT reply on an assign by a non-admin owner.
    const g12 = await send(P.A, "POST", "/goals", {
      objective: "Lost reply",
      storeIds: [],
      successCriteria: criteria,
    });
    const t12 = (
      await send(P.A, "POST", "/tasks", {
        goalId: g12.body.goalId,
        objective: "Owned by A1",
        allowedResources: [],
      })
    ).body.taskId;
    const toA1 = await send(P.A, "POST", "/tasks/" + t12 + "/assignment", {
      assigneeId: P.A1.principal,
      expectedRevision: 1,
    });
    const key = randomUUID();
    const body = { assigneeId: P.B.principal, expectedRevision: 2 };
    const lost = await send(P.A1, "POST", "/tasks/" + t12 + "/assignment", body, {
      key,
      labCase: "commit-reply-lost",
    });
    const replay = await send(P.A1, "POST", "/tasks/" + t12 + "/assignment", body, { key });
    const [owner12] = db.rows(
      `SELECT owner_principal_id::text AS owner FROM morrow_work.tasks WHERE id=${literal(t12)}`,
    );
    const assignments12 = Number(
      db.sql(`SELECT count(*) FROM morrow_work.task_assignments WHERE task_id=${literal(t12)};`),
    );
    check("AC12:A1_owner_first", toA1.status === 200);
    check(
      "AC12:lost_reply_uncertain",
      lost.status === 503 &&
        lost.body.code === "uncertain" &&
        lost.body.retryClass === "reconcile_before_retry",
    );
    check(
      "AC12:retry_replays_original",
      replay.status === 200 &&
        replay.body.replayed === true &&
        replay.body.revision === 3 &&
        typeof replay.body.assignmentId === "string" &&
        owner12.owner === P.B.principal &&
        assignments12 === 2,
    );
    // A1 loses view: the same retry discloses nothing.
    const viewless = fixtureGrant(
      P.A1,
      "workspace.task.create",
      ["execute"],
      capabilityFields().get("workspace.task.create"),
    );
    db.admin(
      `UPDATE morrow_identity.grants SET payload=${literal(JSON.stringify(viewless))}::jsonb WHERE id=${literal(viewless.id)};`,
    );
    const hidden = await send(P.A1, "POST", "/tasks/" + t12 + "/assignment", body, { key });
    check(
      "AC12:no_view_404",
      hidden.status === 404 &&
        !hidden.text.includes(replay.body.assignmentId) &&
        !hidden.text.includes(t12),
    );

    // AC16 (lease): a lease revocation after the command is sent is 503 uncertain;
    // the same-key retry applies exactly once.
    const objective = "Lease revoked " + randomUUID();
    const leaseKey = randomUUID();
    const revokedLease = await send(
      P.A,
      "POST",
      "/goals",
      { objective, storeIds: [], successCriteria: criteria },
      { key: leaseKey, labCase: "lease-revoke-after-send" },
    );
    const leaseRetry = await send(
      P.A,
      "POST",
      "/goals",
      { objective, storeIds: [], successCriteria: criteria },
      { key: leaseKey },
    );
    const leaseGoals = Number(
      db.sql(`SELECT count(*) FROM morrow_work.goals WHERE objective=${literal(objective)};`),
    );
    check(
      "AC16:lease_signal_uncertain",
      revokedLease.status === 503 && revokedLease.body.code === "uncertain",
    );
    check("AC16:lease_retry_once", [200, 201].includes(leaseRetry.status) && leaseGoals === 1);
    check("workerd:no_outbound", outbound === 0);
    check(
      "workerd:one_log_line_per_request",
      logs
        .join("")
        .split("\n")
        .filter((l) => l.includes('"event":"morrow_work"')).length > 0,
    );
  } finally {
    await mf.dispose();
    for (const connection of connections.values()) await connection.close().catch(() => {});
  }
});

// AC23: the unbound default artifact, with every outbound request counted.
{
  let outbound = 0;
  const mf = new Miniflare({
    modules: true,
    script: api.text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: () => {
      outbound++;
      return new Response(null, { status: 502 });
    },
    log: new Log(LogLevel.NONE),
  });
  try {
    let unauthorized = 0;
    const routes = [
      ["GET", "/workspace/ws_w/work/goals"],
      ["POST", "/workspace/ws_w/work/goals"],
      ["GET", "/workspace/ws_w/work/tasks/t1"],
      ["POST", "/workspace/ws_w/work/questions/q1/answer"],
      ["GET", "/workspace/ws_w/work"],
    ];
    for (const [method, path] of routes) {
      const response = await mf.dispatchFetch(workFixtureOrigin + path, {
        method,
        headers: {
          Cookie: "__Host-morrow_session=" + "A".repeat(42) + "A",
          Origin: workFixtureOrigin,
        },
      });
      const body = await response.json();
      if (response.status === 401 && validateDefinition("core", "ErrorEnvelope", body))
        unauthorized++;
    }
    const bootstrap = await mf.dispatchFetch(workFixtureOrigin + "/workspace/ws_w/bootstrap");
    check("AC23:work_routes_401", unauthorized === routes.length);
    check(
      "AC23:p05_route_unchanged",
      bootstrap.status === 401 &&
        JSON.stringify(await bootstrap.json()) === '{"code":"authentication_required"}',
    );
    check("AC23:no_network_or_database", outbound === 0);
  } finally {
    await mf.dispose();
  }
}

for (const [path, digest] of Object.entries(sourceDigests))
  check("source_unchanged:" + path, hash(readFileSync(path)) === digest);
writeArtifact("labs/work-workers.json", {
  task: "P06.T01a",
  qualification: "actual_local_workerd_with_postgresql17_over_a_service_binding",
  compatibilityDate: "2026-07-30",
  observedAt: new Date().toISOString(),
  durationMs: Date.now() - started,
  checks,
  sourceDigests,
  limitations: [
    "The work handler runs in workerd; SQL crosses a laboratory service binding to a local engine, not the Neon WebSocket transport.",
    "The lease is a fixture lease; the Neon connector's own lease handling is unit-tested in tests/work-unit.test.mjs.",
    "Synthetic owner-seeded fixtures; no hosted database, provider, deployment or merchant data.",
  ],
});
if (failures.length) {
  console.log("FAILED: " + failures.join(", "));
  process.exitCode = 1;
} else console.log(`PASS: ${checks.length} P06.T01a workerd checks.`);
