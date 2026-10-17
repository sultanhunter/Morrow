BEGIN;
-- Local provider-free custody only; original identity SQL remains untouched.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner' OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='morrow_identity_owner' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication)
 OR (SELECT count(*) FROM pg_roles r WHERE r.rolname IN ('morrow_identity_login','morrow_identity_login_maintenance') AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid))<>2
 OR EXISTS(SELECT 1 FROM pg_roles r,pg_roles o WHERE o.rolname='morrow_identity_owner' AND r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance') AND (pg_has_role(r.oid,o.oid,'MEMBER') OR pg_has_role(o.oid,r.oid,'MEMBER'))) THEN RAISE EXCEPTION 'LOGIN_ROLE_PREREQUISITES_INVALID'; END IF;
END $$;
CREATE TABLE morrow_identity.login_controller_configurations (
 configuration_digest text PRIMARY KEY CHECK(configuration_digest ~ '^[a-f0-9]{64}$'),
 controller_protocol text NOT NULL CHECK(controller_protocol='morrow-local-login-84'),
 origin text NOT NULL CHECK(length(origin)<=512 AND origin ~ '^https://[^/@?#[:space:]]+(:[0-9]+)?$'),
 retention_tier text NOT NULL CHECK(retention_tier IN ('development','staging','production')),
 binding_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.authentication_exchange_bindings(binding_id),
 binding_revision morrow_identity.revision NOT NULL,
 environment_id text NOT NULL CHECK(environment_id ~ '^environment_[A-Z0-9]{26}$'),
 application_id text NOT NULL CHECK(application_id ~ '^app_[A-Z0-9]{26}$'),
 client_id text NOT NULL CHECK(client_id ~ '^client_[A-Z0-9]{26}$'),
 redirect_uri text NOT NULL CHECK(redirect_uri=origin||'/auth/workos/callback'),return_path text NOT NULL CHECK(return_path='/'),
 profile_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.identity_verification_profiles(id),
 profile_record_revision morrow_identity.revision NOT NULL,
 issuer text NOT NULL CHECK(issuer='https://api.workos.com/user_management/'||client_id),
 token_profile_revision morrow_identity.revision NOT NULL,
 token_profile_digest text NOT NULL CHECK(token_profile_digest ~ '^[a-f0-9]{64}$'),
 CHECK(configuration_digest=encode(sha256(convert_to(array_to_json(ARRAY['morrow.login.configuration','1',controller_protocol,origin,retention_tier,binding_id::text,binding_revision::text,environment_id,application_id,client_id,redirect_uri,return_path,profile_id::text,profile_record_revision::text,token_profile_digest])::text,'UTF8')),'hex'))
);
CREATE TABLE morrow_identity.login_flow_quotas (
 environment_id text NOT NULL,profile_id morrow_identity.record_id NOT NULL,
 PRIMARY KEY(environment_id,profile_id),FOREIGN KEY(profile_id) REFERENCES morrow_identity.identity_verification_profiles(id)
);
CREATE TABLE morrow_identity.login_command_guards (
 command_digest text PRIMARY KEY CHECK(command_digest ~ '^[a-f0-9]{64}$'),
 flow_id uuid NOT NULL,configuration_digest text NOT NULL REFERENCES morrow_identity.login_controller_configurations(configuration_digest),
 command_kind text NOT NULL CHECK(command_kind IN ('begin','admission','issuer')),created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 UNIQUE(flow_id,command_kind)
);
CREATE TABLE morrow_identity.login_flow_tombstones (
 flow_id uuid PRIMARY KEY,configuration_digest text NOT NULL REFERENCES morrow_identity.login_controller_configurations(configuration_digest),
 phase text NOT NULL CHECK(phase='claimed'),effect_uncertainty boolean NOT NULL CHECK(effect_uncertainty),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at=created_at+interval '300 seconds')
);
CREATE TABLE morrow_identity.login_flows (
 id uuid PRIMARY KEY,configuration_digest text NOT NULL REFERENCES morrow_identity.login_controller_configurations(configuration_digest),
 begin_command_id uuid NOT NULL UNIQUE,admission_command_id uuid NOT NULL UNIQUE,issuer_command_id uuid NOT NULL UNIQUE,
 workspace_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.workspaces(id),
 phase text NOT NULL CHECK(phase IN ('intent','awaiting_callback','claimed')),revision morrow_identity.revision NOT NULL,
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),expires_at timestamptz NOT NULL CHECK(isfinite(expires_at) AND expires_at=created_at+interval '300 seconds'),
 challenge_id uuid UNIQUE REFERENCES morrow_identity.authentication_pkce_challenges(challenge_id),
 state_digest text UNIQUE CHECK(state_digest ~ '^[a-f0-9]{64}$'),cookie_digest text UNIQUE CHECK(cookie_digest ~ '^[a-f0-9]{64}$'),
 browser_proof_digest text CHECK(browser_proof_digest ~ '^[a-f0-9]{64}$'),verifier_digest text CHECK(verifier_digest ~ '^[a-f0-9]{64}$'),
 ciphertext text CHECK(length(ciphertext) BETWEEN 22 AND 683 AND ciphertext ~ '^[A-Za-z0-9_-]+$'),
 encryption_nonce text CHECK(encryption_nonce ~ '^[A-Za-z0-9_-]{16}$'),key_id uuid,aad_digest text CHECK(aad_digest ~ '^[a-f0-9]{64}$'),code_digest text CHECK(code_digest ~ '^[a-f0-9]{64}$'),
 capsule_erased_at timestamptz CHECK(capsule_erased_at IS NULL OR isfinite(capsule_erased_at)),
 CHECK(id<>begin_command_id AND id<>admission_command_id AND id<>issuer_command_id AND begin_command_id<>admission_command_id AND begin_command_id<>issuer_command_id AND admission_command_id<>issuer_command_id),
 CHECK((phase='intent' AND revision>=1 AND challenge_id IS NULL AND state_digest IS NULL AND cookie_digest IS NULL AND browser_proof_digest IS NULL AND verifier_digest IS NULL AND ciphertext IS NULL AND encryption_nonce IS NULL AND key_id IS NULL AND aad_digest IS NULL AND code_digest IS NULL)
 OR (phase IN ('awaiting_callback','claimed') AND challenge_id IS NOT NULL AND state_digest IS NOT NULL AND cookie_digest IS NOT NULL AND browser_proof_digest IS NOT NULL AND verifier_digest IS NOT NULL AND encryption_nonce IS NOT NULL AND key_id IS NOT NULL AND aad_digest IS NOT NULL AND ((phase='awaiting_callback' AND revision>=2 AND code_digest IS NULL AND (ciphertext IS NOT NULL OR capsule_erased_at IS NOT NULL)) OR (phase='claimed' AND revision>=3 AND code_digest IS NOT NULL AND ciphertext IS NULL AND capsule_erased_at IS NOT NULL))))
);
CREATE INDEX login_flows_quota ON morrow_identity.login_flows(configuration_digest,created_at,expires_at);
CREATE TABLE morrow_identity.login_flow_events (
 id uuid PRIMARY KEY,flow_id uuid,configuration_digest text,flow_revision morrow_identity.revision NOT NULL,
 kind text NOT NULL CHECK(kind IN ('created','ready','claimed','expiry_erasure')),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),pseudonymized boolean NOT NULL DEFAULT false,
 CHECK((NOT pseudonymized AND flow_id IS NOT NULL AND configuration_digest IS NOT NULL) OR (pseudonymized AND flow_id IS NULL AND configuration_digest IS NULL)),
 UNIQUE(flow_id,flow_revision)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['login_controller_configurations','login_flow_quotas','login_command_guards','login_flows','login_flow_events','login_flow_tombstones'] LOOP
 EXECUTE format('ALTER TABLE morrow_identity.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE morrow_identity.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY identity_owner ON morrow_identity.%I TO morrow_identity_owner USING(true) WITH CHECK(true)',t);
 EXECUTE format('REVOKE ALL ON morrow_identity.%I FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions,morrow_identity_login,morrow_identity_login_maintenance',t);
 END LOOP;END $$;
