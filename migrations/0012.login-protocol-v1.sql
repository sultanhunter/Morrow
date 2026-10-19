BEGIN;
-- Retires the plan-number login controller protocol identifier (P05.T01x Part A).
-- 0001-0004 stay byte-identical; 0005-0015 were rebaselined once under ADR-0020. Legacy
-- configuration rows stay readable and
-- immutable; the NOT VALID constraint binds only rows written after this migration and is
-- never validated. Executors may already hold LOGIN when an existing database upgrades, so
-- the role check is the 0010 flag set without the LOGIN attribute.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT EXISTS(SELECT 1 FROM pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 OR (SELECT count(*) FROM pg_roles r WHERE r.rolname IN ('morrow_identity_login','morrow_identity_login_maintenance') AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND morrow_identity.memberships_closed(r.rolname))<>2
 OR EXISTS(SELECT 1 FROM pg_roles r,pg_roles o WHERE o.rolname='morrow_identity_owner' AND r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance','morrow_identity_logout') AND (pg_has_role(r.oid,o.oid,'MEMBER') OR pg_has_role(o.oid,r.oid,'MEMBER')))
 OR to_regprocedure('morrow_identity.end_self_browser_family(text,text,text,text,text,text,text,text)') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=to_regclass('morrow_identity.login_controller_configurations') AND k.conname='login_controller_configurations_controller_protocol_check' AND k.contype='c')
 THEN RAISE EXCEPTION 'LOGIN_PROTOCOL_PREREQUISITES_INVALID'; END IF;
END $$;
ALTER TABLE morrow_identity.login_controller_configurations
 DROP CONSTRAINT login_controller_configurations_controller_protocol_check,
 ADD CONSTRAINT login_controller_protocol_v1 CHECK(controller_protocol='morrow-login-v1') NOT VALID;
-- The 0010 body plus the protocol requirement. OR REPLACE keeps the owner, the ACL (no
-- EXECUTE for any executor) and every definer caller unchanged.
CREATE OR REPLACE FUNCTION morrow_identity.login_configuration_current(p_configuration text,p_workspace text) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM morrow_identity.login_controller_configurations c
 JOIN morrow_identity.authentication_bindings b ON b.id=c.binding_id AND b.active AND b.environment_id=c.environment_id AND b.client_id=c.client_id AND b.redirect_uri=c.redirect_uri AND b.return_path=c.return_path
 JOIN morrow_identity.authentication_exchange_bindings x ON x.binding_id=b.id AND x.active AND x.provider_id='workos' AND x.application_id=c.application_id AND x.revision=c.binding_revision
 JOIN morrow_identity.identity_verification_profiles p ON p.id=c.profile_id AND p.state='active' AND p.provider_id='workos' AND p.environment_id=c.environment_id AND p.application_id=c.application_id AND p.client_id=c.client_id AND p.issuer=c.issuer AND p.token_profile_revision=c.token_profile_revision AND p.token_profile_digest=c.token_profile_digest AND p.record_revision=c.profile_record_revision
 JOIN morrow_identity.workspaces w ON w.id::text=p_workspace AND w.active JOIN morrow_identity.organizations o ON o.id=w.organization_id AND o.active
 WHERE c.configuration_digest=p_configuration AND c.controller_protocol='morrow-login-v1')
$$;
COMMIT;
