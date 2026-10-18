-- Separate exact first-owner signup executor (ADR-0009 item 4). Runtime LOGIN is qualified
-- only in isolated labs; hosted access arrives only through a broker lease (ADR-0007).
CREATE ROLE morrow_identity_onboarding NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
