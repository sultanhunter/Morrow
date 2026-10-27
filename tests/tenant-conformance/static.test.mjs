// Static tenant-isolation checks S1-S6 (P06.T01a §4.12) against the real catalog
// of a PostgreSQL 17 database migrated through the whole manifest. Any miss fails.
// Run by `npm run lab:tenant-conformance` (pg-work group), not by `npm test`.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { withWorkDatabase } from "./harness.mjs";
import {
  billingFunctions,
  billingTables,
  bridgeFunctions,
  executorLogins,
  registeredRoutes,
  schemaUsage,
  vaultFunctions,
  vaultTables,
  workDomains,
  workFunctions,
  workOwnerBridges,
  workRouteProbes,
  workRoles,
  workTables,
} from "./registry.mjs";
import { contentProblems, contentSchemas, registeredTables } from "./content.mjs";
import { conformanceReport, recordConformance } from "./report.mjs";
import { morrowSetRowsSql } from "../../scripts/fixtures/createrole-administrator.mjs";

conformanceReport("static");

let db, release, started;
before(async () => {
  let ready;
  const opened = new Promise((resolve) => (ready = resolve));
  // The hosted administrator shape (ADR-0020, P04.T01j D7): a non-superuser CREATEROLE
  // login applies the chain with the D4 runner protocol.
  started = withWorkDatabase(
    "P06.T01a.conformance-static",
    (context) => {
      db = context;
      ready();
      return new Promise((resolve) => (release = resolve));
    },
    { administrator: "createrole" },
  );
  await Promise.race([opened, started]);
  assert.ok(db, "database started");
});
after(async () => {
  release?.();
  await started;
});
// The options carry `role` (SET ROLE before the query) through to the harness.
const rows = (query, options) => db.rows(query, options);
const names = (list) => [...list].sort();
const tenantTables = Object.entries(workTables)
  .filter(([, t]) => t.class !== "platform")
  .map(([name]) => name);
// The api role reads tenant-readable tables and the tenant rows plus platform rows of
// tenant_or_platform tables.
const readable = Object.entries(workTables)
  .filter(([, t]) => t.class === "tenant_readable" || t.class === "tenant_or_platform")
  .map(([name]) => name);
const tenantPredicate =
  "(((organization_id)::text, (workspace_id)::text) = ( SELECT c.organization_id,\n    c.workspace_id\n   FROM morrow_work.current_tenant() c(organization_id, workspace_id, principal_id, membership_id, policy_revision)))";
// The lease-context twin (M2 PR-1): the same row comparison against current_lease().
const leasePredicate =
  "(((organization_id)::text, (workspace_id)::text) = ( SELECT c.organization_id,\n    c.workspace_id\n   FROM morrow_work.current_lease() c(organization_id, workspace_id, lease_id, generation, kind, subject_id, store_id, connection_id, installation_id, initiator_principal_id, initiator_membership_id, expires_at)))";
const orPlatform = (predicate) => "((organization_id IS NULL) OR " + predicate + ")";
// M2 PR-3 (0037): the connector context's lease and redaction predicates.
const connectorLease =
  "((SESSION_USER = 'morrow_connector_ingress'::name) AND ((((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) || '|'::text) || (connection_id)::text) = current_setting('morrow.connector_stop'::text, true)))";
const connectorRedact =
  "((SESSION_USER = 'morrow_connector_ingress'::name) AND (EXISTS ( SELECT 1\n   FROM morrow_work.proposals x\n  WHERE (((x.organization_id)::text = (proposal_parameters.organization_id)::text) AND ((x.workspace_id)::text = (proposal_parameters.workspace_id)::text) AND ((x.parameters_id)::text = (proposal_parameters.id)::text) AND ((((((x.organization_id)::text || '|'::text) || (x.workspace_id)::text) || '|'::text) || (x.store_id)::text) = current_setting('morrow.connector_redact'::text, true))))))";
// M3 PR-2 with M2 PR-3: the connector's redaction context on a store-content table.
const connectorContent =
  "((SESSION_USER = 'morrow_connector_ingress'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) = current_setting('morrow.connector_redact'::text, true)))";
// v1 PR 5 (connection-health-work): the connector's health context, one connection
// (org|ws|store|connection) or one store (org|ws|store), each written only by the reconcile.
const connectorHealth =
  "((SESSION_USER = 'morrow_connector_ingress'::name) AND ((((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) || '|'::text) || (connection_id)::text) = current_setting('morrow.connector_health'::text, true)))";
const connectorAgentStore =
  "((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) = current_setting('morrow.connector_agent_stop'::text, true))";
const connectorHealthLease =
  "((SESSION_USER = 'morrow_connector_ingress'::name) AND (installation_id IS NOT NULL) AND " +
  connectorAgentStore +
  ")";
// v1 PR 3 (catalog-apply): the broker's catalog context (one operation, by its own setting).
const brokerCatalog =
  "((SESSION_USER = 'morrow_vault_broker'::name) AND (kind = 'catalog_write'::text) AND ((id)::text = current_setting('morrow.vault_catalog_operation'::text, true)))";
const brokerCatalogOperation =
  "((SESSION_USER = 'morrow_vault_broker'::name) AND ((operation_id)::text = current_setting('morrow.vault_catalog_operation'::text, true)))";
const brokerCatalogTransition =
  "((SESSION_USER = 'morrow_vault_broker'::name) AND ((operation_id)::text = current_setting('morrow.vault_catalog_operation'::text, true)) AND (EXISTS ( SELECT 1\n   FROM morrow_work.operations o\n  WHERE (((o.organization_id)::text = (operation_transitions.organization_id)::text) AND ((o.workspace_id)::text = (operation_transitions.workspace_id)::text) AND ((o.id)::text = (operation_transitions.operation_id)::text) AND (o.kind = 'catalog_write'::text)))))";
// SD12 (schedules-shop-zone): one tenant of the runtime executor's firing pass, and one store
// of the vault broker's zone record.
const scheduleFire =
  "((SESSION_USER = 'morrow_runtime_executor'::name) AND ((((organization_id)::text || '|'::text) || (workspace_id)::text) = current_setting('morrow.schedule_fire'::text, true)))";
const scheduleZone =
  "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) = current_setting('morrow.schedule_zone'::text, true)))";
