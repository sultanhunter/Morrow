import type { Core_AnswerRef, Core_PolicyDecision, Current_ResourceRef } from "@morrow/contracts";
import { validateCapabilityInput, validateCapabilityOutput } from "@morrow/contracts/validation";
import {
  workAggregateReads,
  workPermissions,
  type WorkPermissionKey,
} from "@morrow/contracts/work-permissions";
import { WorkReject, type WorkRejection, type WorkTx } from "./connection.js";
import { enterWorkContext, WorkContextUnavailable, type WorkAuthority } from "./context.js";
import { answerSchemaRef } from "./contract-mapping.js";
import { sha256Hex, workRequestDigest, type WorkCommandType } from "./digest.js";
import { targetEligible } from "./eligibility.js";
import {
  parseGoalCreate,
  parseGoalTransition,
  parseQuestionAnswer,
  parseQuestionCancel,
  parseQuestionRequest,
  parseTaskAssign,
  parseTaskCreate,
  parseTaskReady,
} from "./http-bodies.js";
import type { GuardedWorkRequest } from "./http-guard.js";
import { authorizeWork, decideWork } from "./permissions.js";
import type { WorkStatementName } from "./sql.js";

// The command protocol (P06.T01a §4.7): replay first, then authority, then one
// locked write. Steps 1 (parse and digest) run before any connection opens.
// Denials and conflicts persist nothing; an unknown outcome is never reported as
// success or as denial.

export interface WorkCommandResult {
  readonly status: 200 | 201;
  readonly body: Readonly<Record<string, unknown>>;
  readonly outcome: "applied" | "replayed";
}
interface Target {
  readonly status: string;
  readonly ownerPrincipalId: string;
  readonly ownerMembershipId: string;
  readonly respondentPrincipalId: string | null;
  readonly respondentMembershipId: string | null;
}
interface Spec<P> {
  readonly type: WorkCommandType;
  readonly permission: WorkPermissionKey;
  readonly parse: (body: unknown) => P | null;
  readonly pathIds: (g: GuardedWorkRequest) => readonly string[];
  readonly target?: (
    g: GuardedWorkRequest,
    p: P,
  ) => { statement: WorkStatementName; id: string; read: WorkPermissionKey };
  readonly ownership: boolean;
  readonly respondentOnly?: boolean;
  readonly eligibility?: (p: P) => { role: "assignee" | "respondent"; principal: string };
  readonly storeIds?: (p: P) => readonly string[];
  /** The server-built v1 capability input, or null where v1 has none. */
  readonly input: (g: GuardedWorkRequest, p: P, a: WorkAuthority, x: Extra) => unknown;
  readonly inputCheck?: (p: P, a: WorkAuthority) => boolean;
  /** Input rules decidable from the request alone, checked before any connection opens. */
  readonly precheck?: (g: GuardedWorkRequest, p: P) => boolean;
  readonly call: (
    g: GuardedWorkRequest,
    p: P,
    x: Extra,
  ) => { statement: WorkStatementName; values: (string | null)[] };
  readonly created: boolean;
  readonly result: (result: Record<string, unknown>) => Record<string, unknown> | null;
}
interface Extra {
  readonly commandId: string;
  readonly digest: string;
  readonly correlationId: string;
  readonly basis: "own" | "other" | "none";
  readonly answerId: string;
  readonly answerDigest: string;
  /** The assignee or respondent grants digest from step 6, rechecked under lock. */
  readonly targetGrantsDigest: string | null;
}
export interface PreparedWorkCommand {
  readonly spec: Spec<unknown>;
  readonly parsed: unknown;
  readonly digest: string;
  readonly answerId: string;
  readonly answerDigest: string;
}

const keys = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
const revisionPair = (r: Record<string, unknown>) =>
  keys(r, ["status", "revision"]) &&
  typeof r.status === "string" &&
  Number.isSafeInteger(r.revision) &&
  (r.revision as number) >= 1
    ? { status: r.status, revision: r.revision }
    : null;
const capabilityOutput = (
  capability: Parameters<typeof validateCapabilityOutput>[0],
  value: Record<string, unknown>,
) => (validateCapabilityOutput(capability, value) ? value : null);

const goalTarget = (id: string) => ({
  statement: "goalTarget" as const,
  id,
  read: "goal.read" as const,
});
const taskTarget = (id: string) => ({
  statement: "taskTarget" as const,
  id,
  read: "task.read" as const,
});
const questionTarget = (id: string) => ({
  statement: "questionTarget" as const,
  id,
  read: "question.read" as const,
});
function workspaceResource(a: WorkAuthority) {
  return a.resource;
}
const sameResource = (x: Current_ResourceRef, a: WorkAuthority) => {
  const w = workspaceResource(a);
  return (
    x.organizationId === w.organizationId &&
    x.workspaceId === w.workspaceId &&
    x.storeId === null &&
    x.connectionId === null &&
    x.kind === "workspace" &&
    x.id === w.id
  );
};

