BEGIN;
-- Private local persistence only. No login/HTTP/cookie/provider activation.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_identity_owner'
   AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb
   AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles service,pg_catalog.pg_roles owner
   WHERE owner.rolname='morrow_identity_owner'
   AND service.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions')
   AND (pg_catalog.pg_has_role(service.oid,owner.oid,'MEMBER') OR pg_catalog.pg_has_role(owner.oid,service.oid,'MEMBER')))
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='morrow_identity_sessions'
   AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
   AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication
   AND morrow_identity.memberships_closed(r.rolname)) THEN
  RAISE EXCEPTION 'BROWSER_SESSION_ROLE_PREREQUISITES_INVALID';
 END IF;
END $$;
CREATE TABLE morrow_identity.provider_session_bindings (
 id morrow_identity.record_id PRIMARY KEY,
 provider_id text NOT NULL CHECK(provider_id='workos'),
 environment_id text NOT NULL CHECK(environment_id ~ '^environment_[A-Z0-9]{26}$'),
 client_id text NOT NULL CHECK(client_id ~ '^client_[A-Z0-9]{26}$'),
 provider_session_id text NOT NULL CHECK(provider_session_id ~ '^session_[A-Z0-9]{26}$'),
 mapping_id morrow_identity.record_id NOT NULL,
 profile_id morrow_identity.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 revoked_at timestamptz CHECK(revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at>=created_at)),
 record_revision morrow_identity.revision NOT NULL DEFAULT 1,
 UNIQUE(provider_id,environment_id,client_id,provider_session_id),
 FOREIGN KEY(mapping_id,provider_id,environment_id) REFERENCES morrow_identity.provider_subject_mappings(id,provider_id,environment_id),
 FOREIGN KEY(profile_id,provider_id,environment_id) REFERENCES morrow_identity.identity_verification_profiles(id,provider_id,environment_id)
);
CREATE TABLE morrow_identity.browser_session_families (
 id morrow_identity.record_id PRIMARY KEY,
 provider_binding_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.provider_session_bindings(id),
 profile_record_revision morrow_identity.revision NOT NULL,
 mapping_revision morrow_identity.revision NOT NULL,
 binding_revision morrow_identity.revision NOT NULL,
 current_generation morrow_identity.revision NOT NULL DEFAULT 1 CHECK(current_generation=1),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at=created_at+interval '15 minutes'),
 revoked_at timestamptz CHECK(revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at>=created_at)),
 record_revision morrow_identity.revision NOT NULL DEFAULT 1
);
CREATE TABLE morrow_identity.browser_session_generations (
 id morrow_identity.record_id PRIMARY KEY,
 family_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.browser_session_families(id),
 generation morrow_identity.revision NOT NULL DEFAULT 1 CHECK(generation=1),
 secret_digest text NOT NULL UNIQUE CHECK(secret_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at=created_at+interval '15 minutes'),
 revoked_at timestamptz CHECK(revoked_at IS NULL OR (isfinite(revoked_at) AND revoked_at>=created_at)),
 record_revision morrow_identity.revision NOT NULL DEFAULT 1,
 UNIQUE(family_id,generation)
);
CREATE TABLE morrow_identity.browser_session_audits (
 id morrow_identity.record_id PRIMARY KEY,
 command_id morrow_identity.record_id NOT NULL UNIQUE,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK(kind IN ('admit','provider_binding','family','generation')),
 target_id morrow_identity.record_id,
 outcome text NOT NULL CHECK(outcome IN ('admitted','denied','revoked','already_revoked')),
 reason text NOT NULL CHECK(reason IN ('admitted','identity_ineligible','evidence_expired','revision_conflict','binding_revoked','digest_conflict','identity_conflict','revoked','already_revoked')),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE TABLE morrow_identity.browser_session_commands (
 command_id morrow_identity.record_id PRIMARY KEY,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 request_tuple jsonb NOT NULL CHECK(jsonb_typeof(request_tuple)='array' AND jsonb_array_length(request_tuple)=26),
 outcome text NOT NULL CHECK(outcome IN ('admitted','denied')),
 family_id morrow_identity.record_id REFERENCES morrow_identity.browser_session_families(id),
 generation_id morrow_identity.record_id REFERENCES morrow_identity.browser_session_generations(id),
 provider_binding_id morrow_identity.record_id REFERENCES morrow_identity.provider_session_bindings(id),
 expires_at timestamptz,
 audit_id morrow_identity.record_id NOT NULL UNIQUE REFERENCES morrow_identity.browser_session_audits(id),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 CHECK((outcome='admitted' AND family_id IS NOT NULL AND generation_id IS NOT NULL AND provider_binding_id IS NOT NULL AND expires_at IS NOT NULL AND isfinite(expires_at))
    OR (outcome='denied' AND family_id IS NULL AND generation_id IS NULL AND provider_binding_id IS NULL AND expires_at IS NULL))
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['provider_session_bindings','browser_session_families','browser_session_generations','browser_session_commands','browser_session_audits'] LOOP
  EXECUTE format('ALTER TABLE morrow_identity.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_identity.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY identity_owner ON morrow_identity.%I TO morrow_identity_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON morrow_identity.%I FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions',t);
 END LOOP;
END $$;
CREATE FUNCTION morrow_identity.preserve_browser_session_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE kind_value text;
BEGIN
 IF TG_OP<>'UPDATE' OR TG_TABLE_NAME IN ('browser_session_commands','browser_session_audits') THEN
  RAISE EXCEPTION 'BROWSER_SESSION_RECORD_IMMUTABLE';
 END IF;
 kind_value:=CASE TG_TABLE_NAME WHEN 'provider_session_bindings' THEN 'provider_binding' WHEN 'browser_session_families' THEN 'family' WHEN 'browser_session_generations' THEN 'generation' END;
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
REVOKE ALL ON FUNCTION morrow_identity.preserve_browser_session_record() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['provider_session_bindings','browser_session_families','browser_session_generations','browser_session_commands','browser_session_audits'] LOOP
  EXECUTE format('CREATE TRIGGER browser_session_immutable BEFORE UPDATE OR DELETE ON morrow_identity.%I FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_browser_session_record()',t);
  EXECUTE format('CREATE TRIGGER browser_session_no_truncate BEFORE TRUNCATE ON morrow_identity.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity.preserve_browser_session_record()',t);
 END LOOP;
END $$;
CREATE FUNCTION morrow_identity.browser_sessions_role_safe() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT current_user='morrow_identity_owner' AND session_user='morrow_identity_sessions'
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND morrow_identity.executor_memberships_closed(r.rolname))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles service,pg_catalog.pg_roles o WHERE o.rolname='morrow_identity_owner' AND service.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions') AND (pg_catalog.pg_has_role(service.oid,o.oid,'MEMBER') OR pg_catalog.pg_has_role(o.oid,service.oid,'MEMBER')))
$$;
REVOKE ALL ON FUNCTION morrow_identity.browser_sessions_role_safe() FROM PUBLIC;
-- Readers never lock. A collision across representations denies even if one is
-- expired/revoked; a GUC or a second representation cannot choose its authority.
CREATE FUNCTION morrow_identity.session_eligibility(p_digest text,p_workspace text)
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
   AND g.created_at=f.created_at AND g.expires_at=f.expires_at
   AND pb.created_at<=clock_timestamp() AND f.created_at<=clock_timestamp() AND g.created_at<=clock_timestamp()
   AND g.expires_at>clock_timestamp() AND f.expires_at>clock_timestamp()
$$;
REVOKE ALL ON FUNCTION morrow_identity.session_eligibility(text,text) FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions;
-- Call only after the selected organization is locked. The shared order is
-- organization -> provider namespace/binding -> profile/mapping/allow-binding
-- -> principal -> family/generation -> workspace/memberships -> grants.
CREATE FUNCTION morrow_identity.lock_session_eligibility(p_digest text,p_workspace text,p_principal text,p_org text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE pb morrow_identity.provider_session_bindings%ROWTYPE; family_key text; generation_key text;
BEGIN
 IF (SELECT count(*) FROM morrow_identity.sessions WHERE session_digest=p_digest)
    +(SELECT count(*) FROM morrow_identity.browser_session_generations WHERE secret_digest=p_digest)<>1 THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM morrow_identity.sessions WHERE session_digest=p_digest AND principal_id::text=p_principal AND organization_id::text=p_org) THEN
  PERFORM 1 FROM morrow_identity.principals WHERE id::text=p_principal FOR UPDATE;
  PERFORM 1 FROM morrow_identity.sessions WHERE session_digest=p_digest FOR UPDATE;
  RETURN;
 END IF;
 SELECT x.* INTO pb FROM morrow_identity.browser_session_generations g
 JOIN morrow_identity.browser_session_families f ON f.id=g.family_id
 JOIN morrow_identity.provider_session_bindings x ON x.id=f.provider_binding_id
 JOIN morrow_identity.provider_subject_mappings sm ON sm.id=x.mapping_id AND sm.principal_id::text=p_principal
 WHERE g.secret_digest=p_digest;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('browser-provider:'||array_to_json(ARRAY[pb.provider_id,pb.environment_id,pb.client_id,pb.provider_session_id])::text,0));
 PERFORM 1 FROM morrow_identity.provider_session_bindings WHERE id=pb.id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.identity_verification_profiles WHERE id=pb.profile_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.provider_subject_mappings WHERE id=pb.mapping_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.provider_subject_profile_bindings WHERE profile_id=pb.profile_id AND mapping_id=pb.mapping_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.principals WHERE id::text=p_principal FOR UPDATE;
 SELECT f.id::text,g.id::text INTO family_key,generation_key FROM morrow_identity.browser_session_generations g JOIN morrow_identity.browser_session_families f ON f.id=g.family_id WHERE g.secret_digest=p_digest;
 PERFORM 1 FROM morrow_identity.browser_session_families WHERE id::text=family_key FOR UPDATE;
 PERFORM 1 FROM morrow_identity.browser_session_generations WHERE id::text=generation_key FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.lock_session_eligibility(text,text,text,text) FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions;
