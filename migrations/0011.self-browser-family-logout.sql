BEGIN;
-- Retirement only. No workspace authority, provider logout or cookie operation.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT EXISTS(SELECT 1 FROM pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='morrow_identity_logout' AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND morrow_identity.memberships_closed(r.rolname))
 OR EXISTS(SELECT 1 FROM pg_roles r,pg_roles o WHERE o.rolname='morrow_identity_owner' AND r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance','morrow_identity_logout') AND (pg_has_role(r.oid,o.oid,'MEMBER') OR pg_has_role(o.oid,r.oid,'MEMBER'))) THEN RAISE EXCEPTION 'SELF_LOGOUT_ROLE_PREREQUISITES_INVALID'; END IF;
END $$;
CREATE FUNCTION morrow_identity.end_self_browser_family(
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
 OR pb.id IS NULL OR f.id IS NULL OR g.id IS NULL OR f.provider_binding_id<>pb.id OR g.family_id<>f.id OR g.secret_digest<>p_session_digest OR g.generation<>f.current_generation
 OR g.created_at<>f.created_at OR g.expires_at<>f.expires_at OR NOT isfinite(pb.created_at) OR NOT isfinite(f.created_at) OR NOT isfinite(g.created_at) OR NOT isfinite(f.expires_at) OR NOT isfinite(g.expires_at)
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
   OR g.family_id<>f.id OR f.provider_binding_id<>pb.id OR g.generation<>f.current_generation OR g.created_at<>f.created_at OR g.expires_at<>f.expires_at
   OR NOT EXISTS(SELECT 1 FROM morrow_identity.identity_verification_profiles v WHERE v.id=pb.profile_id AND v.id::text=p_profile AND pb.provider_id='workos' AND v.provider_id=pb.provider_id AND pb.environment_id=p_environment AND v.environment_id=pb.environment_id AND pb.client_id=p_client AND v.client_id=pb.client_id AND v.application_id=p_application) THEN
   RAISE EXCEPTION 'SELF_LOGOUT_BINDING_DENIED';
  END IF;
  RETURN QUERY SELECT 'ended'::text,effect.audit_id::text; RETURN;
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  IF SQLERRM<>'SELF_LOGOUT_BINDING_DENIED' THEN RAISE; END IF;
 END;
 RETURN QUERY SELECT 'denied'::text,NULL::text;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.end_self_browser_family(text,text,text,text,text,text,text,text) FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions,morrow_identity_login,morrow_identity_login_maintenance,morrow_identity_logout;
GRANT USAGE ON SCHEMA morrow_identity TO morrow_identity_logout;
GRANT EXECUTE ON FUNCTION morrow_identity.end_self_browser_family(text,text,text,text,text,text,text,text) TO morrow_identity_logout;
COMMIT;