function spec<P>(s: Spec<P>): Spec<unknown> {
  return Object.freeze(s) as unknown as Spec<unknown>;
}
export const workCommandSpecs: Readonly<Record<WorkCommandType, Spec<unknown>>> = Object.freeze({
  "goal.create": spec({
    type: "goal.create",
    permission: "goal.create",
    parse: parseGoalCreate,
    pathIds: () => [],
    ownership: false,
    storeIds: (p) => p.storeIds,
    input: (_g, p) => ({
      objective: p.objective,
      storeIds: p.storeIds,
      successCriteria: p.successCriteria,
    }),
    call: (g, p, x) => ({
      statement: "cmdGoalCreate",
      values: [
        x.commandId,
        x.digest,
        x.correlationId,
        p.objective,
        JSON.stringify(p.successCriteria),
      ],
    }),
    created: true,
    result: (r) => capabilityOutput("workspace.goal.create", r),
  }),
  "goal.transition": spec({
    type: "goal.transition",
    permission: "goal.transition",
    parse: parseGoalTransition,
    pathIds: (g) => [g.params.goalId!],
    target: (g) => goalTarget(g.params.goalId!),
    ownership: true,
    input: () => null,
    call: (g, p, x) => ({
      statement: "cmdGoalTransition",
      values: [
        x.commandId,
        x.digest,
        x.correlationId,
        g.params.goalId!,
        p.to,
        String(p.expectedRevision),
        x.basis,
      ],
    }),
    created: false,
    result: revisionPair,
  }),
  "task.create": spec({
    type: "task.create",
    permission: "task.create",
    parse: parseTaskCreate,
    pathIds: () => [],
    target: (_g, p) => goalTarget(p.goalId),
    ownership: false,
    input: (_g, p) => ({
      goalId: p.goalId,
      objective: p.objective,
      allowedResources: p.allowedResources,
    }),
    // Nested scope: allowedResources ⊆ goal.scope.resources = [W]. Everything but the
    // organization is decidable from the request; the organization needs the context.
    precheck: (g, p) =>
      p.allowedResources.every(
        (r) =>
          r.workspaceId === g.workspaceId &&
          r.id === g.workspaceId &&
          r.kind === "workspace" &&
          r.storeId === null &&
          r.connectionId === null,
      ),
    inputCheck: (p, a) => p.allowedResources.every((r) => sameResource(r, a)),
    call: (g, p, x) => ({
      statement: "cmdTaskCreate",
      values: [
        x.commandId,
        x.digest,
        x.correlationId,
        p.goalId,
        p.objective,
        JSON.stringify(p.allowedResources),
      ],
    }),
    created: true,
    result: (r) => capabilityOutput("workspace.task.create", r),
  }),
  "task.ready": spec({
    type: "task.ready",
    permission: "task.ready",
    parse: parseTaskReady,
    pathIds: (g) => [g.params.taskId!],
    target: (g) => taskTarget(g.params.taskId!),
    ownership: true,
    input: () => null,
    call: (g, p, x) => ({
      statement: "cmdTaskReady",
      values: [
        x.commandId,
        x.digest,
        x.correlationId,
        g.params.taskId!,
        String(p.expectedRevision),
        x.basis,
      ],
    }),
    created: false,
    result: revisionPair,
  }),
  "task.assign": spec({
    type: "task.assign",
    permission: "task.assign",
    parse: parseTaskAssign,
    pathIds: (g) => [g.params.taskId!],
    target: (g) => taskTarget(g.params.taskId!),
    ownership: true,
    eligibility: (p) => ({ role: "assignee", principal: p.assigneeId }),
    input: (g, p) => ({
      taskId: g.params.taskId,
      assigneeId: p.assigneeId,
      expectedRevision: p.expectedRevision,
    }),
    call: (g, p, x) => ({
      statement: "cmdTaskAssign",
      values: [
        x.commandId,
        x.digest,
        x.correlationId,
        g.params.taskId!,
        p.assigneeId,
        String(p.expectedRevision),
        x.basis,
        x.targetGrantsDigest,
      ],
    }),
    created: false,
    result: (r) => capabilityOutput("workspace.task.assign", r),
  }),
  "question.request": spec({
    type: "question.request",
    permission: "question.request",
    parse: parseQuestionRequest,
    pathIds: (g) => [g.params.taskId!],
    target: (g) => taskTarget(g.params.taskId!),
    ownership: false,
    eligibility: (p) => ({ role: "respondent", principal: p.respondentId }),
    input: (g, p, a) => ({
      taskId: g.params.taskId,
      question: p.question,
      answerSchema: answerSchemaRef(a),
      respondentId: p.respondentId,
    }),
    call: (g, p, x) => ({
      statement: "cmdQuestionRequest",
      values: [
        x.commandId,
        x.digest,
        x.correlationId,
        g.params.taskId!,
        p.question,
        p.respondentId,
        x.targetGrantsDigest,
      ],
    }),
    created: true,
    result: (r) => capabilityOutput("workspace.question.request", r),
  }),
  "question.answer": spec({
    type: "question.answer",
    permission: "question.answer",
    parse: parseQuestionAnswer,
    pathIds: (g) => [g.params.questionId!],
    target: (g) => questionTarget(g.params.questionId!),
    ownership: false,
    respondentOnly: true,
    input: (g, p, a, x) => ({
      questionId: g.params.questionId,
      answer: {
        organizationId: a.actor.organizationId,
        workspaceId: a.resource.workspaceId,
        storeId: null,
        kind: "answer",
        id: x.answerId,
        revision: 1,
        digest: x.answerDigest,
      } satisfies Core_AnswerRef,
      expectedRevision: p.expectedRevision,
    }),
    call: (g, p, x) => ({
      statement: "cmdQuestionAnswer",
      values: [
        x.commandId,
        x.digest,
        x.correlationId,
        g.params.questionId!,
        x.answerId,
        p.text,
        String(p.expectedRevision),
      ],
    }),
    created: false,
    result: (r) =>
      keys(r, ["answerRevision", "answerRef"]) &&
      validateCapabilityOutput("workspace.question.answer", { answerRevision: r.answerRevision })
        ? r
        : null,
  }),
  "question.cancel": spec({
    type: "question.cancel",
    permission: "question.cancel",
    parse: parseQuestionCancel,
    pathIds: (g) => [g.params.questionId!],
    target: (g) => questionTarget(g.params.questionId!),
    ownership: true,
    input: () => null,
    call: (g, p, x) => ({
      statement: "cmdQuestionCancel",
      values: [
        x.commandId,
        x.digest,
        x.correlationId,
        g.params.questionId!,
        String(p.expectedRevision),
        x.basis,
      ],
    }),
    created: false,
    result: revisionPair,
  }),
});

