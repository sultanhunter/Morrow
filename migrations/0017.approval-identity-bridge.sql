BEGIN;
-- P06.T01b approval identity bridge (ADR-0011, ADR-0010 item 2). Executes AS
-- morrow_identity_owner, after 0016 (P05.T01y); it builds on 0013 (signup owner
-- records) and 0014 (the P06.T01a bridge). It changes no identity table, row or
-- grant. It adds four definer functions that only morrow_work_command may
-- execute: the workspace ownership facts of the solo-owner rule, the review
-- candidates and reviewer grants the policy kernel judges in the Worker, and the
-- exclusive variant of the P06.T01a locked recheck for approval claim consumers.
-- SQL never interprets a grant here: rows are selected by capability id only and
-- the kernel decides (no verb, revocation or validity filter). Role checks reuse
-- the existing helpers and pg_has_role; this file never reads the role-membership
-- catalog directly (the proposed ADR-0020 new-migration rule).
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api') AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication)<>3
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles w,pg_catalog.pg_roles i
   WHERE w.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api','morrow_api_worker')
   AND (i.rolname='morrow_api' OR i.rolname LIKE 'morrow\_identity%')
   AND (pg_catalog.pg_has_role(w.oid,i.oid,'MEMBER') OR pg_catalog.pg_has_role(i.oid,w.oid,'MEMBER')))
 OR to_regclass('morrow_identity.organization_signups') IS NULL
 OR to_regclass('morrow_identity.workspace_revocation_results') IS NULL
 OR to_regprocedure('morrow_identity.work_lock_and_recheck(text,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.work_actor_authority(text,text)') IS NULL
 OR to_regnamespace('morrow_work') IS NULL
 THEN RAISE EXCEPTION 'APPROVAL_BRIDGE_PREREQUISITES_INVALID'; END IF;
END $$;

