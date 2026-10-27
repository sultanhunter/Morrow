// Plan row SD5 (migration shopify-query-cost): the vault login's fixed statements for the
// per-shop buckets of Shopify's API query cost (Shopify's rate limit, never money). One frozen
// map, spread into vault.ts's vaultStatements registry, the only statements the vault
// transport (vault-database.ts) sends. Each selects every column of one SECURITY DEFINER
// function that only morrow_vault_broker may execute; values travel as text parameters, and
// an absent value is the empty string, which the statement turns into NULL.
export const queryCostVaultStatements = Object.freeze({
  shopifyQueryCostTake:
    "SELECT outcome,wait_ms FROM morrow_vault.shopify_query_cost_take($1,$2,$3)",
  shopifyQueryCostSettle:
    "SELECT morrow_vault.shopify_query_cost_settle($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),$7) AS outcome",
} as const);
