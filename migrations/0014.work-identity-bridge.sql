BEGIN;
-- P06.T01a identity bridge (ADR-0010 item 2). Executes AS morrow_identity_owner.
-- It changes no identity table or grant. It adds four definer functions that only
-- morrow_work_command may execute, plus the schema usage and column REFERENCES the
-- work tables' composite foreign keys need, and it gives the three identity
-- functions that lock an organization FOR UPDATE the organization interlock (see
-- the end of this file). No work role and no identity role are members of each
-- other in either direction.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api') AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication)<>3
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='morrow_api_worker' AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles w,pg_catalog.pg_roles i
   WHERE w.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker')
   AND (i.rolname='morrow_api' OR i.rolname LIKE 'morrow\_identity%')
   AND (pg_catalog.pg_has_role(w.oid,i.oid,'MEMBER') OR pg_catalog.pg_has_role(i.oid,w.oid,'MEMBER')))
 OR to_regprocedure('morrow_identity.session_eligibility(text,text)') IS NULL
 OR to_regprocedure('morrow_identity.revoke_workspace_access(text,text,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.link_workspace_store(text,text,text,text,text,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.admit_browser_family(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)') IS NULL
 OR to_regnamespace('morrow_work') IS NOT NULL
 THEN RAISE EXCEPTION 'WORK_BRIDGE_PREREQUISITES_INVALID'; END IF;
END $$;
GRANT USAGE ON SCHEMA morrow_identity TO morrow_work_owner,morrow_work_command;
-- Composite foreign key targets only. Referential checks run as the referenced
-- table's owner, so no SELECT on identity tables is granted to any work role.
GRANT REFERENCES (organization_id,id) ON morrow_identity.workspaces TO morrow_work_owner;
GRANT REFERENCES (organization_id,id,principal_id) ON morrow_identity.memberships TO morrow_work_owner;
GRANT REFERENCES (workspace_id,membership_id) ON morrow_identity.workspace_memberships TO morrow_work_owner;

