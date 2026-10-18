import { validateDefinition } from "@morrow/contracts/validation";
import { workPermissions, type WorkPermissionKey } from "@morrow/contracts/work-permissions";
import { WorkReject, type WorkTx } from "./connection.js";
import { enterWorkContext, type WorkAuthority } from "./context.js";
import {
  decodeCursor,
  encodeCursor,
  mapAnswer,
  mapGoal,
  mapQuestion,
  mapTask,
} from "./contract-mapping.js";
import type { GuardedWorkRequest } from "./http-guard.js";
import { decideWork } from "./permissions.js";
import type { WorkStatementName } from "./sql.js";

// Reads (P06.T01a §4.7): READ ONLY prologue, enter_context, view checks, fixed
// SELECTs under RLS. No locks. A read requests every non-metadata field it
// returns, so an uncovered field is 403 field_denied, never a partial object.
// A single record the actor may not view is 404, identical to an absent one; a
// list the actor may not view is 403.

export type WorkReadKind =
  | "goal.list"
  | "goal.get"
  | "task.list"
  | "task.get"
  | "question.list_of_task"
  | "question.list"
  | "question.get"
  | "answer.get";
export interface WorkReadResult {
  readonly body: Readonly<Record<string, unknown>>;
}
type Row = Readonly<Record<string, unknown>>;

async function view(
  a: WorkAuthority,
  key: WorkPermissionKey,
  kind: "list" | "single",
): Promise<void> {
  const rule = workPermissions[key];
  const decision = await decideWork(a, rule.capabilityId, "view", rule.fields);
  if (decision.allowed) return;
  if (decision.reason === "field_denied") throw new WorkReject("field_denied");
  throw new WorkReject(kind === "list" ? "denied" : "not_found");
}
function limit(g: GuardedWorkRequest, max: number): number {
  const value = g.query.get("limit");
  if (value === undefined) return max;
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > max) throw new WorkReject("invalid");
  return Number(value);
}
function cursor(g: GuardedWorkRequest): readonly [string | null, string | null] {
  const value = g.query.get("after");
  if (value === undefined) return [null, null];
  const decoded = decodeCursor(value);
  if (!decoded) throw new WorkReject("invalid");
  return decoded;
}
function optionalId(g: GuardedWorkRequest, key: string): string | null {
  const value = g.query.get(key);
  if (value === undefined) return null;
  if (!validateDefinition("core", "Id", value)) throw new WorkReject("invalid");
  return value;
}
function optionalEnum(g: GuardedWorkRequest, key: string, definition: string): string | null {
  const value = g.query.get(key);
  if (value === undefined) return null;
  if (!validateDefinition("core", definition, value)) throw new WorkReject("invalid");
  return value;
}
async function page<T>(
  tx: WorkTx,
  statement: WorkStatementName,
  values: (string | null)[],
  size: number,
  map: (row: Row) => T,
): Promise<Record<string, unknown>> {
  const rows = await tx.run(statement, [...values, String(size + 1)]);
  const items = rows.slice(0, size);
  return {
    items: items.map(map),
    next: rows.length > size && items.length ? encodeCursor(items[items.length - 1]!) : null,
  };
}
async function exists(tx: WorkTx, statement: WorkStatementName, id: string): Promise<void> {
  if ((await tx.run(statement, [id])).length !== 1) throw new WorkReject("not_found");
}

/** Validates a read's query before any connection opens. */
export function prepareWorkRead(kind: WorkReadKind, g: GuardedWorkRequest): void {
  if (kind === "question.list" && g.query.get("respondent") !== "me")
    throw new WorkReject("invalid");
  if (kind === "goal.list") limit(g, 25);
  if (kind === "task.list" || kind === "question.list_of_task" || kind === "question.list")
    limit(g, 50);
  if (kind.endsWith("list") || kind === "question.list_of_task") cursor(g);
  if (kind === "task.list") {
    optionalId(g, "goalId");
    optionalEnum(g, "status", "TaskStatus");
  }
  if (kind === "question.list") optionalEnum(g, "status", "QuestionStatus");
}

export async function runWorkRead(
  tx: WorkTx,
  g: GuardedWorkRequest,
  kind: WorkReadKind,
): Promise<WorkReadResult> {
  const a = await enterWorkContext(tx, g.sessionDigest, g.workspaceId);
  if (a === "ineligible") throw new WorkReject("unauthenticated");
  if (a === "grant_overflow") throw new WorkReject("grant_overflow");
  const p = g.params;
  switch (kind) {
    case "goal.list": {
      await view(a, "goal.read", "list");
      const [us, id] = cursor(g);
      return { body: await page(tx, "goalPage", [us, id], limit(g, 25), (r) => mapGoal(r, a)) };
    }
    case "goal.get": {
      await view(a, "goal.read", "single");
      const rows = await tx.run("goalById", [p.goalId!]);
      if (rows.length !== 1) throw new WorkReject("not_found");
      return { body: { goal: mapGoal(rows[0]!, a) } };
    }
    case "task.list": {
      await view(a, "task.read", "list");
      const goalId = optionalId(g, "goalId");
      if (goalId !== null) await exists(tx, "goalTarget", goalId);
      const [us, id] = cursor(g);
      const status = optionalEnum(g, "status", "TaskStatus");
      return {
        body: await page(tx, "taskPage", [goalId, status, us, id], limit(g, 50), (r) =>
          mapTask(r, a),
        ),
      };
    }
    case "task.get": {
      await view(a, "task.read", "single");
      const rows = await tx.run("taskById", [p.taskId!]);
      if (rows.length !== 1) throw new WorkReject("not_found");
      return { body: { task: mapTask(rows[0]!, a) } };
    }
    case "question.list_of_task": {
      await view(a, "question.read", "list");
      await exists(tx, "taskTarget", p.taskId!);
      const [us, id] = cursor(g);
      return {
        body: await page(tx, "questionPageOfTask", [p.taskId!, us, id], limit(g, 50), (r) =>
          mapQuestion(r, a),
        ),
      };
    }
    case "question.list": {
      await view(a, "question.read", "list");
      const [us, id] = cursor(g);
      const status = optionalEnum(g, "status", "QuestionStatus");
      return {
        body: await page(
          tx,
          "questionPageForRespondent",
          [a.actor.principalId, status, us, id],
          limit(g, 50),
          (r) => mapQuestion(r, a),
        ),
      };
    }
    case "question.get": {
      await view(a, "question.read", "single");
      const rows = await tx.run("questionById", [p.questionId!]);
      if (rows.length !== 1) throw new WorkReject("not_found");
      return { body: { question: mapQuestion(rows[0]!, a) } };
    }
    case "answer.get": {
      await view(a, "answer.read", "single");
      const rows = await tx.run("answerOfQuestion", [p.questionId!]);
      if (rows.length !== 1) throw new WorkReject("not_found");
      return { body: { answer: mapAnswer(rows[0]!, a) } };
    }
  }
}
