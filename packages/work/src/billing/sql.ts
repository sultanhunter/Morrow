// The api's billing statements (M5 PR-1; migration 0027), merged into workStatements so
// WorkTx.run accepts no other text. Source-fixed: values travel only as bind parameters,
// every selected column is text. The session reads run as morrow_work_api under the
// tenant_read policies and column grants; the commands and the receipt ingress call the
// morrow_billing definers.

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const billingStatements = Object.freeze({
  // The current terms revision with its offers (platform_api_read).
  billingTermsLatest:
    "SELECT t.terms_revision::text AS terms_revision,t.terms::text AS terms,t.offers::text AS offers,t.digest::text AS digest FROM morrow_billing.billing_terms t ORDER BY t.terms_revision DESC LIMIT 1",
  // The session workspace's store associations, through the identity bridge.
  billingAssociations:
    'SELECT a.installation_id,a.store_id,a.connection_id,a.status,a.linked_at FROM morrow_billing.workspace_associations() a ORDER BY a.linked_at,a.installation_id COLLATE "C" LIMIT 101',
  // $1 is the session workspace.
  billingAccount:
    "SELECT a.organization_id::text AS organization_id,a.workspace_id::text AS workspace_id,a.id::text AS id,a.route,a.mode,a.currency,a.status,a.revision::text AS revision FROM morrow_billing.billing_accounts a WHERE a.workspace_id=$1::text AND a.route='morrow_direct'",
  // $1 workspace, $2 billing account.
  billingSnapshotLatest: `SELECT s.organization_id::text AS organization_id,s.workspace_id::text AS workspace_id,s.billing_account_id::text AS billing_account_id,s.revision::text AS revision,s.route,s.mode,s.subscription_key,s.status,s.provider_evidence_ref::text AS provider_evidence_ref,${utc("s.verified_at")} AS verified_at,${utc("s.valid_until")} AS valid_until FROM morrow_billing.entitlement_snapshots s WHERE s.workspace_id=$1::text AND s.billing_account_id=$2::text ORDER BY s.revision DESC LIMIT 1`,
  billingWallet:
    "SELECT w.organization_id::text AS organization_id,w.workspace_id::text AS workspace_id,w.billing_account_id::text AS billing_account_id,w.available::text AS available,w.reserved::text AS reserved,w.consumed::text AS consumed,w.rate_revision::text AS rate_revision,w.terms_revision::text AS terms_revision,w.revision::text AS revision FROM morrow_billing.credit_wallets w WHERE w.workspace_id=$1::text AND w.billing_account_id=$2::text",
  // Open conflicts (R7): one per (route, subscription), the latest code.
  billingConflicts:
    "SELECT DISTINCT ON (v.subscription_key) v.route,v.subscription_key,v.outcome_code AS code FROM morrow_billing.verified_payment_events v WHERE v.workspace_id=$1::text AND v.outcome='conflict' ORDER BY v.subscription_key,v.recorded_at DESC,v.id::text COLLATE \"C\" DESC LIMIT 101",
  // The workspace's open or completed checkout intent, if any (§8.7).
  billingIntentCurrent: `SELECT i.id::text AS id,i.status,i.price_key,${utc("i.expires_at")} AS expires_at FROM morrow_billing.checkout_intents i WHERE i.workspace_id=$1::text AND i.status IN ('open','completed')`,
  // The billing period: the line period of the latest granted subscription invoice.
  billingPeriodLatest: `SELECT ${utc("v.period_start")} AS period_start,${utc("v.period_end")} AS period_end FROM morrow_billing.verified_payment_events v WHERE v.workspace_id=$1::text AND v.outcome='granted' AND v.kind='subscription_period' ORDER BY v.period_end DESC,v.recorded_at DESC LIMIT 1`,
  cmdCheckoutOpen: "SELECT outcome,result FROM morrow_billing.cmd_checkout_open($1,$2,$3,$4,$5,$6)",
  cmdPortalOpen: "SELECT outcome,result FROM morrow_billing.cmd_portal_open($1,$2,$3)",
  // The receipt-only ingress (sessionless: no enter_context in its transaction).
  receiptBegin: "SELECT outcome,facts FROM morrow_billing.receipt_begin($1,$2)",
  receiptApply: "SELECT outcome,result FROM morrow_billing.receipt_apply($1,$2,$3)",
  receiptStatus: "SELECT outcome,result FROM morrow_billing.receipt_status($1)",
} as const);
export type BillingStatementName = keyof typeof billingStatements;
