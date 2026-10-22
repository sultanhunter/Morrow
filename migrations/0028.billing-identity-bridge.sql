BEGIN;
-- M5 PR-1: owner grant template v2 (ADR-0022 item 3; docs/briefs/M5-billing.md). Executes
-- AS morrow_identity_owner, after 0027. ADR-0022 item 3 adds governance.billing.manage
-- {view, execute} and governance.model_default.revise {execute} to the signup template, and
-- a forward migration backfills existing owners:
--   * owner_bootstrap_grants_v2(): the eight owner-bootstrap-v1 rows (0013) plus those two,
--     with fields equal to the v1.1 input property names of each body (the v1 rule).
--   * organization_signups.grant_template admits 'owner-bootstrap-v2'; v1 rows stay as
--     recorded (the table is immutable).
--   * create_first_organization is replaced (OR REPLACE keeps its owner, ACL and the 0021
--     route-row trigger on organization_signups): its body is byte-identical to 0013's
--     except that it issues owner_bootstrap_grants_v2() and records 'owner-bootstrap-v2'
--     (tests/account-onboarding.test.mjs diffs the two bodies).
--   * The backfill gives every founding owner whose founding organization and workspace
--     memberships are active the two new grants it does not hold yet, in the 0013 shape:
--     the workspace resource, issuedBy service morrow.onboarding, validFrom this
--     migration's instant and the organization's current policy revision. Idempotent.
-- Neither capability is paid work (P01.T04a PW5), so no billing state gates either. No
-- template v1 row and no route row changes. Role checks go through the ADR-0020 helpers.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regprocedure('morrow_identity.owner_bootstrap_grants_v1()') IS NULL
 OR to_regprocedure('morrow_identity.owner_bootstrap_grants_v2()') IS NOT NULL
 OR to_regprocedure('morrow_identity.create_first_organization(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.signup_billing_route()') IS NULL
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='morrow_identity.organization_signups'::regclass AND c.conname='organization_signups_grant_template_check')
   IS DISTINCT FROM 'CHECK ((grant_template = ''owner-bootstrap-v1''::text))'
 THEN RAISE EXCEPTION 'OWNER_TEMPLATE_V2_PREREQUISITES_INVALID'; END IF;
END $$;

-- Grant template owner-bootstrap-v2 (ADR-0022 item 3): owner-bootstrap-v1 plus the two
-- Governance controls. Granted to nobody; only create_first_organization (its owner's
-- definer) reads it. BEGIN ATOMIC records the dependency on v1.
CREATE FUNCTION morrow_identity.owner_bootstrap_grants_v2() RETURNS TABLE(capability_id text,verbs jsonb,fields jsonb)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_identity,pg_temp
BEGIN ATOMIC
 SELECT v.capability_id,v.verbs,v.fields FROM morrow_identity.owner_bootstrap_grants_v1() v
 UNION ALL
 SELECT t.c,t.v::jsonb,t.f::jsonb FROM (VALUES
  ('governance.billing.manage','["view","execute"]','["action","priceKey"]'),
  ('governance.model_default.revise','["execute"]','["effort","expectedRevision","maxCreditsPerProduct","model"]')) t(c,v,f);
END;
REVOKE ALL ON FUNCTION morrow_identity.owner_bootstrap_grants_v2() FROM PUBLIC;

ALTER TABLE morrow_identity.organization_signups DROP CONSTRAINT organization_signups_grant_template_check,
 ADD CONSTRAINT organization_signups_grant_template_check CHECK (grant_template IN ('owner-bootstrap-v1','owner-bootstrap-v2'));

