// P06.T01a unit tests: digests, strict bodies, the vocabulary contract check,
// permissions through createHumanPolicyService, outcome→HTTP mapping, the
// transaction protocol and the Neon connector's lease hygiene. No I/O.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateDefinition } from "../packages/contracts/src/validation.ts";
import {
  workAggregateReads,
  workEligibility,
  workMetadataFields,
  workPermissions,
  workVerb,
} from "../packages/contracts/src/work-permissions.ts";
import {
  answerTextSchema,
  answerTextSchemaDigest,
  canonicalJson,
  workRequestDigest,
} from "../packages/work/src/digest.ts";
import {
  containsNul,
  parseGoalCreate,
  parseGoalTransition,
  parseQuestionAnswer,
  parseQuestionCancel,
  parseQuestionRequest,
  parseTaskAssign,
  parseTaskCreate,
  parseTaskReady,
  workText,
} from "../packages/work/src/http-bodies.ts";
import { authorizeWork, decideWork } from "../packages/work/src/permissions.ts";
import {
  WorkOutcomeUnknown,
  WorkReject,
  WorkSqlUnavailable,
  withWorkTransaction,
} from "../packages/work/src/connection.ts";
import { workStatements } from "../packages/work/src/sql.ts";
import { workErrorResponse, workRoutes } from "../packages/work/src/http.ts";
import { decodeCursor, encodeCursor } from "../packages/work/src/contract-mapping.ts";
import { neonWorkConnectorWithDriver } from "../packages/work/src/neon-connector.ts";
import { neonLeaseNamespace } from "../packages/identity/src/broker-protocol.ts";
import { enterWorkContext } from "../packages/work/src/context.ts";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const catalogue = JSON.parse(readFileSync("docs/contracts/capabilities.json", "utf8"));
const core = JSON.parse(readFileSync("docs/contracts/schemas/v1/core.schema.json", "utf8"));
const W = {
  organizationId: "org_o",
  workspaceId: "ws_w",
  storeId: null,
  connectionId: null,
  kind: "workspace",
  id: "ws_w",
};
const actor = (principalId = "person_a", membershipId = "membership_a") => ({
  kind: "human",
  principalId,
  organizationId: "org_o",
  workspaceId: "ws_w",
  membershipId,
  installationId: null,
  mandateId: null,
});
function grant(capabilityId, verbs, fields, overrides = {}) {
  return {
    id: "grant_" + capabilityId.replaceAll(".", "_") + "_" + verbs.join("_"),
    principal: actor(),
    capabilityId,
    verbs,
    scope: {
      organizationId: "org_o",
      workspaceId: "ws_w",
      storeIds: [],
      accountIds: [],
      resources: [W],
      fields,
    },
    issuedBy: actor(),
    validFrom: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    policyRevision: 1,
    ...overrides,
  };
}
const authority = (grants) => ({
  actor: actor(),
  policyRevision: 1,
  grants,
  databaseNowMs: Date.parse("2026-10-18T12:00:00.000Z"),
  resource: W,
});

test("digest: canonical JSON sorts keys at every depth, so reordered bodies replay", async () => {
  assert.equal(
    canonicalJson({ b: 1, a: [{ d: null, c: "x" }] }),
    '{"a":[{"c":"x","d":null}],"b":1}',
  );
  assert.throws(() => canonicalJson({ a: undefined }), /CANONICAL/);
  assert.throws(() => canonicalJson(Number.NaN), /CANONICAL/);
  assert.throws(() => canonicalJson(new Date(0)), /CANONICAL/);
  const body = {
    objective: "Grow",
    storeIds: [],
    successCriteria: [
      { description: "d", verificationCapabilityId: null, evidenceRequired: false },
    ],
  };
  const reordered = JSON.parse(
    '{"successCriteria":[{"evidenceRequired":false,"description":"d","verificationCapabilityId":null}],"storeIds":[],"objective":"Grow"}',
  );
  const a = await workRequestDigest("goal.create", "ws_w", [], body);
  assert.equal(a, await workRequestDigest("goal.create", "ws_w", [], reordered));
  // Independent vector: sha256 of the documented transcript.
  assert.equal(
    a,
    sha(
      '["morrow.work.command",1,"goal.create","ws_w",[],{"objective":"Grow","storeIds":[],"successCriteria":[{"description":"d","evidenceRequired":false,"verificationCapabilityId":null}]}]',
    ),
  );
  for (const other of [
    workRequestDigest("goal.transition", "ws_w", [], body),
    workRequestDigest("goal.create", "ws_w2", [], body),
    workRequestDigest("goal.create", "ws_w", ["g"], body),
    workRequestDigest("goal.create", "ws_w", [], { ...body, objective: "Grow!" }),
  ])
    assert.notEqual(await other, a);
  assert.equal(answerTextSchemaDigest, sha(canonicalJson(answerTextSchema)));
});

