BEGIN;
-- P06.T01a identity bridge (ADR-0010 item 2). Executes AS morrow_identity_owner.
-- It changes no identity table, function or grant; it adds four definer functions
-- that only morrow_work_command may execute, plus the schema usage and column
-- REFERENCES the work tables' composite foreign keys need. No work role and no
-- identity role are members of each other in either direction.
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
-- FOR SHARE (conflicting with the 0004 revocation's FOR UPDATE) and re-resolves:
-- 'ineligible' when the session, membership or actor changed; 'stale' when the
-- policy revision or grants digest changed or a grant expired after the snapshot.
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
COMMIT;
