// Every statement the runs routes send (M3 PR-2; migration listings-runs), merged into
// workStatements so WorkTx.run accepts no other text. Source fixed: values travel only as
// bind parameters, and every selected column is text. The reads run as morrow_work_api under
// the tenant_read policies and column grants: never a provider id, a raw stop reason, a
// snapshot or a draft's content.

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const runColumns = `r.id::text AS id,r.revision::text AS revision,r.task_id::text AS task_id,r.child_task_id::text AS child_task_id,r.store_id::text AS store_id,r.installation_id::text AS installation_id,r.status,r.ended_reason,r.catalogue_version::text AS catalogue_version,r.model_key,r.effort_key,r.credits_per_product::text AS credits_per_product,r.product_count::text AS product_count,to_jsonb(r.fields)::text AS fields,r.products_drafted::text AS products_drafted,r.products_failed::text AS products_failed,r.requester_principal_id::text AS requester_principal_id,${utc("r.created_at")} AS created_at,${utc("r.started_at")} AS started_at,${utc("r.ended_at")} AS ended_at,${utc("r.updated_at")} AS updated_at`;

export const runStatements = Object.freeze({
  beginRunCommand:
    "SELECT outcome,aggregate_type,aggregate_id,result FROM morrow_work.begin_run_command($1,$2,$3)",
  cmdRunAdmit:
    "SELECT outcome,result FROM morrow_work.cmd_run_admit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)",
  cmdRunsReconcile: "SELECT outcome,result FROM morrow_work.cmd_runs_reconcile($1,$2,$3)",
  runInterrupted: "SELECT morrow_work.run_interrupted($1)::text AS interrupted",
  // One run of the session tenant (tenant_read), its credits and its usage summary.
  runById: `SELECT ${runColumns},c.credits_reserved::text AS credits_reserved,c.credits_settled::text AS credits_settled,c.status AS credit_status,m.attempts::text AS attempts,m.input_tokens::text AS input_tokens,m.output_tokens::text AS output_tokens FROM morrow_work.runs r LEFT JOIN morrow_billing.credit_reservations c ON c.organization_id=r.organization_id AND c.workspace_id=r.workspace_id AND c.root_run_id=r.id LEFT JOIN morrow_work.run_manifests m ON m.organization_id=r.organization_id AND m.workspace_id=r.workspace_id AND m.run_id=r.id WHERE r.id=$1::text`,
  // The run's products in route order, with their drafts' proposals and reviewer flags.
  runProductsOfRun: `SELECT p.product_index::text AS product_index,p.product_id,p.status,p.attempts::text AS attempts,p.failure_code,d.proposal_id::text AS proposal_id,d.flags::text AS flags FROM morrow_work.run_products p LEFT JOIN morrow_work.run_drafts d ON d.organization_id=p.organization_id AND d.workspace_id=p.workspace_id AND d.run_id=p.run_id AND d.product_index=p.product_index WHERE p.run_id=$1::text ORDER BY p.product_index`,
  // A task's runs, newest first, at most 20.
  runsOfTask: `SELECT ${runColumns} FROM morrow_work.runs r WHERE r.task_id=$1::text ORDER BY r.created_at DESC,r.id::text COLLATE "C" DESC LIMIT 20`,
} as const);
export type RunStatementName = keyof typeof runStatements;
