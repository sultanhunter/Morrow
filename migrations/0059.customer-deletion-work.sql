BEGIN;
-- SD3 (P09.T05b): the "orders listed" matcher and the customer redaction run
-- (docs/plan/store-data-foundation-implementation.md row SD3; ADR-0031 item 3 and its
-- 2026-10-26 note on item 1; ADR-0043 item 24; docs/briefs/sd3-keep-orders-to-redact.md).
-- Executes AS morrow_work_owner, after customer-deletion-identity (0058). It adds:
--   * the match of one customers/* request (customer_match_of, customer_match_valid,
--     customer_match_orders): the order ids the request lists, read from the inbox row the
--     broker recorded (0058), never from a caller. Pure, IMMUTABLE, EXECUTE for the command
--     role, so a registered class's handler and policies can call them;
--   * customer_content_redact(org, ws, store, match), the registration surface: a revisable
--     owner helper (INVOKER, owned by the owner, EXECUTE for the command role) that runs
--     every customer-content handler registered on the matchers (packages/work/src/
--     redaction.ts customerContentHandlers) and returns one entry per handler with its rows
--     and the rows still matching. It runs only under the connector's customer redaction
--     context for exactly that store (morrow.connector_customer, which only the applier below
--     writes, and clears). No handler is registered yet: the pull request that first writes a
--     customer-keyed class replaces it, with its policies on that context, in the same change
--     (ADR-0031 item 4, G9), and S8 fails an order-keyed table without its handler;
--   * connector_inbox_apply_v2 (0054), same signature, owner and ACL: customers/redact runs the
--     redaction under the store's stop key (exclusive, as shop/redact takes it, so a class
--     writer holding it shared either commits first and is redacted or writes after), and
--     its privacy request completes only when every handler reports zero remaining
--     ("customer_redacted" with each handler's rows, or "none_held" when no handler is
--     registered); otherwise the delivery stays received, the cron re-drives it, and its
--     inbox row (with the order ids) outlives its 7 days. customers/data_request still
--     completes "none held"; every other topic is 0054's, unchanged;
--   * connector_privacy_purge(): the inbox's 7-day purge for the connector's cron (counts
--     only; 0058's work_shopify_inbox_purge), run only while the connection clean-up switch is
--     on (docs/decisions/connection-cleanup-staging.json).
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regprocedure('morrow_work.connector_inbox_apply(text)') IS NULL
 OR to_regprocedure('morrow_work.connection_health_reconcile(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.customer_content_redact(text,text,text,jsonb)') IS NOT NULL
 OR to_regprocedure('morrow_work.connector_privacy_purge()') IS NOT NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_purge()','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_take(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_settle(text,text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_privacy_request_complete(text,text,text,jsonb)','EXECUTE')
 OR to_regprocedure('morrow_identity.customer_handler_tables()') IS NULL
 -- The function text this file replaces, exactly as 0054 wrote it (a missed merge fails here).
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_work.connector_inbox_apply_v2(text)'))
  IS DISTINCT FROM 'b4f5f7ea0c5fdb65ac1cdb7e32770c1a'
 THEN RAISE EXCEPTION 'CUSTOMER_DELETION_WORK_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pure functions: IMMUTABLE, owned by the owner; the command role holds EXECUTE (the 0015
-- valid_scope pattern), so a registered class's definers, CHECKs and policies may call them.
-- The match document of one customers/* request: {"orders": [ids]}, at most 20,000 distinct
-- numeric order ids as text.
CREATE FUNCTION morrow_work.customer_match_valid(p_match jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_keys text[];
BEGIN
 IF p_match IS NULL OR jsonb_typeof(p_match)<>'object' THEN RETURN false; END IF;
 SELECT COALESCE(array_agg(k ORDER BY k),'{}') INTO v_keys FROM jsonb_object_keys(p_match) k;
 IF v_keys<>ARRAY['orders'] OR jsonb_typeof(p_match->'orders')<>'array' OR jsonb_array_length(p_match->'orders')>20000 THEN
  RETURN false;
 END IF;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_match->'orders') e
   WHERE jsonb_typeof(e)<>'string' OR (e#>>'{}') !~ '^[1-9][0-9]{0,19}$')
  AND (SELECT count(DISTINCT e#>>'{}') FROM jsonb_array_elements(p_match->'orders') e)=jsonb_array_length(p_match->'orders');
END $$;
-- The match of one inbox row's minimised body (0058's shapes): the order ids its request lists
-- (ordersToRedact or ordersRequested; none for a row recorded before SD3). NULL for any other
-- topic or an invalid body.
CREATE FUNCTION morrow_work.customer_match_of(p_topic text,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_match jsonb;
BEGIN
 IF p_topic IS NULL OR p_topic NOT IN ('customers/data_request','customers/redact') OR p_body IS NULL
  OR jsonb_typeof(p_body)<>'object' THEN
  RETURN NULL;
 END IF;
 v_match:=jsonb_build_object('orders',COALESCE(p_body->CASE p_topic WHEN 'customers/redact' THEN 'ordersToRedact' ELSE 'ordersRequested' END,
  '[]'::jsonb));
 RETURN CASE WHEN morrow_work.customer_match_valid(v_match) THEN v_match END;
END $$;
-- The listed orders of a valid match, as an array a handler compares its order ids with
-- (`order_id = ANY(...)`). NULL for an invalid match, which matches nothing.
CREATE FUNCTION morrow_work.customer_match_orders(p_match jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT CASE WHEN morrow_work.customer_match_valid(p_match)
  THEN (SELECT COALESCE(array_agg(e ORDER BY e),'{}') FROM jsonb_array_elements_text(p_match->'orders') e) END
$$;

-- ---------------------------------------------------------------------------
-- The registration surface: a revisable owner helper (INVOKER, owned by the owner, EXECUTE for
-- the command role only), run by the applier below as the command role. It runs only under
-- the connector's customer redaction context for exactly this store
-- (morrow.connector_customer = org|ws|store, which only connector_inbox_apply_v2 writes, and
-- clears); anything else is refused, never an empty success. Returns one entry per
-- registered handler, {table, action, rows, remaining}: rows in the redacted state for this
-- match, remaining still matching (a request completes only when every remaining is 0).
-- Each class that is keyed by an order, a customer id or a customer digest registers its
-- handler here (and in redaction.ts and customer_handler_tables) in the pull request that
-- first writes it. None is registered yet.
CREATE FUNCTION morrow_work.customer_content_redact(p_org text,p_ws text,p_store_id text,p_match jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR NOT morrow_work.customer_match_valid(p_match) THEN
  RAISE EXCEPTION 'CUSTOMER_CONTENT_REDACT_INVALID';
 END IF;
 IF NOT (session_user='morrow_connector_ingress'
   AND pg_catalog.current_setting('morrow.connector_customer',true)=p_org||'|'||p_ws||'|'||p_store_id) THEN
  RAISE EXCEPTION 'CUSTOMER_CONTENT_REDACT_UNAVAILABLE';
 END IF;
 RETURN '[]'::jsonb;
END $$;

-- ---------------------------------------------------------------------------
-- The connector definers: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_connector_ingress only (work_executor_safe). Each takes ids only and overwrites
-- every connector setting on entry.
-- The applier of one recorded inbox row (0054), same signature, owner and ACL. The tenant,
-- installation and store come only from the row the broker recorded:
--   customers/redact  (SD3) the request's match, from the row's minimised body; under the
--     store's stop key, every registered customer-content handler of the store's tenant
--     (customer_content_redact, in the connector's customer redaction context for that store
--     alone). Completes "customer_redacted" (or "none_held" when no handler is registered, or
--     when no installation of the app holds the shop) only when every handler reports zero
--     remaining; otherwise the delivery stays received and its request open ('pending'), and
--     the cron re-drives it. A redelivery under another webhook id is redacted again: it is
--     idempotent, and each delivery has its own request;
--   customers/data_request  "none held", as 0037 (its listed orders stay on the inbox row's
--     clock);
--   app/scopes_update and every other topic  0054's, unchanged.
-- The command role owns it, so it is dropped (the schema owner may) and created again, with
-- its one grant and owner restored below, as 0056 did for runtime_operation_begin.
DROP FUNCTION morrow_work.connector_inbox_apply_v2(text);
CREATE FUNCTION morrow_work.connector_inbox_apply_v2(p_inbox_id text)
RETURNS TABLE(outcome text,topic text,installation_id text,credential text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE x record; r record; s record; h jsonb; v_body jsonb; v_match jsonb; v_content jsonb:='[]'::jsonb; v_handlers jsonb;
 v_outstanding jsonb; v_evidence jsonb; v_completed text; v_kind text;
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true),
  pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true),
  pg_catalog.set_config('morrow.connector_sweep','',true),pg_catalog.set_config('morrow.connector_customer','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_inbox_id IS NULL OR p_inbox_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO x FROM morrow_identity.work_shopify_inbox_take(p_inbox_id);
 IF x.outcome IS DISTINCT FROM 'found' THEN
  RETURN QUERY SELECT COALESCE(x.outcome,'not_found'),NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 -- SD3: customers/redact runs every registered customer-content handler.
 IF x.topic='customers/redact' THEN
  IF x.status<>'received' THEN RETURN QUERY SELECT 'settled'::text,x.topic,x.installation_id,NULL::text,NULL::text; RETURN; END IF;
  v_body:=x.body::jsonb;
  v_match:=morrow_work.customer_match_of(x.topic,v_body);
  IF v_match IS NULL THEN RAISE EXCEPTION 'CONNECTOR_CUSTOMER_MATCH_INVALID'; END IF;
  IF x.store_id IS NOT NULL THEN
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
    x.organization_id,x.workspace_id,x.store_id)::text,0));
   PERFORM pg_catalog.set_config('morrow.connector_customer',x.organization_id||'|'||x.workspace_id||'|'||x.store_id,true);
   v_content:=morrow_work.customer_content_redact(x.organization_id,x.workspace_id,x.store_id,v_match);
   PERFORM pg_catalog.set_config('morrow.connector_customer','',true);
  END IF;
  SELECT COALESCE(jsonb_agg(c-'remaining' ORDER BY c->>'table'),'[]'::jsonb),
   COALESCE(jsonb_agg(c->'table' ORDER BY c->>'table') FILTER (WHERE (c->>'remaining')::bigint>0),'[]'::jsonb)
   INTO v_handlers,v_outstanding FROM jsonb_array_elements(v_content) c;
  IF v_outstanding<>'[]'::jsonb THEN
   RETURN QUERY SELECT 'pending'::text,x.topic,x.installation_id,'none'::text,NULL::text; RETURN;
  END IF;
  v_kind:=CASE WHEN v_handlers='[]'::jsonb THEN 'none_held' ELSE 'customer_redacted' END;
  v_evidence:=jsonb_build_object('schemaVersion',1,'kind',v_kind,'scopes','["read_products","write_products"]'::jsonb,
   'handlers',v_handlers,'credential','none','outstanding','[]'::jsonb);
  v_completed:=CASE WHEN x.request_status IS NULL THEN 'not_found'
   ELSE morrow_identity.work_privacy_request_complete(x.organization_id,x.workspace_id,p_inbox_id,v_evidence) END;
  IF v_completed NOT IN ('completed','already_completed','not_found') THEN RAISE EXCEPTION 'CONNECTOR_PRIVACY_REFUSED'; END IF;
  IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'applied',v_kind,jsonb_build_object(
    'request',CASE WHEN v_completed='not_found' THEN 'none' ELSE 'completed' END,
    'orders',jsonb_array_length(v_match->'orders'),'handlers',jsonb_array_length(v_handlers)))
   NOT IN ('settled','already_settled') THEN RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED'; END IF;
  RETURN QUERY SELECT 'applied'::text,x.topic,x.installation_id,'none'::text,NULL::text; RETURN;
 END IF;
 IF x.topic<>'app/scopes_update' THEN
  SELECT * INTO r FROM morrow_work.connector_inbox_apply(p_inbox_id);
  IF r.outcome IN ('applied','pending') AND x.topic IN ('app/uninstalled','shop/redact') AND x.installation_id IS NOT NULL THEN
   PERFORM morrow_work.connection_health_reconcile(x.organization_id,x.workspace_id,x.installation_id,NULL);
  END IF;
  RETURN QUERY SELECT r.outcome,r.topic,r.installation_id,r.credential,r.reason; RETURN;
 END IF;
 IF x.status<>'received' THEN RETURN QUERY SELECT 'settled'::text,x.topic,x.installation_id,NULL::text,NULL::text; RETURN; END IF;
 IF x.installation_id IS NULL THEN
  IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'ignored','no_installation','{}'::jsonb) NOT IN ('settled','already_settled') THEN
   RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED';
  END IF;
  RETURN QUERY SELECT 'applied'::text,x.topic,NULL::text,'none'::text,NULL::text; RETURN;
 END IF;
 v_body:=x.body::jsonb;
 SELECT * INTO s FROM morrow_identity.work_shopify_scopes_record(x.organization_id,x.workspace_id,x.installation_id,'narrow',
  (v_body->'current')::text,NULL,NULL);
 IF s.outcome IS NULL OR s.outcome NOT IN ('applied','unchanged','ineligible') THEN RAISE EXCEPTION 'CONNECTOR_SCOPES_REFUSED'; END IF;
 IF s.outcome='ineligible' THEN
  IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'ignored','installation_ended',jsonb_build_object('installation',s.status))
   NOT IN ('settled','already_settled') THEN RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED'; END IF;
  RETURN QUERY SELECT 'applied'::text,x.topic,x.installation_id,'none'::text,NULL::text; RETURN;
 END IF;
 h:=morrow_work.connection_health_reconcile(x.organization_id,x.workspace_id,x.installation_id,p_inbox_id);
 IF h->>'outcome' IS DISTINCT FROM 'reconciled' THEN RAISE EXCEPTION 'CONNECTOR_RECONCILE_REFUSED'; END IF;
 IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'applied','scopes_recorded',jsonb_build_object(
   'scopes',CASE WHEN s.outcome='applied' THEN 'narrowed' ELSE 'unchanged' END,'notice',h->>'notice',
   'agents_stopped',(h->>'stopped')::integer,'agents_newly_stopped',(h->>'newly')::integer))
  NOT IN ('settled','already_settled') THEN RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED'; END IF;
 RETURN QUERY SELECT 'applied'::text,x.topic,x.installation_id,'none'::text,NULL::text;
END $$;
-- The connector's 7-day inbox purge (ADR-0031 item 1), across tenants, counts only: the
-- deliveries deleted and the expired ones kept for an open request or a pending apply.
CREATE FUNCTION morrow_work.connector_privacy_purge()
RETURNS TABLE(purged integer,held integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true),
  pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true),
  pg_catalog.set_config('morrow.connector_sweep','',true),pg_catalog.set_config('morrow.connector_customer','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN RETURN; END IF;
 RETURN QUERY SELECT p.purged,p.held FROM morrow_identity.work_shopify_inbox_purge() p;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.customer_match_valid(jsonb),morrow_work.customer_match_of(text,jsonb),
 morrow_work.customer_match_orders(jsonb),morrow_work.customer_content_redact(text,text,text,jsonb),
 morrow_work.connector_inbox_apply_v2(text),morrow_work.connector_privacy_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.customer_match_valid(jsonb),morrow_work.customer_match_of(text,jsonb),
 morrow_work.customer_match_orders(jsonb),morrow_work.customer_content_redact(text,text,text,jsonb) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_work.connector_inbox_apply_v2(text),morrow_work.connector_privacy_purge() TO morrow_connector_ingress;
GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_inbox_apply_v2(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_privacy_purge() OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;
COMMIT;
