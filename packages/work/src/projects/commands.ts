import type {
  CapabilityId,
  Current_AreaTemplateId,
  Current_CriteriaList,
  Current_GoalProgress,
  Current_GoalStatus,
  Current_GoalValueClass,
  Current_HumanActorRef,
  Current_PlanDraft,
  Current_PlanStartDocument,
  Current_PlanStartResult,
  Current_ReadTag,
  Current_ResourceRef,
} from "@morrow/contracts";
import { validateCurrentDefinition } from "@morrow/contracts/validation";
import { createHumanPolicyService, type HumanAuthority, type PermissionVerb } from "@morrow/policy";
import {
  areaTemplate,
  buildPlanStartDocument,
  decideStartPieces,
  goalProgress,
  grantSummaryDigest,
  planDraftValid,
  planStepRuns,
  startChecks,
  startEligible,
  startRecords,
  startRouteGate,
  startTarget,
  type GoalValueFacts,
  type StartCard,
} from "@morrow/policy/projects";
import { storeResource } from "@morrow/policy/store-resource";
import { WorkReject, type WorkRejection, type WorkTx } from "../connection.js";
import { enterWorkContext, WorkContextUnavailable, type WorkAuthority } from "../context.js";
import { canonicalJson, sha256Hex } from "../digest.js";
import { targetEligible } from "../eligibility.js";
import type { GuardedWorkspaceRequest, WorkspaceRouteSpec } from "../http-guard.js";
import {
  parseGoalCheckBody,
  parseGoalReviseBody,
  parseStartBody,
  parseStartDocumentBody,
  type GoalCheckBody,
  type GoalReviseBody,
  type StartBody,
  type StartDocumentBody,
} from "./bodies.js";

// The goal and plan-start commands and the progress read (PR 18; ADR-0033 and ADR-0034).
// Each runs the human kernel (packages/policy) under the request's own enter_context()
// snapshot before its definer; the definer rechecks authority under lock (the P06.T01a
// prelude) and every data rule. Denials and conflicts persist nothing; an unknown outcome is
// never reported as success or denial.
//   * workspace.goal.revise and workspace.goal.measure.record are human_only: the kernel's
//     origin rule refuses any actor but a human member, and the work API serves only the
//     standalone workspace's session (no embedded or email session reaches it).
//   * The plan start is two commands, like "Enable Listings agent": the server builds the
//     document for the asker (or the person opening a code-built card), bound to the actor,
//     the session, five minutes and a single-use nonce; the confirmation of its digest and
//     nonce runs every piece under live grants again and creates everything in one
//     transaction. It never admits a run: while the agent loop is off every step that would
//     start one is `not_started` with `agent_loop_off`.
export type ProjectCommandType =
  | "goal.revise"
  | "goal.check"
  | "plan.start_document"
  | "plan.start";
export type ProjectRead = "goal.progress";
export type ProjectRefusal =
  | "goals_unavailable"
  | "start_unavailable"
  | "plan_drafts_off"
  | "actor_ineligible"
  | "stale"
  | "repeating_unavailable"
  | "stopped"
  | "agent_not_added";
export class ProjectReject extends Error {
  constructor(readonly reason: ProjectRefusal) {
    super("PROJECT_REJECTED");
    this.name = "ProjectReject";
  }
}
type Guarded = GuardedWorkspaceRequest<WorkspaceRouteSpec>;
export interface ProjectResult {
  readonly status: 200 | 201;
  readonly body: Readonly<Record<string, unknown>>;
  readonly outcome: string;
}
export interface PreparedProjectCommand {
  readonly type: ProjectCommandType;
  readonly parsed: unknown;
  readonly digest: string;
}
/** The request digest: canonical JSON of the command, its workspace, path ids and body. */
export function projectRequestDigest(
  type: ProjectCommandType,
  workspaceId: string,
  pathIds: readonly string[],
  body: unknown,
): Promise<string> {
  return sha256Hex(
    canonicalJson(["morrow.work.command", 1, type, workspaceId, [...pathIds], body]),
  );
}
/** Step 1, with no I/O: the strict body and the request digest. */
export async function prepareProjectCommand(
  type: ProjectCommandType,
  g: Guarded,
): Promise<PreparedProjectCommand> {
  const goalId = g.params.goalId ?? "";
  const parsed =
    type === "goal.revise"
      ? parseGoalReviseBody(goalId, g.body)
      : type === "goal.check"
        ? parseGoalCheckBody(goalId, g.body)
        : type === "plan.start_document"
          ? parseStartDocumentBody(g.body)
          : parseStartBody(g.body);
  if (parsed === null) throw new WorkReject("invalid");
  const pathIds = g.params.goalId === undefined ? [] : [g.params.goalId];
  const digest = await projectRequestDigest(type, g.workspaceId, pathIds, g.body);
  return Object.freeze({ type, parsed, digest });
}

