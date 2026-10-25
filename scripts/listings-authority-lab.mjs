// M3 PR-1 PostgreSQL 17 laboratory: listings authority and stops (migrations
// listings-identity-bridge, listings-authority and agent-proposals) on an isolated
// network-none engine, the full manifest applied by the Neon-shaped non-superuser
// CREATEROLE administrator (ADR-0020 D4, the hosted shape). Through the real agents
// handler (Node, the psql work connector logged in as morrow_api_worker) and direct SQL
// as each login, it proves:
//   G  agent grants: membership null exactly for agents; the identity bridges' refusals;
//      every grant of the installation's grant set and the enable request inside M2's
//      store-link template (store_link_grants_v1()); agents.installation.activate held
//      only by the organization's founding principal (the ADR-0022 item 3 amendment of
//      2026-10-21);
//   E  "Enable Listings agent" (the ADR-0022 item 3 amendment): the server-built document,
//      bound to actor, session, five minutes and a single-use nonce; the confirmation
//      creates the installation, its principals and grants; replay, reuse, expiry,
//      another actor or session, lost authority and stops all refuse;
//   S  "Stop AI work": the KillSwitchRecord commits with the stop and its event, revokes
//      the installation's run leases, and a later lease_open is stopped; a stale prior
//      state is a conflict; resume only after the owner's own stop, with a fresh document
//      that is exactly the installation (release, connection, grants; a SQL refusal read
//      inside its own transaction, and committed) and lifts only the stop it named; a
//      confirmation under a connection stop changes nothing;
//   R  morrow_vault.resolve_call as the broker's login: every refusal, and nothing for
//      any other login;
//   D  delegation_facts as morrow_runtime_executor feeding the real agent kernel through
//      createLeaseDelegationReader (allow, and the P05.A02/A03 deny cases); an envelope with
//      several children gives each executor its own chain, and two chains are ambiguous;
//      a store whose M2 installation is not linked denies every step and refuses
//      resolve_call;
//   P  catalog proposals (the agent-proposals migration) and parameter redaction;
//   M  workspace_model_defaults through GET /models and PUT /settings/model-default;
//   T  the owner-run platform stop through the staging runner's admin transaction, and a
//      resume confirmed under it changes nothing;
//   L  M2's store installation unlinked, suspended or uninstalled: enable and resume are
//      refused at both steps, in TypeScript and in SQL, and change nothing (a SQL refusal
//      read inside its own transaction, and committed); linked again, the same documents
//      apply; "Stop AI work" needs no link.
// Owner-seeded synthetic fixtures only; no provider, credential or merchant data. Runs in
// the CI pg-work group. The local superuser is used only for fixtures and the shapes
// marked "sim".
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import canonicalize from "canonicalize";
import { createAgentAuthorityService } from "../packages/policy/src/agent-authority.ts";
import { effectiveRule, proposalDigest, riskClassFor } from "../packages/policy/src/review.ts";
import { listingFieldPaths, storeResource } from "../packages/policy/src/store-resource.ts";
import { validateCurrentDefinition } from "../packages/contracts/src/validation.ts";
import { createAgentsApiHandler } from "../packages/work/src/agents/http.ts";
import { createLeaseDelegationReader } from "../packages/work/src/agents/delegation-reader.ts";
import {
  buildInstallationDocument,
  enableRequestFields,
} from "../packages/work/src/agents/listings.ts";
import { createWorkApiHandler, workErrorResponse } from "../packages/work/src/http.ts";
import { createRuntimeAttempt, runLeaseStep } from "../packages/work/src/runtime/leases.ts";
import {
  asApi,
  asCommandRole,
  createLocalWorkConnector,
  literal,
  restoreSql,
  revocationSql,
  seedWorkFixtures,
  sleep,
  storeInstallationSql,
  withWorkDatabase,
  workFixtureOrigin,
  workRequest,
} from "../tests/tenant-conformance/harness.mjs";
import { defaults } from "../tests/fixtures/approval-records-fixtures.mjs";
import { directLink, library, payerFacts, rawFacts } from "./billing-route-fixtures.mjs";
import { psqlConnector } from "./fixtures/staging-psql-connection.mjs";
import { platformStop } from "./staging-runner.mjs";
import { writeArtifact } from "./artifacts.mjs";

const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
const capabilityOf = (id) => catalogue.capabilities.find((c) => c.id === id);
const plusSeconds = (t, s) => new Date(Date.parse(t) + s * 1000).toISOString();
const checks = [];
const failures = [];
const labStarted = Date.now();
let stage = "start";
const phase = (value) => {
  stage = value;
  console.error(
    "LISTINGS_LAB_PHASE:" + value + " t=" + Math.round((Date.now() - labStarted) / 1000) + "s",
  );
};
function within(promise, timeoutMs, wait) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Error("LISTINGS_LAB_STALLED:" + stage + ":" + wait)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
function check(name, passed, detail) {
  if (!/^[A-Z][0-9]+:[a-z0-9_]+$/.test(name) || checks.some((c) => c.name === name))
    throw Error("LISTINGS_LAB_CHECK_NAME:" + name);
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
const utc = (expression) =>
  `to_char((${expression}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// Worker console lines are captured (one fixed line per request).
const consoleLines = [];
const print = console.log.bind(console);
// The exact error envelope of one outcome (status, code, retry class and fixed message), so
// a case cannot pass on a neighbouring 409.
const envelopes = new Map();
for (const kind of [
  "guard_failed",
  "state_conflict",
  "revision_conflict",
  "denied",
  "invalid",
  "not_found",
]) {
  const response = workErrorResponse(kind, "lab");
  envelopes.set(kind, { status: response.status, body: await response.json() });
}
const is = (reply, kind) => {
  const e = envelopes.get(kind);
  return (
    reply.status === e.status &&
    reply.body.code === e.body.code &&
    reply.body.retryClass === e.body.retryClass &&
    reply.body.safeMessage === e.body.safeMessage
  );
};

export async function runListingsAuthorityLab(db) {
  phase("fixtures");
  const P = seedWorkFixtures(db);
  const O = P.A.org,
    W = P.A.workspace;
  // The store: M2 PR-2's store installation, linked (morrow_identity.work_store_installations
  // reads it). Its store, connection and installation ids are distinct, and the credential's
  // subject is the store installation (M2 0027).
  const S = "store_lab",
    C = "connection_lab",
    SI = "storeinst_lab";
  const store = storeResource(O, W, S, C);
  const link = (id, owner = P.A) =>
    db.admin(
      storeInstallationSql({
        org: O,
        workspace: W,
        principal: owner.principal,
        storeId: id,
        connectionId: id === S ? C : id.replace(/^store_/, "connection_"),
        installationId: id === S ? SI : id.replace(/^store_/, "storeinst_"),
      }),
    );
  link(S);
  // Store-link grants (M2 PR-2's template) and signup template v2's model-default grant
  // (M5 PR-1), owner-seeded for A (owner) and A1 (a member who requests runs).
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
  const workspaceRes = {
    organizationId: O,
    workspaceId: W,
    storeId: null,
    connectionId: null,
    kind: "workspace",
    id: W,
  };
  function storeGrant(p, capabilityId, verbs, fields = [...listingFieldPaths], resource = store) {
    const g = {
      // A grant on a store other than S carries its store id.
      id:
        "g_" +
        p.key.toLowerCase() +
        "_" +
        capabilityId.replaceAll(".", "_") +
        (resource.storeId === null || resource.storeId === S ? "" : "_" + resource.storeId),
      principal: actorOf(p),
      capabilityId,
      verbs,
      scope: {
        organizationId: O,
        workspaceId: W,
        storeIds: resource.storeId === null ? [] : [resource.storeId],
        accountIds: [],
        resources: [resource],
        fields,
      },
      issuedBy: linking(p),
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      policyRevision: 1,
    };
    if (!validateCurrentDefinition("Grant", g)) throw Error("LAB_GRANT_INVALID");
    return `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES(${literal(g.id)},${literal(O)},${literal(W)},${literal(p.membership)},${literal(p.principal)},${literal(JSON.stringify(g))}::jsonb);`;
  }
  const catalogGrants = (p, resource = store) => [
    storeGrant(p, "catalog.products.read", ["view", "delegate"], undefined, resource),
    storeGrant(p, "catalog.content.propose", ["execute", "delegate"], undefined, resource),
    storeGrant(
      p,
      "catalog.content.publish",
      ["propose", "approve", "execute", "delegate"],
      undefined,
      resource,
    ),
  ];
  const activateFields = ["evaluation", "grant", "installationId", "revision"];
  // The four rows of M2's store-link template (store_link_grants_v1()) on one store, as the
  // link issues them to the organization's founding principal (G3 pins the equality).
  const storeLinkGrants = (p, resource = store) => [
    ...catalogGrants(p, resource),
    storeGrant(p, "agents.installation.activate", ["execute"], activateFields, resource),
  ];
  // A founded O (its website signup, 0013): M2's link issues the store-link template only to
  // the organization's founding principal (ADR-0022 item 3 amendment, 2026-10-21).
  db.admin(`INSERT INTO morrow_identity.identity_verification_profiles(id,provider_id,environment_id,application_id,client_id,issuer,token_profile_revision,token_profile_digest,record_revision,state) VALUES('profile_listings','workos','environment_${"A".repeat(26)}','app_${"A".repeat(26)}','client_${"A".repeat(26)}','https://api.workos.com/user_management/client_${"A".repeat(26)}',1,${literal("a".repeat(64))},1,'active');
INSERT INTO morrow_identity.organization_signups VALUES(${literal(P.A.principal)},${literal(randomUUID())},${literal("b".repeat(64))},'profile_listings',${literal(O)},${literal(W)},${literal(P.A.membership)},'owner-bootstrap-v1',clock_timestamp());`);
  db.admin(
    [
      ...storeLinkGrants(P.A),
      storeGrant(
        P.A,
        "governance.model_default.revise",
        ["execute"],
        ["effort", "expectedRevision", "maxCreditsPerProduct", "model"],
        workspaceRes,
      ),
      ...catalogGrants(P.A1),
    ].join("\n"),
  );

  const as = (user) => (text) => db.sql(text, { user });
  const broker = as("morrow_vault_broker");
  const attempt = (text, user = "postgres") => db.tryRun(text, { user });
  const refused = (text, code, user = "postgres") => {
    const r = attempt(text, user);
    return !r.ok && new RegExp(code).test(r.stderr);
  };
  const cmd = (p, statements, end = "ROLLBACK") => {
    const r = db.tryRun(asCommandRole(p, statements, { end }));
    if (!r.ok) {
      if (process.env.MORROW_LAB_DEBUG === "1") console.error(r.stderr.slice(0, 600));
      throw Error("LISTINGS_LAB_SQL_FAILED:" + stage);
    }
    return r.stdout.split("\n").slice(1);
  };
  const count = (query) => Number(last(db.sql(`SELECT (${query})::bigint;`)));
  // What an enable or resume definer could change, as the api's role reads it (S8, L): the
  // Listings installations matching `where` (id, status, revision), their open stops set by
  // a person, and whether the enable document with this digest is recorded and unconsumed.
  const agentState = (where, digestSql) =>
    `SELECT concat_ws('|',(SELECT coalesce(string_agg(i.id::text||':'||i.status||':'||i.revision,',' ORDER BY i.id),'none') FROM morrow_work.agent_installations i WHERE ${where}),(SELECT coalesce(string_agg(s.id::text,',' ORDER BY s.id),'none') FROM morrow_work.stop_controls s JOIN morrow_work.agent_installations i ON s.target_id=i.id::text WHERE ${where} AND s.scope='installation' AND s.lifted_at IS NULL AND s.set_by_kind='human'),(SELECT count(*) FROM morrow_work.agent_enable_document(${digestSql}) d WHERE NOT d.consumed));`;
  // One SQL definer call (TypeScript bypassed), as the api's login in one transaction that
  // ends in ROLLBACK, as the Worker ends every outcome but applied. The state the call
  // leaves is read in that same transaction, after the call and before its ROLLBACK, where
  // anything it wrote is still visible, and compared with the committed state just before
  // the call: a refusal cannot pass because its writes were rolled back (the applied
  // controls show the same read sees an applied call's writes).
  const definerRun = (p, definer, state) => {
    const before = last(db.sql(asApi(p, state), { user: "morrow_api_worker" }));
    const out = db.sql(asApi(p, definer + "\n" + state), { user: "morrow_api_worker" }).split("\n");
    return { outcome: out.at(-2), before, after: out.at(-1), unchanged: out.at(-1) === before };
  };
  const refusedInPlace = (run, outcome) => run.outcome === outcome && run.unchanged;
  // An applied document call: the same read, in the same transaction, sees the document it
  // recorded (and nothing else changed).
  const recordedInPlace = (run) =>
    run.outcome === "applied" &&
    run.before.endsWith("|0") &&
    run.after === run.before.slice(0, -1) + "1";
  // The state of one M2 store installation as M2 PR-3's uninstall and suspension paths
  // write it (sim: the lab moves an installation back and forth between states, which no
  // path does, so the edit runs with shopify_record_guard disabled; M2 PR-3's end columns
  // are set as its paths set them, so 0036's store_installations_end CHECK holds).
  // `unlinked` clears the link reference; `linked` restores the installation's own link and
  // link time. Returns the state that work_store_installations reports.
  const linkedRows = new Map();
  const storeState = (installation, status) => {
    if (!linkedRows.has(installation))
      linkedRows.set(
        installation,
        db.rows(
          `SELECT link_id::text AS link_id,${utc("linked_at")} AS linked_at FROM morrow_identity.store_installations WHERE id=${literal(installation)}`,
        )[0],
      );
    const linked = linkedRows.get(installation);
    const keep = status !== "unlinked";
    db.sql(`BEGIN; ALTER TABLE morrow_identity.store_installations DISABLE TRIGGER shopify_record_guard;
UPDATE morrow_identity.store_installations SET status=${literal(status)},revision=revision+1,updated_at=greatest(${ms},updated_at),link_id=${keep ? literal(linked.link_id) : "NULL"},linked_at=${keep ? literal(linked.linked_at) + "::timestamptz" : "NULL"},suspended_at=${status === "suspended" ? `greatest(${ms},created_at)` : "NULL"},suspended_reason=${status === "suspended" ? "'disconnected'" : "NULL"},uninstalled_at=${status === "uninstalled" ? `greatest(${ms},created_at)` : "NULL"} WHERE id=${literal(installation)};
ALTER TABLE morrow_identity.store_installations ENABLE TRIGGER shopify_record_guard; COMMIT;`);
    return last(
      db.sql(
        `SELECT status FROM morrow_identity.work_store_installations(${literal(O)},${literal(W)}) WHERE installation_id=${literal(installation)};`,
      ),
    );
  };
  const linkStates = ["unlinked", "suspended", "uninstalled"];
  const ctx = { waitUntil() {} };
  const handler = createAgentsApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
  });
  const workApi = createWorkApiHandler({
    origin: workFixtureOrigin,
    connector: db.connector(),
    now: Date.now,
  });
  function agentsRequest(p, method, path, body, options = {}) {
    const headers = {
      Cookie: "__Host-morrow_session=" + (options.secret ?? p.secret),
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    };
    if (method !== "GET") {
      headers.Origin = workFixtureOrigin;
      headers["Content-Type"] = "application/json";
      headers["X-Morrow-Request"] = "1";
      headers["Idempotency-Key"] = options.key ?? randomUUID();
    }
    return new Request(
      workFixtureOrigin + "/workspace/" + (options.workspace ?? p.workspace) + path,
      {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  }
  let retries = 0;
  async function send(p, method, path, body, options = {}) {
    const key = options.key ?? randomUUID();
    for (let n = 1; ; n++) {
      console.log = (...args) => consoleLines.push(args.map(String).join(" "));
      let response;
      try {
        response = await within(
          (options.handler ?? handler).fetch(
            agentsRequest(p, method, path, body, { ...options, key }),
            undefined,
            ctx,
          ),
          60000,
          "request",
        );
      } finally {
        console.log = print;
      }
      const text = await response.text();
      const reply = { status: response.status, body: JSON.parse(text), headers: response.headers };
      // A loaded host may time a request out before its definer: reads retry, and a write
      // retries with the same key (a replay returns the recorded result).
      if (reply.status === 503 && n < 4) {
        retries++;
        await sleep(250);
        continue;
      }
      return reply;
    }
  }
  async function work(p, path, body) {
    for (let n = 1; n <= 5; n++) {
      console.log = () => {};
      let response;
      try {
        response = await workApi.fetch(workRequest(p, "POST", path, body), undefined, ctx);
      } finally {
        console.log = print;
      }
      const reply = { status: response.status, body: await response.json() };
      if (reply.status !== 503) return reply;
      await sleep(250);
    }
    throw Error("LAB_WORK_FIXTURE_UNAVAILABLE");
  }
  const listings = `/stores/${S}/agents/listings`;
  const docOf = (reply) => reply.body;

  // -------------------------------------------------------------------------
  phase("grants");
  {
    // G1: the grants CHECK. Agent principals are seeded as the identity owner (sim).
    const agent = "agent_" + randomUUID();
    db.admin(`INSERT INTO morrow_identity.principals VALUES(${literal(agent)},'agent',true);
INSERT INTO morrow_identity.agent_principals VALUES(${literal(agent)},'agent',${literal(O)},${literal(W)},'installation','installation_g',${ms});`);
    const agentActor = {
      kind: "agent",
      principalId: agent,
      organizationId: O,
      workspaceId: W,
      membershipId: null,
      installationId: "installation_g",
      mandateId: null,
    };
    const payload = (principal, id) => ({
      id,
      principal,
      capabilityId: "catalog.products.read",
      verbs: ["view"],
      scope: {
        organizationId: O,
        workspaceId: W,
        storeIds: [S],
        accountIds: [],
        resources: [store],
        fields: [...listingFieldPaths],
      },
      issuedBy: actorOf(P.A),
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      policyRevision: 1,
    });
    const insert = (id, membership, principal, body, kind, agentId) =>
      `SET ROLE morrow_identity_owner; INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload,principal_kind,agent_principal_id) VALUES(${literal(id)},${literal(O)},${literal(W)},${literal(membership)},${literal(principal)},${literal(JSON.stringify(body))}::jsonb,${literal(kind)},${literal(agentId)});`;
    const ok = attempt(
      insert("g_agent_ok", null, agent, payload(agentActor, "g_agent_ok"), "agent", agent),
    );
    check(
      "G1:agent_grant_without_membership_accepted",
      ok.ok &&
        count(
          "SELECT count(*) FROM morrow_identity.grants WHERE id='g_agent_ok' AND membership_id IS NULL AND principal_kind='agent'",
        ) === 1,
    );
    const withMembership = { ...agentActor, membershipId: P.A.membership };
    check(
      "G1:agent_grant_with_membership_refused",
      refused(
        insert(
          "g_agent_m",
          P.A.membership,
          agent,
          payload(withMembership, "g_agent_m"),
          "agent",
          agent,
        ),
        "check constraint|violates",
      ) &&
        refused(
          insert(
            "g_agent_m2",
            P.A.membership,
            agent,
            payload(agentActor, "g_agent_m2"),
            "agent",
            agent,
          ),
          "check constraint|violates",
        ),
    );
    check(
      "G1:human_grant_without_membership_refused",
      refused(
        insert(
          "g_human_n",
          null,
          P.A.principal,
          payload({ ...actorOf(P.A), membershipId: null }, "g_human_n"),
          "human",
          null,
        ),
        "check constraint|violates",
      ),
    );
    // A kind that disagrees with the principal row, or an agent principal of another
    // workspace, is refused by the foreign keys.
    check(
      "G1:kind_and_workspace_bound_by_foreign_keys",
      refused(
        insert(
          "g_kind",
          null,
          P.A.principal,
          payload({ ...actorOf(P.A), kind: "agent", membershipId: null }, "g_kind"),
          "agent",
          P.A.principal,
        ),
        "violates",
      ) &&
        refused(
          `SET ROLE morrow_identity_owner; INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload,principal_kind,agent_principal_id) VALUES('g_ws2',${literal(O)},'ws_w2',NULL,${literal(agent)},${literal(JSON.stringify({ ...payload({ ...agentActor, workspaceId: "ws_w2" }, "g_ws2"), scope: { ...payload(agentActor, "x").scope, workspaceId: "ws_w2", resources: [storeResource(O, "ws_w2", S, C)] } }))}::jsonb,'agent',${literal(agent)});`,
          "violates",
        ),
    );
    // Existing human readers never see agent grants: A's context lists only A's grants.
    const contextGrants = db.rows(
      `SELECT grant_count FROM morrow_work.enter_context(${literal(P.A.digest)},${literal(W)})`,
      {
        user: "morrow_api_worker",
        prefix: "BEGIN; SET LOCAL ROLE morrow_work_api;\n",
        suffix: "\nROLLBACK;",
      },
    );
    check(
      "G1:human_context_excludes_agent_grants",
      Number(contextGrants[0]?.grant_count) ===
        count(
          `SELECT count(*) FROM morrow_identity.grants WHERE membership_id=${literal(P.A.membership)}`,
        ),
      contextGrants,
    );
    // G2: the bridges. No session context: denied; another issuer, a verb outside the
    // allowlist, approve or execute on publish: invalid.
    const issue = (grants) =>
      `SELECT outcome FROM morrow_identity.work_agent_grants_issue(${literal(O)},${literal(W)},${literal(JSON.stringify(grants))}::jsonb);`;
    const noSession = db.sql(
      `BEGIN; SET LOCAL ROLE morrow_work_command; ${issue([payload(agentActor, "x")])} ROLLBACK;`,
    );
    check("G2:bridge_without_session_denied", last(noSession) === "denied");
    // A fresh installation principal (the first one already holds a grant, and an
    // installation's grant set is issued once, whole).
    const agent2 = "agent_" + randomUUID();
    db.admin(`INSERT INTO morrow_identity.principals VALUES(${literal(agent2)},'agent',true);