CREATE FUNCTION morrow_identity.login_role_safe(maintenance boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT current_user='morrow_identity_owner' AND session_user=CASE WHEN maintenance THEN 'morrow_identity_login_maintenance' ELSE 'morrow_identity_login' END
 AND EXISTS(SELECT 1 FROM pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 AND EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid))
 AND NOT EXISTS(SELECT 1 FROM pg_roles r,pg_roles o WHERE o.rolname='morrow_identity_owner' AND r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance') AND (pg_has_role(r.oid,o.oid,'MEMBER') OR pg_has_role(o.oid,r.oid,'MEMBER')))
$$;
CREATE FUNCTION morrow_identity.login_configuration_current(p_configuration text,p_workspace text) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM morrow_identity.login_controller_configurations c
 JOIN morrow_identity.authentication_bindings b ON b.id=c.binding_id AND b.active AND b.environment_id=c.environment_id AND b.client_id=c.client_id AND b.redirect_uri=c.redirect_uri AND b.return_path=c.return_path
 JOIN morrow_identity.authentication_exchange_bindings x ON x.binding_id=b.id AND x.active AND x.provider_id='workos' AND x.application_id=c.application_id AND x.revision=c.binding_revision
 JOIN morrow_identity.identity_verification_profiles p ON p.id=c.profile_id AND p.state='active' AND p.provider_id='workos' AND p.environment_id=c.environment_id AND p.application_id=c.application_id AND p.client_id=c.client_id AND p.issuer=c.issuer AND p.token_profile_revision=c.token_profile_revision AND p.token_profile_digest=c.token_profile_digest AND p.record_revision=c.profile_record_revision
 JOIN morrow_identity.workspaces w ON w.id::text=p_workspace AND w.active JOIN morrow_identity.organizations o ON o.id=w.organization_id AND o.active
 WHERE c.configuration_digest=p_configuration)
