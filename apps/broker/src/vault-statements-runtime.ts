// Build order PR 7: the vault login's fixed runtime-ledger statements (migration 0043). One
// frozen map per PR, spread into vault.ts's vaultStatements registry, the only statements the
// vault transport (vault-database.ts) sends. Each selects every column of one SECURITY
// DEFINER function that only morrow_vault_broker may execute; values travel as text
// parameters, and an absent optional value is the empty string, which the statement turns
// into NULL.
export const runtimeVaultStatements = Object.freeze({
  runtimeOperationBegin:
    "SELECT outcome,operation_id,deadline_at FROM morrow_vault.runtime_operation_begin($1,$2,$3,$4,$5)",
  runtimeOperationCreated:
    "SELECT outcome,status FROM morrow_vault.runtime_operation_created($1,$2)",
  runtimeOperationSettle:
    "SELECT outcome,status FROM morrow_vault.runtime_operation_settle($1,$2,NULLIF($3,''))",
  runtimeOperationsOpen:
    "SELECT operation_id,provider,sandbox_ref,status,deadline_at,stale::text AS stale,past_grace::text AS past_grace FROM morrow_vault.runtime_operations_open($1)",
} as const);
