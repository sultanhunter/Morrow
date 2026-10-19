BEGIN;
-- P05.T01y session lifecycle (ADR-0004). 0001-0004 stay byte-identical; 0005-0015 were
-- rebaselined once under ADR-0020, whose helpers are this file's only membership reads.
-- New browser families live 12 hours; each generation lives at most 30 idle minutes and
-- never past its family. Rotation retires generation n and issues n+1; presenting a
-- retired generation of a live family revokes the family. Removing an organization
-- membership writes a durable sign-out watermark for that organization. Nothing revives a
-- revoked or expired family. Legacy 15-minute rows keep every byte and never rotate.
-- Executors may already hold LOGIN on an upgraded database (the 0012 flag set).
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT EXISTS(SELECT 1 FROM pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='morrow_identity_logout' AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND morrow_identity.memberships_closed(r.rolname))
 OR EXISTS(SELECT 1 FROM pg_roles r,pg_roles o WHERE o.rolname='morrow_identity_owner' AND (r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance','morrow_identity_logout','morrow_identity_onboarding','morrow_api_worker') OR r.rolname LIKE 'morrow\_work\_%') AND (pg_has_role(r.oid,o.oid,'MEMBER') OR pg_has_role(o.oid,r.oid,'MEMBER')))
 OR to_regprocedure('morrow_identity.admit_account_family(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.account_session_principal(text)') IS NULL
 OR to_regprocedure('morrow_identity.reconcile_login_flow(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.end_self_browser_family(text,text,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.session_eligibility(text,text)') IS NULL
 OR (SELECT count(*) FROM pg_constraint k WHERE k.contype='c' AND (k.conrelid,k.conname::text,pg_get_constraintdef(k.oid)) IN (
   (to_regclass('morrow_identity.browser_session_families'),'browser_session_families_current_generation_check','CHECK (((current_generation)::bigint = 1))'),
   (to_regclass('morrow_identity.browser_session_families'),'browser_session_families_check','CHECK ((isfinite(expires_at) AND (expires_at = (created_at + ''00:15:00''::interval))))'),
   (to_regclass('morrow_identity.browser_session_generations'),'browser_session_generations_generation_check','CHECK (((generation)::bigint = 1))'),
   (to_regclass('morrow_identity.browser_session_generations'),'browser_session_generations_check','CHECK ((isfinite(expires_at) AND (expires_at = (created_at + ''00:15:00''::interval))))')))<>4
 OR NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=to_regclass('morrow_identity.browser_session_audits') AND k.conname='browser_session_audits_reason_check' AND k.contype='c')
 OR to_regclass('morrow_identity.organization_session_signouts') IS NOT NULL
 THEN RAISE EXCEPTION 'SESSION_LIFECYCLE_PREREQUISITES_INVALID'; END IF;
END $$;

-- Lifetimes. The prerequisite block above pinned the four dropped 0008 checks by name and
-- definition (PostgreSQL named the two multi-column expiry checks <table>_check). A legacy
-- family keeps the 0008 shape at generation 1; every other family expires exactly 12 hours
-- after creation. Legacy 15-minute generations satisfy the idle check.
ALTER TABLE morrow_identity.browser_session_families
 DROP CONSTRAINT browser_session_families_current_generation_check,
 DROP CONSTRAINT browser_session_families_check,
 ADD CONSTRAINT browser_session_family_lifetime CHECK(isfinite(expires_at) AND (
  (current_generation=1 AND expires_at=created_at+interval '15 minutes')
  OR (current_generation BETWEEN 1 AND 1000 AND expires_at=created_at+interval '12 hours')));
ALTER TABLE morrow_identity.browser_session_generations
 DROP CONSTRAINT browser_session_generations_generation_check,
 DROP CONSTRAINT browser_session_generations_check,
 ADD CONSTRAINT browser_session_generation_number CHECK(generation BETWEEN 1 AND 1000),
 ADD CONSTRAINT browser_session_generation_idle CHECK(isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '30 minutes');
-- A superset of the 0013 reasons: a rotation is one generation audit, a reuse one family audit.
ALTER TABLE morrow_identity.browser_session_audits DROP CONSTRAINT browser_session_audits_reason_check,
 ADD CONSTRAINT browser_session_audits_reason_check CHECK(reason IN ('admitted','identity_ineligible','evidence_expired','revision_conflict','binding_revoked','digest_conflict','identity_conflict','revoked','already_revoked','enrollment_disabled','enrollment_limited','rotated','reuse_detected'));

-- Append-only organization sign-out watermarks. A family committed at or before a
-- watermark never again resolves a workspace of that organization for that principal.
CREATE TABLE morrow_identity.organization_session_signouts (
 id morrow_identity.record_id PRIMARY KEY,
 organization_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.organizations(id),
 principal_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.principals(id),
 membership_id morrow_identity.record_id NOT NULL,
 cause text NOT NULL CHECK(cause IN ('membership_deactivated','membership_deleted','membership_reassigned')),
 signed_out_at timestamptz NOT NULL CHECK(isfinite(signed_out_at)),
 recorded_by name NOT NULL
);
CREATE INDEX organization_session_signouts_lookup ON morrow_identity.organization_session_signouts(organization_id,principal_id,signed_out_at);
ALTER TABLE morrow_identity.organization_session_signouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_identity.organization_session_signouts FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_owner ON morrow_identity.organization_session_signouts TO morrow_identity_owner USING(true) WITH CHECK(true);
REVOKE ALL ON morrow_identity.organization_session_signouts FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions,morrow_identity_login,morrow_identity_login_maintenance,morrow_identity_logout,morrow_identity_onboarding;
-- The replaceable retention and erasure hook (data-lifecycle.md): P09.T05 replaces it.
CREATE FUNCTION morrow_identity.preserve_session_signout_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'SESSION_SIGNOUT_RECORD_IMMUTABLE';
END $$;
CREATE TRIGGER session_signout_immutable BEFORE UPDATE OR DELETE ON morrow_identity.organization_session_signouts
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_session_signout_record();
CREATE TRIGGER session_signout_no_truncate BEFORE TRUNCATE ON morrow_identity.organization_session_signouts
 FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity.preserve_session_signout_record();
-- Lock order organization -> membership -> principal: the principal is locked FOR SHARE
-- before the watermark is taken. Every family admission reads its creation instant after
-- locking the principal FOR UPDATE, so no family can commit for this principal while the
-- share lock is held. The watermark is the later of the clock and every existing family's
-- created_at for the principal, so no family committed before this removal has created_at
-- later than the watermark, even if the wall clock stepped backward since its admission.
CREATE FUNCTION morrow_identity.record_organization_session_signout() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE cause_value text; instant timestamptz;
BEGIN
 IF NOT OLD.active THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN cause_value:='membership_deleted';
 ELSIF NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN cause_value:='membership_reassigned';
 ELSIF NEW.active IS DISTINCT FROM true THEN cause_value:='membership_deactivated';
 ELSE RETURN NULL; END IF;
 PERFORM 1 FROM morrow_identity.principals WHERE id=OLD.principal_id FOR SHARE;
 SELECT greatest(clock_timestamp(),max(f.created_at)) INTO instant
  FROM morrow_identity.browser_session_families f
  JOIN morrow_identity.provider_session_bindings pb ON pb.id=f.provider_binding_id
  JOIN morrow_identity.provider_subject_mappings sm ON sm.id=pb.mapping_id
  WHERE sm.principal_id=OLD.principal_id;
 INSERT INTO morrow_identity.organization_session_signouts(id,organization_id,principal_id,membership_id,cause,signed_out_at,recorded_by)
  VALUES(gen_random_uuid()::text,OLD.organization_id,OLD.principal_id,OLD.id,cause_value,instant,session_user);
 RETURN NULL;
END $$;
CREATE TRIGGER membership_organization_signout AFTER UPDATE OF active,principal_id,organization_id OR DELETE ON morrow_identity.memberships
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.record_organization_session_signout();

-- Helpers. None is executable by any service role.
CREATE FUNCTION morrow_identity.browser_new_lifetimes(p_instant timestamptz)
RETURNS TABLE(family_expires_at timestamptz,generation_expires_at timestamptz)
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT p_instant+interval '12 hours',p_instant+interval '30 minutes'
$$;
-- A generation fits its family when it starts no earlier, ends no later and lives at most
-- 30 minutes. Legacy rows (equal 15-minute lifetimes) fit.
CREATE FUNCTION morrow_identity.browser_generation_fits_family(p_generation_created timestamptz,p_generation_expires timestamptz,p_family_created timestamptz,p_family_expires timestamptz)
RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT coalesce(p_generation_created>=p_family_created AND p_generation_expires<=p_family_expires
  AND p_generation_expires<=p_generation_created+interval '30 minutes',false)
$$;
-- The 0011 self-session executor check over the current executor set: the session user is
-- the logout executor, the owner and executor flags are safe, the executor's and the
-- owner's memberships are closed (ADR-0020), and no executor (including onboarding, the
-- api Worker login and every morrow_work_ role) has the owner as a member or is a member
-- of it.
CREATE FUNCTION morrow_identity.self_session_role_safe() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT current_user='morrow_identity_owner' AND session_user='morrow_identity_logout'
 AND EXISTS(SELECT 1 FROM pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 AND EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND morrow_identity.executor_memberships_closed(r.rolname))
 AND NOT EXISTS(SELECT 1 FROM pg_roles r,pg_roles o WHERE o.rolname='morrow_identity_owner' AND (r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance','morrow_identity_logout','morrow_identity_onboarding','morrow_api_worker') OR r.rolname LIKE 'morrow\_work\_%') AND (pg_has_role(r.oid,o.oid,'MEMBER') OR pg_has_role(o.oid,r.oid,'MEMBER')))
$$;

-- Generation inserts: only the current number of a live family, with no lower generation
-- still live; generation 1 starts with its family; generation n>=2 starts exactly when the
-- rotated audit of generation n-1 retired it. Every expiry is the reviewed lifetime.
CREATE FUNCTION morrow_identity.check_browser_generation_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE f morrow_identity.browser_session_families%ROWTYPE; retired morrow_identity.browser_session_generations%ROWTYPE;
BEGIN
 SELECT * INTO f FROM morrow_identity.browser_session_families WHERE id=NEW.family_id;
 IF NOT FOUND OR f.revoked_at IS NOT NULL OR NEW.generation IS DISTINCT FROM f.current_generation
   OR NEW.revoked_at IS NOT NULL OR NEW.record_revision IS DISTINCT FROM 1
   OR EXISTS(SELECT 1 FROM morrow_identity.browser_session_generations x WHERE x.family_id=NEW.family_id AND x.generation<NEW.generation AND x.revoked_at IS NULL) THEN
  RAISE EXCEPTION 'BROWSER_SESSION_GENERATION_INVALID';
 END IF;
 IF NEW.generation=1 THEN
  IF NEW.created_at IS DISTINCT FROM f.created_at
    OR NEW.expires_at IS DISTINCT FROM (CASE WHEN f.expires_at=f.created_at+interval '15 minutes' THEN f.expires_at ELSE least(NEW.created_at+interval '30 minutes',f.expires_at) END) THEN
   RAISE EXCEPTION 'BROWSER_SESSION_GENERATION_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO retired FROM morrow_identity.browser_session_generations WHERE family_id=NEW.family_id AND generation=NEW.generation-1;
 IF NOT FOUND OR retired.revoked_at IS DISTINCT FROM NEW.created_at
   OR NEW.expires_at IS DISTINCT FROM least(NEW.created_at+interval '30 minutes',f.expires_at)
   OR NOT EXISTS(SELECT 1 FROM morrow_identity.browser_session_audits a WHERE a.kind='generation' AND a.target_id=retired.id AND a.outcome='revoked' AND a.reason='rotated' AND a.recorded_at=NEW.created_at) THEN
  RAISE EXCEPTION 'BROWSER_SESSION_GENERATION_INVALID';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER browser_session_generation_insert BEFORE INSERT ON morrow_identity.browser_session_generations
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.check_browser_generation_insert();

-- The 0008 trigger with one added branch; its revocation branch is unchanged and also
-- retires generation n on rotation. OR REPLACE keeps the owner, the ACL and the triggers.
CREATE OR REPLACE FUNCTION morrow_identity.preserve_browser_session_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE kind_value text;
BEGIN
 IF TG_OP<>'UPDATE' OR TG_TABLE_NAME IN ('browser_session_commands','browser_session_audits') THEN
  RAISE EXCEPTION 'BROWSER_SESSION_RECORD_IMMUTABLE';
 END IF;
 kind_value:=CASE TG_TABLE_NAME WHEN 'provider_session_bindings' THEN 'provider_binding' WHEN 'browser_session_families' THEN 'family' WHEN 'browser_session_generations' THEN 'generation' END;
 -- P05.T01y family advance: a rotation moves the current generation by exactly one and
 -- changes nothing else. It names the rotated audit of the generation it retires.
 IF TG_TABLE_NAME='browser_session_families' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL THEN
  IF OLD.expires_at<>OLD.created_at+interval '12 hours'
    OR NEW.current_generation<>OLD.current_generation+1 OR NEW.current_generation>1000
    OR NEW.record_revision<>OLD.record_revision+1
    OR (to_jsonb(NEW)-'current_generation'-'record_revision') IS DISTINCT FROM (to_jsonb(OLD)-'current_generation'-'record_revision')
    OR NOT EXISTS(SELECT 1 FROM morrow_identity.browser_session_audits a
      JOIN morrow_identity.browser_session_generations x ON x.id=a.target_id
      WHERE a.id::text=pg_catalog.current_setting('morrow.browser_revocation_audit',true)
        AND a.kind='generation' AND a.outcome='revoked' AND a.reason='rotated'
        AND x.family_id=OLD.id AND x.generation=OLD.current_generation
        AND x.revoked_at=a.recorded_at AND a.recorded_at<OLD.expires_at) THEN
   RAISE EXCEPTION 'BROWSER_SESSION_ADVANCE_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF kind_value IS NULL OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
   OR NOT isfinite(NEW.revoked_at) OR NEW.revoked_at<OLD.created_at
   OR NEW.record_revision<>OLD.record_revision+1
   OR (to_jsonb(NEW)-'revoked_at'-'record_revision') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'record_revision')
   OR NOT EXISTS(SELECT 1 FROM morrow_identity.browser_session_audits a
     WHERE a.id::text=pg_catalog.current_setting('morrow.browser_revocation_audit',true)
       AND a.kind=kind_value AND a.target_id=OLD.id AND a.outcome='revoked' AND a.recorded_at=NEW.revoked_at) THEN
  RAISE EXCEPTION 'BROWSER_SESSION_REVOCATION_INVALID';
 END IF;
 RETURN NEW;
END $$;

-- Same signatures, result types, owners and ACLs; only the reviewed lines differ
-- (tests/fixtures/session-lifecycle-replacements.mjs).
CREATE OR REPLACE FUNCTION morrow_identity.session_eligibility(p_digest text,p_workspace text)
RETURNS TABLE(principal_id text,organization_id text,workspace_id text,membership_id text,policy_revision bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 WITH unambiguous AS (
  SELECT (SELECT count(*) FROM morrow_identity.sessions s WHERE s.session_digest=p_digest)
       + (SELECT count(*) FROM morrow_identity.browser_session_generations g WHERE g.secret_digest=p_digest)=1 AS eligible
 )
 SELECT p.id::text,o.id::text,w.id::text,m.id::text,o.policy_revision::bigint
 FROM morrow_identity.sessions s
 JOIN morrow_identity.principals p ON p.id=s.principal_id AND p.active AND p.kind='human'
 JOIN morrow_identity.organizations o ON o.id=s.organization_id AND o.active
 JOIN morrow_identity.memberships m ON m.organization_id=o.id AND m.principal_id=p.id AND m.active
 JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=o.id AND wm.membership_id=m.id AND wm.active
 JOIN morrow_identity.workspaces w ON w.organization_id=o.id AND w.id=wm.workspace_id AND w.active
 WHERE (SELECT eligible FROM unambiguous) AND s.session_digest=p_digest AND w.id::text=p_workspace
   AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM morrow_identity.organization_session_signouts x WHERE x.organization_id=o.id AND x.principal_id=p.id)
 UNION ALL
 SELECT p.id::text,o.id::text,w.id::text,m.id::text,o.policy_revision::bigint
 FROM morrow_identity.browser_session_generations g
 JOIN morrow_identity.browser_session_families f ON f.id=g.family_id AND f.current_generation=g.generation
 JOIN morrow_identity.provider_session_bindings pb ON pb.id=f.provider_binding_id AND pb.revoked_at IS NULL
 JOIN morrow_identity.identity_verification_profiles v ON v.id=pb.profile_id AND v.provider_id=pb.provider_id
   AND v.environment_id=pb.environment_id AND v.client_id=pb.client_id AND v.state='active' AND v.record_revision=f.profile_record_revision
 JOIN morrow_identity.provider_subject_mappings sm ON sm.id=pb.mapping_id AND sm.provider_id=pb.provider_id
   AND sm.environment_id=pb.environment_id AND sm.state='active' AND sm.record_revision=f.mapping_revision
 JOIN morrow_identity.provider_subject_profile_bindings b ON b.profile_id=v.id AND b.mapping_id=sm.id
   AND b.provider_id=pb.provider_id AND b.environment_id=pb.environment_id AND b.state='active' AND b.record_revision=f.binding_revision
 JOIN morrow_identity.principals p ON p.id=sm.principal_id AND p.active AND p.kind='human'
 JOIN morrow_identity.memberships m ON m.principal_id=p.id AND m.active
 JOIN morrow_identity.organizations o ON o.id=m.organization_id AND o.active
 JOIN morrow_identity.workspaces w ON w.organization_id=o.id AND w.id::text=p_workspace AND w.active
 JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=o.id AND wm.workspace_id=w.id AND wm.membership_id=m.id AND wm.active
 WHERE (SELECT eligible FROM unambiguous) AND g.secret_digest=p_digest AND g.revoked_at IS NULL AND f.revoked_at IS NULL
   AND morrow_identity.browser_generation_fits_family(g.created_at,g.expires_at,f.created_at,f.expires_at)
   AND NOT EXISTS(SELECT 1 FROM morrow_identity.organization_session_signouts x WHERE x.organization_id=o.id AND x.principal_id=p.id AND x.signed_out_at>=f.created_at)
   AND pb.created_at<=clock_timestamp() AND f.created_at<=clock_timestamp() AND g.created_at<=clock_timestamp()
   AND g.expires_at>clock_timestamp() AND f.expires_at>clock_timestamp()
$$;
CREATE OR REPLACE FUNCTION morrow_identity.end_self_browser_family(
 p_command text,p_request_digest text,p_configuration_digest text,p_environment text,
 p_application text,p_client text,p_profile text,p_session_digest text)
RETURNS TABLE(outcome text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE pb morrow_identity.provider_session_bindings%ROWTYPE;
 f morrow_identity.browser_session_families%ROWTYPE;
 g morrow_identity.browser_session_generations%ROWTYPE;
 previous morrow_identity.browser_session_audits%ROWTYPE;
 candidate_provider text; candidate_family text; candidate_generation text;
 effect record; original_audit text; audit_count bigint; instant timestamptz;
BEGIN
 IF current_user<>'morrow_identity_owner' OR session_user<>'morrow_identity_logout'
 OR NOT EXISTS(SELECT 1 FROM pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND morrow_identity.executor_memberships_closed(r.rolname))
 OR EXISTS(SELECT 1 FROM pg_roles r,pg_roles o WHERE o.rolname='morrow_identity_owner' AND r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance','morrow_identity_logout') AND (pg_has_role(r.oid,o.oid,'MEMBER') OR pg_has_role(o.oid,r.oid,'MEMBER'))) THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN;
 END IF;
 IF p_command IS NULL OR p_request_digest IS NULL OR p_configuration_digest IS NULL OR p_environment IS NULL OR p_application IS NULL OR p_client IS NULL OR p_profile IS NULL OR p_session_digest IS NULL
 OR p_command !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
 OR p_request_digest !~ '^[a-f0-9]{64}$' OR p_configuration_digest !~ '^[a-f0-9]{64}$' OR p_session_digest !~ '^[a-f0-9]{64}$'
 OR p_environment !~ '^environment_[A-Z0-9]{26}$' OR p_application !~ '^app_[A-Z0-9]{26}$' OR p_client !~ '^client_[A-Z0-9]{26}$'
 OR p_profile !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF encode(sha256(convert_to(array_to_json(ARRAY['morrow.browser.self_logout','1',p_command,p_configuration_digest,'workos',p_environment,p_application,p_client,p_profile,p_session_digest])::text,'UTF8')),'hex')<>p_request_digest THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 -- Discover only immutable ownership before taking any target lock. Mutable
 -- profile/principal/membership state and expired credentials do not bar retirement.
 SELECT x.id::text,b.id::text,a.id::text INTO candidate_provider,candidate_family,candidate_generation
 FROM morrow_identity.browser_session_generations a
 JOIN morrow_identity.browser_session_families b ON b.id=a.family_id
 JOIN morrow_identity.provider_session_bindings x ON x.id=b.provider_binding_id
 JOIN morrow_identity.identity_verification_profiles v ON v.id=x.profile_id
 WHERE a.secret_digest=p_session_digest AND v.id::text=p_profile
 AND x.provider_id='workos' AND v.provider_id=x.provider_id
 AND x.environment_id=p_environment AND v.environment_id=x.environment_id
 AND x.client_id=p_client AND v.client_id=x.client_id AND v.application_id=p_application;
 IF candidate_provider IS NULL THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('browser-command:'||p_command,0));
 SELECT * INTO previous FROM morrow_identity.browser_session_audits WHERE command_id::text=p_command;
 IF FOUND AND (previous.kind IS DISTINCT FROM 'family' OR previous.target_id::text IS DISTINCT FROM candidate_family OR previous.request_digest IS DISTINCT FROM p_request_digest) THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT * INTO pb FROM morrow_identity.provider_session_bindings WHERE id::text=candidate_provider;
 PERFORM pg_advisory_xact_lock(hashtextextended('browser-provider:'||array_to_json(ARRAY[pb.provider_id,pb.environment_id,pb.client_id,pb.provider_session_id])::text,0));
 SELECT * INTO pb FROM morrow_identity.provider_session_bindings WHERE id::text=candidate_provider FOR UPDATE;
 SELECT * INTO f FROM morrow_identity.browser_session_families WHERE id::text=candidate_family FOR UPDATE;
 SELECT * INTO g FROM morrow_identity.browser_session_generations WHERE id::text=candidate_generation FOR UPDATE;
 SELECT * INTO previous FROM morrow_identity.browser_session_audits WHERE command_id::text=p_command;
 IF FOUND AND (previous.kind IS DISTINCT FROM 'family' OR previous.target_id::text IS DISTINCT FROM candidate_family OR previous.request_digest IS DISTINCT FROM p_request_digest) THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 instant:=clock_timestamp();
 IF current_user<>'morrow_identity_owner' OR session_user<>'morrow_identity_logout'
 OR NOT EXISTS(SELECT 1 FROM pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND morrow_identity.executor_memberships_closed(r.rolname))
 OR EXISTS(SELECT 1 FROM pg_roles r,pg_roles o WHERE o.rolname='morrow_identity_owner' AND r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance','morrow_identity_logout') AND (pg_has_role(r.oid,o.oid,'MEMBER') OR pg_has_role(o.oid,r.oid,'MEMBER')))
 OR pb.id IS NULL OR f.id IS NULL OR g.id IS NULL OR f.provider_binding_id<>pb.id OR g.family_id<>f.id OR g.secret_digest<>p_session_digest OR g.generation>f.current_generation
 OR NOT morrow_identity.browser_generation_fits_family(g.created_at,g.expires_at,f.created_at,f.expires_at) OR NOT isfinite(pb.created_at) OR NOT isfinite(f.created_at) OR NOT isfinite(g.created_at) OR NOT isfinite(f.expires_at) OR NOT isfinite(g.expires_at)
 OR pb.created_at>instant OR f.created_at>instant OR g.created_at>instant
 OR (SELECT count(*) FROM morrow_identity.sessions WHERE session_digest=p_session_digest)+(SELECT count(*) FROM morrow_identity.browser_session_generations WHERE secret_digest=p_session_digest)<>1
 OR NOT EXISTS(SELECT 1 FROM morrow_identity.identity_verification_profiles v WHERE v.id=pb.profile_id AND v.id::text=p_profile AND pb.provider_id='workos' AND v.provider_id=pb.provider_id AND pb.environment_id=p_environment AND v.environment_id=pb.environment_id AND pb.client_id=p_client AND v.client_id=pb.client_id AND v.application_id=p_application) THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 -- Do not ask the old helper to manufacture an already_revoked audit. This is
 -- state correlation only: a fresh no-op command is deliberately not reserved.
 IF f.revoked_at IS NOT NULL THEN
  SELECT count(*),min(a.id::text) INTO audit_count,original_audit FROM morrow_identity.browser_session_audits a WHERE a.kind='family' AND a.target_id=f.id AND a.outcome='revoked' AND a.recorded_at=f.revoked_at;
  IF audit_count=1 THEN RETURN QUERY SELECT 'ended'::text,original_audit; ELSE RETURN QUERY SELECT 'denied'::text,NULL::text; END IF; RETURN;
 END IF;
 BEGIN
  SELECT * INTO effect FROM morrow_identity.revoke_browser_family(f.id::text,p_command,p_request_digest);
  SELECT * INTO f FROM morrow_identity.browser_session_families WHERE id::text=candidate_family;
  IF effect.outcome IS DISTINCT FROM 'applied' OR effect.audit_id IS NULL
   OR NOT EXISTS(SELECT 1 FROM morrow_identity.browser_session_audits a WHERE a.id::text=effect.audit_id AND a.command_id::text=p_command AND a.request_digest=p_request_digest AND a.kind='family' AND a.target_id=f.id AND a.outcome='revoked' AND a.recorded_at=f.revoked_at)
   OR (SELECT count(*) FROM morrow_identity.browser_session_audits a WHERE a.kind='family' AND a.target_id=f.id AND a.outcome='revoked' AND a.recorded_at=f.revoked_at)<>1
   OR (SELECT count(*) FROM morrow_identity.sessions WHERE session_digest=p_session_digest)+(SELECT count(*) FROM morrow_identity.browser_session_generations WHERE secret_digest=p_session_digest)<>1
   OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND morrow_identity.executor_memberships_closed(r.rolname))
   OR current_user<>'morrow_identity_owner' OR session_user<>'morrow_identity_logout'
   OR NOT EXISTS(SELECT 1 FROM pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
   OR EXISTS(SELECT 1 FROM pg_roles r,pg_roles o WHERE o.rolname='morrow_identity_owner' AND r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance','morrow_identity_logout') AND (pg_has_role(r.oid,o.oid,'MEMBER') OR pg_has_role(o.oid,r.oid,'MEMBER')))
   OR g.family_id<>f.id OR f.provider_binding_id<>pb.id OR g.generation>f.current_generation OR NOT morrow_identity.browser_generation_fits_family(g.created_at,g.expires_at,f.created_at,f.expires_at)
   OR NOT EXISTS(SELECT 1 FROM morrow_identity.identity_verification_profiles v WHERE v.id=pb.profile_id AND v.id::text=p_profile AND pb.provider_id='workos' AND v.provider_id=pb.provider_id AND pb.environment_id=p_environment AND v.environment_id=pb.environment_id AND pb.client_id=p_client AND v.client_id=pb.client_id AND v.application_id=p_application) THEN
   RAISE EXCEPTION 'SELF_LOGOUT_BINDING_DENIED';
  END IF;
  RETURN QUERY SELECT 'ended'::text,effect.audit_id::text; RETURN;
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'SELF_LOGOUT_BINDING_DENIED' THEN RAISE; END IF;
 END;
 RETURN QUERY SELECT 'denied'::text,NULL::text;
END $$;
CREATE OR REPLACE FUNCTION morrow_identity.account_session_principal(p_digest text) RETURNS TABLE(principal_id text,profile_id text)
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT p.id::text,v.id::text
 FROM morrow_identity.browser_session_generations g
 JOIN morrow_identity.browser_session_families f ON f.id=g.family_id AND f.current_generation=g.generation
 JOIN morrow_identity.provider_session_bindings pb ON pb.id=f.provider_binding_id AND pb.revoked_at IS NULL
 JOIN morrow_identity.identity_verification_profiles v ON v.id=pb.profile_id AND v.provider_id=pb.provider_id
   AND v.environment_id=pb.environment_id AND v.client_id=pb.client_id AND v.state='active' AND v.record_revision=f.profile_record_revision
 JOIN morrow_identity.provider_subject_mappings sm ON sm.id=pb.mapping_id AND sm.provider_id=pb.provider_id
   AND sm.environment_id=pb.environment_id AND sm.state='active' AND sm.record_revision=f.mapping_revision
 JOIN morrow_identity.provider_subject_profile_bindings b ON b.profile_id=v.id AND b.mapping_id=sm.id
   AND b.provider_id=pb.provider_id AND b.environment_id=pb.environment_id AND b.state='active' AND b.record_revision=f.binding_revision
 JOIN morrow_identity.principals p ON p.id=sm.principal_id AND p.active AND p.kind='human'
 WHERE p_digest ~ '^[a-f0-9]{64}$'
   AND (SELECT count(*) FROM morrow_identity.sessions s WHERE s.session_digest=p_digest)
     + (SELECT count(*) FROM morrow_identity.browser_session_generations x WHERE x.secret_digest=p_digest)=1
   AND g.secret_digest=p_digest AND g.revoked_at IS NULL AND f.revoked_at IS NULL
   AND morrow_identity.browser_generation_fits_family(g.created_at,g.expires_at,f.created_at,f.expires_at)
   AND pb.created_at<=clock_timestamp() AND f.created_at<=clock_timestamp() AND g.created_at<=clock_timestamp()
   AND g.expires_at>clock_timestamp() AND f.expires_at>clock_timestamp()
$$;
CREATE OR REPLACE FUNCTION morrow_identity.reconcile_login_flow(p_configuration text,p_flow text,p_begin text,p_admission text,p_issuer text)
RETURNS TABLE(outcome text,phase text,flow_revision text,expires_at_ms text,admission_id text,issuer_request_digest text,issuer_outcome text,family_id text,generation_id text,provider_binding_id text,family_expires_at_ms text,issuer_audit_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE base record;f morrow_identity.login_flows%ROWTYPE;c morrow_identity.login_controller_configurations%ROWTYPE;m morrow_identity.account_session_commands%ROWTYPE;found_m boolean;BEGIN
 SELECT * INTO base FROM morrow_identity.reconcile_workspace_login_flow(p_configuration,p_flow,p_begin,p_admission,p_issuer);
 IF base.outcome IS DISTINCT FROM 'observed' THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 SELECT * INTO f FROM morrow_identity.login_flows WHERE id::text=p_flow AND configuration_digest=p_configuration AND begin_command_id::text=p_begin AND admission_command_id::text=p_admission AND issuer_command_id::text=p_issuer;
 IF NOT FOUND THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 IF f.workspace_id IS NOT NULL THEN
  RETURN QUERY SELECT base.outcome,base.phase,base.flow_revision,base.expires_at_ms,base.admission_id,base.issuer_request_digest,base.issuer_outcome,base.family_id,base.generation_id,base.provider_binding_id,base.family_expires_at_ms,base.issuer_audit_id;RETURN;
 END IF;
 IF base.issuer_outcome IS NOT NULL OR EXISTS(SELECT 1 FROM morrow_identity.browser_session_commands r WHERE r.command_id::text=p_issuer) THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 SELECT * INTO c FROM morrow_identity.login_controller_configurations WHERE configuration_digest=p_configuration;
 SELECT * INTO m FROM morrow_identity.account_session_commands WHERE command_id::text=p_issuer;found_m:=FOUND;
 IF found_m THEN
 IF (SELECT count(*) FROM jsonb_array_elements(m.request_tuple) e WHERE jsonb_typeof(e)='string')<>20 OR m.request_digest IS DISTINCT FROM encode(sha256(convert_to(array_to_json(ARRAY(SELECT e.value#>>'{}' FROM jsonb_array_elements(m.request_tuple) WITH ORDINALITY e(value,n) ORDER BY e.n))::text,'UTF8')),'hex') OR base.admission_id IS NULL OR m.request_tuple->>0 IS DISTINCT FROM p_issuer OR m.request_tuple->>1 IS DISTINCT FROM 'workos' OR m.request_tuple->>2 IS DISTINCT FROM c.environment_id OR m.request_tuple->>3 IS DISTINCT FROM c.application_id OR m.request_tuple->>4 IS DISTINCT FROM c.client_id OR m.request_tuple->>5 IS DISTINCT FROM c.issuer OR m.request_tuple->>6 IS DISTINCT FROM c.token_profile_revision::text OR m.request_tuple->>7 IS DISTINCT FROM c.token_profile_digest OR m.request_tuple->>16 IS DISTINCT FROM c.profile_id::text OR m.request_tuple->>17 IS DISTINCT FROM c.profile_record_revision::text OR NOT EXISTS(SELECT 1 FROM morrow_identity.browser_session_audits a WHERE a.id=m.audit_id AND a.command_id=m.command_id AND a.request_digest=m.request_digest AND a.kind='admit' AND a.outcome=m.outcome AND a.target_id IS NOT DISTINCT FROM m.family_id) THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 IF m.outcome='admitted' AND (m.request_tuple->>18 IS DISTINCT FROM m.family_id::text OR m.request_tuple->>19 IS DISTINCT FROM m.generation_id::text OR NOT EXISTS(SELECT 1 FROM morrow_identity.browser_session_families bf JOIN morrow_identity.browser_session_generations g ON g.family_id=bf.id JOIN morrow_identity.provider_session_bindings pb ON pb.id=bf.provider_binding_id JOIN morrow_identity.provider_subject_mappings sm ON sm.id=pb.mapping_id WHERE bf.id=m.family_id AND g.id=m.generation_id AND pb.id=m.provider_binding_id AND pb.provider_id='workos' AND pb.environment_id=c.environment_id AND pb.client_id=c.client_id AND pb.profile_id=c.profile_id AND pb.provider_session_id=m.request_tuple->>9 AND sm.subject_id=m.request_tuple->>8 AND g.generation=1 AND g.expires_at=m.expires_at AND morrow_identity.browser_generation_fits_family(g.created_at,g.expires_at,bf.created_at,bf.expires_at))) THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 END IF;
 RETURN QUERY SELECT 'observed'::text,base.phase,base.flow_revision,base.expires_at_ms,base.admission_id,CASE WHEN found_m THEN m.request_digest END,CASE WHEN found_m THEN m.outcome END,m.family_id::text,m.generation_id::text,m.provider_binding_id::text,CASE WHEN m.expires_at IS NOT NULL THEN floor(extract(epoch FROM m.expires_at)*1000)::bigint::text END,m.audit_id::text;
END $$;
CREATE OR REPLACE FUNCTION morrow_identity.admit_account_family(
 p_command text,p_request_digest text,p_provider text,p_environment text,p_application text,p_client text,p_issuer text,
 p_token_revision text,p_token_digest text,p_subject text,p_provider_session text,
 p_evidence_issued text,p_evidence_observed text,p_evidence_expires text,p_keyset_digest text,p_observation_digest text,p_secret_digest text,
 p_profile_id text,p_profile_record_revision text,p_family_id text,p_generation_id text)
RETURNS TABLE(outcome text,family_id text,generation_id text,provider_binding_id text,expires_at_ms text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
 tuple_values text[]; previous morrow_identity.account_session_commands%ROWTYPE;
 v morrow_identity.identity_verification_profiles%ROWTYPE; sm morrow_identity.provider_subject_mappings%ROWTYPE;
 b morrow_identity.provider_subject_profile_bindings%ROWTYPE; pb morrow_identity.provider_session_bindings%ROWTYPE;
 person morrow_identity.principals%ROWTYPE;
 reason_code text:='identity_ineligible'; enrollment_kind text; instant timestamptz; expiry timestamptz; family_expiry timestamptz;
 audit_key text; provider_key text; principal_key text; mapping_key text; mapping_revision bigint; binding_revision bigint;
 n numeric; value text; succeeded boolean:=false;
BEGIN
 IF NOT morrow_identity.browser_sessions_role_safe() THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 tuple_values:=ARRAY[p_command,p_provider,p_environment,p_application,p_client,p_issuer,p_token_revision,p_token_digest,p_subject,p_provider_session,p_evidence_issued,p_evidence_observed,p_evidence_expires,p_keyset_digest,p_observation_digest,p_secret_digest,p_profile_id,p_profile_record_revision,p_family_id,p_generation_id];
 IF array_position(tuple_values,NULL) IS NOT NULL OR p_request_digest IS NULL
   OR p_provider<>'workos' OR p_environment !~ '^environment_[A-Z0-9]{26}$' OR p_application !~ '^app_[A-Z0-9]{26}$'
   OR p_client !~ '^client_[A-Z0-9]{26}$' OR p_issuer<>'https://api.workos.com/user_management/'||p_client
   OR p_subject !~ '^user_[A-Z0-9]{26}$' OR p_provider_session !~ '^session_[A-Z0-9]{26}$'
   OR p_family_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_generation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   OR p_family_id=p_generation_id THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 FOREACH value IN ARRAY ARRAY[p_command,p_profile_id] LOOP
  IF value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 END LOOP;
 FOREACH value IN ARRAY ARRAY[p_request_digest,p_token_digest,p_keyset_digest,p_observation_digest,p_secret_digest] LOOP
  IF value !~ '^[a-f0-9]{64}$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 END LOOP;
 FOREACH value IN ARRAY ARRAY[p_token_revision,p_profile_record_revision] LOOP
  IF value !~ '^[1-9][0-9]{0,15}$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
  IF value::numeric>9007199254740991 THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 END LOOP;
 FOREACH value IN ARRAY ARRAY[p_evidence_issued,p_evidence_observed,p_evidence_expires] LOOP
  IF value !~ '^(0|[1-9][0-9]{0,15})$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
  IF value::numeric>8640000000000000 THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 END LOOP;
 IF p_evidence_expires::numeric<=p_evidence_observed::numeric
   OR p_evidence_expires::numeric>p_evidence_observed::numeric+5000
   OR p_evidence_issued::numeric>p_evidence_observed::numeric+30000
   OR encode(sha256(convert_to(array_to_json(tuple_values)::text,'UTF8')),'hex')<>p_request_digest THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 -- (1) One global command namespace shared with 0008 admission, revocation and logout.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('browser-command:'||p_command,0));
 SELECT * INTO previous FROM morrow_identity.account_session_commands WHERE command_id::text=p_command;
 IF FOUND THEN
  IF previous.request_digest<>p_request_digest OR previous.request_tuple<>to_jsonb(tuple_values) THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  ELSIF previous.outcome='admitted' THEN
   RETURN QUERY SELECT 'replayed'::text,previous.family_id::text,previous.generation_id::text,previous.provider_binding_id::text,floor(extract(epoch FROM previous.expires_at)*1000)::text,previous.audit_id::text;
  ELSE RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; END IF;
  RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM morrow_identity.browser_session_commands WHERE command_id::text=p_command)
   OR EXISTS(SELECT 1 FROM morrow_identity.browser_session_audits WHERE command_id::text=p_command) THEN
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 <<qualification>> BEGIN
  -- (2) provider namespace, (3) provider subject, (4) provider binding (may be absent).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('browser-provider:'||array_to_json(ARRAY[p_provider,p_environment,p_client,p_provider_session])::text,0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('provider-subject:'||array_to_json(ARRAY[p_provider,p_environment,p_subject])::text,0));
  SELECT * INTO pb FROM morrow_identity.provider_session_bindings WHERE provider_id=p_provider AND environment_id=p_environment AND client_id=p_client AND provider_session_id=p_provider_session FOR UPDATE;
  -- (5) The exact evidence profile; its row lock serializes the enrollment window.
  SELECT * INTO v FROM morrow_identity.identity_verification_profiles WHERE id::text=p_profile_id
    AND provider_id=p_provider AND environment_id=p_environment AND application_id=p_application AND client_id=p_client AND issuer=p_issuer
    AND token_profile_revision::text=p_token_revision AND token_profile_digest=p_token_digest FOR UPDATE;
  IF NOT FOUND OR v.state<>'active' OR v.record_revision::text<>p_profile_record_revision THEN reason_code:='revision_conflict'; EXIT qualification; END IF;
  -- (6) The mapping of the verified subject.
  SELECT * INTO sm FROM morrow_identity.provider_subject_mappings WHERE provider_id=p_provider AND environment_id=p_environment AND subject_id=p_subject FOR UPDATE;
  IF FOUND THEN
   -- (7)-(8) An existing mapping signs in only through its existing active binding to this
   -- exact profile. A binding is never added and nothing is reactivated.
   SELECT * INTO b FROM morrow_identity.provider_subject_profile_bindings WHERE mapping_id=sm.id AND profile_id=v.id FOR UPDATE;
   IF NOT FOUND THEN EXIT qualification; END IF;
   SELECT * INTO person FROM morrow_identity.principals WHERE id=sm.principal_id FOR UPDATE;
   IF NOT FOUND OR sm.state<>'active' OR b.state<>'active' OR b.provider_id<>p_provider OR b.environment_id<>p_environment
      OR NOT person.active OR person.kind<>'human' THEN EXIT qualification; END IF;
   enrollment_kind:='existing'; mapping_key:=sm.id::text; principal_key:=sm.principal_id::text;
   mapping_revision:=sm.record_revision; binding_revision:=b.record_revision;
  ELSE
   IF (SELECT s.enrollment FROM morrow_identity.self_service_current(v.id::text) s)<>'enabled' THEN reason_code:='enrollment_disabled'; EXIT qualification; END IF;
   instant:=clock_timestamp();
   IF (SELECT count(*) FROM morrow_identity.account_enrollments e WHERE e.profile_id=v.id AND e.recorded_at>instant-interval '10 minutes')>=30
      OR (SELECT count(*) FROM morrow_identity.account_enrollments e WHERE e.profile_id=v.id AND e.recorded_at>instant-interval '24 hours')>=500 THEN
    reason_code:='enrollment_limited'; EXIT qualification; END IF;
   enrollment_kind:='enrolled'; mapping_key:=gen_random_uuid()::text; principal_key:=gen_random_uuid()::text;
   mapping_revision:=1; binding_revision:=1;
  END IF;
  instant:=clock_timestamp(); n:=floor(extract(epoch FROM instant)*1000);
  IF p_evidence_observed::numeric>n OR p_evidence_expires::numeric<=n THEN reason_code:='evidence_expired'; EXIT qualification; END IF;
  IF pb.id IS NOT NULL AND (pb.mapping_id::text<>mapping_key OR pb.profile_id<>v.id) THEN reason_code:='identity_conflict'; EXIT qualification; END IF;
  IF pb.id IS NOT NULL AND pb.revoked_at IS NOT NULL THEN reason_code:='binding_revoked'; EXIT qualification; END IF;
  IF pb.id IS NOT NULL AND pb.created_at>instant THEN EXIT qualification; END IF;
  IF EXISTS(SELECT 1 FROM morrow_identity.sessions WHERE session_digest=p_secret_digest) THEN reason_code:='digest_conflict'; EXIT qualification; END IF;
  reason_code:='admitted';
 END qualification;
 audit_key:=gen_random_uuid()::text;
 IF reason_code='admitted' THEN
  BEGIN
   instant:=clock_timestamp(); n:=floor(extract(epoch FROM instant)*1000);
   IF p_evidence_observed::numeric>n OR p_evidence_expires::numeric<=n THEN RAISE SQLSTATE 'MR001'; END IF;
   IF enrollment_kind='enrolled' THEN
    INSERT INTO morrow_identity.principals(id,kind,active) VALUES(principal_key,'human',true);
    INSERT INTO morrow_identity.provider_subject_mappings(id,provider_id,environment_id,subject_id,principal_id,record_revision,state)
     VALUES(mapping_key,p_provider,p_environment,p_subject,principal_key,1,'active');
    INSERT INTO morrow_identity.provider_subject_profile_bindings(mapping_id,profile_id,provider_id,environment_id,record_revision,state)
     VALUES(mapping_key,v.id,p_provider,p_environment,1,'active');
    INSERT INTO morrow_identity.account_enrollments(principal_id,mapping_id,profile_id,command_id,recorded_at)
     VALUES(principal_key,mapping_key,v.id,p_command,instant);
   END IF;
   IF pb.id IS NULL THEN
    provider_key:=gen_random_uuid()::text;
    INSERT INTO morrow_identity.provider_session_bindings(id,provider_id,environment_id,client_id,provider_session_id,mapping_id,profile_id,created_at)
     VALUES(provider_key,p_provider,p_environment,p_client,p_provider_session,mapping_key,v.id,instant);
   ELSE provider_key:=pb.id::text; END IF;
   SELECT l.family_expires_at,l.generation_expires_at INTO family_expiry,expiry FROM morrow_identity.browser_new_lifetimes(instant) l;
   INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,created_at,expires_at)
    VALUES(p_family_id,provider_key,v.record_revision,mapping_revision,binding_revision,instant,family_expiry);
   INSERT INTO morrow_identity.browser_session_generations(id,family_id,secret_digest,created_at,expires_at)
    VALUES(p_generation_id,p_family_id,p_secret_digest,instant,expiry);
   INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at)
    VALUES(audit_key,p_command,p_request_digest,'admit',p_family_id,'admitted','admitted',instant);
   INSERT INTO morrow_identity.account_session_commands(command_id,request_digest,request_tuple,outcome,enrollment,family_id,generation_id,provider_binding_id,expires_at,audit_id,recorded_at)
    VALUES(p_command,p_request_digest,to_jsonb(tuple_values),'admitted',enrollment_kind,p_family_id,p_generation_id,provider_key,expiry,audit_key,instant);
   -- Covers every late UNIQUE/FK/row wait inside the persistence subtransaction.
   IF p_evidence_expires::numeric<=floor(extract(epoch FROM clock_timestamp())*1000) THEN RAISE SQLSTATE 'MR001'; END IF;
   succeeded:=true;
  EXCEPTION WHEN SQLSTATE 'MR001' THEN reason_code:='evidence_expired';
   WHEN unique_violation THEN reason_code:='identity_conflict';
  END;
 END IF;
 IF succeeded THEN
  RETURN QUERY SELECT 'newly_admitted'::text,p_family_id,p_generation_id,provider_key,floor(extract(epoch FROM expiry)*1000)::text,audit_key; RETURN;
 END IF;
 instant:=clock_timestamp();
 INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at)
  VALUES(audit_key,p_command,p_request_digest,'admit',NULL,'denied',reason_code,instant);
 INSERT INTO morrow_identity.account_session_commands(command_id,request_digest,request_tuple,outcome,audit_id,recorded_at)
  VALUES(p_command,p_request_digest,to_jsonb(tuple_values),'denied',audit_key,instant);
 RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
END $$;

-- Self rotation (section 3). Denials write nothing; only rotated and reuse_revoked write.
CREATE FUNCTION morrow_identity.rotate_self_browser_generation(
 p_command text,p_request_digest text,p_configuration_digest text,p_environment text,
 p_application text,p_client text,p_profile text,p_presented_digest text,p_new_digest text,p_new_generation text)
RETURNS TABLE(outcome text,idle_expires_at_ms text,absolute_expires_at_ms text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE pb morrow_identity.provider_session_bindings%ROWTYPE;
 f morrow_identity.browser_session_families%ROWTYPE;
 g morrow_identity.browser_session_generations%ROWTYPE;
 cur morrow_identity.browser_session_generations%ROWTYPE;
 candidate_provider text; candidate_family text; candidate_generation text; candidate_principal text;
 fast_idle timestamptz; fast_absolute timestamptz; instant timestamptz; expiry timestamptz;
 audit_key text; prior_setting text; applied boolean:=false;
BEGIN
 -- (1) The exact executor.
 IF NOT morrow_identity.self_session_role_safe() THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 -- (2) Closed shapes and the request digest.
 IF p_command IS NULL OR p_request_digest IS NULL OR p_configuration_digest IS NULL OR p_environment IS NULL OR p_application IS NULL
 OR p_client IS NULL OR p_profile IS NULL OR p_presented_digest IS NULL OR p_new_digest IS NULL OR p_new_generation IS NULL
 OR p_command !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_new_generation !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_command=p_new_generation
 OR p_request_digest !~ '^[a-f0-9]{64}$' OR p_configuration_digest !~ '^[a-f0-9]{64}$' OR p_presented_digest !~ '^[a-f0-9]{64}$' OR p_new_digest !~ '^[a-f0-9]{64}$'
 OR p_presented_digest=p_new_digest
 OR p_environment !~ '^environment_[A-Z0-9]{26}$' OR p_application !~ '^app_[A-Z0-9]{26}$' OR p_client !~ '^client_[A-Z0-9]{26}$'
 OR p_profile !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 IF encode(sha256(convert_to(array_to_json(ARRAY['morrow.browser.self_rotate','1',p_command,p_configuration_digest,'workos',p_environment,p_application,p_client,p_profile,p_presented_digest,p_new_digest,p_new_generation])::text,'UTF8')),'hex')<>p_request_digest THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 -- (3) Unambiguous digests: the presented one is held by exactly one representation and
 -- the new one by none.
 IF (SELECT count(*) FROM morrow_identity.sessions WHERE session_digest=p_presented_digest)+(SELECT count(*) FROM morrow_identity.browser_session_generations WHERE secret_digest=p_presented_digest)<>1
 OR EXISTS(SELECT 1 FROM morrow_identity.sessions WHERE session_digest=p_new_digest)
 OR EXISTS(SELECT 1 FROM morrow_identity.browser_session_generations WHERE secret_digest=p_new_digest) THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 -- (4) Immutable ownership only (the 0011 join).
 SELECT x.id::text,b.id::text,a.id::text,sm.principal_id::text INTO candidate_provider,candidate_family,candidate_generation,candidate_principal
 FROM morrow_identity.browser_session_generations a
 JOIN morrow_identity.browser_session_families b ON b.id=a.family_id
 JOIN morrow_identity.provider_session_bindings x ON x.id=b.provider_binding_id
 JOIN morrow_identity.identity_verification_profiles v ON v.id=x.profile_id
 JOIN morrow_identity.provider_subject_mappings sm ON sm.id=x.mapping_id
 WHERE a.secret_digest=p_presented_digest AND v.id::text=p_profile
 AND x.provider_id='workos' AND v.provider_id=x.provider_id
 AND x.environment_id=p_environment AND v.environment_id=x.environment_id
 AND x.client_id=p_client AND v.client_id=x.client_id AND v.application_id=p_application;
 IF candidate_provider IS NULL THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 -- (5) Unlocked fast path: a current, eligible generation of a 12-hour family younger than
 -- 60 s is current. Legacy-shape families never rotate and never take this path.
 SELECT a.expires_at,b.expires_at INTO fast_idle,fast_absolute
 FROM morrow_identity.account_session_principal(p_presented_digest) s
 JOIN morrow_identity.browser_session_generations a ON a.secret_digest=p_presented_digest
 JOIN morrow_identity.browser_session_families b ON b.id=a.family_id AND b.current_generation=a.generation
  AND b.expires_at=b.created_at+interval '12 hours'
 WHERE s.profile_id=p_profile AND s.principal_id=candidate_principal AND a.id::text=candidate_generation AND b.id::text=candidate_family
 AND clock_timestamp()<a.created_at+interval '60 seconds';
 IF FOUND THEN
  RETURN QUERY SELECT 'current'::text,floor(extract(epoch FROM fast_idle)*1000)::bigint::text,floor(extract(epoch FROM fast_absolute)*1000)::bigint::text; RETURN;
 END IF;
 -- (6) Locks: provider namespace; binding, profile, mapping, profile binding and principal
 -- shared; the family and its generations (presented, then current) exclusive.
 SELECT * INTO pb FROM morrow_identity.provider_session_bindings WHERE id::text=candidate_provider;
 PERFORM pg_advisory_xact_lock(hashtextextended('browser-provider:'||array_to_json(ARRAY[pb.provider_id,pb.environment_id,pb.client_id,pb.provider_session_id])::text,0));
 SELECT * INTO pb FROM morrow_identity.provider_session_bindings WHERE id::text=candidate_provider FOR SHARE;
 PERFORM 1 FROM morrow_identity.identity_verification_profiles WHERE id=pb.profile_id FOR SHARE;
 PERFORM 1 FROM morrow_identity.provider_subject_mappings WHERE id=pb.mapping_id FOR SHARE;
 PERFORM 1 FROM morrow_identity.provider_subject_profile_bindings WHERE profile_id=pb.profile_id AND mapping_id=pb.mapping_id FOR SHARE;
 PERFORM 1 FROM morrow_identity.principals WHERE id::text=candidate_principal FOR SHARE;
 SELECT * INTO f FROM morrow_identity.browser_session_families WHERE id::text=candidate_family FOR UPDATE;
 SELECT * INTO g FROM morrow_identity.browser_session_generations WHERE id::text=candidate_generation FOR UPDATE;
 SELECT * INTO cur FROM morrow_identity.browser_session_generations WHERE family_id=f.id AND generation=f.current_generation FOR UPDATE;
 instant:=clock_timestamp();
 -- (7) Nothing revives a revoked family or binding.
 IF pb.id IS NULL OR f.id IS NULL OR g.id IS NULL OR pb.revoked_at IS NOT NULL OR f.revoked_at IS NOT NULL
 OR f.provider_binding_id<>pb.id OR g.family_id<>f.id OR g.secret_digest<>p_presented_digest THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 -- (8) A retired generation of a live family is reuse: the family is revoked.
 IF g.generation<f.current_generation THEN
  IF f.expires_at<=instant OR f.created_at>instant THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
  BEGIN
   audit_key:=gen_random_uuid()::text;
   INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at)
    VALUES(audit_key,p_command,p_request_digest,'family',f.id,'revoked','reuse_detected',instant);
   prior_setting:=pg_catalog.current_setting('morrow.browser_revocation_audit',true);
   PERFORM pg_catalog.set_config('morrow.browser_revocation_audit',audit_key,true);
   UPDATE morrow_identity.browser_session_families SET revoked_at=instant,record_revision=record_revision+1 WHERE id=f.id;
   PERFORM pg_catalog.set_config('morrow.browser_revocation_audit',coalesce(prior_setting,''),true);
   applied:=true;
  EXCEPTION WHEN unique_violation THEN applied:=false;
  END;
  IF applied THEN RETURN QUERY SELECT 'reuse_revoked'::text,NULL::text,NULL::text;
  ELSE RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; END IF;
  RETURN;
 END IF;
 -- (9) Only the live, eligible, current generation of a 12-hour family rotates.
 IF g.generation<>f.current_generation OR cur.id IS NULL OR cur.id<>g.id OR g.revoked_at IS NOT NULL
 OR g.created_at>instant OR f.created_at>instant OR g.expires_at<=instant OR f.expires_at<=instant
 OR f.expires_at<>f.created_at+interval '12 hours' OR f.current_generation>=1000
 OR NOT EXISTS(SELECT 1 FROM morrow_identity.account_session_principal(p_presented_digest) s WHERE s.profile_id=p_profile AND s.principal_id=candidate_principal)
 OR (SELECT count(*) FROM morrow_identity.sessions WHERE session_digest=p_presented_digest)+(SELECT count(*) FROM morrow_identity.browser_session_generations WHERE secret_digest=p_presented_digest)<>1
 OR EXISTS(SELECT 1 FROM morrow_identity.sessions WHERE session_digest=p_new_digest)
 OR EXISTS(SELECT 1 FROM morrow_identity.browser_session_generations WHERE secret_digest=p_new_digest) THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 -- (10) Too early: current, with the existing expiries and no write.
 IF instant<g.created_at+interval '60 seconds' THEN
  RETURN QUERY SELECT 'current'::text,floor(extract(epoch FROM g.expires_at)*1000)::bigint::text,floor(extract(epoch FROM f.expires_at)*1000)::bigint::text; RETURN;
 END IF;
 -- (11) One subtransaction: the rotated audit, retire n, advance the family, issue n+1.
 expiry:=least(instant+interval '30 minutes',f.expires_at);
 BEGIN
  audit_key:=gen_random_uuid()::text;
  INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at)
   VALUES(audit_key,p_command,p_request_digest,'generation',g.id,'revoked','rotated',instant);
  prior_setting:=pg_catalog.current_setting('morrow.browser_revocation_audit',true);
  PERFORM pg_catalog.set_config('morrow.browser_revocation_audit',audit_key,true);
  UPDATE morrow_identity.browser_session_generations SET revoked_at=instant,record_revision=record_revision+1 WHERE id=g.id;
  UPDATE morrow_identity.browser_session_families SET current_generation=current_generation+1,record_revision=record_revision+1 WHERE id=f.id;
  INSERT INTO morrow_identity.browser_session_generations(id,family_id,generation,secret_digest,created_at,expires_at)
   VALUES(p_new_generation,f.id,f.current_generation+1,p_new_digest,instant,expiry);
  PERFORM pg_catalog.set_config('morrow.browser_revocation_audit',coalesce(prior_setting,''),true);
  -- Covers every late row wait inside the subtransaction.
  IF clock_timestamp()>=expiry THEN RAISE EXCEPTION USING ERRCODE='MR001',MESSAGE='SESSION_ROTATION_LATE'; END IF;
  applied:=true;
 EXCEPTION WHEN SQLSTATE 'MR001' OR unique_violation THEN applied:=false;
 END;
 IF NOT applied THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'rotated'::text,floor(extract(epoch FROM expiry)*1000)::bigint::text,floor(extract(epoch FROM f.expires_at)*1000)::bigint::text;
END $$;

-- Privileges. Only the logout executor may rotate; every new helper and trigger is
-- executable by no service role.
DO $$ DECLARE r record; BEGIN FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND p.proname IN ('preserve_session_signout_record','record_organization_session_signout','browser_new_lifetimes','browser_generation_fits_family','self_session_role_safe','check_browser_generation_insert','rotate_self_browser_generation') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions,morrow_identity_login,morrow_identity_login_maintenance,morrow_identity_logout,morrow_identity_onboarding',r.signature); END LOOP;END $$;
GRANT EXECUTE ON FUNCTION morrow_identity.rotate_self_browser_generation(text,text,text,text,text,text,text,text,text,text) TO morrow_identity_logout;
COMMIT;