$$;
CREATE FUNCTION morrow_identity.login_preserve_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'LOGIN_RECORD_IMMUTABLE';END IF;
 IF TG_TABLE_NAME='login_flows' THEN
  IF TG_OP='DELETE' AND morrow_identity.login_role_safe(true) AND (OLD.phase<>'claimed' OR EXISTS(SELECT 1 FROM morrow_identity.login_flow_tombstones t WHERE t.flow_id=OLD.id AND t.configuration_digest=OLD.configuration_digest AND t.phase='claimed' AND t.effect_uncertainty)) AND OLD.capsule_erased_at IS NOT NULL AND OLD.expires_at<clock_timestamp()-(CASE WHEN (SELECT retention_tier FROM morrow_identity.login_controller_configurations WHERE configuration_digest=OLD.configuration_digest)='production' THEN interval '30 days' ELSE interval '7 days' END) AND EXISTS(SELECT 1 FROM morrow_identity.login_flow_events e WHERE e.flow_id=OLD.id AND e.kind IN ('expiry_erasure','claimed')) THEN RETURN OLD;END IF;
  IF TG_OP='UPDATE' AND NEW.revision=OLD.revision+1 AND
   (to_jsonb(NEW)-ARRAY['phase','revision','challenge_id','state_digest','cookie_digest','browser_proof_digest','verifier_digest','ciphertext','encryption_nonce','key_id','aad_digest','code_digest','capsule_erased_at'])=(to_jsonb(OLD)-ARRAY['phase','revision','challenge_id','state_digest','cookie_digest','browser_proof_digest','verifier_digest','ciphertext','encryption_nonce','key_id','aad_digest','code_digest','capsule_erased_at']) THEN
   IF morrow_identity.login_role_safe() AND OLD.phase='intent' AND NEW.phase='awaiting_callback' AND OLD.expires_at>clock_timestamp() AND NEW.ciphertext IS NOT NULL AND NEW.capsule_erased_at IS NULL AND NEW.code_digest IS NULL THEN RETURN NEW;END IF;
   IF morrow_identity.login_role_safe() AND OLD.phase='awaiting_callback' AND OLD.ciphertext IS NOT NULL AND NEW.phase='claimed' AND NEW.ciphertext IS NULL AND NEW.capsule_erased_at IS NOT NULL AND NEW.code_digest IS NOT NULL AND OLD.expires_at>clock_timestamp() AND (to_jsonb(NEW)-ARRAY['phase','revision','ciphertext','code_digest','capsule_erased_at'])=(to_jsonb(OLD)-ARRAY['phase','revision','ciphertext','code_digest','capsule_erased_at']) THEN RETURN NEW;END IF;
   IF morrow_identity.login_role_safe(true) AND OLD.expires_at<=clock_timestamp() AND OLD.capsule_erased_at IS NULL AND NEW.capsule_erased_at IS NOT NULL AND NEW.ciphertext IS NULL AND (to_jsonb(NEW)-ARRAY['revision','ciphertext','capsule_erased_at'])=(to_jsonb(OLD)-ARRAY['revision','ciphertext','capsule_erased_at']) THEN RETURN NEW;END IF;
  END IF;
 ELSIF TG_TABLE_NAME='login_flow_events' AND morrow_identity.login_role_safe(true) THEN
  IF TG_OP='UPDATE' AND NOT OLD.pseudonymized AND NEW.pseudonymized AND NEW.flow_id IS NULL AND NEW.configuration_digest IS NULL AND (to_jsonb(NEW)-ARRAY['flow_id','configuration_digest','pseudonymized'])=(to_jsonb(OLD)-ARRAY['flow_id','configuration_digest','pseudonymized']) AND NOT EXISTS(SELECT 1 FROM morrow_identity.login_flows f WHERE f.id=OLD.flow_id) THEN RETURN NEW;END IF;
  IF TG_OP='DELETE' AND OLD.pseudonymized AND OLD.recorded_at<=clock_timestamp()-interval '365 days' THEN RETURN OLD;END IF;
 END IF;
 RAISE EXCEPTION 'LOGIN_RECORD_IMMUTABLE';
END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['login_controller_configurations','login_flow_quotas','login_command_guards','login_flows','login_flow_events','login_flow_tombstones'] LOOP
 EXECUTE format('CREATE TRIGGER login_record_immutable BEFORE UPDATE OR DELETE ON morrow_identity.%I FOR EACH ROW EXECUTE FUNCTION morrow_identity.login_preserve_record()',t);
 EXECUTE format('CREATE TRIGGER login_record_no_truncate BEFORE TRUNCATE ON morrow_identity.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity.login_preserve_record()',t);
 END LOOP;END $$;
