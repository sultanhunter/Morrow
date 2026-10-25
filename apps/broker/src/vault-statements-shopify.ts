// M2 PR-2: the vault login's fixed Shopify statements (migration 0027; M2 PR-3: 0037). One frozen map per
// PR, spread into vault.ts's vaultStatements registry, the only statements the vault
// transport (vault-database.ts) sends. Each selects every column of one SECURITY DEFINER
// function that only morrow_vault_broker may execute; values travel as text parameters.
export const shopifyVaultStatements = Object.freeze({
  shopifyLaunchContext:
    "SELECT outcome,client_id,workspace_id,installation FROM morrow_vault.shopify_launch_context($1,$2)",
  shopifyCallbackClaim:
    "SELECT outcome,shop_digest,client_id FROM morrow_vault.shopify_callback_claim($1,$2)",
  shopifyInstallPrepare:
    "SELECT outcome,organization_id,workspace_id,installation_id,store_id,connection_id,credential_id,credential_version FROM morrow_vault.shopify_install_prepare($1,$2,$3,$4)",
  shopifyInstallStore:
    "SELECT outcome,workspace_id,continuation FROM morrow_vault.shopify_install_store($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
  // M2 PR-3 (migration 0037): the webhook record, the token's destruction and the read
  // resolution. An absent product id is the empty string, which the statement turns into NULL.
  shopifyWebhookRecord:
    "SELECT outcome,inbox_id,settled FROM morrow_vault.shopify_webhook_record($1,$2,$3,$4,$5,$6)",
  shopifyCredentialDestroy: "SELECT morrow_vault.shopify_credential_destroy($1,$2) AS outcome",
  shopifyReadResolve:
    "SELECT outcome,organization_id,workspace_id,lease_kind,store_id,connection_id,installation_id,shop_domain,credential_id,credential_version,kek_version,wrapped_key,sealed_value FROM morrow_vault.shopify_read_resolve($1,$2,$3,$4,NULLIF($5,''))",
  // v1 PR 1 (migration shopify-live-store-vault; ADR-0035 item 2): whether the app may
  // install a store that is not a development store (only the marked app's own shop).
  shopifyLiveStoreAdmission: "SELECT morrow_vault.shopify_live_store_admission($1,$2) AS outcome",
  // Shop-specific webhook subscriptions (migration shopify-webhook-registrations-vault): the
  // pending ids, one installation's target with its token's envelope, and the outcome record
  // (an absent subscription id is the empty string, which the statement turns into NULL).
  shopifyWebhookRegistrationsPending:
    "SELECT installation_id FROM morrow_vault.shopify_webhook_registrations_pending()",
  shopifyWebhookTarget:
    "SELECT outcome,organization_id,workspace_id,app_key,shop_domain,credential_id,credential_version,kek_version,wrapped_key,sealed_value FROM morrow_vault.shopify_webhook_target($1)",
  shopifyWebhookRegistrationRecord:
    "SELECT morrow_vault.shopify_webhook_registration_record($1,$2,$3,NULLIF($4,''),NULLIF($5,'')) AS outcome",
} as const);
