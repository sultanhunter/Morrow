BEGIN;
-- Self-service enrollment at the first verified sign-in and first-owner signup (P05.T01x
-- Part B, ADR-0009). 0001-0004 stay byte-identical; 0005-0015 were rebaselined once
-- under ADR-0020. Enrollment confers no tenant
-- authority; signup is a separate human-initiated command with one fixed grant template.
-- Existing executors may already hold LOGIN on an upgraded database; the new onboarding
-- executor must still be NOLOGIN. IS NFC NORMALIZED needs a UTF8 database.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT EXISTS(SELECT 1 FROM pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='morrow_identity_onboarding' AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND morrow_identity.memberships_closed(r.rolname))
 OR (SELECT count(*) FROM pg_roles r WHERE r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance','morrow_identity_logout') AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication)<>9
 OR EXISTS(SELECT 1 FROM pg_roles r,pg_roles o WHERE o.rolname='morrow_identity_owner' AND r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance','morrow_identity_logout','morrow_identity_onboarding') AND (pg_has_role(r.oid,o.oid,'MEMBER') OR pg_has_role(o.oid,r.oid,'MEMBER')))
 OR (SELECT pg_encoding_to_char(d.encoding) FROM pg_database d WHERE d.datname=current_database())<>'UTF8'
 OR NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=to_regclass('morrow_identity.login_controller_configurations') AND k.conname='login_controller_protocol_v1' AND k.contype='c')
 OR to_regprocedure('morrow_identity.reconcile_login_flow(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.reconcile_workspace_login_flow(text,text,text,text,text)') IS NOT NULL
 OR to_regclass('morrow_identity.account_enrollments') IS NOT NULL
 THEN RAISE EXCEPTION 'ACCOUNT_ONBOARDING_PREREQUISITES_INVALID'; END IF;
END $$;

-- Account flows carry no workspace. Workspace-bound flows stay readable and maintainable.
ALTER TABLE morrow_identity.login_flows ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE morrow_identity.browser_session_audits DROP CONSTRAINT browser_session_audits_reason_check,
 ADD CONSTRAINT browser_session_audits_reason_check CHECK(reason IN ('admitted','identity_ineligible','evidence_expired','revision_conflict','binding_revoked','digest_conflict','identity_conflict','revoked','already_revoked','enrollment_disabled','enrollment_limited'));

-- Append-only self-service switch per verification profile. Its history is the audit;
-- no row means disabled. Only owner maintenance inserts, under the section 7 lock order.
CREATE TABLE morrow_identity.self_service_revisions (
 profile_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.identity_verification_profiles(id),
 revision morrow_identity.revision NOT NULL,
 enrollment text NOT NULL CHECK(enrollment IN ('disabled','enabled')),
 organization_signup text NOT NULL CHECK(organization_signup IN ('disabled','enabled')),
 reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 280),
 approval_ref morrow_identity.record_id NOT NULL,
 recorded_by name NOT NULL,
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 PRIMARY KEY(profile_id,revision)
);
CREATE TABLE morrow_identity.account_enrollments (
 principal_id morrow_identity.record_id PRIMARY KEY REFERENCES morrow_identity.principals(id),
 mapping_id morrow_identity.record_id NOT NULL UNIQUE REFERENCES morrow_identity.provider_subject_mappings(id),
 profile_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.identity_verification_profiles(id),
 command_id morrow_identity.record_id NOT NULL UNIQUE,
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at))
);
CREATE TABLE morrow_identity.account_session_commands (
 command_id morrow_identity.record_id PRIMARY KEY,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 request_tuple jsonb NOT NULL CHECK(jsonb_typeof(request_tuple)='array' AND jsonb_array_length(request_tuple)=20),
 outcome text NOT NULL CHECK(outcome IN ('admitted','denied')),
 enrollment text CHECK(enrollment IN ('enrolled','existing')),
 family_id morrow_identity.record_id REFERENCES morrow_identity.browser_session_families(id),
 generation_id morrow_identity.record_id REFERENCES morrow_identity.browser_session_generations(id),
 provider_binding_id morrow_identity.record_id REFERENCES morrow_identity.provider_session_bindings(id),
 expires_at timestamptz,
 audit_id morrow_identity.record_id NOT NULL UNIQUE REFERENCES morrow_identity.browser_session_audits(id),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 CHECK((outcome='admitted' AND num_nonnulls(enrollment,family_id,generation_id,provider_binding_id)=4 AND expires_at IS NOT NULL AND isfinite(expires_at))
    OR (outcome='denied' AND num_nonnulls(enrollment,family_id,generation_id,provider_binding_id,expires_at)=0))
);
-- Result and audit of the one signup per principal. Command ids are scoped per principal.
CREATE TABLE morrow_identity.organization_signups (
 principal_id morrow_identity.record_id PRIMARY KEY REFERENCES morrow_identity.principals(id),
 command_id morrow_identity.record_id NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 profile_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.identity_verification_profiles(id),
 organization_id morrow_identity.record_id NOT NULL UNIQUE,
 workspace_id morrow_identity.record_id NOT NULL,
 membership_id morrow_identity.record_id NOT NULL,
 grant_template text NOT NULL CHECK(grant_template='owner-bootstrap-v1'),
 recorded_at timestamptz NOT NULL CHECK(isfinite(recorded_at)),
 FOREIGN KEY(organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY(organization_id,membership_id,principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id)
);
CREATE INDEX account_enrollments_window ON morrow_identity.account_enrollments(profile_id,recorded_at);
CREATE INDEX organization_signups_window ON morrow_identity.organization_signups(profile_id,recorded_at);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['self_service_revisions','account_enrollments','account_session_commands','organization_signups'] LOOP
  EXECUTE format('ALTER TABLE morrow_identity.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_identity.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY identity_owner ON morrow_identity.%I TO morrow_identity_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON morrow_identity.%I FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions,morrow_identity_login,morrow_identity_login_maintenance,morrow_identity_logout,morrow_identity_onboarding',t);
 END LOOP;
END $$;

-- The replaceable retention and erasure hook (data-lifecycle.md). P09.T05 replaces this
-- function in a later forward migration so a dedicated privacy role can erase rows.
CREATE FUNCTION morrow_identity.account_preserve_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'ACCOUNT_RECORD_IMMUTABLE';
END $$;
-- Sequential revisions only. The profile row lock is lock-order step (5); the insert
-- therefore waits behind any admission or signup that holds that profile.
CREATE FUNCTION morrow_identity.self_service_revision_sequence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE latest bigint;
BEGIN
 PERFORM 1 FROM morrow_identity.identity_verification_profiles WHERE id=NEW.profile_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SELF_SERVICE_REVISION_INVALID'; END IF;
 SELECT max(r.revision) INTO latest FROM morrow_identity.self_service_revisions r WHERE r.profile_id=NEW.profile_id;
 IF NEW.revision IS DISTINCT FROM coalesce(latest,0)+1 THEN RAISE EXCEPTION 'SELF_SERVICE_REVISION_INVALID'; END IF;
 NEW.recorded_by:=session_user;
 NEW.recorded_at:=clock_timestamp();
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['self_service_revisions','account_enrollments','account_session_commands','organization_signups'] LOOP
  EXECUTE format('CREATE TRIGGER account_record_immutable BEFORE UPDATE OR DELETE ON morrow_identity.%I FOR EACH ROW EXECUTE FUNCTION morrow_identity.account_preserve_record()',t);
  EXECUTE format('CREATE TRIGGER account_record_no_truncate BEFORE TRUNCATE ON morrow_identity.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity.account_preserve_record()',t);
 END LOOP;
END $$;
CREATE TRIGGER self_service_revision_sequence BEFORE INSERT ON morrow_identity.self_service_revisions
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.self_service_revision_sequence();

-- Helpers. None is executable by any service role.
CREATE FUNCTION morrow_identity.display_name_valid(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT p IS NOT NULL AND char_length(p) BETWEEN 1 AND 100 AND p IS NFC NORMALIZED
 AND p !~ '[\u0001-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]'
 AND left(p,1) !~ '[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]'
 AND right(p,1) !~ '[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]'
$$;
CREATE FUNCTION morrow_identity.self_service_current(p_profile text) RETURNS TABLE(enrollment text,organization_signup text)
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT coalesce(x.enrollment,'disabled'),coalesce(x.organization_signup,'disabled')
 FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT r.enrollment,r.organization_signup FROM morrow_identity.self_service_revisions r
  WHERE r.profile_id::text=p_profile ORDER BY r.revision DESC LIMIT 1) x ON true
$$;
-- Grant template owner-bootstrap-v1 (ADR-0009 item 7): governance only, workspace scoped.
-- Fields are the union of the v1 and v1.1 effective input property names.
CREATE FUNCTION morrow_identity.owner_bootstrap_grants_v1() RETURNS TABLE(capability_id text,verbs jsonb,fields jsonb)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT c,v::jsonb,f::jsonb FROM (VALUES
  ('governance.membership.invite','["execute","approve"]','["identity","grantProposal"]'),
  ('governance.membership.revoke','["execute","approve"]','["membershipId","expectedRevision","control"]'),
  ('governance.grants.revise','["execute","approve"]','["proposalRef","approvalRef"]'),
  ('governance.connection.connect','["administer","approve"]','["providerId","installationProof","scope"]'),
  ('governance.connection.disconnect','["execute","approve"]','["connectionId","expectedRevision","control"]'),
  ('governance.approval.decide','["approve"]','["proposalRef","decision","expectedRevision"]'),
  ('governance.approval.preview','["view"]','["proposalRef","selectedTargetIndexes"]'),
  ('governance.usage.read','["view"]','["scope","period"]')) t(c,v,f)
$$;
-- One executor check over all ten executors: the session user is the named executor, the
-- owner and executor flags are safe, and no executor is a member of the owner or has it as
-- a member. The 0008 and 0010 helpers listed six and eight executors; they are replaced so
-- that admission, account login and every login-flow definer refuse exactly as signup does.
-- OR REPLACE keeps their owner and ACLs.
CREATE FUNCTION morrow_identity.executor_role_safe(p_executor text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT current_user='morrow_identity_owner' AND session_user=p_executor
 AND EXISTS(SELECT 1 FROM pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 AND EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=session_user AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication AND morrow_identity.executor_memberships_closed(r.rolname))
 AND NOT EXISTS(SELECT 1 FROM pg_roles r,pg_roles o WHERE o.rolname='morrow_identity_owner' AND r.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions','morrow_identity_login','morrow_identity_login_maintenance','morrow_identity_logout','morrow_identity_onboarding') AND (pg_has_role(r.oid,o.oid,'MEMBER') OR pg_has_role(o.oid,r.oid,'MEMBER')))
$$;
CREATE OR REPLACE FUNCTION morrow_identity.browser_sessions_role_safe() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT morrow_identity.executor_role_safe('morrow_identity_sessions')
$$;
CREATE OR REPLACE FUNCTION morrow_identity.login_role_safe(maintenance boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT morrow_identity.executor_role_safe(CASE WHEN maintenance THEN 'morrow_identity_login_maintenance' ELSE 'morrow_identity_login' END)
$$;
CREATE FUNCTION morrow_identity.onboarding_role_safe() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT morrow_identity.executor_role_safe('morrow_identity_onboarding')
$$;
-- The family half of session_eligibility without membership joins. Only a digest held by
-- exactly one representation resolves; a legacy sessions digest never does.
CREATE FUNCTION morrow_identity.account_session_principal(p_digest text) RETURNS TABLE(principal_id text,profile_id text)
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
   AND g.created_at=f.created_at AND g.expires_at=f.expires_at
   AND pb.created_at<=clock_timestamp() AND f.created_at<=clock_timestamp() AND g.created_at<=clock_timestamp()
   AND g.expires_at>clock_timestamp() AND f.expires_at>clock_timestamp()
$$;

-- Account flows: the configuration must be current, v1 and workspace-free. A workspace
-- argument never resolves any more, so bind, claim and observe deny workspace flows.
CREATE OR REPLACE FUNCTION morrow_identity.login_configuration_current(p_configuration text,p_workspace text) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT p_workspace IS NULL AND EXISTS(SELECT 1 FROM morrow_identity.login_controller_configurations c
 JOIN morrow_identity.authentication_bindings b ON b.id=c.binding_id AND b.active AND b.environment_id=c.environment_id AND b.client_id=c.client_id AND b.redirect_uri=c.redirect_uri AND b.return_path=c.return_path
 JOIN morrow_identity.authentication_exchange_bindings x ON x.binding_id=b.id AND x.active AND x.provider_id='workos' AND x.application_id=c.application_id AND x.revision=c.binding_revision
 JOIN morrow_identity.identity_verification_profiles p ON p.id=c.profile_id AND p.state='active' AND p.provider_id='workos' AND p.environment_id=c.environment_id AND p.application_id=c.application_id AND p.client_id=c.client_id AND p.issuer=c.issuer AND p.token_profile_revision=c.token_profile_revision AND p.token_profile_digest=c.token_profile_digest AND p.record_revision=c.profile_record_revision
 WHERE c.configuration_digest=p_configuration AND c.controller_protocol='morrow-login-v1')
$$;
CREATE FUNCTION morrow_identity.create_account_login_flow_intent(p_configuration text,p_flow text,p_begin text,p_admission text,p_issuer text)
RETURNS TABLE(outcome text,flow_id text,flow_revision text,expires_at_ms text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE c morrow_identity.login_controller_configurations%ROWTYPE;instant timestamptz;a uuid;BEGIN
 IF NOT morrow_identity.login_role_safe() OR NOT morrow_identity.login_digest(p_configuration) OR NOT morrow_identity.login_uuid(p_flow) OR NOT morrow_identity.login_uuid(p_begin) OR NOT morrow_identity.login_uuid(p_admission) OR NOT morrow_identity.login_uuid(p_issuer) OR (SELECT count(DISTINCT v) FROM unnest(ARRAY[p_flow,p_begin,p_admission,p_issuer])v)<>4 THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO c FROM morrow_identity.login_controller_configurations WHERE configuration_digest=p_configuration FOR SHARE;
 IF NOT FOUND OR NOT morrow_identity.login_configuration_current(p_configuration,NULL) THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 INSERT INTO morrow_identity.login_flow_quotas VALUES(c.environment_id,c.profile_id) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM morrow_identity.login_flow_quotas q WHERE q.environment_id=c.environment_id AND q.profile_id=c.profile_id FOR UPDATE;
 instant:=clock_timestamp();
 IF EXISTS(SELECT 1 FROM morrow_identity.login_flows f JOIN morrow_identity.login_controller_configurations k ON k.configuration_digest=f.configuration_digest WHERE k.environment_id=c.environment_id AND k.profile_id=c.profile_id AND f.created_at>instant-interval '10 seconds' HAVING count(*)>=10) THEN RETURN QUERY SELECT 'rate_limited'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM morrow_identity.login_flows f JOIN morrow_identity.login_controller_configurations k ON k.configuration_digest=f.configuration_digest WHERE k.environment_id=c.environment_id AND k.profile_id=c.profile_id AND f.expires_at>instant HAVING count(*)>=100) THEN RETURN QUERY SELECT 'quota_limited'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM morrow_identity.authentication_pkce_challenges k WHERE k.begin_command_id::text=ANY(ARRAY[p_begin,p_admission,p_issuer])) OR EXISTS(SELECT 1 FROM morrow_identity.authentication_exchange_admissions r WHERE r.command_id::text=ANY(ARRAY[p_begin,p_admission,p_issuer])) OR EXISTS(SELECT 1 FROM morrow_identity.browser_session_commands r WHERE r.command_id::text=ANY(ARRAY[p_begin,p_admission,p_issuer])) OR EXISTS(SELECT 1 FROM morrow_identity.account_session_commands r WHERE r.command_id::text=ANY(ARRAY[p_begin,p_admission,p_issuer])) THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 BEGIN
 INSERT INTO morrow_identity.login_command_guards(command_digest,flow_id,configuration_digest,command_kind,created_at) VALUES(encode(sha256(convert_to(p_begin,'UTF8')),'hex'),p_flow::uuid,p_configuration,'begin',instant),(encode(sha256(convert_to(p_admission,'UTF8')),'hex'),p_flow::uuid,p_configuration,'admission',instant),(encode(sha256(convert_to(p_issuer,'UTF8')),'hex'),p_flow::uuid,p_configuration,'issuer',instant);
 INSERT INTO morrow_identity.login_flows(id,configuration_digest,begin_command_id,admission_command_id,issuer_command_id,workspace_id,phase,revision,created_at,expires_at) VALUES(p_flow::uuid,p_configuration,p_begin::uuid,p_admission::uuid,p_issuer::uuid,NULL,'intent',1,instant,instant+interval '300 seconds');
 a:=gen_random_uuid();INSERT INTO morrow_identity.login_flow_events VALUES(a,p_flow::uuid,p_configuration,1,'created',instant,false);
 IF clock_timestamp()>=instant+interval '300 seconds' OR NOT morrow_identity.login_configuration_current(p_configuration,NULL) THEN RAISE EXCEPTION USING ERRCODE='MR001',MESSAGE='LOGIN_FLOW_LATE';END IF;
 EXCEPTION WHEN unique_violation THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; WHEN SQLSTATE 'MR001' THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END;
 RETURN QUERY SELECT 'newly_created'::text,p_flow,'1'::text,floor(extract(epoch FROM instant+interval '300 seconds')*1000)::bigint::text,a::text;
END $$;

-- The 0010 reconciliation keeps its body under a new name; the wrapper keeps the old name,
-- signature and return type, and adds account flows.
ALTER FUNCTION morrow_identity.reconcile_login_flow(text,text,text,text,text) RENAME TO reconcile_workspace_login_flow;
REVOKE ALL ON FUNCTION morrow_identity.reconcile_workspace_login_flow(text,text,text,text,text) FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions,morrow_identity_login,morrow_identity_login_maintenance,morrow_identity_logout,morrow_identity_onboarding;
CREATE FUNCTION morrow_identity.reconcile_login_flow(p_configuration text,p_flow text,p_begin text,p_admission text,p_issuer text)
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
 IF m.outcome='admitted' AND (m.request_tuple->>18 IS DISTINCT FROM m.family_id::text OR m.request_tuple->>19 IS DISTINCT FROM m.generation_id::text OR NOT EXISTS(SELECT 1 FROM morrow_identity.browser_session_families bf JOIN morrow_identity.browser_session_generations g ON g.family_id=bf.id JOIN morrow_identity.provider_session_bindings pb ON pb.id=bf.provider_binding_id JOIN morrow_identity.provider_subject_mappings sm ON sm.id=pb.mapping_id WHERE bf.id=m.family_id AND g.id=m.generation_id AND pb.id=m.provider_binding_id AND pb.provider_id='workos' AND pb.environment_id=c.environment_id AND pb.client_id=c.client_id AND pb.profile_id=c.profile_id AND pb.provider_session_id=m.request_tuple->>9 AND sm.subject_id=m.request_tuple->>8 AND g.expires_at=m.expires_at AND bf.expires_at=m.expires_at)) THEN RETURN QUERY SELECT 'held'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;RETURN; END IF;
 END IF;
 RETURN QUERY SELECT 'observed'::text,base.phase,base.flow_revision,base.expires_at_ms,base.admission_id,CASE WHEN found_m THEN m.request_digest END,CASE WHEN found_m THEN m.outcome END,m.family_id::text,m.generation_id::text,m.provider_binding_id::text,CASE WHEN m.expires_at IS NOT NULL THEN floor(extract(epoch FROM m.expires_at)*1000)::bigint::text END,m.audit_id::text;
END $$;

-- Account admission: the 0008 browser family without a workspace. An unmapped verified
-- subject enrolls (principal, mapping and profile binding together) only while enrollment
-- is enabled. Lock order (section 7): command advisory, browser-provider advisory,
-- provider-subject advisory, provider binding, profile, mapping, profile binding, principal.
CREATE FUNCTION morrow_identity.admit_account_family(
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
 reason_code text:='identity_ineligible'; enrollment_kind text; instant timestamptz; expiry timestamptz;
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
   expiry:=instant+interval '15 minutes';
   INSERT INTO morrow_identity.browser_session_families(id,provider_binding_id,profile_record_revision,mapping_revision,binding_revision,created_at,expires_at)
    VALUES(p_family_id,provider_key,v.record_revision,mapping_revision,binding_revision,instant,expiry);
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
CREATE FUNCTION morrow_identity.reconcile_account_admission(p_command text,p_digest text)
RETURNS TABLE(outcome text,family_id text,generation_id text,provider_binding_id text,expires_at_ms text,audit_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE previous morrow_identity.account_session_commands%ROWTYPE;
BEGIN
 IF NOT morrow_identity.browser_sessions_role_safe() OR p_command IS NULL OR p_digest IS NULL
   OR p_command !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO previous FROM morrow_identity.account_session_commands WHERE command_id::text=p_command;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
 ELSIF previous.request_digest<>p_digest THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
 ELSIF previous.outcome='admitted' THEN RETURN QUERY SELECT 'replayed'::text,previous.family_id::text,previous.generation_id::text,previous.provider_binding_id::text,floor(extract(epoch FROM previous.expires_at)*1000)::text,previous.audit_id::text;
 ELSE RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; END IF;
END $$;

-- The account list: one statement, one snapshot. Authority has a single source:
-- every listed workspace is one where session_eligibility returns a row.
CREATE FUNCTION morrow_identity.account_overview(p_digest text,p_profile text) RETURNS TABLE(onboarding text,workspaces jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 WITH me AS (
  SELECT a.principal_id,a.profile_id FROM morrow_identity.account_session_principal(p_digest) a
  WHERE p_digest ~ '^[a-f0-9]{64}$' AND p_profile ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' AND a.profile_id=p_profile
 ), listed AS (
  SELECT o.id::text AS organization_id,o.display_name AS organization_name,w.id::text AS workspace_id,w.display_name AS workspace_name
  FROM me JOIN morrow_identity.memberships m ON m.principal_id::text=me.principal_id AND m.active
  JOIN morrow_identity.organizations o ON o.id=m.organization_id AND o.active
  JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=o.id AND wm.membership_id=m.id AND wm.active
  JOIN morrow_identity.workspaces w ON w.organization_id=o.id AND w.id=wm.workspace_id AND w.active
  WHERE EXISTS(SELECT 1 FROM morrow_identity.session_eligibility(p_digest,w.id::text))
  ORDER BY o.display_name COLLATE "C",o.id::text COLLATE "C",w.display_name COLLATE "C",w.id::text COLLATE "C" LIMIT 101
 )
 SELECT CASE WHEN EXISTS(SELECT 1 FROM morrow_identity.account_enrollments e WHERE e.principal_id::text=me.principal_id)
   AND NOT EXISTS(SELECT 1 FROM morrow_identity.organization_signups s WHERE s.principal_id::text=me.principal_id)
   AND (SELECT x.organization_signup FROM morrow_identity.self_service_current(me.profile_id) x)='enabled'
   THEN 'available' ELSE 'unavailable' END,
  coalesce((SELECT jsonb_agg(jsonb_build_object('organizationId',l.organization_id,'organizationName',l.organization_name,'workspaceId',l.workspace_id,'workspaceName',l.workspace_name)
   ORDER BY l.organization_name COLLATE "C",l.organization_id COLLATE "C",l.workspace_name COLLATE "C",l.workspace_id COLLATE "C") FROM listed l),'[]'::jsonb)
 FROM me
$$;

-- First-owner signup: one organization per self-enrolled principal, with grant template
-- owner-bootstrap-v1. A human-initiated command; denials write nothing.
CREATE FUNCTION morrow_identity.create_first_organization(p_digest text,p_command text,p_profile text,p_org text,p_ws text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
 request text; person text; checked text; previous morrow_identity.organization_signups%ROWTYPE;
 instant timestamptz; org_key text; ws_key text; member_key text; result text:='created';
BEGIN
 IF NOT morrow_identity.onboarding_role_safe() OR p_digest IS NULL OR p_command IS NULL OR p_profile IS NULL OR p_org IS NULL OR p_ws IS NULL
   OR p_digest !~ '^[a-f0-9]{64}$' OR p_command !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   OR p_profile !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 IF NOT morrow_identity.display_name_valid(p_org) OR NOT morrow_identity.display_name_valid(p_ws) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN; END IF;
 request:=encode(sha256(convert_to(array_to_json(ARRAY['morrow.onboarding.organization','1',p_command,p_profile,p_org,p_ws])::text,'UTF8')),'hex');
 SELECT a.principal_id INTO person FROM morrow_identity.account_session_principal(p_digest) a WHERE a.profile_id=p_profile;
 IF person IS NULL THEN RETURN QUERY SELECT 'unauthenticated'::text,NULL::text,NULL::text; RETURN; END IF;
 -- (1) principal advisory, then the family branch of the shared eligibility lock order.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('onboarding-principal:'||person,0));
 PERFORM morrow_identity.lock_session_eligibility(p_digest,NULL,person,NULL);
 SELECT a.principal_id INTO checked FROM morrow_identity.account_session_principal(p_digest) a WHERE a.profile_id=p_profile;
 IF checked IS DISTINCT FROM person THEN RETURN QUERY SELECT 'unauthenticated'::text,NULL::text,NULL::text; RETURN; END IF;
 -- A replay is decided before the switch and the window, and discloses ids only to the
 -- same principal while its founding workspace membership is active.
 SELECT * INTO previous FROM morrow_identity.organization_signups s WHERE s.principal_id::text=person;
 IF FOUND THEN
  IF previous.command_id::text=p_command AND previous.request_digest=request THEN
   IF EXISTS(SELECT 1 FROM morrow_identity.memberships m JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=m.organization_id AND wm.membership_id=m.id
     WHERE m.organization_id=previous.organization_id AND m.id=previous.membership_id AND m.principal_id=previous.principal_id AND m.active
       AND wm.workspace_id=previous.workspace_id AND wm.active) THEN
    RETURN QUERY SELECT 'replayed'::text,previous.organization_id::text,previous.workspace_id::text;
   ELSE RETURN QUERY SELECT 'already_onboarded'::text,NULL::text,NULL::text; END IF;
  ELSIF previous.command_id::text=p_command THEN RETURN QUERY SELECT 'idempotency_conflict'::text,NULL::text,NULL::text;
  ELSE RETURN QUERY SELECT 'already_onboarded'::text,NULL::text,NULL::text; END IF;
  RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_identity.account_enrollments e WHERE e.principal_id::text=person) THEN
  RETURN QUERY SELECT 'not_eligible'::text,NULL::text,NULL::text; RETURN; END IF;
 IF (SELECT x.organization_signup FROM morrow_identity.self_service_current(p_profile) x)<>'enabled' THEN
  RETURN QUERY SELECT 'signup_disabled'::text,NULL::text,NULL::text; RETURN; END IF;
 instant:=clock_timestamp();
 IF (SELECT count(*) FROM morrow_identity.organization_signups s WHERE s.profile_id::text=p_profile AND s.recorded_at>instant-interval '10 minutes')>=20
   OR (SELECT count(*) FROM morrow_identity.organization_signups s WHERE s.profile_id::text=p_profile AND s.recorded_at>instant-interval '24 hours')>=200 THEN
  RETURN QUERY SELECT 'rate_limited'::text,NULL::text,NULL::text; RETURN; END IF;
 BEGIN
  instant:=clock_timestamp();
  org_key:=gen_random_uuid()::text; ws_key:=gen_random_uuid()::text; member_key:=gen_random_uuid()::text;
  INSERT INTO morrow_identity.organizations(id,display_name,active,policy_revision) VALUES(org_key,p_org,true,1);
  INSERT INTO morrow_identity.workspaces(id,organization_id,display_name,active) VALUES(ws_key,org_key,p_ws,true);
  INSERT INTO morrow_identity.memberships(id,organization_id,principal_id,active) VALUES(member_key,org_key,person,true);
  INSERT INTO morrow_identity.workspace_memberships(organization_id,workspace_id,membership_id,active) VALUES(org_key,ws_key,member_key,true);
  INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload)
  SELECT g.grant_key,org_key,ws_key,member_key,person,jsonb_build_object(
    'id',g.grant_key,
    'principal',jsonb_build_object('kind','human','principalId',person,'organizationId',org_key,'workspaceId',ws_key,'membershipId',member_key,'installationId',NULL,'mandateId',NULL),
    'capabilityId',g.capability_id,'verbs',g.verbs,
    'scope',jsonb_build_object('organizationId',org_key,'workspaceId',ws_key,'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,
      'resources',jsonb_build_array(jsonb_build_object('organizationId',org_key,'workspaceId',ws_key,'storeId',NULL,'connectionId',NULL,'kind','workspace','id',ws_key)),
      'fields',g.fields),
    'issuedBy',jsonb_build_object('kind','service','principalId','morrow.onboarding','organizationId',org_key,'workspaceId',ws_key,'membershipId',NULL,'installationId',NULL,'mandateId',NULL),
    'validFrom',to_char(instant AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',NULL,'revokedAt',NULL,'policyRevision',1)
  FROM (SELECT t.capability_id,t.verbs,t.fields,gen_random_uuid()::text AS grant_key FROM morrow_identity.owner_bootstrap_grants_v1() t) g;
  INSERT INTO morrow_identity.organization_signups(principal_id,command_id,request_digest,profile_id,organization_id,workspace_id,membership_id,grant_template,recorded_at)
   VALUES(person,p_command,request,p_profile,org_key,ws_key,member_key,'owner-bootstrap-v1',instant);
  -- The family must still be current after every late row wait.
  IF NOT EXISTS(SELECT 1 FROM morrow_identity.account_session_principal(p_digest) a WHERE a.principal_id=person AND a.profile_id=p_profile) THEN
   RAISE SQLSTATE 'MR001'; END IF;
 EXCEPTION WHEN SQLSTATE 'MR001' THEN result:='unauthenticated';
  WHEN unique_violation THEN result:='already_onboarded';
 END;
 IF result='created' THEN RETURN QUERY SELECT 'created'::text,org_key,ws_key;
 ELSE RETURN QUERY SELECT result,NULL::text,NULL::text; END IF;
END $$;

-- Privileges. Retired entry points are no longer executable by their former roles.
DO $$ DECLARE r record; BEGIN FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='morrow_identity' AND p.proname IN ('account_preserve_record','self_service_revision_sequence','display_name_valid','self_service_current','owner_bootstrap_grants_v1','executor_role_safe','onboarding_role_safe','account_session_principal','create_account_login_flow_intent','reconcile_login_flow','admit_account_family','reconcile_account_admission','account_overview','create_first_organization') LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions,morrow_identity_login,morrow_identity_login_maintenance,morrow_identity_logout,morrow_identity_onboarding',r.signature); END LOOP;END $$;
REVOKE EXECUTE ON FUNCTION morrow_identity.create_login_flow_intent(text,text,text,text,text,text) FROM morrow_identity_login;
REVOKE EXECUTE ON FUNCTION morrow_identity.admit_browser_family(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) FROM morrow_identity_sessions;
REVOKE EXECUTE ON FUNCTION morrow_identity.resolve_provider_subject_selection(text,text,text,text,text,text,text,text,text) FROM morrow_identity_resolution;
GRANT USAGE ON SCHEMA morrow_identity TO morrow_identity_onboarding;
GRANT EXECUTE ON FUNCTION morrow_identity.create_account_login_flow_intent(text,text,text,text,text),morrow_identity.reconcile_login_flow(text,text,text,text,text) TO morrow_identity_login;
GRANT EXECUTE ON FUNCTION morrow_identity.admit_account_family(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text),morrow_identity.reconcile_account_admission(text,text) TO morrow_identity_sessions;
GRANT EXECUTE ON FUNCTION morrow_identity.account_overview(text,text) TO morrow_api;
GRANT EXECUTE ON FUNCTION morrow_identity.create_first_organization(text,text,text,text,text) TO morrow_identity_onboarding;
COMMIT;