// The exactly-checked extra policies (registry `policies`): [command, roles, qual, check].
const extraPolicies = {
  lease_self: [
    "ALL",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_runtime_executor'::name) AND ((id)::text = current_setting('morrow.work_lease_id'::text, true)))",
    "((SESSION_USER = 'morrow_runtime_executor'::name) AND ((id)::text = current_setting('morrow.work_lease_id'::text, true)))",
  ],
  lease_pending: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_runtime_executor'::name) AND (status = 'active'::text) AND (started_at IS NULL) AND (kind = ANY (ARRAY['run'::text, 'operation'::text])))",
    null,
  ],
  // The entry proof of enter_lease (0020): the runtime login's own backend only.
  lease_entry: [
    "ALL",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_runtime_executor'::name) AND (backend_pid = pg_backend_pid()))",
    "((SESSION_USER = 'morrow_runtime_executor'::name) AND (backend_pid = pg_backend_pid()))",
  ],
  // The membership-removal revocation (0023): the named membership's leases, only while
  // that member is not current, and only the change to revoked with reason membership.
  lease_member_revoke: [
    "ALL",
    "{morrow_work_command}",
    "((current_setting('morrow.work_member_revocation'::text, true) = (((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (initiator_membership_id)::text)) AND (NOT morrow_identity.work_lease_member_current((organization_id)::text, (workspace_id)::text, (initiator_principal_id)::text, (initiator_membership_id)::text)))",
    "((status = 'revoked'::text) AND (revoked_reason = 'membership'::text) AND (current_setting('morrow.work_member_revocation'::text, true) = (((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (initiator_membership_id)::text)))",
  ],
  // M2 PR-2 (0025): the linking rule's route read, one named row, SELECT only.
  route_link_read: [
    "SELECT",
    "{morrow_work_command}",
    "(current_setting('morrow.billing_route_read'::text, true) = (((organization_id)::text || '|'::text) || (workspace_id)::text))",
    null,
  ],
  // The signup bridge's policy, bound to the website signup (0022-0023).
  route_signup: [
    "INSERT",
    "{morrow_work_command}",
    null,
    "((origin = 'website'::text) AND (route IS NULL) AND (mode IS NULL) AND (route_fixed_at IS NULL) AND (fixing_payment_key IS NULL) AND ((revision)::bigint = 1) AND morrow_identity.work_signup_workspace((organization_id)::text, (workspace_id)::text))",
  ],
  vault_broker: [
    "ALL",
    "{morrow_work_command}",
    "(SESSION_USER = 'morrow_vault_broker'::name)",
    "(SESSION_USER = 'morrow_vault_broker'::name)",
  ],
  // M5 PR-1 (0029): the broker's own login, through its own definers only.
  broker_billing: [
    "ALL",
    "{morrow_work_command}",
    "(SESSION_USER = 'morrow_vault_broker'::name)",
    "(SESSION_USER = 'morrow_vault_broker'::name)",
  ],
  // Build order PR 7 (0043): the runtime ledger, the broker's own login through its four
  // vault definers only.
  broker_runtime: [
    "ALL",
    "{morrow_work_command}",
    "(SESSION_USER = 'morrow_vault_broker'::name)",
    "(SESSION_USER = 'morrow_vault_broker'::name)",
  ],
  broker_stripe: [
    "ALL",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND (kind = 'stripe_write'::text))",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND (kind = 'stripe_write'::text))",
  ],
  broker_stripe_transition: [
    "ALL",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND (EXISTS ( SELECT 1\n   FROM morrow_work.operations o\n  WHERE (((o.organization_id)::text = (operation_transitions.organization_id)::text) AND ((o.workspace_id)::text = (operation_transitions.workspace_id)::text) AND ((o.id)::text = (operation_transitions.operation_id)::text) AND (o.kind = 'stripe_write'::text)))))",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND (EXISTS ( SELECT 1\n   FROM morrow_work.operations o\n  WHERE (((o.organization_id)::text = (operation_transitions.organization_id)::text) AND ((o.workspace_id)::text = (operation_transitions.workspace_id)::text) AND ((o.id)::text = (operation_transitions.operation_id)::text) AND (o.kind = 'stripe_write'::text)))))",
  ],
  // The receipt-only ingress: the receipt's own tenant, through the entry proof.
  receipt_apply: [
    "ALL",
    "{morrow_work_command}",
    "morrow_billing.receipt_tenant((organization_id)::text, (workspace_id)::text)",
    "morrow_billing.receipt_tenant((organization_id)::text, (workspace_id)::text)",
  ],
  receipt_ingress_read: [
    "SELECT",
    "{morrow_work_command}",
    "morrow_billing.receipt_ingress()",
    null,
  ],
  receipt_ingress_apply: [
    "INSERT",
    "{morrow_work_command}",
    null,
    "morrow_billing.receipt_entered((receipt_id)::text)",
  ],
  receipt_entry: [
    "ALL",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_api_worker'::name) AND (backend_pid = pg_backend_pid()))",
    "((SESSION_USER = 'morrow_api_worker'::name) AND (backend_pid = pg_backend_pid()))",
  ],
  platform_command_read: ["SELECT", "{morrow_work_command}", "true", null],
  platform_api_read: ["SELECT", "{morrow_work_api}", "true", null],
  // M5 PR-1: the wallet's session UPDATE for M3 PR-1's sum-preserving moves (no INSERT).
  tenant_command_update: ["UPDATE", "{morrow_work_command}", tenantPredicate, tenantPredicate],
  // M3 PR-1 (0033): the lease twins of the wallet's two session policies, for the run
  // steps (no INSERT either).
  tenant_lease_read: ["SELECT", "{morrow_work_command}", leasePredicate, null],
  tenant_lease_update: ["UPDATE", "{morrow_work_command}", leasePredicate, leasePredicate],
  // M3 PR-1: morrow_vault.resolve_call reads, as the broker's login only, the one lease it
  // names, that lease's tenant's stops and the platform's, and that lease's installation,
  // through transaction-local settings it writes itself.
  lease_broker_resolve: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((id)::text = current_setting('morrow.vault_resolve_lease'::text, true)))",
    null,
  ],
  stop_broker_resolve: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((organization_id IS NULL) OR ((((organization_id)::text || '|'::text) || (workspace_id)::text) = current_setting('morrow.vault_resolve_tenant'::text, true))))",
    null,
  ],
  installation_broker_resolve: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (id)::text) = current_setting('morrow.vault_resolve_installation'::text, true)))",
    null,
  ],
  // M2 PR-3 (0037): the connector's context. Each names exactly the tenant, store and
  // connection (or store) that connector_inbox_apply wrote into its transaction-local
  // setting, only while the session user is the connector's login: the system connection
  // stop (set, never lifted), its StopRecord@1, the revocation of that connection's leases
  // (to revoked with reason stop) and shop/redact's emptying of the store's parameters.
  connector_stop_read: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_connector_ingress'::name) AND (scope = 'connection'::text) AND ((((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) || '|'::text) || (target_id)::text) = current_setting('morrow.connector_stop'::text, true)))",
    null,
  ],
  connector_stop_set: [
    "INSERT",
    "{morrow_work_command}",
    null,
    "((SESSION_USER = 'morrow_connector_ingress'::name) AND (scope = 'connection'::text) AND (set_by_kind = 'system'::text) AND (lifted_at IS NULL) AND (kill_switch_record_id IS NULL) AND (reason_code = ANY (ARRAY['shopify_app_uninstalled'::text, 'shopify_scopes_changed'::text])) AND ((((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) || '|'::text) || (target_id)::text) = current_setting('morrow.connector_stop'::text, true)))",
  ],
  connector_stop_record: [
    "INSERT",
    "{morrow_work_command}",
    null,
    "((SESSION_USER = 'morrow_connector_ingress'::name) AND (action = 'set'::text) AND (actor_kind = 'system'::text) AND (operator_id IS NULL) AND (scope = 'connection'::text) AND (reason_code = ANY (ARRAY['shopify_app_uninstalled'::text, 'shopify_scopes_changed'::text])) AND ((((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) || '|'::text) || (target_id)::text) = current_setting('morrow.connector_stop'::text, true)))",
  ],
  connector_lease_read: ["SELECT", "{morrow_work_command}", connectorLease, null],
  connector_lease_revoke: [
    "UPDATE",
    "{morrow_work_command}",
    connectorLease,
    "((status = 'revoked'::text) AND (revoked_reason = 'stop'::text) AND (SESSION_USER = 'morrow_connector_ingress'::name) AND ((((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) || '|'::text) || (connection_id)::text) = current_setting('morrow.connector_stop'::text, true)))",
  ],
  connector_redact_proposal: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_connector_ingress'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) = current_setting('morrow.connector_redact'::text, true)))",
    null,
  ],
  connector_redact_read: ["SELECT", "{morrow_work_command}", connectorRedact, null],
  connector_redact: [
    "UPDATE",
    "{morrow_work_command}",
    connectorRedact,
    "((redacted_at IS NOT NULL) AND (canonical = '{}'::text) AND " + connectorRedact.slice(1),
  ],
  // M3 PR-2 (listings-runs): the broker's model_call_begin and model_call_end reach, as the
  // broker's login only, the one run (and call) and tenant they name through
  // transaction-local settings they write themselves (the resolve_call idiom), and the one
  // parent task whose objective digest the fence binds.
  broker_model_run: [
    "ALL",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (id)::text) = current_setting('morrow.vault_model_run'::text, true)))",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (id)::text) = current_setting('morrow.vault_model_run'::text, true)))",
  ],
  broker_model_run_child: [
    "ALL",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (run_id)::text) = current_setting('morrow.vault_model_run'::text, true)))",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (run_id)::text) = current_setting('morrow.vault_model_run'::text, true)))",
  ],
  broker_model_call: [
    "ALL",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND (((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (run_id)::text) = current_setting('morrow.vault_model_run'::text, true)) OR ((id)::text = current_setting('morrow.vault_model_call'::text, true))))",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (run_id)::text) = current_setting('morrow.vault_model_run'::text, true)))",
  ],
  broker_model_tenant: [
    "ALL",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((organization_id)::text || '|'::text) || (workspace_id)::text) = current_setting('morrow.vault_model_tenant'::text, true)))",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((organization_id)::text || '|'::text) || (workspace_id)::text) = current_setting('morrow.vault_model_tenant'::text, true)))",
  ],
  task_broker_model: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (id)::text) = current_setting('morrow.vault_model_task'::text, true)))",
    null,
  ],
  // M2 PR-3's read resolution, revised in listings-runs (0038): run_product_readable reads,
  // as the broker's login only, the one run its own setting names and that run's products
  // (FOR SELECT only; never a manifest or a call, never a write).
  broker_read_run: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (id)::text) = current_setting('morrow.vault_read_run'::text, true)))",
    null,
  ],
  broker_read_run_product: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (run_id)::text) = current_setting('morrow.vault_read_run'::text, true)))",
    null,
  ],
  // shop/redact's deletion of a store's snapshots and drafts (0038's store_content_redact):
  // read and delete in the connector's redaction context only, and a RESTRICTIVE delete
  // policy with the same predicate, so no session or lease policy admits a DELETE.
  connector_content_read: ["SELECT", "{morrow_work_command}", connectorContent, null],
  connector_content_delete: ["DELETE", "{morrow_work_command}", connectorContent, null],
  connector_content_delete_only: ["DELETE", "{morrow_work_command}", connectorContent, null],
  // v1 PR 3 (catalog-apply): the broker's catalog definers reach, as the broker's login only,
  // the one catalog_write operation their own transaction-local setting names (its row, its
  // transitions, its fence and read-back rows) and, for reading only, that operation's
  // tenant: its catalog operations (one open write per product), proposals, parameters and
  // snapshots.
  broker_catalog: ["ALL", "{morrow_work_command}", brokerCatalog, brokerCatalog],
  broker_catalog_tenant: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND (kind = 'catalog_write'::text) AND ((((organization_id)::text || '|'::text) || (workspace_id)::text) = current_setting('morrow.vault_catalog_tenant'::text, true)))",
    null,
  ],
  broker_catalog_transition: [
    "ALL",
    "{morrow_work_command}",
    brokerCatalogTransition,
    brokerCatalogTransition,
  ],
  broker_catalog_operation: [
    "ALL",
    "{morrow_work_command}",
    brokerCatalogOperation,
    brokerCatalogOperation,
  ],
  broker_catalog_read: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((organization_id)::text || '|'::text) || (workspace_id)::text) = current_setting('morrow.vault_catalog_tenant'::text, true)))",
    null,
  ],
  // v1 PR 4 (catalog-undo): the broker's undo check stores its read of one product, as the
  // broker's login only, for exactly the tenant, store and product its own transaction-local
  // setting names (INSERT only; catalog_undo_record writes and clears it).
  broker_undo_snapshot: [
    "INSERT",
    "{morrow_work_command}",
    null,
    "((SESSION_USER = 'morrow_vault_broker'::name) AND ((((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) || '|'::text) || product_id) = current_setting('morrow.vault_undo_product'::text, true)))",
  ],
  // v1 PR 5 (connection-health-work): the connector's health context. The Reconnect item of
  // exactly one connection (read, raise while open, revise), the cron's open-item list (only
  // under that definer's own setting), the store's agent installations (read only), and the
  // system installation stop of a scope change (read, set with its two reasons, never
  // lifted; its StopRecord@1; the revocation of that store's agent leases).
  connector_health_read: ["SELECT", "{morrow_work_command}", connectorHealth, null],
  connector_health_raise: [
    "INSERT",
    "{morrow_work_command}",
    null,
    "((SESSION_USER = 'morrow_connector_ingress'::name) AND (cleared_at IS NULL) AND ((((((((organization_id)::text || '|'::text) || (workspace_id)::text) || '|'::text) || (store_id)::text) || '|'::text) || (connection_id)::text) = current_setting('morrow.connector_health'::text, true)))",
  ],
  connector_health_revise: ["UPDATE", "{morrow_work_command}", connectorHealth, connectorHealth],
  connector_health_sweep: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_connector_ingress'::name) AND (cleared_at IS NULL) AND (current_setting('morrow.connector_sweep'::text, true) = 'open'::text))",
    null,
  ],
  connector_health_agents: ["SELECT", "{morrow_work_command}", connectorHealth, null],
  // SD12 (schedules-shop-zone): the runtime executor's firing context (the due list across
  // tenants while its definer's own setting is on, one schedule by id to find its tenant, then
  // one tenant's schedules and the pending schedule trigger rows it writes) and the vault
  // broker's zone context (one store's zone row and open notice, and its schedules, read only).
  schedule_sweep: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_runtime_executor'::name) AND (status = 'active'::text) AND (current_setting('morrow.schedule_sweep'::text, true) = 'due'::text))",
    null,
  ],
  schedule_target: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_runtime_executor'::name) AND ((id)::text = current_setting('morrow.schedule_target'::text, true)))",
    null,
  ],
  schedule_fire_read: ["SELECT", "{morrow_work_command}", scheduleFire, null],
  schedule_fire_advance: ["UPDATE", "{morrow_work_command}", scheduleFire, scheduleFire],
  schedule_fire_triggers: [
    "INSERT",
    "{morrow_work_command}",
    null,
    "((SESSION_USER = 'morrow_runtime_executor'::name) AND (kind = 'schedule'::text) AND (status = 'pending'::text) AND ((((organization_id)::text || '|'::text) || (workspace_id)::text) = current_setting('morrow.schedule_fire'::text, true)))",
  ],
  schedule_zone_vault: ["ALL", "{morrow_work_command}", scheduleZone, scheduleZone],
  schedule_zone_vault_read: ["SELECT", "{morrow_work_command}", scheduleZone, null],
  connector_health_stop_read: [
    "SELECT",
    "{morrow_work_command}",
    "((SESSION_USER = 'morrow_connector_ingress'::name) AND (scope = 'installation'::text) AND " +
      connectorAgentStore +
      ")",
    null,
  ],
  connector_health_stop_set: [
    "INSERT",
    "{morrow_work_command}",
    null,
    "((SESSION_USER = 'morrow_connector_ingress'::name) AND (scope = 'installation'::text) AND (set_by_kind = 'system'::text) AND (lifted_at IS NULL) AND (kill_switch_record_id IS NULL) AND (reason_code = ANY (ARRAY['shopify_scope_missing'::text, 'shopify_token_refused'::text])) AND " +
      connectorAgentStore +
      ")",
  ],
  connector_health_stop_record: [
    "INSERT",
    "{morrow_work_command}",
    null,
    "((SESSION_USER = 'morrow_connector_ingress'::name) AND (action = 'set'::text) AND (actor_kind = 'system'::text) AND (operator_id IS NULL) AND (scope = 'installation'::text) AND (reason_code = ANY (ARRAY['shopify_scope_missing'::text, 'shopify_token_refused'::text])) AND " +
      connectorAgentStore +
      ")",
  ],
  connector_health_lease_read: ["SELECT", "{morrow_work_command}", connectorHealthLease, null],
  connector_health_lease_revoke: [
    "UPDATE",
    "{morrow_work_command}",
    connectorHealthLease,
    "((status = 'revoked'::text) AND (revoked_reason = 'stop'::text) AND (SESSION_USER = 'morrow_connector_ingress'::name) AND (installation_id IS NOT NULL) AND " +
      connectorAgentStore +
      ")",
  ],
};
// The only restrictive policies; every other policy is permissive.
const restrictivePolicies = new Set(["connector_content_delete_only"]);
// One table's policies against the template of its class and its registry extras.
function checkPolicies(schema, table, spec) {
  const policies = rows(
    `SELECT policyname, cmd, roles::text AS roles, qual, with_check, permissive FROM pg_policies WHERE schemaname='${schema}' AND tablename='${table}' ORDER BY policyname`,
  );
  // Every policy is permissive except the registered restrictive ones.
  for (const policy of policies)
    assert.equal(
      policy.permissive,
      restrictivePolicies.has(policy.policyname) ? "RESTRICTIVE" : "PERMISSIVE",
      table + " " + policy.policyname,
    );
  const mixed = spec.class === "tenant_or_platform";
  const vault = spec.class === "vault_platform" || spec.class === "vault_tenant";
  // M5 PR-1: platform tables of morrow_billing, the ingress receipts and the operator's
  // records carry only the owner's maintenance policy and their registered extras (no
  // session template).
  const ownOnly = ["platform", "platform_readable", "ingress", "operator_record"].includes(
    spec.class,
  );
  const expected = ["work_owner"]
    .concat(vault ? ["vault_broker"] : ownOnly ? [] : ["tenant_command"])
    .concat(spec.class === "tenant_readable" || mixed ? ["tenant_read"] : [])
    .concat(spec.lease || mixed ? ["tenant_lease"] : [])
    .concat(spec.policies ?? []);
  assert.deepEqual(names(policies.map((p) => p.policyname)), names(expected), table);
  for (const policy of policies) {
    const shape = [policy.cmd, policy.roles, policy.qual, policy.with_check];
    if (policy.policyname === "work_owner")
      assert.deepEqual(shape, ["ALL", "{morrow_work_owner}", "true", "true"], table);
    else if (policy.policyname === "tenant_command")
      assert.deepEqual(
        shape,
        spec.commandRead
          ? ["SELECT", "{morrow_work_command}", tenantPredicate, null]
          : [
              "ALL",
              "{morrow_work_command}",
              mixed ? orPlatform(tenantPredicate) : tenantPredicate,
              tenantPredicate,
            ],
        table,
      );
    else if (policy.policyname === "tenant_lease")
      assert.deepEqual(
        shape,
        mixed
          ? ["SELECT", "{morrow_work_command}", orPlatform(leasePredicate), null]
          : ["ALL", "{morrow_work_command}", leasePredicate, leasePredicate],
        table,
      );
    else if (policy.policyname === "tenant_read")
      assert.deepEqual(
        shape,
        [
          "SELECT",
          "{morrow_work_api}",
          mixed ? orPlatform(tenantPredicate) : tenantPredicate,
          null,
        ],
        table,
      );
    else assert.deepEqual(shape, extraPolicies[policy.policyname], table + " " + policy.policyname);
  }
}