test("bodies: closed records, limits, no tenant keys and no NUL", () => {
  const criteria = [
    { description: "d", verificationCapabilityId: "catalog.products.read", evidenceRequired: true },
  ];
  assert.ok(parseGoalCreate({ objective: "o", storeIds: [], successCriteria: criteria }));
  for (const bad of [
    { objective: "o", storeIds: [], successCriteria: criteria, organizationId: "org_o" },
    { objective: "o", storeIds: [], successCriteria: criteria, workspaceId: "ws_w" },
    { objective: "o", storeIds: [], successCriteria: criteria, principalId: "p" },
    { objective: "", storeIds: [], successCriteria: criteria },
    { objective: "x".repeat(8193), storeIds: [], successCriteria: criteria },
    { objective: "a\0b", storeIds: [], successCriteria: criteria },
    { objective: "o", storeIds: [], successCriteria: [] },
    { objective: "o", storeIds: [], successCriteria: Array(21).fill(criteria[0]) },
    { objective: "o", storeIds: [], successCriteria: [{ ...criteria[0], extra: 1 }] },
    { objective: "o", successCriteria: criteria },
  ])
    assert.equal(parseGoalCreate(bad), null, JSON.stringify(bad).slice(0, 80));
  assert.equal(workText("😀".repeat(8192)), true);
  assert.equal(workText("😀".repeat(8193)), false);
  assert.ok(parseTaskCreate({ goalId: "g", objective: "o", allowedResources: [W] }));
  assert.equal(parseTaskCreate({ goalId: "g", objective: "o", allowedResources: [W, W] }), null);
  assert.equal(
    parseTaskCreate({ goalId: "g", objective: "o", allowedResources: [{ ...W, id: undefined }] }),
    null,
  );
  assert.deepEqual(parseGoalTransition({ to: "active", expectedRevision: 1 }), {
    to: "active",
    expectedRevision: 1,
  });
  assert.equal(parseGoalTransition({ to: "active", expectedRevision: 0 }), null);
  assert.equal(parseGoalTransition({ to: "done", expectedRevision: 1 }), null);
  assert.equal(parseTaskReady({ to: "queued", expectedRevision: 1 }), null);
  assert.equal(parseTaskAssign({ assigneeId: "p", expectedRevision: 2 ** 53 }), null);
  assert.equal(parseQuestionRequest({ question: "q", respondentId: "bad id" }), null);
  assert.equal(parseQuestionAnswer({ text: "t", expectedRevision: 1, answer: {} }), null);
  assert.equal(parseQuestionCancel({ to: "expired", expectedRevision: 1 }), null);
  assert.equal(containsNul({ a: ["x", { b: "\0" }] }), true);
  assert.equal(containsNul({ a: ["x", { b: "y" }] }), false);
});