-- First-owner signup: one organization per self-enrolled principal, with grant template
-- owner-bootstrap-v2 (M5 PR-1). A human-initiated command; denials write nothing.
CREATE OR REPLACE FUNCTION morrow_identity.create_first_organization(p_digest text,p_command text,p_profile text,p_org text,p_ws text)
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
  FROM (SELECT t.capability_id,t.verbs,t.fields,gen_random_uuid()::text AS grant_key FROM morrow_identity.owner_bootstrap_grants_v2() t) g;
  INSERT INTO morrow_identity.organization_signups(principal_id,command_id,request_digest,profile_id,organization_id,workspace_id,membership_id,grant_template,recorded_at)
   VALUES(person,p_command,request,p_profile,org_key,ws_key,member_key,'owner-bootstrap-v2',instant);
  -- The family must still be current after every late row wait.
  IF NOT EXISTS(SELECT 1 FROM morrow_identity.account_session_principal(p_digest) a WHERE a.principal_id=person AND a.profile_id=p_profile) THEN
   RAISE SQLSTATE 'MR001'; END IF;
 EXCEPTION WHEN SQLSTATE 'MR001' THEN result:='unauthenticated';
  WHEN unique_violation THEN result:='already_onboarded';
 END;
 IF result='created' THEN RETURN QUERY SELECT 'created'::text,org_key,ws_key;
 ELSE RETURN QUERY SELECT result,NULL::text,NULL::text; END IF;
END $$;

-- The backfill (ADR-0022 item 3): founding owners recorded by organization_signups whose
-- founding membership and workspace membership are both active, in an active organization
-- and workspace, get each v2-only grant they do not hold yet. Oldest signup first.
DO $$ DECLARE s record; g record; v_at timestamptz:=clock_timestamp(); v_key text; BEGIN
 FOR s IN SELECT x.principal_id::text AS principal_id,x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,
   x.membership_id::text AS membership_id,o.policy_revision::bigint AS policy_revision
  FROM morrow_identity.organization_signups x
  JOIN morrow_identity.organizations o ON o.id=x.organization_id AND o.active
  JOIN morrow_identity.workspaces w ON w.organization_id=x.organization_id AND w.id=x.workspace_id AND w.active
  JOIN morrow_identity.memberships m ON m.organization_id=x.organization_id AND m.id=x.membership_id AND m.principal_id=x.principal_id AND m.active
  JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=x.organization_id AND wm.workspace_id=x.workspace_id
   AND wm.membership_id=x.membership_id AND wm.active
  ORDER BY x.recorded_at,x.organization_id LOOP
  FOR g IN SELECT t.capability_id,t.verbs,t.fields FROM morrow_identity.owner_bootstrap_grants_v2() t
   WHERE t.capability_id IN ('governance.billing.manage','governance.model_default.revise') ORDER BY t.capability_id LOOP
   IF NOT EXISTS(SELECT 1 FROM morrow_identity.grants x WHERE x.organization_id=s.organization_id AND x.workspace_id=s.workspace_id
     AND x.membership_id=s.membership_id AND x.principal_id=s.principal_id AND x.payload->>'capabilityId'=g.capability_id) THEN
    v_key:=gen_random_uuid()::text;
    INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload)
    VALUES (v_key,s.organization_id,s.workspace_id,s.membership_id,s.principal_id,jsonb_build_object(
     'id',v_key,
     'principal',jsonb_build_object('kind','human','principalId',s.principal_id,'organizationId',s.organization_id,'workspaceId',s.workspace_id,
      'membershipId',s.membership_id,'installationId',NULL,'mandateId',NULL),
     'capabilityId',g.capability_id,'verbs',g.verbs,
     'scope',jsonb_build_object('organizationId',s.organization_id,'workspaceId',s.workspace_id,'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,
      'resources',jsonb_build_array(jsonb_build_object('organizationId',s.organization_id,'workspaceId',s.workspace_id,'storeId',NULL,
       'connectionId',NULL,'kind','workspace','id',s.workspace_id)),
      'fields',g.fields),
     'issuedBy',jsonb_build_object('kind','service','principalId','morrow.onboarding','organizationId',s.organization_id,
      'workspaceId',s.workspace_id,'membershipId',NULL,'installationId',NULL,'mandateId',NULL),
     'validFrom',to_char(v_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',NULL,'revokedAt',NULL,
     'policyRevision',s.policy_revision));
   END IF;
  END LOOP;
 END LOOP;
END $$;
COMMIT;
