// v1 PR 3: the vault login's fixed catalog statements (migration catalog-apply), the gateway's
// apply and read-back. One frozen map per PR, spread into vault.ts's vaultStatements registry,
// the only statements the vault transport (vault-database.ts) sends. Each selects every column
// of one SECURITY DEFINER function that only morrow_vault_broker may execute; values travel
// as text parameters, and an absent optional value is the empty string, which the statement
// turns into NULL.
export const catalogVaultStatements = Object.freeze({
  catalogWriteResolve:
    "SELECT outcome,status,reason,organization_id,workspace_id,shop_domain,product_id,fields,item,request_digest,expected_source_revision,store_installation_id,credential_id,credential_version,kek_version,wrapped_key,sealed_value FROM morrow_vault.catalog_write_resolve($1)",
  catalogWriteBegin:
    "SELECT outcome,status,reason FROM morrow_vault.catalog_write_begin($1,$2,NULLIF($3,''),NULLIF($4,''),$5)",
  catalogWriteEnd: "SELECT morrow_vault.catalog_write_end($1,$2,$3,NULLIF($4,'')) AS outcome",
  catalogReconcileResolve:
    "SELECT outcome,status,organization_id,workspace_id,shop_domain,product_id,fields,item,source,source_updated_at,store_installation_id,credential_id,credential_version,kek_version,wrapped_key,sealed_value FROM morrow_vault.catalog_reconcile_resolve($1)",
  catalogReconcileRecord:
    "SELECT outcome,status FROM morrow_vault.catalog_reconcile_record($1,$2,NULLIF($3,''),NULLIF($4,''),$5)",
  // v1 PR 4 (migration catalog-undo): the undo check's resolution and record.
  catalogUndoResolve:
    "SELECT outcome,organization_id,workspace_id,shop_domain,product_id,fields,item,source,store_installation_id,credential_id,credential_version,kek_version,wrapped_key,sealed_value FROM morrow_vault.catalog_undo_resolve($1)",
  catalogUndoRecord:
    "SELECT outcome,sequence,verdict FROM morrow_vault.catalog_undo_record($1,$2,NULLIF($3,''),NULLIF($4,''),$5)",
} as const);
