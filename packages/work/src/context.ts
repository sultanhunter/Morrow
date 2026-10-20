import type { Core_ActorRef, Current_Grant, Current_ResourceRef } from "@morrow/contracts";
import { validateCurrentDefinition, validateDefinition } from "@morrow/contracts/validation";
import type { WorkTx } from "./connection.js";

/**
 * The session's workspace resource, the resource of every work request: storeless, so it
 * is also a v1 ResourceRef (Proposal@2's scope names it).
 */
export type WorkspaceResource = Current_ResourceRef & {
  readonly storeId: null;
  readonly connectionId: null;
  readonly kind: "workspace";
};
// The authority snapshot of one request, resolved by morrow_work.enter_context()
// from the session digest. It is server-side data only: grants never reach a client.
export interface WorkAuthority {
  readonly actor: Core_ActorRef;
  readonly policyRevision: number;
  readonly grants: readonly Current_Grant[];
  readonly databaseNowMs: number;
  readonly resource: WorkspaceResource;
}
export class WorkContextUnavailable extends Error {
  constructor() {
    super("WORK_CONTEXT_UNAVAILABLE");
    this.name = "WorkContextUnavailable";
  }
}

const id = (value: unknown): value is string =>
  typeof value === "string" && validateDefinition("core", "Id", value);
const keys = [
  "database_now_us",
  "grant_count",
  "grants",
  "grants_digest",
  "membership_id",
  "organization_id",
  "policy_revision",
  "principal_id",
  "workspace_id",
].join(",");

/**
 * Decodes trusted grant rows: at most 1000, each a valid current Grant (v1.1: its scope may
 * name the store resource, ADR-0022 item 2; every v1 grant is one), unique by id.
 */
export function decodeGrants(text: unknown, count: unknown): readonly Current_Grant[] | "overflow" {
  if (typeof count !== "string" || !/^(0|[1-9][0-9]{0,4})$/.test(count))
    throw new WorkContextUnavailable();
  if (Number(count) > 1000) return "overflow";
  if (typeof text !== "string") throw new WorkContextUnavailable();
  let grants: unknown;
  try {
    grants = JSON.parse(text);
  } catch {
    throw new WorkContextUnavailable();
  }
  if (
    !Array.isArray(grants) ||
    grants.length !== Number(count) ||
    !grants.every((g) => validateCurrentDefinition("Grant", g)) ||
    new Set(grants.map((g: Current_Grant) => g.id)).size !== grants.length
  )
    throw new WorkContextUnavailable();
  return Object.freeze(grants as Current_Grant[]);
}

export async function enterWorkContext(
  tx: WorkTx,
  sessionDigest: string,
  workspaceId: string,
): Promise<WorkAuthority | "ineligible" | "grant_overflow"> {
  if (!/^[a-f0-9]{64}$/.test(sessionDigest) || !id(workspaceId)) return "ineligible";
  const rows = await tx.run("enterContext", [sessionDigest, workspaceId]);
  if (rows.length === 0) return "ineligible";
  const row = rows[0];
  if (rows.length !== 1 || !row || Object.keys(row).sort().join(",") !== keys)
    throw new WorkContextUnavailable();
  if (
    !id(row.principal_id) ||
    !id(row.organization_id) ||
    !id(row.membership_id) ||
    row.workspace_id !== workspaceId ||
    typeof row.policy_revision !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(row.policy_revision) ||
    !Number.isSafeInteger(Number(row.policy_revision)) ||
    typeof row.grants_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.grants_digest) ||
    typeof row.database_now_us !== "string" ||
    !/^[1-9][0-9]{0,17}$/.test(row.database_now_us)
  )
    throw new WorkContextUnavailable();
  const grants = decodeGrants(row.grants, row.grant_count);
  if (grants === "overflow") return "grant_overflow";
  const databaseNowMs = Number(BigInt(row.database_now_us) / 1000n);
  if (!Number.isSafeInteger(databaseNowMs)) throw new WorkContextUnavailable();
  const actor: Core_ActorRef = Object.freeze({
    kind: "human",
    principalId: row.principal_id,
    organizationId: row.organization_id,
    workspaceId,
    membershipId: row.membership_id,
    installationId: null,
    mandateId: null,
  });
  const resource: WorkspaceResource = Object.freeze({
    organizationId: row.organization_id,
    workspaceId,
    storeId: null,
    connectionId: null,
    kind: "workspace",
    id: workspaceId,
  });
  if (
    !validateDefinition("core", "ActorRef", actor) ||
    !validateCurrentDefinition("ResourceRef", resource)
  )
    throw new WorkContextUnavailable();
  return Object.freeze({
    actor,
    policyRevision: Number(row.policy_revision),
    grants,
    databaseNowMs,
    resource,
  });
}
