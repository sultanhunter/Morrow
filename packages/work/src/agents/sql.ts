// Every statement the agents routes send (M3 PR-1; migrations listings-authority and
// agent-proposals), merged into workStatements so WorkTx.run accepts no other text. Source
// fixed: values travel only as bind parameters, and every selected column is text.

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const installationColumns = `i.id::text AS id,i.revision::text AS revision,i.store_id::text AS store_id,i.connection_id::text AS connection_id,i.agent_principal_id::text AS agent_principal_id,i.owner_principal_id::text AS owner_principal_id,i.owner_membership_id::text AS owner_membership_id,i.status,i.release_id,i.release_revision::text AS release_revision,i.release_digest::text AS release_digest,i.scope::text AS scope,${utc("i.updated_at")} AS updated_at`;

export const agentStatements = Object.freeze({
  beginAgentCommand:
    "SELECT outcome,aggregate_type,aggregate_id,result FROM morrow_work.begin_agent_command($1,$2,$3)",
  storeAssociation:
    "SELECT store_id,connection_id,database_now FROM morrow_work.store_association($1)",
  agentEnableDocument:
    "SELECT id,purpose,store_id,connection_id,installation_id,canonical,expires_at,consumed::text AS consumed FROM morrow_work.agent_enable_document($1)",
  cmdListingsEnableDocument:
    "SELECT outcome,result FROM morrow_work.cmd_listings_enable_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
  cmdListingsEnable:
    "SELECT outcome,result FROM morrow_work.cmd_listings_enable($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
  cmdStopAiWork: "SELECT outcome,result FROM morrow_work.cmd_stop_ai_work($1,$2,$3,$4,$5,$6,$7)",
  cmdModelDefaultRevise:
    "SELECT outcome,result FROM morrow_work.cmd_model_default_revise($1,$2,$3,$4,$5,$6,$7,$8)",
  // The store's Listings installation that is not uninstalled (tenant_read), if any.
  listingsInstallation: `SELECT ${installationColumns} FROM morrow_work.agent_installations i WHERE i.store_id=$1::text AND i.release_id='morrow.listings' AND i.status<>'uninstalled'`,
  // The installation's open stop (tenant_read), if any: who set it, why and when.
  installationStop: `SELECT s.id::text AS id,s.set_by_kind,s.reason_code,s.kill_switch_record_id::text AS kill_switch_record_id,${utc("s.created_at")} AS created_at FROM morrow_work.stop_controls s WHERE s.scope='installation' AND s.target_id=$1::text AND s.lifted_at IS NULL`,
  // The open platform stop and the connection's open stop (tenant_read shows platform rows
  // in every tenant): whether a stop outside the installation blocks its AI work.
  storeStops: `SELECT s.scope FROM morrow_work.stop_controls s WHERE s.lifted_at IS NULL AND (s.scope='platform' OR (s.scope='connection' AND s.target_id=$1::text))`,
  // The workspace's model default (tenant_read), if any.
  workspaceModelDefault: `SELECT d.catalogue_version::text AS catalogue_version,d.model_key,d.effort_key,d.max_credits_per_product::text AS max_credits_per_product,d.revision::text AS revision,${utc("d.updated_at")} AS updated_at FROM morrow_work.workspace_model_defaults d`,
} as const);
export type AgentStatementName = keyof typeof agentStatements;
