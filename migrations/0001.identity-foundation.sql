BEGIN;
-- This migration must execute AS morrow_identity_owner, not runtime or superuser.
DO $$ BEGIN
  IF current_user <> 'morrow_identity_owner'
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('morrow_identity_owner','morrow_api')
                AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'morrow_identity_owner' AND rolcanlogin)
     OR pg_catalog.pg_has_role('morrow_api', 'morrow_identity_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'IDENTITY_ROLE_PREREQUISITES_INVALID';
  END IF;
END $$;
CREATE SCHEMA morrow_identity AUTHORIZATION morrow_identity_owner;
REVOKE ALL ON SCHEMA morrow_identity FROM PUBLIC;
GRANT USAGE ON SCHEMA morrow_identity TO morrow_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA morrow_identity REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE DOMAIN morrow_identity.record_id AS text
  CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
CREATE DOMAIN morrow_identity.revision AS bigint
  CHECK (VALUE BETWEEN 1 AND 9007199254740991);
CREATE TABLE morrow_identity.organizations (
  id morrow_identity.record_id PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT false,
  policy_revision morrow_identity.revision NOT NULL DEFAULT 1
);
CREATE TABLE morrow_identity.principals (
  id morrow_identity.record_id PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('human','service','agent')),
  active boolean NOT NULL DEFAULT false
);
CREATE TABLE morrow_identity.memberships (
  id morrow_identity.record_id PRIMARY KEY,
  organization_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.organizations(id),
  principal_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.principals(id),
  active boolean NOT NULL DEFAULT false,
  UNIQUE (organization_id, principal_id),
  UNIQUE (organization_id, id)
);
CREATE TABLE morrow_identity.workspaces (
  id morrow_identity.record_id PRIMARY KEY,
  organization_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.organizations(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  active boolean NOT NULL DEFAULT false,
  UNIQUE (organization_id, id)
);
CREATE TABLE morrow_identity.workspace_memberships (
  organization_id morrow_identity.record_id NOT NULL,
  workspace_id morrow_identity.record_id NOT NULL,
  membership_id morrow_identity.record_id NOT NULL,
  active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, membership_id),
  FOREIGN KEY (organization_id, workspace_id) REFERENCES morrow_identity.workspaces(organization_id, id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES morrow_identity.memberships(organization_id, id)
);
CREATE TABLE morrow_identity.sessions (
  id morrow_identity.record_id PRIMARY KEY,
  principal_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.principals(id),
  organization_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.organizations(id),
  session_digest text NOT NULL UNIQUE CHECK (session_digest ~ '^[a-f0-9]{64}$'),
  provider text NOT NULL CHECK (provider = 'workos'),
  provider_session_id text NOT NULL CHECK (length(provider_session_id) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (provider, provider_session_id)
);
CREATE INDEX sessions_authority ON morrow_identity.sessions (organization_id, principal_id);

-- All tables use FORCE RLS. Maintenance access is an explicit owner policy;
-- runtime has no membership in that NOLOGIN role and no private-table privileges.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','principals','memberships','workspaces','workspace_memberships','sessions'] LOOP
    EXECUTE format('ALTER TABLE morrow_identity.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE morrow_identity.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY identity_owner ON morrow_identity.%I TO morrow_identity_owner USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- GUC values alone do not establish authority: every invocation resolves a
-- sensitive opaque session digest against current durable session/membership.
-- No session digest, provider session ID or client organization is returned.
-- Fixed search_path prevents temp/public object substitution in definer code.
CREATE FUNCTION morrow_identity.resolved_context()
RETURNS TABLE (principal_id text, organization_id text, workspace_id text, membership_id text, policy_revision bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, morrow_identity, pg_temp
AS $$
  SELECT p.id::text, o.id::text, w.id::text, m.id::text, o.policy_revision::bigint
  FROM morrow_identity.sessions s
  JOIN morrow_identity.principals p ON p.id = s.principal_id AND p.active AND p.kind = 'human'
  JOIN morrow_identity.organizations o ON o.id = s.organization_id AND o.active
  JOIN morrow_identity.memberships m ON m.organization_id = o.id AND m.principal_id = p.id AND m.active
  JOIN morrow_identity.workspace_memberships wm ON wm.organization_id = o.id AND wm.membership_id = m.id AND wm.active
  JOIN morrow_identity.workspaces w ON w.organization_id = o.id AND w.id = wm.workspace_id AND w.active
  WHERE s.session_digest = pg_catalog.current_setting('morrow.session_digest', true)
    AND w.id::text = pg_catalog.current_setting('morrow.requested_workspace', true)
    AND s.revoked_at IS NULL AND s.expires_at > pg_catalog.statement_timestamp()
$$;
REVOKE ALL ON FUNCTION morrow_identity.resolved_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.resolved_context() TO morrow_api;
CREATE POLICY eligible_organization ON morrow_identity.organizations FOR SELECT TO morrow_api
  USING (id::text IN (SELECT organization_id FROM morrow_identity.resolved_context()));
CREATE POLICY eligible_workspace ON morrow_identity.workspaces FOR SELECT TO morrow_api
  USING ((organization_id::text, id::text) IN
    (SELECT organization_id, workspace_id FROM morrow_identity.resolved_context()));
GRANT SELECT (id, display_name, policy_revision) ON morrow_identity.organizations TO morrow_api;
GRANT SELECT (id, organization_id, display_name) ON morrow_identity.workspaces TO morrow_api;
COMMIT;
