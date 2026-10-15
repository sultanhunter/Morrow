BEGIN;
DO $$ BEGIN
  IF current_user <> 'morrow_identity_owner'
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname IN ('morrow_identity_owner','morrow_api')
                AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_identity_owner' AND rolcanlogin)
     OR pg_catalog.pg_has_role('morrow_api','morrow_identity_owner','MEMBER') THEN
    RAISE EXCEPTION 'IDENTITY_ROLE_PREREQUISITES_INVALID';
  END IF;
END $$;
-- Owner-provisioned configuration only. No tenant or principal authority lives here.
CREATE TABLE morrow_identity.authentication_bindings (
  id morrow_identity.record_id PRIMARY KEY,
  environment_id text NOT NULL CHECK (length(environment_id) BETWEEN 1 AND 128),
  client_id text NOT NULL CHECK (client_id ~ '^client_[A-Z0-9]{26}$'),
  redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
  return_path text NOT NULL CHECK (length(return_path) BETWEEN 1 AND 512),
  active boolean NOT NULL DEFAULT false
);
CREATE TABLE morrow_identity.authentication_challenges (
  id uuid PRIMARY KEY,
  binding_id morrow_identity.record_id NOT NULL REFERENCES morrow_identity.authentication_bindings(id),
  environment_id text NOT NULL,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  return_path text NOT NULL,
  state_digest text NOT NULL UNIQUE CHECK (state_digest ~ '^[a-f0-9]{64}$'),
  browser_digest text NOT NULL UNIQUE CHECK (browser_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '5 minutes',
  consumed_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at+interval '5 minutes')
);
CREATE INDEX authentication_pending ON morrow_identity.authentication_challenges(binding_id,expires_at)
  WHERE consumed_at IS NULL;
ALTER TABLE morrow_identity.authentication_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_identity.authentication_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE morrow_identity.authentication_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_identity.authentication_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_owner ON morrow_identity.authentication_bindings TO morrow_identity_owner USING (true) WITH CHECK (true);
CREATE POLICY identity_owner ON morrow_identity.authentication_challenges TO morrow_identity_owner USING (true) WITH CHECK (true);

-- API can run only these fixed pre-authentication operations. No direct table
-- privilege, session issuance, membership write or capability grant is added.
CREATE FUNCTION morrow_identity.begin_authentication_challenge(
  created_id uuid, configured_binding text, state_hash text, browser_hash text,
  configured_environment text, configured_client text, configured_redirect text, configured_return text
) RETURNS TABLE (challenge_id text)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, morrow_identity, pg_temp
AS $$
  INSERT INTO morrow_identity.authentication_challenges(id,binding_id,environment_id,client_id,redirect_uri,return_path,state_digest,browser_digest)
  SELECT $1,b.id,b.environment_id,b.client_id,b.redirect_uri,b.return_path,$3,$4 FROM morrow_identity.authentication_bindings b
  WHERE b.id::text=$2 AND b.active AND b.environment_id=$5 AND b.client_id=$6
    AND b.redirect_uri=$7 AND b.return_path=$8
  RETURNING id::text
$$;
CREATE FUNCTION morrow_identity.consume_authentication_challenge(
  configured_binding text, state_hash text, browser_hash text,
  configured_environment text, configured_client text, configured_redirect text, configured_return text
) RETURNS TABLE (challenge_id text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, morrow_identity, pg_temp
AS $$
DECLARE pending morrow_identity.authentication_challenges%ROWTYPE;
BEGIN
  -- Configuration changes and callback consumption use the same locked tuple.
  PERFORM b.id FROM morrow_identity.authentication_bindings b
    WHERE b.id::text=$1 AND b.active AND b.environment_id=$4 AND b.client_id=$5
      AND b.redirect_uri=$6 AND b.return_path=$7 FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT c.* INTO pending FROM morrow_identity.authentication_challenges c
    WHERE c.binding_id::text=$1 AND c.state_digest=$2 AND c.browser_digest=$3
      AND c.consumed_at IS NULL AND c.environment_id=$4 AND c.client_id=$5
      AND c.redirect_uri=$6 AND c.return_path=$7 FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  -- Wall time AFTER the row-lock wait, not transaction/statement start time.
  IF pending.created_at>clock_timestamp() OR pending.expires_at<=clock_timestamp() THEN RETURN; END IF;
  UPDATE morrow_identity.authentication_challenges c SET consumed_at=clock_timestamp()
    WHERE c.id=pending.id RETURNING c.id::text INTO challenge_id;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION morrow_identity.begin_authentication_challenge(uuid,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_identity.consume_authentication_challenge(text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.begin_authentication_challenge(uuid,text,text,text,text,text,text,text) TO morrow_api;
GRANT EXECUTE ON FUNCTION morrow_identity.consume_authentication_challenge(text,text,text,text,text,text,text) TO morrow_api;
COMMIT;
