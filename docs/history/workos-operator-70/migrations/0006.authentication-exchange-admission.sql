BEGIN;
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('morrow_identity_owner','morrow_api','morrow_identity_lifecycle','morrow_identity_linking') AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole))
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='morrow_identity_owner' AND rolcanlogin)
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='morrow_identity_owner') AND member IN (SELECT oid FROM pg_roles WHERE rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth')))
 OR pg_has_role('morrow_api','morrow_identity_owner','MEMBER') OR pg_has_role('morrow_identity_lifecycle','morrow_identity_owner','MEMBER') OR pg_has_role('morrow_identity_linking','morrow_identity_owner','MEMBER')
 OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='morrow_identity_preauth' AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)) THEN
  RAISE EXCEPTION 'PREAUTH_ROLE_PREREQUISITES_INVALID';
 END IF;
END $$;
GRANT USAGE ON SCHEMA morrow_identity TO morrow_identity_preauth;
CREATE TABLE morrow_identity.authentication_exchange_bindings (
 binding_id morrow_identity.record_id PRIMARY KEY REFERENCES morrow_identity.authentication_bindings(id),
 provider_id text NOT NULL CHECK(provider_id='workos'),
 application_id text NOT NULL CHECK(application_id ~ '^app_[A-Z0-9]{26}$'),
 revision morrow_identity.revision NOT NULL,
 active boolean NOT NULL DEFAULT false
);
CREATE TABLE morrow_identity.authentication_pkce_challenges (
 challenge_id uuid PRIMARY KEY REFERENCES morrow_identity.authentication_challenges(id),
 begin_command_id morrow_identity.record_id NOT NULL UNIQUE,
 binding_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.authentication_exchange_bindings(binding_id),
 binding_revision morrow_identity.revision NOT NULL,
 application_id text NOT NULL CHECK(application_id ~ '^app_[A-Z0-9]{26}$'),
 verifier_digest text NOT NULL CHECK(verifier_digest ~ '^[a-f0-9]{64}$'),
 method text NOT NULL CHECK(method='S256')
);
CREATE TABLE morrow_identity.authentication_exchange_admissions (
 id uuid PRIMARY KEY,
 command_id morrow_identity.record_id NOT NULL UNIQUE,
 challenge_id uuid NOT NULL UNIQUE REFERENCES morrow_identity.authentication_pkce_challenges(challenge_id),
 provider_id text NOT NULL CHECK(provider_id='workos'),
 environment_id text NOT NULL CHECK(environment_id ~ '^environment_[A-Z0-9]{26}$'),
 client_id text NOT NULL CHECK(client_id ~ '^client_[A-Z0-9]{26}$'),
 code_digest text NOT NULL CHECK(code_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
 UNIQUE(provider_id,environment_id,client_id,code_digest)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['authentication_exchange_bindings','authentication_pkce_challenges','authentication_exchange_admissions'] LOOP
  EXECUTE format('ALTER TABLE morrow_identity.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_identity.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY identity_owner ON morrow_identity.%I TO morrow_identity_owner USING(true) WITH CHECK(true)',t);
 END LOOP;
END $$;
CREATE FUNCTION morrow_identity.preauth_role_safe() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT session_user='morrow_identity_preauth' AND EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid))
$$;
REVOKE ALL ON FUNCTION morrow_identity.preauth_role_safe() FROM PUBLIC;
CREATE FUNCTION morrow_identity.preserve_preauth_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='authentication_challenges' THEN
  IF NOT EXISTS(SELECT 1 FROM morrow_identity.authentication_pkce_challenges WHERE challenge_id=OLD.id) THEN
   IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
   IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND morrow_identity.preauth_role_safe()
    AND (to_jsonb(OLD)-'consumed_at')=(to_jsonb(NEW)-'consumed_at') THEN RETURN NEW; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'PREAUTH_RECORD_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION morrow_identity.preserve_preauth_record() FROM PUBLIC;
