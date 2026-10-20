BEGIN;
-- BRANCH-LOCAL STUB (M5 PR-1), deleted at the final rebase and never merged. It stands in
-- for M2 PR-2's identity bridge morrow_identity.work_store_installations(text,text)
-- (integration.json cross_pr_interfaces, "Store installation read bridge"), with exactly
-- its signature, owner, ACL and registry entry, so M5's workspace_associations() and
-- checkout precondition can be built and tested before M2 PR-2 merges. Over
-- workspace_store_links (0005), which has no store or connection id: store_id =
-- connection_id = installation_id and every link reads as status 'linked'. M2 PR-2's
-- migration replaces it with the real bridge over store_installations.
-- Executes AS morrow_identity_owner. It changes no identity table, row or grant.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR to_regclass('morrow_identity.workspace_store_links') IS NULL
 OR to_regprocedure('morrow_identity.work_store_installations(text,text)') IS NOT NULL
 OR NOT morrow_identity.morrow_memberships_closed()
 THEN RAISE EXCEPTION 'WORK_STORE_INSTALLATIONS_STUB_PREREQUISITES_INVALID'; END IF;
END $$;

-- Ids and states only, never a shop domain. A current association is status 'linked'
-- with linked_at <= now. Callers pass the tenant from current_tenant() or a lease row.
CREATE FUNCTION morrow_identity.work_store_installations(p_org text,p_ws text)
RETURNS TABLE(installation_id text,store_id text,connection_id text,status text,linked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp
BEGIN ATOMIC
 SELECT l.installation_id::text,l.installation_id::text,l.installation_id::text,'linked'::text,l.linked_at
 FROM morrow_identity.workspace_store_links l
 WHERE l.organization_id=p_org AND l.workspace_id=p_ws
 ORDER BY l.linked_at,l.installation_id::text COLLATE "C" LIMIT 100;
END;
REVOKE ALL ON FUNCTION morrow_identity.work_store_installations(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_store_installations(text,text) TO morrow_work_command;
COMMIT;
