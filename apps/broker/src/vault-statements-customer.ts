// SD4 (P09.T05c; migration customer-deletion-work): the vault login's fixed statements for the
// workspace's customer digest keys. One frozen map, spread into vault.ts's vaultStatements
// registry, the only statements the vault transport (vault-database.ts) sends. Each selects
// every column of one SECURITY DEFINER function that only morrow_vault_broker may execute;
// values travel as text parameters.
export const customerVaultStatements = Object.freeze({
  // Every kept version of the digest key of the workspace an app (registered for a shop)
  // invites, ascending; or one row "none" (the tenant, no key yet) or "not_found".
  customerDigestKeysGet:
    "SELECT outcome,organization_id,workspace_id,version,kek_version,wrapped_key,sealed_value FROM morrow_vault.customer_digest_keys_get($1,$2)",
  // Version 1 of that workspace's key, sealed by the broker under its KEK; a racing second
  // creation keeps the first ("exists").
  customerDigestKeyCreate:
    "SELECT morrow_vault.customer_digest_key_create($1,$2,$3,$4,$5) AS outcome",
} as const);
