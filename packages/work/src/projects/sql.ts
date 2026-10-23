// Every statement the goal and plan-start routes send (PR 18; migration 0039), merged into
// workStatements so WorkTx.run accepts no other text. Source fixed: values travel only as
// bind parameters, and every selected column is text.

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const projectStatements = Object.freeze({
  beginProjectCommand:
    "SELECT outcome,aggregate_type,aggregate_id,result FROM morrow_work.begin_project_command($1,$2,$3)",
  cmdGoalRevise:
    "SELECT outcome,result FROM morrow_work.cmd_goal_revise($1,$2,$3,$4,$5,$6,$7,$8,$9)",
  cmdGoalCheck: "SELECT outcome,result FROM morrow_work.cmd_goal_check($1,$2,$3,$4,$5,$6,$7,$8,$9)",
  cmdPlanStartDocument:
    "SELECT outcome,result FROM morrow_work.cmd_plan_start_document($1,$2,$3,$4,$5,$6,$7,$8)",
  cmdPlanStart: "SELECT outcome,result FROM morrow_work.cmd_plan_start($1,$2,$3,$4,$5,$6,$7)",
  // The actor's own start document, by digest (a read definer).
  planStartDocument:
    "SELECT id,purpose,canonical,message_id,draft_revision,expires_at,consumed::text AS consumed FROM morrow_work.plan_start_document($1)",
  // One goal record as the progress and the commands read it (tenant_read).
  projectGoal: `SELECT g.id::text AS id,g.revision::text AS revision,g.status,g.success_criteria::text AS success_criteria,g.owner_principal_id::text AS owner_principal_id,g.owner_membership_id::text AS owner_membership_id,${utc("g.created_at")} AS created_at,${utc("g.due_at")} AS due_at,g.area_template_id FROM morrow_work.goals g WHERE g.id=$1::text`,
  // A goal's unexpired values, oldest first, at most 2,000 (the progress reads; the work API
  // filters them per viewer by read tags, ADR-0031 item 6).
  goalValues: `SELECT v.key,v.product_id,v.value::text AS value,${utc("v.observed_at")} AS observed_at,v.counted::text AS counted,v.read_tags::text AS read_tags,v.data_class,${utc("v.expires_at")} AS expires_at FROM morrow_work.goal_measure_values v WHERE v.goal_id=$1::text AND (v.expires_at IS NULL OR v.expires_at>clock_timestamp()) ORDER BY v.observed_at,v.id::text COLLATE "C" LIMIT 2001`,
  // Finish's results record, if the project was finished.
  goalFinish: `SELECT f.outcome,${utc("f.created_at")} AS created_at FROM morrow_work.goal_finish_results f WHERE f.goal_id=$1::text`,
  // Questions waiting on this viewer under the goal (someone waits on them).
  goalWaitingOn: `SELECT count(*)::text AS waiting FROM morrow_work.questions q JOIN morrow_work.tasks t ON t.organization_id=q.organization_id AND t.workspace_id=q.workspace_id AND t.id=q.task_id WHERE t.goal_id=$1::text AND q.respondent_principal_id=$2::text AND q.status='open'`,
  // The stores the workspace's agents work on (a goal's read tags are on these stores).
  workspaceStores:
    "SELECT DISTINCT i.store_id::text AS store_id FROM morrow_work.agent_installations i WHERE i.status<>'uninstalled' ORDER BY 1",
  // A card's latest revision (tenant_read).
  planDraftLatest:
    "SELECT d.message_id::text AS message_id,d.revision::text AS revision,d.kind,d.canonical,d.digest::text AS digest,d.asker_principal_id::text AS asker_principal_id,d.asker_membership_id::text AS asker_membership_id,d.context_taint FROM morrow_work.plan_draft_revisions d WHERE d.message_id=$1::text ORDER BY d.revision DESC LIMIT 1",
  // A plan change's target: the project and its goal record's revision and date.
  projectTarget: `SELECT j.id::text AS id,g.id::text AS goal_id,g.revision::text AS revision,${utc("g.due_at")} AS due_at FROM morrow_work.projects j JOIN morrow_work.goals g ON g.organization_id=j.organization_id AND g.workspace_id=j.workspace_id AND g.id=j.goal_id WHERE j.id=$1::text`,
  // An area's or Quick tasks' existing record, if any.
  areaGoal: "SELECT g.id::text AS id FROM morrow_work.goals g WHERE g.area_template_id=$1::text",
  // An area's agent is added (ADR-0033 item 6): an installation of its release that was not
  // uninstalled (a disabled one keeps its area).
  areaAgentAdded:
    "SELECT count(*)::text AS added FROM morrow_work.agent_installations i WHERE i.release_id=$1::text AND i.status<>'uninstalled'",
} as const);
export type ProjectStatementName = keyof typeof projectStatements;