INSERT INTO morrow_identity.agent_principals VALUES(${literal(agent2)},'agent',${literal(O)},${literal(W)},'installation','installation_g2',${ms});`);
    const agentActor2 = { ...agentActor, principalId: agent2, installationId: "installation_g2" };
    const forBridge = (change) => ({
      ...payload(agentActor2, "g_b_" + randomUUID().slice(0, 8)),
      policyRevision: 1,
      ...change,
    });
    // validFrom must be inside the transaction: it is filled in by SQL.
    const bridgeCall = (grants) => {
      const text = JSON.stringify(grants);
      return last(
        cmd(
          P.A,
          `SELECT outcome FROM morrow_identity.work_agent_grants_issue(${literal(O)},${literal(W)},replace(${literal(text)},'__NOW__',${utc(ms)})::jsonb);`,
        ),
      );
    };
    const three = (change = {}) => [
      forBridge({
        capabilityId: "catalog.content.propose",
        verbs: ["execute"],
        validFrom: "__NOW__",
        ...change,
      }),
      forBridge({
        capabilityId: "catalog.content.publish",
        verbs: ["propose"],
        validFrom: "__NOW__",
      }),
      forBridge({ capabilityId: "catalog.products.read", verbs: ["view"], validFrom: "__NOW__" }),
    ];
    check(
      "G2:bridge_issues_exactly_the_allowlist",
      bridgeCall(three()) === "issued",
      bridgeCall(three()),
    );
    check(
      "G2:bridge_refuses_another_issuer_and_widened_verbs",
      bridgeCall(three({ issuedBy: actorOf(P.A1) })) === "invalid" &&
        bridgeCall([
          three()[0],
          forBridge({
            capabilityId: "catalog.content.publish",
            verbs: ["propose", "approve"],
            validFrom: "__NOW__",
          }),
          three()[2],
        ]) === "invalid" &&
        bridgeCall([
          three()[0],
          forBridge({
            capabilityId: "catalog.content.publish",
            verbs: ["execute"],
            validFrom: "__NOW__",
          }),
          three()[2],
        ]) === "invalid" &&
        bridgeCall([
          three()[0],
          three()[1],
          forBridge({
            capabilityId: "catalog.products.read",
            verbs: ["view", "delegate"],
            validFrom: "__NOW__",
          }),
        ]) === "invalid" &&
        bridgeCall(
          three({ scope: { ...payload(agentActor, "x").scope, fields: ["title", "vendor"] } }),
        ) === "invalid" &&
        bridgeCall(three().slice(0, 2)) === "invalid" &&
        bridgeCall(three({ validFrom: "2026-01-01T00:00:00.000Z" })) === "invalid",
    );
    // The command role cannot write grants itself, and the api cannot call the bridges.
    check(
      "G2:only_the_bridges_write_agent_grants",
      refused(
        asCommandRole(
          P.A,
          `INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload) VALUES('x',${literal(O)},${literal(W)},NULL,${literal(agent)},'{}');`,
        ),
        "permission denied",
      ) && refused(asApi(P.A, issue(three())), "permission denied", "morrow_api_worker"),
    );
    // G3: the installation never exceeds M2's store-link template (store_link_grants_v1(),
    // as applied): each capability of the installation's grant set is a template row whose
    // verbs and fields contain the installation's and which carries delegate (the owner
    // delegates what the installation receives); the enable request's fields are inside the
    // activate row. The lab's owner-seeded store-link grants are exactly the template.
    const template = db.rows(
      "SELECT capability_id,verbs,fields FROM morrow_identity.store_link_grants_v1()",
    );
    // A grant set's elements inside the template (the inner JOIN) and all of its elements:
    // they are equal only when no element falls outside, so a grant the template does not
    // hold cannot hide behind the JOIN.
    const listingsSet = `morrow_work.listings_grant_set(${literal(O)},${literal(W)},${literal(S)},${literal(C)})`;
    const insideOf = (set) =>
      last(
        db.sql(
          `SELECT (SELECT count(*) FROM jsonb_array_elements(${set}) g JOIN morrow_identity.store_link_grants_v1() t ON t.capability_id=g->>'capabilityId' WHERE (g->'verbs')<@t.verbs AND t.verbs ? 'delegate' AND (g#>'{scope,fields}')<@t.fields)||'|'||jsonb_array_length(${set});`,
        ),
      )
        .split("|")
        .map(Number);
    const [inside, total] = insideOf(listingsSet);
    // Negative controls: the same set with one more grant outside the template (a
    // capability it has no row for; a template capability with a verb its row lacks, or a
    // field its row lacks; the activate row, which carries no delegate) counts that grant in
    // the total only.
    const extra = (capabilityId, verbs, fields) =>
      `${listingsSet}||jsonb_build_array(jsonb_build_object('capabilityId',${literal(capabilityId)},'verbs',${literal(JSON.stringify(verbs))}::jsonb,'scope',jsonb_build_object('fields',${literal(JSON.stringify(fields))}::jsonb)))`;
    const outside = [
      insideOf(extra("governance.model_default.revise", ["execute"], ["model"])),
      insideOf(extra("catalog.content.propose", ["approve"], [...listingFieldPaths])),
      insideOf(extra("catalog.products.read", ["view"], ["vendor"])),
      insideOf(extra("agents.installation.activate", ["execute"], activateFields)),
    ];
    const seeded = db.rows(
      `SELECT payload->>'capabilityId' AS capability_id,payload->'verbs' AS verbs,payload#>'{scope,fields}' AS fields FROM morrow_identity.grants WHERE membership_id=${literal(P.A.membership)} AND payload#>>'{scope,resources,0,kind}'='store' AND payload#>>'{scope,resources,0,id}'=${literal(S)}`,
    );
    const key = (r) => JSON.stringify([r.capability_id, r.verbs, r.fields]);
    check(
      "G3:installation_and_enable_inside_the_store_link_template",
      template.length === 4 &&
        inside === 3 &&
        total === inside &&
        outside.every(([n, all]) => n === inside && all === inside + 1) &&
        template.some(
          (t) =>
            t.capability_id === "agents.installation.activate" &&
            t.verbs.includes("execute") &&
            enableRequestFields.every((f) => t.fields.includes(f)),
        ) &&
        seeded.map(key).sort().join() === template.map(key).sort().join(),
      { template, inside, total, outside, seeded },
    );
    // Neither agents bridge issues agents.installation.activate: not in an installation's
    // grant set, and not as the owner's grant (whose control, the disable grant, issues).
    const policyRevision = Number(
      last(
        db.sql(`SELECT policy_revision FROM morrow_identity.organizations WHERE id=${literal(O)};`),
      ),
    );
    const ownerBridge = (capabilityId, fields) =>
      last(
        cmd(
          P.A,
          `SELECT outcome FROM morrow_identity.work_owner_disable_grant_issue(${literal(O)},${literal(W)},replace(${literal(
            JSON.stringify({
              id: "g_owner_" + randomUUID().slice(0, 8),
              principal: actorOf(P.A),
              capabilityId,
              verbs: ["execute"],
              scope: {
                organizationId: O,
                workspaceId: W,
                storeIds: [S],
                accountIds: [],
                resources: [
                  {
                    organizationId: O,
                    workspaceId: W,
                    storeId: S,
                    connectionId: C,
                    kind: "installation",
                    id: "installation_g",
                  },
                ],
                fields,
              },
              issuedBy: {
                kind: "service",
                principalId: "morrow.agents",
                organizationId: O,
                workspaceId: W,
                membershipId: null,
                installationId: null,
                mandateId: null,
              },
              validFrom: "__NOW__",
              expiresAt: null,
              revokedAt: null,
              policyRevision,
            }),
          )},'__NOW__',${utc(ms)})::jsonb);`,
        ),
      );
    const disableControl = ownerBridge("agents.installation.disable", [
      "control",
      "installationId",
    ]);
    const ownerActivate = ownerBridge("agents.installation.activate", activateFields);
    const agentActivate = bridgeCall([
      three()[0],
      three()[1],
      forBridge({
        capabilityId: "agents.installation.activate",
        verbs: ["execute"],
        validFrom: "__NOW__",
        scope: { ...payload(agentActor, "x").scope, fields: activateFields },
      }),
    ]);
    check(
      "G3:no_agents_bridge_issues_activate",
      disableControl === "issued" && ownerActivate === "invalid" && agentActivate === "invalid",
      { disableControl, ownerActivate, agentActivate },
    );
  }

  // -------------------------------------------------------------------------
  phase("enable");
  let installationId, agentPrincipal, coordinatorPrincipal, delegationRun;
  {
    // E1: step 1 returns the server-built document and its nonce, once.
    const before = count("SELECT count(*) FROM morrow_work.agent_installations");
    const status0 = await send(P.A, "GET", listings);
    const document = await send(P.A, "POST", listings + "/document", {});
    const d = docOf(document);
    installationId = d.installationId;
    const row = db.rows(
      `SELECT purpose,actor_principal_id,actor_membership_id,session_digest,nonce_digest,(expires_at-created_at)::text AS window,consumed_at IS NULL AS open FROM morrow_work.agent_enable_documents WHERE digest=${literal(d.documentDigest ?? "")}`,
    )[0];
    check(
      "E1:document_is_server_built_and_bound",
      status0.status === 200 &&
        status0.body.installation === null &&
        status0.body.actions.enable === true &&
        document.status === 201 &&
        d.purpose === "enable" &&
        /^[a-f0-9]{64}$/.test(d.nonce) &&
        d.document.store.storeId === S &&
        d.document.grants.length === 3 &&
        row?.purpose === "enable" &&
        row.actor_principal_id === P.A.principal &&
        row.actor_membership_id === P.A.membership &&
        row.session_digest === P.A.digest &&
        row.nonce_digest === sha(d.nonce) &&
        row.window === "00:05:00" &&
        row.open === true &&
        before === 0,
      { status0: status0.body, document: document.status, row },
    );
    // A member without activate gets no document and cannot enable.
    const member = await send(P.A1, "POST", listings + "/document", {});
    check("E1:member_without_activate_denied", is(member, "denied"), member.body);
    // E2: the wrong nonce, another actor's or another session's confirmation fail closed.
    const wrong = await send(P.A, "POST", listings, {
      documentDigest: d.documentDigest,
      nonce: "0".repeat(64),
    });
    // Another actor (TypeScript bypassed: B in its own api context) and another session of
    // the same actor reach the definer and are refused by its document binding.
    const definerCall = (p, options) =>
      last(
        db.sql(
          asApi(
            p,
            `SELECT outcome FROM morrow_work.cmd_listings_enable(${literal(randomUUID())},${literal("a".repeat(64))},'corr',${literal(S)},${literal(d.documentDigest)},${literal(d.nonce)},NULL,NULL,NULL,NULL);`,
            options,
          ),
          { user: "morrow_api_worker" },
        ),
      );
    const otherSecret = "second_session_" + randomUUID();
    db.admin(
      `INSERT INTO morrow_identity.sessions VALUES(${literal("session_a_second")},${literal(P.A.principal)},${literal(O)},${literal(sha(otherSecret))},'workos','provider_session_a_second',clock_timestamp()+interval '1 day',NULL);`,
    );
    check(
      "E2:nonce_actor_and_session_bound",
      is(wrong, "guard_failed") &&
        definerCall(P.B) === "guard_failed" &&
        definerCall(P.A, { digest: sha(otherSecret) }) === "guard_failed" &&
        count("SELECT count(*) FROM morrow_work.agent_installations") === 0,
      {
        wrong: wrong.body,
        b: definerCall(P.B),
        session: definerCall(P.A, { digest: sha(otherSecret) }),
      },
    );
    // E3: an expired document (owner-inserted, built six minutes ago: sim) is refused.
    const old = await buildInstallationDocument({
      id: randomUUID(),
      purpose: "enable",
      store,
      installationId: "installation_old",
      actor: actorOf(P.A),
      createdAtMs: Date.parse(last(db.sql(`SELECT ${utc(ms + "-interval '6 minutes'")};`))),
    });
    const oldNonce = "1".repeat(64);
    db.workOwner(
      `INSERT INTO morrow_work.agent_enable_documents VALUES(${literal(O)},${literal(W)},${literal(old.document.id)},'enable',${literal(S)},${literal(C)},'installation_old','morrow.listings',1,${literal(old.document.release.digest)},${literal(P.A.principal)},${literal(P.A.membership)},${literal(P.A.digest)},${literal(sha(oldNonce))},${literal(old.canonical)},${literal(old.digest)},${literal(randomUUID())},${literal(old.document.createdAt)}::timestamptz,${literal(old.document.expiresAt)}::timestamptz,NULL,NULL);`,
    );
    const expired = await send(P.A, "POST", listings, {
      documentDigest: old.digest,
      nonce: oldNonce,
    });
    check("E3:expired_document_refused", is(expired, "guard_failed"), expired.body);
    // A document whose text is not the server's derivation cannot even be stored.
    const forged = JSON.parse(old.canonical);
    forged.grants[1].verbs = ["propose", "execute"];
    const forgedText = canonicalize(forged);
    check(
      "E3:forged_document_refused_by_check",
      refused(
        `SET ROLE morrow_work_owner; INSERT INTO morrow_work.agent_enable_documents VALUES(${literal(O)},${literal(W)},${literal(randomUUID())},'enable',${literal(S)},${literal(C)},'installation_old','morrow.listings',1,${literal(old.document.release.digest)},${literal(P.A.principal)},${literal(P.A.membership)},${literal(P.A.digest)},${literal(sha("2"))},${literal(forgedText)},${literal(sha(forgedText))},${literal(randomUUID())},${literal(old.document.createdAt)}::timestamptz,${literal(old.document.expiresAt)}::timestamptz,NULL,NULL);`,
        "agent_enable_documents_document",
      ),
    );
    // E4: lost authority between the document and the confirmation is denied.
    db.admin(
      `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(${utc(ms)})) WHERE id='g_a_catalog_content_publish';`,
    );
    const lost = await send(P.A, "POST", listings, {
      documentDigest: d.documentDigest,
      nonce: d.nonce,
    });
    db.admin(
      `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}','null'::jsonb) WHERE id='g_a_catalog_content_publish';`,
    );
    check("E4:lost_authority_denied", is(lost, "denied"), lost.body);
    // E5: the confirmation creates the installation, both principals, the three agent grants
    // and the owner's disable grant, and consumes the document.
    const key = randomUUID();
    const enabled = await send(
      P.A,
      "POST",
      listings,
      { documentDigest: d.documentDigest, nonce: d.nonce },
      { key },
    );
    const installation = db.rows(
      `SELECT id,status,revision::int AS revision,agent_principal_id,owner_principal_id,scope,grant_refs,release_id FROM morrow_work.agent_installations WHERE id=${literal(installationId)}`,
    )[0];
    agentPrincipal = installation?.agent_principal_id;
    coordinatorPrincipal = db.rows(
      `SELECT principal_id FROM morrow_identity.agent_principals WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND role='coordinator'`,
    )[0]?.principal_id;
    const agentGrants = db
      .rows(
        `SELECT payload FROM morrow_identity.grants WHERE principal_id=${literal(agentPrincipal ?? "")} ORDER BY payload->>'capabilityId'`,
      )
      .map((r) => r.payload);
    const ownerDisable = db
      .rows(
        `SELECT payload FROM morrow_identity.grants WHERE membership_id=${literal(P.A.membership)} AND payload->>'capabilityId'='agents.installation.disable'`,
      )
      .map((r) => r.payload);
    check(
      "E5:enable_creates_installation_principals_and_grants",
      enabled.status === 200 &&
        enabled.body.status === "active" &&
        installation?.status === "active" &&
        installation.revision === 1 &&
        installation.owner_principal_id === P.A.principal &&
        installation.release_id === "morrow.listings" &&
        installation.grant_refs.length === 3 &&
        typeof coordinatorPrincipal === "string" &&
        agentGrants.map((g) => [g.capabilityId, g.verbs.join(",")]).join(";") ===
          "catalog.content.propose,execute;catalog.content.publish,propose;catalog.products.read,view" &&
        agentGrants.every(
          (g) =>
            g.principal.installationId === installationId &&
            g.issuedBy.principalId === P.A.principal,
        ) &&
        ownerDisable.length === 1 &&
        ownerDisable[0].scope.resources[0].kind === "installation" &&
        ownerDisable[0].issuedBy.principalId === "morrow.agents" &&
        count(
          `SELECT count(*) FROM morrow_work.agent_enable_documents WHERE digest=${literal(d.documentDigest)} AND consumed_at IS NOT NULL`,
        ) === 1 &&
        count(
          `SELECT count(*) FROM morrow_work.commands WHERE command_type='installation.enable' AND aggregate_id=${literal(installationId)}`,
        ) === 1,
      {
        enabled: enabled.body,
        installation,
        agentGrants: agentGrants.length,
        ownerDisable: ownerDisable.length,
      },
    );
    // The grant references are the digests of the stored payloads (the kernel's check).
    check(
      "E5:grant_refs_match_stored_payloads",
      installation?.grant_refs.every((ref) => {
        const g = agentGrants.find((x) => x.id === ref.id);
        return g && ref.digest === sha(canonicalize(g)) && ref.storeId === S && ref.revision === 1;
      }) === true,
    );
    // E6: a replay returns the recorded result; the nonce is single use; a second enable is
    // a state conflict.
    const replay = await send(
      P.A,
      "POST",
      listings,
      { documentDigest: d.documentDigest, nonce: d.nonce },
      { key },
    );
    const reuse = await send(P.A, "POST", listings, {
      documentDigest: d.documentDigest,
      nonce: d.nonce,
    });
    const second = await send(P.A, "POST", listings + "/document", {});
    check(
      "E6:replay_reuse_and_second_enable",
      replay.status === 200 &&
        replay.body.replayed === true &&
        replay.body.installationId === installationId &&
        is(reuse, "guard_failed") &&
        is(second, "state_conflict") &&
        count("SELECT count(*) FROM morrow_work.agent_installations") === 1 &&
        count("SELECT count(*) FROM morrow_identity.agent_principals WHERE role='coordinator'") ===
          1,
      { replay: replay.body, reuse: reuse.body, second: second.body },
    );
    const status1 = await send(P.A, "GET", listings);
    check(
      "E6:status_after_enable",
      status1.status === 200 &&
        status1.body.installation?.status === "active" &&
        status1.body.actions.enable === false &&
        status1.body.actions.stop === true &&
        status1.body.actions.resume === false,
      status1.body,
    );
  }

  // -------------------------------------------------------------------------
  // Leases are opened as the api commands will, in the session transaction (lease_open).
  const openLease = (p, kind, subject, o = {}) => {
    const [line] = cmd(
      p,
      `SELECT concat_ws('|',outcome,lease_id,generation) FROM morrow_work.lease_open(${literal(kind)},${literal(subject)},${literal(o.store ?? S)},${literal(o.connection ?? C)},${kind === "read" ? "NULL" : literal(o.installation ?? installationId)});`,
      "COMMIT",
    );
    const [outcome, id, generation] = line.split("|");
    return { outcome, id, generation };
  };
  const resolve = (lease, purpose, subject, generation = "1", user = "morrow_vault_broker") =>
    last(
      as(user)(
        `SELECT outcome FROM morrow_vault.resolve_call(${literal(lease)},${literal(generation)},${literal(purpose)},${literal(subject)});`,
      ),
    );

  phase("resolve_call");
  {
    // R1: a live run lease resolves for a model call, ids only.
    const run = openLease(P.A, "run", "run_r1");
    const resolved = db.rows(
      `SELECT * FROM morrow_vault.resolve_call(${literal(run.id)},'1','model','run_r1')`,
      { user: "morrow_vault_broker" },
    )[0];
    check(
      "R1:run_lease_resolves_for_the_model",
      run.outcome === "opened" &&
        resolved?.outcome === "resolved" &&
        resolved.organization_id === O &&
        resolved.installation_id === installationId &&
        resolved.credential_id === null &&
        resolved.wrapped_key === null,
      resolved,
    );
    // R2: the wrong generation, purpose or subject; a read lease for a model call.
    const read = openLease(P.A, "read", "read_r2");
    check(
      "R2:generation_purpose_subject",
      resolve(run.id, "model", "run_r1", "2") === "not_found" &&
        resolve(run.id, "model", "run_other") === "subject_mismatch" &&
        resolve(read.id, "model", "read_r2") === "purpose_mismatch" &&
        resolve(randomUUID(), "model", "run_r1") === "not_found" &&
        resolve(run.id, "payment", "run_r1") === "invalid" &&
        resolve("not-a-lease", "model", "run_r1") === "invalid",
    );
    // R3: shopify_read needs the store installation's active credential (owner-seeded
    // envelope bytes, sim); a read lease on another connection is connection_inactive.
    const noCredential = resolve(read.id, "shopify_read", "read_r2");
    db.workOwner(
      `INSERT INTO morrow_vault.credentials(organization_id,workspace_id,id,version,provider,kind,subject_id,status,kek_version,wrapped_key,sealed_value,created_at) VALUES(${literal(O)},${literal(W)},'credential_lab',1,'shopify','shopify_offline_token',${literal(SI)},'active',1,${literal("\\x" + "ab".repeat(60))}::bytea,${literal("\\x" + "cd".repeat(40))}::bytea,${ms});`,
    );
    const withCredential = db.rows(
      `SELECT * FROM morrow_vault.resolve_call(${literal(read.id)},'1','shopify_read','read_r2')`,
      { user: "morrow_vault_broker" },
    )[0];
    const foreign = openLease(P.A, "read", "read_foreign", { connection: "connection_other" });
    check(
      "R3:credential_and_connection",
      noCredential === "credential_unavailable" &&
        withCredential?.outcome === "resolved" &&
        withCredential.credential_id === "credential_lab" &&
        withCredential.wrapped_key === "ab".repeat(60) &&
        withCredential.sealed_value === "cd".repeat(40) &&
        resolve(foreign.id, "shopify_read", "read_foreign") === "connection_inactive" &&
        resolve(run.id, "shopify_read", "run_r1") === "resolved",
      { noCredential, withCredential: withCredential?.outcome },
    );
    // R4: an expired lease (owner-inserted, past creation: sim) and a removed initiator.
    const expired = randomUUID();
    db.workOwner(
      `INSERT INTO morrow_work.work_leases(organization_id,workspace_id,id,generation,kind,subject_id,store_id,connection_id,installation_id,initiator_principal_id,initiator_membership_id,status,created_at,expires_at) VALUES(${literal(O)},${literal(W)},${literal(expired)},1,'run','run_expired',${literal(S)},${literal(C)},${literal(installationId)},${literal(P.A.principal)},${literal(P.A.membership)},'active',${ms}-interval '40 minutes',${ms}-interval '10 minutes');`,
    );
    // The member-removal shape without 0024's lease revocation (sim): a lease of a member
    // whose workspace membership is inactive, checked before the revocation trigger runs.
    const memberLease = openLease(P.A1, "run", "run_member");
    db.sql(
      `BEGIN; ALTER TABLE morrow_identity.workspace_memberships DISABLE TRIGGER USER; UPDATE morrow_identity.workspace_memberships SET active=false WHERE membership_id=${literal(P.A1.membership)} AND workspace_id=${literal(W)}; ALTER TABLE morrow_identity.workspace_memberships ENABLE TRIGGER USER; COMMIT;`,
    );
    const removed = resolve(memberLease.id, "model", "run_member");
    db.sql(
      `BEGIN; ALTER TABLE morrow_identity.workspace_memberships DISABLE TRIGGER USER; UPDATE morrow_identity.workspace_memberships SET active=true WHERE membership_id=${literal(P.A1.membership)} AND workspace_id=${literal(W)}; ALTER TABLE morrow_identity.workspace_memberships ENABLE TRIGGER USER; COMMIT;`,
    );
    check(
      "R4:expired_and_member_inactive",
      resolve(expired, "model", "run_expired") === "expired" && removed === "member_inactive",
      { removed },
    );
    // R5: an installation no longer active (sim: disabled with no stop) refuses a run.
    db.workOwner(
      `UPDATE morrow_work.agent_installations SET status='disabled',revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(installationId)};`,
    );
    const inactive = resolve(run.id, "model", "run_r1");
    db.workOwner(
      `UPDATE morrow_work.agent_installations SET status='active',revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(installationId)};`,
    );
    check(
      "R5:installation_inactive",
      inactive === "installation_inactive" && resolve(run.id, "model", "run_r1") === "resolved",
    );
    // R6: a stop that has not revoked the lease (sim: stop_guard disabled for the insert)
    // still refuses at resolve time, for each stop scope.
    const stopSim = (scope, target, kind = "system") => {
      const id = randomUUID();
      db.sql(`BEGIN; ALTER TABLE morrow_work.stop_controls DISABLE TRIGGER stop_guard;
INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,set_by_membership_id,set_by_operator_id,reason_code,reason,created_at) VALUES(${scope === "platform" ? "NULL,NULL" : literal(O) + "," + literal(W)},${literal(id)},${literal(scope)},${scope === "platform" ? "NULL" : literal(S)},${scope === "platform" ? "NULL" : literal(target)},${literal(kind)},NULL,NULL,${kind === "operator" ? "'lab_operator'" : "NULL"},'lab_stop_sim','Laboratory stop',${ms});
ALTER TABLE morrow_work.stop_controls ENABLE TRIGGER stop_guard; COMMIT;`);
      const outcome = resolve(run.id, "model", "run_r1");
      db.workOwner(
        `UPDATE morrow_work.stop_controls SET lifted_at=greatest(${ms},created_at),lifted_by_kind='operator',lifted_by_operator_id='lab_operator' WHERE id=${literal(id)};`,
      );
      return outcome;
    };
    const stops = [
      stopSim("platform", null, "operator"),
      stopSim("connection", C),
      stopSim("installation", installationId),
    ];
    check(
      "R6:platform_connection_installation_stops",
      stops.every((o) => o === "stopped") && resolve(run.id, "model", "run_r1") === "resolved",
      stops,
    );
    // R7: no other login may call it; the command role gets only `denied`.
    check(
      "R7:broker_login_only",
      refused(
        `SELECT * FROM morrow_vault.resolve_call(${literal(run.id)},'1','model','run_r1');`,
        "permission denied",
        "morrow_runtime_executor",
      ) &&
        refused(
          `SELECT * FROM morrow_vault.resolve_call(${literal(run.id)},'1','model','run_r1');`,
          "permission denied",
          "morrow_api_worker",
        ) &&
        refused(
          `SELECT * FROM morrow_vault.resolve_call(${literal(run.id)},'1','model','run_r1');`,
          "permission denied",
          "morrow_connector_ingress",
        ) &&
        last(
          db.sql(
            `SET ROLE morrow_work_command; SELECT outcome FROM morrow_vault.resolve_call(${literal(run.id)},'1','model','run_r1');`,
          ),
        ) === "denied" &&
        // Its settings do not outlive the call: the broker reads no lease afterwards.
        last(
          broker(
            `BEGIN; SELECT outcome FROM morrow_vault.resolve_call(${literal(run.id)},'1','model','run_r1'); SELECT coalesce(current_setting('morrow.vault_resolve_lease',true),'')||'|'||coalesce(current_setting('morrow.vault_resolve_tenant',true),''); ROLLBACK;`,
          ),
        ) === "|",
    );
  }

  // -------------------------------------------------------------------------
  phase("delegation");
  {
    // Tasks through the work API (A), the Coordinator's grant through the bridge (A1, the
    // requester, issues it), and the envelope and hop owner-inserted as run admission
    // (M3 PR-2) will write them.
    const goal = await work(P.A, "/goals", {
      objective: "Better listings",
      storeIds: [],
      successCriteria: [
        { description: "Done", verificationCapabilityId: null, evidenceRequired: false },
      ],
    });
    const taskOf = async (objective) =>
      (await work(P.A, "/tasks", { goalId: goal.body.goalId, objective, allowedResources: [] }))
        .body.taskId;
    const root = await taskOf("Root");
    const child = await taskOf("Child");
    const coordinatorGrant = (id, task, expires = "interval '2 hours'") =>
      last(
        cmd(
          P.A1,
          `SELECT outcome FROM morrow_identity.work_agent_grants_issue(${literal(O)},${literal(W)},jsonb_build_array(jsonb_build_object('id',${literal(id)},'principal',jsonb_build_object('kind','agent','principalId',${literal(coordinatorPrincipal)},'organizationId',${literal(O)},'workspaceId',${literal(W)},'membershipId',NULL,'installationId',NULL,'mandateId',NULL),'capabilityId','workspace.task.delegate','verbs','["delegate"]'::jsonb,'scope',jsonb_build_object('organizationId',${literal(O)},'workspaceId',${literal(W)},'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,'resources',jsonb_build_array(jsonb_build_object('organizationId',${literal(O)},'workspaceId',${literal(W)},'storeId',NULL,'connectionId',NULL,'kind','task','id',${literal(task)})),'fields','["installationId","mandate","taskId"]'::jsonb),'issuedBy',jsonb_build_object('kind','human','principalId',${literal(P.A1.principal)},'organizationId',${literal(O)},'workspaceId',${literal(W)},'membershipId',${literal(P.A1.membership)},'installationId',NULL,'mandateId',NULL),'validFrom',${utc(ms)},'expiresAt',${utc(ms + "+" + expires)},'revokedAt',NULL,'policyRevision',${last(db.sql(`SELECT policy_revision FROM morrow_identity.organizations WHERE id=${literal(O)};`))})));`,
          "COMMIT",
        ),
      );
    const issued = coordinatorGrant("coordinator_root", root);
    const tooLong = coordinatorGrant("coordinator_long", root, "interval '25 hours'");
    check("D1:coordinator_grant_issued_within_24h", issued === "issued" && tooLong === "invalid", {
      issued,
      tooLong,
    });
    const caps =
      "ARRAY['catalog.content.propose','catalog.content.publish','catalog.products.read']";
    const verbs = "ARRAY['execute','propose','view']";
    // One instant per envelope and its hop (one transaction): a hop never outlives its
    // envelope by the milliseconds between two clock readings.
    const tx = "date_trunc('milliseconds',transaction_timestamp())";
    const envelope = (
      id,
      { from = tx, until = tx + "+interval '2 hours'", childEnvelope = "child_" + id } = {},
    ) =>
      db.workOwner(`BEGIN; INSERT INTO morrow_work.work_envelopes VALUES(${literal(O)},${literal(W)},${literal(id)},1,${literal(root)},1,${literal(P.A1.principal)},${literal(P.A1.membership)},${literal(S)},${literal(installationId)},${caps},${verbs},morrow_work.listings_scope(${literal(O)},${literal(W)},${literal(S)},${literal(C)}),${from},${until},NULL,1,1,${from});
INSERT INTO morrow_work.delegation_hops VALUES(${literal(O)},${literal(W)},${literal("hop_" + id)},1,${literal(root)},1,${literal(child)},1,${literal(id)},1,${literal(childEnvelope)},1,'builtin_coordinator',${literal(coordinatorPrincipal)},NULL,${literal(agentPrincipal)},${literal(installationId)},${caps},${verbs},morrow_work.listings_scope(${literal(O)},${literal(W)},${literal(S)},${literal(C)}),${from},${until},NULL,0,${from}); COMMIT;`);
    envelope("envelope_ok");
    envelope("envelope_expired", {
      from: tx + "-interval '3 hours'",
      until: tx + "-interval '1 hour'",
    });
    envelope("envelope_revoked");
    db.workOwner(
      `UPDATE morrow_work.work_envelopes SET revoked_at=greatest(${ms},created_at) WHERE id='envelope_revoked';`,
    );
    const run = openLease(P.A1, "run", "run_d1");
    const L = library();
    const entitled = JSON.parse(
      JSON.stringify(
        rawFacts({
          route: L.routes.morrow_direct,
          associations: [directLink("iA")],
          payers: [payerFacts("morrow_w")],
        }),
      )
        .replaceAll('"workspace_w"', JSON.stringify(W))
        .replaceAll('"store_a"', JSON.stringify(S)),
    );
    const billing = { read: async () => ({ facts: entitled, billingPeriod: null }) };
    const connector = createLocalWorkConnector(db.id, { user: "morrow_runtime_executor" });
    const runtimePool = {
      async connect(control) {
        const connection = await connector.open({
          signal: control.signal,
          deadlineMs: control.deadlineMs,
          waitUntil() {},
        });
        return {
          query: (text, values, c) => connection.query(text, [...values], c.signal),
          release: () => connection.close(),
        };
      },
    };
    const operation = (capabilityId = "catalog.products.read", verb = "view") => ({
      capabilityId,
      verb,
      resource: store,
      accountId: null,
      fields: ["descriptionHtml", "title"],
    });
    // One lease step: the reader over the step's delegation_facts, the unchanged kernel.
    const decide = async (envelopeId, op = operation(), options = {}) => {
      const a = createRuntimeAttempt(30000, new AbortController().signal);
      try {
        const result = await within(
          runLeaseStep(
            runtimePool,
            a,
            { leaseId: options.lease ?? run.id, generation: 1 },
            async (step) => {
              const reader = createLeaseDelegationReader({
                facts: step.delegationFacts,
                billing: options.billing ?? billing,
                environment: "staging",
                clock: () => new Date(L.now),
              });
              const service = createAgentAuthorityService(reader);
              try {
                const r = await service.decideDelegation(
                  JSON.stringify({
                    envelopeId,
                    executorInstallationId: installationId,
                    operation: op,
                  }),
                );
                return r.decision.reason;
              } catch (error) {
                return error.code ?? "error";
              }
            },
          ),
          120000,
          "lease_step",
        );
        if (!result.ok) return "step_failed";
        return result.value.entered ? result.value.value : "refused:" + result.value.refusal;
      } finally {
        a.end();
      }
    };
    const allowed = await decide("envelope_ok");
    const steps = await Promise.all([
      decide("envelope_ok", operation("catalog.content.propose", "execute")),
      decide("envelope_ok", operation("catalog.content.publish", "propose")),
    ]);
    check("D2:admitted_run_allowed", allowed === "allowed" && steps.every((s) => s === "allowed"), {
      allowed,
      steps,
    });
    check(
      "D3:expired_or_revoked_envelope_denied",
      (await decide("envelope_expired")) === "origin_denied" &&
        (await decide("envelope_revoked")) === "origin_denied",
    );
    // P05.A02: a refund (and approve or execute on publish) through the Listings route.
    const refund = await decide("envelope_ok", { ...operation("orders.refund.create", "propose") });
    const publishExecute = await decide(
      "envelope_ok",
      operation("catalog.content.publish", "execute"),
    );
    check(
      "D4:refund_and_publish_execute_denied",
      refund !== "allowed" && publishExecute !== "allowed",
      { refund, publishExecute },
    );
    // The requester lost view, then delegate (identity owner revocation of one grant).
    const revokeGrant = (id, on) =>
      db.admin(
        `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',${on ? "to_jsonb(" + utc(ms) + ")" : "'null'::jsonb"}) WHERE id=${literal(id)};`,
      );
    revokeGrant("g_a1_catalog_products_read", true);
    const lostView = await decide("envelope_ok");
    revokeGrant("g_a1_catalog_products_read", false);
    revokeGrant("coordinator_root", true);
    const lostCoordinator = await decide("envelope_ok");
    revokeGrant("coordinator_root", false);
    // The Coordinator's grant expired (owner maintenance, sim).
    db.admin(
      `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb(${utc(ms + "-interval '1 minute'")})) WHERE id='coordinator_root';`,
    );
    const expiredCoordinator = await decide("envelope_ok");
    db.admin(
      `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb(${utc(ms + "+interval '1 hour'")})) WHERE id='coordinator_root';`,
    );
    check(
      "D5:lost_grants_denied",
      lostView === "capability_denied" &&
        lostCoordinator === "capability_denied" &&
        expiredCoordinator === "capability_denied" &&
        (await decide("envelope_ok")) === "allowed",
      { lostView, lostCoordinator, expiredCoordinator },
    );
    // The installation's grant drifted from its reference (sim), and the installation
    // disabled without a stop (sim): both deny.
    // The exact stored payload is restored afterwards: its digest is the reference.
    const original = db.rows(
      `SELECT id,payload::text AS payload FROM morrow_identity.grants WHERE principal_id=${literal(agentPrincipal)} AND payload->>'capabilityId'='catalog.products.read'`,
    )[0];
    db.admin(
      `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{validFrom}','"2026-01-01T00:00:00.000Z"') WHERE id=${literal(original.id)};`,
    );
    const drift = await decide("envelope_ok");
    db.admin(
      `UPDATE morrow_identity.grants SET payload=${literal(original.payload)}::jsonb WHERE id=${literal(original.id)};`,
    );
    db.workOwner(
      `UPDATE morrow_work.agent_installations SET status='disabled',revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(installationId)};`,
    );
    const disabled = await decide("envelope_ok");
    db.workOwner(
      `UPDATE morrow_work.agent_installations SET status='active',revision=revision+1,updated_at=greatest(${ms},updated_at) WHERE id=${literal(installationId)};`,
    );
    check(
      "D6:grant_digest_drift_and_disabled_installation_denied",
      drift === "origin_denied" &&
        disabled === "origin_denied" &&
        (await decide("envelope_ok")) === "allowed",
      { drift, disabled },
    );
    // Owner departure: A (the installation owner, not the requester) is removed; A1's
    // lease survives (it is A1's), and the kernel denies through the owner.
    db.sql(revocationSql(P.A));
    const ownerGone = await decide("envelope_ok");
    db.sql(restoreSql(P.A));
    check(
      "D7:owner_departed_denied",
      ownerGone === "origin_denied" || ownerGone === "membership_revoked",
      ownerGone,
    );
    // Entitlement only from entitlementFor: an open route is entitlement_denied, and a failed
    // read through M5 PR-1's billing facts reader (@morrow/work/billing) denies the step.
    const open = {
      read: async () => ({
        facts: JSON.parse(
          JSON.stringify(rawFacts({ route: L.routes.open })).replaceAll(
            '"workspace_w"',
            JSON.stringify(W),
          ),
        ),
        billingPeriod: null,
      }),
    };
    const { createBillingFactsReader } = await import("../packages/work/src/billing/facts.ts");
    check(
      "D8:entitlement_only_via_entitlement_for",
      (await decide("envelope_ok", operation(), { billing: open })) === "entitlement_denied" &&
        (await decide("envelope_ok", operation(), {
          billing: createBillingFactsReader(async () => {
            throw Error("BILLING_READ_FAILED");
          }),
        })) === "AGENT_POLICY_AUTHORITY_UNAVAILABLE",
    );
    // The facts definer: nothing for another installation, a read lease or no lease.
    const read = openLease(P.A1, "read", "read_d9");
    const facts = (lease, installation, user = "morrow_runtime_executor") =>
      last(
        as(user)(
          `BEGIN; SELECT outcome FROM morrow_work.enter_lease(${literal(lease)},'1'); SELECT count(*) FROM morrow_work.delegation_facts('envelope_ok',${literal(installation)},'catalog.products.read'); ROLLBACK;`,
        ),
      );
    check(
      "D9:facts_only_under_the_installations_run_lease",
      facts(run.id, installationId) === "1" &&
        facts(run.id, "installation_other") === "0" &&
        facts(read.id, installationId) === "0" &&
        last(
          as("morrow_runtime_executor")(
            `BEGIN; SELECT count(*) FROM morrow_work.delegation_facts('envelope_ok',${literal(installationId)},'catalog.products.read'); ROLLBACK;`,
          ),
        ) === "0" &&
        refused(
          `SELECT count(*) FROM morrow_work.delegation_facts('envelope_ok',${literal(installationId)},'catalog.products.read');`,
          "permission denied",
          "morrow_vault_broker",
        ),
    );
    // D10: an envelope with two children (M3 PR-1 review). The first hop goes to another
    // installation (owner-inserted on another store, sim), the second to this one: this
    // executor's facts are its own chain and the kernel allows; the oldest hop is not
    // taken. Two chains ending at the same installation are ambiguous: no facts at all.
    const other = db.rows(
      `SELECT principal_id FROM morrow_identity.agent_principals WHERE organization_id=${literal(O)} AND workspace_id=${literal(W)} AND installation_id='installation_g'`,
    )[0]?.principal_id;
    const otherInstallation = (id, store, principal) =>
      `INSERT INTO morrow_work.agent_installations(organization_id,workspace_id,id,revision,release_id,release_revision,release_digest,store_id,connection_id,agent_principal_id,owner_principal_id,owner_membership_id,status,scope,grant_refs,configuration_digest,created_at,updated_at)
SELECT ${literal(O)},${literal(W)},${literal(id)},1,r.id,r.revision,r.digest,${literal(store)},${literal(store)},${literal(principal)},${literal(P.A.principal)},${literal(P.A.membership)},'active',morrow_work.listings_scope(${literal(O)},${literal(W)},${literal(store)},${literal(store)}),(SELECT jsonb_agg(jsonb_build_object('organizationId',${literal(O)},'workspaceId',${literal(W)},'storeId',${literal(store)},'kind','grant','id','g_ref_'||n,'revision',1,'digest',repeat('a',64))) FROM generate_series(1,3) n),repeat('b',64),${tx},${tx} FROM morrow_work.agent_releases r WHERE r.id='morrow.listings' AND r.revision=1;`;
    db.workOwner(`BEGIN; ${otherInstallation("installation_g", "store_g", other)} COMMIT;`);
    const twoChildren = (id, firstRecipient) =>
      db.workOwner(`BEGIN; INSERT INTO morrow_work.work_envelopes VALUES(${literal(O)},${literal(W)},${literal(id)},1,${literal(root)},1,${literal(P.A1.principal)},${literal(P.A1.membership)},${literal(S)},${literal(installationId)},${caps},${verbs},morrow_work.listings_scope(${literal(O)},${literal(W)},${literal(S)},${literal(C)}),${tx},${tx}+interval '2 hours',NULL,1,2,${tx});
INSERT INTO morrow_work.delegation_hops VALUES(${literal(O)},${literal(W)},${literal("hop_a_" + id)},1,${literal(root)},1,${literal(child)},1,${literal(id)},1,${literal("child_a_" + id)},1,'builtin_coordinator',${literal(coordinatorPrincipal)},NULL,${literal(firstRecipient.principal)},${literal(firstRecipient.installation)},${caps},${verbs},morrow_work.listings_scope(${literal(O)},${literal(W)},${literal(S)},${literal(C)}),${tx},${tx}+interval '2 hours',NULL,0,${tx}-interval '1 second');
INSERT INTO morrow_work.delegation_hops VALUES(${literal(O)},${literal(W)},${literal("hop_b_" + id)},1,${literal(root)},1,${literal(child)},1,${literal(id)},1,${literal("child_b_" + id)},1,'builtin_coordinator',${literal(coordinatorPrincipal)},NULL,${literal(agentPrincipal)},${literal(installationId)},${caps},${verbs},morrow_work.listings_scope(${literal(O)},${literal(W)},${literal(S)},${literal(C)}),${tx},${tx}+interval '2 hours',NULL,1,${tx}); COMMIT;`);
    twoChildren("envelope_two", { principal: other, installation: "installation_g" });
    twoChildren("envelope_twice", { principal: agentPrincipal, installation: installationId });
    const factsOf = (envelopeId) =>
      last(
        as("morrow_runtime_executor")(
          `BEGIN; SELECT outcome FROM morrow_work.enter_lease(${literal(run.id)},'1'); SELECT coalesce((SELECT hops FROM morrow_work.delegation_facts(${literal(envelopeId)},${literal(installationId)},'catalog.products.read')),'none'); ROLLBACK;`,
        ),
      );
    const twoHops = factsOf("envelope_two");
    const twiceHops = factsOf("envelope_twice");
    const twoDecision = await decide("envelope_two");
    const twiceDecision = await decide("envelope_twice");
    check(
      "D10:several_children_one_chain_per_executor",
      typeof other === "string" &&
        twoHops !== "none" &&
        JSON.parse(twoHops)
          .map((h) => h.id)
          .join(",") === "hop_b_envelope_two" &&
        twoDecision === "allowed" &&
        twiceHops === "none" &&
        twiceDecision !== "allowed",
      { other, twoHops, twiceHops, twoDecision, twiceDecision },
    );
    // A hop or an installation naming another installation's agent principal is refused
    // by the agent-principal keys.
    check(
      "D10:hops_and_installations_name_their_own_principals",
      refused(
        `SET ROLE morrow_work_owner; INSERT INTO morrow_work.delegation_hops SELECT organization_id,workspace_id,'hop_wrong_principal',revision,parent_task_id,parent_task_revision,child_task_id,child_task_revision,parent_envelope_id,parent_envelope_revision,'child_wrong_principal',child_envelope_revision,dispatcher_kind,dispatcher_principal_id,dispatcher_installation_id,${literal(other)},recipient_installation_id,capability_ids,verbs,scope,valid_from,expires_at,revoked_at,parent_child_count,created_at FROM morrow_work.delegation_hops WHERE id='hop_envelope_ok';`,
        "delegation_hops_organization_id_workspace_id_recipient_princ|violates foreign key",
      ) &&
        refused(
          `SET ROLE morrow_work_owner; ${otherInstallation("installation_h", "store_h", coordinatorPrincipal)}`,
          "violates foreign key",
        ),
    );
    // D11: the store's M2 installation not linked (unlinked, suspended or uninstalled; sim,
    // storeState). A run admitted while the store was linked gets no further: the step's
    // facts report the store not current and the kernel denies (provider_denied), and
    // resolve_call refuses the run lease's model call and Shopify read and a read lease's
    // Shopify read (connection_inactive). Linked again, the same lease steps and resolves.
    const storeCurrent = () =>
      last(
        as("morrow_runtime_executor")(
          `BEGIN; SELECT outcome FROM morrow_work.enter_lease(${literal(run.id)},'1'); SELECT store_current FROM morrow_work.delegation_facts('envelope_ok',${literal(installationId)},'catalog.products.read'); ROLLBACK;`,
        ),
      );
    const notLinked = {};
    for (const state of linkStates) {
      const read = openLease(P.A1, "read", "read_d11_" + state);
      const reported = storeState(SI, state);
      notLinked[state] = {
        reported,
        storeCurrent: storeCurrent(),
        step: await decide("envelope_ok"),
        model: resolve(run.id, "model", "run_d1"),
        runRead: resolve(run.id, "shopify_read", "run_d1"),
        read: resolve(read.id, "shopify_read", "read_d11_" + state),
      };
      storeState(SI, "linked");
    }
    const relinked = {
      storeCurrent: storeCurrent(),
      step: await decide("envelope_ok"),
      model: resolve(run.id, "model", "run_d1"),
      runRead: resolve(run.id, "shopify_read", "run_d1"),
    };
    check(
      "D11:store_not_linked_denies_steps_and_resolve_call",
      linkStates.every(
        (state) =>
          notLinked[state].reported === state &&
          notLinked[state].storeCurrent === "false" &&
          notLinked[state].step === "provider_denied" &&
          notLinked[state].model === "connection_inactive" &&
          notLinked[state].runRead === "connection_inactive" &&
          notLinked[state].read === "connection_inactive",
      ) &&
        relinked.storeCurrent === "true" &&
        relinked.step === "allowed" &&
        relinked.model === "resolved" &&
        relinked.runRead === "resolved",
      { notLinked, relinked },
    );
    // Keep the run lease for the stop section.
    delegationRun = run;
  }

  // -------------------------------------------------------------------------
  // M2 PR-3: one unredacted catalog proposal of S, kept for the last phase's shop/redact.
  let redactLater = null;
  phase("proposals");
  {
    // A review policy, then catalog Proposal@2 rows owner-inserted (the submit definer is
    // M3 PR-2's): every refusal comes from the agent-proposals CHECKs and triggers.
    const createdAt = last(db.sql(`SELECT ${utc(ms)};`));
    const rules = defaults.rules;
    const policyDoc = {
      schemaVersion: 1,
      id: "review-policy",
      organizationId: O,
      workspaceId: W,
      storeId: null,
      revision: 1,
      createdAt,
      updatedAt: createdAt,
      rules,
    };
    const policyText = canonicalize(policyDoc);
    db.workOwner(`INSERT INTO morrow_work.workspace_streams VALUES(${literal(O)},${literal(W)},0,clock_timestamp()) ON CONFLICT DO NOTHING;
INSERT INTO morrow_work.review_policies VALUES(${literal(O)},${literal(W)},'review-policy',1,${literal(JSON.stringify(rules))}::jsonb,${literal(policyText)},${literal(sha(policyText))},${literal(createdAt)}::timestamptz) ON CONFLICT DO NOTHING;`);
    const taskId = db.rows(
      `SELECT id FROM morrow_work.tasks WHERE workspace_id=${literal(W)} ORDER BY created_at LIMIT 1`,
    )[0].id;
    const product = (n, storeId = S, connectionId = C) => ({
      organizationId: O,
      workspaceId: W,
      storeId,
      connectionId,
      kind: "product",
      id: "product:" + n,
    });
    function catalogProposal(change = {}) {
      const capabilityId = change.capabilityId ?? "catalog.content.publish";
      const risk = riskClassFor(capabilityId);
      const irreversible = capabilityOf(capabilityId).irreversible;
      const rule = effectiveRule(rules, risk, irreversible);
      const storeId = change.storeId ?? S;
      const connectionId = change.connectionId ?? C;
      const targets = change.targets ?? [
        {
          resource: product(1, storeId, connectionId),
          expectedSourceRevision: "rev-1",
          fields: ["title"],
          maximumCredits: "0",
          maximumCost: null,
        },
        {
          resource: product(2, storeId, connectionId),
          expectedSourceRevision: "rev-1",
          fields: ["descriptionHtml", "tags"],
          maximumCredits: "0",
          maximumCost: null,
        },
      ];
      const parameters = canonicalize({ drafts: targets.map((t) => t.resource.id) });
      const parametersId = randomUUID();
      const scope = {
        organizationId: O,
        workspaceId: W,
        storeIds: [storeId],
        accountIds: [],
        resources: targets.map((t) => t.resource),
        fields: [...new Set(targets.flatMap((t) => t.fields))].sort(),
      };
      const content = {
        schemaVersion: 2,
        id: randomUUID(),
        organizationId: O,
        workspaceId: W,
        storeId,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        taskId: change.taskId === undefined ? taskId : change.taskId,
        capabilityId,
        scope,
        targets,
        parametersRef: {
          organizationId: O,
          workspaceId: W,
          storeId,
          kind: "artifact",
          id: parametersId,
          revision: 1,
          digest: sha(parameters),
        },
        parametersDigest: sha(parameters),
        maximumCredits: "0",
        maximumCost: null,
        risk,
        irreversible,
        reviewPolicyRef: {
          organizationId: O,
          workspaceId: W,
          storeId: null,
          kind: "policy",
          id: "review-policy",
          revision: 1,
          digest: sha(policyText),
        },
        proposedBy: {
          kind: "agent",
          principalId: change.proposer ?? agentPrincipal,
          organizationId: O,
          workspaceId: W,
          membershipId: null,
          installationId: change.installation === undefined ? installationId : change.installation,
          mandateId: null,
        },
        requestedBy: actorOf(P.A),
        beneficiaryPrincipalIds: [],
        contextTaint: change.contextTaint ?? "untrusted_external",
        partialApproval: "allowed",
        derivedFrom: null,
        proposalDigest: "0".repeat(64),
        expiresAt: plusSeconds(
          createdAt,
          rule.pendingExpirySeconds +
            rules.soloOwner.coolDownSeconds +
            rule.approvedValiditySeconds,
        ),
      };
      const doc = { ...content, proposalDigest: proposalDigest(content) };
      const { proposalDigest: digest, ...withoutDigest } = doc;
      const canonical = canonicalize(withoutDigest);
      const row = {
        proposerKind: change.proposerKind ?? "agent",
        proposerMembership: change.proposerMembership ?? null,
        proposerInstallation:
          change.installation === undefined ? installationId : change.installation,
        proposerPrincipal: change.proposer ?? agentPrincipal,
      };
      const sql = `INSERT INTO morrow_work.proposal_parameters VALUES(${literal(O)},${literal(W)},${literal(parametersId)},${literal(parameters)},${literal(sha(parameters))},${literal(createdAt)}::timestamptz);
INSERT INTO morrow_work.proposals(organization_id,workspace_id,id,revision,family_root_id,derived_from_id,derived_from_digest,selected_target_indexes,task_id,capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,proposer_principal_id,proposer_membership_id,requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,review_policy_digest,parameters_id,parameters_digest,canonical,digest,scope_canonical,scope_digest,expires_at,created_at,store_id,connection_id,proposer_kind,proposer_installation_id) VALUES(${literal(O)},${literal(W)},${literal(content.id)},1,${literal(content.id)},NULL,NULL,NULL,${literal(content.taskId)},${literal(capabilityId)},${literal(risk)},${irreversible},'allowed',${targets.length},0,${literal(row.proposerPrincipal)},${literal(row.proposerMembership)},${literal(P.A.principal)},${literal(P.A.membership)},'{}'::text[],'review-policy',1,${literal(sha(policyText))},${literal(parametersId)},${literal(sha(parameters))},${literal(canonical)},${literal(digest)},${literal(canonicalize(scope))},${literal(sha(canonicalize(scope)))},${literal(content.expiresAt)}::timestamptz,${literal(createdAt)}::timestamptz,${literal(change.storeColumn === undefined ? storeId : change.storeColumn)},${literal(change.connectionColumn === undefined ? connectionId : change.connectionColumn)},${literal(row.proposerKind)},${literal(row.proposerInstallation)});`;
      const approval = `INSERT INTO morrow_work.approvals(organization_id,workspace_id,id,revision,proposal_id,proposal_digest,family_root_id,status,required_approvals,self_approval,pending_expiry_seconds,approved_validity_seconds,cool_down_seconds,quiet_period_seconds,eligible_reviewer_principal_ids,counted_reviewer_principal_ids,scope_digest,review_policy_revision,policy_revision,effective_at,expires_at,invalidation_reason,created_at,updated_at) VALUES(${literal(O)},${literal(W)},${literal("approval_" + content.id)},1,${literal(content.id)},${literal(digest)},${literal(content.id)},'pending',${rule.requiredApprovals},${literal(rule.selfApproval)},${rule.pendingExpirySeconds},${rule.approvedValiditySeconds},${rules.soloOwner.coolDownSeconds},${rules.soloOwner.quietPeriodSeconds},${rule.eligibleReviewerPrincipalIds === null || rule.eligibleReviewerPrincipalIds === undefined ? "NULL" : rule.eligibleReviewerPrincipalIds.length ? "ARRAY[" + rule.eligibleReviewerPrincipalIds.map(literal).join(",") + "]::text[]" : "'{}'::text[]"},NULL,${literal(sha(canonicalize(scope)))},1,1,NULL,${literal(plusSeconds(createdAt, rule.pendingExpirySeconds))}::timestamptz,NULL,${literal(createdAt)}::timestamptz,${literal(createdAt)}::timestamptz);`;
      return { id: content.id, sql, approval, parametersId, digest, canonical, doc };
    }
    // As the command role in A's session context: the agent submit definer (M3 PR-2) is
    // command-owned, so the triggers' store lookups run with its privileges and policies.
    const insert = (p, withApproval = false) =>
      attempt(
        asCommandRole(P.A, p.sql + (withApproval ? "\n" + p.approval : ""), { end: "COMMIT" }),
      );
    const accepted = catalogProposal();
    const ok = insert(accepted, true);
    check("P1:store_bound_agent_proposal_accepted", ok.ok, ok.stderr?.slice(0, 300));
    // Refused by this PR's CHECKs, foreign keys or triggers, never by anything else.
    const refuses = (change) => {
      const r = insert(catalogProposal(change));
      return (
        !r.ok &&
        /violates check constraint|violates foreign key constraint|APPROVAL_RECORD_INVALID/.test(
          r.stderr,
        )
      );
    };
    link("store_other");
    const cases = {
      foreign_store: { storeId: "store_unlinked", connectionId: "store_unlinked" },
      foreign_connection: { connectionId: "connection_x" },
      another_linked_store: { storeId: "store_other", connectionId: "connection_other" },
      not_publish: { capabilityId: "catalog.content.propose" },
      null_task: { taskId: null },
      wrong_installation_principal: { proposer: coordinatorPrincipal },
      unknown_installation: { installation: "installation_unknown" },
      context_none: { contextTaint: "none" },
      agent_without_installation: { installation: null },
      human_proposer: {
        proposerKind: "human",
        proposerMembership: P.A.membership,
        installation: null,
        proposer: P.A.principal,
      },
      row_store_mismatch: { storeColumn: "store_other", connectionColumn: "connection_other" },
    };
    const results = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, refuses(v)]));
    check("P2:catalog_refusals", Object.values(results).every(Boolean), results);
    // An agent proposer on a non-catalog capability is refused; the human P06.T01b path on
    // the same capability is unchanged (a human's storeless proposal of 0018's shape).
    check(
      "P3:agent_on_non_catalog_refused",
      refused(
        asCommandRole(
          P.A,
          catalogProposal().sql.replace("'catalog.content.publish'", "'governance.grants.revise'"),
        ),
        "violates|APPROVAL_RECORD_INVALID",
      ),
    );
    // A derived proposal cannot drop or alter the proposer through NULL: it inherits the
    // root's store, kind and installation, and a membership it names is refused.
    const derivedId = randomUUID();
    const derived = (membership) =>
      `BEGIN; SELECT set_config('morrow.work_session_digest',${literal(P.A.digest)},true),set_config('morrow.work_workspace',${literal(W)},true); SET LOCAL ROLE morrow_work_command; INSERT INTO morrow_work.proposals(organization_id,workspace_id,id,revision,family_root_id,derived_from_id,derived_from_digest,selected_target_indexes,task_id,capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,proposer_principal_id,proposer_membership_id,requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,review_policy_digest,parameters_id,parameters_digest,canonical,digest,scope_canonical,scope_digest,expires_at,created_at) SELECT organization_id,workspace_id,${literal(derivedId)},1,id,id,digest,ARRAY[0],task_id,capability_id,risk,irreversible,'all_or_nothing',1,0,proposer_principal_id,${literal(membership)},requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,review_policy_digest,parameters_id,parameters_digest,canonical,digest,scope_canonical,scope_digest,expires_at,created_at FROM morrow_work.proposals WHERE id=${literal(accepted.id)}; ROLLBACK;`;
    check(
      "P4:derived_proposal_cannot_name_a_membership",
      refused(derived(P.A.membership), "APPROVAL_RECORD_INVALID|violates"),
    );
    // Without the tenant's own session context (no session, as shop/redact's connector
    // definer runs today, or another tenant's session) the helper refuses instead of
    // reporting an empty redaction as done, and nothing is redacted.
    const noContext = last(
      db.sql(
        `BEGIN; SET LOCAL ROLE morrow_work_command; SELECT outcome||'|'||coalesce(redacted::text,'') FROM morrow_work.parameters_redact_for_store(${literal(O)},${literal(W)},${literal(S)}); ROLLBACK;`,
      ),
    );
    const otherTenant = last(
      cmd(
        P.Y,
        `SELECT outcome||'|'||coalesce(redacted::text,'') FROM morrow_work.parameters_redact_for_store(${literal(O)},${literal(W)},${literal(S)});`,
      ),
    );
    check(
      "P5:redaction_needs_the_tenants_context",
      noContext === "context_unavailable|" &&
        otherTenant === "context_unavailable|" &&
        count(
          `SELECT count(*) FROM morrow_work.proposal_parameters WHERE id=${literal(accepted.parametersId)} AND redacted_at IS NULL`,
        ) === 1,
      { noContext, otherTenant },
    );
    // Parameter redaction: the store's parameters are emptied (digest kept) by the
    // revisable helper under the command role's own policies; a redacted proposal can
    // never be decided or claimed, and the redaction cannot be undone.
    const redacted = last(
      cmd(
        P.A,
        `SELECT outcome||'|'||redacted FROM morrow_work.parameters_redact_for_store(${literal(O)},${literal(W)},${literal(S)});`,
        "COMMIT",
      ),
    );
    const parameters = db.rows(
      `SELECT canonical,digest,redacted_at IS NOT NULL AS redacted FROM morrow_work.proposal_parameters WHERE id=${literal(accepted.parametersId)}`,
    )[0];
    const approvalId = "approval_" + accepted.id;
    const decide = `SET ROLE morrow_work_owner; INSERT INTO morrow_work.approval_decisions VALUES(${literal(O)},${literal(W)},${literal(approvalId)},1,${literal(P.A.principal)},${literal(P.A.membership)},'approve',${literal(accepted.digest)},${ms},${literal(randomUUID())},${literal("a".repeat(64))},NULL,NULL,NULL);`;
    const claim = `SET ROLE morrow_work_owner; INSERT INTO morrow_work.approval_claims VALUES(${literal(O)},${literal(W)},${literal(approvalId)},${literal(accepted.id)},${literal(P.A.principal)},${literal(P.A.membership)},'lab.consumer',${literal(randomUUID())},${ms});`;
    check(
      "P5:redaction_blocks_decide_and_claim",
      /^applied\|[1-9]/.test(redacted) &&
        parameters?.canonical === "{}" &&
        parameters.redacted === true &&
        /^[a-f0-9]{64}$/.test(parameters.digest) &&
        refused(decide, "APPROVAL_PARAMETERS_REDACTED") &&
        refused(claim, "APPROVAL_PARAMETERS_REDACTED") &&
        refused(
          `SET ROLE morrow_work_owner; UPDATE morrow_work.proposal_parameters SET canonical='{"x":1}' WHERE id=${literal(accepted.parametersId)};`,
          "WORK_RECORD_IMMUTABLE|violates",
        ) &&
        refused(
          `SET ROLE morrow_work_owner; DELETE FROM morrow_work.proposal_parameters WHERE id=${literal(accepted.parametersId)};`,
          "WORK_RECORD_IMMUTABLE",
        ),
      { redacted, parameters },
    );
    redactLater = catalogProposal();
    check("P6:a_second_proposal_for_shop_redact", insert(redactLater, true).ok);
  }

  // -------------------------------------------------------------------------
  phase("stop");
  {
    const run = openLease(P.A, "run", "run_s1");
    const operation = openLease(P.A, "operation", "claim_s1");
    const read = openLease(P.A, "read", "read_s1");
    const priorRun = delegationRun;
    // A member without the disable grant cannot stop the owner's agent.
    const memberStop = await send(P.A1, "POST", listings + "/stop", {
      control: { reason: "Not mine", sourceProposalRef: null },
    });
    const reason = "Drafts look wrong; stopping until reviewed";
    const stopped = await send(P.A, "POST", listings + "/stop", {
      control: { reason, sourceProposalRef: null },
    });
    const record = db.rows(
      `SELECT id,canonical,digest,prior_state_observed,actor_principal_id FROM morrow_work.kill_switch_records WHERE target_id=${literal(installationId)} ORDER BY created_at LIMIT 1`,
    )[0];
    const control = db.rows(
      `SELECT scope,set_by_kind,kill_switch_record_id,reason,reason_code FROM morrow_work.stop_controls WHERE scope='installation' AND target_id=${literal(installationId)} AND lifted_at IS NULL`,
    )[0];
    const leaseState = (id) =>
      db.rows(
        `SELECT status,revoked_reason FROM morrow_work.work_leases WHERE id=${literal(id)}`,
      )[0];
    check(
      "S1:stop_commits_record_stop_and_event",
      memberStop.status === 403 &&
        stopped.status === 200 &&
        stopped.body.status === "disabled" &&
        stopped.body.priorStateObserved === "active" &&
        record?.prior_state_observed === "active" &&
        record.digest === sha(record.canonical) &&
        validateCurrentDefinition("KillSwitchRecord", JSON.parse(record.canonical)) &&
        JSON.parse(record.canonical).control.reason === reason &&
        control?.set_by_kind === "human" &&
        control.kill_switch_record_id === record.id &&
        control.reason === reason &&
        control.reason_code === "human_stop_ai_work" &&
        count(
          `SELECT count(*) FROM morrow_work.outbox_events WHERE event_type='kill_switch.executed' AND aggregate_id=${literal(record.id)}`,
        ) === 1 &&
        count(
          `SELECT count(*) FROM morrow_work.agent_installations WHERE id=${literal(installationId)} AND status='disabled'`,
        ) === 1,
      { stopped: stopped.body, record, control },
    );
    check(
      "S2:stop_revokes_run_and_operation_leases_not_reads",
      leaseState(run.id)?.status === "revoked" &&
        leaseState(run.id).revoked_reason === "stop" &&
        leaseState(operation.id)?.status === "revoked" &&
        leaseState(priorRun.id)?.status === "revoked" &&
        leaseState(read.id)?.status === "active" &&
        openLease(P.A, "run", "run_s2").outcome === "stopped" &&
        resolve(run.id, "model", "run_s1") === "ended",
      { run: leaseState(run.id), read: leaseState(read.id) },
    );
    // Stopping again is idempotent: a second record says already_stopped; no second stop.
    const again = await send(P.A, "POST", listings + "/stop", {
      control: { reason: "Again", sourceProposalRef: null },
    });
    check(
      "S3:already_stopped_is_recorded_once_more",
      again.status === 200 &&
        again.body.priorStateObserved === "already_stopped" &&
        count(
          `SELECT count(*) FROM morrow_work.kill_switch_records WHERE target_id=${literal(installationId)}`,
        ) === 2 &&
        count(
          `SELECT count(*) FROM morrow_work.stop_controls WHERE scope='installation' AND target_id=${literal(installationId)} AND lifted_at IS NULL`,
        ) === 1,
      again.body,
    );
    // The record and stop are bound: a human stop without a record, a record that is not
    // the derivation of its row, or an edited record is refused.
    check(
      "S4:record_bound_to_stop",
      refused(
        `SET ROLE morrow_work_owner; INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,set_by_membership_id,reason_code,reason,created_at) VALUES(${literal(O)},${literal(W)},${literal(randomUUID())},'installation',${literal(S)},'installation_x','human',${literal(P.A.principal)},${literal(P.A.membership)},'human_stop_ai_work','x',${ms});`,
        "stop_controls_human_record",
      ) &&
        refused(
          `SET ROLE morrow_work_owner; UPDATE morrow_work.kill_switch_records SET prior_state_observed='active' WHERE id=${literal(record.id)};`,
          "WORK_RECORD_IMMUTABLE",
        ) &&
        refused(
          `SET ROLE morrow_work_owner; INSERT INTO morrow_work.kill_switch_records SELECT organization_id,workspace_id,${literal(randomUUID())},store_id,connection_id,capability_id,target_kind,target_id,actor_principal_id,actor_membership_id,canonical,digest,command_id,request_digest,prior_state_observed,created_at FROM morrow_work.kill_switch_records WHERE id=${literal(record.id)};`,
          "kill_switch_records_document",
        ),
    );
    // S7: a stale prior state (another stop committed between the Worker's read and the
    // definer's lock) is a state conflict to reread, never an invalid request; the fresh
    // record applies (rolled back here). The record is the S1 record re-dated in SQL.
    const stopDefiner = (prior) => {
      const command = randomUUID();
      return last(
        db.sql(
          asApi(
            P.A,
            `WITH r AS (SELECT (k.canonical::jsonb||jsonb_build_object('id',${literal(randomUUID())},'createdAt',${utc("date_trunc('milliseconds',transaction_timestamp())")},'commandId',${literal(command)},'requestDigest',${literal(sha(command))},'priorStateObserved',${literal(prior)}))::text AS t FROM morrow_work.kill_switch_records k WHERE k.id=${literal(record.id)}) SELECT x.outcome FROM r,morrow_work.cmd_stop_ai_work(${literal(command)},${literal(sha(command))},'corr',${literal(S)},${literal(installationId)},r.t,encode(sha256(convert_to(r.t,'UTF8')),'hex')) x;`,
          ),
          { user: "morrow_api_worker" },
        ),
      );
    };
    const records = () =>
      count(
        `SELECT count(*) FROM morrow_work.kill_switch_records WHERE target_id=${literal(installationId)}`,
      );
    const recordsBefore = records();
    const stale = stopDefiner("active");
    const fresh = stopDefiner("already_stopped");
    check(
      "S7:stale_prior_state_is_a_conflict",
      stale === "state_conflict" && fresh === "applied" && records() === recordsBefore,
      { stale, fresh },
    );

    // S8 (the ADR-0022 item 3 amendment; M3 PR-1 review): a resume document must be exactly
    // the installation it reactivates. A difference in the connection, the release or the
    // grants is refused at the document and at the confirmation, in TypeScript and in SQL,
    // and leaves the installation disabled, the owner's stop open and the document unused.
    const ownerStop = (id) =>
      count(
        `SELECT count(*) FROM morrow_work.stop_controls WHERE id=${literal(id)} AND lifted_at IS NULL AND set_by_kind='human'`,
      ) === 1;
    const openHumanStop = () =>
      db.rows(
        `SELECT id FROM morrow_work.stop_controls WHERE scope='installation' AND target_id=${literal(installationId)} AND lifted_at IS NULL AND set_by_kind='human'`,
      )[0]?.id;
    const disabled = () =>
      count(
        `SELECT count(*) FROM morrow_work.agent_installations WHERE id=${literal(installationId)} AND status='disabled'`,
      ) === 1;
    const unconsumed = (digest) =>
      count(
        `SELECT count(*) FROM morrow_work.agent_enable_documents WHERE digest=${literal(digest ?? "")} AND consumed_at IS NULL`,
      ) === 1;
    const confirmOf = (reply) => ({
      documentDigest: reply.body.documentDigest,
      nonce: reply.body.nonce,
    });
    const unchanged = (stopId, reply) =>
      disabled() && ownerStop(stopId) && unconsumed(reply.body.documentDigest);
    // SQL alone (TypeScript bypassed): the document definer with a resume document of the
    // store's current resource, dated inside its own transaction, and the confirmation
    // definer; each runs in its own transaction ending in ROLLBACK (definerRun), where the
    // installation's state (agentState: its status and revision, its open human stops, and
    // the named document unconsumed) is read after the call and before the rollback.
    const template = (
      await buildInstallationDocument({
        id: randomUUID(),
        purpose: "resume",
        store,
        installationId,
        actor: actorOf(P.A),
        createdAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
      })
    ).canonical;
    const placeholders = template
      .replace('"createdAt":"2026-01-01T00:00:00.000Z"', '"createdAt":"__CREATED__"')
      .replace('"expiresAt":"2026-01-01T00:05:00.000Z"', '"expiresAt":"__EXPIRES__"');
    const installationState = (digestSql) =>
      agentState(`i.id=${literal(installationId)}`, digestSql);
    const documentDefiner = () => {
      const command = randomUUID();
      const at = "date_trunc('milliseconds',transaction_timestamp())";
      const canonical = `replace(replace(${literal(placeholders)},'__CREATED__',${utc(at)}),'__EXPIRES__',${utc(at + "+interval '5 minutes'")})`;
      return definerRun(
        P.A,
        `WITH t AS (SELECT ${canonical} AS c) SELECT x.outcome FROM t,morrow_work.cmd_listings_enable_document(${literal(command)},${literal(sha(command))},'corr',${literal(S)},'resume',${literal(installationId)},${literal(JSON.parse(template).id)},t.c,encode(sha256(convert_to(t.c,'UTF8')),'hex'),${literal(sha(randomUUID()))}) x;`,
        installationState(`encode(sha256(convert_to(${canonical},'UTF8')),'hex')`),
      );
    };
    const confirmDefiner = (reply) =>
      definerRun(
        P.A,
        `SELECT outcome FROM morrow_work.cmd_listings_enable(${literal(randomUUID())},${literal("a".repeat(64))},'corr',${literal(S)},${literal(reply.body.documentDigest)},${literal(reply.body.nonce)},NULL,NULL,NULL,NULL);`,
        installationState(literal(reply.body.documentDigest ?? "")),
      );
    const h1 = openHumanStop();
    const sqlControl = documentDefiner();
    // (a) The installation pinned to another connection of the store (sim: the guard that
    // keeps an installation's connection fixed is disabled for the edit, and restored). The
    // SQL refusals are read in place: the confirmation's state before the call is the one a
    // resume would change (disabled, the owner's stop open, the document unused) and the
    // same read after the call, before its rollback, is unchanged. Repinned, the same
    // confirmation (rolled back) applies, and the same read sees the installation active,
    // the stop lifted and the document consumed; nothing persists.
    const pin = (connection) =>
      db.sql(`BEGIN; ALTER TABLE morrow_work.agent_installations DISABLE TRIGGER agent_installation_guard;
UPDATE morrow_work.agent_installations SET connection_id=${literal(connection)},scope=morrow_work.listings_scope(${literal(O)},${literal(W)},${literal(S)},${literal(connection)}) WHERE id=${literal(installationId)};
ALTER TABLE morrow_work.agent_installations ENABLE TRIGGER agent_installation_guard; COMMIT;`);
    const pending = await send(P.A, "POST", listings + "/document", {});
    pin("connection_old");
    const movedStatus = await send(P.A, "GET", listings);
    const movedDocument = await send(P.A, "POST", listings + "/document", {});
    const movedDefiner = documentDefiner();
    const movedConfirm = await send(P.A, "POST", listings, confirmOf(pending));
    const movedConfirmDefiner = confirmDefiner(pending);
    // And committed: nothing the TypeScript refusals or the definers did persists.
    const movedUnchanged = unchanged(h1, pending);
    pin(C);
    const repinnedConfirm = confirmDefiner(pending);
    const repinnedUnchanged = unchanged(h1, pending);
    const awaiting = new RegExp(`^${installationId}:disabled:([0-9]+)\\|${h1}\\|1$`);
    const revision = movedConfirmDefiner.before.match(awaiting)?.[1];
    check(
      "S8:resume_refused_on_another_connection",
      pending.status === 201 &&
        recordedInPlace(sqlControl) &&
        movedStatus.body.actions?.resume === false &&
        is(movedDocument, "state_conflict") &&
        refusedInPlace(movedDefiner, "state_conflict") &&
        is(movedConfirm, "state_conflict") &&
        refusedInPlace(movedConfirmDefiner, "state_conflict") &&
        revision !== undefined &&
        movedUnchanged &&
        repinnedConfirm.outcome === "applied" &&
        repinnedConfirm.before === movedConfirmDefiner.before &&
        repinnedConfirm.after === `${installationId}:active:${Number(revision) + 1}|none|0` &&
        repinnedUnchanged,
      {
        sqlControl,
        movedStatus: movedStatus.body,
        movedDocument: movedDocument.body,
        movedDefiner,
        movedConfirm: movedConfirm.body,
        movedConfirmDefiner,
        repinnedConfirm,
      },
    );
    // (b) A newer release published (sim: the shape of a future release migration; removed
    // afterwards): the installation stays on version 1, so SQL refuses both steps.
    const pendingRelease = await send(P.A, "POST", listings + "/document", {});
    db.workOwner(
      `INSERT INTO morrow_work.agent_releases(id,revision,status,manifest,digest,published_at) SELECT 'morrow.listings',2,'published',m,morrow_work.sha256_text(m),${ms} FROM (VALUES ('{"id":"morrow.listings","kind":"specialist","revision":2}')) v(m);`,
    );
    const releaseDocument = await send(P.A, "POST", listings + "/document", {});
    const releaseConfirm = await send(P.A, "POST", listings, confirmOf(pendingRelease));
    const releaseUnchanged = unchanged(h1, pendingRelease);
    db.sql(`BEGIN; ALTER TABLE morrow_work.agent_releases DISABLE TRIGGER append_only;
DELETE FROM morrow_work.agent_releases WHERE id='morrow.listings' AND revision=2;
ALTER TABLE morrow_work.agent_releases ENABLE TRIGGER append_only; COMMIT;`);
    check(
      "S8:resume_refused_after_a_newer_release",
      pendingRelease.status === 201 &&
        is(releaseDocument, "state_conflict") &&
        is(releaseConfirm, "state_conflict") &&
        releaseUnchanged,
      { releaseDocument: releaseDocument.body, releaseConfirm: releaseConfirm.body },
    );
    // (c) The agent's grants no longer the document's set (one revoked, sim; the exact
    // stored payload is restored afterwards): the identity bridge refuses both steps.
    const pendingGrants = await send(P.A, "POST", listings + "/document", {});
    const agentGrant = db.rows(
      `SELECT id,payload::text AS payload FROM morrow_identity.grants WHERE principal_id=${literal(agentPrincipal)} AND payload->>'capabilityId'='catalog.content.propose'`,
    )[0];
    db.admin(
      `UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(${utc(ms)})) WHERE id=${literal(agentGrant.id)};`,
    );
    const grantsDocument = await send(P.A, "POST", listings + "/document", {});
    const grantsConfirm = await send(P.A, "POST", listings, confirmOf(pendingGrants));
    const grantsUnchanged = unchanged(h1, pendingGrants);
    db.admin(
      `UPDATE morrow_identity.grants SET payload=${literal(agentGrant.payload)}::jsonb WHERE id=${literal(agentGrant.id)};`,
    );
    check(
      "S8:resume_refused_when_the_grants_differ",
      pendingGrants.status === 201 &&
        is(grantsDocument, "state_conflict") &&
        is(grantsConfirm, "state_conflict") &&
        grantsUnchanged &&
        recordedInPlace(documentDefiner()),
      { grantsDocument: grantsDocument.body, grantsConfirm: grantsConfirm.body },
    );

    // S5: resume only after the owner's own stop, through a fresh document and its nonce.
    // Two documents are built for the same stop; the second resumes.
    const status = await send(P.A, "GET", listings);
    const early = await send(P.A, "POST", listings + "/document", {});
    const doc = await send(P.A, "POST", listings + "/document", {});
    const resumed = await send(P.A, "POST", listings, confirmOf(doc));
    const lifted = db.rows(
      `SELECT id,lifted_by_kind,lifted_by_principal_id FROM morrow_work.stop_controls WHERE scope='installation' AND target_id=${literal(installationId)} ORDER BY created_at DESC LIMIT 1`,
    )[0];
    check(
      "S5:resume_after_the_owners_stop",
      status.body.installation?.stopped === true &&
        status.body.actions.resume === true &&
        status.body.blocked === false &&
        doc.status === 201 &&
        doc.body.purpose === "resume" &&
        doc.body.installationId === installationId &&
        resumed.status === 200 &&
        resumed.body.status === "active" &&
        resumed.body.purpose === "resume" &&
        lifted?.id === h1 &&
        lifted.lifted_by_kind === "human" &&
        lifted.lifted_by_principal_id === P.A.principal &&
        openLease(P.A, "run", "run_s3").outcome === "opened",
      { status: status.body, doc: doc.body?.purpose, resumed: resumed.body, lifted },
    );
    // A document names the stop it lifts: after a later stop, the earlier document (built
    // for the lifted stop, still unexpired and unconsumed) is refused and the later stop
    // stays.
    const restopped = await send(P.A, "POST", listings + "/stop", {
      control: { reason: "Stopping again after the resume", sourceProposalRef: null },
    });
    const h2 = openHumanStop();
    const lateConfirm = await send(P.A, "POST", listings, confirmOf(early));
    check(
      "S5:a_document_lifts_only_the_stop_it_named",
      restopped.status === 200 &&
        restopped.body.priorStateObserved === "active" &&
        typeof h2 === "string" &&
        h2 !== h1 &&
        is(lateConfirm, "state_conflict") &&
        unchanged(h2, early),
      { restopped: restopped.body, lateConfirm: lateConfirm.body },
    );
    // S6: a connection stop (system, owner-inserted, sim) is lifted only through its own
    // path. A resume document built before it, confirmed under it, changes nothing: the
    // connection stop and the owner's stop stay, the installation stays disabled, the
    // document stays unused. No new document is issued under it. After its own lift, the
    // same document resumes.
    const beforeConnection = await send(P.A, "POST", listings + "/document", {});
    const connectionStop = randomUUID();
    db.workOwner(
      `INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,reason_code,reason,created_at) VALUES(${literal(O)},${literal(W)},${literal(connectionStop)},'connection',${literal(S)},${literal(C)},'system','lab_connection_stop','Laboratory connection stop',${ms});`,
    );
    const stoppedAgain = await send(P.A, "POST", listings + "/stop", {
      control: { reason: "Pause during the disconnect", sourceProposalRef: null },
    });
    const underConnection = await send(P.A, "POST", listings + "/document", {});
    const confirmUnder = await send(P.A, "POST", listings, confirmOf(beforeConnection));
    const blockedStatus = await send(P.A, "GET", listings);
    const connectionOpen =
      count(
        `SELECT count(*) FROM morrow_work.stop_controls WHERE id=${literal(connectionStop)} AND lifted_at IS NULL`,
      ) === 1;
    const underUnchanged = unchanged(h2, beforeConnection);
    db.workOwner(
      `UPDATE morrow_work.stop_controls SET lifted_at=greatest(${ms},created_at),lifted_by_kind='operator',lifted_by_operator_id='lab_operator' WHERE id=${literal(connectionStop)};`,
    );
    check(
      "S6:connection_stop_not_lifted_by_resume",
      beforeConnection.status === 201 &&
        stoppedAgain.status === 200 &&
        stoppedAgain.body.priorStateObserved === "already_stopped" &&
        is(underConnection, "state_conflict") &&
        is(confirmUnder, "state_conflict") &&
        blockedStatus.body.blocked === true &&
        connectionOpen &&
        underUnchanged,
      {
        underConnection: underConnection.body,
        confirmUnder: confirmUnder.body,
        blocked: blockedStatus.body.blocked,
        connectionOpen,
        underUnchanged,
      },
    );
    // After the connection stop's own lift, the same document resumes (leaving the agent
    // active for the platform stop section).
    const resumed2 = await send(P.A, "POST", listings, confirmOf(beforeConnection));
    check(
      "S6:resume_after_connection_lift",
      resumed2.status === 200 && resumed2.body.status === "active" && !ownerStop(h2),
      resumed2.body,
    );
  }

  // -------------------------------------------------------------------------
  phase("platform_stop");
  {
    // T1: the owner's script, through the staging runner's admin transaction as the
    // Neon-shaped createrole administrator (neondb_owner), with fixed statements.
    const run = openLease(P.A, "run", "run_t1");
    const runner = (action, reason = "Laboratory platform stop") =>
      platformStop({
        connect: psqlConnector(db.id, { user: "neondb_owner", database: "morrow" }).connect,
        binding: { database: "morrow" },
        administrator: { name: "neondb_owner", mode: "createrole" },
        action,
        operatorId: "lab_operator",
        reason,
      });
    const set = await within(runner("set"), 120000, "platform_set");
    const again = await within(runner("set"), 120000, "platform_set_again");
    const blocked = openLease(P.A, "run", "run_t1b");
    const resolveRun = resolve(run.id, "model", "run_t1");
    const doc = await send(P.A, "POST", listings + "/document", {});
    const lift = await within(runner("lift", "Laboratory lift"), 120000, "platform_lift");
    const liftAgain = await within(
      runner("lift", "Laboratory lift"),
      120000,
      "platform_lift_again",
    );
    check(
      "T1:platform_stop_through_the_admin_runner",
      set.outcome === "applied" &&
        again.outcome === "already_stopped" &&
        again.stopId === set.stopId &&
        blocked.outcome === "stopped" &&
        resolveRun === "ended" &&
        is(doc, "state_conflict") &&
        lift.outcome === "applied" &&
        liftAgain.outcome === "not_stopped" &&
        openLease(P.A, "run", "run_t1c").outcome === "opened" &&
        count(
          `SELECT count(*) FROM morrow_work.stop_records WHERE stop_control_id=${literal(set.stopId)}`,
        ) === 2 &&
        Number(
          last(
            db.sql(
              "SELECT count(*) FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member WHERE r.rolname='neondb_owner' AND m.set_option AND m.roleid='morrow_work_owner'::regrole;",
            ),
          ),
        ) === 0,
      { set, again, blocked, resolveRun, doc: doc.body, lift, liftAgain },
    );
    // T2: a resume confirmed under the platform stop changes nothing. The owner stops the
    // agent and builds the resume document; the platform stop is set; the confirmation is a
    // conflict and leaves the platform stop, the owner's stop, the disabled installation and
    // the document; after the platform stop's own lift the same document resumes.
    const ownStopped = await send(P.A, "POST", listings + "/stop", {
      control: { reason: "Pause before the platform stop", sourceProposalRef: null },
    });
    const humanStop = db.rows(
      `SELECT id FROM morrow_work.stop_controls WHERE scope='installation' AND target_id=${literal(installationId)} AND lifted_at IS NULL AND set_by_kind='human'`,
    )[0]?.id;
    const resumeDoc = await send(P.A, "POST", listings + "/document", {});
    const set2 = await within(runner("set"), 120000, "platform_set_2");
    const docUnder = await send(P.A, "POST", listings + "/document", {});
    const confirmUnder = await send(P.A, "POST", listings, {
      documentDigest: resumeDoc.body.documentDigest,
      nonce: resumeDoc.body.nonce,
    });
    const blockedStatus = await send(P.A, "GET", listings);
    const held = {
      platform: count(
        `SELECT count(*) FROM morrow_work.stop_controls WHERE id=${literal(set2.stopId ?? "")} AND lifted_at IS NULL`,
      ),
      human: count(
        `SELECT count(*) FROM morrow_work.stop_controls WHERE id=${literal(humanStop ?? "")} AND lifted_at IS NULL`,
      ),
      disabled: count(
        `SELECT count(*) FROM morrow_work.agent_installations WHERE id=${literal(installationId)} AND status='disabled'`,
      ),
      unconsumed: count(
        `SELECT count(*) FROM morrow_work.agent_enable_documents WHERE digest=${literal(resumeDoc.body.documentDigest ?? "")} AND consumed_at IS NULL`,
      ),
    };
    const lift2 = await within(runner("lift", "Laboratory lift"), 120000, "platform_lift_2");
    const resumedAfter = await send(P.A, "POST", listings, {
      documentDigest: resumeDoc.body.documentDigest,
      nonce: resumeDoc.body.nonce,
    });
    check(
      "T2:resume_under_the_platform_stop_changes_nothing",
      ownStopped.status === 200 &&
        resumeDoc.status === 201 &&
        set2.outcome === "applied" &&
        is(docUnder, "state_conflict") &&
        is(confirmUnder, "state_conflict") &&
        blockedStatus.body.blocked === true &&
        held.platform === 1 &&
        held.human === 1 &&
        held.disabled === 1 &&
        held.unconsumed === 1 &&
        lift2.outcome === "applied" &&
        resumedAfter.status === 200 &&
        resumedAfter.body.status === "active",
      {
        set2,
        docUnder: docUnder.body,
        confirmUnder: confirmUnder.body,
        blocked: blockedStatus.body.blocked,
        held,
        lift2,
        resumedAfter: resumedAfter.body,
      },
    );
  }

  // -------------------------------------------------------------------------
  phase("link_states");
  {
    // L: M2 PR-2's store installation in a state other than linked (unlinked, suspended or
    // uninstalled, as work_store_installations reports them; sim, storeState). Store Z is
    // linked through M2's tables with the founder's store-link grants. For each state, a
    // document built while Z was linked is refused at both steps, in TypeScript (404: the
    // store has no current association) and in SQL with TypeScript bypassed (the document
    // definer not_found, the confirmation state_conflict), and nothing changes: each SQL
    // refusal's state is read inside its own transaction before the ROLLBACK and equals the
    // committed state before the call, and nothing persists after. Linked again, the SQL
    // controls (rolled back) get past the store check, and the same in-transaction read sees
    // what they wrote (the document recorded; the resume applied); the last document applies.
    // Store N was born unlinked (M2's own unlinked state) and was never linked.
    const Z = "store_lz",
      ZC = "connection_lz",
      ZI = "storeinst_lz",
      N = "store_ln";
    link(Z);
    db.admin(storeLinkGrants(P.A, storeResource(O, W, Z, ZC)).join("\n"));
    db.admin(
      storeInstallationSql({
        org: O,
        workspace: W,
        principal: P.A.principal,
        storeId: N,
        connectionId: "connection_ln",
        installationId: "storeinst_ln",
        link: false,
      }),
    );
    const zPath = `/stores/${Z}/agents/listings`;
    const nPath = `/stores/${N}/agents/listings`;
    const confirmOf = (reply) => ({
      documentDigest: reply.body.documentDigest,
      nonce: reply.body.nonce,
    });
    // The state an enable definer could change on a store (agentState): its Listings
    // installations, their open human stops, and the named enable document.
    const storeAgents = (storeId, digestSql) =>
      agentState(`i.store_id=${literal(storeId)}`, digestSql);
    // The document definer with a document of this store, dated inside its own transaction;
    // the state, of that store, names that document by its digest, recomputed in the same
    // transaction.
    const documentSql = async (storeId, connectionId, purpose, installation) => {
      const built = await buildInstallationDocument({
        id: randomUUID(),
        purpose,
        store: storeResource(O, W, storeId, connectionId),
        installationId: installation,
        actor: actorOf(P.A),
        createdAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
      });
      const text = built.canonical
        .replace('"createdAt":"2026-01-01T00:00:00.000Z"', '"createdAt":"__CREATED__"')
        .replace('"expiresAt":"2026-01-01T00:05:00.000Z"', '"expiresAt":"__EXPIRES__"');
      const command = randomUUID();
      const at = "date_trunc('milliseconds',transaction_timestamp())";
      const canonical = `replace(replace(${literal(text)},'__CREATED__',${utc(at)}),'__EXPIRES__',${utc(at + "+interval '5 minutes'")})`;
      const digest = `encode(sha256(convert_to(${canonical},'UTF8')),'hex')`;
      return definerRun(
        P.A,
        `WITH t AS (SELECT ${canonical} AS c) SELECT x.outcome FROM t,morrow_work.cmd_listings_enable_document(${literal(command)},${literal(sha(command))},'corr',${literal(storeId)},${literal(purpose)},${literal(installation)},${literal(built.document.id)},t.c,encode(sha256(convert_to(t.c,'UTF8')),'hex'),${literal(sha(randomUUID()))}) x;`,
        storeAgents(storeId, digest),
      );
    };
    // The confirmation definer. An enable confirmation carries principal ids and an empty
    // grant list, so on a linked store it passes the store check and stops at the grants
    // (invalid); a resume carries none.
    const confirmSql = (reply, purpose) =>
      definerRun(
        P.A,
        `SELECT outcome FROM morrow_work.cmd_listings_enable(${literal(randomUUID())},${literal("a".repeat(64))},'corr',${literal(Z)},${literal(reply.body.documentDigest)},${literal(reply.body.nonce)},${purpose === "enable" ? `${literal("agent_" + randomUUID())},${literal("agent_" + randomUUID())},'[]','{}'` : "NULL,NULL,NULL,NULL"});`,
        storeAgents(Z, literal(reply.body.documentDigest ?? "")),
      );
    const unconsumed = (reply) =>
      count(
        `SELECT count(*) FROM morrow_work.agent_enable_documents WHERE digest=${literal(reply.body.documentDigest ?? "")} AND consumed_at IS NULL`,
      ) === 1;

    // L0: a store that was never linked has no Listings status and no document.
    const neverReported = last(
      db.sql(
        `SELECT status FROM morrow_identity.work_store_installations(${literal(O)},${literal(W)}) WHERE installation_id='storeinst_ln';`,
      ),
    );
    const neverStatus = await send(P.A, "GET", nPath);
    const neverDocument = await send(P.A, "POST", nPath + "/document", {});
    const neverDefiner = await documentSql(N, "connection_ln", "enable", randomUUID());
    check(
      "L0:a_store_never_linked_is_not_found",
      neverReported === "unlinked" &&
        is(neverStatus, "not_found") &&
        is(neverDocument, "not_found") &&
        refusedInPlace(neverDefiner, "not_found") &&
        neverDefiner.before === "none|none|0" &&
        count(
          `SELECT count(*) FROM morrow_work.agent_enable_documents WHERE store_id=${literal(N)}`,
        ) === 0,
      {
        neverReported,
        neverStatus: neverStatus.body,
        neverDocument: neverDocument.body,
        neverDefiner,
      },
    );

    // L1: enable.
    const zInstallations = () =>
      count(`SELECT count(*) FROM morrow_work.agent_installations WHERE store_id=${literal(Z)}`);
    const enableRuns = {};
    let pending;
    for (const state of linkStates) {
      pending = await send(P.A, "POST", zPath + "/document", {});
      const reported = storeState(ZI, state);
      const status = await send(P.A, "GET", zPath);
      const document = await send(P.A, "POST", zPath + "/document", {});
      const documentDefiner = await documentSql(Z, ZC, "enable", randomUUID());
      const confirm = await send(P.A, "POST", zPath, confirmOf(pending));
      const confirmDefiner = confirmSql(pending, "enable");
      // And committed: nothing the TypeScript refusals or the definers did persists.
      const committed = zInstallations() === 0 && unconsumed(pending);
      storeState(ZI, "linked");
      enableRuns[state] = {
        pending: pending.status === 201 && pending.body.purpose === "enable",
        reported,
        status: is(status, "not_found"),
        document: is(document, "not_found"),
        documentDefiner,
        confirm: is(confirm, "not_found"),
        confirmDefiner,
        committed,
        controlDocument: await documentSql(Z, ZC, "enable", randomUUID()),
        controlConfirm: confirmSql(pending, "enable"),
      };
    }
    const enabled = await send(P.A, "POST", zPath, confirmOf(pending));
    // The negative control of the confirmation's state read: committed, the applied enable
    // shows there as the new installation with the document consumed.
    const enabledState = last(
      db.sql(asApi(P.A, storeAgents(Z, literal(pending.body.documentDigest ?? ""))), {
        user: "morrow_api_worker",
      }),
    );
    check(
      "L1:enable_refused_unless_linked",
      linkStates.every((state) => {
        const r = enableRuns[state];
        return (
          r.pending &&
          r.reported === state &&
          r.status &&
          r.document &&
          refusedInPlace(r.documentDefiner, "not_found") &&
          r.confirm &&
          refusedInPlace(r.confirmDefiner, "state_conflict") &&
          r.confirmDefiner.before === "none|none|1" &&
          r.committed &&
          recordedInPlace(r.controlDocument) &&
          refusedInPlace(r.controlConfirm, "invalid")
        );
      }) &&
        enabled.status === 200 &&
        enabled.body.status === "active" &&
        enabled.body.purpose === "enable" &&
        enabledState === enabled.body.installationId + ":active:1|none|0",
      { enableRuns, enabled: enabled.body, enabledState },
    );

    // L2: resume after the owner's own "Stop AI work".
    const zInstallation = enabled.body.installationId;
    const zStopped = await send(P.A, "POST", zPath + "/stop", {
      control: { reason: "Pause before the link checks", sourceProposalRef: null },
    });
    const humanStop = () =>
      db.rows(
        `SELECT id FROM morrow_work.stop_controls WHERE scope='installation' AND target_id=${literal(zInstallation ?? "")} AND lifted_at IS NULL AND set_by_kind='human'`,
      )[0]?.id;
    const ownerStopId = humanStop();
    const disabled = () =>
      count(
        `SELECT count(*) FROM morrow_work.agent_installations WHERE id=${literal(zInstallation ?? "")} AND status='disabled'`,
      ) === 1;
    // The negative control of the resume's state read: an applied resume, in its own
    // transaction, shows the installation active, the owner's stop lifted and the document
    // consumed.
    const resumedInPlace = new RegExp("^" + zInstallation + ":active:[0-9]+\\|none\\|0$");
    const resumeRuns = {};
    for (const state of linkStates) {
      pending = await send(P.A, "POST", zPath + "/document", {});
      const reported = storeState(ZI, state);
      const status = await send(P.A, "GET", zPath);
      const document = await send(P.A, "POST", zPath + "/document", {});
      const documentDefiner = await documentSql(Z, ZC, "resume", zInstallation);
      const confirm = await send(P.A, "POST", zPath, confirmOf(pending));
      const confirmDefiner = confirmSql(pending, "resume");
      // And committed: nothing the TypeScript refusals or the definers did persists.
      const committed = disabled() && humanStop() === ownerStopId && unconsumed(pending);
      storeState(ZI, "linked");
      resumeRuns[state] = {
        pending: pending.status === 201 && pending.body.purpose === "resume",
        reported,
        status:
          status.status === 200 &&
          status.body.linked === false &&
          status.body.installation?.status === "disabled" &&
          status.body.actions.enable === false &&
          status.body.actions.resume === false &&
          status.body.actions.stop === true,
        document: is(document, "not_found"),
        documentDefiner,
        confirm: is(confirm, "not_found"),
        confirmDefiner,
        committed,
        controlDocument: await documentSql(Z, ZC, "resume", zInstallation),
        controlConfirm: confirmSql(pending, "resume"),
      };
    }
    const resumed = await send(P.A, "POST", zPath, confirmOf(pending));
    check(
      "L2:resume_refused_unless_linked",
      zStopped.status === 200 &&
        typeof ownerStopId === "string" &&
        linkStates.every((state) => {
          const r = resumeRuns[state];
          return (
            r.pending &&
            r.reported === state &&
            r.status &&
            r.document &&
            refusedInPlace(r.documentDefiner, "not_found") &&
            r.confirm &&
            refusedInPlace(r.confirmDefiner, "state_conflict") &&
            r.confirmDefiner.before.startsWith(zInstallation + ":disabled:") &&
            r.confirmDefiner.before.endsWith("|" + ownerStopId + "|1") &&
            r.committed &&
            recordedInPlace(r.controlDocument) &&
            r.controlConfirm.outcome === "applied" &&
            r.controlConfirm.before === r.confirmDefiner.before &&
            resumedInPlace.test(r.controlConfirm.after)
          );
        }) &&
        resumed.status === 200 &&
        resumed.body.status === "active" &&
        resumed.body.purpose === "resume" &&
        humanStop() === undefined,
      { resumeRuns, resumed: resumed.body },
    );

    // L3: "Stop AI work" needs no current store. Z uninstalled: its run lease resolves
    // nothing, and the owner's stop still applies and revokes that lease.
    const zRun = openLease(P.A, "run", "run_lz", {
      store: Z,
      connection: ZC,
      installation: zInstallation,
    });
    const resolvedLinked = resolve(zRun.id, "model", "run_lz");
    const reported = storeState(ZI, "uninstalled");
    const resolvedUninstalled = resolve(zRun.id, "model", "run_lz");
    const stopped = await send(P.A, "POST", zPath + "/stop", {
      control: { reason: "Store uninstalled", sourceProposalRef: null },
    });
    const lease = db.rows(
      `SELECT status,revoked_reason FROM morrow_work.work_leases WHERE id=${literal(zRun.id ?? "")}`,
    )[0];
    storeState(ZI, "linked");
    check(
      "L3:stop_ai_work_needs_no_link",
      zRun.outcome === "opened" &&
        resolvedLinked === "resolved" &&
        reported === "uninstalled" &&
        resolvedUninstalled === "connection_inactive" &&
        stopped.status === 200 &&
        stopped.body.status === "disabled" &&
        stopped.body.priorStateObserved === "active" &&
        lease?.status === "revoked" &&
        lease.revoked_reason === "stop" &&
        disabled(),
      { resolvedLinked, resolvedUninstalled, stopped: stopped.body, lease },
    );
  }

  // -------------------------------------------------------------------------
  phase("model_default");
  {
    const models = await send(P.A1, "GET", "/models");
    const memberAllowed = models.body.entries
      ?.filter((e) => e.allowedForMember)
      .map((e) => e.creditsPerProduct);
    // Catalogue version 4 (ADR-0039, migration 0052): version 3's Opus 5.5 at medium by
    // default (ADR-0036), the default member ceiling of 4 that admits it, and 25 products a
    // run for every entry (no run cost cap).
    check(
      "M1:catalogue_default_and_member_ceiling",
      models.status === 200 &&
        models.body.catalogueVersion === 4 &&
        models.body.entries?.every((e) => e.runProductLimit === 25) &&
        models.body.ceiling === 4 &&
        models.body.revision === null &&
        models.body.canRevise === false &&
        models.body.workspaceDefault?.model === "claude_opus_5_5" &&
        models.body.workspaceDefault?.effort === "medium" &&
        memberAllowed.includes(4) &&
        memberAllowed.every((c) => c <= 4) &&
        !/claude-|usd|token|anthropic/i.test(JSON.stringify(models.body)),
      models.body,
    );
    const put = (p, body, key) => send(p, "PUT", "/settings/model-default", body, { key });
    const member = await put(P.A1, {
      model: "claude_opus_5_5",
      effort: "high",
      maxCreditsPerProduct: 6,
      expectedRevision: null,
    });
    const low = await put(P.A, {
      model: "claude_opus_5_5",
      effort: "high",
      maxCreditsPerProduct: 5,
      expectedRevision: null,
    });
    const stale = await put(P.A, {
      model: "claude_opus_5_5",
      effort: "high",
      maxCreditsPerProduct: 6,
      expectedRevision: 3,
    });
    const key = randomUUID();
    const first = await put(
      P.A,
      { model: "claude_opus_5_5", effort: "high", maxCreditsPerProduct: 6, expectedRevision: null },
      key,
    );
    const replay = await put(
      P.A,
      { model: "claude_opus_5_5", effort: "high", maxCreditsPerProduct: 6, expectedRevision: null },
      key,
    );
    const again = await put(P.A, {
      model: "claude_sonnet_5_5",
      effort: "low",
      maxCreditsPerProduct: 6,
      expectedRevision: null,
    });
    const second = await put(P.A, {
      model: "claude_sonnet_5_5",
      effort: "low",
      maxCreditsPerProduct: 6,
      expectedRevision: 1,
    });
    check(
      "M2:revise_rules",
      member.status === 403 &&
        low.status === 400 &&
        is(stale, "revision_conflict") &&
        first.status === 200 &&
        first.body.revision === 1 &&
        replay.status === 200 &&
        replay.body.replayed === true &&
        is(again, "revision_conflict") &&
        second.status === 200 &&
        second.body.revision === 2,
      {
        member: member.status,
        low: low.status,
        stale: stale.body,
        first: first.body,
        again: again.status,
        second: second.body,
      },
    );
    const raised = await send(P.A1, "GET", "/models");
    check(
      "M3:member_sees_the_raised_ceiling",
      raised.body.ceiling === 6 &&
        raised.body.revision === 2 &&
        raised.body.entries.every((e) => e.allowedForMember),
      raised.body,
    );
    // SQL refuses a key outside the active catalogue, a ceiling below the default, or the
    // retired versions 1 (ADR-0036) and 3 (ADR-0039).
    const definer = (model, effort, ceiling, version = "4") =>
      last(
        db.sql(
          asApi(
            P.A,
            `SELECT outcome FROM morrow_work.cmd_model_default_revise(${literal(randomUUID())},${literal("b".repeat(64))},'corr',${literal(version)},${literal(model)},${literal(effort)},${literal(ceiling)},'2');`,
          ),
          { user: "morrow_api_worker" },
        ),
      );
    check(
      "M4:sql_refuses_unknown_keys_and_low_ceilings",
      definer("claude_opus_9", "low", "6") === "invalid" &&
        definer("claude_opus_5_5", "high", "5") === "invalid" &&
        definer("claude_opus_5_5", "xhigh", "6") === "invalid" &&
        definer("claude_sonnet_5_5", "low", "6", "1") === "invalid" &&
        definer("claude_sonnet_5_5", "low", "6", "3") === "invalid",
    );
  }

  // G4 (ADR-0022 item 3 amendment, 2026-10-21): after every enable, resume and stop above,
  // agents.installation.activate is held only by the organization's founding principal, as
  // M2's store-link grants issued by morrow.linking (one per linked store, S and Z); no agent
  // principal, Coordinator or other member holds it.
  const activateHolders = db.rows(
    `SELECT g.principal_id::text AS principal,g.principal_kind AS kind,g.payload#>>'{issuedBy,principalId}' AS issuer,g.payload#>>'{scope,storeIds,0}' AS store,EXISTS(SELECT 1 FROM morrow_identity.organization_signups s WHERE s.organization_id=g.organization_id AND s.principal_id=g.principal_id) AS founder FROM morrow_identity.grants g WHERE g.organization_id=${literal(O)} AND g.payload->>'capabilityId'='agents.installation.activate' ORDER BY 4`,
  );
  check(
    "G4:only_the_founder_holds_activate",
    activateHolders
      .map((h) => h.store)
      .sort()
      .join() === [S, "store_lz"].sort().join() &&
      activateHolders.every(
        (h) =>
          h.founder === true &&
          h.principal === P.A.principal &&
          h.kind === "human" &&
          h.issuer === "morrow.linking",
      ),
    activateHolders,
  );

  // -------------------------------------------------------------------------
  // M2 PR-3: shop/redact from the connector's login (no session): the broker's login records
  // the delivery, the connector's applier ends the installation, empties that store's proposal
  // parameters through the revised helper (parameters_redact_for_store in the connector's
  // redaction context) and completes the privacy request once the token's destruction is
  // recorded. Another store's redaction leaves S's parameters untouched.
  phase("shop_redact");
  {
    const installationOf = (store) =>
      db.rows(
        `SELECT id::text AS id,app_key,shop_domain,shop_id FROM morrow_identity.store_installations WHERE store_id=${literal(store)}`,
      )[0];
    const redactStore = (store, webhookId) => {
      const i = installationOf(store);
      const inbox = last(
        db.sql(
          `SELECT inbox_id FROM morrow_vault.shopify_webhook_record(${literal(i.app_key)},${literal(i.shop_domain)},'shop/redact',${literal(webhookId)},'2026-10',${literal(JSON.stringify({ shopId: i.shop_id }))});`,
          { user: "morrow_vault_broker" },
        ),
      );
      const apply = () =>
        last(
          db.sql(
            `SELECT outcome||'|'||credential FROM morrow_work.connector_inbox_apply(${literal(inbox)});`,
            { user: "morrow_connector_ingress" },
          ),
        );
      const first = apply();
      const destroyed = last(
        db.sql(`SELECT morrow_vault.shopify_credential_destroy(${literal(i.id)},'uninstalled');`, {
          user: "morrow_vault_broker",
        }),
      );
      const second = apply();
      const request = db.rows(
        `SELECT status,evidence FROM morrow_identity.privacy_requests WHERE inbox_id=${literal(inbox)}`,
      )[0];
      return { first, destroyed, second, request, installation: i };
    };
    const fresh = () =>
      db.rows(
        `SELECT canonical<>'{}' AND redacted_at IS NULL AS content,digest FROM morrow_work.proposal_parameters WHERE id=${literal(redactLater.parametersId)}`,
      )[0];
    const before = fresh();
    const other = redactStore("store_other", "lab-redact-other");
    const afterOther = fresh();
    const own = redactStore(S, "lab-redact-own");
    const afterOwn = fresh();
    const evidence = own.request?.evidence;
    const rowsOf = (table) => evidence?.handlers.find((h) => h.table === table)?.rows;
    check(
      "P6:shop_redact_empties_only_its_stores_parameters",
      before?.content === true &&
        other.first === "pending|pending" &&
        other.second === "applied|destroyed" &&
        other.request?.status === "completed" &&
        afterOther?.content === true &&
        own.first.startsWith("pending|") &&
        ["destroyed", "already_destroyed"].includes(own.destroyed) &&
        own.second === "applied|destroyed" &&
        own.request?.status === "completed" &&
        afterOwn?.content === false &&
        afterOwn.digest === before.digest &&
        rowsOf("morrow_work.proposal_parameters") >= 2 &&
        evidence?.kind === "shop_redacted" &&
        JSON.stringify(evidence.outstanding) === "[]" &&
        count(
          `SELECT count(*) FROM morrow_identity.store_installations WHERE store_id=${literal(S)} AND status='uninstalled' AND redacted_at IS NOT NULL AND shop_domain LIKE 'redacted-%'`,
        ) === 1 &&
        count(
          `SELECT count(*) FROM morrow_vault.credentials WHERE subject_id=${literal(SI)} AND status='active'`,
        ) === 0,
      { before, other, afterOther, own, afterOwn },
    );
  }

  // Every agents request logged exactly one fixed line.
  check(
    "W1:one_fixed_log_line_per_request",
    consoleLines.length > 0 &&
      consoleLines.every((line) => {
        const r = JSON.parse(line);
        return (
          Object.keys(r).join(",") === "event,route,outcome,correlationId" &&
          r.event === "morrow_agents"
        );
      }),
  );
  return { checks, failures, retries };
}

