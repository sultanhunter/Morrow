// The api's reads of the M2 PR-1 spine tables (migration 0020), merged into
// workStatements so WorkTx.run accepts no other text. Source-fixed SELECTs run as
// morrow_work_api under the tenant_read policies and column grants; values travel only
// as bind parameters and every selected column is text.

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const stopRecordColumns = `r.id::text AS id,r.stop_control_id::text AS stop_control_id,r.action,r.scope,r.organization_id::text AS organization_id,r.workspace_id::text AS workspace_id,r.store_id::text AS store_id,r.target_id::text AS target_id,r.actor_kind,r.operator_id::text AS operator_id,r.reason_code,r.reason,${utc("r.recorded_at")} AS recorded_at`;
const activeStopColumns = `s.id::text AS id,s.scope,s.organization_id::text AS organization_id,s.workspace_id::text AS workspace_id,s.store_id::text AS store_id,s.target_id::text AS target_id,s.set_by_kind,s.reason_code,${utc("s.created_at")} AS created_at`;

export const spineStatements = Object.freeze({
  // The workspace's billing route row (tenant_read); $1 is the authority's workspace.
  workspaceBillingRoute: `SELECT r.organization_id::text AS organization_id,r.workspace_id::text AS workspace_id,r.origin,${utc("r.shopify_bound_at")} AS shopify_bound_at,r.route,r.mode,${utc("r.route_fixed_at")} AS route_fixed_at,r.fixing_payment_key,r.revision::text AS revision FROM morrow_billing.workspace_billing_routes r WHERE r.workspace_id=$1::text`,
  // Active stops visible to the tenant: its own and the platform's (tenant_read), at most
  // 100, oldest first.
  activeStops: `SELECT ${activeStopColumns} FROM morrow_work.stop_controls s WHERE s.lifted_at IS NULL ORDER BY s.created_at,s.id::text COLLATE "C" LIMIT 100`,
  // The StopRecord@1 rows of one stop control (set, then lift).
  stopRecordsOfControl: `SELECT ${stopRecordColumns} FROM morrow_work.stop_records r WHERE r.stop_control_id=$1::text ORDER BY r.recorded_at,r.action DESC`,
} as const);
export type SpineStatementName = keyof typeof spineStatements;
