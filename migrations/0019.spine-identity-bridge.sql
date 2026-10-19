BEGIN;
-- M2 PR-1 spine identity bridge (ADR-0022 items 8-9; mvp-architecture §3 and §5).
-- Executes AS morrow_identity_owner, after 0018. It changes no identity table, row or
-- grant. It adds two definer functions that only morrow_work_command may execute:
-- work_executor_safe, the run-time guard of the three membership-free executor logins
-- (ADR-0020 item 4: executor_memberships_closed of the session user, which also requires
-- the identity owner to be closed), and work_lease_member_current, the live membership
-- recheck behind morrow_work.current_lease(). Role checks reuse the ADR-0020 helpers;
-- this file never reads the role-membership catalog directly (ADR-0020 item 6).
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 -- The three executor logins of infra/spine-executor-role-prerequisites.sql: LOGIN,
 -- every other attribute off, and no membership row beyond the ADR-0020 creation row.
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regprocedure('morrow_identity.executor_memberships_closed(name)') IS NULL
 OR to_regprocedure('morrow_identity.work_session_context(text,text)') IS NULL
 OR to_regprocedure('morrow_identity.work_lock_and_recheck_exclusive(text,text,text,text,text,text,text)') IS NULL
 OR to_regnamespace('morrow_work') IS NULL
 OR to_regprocedure('morrow_identity.work_executor_safe(text)') IS NOT NULL
 OR to_regnamespace('morrow_billing') IS NOT NULL OR to_regnamespace('morrow_vault') IS NOT NULL
 THEN RAISE EXCEPTION 'SPINE_BRIDGE_PREREQUISITES_INVALID'; END IF;
END $$;

-- The run-time guard of the executor logins (ADR-0022 item 8). True only when the
-- session user is exactly the named executor, one of the three, with LOGIN and every
-- other attribute off, and both it and the identity owner are closed (ADR-0020). A
-- SECURITY DEFINER caller never changes session_user, so a definer owned by the command
-- role sees the login that called it. A plain SQL body (not BEGIN ATOMIC), so the ADR-0020
-- census of helper calls (lab:createrole-administrator) counts this guard.
CREATE FUNCTION morrow_identity.work_executor_safe(p_executor text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT COALESCE(p_executor IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
  AND session_user=p_executor
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user AND r.rolcanlogin AND NOT r.rolsuper
   AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication
   AND morrow_identity.executor_memberships_closed(r.rolname)),false)
$$;
REVOKE ALL ON FUNCTION morrow_identity.work_executor_safe(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_executor_safe(text) TO morrow_work_command;

-- The lease's initiating member is still current (spine §5): an active human principal
-- with active organization and workspace memberships in an active organization and
-- workspace. A lease selects the tenant only while this holds; it grants nothing.
-- LANGUAGE sql BEGIN ATOMIC records the table dependencies.
CREATE FUNCTION morrow_identity.work_lease_member_current(p_org text,p_ws text,p_principal text,p_membership text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp
SET join_collapse_limit=1 SET from_collapse_limit=1
BEGIN ATOMIC
 SELECT EXISTS(SELECT 1 FROM morrow_identity.principals p
  JOIN morrow_identity.memberships mem ON mem.principal_id=p.id AND mem.id=p_membership AND mem.organization_id=p_org AND mem.active
  JOIN morrow_identity.organizations o ON o.id=mem.organization_id AND o.active
  JOIN morrow_identity.workspaces w ON w.organization_id=o.id AND w.id=p_ws AND w.active
  JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=o.id AND wm.workspace_id=w.id AND wm.membership_id=mem.id AND wm.active
  WHERE p.id=p_principal AND p.active AND p.kind='human');
END;
REVOKE ALL ON FUNCTION morrow_identity.work_lease_member_current(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_lease_member_current(text,text,text,text) TO morrow_work_command;
COMMIT;