-- The solo-owner facts of one organization (ADR-0011 Q2; P01.T02a §7 item 6),
-- always exactly one row. The owner is the organization_signups principal and
-- membership (ADR-0009 item 3) while that membership is active and the principal
-- an active human; otherwise both are NULL and solo status never holds. The count
-- is of active ORGANIZATION memberships of active human principals (the stricter
-- reading of "only active human member"). The last change is the millisecond-
-- truncated time of the latest applied 0004 revocation in the organization, or
-- NULL. P05.T01z replaces this body (CREATE OR REPLACE, same shape) to add
-- ownership transfers, removals and principal deactivations. LANGUAGE sql BEGIN
-- ATOMIC records the table dependencies.
CREATE FUNCTION morrow_identity.work_ownership_facts(p_org text)
RETURNS TABLE(owner_principal_id text,owner_membership_id text,active_human_membership_count integer,last_membership_change_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp
BEGIN ATOMIC
 SELECT
  (SELECT s.principal_id::text FROM morrow_identity.organization_signups s
    JOIN morrow_identity.memberships m ON m.organization_id=s.organization_id AND m.id=s.membership_id AND m.principal_id=s.principal_id AND m.active
    JOIN morrow_identity.principals p ON p.id=s.principal_id AND p.active AND p.kind='human'
    WHERE s.organization_id=p_org),
  (SELECT s.membership_id::text FROM morrow_identity.organization_signups s
    JOIN morrow_identity.memberships m ON m.organization_id=s.organization_id AND m.id=s.membership_id AND m.principal_id=s.principal_id AND m.active
    JOIN morrow_identity.principals p ON p.id=s.principal_id AND p.active AND p.kind='human'
    WHERE s.organization_id=p_org),
  (SELECT count(*)::integer FROM morrow_identity.memberships m
    JOIN morrow_identity.principals p ON p.id=m.principal_id AND p.active AND p.kind='human'
    WHERE m.organization_id=p_org AND m.active),
  (SELECT date_trunc('milliseconds',max(r.recorded_at)) FROM morrow_identity.workspace_revocation_results r
    WHERE r.organization_id=p_org AND r.outcome='applied');
END;
REVOKE ALL ON FUNCTION morrow_identity.work_ownership_facts(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_ownership_facts(text) TO morrow_work_command;

-- Review candidates for the quorum-reachability check (liveness only): active human
-- members of the workspace (active principal, organization, workspace and both
-- memberships) holding at least one grant row whose payload capabilityId is
-- governance.approval.decide, minus at most 102 excluded principals, after a
-- principal cursor, at most 25 per page. Each row carries that member's grant
-- rows for the decide capability and the proposal's capability (by id, at most
-- 65; a count of 65 means overflow, which the Worker counts as ineligible) and
-- their digest, as work_actor_authority digests the actor's.
CREATE FUNCTION morrow_identity.work_review_candidates(p_org text,p_ws text,p_capability text,p_exclude text[],p_after text,p_limit integer)
RETURNS TABLE(principal_id text,membership_id text,grants jsonb,grant_count integer,grants_digest text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp
BEGIN ATOMIC
 WITH m AS MATERIALIZED (
  SELECT p.id::text AS principal_id,mem.id::text AS membership_id
  FROM morrow_identity.organizations o
  JOIN morrow_identity.workspaces w ON w.organization_id=o.id AND w.id=p_ws AND w.active
  JOIN morrow_identity.memberships mem ON mem.organization_id=o.id AND mem.active
  JOIN morrow_identity.principals p ON p.id=mem.principal_id AND p.active AND p.kind='human'
  JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=o.id AND wm.workspace_id=w.id AND wm.membership_id=mem.id AND wm.active
  WHERE o.id=p_org AND o.active
   AND p_capability ~ '^[a-z]+(\.[a-z_]+)+$' AND char_length(p_capability)<=128
   AND p_limit BETWEEN 1 AND 25 AND COALESCE(cardinality(p_exclude),0)<=102
   AND (p_after IS NULL OR p.id::text COLLATE "C">p_after COLLATE "C")
   AND p.id::text<>ALL(COALESCE(p_exclude,ARRAY[]::text[]))
   AND EXISTS(SELECT 1 FROM morrow_identity.grants d WHERE d.organization_id=o.id AND d.workspace_id=w.id
    AND d.membership_id=mem.id AND d.principal_id=p.id AND d.payload->>'capabilityId'='governance.approval.decide')
  ORDER BY p.id::text COLLATE "C" LIMIT CASE WHEN p_limit BETWEEN 1 AND 25 THEN p_limit ELSE 0 END)
 SELECT m.principal_id,m.membership_id,a.grants,a.grant_count,encode(sha256(convert_to(a.grants::text,'UTF8')),'hex')
 FROM m CROSS JOIN LATERAL (
  SELECT COALESCE(jsonb_agg(g.payload ORDER BY g.id COLLATE "C"),'[]'::jsonb) AS grants,count(*)::integer AS grant_count
  FROM (SELECT gr.id::text AS id,gr.payload FROM morrow_identity.grants gr
   WHERE gr.organization_id=p_org AND gr.workspace_id=p_ws AND gr.membership_id=m.membership_id AND gr.principal_id=m.principal_id
    AND gr.payload->>'capabilityId' IN ('governance.approval.decide',p_capability)
   ORDER BY gr.id::text COLLATE "C" LIMIT 65) g) a
 ORDER BY m.principal_id COLLATE "C";
END;
REVOKE ALL ON FUNCTION morrow_identity.work_review_candidates(text,text,text,text[],text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_review_candidates(text,text,text,text[],text,integer) TO morrow_work_command;

-- The grants of at most five named reviewers, by the same row rule without paging
-- or the decide-grant filter: an absent row means the principal is no longer an
-- active member of the workspace. Used for counted reviewers at decision and claim.
CREATE FUNCTION morrow_identity.work_reviewer_grants(p_org text,p_ws text,p_capability text,p_principals text[])
RETURNS TABLE(principal_id text,membership_id text,grants jsonb,grant_count integer,grants_digest text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp
BEGIN ATOMIC
 WITH m AS MATERIALIZED (
  SELECT p.id::text AS principal_id,mem.id::text AS membership_id
  FROM morrow_identity.organizations o
  JOIN morrow_identity.workspaces w ON w.organization_id=o.id AND w.id=p_ws AND w.active
  JOIN morrow_identity.memberships mem ON mem.organization_id=o.id AND mem.active
  JOIN morrow_identity.principals p ON p.id=mem.principal_id AND p.active AND p.kind='human'
  JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=o.id AND wm.workspace_id=w.id AND wm.membership_id=mem.id AND wm.active
  WHERE o.id=p_org AND o.active
   AND p_capability ~ '^[a-z]+(\.[a-z_]+)+$' AND char_length(p_capability)<=128
   AND cardinality(p_principals) BETWEEN 1 AND 5
   AND p.id::text=ANY(p_principals))
 SELECT m.principal_id,m.membership_id,a.grants,a.grant_count,encode(sha256(convert_to(a.grants::text,'UTF8')),'hex')
 FROM m CROSS JOIN LATERAL (
  SELECT COALESCE(jsonb_agg(g.payload ORDER BY g.id COLLATE "C"),'[]'::jsonb) AS grants,count(*)::integer AS grant_count
  FROM (SELECT gr.id::text AS id,gr.payload FROM morrow_identity.grants gr
   WHERE gr.organization_id=p_org AND gr.workspace_id=p_ws AND gr.membership_id=m.membership_id AND gr.principal_id=m.principal_id
    AND gr.payload->>'capabilityId' IN ('governance.approval.decide',p_capability)
   ORDER BY gr.id::text COLLATE "C" LIMIT 65) g) a
 ORDER BY m.principal_id COLLATE "C";
END;
REVOKE ALL ON FUNCTION morrow_identity.work_reviewer_grants(text,text,text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_reviewer_grants(text,text,text,text[]) TO morrow_work_command;

-- work_lock_and_recheck (0014) for approval claim consumers, whose effect writes
-- identity rows. It takes the organization interlock exclusively and the
-- organization row FOR UPDATE, first and never upgraded, as every identity
-- function that locks an organization FOR UPDATE does (0014), and then returns
-- work_lock_and_recheck itself, so the recheck is the 0014 one by construction.
-- That call's shared interlock and FOR SHARE are already covered by this
-- transaction's exclusive locks and never wait. No lock is taken for malformed
-- arguments.
CREATE FUNCTION morrow_identity.work_lock_and_recheck_exclusive(p_digest text,p_workspace text,p_principal text,p_membership text,p_revision text,p_grants_digest text,p_evaluated_at_us text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
 v_org text;
BEGIN
 -- The 0014 scalar checks, before any lock is taken; work_lock_and_recheck repeats them.
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
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',v_org)::text,0));
 PERFORM 1 FROM morrow_identity.organizations o WHERE o.id=v_org FOR UPDATE;
 IF NOT FOUND THEN RETURN 'ineligible'; END IF;
 RETURN morrow_identity.work_lock_and_recheck(p_digest,p_workspace,p_principal,p_membership,p_revision,p_grants_digest,p_evaluated_at_us);
END $$;
REVOKE ALL ON FUNCTION morrow_identity.work_lock_and_recheck_exclusive(text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_lock_and_recheck_exclusive(text,text,text,text,text,text,text) TO morrow_work_command;
COMMIT;
