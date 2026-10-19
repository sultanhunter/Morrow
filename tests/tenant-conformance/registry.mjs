// Tenant-isolation conformance registry (P06.T01a §4.12, ADR-0010 item 2). Every
// object a P06+ migration creates registers here; S1 fails CI on any object that
// is not registered. Routes come from @morrow/work's own table (workRoutes), so
// identity code never imports @morrow/work. P05 tables get probes only, and
// P05.T02a registers them. Connector-context and cross-store probes register later.
import { workRoutes } from "../../packages/work/src/http.ts";

export const workRoles = Object.freeze({
  owner: "morrow_work_owner",
  command: "morrow_work_command",
  api: "morrow_work_api",
  login: "morrow_api_worker",
});

// Table classes: tenant_readable (api role reads, column SELECT), tenant_internal
// (only the command role, through definer functions), platform (no tenant columns,
// no api grants).
export const workTables = Object.freeze({
  goals: { class: "tenant_readable", parents: ["workspace_streams"] },
  tasks: { class: "tenant_readable", parents: ["goals"] },
  questions: { class: "tenant_readable", parents: ["tasks"] },
  question_answers: { class: "tenant_readable", parents: ["questions"] },
  workspace_streams: { class: "tenant_internal", parents: ["morrow_identity.workspaces"] },
  task_assignments: { class: "tenant_internal", parents: ["tasks"] },
  commands: { class: "tenant_internal", parents: ["workspace_streams"] },
  outbox_events: { class: "tenant_internal", parents: ["workspace_streams"] },
  transition_rules: { class: "platform", parents: [] },
  // P06.T01b approval records (migration 0018).
  review_policies: { class: "tenant_readable", parents: ["workspace_streams"] },
  proposal_parameters: { class: "tenant_readable", parents: ["workspace_streams"] },
  proposals: { class: "tenant_readable", parents: ["proposal_parameters", "review_policies"] },
  approvals: { class: "tenant_readable", parents: ["proposals"] },
  approval_decisions: { class: "tenant_readable", parents: ["approvals"] },
  approval_claims: { class: "tenant_internal", parents: ["approvals"] },
  review_capabilities: { class: "platform", parents: [] },
  review_risk_by_effect: { class: "platform", parents: [] },
  review_policy_defaults: { class: "platform", parents: [] },
});

