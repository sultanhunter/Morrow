// Every statement the approval records send (P06.T01b; ADR-0010 item 2). Source-
// fixed and merged into workStatements, so WorkTx.run accepts no other text.
// Values travel only as bind parameters, and every selected column is text.

const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const proposalColumns = `p.id::text AS id,p.organization_id::text AS organization_id,p.workspace_id::text AS workspace_id,p.family_root_id::text AS family_root_id,p.derived_from_id::text AS derived_from_id,array_to_json(p.selected_target_indexes)::text AS selected_target_indexes,p.task_id::text AS task_id,p.capability_id,p.risk,p.target_count::text AS target_count,p.maximum_credits::text AS maximum_credits,p.proposer_principal_id::text AS proposer_principal_id,p.proposer_membership_id::text AS proposer_membership_id,p.proposer_kind,p.proposer_installation_id::text AS proposer_installation_id,p.store_id::text AS store_id,p.requester_principal_id::text AS requester_principal_id,p.requester_membership_id::text AS requester_membership_id,p.review_policy_revision::text AS review_policy_revision,p.parameters_id::text AS parameters_id,p.canonical,p.digest::text AS digest,p.scope_digest::text AS scope_digest,${utc("p.expires_at")} AS expires_at,${utc("p.created_at")} AS created_at`;
const approvalColumns = `a.id::text AS id,a.organization_id::text AS organization_id,a.workspace_id::text AS workspace_id,a.revision::text AS revision,a.proposal_id::text AS proposal_id,a.proposal_digest::text AS proposal_digest,a.family_root_id::text AS family_root_id,a.status,a.required_approvals::text AS required_approvals,a.quiet_period_seconds::text AS quiet_period_seconds,array_to_json(a.counted_reviewer_principal_ids)::text AS counted_reviewer_principal_ids,a.scope_digest::text AS scope_digest,a.review_policy_revision::text AS review_policy_revision,a.policy_revision::text AS policy_revision,${utc("a.effective_at")} AS effective_at,${utc("a.expires_at")} AS expires_at,${utc("a.created_at")} AS created_at,${utc("a.updated_at")} AS updated_at`;
const decisionColumns = `d.approval_id::text AS approval_id,d.sequence::text AS sequence,d.reviewer_principal_id::text AS reviewer_principal_id,d.reviewer_membership_id::text AS reviewer_membership_id,d.decision,${utc("d.decided_at")} AS decided_at,d.command_id::text AS command_id,d.request_digest::text AS request_digest,d.comment,d.solo_phrase_digest::text AS solo_phrase_digest,d.solo_cool_down_seconds::text AS solo_cool_down_seconds`;

export const approvalStatements = Object.freeze({
  beginApprovalCommand:
    "SELECT outcome,aggregate_type,aggregate_id,result FROM morrow_work.begin_approval_command($1,$2,$3)",
  reviewContext:
    "SELECT policy_revision,policy_canonical,policy_digest,defaults_digest,capability_effect,capability_irreversible,capability_review_required,capability_kill_switch,risk,owner_principal_id,owner_membership_id,active_human_membership_count,last_membership_change_at,claimed_approval_id,database_now FROM morrow_work.review_context($1,$2)",
  reviewCandidates:
    "SELECT principal_id,membership_id,grants,grant_count,grants_digest,evaluated_at FROM morrow_work.review_candidates($1,$2,$3,$4)",
  reviewerSnapshot:
    "SELECT principal_id,membership_id,grants,grant_count,grants_digest,evaluated_at FROM morrow_work.reviewer_snapshot($1,$2)",
  cmdProposalSubmit:
    "SELECT outcome,result FROM morrow_work.cmd_proposal_submit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
  cmdApprovalDecide:
    "SELECT outcome,result FROM morrow_work.cmd_approval_decide($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
  cmdApprovalWithdraw:
    "SELECT outcome,result FROM morrow_work.cmd_approval_withdraw($1,$2,$3,$4,$5)",
  // The task a producer attaches a proposal to: its initiator selects the verb.
  proposalTask:
    "SELECT t.status,t.initiator_principal_id::text AS initiator_principal_id,t.initiator_membership_id::text AS initiator_membership_id FROM morrow_work.tasks t WHERE t.id=$1::text",
  proposalById: `SELECT ${proposalColumns} FROM morrow_work.proposals p WHERE p.id=$1::text`,
  proposalFamily: `SELECT ${proposalColumns} FROM morrow_work.proposals p WHERE p.family_root_id=$1::text ORDER BY p.id::text COLLATE "C"`,
  approvalById: `SELECT ${approvalColumns} FROM morrow_work.approvals a WHERE a.id=$1::text`,
  approvalFamily: `SELECT ${approvalColumns} FROM morrow_work.approvals a WHERE a.family_root_id=$1::text ORDER BY a.id::text COLLATE "C"`,
  decisionFamily: `SELECT ${decisionColumns} FROM morrow_work.approval_decisions d JOIN morrow_work.approvals a ON a.organization_id=d.organization_id AND a.workspace_id=d.workspace_id AND a.id=d.approval_id WHERE a.family_root_id=$1::text ORDER BY d.approval_id::text COLLATE "C",d.sequence`,
  parametersById:
    "SELECT x.canonical,x.digest::text AS digest FROM morrow_work.proposal_parameters x WHERE x.id=$1::text",
  reviewPolicyAt:
    "SELECT r.revision::text AS revision,r.canonical,r.digest::text AS digest FROM morrow_work.review_policies r WHERE r.id='review-policy' AND r.revision=$1::bigint",
  // Live pending approvals under the current policy, after a (expires_at, id)
  // cursor ($1 microseconds, $2 id), at most 100 rows scanned per page.
  pendingApprovalPage: `SELECT ${approvalColumns},(extract(epoch FROM a.expires_at)*1000000)::bigint::text AS cursor_us FROM morrow_work.approvals a WHERE a.status='pending' AND a.expires_at>date_trunc('milliseconds',clock_timestamp()) AND a.review_policy_revision=(SELECT max(r.revision) FROM morrow_work.review_policies r WHERE r.id='review-policy') AND ($1::text IS NULL OR a.expires_at>timestamptz 'epoch'+($1::text||' microseconds')::interval OR (a.expires_at=timestamptz 'epoch'+($1::text||' microseconds')::interval AND a.id::text COLLATE "C">$2::text COLLATE "C")) ORDER BY a.expires_at,a.id::text COLLATE "C" LIMIT 100`,
} as const);
export type ApprovalStatementName = keyof typeof approvalStatements;