test("vocabulary: catalogue capabilities, FieldPaths and reads that request every field they return", () => {
  const capabilities = new Map(catalogue.capabilities.map((c) => [c.id, c]));
  for (const [key, rule] of Object.entries(workPermissions)) {
    const capability = capabilities.get(rule.capabilityId);
    assert.ok(capability, key);
    assert.ok(!capability.eligible_principal.startsWith("operator_"), key);
    assert.equal(capability.effect, "internal_write", key);
    assert.equal(capability.review_required, false, key);
    assert.ok(rule.fields.length > 0, key);
    for (const field of rule.fields)
      assert.ok(validateDefinition("core", "FieldPath", field), key + " " + field);
    assert.equal(new Set(rule.fields).size, rule.fields.length, key);
  }
  // The catalogue's spaced field_scope strings are not FieldPaths.
  assert.ok(!validateDefinition("core", "FieldPath", "answer schema"));
  for (const [record, key] of Object.entries(workAggregateReads)) {
    const definition = core.$defs[record[0].toUpperCase() + record.slice(1)];
    const returned = Object.keys(definition.properties).filter(
      (p) => !workMetadataFields.includes(p),
    );
    assert.deepEqual([...workPermissions[key].fields].sort(), returned.sort(), record);
    assert.ok(workPermissions[key].fields.includes("status"));
  }
  assert.deepEqual(workEligibility, {
    assignee: ["task.read"],
    respondent: ["question.answer", "question.read"],
  });
  assert.equal(workVerb("goal.transition", "own"), "execute");
  assert.equal(workVerb("goal.transition", "other"), "administer");
  assert.equal(workVerb("goal.transition", "none"), null);
  assert.equal(workVerb("question.answer", "other"), "execute");
  assert.ok(workPermissions["question.answer"].respondentOnly);
  // Every route names a vocabulary key.
  for (const route of workRoutes) assert.ok(Object.hasOwn(workPermissions, route.permission));
});

test("permissions: the policy kernel decides, ownership selects the verb, fields are all-or-nothing", async () => {
  const all = ["view", "execute", "administer"];
  const taskFields = [...workPermissions["task.read"].fields, "allowedResources"];
  const owner = authority([grant("workspace.task.create", ["view", "execute"], taskFields)]);
  assert.equal((await authorizeWork(owner, "task.ready", "own")).allowed, true);
  const other = await authorizeWork(owner, "task.ready", "other");
  assert.equal(other.allowed, false);
  assert.equal(other.reason, "capability_denied");
  const admin = authority([grant("workspace.task.create", ["view", "administer"], taskFields)]);
  assert.equal((await authorizeWork(admin, "task.ready", "other")).allowed, true);
  const goalFields = workPermissions["goal.read"].fields.filter((f) => f !== "successCriteria");
  const v2 = authority([grant("workspace.goal.create", ["view"], goalFields)]);
  const read = await decideWork(
    v2,
    "workspace.goal.create",
    "view",
    workPermissions["goal.read"].fields,
  );
  assert.equal(read.reason, "field_denied");
  // The database clock of the snapshot decides expiry.
  const expiring = authority([
    grant("workspace.goal.create", all, workPermissions["goal.read"].fields, {
      expiresAt: "2026-10-18T12:00:00.000Z",
    }),
  ]);
  assert.equal(
    (await decideWork(expiring, "workspace.goal.create", "view", ["status"])).allowed,
    false,
  );
  const foreign = authority([
    grant("workspace.goal.create", all, ["status"], {
      scope: {
        organizationId: "org_o",
        workspaceId: "ws_w",
        storeIds: [],
        accountIds: [],
        resources: [{ ...W, id: "ws_w2", workspaceId: "ws_w2" }],
        fields: ["status"],
      },
    }),
  ]);
  assert.equal(
    (await decideWork(foreign, "workspace.goal.create", "view", ["status"])).reason,
    "scope_denied",
  );
  await assert.rejects(authorizeWork(owner, "task.ready", "none"), /BASIS/);
});

