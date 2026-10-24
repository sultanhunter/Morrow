import type { Current_HumanActorRef } from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { isCurrentGrant } from "@morrow/policy";
import type { KillSwitchTargetFacts, KillSwitchTargetRequest } from "@morrow/policy/kill-switch";
import { disconnectFields } from "@morrow/policy/store-link-template";
import { storeResource, type StoreResource } from "@morrow/policy/store-resource";
import { decideOn } from "../agents/commands.js";
import { parseStopBody, type StopBody } from "../agents/bodies.js";
import { WorkReject, type WorkRejection, type WorkTx } from "../connection.js";
import { enterWorkContext, WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { canonicalJson, sha256Hex } from "../digest.js";
import type { GuardedWorkspaceRequest, WorkspaceRouteSpec } from "../http-guard.js";
import { disconnectRecord, planDisconnect } from "../stops.js";
import type { ConnectionCommandType, ConnectionRead } from "./types.js";
export type { ConnectionCommandType, ConnectionRead } from "./types.js";

// "Disconnect store" (ADR-0022 items 2, 3, 13 and 15 with the amendments of 2026-10-22,
// owner decision 8; ADR-0005): the human-only kill switch governance.connection.disconnect
// on one store connection, and the read that says whether this person may use it. Like
// "Stop AI work" (agents/commands.ts), on the existing kill-switch path:
//   1. the human kernel (packages/policy) allows `execute` on the store resource
//      {kind: store, id: S, storeId: S, connectionId: C} with the connectionId and control
//      fields (store-link template v2 gives that grant to the linking owner), and returns
//      the kill_switch_record obligation;
//   2. checkKillSwitchTarget (planDisconnect) checks the connection against the actor's
//      current execute grants: an unknown, foreign or ungranted connection is not found;
//   3. the KillSwitchRecord (its target the connection itself) and the connection stop
//      commit together in cmd_store_disconnect, which also ends the store installation
//      (suspended, `disconnected`); the definer rechecks authority under lock.
// It never reads entitlement or credits. A denial or conflict persists nothing; an unknown
// outcome is never reported as success or denial. The token's destruction is the broker's,
// after COMMIT (connections/http.ts).
type Guarded = GuardedWorkspaceRequest<WorkspaceRouteSpec>;
export interface ConnectionResult {
  readonly status: 200;
  readonly body: Readonly<Record<string, unknown>>;
  readonly outcome: string;
}
export interface PreparedConnectionCommand {
  readonly type: ConnectionCommandType;
  readonly parsed: StopBody;
  readonly digest: string;
}

/** The request digest: canonical JSON of the command, its workspace, path ids and body. */
export function connectionRequestDigest(
  type: ConnectionCommandType,
  workspaceId: string,
  connectionId: string,
  body: unknown,
): Promise<string> {
  return sha256Hex(
    canonicalJson(["morrow.work.command", 1, type, workspaceId, [connectionId], body]),
  );
}
/**
 * Step 1, with no I/O: the strict body (a KillSwitchControl a person wrote, with no source
 * proposal: the MVP has no agent proposal path) and the request digest.
 */
export async function prepareConnectionCommand(
  type: ConnectionCommandType,
  g: Guarded,
): Promise<PreparedConnectionCommand> {
  const parsed = parseStopBody(g.body);
  if (parsed === null || g.params.connectionId === undefined) throw new WorkReject("invalid");
  const digest = await connectionRequestDigest(type, g.workspaceId, g.params.connectionId, g.body);
  return Object.freeze({ type, parsed, digest });
}

/**
 * May this actor disconnect this store? governance.connection.disconnect {execute} on the
 * store resource with the request's fields, as a kill switch (kill_switch_record).
 */
export async function disconnectAllowed(a: WorkAuthority, store: StoreResource): Promise<boolean> {
  const decided = await decideOn(
    a,
    store,
    "governance.connection.disconnect",
    "execute",
    disconnectFields,
  );
  return decided.decision.allowed && decided.obligations.includes("kill_switch_record");
}

// ---------------------------------------------------------------------------
// Fixed row decoders. Any other shape is WorkContextUnavailable (a 503, never a guess).
const text = (row: Record<string, unknown>, key: string) => {
  const value = row[key];
  if (typeof value !== "string") throw new WorkContextUnavailable();
  return value;
};
const optional = (row: Record<string, unknown>, key: string) =>
  row[key] === null ? null : text(row, key);
const one = (rows: readonly Record<string, unknown>[]) => {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]) throw new WorkContextUnavailable();
  return rows[0];
};
const installationStatuses = ["linked", "suspended", "uninstalled"] as const;
type InstallationStatus = (typeof installationStatuses)[number];
interface ConnectionTarget {
  readonly connectionId: string;
  readonly storeId: string;
  readonly installationId: string;
  readonly status: InstallationStatus;
}
/** The session tenant's store installation of this connection, if it was ever linked. */
async function targetOf(tx: WorkTx, connectionId: string): Promise<ConnectionTarget | null> {
  const row = one(await tx.run("connectionTarget", [connectionId]));
  if (!row) return null;
  const status = text(row, "status");
  if (
    text(row, "connection_id") !== connectionId ||
    !(installationStatuses as readonly string[]).includes(status)
  )
    throw new WorkContextUnavailable();
  return Object.freeze({
    connectionId,
    storeId: text(row, "store_id"),
    installationId: text(row, "installation_id"),
    status: status as InstallationStatus,
  });
}
const setters = ["human", "system", "operator"] as const;
/** The connection's open stop, whoever set it (a person's disconnect, an uninstall). */
async function openStopOf(tx: WorkTx, connectionId: string) {
  const row = one(await tx.run("connectionStop", [connectionId]));
  if (!row) return null;
  const setBy = text(row, "set_by_kind");
  if (!(setters as readonly string[]).includes(setBy)) throw new WorkContextUnavailable();
  return Object.freeze({
    id: text(row, "id"),
    setBy: setBy as (typeof setters)[number],
    reasonCode: text(row, "reason_code"),
    createdAt: text(row, "created_at"),
  });
}
async function context(tx: WorkTx, g: Guarded): Promise<WorkAuthority> {
  const a = await enterWorkContext(tx, g.sessionDigest, g.workspaceId);
  if (a === "ineligible") throw new WorkReject("unauthenticated");
  if (a === "grant_overflow") throw new WorkReject("grant_overflow");
  return a;
}
const humanActor = (a: WorkAuthority): Current_HumanActorRef => {
  const actor = {
    kind: "human",
    principalId: a.actor.principalId,
    organizationId: a.actor.organizationId,
    workspaceId: a.resource.workspaceId,
    membershipId: a.actor.membershipId,
    installationId: null,
    mandateId: null,
  };
  if (!validateCurrentDefinition("HumanActorRef", actor)) throw new WorkContextUnavailable();
  return actor as Current_HumanActorRef;
};