async function main() {
  const started = Date.now();
  let result;
  phase("engine_and_migrations");
  try {
    await withWorkDatabase(
      "M3.PR1.listings-authority",
      async (db) => {
        result = await runListingsAuthorityLab(db);
      },
      { administrator: "createrole" },
    );
  } catch (error) {
    console.error("LISTINGS_LAB_FAILED_IN:" + stage);
    throw error;
  }
  phase("report");
  writeArtifact("labs/listings-authority.json", {
    task: "M3 PR-1",
    qualification: "local_postgresql17_network_none_listings_authority",
    observedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    administrator: "createrole",
    checks: result.checks,
    unavailableRetries: result.retries,
    providerRequests: 0,
    limitations: [
      "Synthetic owner-seeded fixtures in an isolated local engine; no hosted database, Neon transport, provider or merchant data.",
      "The agents handler runs in Node over a psql connector logged in as morrow_api_worker, not in workerd over the Neon transport.",
      "The store installation (M2 PR-2's tables, read through work_store_installations) and the store-link and model-default grants are owner-seeded; M5 PR-1's billing facts reader runs over fixture facts, since a lease step has no billing read.",
      "Shapes marked sim (a stop inserted with stop_guard disabled, a membership deactivated with its triggers disabled, grant and installation edits as the owner, a store installation moved between unlinked, suspended, uninstalled and back to linked with shopify_record_guard disabled, M2 PR-3's end columns set as its paths set them) stand in for states no API path reaches.",
      "The founder's signup row (organization_signups) is owner-seeded; lab:shopify-install K4 and L16 prove that M2's link issues the store-link template only to the founding principal.",
      "Work envelopes, delegation hops and catalog proposals are owner-inserted; their writers (run admission and the agent submit definer) are M3 PR-2's.",
    ],
  });
  if (result.failures.length) {
    print("FAILED: " + result.failures.join(", "));
    process.exitCode = 1;
  } else print(`PASS: ${result.checks.length} M3 PR-1 listings authority checks.`);
}

await main();
