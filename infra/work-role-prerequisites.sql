-- P06.T01a work roles (ADR-0010 item 2). Reviewed prerequisites only: run once by
-- the database administrator before the work migrations, never by an application.
-- Idempotent: an existing role is left unchanged and the migrations' own
-- prerequisite blocks reject any attribute or membership drift.
-- No PASSWORD clause, ever: P04 provisioning sets the api login's password out of
-- band and only the broker holds it (MORROW_DB_PASSWORD_MORROW_API_WORKER, ADR-0007).
-- No relay, maintenance or operations role and no orchestrator login are created here.
DO $$ BEGIN
 -- Owns the morrow_work schema and tables; migrations only.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_work_owner') THEN
  CREATE ROLE morrow_work_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
 END IF;
 -- Owns the API functions; the tenant policies apply to it.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_work_command') THEN
  CREATE ROLE morrow_work_command NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
 END IF;
 -- The SET target of the api login only.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_work_api') THEN
  CREATE ROLE morrow_work_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
 END IF;
 -- The api Worker's login: no privileges of its own, one SET-only membership.
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='morrow_api_worker') THEN
  CREATE ROLE morrow_api_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
 END IF;
END $$;
GRANT morrow_work_api TO morrow_api_worker WITH INHERIT FALSE, SET TRUE;
-- Only so the work migrations can run ALTER FUNCTION ... OWNER TO morrow_work_command.
GRANT morrow_work_command TO morrow_work_owner WITH INHERIT FALSE, SET TRUE;
GRANT CREATE ON DATABASE morrow TO morrow_work_owner;
