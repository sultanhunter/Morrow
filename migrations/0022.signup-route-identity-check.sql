BEGIN;
-- M2 PR-1 review: the identity fact behind the signup route policy (P01.T04a §3 R1;
-- ADR-0015 item 2; mvp-architecture §6). Executes AS morrow_identity_owner, after 0021.
-- It changes no identity table, row or grant. It adds one definer function that only
-- morrow_work_command may execute: work_signup_workspace, true only for the workspace of
-- a website signup (organization_signups, written only by create_first_organization).
-- 0023 binds morrow_billing.workspace_billing_routes' route_signup policy to it, so no
-- command-role definer can record a website-origin route for any other workspace.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR to_regclass('morrow_identity.organization_signups') IS NULL
 OR to_regprocedure('morrow_identity.signup_billing_route()') IS NULL
 OR to_regprocedure('morrow_identity.work_lease_member_current(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.work_signup_workspace(text,text)') IS NOT NULL
 OR NOT morrow_identity.morrow_memberships_closed()
 THEN RAISE EXCEPTION 'SIGNUP_ROUTE_IDENTITY_CHECK_PREREQUISITES_INVALID'; END IF;
END $$;

-- Whether this workspace was created by a website signup. LANGUAGE sql BEGIN ATOMIC
-- records the table dependency.
CREATE FUNCTION morrow_identity.work_signup_workspace(p_org text,p_ws text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp
BEGIN ATOMIC
 SELECT EXISTS(SELECT 1 FROM morrow_identity.organization_signups s WHERE s.organization_id=p_org AND s.workspace_id=p_ws);
END;
REVOKE ALL ON FUNCTION morrow_identity.work_signup_workspace(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_signup_workspace(text,text) TO morrow_work_command;
COMMIT;