CREATE FUNCTION morrow_identity.admit_browser_family(
 p_command text,p_request_digest text,p_provider text,p_environment text,p_application text,p_client text,p_issuer text,
 p_token_revision text,p_token_digest text,p_subject text,p_provider_session text,p_workspace text,
 p_evidence_issued text,p_evidence_observed text,p_evidence_expires text,p_keyset_digest text,p_observation_digest text,p_secret_digest text,
 p_profile_id text,p_profile_record_revision text,p_mapping_id text,p_mapping_revision text,p_binding_revision text,p_membership_id text,p_policy_revision text,
 p_family_id text,p_generation_id text)
RETURNS TABLE(outcome text,family_id text,generation_id text,provider_binding_id text,expires_at_ms text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
 tuple_values text[]; previous morrow_identity.browser_session_commands%ROWTYPE;
 v morrow_identity.identity_verification_profiles%ROWTYPE; sm morrow_identity.provider_subject_mappings%ROWTYPE;
 b morrow_identity.provider_subject_profile_bindings%ROWTYPE; pb morrow_identity.provider_session_bindings%ROWTYPE;
 person morrow_identity.principals%ROWTYPE; org morrow_identity.organizations%ROWTYPE;
 ws morrow_identity.workspaces%ROWTYPE; member_row morrow_identity.memberships%ROWTYPE; wm morrow_identity.workspace_memberships%ROWTYPE;
 org_key text; reason_code text:='identity_ineligible'; instant timestamptz; expiry timestamptz; audit_key text; provider_key text;
 n numeric; value text; succeeded boolean:=false;
BEGIN
 IF NOT morrow_identity.browser_sessions_role_safe() THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 tuple_values:=ARRAY[p_command,p_provider,p_environment,p_application,p_client,p_issuer,p_token_revision,p_token_digest,p_subject,p_provider_session,p_workspace,p_evidence_issued,p_evidence_observed,p_evidence_expires,p_keyset_digest,p_observation_digest,p_secret_digest,p_profile_id,p_profile_record_revision,p_mapping_id,p_mapping_revision,p_binding_revision,p_membership_id,p_policy_revision,p_family_id,p_generation_id];
 IF array_position(tuple_values,NULL) IS NOT NULL OR p_request_digest IS NULL
   OR p_provider<>'workos' OR p_environment !~ '^environment_[A-Z0-9]{26}$' OR p_application !~ '^app_[A-Z0-9]{26}$'
   OR p_client !~ '^client_[A-Z0-9]{26}$' OR p_issuer<>'https://api.workos.com/user_management/'||p_client
   OR p_subject !~ '^user_[A-Z0-9]{26}$' OR p_provider_session !~ '^session_[A-Z0-9]{26}$'
   OR p_family_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_generation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   OR p_family_id=p_generation_id THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 FOREACH value IN ARRAY ARRAY[p_command,p_workspace,p_profile_id,p_mapping_id,p_membership_id] LOOP
  IF value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 END LOOP;
 FOREACH value IN ARRAY ARRAY[p_request_digest,p_token_digest,p_keyset_digest,p_observation_digest,p_secret_digest] LOOP
  IF value !~ '^[a-f0-9]{64}$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 END LOOP;
 FOREACH value IN ARRAY ARRAY[p_token_revision,p_profile_record_revision,p_mapping_revision,p_binding_revision,p_policy_revision] LOOP
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
 -- One global command namespace, before any identity/provider locks. A digest
 -- includes every exact string in the derived tuple, including generated IDs.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('browser-command:'||p_command,0));
 SELECT * INTO previous FROM morrow_identity.browser_session_commands WHERE command_id::text=p_command;
 IF FOUND THEN
  IF previous.request_digest<>p_request_digest OR previous.request_tuple<>to_jsonb(tuple_values) THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  ELSIF previous.outcome='admitted' THEN
   RETURN QUERY SELECT 'replayed'::text,previous.family_id::text,previous.generation_id::text,previous.provider_binding_id::text,floor(extract(epoch FROM previous.expires_at)*1000)::text,previous.audit_id::text;
  ELSE RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; END IF;
  RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM morrow_identity.browser_session_audits WHERE command_id::text=p_command) THEN
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 <<qualification>> BEGIN
  -- Non-authorizing namespace/membership preflight avoids locking a foreign
  -- selector. Every state/revision/time is rechecked below AFTER actual locks.
  SELECT w.organization_id::text INTO org_key
  FROM morrow_identity.workspaces w
  JOIN morrow_identity.organizations o ON o.id=w.organization_id AND o.active
  JOIN morrow_identity.memberships om ON om.organization_id=o.id AND om.id::text=p_membership_id AND om.active
  JOIN morrow_identity.workspace_memberships x ON x.organization_id=o.id AND x.workspace_id=w.id AND x.membership_id=om.id AND x.active
  JOIN morrow_identity.provider_subject_mappings m ON m.id::text=p_mapping_id AND m.principal_id=om.principal_id
    AND m.provider_id=p_provider AND m.environment_id=p_environment AND m.subject_id=p_subject AND m.state='active'
  JOIN morrow_identity.principals p ON p.id=m.principal_id AND p.active AND p.kind='human'
  JOIN morrow_identity.identity_verification_profiles vp ON vp.id::text=p_profile_id AND vp.provider_id=p_provider
    AND vp.environment_id=p_environment AND vp.application_id=p_application AND vp.client_id=p_client AND vp.issuer=p_issuer
    AND vp.token_profile_revision::text=p_token_revision AND vp.token_profile_digest=p_token_digest AND vp.state='active'
  JOIN morrow_identity.provider_subject_profile_bindings a ON a.mapping_id=m.id AND a.profile_id=vp.id
    AND a.provider_id=p_provider AND a.environment_id=p_environment AND a.state='active'
  WHERE w.id::text=p_workspace AND w.active;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO org FROM morrow_identity.organizations WHERE id::text=org_key FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('browser-provider:'||array_to_json(ARRAY[p_provider,p_environment,p_client,p_provider_session])::text,0));
  SELECT * INTO pb FROM morrow_identity.provider_session_bindings WHERE provider_id=p_provider AND environment_id=p_environment AND client_id=p_client AND provider_session_id=p_provider_session FOR UPDATE;
  SELECT * INTO v FROM morrow_identity.identity_verification_profiles WHERE id::text=p_profile_id
    AND provider_id=p_provider AND environment_id=p_environment AND application_id=p_application AND client_id=p_client AND issuer=p_issuer
    AND token_profile_revision::text=p_token_revision AND token_profile_digest=p_token_digest FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO sm FROM morrow_identity.provider_subject_mappings WHERE id::text=p_mapping_id
    AND provider_id=p_provider AND environment_id=p_environment AND subject_id=p_subject FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO b FROM morrow_identity.provider_subject_profile_bindings WHERE profile_id=v.id AND mapping_id=sm.id FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO person FROM morrow_identity.principals WHERE id=sm.principal_id FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO ws FROM morrow_identity.workspaces WHERE id::text=p_workspace AND organization_id=org.id FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO member_row FROM morrow_identity.memberships WHERE id::text=p_membership_id AND organization_id=org.id AND principal_id=person.id FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  SELECT * INTO wm FROM morrow_identity.workspace_memberships WHERE organization_id=org.id AND workspace_id=ws.id AND membership_id=member_row.id FOR UPDATE;
  IF NOT FOUND THEN EXIT qualification; END IF;
  instant:=clock_timestamp(); n:=floor(extract(epoch FROM instant)*1000);
  IF p_evidence_observed::numeric>n OR p_evidence_expires::numeric<=n THEN reason_code:='evidence_expired'; EXIT qualification; END IF;
  IF NOT org.active OR NOT ws.active OR NOT person.active OR person.kind<>'human' OR NOT member_row.active OR NOT wm.active
     OR v.state<>'active' OR sm.state<>'active' OR b.state<>'active' THEN EXIT qualification; END IF;
  IF v.provider_id<>p_provider OR v.environment_id<>p_environment OR v.application_id<>p_application OR v.client_id<>p_client
     OR v.issuer<>p_issuer OR v.token_profile_revision::text<>p_token_revision OR v.token_profile_digest<>p_token_digest
     OR sm.provider_id<>p_provider OR sm.environment_id<>p_environment OR sm.subject_id<>p_subject
     OR b.provider_id<>p_provider OR b.environment_id<>p_environment THEN EXIT qualification; END IF;
  IF v.record_revision::text<>p_profile_record_revision OR sm.record_revision::text<>p_mapping_revision OR b.record_revision::text<>p_binding_revision OR org.policy_revision::text<>p_policy_revision THEN reason_code:='revision_conflict'; EXIT qualification; END IF;
  IF pb.id IS NOT NULL AND (pb.mapping_id<>sm.id OR pb.profile_id<>v.id) THEN reason_code:='identity_conflict'; EXIT qualification; END IF;
  IF pb.id IS NOT NULL AND pb.revoked_at IS NOT NULL THEN reason_code:='binding_revoked'; EXIT qualification; END IF;
  IF pb.id IS NOT NULL AND pb.created_at>instant THEN EXIT qualification; END IF;
  IF EXISTS(SELECT 1 FROM morrow_identity.sessions WHERE session_digest=p_secret_digest) THEN reason_code:='digest_conflict'; EXIT qualification; END IF;
  reason_code:='admitted';
 END qualification;
 audit_key:=gen_random_uuid()::text;
 IF reason_code='admitted' THEN
  BEGIN
   instant:=clock_timestamp(); n:=floor(extract(epoch FROM instant)*1000);
   IF p_evidence_observed::numeric>n OR p_evidence_expires::numeric<=n THEN RAISE SQLSTATE 'P8101'; END IF;
   IF pb.id IS NULL THEN
    provider_key:=gen_random_uuid()::text;
    INSERT INTO morrow_identity.provider_session_bindings(id,provider_id,environment_id,client_id,provider_session_id,mapping_id,profile_id,created_at)
     VALUES(provider_key,p_provider,p_environment,p_client,p_provider_session,sm.id,v.id,instant);
   ELSE provider_key:=pb.id::text; END IF;
   expiry:=instant+interval '15 minutes';
   INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,created_at,expires_at)
    VALUES(p_family_id,provider_key,v.record_revision,sm.record_revision,b.record_revision,instant,expiry);
   INSERT INTO morrow_identity.browser_session_generations(id,family_id,secret_digest,created_at,expires_at)
    VALUES(p_generation_id,p_family_id,p_secret_digest,instant,expiry);
   INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at)
    VALUES(audit_key,p_command,p_request_digest,'admit',p_family_id,'admitted','admitted',instant);
   INSERT INTO morrow_identity.browser_session_commands(command_id,request_digest,request_tuple,outcome,family_id,generation_id,provider_binding_id,expires_at,audit_id,recorded_at)
    VALUES(p_command,p_request_digest,to_jsonb(tuple_values),'admitted',p_family_id,p_generation_id,provider_key,expiry,audit_key,instant);
   -- Covers every late UNIQUE/FK/row wait inside the persistence subtransaction.
   IF p_evidence_expires::numeric<=floor(extract(epoch FROM clock_timestamp())*1000) THEN RAISE SQLSTATE 'P8101'; END IF;
   succeeded:=true;
  EXCEPTION WHEN SQLSTATE 'P8101' THEN reason_code:='evidence_expired';
   WHEN unique_violation THEN reason_code:='identity_conflict';
  END;
 END IF;
 IF succeeded THEN
  RETURN QUERY SELECT 'newly_admitted'::text,p_family_id,p_generation_id,provider_key,floor(extract(epoch FROM expiry)*1000)::text,audit_key; RETURN;
 END IF;
 -- A terminal denied command is also immutable. Its private audit attributes the
 -- denial, but the executor receives no identity locator or bearer information.
 instant:=clock_timestamp();
 INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at)
  VALUES(audit_key,p_command,p_request_digest,'admit',NULL,'denied',reason_code,instant);
 INSERT INTO morrow_identity.browser_session_commands(command_id,request_digest,request_tuple,outcome,audit_id,recorded_at)
  VALUES(p_command,p_request_digest,to_jsonb(tuple_values),'denied',audit_key,instant);
 RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.admit_browser_family(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution;
CREATE FUNCTION morrow_identity.reconcile_browser_admission(p_command text,p_digest text)
RETURNS TABLE(outcome text,family_id text,generation_id text,provider_binding_id text,expires_at_ms text,audit_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE previous morrow_identity.browser_session_commands%ROWTYPE;
BEGIN
 IF NOT morrow_identity.browser_sessions_role_safe() OR p_command IS NULL OR p_digest IS NULL
   OR p_command !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO previous FROM morrow_identity.browser_session_commands WHERE command_id::text=p_command;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
 ELSIF previous.request_digest<>p_digest THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
 ELSIF previous.outcome='admitted' THEN RETURN QUERY SELECT 'replayed'::text,previous.family_id::text,previous.generation_id::text,previous.provider_binding_id::text,floor(extract(epoch FROM previous.expires_at)*1000)::text,previous.audit_id::text;
 ELSE RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; END IF;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.reconcile_browser_admission(text,text) FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution;
GRANT USAGE ON SCHEMA morrow_identity TO morrow_identity_sessions;
GRANT EXECUTE ON FUNCTION morrow_identity.admit_browser_family(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) TO morrow_identity_sessions;
GRANT EXECUTE ON FUNCTION morrow_identity.reconcile_browser_admission(text,text) TO morrow_identity_sessions;
-- Owner-only maintenance primitives, not an end-user logout/admin protocol.
-- They never take organization/profile locks after provider/family locks.
CREATE FUNCTION morrow_identity.revoke_browser_record(p_kind text,p_target text,p_command text,p_digest text)
RETURNS TABLE(outcome text,audit_id text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE pb morrow_identity.provider_session_bindings%ROWTYPE; previous morrow_identity.browser_session_audits%ROWTYPE;
 family_key text; target_revoked timestamptz; target_created timestamptz; target_revision bigint; instant timestamptz; audit_key text; prior_setting text;
BEGIN
 IF current_user<>'morrow_identity_owner'
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
   OR p_kind IS NULL OR p_target IS NULL OR p_command IS NULL OR p_digest IS NULL
   OR p_kind NOT IN ('provider_binding','family','generation')
   OR p_target !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_command !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('browser-command:'||p_command,0));
 SELECT * INTO previous FROM morrow_identity.browser_session_audits WHERE command_id::text=p_command;
 IF FOUND THEN
  IF previous.kind=p_kind AND previous.target_id::text=p_target AND previous.request_digest=p_digest THEN
   RETURN QUERY SELECT 'replayed'::text,previous.id::text;
  ELSE RETURN QUERY SELECT 'conflict'::text,NULL::text; END IF; RETURN;
 END IF;
 IF p_kind='provider_binding' THEN
  SELECT * INTO pb FROM morrow_identity.provider_session_bindings WHERE id::text=p_target;
 ELSIF p_kind='family' THEN
  SELECT x.* INTO pb FROM morrow_identity.provider_session_bindings x JOIN morrow_identity.browser_session_families f ON f.provider_binding_id=x.id WHERE f.id::text=p_target;
 ELSE
  SELECT x.* INTO pb FROM morrow_identity.provider_session_bindings x JOIN morrow_identity.browser_session_families f ON f.provider_binding_id=x.id JOIN morrow_identity.browser_session_generations g ON g.family_id=f.id WHERE g.id::text=p_target;
  SELECT family_id::text INTO family_key FROM morrow_identity.browser_session_generations WHERE id::text=p_target;
 END IF;
 IF pb.id IS NULL THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('browser-provider:'||array_to_json(ARRAY[pb.provider_id,pb.environment_id,pb.client_id,pb.provider_session_id])::text,0));
 SELECT * INTO pb FROM morrow_identity.provider_session_bindings WHERE id=pb.id FOR UPDATE;
 IF p_kind='provider_binding' THEN target_revoked:=pb.revoked_at; target_created:=pb.created_at; target_revision:=pb.record_revision;
 ELSIF p_kind='family' THEN
  SELECT f.revoked_at,f.created_at,f.record_revision INTO target_revoked,target_created,target_revision FROM morrow_identity.browser_session_families f WHERE f.id::text=p_target FOR UPDATE;
 ELSE
  PERFORM 1 FROM morrow_identity.browser_session_families WHERE id::text=family_key FOR UPDATE;
  SELECT g.revoked_at,g.created_at,g.record_revision INTO target_revoked,target_created,target_revision FROM morrow_identity.browser_session_generations g WHERE g.id::text=p_target FOR UPDATE;
 END IF;
 instant:=clock_timestamp();
 IF target_created IS NULL OR target_created>instant OR (target_revoked IS NULL AND target_revision=9007199254740991) THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 audit_key:=gen_random_uuid()::text;
 INSERT INTO morrow_identity.browser_session_audits(id,command_id,request_digest,kind,target_id,outcome,reason,recorded_at)
 VALUES(audit_key,p_command,p_digest,p_kind,p_target,CASE WHEN target_revoked IS NULL THEN 'revoked' ELSE 'already_revoked' END,CASE WHEN target_revoked IS NULL THEN 'revoked' ELSE 'already_revoked' END,instant);
 IF target_revoked IS NULL THEN
  prior_setting:=pg_catalog.current_setting('morrow.browser_revocation_audit',true);
  PERFORM pg_catalog.set_config('morrow.browser_revocation_audit',audit_key,true);
  IF p_kind='provider_binding' THEN UPDATE morrow_identity.provider_session_bindings SET revoked_at=instant,record_revision=record_revision+1 WHERE id::text=p_target;
  ELSIF p_kind='family' THEN UPDATE morrow_identity.browser_session_families SET revoked_at=instant,record_revision=record_revision+1 WHERE id::text=p_target;
  ELSE UPDATE morrow_identity.browser_session_generations SET revoked_at=instant,record_revision=record_revision+1 WHERE id::text=p_target; END IF;
  PERFORM pg_catalog.set_config('morrow.browser_revocation_audit',coalesce(prior_setting,''),true);
 END IF;
 RETURN QUERY SELECT 'applied'::text,audit_key;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.revoke_browser_record(text,text,text,text) FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions;
CREATE FUNCTION morrow_identity.revoke_provider_binding(p_target text,p_command text,p_digest text) RETURNS TABLE(outcome text,audit_id text)
LANGUAGE sql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$ SELECT * FROM morrow_identity.revoke_browser_record('provider_binding',p_target,p_command,p_digest) $$;
CREATE FUNCTION morrow_identity.revoke_browser_family(p_target text,p_command text,p_digest text) RETURNS TABLE(outcome text,audit_id text)
LANGUAGE sql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$ SELECT * FROM morrow_identity.revoke_browser_record('family',p_target,p_command,p_digest) $$;
CREATE FUNCTION morrow_identity.revoke_browser_generation(p_target text,p_command text,p_digest text) RETURNS TABLE(outcome text,audit_id text)
LANGUAGE sql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$ SELECT * FROM morrow_identity.revoke_browser_record('generation',p_target,p_command,p_digest) $$;
REVOKE ALL ON FUNCTION morrow_identity.revoke_provider_binding(text,text,text),morrow_identity.revoke_browser_family(text,text,text),morrow_identity.revoke_browser_generation(text,text,text) FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions;

CREATE OR REPLACE FUNCTION morrow_identity.resolved_context()
RETURNS TABLE(principal_id text,organization_id text,workspace_id text,membership_id text,policy_revision bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT * FROM morrow_identity.session_eligibility(pg_catalog.current_setting('morrow.session_digest',true),pg_catalog.current_setting('morrow.requested_workspace',true))
$$;

-- Deliberate current definitions: unchanged receipt/grant/proof/audit rules.
CREATE OR REPLACE FUNCTION morrow_identity.revoke_workspace_access(
  p_receipt_id text,p_command_id text,p_request_digest text,p_session_digest text,
  p_organization_id text,p_workspace_id text,p_target_membership_id text,p_expected_revision text)
RETURNS TABLE (outcome text,revocation_id text,policy_revision text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
  receipt morrow_identity.workspace_revocation_receipts%ROWTYPE;
  previous morrow_identity.workspace_revocation_results%ROWTYPE;
  org morrow_identity.organizations%ROWTYPE;
  actor_ok boolean; target_ok boolean; grant_ok boolean;
  now_at timestamptz; grant_start timestamptz; grant_end timestamptz;
  reason_code text; result_id text; revoke_id text; result_outcome text;
BEGIN
  -- Validate bounded scalar inputs before private lookups. This function accepts
  -- no caller actor/grant/approval object and never issues any authority.
  IF p_receipt_id IS NULL OR p_command_id IS NULL OR p_request_digest IS NULL OR p_session_digest IS NULL
    OR p_organization_id IS NULL OR p_workspace_id IS NULL OR p_target_membership_id IS NULL OR p_expected_revision IS NULL
    OR p_receipt_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_command_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_organization_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_workspace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_target_membership_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR p_request_digest !~ '^[a-f0-9]{64}$' OR p_session_digest !~ '^[a-f0-9]{64}$'
    OR p_expected_revision !~ '^[1-9][0-9]{0,15}$' THEN
    RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  IF p_expected_revision::numeric > 9007199254740991 THEN
    RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  -- All lifecycle mutations serialize on the organization before any dependent
  -- lock. Explicit row locks also protect against maintenance writes which have
  -- not yet adopted the organization serialization protocol.
  SELECT * INTO org FROM morrow_identity.organizations WHERE id::text=p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
  SELECT * INTO receipt FROM morrow_identity.workspace_revocation_receipts
    WHERE id::text=p_receipt_id AND organization_id::text=p_organization_id FOR UPDATE;
  IF NOT FOUND OR receipt.workspace_id::text<>p_workspace_id
    OR receipt.target_membership_id::text<>p_target_membership_id
    OR receipt.actor_session_digest<>p_session_digest
    OR receipt.expected_policy_revision::text<>p_expected_revision THEN
    RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  IF receipt.command_id::text<>p_command_id OR receipt.request_digest<>p_request_digest THEN
    RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  PERFORM morrow_identity.lock_session_eligibility(receipt.actor_session_digest,receipt.workspace_id::text,receipt.actor_principal_id::text,receipt.organization_id::text);
  PERFORM 1 FROM morrow_identity.principals WHERE id=receipt.actor_principal_id FOR UPDATE;
  PERFORM 1 FROM morrow_identity.workspaces WHERE id=receipt.workspace_id AND organization_id=receipt.organization_id FOR UPDATE;
  PERFORM 1 FROM morrow_identity.memberships
    WHERE organization_id=receipt.organization_id AND id IN (receipt.actor_membership_id,receipt.target_membership_id)
    ORDER BY id FOR UPDATE;
  PERFORM 1 FROM morrow_identity.workspace_memberships
    WHERE workspace_id=receipt.workspace_id AND membership_id IN (receipt.actor_membership_id,receipt.target_membership_id)
    ORDER BY membership_id FOR UPDATE;
  PERFORM 1 FROM morrow_identity.grants
    WHERE id=receipt.authorizing_grant_id OR
      (organization_id=receipt.organization_id AND workspace_id=receipt.workspace_id AND membership_id=receipt.target_membership_id)
    ORDER BY id FOR UPDATE;
  now_at := clock_timestamp();
  actor_ok := org.active AND EXISTS (
    SELECT 1 FROM morrow_identity.principals p
    JOIN morrow_identity.memberships m ON m.principal_id=p.id AND m.id=receipt.actor_membership_id AND m.organization_id=receipt.organization_id AND m.active
    JOIN morrow_identity.workspace_memberships wm ON wm.membership_id=m.id AND wm.workspace_id=receipt.workspace_id AND wm.organization_id=receipt.organization_id AND wm.active
    JOIN morrow_identity.workspaces w ON w.id=wm.workspace_id AND w.organization_id=receipt.organization_id AND w.active
    JOIN morrow_identity.session_eligibility(receipt.actor_session_digest,receipt.workspace_id::text) s ON s.principal_id=p.id::text AND s.organization_id=receipt.organization_id::text AND s.membership_id=receipt.actor_membership_id::text
    WHERE p.id=receipt.actor_principal_id AND p.active AND p.kind='human');
  target_ok := EXISTS (SELECT 1 FROM morrow_identity.memberships m
    JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=m.organization_id AND wm.membership_id=m.id
    WHERE m.id=receipt.target_membership_id AND m.organization_id=receipt.organization_id AND m.active
      AND wm.workspace_id=receipt.workspace_id AND wm.active);
  grant_ok := EXISTS (SELECT 1 FROM morrow_identity.grants g
    WHERE g.id=receipt.authorizing_grant_id AND g.organization_id=receipt.organization_id AND g.workspace_id=receipt.workspace_id
      AND g.membership_id=receipt.actor_membership_id AND g.principal_id=receipt.actor_principal_id
      AND g.payload=receipt.authorizing_grant_snapshot);
  -- The owner-seeded snapshot has already passed the shared Grant validator and
  -- policy boundary. Check its time window here; do not create a parallel grant
  -- interpreter or accept a caller-provided authorization decision.
  BEGIN
    grant_start := (receipt.authorizing_grant_snapshot->>'validFrom')::timestamptz;
    grant_end := (receipt.authorizing_grant_snapshot->>'expiresAt')::timestamptz;
    grant_ok := grant_ok AND grant_start IS NOT NULL AND isfinite(grant_start) AND grant_start<=now_at
      AND (receipt.authorizing_grant_snapshot->'expiresAt'='null'::jsonb OR (grant_end IS NOT NULL AND isfinite(grant_end) AND grant_end>now_at));
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN grant_ok := false;
  END;
  SELECT * INTO previous FROM morrow_identity.workspace_revocation_results WHERE receipt_id=receipt.id;
  IF FOUND THEN
    -- Receipt expiry/old expected revision do not cause another effect. Current
    -- eligibility is still mandatory to disclose the original private result.
    IF actor_ok AND grant_ok IS TRUE THEN
      RETURN QUERY SELECT previous.outcome,previous.revocation_id::text,previous.policy_revision::text,previous.id::text;
    ELSE RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; END IF;
    RETURN;
  END IF;
  IF receipt.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  reason_code := CASE WHEN NOT actor_ok THEN 'actor_ineligible'
    WHEN receipt.expires_at<=now_at THEN 'receipt_expired'
    WHEN org.policy_revision<>receipt.expected_policy_revision THEN 'policy_conflict'
    WHEN grant_ok IS NOT TRUE THEN 'grant_changed'
    WHEN NOT target_ok THEN 'target_ineligible'
    WHEN org.policy_revision=9007199254740991 THEN 'revision_exhausted'
    ELSE 'applied' END;
  result_id := gen_random_uuid()::text;
  IF reason_code='applied' THEN
    revoke_id := gen_random_uuid()::text;
    UPDATE morrow_identity.workspace_memberships SET active=false
      WHERE organization_id=receipt.organization_id AND workspace_id=receipt.workspace_id AND membership_id=receipt.target_membership_id;
    UPDATE morrow_identity.grants SET payload=jsonb_set(payload,'{revokedAt}',to_jsonb(to_char(now_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      WHERE organization_id=receipt.organization_id AND workspace_id=receipt.workspace_id AND membership_id=receipt.target_membership_id
        AND payload->'revokedAt'='null'::jsonb;
    UPDATE morrow_identity.organizations AS o SET policy_revision=o.policy_revision+1 WHERE o.id=receipt.organization_id RETURNING o.* INTO org;
    result_outcome := 'applied';
  ELSE result_outcome := 'denied'; END IF;
  UPDATE morrow_identity.workspace_revocation_receipts SET consumed_at=now_at WHERE id=receipt.id;
  INSERT INTO morrow_identity.workspace_revocation_results
    (id,receipt_id,organization_id,workspace_id,command_id,actor_principal_id,actor_membership_id,target_membership_id,approval_evidence_id,outcome,reason,revocation_id,policy_revision,recorded_at)
    VALUES (result_id,receipt.id,receipt.organization_id,receipt.workspace_id,receipt.command_id,receipt.actor_principal_id,receipt.actor_membership_id,receipt.target_membership_id,receipt.approval_evidence_id,result_outcome,reason_code,revoke_id,org.policy_revision,now_at);
  RETURN QUERY SELECT result_outcome,revoke_id,org.policy_revision::text,result_id;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.revoke_workspace_access(text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.revoke_workspace_access(text,text,text,text,text,text,text,text) TO morrow_identity_lifecycle;

CREATE OR REPLACE FUNCTION morrow_identity.link_workspace_store(
 p_handoff text,p_command text,p_digest text,p_session text,p_nonce text,p_org text,p_workspace text,p_installation text,p_purpose text,p_policy text,p_ownership text)
RETURNS TABLE(outcome text,link_id text,ownership_revision text,policy_revision text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
 o morrow_identity.organizations%ROWTYPE; c morrow_identity.linking_candidates%ROWTYPE;
 h morrow_identity.linking_handoffs%ROWTYPE; r morrow_identity.linking_reviews%ROWTYPE;
 previous morrow_identity.workspace_link_results%ROWTYPE; association morrow_identity.workspace_store_links%ROWTYPE;
 actor_ok boolean; grant_ok boolean; proof_ok boolean; review_ok boolean; at_time timestamptz;
 grant_start timestamptz; grant_end timestamptz; reason_code text; result_id text; created_link text;
BEGIN
 -- The definer owner is not the calling identity. Neither SET ROLE nor a
 -- subsequently unsafe executor configuration may substitute for this login.
 IF session_user<>'morrow_identity_linking' OR NOT EXISTS(
   SELECT 1 FROM pg_roles x WHERE x.rolname=session_user AND NOT x.rolsuper
     AND NOT x.rolbypassrls AND NOT x.rolcreatedb AND NOT x.rolcreaterole AND NOT x.rolinherit
     AND morrow_identity.executor_memberships_closed(x.rolname)) THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_handoff IS NULL OR p_command IS NULL OR p_digest IS NULL OR p_session IS NULL OR p_nonce IS NULL OR p_org IS NULL OR p_workspace IS NULL OR p_installation IS NULL OR p_purpose IS NULL OR p_policy IS NULL OR p_ownership IS NULL
   OR p_handoff !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_command !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_installation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_digest !~ '^[a-f0-9]{64}$' OR p_session !~ '^[a-f0-9]{64}$' OR p_nonce !~ '^[a-f0-9]{64}$'
   OR p_purpose NOT IN ('install_first','workspace_first','existing_account','additional_store','cross_host_resume')
   OR p_policy !~ '^[1-9][0-9]{0,15}$' OR p_ownership !~ '^[1-9][0-9]{0,15}$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_policy::numeric>9007199254740991 OR p_ownership::numeric>9007199254740991 THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO o FROM morrow_identity.organizations WHERE id::text=p_org FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 -- Read the exact private locator only; authority comes from locked records below.
 SELECT * INTO h FROM morrow_identity.linking_handoffs WHERE id::text=p_handoff AND organization_id=o.id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO c FROM morrow_identity.linking_candidates WHERE id=h.candidate_id FOR UPDATE;
 SELECT * INTO h FROM morrow_identity.linking_handoffs WHERE id::text=p_handoff AND organization_id=o.id FOR UPDATE;
 IF h.workspace_id::text<>p_workspace OR h.installation_id::text<>p_installation OR h.session_digest<>p_session OR h.nonce_digest<>p_nonce
   OR h.purpose<>p_purpose OR h.expected_policy_revision::text<>p_policy OR h.expected_ownership_revision::text<>p_ownership THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF h.command_id::text<>p_command OR h.request_digest<>p_digest THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO r FROM morrow_identity.linking_reviews WHERE id=h.review_id FOR UPDATE;
 PERFORM morrow_identity.lock_session_eligibility(h.session_digest,h.workspace_id::text,h.actor_principal_id::text,h.organization_id::text);
 PERFORM 1 FROM morrow_identity.principals WHERE id=h.actor_principal_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.workspaces WHERE id=h.workspace_id AND organization_id=h.organization_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.memberships WHERE id=h.actor_membership_id AND organization_id=h.organization_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.workspace_memberships WHERE workspace_id=h.workspace_id AND membership_id=h.actor_membership_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.grants WHERE id=h.authorizing_grant_id FOR UPDATE;
 SELECT * INTO association FROM morrow_identity.workspace_store_links WHERE candidate_id=c.id FOR UPDATE;
 at_time:=clock_timestamp();
 actor_ok:=o.active AND EXISTS(SELECT 1 FROM morrow_identity.principals p
   JOIN morrow_identity.memberships m ON m.principal_id=p.id AND m.id=h.actor_membership_id AND m.organization_id=o.id AND m.active
   JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=o.id AND wm.workspace_id=h.workspace_id AND wm.membership_id=m.id AND wm.active
   JOIN morrow_identity.workspaces w ON w.id=wm.workspace_id AND w.organization_id=o.id AND w.active
   JOIN morrow_identity.session_eligibility(h.session_digest,h.workspace_id::text) s ON s.principal_id=p.id::text AND s.organization_id=o.id::text AND s.membership_id=h.actor_membership_id::text
   WHERE p.id=h.actor_principal_id AND p.kind='human' AND p.active);
 grant_ok:=EXISTS(SELECT 1 FROM morrow_identity.grants g WHERE g.id=h.authorizing_grant_id AND g.organization_id=o.id AND g.workspace_id=h.workspace_id
   AND g.principal_id=h.actor_principal_id AND g.membership_id=h.actor_membership_id AND g.payload=h.authorizing_grant_snapshot);
 BEGIN
   grant_start:=(h.authorizing_grant_snapshot->>'validFrom')::timestamptz;
   grant_end:=(h.authorizing_grant_snapshot->>'expiresAt')::timestamptz;
   grant_ok:=grant_ok AND grant_start IS NOT NULL AND isfinite(grant_start) AND grant_start<=at_time
     AND(h.authorizing_grant_snapshot->'expiresAt'='null'::jsonb OR(grant_end IS NOT NULL AND isfinite(grant_end) AND grant_end>at_time));
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN grant_ok:=false; END;
 proof_ok:=c.active AND c.installation_id=h.installation_id AND c.generation=h.generation AND c.eligible_principal_id=h.actor_principal_id
   AND c.proof_id=h.proof_id AND c.proof_revision=h.proof_revision AND c.proof_digest=h.proof_digest
   AND c.proof_created_at<=at_time AND c.proof_expires_at>at_time AND c.proof_revoked_at IS NULL;
 review_ok:=r.organization_id=h.organization_id AND r.workspace_id=h.workspace_id AND r.actor_principal_id=h.actor_principal_id
   AND r.actor_membership_id=h.actor_membership_id AND r.session_digest=h.session_digest AND r.nonce_digest=h.nonce_digest AND r.handoff_id=h.id
   AND r.candidate_id=h.candidate_id AND r.installation_id=h.installation_id AND r.generation=h.generation
   AND r.command_id=h.command_id AND r.request_digest=h.request_digest AND r.purpose=h.purpose
   AND r.expected_policy_revision=h.expected_policy_revision AND r.expected_ownership_revision=h.expected_ownership_revision
   AND r.proof_id=h.proof_id AND r.proof_revision=h.proof_revision AND r.proof_digest=h.proof_digest
   AND r.scope_snapshot=h.requested_scope_snapshot AND r.revoked_at IS NULL AND r.created_at<=at_time;
 SELECT * INTO previous FROM morrow_identity.workspace_link_results WHERE handoff_id=h.id;
 IF FOUND THEN
   -- Historical acknowledgement is not a second write. Old handoff/review TTLs
   -- do not extend authority; current human/grant/proof/ownership still must hold.
   IF actor_ok AND grant_ok IS TRUE AND proof_ok IS TRUE AND review_ok IS TRUE
     AND((previous.outcome='applied' AND association.id=previous.link_id AND association.organization_id=h.organization_id
       AND association.workspace_id=h.workspace_id AND association.installation_id=h.installation_id AND association.generation=h.generation
       AND association.ownership_revision=previous.ownership_revision AND c.ownership_revision=previous.ownership_revision)
       OR(previous.outcome='denied' AND association.id IS NULL AND c.ownership_revision=h.expected_ownership_revision)) THEN
     RETURN QUERY SELECT previous.outcome,previous.link_id::text,previous.ownership_revision::text,previous.policy_revision::text,previous.id::text;
   ELSE RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; END IF; RETURN;
 END IF;
 IF h.consumed_at IS NOT NULL THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 reason_code:=CASE WHEN NOT actor_ok THEN 'actor_ineligible' WHEN grant_ok IS NOT TRUE THEN 'grant_changed'
   WHEN h.created_at>at_time OR h.expires_at<=at_time THEN 'handoff_expired'
   WHEN proof_ok IS NOT TRUE THEN 'proof_invalid' WHEN review_ok IS NOT TRUE OR r.expires_at<=at_time THEN 'review_invalid'
   WHEN h.purpose='cross_host_resume' THEN 'purpose_denied' WHEN o.policy_revision<>h.expected_policy_revision THEN 'policy_conflict'
   WHEN association.id IS NOT NULL OR c.ownership_revision<>h.expected_ownership_revision THEN 'ownership_conflict'
   WHEN o.policy_revision=9007199254740991 OR c.ownership_revision=9007199254740991 THEN 'revision_exhausted' ELSE 'applied' END;
 result_id:=gen_random_uuid()::text;
 IF reason_code='applied' THEN
   created_link:=gen_random_uuid()::text;
   UPDATE morrow_identity.linking_candidates SET ownership_revision=linking_candidates.ownership_revision+1 WHERE id=c.id RETURNING * INTO c;
   UPDATE morrow_identity.organizations SET policy_revision=organizations.policy_revision+1 WHERE id=o.id RETURNING * INTO o;
   INSERT INTO morrow_identity.workspace_store_links VALUES(created_link,c.id,h.organization_id,h.workspace_id,h.installation_id,h.generation,c.ownership_revision,h.actor_principal_id,at_time);
 END IF;
 UPDATE morrow_identity.linking_handoffs SET consumed_at=at_time WHERE id=h.id;
 INSERT INTO morrow_identity.workspace_link_results VALUES(result_id,h.id,h.organization_id,h.workspace_id,h.command_id,h.actor_principal_id,c.id,h.review_id,
   CASE WHEN reason_code='applied' THEN 'applied' ELSE 'denied' END,reason_code,created_link,CASE WHEN reason_code='applied' THEN c.ownership_revision ELSE NULL END,o.policy_revision,at_time);
 RETURN QUERY SELECT CASE WHEN reason_code='applied' THEN 'applied' ELSE 'denied' END,created_link,
   CASE WHEN reason_code='applied' THEN c.ownership_revision::text ELSE NULL END,o.policy_revision::text,result_id;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.link_workspace_store(text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.link_workspace_store(text,text,text,text,text,text,text,text,text,text,text) TO morrow_identity_linking;

COMMIT;
