/**
 * Work permission vocabulary v1 (ADR-0010 item 1; P06.T01a §4.8). The single table
 * that `@morrow/work`, grant template v2 and P05.T02a issuance import. It confers
 * nothing: grants are issued elsewhere and decided by the `packages/policy` kernel.
 *
 * - Creates use `execute`; `propose` stays reserved for P11 agent proposals.
 * - Ownership selects the verb (own → `execute`, other → `administer`), but a grant
 *   is always required.
 * - Reads are `view` on the capability that creates the record, and request every
 *   non-metadata property they return; an uncovered field is `field_denied`, never
 *   a partial object.
 * - `workspace.question.answer` is `execute` by the designated respondent only.
 * - The resource is always the workspace W.
 */
export type WorkVerb = "view" | "execute" | "administer";
export type WorkCapabilityId =
  | "workspace.goal.create"
  | "workspace.task.create"
  | "workspace.task.assign"
  | "workspace.question.request"
  | "workspace.question.answer";

/** Never gated: identity and version metadata of every v1 object. */
export const workMetadataFields = Object.freeze([
  "schemaVersion",
  "id",
  "organizationId",
  "workspaceId",
  "storeId",
  "revision",
  "createdAt",
  "updatedAt",
] as const);

export interface WorkPermissionRule {
  readonly capabilityId: WorkCapabilityId;
  /** `own`/`other` select the verb by ownership; a fixed verb ignores ownership. */
  readonly verb: WorkVerb | Readonly<{ own: WorkVerb; other: WorkVerb }>;
  readonly fields: readonly string[];
  /** Records a read returns, or the record a command acts on. */
  readonly record: "goal" | "task" | "question" | "answer";
  readonly respondentOnly?: true;
}

const rule = (r: WorkPermissionRule): Readonly<WorkPermissionRule> =>
  Object.freeze({ ...r, fields: Object.freeze([...r.fields]) });

export const workPermissions = Object.freeze({
  "goal.read": rule({
    capabilityId: "workspace.goal.create",
    verb: "view",
    record: "goal",
    fields: ["objective", "scope", "status", "owner", "successCriteria", "taskIds"],
  }),
  "task.read": rule({
    capabilityId: "workspace.task.create",
    verb: "view",
    record: "task",
    fields: [
      "goalId",
      "parentTaskId",
      "status",
      "objective",
      "scope",
      "initiatingPrincipal",
      "owner",
      "dependencyIds",
      "acceptedArtifactRefs",
      "completionEvidenceRefs",
      "leaseGeneration",
      "activeRunId",
    ],
  }),
  "question.read": rule({
    capabilityId: "workspace.question.request",
    verb: "view",
    record: "question",
    fields: [
      "taskId",
      "status",
      "prompt",
      "answerSchemaRef",
      "eligibleRespondentIds",
      "blocksTask",
      "expiresAt",
      "answerRef",
      "answeredBy",
    ],
  }),
  "answer.read": rule({
    capabilityId: "workspace.question.request",
    verb: "view",
    record: "answer",
    fields: ["answerRef", "answeredBy", "answer"],
  }),
  "goal.create": rule({
    capabilityId: "workspace.goal.create",
    verb: "execute",
    record: "goal",
    fields: ["objective", "storeIds", "successCriteria"],
  }),
  "goal.transition": rule({
    capabilityId: "workspace.goal.create",
    verb: { own: "execute", other: "administer" },
    record: "goal",
    fields: ["status"],
  }),
  "task.create": rule({
    capabilityId: "workspace.task.create",
    verb: "execute",
    record: "task",
    fields: ["goalId", "objective", "allowedResources"],
  }),
  "task.ready": rule({
    capabilityId: "workspace.task.create",
    verb: { own: "execute", other: "administer" },
    record: "task",
    fields: ["status"],
  }),
  "task.assign": rule({
    capabilityId: "workspace.task.assign",
    verb: { own: "execute", other: "administer" },
    record: "task",
    fields: ["taskId", "assigneeId", "expectedRevision"],
  }),
  "question.request": rule({
    capabilityId: "workspace.question.request",
    verb: "execute",
    record: "question",
    fields: ["taskId", "question", "answerSchema", "respondentId"],
  }),
  "question.cancel": rule({
    capabilityId: "workspace.question.request",
    verb: { own: "execute", other: "administer" },
    record: "question",
    fields: ["status"],
  }),
  "question.answer": rule({
    capabilityId: "workspace.question.answer",
    verb: "execute",
    record: "question",
    respondentOnly: true,
    fields: ["questionId", "answer", "expectedRevision"],
  }),
} as const);
export type WorkPermissionKey = keyof typeof workPermissions;

