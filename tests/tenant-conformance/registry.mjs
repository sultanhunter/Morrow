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
// no api grants), tenant_or_platform (tenant rows, plus platform rows whose tenant keys
// are both null; readable like tenant_readable, platform rows visible to every tenant).
// `lease: true` adds the lease-context twin of the command policy (tenant_lease, through
// current_lease()); `commandRead: true` (build order PR 7, as in the S7 spec below) makes
// tenant_command FOR SELECT, so no session definer writes the table; `policies` names a
// table's extra, exactly-checked policies.
// `content` classifies what a row may hold (P09.T05a, spine §11): "none" (ids, digests,
// codes and times only), "workspace" (text people write, members in their workspace or
// the operator in platform audit rows; never a store's content) or "store" (a store's
// content, identity or credential): every "store" table, in every schema the registry
// covers (identityTables included), has exactly one cleanup handler in
// packages/work/src/redaction.ts (S8). `commandDelete: "connector_redact"` (M3 PR-2
// integrated with M2 PR-3) marks the one exception to "no runtime DELETE": the command role
// holds DELETE on that store-content table for shop/redact's connector context alone, which
// a RESTRICTIVE FOR DELETE policy (connector_content_delete_only) enforces; S3 and S4 check
// the grant, the restrictive policy and that no other table has either.
export const workTables = Object.freeze({
  goals: { class: "tenant_readable", parents: ["workspace_streams"], content: "workspace" },
  // M3 PR-2 (listings-runs): the run steps read tasks under their lease (tenant_lease_read),
  // and the broker's model_call_begin reads the one parent task it names.
  tasks: {
    class: "tenant_readable",
    parents: ["goals"],
    policies: ["task_broker_model", "tenant_lease_read"],
    content: "workspace",
  },
  questions: { class: "tenant_readable", parents: ["tasks"], content: "workspace" },
  question_answers: { class: "tenant_readable", parents: ["questions"], content: "workspace" },
  // M3 PR-2: the run steps append run and proposal events under their lease.
  workspace_streams: {
    class: "tenant_internal",
    parents: ["morrow_identity.workspaces"],
    lease: true,
    content: "none",
  },
  task_assignments: { class: "tenant_internal", parents: ["tasks"], content: "none" },
  commands: { class: "tenant_internal", parents: ["workspace_streams"], content: "none" },
  outbox_events: {
    class: "tenant_internal",
    parents: ["workspace_streams"],
    lease: true,
    content: "none",
  },
  transition_rules: { class: "platform", parents: [], content: "none" },
  // P06.T01b approval records (migration 0018).
  // M3 PR-2: the agent submit (submit_agent_proposal) writes the approval records under the
  // run's lease (tenant_lease) and reads claims (tenant_lease_read).
  review_policies: {
    class: "tenant_readable",
    parents: ["workspace_streams"],
    lease: true,
    content: "workspace",
  },
  proposal_parameters: {
    class: "tenant_readable",
    parents: ["workspace_streams"],
    // M2 PR-3 (0037): shop/redact empties a store's parameters in the connector's own
    // redaction context (read, and the one change to redacted). v1 PR 3 (catalog-apply): the
    // broker's catalog definers read their operation's tenant (broker_catalog_read).
    policies: ["broker_catalog_read", "connector_redact", "connector_redact_read"],
    lease: true,
    content: "store",
  },
  proposals: {
    class: "tenant_readable",
    parents: ["proposal_parameters", "review_policies"],
    // M2 PR-3 (0037): the connector's redaction context reads its store's proposals. v1 PR 3:
    // the broker's catalog definers read their operation's tenant (broker_catalog_read).
    policies: ["broker_catalog_read", "connector_redact_proposal"],
    lease: true,
    content: "workspace",
  },
  approvals: { class: "tenant_readable", parents: ["proposals"], lease: true, content: "none" },
  approval_decisions: { class: "tenant_readable", parents: ["approvals"], content: "workspace" },
  approval_claims: {
    class: "tenant_internal",
    parents: ["approvals"],
    policies: ["tenant_lease_read"],
    content: "none",
  },
  review_capabilities: { class: "platform", parents: [], content: "none" },
  review_risk_by_effect: { class: "platform", parents: [], content: "none" },
  review_policy_defaults: { class: "platform", parents: [], content: "none" },
  // M2 PR-1 spine foundation (migration 0020; lease_member_revoke from 0023).
  work_leases: {
    class: "tenant_internal",
    parents: ["morrow_identity.workspaces"],
    // M3 PR-1: lease_broker_resolve (the broker's resolve_call reads the one lease it names).
    // M2 PR-3 (0037): connector_lease_read and connector_lease_revoke (a system connection
    // stop set by the connector's applier revokes that connection's leases).
    policies: [
      "connector_lease_read",
      "connector_lease_revoke",
      "lease_broker_resolve",
      "lease_member_revoke",
      "lease_pending",
      "lease_self",
    ],
    content: "none",
  },
  // The entry proof of enter_lease (0020): one row per backend, no tenant keys, reached
  // only by the runtime login's own definers (lease_entry).
  lease_entries: { class: "platform", parents: [], policies: ["lease_entry"], content: "none" },
  stop_controls: {
    class: "tenant_or_platform",
    parents: ["morrow_identity.workspaces"],
    // M3 PR-1: stop_broker_resolve (resolve_call reads its lease's tenant and platform stops).
    // M2 PR-3 (0037): the connector's system connection stop (read, and set; never lifted).
    policies: ["connector_stop_read", "connector_stop_set", "stop_broker_resolve"],
    content: "workspace",
  },
  stop_records: {
    class: "tenant_or_platform",
    parents: ["stop_controls"],
    // M2 PR-3 (0037): the system stop's StopRecord@1 (set only).
    policies: ["connector_stop_record"],
    content: "none",
  },
  operations: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces"],
    lease: true,
    // M5 PR-1 (0029): the broker's own login settles its stripe_write operations. v1 PR 3
    // (catalog-apply): its catalog definers reach the one catalog_write operation their own
    // setting names (broker_catalog) and read their tenant's catalog operations, for the
    // one-open-write-per-product rule (broker_catalog_tenant, FOR SELECT).
    policies: ["broker_catalog", "broker_catalog_tenant", "broker_stripe"],
    content: "none",
  },
  operation_transitions: {
    class: "tenant_readable",
    parents: ["operations"],
    lease: true,
    policies: ["broker_catalog_transition", "broker_stripe_transition"],
    content: "none",
  },
  // v1 PR 3 (catalog-apply): the send fence's record and the read-backs of one catalog_write
  // operation: ids, listing field names, verdict codes and Shopify's own updatedAt text
  // (content-free, 365 days). Only the broker's catalog definers write them
  // (broker_catalog_operation); the session context only reads them (commandRead), and the
  // api reads the read-backs' codes column by column.
  operation_writes: {
    class: "tenant_internal",
    parents: ["operations"],
    commandRead: true,
    policies: ["broker_catalog_operation"],
    content: "none",
  },
  operation_readbacks: {
    class: "tenant_readable",
    parents: ["operations"],
    commandRead: true,
    // Review F2: the broker's catalog definers also read their tenant's read-backs, for the
    // one-open-write-per-product rule (broker_catalog_read, FOR SELECT).
    policies: ["broker_catalog_operation", "broker_catalog_read"],
    content: "none",
  },
  // M3 PR-1 listings authority (migration 0031).
  agent_releases: { class: "platform", parents: [], content: "none" },
  model_catalogue_versions: { class: "platform", parents: [], content: "none" },
  model_catalogue_entries: { class: "platform", parents: [], content: "none" },
  agent_installations: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces", "morrow_identity.agent_principals"],
    lease: true,
    policies: ["installation_broker_resolve"],
    content: "none",
  },
  agent_enable_documents: {
    class: "tenant_internal",
    parents: ["morrow_identity.workspaces"],
    content: "none",
  },
  work_envelopes: {
    class: "tenant_internal",
    parents: ["tasks", "agent_installations"],
    lease: true,
    content: "none",
  },
  delegation_hops: {
    class: "tenant_internal",
    parents: ["tasks", "work_envelopes", "agent_installations", "morrow_identity.agent_principals"],
    lease: true,
    content: "none",
  },
  // The owner's reason for "Stop AI work" and "Disconnect store" is text a person writes.
  kill_switch_records: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces"],
    content: "workspace",
  },
  workspace_model_defaults: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces"],
    content: "none",
  },
  // M3 PR-2 listings runs (migration 0038 listings-runs). The catalogue's per-token rates and
  // provider model ids (platform; the command role reads them, the api never).
  model_catalogue_rates: {
    class: "platform",
    parents: [],
    policies: ["platform_command_read"],
    content: "none",
  },
  // One run, its products, manifest and model calls: ids, digests, codes, counts and times.
  // The session context admits and closes stale runs (tenant_command), the run steps work
  // under the run lease (tenant_lease), and the broker's model definers reach exactly the
  // run they name (broker_model_run, broker_model_run_child, broker_model_call). M2 PR-3's
  // read resolution reads one run and its products' status through run_product_readable
  // (broker_read_run, broker_read_run_product: FOR SELECT, its own setting).
  runs: {
    class: "tenant_readable",
    parents: [
      "morrow_identity.workspaces",
      "tasks",
      "agent_installations",
      "work_envelopes",
      "delegation_hops",
      "work_leases",
      "morrow_billing.billing_accounts",
    ],
    lease: true,
    policies: ["broker_model_run", "broker_read_run"],
    content: "none",
  },
  // A run product names the proposal that packed its draft (content-free), so a run settles
  // from these rows even after shop/redact deleted its drafts.
  run_products: {
    class: "tenant_readable",
    parents: ["runs", "proposals"],
    lease: true,
    policies: ["broker_model_run_child", "broker_read_run_product"],
    content: "none",
  },
  run_manifests: {
    class: "tenant_readable",
    parents: ["runs"],
    lease: true,
    policies: ["broker_model_run_child"],
    content: "none",
  },
  run_model_calls: {
    class: "tenant_readable",
    parents: ["run_products"],
    lease: true,
    policies: ["broker_model_call"],
    content: "none",
  },
  // The product text a run read (content-addressed, 90 days) and the drafts it wrote: store
  // content, each with its cleanup handler (S8): shop/redact deletes a store's rows through
  // morrow_work.store_content_redact in the connector's redaction context
  // (connector_content_read, connector_content_delete and the restrictive
  // connector_content_delete_only).
  product_snapshots: {
    class: "tenant_internal",
    parents: ["morrow_identity.workspaces"],
    lease: true,
    // v1 PR 3: the broker's catalog read-back reads the draft's source snapshot.
    policies: [
      "broker_catalog_read",
      "connector_content_delete",
      "connector_content_delete_only",
      "connector_content_read",
    ],
    commandDelete: "connector_redact",
    content: "store",
  },
  run_drafts: {
    class: "tenant_readable",
    parents: ["run_products", "proposals"],
    lease: true,
    policies: [
      "connector_content_delete",
      "connector_content_delete_only",
      "connector_content_read",
    ],
    commandDelete: "connector_redact",
    content: "store",
  },
  // Build order PR 7 (0043 runtime-operations): the computer's operation ledger (one row per
  // sandbox, tenant-keyed, its run a composite parent), the runtime holds and the platform's
  // caps in use. Ids, digests, codes and times only. They live here, beside run_model_calls,
  // not in morrow_vault, which holds sealed secrets only (lab:spine-foundation V3). The
  // broker's login reaches them only through its four vault definers (broker_runtime: the
  // broker's session user); the operations' session template is read-only
  // (`commandRead: true`, tenant_command FOR SELECT, as on 0029's ledger), so no session
  // definer writes them; only the owner's operator function lifts a hold.
  runtime_operations: {
    class: "tenant_internal",
    parents: ["morrow_identity.workspaces", "runs"],
    policies: ["broker_runtime"],
    commandRead: true,
    content: "none",
  },
  runtime_holds: { class: "platform", parents: [], policies: ["broker_runtime"], content: "none" },
  runtime_capacity: {
    class: "platform",
    parents: [],
    policies: ["broker_runtime"],
    content: "none",
  },
  // PR 18 (0046, ADR-0033 and ADR-0034). A project names its goal record and a title people
  // write; values are numbers, codes and read tags (the work API filters them per viewer);
  // Finish's results are keys and health codes (never a number); a card's revisions and a start
  // document hold text people and Morrow write (titles, steps, "Done when").
  projects: { class: "tenant_readable", parents: ["goals"], content: "workspace" },
  goal_measure_values: { class: "tenant_readable", parents: ["goals"], content: "none" },
  goal_finish_results: { class: "tenant_readable", parents: ["goals"], content: "none" },
  plan_draft_revisions: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces"],
    content: "workspace",
  },
  plan_start_documents: {
    class: "tenant_internal",
    parents: ["morrow_identity.workspaces"],
    content: "workspace",
  },
});

