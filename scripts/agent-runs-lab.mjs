// Plan row H7a PostgreSQL 17 laboratory: the agent loop's data model (migration agent-runs,
// ADR-0041 item 4) on an isolated network-none engine, the full manifest applied by the
// Neon-shaped non-superuser CREATEROLE administrator (ADR-0020 D4). One case per lease source
// of ADR-0041 item 7's table, then the data model's safety ranges, tenancy and content rules:
//   A  a person's act, admission: with the switch off, switch_off before any statement; a
//      proposed catalogue or context policy admits nothing; published (sim), one transaction
//      writes the job, its context, the run (lineage, segment 1 incarnation 1, the safety
//      profile composed from the version's template and the entry's max_tokens, the pins, the
//      envelope of 7 days and 24 hours active, the lease <run>), segment 1 and run.admitted;
//      a forged manifest persists nothing; no turn, call, question or time limit column exists;
//   P  a person's act, the answer: only the requester answers an open question wait; it
//      resolves the wait (answered, person_act), queues the run under the lease <run>:w1 and
//      renews the envelope; a lapsed wait is refused expired;
//   M  admit_mandate_run from one trigger row: not built for agent runs (ADR-0024's mandate
//      packet): no definer admits a mandate run, and no login can write one;
//   C  child, fork and review admission: not built (H10, H11): no definer admits a call or a
//      review run, and no login can write one or a call row;
//   R  per-step renewal (agent_run_lease_renew): another step with time left is current; a
//      turn step renews to <run>:l1 and releases the entered lease; another incarnation is
//      superseded and writes nothing; past the envelope the run checks in (a check-in wait,
//      its lease released); after a stop or a revoke no lease can be entered to renew; a
//      disabled installation ends the run lease_ended;
//   W  wait resolution (agent_run_resume): a due timer and a resolvable wait resume under
//      <run>:w<sequence> after admission's checks; a question is the requester's only; past
//      the envelope it is refused with no write; under a stop nothing persists; a wait past
//      its lapse time never resumes;
//   U  upkeep admission (admit_upkeep_run): one pending trigger admits one upkeep run (its
//      manifest built in SQL with the digest code computes), again answers admitted_before, a
//      second pending trigger for the same notebook is refused, a revoked requester admits
//      nothing, a disabled installation skips the trigger;
//   F  standing-request firing: not built (H17): no definer, no table;
//   S  the sweep (agent_run_wake_candidates): ids, positions and one action each; it issues
//      no lease and writes nothing; segment rolls record <run>-s2-i1 and replay safely;
//   D  safety ranges only (turns 1 to 100,000, tool calls per turn 1 to 64, max_output_tokens
//      up to 128,000, a call budget up to 30 minutes, person waits 1 to 365 days, the stored
//      message and the reply's own stored size), FORCE RLS everywhere, no DELETE, the api's
//      column grants, and no content in the run events.
// Owner-seeded synthetic fixtures only; no provider, credential or merchant data. Shapes
// marked sim stand in for states no API path reaches yet (the runner is H7b's).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { listingFieldPaths, storeResource } from "../packages/policy/src/store-resource.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { createAgentsApiHandler } from "../packages/work/src/agents/http.ts";
import { createWorkApiHandler } from "../packages/work/src/http.ts";
import { withWorkTransaction } from "../packages/work/src/connection.ts";
import { canonicalJson } from "../packages/work/src/digest.ts";
import { admitRoutedRun, answerRunQuestion } from "../packages/work/src/loop/admission.ts";
import { runSafety } from "../packages/policy/src/run-safety.ts";
import {
  revocationSql,
  literal,
  seedWorkFixtures,
  sleep,
  storeInstallationSql,
  withWorkDatabase,
  workFixtureOrigin,
  workRequest,
} from "../tests/tenant-conformance/harness.mjs";
import { writeArtifact } from "./artifacts.mjs";

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const checks = [];
const failures = [];
const labStarted = Date.now();
let stage = "start";
const phase = (value) => {
  stage = value;
  console.error(
    "AGENT_RUNS_LAB_PHASE:" + value + " t=" + Math.round((Date.now() - labStarted) / 1000) + "s",
  );
};
function within(promise, timeoutMs, wait) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Error("AGENT_RUNS_LAB_STALLED:" + stage + ":" + wait)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("AGENT_RUNS_LAB_CHECK_NAME:" + name);
  checks.push({ name, passed: passed === true });
  if (passed !== true) {
    failures.push(name);
    console.error(
      "CHECK_FAILED " + name + (detail === undefined ? "" : " " + JSON.stringify(detail)),
    );
  }
  return passed === true;
}
const last = (out) => (Array.isArray(out) ? out : out.split("\n")).at(-1);
const ms = "date_trunc('milliseconds',clock_timestamp())";
const print = console.log.bind(console);
const questionText = "Which tone should the new titles take?";
const answerText = "Plain and short, please";