// ---------------------------------------------------------------------------
// Command plumbing (the agents commands' shape).
const sqlOutcomes: Readonly<Record<string, WorkRejection>> = Object.freeze({
  invalid: "invalid",
  ineligible: "unauthenticated",
  not_found: "not_found",
  state_conflict: "state_conflict",
  stale_authority: "stale_authority",
  command_conflict: "command_conflict",
});
function decodeResult(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new WorkContextUnavailable();
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new WorkContextUnavailable();
  return parsed as Record<string, unknown>;
}
/** Replay first: a recorded command returns its recorded result and changes nothing. */
async function begin(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedConnectionCommand,
): Promise<ConnectionResult | null> {
  if (g.commandId === null) throw new WorkReject("invalid");
  const b = one(
    await tx.run("beginConnectionCommand", [prepared.type, g.commandId, prepared.digest]),
  );
  if (!b || typeof b.outcome !== "string") throw new WorkContextUnavailable();
  if (b.outcome === "conflict") throw new WorkReject("command_conflict");
  if (b.outcome === "ineligible") throw new WorkReject("unauthenticated");
  if (b.outcome === "replay") {
    tx.rollbackOnly();
    return {
      status: 200,
      body: { ...decodeResult(b.result), replayed: true },
      outcome: "replayed",
    };
  }
  if (b.outcome !== "new") throw new WorkReject("invalid");
  return null;
}

