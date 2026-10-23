import type {
  Current_CriteriaList,
  Current_GoalAssistant,
  Current_GoalCheckAnswer,
} from "@morrow/contracts";
import { validateCapabilityInput, validateCurrentDefinition } from "@morrow/contracts/validation";
import { areaTemplate, type AreaId } from "@morrow/policy/projects";

// Closed request bodies of the goal and plan-start routes (PR 18). Each parser returns a
// fresh plain object or null. Tenant, workspace, actor, grant, role and start values are
// never body fields: a criterion's startRef must be null (the server derives the start), a
// check's value, read tags, class and clock are the server's, and the start document is
// built by the server from the card it names.
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !own.every((key) => keys.includes(key))) return null;
  return value as Record<string, unknown>;
}
const hex64 = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export interface GoalReviseBody {
  readonly expectedRevision: number;
  readonly objective: string;
  readonly dueAt: string | null;
  readonly successCriteria: Current_CriteriaList;
}
/**
 * POST /goals/:goalId/revise: workspace.goal.revise's v1.1 input without the path's goal id.
 * The current CriteriaList (its code rules too), at most 20 criteria, every stored measure's
 * startRef null, and a dueAt with millisecond precision.
 */
export function parseGoalReviseBody(goalId: string, body: unknown): GoalReviseBody | null {
  const r = record(body, ["expectedRevision", "objective", "dueAt", "successCriteria"]);
  if (!r) return null;
  const input = { goalId, ...r };
  if (
    !validateCapabilityInput("workspace.goal.revise", input) ||
    !validateCurrentDefinition("CriteriaList", r.successCriteria)
  )
    return null;
  const criteria = r.successCriteria as Current_CriteriaList;
  if (criteria.length > 20) return null;
  if (
    criteria.some(
      (c) => c.measure !== undefined && c.measure !== null && c.measure.startRef !== null,
    )
  )
    return null;
  const dueAt = r.dueAt as string | null;
  if (dueAt !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(dueAt))
    return null;
  // No measure due after its dated record (the Goal rule of validateCurrentDefinition).
  if (
    dueAt !== null &&
    criteria.some(
      (c) =>
        c.measure !== undefined &&
        c.measure !== null &&
        c.measure.dueAt !== null &&
        Date.parse(c.measure.dueAt) > Date.parse(dueAt),
    )
  )
    return null;
  return structuredClone({
    expectedRevision: r.expectedRevision as number,
    objective: r.objective as string,
    dueAt,
    successCriteria: criteria,
  });
}

export interface GoalCheckBody {
  readonly key: string;
  readonly productId: string;
  readonly assistant: Current_GoalAssistant;
  readonly answers: readonly Current_GoalCheckAnswer[];
}
/** POST /goals/:goalId/checks: workspace.goal.measure.record's input without the goal id. */
export function parseGoalCheckBody(goalId: string, body: unknown): GoalCheckBody | null {
  const r = record(body, ["key", "productId", "assistant", "answers"]);
  if (!r || !validateCapabilityInput("workspace.goal.measure.record", { goalId, ...r }))
    return null;
  return structuredClone({
    key: r.key as string,
    productId: r.productId as string,
    assistant: r.assistant as Current_GoalAssistant,
    answers: r.answers as Current_GoalCheckAnswer[],
  });
}

export type StartDocumentBody =
  | { readonly kind: "draft"; readonly messageId: string; readonly draftDigest: string }
  | { readonly kind: "area"; readonly areaTemplateId: AreaId }
  | { readonly kind: "quick_tasks" };
/**
 * POST /plans/start-document: a Morrow card by its message id and the digest the person saw
 * (`{messageId, draftDigest}`), or a card code builds (`{card: {kind: "area",
 * areaTemplateId}}` or `{card: {kind: "quick_tasks"}}`). Nothing else: the server builds the
 * document.
 */
export function parseStartDocumentBody(body: unknown): StartDocumentBody | null {
  const draft = record(body, ["messageId", "draftDigest"]);
  if (draft) {
    if (!validateCurrentDefinition("NullableId", draft.messageId) || draft.messageId === null)
      return null;
    if (!hex64(draft.draftDigest)) return null;
    return { kind: "draft", messageId: draft.messageId as string, draftDigest: draft.draftDigest };
  }
  const coded = record(body, ["card"]);
  if (!coded) return null;
  const quick = record(coded.card, ["kind"]);
  if (quick && quick.kind === "quick_tasks") return { kind: "quick_tasks" };
  const area = record(coded.card, ["kind", "areaTemplateId"]);
  if (
    !area ||
    area.kind !== "area" ||
    typeof area.areaTemplateId !== "string" ||
    area.areaTemplateId === "quick_tasks" ||
    areaTemplate(area.areaTemplateId as AreaId) === null
  )
    return null;
  return { kind: "area", areaTemplateId: area.areaTemplateId as AreaId };
}

export interface StartBody {
  readonly documentDigest: string;
  readonly nonce: string;
}
/** POST /plans/start: the confirmed document's digest and its single-use nonce. */
export function parseStartBody(body: unknown): StartBody | null {
  const r = record(body, ["documentDigest", "nonce"]);
  if (!r || !hex64(r.documentDigest) || !hex64(r.nonce)) return null;
  return { documentDigest: r.documentDigest, nonce: r.nonce };
}
