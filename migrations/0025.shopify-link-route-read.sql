BEGIN;
-- M2 PR-2: the billing route read of the linking rule (ADR-0022 item 5; P01.T04a §3 R2 is
-- superseded for the MVP: a store links only into a workspace whose route is fixed to
-- morrow_direct, and shopify_bound_at is never set). Executes AS morrow_work_owner, after
-- 0024 and before 0026, which calls it. One SECURITY DEFINER read, owned by the command
-- role after the transfer below and executable by the identity owner only, so the
-- identity-owned linking definers (the P09.T02a issuer, the connections read and
-- link_workspace_store) read one workspace's route without any work session context. Its
-- policy, route_link_read, admits only the row of exactly the (organization, workspace)
-- the definer names in its transaction-local setting, for SELECT only. Nothing is written;
-- no table, column or grant of 0020-0024 changes.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR to_regclass('morrow_billing.workspace_billing_routes') IS NULL
 OR to_regprocedure('morrow_billing.route_guard()') IS NULL
 OR to_regprocedure('morrow_billing.link_route_current(text,text)') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='morrow_billing' AND p.tablename='workspace_billing_routes'
   AND p.policyname='route_link_read')
 OR NOT pg_catalog.has_schema_privilege('morrow_identity_owner','morrow_billing','USAGE')
 OR NOT morrow_identity.morrow_memberships_closed()
 THEN RAISE EXCEPTION 'SHOPIFY_LINK_ROUTE_READ_PREREQUISITES_INVALID'; END IF;
END $$;

-- The one row the read definer names, while it runs. SELECT only: the setting never
-- admits a write, and the definer clears it before it returns.
CREATE POLICY route_link_read ON morrow_billing.workspace_billing_routes FOR SELECT TO morrow_work_command
 USING (pg_catalog.current_setting('morrow.billing_route_read',true)=organization_id::text||'|'||workspace_id::text);

-- The workspace's route for the linking rule. Outcomes: morrow_direct (fixed to the
-- Morrow-direct route, either mode), shopify_app_pricing (fixed to the Shopify route),
-- unfixed (a row with no route yet), missing (no row: reads as origin shopify_install,
-- R1) and invalid (malformed ids). Linking requires morrow_direct. No row lock: route_guard
-- makes a fixed route immutable, and every other answer is a refusal, so the R2 binding
-- race cannot occur.
CREATE FUNCTION morrow_billing.link_route_current(p_org text,p_ws text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_route text; v_found boolean;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN 'invalid';
 END IF;
 PERFORM pg_catalog.set_config('morrow.billing_route_read',p_org||'|'||p_ws,true);
 SELECT r.route INTO v_route FROM morrow_billing.workspace_billing_routes r
  WHERE r.organization_id=p_org AND r.workspace_id=p_ws;
 v_found:=FOUND;
 PERFORM pg_catalog.set_config('morrow.billing_route_read','',true);
 IF NOT v_found THEN RETURN 'missing'; END IF;
 RETURN CASE WHEN v_route IS NULL THEN 'unfixed' WHEN v_route='morrow_direct' THEN 'morrow_direct'
  WHEN v_route='shopify_app_pricing' THEN 'shopify_app_pricing' ELSE 'invalid' END;
END $$;
REVOKE ALL ON FUNCTION morrow_billing.link_route_current(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_billing.link_route_current(text,text) TO morrow_identity_owner;
GRANT CREATE ON SCHEMA morrow_billing TO morrow_work_command;
ALTER FUNCTION morrow_billing.link_route_current(text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_billing FROM morrow_work_command;
COMMIT;