/** Step 1, with no I/O: strict body, request digest, server-minted answer identity. */
export async function prepareWorkCommand(
  type: WorkCommandType,
  g: GuardedWorkRequest,
): Promise<PreparedWorkCommand> {
  const s = workCommandSpecs[type];
  const parsed = s.parse(g.body);
  if (parsed === null || (s.precheck && !s.precheck(g, parsed))) throw new WorkReject("invalid");
  const digest = await workRequestDigest(type, g.workspaceId, s.pathIds(g), g.body);
  const answerId = crypto.randomUUID();
  const text = type === "question.answer" ? (parsed as { text: string }).text : "";
  return Object.freeze({
    spec: s,
    parsed,
    digest,
    answerId,
    answerDigest: await sha256Hex(text),
  });
}

function reject(decision: Core_PolicyDecision, fallback: WorkRejection): never {
  throw new WorkReject(decision.reason === "field_denied" ? "field_denied" : fallback);
}
function target(rows: readonly Record<string, unknown>[]): Target | null {
  if (rows.length === 0) return null;
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new WorkContextUnavailable();
  const text = (key: string) => {
    const value = row[key];
    if (typeof value !== "string") throw new WorkContextUnavailable();
    return value;
  };
  const optional = (key: string) => (key in row ? text(key) : null);
  return {
    status: text("status"),
    ownerPrincipalId: text("owner_principal_id"),
    ownerMembershipId: text("owner_membership_id"),
    respondentPrincipalId: optional("respondent_principal_id"),
    respondentMembershipId: optional("respondent_membership_id"),
  };
}
const sqlOutcomes: Readonly<Record<string, WorkRejection>> = Object.freeze({
  invalid: "invalid",
  ineligible: "unauthenticated",
  not_found: "not_found",
  not_respondent: "denied",
  revision_conflict: "revision_conflict",
  state_conflict: "state_conflict",
  guard_failed: "guard_failed",
  stale_authority: "stale_authority",
  command_conflict: "command_conflict",
  limit_reached: "limit_reached",
});
function decodeResult(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new WorkContextUnavailable();
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new WorkContextUnavailable();
  return parsed as Record<string, unknown>;
}