export async function runAgentRunsLab(db) {
  phase("fixtures");
  const P = seedWorkFixtures(db);
  const O = P.A.org,
    W = P.A.workspace;
  const S = "store_runs",
    C = "connection_runs";
  const store = storeResource(O, W, S, C);
  const actorOf = (p) => ({
    kind: "human",
    principalId: p.principal,
    organizationId: p.org,
    workspaceId: p.workspace,
    membershipId: p.membership,
    installationId: null,
    mandateId: null,
  });
  const linking = (p) => ({
    ...actorOf(p),
    kind: "service",
    principalId: "morrow.linking",
    membershipId: null,
  });
  function storeGrant(p, capabilityId, verbs, fields = [...listingFieldPaths]) {
    const g = {
      id: "g_" + p.key.toLowerCase() + "_" + capabilityId.replaceAll(".", "_"),
      principal: actorOf(p),
      capabilityId,
      verbs,
      scope: {
        organizationId: O,
        workspaceId: W,
        storeIds: [S],
        accountIds: [],
        resources: [store],
        fields,
      },
      issuedBy: linking(p),
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      policyRevision: 1,
    };
    if (!validateCurrentDefinition("Grant", g)) throw Error("AGENT_RUNS_LAB_GRANT_INVALID");
    return `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES(${literal(g.id)},${literal(O)},${literal(W)},${literal(p.membership)},${literal(p.principal)},${literal(JSON.stringify(g))}::jsonb);`;
  }
  db.admin(`INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES('profile_runs','workos','environment_${"A".repeat(26)}','app_${"A".repeat(26)}','client_${"A".repeat(26)}','https://api.workos.com/user_management/client_${"A".repeat(26)}',1,${literal("a".repeat(64))},1,'active');
INSERT INTO morrow_identity.organization_signups VALUES(${literal(P.A.principal)},${literal(randomUUID())},${literal("b".repeat(64))},'profile_runs',${literal(O)},${literal(W)},${literal(P.A.membership)},'owner-bootstrap-v1',clock_timestamp());`);
  db.admin(
    [
      storeGrant(P.A, "catalog.products.read", ["view", "delegate"]),
      storeGrant(P.A, "catalog.content.propose", ["execute", "delegate"]),
      storeGrant(P.A, "catalog.content.publish", ["propose", "approve", "execute", "delegate"]),
      storeGrant(
        P.A,
        "agents.installation.activate",
        ["execute"],
        ["evaluation", "grant", "installationId", "revision"],
      ),
    ].join("\n"),
  );
  // M5's records of a staging operator test entitlement (sim, as lab:agent-loop seeded them):
  // the route, the active account, one operator snapshot and a wallet.
  const terms = JSON.parse(readFileSync("docs/decisions/billing-terms.json", "utf8")).environments
    .development[0];
  const account = randomUUID();
  const grantKey = "morrow:operator_entitlement:" + randomUUID();
  db.workOwner(
    `INSERT INTO morrow_billing.billing_terms VALUES(1,${literal(JSON.stringify(terms.terms))}::jsonb,${literal(JSON.stringify(terms.offers))}::jsonb,${literal(terms.digest)},${ms});`,
  );
  const replica = (statements) => {
    const r = db.tryRun(
      `BEGIN; SET LOCAL session_replication_role=replica;\n${statements}\nCOMMIT;`,
    );
    if (!r.ok) {
      if (process.env.MORROW_LAB_DEBUG === "1") console.error(r.stderr.slice(0, 1500));
      throw Error("AGENT_RUNS_LAB_FIXTURE_FAILED:" + stage);
    }
    return r.stdout;
  };
  replica(`INSERT INTO morrow_billing.workspace_billing_routes VALUES(${literal(O)},${literal(W)},'website',NULL,NULL,NULL,NULL,NULL,1,${ms},${ms}) ON CONFLICT DO NOTHING;
UPDATE morrow_billing.workspace_billing_routes SET route='morrow_direct',mode='test',created_at=${ms}-interval '2 days',route_fixed_at=${ms}-interval '1 day',fixing_payment_key=${literal(grantKey)},revision=2,updated_at=${ms} WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)};
INSERT INTO morrow_billing.billing_accounts(organization_id,workspace_id,id,route,mode,currency,status,revision,created_at,updated_at) VALUES(${literal(O)},${literal(W)},${literal(account)},'morrow_direct','test','USD','active',1,${ms},${ms});
INSERT INTO morrow_billing.entitlement_snapshots VALUES(${literal(O)},${literal(W)},${literal(account)},1,'morrow_direct','test',${literal(grantKey)},'active',${literal("f".repeat(64))},${ms}-interval '2 hours',${ms}+interval '29 days',NULL,${ms});
INSERT INTO morrow_billing.credit_wallets(organization_id,workspace_id,billing_account_id,available,reserved,consumed,rate_revision,terms_revision,revision,created_at,updated_at) VALUES(${literal(O)},${literal(W)},${literal(account)},300,0,0,1,1,2,${ms},${ms});`);
  db.admin(
    storeInstallationSql({
      org: O,
      workspace: W,
      principal: P.A.principal,
      storeId: S,
      connectionId: C,
      installationId: "storeinst_runs",
    }),
  );
  const count = (query) => Number(last(db.sql(`SELECT (${query})::bigint;`)));
  const one = (query) => db.rows(query)[0] ?? null;
  const footprint = () =>
    JSON.stringify(
      [
        "agent_runs",
        "jobs",
        "agent_contexts",
        "run_segments",
        "run_events",
        "run_waits",
        "work_leases",
        "tasks",
        "work_envelopes",
        "delegation_hops",
        "commands",
      ].map((t) => count(`SELECT count(*) FROM morrow_work.${t}`)),
    );

  const ctx = { waitUntil() {} };
  const agents = createAgentsApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
  });
  const workApi = createWorkApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
  });
  async function call(handler, p, method, path, body) {
    const key = randomUUID();
    for (let n = 1; ; n++) {
      console.log = () => {};
      let response;
      try {
        response = await within(
          handler.fetch(workRequest(p, method, path, body, { key }), undefined, ctx),
          60000,
          "request",
        );
      } finally {
        console.log = print;
      }
      const reply = { status: response.status, body: JSON.parse(await response.text()) };
      if (reply.status === 503 && reply.body.code === "unavailable" && n < 4) {
        await sleep(250);
        continue;
      }
      return reply;
    }
  }
  async function agentsCall(p, method, path, body) {
    const headers = {
      Cookie: "__Host-morrow_session=" + p.secret,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    };
    if (method !== "GET") {
      headers.Origin = workFixtureOrigin;
      headers["Content-Type"] = "application/json";
      headers["X-Morrow-Request"] = "1";
      headers["Idempotency-Key"] = randomUUID();
    }
    for (let n = 1; ; n++) {
      console.log = () => {};
      let response;
      try {
        response = await agents.fetch(
          new Request(workFixtureOrigin + "/workspace/" + p.workspace + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
          undefined,
          ctx,
        );
      } finally {
        console.log = print;
      }
      const reply = { status: response.status, body: await response.json() };
      if (reply.status !== 503 || n >= 4) return reply;
      await sleep(250);
    }
  }
  const goal = await call(workApi, P.A, "POST", "/goals", {
    objective: "Clearer listings for summer",
    storeIds: [],
    successCriteria: [
      { description: "Done", verificationCapabilityId: null, evidenceRequired: false },
    ],
  });
  const taskOf = async (p, objective) =>
    (
      await call(workApi, p, "POST", "/tasks", {
        goalId: goal.body.goalId,
        objective,
        allowedResources: [],
      })
    ).body.taskId;
  const listings = `/stores/${S}/agents/listings`;
  const document = await agentsCall(P.A, "POST", listings + "/document", {});
  const enabled = await agentsCall(P.A, "POST", listings, {
    documentDigest: document.body.documentDigest,
    nonce: document.body.nonce,
  });
  const installation = one(
    `SELECT id::text AS id,status,release_id,release_revision::int AS revision,release_digest::text AS digest,agent_principal_id::text AS agent FROM morrow_work.agent_installations WHERE store_id=${literal(S)}`,
  );
  check(
    "A0:fixtures_goal_listings_installation_and_operator_entitlement",
    goal.status === 201 &&
      document.status === 201 &&
      enabled.status === 200 &&
      installation?.status === "active",
    { goal: goal.status, document: document.status, enabled: enabled.body, installation },
  );

  // The api's work transaction as morrow_api_worker (the fixed prologue, enter_context).
  const apiConnector = db.connector();
  async function apiTx(p, body) {
    const signal = new AbortController().signal;
    const connection = await apiConnector.open({
      signal,
      deadlineMs: Date.now() + 60000,
      waitUntil() {},
    });
    try {
      return await withWorkTransaction(
        connection,
        { readOnly: false, deadlineMs: Date.now() + 60000, signal },
        async (tx) => {
          const [c] = await tx.run("enterContext", [p.digest, p.workspace]);
          return body(tx, c);
        },
      );
    } finally {
      await connection.close();
    }
  }
  const admissionInput = (c, task, over = {}) => {
    const commandId = randomUUID();
    return {
      runId: randomUUID(),
      childTaskId: randomUUID(),
      envelopeId: randomUUID(),
      hopId: randomUUID(),
      grantId: randomUUID(),
      jobId: randomUUID(),
      contextId: randomUUID(),
      coordinatorPrincipalId: "agent_" + randomUUID(),
      organizationId: O,
      workspaceId: W,
      storeId: S,
      connectionId: C,
      installationId: installation.id,
      requester: { principalId: c.principal_id, membershipId: c.membership_id },
      release: {
        id: installation.release_id,
        revision: installation.revision,
        digest: installation.digest,
      },
      tools: ["products.read", "inbox.ask", "run.plan", "run.complete"],
      profile: { model: "claude_opus_5_5", effort: "medium", catalogueVersion: 2 },
      contextPolicyVersion: 1,
      admittedAt: new Date(Math.floor(Number(c.database_now_us) / 1000)).toISOString(),
      commandId,
      requestDigest: sha("admit:" + commandId),
      correlationId: "lab-" + commandId.slice(0, 8),
      parentTaskId: task,
      ...over,
    };
  };
  // One admission (retried while the loaded host times the transaction out before it
  // commits; a retry after a commit finds the run).
  async function admit(p, task, over = {}, agentLoop = "on") {
    let input;
    for (let n = 1; ; n++) {
      try {
        return await apiTx(p, async (tx, c) => {
          input ??= admissionInput(c, task, over);
          if (n > 1) input = { ...input, admittedAt: admissionInput(c, task).admittedAt };
          return { ...(await admitRoutedRun(tx, agentLoop, input)), input };
        });
      } catch (error) {
        if (
          input &&
          count(`SELECT count(*) FROM morrow_work.agent_runs WHERE id=${literal(input.runId)}`) ===
            1
        )
          return { outcome: "applied", runId: input.runId, input, retried: true };
        if (n >= 6) throw error;
        await sleep(400);
      }
    }
  }
  async function answer(p, questionId, text) {
    for (let n = 1; ; n++) {
      try {
        return await apiTx(p, (tx) =>
          answerRunQuestion(tx, "on", {
            commandId: randomUUID(),
            requestDigest: sha("answer:" + randomUUID()),
            correlationId: "lab-answer",
            questionId,
            answer: text,
          }),
        );
      } catch (error) {
        if (n >= 4) throw error;
        await sleep(400);
      }
    }
  }
  // The runtime login: one round trip, BEGIN, the calls and COMMIT; each output line is
  // tagged so the definers' rows come back as JSON.
  const runtime = (statements) => {
    const r = db.tryRun(`BEGIN;\n${statements}\nCOMMIT;`, { user: "morrow_runtime_executor" });
    const out = {};
    for (const line of r.stdout.split("\n")) {
      const m = /^([A-Z]+):(.*)$/.exec(line);
      if (m) out[m[1]] = /^[{[]/.test(m[2]) ? JSON.parse(m[2]) : m[2];
    }
    return { ok: r.ok, stderr: r.ok ? "" : r.stderr, ...out };
  };
  const enter = (lease) =>
    `SELECT 'E:'||outcome FROM morrow_work.enter_lease(${literal(lease)},'1');`;
  const row = (tag, call) => `SELECT '${tag}:'||row_to_json(x)::text FROM ${call} x;`;
  const runRow = (id) =>
    one(
      `SELECT status,ended_reason,kind,purpose,job_id::text AS job,root_run_id::text AS root,depth::int AS depth,context_id::text AS context,segment,incarnation,workflow_instance_id AS instance,lease_id::text AS lease,lease_renewals::int AS renewals,wait_id::text AS wait,envelope_expires_at,envelope_renewed_at,created_at,active_ms::bigint AS active,safety::text AS safety,safety_profile_version::int AS profile,max_output_tokens::int AS max_out,call_budget_ms::int AS budget,harness_version::int AS harness,runner_version::int AS runner,renderer_version::int AS renderer,context_policy_version::int AS policy,credits_held::bigint AS held,credits_drawn::bigint AS drawn,manifest_canonical AS manifest,manifest_digest::text AS digest,taint::text AS taint FROM morrow_work.agent_runs WHERE id=${literal(id)}`,
    );
  const leaseOf = (id) =>
    one(
      `SELECT subject_id::text AS subject,status,started_at,initiator_principal_id::text AS principal FROM morrow_work.work_leases WHERE id=${literal(id)}`,
    );
  const events = (id) =>
    db.rows(
      `SELECT kind,code,ref_kind,sequence::int AS sequence FROM morrow_work.run_events WHERE run_id=${literal(id)} ORDER BY sequence`,
    );

  // ---------------------------------------------------------------------------
  phase("person_act_admission");
  const T1 = await taskOf(P.A, "Read the summer products and summarise them");
  {
    // A1: the switch off: switch_off before any statement.
    const before = footprint();
    const sent = [];
    const off = await admitRoutedRun(
      { run: async (name) => (sent.push(name), []), markSubmitted() {}, rollbackOnly() {} },
      "off",
      admissionInput(
        {
          principal_id: P.A.principal,
          membership_id: P.A.membership,
          database_now_us: String(Date.now() * 1000),
        },
        T1,
      ),
    );
    check(
      "A1:switch_off_before_any_statement",
      off.outcome === "switch_off" && sent.length === 0 && footprint() === before,
      { off, sent },
    );
    // A2: catalogue v2 committed proposed: catalogue_inactive, nothing persists.
    const proposed = await admit(P.A, T1);
    check(
      "A2:a_proposed_catalogue_admits_nothing",
      proposed.outcome === "catalogue_inactive" && footprint() === before,
      { proposed: proposed.outcome },
    );
    // Publication (sim): a later reviewed forward migration on the owner's confirmation.
    db.workOwner("UPDATE morrow_work.loop_catalogue_versions SET status='active' WHERE version=2;");
    const policyProposed = await admit(P.A, T1);
    check(
      "A3:a_proposed_context_policy_admits_nothing",
      policyProposed.outcome === "version_unknown" && footprint() === before,
      { policyProposed: policyProposed.outcome },
    );
    db.workOwner("UPDATE morrow_work.context_policy_versions SET status='active' WHERE version=1;");
    // A forged manifest (its safety profile edited in the canonical text) persists nothing.
    const forged = await apiTx(P.A, async (tx, c) => {
      const input = admissionInput(c, T1, { tools: ["inbox.ask", "run.plan"] });
      const realRun = tx.run.bind(tx);
      const forgedTx = {
        markSubmitted: () => tx.markSubmitted(),
        rollbackOnly: () => tx.rollbackOnly(),
        run: (name, values) => {
          if (name !== "cmdAgentRunAdmit") return realRun(name, values);
          const v = [...values];
          const m = JSON.parse(v[22]);
          m.safety.checkIns.modelTurns = 16;
          v[22] = canonicalJson(m);
          return realRun(name, v);
        },
      };
      return admitRoutedRun(forgedTx, "on", input);
    });
    check(
      "A4:a_forged_manifest_persists_nothing",
      forged.outcome === "invalid" && footprint() === before,
      { forged },
    );
    // A model the active context policy has no row for (Haiku: the loop is Opus 5.5 only).
    const haiku = await admit(P.A, T1, {
      profile: { model: "claude_haiku_5_5", effort: "low", catalogueVersion: 2 },
    });
    check(
      "A5:no_context_policy_row_no_admission",
      haiku.outcome === "version_unknown" && footprint() === before,
      { haiku: haiku.outcome },
    );
  }
  const admitted = await admit(P.A, T1);
  const R1 = admitted.runId;
  const r1 = runRow(R1);
  {
    const job = one(
      `SELECT origin,state,requester_principal_id::text AS requester FROM morrow_work.jobs WHERE id=${literal(admitted.input.jobId)}`,
    );
    const context = one(
      `SELECT scope,job_id::text AS job,current_epoch::int AS epoch,last_sequence::int AS seq,status,tools::text AS tools,model_key,effort_key,context_policy_version::int AS policy FROM morrow_work.agent_contexts WHERE id=${literal(admitted.input.contextId)}`,
    );
    const lease = leaseOf(r1?.lease);
    const segment = one(
      `SELECT segment,incarnation,workflow_instance_id AS instance,reason FROM morrow_work.run_segments WHERE run_id=${literal(R1)}`,
    );
    const safety = runSafety(2, 12000);
    const manifest = JSON.parse(r1.manifest);
    const wall = Date.parse(r1.envelope_expires_at) - Date.parse(r1.created_at);
    check(
      "A6:one_transaction_writes_the_job_context_run_segment_and_event",
      admitted.outcome === "applied" &&
        job?.origin === "routed" &&
        job.state === "received" &&
        context?.scope === "job" &&
        context.job === admitted.input.jobId &&
        context.epoch === 0 &&
        context.seq === 0 &&
        context.status === "open" &&
        context.policy === 1 &&
        r1?.status === "queued" &&
        r1.kind === "routed" &&
        r1.purpose === null &&
        r1.job === admitted.input.jobId &&
        r1.root === R1 &&
        r1.depth === 0 &&
        r1.segment === 1 &&
        r1.incarnation === 1 &&
        r1.instance === R1 + "-s1-i1" &&
        segment?.instance === R1 + "-s1-i1" &&
        segment.reason === "start" &&
        lease?.subject === R1 &&
        lease.status === "active" &&
        JSON.stringify(events(R1)) ===
          JSON.stringify([
            { kind: "run.admitted", code: "person_act", ref_kind: "run", sequence: 1 },
          ]),
      { admitted: admitted.outcome, job, context, r1: { ...r1, manifest: undefined }, lease },
    );
    check(
      "A7:the_safety_profile_and_pins_are_composed_never_a_cap",
      JSON.stringify(JSON.parse(r1.safety)) !== undefined &&
        canonicalJson(JSON.parse(r1.safety)) === canonicalJson(safety) &&
        r1.profile === 1 &&
        r1.max_out === 12000 &&
        r1.budget === 1680000 &&
        r1.harness === 1 &&
        r1.runner === 1 &&
        r1.renderer === 1 &&
        r1.policy === 1 &&
        r1.held === 0 &&
        r1.drawn === 0 &&
        wall === 7 * 86400000 &&
        r1.digest === sha(r1.manifest) &&
        validateCurrentDefinition("AgentRunManifest", manifest) &&
        manifest.safety.checkIns.modelTurns === 1000,
      { profile: r1.profile, max: r1.max_out, wall },
    );
    const capColumns = count(
      "SELECT count(*) FROM information_schema.columns WHERE table_schema='morrow_work' AND table_name IN ('agent_runs','run_turns','agent_model_calls','loop_catalogue_versions') AND column_name IN ('turn_limit','tool_calls_per_turn','tool_calls_per_run','questions_limit','wall_time_ms','final','hold_usd','booked_usd','overflow_usd','worst_case_turn_usd','cost_usd','max_turns_per_run','wall_time_minutes','question_wait_hours')",
    );
    check("A8:no_turn_call_question_time_or_money_limit_column", capColumns === 0, {
      capColumns,
    });
  }

  // ---------------------------------------------------------------------------
  phase("person_act_answer");
  // A question wait (sim: inbox.ask's handler is H7b's): the run waits on its open question,
  // holding no lease (its admission lease released).
  const askQuestion = (runId, { openedAgo = "0 seconds" } = {}) => {
    const q = randomUUID(),
      w = randomUUID();
    const r = runRow(runId);
    // One clock reading for the question's times (its guard requires exactly 90 days).
    db.workOwner(`INSERT INTO morrow_work.agent_run_questions(organization_id,workspace_id,id,run_id,tool_use_id,question,choices,status,created_at,expires_at)
 SELECT ${literal(O)},${literal(W)},${literal(q)},${literal(runId)},${literal("toolu_" + q.slice(0, 8))},${literal(questionText)},'[]'::jsonb,'open',t,t+interval '90 days'
 FROM (SELECT ${ms} AS t) x;
INSERT INTO morrow_work.run_waits(organization_id,workspace_id,id,run_id,job_id,wait_sequence,kind,condition,question_id,state,opened_at,lapses_at,expires_at)
 SELECT ${literal(O)},${literal(W)},${literal(w)},${literal(runId)},${literal(r.job)},COALESCE((SELECT max(wait_sequence) FROM morrow_work.run_waits WHERE run_id=${literal(runId)}),0)+1,'question',jsonb_build_object('kind','question','questionId',${literal(q)}),${literal(q)},'open',t,t+interval '7 days',t+interval '365 days'
 FROM (SELECT ${ms}-interval ${literal(openedAgo)} AS t) x;
UPDATE morrow_work.work_leases SET status='released',ended_at=greatest(${ms},created_at) WHERE id=${literal(r.lease)} AND status='active';
UPDATE morrow_work.agent_runs SET status='waiting',wait_id=${literal(w)},lease_id=NULL,lease_generation=NULL,lease_expires_at=NULL,segment_started_at=NULL,revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(runId)};`);
    return { question: q, wait: w };
  };
  {
    const asked = askQuestion(R1);
    const other = await answer(P.B, asked.question, answerText);
    const renewedBefore = runRow(R1).envelope_renewed_at;
    await sleep(20);
    const answered = await answer(P.A, asked.question, answerText);
    const r = runRow(R1);
    const wait = one(
      `SELECT state,resolution_code,resolution_lease_source,wait_sequence::int AS seq FROM morrow_work.run_waits WHERE id=${literal(asked.wait)}`,
    );
    const q = one(
      `SELECT status,answer FROM morrow_work.agent_run_questions WHERE id=${literal(asked.question)}`,
    );
    const lease = leaseOf(r.lease);
    check(
      "P1:only_the_requester_answers_and_the_answer_resumes_and_renews",
      other.outcome === "denied" &&
        answered.outcome === "applied" &&
        r.status === "queued" &&
        r.wait === null &&
        lease?.subject === R1 + ":w1" &&
        lease.principal === P.A.principal &&
        wait?.state === "resolved" &&
        wait.resolution_code === "answered" &&
        wait.resolution_lease_source === "person_act" &&
        q?.status === "answered" &&
        Date.parse(r.envelope_renewed_at) > Date.parse(renewedBefore) &&
        Date.parse(r.envelope_expires_at) - Date.parse(r.envelope_renewed_at) === 7 * 86400000 &&
        events(R1).some((e) => e.kind === "wait.resolved" && e.code === "answered"),
      { other, answered, r: { status: r.status, wait: r.wait }, wait, q, lease },
    );
  }

  let RP = null;
  {
    // A question wait that lapsed (sim: asked 8 days ago; a wait on a person lasts 7 days).
    const T = await taskOf(P.A, "A question nobody answered in time");
    const run = await admit(P.A, T);
    RP = run.runId;
    const asked = askQuestion(RP, { openedAgo: "8 days" });
    const late = await answer(P.A, asked.question, answerText);
    check(
      "P2:a_lapsed_wait_is_refused_expired",
      late.outcome === "expired" && runRow(RP).status === "waiting",
      { late },
    );
  }

  // ---------------------------------------------------------------------------
  phase("not_built_sources");
  {
    const fn = (sig) =>
      count(`SELECT count(*) FROM pg_proc WHERE oid=to_regprocedure(${literal(sig)})`);
    const runtimeFns = db
      .rows(
        "SELECT p.proname FROM pg_proc p WHERE p.pronamespace='morrow_work'::regnamespace AND has_function_privilege('morrow_runtime_executor',p.oid,'EXECUTE') AND p.proname LIKE '%admit%'",
      )
      .map((r) => r.proname)
      .sort();
    // No login holds a table privilege: a forged run, call or wait insert is denied.
    const forge = (table) =>
      db.tryRun(`INSERT INTO morrow_work.${table} DEFAULT VALUES;`, {
        user: "morrow_runtime_executor",
      }).stderr;
    check(
      "M1:mandate_trigger_admission_is_not_built_and_no_login_writes_a_mandate_run",
      fn("morrow_work.admit_mandate_run(text,text,text)") === 0 &&
        JSON.stringify(runtimeFns) === JSON.stringify(["admit_upkeep_run"]) &&
        /permission denied/.test(forge("agent_runs")),
      { runtimeFns },
    );
    check(
      "C1:child_fork_and_review_admission_are_not_built",
      count(
        "SELECT count(*) FROM pg_proc WHERE pronamespace='morrow_work'::regnamespace AND proname ~ '(call|fork|review)_admit|admit_(call|fork|review)'",
      ) === 0 &&
        /permission denied/.test(forge("agent_calls")) &&
        count("SELECT count(*) FROM morrow_work.agent_calls") === 0,
    );
    check(
      "F1:standing_request_firing_is_not_built",
      fn("morrow_work.admit_standing_request_run(text,text,text)") === 0 &&
        count("SELECT count(*) FROM pg_class WHERE relname='standing_requests'") === 0 &&
        /permission denied/.test(forge("run_waits")),
    );
  }

  // ---------------------------------------------------------------------------
  phase("step_renewal");
  {
    const before = runRow(R1);
    // The Workflow's start step under the answer's lease: marked started, running.
    const started = runtime(enter(before.lease) + row("S", "morrow_work.agent_run_start()"));
    const r0 = runRow(R1);
    const current = runtime(
      enter(r0.lease) + row("R", "morrow_work.agent_run_lease_renew('1','1','other')"),
    );
    const superseded = runtime(
      enter(r0.lease) + row("R", "morrow_work.agent_run_lease_renew('1','2','turn')"),
    );
    const afterSuperseded = runRow(R1);
    const renewed = runtime(
      enter(r0.lease) + row("R", "morrow_work.agent_run_lease_renew('1','1','turn')"),
    );
    const r1b = runRow(R1);
    const oldLease = leaseOf(r0.lease);
    const newLease = leaseOf(r1b.lease);
    const pending = runtime(
      `SELECT 'P:'||COALESCE(json_agg(row_to_json(x)),'[]'::json)::text FROM morrow_work.agent_run_pending_starts() x;`,
    );
    const marks = runtime(enter(r1b.lease) + row("S", "morrow_work.agent_run_start()"));
    check(
      "R1:a_turn_step_renews_another_with_time_left_is_current",
      started.ok &&
        started.S?.outcome === "started" &&
        current.R?.outcome === "current" &&
        current.R.lease_id === r0.lease &&
        superseded.R?.outcome === "superseded" &&
        afterSuperseded.lease === r0.lease &&
        afterSuperseded.renewals === 0 &&
        renewed.R?.outcome === "renewed" &&
        renewed.R.lease_id === r1b.lease &&
        r1b.renewals === 1 &&
        oldLease?.status === "released" &&
        newLease?.subject === R1 + ":l1" &&
        newLease.status === "active" &&
        Array.isArray(pending.P) &&
        pending.P.some((p) => p.lease_id === r1b.lease) &&
        marks.S?.outcome === "running" &&
        leaseOf(r1b.lease).started_at !== null &&
        events(R1).some((e) => e.kind === "run.lease_renewed" && e.code === "step_renewal"),
      { started, current, superseded, renewed, oldLease, newLease, marks },
    );
  }
  {
    // Past the envelope (24 hours active, sim: the running stretch began 25 hours ago, not yet
    // folded into active_ms): the run checks in.
    const r = runRow(R1);
    db.workOwner(
      `UPDATE morrow_work.agent_runs SET segment_started_at=${ms}-interval '25 hours',revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(R1)};`,
    );
    const out = runtime(
      enter(r.lease) + row("R", "morrow_work.agent_run_lease_renew('1','1','turn')"),
    );
    const after = runRow(R1);
    const wait = one(
      `SELECT kind,state,condition::text AS condition,lapses_at,opened_at FROM morrow_work.run_waits WHERE id=${literal(after.wait)}`,
    );
    check(
      "R2:renewal_is_refused_after_the_envelope_and_the_run_checks_in",
      out.R?.outcome === "checked_in" &&
        out.R.reason === "envelope_expired" &&
        after.status === "waiting" &&
        after.lease === null &&
        Number(after.active) >= 25 * 3600000 &&
        wait?.kind === "checkin" &&
        JSON.parse(wait.condition).code === "envelope" &&
        Date.parse(wait.lapses_at) - Date.parse(wait.opened_at) === 7 * 86400000 &&
        leaseOf(r.lease).status === "released",
      { out, after: { status: after.status, lease: after.lease, active: after.active }, wait },
    );
  }
  let R3 = null;
  // A second run for the revoke and installation cases.
  const T2 = await taskOf(P.A, "Second routed run");
  const run2 = await admit(P.A, T2);
  const R2 = run2.runId;
  {
    const r = runRow(R2);
    runtime(enter(r.lease) + row("S", "morrow_work.agent_run_start()"));
    // A disabled installation (sim: its status, as the agents API's disable does): admission's
    // checks fail, the run ends lease_ended, its envelope and hop are revoked, its lease released.
    db.workOwner(
      `UPDATE morrow_work.agent_installations SET status='disabled',revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(installation.id)};`,
    );
    const out = runtime(
      enter(r.lease) + row("R", "morrow_work.agent_run_lease_renew('1','1','turn')"),
    );
    db.workOwner(
      `UPDATE morrow_work.agent_installations SET status='active',revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(installation.id)};`,
    );
    const after = runRow(R2);
    const revoked = one(
      `SELECT (e.revoked_at IS NOT NULL) AS envelope,(h.revoked_at IS NOT NULL) AS hop FROM morrow_work.agent_runs a JOIN morrow_work.work_envelopes e ON e.organization_id=a.organization_id AND e.workspace_id=a.workspace_id AND e.id=a.work_envelope_id JOIN morrow_work.delegation_hops h ON h.organization_id=a.organization_id AND h.workspace_id=a.workspace_id AND h.id=a.hop_id WHERE a.id=${literal(R2)}`,
    );
    const job = one(`SELECT state FROM morrow_work.jobs WHERE id=${literal(run2.input.jobId)}`);
    check(
      "R3:a_failed_admission_check_ends_the_run_with_its_reason",
      out.R?.outcome === "ended" &&
        out.R.reason === "lease_ended" &&
        after.status === "cancelled" &&
        after.ended_reason === "lease_ended" &&
        revoked?.envelope === true &&
        revoked.hop === true &&
        leaseOf(r.lease).status === "released" &&
        job?.state === "stopped" &&
        events(R2).some((e) => e.kind === "run.ended" && e.code === "lease_ended"),
      { out, after: { status: after.status, reason: after.ended_reason }, revoked, job },
    );
  }
  {
    // After a stop ("Stop AI work" on the store) or a revoke, no lease can be entered to renew.
    const T3 = await taskOf(P.R, "Revoked requester's run");
    const run3 = await admit(P.R, T3);
    R3 = run3.runId;
    const r3 = runRow(run3.runId);
    db.sql(revocationSql(P.R));
    const revoked = runtime(
      enter(r3.lease) + row("R", "morrow_work.agent_run_lease_renew('1','1','turn')"),
    );
    check(
      "R4:renewal_is_refused_after_a_revoke",
      run3.outcome === "applied" &&
        // The revocation revokes the member's leases too (0023), so the entry finds it ended.
        ["member_inactive", "ended"].includes(revoked.E) &&
        revoked.R?.outcome === "denied" &&
        runRow(run3.runId).renewals === 0,
      { run3: run3.outcome, revoked },
    );
  }

  // ---------------------------------------------------------------------------
  phase("wait_resume");
  const T4 = await taskOf(P.A, "A run that waits");
  const run4 = await admit(P.A, T4);
  const R4 = run4.runId;
  // A wait (sim: the runner's run.wait and the call registry are H7b's and H10's): a waiting
  // run's open wait is replaced; an open run goes to waiting, its lease released.
  const waitOn = (runId, kind, condition, { due = true, resolvable = null } = {}) => {
    const w = randomUUID();
    const r = runRow(runId);
    const closeOld =
      r.status === "waiting"
        ? `UPDATE morrow_work.run_waits SET state='cancelled',resolution_code='stopped',resolved_at=greatest(${ms},opened_at) WHERE id=${literal(r.wait)};`
        : `UPDATE morrow_work.work_leases SET status='released',ended_at=greatest(${ms},created_at) WHERE id=${literal(r.lease)} AND status='active';`;
    db.workOwner(`${closeOld}
INSERT INTO morrow_work.run_waits(organization_id,workspace_id,id,run_id,job_id,wait_sequence,kind,condition,state,opened_at,wake_at,lapses_at,expires_at)
 SELECT ${literal(O)},${literal(W)},${literal(w)},${literal(runId)},${literal(r.job)},COALESCE((SELECT max(wait_sequence) FROM morrow_work.run_waits WHERE run_id=${literal(runId)}),0)+1,${literal(kind)},${literal(JSON.stringify(condition))}::jsonb,'open',t-interval '2 seconds',${kind === "timer" ? (due ? "t-interval '1 second'" : "t+interval '1 hour'") : "NULL"},NULL,t-interval '2 seconds'+interval '365 days' FROM (SELECT ${ms} AS t) x;
${resolvable ? `UPDATE morrow_work.run_waits SET state='resolvable',resolvable_code=${literal(resolvable)},resolvable_at=${ms} WHERE id=${literal(w)};` : ""}
UPDATE morrow_work.agent_runs SET status='waiting',wait_id=${literal(w)},lease_id=NULL,lease_generation=NULL,lease_expires_at=NULL,segment_started_at=NULL,revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(runId)};`);
    return {
      wait: w,
      seq: Number(
        one(`SELECT wait_sequence FROM morrow_work.run_waits WHERE id=${literal(w)}`).wait_sequence,
      ),
    };
  };
  const resume = (runId, seq) =>
    runtime(
      row(
        "W",
        `morrow_work.agent_run_resume(${literal(O)},${literal(W)},${literal(runId)},'${seq}')`,
      ),
    );
  {
    const early = waitOn(
      R4,
      "timer",
      { kind: "timer", until: "2026-12-01T00:00:00.000Z" },
      { due: false },
    );
    const leases = count("SELECT count(*) FROM morrow_work.work_leases");
    const notDue = resume(R4, early.seq);
    const due = waitOn(R4, "timer", { kind: "timer", until: "2026-10-27T00:00:00.000Z" });
    const out = resume(R4, due.seq);
    const r = runRow(R4);
    const wait = one(
      `SELECT state,resolution_code,resolution_lease_source FROM morrow_work.run_waits WHERE id=${literal(due.wait)}`,
    );
    const again = resume(R4, due.seq);
    check(
      "W1:a_due_timer_resumes_under_a_new_lease_after_admissions_checks",
      notDue.W?.outcome === "not_resolvable" &&
        out.W?.outcome === "resumed" &&
        out.W.lease_id === r.lease &&
        out.W.event_type === "w-" + due.seq &&
        out.W.segment === "1" &&
        out.W.incarnation === "1" &&
        r.status === "queued" &&
        r.wait === null &&
        leaseOf(r.lease)?.subject === R4 + ":w" + due.seq &&
        count("SELECT count(*) FROM morrow_work.work_leases") === leases + 1 &&
        wait?.state === "resolved" &&
        wait.resolution_code === "time_reached" &&
        wait.resolution_lease_source === "wait_resume" &&
        again.W?.outcome === "not_waiting" &&
        events(R4).some((e) => e.kind === "wait.resolved" && e.code === "time_reached"),
      { notDue, out, wait, again },
    );
  }
  {
    // A resolvable wait (sim: a child finished) resumes the same way; a question is the
    // requester's alone, even when something marked it resolvable.
    const r = runRow(R4);
    runtime(enter(r.lease) + row("S", "morrow_work.agent_run_start()"));
    const child = waitOn(
      R4,
      "children",
      { kind: "children", mode: "any", callIds: [] },
      {
        resolvable: "child_finished",
      },
    );
    const out = resume(R4, child.seq);
    const wait = one(
      `SELECT state,resolution_code FROM morrow_work.run_waits WHERE id=${literal(child.wait)}`,
    );
    const asked = askQuestion(R4);
    const seq = Number(
      one(`SELECT wait_sequence FROM morrow_work.run_waits WHERE id=${literal(asked.wait)}`)
        .wait_sequence,
    );
    const question = resume(R4, seq);
    db.workOwner(
      `UPDATE morrow_work.run_waits SET state='resolvable',resolvable_code='answered',resolvable_at=${ms} WHERE id=${literal(asked.wait)};`,
    );
    const leases = count("SELECT count(*) FROM morrow_work.work_leases");
    const stillQuestion = resume(R4, seq);
    check(
      "W2:a_resolvable_wait_resumes_and_a_question_is_the_requesters_only",
      out.W?.outcome === "resumed" &&
        wait?.state === "resolved" &&
        wait.resolution_code === "child_finished" &&
        question.W?.outcome === "not_resolvable" &&
        stillQuestion.W?.outcome === "not_resolvable" &&
        count("SELECT count(*) FROM morrow_work.work_leases") === leases &&
        runRow(R4).status === "waiting",
      { out, wait, question, stillQuestion },
    );
  }
  const T5 = await taskOf(P.A, "Past the envelope");
  const run5 = await admit(P.A, T5);
  const R5 = run5.runId;
  const T6 = await taskOf(P.A, "Under a stop");
  const run6 = await admit(P.A, T6);
  const R6 = run6.runId;
  {
    const t = waitOn(R5, "timer", { kind: "timer", until: "2026-10-27T00:00:00.000Z" });
    db.workOwner(
      `UPDATE morrow_work.agent_runs SET active_ms=active_ms+86400000,revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(R5)};`,
    );
    const leases = count("SELECT count(*) FROM morrow_work.work_leases");
    const expired = resume(R5, t.seq);
    check(
      "W3:resume_is_refused_after_the_envelope_with_no_write",
      expired.W?.outcome === "envelope_expired" &&
        count("SELECT count(*) FROM morrow_work.work_leases") === leases &&
        runRow(R5).status === "waiting",
      { expired },
    );
    // Under "Stop AI work" on the installation (sim: an operator's stop control, written as
    // the other labs write it, without revoking the other runs' leases this lab still uses):
    // enter_lease refuses, the lease insert rolls back with it, and the run waits on (the
    // sweep's stop rule is H7b's).
    const t6 = waitOn(R6, "timer", { kind: "timer", until: "2026-10-27T00:00:00.000Z" });
    const stop = randomUUID();
    replica(
      `SET LOCAL ROLE morrow_work_owner; INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,set_by_membership_id,set_by_operator_id,reason_code,reason,created_at) VALUES(${literal(O)},${literal(W)},${literal(stop)},'installation',${literal(S)},${literal(installation.id)},'operator',NULL,NULL,'lab_operator','lab_stop_sim','Laboratory stop',${ms});`,
    );
    const leases6 = count("SELECT count(*) FROM morrow_work.work_leases");
    const stopped = resume(R6, t6.seq);
    db.workOwner(
      `UPDATE morrow_work.stop_controls SET lifted_at=greatest(${ms},created_at),lifted_by_kind='operator',lifted_by_operator_id='lab_operator' WHERE id=${literal(stop)};`,
    );
    check(
      "W4:under_a_stop_resume_persists_nothing",
      stopped.W?.outcome === "stopped" &&
        count("SELECT count(*) FROM morrow_work.work_leases") === leases6 &&
        runRow(R6).status === "waiting",
      { stopped },
    );
  }
  // A wait past its lapse time never resumes, even once something made it resolvable (sim: a
  // credits wait opened 8 days ago, lapsed after 7, and credits covered since): refused lapsed
  // with no write; the sweep lists it to lapse (S1).
  const T8 = await taskOf(P.A, "Parked on credits too long");
  const run8 = await admit(P.A, T8);
  const R8 = run8.runId;
  {
    const r = runRow(R8);
    const w = randomUUID();
    db.workOwner(`UPDATE morrow_work.work_leases SET status='released',ended_at=greatest(${ms},created_at) WHERE id=${literal(r.lease)} AND status='active';
INSERT INTO morrow_work.run_waits(organization_id,workspace_id,id,run_id,job_id,wait_sequence,kind,condition,state,opened_at,lapses_at,expires_at)
 SELECT ${literal(O)},${literal(W)},${literal(w)},${literal(R8)},${literal(r.job)},1,'credits','{"kind":"credits"}'::jsonb,'open',t-interval '8 days',t-interval '1 day',t-interval '8 days'+interval '365 days' FROM (SELECT ${ms} AS t) x;
UPDATE morrow_work.run_waits SET state='resolvable',resolvable_code='credits_covered',resolvable_at=${ms} WHERE id=${literal(w)};
UPDATE morrow_work.agent_runs SET status='waiting',wait_id=${literal(w)},lease_id=NULL,lease_generation=NULL,lease_expires_at=NULL,segment_started_at=NULL,revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(R8)};`);
    const leases8 = count("SELECT count(*) FROM morrow_work.work_leases");
    const lapsed = resume(R8, 1);
    const wait = one(`SELECT state FROM morrow_work.run_waits WHERE id=${literal(w)}`);
    check(
      "W5:a_wait_past_its_lapse_never_resumes",
      lapsed.W?.outcome === "lapsed" &&
        count("SELECT count(*) FROM morrow_work.work_leases") === leases8 &&
        runRow(R8).status === "waiting" &&
        wait?.state === "resolvable",
      { lapsed, wait },
    );
  }

  // ---------------------------------------------------------------------------
  phase("upkeep_admission");
  const upkeepTrigger = (p, { subject = "notebook_" + installation.id } = {}) => {
    const id = randomUUID();
    db.workOwner(`INSERT INTO morrow_work.upkeep_triggers(organization_id,workspace_id,id,revision,kind,subject_kind,subject_id,installation_id,store_id,connection_id,agent_principal_id,requester_principal_id,requester_membership_id,source_kind,source_run_id,source_lease_id,catalogue_version,model_key,effort_key,system_text_digest,tool_catalogue_version,tool_catalogue_digest,state,run_id,created_at,admitted_at,ended_at,expires_at)
 SELECT ${literal(O)},${literal(W)},${literal(id)},1,'consolidation','notebook',${literal(subject)},${literal(installation.id)},${literal(S)},${literal(C)},${literal(installation.agent)},${literal(p.principal)},${literal(p.membership)},'person_act',NULL,NULL,2,'claude_opus_5_5','medium',${literal(sha("upkeep text"))},4,${literal(sha("tool catalogue v4"))},'pending',NULL,t,NULL,NULL,t+interval '365 days' FROM (SELECT ${ms} AS t) x;`);
    return id;
  };
  const admitUpkeep = (trigger) =>
    runtime(
      row("U", `morrow_work.admit_upkeep_run(${literal(O)},${literal(W)},${literal(trigger)})`),
    );
  {
    const trigger = upkeepTrigger(P.A);
    const second = db.tryRun(
      `SET ROLE morrow_work_owner; INSERT INTO morrow_work.upkeep_triggers SELECT organization_id,workspace_id,${literal(randomUUID())},1,kind,subject_kind,subject_id,installation_id,store_id,connection_id,agent_principal_id,requester_principal_id,requester_membership_id,source_kind,source_run_id,source_lease_id,catalogue_version,model_key,effort_key,system_text_digest,tool_catalogue_version,tool_catalogue_digest,'pending',NULL,created_at,NULL,NULL,expires_at FROM morrow_work.upkeep_triggers WHERE id=${literal(trigger)};`,
    );
    const out = admitUpkeep(trigger);
    const run = runRow(out.U?.run_id);
    const t = one(
      `SELECT state,run_id::text AS run FROM morrow_work.upkeep_triggers WHERE id=${literal(trigger)}`,
    );
    const context = one(
      `SELECT scope,tools::text AS tools FROM morrow_work.agent_contexts WHERE id=${literal(run?.context)}`,
    );
    const manifest = run ? JSON.parse(run.manifest) : null;
    const again = admitUpkeep(trigger);
    check(
      "U1:one_pending_trigger_admits_one_upkeep_run_with_the_upkeep_tools",
      out.U?.outcome === "admitted" &&
        run?.kind === "upkeep" &&
        run.status === "queued" &&
        run.job === null &&
        context?.scope === "upkeep" &&
        JSON.stringify(manifest.tools) ===
          JSON.stringify(["notebook.write", "memory.search", "memory.read", "run.complete"]) &&
        leaseOf(run.lease)?.subject === out.U.run_id + ":u:" + trigger &&
        t?.state === "admitted" &&
        t.run === out.U.run_id &&
        again.U?.outcome === "admitted_before" &&
        again.U.run_id === out.U.run_id &&
        second.ok === false &&
        events(out.U.run_id).some(
          (e) => e.kind === "run.admitted" && e.code === "upkeep_admission",
        ),
      { out, t, again, second: second.ok },
    );
    // The manifest SQL built is exactly the text code would build: the same RFC 8785 bytes and
    // digest (harness_jcs against canonicalJson), and a valid AgentRunManifest@1.
    check(
      "U2:the_sql_built_manifest_is_rfc_8785_and_valid",
      manifest !== null &&
        canonicalJson(manifest) === run.manifest &&
        sha(run.manifest) === run.digest &&
        validateCurrentDefinition("AgentRunManifest", manifest),
      { valid: manifest && validateCurrentDefinition("AgentRunManifest", manifest) },
    );
  }
  {
    // A revoked requester's trigger admits nothing (the lease is never entered).
    const trigger = upkeepTrigger(P.S, { subject: "notebook_revoked" });
    db.sql(revocationSql(P.S));
    const runs = count("SELECT count(*) FROM morrow_work.agent_runs");
    const leases = count("SELECT count(*) FROM morrow_work.work_leases");
    const out = admitUpkeep(trigger);
    check(
      "U3:a_revoked_requester_admits_nothing",
      out.U?.outcome === "member_inactive" &&
        count("SELECT count(*) FROM morrow_work.agent_runs") === runs &&
        count("SELECT count(*) FROM morrow_work.work_leases") === leases,
      { out },
    );
    // A disabled installation skips the trigger (its lease released, no run).
    const skippedTrigger = upkeepTrigger(P.A, { subject: "notebook_skipped" });
    db.workOwner(
      `UPDATE morrow_work.agent_installations SET status='disabled',revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(installation.id)};`,
    );
    const skipped = admitUpkeep(skippedTrigger);
    db.workOwner(
      `UPDATE morrow_work.agent_installations SET status='active',revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(installation.id)};`,
    );
    check(
      "U4:a_disabled_installation_skips_the_trigger",
      skipped.U?.outcome === "skipped" &&
        skipped.U.reason === "lease_ended" &&
        one(`SELECT state FROM morrow_work.upkeep_triggers WHERE id=${literal(skippedTrigger)}`)
          ?.state === "skipped" &&
        count("SELECT count(*) FROM morrow_work.agent_runs") === runs,
      { skipped },
    );
  }

  // ---------------------------------------------------------------------------
  phase("sweep_and_segments");
  {
    // A queued run whose lease expired unrenewed (sim: its recorded expiry moved back).
    db.workOwner(
      `UPDATE morrow_work.agent_runs SET lease_expires_at=${ms}-interval '1 minute',revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(R3)};`,
    );
    const leases = count("SELECT count(*) FROM morrow_work.work_leases");
    const out = runtime(
      `SELECT 'K:'||COALESCE(json_agg(row_to_json(x)),'[]'::json)::text FROM morrow_work.agent_run_wake_candidates() x;`,
    );
    const actions = new Map((out.K ?? []).map((k) => [k.run_id, k.action]));
    const columns = out.K?.[0] ? Object.keys(out.K[0]).sort().join(",") : "";
    check(
      "S1:the_sweep_lists_ids_and_actions_and_issues_no_lease",
      out.ok &&
        columns ===
          "action,incarnation,organization_id,run_id,segment,wait_sequence,workspace_id" &&
        actions.get(R5) === "check_in" &&
        actions.get(R6) === "resume" &&
        actions.get(RP) === "lapse" &&
        actions.get(R3) === "close_lapsed" &&
        actions.get(R8) === "lapse" &&
        !actions.has(R4) &&
        count("SELECT count(*) FROM morrow_work.work_leases") === leases,
      { candidates: out.K, stderr: out.stderr.slice(0, 300) },
    );
    // A segment roll under the run's lease: s2 of incarnation 1; a replay answers the same roll;
    // another incarnation is superseded.
    const T7 = await taskOf(P.A, "Segments");
    const run7 = await admit(P.A, T7);
    const r7 = runRow(run7.runId);
    runtime(enter(r7.lease) + row("S", "morrow_work.agent_run_start()"));
    const rolled = runtime(
      enter(r7.lease) + row("G", "morrow_work.agent_run_segment_roll('1','1','steps')"),
    );
    const replay = runtime(
      enter(r7.lease) + row("G", "morrow_work.agent_run_segment_roll('1','1','steps')"),
    );
    const other = runtime(
      enter(r7.lease) + row("G", "morrow_work.agent_run_segment_roll('2','2','epoch')"),
    );
    const segments = db.rows(
      `SELECT segment,incarnation,workflow_instance_id AS instance,(rolled_at IS NOT NULL) AS rolled FROM morrow_work.run_segments WHERE run_id=${literal(run7.runId)} ORDER BY segment`,
    );
    check(
      "S2:a_segment_roll_records_the_next_instance_and_replays_safely",
      rolled.G?.outcome === "rolled" &&
        rolled.G.workflow_instance_id === run7.runId + "-s2-i1" &&
        replay.G?.outcome === "rolled_before" &&
        replay.G.workflow_instance_id === run7.runId + "-s2-i1" &&
        other.G?.outcome === "superseded" &&
        segments.length === 2 &&
        segments[0].rolled === true &&
        segments[1].instance === run7.runId + "-s2-i1" &&
        runRow(run7.runId).instance === run7.runId + "-s2-i1",
      { rolled, replay, other, segments },
    );
  }

  // ---------------------------------------------------------------------------
  phase("data_model");
  {
    // Safety ranges only, each just inside and just outside, by the owner in a savepoint
    // (sim: the runner that writes them is H7b's).
    const r = runRow(R1);
    const epoch = `INSERT INTO morrow_work.context_epochs(organization_id,workspace_id,context_id,epoch,kind,opening,prefix_digest,section_tokens,policy_version,renderer_version,opened_at) VALUES(${literal(O)},${literal(W)},${literal(r.context)},1,'initial','{}'::jsonb,${literal("a".repeat(64))},'{"tools":0,"system":0,"workspace":0,"opening":0,"conversation":0}'::jsonb,1,1,${ms}) ON CONFLICT DO NOTHING;`;
    db.workOwner(epoch);
    const attempt = (sql) => db.tryRun(`SET ROLE morrow_work_owner; BEGIN; ${sql} ROLLBACK;`).ok;
    // One clock reading for a turn's times (its guard requires updated_at=created_at at birth).
    const turn = (n, seq, budget = 1800000) =>
      `INSERT INTO morrow_work.run_turns(organization_id,workspace_id,context_id,sequence,run_id,turn,attempt,epoch,purpose,notices,input,input_digest,budget_ms,read_tags,audience,taint,created_at,updated_at) SELECT ${literal(O)},${literal(W)},${literal(r.context)},${seq},${literal(R1)},${n},1,1,'turn','[]'::jsonb,NULL,NULL,${budget},'[]'::jsonb,'{"kind":"workspace"}'::jsonb,'{"kinds":[],"sourceCount":0}'::jsonb,t,t FROM (SELECT ${ms} AS t) x;`;
    const tool = (ordinal) =>
      `${turn(1, 1)} INSERT INTO morrow_work.run_tool_calls(organization_id,workspace_id,run_id,tool_use_id,context_id,turn,ordinal,label,tool,capability_id,verb,replay_class,input_digest,counted,started_at,expires_at) SELECT ${literal(O)},${literal(W)},${literal(R1)},'toolu_${ordinal}',${literal(r.context)},1,${ordinal},'c${ordinal + 1}','run.plan',NULL,NULL,'internal_write',${literal("b".repeat(64))},true,t,t+interval '365 days' FROM (SELECT ${ms} AS t) x;`;
    const model = (maxOut, budget) =>
      `${turn(1, 1)} INSERT INTO morrow_work.agent_model_calls(organization_id,workspace_id,id,run_id,context_id,turn,attempt,sequence,purpose,epoch,cache_ttl,status,budget_ms,max_output_tokens,started_at) VALUES(${literal(O)},${literal(W)},${literal(randomUUID())},${literal(R1)},${literal(r.context)},1,1,1,'turn',1,'1h','started',${budget},${maxOut},${ms});`;
    const personWait = (interval) =>
      `INSERT INTO morrow_work.run_waits(organization_id,workspace_id,id,run_id,job_id,wait_sequence,kind,condition,state,opened_at,lapses_at,expires_at) SELECT ${literal(O)},${literal(W)},${literal(randomUUID())},${literal(R2)},NULL,999,'checkin','{"kind":"checkin","code":"turns"}'::jsonb,'open',t,t+interval '${interval}',t+interval '365 days' FROM (SELECT ${ms} AS t) x;`;
    // Blocks of 32,000 two-byte characters: 32 is about 2 MiB of jsonb text, 128 about 8 MiB
    // (each block within its own bound and the count within 128: only the size refuses it).
    const reply = (blocks) =>
      Number(
        last(
          db.sql(
            `SELECT morrow_work.loop_assistant_message_valid(jsonb_build_object('role','assistant','content',(SELECT jsonb_agg(jsonb_build_object('type','text','text',repeat(chr(233),32000))) FROM generate_series(1,${blocks}))))::int;`,
          ),
        ),
      );
    const cases = {
      turns: [attempt(turn(100000, 1)), attempt(turn(100001, 1))],
      toolCalls: [attempt(tool(63)), attempt(tool(64))],
      maxTokens: [attempt(model(128000, 1800000)), attempt(model(128001, 1800000))],
      budget: [attempt(model(32000, 1800000)), attempt(model(32000, 1800001))],
      turnBudget: [attempt(turn(1, 1, 1800000)), attempt(turn(1, 1, 1800001))],
      personWait: [
        attempt(personWait("1 day")),
        attempt(personWait("23 hours")),
        attempt(personWait("365 days")),
        attempt(personWait("366 days")),
      ],
      // The reply's own stored size: 4 MiB of jsonb text, never the 384 KiB stored-message
      // bound of results.
      reply: [reply(32), reply(128)],
    };
    check(
      "D1:checks_are_safety_ranges_only",
      JSON.stringify(cases) ===
        JSON.stringify({
          turns: [true, false],
          toolCalls: [true, false],
          maxTokens: [true, false],
          budget: [true, false],
          turnBudget: [true, false],
          personWait: [true, false, true, false],
          reply: [1, 0],
        }),
      cases,
    );
    const tables = [
      "jobs",
      "agent_contexts",
      "context_epochs",
      "agent_runs",
      "agent_calls",
      "agent_run_questions",
      "run_waits",
      "context_checkpoints",
      "run_turns",
      "run_tool_calls",
      "agent_model_calls",
      "run_plans",
      "run_plan_revisions",
      "run_events",
      "teammate_results",
      "result_items",
      "result_item_pages",
      "run_detector_state",
      "run_segments",
      "run_taint_sources",
      "run_memory_reads",
      "upkeep_triggers",
      "context_policy_versions",
    ];
    const rls = db.rows(
      `SELECT relname,relrowsecurity AND relforcerowsecurity AS forced FROM pg_class WHERE relnamespace='morrow_work'::regnamespace AND relname IN (${tables.map(literal).join(",")})`,
    );
    const deletable = db.rows(
      `SELECT t FROM unnest(ARRAY[${tables.map(literal).join(",")}]) t WHERE has_table_privilege('morrow_work_command','morrow_work.'||t,'DELETE') OR has_table_privilege('morrow_work_api','morrow_work.'||t,'DELETE')`,
    );
    const eventsUpdate = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_work_command; UPDATE morrow_work.run_events SET code='x'; ROLLBACK;`,
    );
    const apiManifest = db.tryRun(
      `BEGIN; SET LOCAL ROLE morrow_work_api; SELECT manifest_canonical FROM morrow_work.agent_runs; ROLLBACK;`,
    );
    check(
      "D2:force_rls_everywhere_no_delete_append_only_events_and_column_reads",
      rls.length === tables.length &&
        rls.every((t) => t.forced) &&
        deletable.length === 0 &&
        !eventsUpdate.ok &&
        !apiManifest.ok &&
        /permission denied/.test(apiManifest.stderr),
      { rls: rls.filter((t) => !t.forced), deletable },
    );
    // No content in the event stream: every column is an id, code, count, digest or time.
    const eventColumns = db
      .rows(
        "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='morrow_work' AND table_name='run_events' ORDER BY ordinal_position",
      )
      .map((c) => c.column_name + ":" + c.data_type);
    const allEvents = db.rows("SELECT kind,code FROM morrow_work.run_events");
    check(
      "D3:the_event_stream_holds_ids_and_codes_only",
      eventColumns.every((c) => !/:(jsonb|json)$/.test(c)) &&
        allEvents.every((e) => e.code === null || /^[a-z][a-z0-9_]{0,63}$/.test(e.code)) &&
        !JSON.stringify(allEvents).includes(questionText) &&
        !JSON.stringify(allEvents).includes(answerText),
      { eventColumns },
    );
  }
  return { checks, failures };
}

async function main() {
  const started = Date.now();
  let result;
  phase("engine_and_migrations");
  try {
    await withWorkDatabase(
      "H7a.agent-runs",
      async (db) => {
        result = await runAgentRunsLab(db);
      },
      { administrator: "createrole" },
    );
  } catch (error) {
    console.error("AGENT_RUNS_LAB_FAILED_IN:" + stage);
    throw error;
  }
  phase("report");
  writeArtifact("labs/agent-runs.json", {
    task: "Plan row H7a",
    qualification: "local_postgresql17_network_none_agent_runs",
    observedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    administrator: "createrole",
    checks: result.checks,
    providerRequests: 0,
    limitations: [
      "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data.",
      "Admission and the answer run in Node over psql connectors as morrow_api_worker; the runtime definers as morrow_runtime_executor, in one round trip each.",
      "Catalogue v2 and context policy v1 are published by an owner UPDATE (sim): their publication is a later reviewed forward migration. Waits, questions and upkeep triggers are owner-seeded (sim): the runner, inbox.ask and the notebook writes that open them are H7b's and H12's.",
      "The envelope's expiry is reached by moving a run's active time on (sim); the delegation envelope's 24-hour window is the kernel's (0031).",
      "The mandate, child, fork, review and standing-request lease sources are not built here: their cases prove that no definer or login can admit such a run yet.",
    ],
  });
  if (result.failures.length) {
    print("FAILED: " + result.failures.join(", "));
    process.exitCode = 1;
  } else print(`PASS: ${result.checks.length} plan row H7a agent-runs checks.`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