test("errors: each outcome maps to one fixed, valid ErrorEnvelope", async () => {
  const expected = {
    unauthenticated: [401, "denied", "never"],
    invalid: [400, "missing_input", "never"],
    guard_denied: [403, "denied", "never"],
    denied: [403, "denied", "never"],
    field_denied: [403, "denied", "never"],
    grant_overflow: [403, "denied", "never"],
    not_found: [404, "denied", "never"],
    revision_conflict: [409, "conflict", "recheck_before_retry"],
    state_conflict: [409, "conflict", "recheck_before_retry"],
    guard_failed: [409, "conflict", "recheck_before_retry"],
    stale_authority: [409, "conflict", "recheck_before_retry"],
    command_conflict: [409, "conflict", "never"],
    target_ineligible: [409, "conflict", "never"],
    limit_reached: [409, "conflict", "never"],
    unavailable: [503, "unavailable", "recheck_before_retry"],
    unavailable_read: [503, "unavailable", "safe_read_retry"],
    uncertain: [503, "uncertain", "reconcile_before_retry"],
  };
  for (const [kind, [status, code, retryClass]] of Object.entries(expected)) {
    const response = workErrorResponse(kind, "corr_1");
    const body = await response.json();
    assert.equal(response.status, status, kind);
    assert.equal(body.code, code, kind);
    assert.equal(body.retryClass, retryClass, kind);
    assert.ok(validateDefinition("core", "ErrorEnvelope", body), kind);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(response.headers.has("access-control-allow-origin"), false);
  }
  const a = await workErrorResponse("not_found", "corr_a").text();
  const b = await workErrorResponse("not_found", "corr_b").text();
  assert.equal(a.replace("corr_a", "x"), b.replace("corr_b", "x"));
  const allow = workErrorResponse("method_not_allowed", "c", "GET, POST");
  assert.equal(allow.status, 405);
  assert.equal(allow.headers.get("allow"), "GET, POST");
});

test("transition_rules: migration 0015 persists exactly the v1 goal, task and question rows", () => {
  const json = JSON.parse(readFileSync("docs/contracts/state-transitions.json", "utf8"));
  const sql = readFileSync("migrations/0015.work-state.sql", "utf8");
  const block =
    /INSERT INTO morrow_work\.transition_rules\(machine,from_status,to_status,actor,guard\) VALUES([\s\S]*?);\n/.exec(
      sql,
    )[1];
  const persisted = [
    ...block.matchAll(/\('([a-z_]+)','([a-z_]+)','([a-z_]+)','([a-z_]+)','([a-z_]+)'\)/g),
  ].map((m) => m.slice(1).join("|"));
  const v1 = ["goal", "task", "question"].flatMap((machine) =>
    json.transitions[machine]
      .filter((r) => r.since === undefined)
      .map((r) => [machine, r.from, r.to, r.actor, r.guard].join("|")),
  );
  assert.deepEqual(persisted.sort(), v1.sort());
  assert.deepEqual(
    [json.transitions.goal, json.transitions.task, json.transitions.question].map(
      (rows) => rows.filter((r) => r.since === undefined).length,
    ),
    [7, 20, 3],
  );
  // The v1.1 task cancel rows are persisted by a later P06 migration (ADR-0010 item 5).
  assert.deepEqual(
    json.transitions.task.filter((r) => r.since === "1.1").map((r) => r.from + ">" + r.to),
    ["draft>cancelled", "ready>cancelled"],
  );
});

function fakeConnection(script) {
  const sent = [];
  return {
    sent,
    async query(text, values) {
      sent.push(text);
      const step = script(text, values, sent.length);
      if (step instanceof Error) throw step;
      return { rows: step ?? [] };
    },
    async close() {},
  };
}
const options = () => ({
  readOnly: false,
  deadlineMs: Date.now() + 5000,
  signal: new AbortController().signal,
});

