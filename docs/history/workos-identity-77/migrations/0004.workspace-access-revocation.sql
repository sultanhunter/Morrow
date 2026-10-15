BEGIN;
-- Local lifecycle engineering only. No receipt issuer or production login is
-- installed. The separate NOLOGIN role is not inherited by API/runtime roles.
DO $$ BEGIN
  IF current_user <> 'morrow_identity_owner'
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('morrow_identity_owner','morrow_api','morrow_identity_lifecycle') AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_identity_owner' AND rolcanlogin)
    OR pg_catalog.pg_has_role('morrow_api','morrow_identity_owner','MEMBER')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_identity_lifecycle'
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='morrow_identity_lifecycle'))
    OR pg_catalog.pg_has_role('morrow_identity_lifecycle','morrow_identity_owner','MEMBER')
    OR pg_catalog.pg_has_role('morrow_api','morrow_identity_lifecycle','MEMBER') THEN
    RAISE EXCEPTION 'IDENTITY_ROLE_PREREQUISITES_INVALID';
  END IF;
END $$;
GRANT USAGE ON SCHEMA morrow_identity TO morrow_identity_lifecycle;
CREATE TABLE morrow_identity.workspace_revocation_receipts (
  id morrow_identity.record_id PRIMARY KEY,
  organization_id morrow_identity.record_id NOT NULL,
  workspace_id morrow_identity.record_id NOT NULL,
  actor_principal_id morrow_identity.record_id NOT NULL,
  actor_membership_id morrow_identity.record_id NOT NULL,
  actor_session_digest text NOT NULL CHECK (actor_session_digest ~ '^[a-f0-9]{64}$'),
  target_membership_id morrow_identity.record_id NOT NULL,
  command_id morrow_identity.record_id NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  expected_policy_revision morrow_identity.revision NOT NULL,
  authorizing_grant_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.grants(id),
  authorizing_grant_snapshot jsonb NOT NULL,
  approval_evidence_id morrow_identity.record_id NOT NULL,
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  consumed_at timestamptz,
  UNIQUE (organization_id,command_id),
  FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
  FOREIGN KEY (organization_id,actor_membership_id,actor_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
  FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
  FOREIGN KEY (organization_id,target_membership_id) REFERENCES morrow_identity.memberships(organization_id,id),
  FOREIGN KEY (workspace_id,target_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
  CHECK ((jsonb_typeof(authorizing_grant_snapshot)='object'
    AND authorizing_grant_snapshot->>'id'=authorizing_grant_id::text
    AND authorizing_grant_snapshot#>>'{principal,kind}'='human'
    AND authorizing_grant_snapshot#>>'{principal,organizationId}'=organization_id::text
    AND authorizing_grant_snapshot#>>'{principal,workspaceId}'=workspace_id::text
    AND authorizing_grant_snapshot#>>'{principal,principalId}'=actor_principal_id::text
    AND authorizing_grant_snapshot#>>'{principal,membershipId}'=actor_membership_id::text
    AND authorizing_grant_snapshot#>>'{scope,organizationId}'=organization_id::text
    AND authorizing_grant_snapshot#>>'{scope,workspaceId}'=workspace_id::text
    AND authorizing_grant_snapshot->>'capabilityId'='governance.membership.revoke'
    AND authorizing_grant_snapshot->'revokedAt'='null'::jsonb) IS TRUE)
);
-- This is the one immutable attributable command result AND audit record.
-- It intentionally omits bearer proofs, full grant payloads and provider data.
CREATE TABLE morrow_identity.workspace_revocation_results (
  id morrow_identity.record_id PRIMARY KEY,
  receipt_id morrow_identity.record_id NOT NULL UNIQUE REFERENCES morrow_identity.workspace_revocation_receipts(id),
  organization_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.organizations(id),
  workspace_id morrow_identity.record_id NOT NULL,
  command_id morrow_identity.record_id NOT NULL,
  actor_principal_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.principals(id),
  actor_membership_id morrow_identity.record_id NOT NULL,
  target_membership_id morrow_identity.record_id NOT NULL,
  approval_evidence_id morrow_identity.record_id NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('applied','denied')),
  reason text NOT NULL CHECK (reason IN ('applied','actor_ineligible','receipt_expired','policy_conflict','grant_changed','target_ineligible','revision_exhausted')),
  revocation_id morrow_identity.record_id UNIQUE,
  policy_revision morrow_identity.revision NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (organization_id,command_id),
  FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
  FOREIGN KEY (organization_id,actor_membership_id,actor_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
  FOREIGN KEY (organization_id,target_membership_id) REFERENCES morrow_identity.memberships(organization_id,id),
  CHECK ((outcome='applied' AND reason='applied' AND revocation_id IS NOT NULL)
    OR (outcome='denied' AND reason<>'applied' AND revocation_id IS NULL))
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_revocation_receipts','workspace_revocation_results'] LOOP
    EXECUTE format('ALTER TABLE morrow_identity.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE morrow_identity.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY identity_owner ON morrow_identity.%I TO morrow_identity_owner USING (true) WITH CHECK (true)',t);
  END LOOP;
END $$;
CREATE FUNCTION morrow_identity.preserve_workspace_revocation_record()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='workspace_revocation_receipts' AND TG_OP='UPDATE' THEN
    IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
      AND (to_jsonb(OLD)-'consumed_at')=(to_jsonb(NEW)-'consumed_at') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'LIFECYCLE_RECORD_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION morrow_identity.preserve_workspace_revocation_record() FROM PUBLIC;
CREATE TRIGGER immutable_workspace_receipt BEFORE UPDATE OR DELETE ON morrow_identity.workspace_revocation_receipts
  FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_workspace_revocation_record();
CREATE TRIGGER immutable_workspace_result BEFORE UPDATE OR DELETE ON morrow_identity.workspace_revocation_results
  FOR EACH ROW EXECUTE FUNCTION morrow_identity.preserve_workspace_revocation_record();

CREATE FUNCTION morrow_identity.revoke_workspace_access(
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
  PERFORM 1 FROM morrow_identity.principals WHERE id=receipt.actor_principal_id FOR UPDATE;
  PERFORM 1 FROM morrow_identity.sessions WHERE session_digest=receipt.actor_session_digest FOR UPDATE;
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
    JOIN morrow_identity.sessions s ON s.principal_id=p.id AND s.organization_id=receipt.organization_id AND s.session_digest=receipt.actor_session_digest
    WHERE p.id=receipt.actor_principal_id AND p.active AND p.kind='human' AND s.revoked_at IS NULL AND s.expires_at>now_at);
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
COMMIT;
