import type {
  Core_ResourceRef,
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
// - System and operator stops write StopRecord@1: the app/uninstalled connection stop
//   (M2 PR-3 writes it through the connector's definer) and the platform stop of the
//   owner's script (0020 platform_stop_set/_lift).
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

export type StopAiWorkResult =
  | {
      readonly allowed: true;
      readonly plan: StopControlPlan;
      /** The KillSwitchRecord targets: the installation as a v1 ResourceRef. */
      readonly targets: readonly Core_ResourceRef[];
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
  if (!record || record.storeId === null) {
    // The same result checkKillSwitchTarget gives an unknown target.
    return Object.freeze({
      allowed: false,
      code: "TARGET_NOT_FOUND",
      category: "denied",
      retry: "never",
      safeMessage: "The requested target is not available.",
    });
  }
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
  const target: Core_ResourceRef = Object.freeze({
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

/**
 * The system's connection stop for an app/uninstalled webhook (ADR-0022 items 13-15):
 * every lease on the connection is revoked, and its StopRecord@1 is a system record.
 */
export function uninstallConnectionStop(target: {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly storeId: string;
  readonly connectionId: string;
}): StopControlPlan {
  if (
    !target ||
    ![target.organizationId, target.workspaceId, target.storeId, target.connectionId].every((v) =>
      exact(recordId, v),
    )
  )
    throw inputInvalid();
  return Object.freeze({
    scope: "connection",
    organizationId: target.organizationId,
    workspaceId: target.workspaceId,
    storeId: target.storeId,
    targetId: target.connectionId,
    setBy: Object.freeze({ kind: "system" }),
    reasonCode: stopReasonCodes.uninstalled,
    reason: "The Shopify app was uninstalled from the store.",
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
