BEGIN;
-- BRANCH-LOCAL STUB, never merged (integration interface "Store installation read
-- bridge"): M3 PR-1 consumes M2 PR-2's morrow_identity.work_store_installations before M2
-- PR-2 merges. At the final rebase this file and its manifest row are deleted, and M2
-- PR-2's own bridge (migration 0026 of that PR, over store_installations joined to
-- workspace_store_links) takes its place with the same signature. Executes AS
-- morrow_identity_owner. Until then each 0005 workspace_store_links row stands for one
-- linked store whose store id, connection id and installation id are all its
-- installation_id, with status 'linked'. It returns ids and states only, never a shop
-- domain; callers pass the tenant from current_tenant() or the lease row.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR to_regclass('morrow_identity.workspace_store_links') IS NULL
 OR to_regprocedure('morrow_identity.work_store_installations(text,text)') IS NOT NULL
 OR NOT morrow_identity.morrow_memberships_closed()
 THEN RAISE EXCEPTION 'STORE_INSTALLATIONS_STUB_PREREQUISITES_INVALID'; END IF;
END $$;

CREATE FUNCTION morrow_identity.work_store_installations(p_org text,p_ws text)
RETURNS TABLE(installation_id text,store_id text,connection_id text,status text,linked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp
BEGIN ATOMIC
 SELECT l.installation_id::text,l.installation_id::text,l.installation_id::text,'linked'::text,l.linked_at
 FROM morrow_identity.workspace_store_links l
 WHERE l.organization_id=p_org AND l.workspace_id=p_ws
  AND p_org ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND p_ws ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
 ORDER BY l.installation_id::text COLLATE "C";
END;
REVOKE ALL ON FUNCTION morrow_identity.work_store_installations(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_store_installations(text,text) TO morrow_work_command;
COMMIT;
