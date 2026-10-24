import type {
  Core_ActorRef,
  Core_Question,
  Core_SchemaRef,
  Core_Task,
  Current_AreaTemplateId,
  Current_Goal,
} from "@morrow/contracts";
import { validateCurrentDefinition, validateDefinition } from "@morrow/contracts/validation";
import type { WorkAuthority } from "./context.js";
import { answerTextSchemaDigest } from "./digest.js";

// Rows → v1 objects (P06.T01a §4.9). Every object passes the generated v1
// validator before it is sent (a goal, the current Goal: v1.1, a declared superset of v1,
// ADR-0033 item 2); a row that cannot map is a server fault (503), never a partial object.
export class WorkMappingError extends Error {
  constructor() {
    super("WORK_MAPPING_INVALID");
    this.name = "WorkMappingError";
  }
}
type Row = Readonly<Record<string, unknown>>;
const fail = (): never => {
  throw new WorkMappingError();
};
const text = (row: Row, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : fail();
};
const json = (row: Row, key: string): unknown => {
  try {
    return JSON.parse(text(row, key));
  } catch {
    return fail();
  }
};
const revision = (row: Row, key = "revision"): number => {
  const value = text(row, key);
  return /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : fail();
};
function tenant(row: Row, a: WorkAuthority): void {
  if (row.organization_id !== a.actor.organizationId || row.workspace_id !== a.actor.workspaceId)
    fail();
}
export function workActorRef(
  a: WorkAuthority,
  principalId: string,
  membershipId: string,
): Core_ActorRef {
  return {
    kind: "human",
    principalId,
    organizationId: a.actor.organizationId,
    workspaceId: a.actor.workspaceId,
    membershipId,
    installationId: null,
    mandateId: null,
  };
}
export function answerSchemaRef(a: WorkAuthority): Core_SchemaRef {
  return {
    organizationId: a.actor.organizationId,
    workspaceId: a.resource.workspaceId,
    storeId: null,
    kind: "schema",
    id: "morrow.answer.text",
    revision: 1,
    digest: answerTextSchemaDigest,
  };
}
function checked<T>(name: "Task" | "Question", value: T): T {
  return validateDefinition("core", name, value) ? value : fail();
}

const nullableText = (row: Row, key: string): string | null =>
  row[key] === null || row[key] === undefined ? null : text(row, key);
export function mapGoal(row: Row, a: WorkAuthority): Current_Goal {
  tenant(row, a);
  const goal: Current_Goal = {
    schemaVersion: 1,
    id: text(row, "id"),
    organizationId: text(row, "organization_id"),
    workspaceId: text(row, "workspace_id"),
    storeId: null,
    revision: revision(row),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    status: text(row, "status") as Current_Goal["status"],
    objective: text(row, "objective"),
    scope: json(row, "scope") as Current_Goal["scope"],
    owner: workActorRef(a, text(row, "owner_principal_id"), text(row, "owner_membership_id")),
    successCriteria: json(row, "success_criteria") as Current_Goal["successCriteria"],
    taskIds: json(row, "task_ids") as string[],
    dueAt: nullableText(row, "due_at"),
    areaTemplateId: nullableText(row, "area_template_id") as Current_AreaTemplateId | null,
  };
  return validateCurrentDefinition("Goal", goal) ? goal : fail();
}

export function mapTask(row: Row, a: WorkAuthority): Core_Task {
  tenant(row, a);
  return checked("Task", {
    schemaVersion: 1,
    id: text(row, "id"),
    organizationId: text(row, "organization_id"),
    workspaceId: text(row, "workspace_id"),
    storeId: null,
    revision: revision(row),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    goalId: text(row, "goal_id"),
    parentTaskId: null,
    status: text(row, "status") as Core_Task["status"],
    objective: text(row, "objective"),
    scope: json(row, "scope") as Core_Task["scope"],
    initiatingPrincipal: workActorRef(
      a,
      text(row, "initiator_principal_id"),
      text(row, "initiator_membership_id"),
    ),
    owner: workActorRef(a, text(row, "owner_principal_id"), text(row, "owner_membership_id")),
    dependencyIds: [],
    acceptedArtifactRefs: [],
    completionEvidenceRefs: [],
    leaseGeneration: 0,
    activeRunId: null,
  });
}

export function mapQuestion(row: Row, a: WorkAuthority): Core_Question {
  tenant(row, a);
  const answered = row.answer_id !== null;
  return checked("Question", {
    schemaVersion: 1,
    id: text(row, "id"),
    organizationId: text(row, "organization_id"),
    workspaceId: text(row, "workspace_id"),
    storeId: null,
    revision: revision(row),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    taskId: text(row, "task_id"),
    status: text(row, "status") as Core_Question["status"],
    prompt: text(row, "prompt"),
    answerSchemaRef: answerSchemaRef(a),
    eligibleRespondentIds: [text(row, "respondent_principal_id")],
    blocksTask: false,
    expiresAt: null,
    answerRef: answered
      ? {
          organizationId: a.actor.organizationId,
          workspaceId: a.resource.workspaceId,
          storeId: null,
          kind: "answer",
          id: text(row, "answer_id"),
          revision: 1,
          digest: text(row, "answer_digest"),
        }
      : null,
    answeredBy: answered
      ? workActorRef(
          a,
          text(row, "answered_by_principal_id"),
          text(row, "answered_by_membership_id"),
        )
      : null,
  });
}

export interface WorkAnswer {
  readonly id: string;
  readonly questionId: string;
  readonly body: string;
  readonly answeredBy: Core_ActorRef;
  readonly createdAt: string;
}
export function mapAnswer(row: Row, a: WorkAuthority): WorkAnswer {
  // The same second check as every other mapper: the answer body is free text, so
  // a row of another tenant is a server fault, never relabelled as this tenant's.
  tenant(row, a);
  const answer = {
    id: text(row, "id"),
    questionId: text(row, "question_id"),
    body: text(row, "body"),
    answeredBy: workActorRef(
      a,
      text(row, "answered_by_principal_id"),
      text(row, "answered_by_membership_id"),
    ),
    createdAt: text(row, "created_at"),
  };
  if (
    !validateDefinition("core", "Id", answer.id) ||
    !validateDefinition("core", "Id", answer.questionId) ||
    !validateDefinition("core", "ActorRef", answer.answeredBy) ||
    !validateDefinition("core", "UtcTime", answer.createdAt) ||
    answer.body.length < 1
  )
    fail();
  return answer;
}

// Opaque keyset cursors: base64url(JSON [created_at microseconds, id]).
export function encodeCursor(row: Row): string {
  const value = JSON.stringify([text(row, "cursor_us"), text(row, "id")]);
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decodeCursor(cursor: string): readonly [string, string] | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) return null;
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(binary, (c) => c.charCodeAt(0)),
      ),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      !/^[1-9][0-9]{0,17}$/.test(value[0]) ||
      !validateDefinition("core", "Id", value[1])
    )
      return null;
    return [value[0], value[1] as string];
  } catch {
    return null;
  }
}