test("S1: every morrow_work object is registered and nothing else exists", () => {
  const tables = rows(
    "SELECT c.relname, c.relkind FROM pg_class c WHERE c.relnamespace='morrow_work'::regnamespace AND c.relkind IN ('r','p','v','m','S','f')",
  );
  assert.deepEqual(names(tables.map((t) => t.relname)), names(Object.keys(workTables)));
  assert.ok(tables.every((t) => t.relkind === "r"));
  const functions = rows(
    "SELECT regexp_replace(p.oid::regprocedure::text,'^morrow_work\\.','') AS signature FROM pg_proc p WHERE p.pronamespace='morrow_work'::regnamespace",
  );
  assert.deepEqual(names(functions.map((f) => f.signature)), names(Object.keys(workFunctions)));
  const types = rows(
    "SELECT t.typname, t.typtype FROM pg_type t WHERE t.typnamespace='morrow_work'::regnamespace AND t.typtype='d'",
  );
  assert.deepEqual(names(types.map((t) => t.typname)), names(workDomains));
  const bridge = rows(
    "SELECT regexp_replace(p.oid::regprocedure::text,'^morrow_identity\\.','') AS signature FROM pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname LIKE 'work\\_%'",
  );
  assert.deepEqual(names(bridge.map((f) => f.signature)), names(bridgeFunctions));
  recordConformance("S1", true);
});