/** The read capability of each aggregate: replay disclosure and target view need `status`. */
export const workAggregateReads = Object.freeze({
  goal: "goal.read",
  task: "task.read",
  question: "question.read",
} as const satisfies Record<string, WorkPermissionKey>);

/**
 * Eligibility (ADR-0010 item 4), held by the target: an assignee needs task.create
 * view over the task read fields; a respondent needs question.answer execute over
 * its input fields plus question.request view over the question read fields.
 */
export const workEligibility = Object.freeze({
  assignee: Object.freeze(["task.read"] as const),
  respondent: Object.freeze(["question.answer", "question.read"] as const),
} as const satisfies Record<string, readonly WorkPermissionKey[]>);

/** The verb a rule requires for an actor whose ownership basis is known. */
export function workVerb(key: WorkPermissionKey, basis: "own" | "other" | "none"): WorkVerb | null {
  const verb = workPermissions[key].verb;
  if (typeof verb === "string") return verb;
  return basis === "own" ? verb.own : basis === "other" ? verb.other : null;
}

/**
 * Approval record operations (P06.T01b §6; ADR-0010 item 1, ADR-0011 Q5). Each
 * requirement is one kernel request on the workspace W, decided at database time.
 * `capabilityId: "proposal"` is the proposal's own capability, and `fields:
 * "targets"` every field of every target it decides or reads; `proposer` is the
 * creating verb (`execute`, or `administer` for governance.connection.connect,
 * which no proposal may use yet). Ownership selects the task-attach verb.
 *
 * Declared deviation `governance-input-fields` (Tier 2 confirms): governance grant
 * fields are capability input names (ADR-0009 item 7), so these reads and commands
 * request input names while returning whole Proposal@2/Approval@2 objects and
 * parameters, whose property names template v1 cannot grant; own reads use the
 * proposer verb, not `view`; reviewer reads use `view` on the preview capability.
 * The contract check accepts the marker on these rows only.
 */
export type ApprovalVerb = "view" | "approve" | "execute" | "administer" | "proposer";
export interface ApprovalRequirement {
  readonly capabilityId:
    | "governance.approval.decide"
    | "governance.approval.preview"
    | "workspace.task.create"
    | "proposal";
  readonly verb: ApprovalVerb | Readonly<{ own: ApprovalVerb; other: ApprovalVerb }>;
  readonly fields: readonly string[] | "targets";
}
export interface ApprovalPermissionRule {
  readonly requirements: readonly ApprovalRequirement[];
  readonly deviation: "governance-input-fields" | null;
}
const approvalRule = (
  requirements: readonly ApprovalRequirement[],
  deviation: ApprovalPermissionRule["deviation"],
): Readonly<ApprovalPermissionRule> =>
  Object.freeze({
    requirements: Object.freeze(
      requirements.map((r) =>
        Object.freeze({
          ...r,
          fields: r.fields === "targets" ? "targets" : Object.freeze([...r.fields]),
        }),
      ),
    ),
    deviation,
  });
const previewView = {
  capabilityId: "governance.approval.preview",
  verb: "view",
  fields: ["proposalRef", "selectedTargetIndexes"],
} as const;
const decideApprove = {
  capabilityId: "governance.approval.decide",
  verb: "approve",
  fields: ["proposalRef", "decision", "expectedRevision"],
} as const;
export const approvalPermissions = Object.freeze({
  "proposal.submit": approvalRule(
    [{ capabilityId: "proposal", verb: "proposer", fields: "targets" }],
    "governance-input-fields",
  ),
  "proposal.task_attach": approvalRule(
    [
      {
        capabilityId: "workspace.task.create",
        verb: { own: "execute", other: "administer" },
        fields: ["status"],
      },
    ],
    null,
  ),
  "approval.reviewer_read": approvalRule(
    [previewView, decideApprove, { capabilityId: "proposal", verb: "approve", fields: "targets" }],
    "governance-input-fields",
  ),
  "approval.own_read": approvalRule(
    [{ capabilityId: "proposal", verb: "proposer", fields: "targets" }],
    "governance-input-fields",
  ),
  "approval.decide": approvalRule(
    [decideApprove, { capabilityId: "proposal", verb: "approve", fields: "targets" }],
    "governance-input-fields",
  ),
  "approval.withdraw": approvalRule(
    [{ capabilityId: "proposal", verb: "proposer", fields: "targets" }],
    "governance-input-fields",
  ),
  "approval.claim": approvalRule(
    [{ capabilityId: "proposal", verb: "execute", fields: "targets" }],
    "governance-input-fields",
  ),
} as const);
export type ApprovalPermissionKey = keyof typeof approvalPermissions;
/** The creating verb of a proposal's capability (kernel rule: connect is administer). */
export const proposerVerb = (capabilityId: string): "execute" | "administer" =>
  capabilityId === "governance.connection.connect" ? "administer" : "execute";
