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
// current_lease()); `policies` names a table's extra, exactly-checked policies.
// `content` classifies what a row may hold (P09.T05a, spine §11): "none" (ids, digests,
// codes and times only), "workspace" (text people write, members in their workspace or
// the operator in platform audit rows; never a store's content) or "store" (a store's
// content, identity or credential): every "store" table, in every schema the registry
// covers (identityTables included), has exactly one cleanup handler in
// packages/work/src/redaction.ts (S8).
export const workTables = Object.freeze({
  goals: { class: "tenant_readable", parents: ["workspace_streams"], content: "workspace" },
  tasks: { class: "tenant_readable", parents: ["goals"], content: "workspace" },
  questions: { class: "tenant_readable", parents: ["tasks"], content: "workspace" },
  question_answers: { class: "tenant_readable", parents: ["questions"], content: "workspace" },
  workspace_streams: {
    class: "tenant_internal",
    parents: ["morrow_identity.workspaces"],
    content: "none",
  },
  task_assignments: { class: "tenant_internal", parents: ["tasks"], content: "none" },
  commands: { class: "tenant_internal", parents: ["workspace_streams"], content: "none" },
  outbox_events: { class: "tenant_internal", parents: ["workspace_streams"], content: "none" },
  transition_rules: { class: "platform", parents: [], content: "none" },
  // P06.T01b approval records (migration 0018).
  review_policies: {
    class: "tenant_readable",
    parents: ["workspace_streams"],
    content: "workspace",
  },
  proposal_parameters: {
    class: "tenant_readable",
    parents: ["workspace_streams"],
    content: "store",
  },
  proposals: {
    class: "tenant_readable",
    parents: ["proposal_parameters", "review_policies"],
    content: "workspace",
  },
  approvals: { class: "tenant_readable", parents: ["proposals"], content: "none" },
  approval_decisions: { class: "tenant_readable", parents: ["approvals"], content: "workspace" },
  approval_claims: { class: "tenant_internal", parents: ["approvals"], content: "none" },
  review_capabilities: { class: "platform", parents: [], content: "none" },
  review_risk_by_effect: { class: "platform", parents: [], content: "none" },
  review_policy_defaults: { class: "platform", parents: [], content: "none" },
  // M2 PR-1 spine foundation (migration 0020; lease_member_revoke from 0023).
  work_leases: {
    class: "tenant_internal",
    parents: ["morrow_identity.workspaces"],
    policies: ["lease_member_revoke", "lease_pending", "lease_self"],
    content: "none",
  },
  // The entry proof of enter_lease (0020): one row per backend, no tenant keys, reached
  // only by the runtime login's own definers (lease_entry).
  lease_entries: { class: "platform", parents: [], policies: ["lease_entry"], content: "none" },
  stop_controls: {
    class: "tenant_or_platform",
    parents: ["morrow_identity.workspaces"],
    content: "workspace",
  },
  stop_records: { class: "tenant_or_platform", parents: ["stop_controls"], content: "none" },
  operations: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces"],
    lease: true,
    // M5 PR-1 (0027): the broker's own login settles its stripe_write operations.
    policies: ["broker_stripe"],
    content: "none",
  },
  operation_transitions: {
    class: "tenant_readable",
    parents: ["operations"],
    lease: true,
    policies: ["broker_stripe_transition"],
    content: "none",
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
  // M5 PR-1 (0025, BRANCH-LOCAL STUB of M2 PR-2's bridge, same signature): the store
  // associations behind the billing phase and the checkout precondition.
  "work_store_installations(text,text)",
]);
// M2 PR-1 (0020): the two schemas the work owner creates beside morrow_work. The billing
// route is tenant-readable with one extra insert policy for the signup bridge; the vault
// is readable only while the session user is the broker's login (vault_broker).
//
// S7 per-table spec (M2 PR-2a). Every billingTables and vaultTables entry carries exactly
// {class, parents, policies, content, commandPrivileges, commandColumnUpdates, apiColumns}:
// class, parents, policies and content as in workTables, and the table's whole ACL:
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
// runtime roles, written only by the owner) and ingress (the broker-recorded receipts and
// their applications: nullable tenant keys, reached only through the broker's and the
// receipt ingress's own policies, never the session template).
export const billingTables = Object.freeze({
  workspace_billing_routes: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces"],
    // M5 PR-1 (0027): receipt_apply fixes the route from a verified receipt.
    policies: ["receipt_apply", "route_signup"],
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
  // M5 PR-1 (0027): the M5 billing records.
  billing_terms: {
    class: "platform_readable",
    parents: [],
    policies: ["platform_api_read", "platform_command_read"],
    content: "none",
    ...aclSpec(["SELECT"], [], ["digest", "offers", "recorded_at", "terms", "terms_revision"]),
  },
  stripe_customers: {
    class: "tenant_internal",
    parents: ["morrow_identity.workspaces", "morrow_work.operations"],
    policies: ["broker_billing"],
    content: "none",
    ...aclSpec(["INSERT", "SELECT"]),
  },
  checkout_intents: {
    class: "tenant_readable",
    parents: ["morrow_identity.workspaces", "morrow_work.operations"],
    policies: ["broker_billing", "receipt_apply"],
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
  stripe_operations: {
    class: "tenant_internal",
    parents: ["morrow_billing.checkout_intents", "morrow_work.operations"],
    policies: ["broker_billing", "receipt_apply"],
    content: "none",
    ...aclSpec(["INSERT", "SELECT"], ["provider_object_id"]),
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
    policies: ["receipt_apply"],
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
    policies: ["receipt_apply"],
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
    policies: ["receipt_apply"],
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
  credit_wallets: {
    class: "tenant_readable",
    parents: ["morrow_billing.billing_accounts"],
    policies: ["receipt_apply"],
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
  // M5 PR-1 (0027). Session definers for the api role (tenant from current_tenant()).
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
});
export const vaultTables = Object.freeze({
  app_secrets: {
    class: "vault_platform",
    parents: [],
    policies: [],
    content: "none",
    ...aclSpec(["SELECT"]),
  },
  credentials: {
    class: "vault_tenant",
    parents: ["morrow_identity.workspaces"],
    policies: [],
    content: "store",
    ...aclSpec(["SELECT"]),
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
  // shop_domain and shop_id (spine §11: shop/redact pseudonymises the domain)
  linking_candidates: { content: "store" },
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
  morrow_connector_ingress: [],
  morrow_runtime_executor: [
    "morrow_work.enter_lease(text,text)",
    "morrow_work.lease_mark_started()",
    "morrow_work.lease_release()",
    "morrow_work.pending_starts()",
  ],
  morrow_vault_broker: [
    // M5 PR-1 (0027).
    "morrow_billing.stripe_op_begin(text)",
    "morrow_billing.stripe_op_settle(text,text,text,text)",
    "morrow_billing.stripe_receipt_record(text,text,text,text,text,text,text,text,text)",
    "morrow_vault.app_secret_get(text)",
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
