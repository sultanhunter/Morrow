BEGIN;
DO $$ BEGIN
  IF current_user <> 'morrow_identity_owner' THEN
    RAISE EXCEPTION 'IDENTITY_ROLE_PREREQUISITES_INVALID';
  END IF;
END $$;
ALTER TABLE morrow_identity.memberships ADD CONSTRAINT membership_principal_binding
  UNIQUE (organization_id, id, principal_id);
CREATE TABLE morrow_identity.grants (
  id morrow_identity.record_id PRIMARY KEY,
  organization_id morrow_identity.record_id NOT NULL,
  workspace_id morrow_identity.record_id NOT NULL,
  membership_id morrow_identity.record_id NOT NULL,
  principal_id morrow_identity.record_id NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (organization_id, workspace_id) REFERENCES morrow_identity.workspaces(organization_id, id),
  FOREIGN KEY (organization_id, membership_id, principal_id) REFERENCES morrow_identity.memberships(organization_id, id, principal_id),
  FOREIGN KEY (workspace_id, membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id, membership_id),
  CHECK ((jsonb_typeof(payload) = 'object'
    AND payload->>'id' = id::text
    AND payload#>>'{principal,organizationId}' = organization_id::text
    AND payload#>>'{principal,workspaceId}' = workspace_id::text
    AND payload#>>'{principal,membershipId}' = membership_id::text
    AND payload#>>'{principal,principalId}' = principal_id::text
    AND payload#>>'{scope,organizationId}' = organization_id::text
    AND payload#>>'{scope,workspaceId}' = workspace_id::text) IS TRUE)
);
CREATE INDEX grants_current_actor ON morrow_identity.grants (organization_id,workspace_id,membership_id,principal_id);
ALTER TABLE morrow_identity.grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_identity.grants FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_owner ON morrow_identity.grants TO morrow_identity_owner USING (true) WITH CHECK (true);
CREATE POLICY own_current_grants ON morrow_identity.grants FOR SELECT TO morrow_api
  USING ((organization_id::text,workspace_id::text,membership_id::text,principal_id::text) IN
    (SELECT organization_id,workspace_id,membership_id,principal_id FROM morrow_identity.resolved_context()));
GRANT SELECT (id,organization_id,workspace_id,membership_id,principal_id,payload) ON morrow_identity.grants TO morrow_api;
-- Only owned maintenance may persist grants. Full closed Grant validation also
-- runs at the application read boundary. This is not an issuance/audit API.
COMMIT;