CREATE TRIGGER pkce_record_immutable BEFORE UPDATE OR DELETE ON morrow_identity.authentication_pkce_challenges FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_preauth_record();
CREATE TRIGGER admission_record_immutable BEFORE UPDATE OR DELETE ON morrow_identity.authentication_exchange_admissions FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_preauth_record();
CREATE TRIGGER pkce_challenge_immutable BEFORE UPDATE OR DELETE ON morrow_identity.authentication_challenges FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_preauth_record();
-- Scalar-only guard: no casts until shape/length checks have passed.
CREATE FUNCTION morrow_identity.preauth_inputs_valid(p_command text,p_challenge text,p_binding text,p_revision text,p_environment text,p_application text,p_client text,p_redirect text,p_return text,p_state text,p_browser text,p_verifier text,p_code text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
 IF p_command IS NULL OR p_challenge IS NULL OR p_binding IS NULL OR p_revision IS NULL OR p_environment IS NULL OR p_application IS NULL OR p_client IS NULL OR p_redirect IS NULL OR p_return IS NULL OR p_state IS NULL OR p_browser IS NULL OR p_verifier IS NULL OR p_code IS NULL
  OR p_command !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_binding !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_challenge !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_revision !~ '^[1-9][0-9]{0,15}$'
  OR p_environment !~ '^environment_[A-Z0-9]{26}$' OR p_application !~ '^app_[A-Z0-9]{26}$' OR p_client !~ '^client_[A-Z0-9]{26}$'
  OR length(p_redirect) NOT BETWEEN 1 AND 2048 OR length(p_return) NOT BETWEEN 1 AND 512
  OR p_state !~ '^[a-f0-9]{64}$' OR p_browser !~ '^[a-f0-9]{64}$' OR p_verifier !~ '^[a-f0-9]{64}$' OR p_code !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 RETURN p_revision::numeric<=9007199254740991;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.preauth_inputs_valid(text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
CREATE FUNCTION morrow_identity.begin_authentication_exchange(p_challenge text,p_command text,p_binding text,p_revision text,p_environment text,p_application text,p_client text,p_redirect text,p_return text,p_state text,p_browser text,p_verifier text) RETURNS TABLE(challenge_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE b morrow_identity.authentication_bindings%ROWTYPE; a morrow_identity.authentication_exchange_bindings%ROWTYPE; instant timestamptz;
BEGIN
 IF NOT morrow_identity.preauth_role_safe() OR NOT morrow_identity.preauth_inputs_valid(p_command,p_challenge,p_binding,p_revision,p_environment,p_application,p_client,p_redirect,p_return,p_state,p_browser,p_verifier,p_verifier) THEN RETURN; END IF;
 SELECT * INTO b FROM morrow_identity.authentication_bindings WHERE id::text=p_binding FOR SHARE;
 IF NOT FOUND OR NOT b.active OR b.environment_id<>p_environment OR b.client_id<>p_client OR b.redirect_uri<>p_redirect OR b.return_path<>p_return THEN RETURN; END IF;
 SELECT * INTO a FROM morrow_identity.authentication_exchange_bindings WHERE binding_id=b.id FOR SHARE;
 IF NOT FOUND OR NOT a.active OR a.application_id<>p_application OR a.revision::text<>p_revision THEN RETURN; END IF;
 -- Namespaces are deliberately distinct; collisions only add serialization.
 PERFORM pg_advisory_xact_lock(69001,hashtext(p_command));
 IF EXISTS(SELECT 1 FROM morrow_identity.authentication_pkce_challenges WHERE begin_command_id::text=p_command) THEN RETURN; END IF;
 instant:=clock_timestamp();
 BEGIN
  INSERT INTO morrow_identity.authentication_challenges(id,binding_id,environment_id,client_id,redirect_uri,return_path,state_digest,browser_digest,created_at,expires_at)
   VALUES(p_challenge::uuid,b.id,b.environment_id,b.client_id,b.redirect_uri,b.return_path,p_state,p_browser,instant,instant+interval '5 minutes');
  INSERT INTO morrow_identity.authentication_pkce_challenges VALUES(p_challenge::uuid,p_command,b.id,a.revision,a.application_id,p_verifier,'S256');
  IF clock_timestamp()>=instant+interval '5 minutes' THEN RAISE EXCEPTION USING ERRCODE='P6901',MESSAGE='PREAUTH_EXPIRED'; END IF;
 EXCEPTION WHEN unique_violation OR SQLSTATE 'P6901' THEN RETURN;
 END;
 RETURN QUERY SELECT p_challenge;
END $$;
CREATE FUNCTION morrow_identity.admit_authentication_exchange(p_command text,p_challenge text,p_binding text,p_revision text,p_environment text,p_application text,p_client text,p_redirect text,p_return text,p_state text,p_browser text,p_verifier text,p_code text) RETURNS TABLE(outcome text,admission_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE b morrow_identity.authentication_bindings%ROWTYPE; a morrow_identity.authentication_exchange_bindings%ROWTYPE;
 c morrow_identity.authentication_challenges%ROWTYPE; k morrow_identity.authentication_pkce_challenges%ROWTYPE;
 previous morrow_identity.authentication_exchange_admissions%ROWTYPE; reservation uuid; instant timestamptz;
BEGIN
 IF NOT morrow_identity.preauth_role_safe() OR NOT morrow_identity.preauth_inputs_valid(p_command,p_challenge,p_binding,p_revision,p_environment,p_application,p_client,p_redirect,p_return,p_state,p_browser,p_verifier,p_code) THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT * INTO b FROM morrow_identity.authentication_bindings WHERE id::text=p_binding FOR SHARE;
 IF NOT FOUND OR NOT b.active OR b.environment_id<>p_environment OR b.client_id<>p_client OR b.redirect_uri<>p_redirect OR b.return_path<>p_return THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT * INTO a FROM morrow_identity.authentication_exchange_bindings WHERE binding_id=b.id FOR SHARE;
 IF NOT FOUND OR NOT a.active OR a.application_id<>p_application OR a.revision::text<>p_revision THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 PERFORM pg_advisory_xact_lock(69001,hashtext(p_command));
 PERFORM pg_advisory_xact_lock(69002,hashtext(jsonb_build_array(a.provider_id,p_environment,p_client,p_code)::text));
 SELECT * INTO c FROM morrow_identity.authentication_challenges WHERE id=p_challenge::uuid FOR UPDATE;
 IF NOT FOUND OR c.binding_id<>b.id OR c.environment_id<>p_environment OR c.client_id<>p_client OR c.redirect_uri<>p_redirect OR c.return_path<>p_return OR c.state_digest<>p_state OR c.browser_digest<>p_browser THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT * INTO k FROM morrow_identity.authentication_pkce_challenges WHERE challenge_id=c.id FOR UPDATE;
 IF NOT FOUND OR k.binding_id<>b.id OR k.binding_revision<>a.revision OR k.application_id<>a.application_id OR k.verifier_digest<>p_verifier OR k.method<>'S256' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT * INTO previous FROM morrow_identity.authentication_exchange_admissions WHERE command_id::text=p_command;
 IF FOUND THEN
  IF previous.challenge_id=c.id AND previous.provider_id=a.provider_id AND previous.environment_id=p_environment AND previous.client_id=p_client AND previous.code_digest=p_code THEN RETURN QUERY SELECT 'held'::text,previous.id::text;
  ELSE RETURN QUERY SELECT 'conflict'::text,NULL::text; END IF; RETURN;
 END IF;
 instant:=clock_timestamp();
 IF c.consumed_at IS NOT NULL OR c.created_at>instant OR c.expires_at<=instant THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 BEGIN
  reservation:=gen_random_uuid();
  INSERT INTO morrow_identity.authentication_exchange_admissions VALUES(reservation,p_command,c.id,a.provider_id,p_environment,p_client,p_code,instant);
  UPDATE morrow_identity.authentication_challenges SET consumed_at=clock_timestamp() WHERE id=c.id;
  -- An out-of-protocol owner can hold a UNIQUE tuple. Roll back both writes
  -- if its release allowed our INSERT only after the challenge expired.
  IF clock_timestamp()>=c.expires_at THEN RAISE EXCEPTION USING ERRCODE='P6901',MESSAGE='PREAUTH_EXPIRED'; END IF;
 EXCEPTION
  WHEN unique_violation THEN RETURN QUERY SELECT 'conflict'::text,NULL::text; RETURN;
  WHEN SQLSTATE 'P6901' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN;
 END;
 RETURN QUERY SELECT 'newly_reserved'::text,reservation::text;
END $$;
CREATE FUNCTION morrow_identity.reconcile_authentication_exchange(p_command text,p_challenge text,p_binding text,p_revision text,p_environment text,p_application text,p_client text,p_redirect text,p_return text,p_state text,p_browser text,p_verifier text,p_code text) RETURNS TABLE(outcome text,admission_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE matched text;
BEGIN
 IF morrow_identity.preauth_role_safe() AND morrow_identity.preauth_inputs_valid(p_command,p_challenge,p_binding,p_revision,p_environment,p_application,p_client,p_redirect,p_return,p_state,p_browser,p_verifier,p_code) THEN
  SELECT r.id::text INTO matched FROM morrow_identity.authentication_exchange_admissions r
   JOIN morrow_identity.authentication_pkce_challenges k ON k.challenge_id=r.challenge_id
   JOIN morrow_identity.authentication_challenges c ON c.id=k.challenge_id
   JOIN morrow_identity.authentication_bindings b ON b.id=c.binding_id
   JOIN morrow_identity.authentication_exchange_bindings a ON a.binding_id=b.id
   WHERE r.command_id::text=p_command AND r.challenge_id::text=p_challenge AND r.code_digest=p_code
    AND b.id::text=p_binding AND b.active AND a.active AND a.revision::text=p_revision AND a.application_id=p_application
    AND b.environment_id=p_environment AND b.client_id=p_client AND b.redirect_uri=p_redirect AND b.return_path=p_return
    AND c.environment_id=b.environment_id AND c.client_id=b.client_id AND c.redirect_uri=b.redirect_uri AND c.return_path=b.return_path
    AND c.state_digest=p_state AND c.browser_digest=p_browser AND c.consumed_at IS NOT NULL
    AND k.binding_id=b.id AND k.binding_revision=a.revision AND k.application_id=a.application_id AND k.verifier_digest=p_verifier AND k.method='S256'
    AND r.provider_id=a.provider_id AND r.environment_id=p_environment AND r.client_id=p_client;
 END IF;
 RETURN QUERY SELECT 'held'::text,matched;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.begin_authentication_exchange(text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_identity.admit_authentication_exchange(text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_identity.reconcile_authentication_exchange(text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.begin_authentication_exchange(text,text,text,text,text,text,text,text,text,text,text,text) TO morrow_identity_preauth;
GRANT EXECUTE ON FUNCTION morrow_identity.admit_authentication_exchange(text,text,text,text,text,text,text,text,text,text,text,text,text) TO morrow_identity_preauth;
GRANT EXECUTE ON FUNCTION morrow_identity.reconcile_authentication_exchange(text,text,text,text,text,text,text,text,text,text,text,text,text) TO morrow_identity_preauth;
-- Preserve the legacy signature and privileges; managed PKCE is excluded twice
-- so an attach committed during its row wait cannot be consumed by this path.
CREATE OR REPLACE FUNCTION morrow_identity.consume_authentication_challenge(configured_binding text,state_hash text,browser_hash text,configured_environment text,configured_client text,configured_redirect text,configured_return text) RETURNS TABLE(challenge_id text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE pending morrow_identity.authentication_challenges%ROWTYPE;
BEGIN
 PERFORM b.id FROM morrow_identity.authentication_bindings b WHERE b.id::text=$1 AND b.active AND b.environment_id=$4 AND b.client_id=$5 AND b.redirect_uri=$6 AND b.return_path=$7 FOR SHARE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT c.* INTO pending FROM morrow_identity.authentication_challenges c WHERE c.binding_id::text=$1 AND c.state_digest=$2 AND c.browser_digest=$3 AND c.consumed_at IS NULL AND c.environment_id=$4 AND c.client_id=$5 AND c.redirect_uri=$6 AND c.return_path=$7
  AND NOT EXISTS(SELECT 1 FROM morrow_identity.authentication_pkce_challenges k WHERE k.challenge_id=c.id) FOR UPDATE;
 IF NOT FOUND OR pending.created_at>clock_timestamp() OR pending.expires_at<=clock_timestamp() THEN RETURN; END IF;
 UPDATE morrow_identity.authentication_challenges c SET consumed_at=clock_timestamp() WHERE c.id=pending.id
  AND NOT EXISTS(SELECT 1 FROM morrow_identity.authentication_pkce_challenges k WHERE k.challenge_id=c.id) RETURNING c.id::text INTO challenge_id;
 IF FOUND THEN RETURN NEXT; END IF;
END $$;
COMMIT;
