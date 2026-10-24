// Build order PR 7: the vault login's fixed runtime-ledger statements (migration 0043; PR 8's
// 0047 below). One frozen map per PR, spread into vault.ts's vaultStatements registry, the
// only statements the vault transport (vault-database.ts) sends. Each selects every column of
// one SECURITY DEFINER function that only morrow_vault_broker may execute; values travel as
// text parameters, and an absent optional value is the empty string, which the statement
// turns into NULL.
export const runtimeVaultStatements = Object.freeze({
  runtimeOperationBegin:
    "SELECT outcome,operation_id,deadline_at FROM morrow_vault.runtime_operation_begin($1,$2,$3,$4,$5)",
  runtimeOperationCreated:
    "SELECT outcome,status FROM morrow_vault.runtime_operation_created($1,$2)",
  runtimeOperationSettle:
    "SELECT outcome,status FROM morrow_vault.runtime_operation_settle($1,$2,NULLIF($3,''))",
  // Build order PR 8 (migration 0047): the sweep's list also says which open operations a
  // stop, an ended lease or an expired one has cut off (`stopped`), so the sweep kills their
  // sandboxes at once; and the sandbox's envd token as a vault record, stored once while the
  // operation is `created` and opened for each call to the sandbox (the operation's
  // settlement destroys it).
  runtimeOperationsOpen:
    "SELECT operation_id,provider,sandbox_ref,status,deadline_at,stale::text AS stale,past_grace::text AS past_grace,stopped::text AS stopped FROM morrow_vault.runtime_operations_open($1)",
  runtimeTokenPut: "SELECT outcome FROM morrow_vault.runtime_token_put($1,$2,$3,$4)",
  runtimeTokenGet:
    "SELECT outcome,kek_version,wrapped_key,sealed_value FROM morrow_vault.runtime_token_get($1)",
} as const);
