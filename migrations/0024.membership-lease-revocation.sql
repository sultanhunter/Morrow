BEGIN;
-- M2 PR-1 review: a membership removal revokes the removed member's leases in the same
-- transaction (mvp-architecture §5; ADR-0022 item 9). Executes AS morrow_identity_owner,
-- after 0023. When a workspace membership, or the organization membership behind it,
-- goes from active to inactive (revoke_workspace_access, or any later removal path), its
-- AFTER UPDATE trigger calls morrow_work.revoke_member_leases (0023) for each affected
-- workspace, so a run or operation the member queued neither runs nor resumes when the
-- membership returns. It changes no identity table, row or grant.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR to_regclass('morrow_identity.workspace_memberships') IS NULL OR to_regclass('morrow_identity.memberships') IS NULL
 OR to_regprocedure('morrow_work.revoke_member_leases(text,text,text)') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_identity_owner','morrow_work.revoke_member_leases(text,text,text)','EXECUTE')
 OR to_regprocedure('morrow_identity.revoke_member_work_leases()') IS NOT NULL
 OR NOT morrow_identity.morrow_memberships_closed()
 THEN RAISE EXCEPTION 'MEMBERSHIP_LEASE_REVOCATION_PREREQUISITES_INVALID'; END IF;
END $$;

-- INVOKER, owned by the identity owner, granted to nobody. It runs as the writer of the
-- membership row: the identity owner (revoke_workspace_access and every other identity
-- writer is its definer).
CREATE FUNCTION morrow_identity.revoke_member_work_leases() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE w record; v record;
BEGIN
 IF TG_TABLE_NAME='workspace_memberships' THEN
  SELECT * INTO v FROM morrow_work.revoke_member_leases(NEW.organization_id::text,NEW.workspace_id::text,NEW.membership_id::text);
  IF v.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'MEMBERSHIP_LEASE_REVOCATION_INVALID'; END IF;
 ELSE
  FOR w IN SELECT m.workspace_id::text AS workspace_id FROM morrow_identity.workspace_memberships m
   WHERE m.organization_id=NEW.organization_id AND m.membership_id=NEW.id ORDER BY m.workspace_id LOOP
   SELECT * INTO v FROM morrow_work.revoke_member_leases(NEW.organization_id::text,w.workspace_id,NEW.id::text);
   IF v.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'MEMBERSHIP_LEASE_REVOCATION_INVALID'; END IF;
  END LOOP;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.revoke_member_work_leases() FROM PUBLIC;
CREATE TRIGGER revoke_member_work_leases AFTER UPDATE OF active ON morrow_identity.workspace_memberships
 FOR EACH ROW WHEN (OLD.active AND NOT NEW.active) EXECUTE FUNCTION morrow_identity.revoke_member_work_leases();
CREATE TRIGGER revoke_member_work_leases AFTER UPDATE OF active ON morrow_identity.memberships
 FOR EACH ROW WHEN (OLD.active AND NOT NEW.active) EXECUTE FUNCTION morrow_identity.revoke_member_work_leases();
COMMIT;
