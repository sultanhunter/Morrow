BEGIN;
-- Controlled, private read boundaries only. Existing linking writers stay exact.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='morrow_identity_owner'
   AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
   AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication)
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='morrow_identity_linking'
   AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb
   AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles service,pg_catalog.pg_roles owner
   WHERE owner.rolname='morrow_identity_owner'
   AND service.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions')
   AND (pg_catalog.pg_has_role(service.oid,owner.oid,'MEMBER') OR pg_catalog.pg_has_role(owner.oid,service.oid,'MEMBER'))) THEN
  RAISE EXCEPTION 'LINKING_READ_ROLE_PREREQUISITES_INVALID';
 END IF;
END $$;

-- Private common predicate. No executor receives this table-shaped helper.
-- This is a read observation, never a reservation or a reusable permission.
CREATE FUNCTION morrow_identity.bound_workspace_linking_handoff(
 p_session text,p_workspace text,p_nonce text,p_command text)
RETURNS SETOF morrow_identity.linking_handoffs
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
 h morrow_identity.linking_handoffs%ROWTYPE;
 c morrow_identity.linking_candidates%ROWTYPE;
 r morrow_identity.linking_reviews%ROWTYPE;
 previous morrow_identity.workspace_link_results%ROWTYPE;
 association morrow_identity.workspace_store_links%ROWTYPE;
 at_time timestamptz; grant_start timestamptz; grant_end timestamptz;
 grant_ok boolean; proof_ok boolean; review_ok boolean;
BEGIN
 IF current_user<>'morrow_identity_owner' OR session_user<>'morrow_identity_linking'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles o WHERE o.rolname='morrow_identity_owner'
   AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb
   AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles x WHERE x.rolname=session_user
   AND NOT x.rolsuper AND NOT x.rolbypassrls AND NOT x.rolcreatedb AND NOT x.rolcreaterole
   AND NOT x.rolinherit AND NOT x.rolreplication
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=x.oid OR m.roleid=x.oid))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles service,pg_catalog.pg_roles owner
   WHERE owner.rolname='morrow_identity_owner'
   AND service.rolname IN ('morrow_api','morrow_identity_lifecycle','morrow_identity_linking','morrow_identity_preauth','morrow_identity_resolution','morrow_identity_sessions')
   AND (pg_catalog.pg_has_role(service.oid,owner.oid,'MEMBER') OR pg_catalog.pg_has_role(owner.oid,service.oid,'MEMBER'))) THEN RETURN; END IF;
 IF p_session IS NULL OR p_workspace IS NULL OR p_nonce IS NULL OR p_command IS NULL
   OR p_session !~ '^[a-f0-9]{64}$' OR p_nonce !~ '^[a-f0-9]{64}$'
   OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_command !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RETURN; END IF;
 SELECT * INTO h FROM morrow_identity.linking_handoffs
 WHERE session_digest=p_session AND workspace_id::text=p_workspace
   AND nonce_digest=p_nonce AND command_id::text=p_command;
 IF NOT FOUND THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_identity.session_eligibility(p_session,p_workspace) s
   WHERE s.principal_id=h.actor_principal_id::text AND s.organization_id=h.organization_id::text
     AND s.membership_id=h.actor_membership_id::text) THEN RETURN; END IF;
 SELECT * INTO c FROM morrow_identity.linking_candidates WHERE id=h.candidate_id;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO r FROM morrow_identity.linking_reviews WHERE id=h.review_id;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO association FROM morrow_identity.workspace_store_links WHERE candidate_id=c.id;
 at_time:=clock_timestamp();
 grant_ok:=EXISTS(SELECT 1 FROM morrow_identity.grants g WHERE g.id=h.authorizing_grant_id
   AND g.organization_id=h.organization_id AND g.workspace_id=h.workspace_id
   AND g.principal_id=h.actor_principal_id AND g.membership_id=h.actor_membership_id
   AND g.payload=h.authorizing_grant_snapshot);
 BEGIN
  grant_start:=(h.authorizing_grant_snapshot->>'validFrom')::timestamptz;
  grant_end:=(h.authorizing_grant_snapshot->>'expiresAt')::timestamptz;
  grant_ok:=grant_ok AND grant_start IS NOT NULL AND isfinite(grant_start) AND grant_start<=at_time
    AND(h.authorizing_grant_snapshot->'expiresAt'='null'::jsonb OR(grant_end IS NOT NULL AND isfinite(grant_end) AND grant_end>at_time));
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN; END;
 proof_ok:=c.active AND c.installation_id=h.installation_id AND c.generation=h.generation
   AND c.eligible_principal_id=h.actor_principal_id AND c.proof_id=h.proof_id
   AND c.proof_revision=h.proof_revision AND c.proof_digest=h.proof_digest
   AND c.proof_created_at<=at_time AND c.proof_expires_at>at_time AND c.proof_revoked_at IS NULL;
 review_ok:=r.organization_id=h.organization_id AND r.workspace_id=h.workspace_id
   AND r.actor_principal_id=h.actor_principal_id AND r.actor_membership_id=h.actor_membership_id
   AND r.session_digest=h.session_digest AND r.nonce_digest=h.nonce_digest AND r.handoff_id=h.id
   AND r.candidate_id=h.candidate_id AND r.installation_id=h.installation_id AND r.generation=h.generation
   AND r.command_id=h.command_id AND r.request_digest=h.request_digest AND r.purpose=h.purpose
   AND r.expected_policy_revision=h.expected_policy_revision AND r.expected_ownership_revision=h.expected_ownership_revision
   AND r.proof_id=h.proof_id AND r.proof_revision=h.proof_revision AND r.proof_digest=h.proof_digest
   AND r.scope_snapshot=h.requested_scope_snapshot AND r.revoked_at IS NULL AND r.created_at<=at_time;
 IF grant_ok IS NOT TRUE OR proof_ok IS NOT TRUE OR review_ok IS NOT TRUE THEN RETURN; END IF;
 SELECT * INTO previous FROM morrow_identity.workspace_link_results WHERE handoff_id=h.id;
 IF FOUND THEN
  -- Same current replay predicate as the unchanged writer, without row locks or
  -- any write call. Old receipt TTL never becomes a fresh dispatch permission.
  IF h.consumed_at IS NULL OR previous.command_id<>h.command_id
    OR previous.organization_id<>h.organization_id OR previous.workspace_id<>h.workspace_id
    OR previous.actor_principal_id<>h.actor_principal_id OR previous.candidate_id<>h.candidate_id
    OR previous.review_id<>h.review_id THEN RETURN; END IF;
  IF (previous.outcome='applied' AND association.id=previous.link_id
      AND association.organization_id=h.organization_id AND association.workspace_id=h.workspace_id
      AND association.installation_id=h.installation_id AND association.generation=h.generation
      AND association.ownership_revision=previous.ownership_revision
      AND c.ownership_revision=previous.ownership_revision)
     OR(previous.outcome='denied' AND association.id IS NULL AND c.ownership_revision=h.expected_ownership_revision) THEN
   RETURN NEXT h;
  END IF;
  RETURN;
 END IF;
 IF h.consumed_at IS NOT NULL OR h.created_at>at_time OR h.expires_at<=at_time
   OR r.expires_at<=at_time OR association.id IS NOT NULL
   OR c.ownership_revision<>h.expected_ownership_revision
   OR NOT EXISTS(SELECT 1 FROM morrow_identity.organizations o WHERE o.id=h.organization_id
     AND o.active AND o.policy_revision=h.expected_policy_revision) THEN RETURN; END IF;
 RETURN NEXT h;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.bound_workspace_linking_handoff(text,text,text,text)
 FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_linking,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions;

