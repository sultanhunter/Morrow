import { approvalStatements } from "./approvals/sql.js";

// Every statement the work API sends (ADR-0010 item 2). Source-fixed: no caller
// SQL, role, option or identifier is ever interpolated; values travel only as
// bind parameters. The prologue is the one fixed, parameter-free SET LOCAL ROLE.
// Every selected column is text, so the Neon driver and the laboratory adapter
// decode rows identically.

const prologue = (access: "READ ONLY" | "READ WRITE") =>
  `BEGIN ISOLATION LEVEL READ COMMITTED ${access}; SET LOCAL ROLE morrow_work_api; SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='1s'; SET LOCAL idle_in_transaction_session_timeout='5s'; SET LOCAL transaction_timeout='5s'`;

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const micros = (column: string) => `(extract(epoch FROM ${column})*1000000)::bigint::text`;
// Keyset pagination on (created_at, id): $a is the cursor's microseconds, $b its id.
const after = (alias: string, a: number, b: number) =>
  `($${a}::text IS NULL OR ${alias}.created_at>timestamptz 'epoch'+($${a}::text||' microseconds')::interval OR (${alias}.created_at=timestamptz 'epoch'+($${a}::text||' microseconds')::interval AND ${alias}.id::text COLLATE "C">$${b}::text COLLATE "C"))`;

const goalColumns = `g.id::text AS id,g.organization_id::text AS organization_id,g.workspace_id::text AS workspace_id,g.revision::text AS revision,g.status,g.objective,g.scope::text AS scope,g.success_criteria::text AS success_criteria,g.owner_principal_id::text AS owner_principal_id,g.owner_membership_id::text AS owner_membership_id,${utc("g.created_at")} AS created_at,${utc("g.updated_at")} AS updated_at,${micros("g.created_at")} AS cursor_us,COALESCE((SELECT jsonb_agg(t.id::text ORDER BY t.created_at,t.id::text COLLATE "C") FROM morrow_work.tasks t WHERE t.organization_id=g.organization_id AND t.workspace_id=g.workspace_id AND t.goal_id=g.id),'[]'::jsonb)::text AS task_ids`;
const taskColumns = `t.id::text AS id,t.organization_id::text AS organization_id,t.workspace_id::text AS workspace_id,t.revision::text AS revision,t.goal_id::text AS goal_id,t.status,t.objective,t.scope::text AS scope,t.initiator_principal_id::text AS initiator_principal_id,t.initiator_membership_id::text AS initiator_membership_id,t.owner_principal_id::text AS owner_principal_id,t.owner_membership_id::text AS owner_membership_id,${utc("t.created_at")} AS created_at,${utc("t.updated_at")} AS updated_at,${micros("t.created_at")} AS cursor_us`;
const questionColumns = `q.id::text AS id,q.organization_id::text AS organization_id,q.workspace_id::text AS workspace_id,q.revision::text AS revision,q.task_id::text AS task_id,q.status,q.prompt,q.respondent_principal_id::text AS respondent_principal_id,a.id::text AS answer_id,a.body_digest::text AS answer_digest,a.answered_by_principal_id::text AS answered_by_principal_id,a.answered_by_membership_id::text AS answered_by_membership_id,${utc("q.created_at")} AS created_at,${utc("q.updated_at")} AS updated_at,${micros("q.created_at")} AS cursor_us`;
const questionFrom = `morrow_work.questions q LEFT JOIN morrow_work.question_answers a ON a.organization_id=q.organization_id AND a.workspace_id=q.workspace_id AND a.question_id=q.id`;

