import type {
  Current_HumanActorRef,
  Current_KillSwitchRecord,
  Current_StopRecord,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import {
  checkKillSwitchTarget,
  type KillSwitchTargetFacts,
  type KillSwitchTargetRequest,
  type KillSwitchTargetResult,
} from "@morrow/policy/kill-switch";

// Stops (P11.T05a minimum; ADR-0005; ADR-0022 item 15; mvp-architecture §10; migration
// 0020 stop_controls and stop_records). Pure: no I/O, clock or randomness.
//
// - "Stop AI work" is the human-only ADR-0005 kill switch agents.installation.disable.
//   It runs on the existing path: the human policy evaluator allows `execute`, then
//   checkKillSwitchTarget checks the target, then the effect (an installation stop) and
//   its KillSwitchRecord commit together. `planStopAiWork` is that middle step; its
//   command and definer land with the installation records (M3 PR-1, spine §10), since
//   an installation stop names an installation that only "Enable Listings agent" creates.
// - "Disconnect store" is the human-only kill switch governance.connection.disconnect
//   (ADR-0022 items 2, 3 and 15 with the amendments of 2026-10-22) on the same path:
//   `planDisconnect` is its middle step, a connection stop whose KillSwitchRecord names
//   the connection (KillSwitchConnectionTarget, core v1.1). Its definer also ends the
//   store installation (suspended, `disconnected`); the broker then destroys the token.
// - System and operator stops write StopRecord@1: the app/uninstalled and
//   app/scopes_update connection stops (M2 PR-3 writes them through the connector's
//   applier, morrow_work.connector_inbox_apply, with exactly these codes and reasons) and
//   the platform stop of the owner's script (0020 platform_stop_set/_lift). v1 PR 5: a scope
//   change no longer stops the connection; the system installation stop of each agent that
//   needs a missing scope (shopify_scope_missing, or shopify_token_refused) does instead.
// - A stop revokes its matching active leases in the same statement (0020 stop_guard);
//   `stopBlocks` is the TypeScript twin of morrow_work.stop_active.
// Agents never set or lift a stop; they may only propose one.

export const stopReasonCodes = Object.freeze({
  /** agents.installation.disable, by a person. */
  stopAiWork: "human_stop_ai_work",
  /** governance.connection.disconnect, by a person (M2 PR-3). */
  disconnect: "human_disconnect",
  /** The app/uninstalled webhook's connection stop (system). */
  uninstalled: "shopify_app_uninstalled",
  /**
   * The app/scopes_update webhook's connection stop when the scopes changed (system; M2
   * PR-3). Since v1 PR 5 a scope change keeps the connection: this code is no longer written,
   * and stays for the rows M2 PR-3 wrote.
   */
  scopesChanged: "shopify_scopes_changed",
  /**
   * v1 PR 5 (ADR-0025 item 10): the system installation stop on an agent whose release needs a
   * Shopify scope that is no longer granted (connection-health-work's reconcile).
   */
  scopeMissing: "shopify_scope_missing",
  /** v1 PR 5: the same stop when Shopify refused the connection's token (the read-back). */
  tokenRefused: "shopify_token_refused",
  /** Fixed by 0020's platform_stop_set and platform_stop_lift (operator). */
  platformStop: "operator_platform_stop",
  platformLift: "operator_platform_lift",
} as const);
export type StopSetter =
  | { readonly kind: "human"; readonly principalId: string; readonly membershipId: string }
  | { readonly kind: "system" };
/** One stop_controls row to insert: a tenant stop on one installation or connection. */
export interface StopControlPlan {
  readonly scope: "installation" | "connection";
  readonly organizationId: string;
  readonly workspaceId: string;
  /** The store whose interlock key the stop takes (0020 stop_guard). */
  readonly storeId: string;
  /** The installation or connection id. */
  readonly targetId: string;
  readonly setBy: StopSetter;
  readonly reasonCode: string;
  readonly reason: string;
}
export class StopBoundaryError extends Error {
  constructor(readonly code: "STOP_INPUT_INVALID" | "STOP_RECORD_INVALID") {
    super(code);
    this.name = "StopBoundaryError";
  }
}

const recordId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === "string" && pattern.exec(value)?.[0] === value;
const inputInvalid = () => new StopBoundaryError("STOP_INPUT_INVALID");
/** One KillSwitchRecord target, as the record's own schema types it. */
type KillSwitchTarget = Current_KillSwitchRecord["targets"][number];
/** A store connection as a KillSwitchRecord target (core v1.1 KillSwitchConnectionTarget). */
type ConnectionTarget = Extract<KillSwitchTarget, { kind: "connection" }>;
// The same result checkKillSwitchTarget gives an unknown target.
const notFound = () =>
  Object.freeze({
    allowed: false,
    code: "TARGET_NOT_FOUND",
    category: "denied",
    retry: "never",
    safeMessage: "The requested target is not available.",
  } as const);

export type StopAiWorkResult =
  | {
      readonly allowed: true;
      readonly plan: StopControlPlan;
      /**
       * The KillSwitchRecord targets: the installation as a v1 ResourceRef (KillSwitchRecord
       * keeps v1 ResourceRef targets; the v1.1 ResourceRef only adds kind store).
       */
      readonly targets: readonly KillSwitchTarget[];
    }
  | Extract<KillSwitchTargetResult, { allowed: false }>;

/**
 * The target step of "Stop AI work" for an actor the human policy evaluator already
 * allowed to execute agents.installation.disable. The actor must be a current human
 * member of the facts' tenant (HumanActorRef): an agent never stops. The installation
 * must be a store's (its stop takes that store's interlock); a storeless one is the
 * same not-found denial as an unknown target. Throws StopBoundaryError or the
 * kill-switch library's KillSwitchBoundaryError for malformed input.
 */
export function planStopAiWork(
  actor: Current_HumanActorRef,
  request: KillSwitchTargetRequest,
  facts: KillSwitchTargetFacts,
): StopAiWorkResult {
  if (
    !validateCurrentDefinition("HumanActorRef", actor) ||
    !facts ||
    actor.organizationId !== facts.organizationId ||
    actor.workspaceId !== facts.workspaceId ||
    !request ||
    request.capabilityId !== "agents.installation.disable"
  )
    throw inputInvalid();
  const checked = checkKillSwitchTarget(request, facts);
  if (!checked.allowed) return checked;
  const installationId = request.input.installationId;
  const record = facts.records.find((r) => r.kind === "installation" && r.id === installationId);
  if (!record || record.storeId === null) return notFound();
  const plan: StopControlPlan = Object.freeze({
    scope: "installation",
    organizationId: facts.organizationId,
    workspaceId: facts.workspaceId,
    storeId: record.storeId,
    targetId: installationId,
    setBy: Object.freeze({
      kind: "human",
      principalId: actor.principalId,
      membershipId: actor.membershipId,
    }),
    reasonCode: stopReasonCodes.stopAiWork,
    reason: request.input.control.reason,
  });
  const target: KillSwitchTarget = Object.freeze({
    organizationId: facts.organizationId,
    workspaceId: facts.workspaceId,
    storeId: record.storeId,
    connectionId: record.connectionId,
    kind: "installation",
    id: installationId,
  });
  if (!validateCurrentDefinition("ResourceRef", target)) throw inputInvalid();
  return Object.freeze({ allowed: true, plan, targets: Object.freeze([target]) });
}

/**
 * The KillSwitchRecord committed with a "Stop AI work" stop. The command supplies its
 * own record id, time, command id, request digest and the prior state it observed.
 */
export function stopAiWorkRecord(
  actor: Current_HumanActorRef,
  request: KillSwitchTargetRequest,
  result: Extract<StopAiWorkResult, { allowed: true }>,
  command: {
    readonly id: string;
    readonly createdAt: string;
    readonly commandId: string;
    readonly requestDigest: string;
    readonly priorStateObserved: "active" | "already_stopped";
  },
): Current_KillSwitchRecord {
  if (request.capabilityId !== "agents.installation.disable") throw inputInvalid();
  const record = {
    schemaVersion: 1,
    id: command.id,
    organizationId: result.plan.organizationId,
    workspaceId: result.plan.workspaceId,
    storeId: result.plan.storeId,
    revision: 1,
    createdAt: command.createdAt,
    capabilityId: "agents.installation.disable",
    actor,
    control: request.input.control,
    targets: result.targets,
    commandId: command.commandId,
    requestDigest: command.requestDigest,
    priorStateObserved: command.priorStateObserved,
  };
  if (!validateCurrentDefinition("KillSwitchRecord", record)) throw inputInvalid();
  return JSON.parse(JSON.stringify(record)) as Current_KillSwitchRecord;
}

export type DisconnectResult =
  | {
      readonly allowed: true;
      readonly plan: StopControlPlan;
      /** The one KillSwitchRecord target: the connection, on its store. */
      readonly targets: readonly [ConnectionTarget];
    }
  | Extract<KillSwitchTargetResult, { allowed: false }>;

/**
 * The target step of "Disconnect store" for an actor the human policy evaluator already
 * allowed to execute governance.connection.disconnect on the store resource (the
 * store-link template v2 grant). The actor must be a current human member of the facts'
 * tenant: an agent never disconnects. The connection must be a store's (its stop takes
 * that store's interlock, 0020 stop_guard); a storeless one, or a record that names
 * another connection, is the same not-found denial as an unknown target. Throws
 * StopBoundaryError or KillSwitchBoundaryError for malformed input.
 */
export function planDisconnect(
  actor: Current_HumanActorRef,
  request: KillSwitchTargetRequest,
  facts: KillSwitchTargetFacts,
): DisconnectResult {
  if (
    !validateCurrentDefinition("HumanActorRef", actor) ||
    !facts ||
    actor.organizationId !== facts.organizationId ||
    actor.workspaceId !== facts.workspaceId ||
    !request ||
    request.capabilityId !== "governance.connection.disconnect"
  )
    throw inputInvalid();
  const checked = checkKillSwitchTarget(request, facts);
  if (!checked.allowed) return checked;
  const connectionId = request.input.connectionId;
  const record = facts.records.find((r) => r.kind === "connection" && r.id === connectionId);
  if (
    !record ||
    record.storeId === null ||
    (record.connectionId !== null && record.connectionId !== connectionId)
  )
    return notFound();
  const plan: StopControlPlan = Object.freeze({
    scope: "connection",
    organizationId: facts.organizationId,
    workspaceId: facts.workspaceId,
    storeId: record.storeId,
    targetId: connectionId,
    setBy: Object.freeze({
      kind: "human",
      principalId: actor.principalId,
      membershipId: actor.membershipId,
    }),
    reasonCode: stopReasonCodes.disconnect,
    reason: request.input.control.reason,
  });
  const target: ConnectionTarget = Object.freeze({
    organizationId: facts.organizationId,
    workspaceId: facts.workspaceId,
    storeId: record.storeId,
    connectionId,
    kind: "connection",
    id: connectionId,
  });
  if (!validateCurrentDefinition("KillSwitchConnectionTarget", target)) throw inputInvalid();
  return Object.freeze({ allowed: true, plan, targets: Object.freeze([target] as const) });
}

/**
 * The KillSwitchRecord committed with a "Disconnect store" stop. The command supplies its
 * own record id, time, command id, request digest and the prior state it observed (an
 * open stop on the connection, whoever set it, is already_stopped).
 */
export function disconnectRecord(
  actor: Current_HumanActorRef,
  request: KillSwitchTargetRequest,
  result: Extract<DisconnectResult, { allowed: true }>,
  command: {
    readonly id: string;
    readonly createdAt: string;
    readonly commandId: string;
    readonly requestDigest: string;
    readonly priorStateObserved: "active" | "already_stopped";
  },
): Current_KillSwitchRecord {
  if (request.capabilityId !== "governance.connection.disconnect") throw inputInvalid();
  const record = {
    schemaVersion: 1,
    id: command.id,
    organizationId: result.plan.organizationId,
    workspaceId: result.plan.workspaceId,
    storeId: result.plan.storeId,
    revision: 1,
    createdAt: command.createdAt,
    capabilityId: "governance.connection.disconnect",
    actor,
    control: request.input.control,
    targets: result.targets,
    commandId: command.commandId,
    requestDigest: command.requestDigest,
    priorStateObserved: command.priorStateObserved,
  };
  if (!validateCurrentDefinition("KillSwitchRecord", record)) throw inputInvalid();
  return JSON.parse(JSON.stringify(record)) as Current_KillSwitchRecord;
}

/** The system stops' fixed reasons (the connector's applier writes exactly these). */
export const systemStopReasons = Object.freeze({
  shopify_app_uninstalled: "The Shopify app was uninstalled from the store.",
  shopify_scopes_changed: "The Shopify app's access scopes changed.",
} as const);
/**
 * v1 PR 5: the system installation stops' fixed reasons (migration connection-health-work's
 * connection_health_reconcile writes exactly these; tests/connection-health.test.mjs pins
 * them to the SQL). Agents never set or lift them; only a person resumes an agent.
 */
export const systemInstallationStopReasons = Object.freeze({
  shopify_scope_missing: "The Shopify app no longer has a permission this agent needs.",
  shopify_token_refused: "Shopify no longer accepts the store connection's access token.",
} as const);
/**
 * The system's connection stop for an app/uninstalled webhook (ADR-0022 items 13-15):
 * every lease on the connection is revoked, and its StopRecord@1 is a system record.
 * M2 PR-3: the same stop with its own reason when app/scopes_update reports scopes that are
 * no longer exactly the app's. The installation stays suspended: this release has no
 * reinstall path, so reconnecting needs a new app (a deviation from ADR-0022 items 13 and
 * 15 that the M2 brief's PR-3 owner questions name; spine §10 and §11).
 */
export function uninstallConnectionStop(
  target: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly storeId: string;
    readonly connectionId: string;
  },
  reasonCode: keyof typeof systemStopReasons = stopReasonCodes.uninstalled,
): StopControlPlan {
  if (
    !target ||
    ![target.organizationId, target.workspaceId, target.storeId, target.connectionId].every((v) =>
      exact(recordId, v),
    ) ||
    !Object.hasOwn(systemStopReasons, reasonCode)
  )
    throw inputInvalid();
  return Object.freeze({
    scope: "connection",
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    storeId: target.storeId,
    targetId: target.connectionId,
    setBy: Object.freeze({ kind: "system" }),
    reasonCode,
    reason: systemStopReasons[reasonCode],
  });
}