// "Disconnect store": the person's kill switch on one connection. It needs neither the
// store's association to be current nor the installation to be linked: a disconnect is
// always possible on a connection that was ever linked here, and a repeat records the
// person's KillSwitchRecord as already_stopped and changes nothing else.
async function disconnect(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedConnectionCommand,
  correlationId: string,
): Promise<ConnectionResult> {
  const body = prepared.parsed;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  const connectionId = g.params.connectionId!;
  const target = await targetOf(tx, connectionId);
  if (!target) throw new WorkReject("not_found");
  const store = storeResource(
    a.actor.organizationId,
    a.resource.workspaceId,
    target.storeId,
    connectionId,
  );
  if (!(await disconnectAllowed(a, store))) throw new WorkReject("denied");
  const actor = humanActor(a);
  const now = a.databaseNowMs;
  const request = {
    capabilityId: "governance.connection.disconnect",
    input: { connectionId, control: body.control },
  } as KillSwitchTargetRequest;
  const owner = one(await tx.run("reviewContext", ["governance.connection.disconnect", null]));
  if (!owner) throw new WorkReject("unauthenticated");
  // The kill-switch target facts: the connection record and the store and connection
  // coverage of the actor's current execute grants (never unioned). Ownership is part of
  // the facts' shape; a disconnect never consults it (only a membership revocation does).
  const coverage = a.grants
    .filter((grant) =>
      isCurrentGrant(
        grant,
        a.actor,
        "governance.connection.disconnect",
        "execute",
        a.policyRevision,
        now,
      ),
    )
    .map((grant) => ({
      storeIds: [...grant.scope.storeIds],
      connectionIds: [
        ...new Set(
          grant.scope.resources.map((r) => r.connectionId).filter((c): c is string => c !== null),
        ),
      ],
    }));
  const facts: KillSwitchTargetFacts = {
    organizationId: a.actor.organizationId,
    workspaceId: a.resource.workspaceId,
    records: [
      {
        kind: "connection",
        id: connectionId,
        organizationId: a.actor.organizationId,
        workspaceId: a.resource.workspaceId,
        storeId: target.storeId,
        connectionId,
        revision: null,
        digest: null,
      },
    ],
    grants: coverage,
    sourceProposal: null,
    ownership: {
      ownerPrincipalId: optional(owner, "owner_principal_id") ?? actor.principalId,
      ownerMembershipId: optional(owner, "owner_membership_id") ?? actor.membershipId,
      activeHumanMembershipCount: Number(text(owner, "active_human_membership_count")),
      lastMembershipChangeAt: optional(owner, "last_membership_change_at"),
    },
  };
  const planned = planDisconnect(actor, request, facts);
  if (!planned.allowed) throw new WorkReject("not_found");
  const open = await openStopOf(tx, connectionId);
  const record = disconnectRecord(actor, request, planned, {
    id: crypto.randomUUID(),
    createdAt: new Date(now).toISOString(),
    commandId: g.commandId!,
    requestDigest: prepared.digest,
    priorStateObserved: open ? "already_stopped" : "active",
  });
  const canonical = canonicalJson(record);
  tx.markSubmitted();
  const row = one(
    await tx.run("cmdStoreDisconnect", [
      g.commandId,
      prepared.digest,
      correlationId,
      connectionId,
      canonical,
      await sha256Hex(canonical),
    ]),
  );
  if (!row || typeof row.outcome !== "string") throw new WorkContextUnavailable();
  if (row.outcome !== "applied") {
    tx.rollbackOnly();
    throw new WorkReject(sqlOutcomes[row.outcome] ?? "unavailable");
  }
  return { status: 200, body: decodeResult(row.result), outcome: "applied" };
}

export function runConnectionCommand(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedConnectionCommand,
  correlationId: string,
): Promise<ConnectionResult> {
  return disconnect(tx, g, prepared, correlationId);
}

/**
 * GET /connections/:connectionId/disconnect: the connection's state and whether this
 * person may disconnect it now (the kernel allows it, the installation is linked and no
 * stop stands on the connection). Any session-eligible member reads it; ids and codes only.
 */
async function disconnectStatus(tx: WorkTx, g: Guarded): Promise<ConnectionResult> {
  const a = await context(tx, g);
  const connectionId = g.params.connectionId!;
  const target = await targetOf(tx, connectionId);
  if (!target) throw new WorkReject("not_found");
  const store = storeResource(
    a.actor.organizationId,
    a.resource.workspaceId,
    target.storeId,
    connectionId,
  );
  const may = await disconnectAllowed(a, store);
  const open = await openStopOf(tx, connectionId);
  return {
    status: 200,
    body: {
      connectionId,
      storeId: target.storeId,
      installationStatus: target.status,
      stop: open
        ? { setBy: open.setBy, reasonCode: open.reasonCode, createdAt: open.createdAt }
        : null,
      actions: { disconnect: may && open === null && target.status === "linked" },
    },
    outcome: "read",
  };
}
export function runConnectionRead(
  tx: WorkTx,
  g: Guarded,
  _read: ConnectionRead,
): Promise<ConnectionResult> {
  return disconnectStatus(tx, g);
}
