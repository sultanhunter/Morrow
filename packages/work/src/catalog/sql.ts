// The statement the catalogue routes send beside the agents routes' store association (M2
// PR-3; migration shopify-privacy-work), merged into workStatements so WorkTx.run accepts no
// other text. Source fixed: values travel only as bind parameters; every column is text.
export const catalogStatements = Object.freeze({
  catalogReadLease:
    "SELECT outcome,lease_id,generation,expires_at_ms,subject_id FROM morrow_work.catalog_read_lease($1,$2)",
} as const);
