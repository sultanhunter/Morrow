-- Separate exact executor. Runtime LOGIN is qualified only in isolated labs.
CREATE ROLE morrow_identity_logout NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
