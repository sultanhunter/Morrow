BEGIN;
-- SD3 (P09.T05b): keep the order ids a customer's privacy request lists, on the inbox row's
-- 7-day clock (docs/plan/store-data-foundation-implementation.md row SD3; ADR-0031's
-- 2026-10-26 note on item 1; ADR-0043 item 24; docs/briefs/sd3-keep-orders-to-redact.md).
-- Executes AS morrow_identity_owner, after 0056 (credits-only-catalogue); pull request 92
-- holds 0057, and the lead renumbers this pair at merge. It changes:
--   * shopify_webhook_body_valid (0036), same signature: a customers/redact body may also
--     carry ordersToRedact, and a customers/data_request body ordersRequested: each a list of
--     at most 20,000 distinct numeric order ids (shopify_order_list_valid). Order ids are not
--     customer data (CLAUDE.md); tied to a customer's request they are pseudonymous personal
--     data, so they live only here. Rows recorded before this migration keep 0036's shapes;
--     the broker records every new one with its list (apps/broker/src/shopify.ts);
--   * work_shopify_webhook_record (0053), same signature: a minimised body may be up to
--     512 KiB (was 4 KiB), the room a list of 20,000 ids needs; every other rule is 0053's;
--   * privacy_evidence_valid (0036), same signature: a customers/* request may complete
--     "customer_redacted", naming each registered customer-content handler (table, action,
--     rows) whose table customer_handler_tables() lists, as well as "none_held" with no
--     handler. shop/redact's evidence (and the 48-hour deletion's, which reads it) is 0036's;
--   * customer_handler_tables() (new): the closed list of tables registered on the customer
--     redaction matchers (packages/work/src/redaction.ts customerContentHandlers). None is
--     registered yet; the pull request that first writes a customer-keyed class replaces it;
--   * the inbox's 7-day clock (ADR-0031 item 1, "Webhook inbox receipts ... 7 days"): the
--     inbox gets its own guard, shopify_inbox_guard, with 0053's two inbox rules unchanged and
--     one more: a settled row past expires_at whose privacy request is not open may be
--     deleted. work_shopify_inbox_purge() deletes such rows (at most 500 a call) and counts
--     the expired rows it must keep: a delivery still received, or one whose request is open,
--     keeps its order ids until every handler has reported zero remaining.
-- The tenant always comes from the row the broker recorded; nothing here reads a caller's
-- tenant (invariant 1). Nothing here reaches the vault or a work table.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regclass('morrow_identity.shopify_webhook_inbox') IS NULL OR to_regclass('morrow_identity.privacy_requests') IS NULL
 OR to_regclass('morrow_identity.store_data_deletions') IS NULL
 OR to_regprocedure('morrow_identity.shopify_order_list_valid(jsonb)') IS NOT NULL
 OR to_regprocedure('morrow_identity.customer_handler_tables()') IS NOT NULL
 OR to_regprocedure('morrow_identity.shopify_inbox_guard()') IS NOT NULL
 OR to_regprocedure('morrow_identity.work_shopify_inbox_purge()') IS NOT NULL
 OR to_regprocedure('morrow_identity.store_deletion_evidence_valid(jsonb)') IS NULL
 -- The inbox's guard is still the shared one (0036, revised by 0053).
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='morrow_identity.shopify_webhook_inbox'::regclass
   AND t.tgname='shopify_record_guard' AND t.tgfoid=to_regprocedure('morrow_identity.shopify_preserve_record()'))
 -- The function texts this file replaces, exactly as 0036 and 0053 wrote them (a missed merge
 -- fails here).
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.shopify_webhook_body_valid(text,jsonb)'))
  IS DISTINCT FROM 'e66d2c639d4e0c7dce9a5b0be466a74a'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('morrow_identity.work_shopify_webhook_record(text,text,text,text,text,text)'))
  IS DISTINCT FROM '2e44c361838f06979503c695786fbac7'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.privacy_evidence_valid(text,jsonb)'))
  IS DISTINCT FROM '4b0a2f8325b4a94190fc82e51b9c2137'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.shopify_preserve_record()'))
  IS DISTINCT FROM 'd20ef259c112b34c80efcd0f7e7095fe'
 THEN RAISE EXCEPTION 'CUSTOMER_DELETION_IDENTITY_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pure functions (IMMUTABLE, owned by the identity owner, granted to nobody): the CHECKs and
-- guards call them as the identity owner, the only writer of these tables.
-- The order ids one compliance request lists, as the inbox keeps them: at most 20,000
-- distinct numeric ids, each as text (apps/broker/src/shopify.ts shopifyComplianceOrdersMax).
CREATE FUNCTION morrow_identity.shopify_order_list_valid(p_list jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_list IS NULL OR jsonb_typeof(p_list)<>'array' OR jsonb_array_length(p_list)>20000 THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_list) e WHERE jsonb_typeof(e)<>'string' OR (e#>>'{}') !~ '^[1-9][0-9]{0,19}$')
  AND (SELECT count(DISTINCT e#>>'{}') FROM jsonb_array_elements(p_list) e)=jsonb_array_length(p_list);
END $$;
-- The tables registered on the customer redaction matchers (packages/work/src/redaction.ts
-- customerContentHandlers; S8 keeps the two lists equal). A customers/* request's evidence
-- may name only these. Empty until the first customer-keyed class: the pull request that
-- first writes one replaces this function in the same change (ADR-0031 item 4, G9).
CREATE FUNCTION morrow_identity.customer_handler_tables() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT '{}'::text[]
$$;
-- The minimised body of one topic (0036), with SD3's order lists: closed key sets of ids,
-- scope names, a keyed customer digest and the order ids a customers/* request lists, never
-- an email, phone, name or address. A customers/* row recorded before SD3 has no order list.
CREATE OR REPLACE FUNCTION morrow_identity.shopify_webhook_body_valid(p_topic text,p_body jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE v_keys text[];
BEGIN
 IF p_topic IS NULL OR p_body IS NULL OR jsonb_typeof(p_body)<>'object' THEN RETURN false; END IF;
 SELECT COALESCE(array_agg(k ORDER BY k),'{}') INTO v_keys FROM jsonb_object_keys(p_body) k;
 IF p_topic='app/scopes_update' THEN
  RETURN v_keys=ARRAY['current','previous']
   AND morrow_identity.shopify_scope_list_valid(p_body->'previous') AND morrow_identity.shopify_scope_list_valid(p_body->'current');
 END IF;
 IF NOT ('shopId'=ANY(v_keys)) OR jsonb_typeof(p_body->'shopId')<>'string' OR (p_body->>'shopId') !~ '^[1-9][0-9]{0,19}$' THEN
  RETURN false;
 END IF;
 IF p_topic IN ('app/uninstalled','shop/redact') THEN RETURN v_keys=ARRAY['shopId']; END IF;
 IF p_topic NOT IN ('customers/data_request','customers/redact') THEN RETURN false; END IF;
 IF NOT ('customerDigest'=ANY(v_keys)) OR NOT (p_body->'customerDigest'='null'::jsonb
   OR (jsonb_typeof(p_body->'customerDigest')='string' AND (p_body->>'customerDigest') ~ '^[a-f0-9]{64}$')) THEN
  RETURN false;
 END IF;
 IF p_topic='customers/redact' THEN
  RETURN v_keys=ARRAY['customerDigest','shopId']
   OR (v_keys=ARRAY['customerDigest','ordersToRedact','shopId'] AND morrow_identity.shopify_order_list_valid(p_body->'ordersToRedact'));
 END IF;
 RETURN (v_keys=ARRAY['customerDigest','dataRequestId','shopId']
   OR (v_keys=ARRAY['customerDigest','dataRequestId','ordersRequested','shopId']
    AND morrow_identity.shopify_order_list_valid(p_body->'ordersRequested')))
  AND jsonb_typeof(p_body->'dataRequestId')='string' AND (p_body->>'dataRequestId') ~ '^[1-9][0-9]{0,19}$';
END $$;
-- Completion evidence of one privacy request (0036), content-free and closed:
--   {schemaVersion 1, kind, scopes, handlers [{table, action, rows}], credential, outstanding}
-- shop/redact (and through store_deletion_evidence_valid the 48-hour deletion) as 0036: the
-- closed store-content handler list. customers/* (SD3): "none_held" with no handler, or
-- "customer_redacted" naming at least one handler whose table customer_handler_tables()
-- lists, each with its declared action; never a credential. outstanding is always empty: a
-- request never completes while anything it matched remains.
CREATE OR REPLACE FUNCTION morrow_identity.privacy_evidence_valid(p_topic text,p_evidence jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE v_keys text[];
BEGIN
 IF p_topic IS NULL OR p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object' THEN RETURN false; END IF;
 SELECT COALESCE(array_agg(k ORDER BY k),'{}') INTO v_keys FROM jsonb_object_keys(p_evidence) k;
 IF v_keys<>ARRAY['credential','handlers','kind','outstanding','schemaVersion','scopes'] OR p_evidence->'schemaVersion'<>'1'::jsonb
  OR p_evidence->'outstanding'<>'[]'::jsonb OR jsonb_typeof(p_evidence->'kind')<>'string'
  OR jsonb_typeof(p_evidence->'credential')<>'string' OR (p_evidence->>'credential') NOT IN ('destroyed','already_destroyed','none')
  OR jsonb_typeof(p_evidence->'scopes')<>'array' OR jsonb_array_length(p_evidence->'scopes')>8
  OR jsonb_typeof(p_evidence->'handlers')<>'array' OR jsonb_array_length(p_evidence->'handlers')>16 THEN
  RETURN false;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'scopes') s WHERE jsonb_typeof(s)<>'string'
   OR (s#>>'{}') NOT IN ('read_products','write_products')) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'handlers') h WHERE jsonb_typeof(h)<>'object'
   OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(h) k)<>ARRAY['action','rows','table']
   OR jsonb_typeof(h->'table')<>'string' OR jsonb_typeof(h->'action')<>'string'
   OR jsonb_typeof(h->'rows')<>'number' OR (h->>'rows') !~ '^(0|[1-9][0-9]{0,8})$') THEN RETURN false; END IF;
 IF p_topic IN ('customers/data_request','customers/redact') THEN
  IF p_evidence->>'credential'<>'none' THEN RETURN false; END IF;
  IF p_evidence->>'kind'='none_held' THEN RETURN p_evidence->'handlers'='[]'::jsonb; END IF;
  RETURN p_topic='customers/redact' AND p_evidence->>'kind'='customer_redacted' AND jsonb_array_length(p_evidence->'handlers')>0
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'handlers') h
    WHERE NOT ((h->>'table')=ANY(morrow_identity.customer_handler_tables()))
     OR (h->>'action') NOT IN ('delete_rows','blank_order_id','empty_keep_digest','erase_keep_digest'));
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_evidence->'handlers') h
   WHERE (h->>'table') NOT IN ('morrow_vault.credentials','morrow_identity.linking_candidates',
    'morrow_identity.shopify_apps','morrow_identity.store_installations','morrow_work.proposal_parameters',
    'morrow_work.product_snapshots','morrow_work.run_drafts')
   OR (h->>'action') NOT IN ('destroy_credential','empty_keep_digest','delete_rows','pseudonymise','clear_install_link')) THEN
  RETURN false;
 END IF;
 IF p_topic='shop/redact' THEN
  RETURN (p_evidence->>'kind'='shop_redacted' AND p_evidence->>'credential'<>'none')
   OR (p_evidence->>'kind'='none_held' AND p_evidence->'handlers'='[]'::jsonb AND p_evidence->>'credential'='none');
 END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.shopify_order_list_valid(jsonb),morrow_identity.customer_handler_tables() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The inbox's 7-day clock (ADR-0031 item 1). Its own guard (INVOKER, owned by the identity
-- owner, granted to nobody) in place of the shared shopify_preserve_record for its row
-- trigger: 0053's two inbox rules unchanged (born received; one change, received -> applied
-- or ignored with its effects), and the one deletion: a settled row past expires_at whose
-- privacy request is not open. A delivery still received, or one whose request is open, is
-- never deleted, so a request keeps its order ids until every handler reports zero
-- remaining. TRUNCATE stays refused by the shared function's statement trigger.
CREATE FUNCTION morrow_identity.shopify_inbox_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME<>'shopify_webhook_inbox' THEN RAISE EXCEPTION 'SHOPIFY_RECORD_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status='received' AND NEW.settled_at IS NULL AND NEW.outcome IS NULL AND NEW.effects IS NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'SHOPIFY_RECORD_INVALID';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.status='received' AND NEW.status IN ('applied','ignored') AND NEW.settled_at IS NOT NULL AND NEW.outcome IS NOT NULL
   AND NEW.effects IS NOT NULL
   AND (to_jsonb(NEW)-ARRAY['status','settled_at','outcome','effects'])=(to_jsonb(OLD)-ARRAY['status','settled_at','outcome','effects']) THEN RETURN NEW; END IF;
 END IF;
 IF TG_OP='DELETE' AND OLD.status IN ('applied','ignored') AND OLD.expires_at<=pg_catalog.clock_timestamp()
  AND NOT EXISTS(SELECT 1 FROM morrow_identity.privacy_requests r WHERE r.organization_id=OLD.organization_id
   AND r.workspace_id=OLD.workspace_id AND r.inbox_id=OLD.id::text AND r.status='open') THEN
  RETURN OLD;
 END IF;
 RAISE EXCEPTION 'SHOPIFY_RECORD_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION morrow_identity.shopify_inbox_guard() FROM PUBLIC;
DROP TRIGGER shopify_record_guard ON morrow_identity.shopify_webhook_inbox;
CREATE TRIGGER shopify_record_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_identity.shopify_webhook_inbox
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.shopify_inbox_guard();
CREATE INDEX shopify_webhook_inbox_expires ON morrow_identity.shopify_webhook_inbox (expires_at,id);

-- ---------------------------------------------------------------------------
-- The identity bridges: definers owned by the identity owner, EXECUTE for
-- morrow_work_command only (0059's connector definers call them).
-- The webhook record (0053), same signature, owner and ACL, with one change: a minimised
-- body may be up to 512 KiB, for a request's list of up to 20,000 order ids (SD3). Every
-- other rule is 0053's.
CREATE OR REPLACE FUNCTION morrow_identity.work_shopify_webhook_record(p_app_key text,p_shop_domain text,p_topic text,p_webhook_id text,
 p_api_version text,p_body text)
RETURNS TABLE(outcome text,inbox_id text,settled text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE a morrow_identity.shopify_apps%ROWTYPE; v_body jsonb; v_digest text; v_installation text; v_id text; v_at timestamptz;
 v_existing record; n integer;
BEGIN
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$'
  OR p_shop_domain IS NULL OR length(p_shop_domain)>255 OR p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
  OR p_topic IS NULL OR p_topic NOT IN ('app/uninstalled','app/scopes_update','customers/data_request','customers/redact','shop/redact')
  OR p_webhook_id IS NULL OR p_webhook_id !~ '^[A-Za-z0-9-]{1,128}$'
  OR p_api_version IS NULL OR p_api_version !~ '^([0-9]{4}-[0-9]{2}|unstable)$'
  OR p_body IS NULL OR octet_length(p_body)>524288 OR NOT pg_input_is_valid(p_body,'jsonb') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_body:=p_body::jsonb;
 IF NOT morrow_identity.shopify_webhook_body_valid(p_topic,v_body) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_digest:=encode(sha256(convert_to(p_shop_domain,'UTF8')),'hex');
 SELECT * INTO a FROM morrow_identity.shopify_apps x WHERE x.app_key=p_app_key AND x.intended_shop_digest=v_digest;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_topic='app/scopes_update' THEN
  SELECT x.id::text INTO v_installation FROM morrow_identity.store_installations x
   WHERE x.app_key=p_app_key AND x.shop_domain=p_shop_domain AND x.redacted_at IS NULL
   ORDER BY (x.status='uninstalled'),x.created_at DESC,x.id LIMIT 1;
 ELSIF p_topic='shop/redact' THEN
  SELECT x.id::text INTO v_installation FROM morrow_identity.store_installations x
   WHERE x.app_key=p_app_key AND x.shop_id=v_body->>'shopId' AND (x.shop_domain=p_shop_domain OR x.redacted_at IS NOT NULL)
   ORDER BY CASE WHEN x.status='uninstalled' AND x.redacted_at IS NULL THEN 0 WHEN x.status='uninstalled' THEN 1 ELSE 2 END,
    x.uninstalled_at DESC NULLS LAST,x.created_at DESC,x.id LIMIT 1;
 ELSE
  SELECT x.id::text INTO v_installation FROM morrow_identity.store_installations x
   WHERE x.app_key=p_app_key AND x.shop_id=v_body->>'shopId' AND (x.shop_domain=p_shop_domain OR x.redacted_at IS NOT NULL)
   ORDER BY (x.status='uninstalled'),x.created_at DESC,x.id LIMIT 1;
 END IF;
 v_at:=date_trunc('milliseconds',clock_timestamp());
 v_id:=gen_random_uuid()::text;
 INSERT INTO morrow_identity.shopify_webhook_inbox(id,app_key,organization_id,workspace_id,shop_digest,installation_id,topic,webhook_id,
  api_version,body,received_at,expires_at,status,settled_at,outcome,effects)
 VALUES (v_id,p_app_key,a.invited_organization_id,a.invited_workspace_id,v_digest,v_installation,p_topic,p_webhook_id,p_api_version,v_body,
  v_at,v_at+interval '7 days','received',NULL,NULL,NULL)
 ON CONFLICT (app_key,shop_digest,webhook_id) DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n=0 THEN
  SELECT x.id::text AS id,x.status INTO v_existing FROM morrow_identity.shopify_webhook_inbox x
   WHERE x.app_key=p_app_key AND x.shop_digest=v_digest AND x.webhook_id=p_webhook_id;
  RETURN QUERY SELECT 'duplicate'::text,v_existing.id,(v_existing.status<>'received')::text; RETURN;
 END IF;
 IF p_topic IN ('customers/data_request','customers/redact','shop/redact') THEN
  INSERT INTO morrow_identity.privacy_requests(organization_id,workspace_id,id,app_key,installation_id,inbox_id,webhook_id,topic,shop_id,
   data_request_id,received_at,target_at,due_at,status,completed_at,evidence,evidence_digest)
  VALUES (a.invited_organization_id,a.invited_workspace_id,gen_random_uuid()::text,p_app_key,v_installation,v_id,p_webhook_id,p_topic,
   v_body->>'shopId',CASE WHEN p_topic='customers/data_request' THEN v_body->>'dataRequestId' END,v_at,
   v_at+CASE WHEN p_topic='shop/redact' THEN interval '24 hours' ELSE interval '0' END,v_at+interval '30 days','open',NULL,NULL,NULL)
  ON CONFLICT DO NOTHING;
 END IF;
 RETURN QUERY SELECT 'recorded'::text,v_id,'false'::text;
END $$;
-- The inbox's 7-day purge (ADR-0031 item 1), across tenants, counts only: deletes at most
-- 500 settled rows past expires_at whose privacy request is not open (oldest first; the
-- guard checks the same rule again for each row), and counts the expired rows it must keep
-- (still received, or with an open request), which the connector's cron logs. The identity
-- owner's own policy, never BYPASSRLS.
CREATE FUNCTION morrow_identity.work_shopify_inbox_purge()
RETURNS TABLE(purged integer,held integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE n integer; h integer;
BEGIN
 DELETE FROM morrow_identity.shopify_webhook_inbox x WHERE x.id IN (
  SELECT d.id FROM morrow_identity.shopify_webhook_inbox d
  WHERE d.status IN ('applied','ignored') AND d.expires_at<=pg_catalog.clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM morrow_identity.privacy_requests r WHERE r.organization_id=d.organization_id
    AND r.workspace_id=d.workspace_id AND r.inbox_id=d.id::text AND r.status='open')
  ORDER BY d.expires_at,d.id LIMIT 500 FOR UPDATE SKIP LOCKED);
 GET DIAGNOSTICS n=ROW_COUNT;
 SELECT count(*)::integer INTO h FROM morrow_identity.shopify_webhook_inbox x WHERE x.expires_at<=pg_catalog.clock_timestamp();
 RETURN QUERY SELECT n,h;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.work_shopify_inbox_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_shopify_inbox_purge() TO morrow_work_command;
COMMIT;
