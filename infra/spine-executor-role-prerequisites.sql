-- M2 PR-1 executor logins (ADR-0022 item 8, spine §3). Reviewed prerequisites only: run
-- once by the database administrator before migration 0019, never by an application.
-- Idempotent: an existing role is left unchanged and 0019 refuses to apply on any
-- attribute or membership drift. Three membership-free executor logins on the P05
-- pattern: no role is ever granted to them and they are granted to no role, so the
-- ADR-0020 closed set and the owner roles are unchanged. Each executes only its own
-- definers. No PASSWORD clause, ever: P04 provisioning sets the two leased passwords
-- (morrow_connector_ingress and morrow_runtime_executor, through neonLease) and the
-- broker's own (morrow_vault_broker, never leased) out of band.
DO $$ BEGIN
 -- The connector Worker's login: Shopify launch, callback, webhooks and status (M2 PR-2/PR-3).
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_connector_ingress') THEN
  CREATE ROLE morrow_connector_ingress LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
 END IF;
 -- The orchestrator Worker's login: enters leases, lists pending starts.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_runtime_executor') THEN
  CREATE ROLE morrow_runtime_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
 END IF;
 -- The broker Worker's own login: the vault definers only.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_vault_broker') THEN
  CREATE ROLE morrow_vault_broker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
 END IF;
END $$;