export const workStatements = Object.freeze({
  prologueReadOnly: prologue("READ ONLY"),
  prologueReadWrite: prologue("READ WRITE"),
  commit: "COMMIT",
  rollback: "ROLLBACK",
  enterContext:
    "SELECT principal_id,organization_id,workspace_id,membership_id,policy_revision,grants,grant_count,grants_digest,database_now_us FROM morrow_work.enter_context($1,$2)",
  beginCommand:
    "SELECT outcome,aggregate_type,aggregate_id,result FROM morrow_work.begin_command($1,$2,$3)",
  targetMember:
    "SELECT membership_id,grants,grant_count,grants_digest FROM morrow_work.target_member($1)",
  cmdGoalCreate: "SELECT outcome,result FROM morrow_work.cmd_goal_create($1,$2,$3,$4,$5)",
  cmdGoalTransition:
    "SELECT outcome,result FROM morrow_work.cmd_goal_transition($1,$2,$3,$4,$5,$6,$7)",
  cmdTaskCreate: "SELECT outcome,result FROM morrow_work.cmd_task_create($1,$2,$3,$4,$5,$6)",
  cmdTaskReady: "SELECT outcome,result FROM morrow_work.cmd_task_ready($1,$2,$3,$4,$5,$6)",
  cmdTaskAssign: "SELECT outcome,result FROM morrow_work.cmd_task_assign($1,$2,$3,$4,$5,$6,$7,$8)",
  cmdQuestionRequest:
    "SELECT outcome,result FROM morrow_work.cmd_question_request($1,$2,$3,$4,$5,$6,$7)",
  cmdQuestionAnswer:
    "SELECT outcome,result FROM morrow_work.cmd_question_answer($1,$2,$3,$4,$5,$6,$7)",
  cmdQuestionCancel:
    "SELECT outcome,result FROM morrow_work.cmd_question_cancel($1,$2,$3,$4,$5,$6)",
  // Command targets, read under RLS before the verb decision.
  goalTarget:
    "SELECT g.status,g.revision::text AS revision,g.owner_principal_id::text AS owner_principal_id,g.owner_membership_id::text AS owner_membership_id FROM morrow_work.goals g WHERE g.id=$1::text",
  taskTarget:
    "SELECT t.status,t.revision::text AS revision,t.owner_principal_id::text AS owner_principal_id,t.owner_membership_id::text AS owner_membership_id FROM morrow_work.tasks t WHERE t.id=$1::text",
  questionTarget:
    "SELECT q.status,q.revision::text AS revision,q.requester_principal_id::text AS owner_principal_id,q.requester_membership_id::text AS owner_membership_id,q.respondent_principal_id::text AS respondent_principal_id,q.respondent_membership_id::text AS respondent_membership_id FROM morrow_work.questions q WHERE q.id=$1::text",
  // Reads. $n LIMIT values are the page size plus one.
  goalById: `SELECT ${goalColumns} FROM morrow_work.goals g WHERE g.id=$1::text`,
  goalPage: `SELECT ${goalColumns} FROM morrow_work.goals g WHERE ${after("g", 1, 2)} ORDER BY g.created_at,g.id::text COLLATE "C" LIMIT $3::integer`,
  taskById: `SELECT ${taskColumns} FROM morrow_work.tasks t WHERE t.id=$1::text`,
  taskPage: `SELECT ${taskColumns} FROM morrow_work.tasks t WHERE ($1::text IS NULL OR t.goal_id=$1::text) AND ($2::text IS NULL OR t.status=$2::text) AND ${after("t", 3, 4)} ORDER BY t.created_at,t.id::text COLLATE "C" LIMIT $5::integer`,
  questionById: `SELECT ${questionColumns} FROM ${questionFrom} WHERE q.id=$1::text`,
  questionPageOfTask: `SELECT ${questionColumns} FROM ${questionFrom} WHERE q.task_id=$1::text AND ${after("q", 2, 3)} ORDER BY q.created_at,q.id::text COLLATE "C" LIMIT $4::integer`,
  questionPageForRespondent: `SELECT ${questionColumns} FROM ${questionFrom} WHERE q.respondent_principal_id=$1::text AND ($2::text IS NULL OR q.status=$2::text) AND ${after("q", 3, 4)} ORDER BY q.created_at,q.id::text COLLATE "C" LIMIT $5::integer`,
  answerOfQuestion: `SELECT a.id::text AS id,a.organization_id::text AS organization_id,a.workspace_id::text AS workspace_id,a.question_id::text AS question_id,a.body,a.body_digest::text AS body_digest,a.answered_by_principal_id::text AS answered_by_principal_id,a.answered_by_membership_id::text AS answered_by_membership_id,${utc("a.created_at")} AS created_at FROM morrow_work.question_answers a WHERE a.question_id=$1::text`,
  // The approval records (P06.T01b), from their own fixed table.
  ...approvalStatements,
} as const);
export type WorkStatementName = keyof typeof workStatements;