// ---------------------------------------------------------------------------
// StopRecord@1 from its row. The api reads stop_records under tenant_read (its own
// tenant's rows and the platform rows) with `stopRecordColumns`.
export { stopRecordColumns } from "./spine-sql.js";
const stopRecordNames =
  "action,actor_kind,id,operator_id,organization_id,reason,reason_code,recorded_at,scope,stop_control_id,store_id,target_id,workspace_id";
export function stopRecordFromRow(row: Readonly<Record<string, unknown>>): Current_StopRecord {
  if (!row || typeof row !== "object" || Object.keys(row).sort().join(",") !== stopRecordNames)
    throw new StopBoundaryError("STOP_RECORD_INVALID");
  const record = {
    schemaVersion: 1,
    id: row.id,
    stopControlId: row.stop_control_id,
    action: row.action,
    scope: row.scope,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    storeId: row.store_id,
    targetId: row.target_id,
    actor:
      row.actor_kind === "system"
        ? { kind: "system", operatorId: row.operator_id }
        : { kind: row.actor_kind, operatorId: row.operator_id },
    reasonCode: row.reason_code,
    reason: row.reason,
    recordedAt: row.recorded_at,
  };
  if (!validateCurrentDefinition("StopRecord", record))
    throw new StopBoundaryError("STOP_RECORD_INVALID");
  return Object.freeze(record) as Current_StopRecord;
}

// ---------------------------------------------------------------------------
// The TypeScript twin of morrow_work.stop_active: whether an active stop blocks work of
// this kind on this connection or installation. A platform stop blocks run and operation
// work (never a read, so readback continues); a connection stop blocks everything on its
// connection; an installation stop blocks that installation's run and operation work.
export interface ActiveStop {
  readonly scope: "platform" | "installation" | "connection";
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly targetId: string | null;
}
export function stopBlocks(
  stops: readonly ActiveStop[],
  work: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly kind: "read" | "run" | "operation";
    readonly connectionId: string;
    readonly installationId: string | null;
  },
): boolean {
  const background = work.kind === "run" || work.kind === "operation";
  return stops.some((s) => {
    if (s.scope === "platform") return background;
    if (s.organizationId !== work.organizationId || s.workspaceId !== work.workspaceId)
      return false;
    if (s.scope === "connection") return s.targetId === work.connectionId;
    return background && work.installationId !== null && s.targetId === work.installationId;
  });
}