-- The one resolver of a work request's tenant and actor. LANGUAGE sql BEGIN ATOMIC
-- records the dependency on session_eligibility, so a later migration cannot drop
-- or re-type it without replacing this bridge in the same migration (AC24).
-- Every policy evaluation calls it, and PostgreSQL 17 plans a SQL function body on
-- each call, so the collapse limits keep the written join order (each branch starts
-- from its unique digest index) and make that planning cheap. They change plans,
-- never results.
CREATE FUNCTION morrow_identity.work_session_context(p_digest text,p_workspace text)
RETURNS TABLE(principal_id text,organization_id text,workspace_id text,membership_id text,policy_revision bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp
SET join_collapse_limit=1 SET from_collapse_limit=1
BEGIN ATOMIC
 SELECT e.principal_id,e.organization_id,e.workspace_id,e.membership_id,e.policy_revision
 FROM morrow_identity.session_eligibility(p_digest,p_workspace) e
 WHERE p_digest ~ '^[a-f0-9]{64}$' AND p_workspace ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   AND e.workspace_id=p_workspace;
END;
REVOKE ALL ON FUNCTION morrow_identity.work_session_context(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_session_context(text,text) TO morrow_work_command;

-- The resolved actor plus its current grants (at most 1001, ordered by id; the
-- caller denies more than 1000), their digest and the database clock. Unlocked.
CREATE FUNCTION morrow_identity.work_actor_authority(p_digest text,p_workspace text)
RETURNS TABLE(principal_id text,organization_id text,workspace_id text,membership_id text,policy_revision bigint,grants jsonb,grant_count integer,grants_digest text,database_now timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp
BEGIN ATOMIC
 WITH c AS MATERIALIZED (
  SELECT s.principal_id,s.organization_id,s.workspace_id,s.membership_id,s.policy_revision
  FROM morrow_identity.work_session_context(p_digest,p_workspace) s),
 g AS (
  SELECT gr.id::text AS id,gr.payload FROM morrow_identity.grants gr JOIN c
   ON gr.organization_id=c.organization_id AND gr.workspace_id=c.workspace_id
   AND gr.membership_id=c.membership_id AND gr.principal_id=c.principal_id
  ORDER BY gr.id::text COLLATE "C" LIMIT 1001),
 a AS (
  SELECT COALESCE(jsonb_agg(g.payload ORDER BY g.id COLLATE "C"),'[]'::jsonb) AS grants,count(*)::integer AS grant_count FROM g)
 SELECT c.principal_id,c.organization_id,c.workspace_id,c.membership_id,c.policy_revision,
  a.grants,a.grant_count,encode(sha256(convert_to(a.grants::text,'UTF8')),'hex'),clock_timestamp()
 FROM c CROSS JOIN a;
END;
REVOKE ALL ON FUNCTION morrow_identity.work_actor_authority(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_actor_authority(text,text) TO morrow_work_command;

-- Called only from inside a work command function. It takes the organization
-- interlock shared, then the organization row FOR SHARE, and re-resolves:
-- 'ineligible' when the session, membership or actor changed; 'stale' when the
-- policy revision or grants digest changed or a grant expired after the snapshot.
-- The interlock is a heavyweight advisory lock that the revocation, store linking
-- and browser admission take exclusively before their organization FOR UPDATE.
-- PostgreSQL queues a new shared request behind a waiting exclusive one, so
-- overlapping commands cannot starve a revocation (a row FOR SHARE alone would let
-- each new command in past the waiting FOR UPDATE). The row lock stays for owner
-- maintenance writes that take the row FOR UPDATE without the interlock.
CREATE FUNCTION morrow_identity.work_lock_and_recheck(p_digest text,p_workspace text,p_principal text,p_membership text,p_revision text,p_grants_digest text,p_evaluated_at_us text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
 a record; v_org text; v_evaluated timestamptz; v_now timestamptz; v_expired boolean;
BEGIN
 IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
  OR p_workspace IS NULL OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_principal IS NULL OR p_principal !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_membership IS NULL OR p_membership !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_revision IS NULL OR p_revision !~ '^[1-9][0-9]{0,15}$'
  OR p_grants_digest IS NULL OR p_grants_digest !~ '^[a-f0-9]{64}$'
  OR p_evaluated_at_us IS NULL OR p_evaluated_at_us !~ '^[1-9][0-9]{0,17}$' THEN
  RETURN 'ineligible';
 END IF;
 SELECT w.organization_id::text INTO v_org FROM morrow_identity.workspaces w WHERE w.id=p_workspace;
 IF NOT FOUND THEN RETURN 'ineligible'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',v_org)::text,0));
 PERFORM 1 FROM morrow_identity.organizations o WHERE o.id=v_org FOR SHARE;
 IF NOT FOUND THEN RETURN 'ineligible'; END IF;
 -- A new statement after the lock: READ COMMITTED sees any revocation that
 -- committed while this transaction waited.
 SELECT * INTO a FROM morrow_identity.work_actor_authority(p_digest,p_workspace);
 IF NOT FOUND OR a.organization_id<>v_org OR a.principal_id<>p_principal OR a.membership_id<>p_membership THEN
  RETURN 'ineligible';
 END IF;
 IF a.policy_revision::text<>p_revision OR a.grants_digest<>p_grants_digest THEN RETURN 'stale'; END IF;
 v_evaluated:=timestamptz 'epoch'+(p_evaluated_at_us||' microseconds')::interval;
 v_now:=clock_timestamp();
 -- A snapshot from the future would narrow the expiry window: refuse it.
 IF v_evaluated>v_now THEN RETURN 'stale'; END IF;
 BEGIN
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(a.grants) g
   WHERE g->'expiresAt'<>'null'::jsonb
     AND (g->>'expiresAt')::timestamptz>v_evaluated AND (g->>'expiresAt')::timestamptz<=v_now)
  INTO v_expired;
 EXCEPTION WHEN OTHERS THEN RETURN 'stale';
 END;
 IF v_expired IS NOT FALSE THEN RETURN 'stale'; END IF;
 RETURN 'current';
END $$;
REVOKE ALL ON FUNCTION morrow_identity.work_lock_and_recheck(text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_lock_and_recheck(text,text,text,text,text,text,text) TO morrow_work_command;

-- Eligibility of an assignee or respondent (ADR-0010 item 4): an active human with
-- active organization and workspace memberships, and that member's current grants
-- (at most 1001). Any other principal returns no row. The grants are evaluated by
-- the policy kernel in the Worker and are never returned to a client.
CREATE FUNCTION morrow_identity.work_member_authority(p_org text,p_ws text,p_principal text)
RETURNS TABLE(membership_id text,grants jsonb,grant_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp
SET join_collapse_limit=1 SET from_collapse_limit=1
BEGIN ATOMIC
 WITH m AS MATERIALIZED (
  SELECT mem.id::text AS membership_id
  FROM morrow_identity.principals p
  JOIN morrow_identity.memberships mem ON mem.principal_id=p.id AND mem.organization_id=p_org AND mem.active
  JOIN morrow_identity.organizations o ON o.id=mem.organization_id AND o.active
  JOIN morrow_identity.workspaces w ON w.organization_id=o.id AND w.id=p_ws AND w.active
  JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=o.id AND wm.workspace_id=w.id AND wm.membership_id=mem.id AND wm.active
  WHERE p.id=p_principal AND p.active AND p.kind='human'),
 g AS (
  SELECT gr.id::text AS id,gr.payload FROM morrow_identity.grants gr JOIN m
   ON gr.organization_id=p_org AND gr.workspace_id=p_ws AND gr.membership_id=m.membership_id AND gr.principal_id=p_principal
  ORDER BY gr.id::text COLLATE "C" LIMIT 1001),
 a AS (
  SELECT COALESCE(jsonb_agg(g.payload ORDER BY g.id COLLATE "C"),'[]'::jsonb) AS grants,count(*)::integer AS grant_count FROM g)
 SELECT m.membership_id,a.grants,a.grant_count FROM m CROSS JOIN a;
END;
REVOKE ALL ON FUNCTION morrow_identity.work_member_authority(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_member_authority(text,text,text) TO morrow_work_command;

-- The organization interlock (P06.T01a). Each function below is its 0008
-- definition unchanged except for one statement: the exclusive interlock, taken
-- before the organization FOR UPDATE, on the key work_lock_and_recheck takes
-- shared. Ownership, ACLs and every other rule are unchanged (CREATE OR REPLACE
-- keeps them). Any later identity function that locks an organization FOR UPDATE
-- takes the same interlock first.
CREATE OR REPLACE FUNCTION morrow_identity.revoke_workspace_access(
  p_receipt_id text,p_command_id text,p_request_digest text,p_session_digest text,
  p_organization_id text,p_workspace_id text,p_target_membership_id text,p_expected_revision text)
RETURNS TABLE (outcome text,revocation_id text,policy_revision text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
  receipt morrow_identity.workspace_revocation_receipts%ROWTYPE;
  previous morrow_identity.workspace_revocation_results%ROWTYPE;
  org morrow_identity.organizations%ROWTYPE;
  actor_ok boolean; target_ok boolean; grant_ok boolean;
  now_at timestamptz; grant_start timestamptz; grant_end timestamptz;
  reason_code text; result_id text; revoke_id text; result_outcome text;
BEGIN
  -- Validate bounded scalar inputs before private lookups. This function accepts
  -- no caller actor/grant/approval object and never issues any authority.
  IF p_receipt_id IS NULL OR p_command_id IS NULL OR p_request_digest IS NULL OR p_session_digest IS NULL
    OR p_organization_id IS NULL OR p_workspace_id IS NULL OR p_target_membership_id IS NULL OR p_expected_revision IS NULL
    OR p_receipt_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_command_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_organization_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_workspace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_target_membership_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_request_digest !~ '^[a-f0-9]{64}$' OR p_session_digest !~ '^[a-f0-9]{64}$'
    OR p_expected_revision !~ '^[1-9][0-9]{0,15}$' THEN
    RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  IF p_expected_revision::numeric > 9007199254740991 THEN
    RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  -- All lifecycle mutations serialize on the organization before any dependent
  -- lock. Explicit row locks also protect against maintenance writes which have
  -- not yet adopted the organization serialization protocol.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',p_organization_id)::text,0));
  SELECT * INTO org FROM morrow_identity.organizations WHERE id::text=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
  SELECT * INTO receipt FROM morrow_identity.workspace_revocation_receipts
    WHERE id::text=p_receipt_id AND organization_id::text=p_organization_id FOR UPDATE;
  IF NOT FOUND OR receipt.workspace_id::text<>p_workspace_id
    OR receipt.target_membership_id::text<>p_target_membership_id
    OR receipt.actor_session_digest<>p_session_digest
    OR receipt.expected_policy_revision::text<>p_expected_revision THEN
    RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  IF receipt.command_id::text<>p_command_id OR receipt.request_digest<>p_request_digest THEN
    RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  PERFORM morrow_identity.lock_session_eligibility(receipt.actor_session_digest,receipt.workspace_id::text,receipt.actor_principal_id::text,receipt.organization_id::text);
  PERFORM 1 FROM morrow_identity.principals WHERE id=receipt.actor_principal_id FOR UPDATE;
  PERFORM 1 FROM morrow_identity.workspaces WHERE id=receipt.workspace_id AND organization_id=receipt.organization_id FOR UPDATE;
  PERFORM 1 FROM morrow_identity.memberships
    WHERE organization_id=receipt.organization_id AND id IN (receipt.actor_membership_id,receipt.target_membership_id)
    ORDER BY id FOR UPDATE;
  PERFORM 1 FROM morrow_identity.workspace_memberships
    WHERE workspace_id=receipt.workspace_id AND membership_id IN (receipt.actor_membership_id,receipt.target_membership_id)
    ORDER BY membership_id FOR UPDATE;
  PERFORM 1 FROM morrow_identity.grants
    WHERE id=receipt.authorizing_grant_id OR
      (organization_id=receipt.organization_id AND workspace_id=receipt.workspace_id AND membership_id=receipt.target_membership_id)
    ORDER BY id FOR UPDATE;
  now_at := clock_timestamp();
  actor_ok := org.active AND EXISTS (
    SELECT 1 FROM morrow_identity.principals p
    JOIN morrow_identity.memberships m ON m.principal_id=p.id AND m.id=receipt.actor_membership_id AND m.organization_id=receipt.organization_id AND m.active
    JOIN morrow_identity.workspace_memberships wm ON wm.membership_id=m.id AND wm.workspace_id=receipt.workspace_id AND wm.organization_id=receipt.organization_id AND wm.active
    JOIN morrow_identity.workspaces w ON w.id=wm.workspace_id AND w.organization_id=receipt.organization_id AND w.active
    JOIN morrow_identity.session_eligibility(receipt.actor_session_digest,receipt.workspace_id::text) s ON s.principal_id=p.id::text AND s.organization_id=receipt.organization_id::text AND s.membership_id=receipt.actor_membership_id::text
    WHERE p.id=receipt.actor_principal_id AND p.active AND p.kind='human');
  target_ok := EXISTS (SELECT 1 FROM morrow_identity.memberships m
    JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=m.organization_id AND wm.membership_id=m.id
    WHERE m.id=receipt.target_membership_id AND m.organization_id=receipt.organization_id AND m.active
      AND wm.workspace_id=receipt.workspace_id AND wm.active);
  grant_ok := EXISTS (SELECT 1 FROM morrow_identity.grants g
    WHERE g.id=receipt.authorizing_grant_id AND g.organization_id=receipt.organization_id AND g.workspace_id=receipt.workspace_id
      AND g.membership_id=receipt.actor_membership_id AND g.principal_id=receipt.actor_principal_id
      AND g.payload=receipt.authorizing_grant_snapshot);
  -- The owner-seeded snapshot has already passed the shared Grant validator and
  -- policy boundary. Check its time window here; do not create a parallel grant
  -- interpreter or accept a caller-provided authorization decision.
  BEGIN
    grant_start := (receipt.authorizing_grant_snapshot->>'validFrom')::timestamptz;
    grant_end := (receipt.authorizing_grant_snapshot->>'expiresAt')::timestamptz;
    grant_ok := grant_ok AND grant_start IS NOT NULL AND isfinite(grant_start) AND grant_start<=now_at
      AND (receipt.authorizing_grant_snapshot->'expiresAt'='null'::jsonb OR (grant_end IS NOT NULL AND isfinite(grant_end) AND grant_end>now_at));
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN grant_ok := false;
  END;
  SELECT * INTO previous FROM morrow_identity.workspace_revocation_results WHERE receipt_id=receipt.id;
  IF FOUND THEN
    -- Receipt expiry/old expected revision do not cause another effect. Current
    -- eligibility is still mandatory to disclose the original private result.
    IF actor_ok AND grant_ok IS TRUE THEN
      RETURN QUERY SELECT previous.outcome,previous.revocation_id::text,previous.policy_revision::text,previous.id::text;
    ELSE RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; END IF;
    RETURN;
  END IF;
  IF receipt.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  reason_code := CASE WHEN NOT actor_ok THEN 'actor_ineligible'
    WHEN receipt.expires_at<=now_at THEN 'receipt_expired'
    WHEN org.policy_revision<>receipt.expected_policy_revision THEN 'policy_conflict'
    WHEN grant_ok IS NOT TRUE THEN 'grant_changed'
    WHEN NOT target_ok THEN 'target_ineligible'
    WHEN org.policy_revision=9007199254740991 THEN 'revision_exhausted'
    ELSE 'applied' END;
  result_id := gen_random_uuid()::text;
  IF reason_code='applied' THEN
    revoke_id := gen_random_uuid()::text;
    UPDATE morrow_identity.workspace_memberships SET active=false
      WHERE organization_id=receipt.organization_id AND workspace_id=receipt.workspace_id AND membership_id=receipt.target_membership_id;
    UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(to_char(now_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      WHERE organization_id=receipt.organization_id AND workspace_id=receipt.workspace_id AND membership_id=receipt.target_membership_id
        AND payload->'revokedAt'='null'::jsonb;
    UPDATE morrow_identity.organizations AS o SET policy_revision=o.policy_revision+1 WHERE o.id=receipt.organization_id RETURNING o.* INTO org;
    result_outcome := 'applied';
  ELSE result_outcome := 'denied'; END IF;
  UPDATE morrow_identity.workspace_revocation_receipts SET consumed_at=now_at WHERE id=receipt.id;
  INSERT INTO morrow_identity.workspace_revocation_results
    (id,receipt_id,organization_id,workspace_id,command_id,actor_principal_id,actor_membership_id,target_membership_id,approval_evidence_id,outcome,reason,revocation_id,policy_revision,recorded_at)
    VALUES (result_id,receipt.id,receipt.organization_id,receipt.workspace_id,receipt.command_id,receipt.actor_principal_id,receipt.actor_membership_id,receipt.target_membership_id,receipt.approval_evidence_id,result_outcome,reason_code,revoke_id,org.policy_revision,now_at);
  RETURN QUERY SELECT result_outcome,revoke_id,org.policy_revision::text,result_id;
END $$;
CREATE OR REPLACE FUNCTION morrow_identity.link_workspace_store(
 p_handoff text,p_command text,p_digest text,p_session text,p_nonce text,p_org text,p_workspace text,p_installation text,p_purpose text,p_policy text,p_ownership text)
RETURNS TABLE(outcome text,link_id text,ownership_revision text,policy_revision text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
 o morrow_identity.organizations%ROWTYPE; c morrow_identity.linking_candidates%ROWTYPE;
 h morrow_identity.linking_handoffs%ROWTYPE; r morrow_identity.linking_reviews%ROWTYPE;
 previous morrow_identity.workspace_link_results%ROWTYPE; association morrow_identity.workspace_store_links%ROWTYPE;
 actor_ok boolean; grant_ok boolean; proof_ok boolean; review_ok boolean; at_time timestamptz;
 grant_start timestamptz; grant_end timestamptz; reason_code text; result_id text; created_link text;
BEGIN
 -- The definer owner is not the calling identity. Neither SET ROLE nor a
 -- subsequently unsafe executor configuration may substitute for this login.
 IF session_user<>'morrow_identity_linking' OR NOT EXISTS(
   SELECT 1 FROM pg_roles x WHERE x.rolname=session_user AND NOT x.rolsuper
     AND NOT x.rolbypassrls AND NOT x.rolcreatedb AND NOT x.rolcreaterole AND NOT x.rolinherit
     AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=x.oid OR m.roleid=x.oid)) THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_handoff IS NULL OR p_command IS NULL OR p_digest IS NULL OR p_session IS NULL OR p_nonce IS NULL OR p_org IS NULL OR p_workspace IS NULL OR p_installation IS NULL OR p_purpose IS NULL OR p_policy IS NULL OR p_ownership IS NULL
   OR p_handoff !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_command !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_installation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_digest !~ '^[a-f0-9]{64}$' OR p_session !~ '^[a-f0-9]{64}$' OR p_nonce !~ '^[a-f0-9]{64}$'
   OR p_purpose NOT IN ('install_first','workspace_first','existing_account','additional_store','cross_host_resume')
   OR p_policy !~ '^[1-9][0-9]{0,15}$' OR p_ownership !~ '^[1-9][0-9]{0,15}$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_policy::numeric>9007199254740991 OR p_ownership::numeric>9007199254740991 THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',p_org)::text,0));
 SELECT * INTO o FROM morrow_identity.organizations WHERE id::text=p_org FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 -- Read the exact private locator only; authority comes from locked records below.
 SELECT * INTO h FROM morrow_identity.linking_handoffs WHERE id::text=p_handoff AND organization_id=o.id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO c FROM morrow_identity.linking_candidates WHERE id=h.candidate_id FOR UPDATE;
 SELECT * INTO h FROM morrow_identity.linking_handoffs WHERE id::text=p_handoff AND organization_id=o.id FOR UPDATE;
 IF h.workspace_id::text<>p_workspace OR h.installation_id::text<>p_installation OR h.session_digest<>p_session OR h.nonce_digest<>p_nonce
   OR h.purpose<>p_purpose OR h.expected_policy_revision::text<>p_policy OR h.expected_ownership_revision::text<>p_ownership THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF h.command_id::text<>p_command OR h.request_digest<>p_digest THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO r FROM morrow_identity.linking_reviews WHERE id=h.review_id FOR UPDATE;
 PERFORM morrow_identity.lock_session_eligibility(h.session_digest,h.workspace_id::text,h.actor_principal_id::text,h.organization_id::text);
 PERFORM 1 FROM morrow_identity.principals WHERE id=h.actor_principal_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.workspaces WHERE id=h.workspace_id AND organization_id=h.organization_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.memberships WHERE id=h.actor_membership_id AND organization_id=h.organization_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.workspace_memberships WHERE workspace_id=h.workspace_id AND membership_id=h.actor_membership_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.grants WHERE id=h.authorizing_grant_id FOR UPDATE;
 SELECT * INTO association FROM morrow_identity.workspace_store_links WHERE candidate_id=c.id FOR UPDATE;
 at_time:=clock_timestamp();
 actor_ok:=o.active AND EXISTS(SELECT 1 FROM morrow_identity.principals p
   JOIN morrow_identity.memberships m ON m.principal_id=p.id AND m.id=h.actor_membership_id AND m.organization_id=o.id AND m.active
   JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=o.id AND wm.workspace_id=h.workspace_id AND wm.membership_id=m.id AND wm.active
   JOIN morrow_identity.workspaces w ON w.id=wm.workspace_id AND w.organization_id=o.id AND w.active
   JOIN morrow_identity.session_eligibility(h.session_digest,h.workspace_id::text) s ON s.principal_id=p.id::text AND s.organization_id=o.id::text AND s.membership_id=h.actor_membership_id::text
   WHERE p.id=h.actor_principal_id AND p.kind='human' AND p.active);
 grant_ok:=EXISTS(SELECT 1 FROM morrow_identity.grants g WHERE g.id=h.authorizing_grant_id AND g.organization_id=o.id AND g.workspace_id=h.workspace_id
   AND g.principal_id=h.actor_principal_id AND g.membership_id=h.actor_membership_id AND g.payload=h.authorizing_grant_snapshot);
 BEGIN
   grant_start:=(h.authorizing_grant_snapshot->>'validFrom')::timestamptz;
   grant_end:=(h.authorizing_grant_snapshot->>'expiresAt')::timestamptz;
   grant_ok:=grant_ok AND grant_start IS NOT NULL AND isfinite(grant_start) AND grant_start<=at_time
     AND(h.authorizing_grant_snapshot->'expiresAt'='null'::jsonb OR(grant_end IS NOT NULL AND isfinite(grant_end) AND grant_end>at_time));
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN grant_ok:=false; END;
 proof_ok:=c.active AND c.installation_id=h.installation_id AND c.generation=h.generation AND c.eligible_principal_id=h.actor_principal_id
   AND c.proof_id=h.proof_id AND c.proof_revision=h.proof_revision AND c.proof_digest=h.proof_digest
   AND c.proof_created_at<=at_time AND c.proof_expires_at>at_time AND c.proof_revoked_at IS NULL;
 review_ok:=r.organization_id=h.organization_id AND r.workspace_id=h.workspace_id AND r.actor_principal_id=h.actor_principal_id
   AND r.actor_membership_id=h.actor_membership_id AND r.session_digest=h.session_digest AND r.nonce_digest=h.nonce_digest AND r.handoff_id=h.id
   AND r.candidate_id=h.candidate_id AND r.installation_id=h.installation_id AND r.generation=h.generation
   AND r.command_id=h.command_id AND r.request_digest=h.request_digest AND r.purpose=h.purpose
   AND r.expected_policy_revision=h.expected_policy_revision AND r.expected_ownership_revision=h.expected_ownership_revision
   AND r.proof_id=h.proof_id AND r.proof_revision=h.proof_revision AND r.proof_digest=h.proof_digest
   AND r.scope_snapshot=h.requested_scope_snapshot AND r.revoked_at IS NULL AND r.created_at<=at_time;
 SELECT * INTO previous FROM morrow_identity.workspace_link_results WHERE handoff_id=h.id;
 IF FOUND THEN
   -- Historical acknowledgement is not a second write. Old handoff/review TTLs
   -- do not extend authority; current human/grant/proof/ownership still must hold.
   IF actor_ok AND grant_ok IS TRUE AND proof_ok IS TRUE AND review_ok IS TRUE
     AND((previous.outcome='applied' AND association.id=previous.link_id AND association.organization_id=h.organization_id
       AND association.workspace_id=h.workspace_id AND association.installation_id=h.installation_id AND association.generation=h.generation
       AND association.ownership_revision=previous.ownership_revision AND c.ownership_revision=previous.ownership_revision)
       OR(previous.outcome='denied' AND association.id IS NULL AND c.ownership_revision=h.expected_ownership_revision)) THEN
     RETURN QUERY SELECT previous.outcome,previous.link_id::text,previous.ownership_revision::text,previous.policy_revision::text,previous.id::text;
   ELSE RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; END IF; RETURN;
 END IF;
 IF h.consumed_at IS NOT NULL THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 reason_code:=CASE WHEN NOT actor_ok THEN 'actor_ineligible' WHEN grant_ok IS NOT TRUE THEN 'grant_changed'
   WHEN h.created_at>at_time OR h.expires_at<=at_time THEN 'handoff_expired'
   WHEN proof_ok IS NOT TRUE THEN 'proof_invalid' WHEN review_ok IS NOT TRUE OR r.expires_at<=at_time THEN 'review_invalid'
   WHEN h.purpose='cross_host_resume' THEN 'purpose_denied' WHEN o.policy_revision<>h.expected_policy_revision THEN 'policy_conflict'
   WHEN association.id IS NOT NULL OR c.ownership_revision<>h.expected_ownership_revision THEN 'ownership_conflict'
   WHEN o.policy_revision=9007199254740991 OR c.ownership_revision=9007199254740991 THEN 'revision_exhausted' ELSE 'applied' END;
 result_id:=gen_random_uuid()::text;
 IF reason_code='applied' THEN
   created_link:=gen_random_uuid()::text;
   UPDATE morrow_identity.linking_candidates SET ownership_revision=linking_candidates.ownership_revision+1 WHERE id=c.id RETURNING * INTO c;
   UPDATE morrow_identity.organizations SET policy_revision=organizations.policy_revision+1 WHERE id=o.id RETURNING * INTO o;
   INSERT INTO morrow_identity.workspace_store_links VALUES(created_link,c.id,h.organization_id,h.workspace_id,h.installation_id,h.generation,c.ownership_revision,h.actor_principal_id,at_time);
 END IF;
 UPDATE morrow_identity.linking_handoffs SET consumed_at=at_time WHERE id=h.id;
 INSERT INTO morrow_identity.workspace_link_results VALUES(result_id,h.id,h.organization_id,h.workspace_id,h.command_id,h.actor_principal_id,c.id,h.review_id,
   CASE WHEN reason_code='applied' THEN 'applied' ELSE 'denied' END,reason_code,created_link,CASE WHEN reason_code='applied' THEN c.ownership_revision ELSE NULL END,o.policy_revision,at_time);
 RETURN QUERY SELECT CASE WHEN reason_code='applied' THEN 'applied' ELSE 'denied' END,created_link,
   CASE WHEN reason_code='applied' THEN c.ownership_revision::text ELSE NULL END,o.policy_revision::text,result_id;
END $$;
CREATE OR REPLACE FUNCTION morrow_identity.admit_browser_family(
 p_command text,p_request_digest text,p_provider text,p_environment text,p_application text,p_client text,p_issuer text,
 p_token_revision text,p_token_digest text,p_subject text,p_provider_session text,p_workspace text,
 p_evidence_issued text,p_evidence_observed text,p_evidence_expires text,p_keyset_digest text,p_observation_digest text,p_secret_digest text,
 p_profile_id text,p_profile_record_revision text,p_mapping_id text,p_mapping_revision text,p_binding_revision text,p_membership_id text,p_policy_revision text,
 p_family_id text,p_generation_id text)
RETURNS TABLE(outcome text,family_id text,generation_id text,provider_binding_id text,expires_at_ms text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
 tuple_values text[]; previous morrow_identity.browser_session_commands%ROWTYPE;
 v morrow_identity.identity_verification_profiles%ROWTYPE; sm morrow_identity.provider_subject_mappings%ROWTYPE;
 b morrow_identity.provider_subject_profile_bindings%ROWTYPE; pb morrow_identity.provider_session_bindings%ROWTYPE;
 person morrow_identity.principals%ROWTYPE; org morrow_identity.organizations%ROWTYPE;
 ws morrow_identity.workspaces%ROWTYPE; member_row morrow_identity.memberships%ROWTYPE; wm morrow_identity.workspace_memberships%ROWTYPE;
 org_key text; reason_code text:='identity_ineligible'; instant timestamptz; expiry timestamptz; audit_key text; provider_key text;
 n numeric; value text; succeeded boolean:=false;
BEGIN
 IF NOT morrow_identity.browser_sessions_role_safe() THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 tuple_values:=ARRAY[p_command,p_provider,p_environment,p_application,p_client,p_issuer,p_token_revision,p_token_digest,p_subject,p_provider_session,p_workspace,p_evidence_issued,p_evidence_observed,p_evidence_expires,p_keyset_digest,p_observation_digest,p_secret_digest,p_profile_id,p_profile_record_revision,p_mapping_id,p_mapping_revision,p_binding_revision,p_membership_id,p_policy_revision,p_family_id,p_generation_id];
 IF array_position(tuple_values,NULL) IS NOT NULL OR p_request_digest IS NULL
   OR p_provider<>'workos' OR p_environment !~ '^environment_[A-Z0-9]{26}$' OR p_application !~ '^app_[A-Z0-9]{26}$'
   OR p_client !~ '^client_[A-Z0-9]{26}$' OR p_issuer<>'https://api.workos.com/user_management/'||p_client
   OR p_subject !~ '^user_[A-Z0-9]{26}$' OR p_provider_session !~ '^session_[A-Z0-9]{26}$'
   OR p_family_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_generation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   OR p_family_id=p_generation_id THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 FOREACH value IN ARRAY ARRAY[p_command,p_workspace,p_profile_id,p_mapping_id,p_membership_id] LOOP
  IF value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 END LOOP;
 FOREACH value IN ARRAY ARRAY[p_request_digest,p_token_digest,p_keyset_digest,p_observation_digest,p_secret_digest] LOOP
  IF value !~ '^[a-f0-9]{64}$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 END LOOP;
 FOREACH value IN ARRAY ARRAY[p_token_revision,p_profile_record_revision,p_mapping_revision,p_binding_revision,p_policy_revision] LOOP
  IF value !~ '^[1-9][0-9]{0,15}$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
  IF value::numeric>9007199254740991 THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 END LOOP;
 FOREACH value IN ARRAY ARRAY[p_evidence_issued,p_evidence_observed,p_evidence_expires] LOOP
  IF value !~ '^(0|[1-9][0-9]{0,15})$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
  IF value::numeric>8640000000000000 THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 END LOOP;
 IF p_evidence_expires::numeric<=p_evidence_observed::numeric
   OR p_evidence_expires::numeric>p_evidence_observed::numeric+5000
   OR p_evidence_issued::numeric>p_evidence_observed::numeric+30000
   OR encode(sha256(convert_to(array_to_json(tuple_values)::text,'UTF8')),'hex')<>p_request_digest THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 -- One global command namespace, before any identity/provider locks. A digest
 -- includes every exact string in the derived tuple, including generated IDs.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('browser-command:'||p_command,0));
 SELECT * INTO previous FROM morrow_identity.browser_session_commands WHERE command_id::text=p_command;
 IF FOUND THEN
  IF previous.request_digest<>p_request_digest OR previous.request_tuple<>to_jsonb(tuple_values) THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  ELSIF previous.outcome='admitted' THEN
   RETURN QUERY SELECT 'replayed'::text,previous.family_id::text,previous.generation_id::text,previous.provider_binding_id::text,floor(extract(epoch FROM previous.expires_at)*1000)::text,previous.audit_id::text;
  ELSE RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; END IF;
  RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM morrow_identity.browser_session_audits WHERE command_id::text=p_command) THEN
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 <<qualification>> BEGIN
  -- Non-authorizing namespace/membership preflight avoids locking a foreign
  -- selector. Every state/revision/time is rechecked below AFTER actual locks.
  SELECT w.organization_id::text INTO org_key
  FROM morrow_identity.workspaces w
  JOIN morrow_identity.organizations o ON o.id=w.organization_id AND o.active
  JOIN morrow_identity.memberships om ON om.organization_id=o.id AND om.id::text=p_membership_id AND om.active
  JOIN morrow_identity.workspace_memberships x ON x.organization_id=o.id AND x.workspace_id=w.id AND x.membership_id=om.id AND x.active
  JOIN morrow_identity.provider_subject_mappings m ON m.id::text=p_mapping_id AND m.principal_id=om.principal_id
    AND m.provider_id=p_provider AND m.environment_id=p_environment AND m.subject_id=p_subject AND m.state='active'
  JOIN morrow_identity.principals p ON p.id=m.principal_id AND p.active AND p.kind='human'
  JOIN morrow_identity.identity_verification_profiles vp ON vp.id::text=p_profile_id AND vp.provider_id=p_provider
    AND vp.environment_id=p_environment AND vp.application_id=p_application AND vp.client_id=p_client AND vp.issuer=p_issuer
    AND vp.token_profile_revision::text=p_token_revision AND vp.token_profile_digest=p_token_digest AND vp.state='active'
  JOIN morrow_identity.provider_subject_profile_bindings a ON a.mapping_id=m.id AND a.profile_id=vp.id
    AND a.provider_id=p_provider AND a.environment_id=p_environment AND a.state='active'
  WHERE w.id::text=p_workspace AND w.active;
  IF NOT FOUND THEN EXIT qualification; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',org_key)::text,0));
  SELECT * INTO org FROM morrow_identity.organizations WHERE id::text=org_key FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('browser-provider:'||array_to_json(ARRAY[p_provider,p_environment,p_client,p_provider_session])::text,0));
  SELECT * INTO pb FROM morrow_identity.provider_session_bindings WHERE provider_id=p_provider AND environment_id=p_environment AND client_id=p_client AND provider_session_id=p_provider_session FOR UPDATE;
  SELECT * INTO v FROM morrow_identity.identity_verification_profiles WHERE id::text=p_profile_id
    AND provider_id=p_provider AND environment_id=p_environment AND application_id=p_application AND client_id=p_client AND issuer=p_issuer
    AND token_profile_revision::text=p_token_revision AND token_profile_digest=p_token_digest FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO sm FROM morrow_identity.provider_subject_mappings WHERE id::text=p_mapping_id
    AND provider_id=p_provider AND environment_id=p_environment AND subject_id=p_subject FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO b FROM morrow_identity.provider_subject_profile_bindings WHERE profile_id=v.id AND mapping_id=sm.id FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO person FROM morrow_identity.principals WHERE id=sm.principal_id FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO ws FROM morrow_identity.workspaces WHERE id::text=p_workspace AND organization_id=org.id FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO member_row FROM morrow_identity.memberships WHERE id::text=p_membership_id AND organization_id=org.id AND principal_id=person.id FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO wm FROM morrow_identity.workspace_memberships WHERE organization_id=org.id AND workspace_id=ws.id AND membership_id=member_row.id FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  instant:=clock_timestamp(); n:=floor(extract(epoch FROM instant)*1000);
  IF p_evidence_observed::numeric>n OR p_evidence_expires::numeric<=n THEN reason_code:='evidence_expired'; EXIT qualification; END IF;
  IF NOT org.active OR NOT ws.active OR NOT person.active OR person.kind<>'human' OR NOT member_row.active OR NOT wm.active
     OR v.state<>'active' OR sm.state<>'active' OR b.state<>'active' THEN EXIT qualification; END IF;
  IF v.provider_id<>p_provider OR v.environment_id<>p_environment OR v.application_id<>p_application OR v.client_id<>p_client
     OR v.issuer<>p_issuer OR v.token_profile_revision::text<>p_token_revision OR v.token_profile_digest<>p_token_digest
     OR sm.provider_id<>p_provider OR sm.environment_id<>p_environment OR sm.subject_id<>p_subject
     OR b.provider_id<>p_provider OR b.environment_id<>p_environment THEN EXIT qualification; END IF;
  IF v.record_revision::text<>p_profile_record_revision OR sm.record_revision::text<>p_mapping_revision OR b.record_revision::text<>p_binding_revision OR org.policy_revision::text<>p_policy_revision THEN reason_code:='revision_conflict'; EXIT qualification; END IF;
  IF pb.id IS NOT NULL AND (pb.mapping_id<>sm.id OR pb.profile_id<>v.id) THEN reason_code:='identity_conflict'; EXIT qualification; END IF;
  IF pb.id IS NOT NULL AND pb.revoked_at IS NOT NULL THEN reason_code:='binding_revoked'; EXIT qualification; END IF;
  IF pb.id IS NOT NULL AND pb.created_at>instant THEN EXIT qualification; END IF;
  IF EXISTS(SELECT 1 FROM morrow_identity.sessions WHERE session_digest=p_secret_digest) THEN reason_code:='digest_conflict'; EXIT qualification; END IF;
  reason_code:='admitted';
 END qualification;
 audit_key:=gen_random_uuid()::text;
 IF reason_code='admitted' THEN
  BEGIN
   instant:=clock_timestamp(); n:=floor(extract(epoch FROM instant)*1000);
   IF p_evidence_observed::numeric>n OR p_evidence_expires::numeric<=n THEN RAISE SQLSTATE 'P8101'; END IF;
   IF pb.id IS NULL THEN
    provider_key:=gen_random_uuid()::text;
    INSERT INTO morrow_identity.provider_session_bindings(id,provider_id,environment_id,client_id,provider_session_id,mapping_id,profile_id,created_at)
     VALUES(provider_key,p_provider,p_environment,p_client,p_provider_session,sm.id,v.id,instant);
   ELSE provider_key:=pb.id::text; END IF;
   expiry:=instant+interval '15 minutes';
   INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,created_at,expires_at)
    VALUES(p_family_id,provider_key,v.record_revision,sm.record_revision,b.record_revision,instant,expiry);
   INSERT INTO morrow_identity.browser_session_generations(id,family_id,secret_digest,created_at,expires_at)
    VALUES(p_generation_id,p_family_id,p_secret_digest,instant,expiry);
   INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at)
    VALUES(audit_key,p_command,p_request_digest,'admit',p_family_id,'admitted','admitted',instant);
   INSERT INTO morrow_identity.browser_session_commands(command_id,request_digest,request_tuple,outcome,family_id,generation_id,provider_binding_id,expires_at,audit_id,recorded_at)
    VALUES(p_command,p_request_digest,to_jsonb(tuple_values),'admitted',p_family_id,p_generation_id,provider_key,expiry,audit_key,instant);
   -- Covers every late UNIQUE/FK/row wait inside the persistence subtransaction.
   IF p_evidence_expires::numeric<=floor(extract(epoch FROM clock_timestamp())*1000) THEN RAISE SQLSTATE 'P8101'; END IF;
   succeeded:=true;
  EXCEPTION WHEN SQLSTATE 'P8101' THEN reason_code:='evidence_expired';
   WHEN unique_violation THEN reason_code:='identity_conflict';
  END;
 END IF;
 IF succeeded THEN
  RETURN QUERY SELECT 'newly_admitted'::text,p_family_id,p_generation_id,provider_key,floor(extract(epoch FROM expiry)*1000)::text,audit_key; RETURN;
 END IF;
 -- A terminal denied command is also immutable. Its private audit attributes the
 -- denial, but the executor receives no identity locator or bearer information.
 instant:=clock_timestamp();
 INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at)
  VALUES(audit_key,p_command,p_request_digest,'admit',NULL,'denied',reason_code,instant);
 INSERT INTO morrow_identity.browser_session_commands(command_id,request_digest,request_tuple,outcome,audit_id,recorded_at)
  VALUES(p_command,p_request_digest,to_jsonb(tuple_values),'denied',audit_key,instant);
 RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
END $$;
COMMIT;
