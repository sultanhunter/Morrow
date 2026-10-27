// The agent loop's api statements (build order PR 11; migration agent-runs), merged into
// workStatements so WorkTx.run accepts no other text. Source-fixed: values travel only as
// bind parameters. Each is reached only while the agent-loop switch is on (admission.ts:
// admitRoutedRun and answerRunQuestion answer switch_off before any statement); the routes
// that compose them are PR 12's (the Ask) and the Inbox's (PR 15), behind the same switch.
export const loopStatements = Object.freeze({
  cmdAgentRunAdmit:
    "SELECT outcome,result FROM morrow_work.cmd_agent_run_admit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)",
  cmdAgentRunAnswer: "SELECT outcome,result FROM morrow_work.cmd_agent_run_answer($1,$2,$3,$4,$5)",
} as const);