/** Steps 2-9 inside one READ WRITE transaction. */
export async function runWorkCommand(
  tx: WorkTx,
  g: GuardedWorkRequest,
  prepared: PreparedWorkCommand,
  correlationId: string,
): Promise<WorkCommandResult> {
  const s = prepared.spec;
  const commandId = g.commandId;
  if (commandId === null) throw new WorkReject("invalid");
  // 2. Context.
  const a = await enterWorkContext(tx, g.sessionDigest, g.workspaceId);
  if (a === "ineligible") throw new WorkReject("unauthenticated");
  if (a === "grant_overflow") throw new WorkReject("grant_overflow");
  // 3. Replay check: only the session plus view on the aggregate's read capability.
  const begun = await tx.run("beginCommand", [s.type, commandId, prepared.digest]);
  const b = begun[0];
  if (begun.length !== 1 || !b || typeof b.outcome !== "string") throw new WorkContextUnavailable();
  if (b.outcome === "conflict") throw new WorkReject("command_conflict");
  if (b.outcome === "ineligible") throw new WorkReject("unauthenticated");
  if (b.outcome === "replay") {
    const read = workAggregateReads[b.aggregate_type as keyof typeof workAggregateReads];
    if (!read) throw new WorkContextUnavailable();
    const rule = workPermissions[read];
    const view = await decideWork(a, rule.capabilityId, "view", ["status"]);
    if (!view.allowed) throw new WorkReject("not_found");
    const body = s.result(decodeResult(b.result));
    if (!body) throw new WorkContextUnavailable();
    tx.rollbackOnly();
    return { status: 200, body: { ...body, replayed: true }, outcome: "replayed" };
  }
  if (b.outcome !== "new") throw new WorkReject("invalid");
  // 4. Target: absent or not viewable is the same 404.
  let found: Target | null = null;
  if (s.target) {
    const t = s.target(g, prepared.parsed);
    const rule = workPermissions[t.read];
    const view = await decideWork(a, rule.capabilityId, "view", ["status"]);
    if (!view.allowed) throw new WorkReject("not_found");
    found = target(await tx.run(t.statement, [t.id]));
    if (!found) throw new WorkReject("not_found");
  }
  // 5. Ownership selects the verb; a grant is always required.
  let basis: "own" | "other" | "none" = "none";
  if (s.ownership) {
    if (!found) throw new WorkContextUnavailable();
    basis =
      found.ownerPrincipalId === a.actor.principalId &&
      found.ownerMembershipId === a.actor.membershipId
        ? "own"
        : "other";
  }
  const decision = await authorizeWork(a, s.permission, basis);
  if (!decision.allowed) reject(decision, "denied");
  if (
    s.respondentOnly &&
    (found?.respondentPrincipalId !== a.actor.principalId ||
      found?.respondentMembershipId !== a.actor.membershipId)
  )
    throw new WorkReject("denied");
  if (s.storeIds && s.storeIds(prepared.parsed).length > 0) throw new WorkReject("store_denied");
  // 6. Eligibility of the assignee or respondent (OQ-4). The digest of the grants
  // it was judged on goes to the command function, which rechecks it under lock.
  let targetGrantsDigest: string | null = null;
  if (s.eligibility) {
    const e = s.eligibility(prepared.parsed);
    const eligible = await targetEligible(tx, a, e.principal, e.role);
    if (eligible.outcome !== "eligible")
      throw new WorkReject(eligible.outcome === "not_member" ? "not_found" : "target_ineligible");
    targetGrantsDigest = eligible.grantsDigest;
  }
  // 7. The server-built v1 capability input.
  const extra: Extra = {
    commandId,
    digest: prepared.digest,
    correlationId,
    basis,
    answerId: prepared.answerId,
    answerDigest: prepared.answerDigest,
    targetGrantsDigest,
  };
  const input = s.input(g, prepared.parsed, a, extra);
  const capability = workPermissions[s.permission].capabilityId;
  if (input !== null && !validateCapabilityInput(capability, input))
    throw new WorkReject("invalid");
  if (s.inputCheck && !s.inputCheck(prepared.parsed, a)) throw new WorkReject("invalid");
  // 8. Execute: from here a lost reply is an unknown outcome.
  const call = s.call(g, prepared.parsed, extra);
  tx.markSubmitted();
  const rows = await tx.run(call.statement, call.values);
  const row = rows[0];
  if (rows.length !== 1 || !row || typeof row.outcome !== "string") {
    // The function's reply is not a decided outcome: never report success or denial.
    throw new WorkContextUnavailable();
  }
  if (row.outcome !== "applied") {
    tx.rollbackOnly();
    throw new WorkReject(sqlOutcomes[row.outcome] ?? "unavailable");
  }
  // 9. The result commits with the effect; the caller sends COMMIT.
  const body = s.result(decodeResult(row.result));
  if (!body) throw new WorkContextUnavailable();
  return { status: s.created ? 201 : 200, body, outcome: "applied" };
}
