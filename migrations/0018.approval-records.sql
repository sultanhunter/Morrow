BEGIN;
-- P06.T01b approval records (ADR-0011, ADR-0018; ADR-0010 tenant data pattern).
-- Executes AS morrow_work_owner, after 0017. Proposal@2 and Approval@2 storage on
-- the P06.T01a pattern: composite tenant keys, FORCE RLS, definer API functions
-- owned by morrow_work_command, INVOKER helpers granted to nobody. The pure review
-- library decides in the Worker; SQL independently rechecks every data-only rule
-- (documents, digests, derivation, ceilings, expiry formulas, the conflict set,
-- solo facts and the phrase digest), holds database time, freshness, immutability,
-- the transition edges, the quorum count and the family and claim exclusivity.
-- No capability executes here and no OperationLedger row is written (hard ordering
-- a): the claim primitive is granted to nobody; consumers add their own definers.
--
-- Declared deviations from P06.T01a (routine; P06.T01b header): (1) the
-- commands.command_type/aggregate_type and the outbox event_type/aggregate_type/
-- task/payload CHECKs are replaced by strict supersets; (2) the transition_rules
-- primary key gains the guard; (3) three read-only api definers read identity facts
-- as target_member does; (4) outbox uniqueness per aggregate revision gains the event
-- type for the approval aggregate only, so one decision may emit approval.decided
-- and approval.status_changed at the decided revision, and a claim may emit
-- approval.claimed without bumping it; every other aggregate keeps one event per
-- revision (a partial unique index with the P06.T01a key).
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api') AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication)<>3
 OR to_regclass('morrow_work.tasks') IS NULL OR to_regclass('morrow_work.commands') IS NULL
 OR to_regclass('morrow_work.outbox_events') IS NULL OR to_regclass('morrow_work.transition_rules') IS NULL
 OR to_regclass('morrow_work.workspace_streams') IS NULL
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL
 OR to_regprocedure('morrow_work.command_prelude(text,text)') IS NULL
 OR to_regprocedure('morrow_work.append_event(text,text,text,text,text,text,text,bigint,text,jsonb,text,timestamptz)') IS NULL
 OR to_regprocedure('morrow_work.record_command(text,text,text,text,text,text,text,text,bigint,jsonb,text,timestamptz)') IS NULL
 OR to_regprocedure('morrow_work.append_only()') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_ownership_facts(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_review_candidates(text,text,text,text[],text,integer)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_reviewer_grants(text,text,text,text[])','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_lock_and_recheck_exclusive(text,text,text,text,text,text,text)','EXECUTE')
 OR (SELECT count(*) FROM pg_catalog.pg_constraint c WHERE (c.conrelid,c.conname) IN (
   ('morrow_work.commands'::regclass,'commands_command_type_check'),('morrow_work.commands'::regclass,'commands_check'),
   ('morrow_work.outbox_events'::regclass,'outbox_events_event_type_check'),('morrow_work.outbox_events'::regclass,'outbox_events_check'),
   ('morrow_work.outbox_events'::regclass,'outbox_events_check1'),('morrow_work.outbox_events'::regclass,'outbox_events_check3'),
   ('morrow_work.outbox_events'::regclass,'outbox_events_organization_id_workspace_id_aggregate_type_a_key'),
   ('morrow_work.transition_rules'::regclass,'transition_rules_machine_check'),('morrow_work.transition_rules'::regclass,'transition_rules_pkey')))<>9
 THEN RAISE EXCEPTION 'APPROVAL_RECORDS_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Deviations (1), (2) and (4): strict supersets of the P06.T01a constraints.
ALTER TABLE morrow_work.commands DROP CONSTRAINT commands_command_type_check, DROP CONSTRAINT commands_check,
 ADD CONSTRAINT commands_command_type_check CHECK (command_type IN ('goal.create','goal.transition','task.create','task.ready','task.assign',
  'question.request','question.answer','question.cancel','proposal.submit','approval.decide','approval.withdraw')),
 ADD CONSTRAINT commands_check CHECK (aggregate_type IN ('goal','task','question','proposal','approval') AND aggregate_type=split_part(command_type,'.',1));
ALTER TABLE morrow_work.outbox_events DROP CONSTRAINT outbox_events_event_type_check, DROP CONSTRAINT outbox_events_check,
 DROP CONSTRAINT outbox_events_check1, DROP CONSTRAINT outbox_events_check3,
 DROP CONSTRAINT outbox_events_organization_id_workspace_id_aggregate_type_a_key,
 ADD CONSTRAINT outbox_events_event_type_check CHECK (event_type IN ('goal.created','goal.status_changed','task.created','task.status_changed','task.assigned',
  'question.requested','question.answered','question.cancelled','proposal.submitted','proposal.derived','approval.decided','approval.status_changed','approval.claimed')),
 ADD CONSTRAINT outbox_events_check CHECK (aggregate_type IN ('goal','task','question','proposal','approval') AND aggregate_type=split_part(event_type,'.',1)),
 ADD CONSTRAINT outbox_events_check1 CHECK ((aggregate_type='goal' AND task_id IS NULL) OR (aggregate_type='task' AND task_id=aggregate_id)
  OR (aggregate_type='question' AND task_id IS NOT NULL) OR aggregate_type IN ('proposal','approval')),
 ADD CONSTRAINT outbox_events_check3 CHECK (CASE WHEN jsonb_typeof(payload)<>'object' THEN false
  WHEN event_type='goal.created' THEN payload ? 'status' AND payload-'status'='{}'::jsonb AND jsonb_typeof(payload->'status')='string'
  WHEN event_type IN ('goal.status_changed','task.status_changed') THEN payload ?& ARRAY['from','to'] AND payload-ARRAY['from','to']='{}'::jsonb
   AND jsonb_typeof(payload->'from')='string' AND jsonb_typeof(payload->'to')='string'
  WHEN event_type='task.created' THEN payload ?& ARRAY['goalId','status'] AND payload-ARRAY['goalId','status']='{}'::jsonb
   AND jsonb_typeof(payload->'goalId')='string' AND jsonb_typeof(payload->'status')='string'
  WHEN event_type='task.assigned' THEN payload ?& ARRAY['assignmentId','ownerPrincipalId'] AND payload-ARRAY['assignmentId','ownerPrincipalId']='{}'::jsonb
   AND jsonb_typeof(payload->'assignmentId')='string' AND jsonb_typeof(payload->'ownerPrincipalId')='string'
  WHEN event_type='question.requested' THEN payload ? 'respondentPrincipalId' AND payload-'respondentPrincipalId'='{}'::jsonb
   AND jsonb_typeof(payload->'respondentPrincipalId')='string'
  WHEN event_type='question.answered' THEN payload ? 'answerId' AND payload-'answerId'='{}'::jsonb AND jsonb_typeof(payload->'answerId')='string'
  WHEN event_type='question.cancelled' THEN payload='{}'::jsonb
  WHEN event_type='proposal.submitted' THEN payload ?& ARRAY['approvalId','risk','targetCount'] AND payload-ARRAY['approvalId','risk','targetCount']='{}'::jsonb
   AND jsonb_typeof(payload->'approvalId')='string' AND jsonb_typeof(payload->'risk')='string' AND jsonb_typeof(payload->'targetCount')='number'
  WHEN event_type='proposal.derived' THEN payload ? 'parentId' AND payload-'parentId'='{}'::jsonb AND jsonb_typeof(payload->'parentId')='string'
  WHEN event_type='approval.decided' THEN payload ?& ARRAY['decision','status'] AND payload-ARRAY['decision','status']='{}'::jsonb
   AND jsonb_typeof(payload->'decision')='string' AND jsonb_typeof(payload->'status')='string'
  WHEN event_type='approval.status_changed' THEN payload ?& ARRAY['from','to','reason'] AND payload-ARRAY['from','to','reason']='{}'::jsonb
   AND jsonb_typeof(payload->'from')='string' AND jsonb_typeof(payload->'to')='string' AND jsonb_typeof(payload->'reason')='string'
   AND (payload->>'reason') IN ('quorum_met','solo_owner_confirmed','rejected','cancelled_before_effective','withdrawn','superseded_by_partial_approval','family_closed')
  WHEN event_type='approval.claimed' THEN payload ? 'consumer' AND payload-'consumer'='{}'::jsonb AND jsonb_typeof(payload->'consumer')='string'
  ELSE false END),
 ADD CONSTRAINT outbox_events_aggregate_revision_event_key UNIQUE (organization_id,workspace_id,aggregate_type,aggregate_id,aggregate_revision,event_type);
CREATE UNIQUE INDEX outbox_events_one_event_per_revision ON morrow_work.outbox_events (organization_id,workspace_id,aggregate_type,aggregate_id,aggregate_revision)
 WHERE aggregate_type<>'approval';
-- The effective approval rows of state-transitions.json at contract v1.1: the v1
-- rows without the two superseded in 1.1, plus every row since 1.1. Two
-- pending→invalidated work_service rows differ only by guard, so the key gains it.
ALTER TABLE morrow_work.transition_rules DROP CONSTRAINT transition_rules_machine_check, DROP CONSTRAINT transition_rules_pkey,
 ADD CONSTRAINT transition_rules_machine_check CHECK (machine IN ('goal','task','question','approval')),
 ADD CONSTRAINT transition_rules_pkey PRIMARY KEY (machine,from_status,to_status,actor,guard);
INSERT INTO morrow_work.transition_rules(machine,from_status,to_status,actor,guard) VALUES
 ('approval','pending','expired','work_service','expiry_elapsed'),
 ('approval','pending','invalidated','work_service','proposal_or_authority_changed'),
 ('approval','approved','expired','work_service','expiry_elapsed'),
 ('approval','approved','invalidated','work_service','proposal_or_authority_changed'),
 ('approval','pending','cancelled','owner','current_revision'),
 ('approval','pending','approved','eligible_human_reviewer','quorum_met_exact_digest_scope_and_current_policy'),
 ('approval','pending','approved','solo_owner','typed_confirmation_recorded_cool_down_scheduled'),
 ('approval','pending','rejected','eligible_human_reviewer','eligible_rejection_exact_digest_and_current_policy'),
 ('approval','approved','cancelled','solo_owner','before_effective_at'),
 ('approval','pending','invalidated','work_service','superseded_by_partial_approval'),
 ('approval','pending','invalidated','work_service','family_rejected');

-- ---------------------------------------------------------------------------
-- Pure functions: IMMUTABLE, owned by the owner. CHECK constraints and INVOKER
-- triggers run with the writer's privileges, so the one runtime writer (the
-- command role) holds EXECUTE and nobody else (the 0015 valid_scope pattern).
CREATE FUNCTION morrow_work.sha256_text(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
 SELECT encode(sha256(convert_to(p_text,'UTF8')),'hex')
$$;
-- A stored instant as Date.toISOString() renders it (every stored time is ms-truncated).
CREATE FUNCTION morrow_work.utc_text(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
 SELECT to_char(p_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
-- The inverse, only for an exact utc_text rendering; anything else is NULL.
CREATE FUNCTION morrow_work.utc_parse(p_text text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v timestamptz;
BEGIN
 IF p_text IS NULL OR p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  OR NOT pg_input_is_valid(p_text,'timestamptz') THEN RETURN NULL; END IF;
 v:=p_text::timestamptz;
 IF morrow_work.utc_text(v) IS DISTINCT FROM p_text OR v<timestamptz '2000-01-01T00:00:00Z' OR v>=timestamptz '9000-01-01T00:00:00Z' THEN RETURN NULL; END IF;
 RETURN v;
END $$;
CREATE FUNCTION morrow_work.json_int(p_value jsonb,p_low bigint,p_high bigint) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value)<>'number' THEN RETURN false; END IF;
 IF p_value::text !~ '^-?(0|[1-9][0-9]{0,17})$' THEN RETURN false; END IF;
 RETURN (p_value::text)::bigint BETWEEN p_low AND p_high;
END $$;
CREATE FUNCTION morrow_work.json_id(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value)<>'string' THEN RETURN false; END IF;
 RETURN (p_value#>>'{}') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
END $$;
-- One ReviewRule (core v1.1): closed keys and ranges; a restricted class
-- (communication, financial, access_change, irreversible) never allows self-approval.
CREATE FUNCTION morrow_work.valid_review_rule(p_rule jsonb,p_restricted boolean) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE k text[]:=ARRAY['requiredApprovals','selfApproval','pendingExpirySeconds','approvedValiditySeconds','eligibleReviewerPrincipalIds']; l jsonb;
BEGIN
 IF p_rule IS NULL OR p_restricted IS NULL OR jsonb_typeof(p_rule)<>'object' THEN RETURN false; END IF;
 IF NOT (p_rule ?& k) OR (p_rule-k)<>'{}'::jsonb THEN RETURN false; END IF;
 IF NOT morrow_work.json_int(p_rule->'requiredApprovals',1,5) OR NOT morrow_work.json_int(p_rule->'pendingExpirySeconds',300,2592000)
  OR NOT morrow_work.json_int(p_rule->'approvedValiditySeconds',300,604800) OR jsonb_typeof(p_rule->'selfApproval')<>'string' THEN RETURN false; END IF;
 IF NOT ((p_rule->>'selfApproval') IN ('denied','solo_owner_typed_confirmation') OR (NOT p_restricted AND p_rule->>'selfApproval'='allowed')) THEN RETURN false; END IF;
 l:=p_rule->'eligibleReviewerPrincipalIds';
 IF l='null'::jsonb THEN RETURN true; END IF;
 IF jsonb_typeof(l)<>'array' THEN RETURN false; END IF;
 IF jsonb_array_length(l) NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(l) e WHERE NOT morrow_work.json_id(e)) THEN RETURN false; END IF;
 RETURN (SELECT count(DISTINCT e) FROM jsonb_array_elements(l) e)=jsonb_array_length(l);
END $$;
CREATE FUNCTION morrow_work.valid_review_rules(p_rules jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE k text[]:=ARRAY['internal','external','communication','financial','access_change','irreversible','soloOwner']; s jsonb;
BEGIN
 IF p_rules IS NULL OR jsonb_typeof(p_rules)<>'object' THEN RETURN false; END IF;
 IF NOT (p_rules ?& k) OR (p_rules-k)<>'{}'::jsonb THEN RETURN false; END IF;
 IF NOT morrow_work.valid_review_rule(p_rules->'internal',false) OR NOT morrow_work.valid_review_rule(p_rules->'external',false)
  OR NOT morrow_work.valid_review_rule(p_rules->'communication',true) OR NOT morrow_work.valid_review_rule(p_rules->'financial',true)
  OR NOT morrow_work.valid_review_rule(p_rules->'access_change',true) OR NOT morrow_work.valid_review_rule(p_rules->'irreversible',true) THEN RETURN false; END IF;
 s:=p_rules->'soloOwner';
 IF jsonb_typeof(s)<>'object' THEN RETURN false; END IF;
 IF NOT (s ?& ARRAY['coolDownSeconds','quietPeriodSeconds']) OR (s-ARRAY['coolDownSeconds','quietPeriodSeconds'])<>'{}'::jsonb THEN RETURN false; END IF;
 RETURN morrow_work.json_int(s->'coolDownSeconds',60,86400) AND morrow_work.json_int(s->'quietPeriodSeconds',3600,604800);
END $$;
-- effectiveRule (P01.T02a §7 item 3): rules[risk], merged field by field with the
-- irreversible overlay for an irreversible proposal, taking the stricter value.
-- Callers pass validated rules (the review_policies CHECK).
CREATE FUNCTION morrow_work.effective_rule(p_rules jsonb,p_risk text,p_irreversible boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE b jsonb; e jsonb; order_ text[]:=ARRAY['denied','solo_owner_typed_confirmation','allowed']; l jsonb;
BEGIN
 IF p_rules IS NULL OR p_irreversible IS NULL OR p_risk IS NULL OR p_risk NOT IN ('internal','external','communication','financial','access_change') THEN RETURN NULL; END IF;
 b:=p_rules->p_risk;
 IF NOT p_irreversible THEN RETURN b; END IF;
 e:=p_rules->'irreversible';
 IF b->'eligibleReviewerPrincipalIds'='null'::jsonb THEN l:=e->'eligibleReviewerPrincipalIds';
 ELSIF e->'eligibleReviewerPrincipalIds'='null'::jsonb THEN l:=b->'eligibleReviewerPrincipalIds';
 ELSE SELECT COALESCE(jsonb_agg(x ORDER BY o),'[]'::jsonb) INTO l FROM jsonb_array_elements(b->'eligibleReviewerPrincipalIds') WITH ORDINALITY t(x,o)
  WHERE (e->'eligibleReviewerPrincipalIds') @> jsonb_build_array(x);
 END IF;
 RETURN jsonb_build_object(
  'requiredApprovals',greatest((b->>'requiredApprovals')::integer,(e->>'requiredApprovals')::integer),
  'selfApproval',order_[least(array_position(order_,b->>'selfApproval'),array_position(order_,e->>'selfApproval'))],
  'pendingExpirySeconds',least((b->>'pendingExpirySeconds')::integer,(e->>'pendingExpirySeconds')::integer),
  'approvedValiditySeconds',least((b->>'approvedValiditySeconds')::integer,(e->>'approvedValiditySeconds')::integer),
  'eligibleReviewerPrincipalIds',l);
END $$;
-- The exact solo-owner phrase (P01.T02a §7 item 6) of a stored proposal document:
-- ASCII only, so NFC is the identity. NULL for a malformed document.
CREATE FUNCTION morrow_work.solo_phrase(p_document jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF p_document IS NULL OR jsonb_typeof(p_document)<>'object' OR jsonb_typeof(p_document->'targets')<>'array'
  OR jsonb_typeof(p_document->'maximumCredits')<>'string' THEN RETURN NULL; END IF;
 n:=jsonb_array_length(p_document->'targets');
 RETURN 'approve '||n||' '||CASE WHEN n=1 THEN 'change' ELSE 'changes' END||' for '||(p_document->>'maximumCredits')||' credits'
  ||CASE WHEN p_document->'maximumCost'='null'::jsonb THEN ''
   ELSE ' and '||(p_document#>>'{maximumCost,amount}')||' '||(p_document#>>'{maximumCost,currency}') END;
END $$;
-- 'derived_' + sha256 of the RFC 8785 form of {parentRef, selectedTargetIndexes}
-- (P01.T02a §7 item 8); identifiers and hex digests need no JSON escaping.
CREATE FUNCTION morrow_work.derived_proposal_id(p_org text,p_ws text,p_parent_id text,p_parent_digest text,p_indexes integer[]) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT 'derived_'||morrow_work.sha256_text(format(
  '{"parentRef":{"digest":"%s","id":"%s","kind":"proposal","organizationId":"%s","revision":1,"storeId":null,"workspaceId":"%s"},"selectedTargetIndexes":[%s]}',
  p_parent_digest,p_parent_id,p_org,p_ws,array_to_string(p_indexes,',')))
$$;
-- ApprovalRef.digest: sha256 of the fixed-key RFC 8785 object of the stored approval
-- at revision R. A claim compares it, so any status, expiry or revision change voids
-- an older reference.
CREATE FUNCTION morrow_work.approval_ref_digest(p_org text,p_ws text,p_id text,p_revision bigint,p_proposal_digest text,p_scope_digest text,
 p_status text,p_effective_at timestamptz,p_expires_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT morrow_work.sha256_text(format(
  '{"effectiveAt":%s,"expiresAt":"%s","id":"%s","kind":"approval","organizationId":"%s","proposalDigest":"%s","revision":%s,"scopeDigest":"%s","status":"%s","workspaceId":"%s"}',
  CASE WHEN p_effective_at IS NULL THEN 'null' ELSE '"'||morrow_work.utc_text(p_effective_at)||'"' END,
  morrow_work.utc_text(p_expires_at),p_id,p_org,p_proposal_digest,p_revision,p_scope_digest,p_status,p_ws))
$$;
-- The conflict set (P01.T02a §7 item 5): proposer, requester and beneficiaries.
CREATE FUNCTION morrow_work.conflicted(p_proposer text,p_requester text,p_beneficiaries text[],p_principal text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_principal IS NOT NULL AND (p_principal=p_proposer OR p_principal=p_requester OR p_principal=ANY(COALESCE(p_beneficiaries,ARRAY[]::text[])))
$$;
-- The lazy projection of a stored pending or approved approval at an instant, in
-- order: a claim (stored status, consumed), expiry, a newer review policy, lost
-- solo-owner status. Each condition is monotone. Commands and claims return the
-- code and roll back; reads display the status and never write. projectApproval
-- in @morrow/work/approvals mirrors it.
CREATE FUNCTION morrow_work.approval_projection(p_status text,p_expires_at timestamptz,p_bound_policy_revision bigint,p_current_policy_revision bigint,
 p_has_claim boolean,p_solo_reviewer text,p_solo_decided_at timestamptz,p_quiet_period_seconds integer,
 p_owner_principal text,p_human_count integer,p_last_change timestamptz,p_at timestamptz)
RETURNS TABLE(status text,code text)
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('pending','approved') THEN RETURN QUERY SELECT p_status,NULL::text; RETURN; END IF;
 IF p_has_claim IS NOT FALSE THEN RETURN QUERY SELECT p_status,'APPROVAL_ALREADY_CLAIMED'::text; RETURN; END IF;
 IF p_at IS NULL OR p_expires_at IS NULL OR p_at>=p_expires_at THEN RETURN QUERY SELECT 'expired'::text,'APPROVAL_EXPIRED'::text; RETURN; END IF;
 IF p_current_policy_revision IS NULL OR p_bound_policy_revision IS NULL OR p_bound_policy_revision<p_current_policy_revision THEN
  RETURN QUERY SELECT 'invalidated'::text,'REVIEW_POLICY_NOT_CURRENT'::text; RETURN;
 END IF;
 IF p_solo_reviewer IS NOT NULL AND (p_solo_reviewer=p_owner_principal AND p_human_count=1
   AND (p_last_change IS NULL OR (p_at>=p_last_change+make_interval(secs=>p_quiet_period_seconds) AND p_last_change<=p_solo_decided_at))) IS NOT TRUE THEN
  RETURN QUERY SELECT 'invalidated'::text,'SOLO_OWNER_STATUS_LOST'::text; RETURN;
 END IF;
 RETURN QUERY SELECT p_status,NULL::text;
END $$;
-- ReviewPolicy document check: exactly the ReviewPolicy@1 keys, this tenant, no store,
-- createdAt = updatedAt = the row time, and rules = the column.
CREATE FUNCTION morrow_work.policy_document_matches(p_canonical text,p_org text,p_ws text,p_id text,p_revision bigint,p_created_at timestamptz,p_rules jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE d jsonb; t text;
BEGIN
 IF p_canonical IS NULL OR p_created_at IS NULL OR NOT pg_input_is_valid(p_canonical,'jsonb') THEN RETURN false; END IF;
 d:=p_canonical::jsonb; t:=morrow_work.utc_text(p_created_at);
 RETURN d IS NOT DISTINCT FROM jsonb_build_object('schemaVersion',1,'id',p_id,'organizationId',p_org,'workspaceId',p_ws,'storeId',NULL,
  'revision',p_revision,'createdAt',t,'updatedAt',t,'rules',p_rules);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- Proposal@2 document check (W-only targets in this packet). The canonical text is
-- the Worker's RFC 8785 output of the proposal without proposalDigest; this proves
-- that it parses to exactly the row: every server-derived field, the targets, the
-- exact ceiling sums, the derived scope and the bound references.
CREATE FUNCTION morrow_work.proposal_document_matches(p_canonical text,p_scope_canonical text,p_org text,p_ws text,p_id text,p_revision bigint,
 p_derived_from_id text,p_derived_from_digest text,p_selected integer[],p_task_id text,p_capability_id text,p_risk text,p_irreversible boolean,
 p_partial_approval text,p_target_count integer,p_maximum_credits numeric,p_proposer_principal text,p_proposer_membership text,
 p_requester_principal text,p_requester_membership text,p_beneficiaries text[],p_policy_id text,p_policy_revision bigint,p_policy_digest text,
 p_parameters_id text,p_parameters_digest text,p_expires_at timestamptz,p_created_at timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE
 k text[]:=ARRAY['schemaVersion','id','organizationId','workspaceId','storeId','revision','createdAt','updatedAt','taskId','capabilityId',
  'scope','targets','parametersRef','parametersDigest','maximumCredits','maximumCost','risk','irreversible','reviewPolicyRef','proposedBy',
  'requestedBy','beneficiaryPrincipalIds','contextTaint','partialApproval','derivedFrom','expiresAt'];
 tk text[]:=ARRAY['resource','expectedSourceRevision','fields','maximumCredits','maximumCost'];
 d jsonb; s jsonb; w jsonb; t jsonb; f jsonb; c jsonb; v_fields jsonb;
 v_credits numeric:=0; v_cost numeric:=0; v_costs integer:=0; v_currency text; v_scale integer:=0; v_mixed boolean:=false;
BEGIN
 IF p_canonical IS NULL OR p_scope_canonical IS NULL OR p_created_at IS NULL OR p_expires_at IS NULL
  OR NOT pg_input_is_valid(p_canonical,'jsonb') OR NOT pg_input_is_valid(p_scope_canonical,'jsonb') THEN RETURN false; END IF;
 d:=p_canonical::jsonb; s:=p_scope_canonical::jsonb;
 IF jsonb_typeof(d)<>'object' THEN RETURN false; END IF;
 IF NOT (d ?& k) OR (d-k)<>'{}'::jsonb THEN RETURN false; END IF;
 w:=jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',NULL,'connectionId',NULL,'kind','workspace','id',p_ws);
 IF d->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR d->'id' IS DISTINCT FROM to_jsonb(p_id)
  OR d->'organizationId' IS DISTINCT FROM to_jsonb(p_org) OR d->'workspaceId' IS DISTINCT FROM to_jsonb(p_ws)
  OR d->'storeId' IS DISTINCT FROM 'null'::jsonb OR d->'revision' IS DISTINCT FROM to_jsonb(p_revision)
  OR d->'createdAt' IS DISTINCT FROM to_jsonb(morrow_work.utc_text(p_created_at))
  OR d->'updatedAt' IS DISTINCT FROM to_jsonb(morrow_work.utc_text(p_created_at))
  OR d->'expiresAt' IS DISTINCT FROM to_jsonb(morrow_work.utc_text(p_expires_at))
  OR d->'taskId' IS DISTINCT FROM COALESCE(to_jsonb(p_task_id),'null'::jsonb)
  OR d->'capabilityId' IS DISTINCT FROM to_jsonb(p_capability_id) OR d->'risk' IS DISTINCT FROM to_jsonb(p_risk)
  OR d->'irreversible' IS DISTINCT FROM to_jsonb(p_irreversible) OR d->'partialApproval' IS DISTINCT FROM to_jsonb(p_partial_approval)
  OR d->'contextTaint' IS DISTINCT FROM '"none"'::jsonb
  OR d->'proposedBy' IS DISTINCT FROM jsonb_build_object('kind','human','principalId',p_proposer_principal,'organizationId',p_org,
   'workspaceId',p_ws,'membershipId',p_proposer_membership,'installationId',NULL,'mandateId',NULL)
  OR d->'requestedBy' IS DISTINCT FROM jsonb_build_object('kind','human','principalId',p_requester_principal,'organizationId',p_org,
   'workspaceId',p_ws,'membershipId',p_requester_membership,'installationId',NULL,'mandateId',NULL)
  OR d->'beneficiaryPrincipalIds' IS DISTINCT FROM to_jsonb(p_beneficiaries)
  OR d->'reviewPolicyRef' IS DISTINCT FROM jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',NULL,'kind','policy',
   'id',p_policy_id,'revision',p_policy_revision,'digest',p_policy_digest)
  OR d->'parametersRef' IS DISTINCT FROM jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',NULL,'kind','artifact',
   'id',p_parameters_id,'revision',1,'digest',p_parameters_digest)
  OR d->'parametersDigest' IS DISTINCT FROM to_jsonb(p_parameters_digest)
  OR d->'derivedFrom' IS DISTINCT FROM (CASE WHEN p_derived_from_id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('parentRef',
   jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',NULL,'kind','proposal','id',p_derived_from_id,'revision',1,
    'digest',p_derived_from_digest),'selectedTargetIndexes',to_jsonb(p_selected)) END) THEN
  RETURN false;
 END IF;
 -- Beneficiaries: at most 100 distinct identifiers.
 IF cardinality(p_beneficiaries)>100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'beneficiaryPrincipalIds') e WHERE NOT morrow_work.json_id(e))
  OR (SELECT count(DISTINCT e) FROM unnest(p_beneficiaries) e)<>cardinality(p_beneficiaries) THEN RETURN false; END IF;
 -- Targets: exactly the W resource, closed shape, FieldPaths, ceilings.
 t:=d->'targets';
 IF jsonb_typeof(t)<>'array' THEN RETURN false; END IF;
 IF p_target_count IS NULL OR p_target_count NOT BETWEEN 1 AND 100 OR jsonb_array_length(t)<>p_target_count THEN RETURN false; END IF;
 FOR f IN SELECT x FROM jsonb_array_elements(t) x LOOP
  IF jsonb_typeof(f)<>'object' THEN RETURN false; END IF;
  IF NOT (f ?& tk) OR (f-tk)<>'{}'::jsonb OR f->'resource' IS DISTINCT FROM w THEN RETURN false; END IF;
  IF jsonb_typeof(f->'expectedSourceRevision')<>'string' OR jsonb_typeof(f->'fields')<>'array' OR jsonb_typeof(f->'maximumCredits')<>'string' THEN RETURN false; END IF;
  IF char_length(f->>'expectedSourceRevision') NOT BETWEEN 1 AND 256 OR jsonb_array_length(f->'fields') NOT BETWEEN 1 AND 1000
   OR (f->>'maximumCredits') !~ '^(0|[1-9][0-9]{0,17})$' THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(f->'fields') e WHERE jsonb_typeof(e)<>'string' OR char_length(e#>>'{}')>128
    OR (e#>>'{}') !~ '^[A-Za-z][A-Za-z0-9._-]*$')
   OR (SELECT count(DISTINCT e) FROM jsonb_array_elements(f->'fields') e)<>jsonb_array_length(f->'fields') THEN RETURN false; END IF;
  v_credits:=v_credits+(f->>'maximumCredits')::numeric;
  c:=f->'maximumCost';
  IF c<>'null'::jsonb THEN
   IF jsonb_typeof(c)<>'object' THEN RETURN false; END IF;
   IF NOT (c ?& ARRAY['amount','currency']) OR (c-ARRAY['amount','currency'])<>'{}'::jsonb
    OR jsonb_typeof(c->'amount')<>'string' OR jsonb_typeof(c->'currency')<>'string' THEN RETURN false; END IF;
   IF (c->>'amount') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$' OR (c->>'currency') !~ '^[A-Z]{3}$' THEN RETURN false; END IF;
   IF v_costs>0 AND v_currency<>(c->>'currency') THEN v_mixed:=true; END IF;
   v_currency:=c->>'currency'; v_costs:=v_costs+1;
   v_cost:=v_cost+(c->>'amount')::numeric; v_scale:=greatest(v_scale,scale((c->>'amount')::numeric));
  END IF;
 END LOOP;
 -- Ceilings: the exact sums, as written.
 IF jsonb_typeof(d->'maximumCredits')<>'string' THEN RETURN false; END IF;
 IF (d->>'maximumCredits') !~ '^(0|[1-9][0-9]{0,17})$' THEN RETURN false; END IF;
 IF (d->>'maximumCredits')::numeric<>v_credits OR p_maximum_credits IS DISTINCT FROM v_credits THEN RETURN false; END IF;
 c:=d->'maximumCost';
 IF v_costs=0 THEN
  IF c IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
 ELSE
  IF v_mixed OR jsonb_typeof(c)<>'object' THEN RETURN false; END IF;
  IF NOT (c ?& ARRAY['amount','currency']) OR (c-ARRAY['amount','currency'])<>'{}'::jsonb
   OR c->'currency' IS DISTINCT FROM to_jsonb(v_currency) OR jsonb_typeof(c->'amount')<>'string' THEN RETURN false; END IF;
  IF (c->>'amount') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$' THEN RETURN false; END IF;
  IF (c->>'amount')::numeric<>v_cost OR scale((c->>'amount')::numeric)<>v_scale THEN RETURN false; END IF;
 END IF;
 -- Scope: {O,W,[],[],[W], the sorted (COLLATE "C") distinct union of target fields}.
 SELECT jsonb_agg(x ORDER BY x COLLATE "C") INTO v_fields
  FROM (SELECT DISTINCT e AS x FROM jsonb_array_elements(t) q(target), jsonb_array_elements_text(q.target->'fields') e) u;
 IF s IS DISTINCT FROM jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,
   'resources',jsonb_build_array(w),'fields',v_fields) OR d->'scope' IS DISTINCT FROM s THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- ---------------------------------------------------------------------------
-- Platform tables: the SQL-held catalogue facts a proposal is bound to. Drift-
-- tested against capabilities.json and review-policy-defaults.json (AC19).
CREATE TABLE morrow_work.review_capabilities (
 capability_id text PRIMARY KEY CHECK (char_length(capability_id)<=128 AND capability_id ~ '^[a-z]+(\.[a-z_]+)+$'),
 effect text NOT NULL CHECK (effect IN ('read','internal_write','billable_job','external_write','spend','communication','control')),
 irreversible boolean NOT NULL,
 review_required boolean NOT NULL,
 kill_switch boolean NOT NULL,
 executor text NOT NULL CHECK (executor IN ('agent_direct_read','agent_direct_write','agent_after_approval','human_only'))
);
CREATE TABLE morrow_work.review_risk_by_effect (
 effect text PRIMARY KEY CHECK (effect IN ('read','internal_write','billable_job','external_write','spend','communication','control')),
 risk text NOT NULL CHECK (risk IN ('internal','external','communication','financial','access_change'))
);
CREATE TABLE morrow_work.review_policy_defaults (
 version text PRIMARY KEY CHECK (version='review-policy-defaults@1'),
 rules jsonb NOT NULL CHECK (morrow_work.valid_review_rules(rules)),
 rules_digest morrow_work.digest NOT NULL
);
INSERT INTO morrow_work.review_capabilities(capability_id,effect,irreversible,review_required,kill_switch,executor) VALUES
 ('workspace.goal.create','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.task.create','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.task.assign','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.task.delegate','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.task.takeover','internal_write',false,false,false,'human_only'),
 ('workspace.task.pause','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.task.resume','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.task.cancel','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.question.request','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.question.answer','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.artifact.read','read',false,false,false,'agent_direct_read'),
 ('workspace.artifact.edit','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.comment.create','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.knowledge.approve','internal_write',false,false,false,'human_only'),
 ('workspace.knowledge.read','read',false,false,false,'agent_direct_read'),
 ('workspace.routine.configure','internal_write',false,false,false,'agent_direct_write'),
 ('workspace.routine.activate','control',false,true,false,'human_only'),
 ('catalog.products.read','read',false,false,false,'agent_direct_read'),
 ('catalog.audit.create','internal_write',false,false,false,'agent_direct_write'),
 ('catalog.content.propose','internal_write',false,false,false,'agent_direct_write'),
 ('catalog.content.publish','external_write',false,true,false,'agent_after_approval'),
 ('catalog.variants.propose','internal_write',false,false,false,'agent_direct_write'),
 ('catalog.variants.publish','external_write',false,true,false,'agent_after_approval'),
 ('catalog.collection.propose','internal_write',false,false,false,'agent_direct_write'),
 ('catalog.collection.publish','external_write',false,true,false,'agent_after_approval'),
 ('catalog.channel.publish','external_write',false,true,false,'agent_after_approval'),
 ('search.public.inspect','read',false,false,false,'agent_direct_read'),
 ('search.performance.read','read',false,false,false,'agent_direct_read'),
 ('search.audit.create','internal_write',false,false,false,'agent_direct_write'),
 ('search.improvements.propose','internal_write',false,false,false,'agent_direct_write'),
 ('search.citations.observe','read',false,false,false,'agent_direct_read'),
 ('search.results.report','internal_write',false,false,false,'agent_direct_write'),
 ('creative.brief.create','internal_write',false,false,false,'agent_direct_write'),
 ('creative.image.generate','billable_job',false,false,false,'agent_direct_write'),
 ('creative.contact_sheet.create','internal_write',false,false,false,'agent_direct_write'),
 ('creative.image.revise','billable_job',false,false,false,'agent_direct_write'),
 ('creative.image.approve','internal_write',false,false,false,'human_only'),
 ('creative.media.attach','external_write',false,true,false,'agent_after_approval'),
 ('analytics.report.create','internal_write',false,false,false,'agent_direct_write'),
 ('analytics.anomaly.investigate','internal_write',false,false,false,'agent_direct_write'),
 ('analytics.assortment.propose','internal_write',false,false,false,'agent_direct_write'),
 ('ads.accounts.read','read',false,false,false,'agent_direct_read'),
 ('ads.performance.read','read',false,false,false,'agent_direct_read'),
 ('ads.campaign.propose','internal_write',false,false,false,'agent_direct_write'),
 ('ads.campaign.create_paused','external_write',false,true,false,'agent_after_approval'),
 ('ads.campaign.activate','spend',false,true,false,'agent_after_approval'),
 ('ads.budget.change','spend',false,true,false,'agent_after_approval'),
 ('ads.campaign.pause','external_write',false,false,true,'human_only'),
 ('ads.audience.select','read',false,false,false,'agent_direct_read'),
 ('lifecycle.segment.read','read',false,false,false,'agent_direct_read'),
 ('lifecycle.campaign.propose','internal_write',false,false,false,'agent_direct_write'),
 ('lifecycle.campaign.create_draft','external_write',false,true,false,'agent_after_approval'),
 ('lifecycle.campaign.send','communication',true,true,false,'agent_after_approval'),
 ('lifecycle.performance.read','read',false,false,false,'agent_direct_read'),
 ('support.case.read','read',false,false,false,'agent_direct_read'),
 ('support.reply.propose','internal_write',false,false,false,'agent_direct_write'),
 ('support.reply.send','communication',true,true,false,'agent_after_approval'),
 ('support.case.escalate','external_write',false,true,false,'agent_after_approval'),
 ('support.case.close','external_write',false,true,false,'agent_after_approval'),
 ('orders.read','read',false,false,false,'agent_direct_read'),
 ('orders.exceptions.triage','internal_write',false,false,false,'agent_direct_write'),
 ('orders.cancel','external_write',true,true,false,'agent_after_approval'),
 ('orders.fulfillment.create','external_write',true,true,false,'agent_after_approval'),
 ('orders.fulfillment.tracking_update','external_write',false,true,false,'agent_after_approval'),
 ('orders.return.create','external_write',false,true,false,'agent_after_approval'),
 ('orders.refund.create','spend',true,true,false,'agent_after_approval'),
 ('inventory.levels.read','read',false,false,false,'agent_direct_read'),
 ('inventory.risk.report','internal_write',false,false,false,'agent_direct_write'),
 ('inventory.adjust.propose','internal_write',false,false,false,'agent_direct_write'),
 ('inventory.quantity.adjust','external_write',false,true,false,'agent_after_approval'),
 ('inventory.quantity.set','external_write',false,true,false,'agent_after_approval'),
 ('finance.costs.read','read',false,false,false,'agent_direct_read'),
 ('finance.margin.report','internal_write',false,false,false,'agent_direct_write'),
 ('finance.reconciliation.propose','internal_write',false,false,false,'agent_direct_write'),
 ('storefront.ux.audit','read',false,false,false,'agent_direct_read'),
 ('storefront.change.propose','internal_write',false,false,false,'agent_direct_write'),
 ('storefront.extension.prepare','internal_write',false,false,false,'agent_direct_write'),
 ('storefront.extension.activate','external_write',false,true,false,'agent_after_approval'),
 ('storefront.theme.preview_write','external_write',false,true,false,'agent_after_approval'),
 ('storefront.theme.publish','external_write',false,true,false,'agent_after_approval'),
 ('governance.membership.invite','control',false,true,false,'human_only'),
 ('governance.grants.revise','control',false,true,false,'human_only'),
 ('governance.membership.revoke','control',false,false,true,'human_only'),
 ('governance.connection.connect','control',false,true,false,'human_only'),
 ('governance.connection.disconnect','control',false,false,true,'human_only'),
 ('governance.approval.decide','control',false,false,false,'human_only'),
 ('governance.approval.preview','read',false,false,false,'human_only'),
 ('governance.review_policy.revise','control',false,true,false,'human_only'),
 ('governance.usage.read','read',false,false,false,'agent_direct_read'),
 ('governance.budget.revise','control',false,true,false,'human_only'),
 ('governance.audit.export','internal_write',false,false,false,'human_only'),
 ('governance.privacy.export','internal_write',false,false,false,'human_only'),
 ('governance.privacy.erase','control',true,true,false,'human_only'),
 ('agents.listing.read','read',false,false,false,'agent_direct_read'),
 ('agents.builder.describe','internal_write',false,false,false,'agent_direct_write'),
 ('agents.installation.stage','internal_write',false,false,false,'agent_direct_write'),
 ('agents.installation.sample','billable_job',false,false,false,'agent_direct_write'),
 ('agents.installation.activate','control',false,true,false,'human_only'),
 ('agents.installation.upgrade','control',false,true,false,'human_only'),
 ('agents.installation.disable','control',false,false,true,'human_only'),
 ('agents.installation.uninstall','control',true,true,false,'human_only'),
 ('agents.skill.research','internal_write',false,false,false,'agent_direct_write'),
 ('agents.release.evaluate','billable_job',false,false,false,'agent_direct_write'),
 ('agents.release.publish','control',false,true,false,'human_only'),
 ('agents.release.revoke','control',false,false,true,'human_only');
INSERT INTO morrow_work.review_risk_by_effect(effect,risk) VALUES
 ('read','internal'),('internal_write','internal'),('billable_job','internal'),('external_write','external'),
 ('spend','financial'),('communication','communication'),('control','access_change');
INSERT INTO morrow_work.review_policy_defaults(version,rules,rules_digest) VALUES ('review-policy-defaults@1',
 '{"access_change":{"approvedValiditySeconds":3600,"eligibleReviewerPrincipalIds":null,"pendingExpirySeconds":86400,"requiredApprovals":1,"selfApproval":"solo_owner_typed_confirmation"},"communication":{"approvedValiditySeconds":3600,"eligibleReviewerPrincipalIds":null,"pendingExpirySeconds":86400,"requiredApprovals":1,"selfApproval":"solo_owner_typed_confirmation"},"external":{"approvedValiditySeconds":86400,"eligibleReviewerPrincipalIds":null,"pendingExpirySeconds":259200,"requiredApprovals":1,"selfApproval":"allowed"},"financial":{"approvedValiditySeconds":3600,"eligibleReviewerPrincipalIds":null,"pendingExpirySeconds":86400,"requiredApprovals":1,"selfApproval":"solo_owner_typed_confirmation"},"internal":{"approvedValiditySeconds":86400,"eligibleReviewerPrincipalIds":null,"pendingExpirySeconds":604800,"requiredApprovals":1,"selfApproval":"allowed"},"irreversible":{"approvedValiditySeconds":3600,"eligibleReviewerPrincipalIds":null,"pendingExpirySeconds":86400,"requiredApprovals":1,"selfApproval":"solo_owner_typed_confirmation"},"soloOwner":{"coolDownSeconds":300,"quietPeriodSeconds":86400}}',
 '398d56009b350dc29e9c95ead4c25ab0bd9256803b70a2c23e4d834368ebcf72');

-- ---------------------------------------------------------------------------
-- Tenant tables. T = (organization_id, workspace_id); A(x) = principal plus
-- membership with the P06.T01a identity foreign keys. Every stored time is
-- millisecond-truncated, so utc_text equals Date.toISOString().
CREATE TABLE morrow_work.review_policies (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id='review-policy'),
 revision morrow_work.revision NOT NULL,
 rules jsonb NOT NULL,
 canonical text NOT NULL CHECK (octet_length(canonical)<=16384),
 digest morrow_work.digest NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,id,revision),
 UNIQUE (organization_id,workspace_id,id,revision,digest),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_work.workspace_streams(organization_id,workspace_id),
 CONSTRAINT review_policies_digest CHECK (digest::text=morrow_work.sha256_text(canonical)),
 CONSTRAINT review_policies_rules CHECK (morrow_work.valid_review_rules(rules)),
 CONSTRAINT review_policies_document CHECK (morrow_work.policy_document_matches(canonical,organization_id,workspace_id,id,revision,created_at,rules))
);
-- The proposal parameters artifact: a closed JSON object, controlled ArtifactRef
-- target until P07 (the P06.T04 rule).
CREATE TABLE morrow_work.proposal_parameters (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 canonical text NOT NULL CHECK (octet_length(canonical) BETWEEN 2 AND 32768),
 digest morrow_work.digest NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,id,digest),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_work.workspace_streams(organization_id,workspace_id),
 CONSTRAINT proposal_parameters_digest CHECK (digest::text=morrow_work.sha256_text(canonical)),
 CONSTRAINT proposal_parameters_object CHECK (CASE WHEN pg_input_is_valid(canonical,'jsonb') THEN jsonb_typeof(canonical::jsonb)='object' ELSE false END)
);
CREATE TABLE morrow_work.proposals (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL CHECK (revision=1),
 family_root_id morrow_work.record_id NOT NULL,
 derived_from_id morrow_work.record_id,
 derived_from_digest morrow_work.digest,
 selected_target_indexes integer[],
 task_id morrow_work.record_id,   -- null only for a human governance proposal (ADR-0018)
 capability_id text NOT NULL REFERENCES morrow_work.review_capabilities(capability_id),
 risk text NOT NULL CHECK (risk IN ('internal','external','communication','financial','access_change')),
 irreversible boolean NOT NULL,
 partial_approval text NOT NULL CHECK (partial_approval IN ('allowed','all_or_nothing')),
 target_count integer NOT NULL CHECK (target_count BETWEEN 1 AND 100),
 maximum_credits numeric(19,0) NOT NULL CHECK (maximum_credits BETWEEN 0 AND 999999999999999999),
 proposer_principal_id morrow_work.record_id NOT NULL,
 proposer_membership_id morrow_work.record_id NOT NULL,
 requester_principal_id morrow_work.record_id NOT NULL,
 requester_membership_id morrow_work.record_id NOT NULL,
 beneficiary_principal_ids text[] NOT NULL CHECK (cardinality(beneficiary_principal_ids)<=100),
 review_policy_id morrow_work.record_id NOT NULL,
 review_policy_revision morrow_work.revision NOT NULL,
 review_policy_digest morrow_work.digest NOT NULL,
 parameters_id morrow_work.record_id NOT NULL,
 parameters_digest morrow_work.digest NOT NULL,
 canonical text NOT NULL CHECK (octet_length(canonical)<=131072),
 digest morrow_work.digest NOT NULL,
 scope_canonical text NOT NULL CHECK (octet_length(scope_canonical)<=16384),
 scope_digest morrow_work.digest NOT NULL,
 expires_at timestamptz NOT NULL CHECK (expires_at=date_trunc('milliseconds',expires_at) AND isfinite(expires_at)),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,id,digest),
 FOREIGN KEY (organization_id,workspace_id,family_root_id) REFERENCES morrow_work.proposals(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,derived_from_id,derived_from_digest) REFERENCES morrow_work.proposals(organization_id,workspace_id,id,digest),
 FOREIGN KEY (organization_id,workspace_id,task_id) REFERENCES morrow_work.tasks(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,parameters_id,parameters_digest) REFERENCES morrow_work.proposal_parameters(organization_id,workspace_id,id,digest),
 FOREIGN KEY (organization_id,workspace_id,review_policy_id,review_policy_revision,review_policy_digest)
  REFERENCES morrow_work.review_policies(organization_id,workspace_id,id,revision,digest),
 FOREIGN KEY (organization_id,proposer_membership_id,proposer_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,proposer_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 FOREIGN KEY (organization_id,requester_membership_id,requester_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,requester_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT proposals_family CHECK ((derived_from_id IS NULL AND derived_from_digest IS NULL AND selected_target_indexes IS NULL AND family_root_id=id)
  OR (derived_from_id IS NOT NULL AND derived_from_digest IS NOT NULL AND selected_target_indexes IS NOT NULL AND family_root_id=derived_from_id
   AND partial_approval='all_or_nothing'
   AND id::text=morrow_work.derived_proposal_id(organization_id,workspace_id,derived_from_id,derived_from_digest,selected_target_indexes))),
 CONSTRAINT proposals_digest CHECK (digest::text=morrow_work.sha256_text(canonical) AND scope_digest::text=morrow_work.sha256_text(scope_canonical)),
 -- ADR-0018: no task only for a governance capability whose requester is the
 -- proposer; every proposer here is a human member (the A(proposer) keys).
 CONSTRAINT proposals_task_optional CHECK (task_id IS NOT NULL OR (capability_id LIKE 'governance.%'
  AND requester_principal_id=proposer_principal_id AND requester_membership_id=proposer_membership_id)),
 CONSTRAINT proposals_document CHECK (morrow_work.proposal_document_matches(canonical,scope_canonical,organization_id,workspace_id,id,revision,
  derived_from_id,derived_from_digest,selected_target_indexes,task_id,capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,
  proposer_principal_id,proposer_membership_id,requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,
  review_policy_revision,review_policy_digest,parameters_id,parameters_digest,expires_at,created_at))
);
CREATE INDEX proposals_family ON morrow_work.proposals (organization_id,workspace_id,family_root_id,id);
CREATE TABLE morrow_work.approvals (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 proposal_id morrow_work.record_id NOT NULL,
 proposal_digest morrow_work.digest NOT NULL,
 family_root_id morrow_work.record_id NOT NULL,
 status text NOT NULL CHECK (status IN ('pending','approved','rejected','expired','invalidated','cancelled')),
 required_approvals integer NOT NULL CHECK (required_approvals BETWEEN 1 AND 5),
 self_approval text NOT NULL CHECK (self_approval IN ('denied','solo_owner_typed_confirmation','allowed')),
 pending_expiry_seconds integer NOT NULL CHECK (pending_expiry_seconds BETWEEN 300 AND 2592000),
 approved_validity_seconds integer NOT NULL CHECK (approved_validity_seconds BETWEEN 300 AND 604800),
 cool_down_seconds integer NOT NULL CHECK (cool_down_seconds BETWEEN 60 AND 86400),
 quiet_period_seconds integer NOT NULL CHECK (quiet_period_seconds BETWEEN 3600 AND 604800),
 eligible_reviewer_principal_ids text[] CHECK (cardinality(eligible_reviewer_principal_ids) BETWEEN 1 AND 100),
 counted_reviewer_principal_ids text[] CHECK (cardinality(counted_reviewer_principal_ids) BETWEEN 1 AND 5),
 scope_digest morrow_work.digest NOT NULL,
 review_policy_revision morrow_work.revision NOT NULL,
 policy_revision morrow_work.revision NOT NULL,
 effective_at timestamptz CHECK (effective_at=date_trunc('milliseconds',effective_at) AND isfinite(effective_at)),
 expires_at timestamptz NOT NULL CHECK (expires_at=date_trunc('milliseconds',expires_at) AND isfinite(expires_at)),
 invalidation_reason text CHECK (invalidation_reason IN ('superseded_by_partial_approval','family_closed','review_policy_not_current','solo_owner_status_lost')),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,proposal_id),
 UNIQUE (organization_id,workspace_id,id,family_root_id),
 FOREIGN KEY (organization_id,workspace_id,proposal_id,proposal_digest) REFERENCES morrow_work.proposals(organization_id,workspace_id,id,digest),
 FOREIGN KEY (organization_id,workspace_id,family_root_id) REFERENCES morrow_work.proposals(organization_id,workspace_id,id),
 CONSTRAINT approvals_reason CHECK ((status='invalidated')=(invalidation_reason IS NOT NULL)),
 CONSTRAINT approvals_approved CHECK (status<>'approved' OR (effective_at IS NOT NULL AND counted_reviewer_principal_ids IS NOT NULL)),
 CONSTRAINT approvals_times CHECK (updated_at>=created_at)
);
CREATE UNIQUE INDEX approvals_one_approved_per_family ON morrow_work.approvals (organization_id,workspace_id,family_root_id) WHERE status='approved';
CREATE INDEX approvals_pending ON morrow_work.approvals (organization_id,workspace_id,expires_at,id) WHERE status='pending';
CREATE INDEX approvals_family ON morrow_work.approvals (organization_id,workspace_id,family_root_id,id);
CREATE TABLE morrow_work.approval_decisions (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 approval_id morrow_work.record_id NOT NULL,
 sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 5),
 reviewer_principal_id morrow_work.record_id NOT NULL,
 reviewer_membership_id morrow_work.record_id NOT NULL,
 decision text NOT NULL CHECK (decision IN ('approve','reject')),
 decided_digest morrow_work.digest NOT NULL,
 decided_at timestamptz NOT NULL CHECK (decided_at=date_trunc('milliseconds',decided_at) AND isfinite(decided_at)),
 command_id morrow_work.record_id NOT NULL,
 request_digest morrow_work.digest NOT NULL,
 comment text CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 2048),
 solo_phrase_digest morrow_work.digest,
 solo_cool_down_seconds integer CHECK (solo_cool_down_seconds BETWEEN 60 AND 86400),
 PRIMARY KEY (organization_id,workspace_id,approval_id,sequence),
 UNIQUE (organization_id,workspace_id,approval_id,reviewer_principal_id),
 FOREIGN KEY (organization_id,workspace_id,approval_id) REFERENCES morrow_work.approvals(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,reviewer_membership_id,reviewer_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,reviewer_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT approval_decisions_solo CHECK ((solo_phrase_digest IS NULL)=(solo_cool_down_seconds IS NULL))
);
-- One claim per family: the one-use binding of an approval to one consumer effect.
CREATE TABLE morrow_work.approval_claims (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 approval_id morrow_work.record_id NOT NULL,
 family_root_id morrow_work.record_id NOT NULL,
 claimant_principal_id morrow_work.record_id NOT NULL,
 claimant_membership_id morrow_work.record_id NOT NULL,
 consumer text NOT NULL CHECK (consumer ~ '^[a-z][a-z0-9_.]{2,63}$'),
 consumer_command_id morrow_work.record_id NOT NULL,
 claimed_at timestamptz NOT NULL CHECK (claimed_at=date_trunc('milliseconds',claimed_at) AND isfinite(claimed_at)),
 PRIMARY KEY (organization_id,workspace_id,approval_id),
 UNIQUE (organization_id,workspace_id,family_root_id),
 FOREIGN KEY (organization_id,workspace_id,approval_id,family_root_id) REFERENCES morrow_work.approvals(organization_id,workspace_id,id,family_root_id),
 FOREIGN KEY (organization_id,claimant_membership_id,claimant_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,claimant_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id)
);

-- ---------------------------------------------------------------------------
-- Row security: ENABLE + FORCE and the maintenance-only owner policy everywhere;
-- the command role's tenant policy on tenant tables; the api role's read policy
-- and column SELECT on the tenant-readable tables. approval_claims is tenant-
-- internal; the platform tables are readable by the command role only.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['review_capabilities','review_risk_by_effect','review_policy_defaults','review_policies','proposal_parameters',
  'proposals','approvals','approval_decisions','approval_claims'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['review_capabilities','review_risk_by_effect','review_policy_defaults'] LOOP
  EXECUTE format('CREATE POLICY platform_command_read ON morrow_work.%I FOR SELECT TO morrow_work_command USING (true)',t);
  EXECUTE format('GRANT SELECT ON morrow_work.%I TO morrow_work_command',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['review_policies','proposal_parameters','proposals','approvals','approval_decisions','approval_claims'] LOOP
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('GRANT SELECT,INSERT ON morrow_work.%I TO morrow_work_command',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['review_policies','proposal_parameters','proposals','approvals','approval_decisions'] LOOP
  EXECUTE format('CREATE POLICY tenant_read ON morrow_work.%I FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
END $$;
GRANT UPDATE (status,revision,updated_at,policy_revision,effective_at,counted_reviewer_principal_ids,expires_at,invalidation_reason)
 ON morrow_work.approvals TO morrow_work_command;
GRANT SELECT (organization_id,workspace_id,id,revision,rules,canonical,digest,created_at) ON morrow_work.review_policies TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,canonical,digest,created_at) ON morrow_work.proposal_parameters TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,revision,family_root_id,derived_from_id,derived_from_digest,selected_target_indexes,task_id,
 capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,proposer_principal_id,proposer_membership_id,requester_principal_id,
 requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,review_policy_digest,parameters_id,parameters_digest,
 canonical,digest,scope_canonical,scope_digest,expires_at,created_at) ON morrow_work.proposals TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,revision,proposal_id,proposal_digest,family_root_id,status,required_approvals,self_approval,
 pending_expiry_seconds,approved_validity_seconds,cool_down_seconds,quiet_period_seconds,eligible_reviewer_principal_ids,
 counted_reviewer_principal_ids,scope_digest,review_policy_revision,policy_revision,effective_at,expires_at,invalidation_reason,created_at,updated_at)
 ON morrow_work.approvals TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,approval_id,sequence,reviewer_principal_id,reviewer_membership_id,decision,decided_digest,decided_at,
 command_id,request_digest,comment,solo_phrase_digest,solo_cool_down_seconds) ON morrow_work.approval_decisions TO morrow_work_api;

-- ---------------------------------------------------------------------------
-- Triggers: INVOKER, owned by the owner, granted to nobody. They run with the
-- writer's privileges under its tenant policy, and raise a fixed code.
-- Review policy revisions are contiguous and never back-dated.
CREATE FUNCTION morrow_work.policy_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_max bigint; v_last timestamptz;
BEGIN
 SELECT max(x.revision),max(x.created_at) INTO v_max,v_last FROM morrow_work.review_policies x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.id;
 IF NEW.revision IS DISTINCT FROM COALESCE(v_max,0)+1 OR (v_last IS NOT NULL AND NEW.created_at<v_last) THEN
  RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- A proposal binds the SQL catalogue: never forward-dated; reviewed, not a kill
-- switch, not governance.connection.connect; its risk and irreversible flag; the expiry formula
-- of its bound policy's effective rule; a derived proposal inherits everything from
-- a root parent, selects strictly increasing in-range targets in order and never
-- raises a ceiling.
CREATE FUNCTION morrow_work.proposal_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE cap record; v_risk text; v_rules jsonb; r jsonb; parent record; d jsonb; pd jsonb; v_targets jsonb; i integer; prev integer:=-1;
BEGIN
 -- No writer stores a proposal created in the future (commands also bind it to
 -- their own transaction time).
 IF NEW.created_at>date_trunc('milliseconds',clock_timestamp()) THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 SELECT x.effect,x.irreversible,x.review_required,x.kill_switch INTO cap FROM morrow_work.review_capabilities x WHERE x.capability_id=NEW.capability_id;
 IF NOT FOUND OR NOT cap.review_required OR cap.kill_switch OR NEW.capability_id='governance.connection.connect' THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 SELECT x.risk INTO v_risk FROM morrow_work.review_risk_by_effect x WHERE x.effect=cap.effect;
 IF v_risk IS DISTINCT FROM NEW.risk OR NEW.irreversible IS DISTINCT FROM cap.irreversible THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 SELECT x.rules INTO v_rules FROM morrow_work.review_policies x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id
  AND x.id=NEW.review_policy_id AND x.revision=NEW.review_policy_revision AND x.digest=NEW.review_policy_digest;
 IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 r:=morrow_work.effective_rule(v_rules,NEW.risk,NEW.irreversible);
 IF NEW.derived_from_id IS NULL THEN
  IF NEW.expires_at IS DISTINCT FROM NEW.created_at+make_interval(secs=>(r->>'pendingExpirySeconds')::integer
    +(v_rules#>>'{soloOwner,coolDownSeconds}')::integer+(r->>'approvedValiditySeconds')::integer) THEN
   RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 SELECT x.* INTO parent FROM morrow_work.proposals x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.derived_from_id;
 IF NOT FOUND OR parent.derived_from_id IS NOT NULL OR parent.partial_approval<>'allowed' OR parent.digest IS DISTINCT FROM NEW.derived_from_digest
  OR parent.task_id IS DISTINCT FROM NEW.task_id OR parent.capability_id<>NEW.capability_id OR parent.risk<>NEW.risk OR parent.irreversible<>NEW.irreversible
  OR parent.proposer_principal_id<>NEW.proposer_principal_id OR parent.proposer_membership_id<>NEW.proposer_membership_id
  OR parent.requester_principal_id<>NEW.requester_principal_id OR parent.requester_membership_id<>NEW.requester_membership_id
  OR parent.beneficiary_principal_ids IS DISTINCT FROM NEW.beneficiary_principal_ids
  OR parent.review_policy_id<>NEW.review_policy_id OR parent.review_policy_revision<>NEW.review_policy_revision OR parent.review_policy_digest<>NEW.review_policy_digest
  OR parent.parameters_id<>NEW.parameters_id OR parent.parameters_digest<>NEW.parameters_digest
  OR parent.created_at<>NEW.created_at OR parent.expires_at<>NEW.expires_at THEN
  RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
 END IF;
 IF NEW.selected_target_indexes IS NULL OR cardinality(NEW.selected_target_indexes)<1 OR cardinality(NEW.selected_target_indexes)>=parent.target_count
  OR NEW.target_count<>cardinality(NEW.selected_target_indexes) THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 FOREACH i IN ARRAY NEW.selected_target_indexes LOOP
  IF i IS NULL OR i<=prev OR i>=parent.target_count THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
  prev:=i;
 END LOOP;
 IF NOT pg_input_is_valid(NEW.canonical,'jsonb') THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 d:=NEW.canonical::jsonb; pd:=parent.canonical::jsonb;
 SELECT jsonb_agg(pd->'targets'->u.ix ORDER BY u.o) INTO v_targets FROM unnest(NEW.selected_target_indexes) WITH ORDINALITY u(ix,o);
 IF d->'targets' IS DISTINCT FROM v_targets OR NEW.maximum_credits>parent.maximum_credits THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 IF d->'maximumCost' IS DISTINCT FROM 'null'::jsonb THEN
  IF pd->'maximumCost'='null'::jsonb OR (d#>>'{maximumCost,amount}') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$'
   OR (pd#>>'{maximumCost,amount}') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$' THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
  IF (d#>>'{maximumCost,amount}')::numeric>(pd#>>'{maximumCost,amount}')::numeric THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;
-- An approval is born pending at revision 1 with the effective-rule snapshot of its
-- proposal's bound policy and the proposal's scope digest. A root approval shares
-- its proposal's creation time and expires after the pending period; a derived one
-- shares the root approval's creation and expiry (a selection never extends the
-- pending window), needs a pending root and no approved or claimed family member.
CREATE FUNCTION morrow_work.approval_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE prop record; v_rules jsonb; r jsonb; root record; v_list text[];
BEGIN
 IF NEW.status<>'pending' OR NEW.revision<>1 OR NEW.effective_at IS NOT NULL OR NEW.counted_reviewer_principal_ids IS NOT NULL
  OR NEW.invalidation_reason IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 SELECT x.* INTO prop FROM morrow_work.proposals x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.proposal_id;
 IF NOT FOUND OR NEW.proposal_digest<>prop.digest OR NEW.family_root_id<>prop.family_root_id OR NEW.scope_digest<>prop.scope_digest
  OR NEW.review_policy_revision<>prop.review_policy_revision THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 SELECT x.rules INTO v_rules FROM morrow_work.review_policies x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id
  AND x.id=prop.review_policy_id AND x.revision=prop.review_policy_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 r:=morrow_work.effective_rule(v_rules,prop.risk,prop.irreversible);
 IF r->'eligibleReviewerPrincipalIds'<>'null'::jsonb THEN
  v_list:=ARRAY(SELECT e FROM jsonb_array_elements_text(r->'eligibleReviewerPrincipalIds') WITH ORDINALITY q(e,o) ORDER BY o);
 END IF;
 IF NEW.required_approvals<>(r->>'requiredApprovals')::integer OR NEW.self_approval<>(r->>'selfApproval')
  OR NEW.pending_expiry_seconds<>(r->>'pendingExpirySeconds')::integer OR NEW.approved_validity_seconds<>(r->>'approvedValiditySeconds')::integer
  OR NEW.cool_down_seconds<>(v_rules#>>'{soloOwner,coolDownSeconds}')::integer OR NEW.quiet_period_seconds<>(v_rules#>>'{soloOwner,quietPeriodSeconds}')::integer
  OR NEW.eligible_reviewer_principal_ids IS DISTINCT FROM v_list THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 IF prop.derived_from_id IS NULL THEN
  IF NEW.created_at<>prop.created_at OR NEW.updated_at<>NEW.created_at
   OR NEW.expires_at<>least(prop.expires_at,prop.created_at+make_interval(secs=>NEW.pending_expiry_seconds)) THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
  RETURN NEW;
 END IF;
 SELECT x.* INTO root FROM morrow_work.approvals x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.proposal_id=prop.family_root_id;
 IF NOT FOUND OR root.status<>'pending' OR NEW.id::text<>'approval_'||prop.id::text OR NEW.created_at<>root.created_at OR NEW.expires_at<>root.expires_at
  OR EXISTS(SELECT 1 FROM morrow_work.approvals x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id
   AND x.family_root_id=NEW.family_root_id AND x.status='approved')
  OR EXISTS(SELECT 1 FROM morrow_work.approval_claims x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id
   AND x.family_root_id=NEW.family_root_id) THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 RETURN NEW;
END $$;
-- Approval updates: never after a claim in the family; revision+1; only the
-- decision columns change; a status change is a transition_rules approval edge whose
-- guard matches the invalidation reason; effective time, counted reviewers and the
-- approved expiry are set only on pending→approved, by formula.
CREATE FUNCTION morrow_work.approval_enforce_status() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE
 v_mutable text[]:=ARRAY['status','revision','updated_at','policy_revision','effective_at','counted_reviewer_principal_ids','expires_at','invalidation_reason'];
 v_last record; v_expires timestamptz;
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM morrow_work.approval_claims x WHERE x.organization_id=OLD.organization_id AND x.workspace_id=OLD.workspace_id
   AND x.family_root_id=OLD.family_root_id) THEN RAISE EXCEPTION 'APPROVAL_CLAIMED'; END IF;
 IF NEW.revision IS DISTINCT FROM OLD.revision+1 OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 IF NEW.status=OLD.status THEN
  IF NEW.status<>'pending' OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
   OR NEW.counted_reviewer_principal_ids IS DISTINCT FROM OLD.counted_reviewer_principal_ids
   OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.invalidation_reason IS DISTINCT FROM OLD.invalidation_reason THEN
   RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_work.transition_rules x WHERE x.machine='approval' AND x.from_status=OLD.status AND x.to_status=NEW.status
   AND (NEW.status<>'invalidated' OR x.guard=ANY(CASE NEW.invalidation_reason WHEN 'superseded_by_partial_approval' THEN ARRAY['superseded_by_partial_approval']
    WHEN 'family_closed' THEN ARRAY['family_rejected','proposal_or_authority_changed'] ELSE ARRAY['proposal_or_authority_changed'] END))) THEN
  RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
 END IF;
 SELECT x.decision,x.decided_at,x.solo_phrase_digest IS NOT NULL AS solo INTO v_last FROM morrow_work.approval_decisions x
  WHERE x.organization_id=OLD.organization_id AND x.workspace_id=OLD.workspace_id AND x.approval_id=OLD.id ORDER BY x.sequence DESC LIMIT 1;
 IF OLD.status='pending' AND NEW.status='approved' THEN
  IF v_last.decision IS DISTINCT FROM 'approve' THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
  SELECT x.expires_at INTO v_expires FROM morrow_work.proposals x WHERE x.organization_id=OLD.organization_id AND x.workspace_id=OLD.workspace_id AND x.id=OLD.proposal_id;
  IF NEW.effective_at IS DISTINCT FROM v_last.decided_at+(CASE WHEN v_last.solo THEN make_interval(secs=>OLD.cool_down_seconds) ELSE interval '0' END)
   OR NEW.expires_at IS DISTINCT FROM least(v_expires,NEW.effective_at+make_interval(secs=>OLD.approved_validity_seconds))
   OR (v_last.solo AND cardinality(NEW.counted_reviewer_principal_ids)<>1)
   OR (NOT v_last.solo AND cardinality(NEW.counted_reviewer_principal_ids)<OLD.required_approvals)
   OR (SELECT count(DISTINCT c) FROM unnest(NEW.counted_reviewer_principal_ids) c)<>cardinality(NEW.counted_reviewer_principal_ids)
   OR EXISTS(SELECT 1 FROM unnest(NEW.counted_reviewer_principal_ids) c WHERE NOT EXISTS(SELECT 1 FROM morrow_work.approval_decisions x
    WHERE x.organization_id=OLD.organization_id AND x.workspace_id=OLD.workspace_id AND x.approval_id=OLD.id AND x.reviewer_principal_id=c AND x.decision='approve')) THEN
   RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.effective_at IS DISTINCT FROM OLD.effective_at OR NEW.counted_reviewer_principal_ids IS DISTINCT FROM OLD.counted_reviewer_principal_ids
  OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 IF NEW.status='rejected' AND v_last.decision IS DISTINCT FROM 'reject' THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 IF OLD.status='approved' AND NEW.status='cancelled' AND NOT (NEW.updated_at<OLD.effective_at) THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 RETURN NEW;
END $$;
-- A decision lands only on a pending approval, in sequence, inside the snapshot's
-- reviewer list, and respects the conflict set: a conflicted approval needs
-- `allowed`, or the solo-owner phrase digest of the stored proposal (the solo-owner
-- facts themselves are dynamic and checked by the command under lock).
CREATE FUNCTION morrow_work.decision_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE a record; prop record; v_count integer;
BEGIN
 SELECT x.* INTO a FROM morrow_work.approvals x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.approval_id;
 IF NOT FOUND OR a.status<>'pending' OR NEW.decided_at<a.created_at OR NEW.decided_digest<>a.proposal_digest THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 SELECT count(*) INTO v_count FROM morrow_work.approval_decisions x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.approval_id=NEW.approval_id;
 IF NEW.sequence<>v_count+1 THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 IF a.eligible_reviewer_principal_ids IS NOT NULL AND NOT (NEW.reviewer_principal_id::text=ANY(a.eligible_reviewer_principal_ids)) THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 SELECT x.proposer_principal_id::text AS proposer,x.requester_principal_id::text AS requester,x.beneficiary_principal_ids,x.canonical INTO prop
  FROM morrow_work.proposals x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=a.proposal_id;
 IF NEW.decision='approve' AND morrow_work.conflicted(prop.proposer,prop.requester,prop.beneficiary_principal_ids,NEW.reviewer_principal_id) THEN
  IF a.self_approval='denied' THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
  ELSIF a.self_approval='solo_owner_typed_confirmation' THEN
   IF NEW.solo_phrase_digest IS DISTINCT FROM morrow_work.sha256_text(morrow_work.solo_phrase(prop.canonical::jsonb))
    OR NEW.solo_cool_down_seconds IS DISTINCT FROM a.cool_down_seconds THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
  ELSIF NEW.solo_phrase_digest IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
  END IF;
 ELSIF NEW.solo_phrase_digest IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_work.policy_bind() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.proposal_bind() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.approval_bind() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.approval_enforce_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.decision_bind() FROM PUBLIC;
CREATE TRIGGER policy_bind BEFORE INSERT ON morrow_work.review_policies FOR EACH ROW EXECUTE FUNCTION morrow_work.policy_bind();
CREATE TRIGGER proposal_bind BEFORE INSERT ON morrow_work.proposals FOR EACH ROW EXECUTE FUNCTION morrow_work.proposal_bind();
CREATE TRIGGER approval_bind BEFORE INSERT ON morrow_work.approvals FOR EACH ROW EXECUTE FUNCTION morrow_work.approval_bind();
CREATE TRIGGER enforce_status BEFORE UPDATE ON morrow_work.approvals FOR EACH ROW EXECUTE FUNCTION morrow_work.approval_enforce_status();
CREATE TRIGGER decision_bind BEFORE INSERT ON morrow_work.approval_decisions FOR EACH ROW EXECUTE FUNCTION morrow_work.decision_bind();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['review_capabilities','review_risk_by_effect','review_policy_defaults','review_policies','proposal_parameters',
  'proposals','approval_decisions','approval_claims'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 EXECUTE 'CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.approvals FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()';
 FOREACH t IN ARRAY ARRAY['review_capabilities','review_risk_by_effect','review_policy_defaults','review_policies','proposal_parameters',
  'proposals','approvals','approval_decisions','approval_claims'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Helpers: owned by the command role after the transfer below, INVOKER, granted to
-- nobody; they run under the command role's tenant policies.
-- Database time: millisecond-truncated, read after the last lock wait.
CREATE FUNCTION morrow_work.db_now() RETURNS timestamptz
LANGUAGE sql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
 SELECT date_trunc('milliseconds',clock_timestamp())
$$;
-- The P06.T01a prelude for approval claim consumers, with the exclusive organization
-- lock (work_lock_and_recheck_exclusive) taken first and never upgraded.
CREATE FUNCTION morrow_work.command_prelude_exclusive(p_command_id text,p_request_digest text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,principal_id text,membership_id text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 t record; v_check text;
BEGIN
 IF p_command_id IS NULL OR p_command_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_request_digest IS NULL OR p_request_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT c.organization_id,c.workspace_id,c.principal_id,c.membership_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF t.principal_id IS DISTINCT FROM pg_catalog.current_setting('morrow.work_principal_id',true)
  OR t.membership_id IS DISTINCT FROM pg_catalog.current_setting('morrow.work_membership_id',true) THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.work.command',t.organization_id,t.workspace_id,t.principal_id,p_command_id)::text,0));
 IF EXISTS(SELECT 1 FROM morrow_work.commands c WHERE c.organization_id=t.organization_id AND c.workspace_id=t.workspace_id
   AND c.actor_principal_id=t.principal_id AND c.command_id=p_command_id) THEN
  RETURN QUERY SELECT 'command_conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_check:=morrow_identity.work_lock_and_recheck_exclusive(
  pg_catalog.current_setting('morrow.work_session_digest',true),pg_catalog.current_setting('morrow.work_workspace',true),
  pg_catalog.current_setting('morrow.work_principal_id',true),pg_catalog.current_setting('morrow.work_membership_id',true),
  pg_catalog.current_setting('morrow.work_policy_revision',true),pg_catalog.current_setting('morrow.work_grants_digest',true),
  pg_catalog.current_setting('morrow.work_evaluated_at_us',true));
 IF v_check='ineligible' THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 ELSIF v_check IS DISTINCT FROM 'current' THEN
  RETURN QUERY SELECT 'stale_authority'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 INSERT INTO morrow_work.workspace_streams(organization_id,workspace_id,head_position,created_at)
  VALUES (t.organization_id,t.workspace_id,0,clock_timestamp()) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM morrow_work.workspace_streams s WHERE s.organization_id=t.organization_id AND s.workspace_id=t.workspace_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 RETURN QUERY SELECT 'ok'::text,t.organization_id,t.workspace_id,t.principal_id,t.membership_id;
END $$;
-- Counted reviewers are current (§4): each holds an approve decision on the
-- approval, is still an active member with the same membership and grants digest
-- it was judged on, and none of its grants expired in (evaluatedAt, now]. With
-- p_expected the set must equal it exactly (a claim's counted set).
CREATE FUNCTION morrow_work.counted_current(p_org text,p_ws text,p_approval_id text,p_capability text,p_counted jsonb,p_expected text[],p_now timestamptz)
RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_eval timestamptz; v_principals text[]; e jsonb; g record; v_expired boolean;
BEGIN
 IF p_counted IS NULL OR jsonb_typeof(p_counted)<>'object' THEN RETURN 'invalid'; END IF;
 IF NOT (p_counted ?& ARRAY['evaluatedAt','reviewers']) OR (p_counted-ARRAY['evaluatedAt','reviewers'])<>'{}'::jsonb
  OR jsonb_typeof(p_counted->'reviewers')<>'array' OR jsonb_typeof(p_counted->'evaluatedAt')<>'string' THEN RETURN 'invalid'; END IF;
 IF jsonb_array_length(p_counted->'reviewers')>5 THEN RETURN 'invalid'; END IF;
 v_eval:=morrow_work.utc_parse(p_counted->>'evaluatedAt');
 IF v_eval IS NULL THEN RETURN 'invalid'; END IF;
 FOR e IN SELECT x FROM jsonb_array_elements(p_counted->'reviewers') x LOOP
  IF jsonb_typeof(e)<>'object' THEN RETURN 'invalid'; END IF;
  IF NOT (e ?& ARRAY['principalId','membershipId','grantsDigest']) OR (e-ARRAY['principalId','membershipId','grantsDigest'])<>'{}'::jsonb
   OR NOT morrow_work.json_id(e->'principalId') OR NOT morrow_work.json_id(e->'membershipId') OR jsonb_typeof(e->'grantsDigest')<>'string' THEN RETURN 'invalid'; END IF;
  IF (e->>'grantsDigest') !~ '^[a-f0-9]{64}$' THEN RETURN 'invalid'; END IF;
 END LOOP;
 v_principals:=ARRAY(SELECT x->>'principalId' FROM jsonb_array_elements(p_counted->'reviewers') x);
 IF (SELECT count(DISTINCT x) FROM unnest(v_principals) x)<>cardinality(v_principals) THEN RETURN 'invalid'; END IF;
 IF p_expected IS NOT NULL AND (cardinality(v_principals)<>cardinality(p_expected) OR NOT (v_principals<@p_expected)) THEN RETURN 'invalid'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(v_principals) x WHERE NOT EXISTS(SELECT 1 FROM morrow_work.approval_decisions d
   WHERE d.organization_id=p_org AND d.workspace_id=p_ws AND d.approval_id=p_approval_id AND d.reviewer_principal_id=x AND d.decision='approve')) THEN
  RETURN 'invalid';
 END IF;
 IF cardinality(v_principals)=0 THEN RETURN 'current'; END IF;
 IF v_eval>p_now THEN RETURN 'stale_authority'; END IF;
 FOR e IN SELECT x FROM jsonb_array_elements(p_counted->'reviewers') x LOOP
  SELECT r.membership_id,r.grants,r.grants_digest INTO g FROM morrow_identity.work_reviewer_grants(p_org,p_ws,p_capability,ARRAY[e->>'principalId']) r;
  IF NOT FOUND OR g.membership_id IS DISTINCT FROM e->>'membershipId' THEN RETURN 'REVIEWER_AUTHORITY_LOST'; END IF;
  IF g.grants_digest IS DISTINCT FROM e->>'grantsDigest' THEN RETURN 'stale_authority'; END IF;
  BEGIN
   SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(g.grants) q WHERE q->'expiresAt'<>'null'::jsonb
    AND (q->>'expiresAt')::timestamptz>v_eval AND (q->>'expiresAt')::timestamptz<=p_now) INTO v_expired;
  EXCEPTION WHEN OTHERS THEN v_expired:=NULL;
  END;
  IF v_expired IS NOT FALSE THEN RETURN 'stale_authority'; END IF;
 END LOOP;
 RETURN 'current';
END $$;
-- The one-use consumption primitive (§5 Claim), called only from a consumer's own
-- api-executable definer after command_prelude_exclusive, inside the consumer's
-- effect transaction. The consumer names the capability it executes. It locks the
-- family root approval then the approval, reads database time, and requires: the
-- exact approval revision, ApprovalRef digest, proposal digest and capability; no
-- claim in the family; no projected outcome; approved status; effectiveAt reached;
-- the exact counted set still current. It records the claim and approval.claimed,
-- and returns the stored proposal and parameters, from which alone the consumer
-- derives its effect input. The same claimant, consumer and consumer command ID
-- reading back its own committed claim (an unknown commit) gets `replayed` and the
-- same documents, and nothing is written; any other claim in the family is
-- APPROVAL_ALREADY_CLAIMED. Granted to nobody.
CREATE FUNCTION morrow_work.approval_claim(p_approval_id text,p_approval_revision text,p_approval_digest text,p_proposal_id text,p_proposal_digest text,
 p_capability text,p_consumer text,p_consumer_command_id text,p_counted text)
RETURNS TABLE(outcome text,proposal jsonb,parameters jsonb)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 t record; a record; root record; prop record; v_now timestamptz; f record; v_current bigint; v_solo record; v_projection record;
 v_code text; v_parameters text; v_claim record;
BEGIN
 IF p_approval_id IS NULL OR p_approval_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_approval_revision IS NULL OR p_approval_revision !~ '^[1-9][0-9]{0,15}$'
  OR p_approval_digest IS NULL OR p_approval_digest !~ '^[a-f0-9]{64}$'
  OR p_proposal_id IS NULL OR p_proposal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_proposal_digest IS NULL OR p_proposal_digest !~ '^[a-f0-9]{64}$'
  OR p_capability IS NULL OR char_length(p_capability)>128 OR p_capability !~ '^[a-z]+(\.[a-z_]+)+$'
  OR p_consumer IS NULL OR p_consumer !~ '^[a-z][a-z0-9_.]{2,63}$'
  OR p_consumer_command_id IS NULL OR p_consumer_command_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_counted IS NULL OR octet_length(p_counted)>4096 OR NOT pg_input_is_valid(p_counted,'jsonb') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb; RETURN;
 END IF;
 IF p_approval_revision::numeric>9007199254740991 THEN RETURN QUERY SELECT 'invalid'::text,NULL::jsonb,NULL::jsonb; RETURN; END IF;
 SELECT c.organization_id,c.workspace_id,c.principal_id,c.membership_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND OR t.principal_id IS DISTINCT FROM pg_catalog.current_setting('morrow.work_principal_id',true)
  OR t.membership_id IS DISTINCT FROM pg_catalog.current_setting('morrow.work_membership_id',true) THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::jsonb,NULL::jsonb; RETURN;
 END IF;
 SELECT x.family_root_id::text AS family_root_id INTO a FROM morrow_work.approvals x
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=p_approval_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::jsonb,NULL::jsonb; RETURN; END IF;
 SELECT x.id INTO root FROM morrow_work.approvals x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
  AND x.proposal_id=a.family_root_id FOR UPDATE;
 SELECT x.* INTO a FROM morrow_work.approvals x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=p_approval_id FOR UPDATE;
 v_now:=morrow_work.db_now();
 SELECT x.id::text AS id,x.digest::text AS digest,x.canonical,x.capability_id,x.task_id::text AS task_id,x.parameters_id::text AS parameters_id INTO prop
  FROM morrow_work.proposals x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=a.proposal_id;
 IF a.revision::text<>p_approval_revision OR prop.id<>p_proposal_id OR prop.digest<>p_proposal_digest OR prop.capability_id<>p_capability
  OR morrow_work.approval_ref_digest(t.organization_id,t.workspace_id,a.id,a.revision,a.proposal_digest,a.scope_digest,a.status,a.effective_at,a.expires_at)<>p_approval_digest THEN
  RETURN QUERY SELECT 'DIGEST_MISMATCH'::text,NULL::jsonb,NULL::jsonb; RETURN;
 END IF;
 SELECT x.approval_id::text AS approval_id,x.claimant_principal_id::text AS principal_id,x.claimant_membership_id::text AS membership_id,
  x.consumer,x.consumer_command_id::text AS consumer_command_id INTO v_claim FROM morrow_work.approval_claims x
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.family_root_id=a.family_root_id;
 IF FOUND THEN
  IF v_claim.approval_id=a.id AND v_claim.principal_id=t.principal_id AND v_claim.membership_id=t.membership_id
   AND v_claim.consumer=p_consumer AND v_claim.consumer_command_id=p_consumer_command_id THEN
   SELECT x.canonical INTO v_parameters FROM morrow_work.proposal_parameters x WHERE x.organization_id=t.organization_id
    AND x.workspace_id=t.workspace_id AND x.id=prop.parameters_id;
   RETURN QUERY SELECT 'replayed'::text,prop.canonical::jsonb||jsonb_build_object('proposalDigest',prop.digest),v_parameters::jsonb; RETURN;
  END IF;
  RETURN QUERY SELECT 'APPROVAL_ALREADY_CLAIMED'::text,NULL::jsonb,NULL::jsonb; RETURN;
 END IF;
 SELECT max(x.revision) INTO v_current FROM morrow_work.review_policies x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id='review-policy';
 SELECT * INTO f FROM morrow_identity.work_ownership_facts(t.organization_id);
 SELECT x.reviewer_principal_id::text AS reviewer,x.decided_at INTO v_solo FROM morrow_work.approval_decisions x
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.approval_id=a.id AND x.solo_phrase_digest IS NOT NULL;
 SELECT * INTO v_projection FROM morrow_work.approval_projection(a.status,a.expires_at,a.review_policy_revision,v_current,false,v_solo.reviewer,
  v_solo.decided_at,a.quiet_period_seconds,f.owner_principal_id,f.active_human_membership_count,f.last_membership_change_at,v_now);
 IF v_projection.code IS NOT NULL THEN RETURN QUERY SELECT v_projection.code,NULL::jsonb,NULL::jsonb; RETURN; END IF;
 IF a.status<>'approved' THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::jsonb,NULL::jsonb; RETURN; END IF;
 IF v_now<a.effective_at THEN RETURN QUERY SELECT 'APPROVAL_NOT_EFFECTIVE'::text,NULL::jsonb,NULL::jsonb; RETURN; END IF;
 v_code:=morrow_work.counted_current(t.organization_id,t.workspace_id,a.id,prop.capability_id,p_counted::jsonb,a.counted_reviewer_principal_ids,v_now);
 IF v_code<>'current' THEN RETURN QUERY SELECT v_code,NULL::jsonb,NULL::jsonb; RETURN; END IF;
 INSERT INTO morrow_work.approval_claims(organization_id,workspace_id,approval_id,family_root_id,claimant_principal_id,claimant_membership_id,
  consumer,consumer_command_id,claimed_at)
 VALUES (t.organization_id,t.workspace_id,a.id,a.family_root_id,t.principal_id,t.membership_id,p_consumer,p_consumer_command_id,v_now);
 PERFORM morrow_work.append_event(t.organization_id,t.workspace_id,t.principal_id,t.membership_id,'approval.claimed','approval',a.id,a.revision,
  prop.task_id,jsonb_build_object('consumer',p_consumer),p_consumer_command_id,v_now);
 SELECT x.canonical INTO v_parameters FROM morrow_work.proposal_parameters x WHERE x.organization_id=t.organization_id
  AND x.workspace_id=t.workspace_id AND x.id=prop.parameters_id;
 RETURN QUERY SELECT 'applied'::text,prop.canonical::jsonb||jsonb_build_object('proposalDigest',prop.digest),v_parameters::jsonb;
END $$;

-- ---------------------------------------------------------------------------
-- API functions: SECURITY DEFINER, owned by the command role after the transfer,
-- EXECUTE for morrow_work_api only. Tenant and actor come only from
-- current_tenant(); no organization, workspace or actor parameter.
-- Read facts for building and deciding a review (deviation 3): the workspace's
-- current policy, the catalogue facts of a capability, the solo-owner facts, the
-- claimed member of a family (or none) and database time. Read before the command
-- takes its locks, so never trusted as current: the commands re-read under lock.
CREATE FUNCTION morrow_work.review_context(p_capability text,p_family_root_id text)
RETURNS TABLE(policy_revision text,policy_canonical text,policy_digest text,defaults_digest text,capability_effect text,capability_irreversible text,
 capability_review_required text,capability_kill_switch text,risk text,owner_principal_id text,owner_membership_id text,
 active_human_membership_count text,last_membership_change_at text,claimed_approval_id text,database_now text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; pol record; cap record; f record; v_claim text; v_risk text; v_defaults text;
BEGIN
 IF p_capability IS NULL OR char_length(p_capability)>128 OR p_capability !~ '^[a-z]+(\.[a-z_]+)+$'
  OR (p_family_root_id IS NOT NULL AND p_family_root_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT x.revision::text AS revision,x.canonical,x.digest::text AS digest INTO pol FROM morrow_work.review_policies x
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id='review-policy' ORDER BY x.revision DESC LIMIT 1;
 SELECT x.effect,x.irreversible,x.review_required,x.kill_switch INTO cap FROM morrow_work.review_capabilities x WHERE x.capability_id=p_capability;
 SELECT x.risk INTO v_risk FROM morrow_work.review_risk_by_effect x WHERE x.effect=cap.effect;
 SELECT x.rules_digest::text INTO v_defaults FROM morrow_work.review_policy_defaults x WHERE x.version='review-policy-defaults@1';
 SELECT * INTO f FROM morrow_identity.work_ownership_facts(t.organization_id);
 IF p_family_root_id IS NOT NULL THEN
  SELECT x.approval_id::text INTO v_claim FROM morrow_work.approval_claims x WHERE x.organization_id=t.organization_id
   AND x.workspace_id=t.workspace_id AND x.family_root_id=p_family_root_id;
 END IF;
 RETURN QUERY SELECT pol.revision,pol.canonical,pol.digest,v_defaults,cap.effect,cap.irreversible::text,cap.review_required::text,cap.kill_switch::text,
  v_risk,f.owner_principal_id,f.owner_membership_id,f.active_human_membership_count::text,morrow_work.utc_text(f.last_membership_change_at),
  v_claim,morrow_work.utc_text(morrow_work.db_now());
END $$;
-- Review candidates (liveness only; the kernel judges their grants in the Worker).
-- p_exclude is a JSON array of at most 102 principal ids; p_limit 1..25.
CREATE FUNCTION morrow_work.review_candidates(p_capability text,p_exclude text,p_after text,p_limit text)
RETURNS TABLE(principal_id text,membership_id text,grants text,grant_count text,grants_digest text,evaluated_at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; v_exclude text[]; v_now timestamptz;
BEGIN
 IF p_capability IS NULL OR char_length(p_capability)>128 OR p_capability !~ '^[a-z]+(\.[a-z_]+)+$'
  OR p_exclude IS NULL OR octet_length(p_exclude)>16384 OR NOT pg_input_is_valid(p_exclude,'jsonb')
  OR (p_after IS NOT NULL AND p_after !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  OR p_limit IS NULL OR p_limit !~ '^[1-9][0-9]?$' THEN RETURN; END IF;
 IF p_limit::integer>25 OR jsonb_typeof(p_exclude::jsonb)<>'array' THEN RETURN; END IF;
 IF jsonb_array_length(p_exclude::jsonb)>102 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_exclude::jsonb) e WHERE NOT morrow_work.json_id(e)) THEN RETURN; END IF;
 v_exclude:=ARRAY(SELECT e FROM jsonb_array_elements_text(p_exclude::jsonb) e);
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 v_now:=morrow_work.db_now();
 RETURN QUERY SELECT c.principal_id,c.membership_id,c.grants::text,c.grant_count::text,c.grants_digest,morrow_work.utc_text(v_now)
  FROM morrow_identity.work_review_candidates(t.organization_id,t.workspace_id,p_capability,v_exclude,p_after,p_limit::integer) c;
END $$;
-- The grants of at most five named reviewers (counted reviewers at decision and claim).
CREATE FUNCTION morrow_work.reviewer_snapshot(p_capability text,p_principals text)
RETURNS TABLE(principal_id text,membership_id text,grants text,grant_count text,grants_digest text,evaluated_at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; v_principals text[]; v_now timestamptz;
BEGIN
 IF p_capability IS NULL OR char_length(p_capability)>128 OR p_capability !~ '^[a-z]+(\.[a-z_]+)+$'
  OR p_principals IS NULL OR octet_length(p_principals)>1024 OR NOT pg_input_is_valid(p_principals,'jsonb') THEN RETURN; END IF;
 IF jsonb_typeof(p_principals::jsonb)<>'array' THEN RETURN; END IF;
 IF jsonb_array_length(p_principals::jsonb) NOT BETWEEN 1 AND 5 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_principals::jsonb) e WHERE NOT morrow_work.json_id(e)) THEN RETURN; END IF;
 v_principals:=ARRAY(SELECT e FROM jsonb_array_elements_text(p_principals::jsonb) e);
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 v_now:=morrow_work.db_now();
 RETURN QUERY SELECT c.principal_id,c.membership_id,c.grants::text,c.grant_count::text,c.grants_digest,morrow_work.utc_text(v_now)
  FROM morrow_identity.work_reviewer_grants(t.organization_id,t.workspace_id,p_capability,v_principals) c;
END $$;
-- Replay first for the approval commands: the per-actor key lock, then the recorded
-- command if any (begin_command for the approval command types).
CREATE FUNCTION morrow_work.begin_approval_command(p_type text,p_command_id text,p_request_digest text)
RETURNS TABLE(outcome text,aggregate_type text,aggregate_id text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 t record; c record;
BEGIN
 IF p_type IS NULL OR p_type NOT IN ('proposal.submit','approval.decide','approval.withdraw')
  OR p_command_id IS NULL OR p_command_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_request_digest IS NULL OR p_request_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.organization_id,x.workspace_id,x.principal_id INTO t FROM morrow_work.current_tenant() x;
 IF NOT FOUND THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.work.command',t.organization_id,t.workspace_id,t.principal_id,p_command_id)::text,0));
 SELECT k.request_digest::text AS request_digest,k.command_type,k.aggregate_type,k.aggregate_id::text AS aggregate_id,k.result::text AS result INTO c
  FROM morrow_work.commands k WHERE k.organization_id=t.organization_id AND k.workspace_id=t.workspace_id
  AND k.actor_principal_id=t.principal_id AND k.command_id=p_command_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'new'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF c.request_digest<>p_request_digest OR c.command_type<>p_type THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'replay'::text,c.aggregate_type,c.aggregate_id,c.result;
END $$;

-- Submit (§5): producer code only, no HTTP route. The Worker builds Proposal@2 from
-- SQL facts and the library; this rechecks everything data-only and writes the
-- parameters, the proposal, its pending approval, one event and the command row.
CREATE FUNCTION morrow_work.cmd_proposal_submit(p_command_id text,p_request_digest text,p_correlation_id text,p_task_id text,p_task_basis text,
 p_approval_id text,p_policy_canonical text,p_policy_digest text,p_parameters_canonical text,p_parameters_digest text,
 p_proposal_canonical text,p_proposal_digest text,p_scope_canonical text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; k record; cap record; pol record; d jsonb; v_policy jsonb; v_created timestamptz; v_expires timestamptz; v_now timestamptz;
 v_capability text; v_id text; v_parameters_id text; v_beneficiaries text[]; v_risk text; v_rule jsonb; v_requester_p text; v_requester_m text;
 v_approval_expires timestamptz; v_list text[]; v_org_revision bigint; v_result jsonb; v_targets integer;
BEGIN
 -- (a) closed scalars, bounded texts, JSON validity before any cast, digests.
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR (p_task_id IS NULL)<>(p_task_basis IS NULL)
  OR (p_task_id IS NOT NULL AND (p_task_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_task_basis NOT IN ('own','other')))
  OR p_approval_id IS NULL OR p_approval_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_policy_digest IS NULL OR p_policy_digest !~ '^[a-f0-9]{64}$'
  OR (p_policy_canonical IS NOT NULL AND (octet_length(p_policy_canonical)>16384 OR NOT pg_input_is_valid(p_policy_canonical,'jsonb')))
  OR p_parameters_canonical IS NULL OR octet_length(p_parameters_canonical) NOT BETWEEN 2 AND 32768 OR NOT pg_input_is_valid(p_parameters_canonical,'jsonb')
  OR p_parameters_digest IS NULL OR p_parameters_digest !~ '^[a-f0-9]{64}$'
  OR p_proposal_canonical IS NULL OR octet_length(p_proposal_canonical)>131072 OR NOT pg_input_is_valid(p_proposal_canonical,'jsonb')
  OR p_proposal_digest IS NULL OR p_proposal_digest !~ '^[a-f0-9]{64}$'
  OR p_scope_canonical IS NULL OR octet_length(p_scope_canonical)>16384 OR NOT pg_input_is_valid(p_scope_canonical,'jsonb') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF morrow_work.sha256_text(p_parameters_canonical)<>p_parameters_digest OR morrow_work.sha256_text(p_proposal_canonical)<>p_proposal_digest
  OR (p_policy_canonical IS NOT NULL AND morrow_work.sha256_text(p_policy_canonical)<>p_policy_digest) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 d:=p_proposal_canonical::jsonb;
 IF jsonb_typeof(d)<>'object' OR jsonb_typeof(p_parameters_canonical::jsonb)<>'object' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 IF NOT morrow_work.json_id(d->'id') OR jsonb_typeof(d->'capabilityId')<>'string' OR jsonb_typeof(d->'createdAt')<>'string'
  OR jsonb_typeof(d->'expiresAt')<>'string' OR jsonb_typeof(d->'targets')<>'array' OR jsonb_typeof(d->'maximumCredits')<>'string'
  OR jsonb_typeof(d->'partialApproval')<>'string' OR jsonb_typeof(d->'beneficiaryPrincipalIds')<>'array'
  OR NOT morrow_work.json_id(d#>'{parametersRef,id}') OR d->'derivedFrom' IS DISTINCT FROM 'null'::jsonb
  OR d->'taskId' IS DISTINCT FROM COALESCE(to_jsonb(p_task_id),'null'::jsonb) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF (d->>'maximumCredits') !~ '^(0|[1-9][0-9]{0,17})$' OR jsonb_array_length(d->'targets') NOT BETWEEN 1 AND 100
  OR jsonb_array_length(d->'beneficiaryPrincipalIds')>100
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'beneficiaryPrincipalIds') e WHERE NOT morrow_work.json_id(e)) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_created:=morrow_work.utc_parse(d->>'createdAt'); v_expires:=morrow_work.utc_parse(d->>'expiresAt');
 IF v_created IS NULL OR v_expires IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 v_capability:=d->>'capabilityId'; v_id:=d->>'id'; v_parameters_id:=d#>>'{parametersRef,id}'; v_targets:=jsonb_array_length(d->'targets');
 v_beneficiaries:=ARRAY(SELECT e FROM jsonb_array_elements_text(d->'beneficiaryPrincipalIds') WITH ORDINALITY q(e,o) ORDER BY o);
 -- (b) the P06.T01a prelude: tenant, actor, key lock, locked freshness, stream lock.
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT c.policy_revision INTO v_org_revision FROM morrow_work.current_tenant() c;
 -- (c) the SQL catalogue: reviewed, no kill switch, no connect; ADR-0018.
 SELECT x.effect,x.irreversible,x.review_required,x.kill_switch INTO cap FROM morrow_work.review_capabilities x WHERE x.capability_id=v_capability;
 IF NOT FOUND OR NOT cap.review_required OR cap.kill_switch OR v_capability='governance.connection.connect'
  OR (p_task_id IS NULL AND v_capability NOT LIKE 'governance.%') THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT x.risk INTO v_risk FROM morrow_work.review_risk_by_effect x WHERE x.effect=cap.effect;
 -- (d) the task, when named: locked, its status and the attach basis rechecked.
 IF p_task_id IS NOT NULL THEN
  SELECT x.status,x.initiator_principal_id::text AS ip,x.initiator_membership_id::text AS im INTO k FROM morrow_work.tasks x
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_task_id FOR SHARE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
  IF k.status NOT IN ('draft','ready') THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
  IF (p_task_basis='own') IS DISTINCT FROM (k.ip=p.principal_id AND k.im=p.membership_id) THEN RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN; END IF;
  v_requester_p:=k.ip; v_requester_m:=k.im;
 ELSE
  v_requester_p:=p.principal_id; v_requester_m:=p.membership_id;
 END IF;
 -- createdAt lies inside this transaction (no production clock override).
 v_now:=morrow_work.db_now();
 IF v_created<date_trunc('milliseconds',transaction_timestamp()) OR v_created>v_now THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 -- (e) the workspace's single current ReviewPolicy; revision 1 is seeded from the
 -- defaults with the proposal's createdAt. Another current policy is retryable.
 SELECT x.revision::bigint AS revision,x.digest::text AS digest,x.rules INTO pol FROM morrow_work.review_policies x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id='review-policy' ORDER BY x.revision DESC LIMIT 1;
 IF NOT FOUND THEN
  IF p_policy_canonical IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
  v_policy:=p_policy_canonical::jsonb;
  IF jsonb_typeof(v_policy)<>'object' OR v_policy->'revision' IS DISTINCT FROM '1'::jsonb
   OR v_policy->'rules' IS DISTINCT FROM (SELECT x.rules FROM morrow_work.review_policy_defaults x WHERE x.version='review-policy-defaults@1')
   OR v_policy->'createdAt' IS DISTINCT FROM to_jsonb(morrow_work.utc_text(v_created)) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
  BEGIN
   INSERT INTO morrow_work.review_policies(organization_id,workspace_id,id,revision,rules,canonical,digest,created_at)
   VALUES (p.organization_id,p.workspace_id,'review-policy',1,v_policy->'rules',p_policy_canonical,p_policy_digest,v_created);
  EXCEPTION WHEN check_violation OR raise_exception OR unique_violation OR foreign_key_violation OR not_null_violation THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END;
  SELECT x.revision::bigint AS revision,x.digest::text AS digest,x.rules INTO pol FROM morrow_work.review_policies x
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id='review-policy' AND x.revision=1;
 ELSIF p_policy_canonical IS NOT NULL OR pol.digest<>p_policy_digest THEN
  RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN;
 END IF;
 -- (f) the published cap: 1,000 live pending approvals under the current policy.
 IF (SELECT count(*) FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.status='pending' AND x.expires_at>v_now AND x.review_policy_revision=pol.revision)>=1000 THEN
  RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
 END IF;
 -- (g) the document against the row this command derives, and the expiry formula.
 v_rule:=morrow_work.effective_rule(pol.rules,v_risk,cap.irreversible);
 IF v_expires<>v_created+make_interval(secs=>(v_rule->>'pendingExpirySeconds')::integer+(pol.rules#>>'{soloOwner,coolDownSeconds}')::integer
   +(v_rule->>'approvedValiditySeconds')::integer)
  OR NOT morrow_work.proposal_document_matches(p_proposal_canonical,p_scope_canonical,p.organization_id,p.workspace_id,v_id,1,NULL,NULL,NULL,
   p_task_id,v_capability,v_risk,cap.irreversible,d->>'partialApproval',v_targets,(d->>'maximumCredits')::numeric,p.principal_id,p.membership_id,
   v_requester_p,v_requester_m,v_beneficiaries,'review-policy',pol.revision,pol.digest,v_parameters_id,p_parameters_digest,v_expires,v_created) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_approval_expires:=least(v_expires,v_created+make_interval(secs=>(v_rule->>'pendingExpirySeconds')::integer));
 IF v_rule->'eligibleReviewerPrincipalIds'<>'null'::jsonb THEN
  v_list:=ARRAY(SELECT e FROM jsonb_array_elements_text(v_rule->'eligibleReviewerPrincipalIds') WITH ORDINALITY q(e,o) ORDER BY o);
 END IF;
 -- (h) the writes. CHECKs and triggers enforce the same rules again; a refusal
 -- there is invalid and persists nothing.
 BEGIN
  INSERT INTO morrow_work.proposal_parameters(organization_id,workspace_id,id,canonical,digest,created_at)
  VALUES (p.organization_id,p.workspace_id,v_parameters_id,p_parameters_canonical,p_parameters_digest,v_created);
  INSERT INTO morrow_work.proposals(organization_id,workspace_id,id,revision,family_root_id,derived_from_id,derived_from_digest,selected_target_indexes,
   task_id,capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,proposer_principal_id,proposer_membership_id,
   requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,review_policy_digest,
   parameters_id,parameters_digest,canonical,digest,scope_canonical,scope_digest,expires_at,created_at)
  VALUES (p.organization_id,p.workspace_id,v_id,1,v_id,NULL,NULL,NULL,p_task_id,v_capability,v_risk,cap.irreversible,d->>'partialApproval',v_targets,
   (d->>'maximumCredits')::numeric,p.principal_id,p.membership_id,v_requester_p,v_requester_m,v_beneficiaries,'review-policy',pol.revision,pol.digest,
   v_parameters_id,p_parameters_digest,p_proposal_canonical,p_proposal_digest,p_scope_canonical,morrow_work.sha256_text(p_scope_canonical),v_expires,v_created);
  INSERT INTO morrow_work.approvals(organization_id,workspace_id,id,revision,proposal_id,proposal_digest,family_root_id,status,required_approvals,
   self_approval,pending_expiry_seconds,approved_validity_seconds,cool_down_seconds,quiet_period_seconds,eligible_reviewer_principal_ids,
   counted_reviewer_principal_ids,scope_digest,review_policy_revision,policy_revision,effective_at,expires_at,invalidation_reason,created_at,updated_at)
  VALUES (p.organization_id,p.workspace_id,p_approval_id,1,v_id,p_proposal_digest,v_id,'pending',(v_rule->>'requiredApprovals')::integer,
   v_rule->>'selfApproval',(v_rule->>'pendingExpirySeconds')::integer,(v_rule->>'approvedValiditySeconds')::integer,
   (pol.rules#>>'{soloOwner,coolDownSeconds}')::integer,(pol.rules#>>'{soloOwner,quietPeriodSeconds}')::integer,v_list,NULL,
   morrow_work.sha256_text(p_scope_canonical),pol.revision,v_org_revision,NULL,v_approval_expires,NULL,v_created,v_created);
 EXCEPTION WHEN check_violation OR raise_exception OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'proposal.submitted','proposal',v_id,1,p_task_id,
  jsonb_build_object('approvalId',p_approval_id,'risk',v_risk,'targetCount',v_targets),p_correlation_id,v_now);
 v_result:=jsonb_build_object('proposalId',v_id,'proposalDigest',p_proposal_digest,'approvalId',p_approval_id,'approvalRevision',1,
  'approvalDigest',morrow_work.approval_ref_digest(p.organization_id,p.workspace_id,p_approval_id,1,p_proposal_digest,morrow_work.sha256_text(p_scope_canonical),
   'pending',NULL,v_approval_expires),'status','pending','effectiveAt',NULL,'expiresAt',morrow_work.utc_text(v_approval_expires));
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'proposal.submit',v_id,1,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- Decide (§5): ADR-0011 under lock, after the Worker's kernel and fold. Order:
-- target and revision, digest, a claim in the family (consumed: FAMILY_CONFLICT),
-- projection, family, reviewer list and conflict set,
-- solo facts and phrase digest, duplicate reviewer, cap, counted reviewers, quorum.
-- Every non-applied outcome is returned for rollback; nothing is persisted.
CREATE FUNCTION morrow_work.cmd_approval_decide(p_command_id text,p_request_digest text,p_correlation_id text,p_proposal_id text,p_expected_revision text,
 p_decision text,p_selected text,p_expected_decision_digest text,p_derived_canonical text,p_derived_digest text,p_derived_scope_canonical text,
 p_phrase_digest text,p_comment text,p_counted text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; root morrow_work.proposals%ROWTYPE; root_approval morrow_work.approvals%ROWTYPE; target morrow_work.approvals%ROWTYPE;
 target_proposal morrow_work.proposals%ROWTYPE; m record; f record; v_selected integer[]; v_counted jsonb; v_now timestamptz; v_derived_id text;
 v_new boolean:=false; v_current bigint; v_code text; v_projection record; v_solo boolean:=false; v_solo_decision record; v_conflicted boolean;
 v_count integer; v_counted_ids text[]; v_status text; v_effective timestamptz; v_expires timestamptz; v_org_revision bigint; v_revision bigint;
 v_result jsonb; v_reason text; v_has_claim boolean; v_e jsonb; v_prev integer:=-1; v_i integer;
BEGIN
 -- (a) closed scalars and bounded JSON before any cast.
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_proposal_id IS NULL OR p_proposal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_expected_revision IS NULL OR p_expected_revision !~ '^[1-9][0-9]{0,15}$'
  OR p_decision IS NULL OR p_decision NOT IN ('approve','reject','cancel_before_effective')
  OR p_expected_decision_digest IS NULL OR p_expected_decision_digest !~ '^[a-f0-9]{64}$'
  OR (p_selected IS NOT NULL AND (octet_length(p_selected)>8192 OR NOT pg_input_is_valid(p_selected,'jsonb')))
  OR (p_derived_canonical IS NULL)<>(p_derived_digest IS NULL) OR (p_derived_canonical IS NULL)<>(p_derived_scope_canonical IS NULL)
  OR (p_derived_canonical IS NOT NULL AND (octet_length(p_derived_canonical)>131072 OR NOT pg_input_is_valid(p_derived_canonical,'jsonb')
   OR p_derived_digest !~ '^[a-f0-9]{64}$' OR octet_length(p_derived_scope_canonical)>16384 OR NOT pg_input_is_valid(p_derived_scope_canonical,'jsonb')))
  OR (p_phrase_digest IS NOT NULL AND p_phrase_digest !~ '^[a-f0-9]{64}$')
  OR (p_comment IS NOT NULL AND char_length(p_comment) NOT BETWEEN 1 AND 2048)
  OR p_counted IS NULL OR octet_length(p_counted)>4096 OR NOT pg_input_is_valid(p_counted,'jsonb') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF p_expected_revision::numeric>9007199254740991 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 IF p_selected IS NOT NULL THEN
  IF jsonb_typeof(p_selected::jsonb)<>'array' THEN RETURN QUERY SELECT 'SELECTION_INVALID'::text,NULL::text; RETURN; END IF;
  IF jsonb_array_length(p_selected::jsonb) NOT BETWEEN 1 AND 999 THEN RETURN QUERY SELECT 'SELECTION_INVALID'::text,NULL::text; RETURN; END IF;
  FOR v_e IN SELECT x FROM jsonb_array_elements(p_selected::jsonb) x LOOP
   IF NOT morrow_work.json_int(v_e,0,999) THEN RETURN QUERY SELECT 'SELECTION_INVALID'::text,NULL::text; RETURN; END IF;
   v_i:=(v_e::text)::integer;
   IF v_i<=v_prev THEN RETURN QUERY SELECT 'SELECTION_INVALID'::text,NULL::text; RETURN; END IF;
   v_prev:=v_i;
  END LOOP;
  v_selected:=ARRAY(SELECT (x::text)::integer FROM jsonb_array_elements(p_selected::jsonb) WITH ORDINALITY q(x,o) ORDER BY o);
 END IF;
 IF p_decision='cancel_before_effective' AND (v_selected IS NOT NULL OR p_phrase_digest IS NOT NULL OR p_derived_canonical IS NOT NULL) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 -- A rejection is whole: it rejects the proposal as reviewed.
 IF p_decision='reject' AND v_selected IS NOT NULL THEN RETURN QUERY SELECT 'SELECTION_INVALID'::text,NULL::text; RETURN; END IF;
 v_counted:=p_counted::jsonb;
 -- (b) the P06.T01a prelude.
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT c.policy_revision INTO v_org_revision FROM morrow_work.current_tenant() c;
 -- (c) the root proposal; decisions are made through it (a selection names a part).
 SELECT x.* INTO root FROM morrow_work.proposals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_proposal_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF root.derived_from_id IS NOT NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 -- (d) lock the family: the root approval, then every other member in id order.
 SELECT x.* INTO root_approval FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
  AND x.proposal_id=root.id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 PERFORM 1 FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
  AND x.family_root_id=root.id AND x.id<>root_approval.id ORDER BY x.id FOR UPDATE;
 v_now:=morrow_work.db_now();
 v_has_claim:=EXISTS(SELECT 1 FROM morrow_work.approval_claims x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
  AND x.family_root_id=root.id);
 SELECT max(x.revision) INTO v_current FROM morrow_work.review_policies x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
  AND x.id='review-policy';
 SELECT * INTO f FROM morrow_identity.work_ownership_facts(p.organization_id);
 -- (e) the target approval: the approved member (cancel), the root, or the
 -- derivation a selection names (existing, or new from the supplied document).
 IF p_decision='cancel_before_effective' THEN
  SELECT x.* INTO target FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.family_root_id=root.id AND x.status='approved';
  IF NOT FOUND THEN RETURN QUERY SELECT 'CANCEL_NOT_ALLOWED'::text,NULL::text; RETURN; END IF;
 ELSIF v_selected IS NULL THEN
  target:=root_approval;
 ELSE
  IF root.partial_approval<>'allowed' THEN RETURN QUERY SELECT 'PARTIAL_APPROVAL_NOT_ALLOWED'::text,NULL::text; RETURN; END IF;
  IF cardinality(v_selected)>=root.target_count OR v_selected[cardinality(v_selected)]>=root.target_count THEN
   RETURN QUERY SELECT 'SELECTION_INVALID'::text,NULL::text; RETURN;
  END IF;
  v_derived_id:=morrow_work.derived_proposal_id(p.organization_id,p.workspace_id,root.id,root.digest,v_selected);
  SELECT x.* INTO target FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.proposal_id=v_derived_id;
  v_new:=NOT FOUND;
 END IF;
 -- (f) revision: the target approval's, or the root approval's for a new derivation.
 IF (CASE WHEN v_new THEN root_approval.revision ELSE target.revision END)::text<>p_expected_revision THEN
  RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN;
 END IF;
 -- (g) the decided digest.
 IF v_new THEN
  IF p_derived_canonical IS NULL OR p_derived_digest<>p_expected_decision_digest OR morrow_work.sha256_text(p_derived_canonical)<>p_derived_digest THEN
   RETURN QUERY SELECT 'DIGEST_MISMATCH'::text,NULL::text; RETURN;
  END IF;
 ELSE
  IF p_derived_canonical IS NOT NULL OR target.proposal_digest<>p_expected_decision_digest THEN
   RETURN QUERY SELECT 'DIGEST_MISMATCH'::text,NULL::text; RETURN;
  END IF;
 END IF;
 -- (h) a claimed family is consumed and closed (the first projection condition), then
 -- the projections at database time: the target (a cancel's approved member) and the root.
 IF v_has_claim THEN RETURN QUERY SELECT 'FAMILY_CONFLICT'::text,NULL::text; RETURN; END IF;
 IF NOT v_new THEN
  SELECT x.reviewer_principal_id::text AS reviewer,x.decided_at INTO v_solo_decision FROM morrow_work.approval_decisions x
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.approval_id=target.id AND x.solo_phrase_digest IS NOT NULL;
  SELECT * INTO v_projection FROM morrow_work.approval_projection(target.status,target.expires_at,target.review_policy_revision,v_current,false,
   v_solo_decision.reviewer,v_solo_decision.decided_at,target.quiet_period_seconds,f.owner_principal_id,f.active_human_membership_count,
   f.last_membership_change_at,v_now);
  IF v_projection.code IS NOT NULL THEN RETURN QUERY SELECT v_projection.code,NULL::text; RETURN; END IF;
 END IF;
 IF p_decision<>'cancel_before_effective' THEN
  SELECT * INTO v_projection FROM morrow_work.approval_projection(root_approval.status,root_approval.expires_at,root_approval.review_policy_revision,
   v_current,false,NULL,NULL,root_approval.quiet_period_seconds,f.owner_principal_id,f.active_human_membership_count,f.last_membership_change_at,v_now);
  IF v_projection.code IS NOT NULL THEN RETURN QUERY SELECT v_projection.code,NULL::text; RETURN; END IF;
 END IF;
 -- (i) family: cancel is only the confirming solo reviewer before effectiveAt;
 -- otherwise, in the review library's order, an approval while a member is
 -- approved is FAMILY_CONFLICT, and a root or target no longer pending is
 -- APPROVAL_NOT_PENDING.
 IF p_decision='cancel_before_effective' THEN
  IF v_solo_decision.reviewer IS DISTINCT FROM p.principal_id OR NOT EXISTS(SELECT 1 FROM morrow_work.approval_decisions x
    WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.approval_id=target.id AND x.solo_phrase_digest IS NOT NULL
    AND x.reviewer_principal_id=p.principal_id AND x.reviewer_membership_id=p.membership_id) OR v_now>=target.effective_at THEN
   RETURN QUERY SELECT 'CANCEL_NOT_ALLOWED'::text,NULL::text; RETURN;
  END IF;
 ELSE
  IF p_decision='approve' AND EXISTS(SELECT 1 FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
    AND x.family_root_id=root.id AND x.status='approved') THEN
   RETURN QUERY SELECT 'FAMILY_CONFLICT'::text,NULL::text; RETURN;
  END IF;
  IF root_approval.status<>'pending' OR (NOT v_new AND target.status<>'pending') THEN
   RETURN QUERY SELECT 'APPROVAL_NOT_PENDING'::text,NULL::text; RETURN;
  END IF;
  -- (j) the snapshot's reviewer list, then the conflict set, solo facts and phrase.
  IF (CASE WHEN v_new THEN root_approval.eligible_reviewer_principal_ids ELSE target.eligible_reviewer_principal_ids END) IS NOT NULL
   AND NOT (p.principal_id=ANY(CASE WHEN v_new THEN root_approval.eligible_reviewer_principal_ids ELSE target.eligible_reviewer_principal_ids END)) THEN
   RETURN QUERY SELECT 'REVIEWER_DENIED'::text,NULL::text; RETURN;
  END IF;
  v_conflicted:=morrow_work.conflicted(root.proposer_principal_id,root.requester_principal_id,root.beneficiary_principal_ids,p.principal_id);
  IF p_decision='approve' AND v_conflicted THEN
   IF root_approval.self_approval='denied' THEN RETURN QUERY SELECT 'SELF_APPROVAL_DENIED'::text,NULL::text; RETURN; END IF;
   IF root_approval.self_approval='solo_owner_typed_confirmation' THEN
    IF f.owner_principal_id IS DISTINCT FROM p.principal_id OR f.owner_membership_id IS DISTINCT FROM p.membership_id
     OR f.active_human_membership_count IS DISTINCT FROM 1
     OR (f.last_membership_change_at IS NOT NULL AND v_now<f.last_membership_change_at+make_interval(secs=>root_approval.quiet_period_seconds)) THEN
     RETURN QUERY SELECT 'SELF_APPROVAL_DENIED'::text,NULL::text; RETURN;
    END IF;
    v_solo:=true;
   END IF;
  END IF;
  IF v_solo THEN
   IF p_phrase_digest IS DISTINCT FROM morrow_work.sha256_text(morrow_work.solo_phrase(
     (CASE WHEN v_new THEN p_derived_canonical ELSE (SELECT x.canonical FROM morrow_work.proposals x WHERE x.organization_id=p.organization_id
      AND x.workspace_id=p.workspace_id AND x.id=target.proposal_id) END)::jsonb)) THEN
    RETURN QUERY SELECT 'CONFIRMATION_MISMATCH'::text,NULL::text; RETURN;
   END IF;
  ELSIF p_phrase_digest IS NOT NULL THEN
   RETURN QUERY SELECT 'CONFIRMATION_MISMATCH'::text,NULL::text; RETURN;
  END IF;
  -- (k) one decision per reviewer per approval; at most five decisions. A new
  -- derivation (under the root lock): at most 25 derived proposals per family, and
  -- one that stays pending counts against the 1,000 live pending approvals.
  IF NOT v_new THEN
   IF EXISTS(SELECT 1 FROM morrow_work.approval_decisions x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
     AND x.approval_id=target.id AND x.reviewer_principal_id=p.principal_id) THEN
    RETURN QUERY SELECT 'DUPLICATE_REVIEWER'::text,NULL::text; RETURN;
   END IF;
   SELECT count(*) INTO v_count FROM morrow_work.approval_decisions x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
    AND x.approval_id=target.id;
   IF v_count>=5 THEN RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN; END IF;
  ELSE
   IF (SELECT count(*) FROM morrow_work.proposals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
     AND x.family_root_id=root.id AND x.id<>root.id)>=25 THEN
    RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
   END IF;
   IF NOT v_solo AND root_approval.required_approvals>1 AND (SELECT count(*) FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id
     AND x.workspace_id=p.workspace_id AND x.status='pending' AND x.expires_at>v_now AND x.review_policy_revision=v_current)>=1000 THEN
    RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
   END IF;
   v_count:=0;
  END IF;
  -- (l) the earlier approvers the Worker still counts are current under lock.
  IF p_decision='approve' AND NOT v_solo THEN
   IF v_new AND jsonb_array_length(COALESCE(v_counted->'reviewers','[]'::jsonb))<>0 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
   IF NOT v_new THEN
    v_code:=morrow_work.counted_current(p.organization_id,p.workspace_id,target.id,root.capability_id,v_counted,NULL,v_now);
    IF v_code<>'current' THEN RETURN QUERY SELECT v_code,NULL::text; RETURN; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_counted->'reviewers') x WHERE x->>'principalId'=p.principal_id) THEN
     RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
    END IF;
   END IF;
  END IF;
 END IF;
 -- (m) the writes. A new derivation first: its proposal (proposal_bind and the
 -- document CHECK prove it is the root's exact selection) and pending approval.
 BEGIN
  IF v_new THEN
   INSERT INTO morrow_work.proposals(organization_id,workspace_id,id,revision,family_root_id,derived_from_id,derived_from_digest,selected_target_indexes,
    task_id,capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,proposer_principal_id,proposer_membership_id,
    requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,review_policy_digest,
    parameters_id,parameters_digest,canonical,digest,scope_canonical,scope_digest,expires_at,created_at)
   SELECT root.organization_id,root.workspace_id,v_derived_id,1,root.id,root.id,root.digest,v_selected,root.task_id,root.capability_id,root.risk,
    root.irreversible,'all_or_nothing',cardinality(v_selected),
    CASE WHEN (p_derived_canonical::jsonb->>'maximumCredits') ~ '^(0|[1-9][0-9]{0,17})$' THEN (p_derived_canonical::jsonb->>'maximumCredits')::numeric END,
    root.proposer_principal_id,root.proposer_membership_id,root.requester_principal_id,root.requester_membership_id,root.beneficiary_principal_ids,
    root.review_policy_id,root.review_policy_revision,root.review_policy_digest,root.parameters_id,root.parameters_digest,p_derived_canonical,
    p_derived_digest,p_derived_scope_canonical,morrow_work.sha256_text(p_derived_scope_canonical),root.expires_at,root.created_at;
   INSERT INTO morrow_work.approvals(organization_id,workspace_id,id,revision,proposal_id,proposal_digest,family_root_id,status,required_approvals,
    self_approval,pending_expiry_seconds,approved_validity_seconds,cool_down_seconds,quiet_period_seconds,eligible_reviewer_principal_ids,
    counted_reviewer_principal_ids,scope_digest,review_policy_revision,policy_revision,effective_at,expires_at,invalidation_reason,created_at,updated_at)
   VALUES (p.organization_id,p.workspace_id,'approval_'||v_derived_id,1,v_derived_id,p_derived_digest,root.id,'pending',root_approval.required_approvals,
    root_approval.self_approval,root_approval.pending_expiry_seconds,root_approval.approved_validity_seconds,root_approval.cool_down_seconds,
    root_approval.quiet_period_seconds,root_approval.eligible_reviewer_principal_ids,NULL,morrow_work.sha256_text(p_derived_scope_canonical),
    root.review_policy_revision,v_org_revision,NULL,root_approval.expires_at,NULL,root_approval.created_at,v_now)
   RETURNING * INTO target;
   PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'proposal.derived','proposal',v_derived_id,1,root.task_id,
    jsonb_build_object('parentId',root.id),p_correlation_id,v_now);
  END IF;
  SELECT x.* INTO target_proposal FROM morrow_work.proposals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.id=target.proposal_id;
  v_revision:=target.revision+1;
  IF p_decision='cancel_before_effective' THEN
   UPDATE morrow_work.approvals x SET status='cancelled',revision=v_revision,updated_at=greatest(v_now,x.updated_at),policy_revision=v_org_revision
    WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=target.id;
   PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'approval.status_changed','approval',target.id,
    v_revision,root.task_id,jsonb_build_object('from','approved','to','cancelled','reason','cancelled_before_effective'),p_correlation_id,v_now);
   v_status:='cancelled'; v_effective:=target.effective_at; v_expires:=target.expires_at;
  ELSE
   INSERT INTO morrow_work.approval_decisions(organization_id,workspace_id,approval_id,sequence,reviewer_principal_id,reviewer_membership_id,decision,
    decided_digest,decided_at,command_id,request_digest,comment,solo_phrase_digest,solo_cool_down_seconds)
   VALUES (p.organization_id,p.workspace_id,target.id,v_count+1,p.principal_id,p.membership_id,p_decision,target.proposal_digest,v_now,p_command_id,
    p_request_digest,p_comment,CASE WHEN v_solo THEN p_phrase_digest END,CASE WHEN v_solo THEN target.cool_down_seconds END);
   v_effective:=NULL; v_expires:=target.expires_at; v_counted_ids:=NULL;
   IF p_decision='reject' THEN
    v_status:='rejected';
   ELSIF v_solo THEN
    v_status:='approved'; v_counted_ids:=ARRAY[p.principal_id::text];
    v_effective:=v_now+make_interval(secs=>target.cool_down_seconds);
   ELSE
    v_counted_ids:=ARRAY(SELECT x->>'principalId' FROM jsonb_array_elements(COALESCE(v_counted->'reviewers','[]'::jsonb)) WITH ORDINALITY q(x,o) ORDER BY o)
     ||ARRAY[p.principal_id::text];
    IF cardinality(v_counted_ids)>=target.required_approvals THEN v_status:='approved'; v_effective:=v_now;
    ELSE v_status:='pending'; v_counted_ids:=NULL; END IF;
   END IF;
   IF v_status='approved' THEN
    v_expires:=least(target_proposal.expires_at,v_effective+make_interval(secs=>target.approved_validity_seconds));
   END IF;
   UPDATE morrow_work.approvals x SET status=v_status,revision=v_revision,updated_at=greatest(v_now,x.updated_at),policy_revision=v_org_revision,
    effective_at=v_effective,counted_reviewer_principal_ids=v_counted_ids,expires_at=v_expires
    WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=target.id;
   PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'approval.decided','approval',target.id,
    v_revision,root.task_id,jsonb_build_object('decision',p_decision,'status',v_status),p_correlation_id,v_now);
   IF v_status<>'pending' THEN
    PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'approval.status_changed','approval',target.id,
     v_revision,root.task_id,jsonb_build_object('from','pending','to',v_status,'reason',
      CASE WHEN v_status='rejected' THEN 'rejected' WHEN v_solo THEN 'solo_owner_confirmed' ELSE 'quorum_met' END),p_correlation_id,v_now);
    -- An approval supersedes every other pending member; rejecting the root closes the family.
    v_reason:=CASE WHEN v_status='approved' THEN 'superseded_by_partial_approval' ELSE 'family_closed' END;
    FOR m IN SELECT x.id::text AS id,x.revision::bigint AS revision FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id
      AND x.workspace_id=p.workspace_id AND x.family_root_id=root.id AND x.id<>target.id AND x.status='pending' ORDER BY x.id LOOP
     UPDATE morrow_work.approvals x SET status='invalidated',revision=m.revision+1,updated_at=greatest(v_now,x.updated_at),policy_revision=v_org_revision,
      invalidation_reason=v_reason
      WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=m.id;
     PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'approval.status_changed','approval',m.id,
      m.revision+1,root.task_id,jsonb_build_object('from','pending','to','invalidated','reason',v_reason),p_correlation_id,v_now);
    END LOOP;
   END IF;
  END IF;
 EXCEPTION WHEN check_violation OR raise_exception OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 v_result:=jsonb_build_object('proposalId',target.proposal_id,'proposalDigest',target.proposal_digest,'approvalId',target.id,'approvalRevision',v_revision,
  'approvalDigest',morrow_work.approval_ref_digest(p.organization_id,p.workspace_id,target.id,v_revision,target.proposal_digest,target.scope_digest,
   v_status,v_effective,v_expires),'status',v_status,'effectiveAt',morrow_work.utc_text(v_effective),'expiresAt',morrow_work.utc_text(v_expires));
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'approval.decide',target.id,v_revision,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- Withdraw (§5): the v1 pending→cancelled owner row, by the proposer only (the
-- Worker requires its proposer verb); a withdrawn root closes its pending derivations.
CREATE FUNCTION morrow_work.cmd_approval_withdraw(p_command_id text,p_request_digest text,p_correlation_id text,p_proposal_id text,p_expected_revision text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; root morrow_work.proposals%ROWTYPE; a morrow_work.approvals%ROWTYPE; m record; f record; v_now timestamptz; v_current bigint;
 v_projection record; v_org_revision bigint; v_revision bigint; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_proposal_id IS NULL OR p_proposal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_expected_revision IS NULL OR p_expected_revision !~ '^[1-9][0-9]{0,15}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF p_expected_revision::numeric>9007199254740991 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT c.policy_revision INTO v_org_revision FROM morrow_work.current_tenant() c;
 SELECT x.* INTO root FROM morrow_work.proposals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_proposal_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF root.derived_from_id IS NOT NULL THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
 IF root.proposer_principal_id<>p.principal_id OR root.proposer_membership_id<>p.membership_id THEN
  RETURN QUERY SELECT 'not_proposer'::text,NULL::text; RETURN;
 END IF;
 SELECT x.* INTO a FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.proposal_id=root.id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 PERFORM 1 FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
  AND x.family_root_id=root.id AND x.id<>a.id ORDER BY x.id FOR UPDATE;
 v_now:=morrow_work.db_now();
 IF a.revision::text<>p_expected_revision THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
 -- A claimed family is consumed and closed to every command (the first projection
 -- condition), as in cmd_approval_decide.
 IF EXISTS(SELECT 1 FROM morrow_work.approval_claims x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.family_root_id=root.id) THEN RETURN QUERY SELECT 'FAMILY_CONFLICT'::text,NULL::text; RETURN; END IF;
 SELECT max(x.revision) INTO v_current FROM morrow_work.review_policies x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
  AND x.id='review-policy';
 SELECT * INTO f FROM morrow_identity.work_ownership_facts(p.organization_id);
 SELECT * INTO v_projection FROM morrow_work.approval_projection(a.status,a.expires_at,a.review_policy_revision,v_current,false,
  NULL,NULL,a.quiet_period_seconds,f.owner_principal_id,f.active_human_membership_count,f.last_membership_change_at,v_now);
 IF v_projection.code IS NOT NULL THEN RETURN QUERY SELECT v_projection.code,NULL::text; RETURN; END IF;
 IF a.status<>'pending' THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
 v_revision:=a.revision+1;
 BEGIN
  UPDATE morrow_work.approvals x SET status='cancelled',revision=v_revision,updated_at=greatest(v_now,x.updated_at),policy_revision=v_org_revision
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=a.id;
  PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'approval.status_changed','approval',a.id,v_revision,
   root.task_id,jsonb_build_object('from','pending','to','cancelled','reason','withdrawn'),p_correlation_id,v_now);
  FOR m IN SELECT x.id::text AS id,x.revision::bigint AS revision FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id
    AND x.workspace_id=p.workspace_id AND x.family_root_id=root.id AND x.id<>a.id AND x.status='pending' ORDER BY x.id LOOP
   UPDATE morrow_work.approvals x SET status='invalidated',revision=m.revision+1,updated_at=greatest(v_now,x.updated_at),policy_revision=v_org_revision,
    invalidation_reason='family_closed'
    WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=m.id;
   PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'approval.status_changed','approval',m.id,m.revision+1,
    root.task_id,jsonb_build_object('from','pending','to','invalidated','reason','family_closed'),p_correlation_id,v_now);
  END LOOP;
 EXCEPTION WHEN check_violation OR raise_exception OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 v_result:=jsonb_build_object('proposalId',root.id,'proposalDigest',a.proposal_digest,'approvalId',a.id,'approvalRevision',v_revision,
  'approvalDigest',morrow_work.approval_ref_digest(p.organization_id,p.workspace_id,a.id,v_revision,a.proposal_digest,a.scope_digest,'cancelled',NULL,
   a.expires_at),'status','cancelled','effectiveAt',NULL,'expiresAt',morrow_work.utc_text(a.expires_at));
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'approval.withdraw',a.id,v_revision,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 reads proacl), then the ownership transfer.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p WHERE p.pronamespace='morrow_work'::regnamespace AND p.proname IN (
  'sha256_text','utc_text','utc_parse','json_int','json_id','valid_review_rule','valid_review_rules','effective_rule','solo_phrase',
  'derived_proposal_id','approval_ref_digest','conflicted','approval_projection','policy_document_matches','proposal_document_matches',
  'db_now','command_prelude_exclusive','counted_current','approval_claim','review_context','review_candidates','reviewer_snapshot',
  'begin_approval_command','cmd_proposal_submit','cmd_approval_decide','cmd_approval_withdraw') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',r.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION morrow_work.sha256_text(text),morrow_work.utc_text(timestamptz),morrow_work.utc_parse(text),
 morrow_work.json_int(jsonb,bigint,bigint),morrow_work.json_id(jsonb),morrow_work.valid_review_rule(jsonb,boolean),morrow_work.valid_review_rules(jsonb),
 morrow_work.effective_rule(jsonb,text,boolean),morrow_work.solo_phrase(jsonb),morrow_work.derived_proposal_id(text,text,text,text,integer[]),
 morrow_work.approval_ref_digest(text,text,text,bigint,text,text,text,timestamptz,timestamptz),morrow_work.conflicted(text,text,text[],text),
 morrow_work.approval_projection(text,timestamptz,bigint,bigint,boolean,text,timestamptz,integer,text,integer,timestamptz,timestamptz),
 morrow_work.policy_document_matches(text,text,text,text,bigint,timestamptz,jsonb),
 morrow_work.proposal_document_matches(text,text,text,text,text,bigint,text,text,integer[],text,text,text,boolean,text,integer,numeric,text,text,text,text,
  text[],text,bigint,text,text,text,timestamptz,timestamptz)
 TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_work.review_context(text,text),morrow_work.review_candidates(text,text,text,text),
 morrow_work.reviewer_snapshot(text,text),morrow_work.begin_approval_command(text,text,text),
 morrow_work.cmd_proposal_submit(text,text,text,text,text,text,text,text,text,text,text,text,text),
 morrow_work.cmd_approval_decide(text,text,text,text,text,text,text,text,text,text,text,text,text,text),
 morrow_work.cmd_approval_withdraw(text,text,text,text,text) TO morrow_work_api;
GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;
ALTER FUNCTION morrow_work.db_now() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.command_prelude_exclusive(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.counted_current(text,text,text,text,jsonb,text[],timestamptz) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.approval_claim(text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.review_context(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.review_candidates(text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.reviewer_snapshot(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.begin_approval_command(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_proposal_submit(text,text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_approval_decide(text,text,text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_approval_withdraw(text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;
COMMIT;
