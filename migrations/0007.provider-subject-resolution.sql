BEGIN;
-- Preparation only: the dedicated resolver has no login or inherited role.
DO $$ BEGIN
 IF current_user <> 'morrow_identity_owner'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_identity_owner'
   AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb
   AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles service,pg_catalog.pg_roles owner
   WHERE owner.rolname='morrow_identity_owner'
   AND service.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution')
   AND (pg_catalog.pg_has_role(service.oid,owner.oid,'MEMBER') OR pg_catalog.pg_has_role(owner.oid,service.oid,'MEMBER')))
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='morrow_identity_resolution'
   AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
   AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication
   AND morrow_identity.memberships_closed(r.rolname)) THEN
  RAISE EXCEPTION 'RESOLUTION_ROLE_PREREQUISITES_INVALID';
 END IF;
END $$;

CREATE TABLE morrow_identity.identity_verification_profiles (
 id morrow_identity.record_id PRIMARY KEY,
 provider_id text NOT NULL CHECK(provider_id='workos'),
 environment_id text NOT NULL CHECK(environment_id ~ '^environment_[A-Z0-9]{26}$'),
 application_id text NOT NULL CHECK(application_id ~ '^app_[A-Z0-9]{26}$'),
 client_id text NOT NULL CHECK(client_id ~ '^client_[A-Z0-9]{26}$'),
 issuer text NOT NULL CHECK(issuer='https://api.workos.com/user_management/' || client_id),
 token_profile_revision morrow_identity.revision NOT NULL,
 token_profile_digest text NOT NULL CHECK(token_profile_digest ~ '^[a-f0-9]{64}$'),
 record_revision morrow_identity.revision NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'inactive' CHECK(state IN ('inactive','active','revoked')),
 UNIQUE(provider_id,environment_id,application_id,client_id),
 UNIQUE(id,provider_id,environment_id)
);
CREATE TABLE morrow_identity.provider_subject_mappings (
 id morrow_identity.record_id PRIMARY KEY,
 provider_id text NOT NULL CHECK(provider_id='workos'),
 environment_id text NOT NULL CHECK(environment_id ~ '^environment_[A-Z0-9]{26}$'),
 subject_id text NOT NULL CHECK(subject_id ~ '^user_[A-Z0-9]{26}$'),
 principal_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.principals(id),
 record_revision morrow_identity.revision NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'inactive' CHECK(state IN ('inactive','active','revoked')),
 UNIQUE(provider_id,environment_id,subject_id),
 UNIQUE(id,provider_id,environment_id)
);
CREATE TABLE morrow_identity.provider_subject_profile_bindings (
 mapping_id morrow_identity.record_id NOT NULL,
 profile_id morrow_identity.record_id NOT NULL,
 provider_id text NOT NULL CHECK(provider_id='workos'),
 environment_id text NOT NULL CHECK(environment_id ~ '^environment_[A-Z0-9]{26}$'),
 record_revision morrow_identity.revision NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'inactive' CHECK(state IN ('inactive','active','revoked')),
 PRIMARY KEY(mapping_id,profile_id),
 FOREIGN KEY(mapping_id,provider_id,environment_id)
   REFERENCES morrow_identity.provider_subject_mappings(id,provider_id,environment_id),
 FOREIGN KEY(profile_id,provider_id,environment_id)
   REFERENCES morrow_identity.identity_verification_profiles(id,provider_id,environment_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['identity_verification_profiles','provider_subject_mappings','provider_subject_profile_bindings'] LOOP
  EXECUTE format('ALTER TABLE morrow_identity.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_identity.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY identity_owner ON morrow_identity.%I TO morrow_identity_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON morrow_identity.%I FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution',t);
 END LOOP;
END $$;

-- Owner-maintained state only. Erasure/reassignment/reactivation need a later
-- audited lifecycle protocol; delete/reinsert must not reset stable revisions.
CREATE FUNCTION morrow_identity.preserve_provider_identity_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'PROVIDER_IDENTITY_RECORD_IMMUTABLE'; END IF;
 IF NEW.record_revision <> OLD.record_revision+1
   OR (OLD.state='revoked' AND NEW.state<>'revoked') THEN
  RAISE EXCEPTION 'PROVIDER_IDENTITY_REVISION_INVALID';
 END IF;
 IF TG_TABLE_NAME='identity_verification_profiles' THEN
  IF ROW(NEW.id,NEW.provider_id,NEW.environment_id,NEW.application_id,NEW.client_id,NEW.issuer)
     IS DISTINCT FROM ROW(OLD.id,OLD.provider_id,OLD.environment_id,OLD.application_id,OLD.client_id,OLD.issuer) THEN
   RAISE EXCEPTION 'PROVIDER_IDENTITY_RECORD_IMMUTABLE';
  END IF;
 ELSIF TG_TABLE_NAME='provider_subject_mappings' THEN
  IF ROW(NEW.id,NEW.provider_id,NEW.environment_id,NEW.subject_id,NEW.principal_id)
     IS DISTINCT FROM ROW(OLD.id,OLD.provider_id,OLD.environment_id,OLD.subject_id,OLD.principal_id) THEN
   RAISE EXCEPTION 'PROVIDER_IDENTITY_RECORD_IMMUTABLE';
  END IF;
 ELSIF TG_TABLE_NAME='provider_subject_profile_bindings' THEN
  IF ROW(NEW.mapping_id,NEW.profile_id,NEW.provider_id,NEW.environment_id)
     IS DISTINCT FROM ROW(OLD.mapping_id,OLD.profile_id,OLD.provider_id,OLD.environment_id) THEN
   RAISE EXCEPTION 'PROVIDER_IDENTITY_RECORD_IMMUTABLE';
  END IF;
 ELSE RAISE EXCEPTION 'PROVIDER_IDENTITY_RECORD_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.preserve_provider_identity_record() FROM PUBLIC;
CREATE TRIGGER profile_identity_immutable BEFORE UPDATE OR DELETE ON morrow_identity.identity_verification_profiles
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_provider_identity_record();
CREATE TRIGGER subject_identity_immutable BEFORE UPDATE OR DELETE ON morrow_identity.provider_subject_mappings
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_provider_identity_record();
CREATE TRIGGER subject_profile_identity_immutable BEFORE UPDATE OR DELETE ON morrow_identity.provider_subject_profile_bindings
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_provider_identity_record();

-- TRUNCATE is statement-level and does not invoke row DELETE triggers.
CREATE TRIGGER profile_identity_no_truncate BEFORE TRUNCATE ON morrow_identity.identity_verification_profiles
 FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity.preserve_provider_identity_record();
CREATE TRIGGER subject_identity_no_truncate BEFORE TRUNCATE ON morrow_identity.provider_subject_mappings
 FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity.preserve_provider_identity_record();
CREATE TRIGGER subject_profile_identity_no_truncate BEFORE TRUNCATE ON morrow_identity.provider_subject_profile_bindings
 FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity.preserve_provider_identity_record();

CREATE FUNCTION morrow_identity.resolve_provider_subject_selection(
 p_provider text,p_environment text,p_application text,p_client text,p_issuer text,
 p_token_revision text,p_token_digest text,p_subject text,p_workspace text)
RETURNS TABLE(profile_id text,profile_record_revision text,mapping_id text,mapping_revision text,
 binding_revision text,principal_id text,organization_id text,workspace_id text,membership_id text,policy_revision text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
 -- current_user is the definer here; the original login must itself be the
 -- safe dedicated executor. SET ROLE from an API/admin login is not sufficient.
 IF current_user<>'morrow_identity_owner' OR session_user<>'morrow_identity_resolution'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_identity_owner'
   AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb
   AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles service,pg_catalog.pg_roles owner
   WHERE owner.rolname='morrow_identity_owner'
   AND service.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution')
   AND (pg_catalog.pg_has_role(service.oid,owner.oid,'MEMBER') OR pg_catalog.pg_has_role(owner.oid,service.oid,'MEMBER')))
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname=session_user
   AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole
   AND NOT r.rolinherit AND NOT r.rolreplication
   AND morrow_identity.executor_memberships_closed(r.rolname)) THEN RETURN; END IF;
 IF p_provider IS NULL OR p_environment IS NULL OR p_application IS NULL OR p_client IS NULL
   OR p_issuer IS NULL OR p_token_revision IS NULL OR p_token_digest IS NULL OR p_subject IS NULL OR p_workspace IS NULL
   OR p_provider<>'workos' OR p_environment !~ '^environment_[A-Z0-9]{26}$'
   OR p_application !~ '^app_[A-Z0-9]{26}$' OR p_client !~ '^client_[A-Z0-9]{26}$'
   OR p_issuer<>'https://api.workos.com/user_management/' || p_client
   OR p_token_revision !~ '^[1-9][0-9]{0,15}$' OR p_token_digest !~ '^[a-f0-9]{64}$'
   OR p_subject !~ '^user_[A-Z0-9]{26}$' OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 -- Cast only after the textual shape gate; SQL predicate order is not a cast fence.
 IF p_token_revision::numeric>9007199254740991 THEN RETURN; END IF;
 RETURN QUERY
 SELECT v.id::text,v.record_revision::text,m.id::text,m.record_revision::text,
   b.record_revision::text,p.id::text,o.id::text,w.id::text,om.id::text,o.policy_revision::text
 FROM morrow_identity.identity_verification_profiles v
 JOIN morrow_identity.provider_subject_mappings m ON m.provider_id=v.provider_id
   AND m.environment_id=v.environment_id AND m.subject_id=p_subject AND m.state='active'
 JOIN morrow_identity.provider_subject_profile_bindings b ON b.mapping_id=m.id AND b.profile_id=v.id
   AND b.provider_id=v.provider_id AND b.environment_id=v.environment_id AND b.state='active'
 JOIN morrow_identity.principals p ON p.id=m.principal_id AND p.kind='human' AND p.active
 JOIN morrow_identity.memberships om ON om.principal_id=p.id AND om.active
 JOIN morrow_identity.organizations o ON o.id=om.organization_id AND o.active
 JOIN morrow_identity.workspaces w ON w.id::text=p_workspace AND w.organization_id=o.id AND w.active
 JOIN morrow_identity.workspace_memberships wm ON wm.membership_id=om.id
   AND wm.organization_id=o.id AND wm.workspace_id=w.id AND wm.active
 WHERE v.provider_id=p_provider AND v.environment_id=p_environment AND v.application_id=p_application
   AND v.client_id=p_client AND v.issuer=p_issuer AND v.token_profile_revision=p_token_revision::bigint
   AND v.token_profile_digest=p_token_digest AND v.state='active';
END $$;
REVOKE ALL ON FUNCTION morrow_identity.resolve_provider_subject_selection(text,text,text,text,text,text,text,text,text) FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth;
GRANT USAGE ON SCHEMA morrow_identity TO morrow_identity_resolution;
GRANT EXECUTE ON FUNCTION morrow_identity.resolve_provider_subject_selection(text,text,text,text,text,text,text,text,text) TO morrow_identity_resolution;
COMMIT;