// API functions: SECURITY DEFINER, owned by the command role, EXECUTE for the api
// role only, no organization/workspace/actor parameter (enter_context's digest
// and workspace are resolved through session_eligibility()). current_tenant() and
// current_lease() are the resolvers: the policies call them. Runtime functions (M2
// PR-1) are the same shape for morrow_runtime_executor and take ids only; operator
// functions are INVOKER, owned by the owner and granted to nobody (the owner's
// audited scripts only).
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
  // M2 PR-1 spine foundation (migration 0020). current_lease() is called only by the
  // command role's policies and definers, so no role is granted it. pending_starts() is
  // the one cross-tenant read: content-free, ids only.
  "current_lease()": { kind: "resolver", grantees: [] },
  "enter_lease(text,text)": { kind: "runtime", grantees: ["morrow_runtime_executor"] },
  "pending_starts()": {
    kind: "runtime",
    grantees: ["morrow_runtime_executor"],
    crossTenant: true,
    columns: ["kind", "subject_id", "lease_id", "generation"],
  },
  "lease_mark_started()": { kind: "runtime", grantees: ["morrow_runtime_executor"] },
  // 0023: the membership-removal revocation, called by 0024's identity triggers with the
  // tenant of the membership row they handle.
  "revoke_member_leases(text,text,text)": {
    kind: "bridge_in",
    grantees: ["morrow_identity_owner"],
    tenantParameters: ["p_organization_id", "p_workspace_id", "p_membership_id"],
  },
  "lease_release()": { kind: "runtime", grantees: ["morrow_runtime_executor"] },
  "stop_active(text,text,text,text,text)": { kind: "helper", grantees: [] },
  "lease_open(text,text,text,text,text)": { kind: "helper", grantees: [] },
  "operation_transition(text,text,text,bigint,text,text,text,text,text,text)": {
    kind: "helper",
    grantees: [],
  },
  "lease_guard()": { kind: "trigger", grantees: [] },
  "stop_guard()": { kind: "trigger", grantees: [] },
  "stop_record_bind()": { kind: "trigger", grantees: [] },
  "operation_guard()": { kind: "trigger", grantees: [] },
  "operation_transition_bind()": { kind: "trigger", grantees: [] },
  "platform_stop_set(text,text)": { kind: "operator", grantees: [] },
  "platform_stop_lift(text,text)": { kind: "operator", grantees: [] },
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
  // M3 PR-1 (migrations 0031 and 0032). Pure functions of the CHECKs.
  "listing_fields()": { kind: "check", grantees: ["morrow_work_command"] },
  "store_resource(text,text,text,text)": { kind: "check", grantees: ["morrow_work_command"] },
  "listings_scope(text,text,text,text)": { kind: "check", grantees: ["morrow_work_command"] },
  "installation_scope(text,text,text,text,text)": {
    kind: "check",
    grantees: ["morrow_work_command"],
  },
  "listings_grant_set(text,text,text,text)": { kind: "check", grantees: ["morrow_work_command"] },
  "valid_grant_refs(jsonb,text,text,text)": { kind: "check", grantees: ["morrow_work_command"] },
  "enable_document_matches(text,text,text,text,text,text,text,text,text,bigint,text,text,text,timestamp with time zone,timestamp with time zone)":
    { kind: "check", grantees: ["morrow_work_command"] },
  "kill_switch_record_matches(text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamp with time zone)":
    { kind: "check", grantees: ["morrow_work_command"] },
  "release_manifest_valid(text)": { kind: "check", grantees: ["morrow_work_command"] },
  "catalog_proposal_document_matches(text,text,text,text,text,bigint,text,text,integer[],text,text,text,boolean,text,integer,numeric,text,text,text,text,text[],text,bigint,text,text,text,timestamp with time zone,timestamp with time zone,text,text)":
    { kind: "check", grantees: ["morrow_work_command"] },
  "agent_installation_guard()": { kind: "trigger", grantees: [] },
  "enable_document_guard()": { kind: "trigger", grantees: [] },
  "revocable_guard()": { kind: "trigger", grantees: [] },
  "model_default_guard()": { kind: "trigger", grantees: [] },
  "catalog_proposal_bind()": { kind: "trigger", grantees: [] },
  "parameters_guard()": { kind: "trigger", grantees: [] },
  "claim_parameters_bind()": { kind: "trigger", grantees: [] },
  // Revisable owner helpers: INVOKER, owned by the owner (a later owner migration may
  // replace them), EXECUTE for the command role only. Store-dependent SQL lives here.
  "listings_store_current(text,text,text)": {
    kind: "owner_helper",
    grantees: ["morrow_work_command"],
  },
  "parameters_redact_for_store(text,text,text)": {
    kind: "owner_helper",
    grantees: ["morrow_work_command"],
  },
  // M2 PR-3 (0037): every store-content handler of the work schema, and the run-lease
  // product check (refuses until M3 PR-2's runs exist).
  "store_content_redact(text,text,text)": {
    kind: "owner_helper",
    grantees: ["morrow_work_command"],
  },
  "run_product_readable(text,text,text,text)": {
    kind: "owner_helper",
    grantees: ["morrow_work_command"],
  },
  // M2 PR-3 (0037): the connector login's definers (work_executor_safe): the inbox applier
  // (ids only; the tenant from the broker-recorded row) and the two ids-only re-drives.
  "connector_inbox_apply(text)": { kind: "connector", grantees: ["morrow_connector_ingress"] },
  "connector_inbox_pending()": {
    kind: "connector",
    grantees: ["morrow_connector_ingress"],
    crossTenant: true,
    columns: ["inbox_id"],
  },
  "connector_credentials_pending()": {
    kind: "connector",
    grantees: ["morrow_connector_ingress"],
    crossTenant: true,
    columns: ["installation_id", "reason"],
  },
  // M2 PR-3 review (0037): the cron's privacy deadline check (counts only).
  "connector_privacy_overdue()": {
    kind: "connector",
    grantees: ["morrow_connector_ingress"],
    crossTenant: true,
    columns: ["target_missed", "due_missed"],
  },
  // M2 PR-3 (0037): the catalogue routes' read lease (session only).
  "catalog_read_lease(text,text)": { kind: "api", grantees: ["morrow_work_api"] },
  // The agent commands and their read definer.
  "begin_agent_command(text,text,text)": { kind: "api", grantees: ["morrow_work_api"] },
  "store_association(text)": { kind: "api", grantees: ["morrow_work_api"], read: true },
  "agent_enable_document(text)": { kind: "api", grantees: ["morrow_work_api"], read: true },
  "cmd_listings_enable_document(text,text,text,text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "installation.document",
  },
  "cmd_listings_enable(text,text,text,text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "installation.enable",
  },
  "cmd_stop_ai_work(text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "installation.stop",
  },
  "cmd_model_default_revise(text,text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "model_default.revise",
  },
  // v1 PR 2, "Disconnect store" (disconnect-store-work): the connection commands' replay
  // check, the session tenant's connection target (ids and status) and the disconnect.
  "begin_connection_command(text,text,text)": { kind: "api", grantees: ["morrow_work_api"] },
  "connection_target(text)": { kind: "api", grantees: ["morrow_work_api"], read: true },
  "cmd_store_disconnect(text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "connection.disconnect",
  },
  // The agent kernel's facts under a run lease (ids and grant payloads; the kernel decides).
  "delegation_facts(text,text,text)": { kind: "runtime", grantees: ["morrow_runtime_executor"] },
  // M3 PR-2 listings runs. Pure functions of the CHECKs.
  "listing_field_array()": { kind: "check", grantees: ["morrow_work_command"] },
  "run_fields_valid(text[])": { kind: "check", grantees: ["morrow_work_command"] },
  "route_matches(text,text,text,text,text,text,text,text,text,text[],integer)": {
    kind: "check",
    grantees: ["morrow_work_command"],
  },
  "snapshot_matches(text,text)": { kind: "check", grantees: ["morrow_work_command"] },
  "draft_set_valid(text,text[])": { kind: "check", grantees: ["morrow_work_command"] },
  "draft_flags_valid(jsonb)": { kind: "check", grantees: ["morrow_work_command"] },
  "run_guard()": { kind: "trigger", grantees: [] },
  "run_product_guard()": { kind: "trigger", grantees: [] },
  "run_manifest_guard()": { kind: "trigger", grantees: [] },
  "model_call_guard()": { kind: "trigger", grantees: [] },
  "run_draft_guard()": { kind: "trigger", grantees: [] },
  // Revisable owner helpers the run definers call: the uncertain fence close, the run end
  // (credits, accrual, envelope and hop) and the session's stale-run close.
  "run_fence_close_uncertain(text,text,text)": {
    kind: "owner_helper",
    grantees: ["morrow_work_command"],
  },
  "run_end(text,text,text,text,text,text,text)": {
    kind: "owner_helper",
    grantees: ["morrow_work_command"],
  },
  "runs_close_stale(text,text,text)": { kind: "owner_helper", grantees: ["morrow_work_command"] },
  // Run admission and reconciliation (the api) and the interrupted-run read.
  "begin_run_command(text,text,text)": { kind: "api", grantees: ["morrow_work_api"] },
  "cmd_run_admit(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)":
    { kind: "api", grantees: ["morrow_work_api"], command: "run.admit" },
  "cmd_runs_reconcile(text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "run.reconcile",
  },
  "run_interrupted(text)": { kind: "api", grantees: ["morrow_work_api"], read: true },
  // The run steps under the run lease (ids, digests, codes and canonical documents only).
  "run_start()": { kind: "runtime", grantees: ["morrow_runtime_executor"] },
  "run_billing_facts()": { kind: "runtime", grantees: ["morrow_runtime_executor"] },
  "run_product_begin(text)": { kind: "runtime", grantees: ["morrow_runtime_executor"] },
  "run_snapshot_put(text,text)": { kind: "runtime", grantees: ["morrow_runtime_executor"] },
  "run_product_finish(text,text,text,text,text,text)": {
    kind: "runtime",
    grantees: ["morrow_runtime_executor"],
  },
  "run_drafts_pending()": { kind: "runtime", grantees: ["morrow_runtime_executor"] },
  "run_review_context()": { kind: "runtime", grantees: ["morrow_runtime_executor"] },
  "submit_agent_proposal(text,text,text,text,text,text,text,text,text)": {
    kind: "runtime",
    grantees: ["morrow_runtime_executor"],
  },
  "run_finish(text)": { kind: "runtime", grantees: ["morrow_runtime_executor"] },
  // Build order PR 7 (0043 runtime-operations): the ledger's guard, the caps in code (the
  // command role, inside the broker's vault definers) and the operator's hold lift (nobody).
  "runtime_guard()": { kind: "trigger", grantees: [] },
  // Build order PR 8 (0047 runtime-e2b): any settlement destroys the operation's envd token.
  "runtime_token_end()": { kind: "trigger", grantees: [] },
  "runtime_caps()": { kind: "owner_helper", grantees: ["morrow_work_command"] },
  "runtime_hold_lift(text,text,text)": { kind: "operator", grantees: [] },
  // v1 PR 3 (catalog-review, catalog-apply): the review screen's two reads, the claim and
  // the per-product dispatch check (the api), the pure helpers over a stored proposal and
  // its claimed parameters, and the read-back verdicts' CHECK.
  "catalog_review_sources(text)": { kind: "api", grantees: ["morrow_work_api"], read: true },
  "catalog_claim_of(text)": { kind: "api", grantees: ["morrow_work_api"], read: true },
  "cmd_catalog_apply(text,text,text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "catalog.apply",
  },
  "cmd_catalog_dispatch(text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "catalog.dispatch",
  },
  // Review F2: the claimant sets an uncertain operation aside (uncertain -> cancel_requested).
  "cmd_catalog_set_aside(text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "catalog.set_aside",
  },
  "catalog_target(jsonb,integer)": { kind: "helper", grantees: [] },
  "catalog_item(jsonb,integer)": { kind: "helper", grantees: [] },
  "catalog_item_matches(jsonb,jsonb)": { kind: "helper", grantees: [] },
  "readback_verdicts_valid(jsonb)": { kind: "check", grantees: ["morrow_work_command"] },
  // PR 18 (0046). Pure functions of the CHECKs.
  "goal_time(text)": { kind: "check", grantees: ["morrow_work_command"] },
  "valid_goal_measure(jsonb,timestamp with time zone)": {
    kind: "check",
    grantees: ["morrow_work_command"],
  },
  "valid_goal_criteria(jsonb,timestamp with time zone)": {
    kind: "check",
    grantees: ["morrow_work_command"],
  },
  "valid_project_criteria(jsonb,timestamp with time zone,text)": {
    kind: "check",
    grantees: ["morrow_work_command"],
  },
  "valid_read_tags(jsonb)": { kind: "check", grantees: ["morrow_work_command"] },
  "valid_check_answers(jsonb)": { kind: "check", grantees: ["morrow_work_command"] },
  "goal_kind_guard()": { kind: "trigger", grantees: [] },
  "project_guard()": { kind: "trigger", grantees: [] },
  "plan_draft_guard()": { kind: "trigger", grantees: [] },
  "plan_start_document_guard()": { kind: "trigger", grantees: [] },
  // Revisable owner helpers: the 200-task cap's count (an area or Quick tasks record counts
  // only tasks not ended) and a hand check's read tags (the linked stores' catalogue tag).
  "goal_task_count(text,text,text)": { kind: "owner_helper", grantees: ["morrow_work_command"] },
  "hand_check_read_tags(text,text)": { kind: "owner_helper", grantees: ["morrow_work_command"] },
  // The goal and plan-start commands.
  "begin_project_command(text,text,text)": { kind: "api", grantees: ["morrow_work_api"] },
  "plan_start_document(text)": { kind: "api", grantees: ["morrow_work_api"], read: true },
  "cmd_goal_revise(text,text,text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "goal.revise",
  },
  "cmd_goal_check(text,text,text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "goal.check",
  },
  "cmd_plan_start_document(text,text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "plan.start_document",
  },
  "cmd_plan_start(text,text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
    command: "plan.start",
  },
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
  // M2 PR-1 (0019).
  "work_executor_safe(text)",
  "work_lease_member_current(text,text,text,text)",
  // M2 PR-1 review (0022): the website-signup fact behind route_signup.
  "work_signup_workspace(text,text)",
  // M2 PR-2 (0026): the vault login's identity bridges, called only by 0027's vault
  // definers, and the shared store-installation read for the work and billing definers
  // (M5 PR-1's workspace_associations and checkout precondition call it; 0034 also lets
  // the work owner execute it, for the operator test entitlement's precondition:
  // workOwnerBridges below).
  "work_shopify_install_prepare(text,text,text,text)",
  "work_shopify_install_record(text,text,text,text,text,text,text,text,text,text,text,text)",
  "work_shopify_launch(text,text)",
  "work_shopify_state_claim(text,text)",
  "work_store_installations(text,text)",
  // M3 PR-1 (0030): agent principals, agent grants and the kernel's facts.
  "work_agent_principal_ensure(text,text,text,text,text)",
  "work_agent_grants_issue(text,text,jsonb)",
  "work_owner_disable_grant_issue(text,text,jsonb)",
  "work_agent_grant_set_current(text,text,text,text,jsonb,jsonb)",
  "work_delegation_actor_facts(text,text,jsonb)",
  // M2 PR-3 (0036): the webhook record, the inbox applier's reads and writes, the
  // credential end and the read target, called only by 0037's vault and connector definers.
  "work_shopify_webhook_record(text,text,text,text,text,text)",
  "work_shopify_inbox_take(text)",
  "work_shopify_inbox_settle(text,text,text,jsonb)",
  "work_shopify_inbox_pending()",
  "work_shopify_installation_end(text,text,text,text)",
  "work_shopify_redact_identity(text,text,text)",
  "work_privacy_request_complete(text,text,text,jsonb)",
  "work_privacy_overdue()",
  "work_shopify_credential_end(text,text)",
  "work_shopify_credentials_pending()",
  "work_shopify_read_target(text,text,text,text)",
  // v1 PR 1 (shopify-live-store-identity): the live-store admission, called only by the
  // broker's vault definer of shopify-live-store-vault (ADR-0035 item 2).
  "work_shopify_live_store(text,text)",
  // Shop-specific webhook subscriptions (shopify-webhook-registrations-identity): the
  // registration target, the outcome record and the ids-only pending list, called only by the
  // broker's vault definers of shopify-webhook-registrations-vault.
  "work_shopify_webhook_target(text)",
  "work_shopify_webhook_registration_record(text,text,text,text,text)",
  "work_shopify_webhook_registrations_pending()",
]);
// Identity bridges the work owner executes besides the three ADR-0020 membership helpers
// (0014): the staging test entitlement's operator function (0035) runs as the owner and
// reads the store associations through this one (0034). No other work role gains it.
export const workOwnerBridges = Object.freeze(["work_store_installations(text,text)"]);
// M2 PR-1 (0020): the two schemas the work owner creates beside morrow_work. The billing
// route is tenant-readable with one extra insert policy for the signup bridge; the vault
// is readable only while the session user is the broker's login (vault_broker).
//
// S7 per-table spec (M2 PR-2a). Every billingTables and vaultTables entry carries exactly
// {class, parents, policies, content, commandPrivileges, commandColumnUpdates, apiColumns},
// plus an optional `lease: true` and (M5 PR-1) an optional `commandRead: true`: class,
// parents, policies, content and lease as in workTables (`lease: true` expects tenant_lease,
// the lease-context command policy; `commandRead: true` expects tenant_command FOR SELECT
// instead of FOR ALL, so no session definer writes the table), and the table's whole ACL:
//   commandPrivileges     the table privileges morrow_work_command holds (never DELETE,
//                         TRUNCATE, REFERENCES or TRIGGER);
//   commandColumnUpdates  the columns morrow_work_command may UPDATE (column grants);
//   apiColumns            the columns morrow_work_api may SELECT (column grants).
// Nobody else holds a table or column privilege; S7 compares each list with the catalog.
// Later PRs only add entries, each in its own commented block (// M2 PR-2, // M5 PR-1,
// // M3 PR-1), and widen schemaUsage below; shared lists stay sorted.
const aclSpec = (commandPrivileges, commandColumnUpdates = [], apiColumns = []) => ({
  commandPrivileges,
  commandColumnUpdates,
  apiColumns,
});
// Billing classes beside the shared ones: platform_readable (no tenant columns, read by both
// runtime roles, written only by the owner), ingress (the broker-recorded receipts and
// their applications: nullable tenant keys, reached only through the broker's and the
// receipt ingress's own policies, never the session template) and operator_record (tenant
// keys and composite parents, written only by the owner's operator functions; no runtime
// role holds anything).
export const billingTables = Object.freeze({
  workspace_billing_routes: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces"],
    // M2 PR-2 (0025): route_link_read, the linking rule's one-row read. M5 PR-1 (0029):
    // receipt_apply fixes the route from a verified receipt.
    // M3 PR-2: tenant_lease_read, run_billing_facts under the run lease.
    policies: ["receipt_apply", "route_link_read", "route_signup", "tenant_lease_read"],
    content: "none",
    ...aclSpec(
      ["INSERT", "SELECT"],
      ["fixing_payment_key", "mode", "revision", "route", "route_fixed_at", "updated_at"],
      [
        "created_at",
        "fixing_payment_key",
        "mode",
        "organization_id",
        "origin",
        "revision",
        "route",
        "route_fixed_at",
        "shopify_bound_at",
        "updated_at",
        "workspace_id",
      ],
    ),
  },
  // M5 PR-1 (0029): the M5 billing records.
  billing_terms: {
    class: "platform_readable",
    parents: [],
    policies: ["platform_api_read", "platform_command_read"],
    content: "none",
    ...aclSpec(["SELECT"], [], ["digest", "offers", "recorded_at", "terms", "terms_revision"]),
  },
  // The mapping and the ledger: tenant_command FOR SELECT (commandRead), so no session
  // definer inserts a mapping, an account, a snapshot, a payment, a grant or a wallet; they
  // are written by the broker's definers and in the receipt context only.
  stripe_customers: {
    class: "tenant_internal",
    parents: ["morrow_identity.workspaces", "morrow_work.operations"],
    policies: ["broker_billing"],
    commandRead: true,
    content: "none",
    ...aclSpec(["INSERT", "SELECT"]),
  },
  checkout_intents: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces", "morrow_work.operations"],
    policies: ["broker_billing", "receipt_apply", "tenant_lease_read"],
    content: "none",
    ...aclSpec(
      ["INSERT", "SELECT"],
      ["revision", "status", "stripe_session_id", "updated_at"],
      [
        "actor_membership_id",
        "actor_principal_id",
        "checkout_operation_id",
        "created_at",
        "customer_operation_id",
        "expires_at",
        "id",
        "mode",
        "organization_id",
        "price_key",
        "revision",
        "route_revision",
        "status",
        "terms_revision",
        "updated_at",
        "workspace_id",
      ],
    ),
  },
  // The api reads a Stripe operation's purpose and hold (the billing view's setup hold).
  stripe_operations: {
    class: "tenant_readable",
    parents: ["morrow_billing.checkout_intents", "morrow_work.operations"],
    policies: ["broker_billing", "receipt_apply", "tenant_lease_read"],
    content: "none",
    ...aclSpec(
      ["INSERT", "SELECT"],
      ["held_at", "provider_object_id"],
      [
        "checkout_intent_id",
        "created_at",
        "held_at",
        "operation_id",
        "organization_id",
        "purpose",
        "workspace_id",
      ],
    ),
  },
  // The operator's resolutions of held customer operations (fixed codes, the evidence
  // record's path).
  stripe_operation_resolutions: {
    class: "operator_record",
    parents: ["morrow_billing.stripe_operations"],
    policies: [],
    content: "none",
    ...aclSpec([]),
  },
  stripe_event_receipts: {
    class: "ingress",
    parents: ["morrow_identity.workspaces"],
    policies: ["broker_billing", "receipt_ingress_read"],
    content: "none",
    ...aclSpec(["INSERT", "SELECT"]),
  },
  receipt_applications: {
    class: "ingress",
    parents: ["morrow_billing.stripe_event_receipts"],
    policies: ["receipt_ingress_apply", "receipt_ingress_read"],
    content: "none",
    ...aclSpec(["INSERT", "SELECT"]),
  },
  // The entry proof of receipt_begin: one row per backend, the api login's own only.
  receipt_entries: {
    class: "platform",
    parents: [],
    policies: ["receipt_entry"],
    content: "none",
    ...aclSpec(
      ["INSERT", "SELECT"],
      ["nonce", "receipt_id", "receipt_organization_id", "receipt_workspace_id", "xact_id"],
    ),
  },
  billing_accounts: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces"],
    policies: ["receipt_apply", "tenant_lease_read"],
    commandRead: true,
    content: "none",
    ...aclSpec(
      ["INSERT", "SELECT"],
      ["revision", "status", "updated_at"],
      [
        "created_at",
        "currency",
        "id",
        "mode",
        "organization_id",
        "revision",
        "route",
        "status",
        "updated_at",
        "workspace_id",
      ],
    ),
  },
  entitlement_snapshots: {
    class: "tenant_readable",
    parents: ["morrow_billing.billing_accounts", "morrow_billing.stripe_event_receipts"],
    policies: ["receipt_apply", "tenant_lease_read"],
    commandRead: true,
    content: "none",
    ...aclSpec(
      ["INSERT", "SELECT"],
      [],
      [
        "billing_account_id",
        "mode",
        "organization_id",
        "provider_evidence_ref",
        "recorded_at",
        "revision",
        "route",
        "status",
        "subscription_key",
        "valid_until",
        "verified_at",
        "workspace_id",
      ],
    ),
  },
  verified_payment_events: {
    class: "tenant_readable",
    parents: ["morrow_billing.stripe_event_receipts", "morrow_identity.workspaces"],
    policies: ["receipt_apply", "tenant_lease_read"],
    commandRead: true,
    content: "none",
    ...aclSpec(
      ["INSERT", "SELECT"],
      [],
      [
        "amount",
        "currency",
        "id",
        "kind",
        "mode",
        "operation_id",
        "organization_id",
        "outcome",
        "outcome_code",
        "payment_key",
        "period_end",
        "period_start",
        "price_key",
        "provider_evidence_ref",
        "recorded_at",
        "route",
        "subscription_key",
        "verified_at",
        "workspace_id",
      ],
    ),
  },
  credit_grants: {
    class: "tenant_readable",
    parents: ["morrow_billing.billing_accounts"],
    policies: ["receipt_apply"],
    commandRead: true,
    content: "none",
    ...aclSpec(
      ["INSERT", "SELECT"],
      [],
      [
        "billing_account_id",
        "credit_units",
        "effective_at",
        "expires_at",
        "funded_wallet_revision",
        "id",
        "kind",
        "mode",
        "organization_id",
        "payment_key",
        "purchase_evidence_ref",
        "recorded_at",
        "route",
        "terms_revision",
        "workspace_id",
      ],
    ),
  },
  // The wallet's session UPDATE (tenant_command_update) is for M3 PR-1's moves, which
  // wallet_guard keeps sum-preserving; there is no session INSERT. M3 PR-1 (0033) adds the
  // lease twins of the same two policies, tenant_lease_read (FOR SELECT) and
  // tenant_lease_update (FOR UPDATE): run steps settle under a run lease, and no lease
  // context inserts a wallet either.
  credit_wallets: {
    class: "tenant_readable",
    parents: ["morrow_billing.billing_accounts"],
    policies: [
      "receipt_apply",
      "tenant_command_update",
      "tenant_lease_read",
      "tenant_lease_update",
    ],
    commandRead: true,
    content: "none",
    ...aclSpec(
      ["INSERT", "SELECT"],
      ["available", "consumed", "reserved", "revision", "updated_at"],
      [
        "available",
        "billing_account_id",
        "consumed",
        "created_at",
        "organization_id",
        "rate_revision",
        "reserved",
        "revision",
        "terms_revision",
        "updated_at",
        "workspace_id",
      ],
    ),
  },
  // M3 PR-1 run credits (0033): tenant_command, and tenant_lease for M3 PR-2's run steps.
  credit_reservations: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces", "morrow_billing.credit_wallets"],
    lease: true,
    policies: [],
    content: "none",
    ...aclSpec(
      ["INSERT", "SELECT"],
      ["credits_settled", "revision", "settled_at", "status"],
      [
        "allocation_digest",
        "allocation_id",
        "billing_account_id",
        "catalogue_version",
        "created_at",
        "credits_per_product",
        "credits_reserved",
        "credits_settled",
        "effort_key",
        "id",
        "model_key",
        "organization_id",
        "product_count",
        "revision",
        "root_run_id",
        "settled_at",
        "status",
        "workspace_id",
      ],
    ),
  },
  // M3 PR-2: broker_model_tenant, the broker's model definers book a call's cost in the
  // one tenant they name.
  vendor_cost_reservations: {
    class: "tenant_readable",
    parents: ["morrow_billing.credit_reservations"],
    lease: true,
    policies: ["broker_model_tenant"],
    content: "none",
    ...aclSpec(
      ["INSERT", "SELECT"],
      ["booked_cost_usd", "revision", "status", "unrecovered_cost_usd", "updated_at"],
      [
        "booked_cost_usd",
        "catalogue_version",
        "created_at",
        "created_day",
        "credit_reservation_id",
        "effort_key",
        "id",
        "maximum_cost_usd",
        "model_key",
        "organization_id",
        "period_start",
        "revision",
        "root_run_id",
        "status",
        "unrecovered_cost_usd",
        "updated_at",
        "vendor_id",
        "workspace_id",
      ],
    ),
  },
  // One append-only row per vendor-cost booking, keyed by its entry id (replay, M3 PR-1
  // review).
  run_cost_bookings: {
    class: "tenant_internal",
    parents: ["morrow_billing.vendor_cost_reservations"],
    lease: true,
    policies: ["broker_model_tenant"],
    content: "none",
    ...aclSpec(["INSERT", "SELECT"]),
  },
  unrecovered_costs: {
    class: "tenant_internal",
    parents: ["morrow_identity.workspaces"],
    lease: true,
    policies: ["broker_model_tenant"],
    content: "none",
    ...aclSpec(["INSERT", "SELECT"], ["amount_usd", "revision", "updated_at"]),
  },
  unrecovered_cost_entries: {
    class: "tenant_internal",
    parents: [
      "morrow_billing.unrecovered_costs",
      "morrow_billing.vendor_cost_reservations",
      "morrow_billing.run_cost_bookings",
    ],
    lease: true,
    policies: ["broker_model_tenant"],
    content: "none",
    ...aclSpec(["INSERT", "SELECT"]),
  },
  // The staging test entitlement (0035; ADR-0022 item 5 amendment, 2026-10-21): the
  // platform's environment mark (one row, the owner's seed) and the operator grant record
  // (the owner's operator function only). No runtime role holds anything on either.
  platform_environment: {
    class: "platform",
    parents: [],
    policies: [],
    content: "none",
    ...aclSpec([]),
  },
  operator_test_entitlements: {
    class: "operator_record",
    parents: ["morrow_billing.billing_accounts", "morrow_identity.workspaces"],
    policies: [],
    content: "none",
    ...aclSpec([]),
  },
});
export const billingFunctions = Object.freeze({
  // The signup bridge: the identity owner calls it from 0021's trigger and backfill,
  // with the tenant of the identity row it is handling.
  "record_signup_route(text,text,timestamp with time zone)": {
    kind: "bridge_in",
    grantees: ["morrow_identity_owner"],
    tenantParameters: ["p_organization_id", "p_workspace_id"],
  },
  "route_guard()": { kind: "trigger", grantees: [] },
  // M2 PR-2 (0025): the linking rule's route read (ADR-0022 item 5), called by the
  // identity-owned linking definers with the tenant of the handoff, continuation or
  // session they hold.
  "link_route_current(text,text)": {
    kind: "bridge_in",
    grantees: ["morrow_identity_owner"],
    tenantParameters: ["p_org", "p_ws"],
  },
  // M5 PR-1 (0029). Session definers for the api role (tenant from current_tenant()).
  "workspace_associations()": { kind: "api", grantees: ["morrow_work_api"] },
  "cmd_checkout_open(text,text,text,text,text,text)": {
    kind: "api",
    grantees: ["morrow_work_api"],
  },
  "cmd_portal_open(text,text,text)": { kind: "api", grantees: ["morrow_work_api"] },
  // The receipt-only ingress (ADR-0022 item 9 amendment): the api login with no session
  // context; the tenant only from the broker-recorded receipt.
  "receipt_begin(text,text)": { kind: "ingress", grantees: ["morrow_work_api"] },
  "receipt_apply(text,text,text)": { kind: "ingress", grantees: ["morrow_work_api"] },
  "receipt_status(text)": { kind: "ingress", grantees: ["morrow_work_api"] },
  // The broker's own login (work_executor_safe): ids only.
  "stripe_op_begin(text)": { kind: "broker", grantees: ["morrow_vault_broker"] },
  "stripe_op_settle(text,text,text,text)": { kind: "broker", grantees: ["morrow_vault_broker"] },
  "stripe_receipt_record(text,text,text,text,text,text,text,text,text)": {
    kind: "broker",
    grantees: ["morrow_vault_broker"],
  },
  // The operator path: INVOKER, owned by the owner, granted to nobody.
  "operator_customer_operation_resolve(text,text,text,text,text)": {
    kind: "operator",
    grantees: [],
  },
  // The staging test entitlement (0035): INVOKER, owned by the owner, granted to nobody.
  "operator_test_entitlement_grant(text,text,text,text)": { kind: "operator", grantees: [] },
  // INVOKER helpers the policies and definers evaluate as the command role.
  "receipt_ingress()": { kind: "check", grantees: ["morrow_work_command"] },
  "receipt_entered(text)": { kind: "check", grantees: ["morrow_work_command"] },
  "receipt_tenant(text,text)": { kind: "check", grantees: ["morrow_work_command"] },
  "receipt_object_valid(text,jsonb)": { kind: "check", grantees: ["morrow_work_command"] },
  "terms_guard()": { kind: "trigger", grantees: [] },
  "intent_guard()": { kind: "trigger", grantees: [] },
  "stripe_operation_guard()": { kind: "trigger", grantees: [] },
  "account_guard()": { kind: "trigger", grantees: [] },
  "snapshot_guard()": { kind: "trigger", grantees: [] },
  "wallet_guard()": { kind: "trigger", grantees: [] },
  "grant_guard()": { kind: "trigger", grantees: [] },
  "application_guard()": { kind: "trigger", grantees: [] },
  "route_fix_guard()": { kind: "trigger", grantees: [] },
  // M3 PR-1 run credits (0033): triggers, and the revisable owner helpers
  // that M3 PR-2's admission and run definers call.
  "credit_reservation_guard()": { kind: "trigger", grantees: [] },
  "vendor_reservation_guard()": { kind: "trigger", grantees: [] },
  "unrecovered_guard()": { kind: "trigger", grantees: [] },
  "billing_append_only()": { kind: "trigger", grantees: [] },
  "unrecovered_allows(text,text,timestamp with time zone,integer,numeric)": {
    kind: "owner_helper",
    grantees: ["morrow_work_command"],
  },
  "run_reserve(text,text,text,text,text,text,text,text,integer,text,text,integer,timestamp with time zone)":
    { kind: "owner_helper", grantees: ["morrow_work_command"] },
  "run_book_cost(text,text,text,text,numeric,text)": {
    kind: "owner_helper",
    grantees: ["morrow_work_command"],
  },
  "run_settle(text,text,text,integer)": { kind: "owner_helper", grantees: ["morrow_work_command"] },
  "run_release(text,text,text)": { kind: "owner_helper", grantees: ["morrow_work_command"] },
  // M3 PR-2 (listings-runs): a failed product's attempt bookings accrue as unrecovered.
  "run_product_unrecovered(text,text,text,integer)": {
    kind: "owner_helper",
    grantees: ["morrow_work_command"],
  },
});
export const vaultTables = Object.freeze({
  app_secrets: {
    class: "vault_platform",
    parents: [],
    policies: [],
    content: "none",
    ...aclSpec(["SELECT"]),
  },
  // M2 PR-2 (0027): the first writer. The broker's install definer inserts a version and
  // destroys the active one (the only update vault_guard admits erases the key material).
  credentials: {
    class: "vault_tenant",
    parents: ["morrow_identity.workspaces"],
    policies: [],
    content: "store",
    ...aclSpec(
      ["INSERT", "SELECT"],
      ["destroy_reason", "destroyed_at", "sealed_value", "status", "wrapped_key"],
    ),
  },
});
// S7 (M2 PR-2a): the roles granted USAGE on each schema S7 covers, besides its owner.
// An executor login's USAGE must also equal the schemas of the functions it executes.
export const schemaUsage = Object.freeze({
  // M5 PR-1: the broker's own login runs its three billing definers.
  morrow_billing: [
    "morrow_identity_owner",
    "morrow_vault_broker",
    "morrow_work_api",
    "morrow_work_command",
  ],
  morrow_vault: ["morrow_vault_broker", "morrow_work_command"],
});
export const vaultFunctions = Object.freeze({
  "app_secret_get(text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "app_secret_put(text,text,text,text)": { kind: "operator", grantees: [] },
  "vault_guard()": { kind: "trigger", grantees: [] },
  // M3 PR-1 (0031): the broker's resolver and its revisable credential helper.
  "resolve_call(text,text,text,text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "credential_for_connection(text,text,text)": {
    kind: "owner_helper",
    grantees: ["morrow_work_command"],
  },
  // M2 PR-2 (0027): the Shopify launch and callback definers of the broker's own login.
  "shopify_callback_claim(text,text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "shopify_install_prepare(text,text,text,text)": {
    kind: "vault",
    grantees: ["morrow_vault_broker"],
  },
  "shopify_install_store(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)":
    { kind: "vault", grantees: ["morrow_vault_broker"] },
  "shopify_launch_context(text,text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  // M2 PR-3 (0037): the webhook record, the credential destruction and the read resolution.
  "shopify_credential_destroy(text,text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "shopify_read_resolve(text,text,text,text,text)": {
    kind: "vault",
    grantees: ["morrow_vault_broker"],
  },
  "shopify_webhook_record(text,text,text,text,text,text)": {
    kind: "vault",
    grantees: ["morrow_vault_broker"],
  },
  // v1 PR 1 (shopify-live-store-vault): the live-store admission of an install.
  "shopify_live_store_admission(text,text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  // Shop-specific webhook subscriptions (shopify-webhook-registrations-vault): the pending ids,
  // one installation's target with its token's envelope, and the outcome record.
  "shopify_webhook_registrations_pending()": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "shopify_webhook_target(text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "shopify_webhook_registration_record(text,text,text,text,text)": {
    kind: "vault",
    grantees: ["morrow_vault_broker"],
  },
  // M3 PR-2 (listings-runs): the model gateway's fence open and close (ids, digests, codes
  // and counts only; the broker's login).
  "model_call_begin(text,text,text,text,text,text,text,text)": {
    kind: "vault",
    grantees: ["morrow_vault_broker"],
  },
  "model_call_end(text,text,text,text,text,text,text,text,text,text)": {
    kind: "vault",
    grantees: ["morrow_vault_broker"],
  },
  // Build order PR 7 (0043 runtime-operations): the runtime ledger's send mark, create record,
  // settlement and the sweep's ids-only list (the broker's login). The ledger's tables, guard,
  // caps and hold lift are morrow_work's (workTables, workFunctions).
  "runtime_operation_begin(text,text,text,text,text)": {
    kind: "vault",
    grantees: ["morrow_vault_broker"],
  },
  "runtime_operation_created(text,text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "runtime_operation_settle(text,text,text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "runtime_operations_open(text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  // Build order PR 8 (0047 runtime-e2b): the sandbox's envd token as a vault record, stored
  // once and opened per call by the broker's login (any settlement destroys it, through the
  // runtime_token_end trigger), and the sweep's list with stopped operations (the broker's
  // registry no longer sends 0043's runtime_operations_open).
  "runtime_token_put(text,text,text,text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "runtime_token_get(text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "runtime_operations_sweep(text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  // v1 PR 3 (catalog-apply): the gateway's apply (resolve, fence, close) and read-back
  // (resolve, record), keyed by one operation id, and their revisable INVOKER helpers (the
  // context settings and the send refusal), which only the definers above call.
  "catalog_write_resolve(text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "catalog_write_begin(text,text,text,text,text)": {
    kind: "vault",
    grantees: ["morrow_vault_broker"],
  },
  "catalog_write_end(text,text,text,text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "catalog_reconcile_resolve(text)": { kind: "vault", grantees: ["morrow_vault_broker"] },
  "catalog_reconcile_record(text,text,text,text,text)": {
    kind: "vault",
    grantees: ["morrow_vault_broker"],
  },
  "catalog_context(text,text,text,text,text)": {
    kind: "owner_helper",
    grantees: ["morrow_work_command"],
  },
  "catalog_context_clear()": { kind: "owner_helper", grantees: ["morrow_work_command"] },
  "catalog_send_refusal(text,text)": { kind: "owner_helper", grantees: ["morrow_work_command"] },
});
// M2 PR-1 review (P09.T05a; spine §11): the content class of every morrow_identity table,
// so the store-content cleanup contract (S8, tests/redaction-handlers.test.mjs) covers the
// schema that holds the shop identity and, from M2 PR-2, the store tables of spine §6
// (store_installations, shopify_webhook_inbox, install_continuations, privacy_requests),
// each registered here as it lands. Identity tables keep their P05 RLS shape; only their
// content is classified here. Account identifiers (principals, provider subjects, sessions)
// are "none": they are ids, and the account deletion path (P09.T05, data-lifecycle.md)
// covers them.
export const identityTables = Object.freeze({
  account_enrollments: { content: "none" },
  account_session_commands: { content: "none" },
  // M3 PR-1 (0030): the Coordinator and installation agent principals.
  agent_principals: { content: "none" },
  authentication_bindings: { content: "none" },
  authentication_challenges: { content: "none" },
  authentication_exchange_admissions: { content: "none" },
  authentication_exchange_bindings: { content: "none" },
  authentication_pkce_challenges: { content: "none" },
  browser_session_audits: { content: "none" },
  browser_session_commands: { content: "none" },
  browser_session_families: { content: "none" },
  browser_session_generations: { content: "none" },
  grants: { content: "none" },
  identity_verification_profiles: { content: "none" },
  // M2 PR-2 (0026): continuation and state digests, the app registry (the intended shop as
  // a digest; its install link names the shop) and the installations, whose shop domain
  // and id are shop identity.
  install_continuations: { content: "none" },
  // shop_domain and shop_id (spine §11: shop/redact pseudonymises the domain)
  linking_candidates: { content: "store" },
  // M2 PR-3 (0036): content-free completion evidence of the compliance topics (365 days).
  privacy_requests: { content: "none" },
  linking_handoffs: { content: "none" },
  linking_reviews: { content: "none" },
  login_command_guards: { content: "none" },
  login_controller_configurations: { content: "none" },
  login_flow_events: { content: "none" },
  login_flow_quotas: { content: "none" },
  login_flow_tombstones: { content: "none" },
  login_flows: { content: "none" },
  memberships: { content: "none" },
  migration_administrator: { content: "none" },
  organization_session_signouts: { content: "none" },
  organization_signups: { content: "none" },
  // display names people write
  organizations: { content: "workspace" },
  principals: { content: "none" },
  provider_session_bindings: { content: "none" },
  provider_subject_mappings: { content: "none" },
  provider_subject_profile_bindings: { content: "none" },
  // the operator's reason for an enrollment switch
  self_service_revisions: { content: "workspace" },
  sessions: { content: "none" },
  // the install link names the shop (M2 PR-2 review; retirement and shop/redact clear it)
  shopify_apps: { content: "store" },
  shopify_oauth_states: { content: "none" },
  // M2 PR-3 (0036): the minimised webhook bodies (ids, scope names and a keyed customer
  // digest only, spine §11; 7 days).
  shopify_webhook_inbox: { content: "none" },
  // Shop-specific webhook subscriptions: the broker's last outcome per installation and
  // Shopify's two subscription ids (ids, codes, counts and times only).
  shopify_webhook_registrations: { content: "none" },
  // shop_domain and shop_id (spine §11: shop/redact pseudonymises the domain)
  store_installations: { content: "store" },
  workspace_link_results: { content: "none" },
  workspace_memberships: { content: "none" },
  workspace_revocation_receipts: { content: "none" },
  workspace_revocation_results: { content: "none" },
  workspace_store_links: { content: "none" },
  workspaces: { content: "workspace" },
});
// The three membership-free executor logins (ADR-0022 item 8) and the functions each
// may execute, across every schema.
export const executorLogins = Object.freeze({
  // M2 PR-2 (0026): the connector's one definer, in the identity schema.
  morrow_connector_ingress: [
    "morrow_identity.connector_oauth_state_open(text,text,text)",
    // M2 PR-3 (0037): the inbox applier, the two ids-only re-drives and the privacy
    // deadline check.
    "morrow_work.connector_credentials_pending()",
    "morrow_work.connector_inbox_apply(text)",
    "morrow_work.connector_inbox_pending()",
    "morrow_work.connector_privacy_overdue()",
  ],
  morrow_runtime_executor: [
    "morrow_work.delegation_facts(text,text,text)",
    "morrow_work.enter_lease(text,text)",
    "morrow_work.lease_mark_started()",
    "morrow_work.lease_release()",
    "morrow_work.pending_starts()",
    // M3 PR-2 (listings-runs): the run steps.
    "morrow_work.run_billing_facts()",
    "morrow_work.run_drafts_pending()",
    "morrow_work.run_finish(text)",
    "morrow_work.run_product_begin(text)",
    "morrow_work.run_product_finish(text,text,text,text,text,text)",
    "morrow_work.run_review_context()",
    "morrow_work.run_snapshot_put(text,text)",
    "morrow_work.run_start()",
    "morrow_work.submit_agent_proposal(text,text,text,text,text,text,text,text,text)",
  ],
  morrow_vault_broker: [
    // M5 PR-1 (0029).
    "morrow_billing.stripe_op_begin(text)",
    "morrow_billing.stripe_op_settle(text,text,text,text)",
    "morrow_billing.stripe_receipt_record(text,text,text,text,text,text,text,text,text)",
    "morrow_vault.app_secret_get(text)",
    // M3 PR-1 (0031).
    "morrow_vault.resolve_call(text,text,text,text)",
    // M2 PR-2 (0027).
    "morrow_vault.shopify_callback_claim(text,text)",
    "morrow_vault.shopify_install_prepare(text,text,text,text)",
    "morrow_vault.shopify_install_store(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)",
    "morrow_vault.shopify_launch_context(text,text)",
    // M2 PR-3 (0037).
    "morrow_vault.shopify_credential_destroy(text,text)",
    "morrow_vault.shopify_read_resolve(text,text,text,text,text)",
    "morrow_vault.shopify_webhook_record(text,text,text,text,text,text)",
    // v1 PR 1 (shopify-live-store-vault).
    "morrow_vault.shopify_live_store_admission(text,text)",
    // Shop-specific webhook subscriptions (shopify-webhook-registrations-vault).
    "morrow_vault.shopify_webhook_registration_record(text,text,text,text,text)",
    "morrow_vault.shopify_webhook_registrations_pending()",
    "morrow_vault.shopify_webhook_target(text)",
    // M3 PR-2 (listings-runs).
    "morrow_vault.model_call_begin(text,text,text,text,text,text,text,text)",
    "morrow_vault.model_call_end(text,text,text,text,text,text,text,text,text,text)",
    // Build order PR 7 (0043 runtime-operations).
    "morrow_vault.runtime_operation_begin(text,text,text,text,text)",
    "morrow_vault.runtime_operation_created(text,text)",
    "morrow_vault.runtime_operation_settle(text,text,text)",
    "morrow_vault.runtime_operations_open(text)",
    // Build order PR 8 (0047 runtime-e2b).
    "morrow_vault.runtime_operations_sweep(text)",
    "morrow_vault.runtime_token_get(text)",
    "morrow_vault.runtime_token_put(text,text,text,text)",
    // v1 PR 3 (catalog-apply).
    "morrow_vault.catalog_reconcile_record(text,text,text,text,text)",
    "morrow_vault.catalog_reconcile_resolve(text)",
    "morrow_vault.catalog_write_begin(text,text,text,text,text)",
    "morrow_vault.catalog_write_end(text,text,text,text)",
    "morrow_vault.catalog_write_resolve(text)",
  ],
});
export const workDomains = Object.freeze(["record_id", "revision", "digest"]);
// Non-tenant schemas outside the manifest. The staging runner's ledger (ADR-0019 item 12)
// is tooling metadata owned by the migration administrator, with no access for PUBLIC or
// any Morrow role; lab:staging-runner asserts that. It holds no tenant column or row.
export const excludedSchemas = Object.freeze({
  morrow_migrations:
    "staging runner ledger (ADR-0019 item 12); administrator-owned tooling metadata",
});

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