test("S2: every table has ENABLE and FORCE row-level security", () => {
  const tables = rows(
    "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace='morrow_work'::regnamespace AND relkind='r'",
  );
  assert.equal(tables.length, Object.keys(workTables).length);
  for (const t of tables) assert.ok(t.relrowsecurity && t.relforcerowsecurity, t.relname);
  recordConformance("S2", true);
});

test("S3: tenant keys, composite parents and the one tenant policy template", () => {
  for (const table of tenantTables) {
    const mixed = workTables[table].class === "tenant_or_platform";
    const columns = rows(
      `SELECT attname, attnotnull FROM pg_attribute WHERE attrelid='morrow_work.${table}'::regclass AND attname IN ('organization_id','workspace_id') AND NOT attisdropped`,
    );
    assert.equal(columns.length, 2, table);
    // Platform rows of a tenant_or_platform table have both keys null (its CHECK).
    assert.ok(
      columns.every((c) => c.attnotnull === !mixed),
      table,
    );
    const keys = rows(
      `SELECT c.contype AS kind,(SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS columns FROM pg_constraint c WHERE c.conrelid='morrow_work.${table}'::regclass AND c.contype IN ('p','u')`,
    );
    // The primary key leads with the tenant keys. A tenant_or_platform table has a global
    // id primary key instead, and a unique (organization_id, workspace_id, id) key that its
    // children's composite foreign keys reference.
    const pk = keys.find((k) => k.kind === "p").columns;
    if (mixed) {
      assert.deepEqual(pk, ["id"], table);
      assert.ok(
        keys.some((k) => k.columns.join() === "organization_id,workspace_id,id"),
        table,
      );
    } else assert.deepEqual(pk.slice(0, 2), ["organization_id", "workspace_id"], table);
    const fks = rows(
      `SELECT c.confrelid::regclass::text AS parent,(SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS columns FROM pg_constraint c WHERE c.conrelid='morrow_work.${table}'::regclass AND c.contype='f'`,
    );
    for (const parent of workTables[table].parents) {
      const qualified = parent.includes(".") ? parent : "morrow_work." + parent;
      assert.ok(
        fks.some(
          (fk) =>
            fk.parent === qualified &&
            fk.columns[0] === "organization_id" &&
            fk.columns[1] === "workspace_id",
        ),
        table + " -> " + parent,
      );
    }
    checkPolicies("morrow_work", table, workTables[table]);
  }
  for (const [table, spec] of Object.entries(workTables).filter(
    ([, t]) => t.class === "platform",
  )) {
    const platform = rows(
      `SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid='morrow_work.${table}'::regclass AND attname IN ('organization_id','workspace_id')`,
    );
    assert.equal(platform[0].n, 0, table);
    assert.deepEqual(spec.parents, [], table);
    // A platform table with registered policies (the M2 PR-1 entry proof) has exactly the
    // owner's maintenance policy and those, each in its checked shape.
    if (spec.policies) {
      const policies = rows(
        `SELECT policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='morrow_work' AND tablename='${table}' ORDER BY policyname`,
      );
      assert.deepEqual(
        names(policies.map((p) => p.policyname)),
        names(["work_owner", ...spec.policies]),
        table,
      );
      for (const policy of policies)
        assert.deepEqual(
          [policy.cmd, policy.roles, policy.qual, policy.with_check],
          policy.policyname === "work_owner"
            ? ["ALL", "{morrow_work_owner}", "true", "true"]
            : extraPolicies[policy.policyname],
          table + " " + policy.policyname,
        );
    }
  }
  recordConformance("S3", true);
});

