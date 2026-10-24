// Every statement the review and apply routes send (v1 PR 3; migrations catalog-review and
// catalog-apply), merged into workStatements so WorkTx.run accepts no other text. Source
// fixed: values travel only as bind parameters, and every selected column is text. The
// reads run as morrow_work_api under the tenant_read policies and column grants: never a
// provider id, a credential or a product's content outside the review sources' definer.

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const operationColumns = `o.id::text AS id,o.revision::text AS revision,o.task_id::text AS task_id,o.store_id::text AS store_id,o.connection_id::text AS connection_id,o.target_index::text AS target_index,o.target_resource_id::text AS product_id,o.proposal_id::text AS proposal_id,o.approval_id::text AS approval_id,o.approval_revision::text AS approval_revision,o.claim_family_root_id::text AS family_root_id,o.status,o.uncertainty_reason,o.attempt::text AS attempt,${utc("o.send_started_at")} AS send_started_at,${utc("o.submitted_at")} AS submitted_at,${utc("o.created_at")} AS created_at,${utc("o.updated_at")} AS updated_at,(SELECT t.reason FROM morrow_work.operation_transitions t WHERE t.organization_id=o.organization_id AND t.workspace_id=o.workspace_id AND t.operation_id=o.id AND t.revision=(SELECT max(t2.revision) FROM morrow_work.operation_transitions t2 WHERE t2.organization_id=o.organization_id AND t2.workspace_id=o.workspace_id AND t2.operation_id=o.id AND t2.to_status=o.status)) AS reason,(SELECT r.verdict FROM morrow_work.operation_readbacks r WHERE r.organization_id=o.organization_id AND r.workspace_id=o.workspace_id AND r.operation_id=o.id ORDER BY r.sequence DESC LIMIT 1) AS verdict`;

export const reviewStatements = Object.freeze({
  // The "before" side of one catalog proposal's review (catalog-review): per target, the
  // snapshot its draft was made from, or expired, or redacted.
  catalogReviewSources:
    "SELECT target_index,product_id,state,snapshot FROM morrow_work.catalog_review_sources($1)",
  // The one claim of a review family, ids only.
  catalogClaimOf:
    "SELECT approval_id,proposal_id,claimant_principal_id,claimant_membership_id,consumer,consumer_command_id,claimed_at FROM morrow_work.catalog_claim_of($1)",
  // The reviewer flags (counts only) of the drafts a run packed into one proposal.
  draftFlagsOfProposal:
    "SELECT d.product_id,d.flags::text AS flags FROM morrow_work.run_drafts d WHERE d.proposal_id=$1::text ORDER BY d.product_index",
  // The claim (catalog-apply): the approval's exact values, the counted reviewers and the
  // Worker's items; and one operation's dispatch check.
  cmdCatalogApply:
    "SELECT outcome,result FROM morrow_work.cmd_catalog_apply($1,$2,$3,$4,$5,$6,$7,$8,$9)",
  cmdCatalogDispatch:
    "SELECT outcome,status,revision,reason FROM morrow_work.cmd_catalog_dispatch($1,$2)",
  // The claimant sets an uncertain operation aside (uncertain -> cancel_requested).
  cmdCatalogSetAside: "SELECT outcome,status,revision FROM morrow_work.cmd_catalog_set_aside($1)",
  // Catalog operations of the session tenant (tenant_read), with the reason of their current
  // status and their latest read-back verdict: codes only.
  operationById: `SELECT ${operationColumns} FROM morrow_work.operations o WHERE o.id=$1::text AND o.kind='catalog_write'`,
  operationsOfFamily: `SELECT ${operationColumns} FROM morrow_work.operations o WHERE o.claim_family_root_id=$1::text AND o.kind='catalog_write' ORDER BY o.target_index`,
  operationsOfTask: `SELECT ${operationColumns} FROM morrow_work.operations o WHERE o.task_id=$1::text AND o.kind='catalog_write' ORDER BY o.created_at DESC,o.target_index LIMIT 100`,
  // One operation's history: its transitions and read-backs (codes and times only).
  operationTransitions: `SELECT t.revision::text AS revision,t.from_status,t.to_status,t.reason,${utc("t.occurred_at")} AS occurred_at FROM morrow_work.operation_transitions t WHERE t.operation_id=$1::text ORDER BY t.revision`,
  operationReadbacks: `SELECT r.sequence::text AS sequence,${utc("r.observed_at")} AS observed_at,r.outcome,r.verdict,r.field_verdicts::text AS field_verdicts FROM morrow_work.operation_readbacks r WHERE r.operation_id=$1::text ORDER BY r.sequence DESC LIMIT 20`,
} as const);
export type ReviewStatementName = keyof typeof reviewStatements;
