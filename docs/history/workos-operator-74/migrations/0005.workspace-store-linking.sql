BEGIN;
-- Controlled local linking only. No production proof/review issuer or public API.
DO $$ BEGIN
  IF current_user<>'morrow_identity_owner'
    OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='morrow_identity_linking' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole)
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('morrow_identity_owner','morrow_api','morrow_identity_lifecycle') AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole))
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='morrow_identity_owner' AND rolcanlogin)
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='morrow_identity_linking') OR roleid=(SELECT oid FROM pg_roles WHERE rolname='morrow_identity_linking'))
    OR pg_has_role('morrow_api','morrow_identity_linking','MEMBER')
    OR pg_has_role('morrow_identity_lifecycle','morrow_identity_linking','MEMBER')
    OR pg_has_role('morrow_api','morrow_identity_owner','MEMBER') THEN
    RAISE EXCEPTION 'LINKING_ROLE_PREREQUISITES_INVALID';
  END IF;
END $$;
GRANT USAGE ON SCHEMA morrow_identity TO morrow_identity_linking;
-- A global private subject has no fabricated tenant owner. Its stable identity
-- outlives installation generations; an association can never be reassigned.
CREATE TABLE morrow_identity.linking_candidates (
  id morrow_identity.record_id PRIMARY KEY,
  provider_id text NOT NULL CHECK(provider_id='shopify'),
  application_id morrow_identity.record_id NOT NULL,
  environment_id morrow_identity.record_id NOT NULL,
  shop_id text NOT NULL CHECK(length(shop_id) BETWEEN 1 AND 128),
  shop_domain text NOT NULL CHECK(shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' AND length(shop_domain)<=255),
  installation_id morrow_identity.record_id NOT NULL UNIQUE,
  generation morrow_identity.revision NOT NULL,
  active boolean NOT NULL DEFAULT false,
  ownership_revision morrow_identity.revision NOT NULL DEFAULT 1,
  proof_kind text NOT NULL CHECK(proof_kind='controlled_fixture'),
  proof_id morrow_identity.record_id NOT NULL UNIQUE,
  proof_revision morrow_identity.revision NOT NULL,
  proof_digest text NOT NULL CHECK(proof_digest ~ '^[a-f0-9]{64}$'),
  eligible_principal_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.principals(id),
  proof_created_at timestamptz NOT NULL CHECK(isfinite(proof_created_at)),
  proof_expires_at timestamptz NOT NULL CHECK(isfinite(proof_expires_at) AND proof_expires_at>proof_created_at),
  proof_revoked_at timestamptz,
  UNIQUE(provider_id,application_id,environment_id,shop_id)
);
CREATE TABLE morrow_identity.linking_reviews (
  id morrow_identity.record_id PRIMARY KEY,
  organization_id morrow_identity.record_id NOT NULL,
  workspace_id morrow_identity.record_id NOT NULL,
  actor_principal_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.principals(id),
  actor_membership_id morrow_identity.record_id NOT NULL,
  session_digest text NOT NULL CHECK(session_digest ~ '^[a-f0-9]{64}$'),
  nonce_digest text NOT NULL CHECK(nonce_digest ~ '^[a-f0-9]{64}$'),
  handoff_id morrow_identity.record_id NOT NULL,
  candidate_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.linking_candidates(id),
  installation_id morrow_identity.record_id NOT NULL,
  generation morrow_identity.revision NOT NULL,
  command_id morrow_identity.record_id NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  purpose text NOT NULL CHECK(purpose IN ('install_first','workspace_first','existing_account','additional_store','cross_host_resume')),
  expected_policy_revision morrow_identity.revision NOT NULL,
  expected_ownership_revision morrow_identity.revision NOT NULL,
  proof_id morrow_identity.record_id NOT NULL,
  proof_revision morrow_identity.revision NOT NULL,
  proof_digest text NOT NULL CHECK(proof_digest ~ '^[a-f0-9]{64}$'),
  scope_snapshot jsonb NOT NULL CHECK(jsonb_typeof(scope_snapshot)='object'),
  evidence_kind text NOT NULL CHECK(evidence_kind='controlled_review'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY(organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
  CHECK(isfinite(created_at) AND isfinite(expires_at) AND expires_at>created_at)
);
CREATE TABLE morrow_identity.linking_handoffs (
  id morrow_identity.record_id PRIMARY KEY,
  organization_id morrow_identity.record_id NOT NULL,
  workspace_id morrow_identity.record_id NOT NULL,
  actor_principal_id morrow_identity.record_id NOT NULL,
  actor_membership_id morrow_identity.record_id NOT NULL,
  session_digest text NOT NULL CHECK(session_digest ~ '^[a-f0-9]{64}$'),
  nonce_digest text NOT NULL UNIQUE CHECK(nonce_digest ~ '^[a-f0-9]{64}$'),
  candidate_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.linking_candidates(id),
  installation_id morrow_identity.record_id NOT NULL,
  generation morrow_identity.revision NOT NULL,
  command_id morrow_identity.record_id NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  purpose text NOT NULL CHECK(purpose IN ('install_first','workspace_first','existing_account','additional_store','cross_host_resume')),
  expected_policy_revision morrow_identity.revision NOT NULL,
  expected_ownership_revision morrow_identity.revision NOT NULL,
  proof_id morrow_identity.record_id NOT NULL,
  proof_revision morrow_identity.revision NOT NULL,
  proof_digest text NOT NULL CHECK(proof_digest ~ '^[a-f0-9]{64}$'),
  review_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.linking_reviews(id),
  authorizing_grant_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.grants(id),
  authorizing_grant_snapshot jsonb NOT NULL,
  requested_scope_snapshot jsonb NOT NULL CHECK(jsonb_typeof(requested_scope_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE(organization_id,command_id),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
  FOREIGN KEY(organization_id,actor_membership_id,actor_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
  FOREIGN KEY(workspace_id,actor_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
  CHECK(isfinite(created_at) AND isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
  CHECK((jsonb_typeof(authorizing_grant_snapshot)='object'
    AND authorizing_grant_snapshot->>'id'=authorizing_grant_id::text
    AND authorizing_grant_snapshot->>'capabilityId'='governance.connection.connect'
    AND authorizing_grant_snapshot->'verbs' @> '["administer"]'::jsonb
    AND authorizing_grant_snapshot#>>'{principal,kind}'='human'
    AND authorizing_grant_snapshot#>>'{principal,principalId}'=actor_principal_id::text
    AND authorizing_grant_snapshot#>>'{principal,membershipId}'=actor_membership_id::text
    AND authorizing_grant_snapshot#>>'{principal,organizationId}'=organization_id::text
    AND authorizing_grant_snapshot#>>'{principal,workspaceId}'=workspace_id::text
    AND authorizing_grant_snapshot#>>'{scope,organizationId}'=organization_id::text
    AND authorizing_grant_snapshot#>>'{scope,workspaceId}'=workspace_id::text
    AND authorizing_grant_snapshot->'revokedAt'='null'::jsonb) IS TRUE)
);
CREATE TABLE morrow_identity.workspace_store_links (
  id morrow_identity.record_id PRIMARY KEY,
  candidate_id morrow_identity.record_id NOT NULL UNIQUE REFERENCES morrow_identity.linking_candidates(id),
  organization_id morrow_identity.record_id NOT NULL,
  workspace_id morrow_identity.record_id NOT NULL,
  installation_id morrow_identity.record_id NOT NULL UNIQUE,
  generation morrow_identity.revision NOT NULL,
  ownership_revision morrow_identity.revision NOT NULL,
  actor_principal_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.principals(id),
  linked_at timestamptz NOT NULL,
  FOREIGN KEY(organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id)
);
CREATE TABLE morrow_identity.workspace_link_results (
  id morrow_identity.record_id PRIMARY KEY,
  handoff_id morrow_identity.record_id NOT NULL UNIQUE REFERENCES morrow_identity.linking_handoffs(id),
  organization_id morrow_identity.record_id NOT NULL,
  workspace_id morrow_identity.record_id NOT NULL,
  command_id morrow_identity.record_id NOT NULL,
  actor_principal_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.principals(id),
  candidate_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.linking_candidates(id),
  review_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.linking_reviews(id),
  outcome text NOT NULL CHECK(outcome IN ('applied','denied')),
  reason text NOT NULL CHECK(reason IN ('applied','actor_ineligible','grant_changed','handoff_expired','review_invalid','proof_invalid','purpose_denied','policy_conflict','ownership_conflict','revision_exhausted')),
  link_id morrow_identity.record_id REFERENCES morrow_identity.workspace_store_links(id),
  ownership_revision morrow_identity.revision,
  policy_revision morrow_identity.revision NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE(organization_id,command_id),
  FOREIGN KEY(organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
  CHECK((outcome='applied' AND reason='applied' AND link_id IS NOT NULL AND ownership_revision IS NOT NULL)
    OR(outcome='denied' AND reason<>'applied' AND link_id IS NULL AND ownership_revision IS NULL))
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['linking_candidates','linking_reviews','linking_handoffs','workspace_store_links','workspace_link_results'] LOOP
    EXECUTE format('ALTER TABLE morrow_identity.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE morrow_identity.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY identity_owner ON morrow_identity.%I TO morrow_identity_owner USING(true) WITH CHECK(true)',t);
  END LOOP;
END $$;
CREATE FUNCTION morrow_identity.preserve_linking_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='linking_handoffs' THEN
      IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND(to_jsonb(OLD)-'consumed_at')=(to_jsonb(NEW)-'consumed_at') THEN RETURN NEW; END IF;
    END IF;
    IF TG_TABLE_NAME='linking_reviews' THEN
      IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND(to_jsonb(OLD)-'revoked_at')=(to_jsonb(NEW)-'revoked_at') THEN RETURN NEW; END IF;
    END IF;
    IF TG_TABLE_NAME='linking_candidates' THEN
      IF NEW.id=OLD.id AND NEW.provider_id=OLD.provider_id AND NEW.application_id=OLD.application_id AND NEW.environment_id=OLD.environment_id
        AND NEW.shop_id=OLD.shop_id AND NEW.shop_domain=OLD.shop_domain THEN RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'LINKING_RECORD_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION morrow_identity.preserve_linking_record() FROM PUBLIC;
CREATE TRIGGER linking_candidate_identity BEFORE UPDATE OR DELETE ON morrow_identity.linking_candidates FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_linking_record();
CREATE TRIGGER linking_review_immutable BEFORE UPDATE OR DELETE ON morrow_identity.linking_reviews FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_linking_record();
CREATE TRIGGER linking_handoff_immutable BEFORE UPDATE OR DELETE ON morrow_identity.linking_handoffs FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_linking_record();
CREATE TRIGGER linking_association_immutable BEFORE UPDATE OR DELETE ON morrow_identity.workspace_store_links FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_linking_record();
CREATE TRIGGER linking_result_immutable BEFORE UPDATE OR DELETE ON morrow_identity.workspace_link_results FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_linking_record();
CREATE FUNCTION morrow_identity.link_workspace_store(
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
     AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=x.oid OR m.roleid=x.oid)) THEN
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
 PERFORM 1 FROM morrow_identity.principals WHERE id=h.actor_principal_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.sessions WHERE session_digest=h.session_digest FOR UPDATE;
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
   JOIN morrow_identity.sessions s ON s.session_digest=h.session_digest AND s.principal_id=p.id AND s.organization_id=o.id AND s.revoked_at IS NULL AND s.expires_at>at_time
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