test("S4: the api role reads readable tables column by column; no runtime TRUNCATE, DELETE only for shop/redact", () => {
  const tableAcl = rows(
    "SELECT c.relname, a.grantee::regrole::text AS grantee, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace='morrow_work'::regnamespace AND a.grantee<>0",
  );
  assert.ok(!tableAcl.some((a) => a.grantee === workRoles.api || a.grantee === workRoles.login));
  // SELECT and INSERT; DELETE only where the registry names shop/redact's connector context
  // (commandDelete), which a RESTRICTIVE delete policy confines to that context (S3).
  const deletable = Object.entries(workTables)
    .filter(([, t]) => t.commandDelete === "connector_redact")
    .map(([name]) => name);
  assert.deepEqual(deletable.sort(), ["product_snapshots", "run_drafts"]);
  for (const a of tableAcl.filter((x) => x.grantee === workRoles.command))
    assert.ok(
      ["SELECT", "INSERT"].includes(a.privilege_type) ||
        (a.privilege_type === "DELETE" && deletable.includes(a.relname)),
      a.relname + " " + a.privilege_type,
    );
  for (const table of deletable) {
    assert.ok(
      tableAcl.some(
        (a) =>
          a.grantee === workRoles.command && a.relname === table && a.privilege_type === "DELETE",
      ),
      table,
    );
    assert.ok(workTables[table].policies.includes("connector_content_delete_only"), table);
  }
  const columnAcl = rows(
    "SELECT c.relname, a.grantee::regrole::text AS grantee, a.privilege_type FROM pg_attribute t JOIN pg_class c ON c.oid=t.attrelid, aclexplode(t.attacl) a WHERE c.relnamespace='morrow_work'::regnamespace AND t.attacl IS NOT NULL",
  );
  for (const a of columnAcl.filter((x) => x.grantee === workRoles.api)) {
    assert.equal(a.privilege_type, "SELECT");
    assert.ok(readable.includes(a.relname), a.relname);
  }
  for (const a of columnAcl.filter((x) => x.grantee === workRoles.command))
    assert.equal(a.privilege_type, "UPDATE", a.relname);
  for (const table of readable)
    assert.ok(
      columnAcl.some((a) => a.grantee === workRoles.api && a.relname === table),
      table,
    );
  for (const role of Object.values(workRoles))
    for (const table of Object.keys(workTables)) {
      const [p] = rows(
        `SELECT has_table_privilege('${role}','morrow_work.${table}','DELETE') AS d, has_table_privilege('${role}','morrow_work.${table}','TRUNCATE') AS t`,
      );
      if (role === workRoles.owner) continue;
      assert.ok(!p.t, role + " " + table);
      assert.equal(
        p.d,
        role === workRoles.command && workTables[table].commandDelete === "connector_redact",
        role + " " + table,
      );
    }
  for (const [table] of Object.entries(workTables).filter(([, t]) => t.class === "platform")) {
    const platformApi = rows(
      `SELECT has_any_column_privilege('morrow_work_api','morrow_work.${table}','SELECT') AS s`,
    );
    assert.equal(platformApi[0].s, false, table);
  }
  const views = rows(
    "SELECT relname, reloptions FROM pg_class WHERE relnamespace='morrow_work'::regnamespace AND relkind='v'",
  );
  for (const view of views) assert.ok((view.reloptions ?? []).includes("security_invoker=true"));
  recordConformance("S4", true);
});

// Definer kinds: the api functions, the resolvers, and (M2 PR-1) the runtime, vault and
// signup-bridge definers. Every definer is owned by the command role; operator functions
// are INVOKER and owned by the owner, like triggers and checks.
// M5 PR-1 adds the broker's own billing definers ("broker") and the receipt-only ingress
// ("ingress"); M2 PR-3 the connector login's definers ("connector").
const definerKinds = [
  "api",
  "resolver",
  "runtime",
  "vault",
  "bridge_in",
  "broker",
  "ingress",
  "connector",
];

