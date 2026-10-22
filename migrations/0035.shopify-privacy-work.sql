BEGIN;
-- M2 PR-3: the work and vault side of uninstall, the compliance topics and Shopify reads
-- (ADR-0022 items 4, 7, 9, 13-15; mvp-architecture §4, §5, §10 and §11; P09.T04a,
-- P09.T05a). Executes AS morrow_work_owner, after 0034. It adds:
--   * the connector login's context: USAGE on morrow_work and policies that admit, only
--     while the session user is morrow_connector_ingress and only for the tenant, store and
--     connection that its own definer wrote into a transaction-local setting before it
--     touched any table: the system connection stop and its StopRecord@1 (scope connection,
--     set by the system, an uninstall or scope-change reason, never a lift), the revocation
--     of that connection's leases (to revoked, reason stop), and shop/redact's emptying of
--     the store's proposal parameters (redacted, canonical '{}');
--   * the connector definers (EXECUTE for morrow_connector_ingress only): the inbox
--     applier, which ends the installation, sets the stop, redacts the store's content and
--     identity and completes privacy requests from the verified inbox row alone, and the
--     two ids-only re-drives (inbox rows still received; installations whose token is not
--     yet destroyed);
--   * the vault definers (EXECUTE for morrow_vault_broker only): the webhook record in the
--     broker's verifying transaction, the credential destruction (recorded on the
--     installation in the transaction that erases the key material) and the read
--     resolution of shopifyRead (resolve_call with the subject the caller names, the
--     query fitted to the lease kind, and the store installation that is the credential's
--     subject, with its shop domain);
--   * the api's read lease for the catalogue routes (catalog_read_lease, session only);
--   * revisable owner helpers: parameters_redact_for_store (revised to accept the connector's
--     redaction context), store_content_redact (every store-content handler of the work
--     schema, with counts; M3 PR-2 adds snapshots and drafts) and run_product_readable (a
--     run lease reads only its run's products; no run table exists yet, so it refuses).
-- Each setting is written and cleared only inside these definers, and each connector
-- definer overwrites both on entry: the connector login holds no table privilege, so a
-- setting it forges reaches nothing (the resolve_call precedent of 0031).
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regprocedure('morrow_vault.resolve_call(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.lease_open(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.listings_store_current(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL OR to_regprocedure('morrow_work.db_now()') IS NULL
 OR to_regprocedure('morrow_work.connector_inbox_apply(text)') IS NOT NULL
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_work.parameters_redact_for_store(text,text,text)'))
  IS DISTINCT FROM '0d5c26385173cb9828f756658e276dac'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_vault.credentials'::regclass
   AND c.conname='credentials_destroy_reason_check')
  IS DISTINCT FROM 'CHECK ((destroy_reason = ANY (ARRAY[''uninstalled''::text, ''disconnected''::text, ''reauthorised''::text])))'
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_webhook_record(text,text,text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_take(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_settle(text,text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_inbox_pending()','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_installation_end(text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_redact_identity(text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_privacy_request_complete(text,text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_credential_end(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_credentials_pending()','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_read_target(text,text,text,text)','EXECUTE')
 OR pg_catalog.has_schema_privilege('morrow_connector_ingress','morrow_work','USAGE')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='morrow_work' AND p.policyname LIKE 'connector\_%')
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_work.proposals'::regclass AND a.attname='store_id' AND NOT a.attisdropped)
 THEN RAISE EXCEPTION 'SHOPIFY_PRIVACY_WORK_PREREQUISITES_INVALID'; END IF;
END $$;

-- A scope change also ends the token (the installation is suspended until a reinstall, M6).
ALTER TABLE morrow_vault.credentials DROP CONSTRAINT credentials_destroy_reason_check,
 ADD CONSTRAINT credentials_destroy_reason_check CHECK (destroy_reason IN ('uninstalled','disconnected','reauthorised','scopes_changed'));
-- The connector login executes its own work definers (below) and nothing else here.
GRANT USAGE ON SCHEMA morrow_work TO morrow_connector_ingress;

-- ---------------------------------------------------------------------------
-- The connector context's policies. morrow.connector_stop names exactly one
-- org|ws|store|connection and morrow.connector_redact one org|ws|store; only
-- connector_inbox_apply writes them, from the inbox row the broker recorded, and clears
-- them. Nothing here admits a lift, an update of a stop, another scope or reason, a human
-- or operator setter, or any lease change but revoked with reason stop.
CREATE POLICY connector_stop_read ON morrow_work.stop_controls FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress' AND scope='connection'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||target_id::text=pg_catalog.current_setting('morrow.connector_stop',true));
CREATE POLICY connector_stop_set ON morrow_work.stop_controls FOR INSERT TO morrow_work_command
 WITH CHECK (session_user='morrow_connector_ingress' AND scope='connection' AND set_by_kind='system' AND lifted_at IS NULL
  AND kill_switch_record_id IS NULL AND reason_code IN ('shopify_app_uninstalled','shopify_scopes_changed')
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||target_id::text=pg_catalog.current_setting('morrow.connector_stop',true));
CREATE POLICY connector_stop_record ON morrow_work.stop_records FOR INSERT TO morrow_work_command
 WITH CHECK (session_user='morrow_connector_ingress' AND action='set' AND actor_kind='system' AND operator_id IS NULL AND scope='connection'
  AND reason_code IN ('shopify_app_uninstalled','shopify_scopes_changed')
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||target_id::text=pg_catalog.current_setting('morrow.connector_stop',true));
-- stop_guard revokes the connection's leases under these: USING has no status term (an
-- UPDATE that reads its rows also checks the new row against SELECT policies, 0023).
CREATE POLICY connector_lease_read ON morrow_work.work_leases FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||connection_id::text=pg_catalog.current_setting('morrow.connector_stop',true));
CREATE POLICY connector_lease_revoke ON morrow_work.work_leases FOR UPDATE TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||connection_id::text=pg_catalog.current_setting('morrow.connector_stop',true))
 WITH CHECK (status='revoked' AND revoked_reason='stop' AND session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||connection_id::text=pg_catalog.current_setting('morrow.connector_stop',true));
CREATE POLICY connector_redact_proposal ON morrow_work.proposals FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text=pg_catalog.current_setting('morrow.connector_redact',true));
CREATE POLICY connector_redact_read ON morrow_work.proposal_parameters FOR SELECT TO morrow_work_command
 USING (session_user='morrow_connector_ingress' AND EXISTS(SELECT 1 FROM morrow_work.proposals x
  WHERE x.organization_id=proposal_parameters.organization_id AND x.workspace_id=proposal_parameters.workspace_id
   AND x.parameters_id=proposal_parameters.id
   AND x.organization_id::text||'|'||x.workspace_id::text||'|'||x.store_id::text=pg_catalog.current_setting('morrow.connector_redact',true)));
CREATE POLICY connector_redact ON morrow_work.proposal_parameters FOR UPDATE TO morrow_work_command
 USING (session_user='morrow_connector_ingress' AND EXISTS(SELECT 1 FROM morrow_work.proposals x
  WHERE x.organization_id=proposal_parameters.organization_id AND x.workspace_id=proposal_parameters.workspace_id
   AND x.parameters_id=proposal_parameters.id
   AND x.organization_id::text||'|'||x.workspace_id::text||'|'||x.store_id::text=pg_catalog.current_setting('morrow.connector_redact',true)))
 WITH CHECK (redacted_at IS NOT NULL AND canonical='{}' AND session_user='morrow_connector_ingress' AND EXISTS(SELECT 1 FROM morrow_work.proposals x
  WHERE x.organization_id=proposal_parameters.organization_id AND x.workspace_id=proposal_parameters.workspace_id
   AND x.parameters_id=proposal_parameters.id
   AND x.organization_id::text||'|'||x.workspace_id::text||'|'||x.store_id::text=pg_catalog.current_setting('morrow.connector_redact',true)));

-- ---------------------------------------------------------------------------
-- Revisable owner helpers: INVOKER, owned by the owner (a later owner migration may
-- CREATE OR REPLACE them), EXECUTE for the command role only.
-- parameters_redact_for_store (0032), same signature, revised: it runs under the tenant's
-- own session context as before, or under the connector's redaction context for exactly
-- this store (morrow.connector_redact, which only connector_inbox_apply writes). Otherwise
-- it still refuses with context_unavailable, never an empty success.
CREATE OR REPLACE FUNCTION morrow_work.parameters_redact_for_store(p_org text,p_ws text,p_store_id text)
RETURNS TABLE(outcome text,redacted integer)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE n integer; v_at timestamptz:=date_trunc('milliseconds',clock_timestamp());
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_work.current_tenant() c WHERE c.organization_id=p_org AND c.workspace_id=p_ws)
  AND NOT (session_user='morrow_connector_ingress'
   AND pg_catalog.current_setting('morrow.connector_redact',true)=p_org||'|'||p_ws||'|'||p_store_id) THEN
  RETURN QUERY SELECT 'context_unavailable'::text,NULL::integer; RETURN;
 END IF;
 UPDATE morrow_work.proposal_parameters q SET canonical='{}',redacted_at=greatest(v_at,q.created_at)
  WHERE q.organization_id=p_org AND q.workspace_id=p_ws AND q.redacted_at IS NULL
   AND q.id IN (SELECT x.parameters_id FROM morrow_work.proposals x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=p_store_id);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN QUERY SELECT 'applied'::text,n;
END $$;
-- Every store-content handler of the work schema for one store (packages/work/src/
-- redaction.ts), run under the caller's context: the proposal parameters are emptied
-- (digest kept). Returns one entry per handler with the rows now in the redacted state and
-- the rows still holding content; shop/redact completes only when every `remaining` is 0.
-- M3 PR-2 (or this PR's rebase, whichever merges second) revises it to delete the store's
-- product_snapshots and run_drafts too.
CREATE FUNCTION morrow_work.store_content_redact(p_org text,p_ws text,p_store_id text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE r record; v_redacted integer; v_remaining integer;
BEGIN
 SELECT * INTO r FROM morrow_work.parameters_redact_for_store(p_org,p_ws,p_store_id);
 IF r.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'STORE_CONTENT_REDACT_UNAVAILABLE'; END IF;
 SELECT count(*) FILTER (WHERE q.redacted_at IS NOT NULL)::integer,count(*) FILTER (WHERE q.redacted_at IS NULL)::integer
  INTO v_redacted,v_remaining FROM morrow_work.proposal_parameters q
  WHERE q.organization_id=p_org AND q.workspace_id=p_ws
   AND q.id IN (SELECT x.parameters_id FROM morrow_work.proposals x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=p_store_id);
 RETURN jsonb_build_array(jsonb_build_object('table','morrow_work.proposal_parameters','action','empty_keep_digest',
  'rows',v_redacted,'remaining',v_remaining));
END $$;
-- Whether a run lease may read one product (spine §4; review finding B2): only a product of
-- that run. The runs and their products are M3 PR-2's tables, which do not exist at this
-- head, so every run-lease product read is refused; M3 PR-2 (or this PR's rebase) revises
-- it to read the run's products.
CREATE FUNCTION morrow_work.run_product_readable(p_org text,p_ws text,p_run_id text,p_product_id text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT false
$$;

-- ---------------------------------------------------------------------------
-- The connector definers: SECURITY DEFINER, owned by the command role after the transfer
-- below, EXECUTE for morrow_connector_ingress only (work_executor_safe). Each takes ids
-- only and overwrites both connector settings on entry.
-- Applies one recorded inbox row. The tenant, installation, store and connection come
-- only from the row the broker recorded after verifying Shopify's signature (and from the
-- installation it named), never from the caller. By topic:
--   customers/data_request, customers/redact  the privacy request completes "none held":
--     Morrow holds no customer data (read_products and write_products only).
--   app/uninstalled  the installation becomes uninstalled; the system connection stop
--     (StopRecord@1) revokes the connection's leases, unless a stop is already active on it.
--   app/scopes_update  unchanged expanded scopes are ignored; otherwise the installation
--     is suspended (scopes_changed) with the same stop.
--   shop/redact  the uninstall path first (if the uninstall has not arrived, it never
--     assumes order), then every store-content handler of the store and the identity
--     redaction; the privacy request completes only when nothing is outstanding, its
--     evidence counted from the state now held (so a re-run reports the same evidence).
-- A row's token destruction is the broker's (shopifyCredentialDestroy): app/* settle with
-- credential "pending" when it is not yet recorded (the re-drive keeps it until it is);
-- shop/redact stays received, its request open, until it is. `reason` is the end reason
-- the installation records, which the destruction names. Outcomes: applied, pending,
-- settled (already), not_found, invalid, denied.
CREATE FUNCTION morrow_work.connector_inbox_apply(p_inbox_id text)
RETURNS TABLE(outcome text,topic text,installation_id text,credential text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE x record; e record; v_identity record; v_content jsonb; v_handlers jsonb; v_outstanding jsonb; v_evidence jsonb;
 v_completed text; v_stop text:='none'; v_stop_id text; v_at timestamptz; v_reason_code text; v_reason text; v_end_reason text;
 v_scopes text[]; v_body jsonb;
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true);
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
 IF x.status<>'received' THEN RETURN QUERY SELECT 'settled'::text,x.topic,x.installation_id,NULL::text,NULL::text; RETURN; END IF;
 v_body:=x.body::jsonb;
 -- customers/*: no customer data held. A redelivery of a data request that is already
 -- recorded has no request of its own (privacy_requests_one_data_request) and is ignored.
 IF x.topic IN ('customers/data_request','customers/redact') THEN
  v_evidence:=jsonb_build_object('schemaVersion',1,'kind','none_held','scopes','["read_products","write_products"]'::jsonb,
   'handlers','[]'::jsonb,'credential','none','outstanding','[]'::jsonb);
  v_completed:=CASE WHEN x.request_status IS NULL THEN 'not_found'
   ELSE morrow_identity.work_privacy_request_complete(x.organization_id,x.workspace_id,p_inbox_id,v_evidence) END;
  IF v_completed NOT IN ('completed','already_completed','not_found') THEN RAISE EXCEPTION 'CONNECTOR_PRIVACY_REFUSED'; END IF;
  IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,CASE WHEN v_completed='not_found' THEN 'ignored' ELSE 'applied' END,
    CASE WHEN v_completed='not_found' THEN 'duplicate_request' ELSE 'none_held' END,
    jsonb_build_object('request',CASE WHEN v_completed='not_found' THEN 'none' ELSE 'completed' END))
   NOT IN ('settled','already_settled') THEN RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED'; END IF;
  RETURN QUERY SELECT 'applied'::text,x.topic,x.installation_id,'none'::text,NULL::text; RETURN;
 END IF;
 -- No installation of this app holds the shop: app/* change nothing; shop/redact holds none.
 IF x.installation_id IS NULL THEN
  IF x.topic='shop/redact' THEN
   v_evidence:=jsonb_build_object('schemaVersion',1,'kind','none_held','scopes','["read_products","write_products"]'::jsonb,
    'handlers','[]'::jsonb,'credential','none','outstanding','[]'::jsonb);
   v_completed:=morrow_identity.work_privacy_request_complete(x.organization_id,x.workspace_id,p_inbox_id,v_evidence);
   IF v_completed NOT IN ('completed','already_completed') THEN RAISE EXCEPTION 'CONNECTOR_PRIVACY_REFUSED'; END IF;
   IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'applied','none_held',jsonb_build_object('request','completed'))
    NOT IN ('settled','already_settled') THEN RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED'; END IF;
  ELSIF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'ignored','no_installation','{}'::jsonb) NOT IN ('settled','already_settled') THEN
   RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED';
  END IF;
  RETURN QUERY SELECT 'applied'::text,x.topic,NULL::text,'none'::text,NULL::text; RETURN;
 END IF;
 IF x.topic='app/scopes_update' THEN
  -- Expanded as Shopify grants them: write_X implies read_X.
  SELECT COALESCE(array_agg(DISTINCT z.s ORDER BY z.s),'{}') INTO v_scopes FROM (
   SELECT s FROM jsonb_array_elements_text(v_body->'current') s
   UNION SELECT regexp_replace(s,'^(unauthenticated_)?write_','\1read_') FROM jsonb_array_elements_text(v_body->'current') s) z;
  IF v_scopes=ARRAY['read_products','write_products'] THEN
   IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'ignored','scopes_unchanged','{}'::jsonb) NOT IN ('settled','already_settled') THEN
    RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED';
   END IF;
   RETURN QUERY SELECT 'applied'::text,x.topic,x.installation_id,'none'::text,NULL::text; RETURN;
  END IF;
  v_end_reason:='scopes_changed'; v_reason_code:='shopify_scopes_changed'; v_reason:='The Shopify app''s access scopes changed.';
 ELSE
  v_end_reason:='uninstalled'; v_reason_code:='shopify_app_uninstalled'; v_reason:='The Shopify app was uninstalled from the store.';
 END IF;
 SELECT * INTO e FROM morrow_identity.work_shopify_installation_end(x.organization_id,x.workspace_id,x.installation_id,v_end_reason);
 IF e.outcome IS NULL OR e.outcome NOT IN ('applied','unchanged') THEN RAISE EXCEPTION 'CONNECTOR_INSTALLATION_END_REFUSED'; END IF;
 -- The system connection stop (spine §10), under the store's stop interlock (0020), once
 -- per connection: an active stop (a person's disconnect, an earlier delivery) stands.
 PERFORM pg_catalog.set_config('morrow.connector_stop',x.organization_id||'|'||x.workspace_id||'|'||e.store_id||'|'||e.connection_id,true);
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
  x.organization_id,x.workspace_id,e.store_id)::text,0));
 IF EXISTS(SELECT 1 FROM morrow_work.stop_controls s WHERE s.organization_id=x.organization_id AND s.workspace_id=x.workspace_id
   AND s.scope='connection' AND s.store_id=e.store_id AND s.target_id=e.connection_id AND s.lifted_at IS NULL) THEN
  v_stop:='already_stopped';
 ELSE
  v_stop_id:=gen_random_uuid()::text;
  v_at:=morrow_work.db_now();
  INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,
   set_by_membership_id,set_by_operator_id,reason_code,reason,created_at)
  VALUES (x.organization_id,x.workspace_id,v_stop_id,'connection',e.store_id,e.connection_id,'system',NULL,NULL,NULL,v_reason_code,v_reason,v_at);
  INSERT INTO morrow_work.stop_records(organization_id,workspace_id,id,stop_control_id,action,scope,store_id,target_id,actor_kind,
   operator_id,reason_code,reason,recorded_at)
  VALUES (x.organization_id,x.workspace_id,gen_random_uuid()::text,v_stop_id,'set','connection',e.store_id,e.connection_id,'system',NULL,
   v_reason_code,v_reason,v_at);
  v_stop:='set';
 END IF;
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true);
 IF x.topic<>'shop/redact' THEN
  IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'applied',v_end_reason,jsonb_build_object('installation',
    CASE WHEN e.outcome='applied' THEN e.status ELSE 'unchanged' END,'stop',v_stop))
   NOT IN ('settled','already_settled') THEN RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED'; END IF;
  RETURN QUERY SELECT 'applied'::text,x.topic,x.installation_id,CASE WHEN x.credential_destroyed THEN 'destroyed' ELSE 'pending' END,e.end_reason;
  RETURN;
 END IF;
 -- shop/redact: the store's content (work schema), then its identity.
 PERFORM pg_catalog.set_config('morrow.connector_redact',x.organization_id||'|'||x.workspace_id||'|'||e.store_id,true);
 v_content:=morrow_work.store_content_redact(x.organization_id,x.workspace_id,e.store_id);
 PERFORM pg_catalog.set_config('morrow.connector_redact','',true);
 SELECT * INTO v_identity FROM morrow_identity.work_shopify_redact_identity(x.organization_id,x.workspace_id,x.installation_id);
 IF v_identity.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CONNECTOR_IDENTITY_REDACT_REFUSED'; END IF;
 SELECT COALESCE(jsonb_agg(c-'remaining' ORDER BY c->>'table'),'[]'::jsonb),
  COALESCE(jsonb_agg(c->'table' ORDER BY c->>'table') FILTER (WHERE (c->>'remaining')::bigint>0),'[]'::jsonb)
  INTO v_handlers,v_outstanding FROM jsonb_array_elements(v_content) c;
 v_handlers:=v_handlers||jsonb_build_array(
  jsonb_build_object('table','morrow_identity.linking_candidates','action','pseudonymise','rows',v_identity.candidates),
  jsonb_build_object('table','morrow_identity.shopify_apps','action','clear_install_link','rows',v_identity.apps),
  jsonb_build_object('table','morrow_identity.store_installations','action','pseudonymise','rows',v_identity.installations));
 IF x.credential_destroyed THEN
  v_handlers:=jsonb_build_array(jsonb_build_object('table','morrow_vault.credentials','action','destroy_credential',
   'rows',x.credential_version))||v_handlers;
 ELSE
  v_outstanding:=v_outstanding||'["morrow_vault.credentials"]'::jsonb;
 END IF;
 IF v_outstanding<>'[]'::jsonb THEN
  RETURN QUERY SELECT 'pending'::text,x.topic,x.installation_id,CASE WHEN x.credential_destroyed THEN 'destroyed' ELSE 'pending' END,e.end_reason;
  RETURN;
 END IF;
 v_evidence:=jsonb_build_object('schemaVersion',1,'kind','shop_redacted','scopes','["read_products","write_products"]'::jsonb,
  'handlers',v_handlers,'credential','destroyed','outstanding','[]'::jsonb);
 v_completed:=morrow_identity.work_privacy_request_complete(x.organization_id,x.workspace_id,p_inbox_id,v_evidence);
 IF v_completed NOT IN ('completed','already_completed') THEN RAISE EXCEPTION 'CONNECTOR_PRIVACY_REFUSED'; END IF;
 IF morrow_identity.work_shopify_inbox_settle(p_inbox_id,'applied','shop_redacted',jsonb_build_object('installation',
   CASE WHEN e.outcome='applied' THEN e.status ELSE 'unchanged' END,'stop',v_stop,'request','completed'))
  NOT IN ('settled','already_settled') THEN RAISE EXCEPTION 'CONNECTOR_SETTLE_REFUSED'; END IF;
 RETURN QUERY SELECT 'applied'::text,x.topic,x.installation_id,'destroyed'::text,e.end_reason;
END $$;
-- The connector's cron re-drive (spine §5's pending_starts pattern): the ids of inbox rows
-- still received two minutes after they arrived, at most 20. Ids only, content-free.
CREATE FUNCTION morrow_work.connector_inbox_pending()
RETURNS TABLE(inbox_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN RETURN; END IF;
 RETURN QUERY SELECT p.inbox_id FROM morrow_identity.work_shopify_inbox_pending() p;
END $$;
-- The connector's credential re-drive (review finding B7): installations that record an
-- end whose token's destruction is not yet recorded, with the reason the row records, at
-- most 20. Ids only, content-free.
CREATE FUNCTION morrow_work.connector_credentials_pending()
RETURNS TABLE(installation_id text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 PERFORM pg_catalog.set_config('morrow.connector_stop','',true),pg_catalog.set_config('morrow.connector_redact','',true);
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN RETURN; END IF;
 RETURN QUERY SELECT p.installation_id,p.reason FROM morrow_identity.work_shopify_credentials_pending() p;
END $$;

-- ---------------------------------------------------------------------------
-- The vault definers: SECURITY DEFINER, owned by the command role after the transfer,
-- EXECUTE for morrow_vault_broker only.
-- The webhook record, in the broker's transaction that read the app secret and verified
-- the signature over the raw body. Outcomes: recorded, duplicate (with settled), not_found,
-- invalid, denied.
CREATE FUNCTION morrow_vault.shopify_webhook_record(p_app_key text,p_shop_domain text,p_topic text,p_webhook_id text,
 p_api_version text,p_body text)
RETURNS TABLE(outcome text,inbox_id text,settled text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE r record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO r FROM morrow_identity.work_shopify_webhook_record(p_app_key,p_shop_domain,p_topic,p_webhook_id,p_api_version,p_body);
 RETURN QUERY SELECT COALESCE(r.outcome,'invalid'),r.inbox_id,r.settled;
END $$;
-- Destroys a store installation's offline token (ADR-0022 item 13), only when its row
-- records the end the caller names (0034 work_shopify_credential_end), and records the
-- destruction on the installation in this same transaction, so a token is never left
-- live for an ended installation without the re-drive seeing it. Every active version
-- whose subject is the installation is erased (the subject the envelope binds), whatever
-- its credential id. Idempotent. Outcomes: destroyed, already_destroyed, ineligible,
-- not_found, invalid, denied.
CREATE FUNCTION morrow_vault.shopify_credential_destroy(p_installation_id text,p_reason text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
DECLARE r record; n integer; v_at timestamptz:=date_trunc('milliseconds',clock_timestamp());
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN 'denied'; END IF;
 SELECT * INTO r FROM morrow_identity.work_shopify_credential_end(p_installation_id,p_reason);
 IF r.outcome IS DISTINCT FROM 'recorded' THEN RETURN COALESCE(r.outcome,'invalid'); END IF;
 UPDATE morrow_vault.credentials c SET status='destroyed',wrapped_key=NULL,sealed_value=NULL,destroyed_at=greatest(v_at,c.created_at),
  destroy_reason=p_reason
  WHERE c.organization_id=r.organization_id AND c.workspace_id=r.workspace_id AND c.subject_id=p_installation_id AND c.status='active';
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN CASE WHEN n>0 THEN 'destroyed' ELSE 'already_destroyed' END;
END $$;
-- The read resolution of shopifyRead (spine §4): resolve_call with the subject the caller
-- names (the read's request id, or the run id), so no other definer reads the lease
-- (0031); the query fitted to the lease (a read lease: shopIdentity, collectionsPage,
-- productsPage; a run lease: productContent, of a product of that run); the store
-- installation that is the active credential's subject (bound into the envelope's
-- additional data), with its shop domain. Outcomes: resolved, invalid, denied,
-- purpose_mismatch, product_not_in_run, and every refusal of resolve_call.
CREATE FUNCTION morrow_vault.shopify_read_resolve(p_lease_id text,p_generation text,p_subject_id text,p_query text,p_product_id text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,lease_kind text,store_id text,connection_id text,installation_id text,
 shop_domain text,credential_id text,credential_version text,kek_version text,wrapped_key text,sealed_value text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; t record; v_refusal text;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN v_refusal:='denied';
 ELSIF p_query IS NULL OR p_query NOT IN ('shopIdentity','collectionsPage','productsPage','productContent')
  OR (p_query='productContent')<>(p_product_id IS NOT NULL)
  OR (p_product_id IS NOT NULL AND p_product_id !~ '^product:[1-9][0-9]{0,19}$') THEN v_refusal:='invalid';
 END IF;
 IF v_refusal IS NULL THEN
  SELECT * INTO r FROM morrow_vault.resolve_call(p_lease_id,p_generation,'shopify_read',p_subject_id);
  IF r.outcome IS DISTINCT FROM 'resolved' THEN v_refusal:=COALESCE(r.outcome,'invalid');
  ELSIF (r.lease_kind='read')=(p_query='productContent') OR r.lease_kind NOT IN ('read','run') THEN v_refusal:='purpose_mismatch';
  ELSIF r.lease_kind='run' AND morrow_work.run_product_readable(r.organization_id,r.workspace_id,r.subject_id,p_product_id) IS NOT TRUE THEN
   v_refusal:='product_not_in_run';
  ELSE
   SELECT * INTO t FROM morrow_identity.work_shopify_read_target(r.organization_id,r.workspace_id,r.store_id,r.connection_id);
   IF t.outcome IS DISTINCT FROM 'found' THEN v_refusal:='connection_inactive';
   ELSIF t.credential_id IS DISTINCT FROM r.credential_id OR NOT EXISTS(SELECT 1 FROM morrow_vault.credentials c
     WHERE c.organization_id=r.organization_id AND c.workspace_id=r.workspace_id AND c.id=r.credential_id
      AND c.version::text=r.credential_version AND c.subject_id=t.installation_id AND c.status='active') THEN
    v_refusal:='credential_unavailable';
   END IF;
  END IF;
 END IF;
 IF v_refusal IS NOT NULL THEN
  RETURN QUERY SELECT v_refusal,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text;
  RETURN;
 END IF;
 RETURN QUERY SELECT 'resolved'::text,r.organization_id,r.workspace_id,r.lease_kind,r.store_id,r.connection_id,t.installation_id,t.shop_domain,
  r.credential_id,r.credential_version,r.kek_version,r.wrapped_key,r.sealed_value;
END $$;

-- ---------------------------------------------------------------------------
-- The api's read lease for one catalogue read (M2 brief: a read lease per call): after
-- the Worker's kernel allowed `view` on catalog.products.read on the store resource, the
-- store's connection must still be the one the kernel saw, then a 60-second read lease
-- opens for the session tenant and actor (lease_open: refused under a connection stop),
-- named by a fresh request id. It grants nothing. Outcomes: opened, ineligible,
-- not_found (no current connection, or another one), stopped, invalid, subject_conflict.
CREATE FUNCTION morrow_work.catalog_read_lease(p_store_id text,p_connection_id text)
RETURNS TABLE(outcome text,lease_id text,generation text,expires_at_ms text,subject_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; l record; v_subject text;
BEGIN
 IF p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_connection_id IS NULL OR p_connection_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_work.listings_store_current(t.organization_id,t.workspace_id,p_store_id) s
   WHERE s.connection_id=p_connection_id) THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_subject:=gen_random_uuid()::text;
 SELECT * INTO l FROM morrow_work.lease_open('read',v_subject,p_store_id,p_connection_id,NULL);
 IF l.outcome IS DISTINCT FROM 'opened' THEN
  RETURN QUERY SELECT COALESCE(l.outcome,'invalid'),NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 RETURN QUERY SELECT 'opened'::text,l.lease_id,l.generation,l.expires_at_ms,v_subject;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.parameters_redact_for_store(text,text,text),morrow_work.store_content_redact(text,text,text),
 morrow_work.run_product_readable(text,text,text,text),morrow_work.connector_inbox_apply(text),morrow_work.connector_inbox_pending(),
 morrow_work.connector_credentials_pending(),morrow_work.catalog_read_lease(text,text),
 morrow_vault.shopify_webhook_record(text,text,text,text,text,text),morrow_vault.shopify_credential_destroy(text,text),
 morrow_vault.shopify_read_resolve(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.parameters_redact_for_store(text,text,text),morrow_work.store_content_redact(text,text,text),
 morrow_work.run_product_readable(text,text,text,text) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_work.connector_inbox_apply(text),morrow_work.connector_inbox_pending(),
 morrow_work.connector_credentials_pending() TO morrow_connector_ingress;
GRANT EXECUTE ON FUNCTION morrow_vault.shopify_webhook_record(text,text,text,text,text,text),
 morrow_vault.shopify_credential_destroy(text,text),morrow_vault.shopify_read_resolve(text,text,text,text,text) TO morrow_vault_broker;
GRANT EXECUTE ON FUNCTION morrow_work.catalog_read_lease(text,text) TO morrow_work_api;
GRANT CREATE ON SCHEMA morrow_work,morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_inbox_apply(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_inbox_pending() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.connector_credentials_pending() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_read_lease(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_webhook_record(text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_credential_destroy(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_read_resolve(text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work,morrow_vault FROM morrow_work_command;
COMMIT;