test("transactions: prologue, commit, rollback-only, and unknown only after submission", async () => {
  const ok = fakeConnection(() => []);
  assert.equal(
    await withWorkTransaction(
      ok,
      options(),
      async (tx) => (await tx.run("goalTarget", ["g"]), "done"),
    ),
    "done",
  );
  assert.deepEqual(ok.sent, [
    workStatements.prologueReadWrite,
    workStatements.goalTarget,
    "COMMIT",
  ]);
  const decided = fakeConnection(() => []);
  await assert.rejects(
    withWorkTransaction(decided, options(), async () => {
      throw new WorkReject("not_found");
    }),
    WorkReject,
  );
  assert.deepEqual(decided.sent.at(-1), "ROLLBACK");
  const rollbackOnly = fakeConnection(() => []);
  await withWorkTransaction(rollbackOnly, options(), async (tx) => {
    tx.markSubmitted();
    await tx.run("cmdGoalCreate", ["a", "b", "c", "d", "e"]);
    tx.rollbackOnly();
  });
  assert.equal(rollbackOnly.sent.at(-1), "ROLLBACK");
  const lostBefore = fakeConnection((text) =>
    text === workStatements.enterContext ? Error("x") : [],
  );
  await assert.rejects(
    withWorkTransaction(lostBefore, options(), (tx) => tx.run("enterContext", ["a", "b"])),
    WorkSqlUnavailable,
  );
  const lostCommand = fakeConnection((text) =>
    text === workStatements.cmdGoalCreate ? Error("x") : [],
  );
  await assert.rejects(
    withWorkTransaction(lostCommand, options(), async (tx) => {
      tx.markSubmitted();
      return tx.run("cmdGoalCreate", ["a", "b", "c", "d", "e"]);
    }),
    WorkOutcomeUnknown,
  );
  const lostCommit = fakeConnection((text) => (text === "COMMIT" ? Error("x") : []));
  await assert.rejects(
    withWorkTransaction(lostCommit, options(), async (tx) => {
      tx.markSubmitted();
      return tx.run("cmdGoalCreate", ["a", "b", "c", "d", "e"]);
    }),
    WorkOutcomeUnknown,
  );
  const readCommit = fakeConnection((text) => (text === "COMMIT" ? Error("x") : []));
  await assert.rejects(
    withWorkTransaction(readCommit, { ...options(), readOnly: true }, async () => 1),
    WorkSqlUnavailable,
  );
  const nul = fakeConnection(() => []);
  await assert.rejects(
    withWorkTransaction(nul, options(), (tx) => tx.run("goalTarget", ["a\0"])),
    WorkSqlUnavailable,
  );
  const late = fakeConnection(() => []);
  await assert.rejects(
    withWorkTransaction(late, { ...options(), deadlineMs: Date.now() - 1 }, async () => 1),
    WorkSqlUnavailable,
  );
  assert.deepEqual(late.sent, []);
});

test("context: enter_context rows decode strictly; 1001 grants overflow", async () => {
  const g = grant("workspace.goal.create", ["view"], ["status"]);
  const row = (overrides = {}) => ({
    principal_id: "person_a",
    organization_id: "org_o",
    workspace_id: "ws_w",
    membership_id: "membership_a",
    policy_revision: "3",
    grants: JSON.stringify([g]),
    grant_count: "1",
    grants_digest: "a".repeat(64),
    database_now_us: "1760788800123456",
    ...overrides,
  });
  const tx = (rows) => ({ run: async () => rows, markSubmitted() {}, rollbackOnly() {} });
  const a = await enterWorkContext(tx([row()]), "b".repeat(64), "ws_w");
  assert.equal(a.policyRevision, 3);
  assert.equal(a.databaseNowMs, 1760788800123);
  assert.deepEqual(a.resource, W);
  assert.equal(await enterWorkContext(tx([]), "b".repeat(64), "ws_w"), "ineligible");
  assert.equal(
    await enterWorkContext(
      tx([row({ grant_count: "1001", grants: "[]" })]),
      "b".repeat(64),
      "ws_w",
    ),
    "grant_overflow",
  );
  assert.equal(await enterWorkContext(tx([row()]), "not-a-digest", "ws_w"), "ineligible");
  await assert.rejects(
    enterWorkContext(tx([row({ workspace_id: "ws_w2" })]), "b".repeat(64), "ws_w"),
  );
  await assert.rejects(
    enterWorkContext(
      tx([row({ grants: JSON.stringify([{ ...g, verbs: [] }]) })]),
      "b".repeat(64),
      "ws_w",
    ),
  );
  await assert.rejects(enterWorkContext(tx([row(), row()]), "b".repeat(64), "ws_w"));
});