// ---------------------------------------------------------------------------
// The kernel on one resource. These are internal writes, never paid work, so entitlement
// is the literal false every builder but the billing reader passes.
async function decideOn(
  a: WorkAuthority,
  resource: Current_ResourceRef,
  capabilityId: CapabilityId,
  verb: PermissionVerb,
  fields: readonly string[],
): Promise<{ readonly allowed: boolean; readonly reason: string }> {
  const authority: HumanAuthority = {
    actor: a.actor,
    policyRevision: a.policyRevision,
    grantsRevision: a.policyRevision,
    principalActive: true,
    organizationActive: true,
    workspaceActive: true,
    membershipActive: true,
    sessionCurrent: true,
    resource,
    accountId: null,
    providerAllowed: true,
    entitlementAllowed: false,
    grants: a.grants,
  };
  const service = createHumanPolicyService(
    { readCurrent: async () => authority },
    () => new Date(a.databaseNowMs),
  );
  const r = await service.decide({
    capabilityId,
    verb,
    resource,
    accountId: null,
    fields: [...fields],
  });
  return { allowed: r.decision.allowed, reason: r.decision.reason };
}
const goalView = (a: WorkAuthority) =>
  decideOn(a, a.resource, "workspace.goal.create", "view", ["status"]);

// ---------------------------------------------------------------------------
// Fixed row decoders. Any other shape is WorkContextUnavailable (a 503, never a guess).
type Row = Readonly<Record<string, unknown>>;
const text = (row: Row, key: string) => {
  const value = row[key];
  if (typeof value !== "string") throw new WorkContextUnavailable();
  return value;
};
const optional = (row: Row, key: string) => (row[key] === null ? null : text(row, key));
const one = (rows: readonly Row[]) => {
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]) throw new WorkContextUnavailable();
  return rows[0];
};
const integer = (value: string) => {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new WorkContextUnavailable();
  return Number(value);
};
const ms = (value: string) => {
  const t = Date.parse(value);
  if (!Number.isSafeInteger(t)) throw new WorkContextUnavailable();
  return t;
};
const parsed = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new WorkContextUnavailable();
  }
};
async function context(tx: WorkTx, g: Guarded): Promise<WorkAuthority> {
  const a = await enterWorkContext(tx, g.sessionDigest, g.workspaceId);
  if (a === "ineligible") throw new WorkReject("unauthenticated");
  if (a === "grant_overflow") throw new WorkReject("grant_overflow");
  return a;
}
const sqlOutcomes: Readonly<Record<string, WorkRejection | ProjectRefusal>> = Object.freeze({
  invalid: "invalid",
  ineligible: "unauthenticated",
  not_found: "not_found",
  revision_conflict: "revision_conflict",
  state_conflict: "state_conflict",
  stale_authority: "stale_authority",
  command_conflict: "command_conflict",
  limit_reached: "limit_reached",
  stale: "stale",
  actor_ineligible: "actor_ineligible",
  repeating_unavailable: "repeating_unavailable",
  stopped: "stopped",
});
const projectRefusals: readonly string[] = [
  "stale",
  "actor_ineligible",
  "repeating_unavailable",
  "stopped",
];
function decodeResult(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new WorkContextUnavailable();
  const result = parsed(value);
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new WorkContextUnavailable();
  return result as Record<string, unknown>;
}
/** Replay first: a recorded command returns its recorded result and changes nothing. */
async function begin(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedProjectCommand,
): Promise<ProjectResult | null> {
  if (g.commandId === null) throw new WorkReject("invalid");
  const b = one(await tx.run("beginProjectCommand", [prepared.type, g.commandId, prepared.digest]));
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
/** Sends the definer: from here a lost reply is an unknown outcome. */
async function submit(
  tx: WorkTx,
  statement: "cmdGoalRevise" | "cmdGoalCheck" | "cmdPlanStartDocument" | "cmdPlanStart",
  values: (string | null)[],
): Promise<Record<string, unknown>> {
  tx.markSubmitted();
  const row = one(await tx.run(statement, values));
  if (!row || typeof row.outcome !== "string") throw new WorkContextUnavailable();
  if (row.outcome !== "applied") {
    tx.rollbackOnly();
    const reason = sqlOutcomes[row.outcome] ?? "unavailable";
    if (projectRefusals.includes(reason)) throw new ProjectReject(reason as ProjectRefusal);
    throw new WorkReject(reason as WorkRejection);
  }
  return decodeResult(row.result);
}
const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

interface GoalRow {
  readonly id: string;
  readonly revision: number;
  readonly status: Current_GoalStatus;
  readonly successCriteria: Current_CriteriaList;
  readonly ownerPrincipalId: string;
  readonly ownerMembershipId: string;
  readonly createdAtMs: number;
  readonly dueAtMs: number | null;
  readonly areaTemplateId: Current_AreaTemplateId | null;
}
async function goalOf(tx: WorkTx, goalId: string): Promise<GoalRow | null> {
  const row = one(await tx.run("projectGoal", [goalId]));
  if (!row) return null;
  const criteria = parsed(text(row, "success_criteria"));
  if (!validateCurrentDefinition("CriteriaList", criteria)) throw new WorkContextUnavailable();
  const due = optional(row, "due_at");
  return {
    id: text(row, "id"),
    revision: integer(text(row, "revision")),
    status: text(row, "status") as Current_GoalStatus,
    successCriteria: criteria as Current_CriteriaList,
    ownerPrincipalId: text(row, "owner_principal_id"),
    ownerMembershipId: text(row, "owner_membership_id"),
    createdAtMs: ms(text(row, "created_at")),
    dueAtMs: due === null ? null : ms(due),
    areaTemplateId: optional(row, "area_template_id") as Current_AreaTemplateId | null,
  };
}
/** A goal the actor may see: absent or not viewable is the same 404. */
async function viewableGoal(tx: WorkTx, a: WorkAuthority, goalId: string): Promise<GoalRow> {
  if (!(await goalView(a)).allowed) throw new WorkReject("not_found");
  const goal = await goalOf(tx, goalId);
  if (!goal) throw new WorkReject("not_found");
  return goal;
}

// ---------------------------------------------------------------------------
// workspace.goal.revise: own -> execute, another member's record -> administer.
const reviseFields = ["goalId", "expectedRevision", "objective", "dueAt", "successCriteria"];
async function goalRevise(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedProjectCommand,
  correlationId: string,
): Promise<ProjectResult> {
  const body = prepared.parsed as GoalReviseBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  const goalId = g.params.goalId!;
  const goal = await viewableGoal(tx, a, goalId);
  const own =
    goal.ownerPrincipalId === a.actor.principalId &&
    goal.ownerMembershipId === a.actor.membershipId;
  const decided = await decideOn(
    a,
    a.resource,
    "workspace.goal.revise",
    own ? "execute" : "administer",
    reviseFields,
  );
  if (!decided.allowed)
    throw new WorkReject(decided.reason === "field_denied" ? "field_denied" : "denied");
  const result = await submit(tx, "cmdGoalRevise", [
    g.commandId,
    prepared.digest,
    correlationId,
    goalId,
    String(body.expectedRevision),
    own ? "own" : "other",
    body.objective,
    body.dueAt === null ? null : new Date(Date.parse(body.dueAt)).toISOString(),
    JSON.stringify(body.successCriteria),
  ]);
  return { status: 200, body: result, outcome: "applied" };
}

// workspace.goal.measure.record: the person's own hand check.
const checkFields = ["goalId", "key", "productId", "assistant", "answers"];
async function goalCheck(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedProjectCommand,
  correlationId: string,
): Promise<ProjectResult> {
  const body = prepared.parsed as GoalCheckBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  const goalId = g.params.goalId!;
  await viewableGoal(tx, a, goalId);
  const decided = await decideOn(
    a,
    a.resource,
    "workspace.goal.measure.record",
    "execute",
    checkFields,
  );
  if (!decided.allowed)
    throw new WorkReject(decided.reason === "field_denied" ? "field_denied" : "denied");
  const result = await submit(tx, "cmdGoalCheck", [
    g.commandId,
    prepared.digest,
    correlationId,
    goalId,
    body.key,
    body.productId,
    body.assistant,
    JSON.stringify(body.answers),
    crypto.randomUUID(),
  ]);
  return { status: 201, body: result, outcome: "applied" };
}

// ---------------------------------------------------------------------------
// GoalProgress@1 for this viewer: each read tag decided by the kernel on its store resource
// (view on the tag's capability); a store with no current association is never viewable.
export async function goalProgressRead(tx: WorkTx, g: Guarded): Promise<ProjectResult> {
  const a = await context(tx, g);
  const goalId = g.params.goalId!;
  const goal = await viewableGoal(tx, a, goalId);
  const values: GoalValueFacts[] = [];
  const rows = await tx.run("goalValues", [goalId]);
  if (rows.length > 2000) throw new WorkReject("limit_reached");
  for (const row of rows) {
    const tags = parsed(text(row, "read_tags"));
    if (!validateCurrentDefinition("ReadTags", tags)) throw new WorkContextUnavailable();
    const expires = optional(row, "expires_at");
    values.push({
      key: text(row, "key"),
      productId: optional(row, "product_id"),
      value: Number(text(row, "value")),
      observedAtMs: ms(text(row, "observed_at")),
      counted: text(row, "counted") === "true",
      readTags: tags as Current_ReadTag[],
      dataClass: text(row, "data_class") as Current_GoalValueClass,
      expiresAtMs: expires === null ? null : ms(expires),
    });
  }
  const stores = new Set<string>();
  for (const row of await tx.run("workspaceStores", [])) stores.add(text(row, "store_id"));
  for (const v of values) for (const tag of v.readTags) stores.add(tag.storeId);
  // The kernel's view on each (store, capability), decided once.
  const decisions = new Map<string, boolean>();
  const resources = new Map<string, Current_ResourceRef | null>();
  for (const storeId of stores) {
    const row = one(await tx.run("storeAssociation", [storeId]));
    resources.set(
      storeId,
      row === null
        ? null
        : storeResource(
            a.actor.organizationId,
            a.resource.workspaceId,
            storeId,
            text(row, "connection_id"),
          ),
    );
  }
  const capabilities = [
    "catalog.products.read",
    "inventory.levels.read",
    "orders.read",
    "support.case.read",
    "workspace.knowledge.read",
    "workspace.artifact.read",
  ] as const;
  for (const [storeId, resource] of resources)
    for (const capabilityId of capabilities)
      decisions.set(
        storeId + "|" + capabilityId,
        resource !== null && (await decideOn(a, resource, capabilityId, "view", [])).allowed,
      );
  const finishRow = one(await tx.run("goalFinish", [goalId]));
  const waiting = one(await tx.run("goalWaitingOn", [goalId, a.actor.principalId]));
  const progress: Current_GoalProgress = goalProgress(
    {
      id: goal.id,
      revision: goal.revision,
      status: goal.status,
      createdAtMs: goal.createdAtMs,
      dueAtMs: goal.dueAtMs,
      areaTemplateId: goal.areaTemplateId,
      successCriteria: goal.successCriteria,
    },
    values,
    { mayView: (tag) => decisions.get(tag.storeId + "|" + tag.capabilityId) === true },
    {
      nowMs: a.databaseNowMs,
      storeIds: [...stores].sort(),
      finished:
        finishRow === null
          ? null
          : {
              outcome: text(finishRow, "outcome") as "achieved" | "cancelled",
              atMs: ms(text(finishRow, "created_at")),
            },
      waitingOnViewer: waiting !== null && text(waiting, "waiting") !== "0",
      audience: "viewer",
    },
  );
  tx.rollbackOnly();
  return { status: 200, body: { progress }, outcome: "read" };
}

// ---------------------------------------------------------------------------
// The plan start, step 1: the server builds the document.
const startCapabilities: readonly CapabilityId[] = [
  "workspace.goal.create",
  "workspace.goal.revise",
  "workspace.project.create",
  "workspace.project.pin",
  "workspace.task.create",
  "workspace.task.assign",
  "workspace.routine.configure",
];
async function cardOf(tx: WorkTx, a: WorkAuthority, body: StartDocumentBody): Promise<StartCard> {
  if (body.kind === "area") return { kind: "area", areaTemplateId: body.areaTemplateId };
  if (body.kind === "quick_tasks") return { kind: "quick_tasks" };
  const row = one(await tx.run("planDraftLatest", [body.messageId]));
  // Only a digest the server holds, and only the card's current revision.
  if (!row || text(row, "digest") !== body.draftDigest) throw new ProjectReject("stale");
  const draft = parsed(text(row, "canonical"));
  if (!planDraftValid(draft)) throw new WorkContextUnavailable();
  let currentDueAt: string | null = null;
  let targetOwner: "own" | "other" | null = null;
  const d = draft as Current_PlanDraft;
  if (d.target.kind === "existing_project") {
    const target = one(await tx.run("projectTarget", [d.target.projectId]));
    if (!target || integer(text(target, "revision")) !== d.target.goalRevision)
      throw new ProjectReject("stale");
    currentDueAt = optional(target, "due_at");
    targetOwner =
      text(target, "owner_principal_id") === a.actor.principalId &&
      text(target, "owner_membership_id") === a.actor.membershipId
        ? "own"
        : "other";
  }
  return {
    kind: "draft",
    messageId: body.messageId,
    revision: integer(text(row, "revision")),
    digest: body.draftDigest,
    draft: d,
    askerPrincipalId: text(row, "asker_principal_id"),
    contextTaint: text(row, "context_taint") as "none" | "untrusted_external",
    currentDueAt,
    targetOwner,
  };
}
/** An area card needs its agent added (ADR-0033 item 6); Quick tasks needs none. */
async function areaAgentAdded(tx: WorkTx, card: StartCard): Promise<void> {
  if (card.kind !== "area") return;
  const template = areaTemplate(card.areaTemplateId);
  if (!template) throw new WorkContextUnavailable();
  const row = one(await tx.run("areaAgentAdded", [template.releaseId]));
  if (!row || text(row, "added") === "0") throw new ProjectReject("agent_not_added");
}
const pieceDecider = (a: WorkAuthority) => ({
  decide: (check: {
    capabilityId: CapabilityId;
    verb: "execute" | "administer";
    fields: readonly string[];
  }) => decideOn(a, a.resource, check.capabilityId, check.verb, check.fields),
});
async function startDocument(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedProjectCommand,
  correlationId: string,
): Promise<ProjectResult> {
  const body = prepared.parsed as StartDocumentBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return { ...replay, body: { ...replay.body, nonce: null } };
  const card = await cardOf(tx, a, body);
  const actor = {
    kind: "human" as const,
    principalId: a.actor.principalId,
    membershipId: a.actor.membershipId,
  };
  // The work API serves only the standalone workspace's session.
  if (startEligible(actor, "standalone", card) !== "ok")
    throw new ProjectReject("actor_ineligible");
  if (card.kind !== "draft") {
    const template = card.kind === "area" ? card.areaTemplateId : "quick_tasks";
    if (one(await tx.run("areaGoal", [template]))) throw new WorkReject("state_conflict");
    await areaAgentAdded(tx, card);
  }
  const records = startRecords(card);
  if (records === null) throw new WorkContextUnavailable();
  const checks = startChecks(card, records, a.actor.principalId);
  const pieces = await decideStartPieces(checks, pieceDecider(a));
  if (!pieces.ok)
    throw new WorkReject(pieces.reason === "field_denied" ? "field_denied" : "denied");
  const built = buildPlanStartDocument({
    id: crypto.randomUUID(),
    card,
    actor: humanActor(a),
    target: startTarget(card),
    records,
    // The credit range is T4's per-viewer estimate; a code-built card spends nothing.
    estimate: { creditsLow: 0, creditsHigh: 0 },
    grantSummaryDigest: grantSummaryDigest(a.grants, startCapabilities, a.databaseNowMs),
    nowMs: a.databaseNowMs,
  });
  const nonce = randomHex(32);
  const result = await submit(tx, "cmdPlanStartDocument", [
    g.commandId,
    prepared.digest,
    correlationId,
    built.document.id,
    built.canonical,
    built.digest,
    await sha256Hex(nonce),
    built.document.grantSummaryDigest,
  ]);
  if (result.documentDigest !== built.digest) throw new WorkContextUnavailable();
  return { status: 201, body: { ...result, document: built.document, nonce }, outcome: "applied" };
}

// The plan start, step 2: the person's confirmation of the document's digest and nonce.
async function start(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedProjectCommand,
  correlationId: string,
  planDrafts: PlanDraftsState,
): Promise<ProjectResult> {
  const body = prepared.parsed as StartBody;
  const a = await context(tx, g);
  const replay = await begin(tx, g, prepared);
  if (replay) return replay;
  const row = one(await tx.run("planStartDocument", [body.documentDigest]));
  // Unknown (or another actor's), consumed or expired: stale, nothing locked or written.
  if (!row || text(row, "consumed") === "true" || ms(text(row, "expires_at")) <= a.databaseNowMs)
    throw new ProjectReject("stale");
  const document = parsed(text(row, "canonical")) as Current_PlanStartDocument;
  if (!validateCurrentDefinition("PlanStartDocument", document)) throw new WorkContextUnavailable();
  if (document.draft !== null && startRouteGate({ kind: "draft" }, planDrafts) !== "ok")
    throw new ProjectReject("plan_drafts_off");
  // The card as it stands now: a later edit or a moved target makes the document stale.
  let card: StartCard;
  if (document.draft !== null) {
    card = await cardOf(tx, a, {
      kind: "draft",
      messageId: document.draft.messageId,
      draftDigest: document.draft.digest,
    });
    if (card.kind !== "draft" || card.revision !== document.draft.revision)
      throw new ProjectReject("stale");
  } else if (document.target.kind === "area")
    card = { kind: "area", areaTemplateId: document.target.areaTemplateId as never };
  else card = { kind: "quick_tasks" };
  await areaAgentAdded(tx, card);
  // (b) Every piece under live grants, and the grant summary the document bound.
  const live = grantSummaryDigest(a.grants, startCapabilities, a.databaseNowMs);
  if (live !== document.grantSummaryDigest) throw new ProjectReject("stale");
  const checks = startChecks(card, document.records, a.actor.principalId);
  const pieces = await decideStartPieces(checks, pieceDecider(a));
  if (!pieces.ok)
    throw new WorkReject(pieces.reason === "field_denied" ? "field_denied" : "denied");
  // Each person assigned other than the actor: an eligible member, rechecked under lock.
  const assignees: Record<string, string> = {};
  for (const task of document.records.tasks)
    if (task.assignee.kind === "person" && task.assignee.principalId !== a.actor.principalId) {
      const e = await targetEligible(tx, a, task.assignee.principalId, "assignee");
      if (e.outcome !== "eligible") throw new ProjectReject("stale");
      assignees[task.assignee.principalId] = e.grantsDigest;
    }
  const result = await submit(tx, "cmdPlanStart", [
    g.commandId,
    prepared.digest,
    correlationId,
    body.documentDigest,
    await sha256Hex(body.nonce),
    live,
    JSON.stringify(assignees),
  ]);
  // After commit, each run on its own (ADR-0034 item 6); none while the loop is off. T4's
  // admission composes the loop switch and whether the actor is the Owner; until then every
  // agent or specialist step is `not_started` with `agent_loop_off`.
  const runs = planStepRuns(card, {
    actorIsOwner: false,
    agentLoop: "off",
  }).runs;
  const answer: Current_PlanStartResult = {
    goalId: (result.goalId as string | null) ?? null,
    projectId: (result.projectId as string | null) ?? null,
    taskIds: (result.taskIds as string[]) ?? [],
    routineIds: [],
    runs: [...runs],
  };
  if (!validateCurrentDefinition("PlanStartResult", answer)) throw new WorkContextUnavailable();
  return { status: 201, body: answer as unknown as Record<string, unknown>, outcome: "applied" };
}

/** docs/decisions/plan-drafts-staging.json as the api composes it. */
export interface PlanDraftsState {
  readonly switch: "on" | "off";
  readonly start_routes: "held" | "ready";
}
export async function runProjectCommand(
  tx: WorkTx,
  g: Guarded,
  prepared: PreparedProjectCommand,
  correlationId: string,
  planDrafts: PlanDraftsState,
): Promise<ProjectResult> {
  switch (prepared.type) {
    case "goal.revise":
      return goalRevise(tx, g, prepared, correlationId);
    case "goal.check":
      return goalCheck(tx, g, prepared, correlationId);
    case "plan.start_document":
      return startDocument(tx, g, prepared, correlationId);
    case "plan.start":
      return start(tx, g, prepared, correlationId, planDrafts);
  }
}
/** The gate of a start route before any connection: held, or a Morrow card while off. */
export function startGate(
  type: ProjectCommandType,
  parsedBody: unknown,
  record: PlanDraftsState,
): "ok" | "start_unavailable" | "plan_drafts_off" {
  if (type !== "plan.start_document" && type !== "plan.start") return "ok";
  const kind =
    type === "plan.start_document" && (parsedBody as StartDocumentBody).kind === "draft"
      ? "draft"
      : "area";
  const gate = startRouteGate({ kind }, record);
  return gate === "ok" ? "ok" : gate === "unavailable" ? "start_unavailable" : "plan_drafts_off";
}
