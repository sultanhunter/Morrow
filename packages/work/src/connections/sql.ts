// Every statement the connection routes send ("Disconnect store"; migration
// disconnect-store-work), merged into workStatements so WorkTx.run accepts no other text.
// Source fixed: values travel only as bind parameters, and every selected column is text.

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const connectionStatements = Object.freeze({
  beginConnectionCommand:
    "SELECT outcome,aggregate_type,aggregate_id,result FROM morrow_work.begin_connection_command($1,$2,$3)",
  // The session tenant's store installation of one connection, if it was ever linked here.
  connectionTarget:
    "SELECT connection_id,store_id,installation_id,status,database_now FROM morrow_work.connection_target($1)",
  // The connection's open stop (tenant_read), if any: who set it, why and when. One at most
  // (0020 stop_controls_one_per_target).
  connectionStop: `SELECT s.id::text AS id,s.set_by_kind,s.reason_code,${utc("s.created_at")} AS created_at FROM morrow_work.stop_controls s WHERE s.scope='connection' AND s.target_id=$1::text AND s.lifted_at IS NULL`,
  cmdStoreDisconnect:
    "SELECT outcome,result FROM morrow_work.cmd_store_disconnect($1,$2,$3,$4,$5,$6)",
} as const);
export type ConnectionStatementName = keyof typeof connectionStatements;
