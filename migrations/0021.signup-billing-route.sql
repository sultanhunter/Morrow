BEGIN;
-- M2 PR-1: the billing route row in the creating transaction (P01.T04a §3 R1 and §8.1;
-- ADR-0015 item 2; mvp-architecture §2 step 1). Executes AS morrow_identity_owner, after
-- 0020. An organization_signups row is written only by the website signup
-- (create_first_organization, P05.T01x, ADR-0009), so its insert records the workspace's
-- route row with origin website in the same transaction, through the one billing
-- definer the identity owner may execute (morrow_billing.record_signup_route, 0020).
-- This is originForCreation({kind: "website_signup", installHandoffPending: false}): no
-- install handoff exists before P09.T02a, which replaces this trigger function when it
-- adds one. Every other workspace creation (fixtures, seeding, later flows) records no
-- row, which reads as origin shopify_install (fail closed). Existing signups are
-- backfilled the same way; a workspace with a store link already is recorded as bound
-- at its first link (R2). It changes no identity table, row or grant.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR to_regclass('morrow_identity.organization_signups') IS NULL
 OR to_regclass('morrow_identity.workspace_store_links') IS NULL
 OR to_regclass('morrow_billing.workspace_billing_routes') IS NULL
 OR to_regprocedure('morrow_billing.record_signup_route(text,text,timestamp with time zone)') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_identity_owner','morrow_billing.record_signup_route(text,text,timestamp with time zone)','EXECUTE')
 OR to_regprocedure('morrow_identity.signup_billing_route()') IS NOT NULL
 THEN RAISE EXCEPTION 'SIGNUP_BILLING_ROUTE_PREREQUISITES_INVALID'; END IF;
END $$;

-- INVOKER, owned by the identity owner, granted to nobody. It runs as the writer of the
-- signup row: the identity owner (create_first_organization is its definer).
CREATE FUNCTION morrow_identity.signup_billing_route() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE v_outcome text;
BEGIN
 v_outcome:=morrow_billing.record_signup_route(NEW.organization_id::text,NEW.workspace_id::text,
  (SELECT min(l.linked_at) FROM morrow_identity.workspace_store_links l
   WHERE l.organization_id=NEW.organization_id AND l.workspace_id=NEW.workspace_id));
 IF v_outcome IS DISTINCT FROM 'recorded' THEN RAISE EXCEPTION 'SIGNUP_BILLING_ROUTE_INVALID'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.signup_billing_route() FROM PUBLIC;
CREATE TRIGGER signup_billing_route AFTER INSERT ON morrow_identity.organization_signups
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.signup_billing_route();

-- The backfill (P01.T04a §8.1): every existing website signup, oldest first.
DO $$ DECLARE s record; v_outcome text; BEGIN
 FOR s IN SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,
   (SELECT min(l.linked_at) FROM morrow_identity.workspace_store_links l
    WHERE l.organization_id=x.organization_id AND l.workspace_id=x.workspace_id) AS bound_at
  FROM morrow_identity.organization_signups x ORDER BY x.recorded_at,x.organization_id LOOP
  v_outcome:=morrow_billing.record_signup_route(s.organization_id,s.workspace_id,s.bound_at);
  IF v_outcome NOT IN ('recorded','exists') THEN RAISE EXCEPTION 'SIGNUP_BILLING_ROUTE_INVALID'; END IF;
 END LOOP;
END $$;
COMMIT;
