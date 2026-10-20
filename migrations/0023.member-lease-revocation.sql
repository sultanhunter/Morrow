BEGIN;
-- M2 PR-1 review (ADR-0022 item 9; mvp-architecture §5; P01.T04a §8.1). Executes AS
-- morrow_work_owner, after 0022. Two changes on the 0020 tables:
--   * Membership removal revokes leases (spine §5): revoke_member_leases, a definer the
--     identity owner alone may execute, sets every active lease that a removed member
--     initiated in one workspace to revoked (reason 'membership') in the transaction that
--     removes the membership (0024's triggers call it). Its policy, lease_member_revoke,
--     admits only leases of exactly the (organization, workspace, membership) the
--     definer names in its transaction-local setting, only while that member is no longer
--     current, and only the change to revoked with reason 'membership', so no other
--     definer can revoke a current member's lease through it. A revoked lease stays
--     revoked when the membership returns.
--   * The signup route policy: route_signup admits the unfixed website row only for the
--     workspace of a website signup (morrow_identity.work_signup_workspace, 0022), so a
--     command-role definer can no longer record a website origin for any other workspace.
-- No external effect; no table, column or grant of 0020 is removed.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR to_regclass('morrow_work.work_leases') IS NULL OR to_regclass('morrow_billing.workspace_billing_routes') IS NULL
 OR to_regprocedure('morrow_work.revoke_member_leases(text,text,text)') IS NOT NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_lease_member_current(text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_signup_workspace(text,text)','EXECUTE')
 OR (SELECT count(*) FROM pg_catalog.pg_policies p WHERE p.schemaname='morrow_billing' AND p.tablename='workspace_billing_routes'
   AND p.policyname='route_signup')<>1
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='morrow_work' AND p.tablename='work_leases'
   AND p.policyname='lease_member_revoke')
 OR NOT morrow_identity.morrow_memberships_closed()
 THEN RAISE EXCEPTION 'MEMBER_LEASE_REVOCATION_PREREQUISITES_INVALID'; END IF;
END $$;

-- The identity owner calls one work definer (0024's membership triggers).
GRANT USAGE ON SCHEMA morrow_work TO morrow_identity_owner;
CREATE INDEX work_leases_active_member ON morrow_work.work_leases (organization_id,workspace_id,initiator_membership_id) WHERE status='active';

-- USING has no status term: an UPDATE that reads its rows must also see the new (revoked)
-- row, and lease_guard already refuses any change to a lease that is no longer active.
CREATE POLICY lease_member_revoke ON morrow_work.work_leases TO morrow_work_command
 USING (pg_catalog.current_setting('morrow.work_member_revocation',true)=organization_id::text||'|'||workspace_id::text||'|'||initiator_membership_id::text
  AND NOT morrow_identity.work_lease_member_current(organization_id::text,workspace_id::text,initiator_principal_id::text,initiator_membership_id::text))
 WITH CHECK (status='revoked' AND revoked_reason='membership'
  AND pg_catalog.current_setting('morrow.work_member_revocation',true)=organization_id::text||'|'||workspace_id::text||'|'||initiator_membership_id::text);

-- SECURITY DEFINER, owned by the command role after the transfer below, EXECUTE for
-- morrow_identity_owner only. Revokes every active lease the membership initiated in the
-- workspace, if that member is no longer current; the setting lives only for the one
-- statement. Outcomes: applied (with the number revoked), invalid.
CREATE FUNCTION morrow_work.revoke_member_leases(p_organization_id text,p_workspace_id text,p_membership_id text)
RETURNS TABLE(outcome text,revoked integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE n integer;
BEGIN
 IF p_organization_id IS NULL OR p_organization_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_workspace_id IS NULL OR p_workspace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_membership_id IS NULL OR p_membership_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN;
 END IF;
 PERFORM pg_catalog.set_config('morrow.work_member_revocation',p_organization_id||'|'||p_workspace_id||'|'||p_membership_id,true);
 UPDATE morrow_work.work_leases l SET status='revoked',revoked_reason='membership',
  ended_at=greatest(date_trunc('milliseconds',clock_timestamp()),l.created_at)
  WHERE l.organization_id=p_organization_id AND l.workspace_id=p_workspace_id AND l.initiator_membership_id=p_membership_id
   AND l.status='active';
 GET DIAGNOSTICS n=ROW_COUNT;
 PERFORM pg_catalog.set_config('morrow.work_member_revocation','',true);
 RETURN QUERY SELECT 'applied'::text,n;
END $$;
REVOKE ALL ON FUNCTION morrow_work.revoke_member_leases(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.revoke_member_leases(text,text,text) TO morrow_identity_owner;

-- The signup bridge's policy, bound to the signup itself.
DROP POLICY route_signup ON morrow_billing.workspace_billing_routes;
CREATE POLICY route_signup ON morrow_billing.workspace_billing_routes FOR INSERT TO morrow_work_command
 WITH CHECK (origin='website' AND route IS NULL AND mode IS NULL AND route_fixed_at IS NULL AND fixing_payment_key IS NULL AND revision=1
  AND morrow_identity.work_signup_workspace(organization_id::text,workspace_id::text));

GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;
ALTER FUNCTION morrow_work.revoke_member_leases(text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;
COMMIT;