test("S5: definers, owners, search paths, grants, parameters, roles and memberships", () => {
  const functions = rows(
    "SELECT regexp_replace(p.oid::regprocedure::text,'^morrow_work\\.','') AS signature, p.prosecdef, p.proowner::regrole::text AS owner, p.proconfig, p.proacl::text AS acl, pg_get_function_identity_arguments(p.oid) AS arguments, (SELECT COALESCE(array_agg(a.grantee::regrole::text ORDER BY 1),'{}') FROM aclexplode(p.proacl) a WHERE a.grantee<>0 AND a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS grantees, (SELECT count(*) FROM aclexplode(p.proacl) a WHERE a.grantee=0)::int AS public FROM pg_proc p WHERE p.pronamespace='morrow_work'::regnamespace",
  );
  for (const f of functions) {
    const spec = workFunctions[f.signature];
    assert.ok(spec, f.signature);
    assert.ok(f.acl !== null && f.public === 0, "no PUBLIC EXECUTE " + f.signature);
    assert.deepEqual(f.grantees, spec.grantees, f.signature);
    assert.ok(
      (f.proconfig ?? []).some((c) => c.startsWith("search_path=pg_catalog")),
      "search_path " + f.signature,
    );
    const definer = definerKinds.includes(spec.kind);
    assert.equal(f.prosecdef, definer, f.signature);
    if (definer || spec.kind === "helper") assert.equal(f.owner, workRoles.command, f.signature);
    else assert.equal(f.owner, workRoles.owner, f.signature);
    if (spec.kind === "api" || spec.kind === "runtime" || spec.kind === "connector")
      for (const name of f.arguments
        .split(", ")
        .filter(Boolean)
        .map((a) => a.split(" ")[0]))
        assert.ok(
          (spec.tenantParameters ?? []).includes(name) ||
            // Targets (assignee, respondent) are not the actor; the actor comes only
            // from current_tenant().
            !(
              /organization|workspace|actor|membership/.test(name) ||
              /^p_principal(_id)?$/.test(name)
            ),
          f.signature + " " + name,
        );
  }
  // The one cross-tenant definer returns exactly its registered id columns (spine §5).
  for (const [signature, spec] of Object.entries(workFunctions).filter(([, f]) => f.crossTenant)) {
    const [result] = rows(
      `SELECT array_to_string(p.proargnames[p.pronargs+1:],',') AS columns, p.proretset FROM pg_proc p WHERE p.oid='morrow_work.${signature}'::regprocedure`,
    );
    assert.equal(result.columns, spec.columns.join(","), signature);
    assert.equal(result.proretset, true, signature);
  }
  const roles = [
    ...Object.keys(executorLogins),
    "morrow_work_owner",
    "morrow_work_command",
    "morrow_work_api",
    "morrow_api_worker",
    "morrow_api",
    "morrow_identity_owner",
    "morrow_identity_lifecycle",
    "morrow_identity_linking",
    "morrow_identity_preauth",
    "morrow_identity_resolution",
    "morrow_identity_sessions",
    "morrow_identity_login",
    "morrow_identity_login_maintenance",
    "morrow_identity_logout",
    "morrow_identity_onboarding",
  ];
  for (const signature of bridgeFunctions)
    for (const role of roles) {
      const [p] = rows(
        `SELECT has_function_privilege('${role}','morrow_identity.${signature}','EXECUTE') AS x, p.prosecdef, p.proowner::regrole::text AS owner FROM pg_proc p WHERE p.oid='morrow_identity.${signature}'::regprocedure`,
      );
      // The command role executes every bridge; the work owner only its registered ones
      // (workOwnerBridges: 0034, the operator test entitlement's association read).
      assert.equal(
        p.x,
        role === workRoles.command ||
          role === "morrow_identity_owner" ||
          (role === workRoles.owner && workOwnerBridges.includes(signature)),
        role + " " + signature,
      );
      assert.ok(p.prosecdef && p.owner === "morrow_identity_owner");
    }
  // 0014 replaces the three organization-interlocked identity functions with
  // CREATE OR REPLACE, which keeps each ACL. Over the whole chain each keeps exactly
  // its pre-0014 EXECUTE grantees, so 0013's revocation of admit_browser_family from
  // morrow_identity_sessions survives; a later DROP and CREATE plus GRANT would fail here.
  const admitBrowserFamily = `admit_browser_family(${Array(27).fill("text").join(",")})`;
  for (const [signature, grantees] of [
    [
      "revoke_workspace_access(text,text,text,text,text,text,text,text)",
      ["morrow_identity_lifecycle"],
    ],
    [
      "link_workspace_store(text,text,text,text,text,text,text,text,text,text,text)",
      ["morrow_identity_linking"],
    ],
    [admitBrowserFamily, []],
  ]) {
    const [f] = rows(
      `SELECT p.proowner::regrole::text AS owner, p.proacl IS NOT NULL AS acl, (SELECT COALESCE(array_agg(a.grantee::regrole::text ORDER BY 1),'{}') FROM aclexplode(p.proacl) a WHERE a.grantee<>0 AND a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS grantees, (SELECT count(*) FROM aclexplode(p.proacl) a WHERE a.grantee=0)::int AS public FROM pg_proc p WHERE p.oid='morrow_identity.${signature}'::regprocedure`,
    );
    assert.equal(f.owner, "morrow_identity_owner", signature);
    assert.ok(f.acl && f.public === 0, "no PUBLIC EXECUTE " + signature);
    assert.deepEqual(f.grantees, grantees, signature);
  }
  const [sessions] = rows(
    `SELECT has_function_privilege('morrow_identity_sessions','morrow_identity.${admitBrowserFamily}','EXECUTE') AS x`,
  );
  assert.equal(
    sessions.x,
    false,
    "0013 revoked admit_browser_family from morrow_identity_sessions",
  );
  // ADR-0020: the work owner executes exactly the three read-only membership helpers
  // that 0015 checks (granted by 0014); no other work role executes any of the five.
  const workOwnerHelpers = [
    "morrow_identity.memberships_closed(name)",
    "morrow_identity.morrow_memberships_closed()",
    "morrow_identity.recorded_administrator()",
  ];
  const identityFunctions = rows(
    "SELECT p.oid::regprocedure::text AS signature, has_function_privilege('morrow_work_command',p.oid,'EXECUTE') AS c, has_function_privilege('morrow_work_api',p.oid,'EXECUTE') AS a, has_function_privilege('morrow_work_owner',p.oid,'EXECUTE') AS o, has_function_privilege('morrow_api_worker',p.oid,'EXECUTE') AS l FROM pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace",
  );
  // No executor login executes an identity function beyond its registered ones (ADR-0022
  // item 8): M2 PR-2's connector OAuth-state definer is the only one.
  const loginIdentity = rows(
    `SELECT r.rolname, p.oid::regprocedure::text AS signature FROM pg_roles r, pg_proc p WHERE r.rolname IN (${Object.keys(
      executorLogins,
    )
      .map((l) => `'${l}'`)
      .join(
        ",",
      )}) AND p.pronamespace='morrow_identity'::regnamespace AND has_function_privilege(r.oid,p.oid,'EXECUTE')`,
  );
  assert.deepEqual(
    loginIdentity.map((r) => r.rolname + " " + r.signature).sort(),
    Object.entries(executorLogins)
      .flatMap(([login, allowed]) =>
        allowed.filter((f) => f.startsWith("morrow_identity.")).map((f) => login + " " + f),
      )
      .sort(),
  );
  // Besides them, the work owner executes exactly its registered identity bridges (0034:
  // the store-association read of the operator test entitlement, 0035).
  for (const f of identityFunctions) {
    const name = f.signature.replace("morrow_identity.", "");
    const bridge = bridgeFunctions.includes(name);
    assert.equal(f.c, bridge, f.signature);
    assert.equal(
      f.o,
      workOwnerHelpers.includes(f.signature) || workOwnerBridges.includes(name),
      f.signature,
    );
    assert.ok(!f.a && !f.l, f.signature);
  }
  assert.ok(workOwnerBridges.every((name) => bridgeFunctions.includes(name)));
  assert.equal(
    identityFunctions.filter((f) => f.o).length,
    workOwnerHelpers.length + workOwnerBridges.length,
  );
  // The five ADR-0020 helpers: owned by the identity owner, no PUBLIC EXECUTE, and no
  // executor may run any of them.
  const helperAcl = rows(
    "SELECT p.oid::regprocedure::text AS signature, p.proowner::regrole::text AS owner, p.proacl IS NOT NULL AS acl, (SELECT count(*) FROM aclexplode(p.proacl) a WHERE a.grantee=0)::int AS public, (SELECT COALESCE(array_agg(a.grantee::regrole::text ORDER BY 1),'{}') FROM aclexplode(p.proacl) a WHERE a.grantee<>0 AND a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS grantees FROM pg_proc p WHERE p.pronamespace='morrow_identity'::regnamespace AND p.proname IN ('preserve_migration_administrator','recorded_administrator','memberships_closed','morrow_memberships_closed','executor_memberships_closed')",
  );
  assert.equal(helperAcl.length, 5);
  for (const h of helperAcl) {
    assert.equal(h.owner, "morrow_identity_owner", h.signature);
    assert.ok(h.acl && h.public === 0, "no PUBLIC EXECUTE " + h.signature);
    assert.deepEqual(
      h.grantees,
      workOwnerHelpers.includes(h.signature) ? ["morrow_work_owner"] : [],
      h.signature,
    );
  }
  // Across every Morrow role: the owner executes all five and the work owner exactly its
  // three; no executor, login or other role executes any of them.
  const helperExecutors = rows(
    "SELECT r.rolname AS role, p.oid::regprocedure::text AS signature FROM pg_roles r, pg_proc p WHERE r.rolname LIKE 'morrow\\_%' AND p.pronamespace='morrow_identity'::regnamespace AND p.proname IN ('preserve_migration_administrator','recorded_administrator','memberships_closed','morrow_memberships_closed','executor_memberships_closed') AND has_function_privilege(r.oid,p.oid,'EXECUTE')",
  );
  assert.deepEqual(
    helperExecutors.map((x) => x.role + " " + x.signature).sort(),
    [
      ...helperAcl.map((h) => "morrow_identity_owner " + h.signature),
      ...workOwnerHelpers.map((signature) => workRoles.owner + " " + signature),
    ].sort(),
  );
  const attributes = rows(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls, rolreplication, rolpassword IS NOT NULL AS has_password FROM pg_authid WHERE rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker',${Object.keys(
      executorLogins,
    )
      .map((l) => `'${l}'`)
      .join(",")})`,
  );
  assert.equal(attributes.length, 4 + Object.keys(executorLogins).length);
  for (const r of attributes) {
    assert.equal(
      r.rolcanlogin,
      r.rolname === workRoles.login || Object.hasOwn(executorLogins, r.rolname),
      r.rolname,
    );
    for (const flag of [
      "rolsuper",
      "rolcreatedb",
      "rolcreaterole",
      "rolinherit",
      "rolbypassrls",
      "rolreplication",
    ])
      assert.equal(r[flag], false, r.rolname + " " + flag);
    assert.equal(r.has_password, false, "no PASSWORD clause " + r.rolname);
  }
  const forbidden = rows(
    "SELECT rolname FROM pg_roles WHERE rolname ~ '^morrow_(work_(relay|maintenance|operations)|orchestrator_worker)$'",
  );
  assert.deepEqual(forbidden, []);
  // ADR-0020 (P04.T01j D7): the recorded administrator is the login that applied the
  // chain, and the rows naming a work role are exact. The suite runs in the hosted shape
  // only: a non-superuser CREATEROLE administrator. The two reviewed rows are granted by
  // the recorded administrator, and each work role also has its one PG16+ creation row
  // (member the administrator, grantor the bootstrap superuser oid 10, admin true, inherit
  // false, set false). The local superuser shape, which has no creation rows, is checked
  // by container S of lab:createrole-administrator.
  assert.equal(db.administrator, "createrole");
  // The owner reads the record through its identity_owner SELECT policy (FORCE RLS).
  const [record] = rows(
    "SELECT current_user AS reader, a.role_oid::bigint AS oid, a.role_name AS name, (SELECT count(*) FROM morrow_identity.migration_administrator)::int AS n FROM morrow_identity.migration_administrator a",
    { role: "morrow_identity_owner" },
  );
  assert.equal(record.reader, "morrow_identity_owner");
  assert.equal(record.n, 1);
  assert.equal(record.name, "neondb_owner");
  assert.notEqual(record.oid, 10);
  const members = rows(
    "SELECT g.rolname AS role, u.rolname AS member, m.grantor::bigint AS grantor, m.admin_option, m.inherit_option, m.set_option FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE g.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker') OR u.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker')",
  );
  const shape = (m) =>
    [m.role, m.member, m.grantor, m.admin_option, m.inherit_option, m.set_option].join(" ");
  assert.deepEqual(
    members.map(shape).sort(),
    [
      ["morrow_work_api", "morrow_api_worker", record.oid, false, false, true],
      ["morrow_work_command", "morrow_work_owner", record.oid, false, false, true],
      ...["morrow_work_owner", "morrow_work_command", "morrow_work_api", "morrow_api_worker"].map(
        (role) => [role, record.name, 10, true, false, false],
      ),
    ]
      .map((row) => row.join(" "))
      .sort(),
  );
  // The executor logins are membership-free (ADR-0022 item 8): each has exactly its PG16+
  // creation row and no other row names it, in either direction.
  const loginMembers = rows(
    `SELECT g.rolname AS role, u.rolname AS member, m.grantor::bigint AS grantor, m.admin_option, m.inherit_option, m.set_option FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE g.rolname IN (${Object.keys(
      executorLogins,
    )
      .map((l) => `'${l}'`)
      .join(",")}) OR u.rolname IN (${Object.keys(executorLogins)
      .map((l) => `'${l}'`)
      .join(",")})`,
  );
  assert.deepEqual(
    loginMembers.map(shape).sort(),
    Object.keys(executorLogins)
      .map((login) => [login, record.name, 10, true, false, false].join(" "))
      .sort(),
  );
  // Every Morrow role is closed, evaluated as the owner from a superuser session (so the
  // in-transaction runner rule (C) cannot apply), and no SET row names a Morrow role
  // except the two reviewed rows.
  const [closed] = rows(
    "SELECT current_user AS caller, morrow_identity.morrow_memberships_closed() AS closed",
    { role: "morrow_identity_owner" },
  );
  assert.equal(closed.caller, "morrow_identity_owner");
  assert.equal(closed.closed, true);
  const [setRows] = rows(morrowSetRowsSql.replace("SELECT count(*)", "SELECT count(*)::int AS n"));
  assert.equal(setRows.n, 0);
  recordConformance("S5", true);
});

test("S6: workRoutes and the registry match one-to-one", () => {
  assert.deepEqual(names(registeredRoutes), names(Object.keys(workRouteProbes)));
  assert.equal(new Set(registeredRoutes).size, registeredRoutes.length);
  recordConformance("S6", true);
});

// M2 PR-1 (0020): morrow_billing and morrow_vault follow S1-S5 in their own registries,
// and each executor login executes exactly its registered functions. M2 PR-2a: every
// expectation comes from the registry (schemaUsage and each table's S7 spec), so a later
// PR's tables and grants are checked by adding registry entries only.
test("S7: the billing and vault schemas, and what each executor login may execute", () => {
  assert.deepEqual(Object.keys(schemaUsage).sort(), ["morrow_billing", "morrow_vault"]);
  for (const [schema, tables, functions] of [
    ["morrow_billing", billingTables, billingFunctions],
    ["morrow_vault", vaultTables, vaultFunctions],
  ]) {
    // S1: every object registered and nothing else; no domain, view or sequence.
    const relations = rows(
      `SELECT c.relname, c.relkind FROM pg_class c WHERE c.relnamespace='${schema}'::regnamespace AND c.relkind IN ('r','p','v','m','S','f')`,
    );
    assert.deepEqual(names(relations.map((t) => t.relname)), names(Object.keys(tables)), schema);
    assert.ok(relations.every((t) => t.relkind === "r"));
    const types = rows(
      `SELECT t.typname FROM pg_type t WHERE t.typnamespace='${schema}'::regnamespace AND t.typtype='d'`,
    );
    assert.deepEqual(types, [], schema);
    const schemaAcl = rows(
      `SELECT n.nspowner::regrole::text AS owner, (SELECT COALESCE(array_agg(a.grantee::regrole::text||':'||a.privilege_type ORDER BY 1),'{}') FROM aclexplode(n.nspacl) a WHERE a.grantee<>n.nspowner) AS grants FROM pg_namespace n WHERE n.nspname='${schema}'`,
    );
    assert.equal(schemaAcl[0].owner, workRoles.owner, schema);
    assert.deepEqual(
      [...schemaAcl[0].grants].sort(),
      schemaUsage[schema].map((role) => role + ":USAGE").sort(),
      schema,
    );
    for (const [table, spec] of Object.entries(tables)) {
      // S2 and S3.
      const [t] = rows(
        `SELECT relrowsecurity, relforcerowsecurity, relowner::regrole::text AS owner FROM pg_class WHERE oid='${schema}.${table}'::regclass`,
      );
      assert.ok(t.relrowsecurity && t.relforcerowsecurity && t.owner === workRoles.owner, table);
      checkPolicies(schema, table, spec);
      if (!["vault_platform", "platform", "platform_readable"].includes(spec.class)) {
        const fks = rows(
          `SELECT c.confrelid::regclass::text AS parent,(SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS columns FROM pg_constraint c WHERE c.conrelid='${schema}.${table}'::regclass AND c.contype='f'`,
        );
        for (const parent of spec.parents)
          assert.ok(
            fks.some(
              (fk) =>
                fk.parent === parent &&
                fk.columns[0] === "organization_id" &&
                fk.columns[1] === "workspace_id",
            ),
            table + " -> " + parent,
          );
      }
      // S4, from the table's S7 spec: the command role holds exactly its table privileges
      // and column UPDATEs, the api role reads exactly its columns, and nobody else holds
      // anything (no DELETE or TRUNCATE for anyone).
      const acl = rows(
        `SELECT a.grantee::regrole::text AS grantee, a.privilege_type FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid='${schema}.${table}'::regclass AND a.grantee<>c.relowner`,
      );
      assert.deepEqual(
        acl.map((a) => a.grantee + ":" + a.privilege_type).sort(),
        spec.commandPrivileges.map((privilege) => workRoles.command + ":" + privilege).sort(),
        table,
      );
      // Every column with an ACL, system columns included (a grant on ctid or xmin, or to
      // PUBLIC, shows up as an unexpected grantee or column); a dropped column's ACL is
      // cleared, so it never appears.
      const columns = rows(
        `SELECT a.grantee::regrole::text AS grantee, a.privilege_type, t.attname FROM pg_attribute t, aclexplode(t.attacl) a WHERE t.attrelid='${schema}.${table}'::regclass AND t.attacl IS NOT NULL`,
      );
      const granted = {};
      for (const c of columns) (granted[c.grantee + ":" + c.privilege_type] ??= []).push(c.attname);
      const expected = {};
      if (spec.apiColumns.length) expected[workRoles.api + ":SELECT"] = spec.apiColumns;
      if (spec.commandColumnUpdates.length)
        expected[workRoles.command + ":UPDATE"] = spec.commandColumnUpdates;
      assert.deepEqual(
        Object.fromEntries(Object.entries(granted).map(([key, names]) => [key, names.sort()])),
        Object.fromEntries(
          Object.entries(expected).map(([key, names]) => [key, [...names].sort()]),
        ),
        table,
      );
    }
    // S5: functions.
    const fns = rows(
      `SELECT regexp_replace(p.oid::regprocedure::text,'^${schema}\\.','') AS signature, p.prosecdef, p.proowner::regrole::text AS owner, p.proconfig, p.proacl IS NOT NULL AS acl, pg_get_function_identity_arguments(p.oid) AS arguments, (SELECT COALESCE(array_agg(a.grantee::regrole::text ORDER BY 1),'{}') FROM aclexplode(p.proacl) a WHERE a.grantee<>0 AND a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS grantees, (SELECT count(*) FROM aclexplode(p.proacl) a WHERE a.grantee=0)::int AS public FROM pg_proc p WHERE p.pronamespace='${schema}'::regnamespace`,
    );
    assert.deepEqual(names(fns.map((f) => f.signature)), names(Object.keys(functions)), schema);
    for (const f of fns) {
      const spec = functions[f.signature];
      assert.ok(f.acl && f.public === 0, "no PUBLIC EXECUTE " + f.signature);
      assert.deepEqual([...f.grantees].sort(), spec.grantees, f.signature);
      assert.ok(
        (f.proconfig ?? []).some((c) => c.startsWith("search_path=pg_catalog")),
        "search_path " + f.signature,
      );
      const definer = definerKinds.includes(spec.kind);
      assert.equal(f.prosecdef, definer, f.signature);
      assert.equal(f.owner, definer ? workRoles.command : workRoles.owner, f.signature);
      if (definer)
        for (const name of f.arguments
          .split(", ")
          .filter(Boolean)
          .map((a) => a.split(" ")[0]))
          assert.ok(
            (spec.tenantParameters ?? []).includes(name) ||
              !/organization|workspace|actor|membership|principal/.test(name),
            f.signature + " " + name,
          );
    }
  }
  // Every function an executor login may execute, in any schema, is exactly its list; it
  // holds no table, column, sequence or schema privilege beyond USAGE on those schemas
  // (listed by name: morrow_vault_broker holds two since M5 PR-1).
  for (const [login, allowed] of Object.entries(executorLogins)) {
    const executable = rows(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'morrow\\_%' AND has_function_privilege('${login}',p.oid,'EXECUTE')`,
    );
    assert.deepEqual(names(executable.map((f) => f.signature)), names(allowed), login);
    const [privileges] = rows(
      `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'morrow\\_%' AND (has_table_privilege('${login}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege('${login}',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))::int AS tables, (SELECT COALESCE(array_agg(n.nspname::text ORDER BY n.nspname::text COLLATE "C"),'{}') FROM pg_namespace n WHERE n.nspname LIKE 'morrow\\_%' AND has_schema_privilege('${login}',n.oid,'USAGE')) AS schemas, (SELECT count(*) FROM pg_namespace n WHERE n.nspname LIKE 'morrow\\_%' AND has_schema_privilege('${login}',n.oid,'CREATE'))::int AS creates`,
    );
    assert.equal(privileges.tables, 0, login);
    assert.equal(privileges.creates, 0, login);
    assert.deepEqual(
      privileges.schemas,
      [...new Set(allowed.map((signature) => signature.split(".")[0]))].sort(),
      login,
    );
  }
  recordConformance("S7", true);
});

// M2 PR-1 (P09.T05a; mvp-architecture §11): every table of the four schemas, morrow_identity
// included, declares its content class (the registry equals the live catalog), and every
// store-content table has exactly one cleanup handler in packages/work/src/redaction.ts.
test("S8: content classes and the store-content cleanup handlers", () => {
  const live = new Set(
    db
      .rows(
        `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN (${contentSchemas.map((schema) => `'${schema}'`).join(",")})`,
      )
      .map((r) => r.name),
  );
  assert.ok([...live].some((name) => name === "morrow_identity.linking_candidates"));
  assert.deepEqual(
    registeredTables()
      .map(([name]) => name)
      .sort(),
    [...live].sort(),
  );
  assert.deepEqual(contentProblems(), []);
  recordConformance("S8", true);
});