// API functions: SECURITY DEFINER, owned by the command role, EXECUTE for the api
// role only, no organization/workspace/actor parameter (enter_context's digest
// and workspace are resolved through session_eligibility()). current_tenant() is
// the one non-API definer: the read and write policies call it.
export const workFunctions = Object.freeze({
  "current_tenant()": { kind: "resolver", grantees: ["morrow_work_api"] },
  "enter_context(text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    tenantParameters: ["p_workspace"],
  },
  "begin_command(text,text,text)": { kind: "api", grantees: ["morrow_work_api"] },
  "target_member(text)": { kind: "api", grantees: ["morrow_work_api"] },
  "cmd_goal_create(text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "goal.create",
  },
  "cmd_goal_transition(text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "goal.transition",
  },
  "cmd_task_create(text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "task.create",
  },
  "cmd_task_ready(text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "task.ready",
  },
  "cmd_task_assign(text,text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "task.assign",
  },
  "cmd_question_request(text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "question.request",
  },
  "cmd_question_answer(text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "question.answer",
  },
  "cmd_question_cancel(text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "question.cancel",
  },
  // INVOKER helpers, owned by the command role and granted to nobody.
  "command_prelude(text,text)": { kind: "helper", grantees: [] },
  "target_recheck(text,text,text,text)": { kind: "helper", grantees: [] },
  "append_event(text,text,text,text,text,text,text,bigint,text,jsonb,text,timestamp with time zone)":
    { kind: "helper", grantees: [] },
  "record_command(text,text,text,text,text,text,text,text,bigint,jsonb,text,timestamp with time zone)":
    { kind: "helper", grantees: [] },
  // INVOKER triggers, owned by the owner and granted to nobody.
  "enforce_status()": { kind: "trigger", grantees: [] },
  "append_only()": { kind: "trigger", grantees: [] },
  "stream_advance()": { kind: "trigger", grantees: [] },
  // IMMUTABLE row checks: CHECK constraints run with the writer's privileges, so
  // the one runtime writer (the command role) holds EXECUTE and nobody else.
  "valid_scope(jsonb,text,text)": { kind: "check", grantees: ["morrow_work_command"] },
  "valid_criteria(jsonb)": { kind: "check", grantees: ["morrow_work_command"] },
  // P06.T01b (migration 0018). Read definers (deviation 3: they read identity facts
  // as target_member does) and the approval commands.
  "review_context(text,text)": { kind: "api", grantees: ["morrow_work_api"], read: true },
  "review_candidates(text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    read: true,
  },
  "reviewer_snapshot(text,text)": { kind: "api", grantees: ["morrow_work_api"], read: true },
  "begin_approval_command(text,text,text)": { kind: "api", grantees: ["morrow_work_api"] },
  "cmd_proposal_submit(text,text,text,text,text,text,text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "proposal.submit",
  },
  "cmd_approval_decide(text,text,text,text,text,text,text,text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "approval.decide",
  },
  "cmd_approval_withdraw(text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "approval.withdraw",
  },
  // INVOKER helpers granted to nobody; approval_claim is reached only from a
  // consumer's own definer (P05.T01z, P05.T02a), never from the api role.
  "db_now()": { kind: "helper", grantees: [] },
  "command_prelude_exclusive(text,text)": { kind: "helper", grantees: [] },
  "counted_current(text,text,text,text,jsonb,text[],timestamp with time zone)": {
    kind: "helper",
    grantees: [],
  },
  "approval_claim(text,text,text,text,text,text,text,text,text)": {
    kind: "helper",
    grantees: [],
  },
  "policy_bind()": { kind: "trigger", grantees: [] },
  "proposal_bind()": { kind: "trigger", grantees: [] },
  "approval_bind()": { kind: "trigger", grantees: [] },
  "approval_enforce_status()": { kind: "trigger", grantees: [] },
  "decision_bind()": { kind: "trigger", grantees: [] },
  // Pure functions used by CHECK constraints and INVOKER triggers (the writer's
  // privileges), so only the command role holds EXECUTE (the valid_scope pattern).
  "sha256_text(text)": { kind: "check", grantees: ["morrow_work_command"] },
  "utc_text(timestamp with time zone)": { kind: "check", grantees: ["morrow_work_command"] },
  "utc_parse(text)": { kind: "check", grantees: ["morrow_work_command"] },
  "json_int(jsonb,bigint,bigint)": { kind: "check", grantees: ["morrow_work_command"] },
  "json_id(jsonb)": { kind: "check", grantees: ["morrow_work_command"] },
  "valid_review_rule(jsonb,boolean)": { kind: "check", grantees: ["morrow_work_command"] },
  "valid_review_rules(jsonb)": { kind: "check", grantees: ["morrow_work_command"] },
  "effective_rule(jsonb,text,boolean)": { kind: "check", grantees: ["morrow_work_command"] },
  "solo_phrase(jsonb)": { kind: "check", grantees: ["morrow_work_command"] },
  "derived_proposal_id(text,text,text,text,integer[])": {
    kind: "check",
    grantees: ["morrow_work_command"],
  },
  "approval_ref_digest(text,text,text,bigint,text,text,text,timestamp with time zone,timestamp with time zone)":
    { kind: "check", grantees: ["morrow_work_command"] },
  "conflicted(text,text,text[],text)": { kind: "check", grantees: ["morrow_work_command"] },
  "approval_projection(text,timestamp with time zone,bigint,bigint,boolean,text,timestamp with time zone,integer,text,integer,timestamp with time zone,timestamp with time zone)":
    { kind: "check", grantees: ["morrow_work_command"] },
  "policy_document_matches(text,text,text,text,bigint,timestamp with time zone,jsonb)": {
    kind: "check",
    grantees: ["morrow_work_command"],
  },
  "proposal_document_matches(text,text,text,text,text,bigint,text,text,integer[],text,text,text,boolean,text,integer,numeric,text,text,text,text,text[],text,bigint,text,text,text,timestamp with time zone,timestamp with time zone)":
    { kind: "check", grantees: ["morrow_work_command"] },
});
// The identity bridges (0014, 0017): definers owned by the identity owner, EXECUTE
// for the command role only.
export const bridgeFunctions = Object.freeze([
  "work_session_context(text,text)",
  "work_actor_authority(text,text)",
  "work_lock_and_recheck(text,text,text,text,text,text,text)",
  "work_member_authority(text,text,text)",
  // P06.T01b (0017).
  "work_ownership_facts(text)",
  "work_review_candidates(text,text,text,text[],text,integer)",
  "work_reviewer_grants(text,text,text,text[])",
  "work_lock_and_recheck_exclusive(text,text,text,text,text,text,text)",
]);
export const workDomains = Object.freeze(["record_id", "revision", "digest"]);

// Each route's P3 probe: which fixture record supplies its foreign IDs and body.
const probe = (records, body) => Object.freeze({ records, body });
export const workRouteProbes = Object.freeze({
  "GET /goals": probe([], null),
  "POST /goals": probe([], null),
  "GET /goals/:goalId": probe(["goal"], null),
  "POST /goals/:goalId/status": probe(["goal"], { to: "active", expectedRevision: 1 }),
  "GET /tasks": probe(["goal"], null),
  "POST /tasks": probe(["goal"], "task_create"),
  "GET /tasks/:taskId": probe(["task"], null),
  "POST /tasks/:taskId/status": probe(["task"], { to: "ready", expectedRevision: 1 }),
  "POST /tasks/:taskId/assignment": probe(["task"], "assign"),
  "GET /tasks/:taskId/questions": probe(["task"], null),
  "POST /tasks/:taskId/questions": probe(["task"], "question"),
  "GET /questions": probe([], null),
  "GET /questions/:questionId": probe(["question"], null),
  "POST /questions/:questionId/answer": probe(["question"], {
    text: "foreign",
    expectedRevision: 1,
  }),
  "GET /questions/:questionId/answer": probe(["question"], null),
  "POST /questions/:questionId/status": probe(["question"], {
    to: "cancelled",
    expectedRevision: 1,
  }),
});
export const registeredRoutes = Object.freeze(
  workRoutes.map((route) => route.method + " " + route.pattern),
);
export { workRoutes };
