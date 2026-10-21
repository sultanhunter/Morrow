BEGIN;
-- The staging test entitlement's identity bridge (owner decision (b), 2026-10-21; ADR-0022
-- item 5 amendment; docs/briefs/staging-test-entitlement.md). Executes AS
-- morrow_identity_owner, after 0029 and before 0031, which calls it. The operator grant
-- (0031, morrow_billing.operator_test_entitlement_grant) fixes a workspace's route, so it
-- applies the phase-open rule every route fix applies (P01.T04a R2, R3; checkout's
-- route_conflict and the receipt application's fix): no store association, an
-- installation that is or was linked. That fact comes only from M2 PR-2's shared read,
-- morrow_identity.work_store_installations (0026: ids and states only, never a shop
-- domain), executable until now by the command role alone. The operator function is
-- INVOKER and runs as morrow_work_owner, which inherits nothing (rolinherit false), so the
-- identity owner grants the work owner EXECUTE on that one read:
--   * the work owner is no runtime role: only the administrator's own transaction reaches
--     it, under the D4 SET-row protocol (ADR-0020), and it already reads every billing row;
--   * no runtime login, role or definer gains anything; the read is unchanged, and the
--     ADR-0020 helpers keep their three work-owner grants (0014).
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regprocedure('morrow_identity.work_store_installations(text,text)') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_store_installations(text,text)','EXECUTE')
 OR pg_catalog.has_function_privilege('morrow_work_owner','morrow_identity.work_store_installations(text,text)','EXECUTE')
 OR NOT pg_catalog.has_schema_privilege('morrow_work_owner','morrow_identity','USAGE')
 OR to_regclass('morrow_billing.billing_terms') IS NULL
 OR to_regclass('morrow_billing.platform_environment') IS NOT NULL
 THEN RAISE EXCEPTION 'STAGING_ENTITLEMENT_IDENTITY_BRIDGE_PREREQUISITES_INVALID'; END IF;
END $$;

GRANT EXECUTE ON FUNCTION morrow_identity.work_store_installations(text,text) TO morrow_work_owner;
COMMIT;
