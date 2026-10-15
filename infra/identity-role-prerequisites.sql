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
-- Private pre-authentication correlation only; no API assumption or identity issuance.
CREATE ROLE morrow_identity_preauth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
-- Private read-only subject/workspace selection; no inherited or assumable role.
CREATE ROLE morrow_identity_resolution NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
-- Private browser-session admission only; no API assumption or table privileges.
CREATE ROLE morrow_identity_sessions NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
GRANT CREATE ON DATABASE morrow TO morrow_identity_owner;
