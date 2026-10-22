// M3 PR-2: the vault login's fixed model-gateway statements (migration listings-runs). One
// frozen map per PR, spread into vault.ts's vaultStatements registry, the only statements the
// vault transport (vault-database.ts) sends. Each selects every column of one SECURITY
// DEFINER function that only morrow_vault_broker may execute; values travel as text
// parameters, and an absent optional value is the empty string, which the statement turns
// into NULL.
export const modelVaultStatements = Object.freeze({
  modelCallBegin:
    "SELECT outcome,call_id,catalogue_version,model_key,effort_key,provider_model_id,max_input_tokens,product_id,snapshot_digest,request_digest,fields,recorded_outcome,input_tokens,output_tokens FROM morrow_vault.model_call_begin($1,$2,$3,$4,$5,$6,$7,$8)",
  modelCallEnd:
    "SELECT outcome,recorded_outcome,booked_usd,overflow::text AS overflow FROM morrow_vault.model_call_end($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),NULLIF($9,''),NULLIF($10,''))",
} as const);
