BEGIN;
-- SD3 (P09.T05b) and SD4 (P09.T05c): the customer-data deletion base, the work and vault side
-- (docs/plan/store-data-foundation-implementation.md rows SD3 and SD4; ADR-0031 items 1 to 4
-- and its 2026-10-26 note on item 1; ADR-0042 items 5, 15 and 24; ADR-0043 item 24;
-- docs/briefs/sd3-keep-orders-to-redact.md and docs/packets/P09.T05c.md). Executes AS
-- morrow_work_owner, after customer-deletion-identity (0059). It adds:
--   * the redaction matcher (customer_match_of, customer_match_valid, customer_match_orders,
--     customer_match_digests): one customers/* request's match, read only from the inbox row the
--     broker recorded (0059), never from a caller: the order ids it lists (SD3), and the keyed
--     digests of the customer id, email and phone under every kept version of the workspace's
--     digest key (SD4). Pure, IMMUTABLE, EXECUTE for the command role, so a registered class's
--     handlers and policies can call them;
--   * the workspace's customer digest keys in the broker vault (SD4; ADR-0031 item 3, ADR-0042
--     item 5): morrow_vault.customer_digest_keys, one row per kept version (never rotated
--     away, destroyed only at workspace erasure), sealed by the broker under its KEK, read and
--     created only by the broker's two vault definers, for the workspace an app invites;
--   * the registration surface, two revisable owner helpers (INVOKER, owned by the owner,
--     EXECUTE for the command role) that run every registered customer-content class for one
--     store, only in the connector's customer redaction context for exactly that store
--     (morrow.connector_customer, which only the applier writes, and clears):
--     customer_content_redact (each class's {table, action, rows, remaining}) and
--     customer_content_export (each class's {table, rows: [...]}, for a data request). A later
--     class registers by replacing both (and morrow_identity.customer_handler_tables) in the
--     pull request that first writes it (ADR-0031 item 4, G9); S8 fails a keyed or customer
--     table without its handler;
--   * the customers/data_request export to the Owner (SD4; ADR-0031 item 4):
--     customer_data_exports, content: customer, the first registered class. One row per
--     delivery whose request matched rows: the rows each class exported, the Owner it is for,
--     the request's match keys (so a later customers/redact finds it), 30 days from delivery
--     (ADR-0031 item 1). Erased in place (content and keys emptied, the digest of the document
--     kept) by customers/redact (customer_data_exports_redact), by shop/redact and the 48-hour
--     deletion (store_content_redact, revised), and on its clock by the clean-up job. The Owner
--     reads it through customer_data_exports_open() (session only);
--   * connector_inbox_apply_v2 (0054), same signature, owner and ACL (dropped and created again):
--     customers/redact runs customer_content_redact and customers/data_request
--     customer_content_export, each under the store's stop key held exclusively, and each
--     request completes only when every handler reports zero remaining; otherwise the delivery
--     stays received, the cron re-drives it, and its inbox row outlives its 7 days. Every other
--     topic is 0054's, unchanged;
--   * connector_privacy_purge(): the clean-up job's 7-day inbox purge (0059) and the data
--     request exports past their 30 days, each erased under its own tenant's context; run only
--     while the connection clean-up switch is on (docs/decisions/connection-cleanup-staging.json).
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regprocedure('morrow_work.connector_inbox_apply(text)') IS NULL
 OR to_regprocedure('morrow_work.connection_health_reconcile(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.utc_text(timestamp with time zone)') IS NULL OR to_regprocedure('morrow_work.append_only()') IS NULL
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL
 OR to_regprocedure('morrow_work.customer_content_redact(text,text,text,jsonb)') IS NOT NULL
 OR to_regprocedure('morrow_work.connector_privacy_purge()') IS NOT NULL
 OR to_regclass('morrow_work.customer_data_exports') IS NOT NULL OR to_regclass('morrow_vault.customer_digest_keys') IS NOT NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_purge()','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_app_tenant(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_health_target(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_take(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_settle(text,text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_privacy_request_complete(text,text,text,jsonb)','EXECUTE')
 OR to_regprocedure('morrow_identity.customer_handler_tables()') IS NULL
 -- The function texts this file replaces, exactly as 0038 and 0054 wrote them (a missed merge
 -- fails here).
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_work.connector_inbox_apply_v2(text)'))
  IS DISTINCT FROM 'b4f5f7ea0c5fdb65ac1cdb7e32770c1a'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_work.store_content_redact(text,text,text)'))
  IS DISTINCT FROM 'c0abcbecb464022cfc4bfdfafa9c5b62'
 THEN RAISE EXCEPTION 'CUSTOMER_DELETION_WORK_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The redaction matcher. Pure functions: IMMUTABLE, owned by the owner; the command role
-- holds EXECUTE (the 0015 valid_scope pattern), so a registered class's definers, CHECKs and
-- policies may call them.
-- The match document of one customers/* request:
--   {"orders": [ids], "customerIds": [digests], "emails": [digests], "phones": [digests]}
-- at most 20,000 distinct numeric order ids as text, and at most 8 distinct keyed digests (64
-- hex characters) of each kind, one per kept version of the workspace's digest key.
CREATE FUNCTION morrow_work.customer_match_valid(p_match jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_keys text[]; k text;
BEGIN
 IF p_match IS NULL OR jsonb_typeof(p_match)<>'object' THEN RETURN false; END IF;
 SELECT COALESCE(array_agg(x ORDER BY x),'{}') INTO v_keys FROM jsonb_object_keys(p_match) x;
 IF v_keys<>ARRAY['customerIds','emails','orders','phones'] OR jsonb_typeof(p_match->'orders')<>'array'
  OR jsonb_array_length(p_match->'orders')>20000 THEN
  RETURN false;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_match->'orders') e WHERE jsonb_typeof(e)<>'string' OR (e#>>'{}') !~ '^[1-9][0-9]{0,19}$')
  OR (SELECT count(DISTINCT e#>>'{}') FROM jsonb_array_elements(p_match->'orders') e)<>jsonb_array_length(p_match->'orders') THEN
  RETURN false;
 END IF;
 FOREACH k IN ARRAY ARRAY['customerIds','emails','phones'] LOOP
  IF jsonb_typeof(p_match->k)<>'array' OR jsonb_array_length(p_match->k)>8
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_match->k) e WHERE jsonb_typeof(e)<>'string' OR (e#>>'{}') !~ '^[a-f0-9]{64}$')
   OR (SELECT count(DISTINCT e#>>'{}') FROM jsonb_array_elements(p_match->k) e)<>jsonb_array_length(p_match->k) THEN
   RETURN false;
  END IF;
 END LOOP;
 RETURN true;
END $$;
-- The match of one inbox row's minimised body (0059's shapes): the order ids its request lists
-- (ordersToRedact or ordersRequested), and every non-null digest of its customerDigests, by
-- kind. A row recorded before this migration (0036's shape) matches nothing: Morrow held no
-- customer data then. NULL for any other topic or an invalid body.
CREATE FUNCTION morrow_work.customer_match_of(p_topic text,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_digests jsonb; v_match jsonb;
BEGIN
 IF p_topic IS NULL OR p_topic NOT IN ('customers/data_request','customers/redact') OR p_body IS NULL
  OR jsonb_typeof(p_body)<>'object' THEN
  RETURN NULL;
 END IF;
 v_digests:=CASE WHEN jsonb_typeof(p_body->'customerDigests')='array' THEN p_body->'customerDigests' ELSE '[]'::jsonb END;
 SELECT jsonb_build_object(
   'orders',COALESCE(p_body->CASE p_topic WHEN 'customers/redact' THEN 'ordersToRedact' ELSE 'ordersRequested' END,'[]'::jsonb),
   'customerIds',COALESCE(jsonb_agg(DISTINCT d->'id') FILTER (WHERE jsonb_typeof(d->'id')='string'),'[]'::jsonb),
   'emails',COALESCE(jsonb_agg(DISTINCT d->'email') FILTER (WHERE jsonb_typeof(d->'email')='string'),'[]'::jsonb),
   'phones',COALESCE(jsonb_agg(DISTINCT d->'phone') FILTER (WHERE jsonb_typeof(d->'phone')='string'),'[]'::jsonb))
  INTO v_match FROM jsonb_array_elements(v_digests) d;
 RETURN CASE WHEN morrow_work.customer_match_valid(v_match) THEN v_match END;
END $$;
-- The listed orders of a valid match, as an array a handler compares its order ids with
-- (`order_id = ANY(...)`). NULL for an invalid match, which matches nothing.
CREATE FUNCTION morrow_work.customer_match_orders(p_match jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT CASE WHEN morrow_work.customer_match_valid(p_match)
  THEN (SELECT COALESCE(array_agg(e ORDER BY e),'{}') FROM jsonb_array_elements_text(p_match->'orders') e) END
$$;
-- The keyed digests of one kind (customer_id, email or phone) of a valid match, as an array a
-- handler compares its stored digests with. NULL for an invalid match or kind.
CREATE FUNCTION morrow_work.customer_match_digests(p_match jsonb,p_kind text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT CASE WHEN morrow_work.customer_match_valid(p_match) AND p_kind IN ('customer_id','email','phone')
  THEN (SELECT COALESCE(array_agg(e ORDER BY e),'{}') FROM jsonb_array_elements_text(p_match->
   CASE p_kind WHEN 'customer_id' THEN 'customerIds' WHEN 'email' THEN 'emails' ELSE 'phones' END) e) END
$$;

-- ---------------------------------------------------------------------------
-- The workspace's customer digest keys (SD4; ADR-0031 item 3; ADR-0042 items 5 and 24): one row
-- per version, born active at the next contiguous version, every version kept for the
-- workspace's life (a request is matched under each); the only change erases the key material
-- (workspace erasure, governance.privacy.erase, which lands with its own record). The material
-- is 32 random bytes sealed by the broker (apps/broker/src/customer-digest.ts) under its KEK,
-- with the tenant and version in its additional data; only the broker's login reaches a row,
-- through the two definers below.
CREATE TABLE morrow_vault.customer_digest_keys (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 8),
 status text NOT NULL CHECK (status IN ('active','destroyed')),
 kek_version integer NOT NULL CHECK (kek_version BETWEEN 1 AND 999),
 wrapped_key bytea CHECK (octet_length(wrapped_key)=60),
 sealed_value bytea CHECK (octet_length(sealed_value)=60),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 destroyed_at timestamptz CHECK (destroyed_at=date_trunc('milliseconds',destroyed_at) AND isfinite(destroyed_at)),
 PRIMARY KEY (organization_id,workspace_id,version),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CONSTRAINT customer_digest_keys_material CHECK ((status='active')=(wrapped_key IS NOT NULL) AND (wrapped_key IS NULL)=(sealed_value IS NULL)
  AND (status='active')=(destroyed_at IS NULL) AND (destroyed_at IS NULL OR destroyed_at>=created_at))
);
-- The key guard (INVOKER, owned by the owner, granted to nobody): born active at the next
-- contiguous version; the one update erases the material; no delete or truncate.
CREATE FUNCTION morrow_vault.customer_digest_key_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
DECLARE v_previous integer;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT max(k.version) INTO v_previous FROM morrow_vault.customer_digest_keys k
   WHERE k.organization_id=NEW.organization_id AND k.workspace_id=NEW.workspace_id;
  IF NEW.status='active' AND NEW.destroyed_at IS NULL AND NEW.version=COALESCE(v_previous,0)+1 THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'VAULT_RECORD_INVALID';
 END IF;
 IF TG_OP='UPDATE' AND OLD.status='active' AND NEW.status='destroyed' AND NEW.wrapped_key IS NULL AND NEW.sealed_value IS NULL
  AND (to_jsonb(NEW)-ARRAY['status','wrapped_key','sealed_value','destroyed_at'])
   =(to_jsonb(OLD)-ARRAY['status','wrapped_key','sealed_value','destroyed_at']) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'VAULT_RECORD_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION morrow_vault.customer_digest_key_guard() FROM PUBLIC;
CREATE TRIGGER vault_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_vault.customer_digest_keys
 FOR EACH ROW EXECUTE FUNCTION morrow_vault.customer_digest_key_guard();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_vault.customer_digest_keys
 FOR EACH STATEMENT EXECUTE FUNCTION morrow_vault.customer_digest_key_guard();
ALTER TABLE morrow_vault.customer_digest_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_vault.customer_digest_keys FORCE ROW LEVEL SECURITY;
REVOKE ALL ON morrow_vault.customer_digest_keys FROM PUBLIC;
CREATE POLICY work_owner ON morrow_vault.customer_digest_keys TO morrow_work_owner USING (true) WITH CHECK (true);
CREATE POLICY vault_broker ON morrow_vault.customer_digest_keys TO morrow_work_command
 USING (session_user='morrow_vault_broker') WITH CHECK (session_user='morrow_vault_broker');
GRANT SELECT,INSERT ON morrow_vault.customer_digest_keys TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- The customers/data_request export to the Owner (SD4; ADR-0031 items 1 and 4): customer data
-- (content: customer), one row per delivery whose request matched rows of a registered class.
-- `document` holds what each class exported ({schemaVersion 1, dataRequestId, classes
-- [{table, rows [...]}]}), for the Owner (`recipient_principal_id`, the organization's founding
-- principal when it was written) only. The request's match keys are kept beside it so a later
-- customers/redact of the same customer finds it. 30 days from delivery; erased in place, never
-- deleted (no runtime role holds DELETE): the document and the keys emptied, its digest, ids,
-- counts and times kept.
CREATE FUNCTION morrow_work.customer_export_document_valid(p_document jsonb,p_rows integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_document IS NULL OR jsonb_typeof(p_document)<>'object'
  OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_document) k)<>ARRAY['classes','dataRequestId','schemaVersion']
  OR p_document->'schemaVersion'<>'1'::jsonb OR jsonb_typeof(p_document->'dataRequestId')<>'string'
  OR (p_document->>'dataRequestId') !~ '^[1-9][0-9]{0,19}$'
  OR jsonb_typeof(p_document->'classes')<>'array' OR jsonb_array_length(p_document->'classes') NOT BETWEEN 1 AND 64 THEN
  RETURN false;
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_document->'classes') c WHERE jsonb_typeof(c)<>'object'
   OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(c) k)<>ARRAY['rows','table']
   OR jsonb_typeof(c->'table')<>'string' OR (c->>'table') !~ '^morrow_[a-z]+\.[a-z][a-z0-9_]{1,62}$'
   OR jsonb_typeof(c->'rows')<>'array' OR jsonb_array_length(c->'rows')<1
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(c->'rows') r WHERE jsonb_typeof(r)<>'object')) THEN
  RETURN false;
 END IF;
 RETURN (SELECT sum(jsonb_array_length(c->'rows')) FROM jsonb_array_elements(p_document->'classes') c)=p_rows;
END $$;
CREATE FUNCTION morrow_work.customer_digest_list_valid(p_list text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_list IS NOT NULL AND cardinality(p_list)<=8 AND array_position(p_list,NULL) IS NULL
  AND NOT EXISTS(SELECT 1 FROM unnest(p_list) d WHERE d !~ '^[a-f0-9]{64}$')
$$;
CREATE TABLE morrow_work.customer_data_exports (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 store_id morrow_work.record_id NOT NULL,
 inbox_id text NOT NULL UNIQUE CHECK (inbox_id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 data_request_id text NOT NULL CHECK (data_request_id ~ '^[1-9][0-9]{0,19}$'),
 recipient_principal_id morrow_work.record_id NOT NULL,
 rows integer NOT NULL CHECK (rows BETWEEN 1 AND 100000),
 document jsonb,
 document_digest text NOT NULL CHECK (document_digest ~ '^[a-f0-9]{64}$'),
 order_ids text[] NOT NULL CHECK (cardinality(order_ids)<=20000 AND array_position(order_ids,NULL) IS NULL),
 customer_id_digests text[] NOT NULL CHECK (morrow_work.customer_digest_list_valid(customer_id_digests)),
 email_digests text[] NOT NULL CHECK (morrow_work.customer_digest_list_valid(email_digests)),
 phone_digests text[] NOT NULL CHECK (morrow_work.customer_digest_list_valid(phone_digests)),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 expires_at timestamptz NOT NULL,
 erased_at timestamptz CHECK (erased_at=date_trunc('milliseconds',erased_at) AND isfinite(erased_at)),
 erased_reason text CHECK (erased_reason IN ('customer_redact','shop_redact','expired')),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CHECK (expires_at=created_at+interval '30 days'),
 CHECK ((erased_at IS NULL)=(erased_reason IS NULL) AND (erased_at IS NULL)=(document IS NOT NULL)
  AND (erased_at IS NULL OR erased_at>=created_at)
  AND (document IS NULL OR (morrow_work.customer_export_document_valid(document,rows)
   AND document_digest=encode(sha256(convert_to(document::text,'UTF8')),'hex')))
  AND (erased_at IS NULL OR (order_ids='{}' AND customer_id_digests='{}' AND email_digests='{}' AND phone_digests='{}')))
);
CREATE INDEX customer_data_exports_open ON morrow_work.customer_data_exports (expires_at,id) WHERE erased_at IS NULL;
CREATE INDEX customer_data_exports_store ON morrow_work.customer_data_exports (organization_id,workspace_id,store_id)
 WHERE erased_at IS NULL;
-- The export guard (INVOKER, owned by the owner, granted to nobody): born unerased; one change,
-- the erasure (document and keys emptied, its time and reason set), then never again.
CREATE FUNCTION morrow_work.customer_export_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['document','order_ids','customer_id_digests','email_digests','phone_digests','erased_at','erased_reason'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.erased_at IS NULL AND NEW.erased_reason IS NULL AND NEW.document IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'WORK_EXPORT_INVALID';
 END IF;
 IF TG_OP='UPDATE' AND OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL AND NEW.document IS NULL
  AND (to_jsonb(NEW)-v_mutable)=(to_jsonb(OLD)-v_mutable) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'WORK_EXPORT_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION morrow_work.customer_export_guard() FROM PUBLIC;
CREATE TRIGGER customer_export_guard BEFORE INSERT OR UPDATE ON morrow_work.customer_data_exports
 FOR EACH ROW EXECUTE FUNCTION morrow_work.customer_export_guard();
CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.customer_data_exports FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.customer_data_exports FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only();
ALTER TABLE morrow_work.customer_data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_work.customer_data_exports FORCE ROW LEVEL SECURITY;
REVOKE ALL ON morrow_work.customer_data_exports FROM PUBLIC;
CREATE POLICY work_owner ON morrow_work.customer_data_exports TO morrow_work_owner USING (true) WITH CHECK (true);
-- The session template, read only: the Owner's read definer (customer_data_exports_open). No
-- session definer writes an export.
CREATE POLICY tenant_command ON morrow_work.customer_data_exports FOR SELECT TO morrow_work_command
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
-- The connector's customer redaction context (morrow.connector_customer names exactly one
-- org|ws|store; only connector_inbox_apply_v2 writes it, from the inbox row the broker recorded,
-- and clears it): a data request writes its export, and customers/redact erases the matching
-- ones. The connector login holds no table privilege, so a setting it forges reaches nothing.
CREATE POLICY connector_export_customer_read ON morrow_work.customer_data_exports FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_customer',true));
CREATE POLICY connector_export_write ON morrow_work.customer_data_exports FOR INSERT TO morrow_work_command
 WITH CHECK (session_user='morrow_connector_ingress' AND erased_at IS NULL
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_customer',true));
CREATE POLICY connector_export_customer_erase ON morrow_work.customer_data_exports FOR UPDATE TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_customer',true))
 WITH CHECK (session_user='morrow_connector_ingress' AND erased_reason='customer_redact'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_customer',true));
-- shop/redact and the 48-hour deletion (the connector's redaction context, 0037): the store's
-- exports are erased with the rest of its content.
CREATE POLICY connector_export_redact_read ON morrow_work.customer_data_exports FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_redact',true));
CREATE POLICY connector_export_redact_erase ON morrow_work.customer_data_exports FOR UPDATE TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_redact',true))
 WITH CHECK (session_user='morrow_connector_ingress' AND erased_reason='shop_redact'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_redact',true));
-- The clean-up job's clock: the ids of unerased exports, only while connector_privacy_purge's
-- own sweep setting is on; then each one erased under a setting naming its tenant and id alone.
CREATE POLICY connector_export_sweep ON morrow_work.customer_data_exports FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress' AND erased_at IS NULL
  AND pg_catalog.current_setting('morrow.connector_sweep',true)='customer_exports');
CREATE POLICY connector_export_expire_read ON morrow_work.customer_data_exports FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||id::text=pg_catalog.current_setting('morrow.connector_export',true));
CREATE POLICY connector_export_expire ON morrow_work.customer_data_exports FOR UPDATE TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||id::text=pg_catalog.current_setting('morrow.connector_export',true))
 WITH CHECK (session_user='morrow_connector_ingress' AND erased_reason='expired'
  AND organization_id::text||'|'||workspace_id::text||'|'||id::text=pg_catalog.current_setting('morrow.connector_export',true));
GRANT SELECT,INSERT ON morrow_work.customer_data_exports TO morrow_work_command;
GRANT UPDATE (document,order_ids,customer_id_digests,email_digests,phone_digests,erased_at,erased_reason)
 ON morrow_work.customer_data_exports TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- The registered classes' handlers and the registration surface: revisable owner helpers
-- (INVOKER, owned by the owner, EXECUTE for the command role only), run by the applier below
-- as the command role, in the connector's customer redaction context for one store.
-- The data_request exports' customers/redact handler (packages/work/src/redaction.ts
-- customerContentHandlers): an unerased export of this store whose kept keys share an order id
-- or a digest with the match is erased in place. {table, action, rows (erased now), remaining}.
CREATE FUNCTION morrow_work.customer_data_exports_redact(p_org text,p_ws text,p_store_id text,p_match jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE n integer; v_left integer; v_orders text[]; v_ids text[]; v_emails text[]; v_phones text[];
 v_at timestamptz:=date_trunc('milliseconds',clock_timestamp());
BEGIN
 v_orders:=morrow_work.customer_match_orders(p_match);
 v_ids:=morrow_work.customer_match_digests(p_match,'customer_id');
 v_emails:=morrow_work.customer_match_digests(p_match,'email');
 v_phones:=morrow_work.customer_match_digests(p_match,'phone');
 IF v_orders IS NULL OR v_ids IS NULL OR v_emails IS NULL OR v_phones IS NULL THEN RAISE EXCEPTION 'CUSTOMER_CONTENT_REDACT_INVALID'; END IF;
 UPDATE morrow_work.customer_data_exports e SET document=NULL,order_ids='{}',customer_id_digests='{}',email_digests='{}',
  phone_digests='{}',erased_at=greatest(v_at,e.created_at),erased_reason='customer_redact'
  WHERE e.organization_id=p_org AND e.workspace_id=p_ws AND e.store_id=p_store_id AND e.erased_at IS NULL
   AND (e.order_ids && v_orders OR e.customer_id_digests && v_ids OR e.email_digests && v_emails OR e.phone_digests && v_phones);
 GET DIAGNOSTICS n=ROW_COUNT;
 SELECT count(*)::integer INTO v_left FROM morrow_work.customer_data_exports e
  WHERE e.organization_id=p_org AND e.workspace_id=p_ws AND e.store_id=p_store_id AND e.erased_at IS NULL
   AND (e.order_ids && v_orders OR e.customer_id_digests && v_ids OR e.email_digests && v_emails OR e.phone_digests && v_phones);
 RETURN jsonb_build_object('table','morrow_work.customer_data_exports','action','empty_keep_digest','rows',n,'remaining',v_left);
END $$;
-- customers/redact's surface: every registered class's handler for one store, one entry each
-- ({table, action, rows, remaining}). It runs only under the connector's customer redaction
-- context for exactly this store; anything else is refused, never an empty success. A class
-- that is keyed by an order, a customer id or a customer digest registers its handler here
-- (and in redaction.ts and customer_handler_tables) in the pull request that first writes it.
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
 RETURN jsonb_build_array(morrow_work.customer_data_exports_redact(p_org,p_ws,p_store_id,p_match));
END $$;
-- customers/data_request's surface: every registered class's export for one store, one entry
-- per class with rows ({table, rows [objects]}), in the same context only. Each row a class
-- exports is that customer's own data in the class, without digests or other customers' data.
-- No registered class exports rows yet (the exports themselves are not exported again).
CREATE FUNCTION morrow_work.customer_content_export(p_org text,p_ws text,p_store_id text,p_match jsonb)
RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR NOT morrow_work.customer_match_valid(p_match) THEN
  RAISE EXCEPTION 'CUSTOMER_CONTENT_EXPORT_INVALID';
 END IF;
 IF NOT (session_user='morrow_connector_ingress'
   AND pg_catalog.current_setting('morrow.connector_customer',true)=p_org||'|'||p_ws||'|'||p_store_id) THEN
  RAISE EXCEPTION 'CUSTOMER_CONTENT_EXPORT_UNAVAILABLE';
 END IF;
 RETURN '[]'::jsonb;
END $$;
-- Every store-content handler of the work schema for one store (0038), same signature, owner
-- and ACL, with SD4's data_request exports: the store's unerased exports are erased in place
-- (reason shop_redact) in the connector's redaction context (connector_export_redact_read and
-- connector_export_redact_erase). Every other handler is 0038's, unchanged.
CREATE OR REPLACE FUNCTION morrow_work.store_content_redact(p_org text,p_ws text,p_store_id text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE r record; v_redacted integer; v_remaining integer; v_snapshots integer; v_snapshots_left integer; v_drafts integer;
 v_drafts_left integer; v_exports integer; v_exports_left integer; v_at timestamptz:=date_trunc('milliseconds',clock_timestamp());
BEGIN
 SELECT * INTO r FROM morrow_work.parameters_redact_for_store(p_org,p_ws,p_store_id);
 IF r.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'STORE_CONTENT_REDACT_UNAVAILABLE'; END IF;
 SELECT count(*) FILTER (WHERE q.redacted_at IS NOT NULL)::integer,count(*) FILTER (WHERE q.redacted_at IS NULL)::integer
  INTO v_redacted,v_remaining FROM morrow_work.proposal_parameters q
  WHERE q.organization_id=p_org AND q.workspace_id=p_ws
   AND q.id IN (SELECT x.parameters_id FROM morrow_work.proposals x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=p_store_id);
 DELETE FROM morrow_work.run_drafts d WHERE d.organization_id=p_org AND d.workspace_id=p_ws AND d.store_id=p_store_id;
 GET DIAGNOSTICS v_drafts=ROW_COUNT;
 DELETE FROM morrow_work.product_snapshots x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=p_store_id;
 GET DIAGNOSTICS v_snapshots=ROW_COUNT;
 UPDATE morrow_work.customer_data_exports e SET document=NULL,order_ids='{}',customer_id_digests='{}',email_digests='{}',
  phone_digests='{}',erased_at=greatest(v_at,e.created_at),erased_reason='shop_redact'
  WHERE e.organization_id=p_org AND e.workspace_id=p_ws AND e.store_id=p_store_id AND e.erased_at IS NULL;
 GET DIAGNOSTICS v_exports=ROW_COUNT;
 SELECT count(*)::integer INTO v_drafts_left FROM morrow_work.run_drafts d
  WHERE d.organization_id=p_org AND d.workspace_id=p_ws AND d.store_id=p_store_id;
 SELECT count(*)::integer INTO v_snapshots_left FROM morrow_work.product_snapshots x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=p_store_id;
 SELECT count(*)::integer INTO v_exports_left FROM morrow_work.customer_data_exports e
  WHERE e.organization_id=p_org AND e.workspace_id=p_ws AND e.store_id=p_store_id AND e.erased_at IS NULL;
 RETURN jsonb_build_array(
  jsonb_build_object('table','morrow_work.proposal_parameters','action','empty_keep_digest','rows',v_redacted,'remaining',v_remaining),
  jsonb_build_object('table','morrow_work.product_snapshots','action','delete_rows','rows',v_snapshots,'remaining',v_snapshots_left),
  jsonb_build_object('table','morrow_work.run_drafts','action','delete_rows','rows',v_drafts,'remaining',v_drafts_left),
  jsonb_build_object('table','morrow_work.customer_data_exports','action','empty_keep_digest','rows',v_exports,'remaining',v_exports_left));
END $$;

-- ---------------------------------------------------------------------------
-- The connector definers: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_connector_ingress only (work_executor_safe). Each takes ids only and overwrites every
-- connector setting on entry.
-- The applier of one recorded inbox row (0054), same signature, owner and ACL. The tenant,
-- installation and store come only from the row the broker recorded:
--   customers/redact  the request's match, from the row's minimised body; under the store's
--     stop key held exclusively (a class writer holds it shared, so a racing write commits
--     first and is redacted, or writes after), every registered customer-content class of
--     the store (customer_content_redact, in the connector's customer redaction context for
--     that store alone). Completes "customer_redacted" only when every handler reports zero
--     remaining ("none_held" when no installation of the app holds the shop); otherwise the
--     delivery stays received and its request open ('pending'), and the cron re-drives it;
--   customers/data_request  the same match and context; every registered class's export
--     (customer_content_export). When any class exported rows, one export to the Owner (the
--     organization's founding principal, from the installation) is written with the match's
--     keys, and the request completes "customer_exported" with each class's count; otherwise
--     "none_held". A redelivery of a recorded data request has no request of its own and is
--     ignored, as 0037 did;
--   app/scopes_update and every other topic  0054's, unchanged.
-- The command role owns it, so it is dropped (the schema owner may) and created again, with
-- its one grant and owner restored below, as 0056 did for runtime_operation_begin.
DROP FUNCTION morrow_work.connector_inbox_apply_v2(text);
CREATE FUNCTION morrow_work.connector_inbox_apply_v2(p_inbox_id text)
RETURNS TABLE(outcome text,topic text,installation_id text,credential text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE x record; r record; s record; h jsonb; v_body jsonb; v_match jsonb; v_content jsonb:='[]'::jsonb; v_handlers jsonb;
 v_outstanding jsonb; v_evidence jsonb; v_completed text; v_kind text; v_rows integer:=0; v_owner text; v_document jsonb;
 v_at timestamptz;
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true),
  pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true),
  pg_catalog.set_config('morrow.connector_sweep','',true),pg_catalog.set_config('morrow.connector_customer','',true),
  pg_catalog.set_config('morrow.connector_export','',true);
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
 -- SD3 and SD4: the customer requests run every registered customer-content class.
 IF x.topic IN ('customers/redact','customers/data_request') THEN
  IF x.status<>'received' THEN RETURN QUERY SELECT 'settled'::text,x.topic,x.installation_id,NULL::text,NULL::text; RETURN; END IF;
  -- A redelivery of a data request that is already recorded has no request of its own.
  IF x.request_status IS NULL THEN
   IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'ignored','duplicate_request',jsonb_build_object('request','none'))
    NOT IN ('settled','already_settled') THEN RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED'; END IF;
   RETURN QUERY SELECT 'applied'::text,x.topic,x.installation_id,'none'::text,NULL::text; RETURN;
  END IF;
  v_body:=x.body::jsonb;
  v_match:=morrow_work.customer_match_of(x.topic,v_body);
  IF v_match IS NULL THEN RAISE EXCEPTION 'CONNECTOR_CUSTOMER_MATCH_INVALID'; END IF;
  IF x.store_id IS NOT NULL THEN
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
    x.organization_id,x.workspace_id,x.store_id)::text,0));
   PERFORM pg_catalog.set_config('morrow.connector_customer',x.organization_id||'|'||x.workspace_id||'|'||x.store_id,true);
   IF x.topic='customers/redact' THEN
    v_content:=morrow_work.customer_content_redact(x.organization_id,x.workspace_id,x.store_id,v_match);
   ELSE
    v_content:=COALESCE((SELECT jsonb_agg(c ORDER BY c->>'table') FROM jsonb_array_elements(
     morrow_work.customer_content_export(x.organization_id,x.workspace_id,x.store_id,v_match)) c
     WHERE jsonb_array_length(c->'rows')>0),'[]'::jsonb);
    SELECT COALESCE(sum(jsonb_array_length(c->'rows')),0)::integer INTO v_rows FROM jsonb_array_elements(v_content) c;
    IF v_rows>0 THEN
     SELECT t.owner_principal_id INTO v_owner FROM morrow_identity.work_shopify_health_target(x.installation_id) t
      WHERE t.outcome='found' AND t.organization_id=x.organization_id AND t.workspace_id=x.workspace_id;
     IF v_owner IS NULL THEN
      PERFORM pg_catalog.set_config('morrow.connector_customer','',true);
      RETURN QUERY SELECT 'pending'::text,x.topic,x.installation_id,'none'::text,NULL::text; RETURN;
     END IF;
     v_document:=jsonb_build_object('schemaVersion',1,'dataRequestId',v_body->>'dataRequestId','classes',v_content);
     v_at:=date_trunc('milliseconds',clock_timestamp());
     INSERT INTO morrow_work.customer_data_exports(organization_id,workspace_id,id,store_id,inbox_id,data_request_id,
      recipient_principal_id,rows,document,document_digest,order_ids,customer_id_digests,email_digests,phone_digests,created_at,
      expires_at,erased_at,erased_reason)
     VALUES (x.organization_id,x.workspace_id,gen_random_uuid()::text,x.store_id,p_inbox_id,v_body->>'dataRequestId',v_owner,v_rows,
      v_document,encode(sha256(convert_to(v_document::text,'UTF8')),'hex'),morrow_work.customer_match_orders(v_match),
      morrow_work.customer_match_digests(v_match,'customer_id'),morrow_work.customer_match_digests(v_match,'email'),
      morrow_work.customer_match_digests(v_match,'phone'),v_at,v_at+interval '30 days',NULL,NULL);
    END IF;
    -- Each exporting class's count; nothing is outstanding once the export is written.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('table',c->>'table','rows',jsonb_array_length(c->'rows'),'remaining',0)
     ORDER BY c->>'table'),'[]'::jsonb) INTO v_content FROM jsonb_array_elements(v_content) c;
   END IF;
   PERFORM pg_catalog.set_config('morrow.connector_customer','',true);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table',c->>'table','action',
     CASE WHEN x.topic='customers/redact' THEN c->>'action' ELSE 'export_rows' END,'rows',(c->>'rows')::integer) ORDER BY c->>'table'),
    '[]'::jsonb),
   COALESCE(jsonb_agg(c->'table' ORDER BY c->>'table') FILTER (WHERE (c->>'remaining')::bigint>0),'[]'::jsonb)
   INTO v_handlers,v_outstanding FROM jsonb_array_elements(v_content) c;
  IF v_outstanding<>'[]'::jsonb THEN
   RETURN QUERY SELECT 'pending'::text,x.topic,x.installation_id,'none'::text,NULL::text; RETURN;
  END IF;
  v_kind:=CASE WHEN v_handlers='[]'::jsonb THEN 'none_held' WHEN x.topic='customers/redact' THEN 'customer_redacted'
   ELSE 'customer_exported' END;
  v_evidence:=jsonb_build_object('schemaVersion',1,'kind',v_kind,'scopes','["read_products","write_products"]'::jsonb,
   'handlers',v_handlers,'credential','none','outstanding','[]'::jsonb);
  v_completed:=morrow_identity.work_privacy_request_complete(x.organization_id,x.workspace_id,p_inbox_id,v_evidence);
  IF v_completed NOT IN ('completed','already_completed') THEN RAISE EXCEPTION 'CONNECTOR_PRIVACY_REFUSED'; END IF;
  IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'applied',v_kind,jsonb_build_object('request','completed',
    'orders',jsonb_array_length(v_match->'orders'),'handlers',jsonb_array_length(v_handlers),'rows',v_rows))
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
-- The clean-up job's clocks (ADR-0031 item 1), counts only: the inbox's 7-day purge (0059:
-- deliveries deleted, and expired ones kept for an open request or a pending apply), then at
-- most 100 data_request exports past their 30 days, each erased under a setting naming its own
-- tenant and id (listed, ids only, under this definer's sweep setting).
CREATE FUNCTION morrow_work.connector_privacy_purge()
RETURNS TABLE(purged integer,held integer,erased integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; v_keys text[]; v_key text; n integer; v_erased integer:=0; v_at timestamptz;
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true),
  pg_catalog.set_config('morrow.connector_health','',true),pg_catalog.set_config('morrow.connector_agent_stop','',true),
  pg_catalog.set_config('morrow.connector_sweep','',true),pg_catalog.set_config('morrow.connector_customer','',true),
  pg_catalog.set_config('morrow.connector_export','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN RETURN; END IF;
 SELECT x.purged,x.held INTO p FROM morrow_identity.work_shopify_inbox_purge() x;
 PERFORM pg_catalog.set_config('morrow.connector_sweep','customer_exports',true);
 SELECT COALESCE(array_agg(e.k ORDER BY e.expires_at,e.k),'{}') INTO v_keys FROM (
  SELECT x.organization_id::text||'|'||x.workspace_id::text||'|'||x.id::text AS k,x.expires_at FROM morrow_work.customer_data_exports x
  WHERE x.erased_at IS NULL AND x.expires_at<=pg_catalog.clock_timestamp() ORDER BY x.expires_at,x.id LIMIT 100) e;
 PERFORM pg_catalog.set_config('morrow.connector_sweep','',true);
 FOREACH v_key IN ARRAY v_keys LOOP
  PERFORM pg_catalog.set_config('morrow.connector_export',v_key,true);
  v_at:=date_trunc('milliseconds',clock_timestamp());
  UPDATE morrow_work.customer_data_exports e SET document=NULL,order_ids='{}',customer_id_digests='{}',email_digests='{}',
   phone_digests='{}',erased_at=greatest(v_at,e.created_at),erased_reason='expired'
   WHERE e.organization_id::text||'|'||e.workspace_id::text||'|'||e.id::text=v_key AND e.erased_at IS NULL
    AND e.expires_at<=pg_catalog.clock_timestamp();
  GET DIAGNOSTICS n=ROW_COUNT;
  v_erased:=v_erased+n;
 END LOOP;
 PERFORM pg_catalog.set_config('morrow.connector_export','',true);
 RETURN QUERY SELECT p.purged,p.held,v_erased;
END $$;

-- ---------------------------------------------------------------------------
-- The Owner's read of the data_request exports (session only; ADR-0031 item 4 and owner
-- question 4: the Owner only): the unerased exports of the session tenant written for the
-- session principal, newest first, at most 20, with each export's document. Nothing without a
-- context, for another tenant or for any other member. The Inbox is the seam that shows them.
CREATE FUNCTION morrow_work.customer_data_exports_open()
RETURNS TABLE(export_id text,store_id text,data_request_id text,rows integer,created_at text,expires_at text,document text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record;
BEGIN
 SELECT c.organization_id,c.workspace_id,c.principal_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT e.id::text,e.store_id::text,e.data_request_id,e.rows,morrow_work.utc_text(e.created_at),
  morrow_work.utc_text(e.expires_at),e.document::text
  FROM morrow_work.customer_data_exports e
  WHERE e.organization_id=t.organization_id AND e.workspace_id=t.workspace_id AND e.erased_at IS NULL
   AND e.expires_at>pg_catalog.clock_timestamp() AND e.recipient_principal_id=t.principal_id
  ORDER BY e.created_at DESC,e.id LIMIT 20;
END $$;

-- ---------------------------------------------------------------------------
-- The broker's vault definers: SECURITY DEFINER, owned by the command role after the transfer,
-- EXECUTE for morrow_vault_broker only (work_executor_safe). The tenant is the workspace the
-- app registered for the shop invites (0059's work_shopify_app_tenant), never a caller's.
-- Every kept version of that workspace's digest key, ascending, as hex; one row "none" with the
-- tenant when it has none yet; or one row not_found, invalid or denied.
CREATE FUNCTION morrow_vault.customer_digest_keys_get(p_app_key text,p_shop_domain text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,version text,kek_version text,wrapped_key text,sealed_value text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE t record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO t FROM morrow_identity.work_shopify_app_tenant(p_app_key,p_shop_domain);
 IF t.outcome IS DISTINCT FROM 'found' THEN
  RETURN QUERY SELECT COALESCE(t.outcome,'invalid'),NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_vault.customer_digest_keys k WHERE k.organization_id=t.organization_id
   AND k.workspace_id=t.workspace_id AND k.status='active') THEN
  RETURN QUERY SELECT 'none'::text,t.organization_id,t.workspace_id,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 RETURN QUERY SELECT 'found'::text,k.organization_id::text,k.workspace_id::text,k.version::text,k.kek_version::text,
  encode(k.wrapped_key,'hex'),encode(k.sealed_value,'hex')
  FROM morrow_vault.customer_digest_keys k WHERE k.organization_id=t.organization_id AND k.workspace_id=t.workspace_id
   AND k.status='active' ORDER BY k.version LIMIT 8;
END $$;
-- Version 1 of that workspace's key, as the broker sealed it, under the workspace's key lock;
-- a key already there (a racing request) is kept. Outcomes: created, exists, not_found,
-- invalid, denied.
CREATE FUNCTION morrow_vault.customer_digest_key_create(p_app_key text,p_shop_domain text,p_kek_version text,p_wrapped_key text,
 p_sealed_value text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
DECLARE t record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN 'denied'; END IF;
 IF p_kek_version IS NULL OR p_kek_version !~ '^[1-9][0-9]{0,2}$' OR p_wrapped_key IS NULL OR p_wrapped_key !~ '^[a-f0-9]{120}$'
  OR p_sealed_value IS NULL OR p_sealed_value !~ '^[a-f0-9]{120}$' THEN
  RETURN 'invalid';
 END IF;
 SELECT * INTO t FROM morrow_identity.work_shopify_app_tenant(p_app_key,p_shop_domain);
 IF t.outcome IS DISTINCT FROM 'found' THEN RETURN COALESCE(t.outcome,'invalid'); END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.vault.customer_digest_key',
  t.organization_id,t.workspace_id)::text,0));
 IF EXISTS(SELECT 1 FROM morrow_vault.customer_digest_keys k WHERE k.organization_id=t.organization_id
   AND k.workspace_id=t.workspace_id) THEN
  RETURN 'exists';
 END IF;
 INSERT INTO morrow_vault.customer_digest_keys(organization_id,workspace_id,version,status,kek_version,wrapped_key,sealed_value,
  created_at,destroyed_at)
 VALUES (t.organization_id,t.workspace_id,1,'active',p_kek_version::integer,decode(p_wrapped_key,'hex'),decode(p_sealed_value,'hex'),
  date_trunc('milliseconds',clock_timestamp()),NULL);
 RETURN 'created';
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.customer_match_valid(jsonb),morrow_work.customer_match_of(text,jsonb),
 morrow_work.customer_match_orders(jsonb),morrow_work.customer_match_digests(jsonb,text),
 morrow_work.customer_export_document_valid(jsonb,integer),morrow_work.customer_digest_list_valid(text[]),
 morrow_work.customer_data_exports_redact(text,text,text,jsonb),morrow_work.customer_content_redact(text,text,text,jsonb),
 morrow_work.customer_content_export(text,text,text,jsonb),morrow_work.connector_inbox_apply_v2(text),
 morrow_work.connector_privacy_purge(),morrow_work.customer_data_exports_open(),
 morrow_vault.customer_digest_keys_get(text,text),morrow_vault.customer_digest_key_create(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.customer_match_valid(jsonb),morrow_work.customer_match_of(text,jsonb),
 morrow_work.customer_match_orders(jsonb),morrow_work.customer_match_digests(jsonb,text),
 morrow_work.customer_export_document_valid(jsonb,integer),morrow_work.customer_digest_list_valid(text[]),
 morrow_work.customer_data_exports_redact(text,text,text,jsonb),morrow_work.customer_content_redact(text,text,text,jsonb),
 morrow_work.customer_content_export(text,text,text,jsonb) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_work.connector_inbox_apply_v2(text),morrow_work.connector_privacy_purge() TO morrow_connector_ingress;
GRANT EXECUTE ON FUNCTION morrow_work.customer_data_exports_open() TO morrow_work_api;
GRANT EXECUTE ON FUNCTION morrow_vault.customer_digest_keys_get(text,text),
 morrow_vault.customer_digest_key_create(text,text,text,text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_work,morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_inbox_apply_v2(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_privacy_purge() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.customer_data_exports_open() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.customer_digest_keys_get(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.customer_digest_key_create(text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work,morrow_vault FROM morrow_work_command;
COMMIT;