test("cursors are opaque, round-trip and reject anything else", () => {
  const cursor = encodeCursor({ cursor_us: "1760788800123456", id: "goal_1" });
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(cursor), ["1760788800123456", "goal_1"]);
  for (const bad of [
    "",
    "!!",
    Buffer.from('["x","goal"]').toString("base64url"),
    Buffer.from('["1","bad id"]').toString("base64url"),
  ])
    assert.equal(decodeCursor(bad), null);
});

test("Neon connector: per-request lease, deadline min(request, lease), revocation, release via waitUntil, no password in errors", async () => {
  const binding = {
    schemaVersion: 1,
    environment: "staging",
    projectId: "morrow-unit",
    branchId: "br-unit",
    hostname: "ep-unit.c-14.us-east-1.aws.neon.tech",
    database: "morrow",
  };
  const password = "Unit-password-" + "x".repeat(20);
  const events = [];
  let revoke;
  const broker = {
    async borrow(namespaceJson, control) {
      events.push(["borrow", namespaceJson, control.deadlineMs]);
      const controller = new AbortController();
      revoke = () => controller.abort();
      return {
        namespaceJson,
        password,
        expiresAtMs: Date.now() + 1000,
        revocationSignal: controller.signal,
        release: async () => void events.push(["release"]),
      };
    },
  };
  const configs = [];
  let closed = 0,
    pendingQuery;
  const driver = (config) => {
    configs.push(config);
    return {
      async connect() {},
      query(text) {
        if (text === "hang") return (pendingQuery = new Promise(() => {}));
        return Promise.resolve({ rows: [{ ok: "1" }] });
      },
      async end() {
        closed++;
      },
      on() {},
    };
  };
  const connector = neonWorkConnectorWithDriver(binding, broker, driver);
  const waited = [];
  const connection = await connector.open({
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 5000,
    waitUntil: (p) => waited.push(p),
  });
  assert.equal(events[0][1], neonLeaseNamespace(binding, "morrow_api_worker"));
  assert.equal(JSON.parse(events[0][1]).purpose, "work_request_transaction");
  assert.equal(configs[0].user, "morrow_api_worker");
  assert.equal(configs[0].password, password);
  assert.ok(configs[0].connectTimeoutMs <= 1000, "deadline is min(request, lease)");
  assert.deepEqual((await connection.query("SELECT 1", [], new AbortController().signal)).rows, [
    { ok: "1" },
  ]);
  // A lease revocation after the send aborts the pending query with a fixed error.
  const hung = connection.query("hang", [], new AbortController().signal);
  revoke();
  await assert.rejects(
    hung,
    (error) => error.message === "WORK_SQL_UNAVAILABLE" && !String(error.stack).includes(password),
  );
  void pendingQuery;
  await connection.close();
  await Promise.all(waited);
  assert.equal(closed, 1);
  assert.deepEqual(events.at(-1), ["release"]);
  assert.equal(waited.length, 1);
  // A lease whose namespace differs is refused and nothing connects.
  const wrong = neonWorkConnectorWithDriver(
    binding,
    {
      borrow: async () => ({
        namespaceJson: "{}",
        password,
        expiresAtMs: Date.now() + 1000,
        revocationSignal: new AbortController().signal,
        release: async () => {},
      }),
    },
    driver,
  );
  await assert.rejects(
    wrong.open({
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5000,
      waitUntil() {},
    }),
    /WORK_SQL_UNAVAILABLE/,
  );
  assert.equal(configs.length, 1);
  // A broker failure never echoes anything.
  const failing = neonWorkConnectorWithDriver(
    binding,
    {
      borrow: async () => {
        throw Error(password);
      },
    },
    driver,
  );
  await assert.rejects(
    failing.open({
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5000,
      waitUntil() {},
    }),
    (e) => !e.message.includes(password),
  );
  assert.throws(
    () => neonWorkConnectorWithDriver({ ...binding, hostname: "evil.example.com" }, broker, driver),
    /CONFIGURATION_INVALID/,
  );
});
