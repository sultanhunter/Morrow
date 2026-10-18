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
 * Collaboration permission rows v1.1 (ADR-0016; P01.T02c §7), under the same
 * ADR-0010 item 1 rules: reads are `view` on the capability that creates the
 * record and request every non-metadata field they return, ownership selects
 * the verb, the resource is W unless stated, and metadata is never gated. They
 * are a separate table so the ADR-0010 v1 work vocabulary, its routes and its
 * grant fixtures stay byte-stable. They confer nothing; the policy kernel decides.
 *
 * - A project, and a project conversation's subject, are read with goal view.
 * - An Ask is read by its owner (`view` on `workspace.conversation.post`); agents
 *   only through the owner's Ask-bound envelope (P05.T04b). A workspace admin
 *   reads another member's Ask only through the audited, read-only admin row.
 * - Message reads and posts also need the subject view and every restricted
 *   source or part requirement (`everySource`).
 * - Access-request deciders are eligible reviewers of the would-be
 *   `governance.grants.revise` proposal (ADR-0011 Q5), never the requester.
 * - A stop proposal is dismissed by `execute` on its kill switch over every
 *   target, decided by `checkKillSwitchTarget`.
 */
export type CollaborationCapabilityId =
  | "workspace.goal.create"
  | "workspace.task.create"
  | "workspace.conversation.create"
  | "workspace.conversation.post"
  | "workspace.project.create"
  | "workspace.project.revise"
  | "workspace.project.pin"
  | "workspace.inbox.read"
  | "workspace.inbox.mark"
  | "governance.access.request"
  | "governance.approval.decide"
  | "governance.grants.revise";
export type CollaborationVerb = "view" | "execute" | "administer" | "approve";
/** Whose request this is: anyone with the grant, or the one principal the record names. */
export type CollaborationHolder =
  | "actor"
  | "ask_owner"
  | "ask_admin"
  | "recipient"
  | "requester"
  | "decider";
/** The resource of a requirement: W, each requested resource, store and account (W when none), or every kill-switch target. */
export type CollaborationResource = "workspace" | "requested_scope" | "kill_switch_targets";
export interface CollaborationGrantRequirement {
  readonly kind: "grant";
  readonly capabilityId: CollaborationCapabilityId;
  readonly verb: CollaborationVerb | Readonly<{ own: CollaborationVerb; other: CollaborationVerb }>;
  readonly fields: readonly string[];
  readonly resource: CollaborationResource;
}
/** `execute` on the proposal's own kill-switch capability over every target (P01.T02a §5). */
export interface KillSwitchExecuteRequirement {
  readonly kind: "kill_switch_execute";
  readonly resource: "kill_switch_targets";
}
/** Why a returned property needs no requested field. */
export type UngatedReason =
  | "subject_key"
  | "viewer_identity"
  | "viewer_relative_position"
  | `derived_from:${string}`;
export interface CollaborationReadShape {
  /** The current definition the read returns. */
  readonly definition: "Project" | "Conversation" | "Message" | "InboxItem" | "AccessRequest";
  /** Prepended to a returned property name to form the requested field. */
  readonly prefix: string;
  readonly ungated: Readonly<Record<string, UngatedReason>>;
}
export interface CollaborationPermissionRule {
  /** All of these. */
  readonly requires: readonly (CollaborationGrantRequirement | KillSwitchExecuteRequirement)[];
  /** Other rows that must also pass. */
  readonly composes: readonly string[];
  readonly holder: CollaborationHolder;
  /** How an agent reaches the row: the agent kernel (task envelope or mandate), the P05.T04b Ask envelope, or never. */
  readonly agents: "kernel" | "ask_envelope" | "never";
  readonly reads: CollaborationReadShape | null;
  /** Each read writes one content-free AskAdminReadRecord in its transaction (ADR-0016 item 5). */
  readonly audited: boolean;
  /** Also every restricted source of each message, or every part requirement of a post. */
  readonly everySource: boolean;
}

const grantOn = (
  capabilityId: CollaborationCapabilityId,
  verb: CollaborationGrantRequirement["verb"],
  fields: readonly string[],
  resource: CollaborationResource = "workspace",
): CollaborationGrantRequirement =>
  Object.freeze({
    kind: "grant",
    capabilityId,
    verb: typeof verb === "string" ? verb : Object.freeze({ ...verb }),
    fields: Object.freeze([...fields]),
    resource,
  });
const row = (
  r: Partial<CollaborationPermissionRule> & Pick<CollaborationPermissionRule, "requires">,
): Readonly<CollaborationPermissionRule> =>
  Object.freeze({
    composes: Object.freeze([...(r.composes ?? [])]),
    holder: r.holder ?? "actor",
    agents: r.agents ?? "never",
    reads: r.reads
      ? Object.freeze({ ...r.reads, ungated: Object.freeze({ ...r.reads.ungated }) })
      : null,
    audited: r.audited ?? false,
    everySource: r.everySource ?? false,
    requires: Object.freeze([...r.requires]),
  });
const subjectFields = ["objective", "status"] as const;
const messageFields = [
  "author",
  "status",
  "parts",
  "replyToMessageId",
  "restrictedSources",
  "contextTaint",
  "origin",
] as const;

