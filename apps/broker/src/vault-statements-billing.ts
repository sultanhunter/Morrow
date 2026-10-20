// M5 PR-1: the vault login's fixed billing statements (migration 0027). One frozen map per
// PR, spread into vault.ts's vaultStatements registry, the only statements the vault
// transport (vault-database.ts) sends. Each calls one SECURITY DEFINER function that only
// morrow_vault_broker may execute; values travel as text parameters, and an absent
// optional value is the empty string, which the statement turns into NULL.
export const billingVaultStatements = Object.freeze({
  stripeOpBegin:
    "SELECT outcome,purpose,status,request_digest,params,provider_object_id,created_at_ms FROM morrow_billing.stripe_op_begin($1)",
  stripeOpSettle:
    "SELECT morrow_billing.stripe_op_settle($1,$2,NULLIF($3,''),NULLIF($4,'')) AS outcome",
  stripeReceiptRecord:
    "SELECT outcome,receipt_id,attributed,object_digest FROM morrow_billing.stripe_receipt_record($1,$2,$3,$4,$5,$6,$7,$8,$9)",
} as const);
