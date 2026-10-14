-- Reviewed prerequisites only. Not an activation/deployment command.
-- Run through an owned database administrator before immutable migrations.
-- Owner is deliberately privileged within the identity schema; never grant it
-- to an application/service role. LOGIN/IAM/TLS belongs to qualified P04 setup.
CREATE ROLE morrow_identity_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE morrow_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
-- Internal lifecycle persistence only; never grant to API/runtime roles.
-- The isolated laboratory explicitly enables its own local test login.
CREATE ROLE morrow_identity_lifecycle NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
-- Internal controlled linking executor; no role membership or public issuer.
CREATE ROLE morrow_identity_linking NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CREATE ON DATABASE morrow TO morrow_identity_owner;