export const collaborationPermissions = Object.freeze({
  "project.read": row({
    requires: [
      grantOn("workspace.goal.create", "view", [
        ...subjectFields,
        "project.title",
        "project.pinned",
        "project.tabs",
      ]),
    ],
    agents: "kernel",
    reads: {
      definition: "Project",
      prefix: "project.",
      ungated: { goalId: "subject_key", pinRank: "derived_from:project.pinned" },
    },
  }),
  "project.subjectView": row({
    requires: [grantOn("workspace.goal.create", "view", subjectFields)],
    agents: "kernel",
  }),
  "task.subjectView": row({
    requires: [grantOn("workspace.task.create", "view", subjectFields)],
    agents: "kernel",
  }),
  "ask.read": row({
    requires: [grantOn("workspace.conversation.post", "view", ["subject"])],
    holder: "ask_owner",
    agents: "ask_envelope",
    reads: {
      definition: "Conversation",
      prefix: "",
      ungated: { lastPosition: "viewer_relative_position" },
    },
  }),
  "ask.adminRead": row({
    requires: [grantOn("workspace.conversation.create", "administer", ["storeId", "subject"])],
    composes: ["message.read"],
    holder: "ask_admin",
    reads: {
      definition: "Conversation",
      prefix: "",
      ungated: { lastPosition: "viewer_relative_position" },
    },
    audited: true,
  }),
  "message.read": row({
    requires: [grantOn("workspace.conversation.post", "view", messageFields)],
    agents: "kernel",
    reads: {
      definition: "Message",
      prefix: "",
      ungated: { conversationId: "subject_key", position: "viewer_relative_position" },
    },
    everySource: true,
  }),
  "ask.create": row({
    requires: [grantOn("workspace.conversation.create", "execute", ["storeId"])],
  }),
  "message.post": row({
    requires: [grantOn("workspace.conversation.post", "execute", ["parts", "replyToMessageId"])],
    agents: "kernel",
    everySource: true,
  }),
  "project.create": row({
    requires: [grantOn("workspace.project.create", "execute", ["goalId", "title", "tabs"])],
    composes: ["project.subjectView"],
  }),
  "project.revise": row({
    // Ownership is the goal owner's: own → execute, another member's → administer.
    requires: [
      grantOn("workspace.project.revise", { own: "execute", other: "administer" }, [
        "title",
        "tabs",
      ]),
    ],
    composes: ["project.subjectView"],
    agents: "kernel",
  }),
  "project.pin": row({
    requires: [
      grantOn("workspace.project.pin", { own: "execute", other: "administer" }, [
        "pinned",
        "beforeProjectId",
      ]),
    ],
    composes: ["project.subjectView"],
  }),
  "inbox.read": row({
    requires: [
      grantOn("workspace.inbox.read", "view", [
        "kind",
        "subject",
        "decisionState",
        "open",
        "readState",
        "readAt",
        "context",
      ]),
    ],
    holder: "recipient",
    reads: {
      definition: "InboxItem",
      prefix: "",
      ungated: { recipientPrincipalId: "viewer_identity", position: "viewer_relative_position" },
    },
  }),
  "inbox.mark": row({
    // Recipient only: administer never marks another member's items.
    requires: [grantOn("workspace.inbox.mark", "execute", ["itemIds", "state"])],
    holder: "recipient",
  }),
  "accessRequest.create": row({
    requires: [grantOn("governance.access.request", "execute", ["scope", "reason", "context"])],
  }),
  "accessRequest.read": row({
    requires: [
      grantOn("governance.access.request", "view", [
        "requester",
        "scope",
        "reason",
        "context",
        "status",
        "proposalRef",
        "decidedBy",
        "expiresAt",
      ]),
    ],
    holder: "requester",
    reads: { definition: "AccessRequest", prefix: "", ungated: {} },
  }),
  "accessRequest.withdraw": row({
    // Requester only: administer never withdraws for someone else.
    requires: [grantOn("governance.access.request", "execute", ["status"])],
    holder: "requester",
  }),
  "accessRequest.decide": row({
    // Read and deny by a decider (ADR-0011 Q5); P05.T02b confirms the grant-revision target fields.
    requires: [
      grantOn("governance.approval.decide", "approve", ["decision"]),
      grantOn(
        "governance.grants.revise",
        "approve",
        ["capabilityId", "verbs", "scope", "expiresAt"],
        "requested_scope",
      ),
    ],
    holder: "decider",
  }),
  "stopProposal.dismiss": row({
    requires: [Object.freeze({ kind: "kill_switch_execute", resource: "kill_switch_targets" })],
  }),
} as const);
export type CollaborationPermissionKey = keyof typeof collaborationPermissions;

/**
 * The Ask admin grant (ADR-0016 item 5): only owner template v2 and
 * `workspace-admin-v2` may carry it; no `workspace-member-*` template version
 * ever does. The binding template check of the template-v2 packet and of
 * P05.T01z's later versions: returns the ids of the templates that violate it.
 */
export const askAdminGrant = Object.freeze({
  capabilityId: "workspace.conversation.create",
  verb: "administer",
} as const);
export interface GrantTemplateSummary {
  readonly id: string;
  readonly grants: readonly { readonly capabilityId: string; readonly verbs: readonly string[] }[];
}
export function askAdminTemplateViolations(templates: readonly GrantTemplateSummary[]): string[] {
  return templates
    .filter(
      (t) =>
        t.id.startsWith("workspace-member-") &&
        t.grants.some(
          (g) =>
            g.capabilityId === askAdminGrant.capabilityId && g.verbs.includes(askAdminGrant.verb),
        ),
    )
    .map((t) => t.id);
}
