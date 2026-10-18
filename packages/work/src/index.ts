// @morrow/work: authoritative work commands and reads on the ADR-0010 tenant data
// pattern (P06.T01a). The HTTP handler and route table are in `@morrow/work/http`.
export {
  WorkOutcomeUnknown,
  WorkReject,
  WorkSqlUnavailable,
  withWorkTransaction,
  type WorkRejection,
  type WorkSqlConnection,
  type WorkSqlConnector,
  type WorkTransactionOptions,
  type WorkTx,
} from "./connection.js";
export { enterWorkContext, type WorkAuthority } from "./context.js";
export { authorizeWork, decideWork } from "./permissions.js";
export { targetEligible } from "./eligibility.js";
export { canonicalJson, workRequestDigest, type WorkCommandType } from "./digest.js";
export { createNeonWorkConnector, type WorkCredentialBroker } from "./neon-connector.js";
export { workStatements, type WorkStatementName } from "./sql.js";