CREATE FUNCTION morrow_identity.lookup_workspace_store_link(
 p_session text,p_workspace text,p_nonce text,p_command text)
RETURNS TABLE(handoff_id text,command_id text,request_digest text,session_digest text,nonce_digest text,
 organization_id text,workspace_id text,installation_id text,purpose text,expected_policy_revision text,expected_ownership_revision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT h.id::text,h.command_id::text,h.request_digest,h.session_digest,h.nonce_digest,
   h.organization_id::text,h.workspace_id::text,h.installation_id::text,h.purpose,
   h.expected_policy_revision::text,h.expected_ownership_revision::text
 FROM morrow_identity.bound_workspace_linking_handoff(p_session,p_workspace,p_nonce,p_command) h
$$;
CREATE FUNCTION morrow_identity.workspace_store_link_status(
 p_session text,p_workspace text,p_nonce text,p_command text)
RETURNS TABLE(outcome text,link_id text,ownership_revision text,policy_revision text,audit_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT r.outcome,r.link_id::text,r.ownership_revision::text,r.policy_revision::text,r.id::text
 FROM morrow_identity.bound_workspace_linking_handoff(p_session,p_workspace,p_nonce,p_command) h
 JOIN morrow_identity.workspace_link_results r ON r.handoff_id=h.id
$$;
REVOKE ALL ON FUNCTION morrow_identity.lookup_workspace_store_link(text,text,text,text),
 morrow_identity.workspace_store_link_status(text,text,text,text)
 FROM PUBLIC,morrow_api,morrow_identity_lifecycle,morrow_identity_preauth,morrow_identity_resolution,morrow_identity_sessions;
GRANT EXECUTE ON FUNCTION morrow_identity.lookup_workspace_store_link(text,text,text,text),
 morrow_identity.workspace_store_link_status(text,text,text,text) TO morrow_identity_linking;
COMMIT;