CREATE FUNCTION morrow_identity.login_uuid(p text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$SELECT p IS NOT NULL AND p ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'$$;
CREATE FUNCTION morrow_identity.login_digest(p text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$SELECT p IS NOT NULL AND p ~ '^[a-f0-9]{64}$'$$;
CREATE FUNCTION morrow_identity.login_b64(p text,minimum integer,maximum integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE raw bytea;BEGIN IF p IS NULL OR p !~ '^[A-Za-z0-9_-]+$' OR length(p)>((maximum*4+2)/3) OR length(p)%4=1 THEN RETURN false;END IF;
 raw:=decode(translate(p,'-_','+/')||repeat('=',(4-length(p)%4)%4),'base64');RETURN length(raw) BETWEEN minimum AND maximum AND replace(rtrim(encode(raw,'base64'),'='),E'\n','')=translate(p,'-_','+/');EXCEPTION WHEN OTHERS THEN RETURN false;END $$;
CREATE FUNCTION morrow_identity.create_login_flow_intent(p_configuration text,p_flow text,p_begin text,p_admission text,p_issuer text,p_workspace text)
RETURNS TABLE(outcome text,flow_id text,flow_revision text,expires_at_ms text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE c morrow_identity.login_controller_configurations%ROWTYPE;instant timestamptz;a uuid;BEGIN
 IF NOT morrow_identity.login_role_safe() OR NOT morrow_identity.login_digest(p_configuration) OR NOT morrow_identity.login_uuid(p_flow) OR NOT morrow_identity.login_uuid(p_begin) OR NOT morrow_identity.login_uuid(p_admission) OR NOT morrow_identity.login_uuid(p_issuer) OR p_workspace IS NULL OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR (SELECT count(DISTINCT v) FROM unnest(ARRAY[p_flow,p_begin,p_admission,p_issuer])v)<>4 THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO c FROM morrow_identity.login_controller_configurations WHERE configuration_digest=p_configuration FOR SHARE;
 IF NOT FOUND OR NOT morrow_identity.login_configuration_current(p_configuration,p_workspace) THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 INSERT INTO morrow_identity.login_flow_quotas VALUES(c.environment_id,c.profile_id) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM morrow_identity.login_flow_quotas q WHERE q.environment_id=c.environment_id AND q.profile_id=c.profile_id FOR UPDATE;
 instant:=clock_timestamp();
 IF EXISTS(SELECT 1 FROM morrow_identity.login_flows f JOIN morrow_identity.login_controller_configurations k ON k.configuration_digest=f.configuration_digest WHERE k.environment_id=c.environment_id AND k.profile_id=c.profile_id AND f.created_at>instant-interval '10 seconds' HAVING count(*)>=10) THEN RETURN QUERY SELECT 'rate_limited'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM morrow_identity.login_flows f JOIN morrow_identity.login_controller_configurations k ON k.configuration_digest=f.configuration_digest WHERE k.environment_id=c.environment_id AND k.profile_id=c.profile_id AND f.expires_at>instant HAVING count(*)>=100) THEN RETURN QUERY SELECT 'quota_limited'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM morrow_identity.authentication_pkce_challenges k WHERE k.begin_command_id::text=ANY(ARRAY[p_begin,p_admission,p_issuer])) OR EXISTS(SELECT 1 FROM morrow_identity.authentication_exchange_admissions r WHERE r.command_id::text=ANY(ARRAY[p_begin,p_admission,p_issuer])) OR EXISTS(SELECT 1 FROM morrow_identity.browser_session_commands r WHERE r.command_id::text=ANY(ARRAY[p_begin,p_admission,p_issuer])) THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 BEGIN
 INSERT INTO morrow_identity.login_command_guards(command_digest,flow_id,configuration_digest,command_kind,created_at) VALUES(encode(sha256(convert_to(p_begin,'UTF8')),'hex'),p_flow::uuid,p_configuration,'begin',instant),(encode(sha256(convert_to(p_admission,'UTF8')),'hex'),p_flow::uuid,p_configuration,'admission',instant),(encode(sha256(convert_to(p_issuer,'UTF8')),'hex'),p_flow::uuid,p_configuration,'issuer',instant);
 INSERT INTO morrow_identity.login_flows(id,configuration_digest,begin_command_id,admission_command_id,issuer_command_id,workspace_id,phase,revision,created_at,expires_at) VALUES(p_flow::uuid,p_configuration,p_begin::uuid,p_admission::uuid,p_issuer::uuid,p_workspace,'intent',1,instant,instant+interval '300 seconds');
 a:=gen_random_uuid();INSERT INTO morrow_identity.login_flow_events VALUES(a,p_flow::uuid,p_configuration,1,'created',instant,false);
 IF clock_timestamp()>=instant+interval '300 seconds' OR NOT morrow_identity.login_configuration_current(p_configuration,p_workspace) THEN RAISE EXCEPTION USING ERRCODE='P8410',MESSAGE='LOGIN_FLOW_LATE';END IF;
 EXCEPTION WHEN unique_violation THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; WHEN SQLSTATE 'P8410' THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END;
 RETURN QUERY SELECT 'newly_created'::text,p_flow,'1'::text,floor(extract(epoch FROM instant+interval '300 seconds')*1000)::bigint::text,a::text;
END $$;
CREATE FUNCTION morrow_identity.bind_login_flow_begin(p_configuration text,p_flow text,p_revision text,p_challenge text,p_state text,p_cookie text,p_browser text,p_verifier text,p_cipher text,p_nonce text,p_key text,p_aad text)
RETURNS TABLE(outcome text,flow_id text,flow_revision text,expires_at_ms text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE f morrow_identity.login_flows%ROWTYPE;c morrow_identity.login_controller_configurations%ROWTYPE;ch morrow_identity.authentication_challenges%ROWTYPE;k morrow_identity.authentication_pkce_challenges%ROWTYPE;a uuid;instant timestamptz;expires text;BEGIN
 IF NOT morrow_identity.login_role_safe() OR NOT morrow_identity.login_digest(p_configuration) OR NOT morrow_identity.login_uuid(p_flow) OR p_revision IS NULL OR p_revision !~ '^[1-9][0-9]{0,15}$' OR NOT morrow_identity.login_uuid(p_challenge) OR NOT morrow_identity.login_uuid(p_key) OR NOT morrow_identity.login_digest(p_state) OR NOT morrow_identity.login_digest(p_cookie) OR NOT morrow_identity.login_digest(p_browser) OR NOT morrow_identity.login_digest(p_verifier) OR NOT morrow_identity.login_digest(p_aad) OR NOT morrow_identity.login_b64(p_cipher,16,512) OR NOT morrow_identity.login_b64(p_nonce,12,12) THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_revision::numeric>9007199254740991 THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO c FROM morrow_identity.login_controller_configurations WHERE configuration_digest=p_configuration FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO f FROM morrow_identity.login_flows WHERE id::text=p_flow AND configuration_digest=p_configuration FOR UPDATE;
 IF NOT FOUND OR f.phase<>'intent' THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF f.revision::text<>p_revision THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO ch FROM morrow_identity.authentication_challenges WHERE id::text=p_challenge;
 SELECT * INTO k FROM morrow_identity.authentication_pkce_challenges WHERE challenge_id::text=p_challenge;
 instant:=clock_timestamp();expires:=floor(extract(epoch FROM f.expires_at)*1000)::bigint::text;
 IF NOT FOUND OR ch.id IS NULL OR ch.consumed_at IS NOT NULL OR ch.created_at>instant OR ch.expires_at<=instant OR f.expires_at<=instant OR NOT morrow_identity.login_configuration_current(p_configuration,f.workspace_id::text) OR k.begin_command_id::text<>f.begin_command_id::text OR k.binding_id<>c.binding_id OR k.binding_revision<>c.binding_revision OR k.application_id<>c.application_id OR k.verifier_digest<>p_verifier OR k.method<>'S256' OR ch.binding_id<>c.binding_id OR ch.environment_id<>c.environment_id OR ch.client_id<>c.client_id OR ch.redirect_uri<>c.redirect_uri OR ch.return_path<>c.return_path OR ch.state_digest<>p_state OR ch.browser_digest<>p_browser OR p_aad<>encode(sha256(convert_to(array_to_json(ARRAY['morrow.login.capsule','1',p_configuration,p_flow,p_challenge,f.begin_command_id::text,f.admission_command_id::text,f.issuer_command_id::text,f.workspace_id::text,expires,p_state,p_cookie,p_browser,p_verifier,p_key])::text,'UTF8')),'hex') THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 BEGIN
 UPDATE morrow_identity.login_flows SET phase='awaiting_callback',revision=revision+1,challenge_id=p_challenge::uuid,state_digest=p_state,cookie_digest=p_cookie,browser_proof_digest=p_browser,verifier_digest=p_verifier,ciphertext=p_cipher,encryption_nonce=p_nonce,key_id=p_key::uuid,aad_digest=p_aad WHERE id=f.id;
 a:=gen_random_uuid();INSERT INTO morrow_identity.login_flow_events VALUES(a,f.id,p_configuration,f.revision+1,'ready',instant,false);
 IF clock_timestamp()>=f.expires_at OR NOT morrow_identity.login_configuration_current(p_configuration,f.workspace_id::text) THEN RAISE EXCEPTION USING ERRCODE='P8410',MESSAGE='LOGIN_FLOW_LATE';END IF;
 EXCEPTION WHEN unique_violation THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; WHEN SQLSTATE 'P8410' THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END;
 RETURN QUERY SELECT 'newly_ready'::text,p_flow,(f.revision+1)::text,expires,a::text;
END $$;
CREATE FUNCTION morrow_identity.claim_login_callback(p_configuration text,p_cookie text,p_state text,p_code text)
RETURNS TABLE(outcome text,flow_id text,flow_revision text,expires_at_ms text,audit_id text,challenge_id text,begin_command_id text,admission_command_id text,issuer_command_id text,workspace_id text,state_digest text,cookie_digest text,browser_proof_digest text,verifier_digest text,ciphertext text,encryption_nonce text,key_id text,aad_digest text,code_digest text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE f morrow_identity.login_flows%ROWTYPE;instant timestamptz;a uuid;BEGIN
 IF NOT morrow_identity.login_role_safe() OR NOT morrow_identity.login_digest(p_configuration) OR NOT morrow_identity.login_digest(p_cookie) OR NOT morrow_identity.login_digest(p_state) OR NOT morrow_identity.login_digest(p_code) THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 PERFORM 1 FROM morrow_identity.login_controller_configurations WHERE configuration_digest=p_configuration FOR SHARE;IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 SELECT fl.* INTO f FROM morrow_identity.login_flows fl WHERE fl.configuration_digest=p_configuration AND fl.cookie_digest=p_cookie AND fl.state_digest=p_state FOR UPDATE;
 IF NOT FOUND OR f.phase<>'awaiting_callback' OR f.ciphertext IS NULL THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 instant:=clock_timestamp();IF f.created_at>instant OR f.expires_at<=instant OR NOT morrow_identity.login_configuration_current(p_configuration,f.workspace_id::text) OR NOT EXISTS(SELECT 1 FROM morrow_identity.authentication_challenges ch JOIN morrow_identity.authentication_pkce_challenges k ON k.challenge_id=ch.id WHERE ch.id=f.challenge_id AND ch.consumed_at IS NULL AND ch.expires_at>instant AND k.begin_command_id::text=f.begin_command_id::text AND k.verifier_digest=f.verifier_digest) THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 BEGIN
 UPDATE morrow_identity.login_flows SET phase='claimed',revision=revision+1,code_digest=p_code,ciphertext=NULL,capsule_erased_at=instant WHERE id=f.id;
 a:=gen_random_uuid();INSERT INTO morrow_identity.login_flow_events VALUES(a,f.id,p_configuration,f.revision+1,'claimed',instant,false);
 IF clock_timestamp()>=f.expires_at OR NOT morrow_identity.login_configuration_current(p_configuration,f.workspace_id::text) THEN RAISE EXCEPTION USING ERRCODE='P8410',MESSAGE='LOGIN_FLOW_LATE';END IF;
 EXCEPTION WHEN SQLSTATE 'P8410' THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END;
 RETURN QUERY SELECT 'newly_claimed'::text,f.id::text,(f.revision+1)::text,floor(extract(epoch FROM f.expires_at)*1000)::bigint::text,a::text,f.challenge_id::text,f.begin_command_id::text,f.admission_command_id::text,f.issuer_command_id::text,f.workspace_id::text,f.state_digest,f.cookie_digest,f.browser_proof_digest,f.verifier_digest,f.ciphertext,f.encryption_nonce,f.key_id::text,f.aad_digest,p_code;
END $$;
CREATE FUNCTION morrow_identity.observe_login_flow_eligibility(p_flow text,p_configuration text) RETURNS TABLE(matches boolean,database_now_ms text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE instant timestamptz;ok boolean;BEGIN
 ok:=morrow_identity.login_role_safe() AND morrow_identity.login_uuid(p_flow) AND morrow_identity.login_digest(p_configuration) AND EXISTS(SELECT 1 FROM morrow_identity.login_flows f WHERE f.id::text=p_flow AND f.configuration_digest=p_configuration AND f.phase='claimed' AND f.created_at<=clock_timestamp() AND f.expires_at>clock_timestamp() AND morrow_identity.login_configuration_current(p_configuration,f.workspace_id::text));instant:=clock_timestamp();
 RETURN QUERY SELECT coalesce(ok,false) AND EXISTS(SELECT 1 FROM morrow_identity.login_flows f WHERE f.id::text=p_flow AND f.expires_at>instant),floor(extract(epoch FROM instant)*1000)::bigint::text;
END $$;
CREATE FUNCTION morrow_identity.reconcile_login_flow(p_configuration text,p_flow text,p_begin text,p_admission text,p_issuer text)
RETURNS TABLE(outcome text,phase text,flow_revision text,expires_at_ms text,admission_id text,issuer_request_digest text,issuer_outcome text,family_id text,generation_id text,provider_binding_id text,family_expires_at_ms text,issuer_audit_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE f morrow_identity.login_flows%ROWTYPE;c morrow_identity.login_controller_configurations%ROWTYPE;r morrow_identity.authentication_exchange_admissions%ROWTYPE;m morrow_identity.browser_session_commands%ROWTYPE;found_m boolean;BEGIN
 IF NOT morrow_identity.login_role_safe() OR NOT morrow_identity.login_digest(p_configuration) OR NOT morrow_identity.login_uuid(p_flow) OR NOT morrow_identity.login_uuid(p_begin) OR NOT morrow_identity.login_uuid(p_admission) OR NOT morrow_identity.login_uuid(p_issuer) THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 SELECT * INTO c FROM morrow_identity.login_controller_configurations WHERE configuration_digest=p_configuration;
 SELECT * INTO f FROM morrow_identity.login_flows WHERE id::text=p_flow AND configuration_digest=p_configuration AND begin_command_id::text=p_begin AND admission_command_id::text=p_admission AND issuer_command_id::text=p_issuer;
 IF NOT FOUND THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 SELECT a.* INTO r FROM morrow_identity.authentication_exchange_admissions a JOIN morrow_identity.authentication_pkce_challenges k ON k.challenge_id=a.challenge_id JOIN morrow_identity.authentication_challenges ch ON ch.id=k.challenge_id
 WHERE a.command_id::text=p_admission AND a.challenge_id=f.challenge_id AND a.provider_id='workos' AND a.environment_id=c.environment_id AND a.client_id=c.client_id AND a.code_digest=f.code_digest AND k.begin_command_id::text=p_begin AND k.binding_id=c.binding_id AND k.binding_revision=c.binding_revision AND k.application_id=c.application_id AND k.verifier_digest=f.verifier_digest AND k.method='S256' AND ch.binding_id=c.binding_id AND ch.environment_id=c.environment_id AND ch.client_id=c.client_id AND ch.redirect_uri=c.redirect_uri AND ch.return_path=c.return_path AND ch.state_digest=f.state_digest AND ch.browser_digest=f.browser_proof_digest;
 IF EXISTS(SELECT 1 FROM morrow_identity.authentication_exchange_admissions a WHERE a.command_id::text=p_admission) AND r.id IS NULL THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 SELECT * INTO m FROM morrow_identity.browser_session_commands WHERE command_id::text=p_issuer;found_m:=FOUND;
 IF found_m THEN
 IF (SELECT count(*) FROM jsonb_array_elements(m.request_tuple) e WHERE jsonb_typeof(e)='string')<>26 OR m.request_digest IS DISTINCT FROM encode(sha256(convert_to(array_to_json(ARRAY(SELECT e.value#>>'{}' FROM jsonb_array_elements(m.request_tuple) WITH ORDINALITY e(value,n) ORDER BY e.n))::text,'UTF8')),'hex') OR r.id IS NULL OR m.request_tuple->>0 IS DISTINCT FROM p_issuer OR m.request_tuple->>1 IS DISTINCT FROM 'workos' OR m.request_tuple->>2 IS DISTINCT FROM c.environment_id OR m.request_tuple->>3 IS DISTINCT FROM c.application_id OR m.request_tuple->>4 IS DISTINCT FROM c.client_id OR m.request_tuple->>5 IS DISTINCT FROM c.issuer OR m.request_tuple->>6 IS DISTINCT FROM c.token_profile_revision::text OR m.request_tuple->>7 IS DISTINCT FROM c.token_profile_digest OR m.request_tuple->>10 IS DISTINCT FROM f.workspace_id::text OR m.request_tuple->>17 IS DISTINCT FROM c.profile_id::text OR m.request_tuple->>18 IS DISTINCT FROM c.profile_record_revision::text OR NOT EXISTS(SELECT 1 FROM morrow_identity.browser_session_audits a WHERE a.id=m.audit_id AND a.command_id=m.command_id AND a.request_digest=m.request_digest AND a.kind='admit' AND a.outcome=m.outcome AND a.target_id IS NOT DISTINCT FROM m.family_id) THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 IF m.outcome='admitted' AND (m.request_tuple->>24 IS DISTINCT FROM m.family_id::text OR m.request_tuple->>25 IS DISTINCT FROM m.generation_id::text OR NOT EXISTS(SELECT 1 FROM morrow_identity.browser_session_families bf JOIN morrow_identity.browser_session_generations g ON g.family_id=bf.id JOIN morrow_identity.provider_session_bindings pb ON pb.id=bf.provider_binding_id JOIN morrow_identity.provider_subject_mappings sm ON sm.id=pb.mapping_id WHERE bf.id=m.family_id AND g.id=m.generation_id AND pb.id=m.provider_binding_id AND pb.provider_id='workos' AND pb.environment_id=c.environment_id AND pb.client_id=c.client_id AND pb.profile_id=c.profile_id AND pb.provider_session_id=m.request_tuple->>9 AND sm.subject_id=m.request_tuple->>8 AND sm.id::text=m.request_tuple->>19 AND g.expires_at=m.expires_at AND bf.expires_at=m.expires_at)) THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 END IF;
 RETURN QUERY SELECT 'observed'::text,f.phase,f.revision::text,floor(extract(epoch FROM f.expires_at)*1000)::bigint::text,r.id::text,CASE WHEN found_m THEN m.request_digest END,CASE WHEN found_m THEN m.outcome END,m.family_id::text,m.generation_id::text,m.provider_binding_id::text,CASE WHEN m.expires_at IS NOT NULL THEN floor(extract(epoch FROM m.expires_at)*1000)::bigint::text END,m.audit_id::text;
END $$;
CREATE FUNCTION morrow_identity.maintain_login_flows(p_configuration text) RETURNS TABLE(outcome text,erased_capsules text,pruned_closed_states text,pseudonymized_audits text,pruned_audits text,retained_unresolved text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE c morrow_identity.login_controller_configurations%ROWTYPE;f morrow_identity.login_flows%ROWTYPE;e morrow_identity.login_flow_events%ROWTYPE;instant timestamptz;erased integer:=0;pruned integer:=0;pseudo integer:=0;audits integer:=0;unresolved integer;retention interval;
BEGIN
 IF NOT morrow_identity.login_role_safe(true) OR NOT morrow_identity.login_digest(p_configuration) THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN;END IF;
 SELECT * INTO c FROM morrow_identity.login_controller_configurations WHERE configuration_digest=p_configuration FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN;END IF;
 instant:=clock_timestamp();retention:=CASE WHEN c.retention_tier='production' THEN interval '30 days' ELSE interval '7 days' END;
 FOR f IN SELECT * FROM morrow_identity.login_flows WHERE configuration_digest=p_configuration AND expires_at<=instant AND capsule_erased_at IS NULL ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
 UPDATE morrow_identity.login_flows SET ciphertext=NULL,capsule_erased_at=instant,revision=revision+1 WHERE id=f.id;
 INSERT INTO morrow_identity.login_flow_events VALUES(gen_random_uuid(),f.id,p_configuration,f.revision+1,'expiry_erasure',instant,false);erased:=erased+1;
 END LOOP;
 FOR f IN SELECT * FROM morrow_identity.login_flows WHERE configuration_digest=p_configuration AND capsule_erased_at IS NOT NULL AND expires_at<=instant-retention ORDER BY expires_at,id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
 IF f.phase='claimed' THEN INSERT INTO morrow_identity.login_flow_tombstones VALUES(f.id,p_configuration,'claimed',true,f.created_at,f.expires_at);ELSE pruned:=pruned+1;END IF;
 DELETE FROM morrow_identity.login_flows WHERE id=f.id;
 END LOOP;
 FOR e IN SELECT * FROM morrow_identity.login_flow_events x WHERE configuration_digest=p_configuration AND NOT pseudonymized AND NOT EXISTS(SELECT 1 FROM morrow_identity.login_flows lf WHERE lf.id=x.flow_id) AND recorded_at<=instant-retention ORDER BY recorded_at,id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
 UPDATE morrow_identity.login_flow_events SET flow_id=NULL,configuration_digest=NULL,pseudonymized=true WHERE id=e.id;pseudo:=pseudo+1;
 END LOOP;
 -- Pseudonymized rows no longer carry configuration association. Maintenance
 -- can remove only old minimized events; unresolved rows are never candidates.
 FOR e IN SELECT * FROM morrow_identity.login_flow_events WHERE pseudonymized AND recorded_at<=instant-interval '365 days' ORDER BY recorded_at,id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
 DELETE FROM morrow_identity.login_flow_events WHERE id=e.id;audits:=audits+1;
 END LOOP;
 SELECT count(*)::integer INTO unresolved FROM (SELECT id FROM morrow_identity.login_flows WHERE configuration_digest=p_configuration AND phase='claimed' UNION ALL SELECT flow_id FROM morrow_identity.login_flow_tombstones WHERE configuration_digest=p_configuration LIMIT 100) x;
 RETURN QUERY SELECT 'completed'::text,erased::text,pruned::text,pseudo::text,audits::text,unresolved::text;
END $$;
DO $$ DECLARE r record; BEGIN FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND p.proname IN ('login_role_safe','login_configuration_current','login_preserve_record','login_uuid','login_digest','login_b64','create_login_flow_intent','bind_login_flow_begin','claim_login_callback','observe_login_flow_eligibility','reconcile_login_flow','maintain_login_flows') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions,morrow_identity_login,morrow_identity_login_maintenance',r.signature); END LOOP;END $$;
GRANT USAGE ON SCHEMA morrow_identity TO morrow_identity_login,morrow_identity_login_maintenance;
GRANT EXECUTE ON FUNCTION morrow_identity.create_login_flow_intent(text,text,text,text,text,text),morrow_identity.bind_login_flow_begin(text,text,text,text,text,text,text,text,text,text,text,text),morrow_identity.claim_login_callback(text,text,text,text),morrow_identity.observe_login_flow_eligibility(text,text),morrow_identity.reconcile_login_flow(text,text,text,text,text) TO morrow_identity_login;
GRANT EXECUTE ON FUNCTION morrow_identity.maintain_login_flows(text) TO morrow_identity_login_maintenance;
COMMIT;
