// M2 PR-2: the vault login's fixed Shopify statements (migration 0027). One frozen map per
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
} as const);
