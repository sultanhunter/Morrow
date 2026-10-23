import type { Current_ResourceList } from "@morrow/contracts";
import { validateCurrentDefinition, validateDefinition } from "@morrow/contracts/validation";

// Closed request bodies (P06.T01a §4.9), built on the generated v1 leaf
// validators; there is no runtime schema compilation. Each parser returns a fresh
// plain object or null. Tenant keys (organizationId, workspaceId, principalId) are
// unknown keys, and so are rejected like any other.
export interface GoalCreateBody {
  objective: string;
  storeIds: string[];
  successCriteria: {
    description: string;
    verificationCapabilityId: string | null;
    evidenceRequired: boolean;
  }[];
}
export interface GoalTransitionBody {
  to: "draft" | "active" | "paused" | "achieved" | "cancelled";
  expectedRevision: number;
}
export interface TaskCreateBody {
  goalId: string;
  objective: string;
  // A v1 ResourceList (Task@1 is unchanged): its ResourceRefs have no store kind.
  allowedResources: Current_ResourceList;
}
export interface TaskReadyBody {
  to: "ready";
  expectedRevision: number;
}
export interface TaskAssignBody {
  assigneeId: string;
  expectedRevision: number;
}
export interface QuestionRequestBody {
  question: string;
  respondentId: string;
}
export interface QuestionAnswerBody {
  text: string;
  expectedRevision: number;
}
export interface QuestionCancelBody {
  to: "cancelled";
  expectedRevision: number;
}
export const workBodyLimits = Object.freeze({
  bytes: 65536,
  text: 8192,
  successCriteria: 20,
  allowedResources: 1,
});

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !own.every((key) => keys.includes(key))) return null;
  return value as Record<string, unknown>;
}
/** 1..8192 Unicode characters, no NUL. */
export function workText(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\0")) return false;
  const length = [...value].length;
  return length >= 1 && length <= workBodyLimits.text;
}
const revision = (value: unknown): value is number => validateDefinition("core", "Revision", value);
const id = (value: unknown): value is string => validateDefinition("core", "Id", value);
/** True when any string anywhere in the value contains NUL. */
export function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\0");
  if (Array.isArray(value)) return value.some(containsNul);
  if (value !== null && typeof value === "object")
    return Object.entries(value).some(([key, item]) => key.includes("\0") || containsNul(item));
  return false;
}

export function parseGoalCreate(value: unknown): GoalCreateBody | null {
  const r = record(value, ["objective", "storeIds", "successCriteria"]);
  if (
    !r ||
    !workText(r.objective) ||
    !validateDefinition("core", "IdList", r.storeIds) ||
    !validateCurrentDefinition("CriteriaList", r.successCriteria) ||
    (r.successCriteria as unknown[]).length > workBodyLimits.successCriteria ||
    // POST /goals keeps the v1 shape: a measured goal (ADR-0033) belongs to a project's
    // goal record and is made by the plan start or workspace.goal.revise, never here.
    (r.successCriteria as Record<string, unknown>[]).some((c) => "key" in c || "measure" in c)
  )
    return null;
  return structuredClone(r) as unknown as GoalCreateBody;
}
export function parseGoalTransition(value: unknown): GoalTransitionBody | null {
  const r = record(value, ["to", "expectedRevision"]);
  if (!r || !validateDefinition("core", "GoalStatus", r.to) || !revision(r.expectedRevision))
    return null;
  return { to: r.to as GoalTransitionBody["to"], expectedRevision: r.expectedRevision };
}
export function parseTaskCreate(value: unknown): TaskCreateBody | null {
  const r = record(value, ["goalId", "objective", "allowedResources"]);
  if (
    !r ||
    !id(r.goalId) ||
    !workText(r.objective) ||
    !validateDefinition("core", "ResourceList", r.allowedResources) ||
    (r.allowedResources as unknown[]).length > workBodyLimits.allowedResources
  )
    return null;
  return structuredClone(r) as unknown as TaskCreateBody;
}
export function parseTaskReady(value: unknown): TaskReadyBody | null {
  const r = record(value, ["to", "expectedRevision"]);
  if (!r || r.to !== "ready" || !revision(r.expectedRevision)) return null;
  return { to: "ready", expectedRevision: r.expectedRevision };
}
export function parseTaskAssign(value: unknown): TaskAssignBody | null {
  const r = record(value, ["assigneeId", "expectedRevision"]);
  if (!r || !id(r.assigneeId) || !revision(r.expectedRevision)) return null;
  return { assigneeId: r.assigneeId, expectedRevision: r.expectedRevision };
}
export function parseQuestionRequest(value: unknown): QuestionRequestBody | null {
  const r = record(value, ["question", "respondentId"]);
  if (!r || !workText(r.question) || !id(r.respondentId)) return null;
  return { question: r.question, respondentId: r.respondentId };
}
export function parseQuestionAnswer(value: unknown): QuestionAnswerBody | null {
  const r = record(value, ["text", "expectedRevision"]);
  if (!r || !workText(r.text) || !revision(r.expectedRevision)) return null;
  return { text: r.text, expectedRevision: r.expectedRevision };
}
export function parseQuestionCancel(value: unknown): QuestionCancelBody | null {
  const r = record(value, ["to", "expectedRevision"]);
  if (!r || r.to !== "cancelled" || !revision(r.expectedRevision)) return null;
  return { to: "cancelled", expectedRevision: r.expectedRevision };
}
