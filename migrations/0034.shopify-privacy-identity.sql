BEGIN;
-- M2 PR-3: the identity side of uninstall, the compliance topics and Shopify reads
-- (ADR-0022 items 4, 7, 13-15; mvp-architecture §4, §6 and §11; P09.T04a, P09.T05a).
-- Executes AS morrow_identity_owner, after 0033. It adds:
--   * the webhook inbox (shopify_webhook_inbox: one row per verified delivery, unique by
--     app, shop and webhook id, holding only the minimised body of spine §11; 7 days) and
--     privacy_requests (one per compliance delivery, with its 24-hour target, its 30-day
--     due time and content-free completion evidence; 365 days), each ENABLE and FORCE RLS
--     with the identity_owner policy only, guarded by the replaced shopify_preserve_record;
--   * the end states of a store installation (suspended with a reason, uninstalled), the
--     credential destruction mark and shop/redact's pseudonym (shop_pseudonym, derived from
--     the installation id, never the domain), and linking_candidates.redacted_at, each
--     admitted once by the replaced guards (shopify_preserve_record and 0005's
--     preserve_linking_record);
--   * identity bridges (SECURITY DEFINER, EXECUTE for morrow_work_command only; 0035's
--     vault and connector definers call them): the webhook record, the inbox take, settle
--     and pending ids, the installation end, the identity redaction, the privacy request
--     completion and its overdue counts, the credential end and its pending ids, and the
--     read target;
--   * work_shopify_launch and workspace_connections replaced with the same signatures: a
--     launch reports a suspended or uninstalled installation even after its domain was
--     pseudonymised, and the connections read leaves out redacted installations and offers
--     no install link for an app whose installation has ended (a reinstall under the same
--     app is refused, so reconnecting needs a new app).
-- The tenant always comes from the app registry (the invited workspace) or from the
-- inbox row it named; never from a shop, header, body or caller (invariant 1).
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regclass('morrow_identity.store_installations') IS NULL OR to_regclass('morrow_identity.shopify_apps') IS NULL
 OR to_regclass('morrow_identity.install_continuations') IS NULL OR to_regclass('morrow_identity.linking_candidates') IS NULL
 OR to_regclass('morrow_identity.shopify_webhook_inbox') IS NOT NULL OR to_regclass('morrow_identity.privacy_requests') IS NOT NULL
 OR to_regprocedure('morrow_identity.work_executor_safe(text)') IS NULL
 OR to_regprocedure('morrow_identity.shop_pseudonym(text)') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_identity.store_installations'::regclass
   AND a.attname IN ('suspended_at','suspended_reason','uninstalled_at','credential_destroyed_at','redacted_at') AND NOT a.attisdropped)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_identity.linking_candidates'::regclass
   AND a.attname='redacted_at' AND NOT a.attisdropped)
 -- The four function texts this file replaces, exactly as 0005 and 0026 wrote them (a
 -- missed merge fails here).
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.shopify_preserve_record()'))
  IS DISTINCT FROM '1183df074a85805588e6531f1d6d671a'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.preserve_linking_record()'))
  IS DISTINCT FROM '57085beffc773c522b6b30de7b89252b'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.work_shopify_launch(text,text)'))
  IS DISTINCT FROM '279d564694003d2bd6fcb83900b6b4b7'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.workspace_connections(text,text)'))
  IS DISTINCT FROM 'fadd429d7dbff7675a0e7921f6d337f1'
 THEN RAISE EXCEPTION 'SHOPIFY_PRIVACY_IDENTITY_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pure functions (IMMUTABLE, owned by the identity owner, granted to nobody): the CHECKs
-- and guards of this file call them as the identity owner, the only writer of these
-- tables.
-- shop/redact's pseudonym of a shop domain (spine §11): derived from the installation id,
-- never the domain, so it reveals nothing; it keeps the *.myshopify.com shape that the
-- CHECKs and StoreInstallation@1 require.
CREATE FUNCTION morrow_identity.shop_pseudonym(p_installation_id text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT 'redacted-'||substr(encode(sha256(convert_to('morrow.shopify.redacted.v1|'||p_installation_id,'UTF8')),'hex'),1,24)||'.myshopify.com'
$$;
-- A list of Shopify scope names as app/scopes_update sends them (at most 32).
CREATE FUNCTION morrow_identity.shopify_scope_list_valid(p_list jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_list IS NULL OR jsonb_typeof(p_list)<>'array' OR jsonb_array_length(p_list)>32 THEN RETURN false; END IF;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_list) e WHERE jsonb_typeof(e)<>'string' OR (e#>>'{}') !~ '^[a-z][a-z_]{0,63}$');
END $$;
-- The minimised body of one topic (spine §11; apps/broker/src/shopify.ts minimises it):
-- closed key sets of ids, scope names and a keyed customer digest only, never an email,
-- phone, name, address or order id.
CREATE FUNCTION morrow_identity.shopify_webhook_body_valid(p_topic text,p_body jsonb) RETURNS boolean
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
 IF p_topic='customers/redact' THEN RETURN v_keys=ARRAY['customerDigest','shopId']; END IF;
 RETURN v_keys=ARRAY['customerDigest','dataRequestId','shopId'] AND jsonb_typeof(p_body->'dataRequestId')='string'
  AND (p_body->>'dataRequestId') ~ '^[1-9][0-9]{0,19}$';
END $$;
-- A settled delivery's effects: content-free counts and fixed codes only (at most 16 keys).
CREATE FUNCTION morrow_identity.shopify_webhook_effects_valid(p_effects jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_effects IS NULL OR jsonb_typeof(p_effects)<>'object' THEN RETURN false; END IF;
 RETURN (SELECT count(*) FROM jsonb_object_keys(p_effects))<=16
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(p_effects) e WHERE e.key !~ '^[a-z][a-z_]{0,31}$'
   OR NOT ((jsonb_typeof(e.value)='string' AND (e.value#>>'{}') ~ '^[a-z][a-z_]{0,31}$')
    OR (jsonb_typeof(e.value)='number' AND (e.value#>>'{}') ~ '^(0|[1-9][0-9]{0,8})$')));
END $$;
-- Completion evidence of one privacy request (ADR-0022 items 13-14): content-free, closed.
--   {schemaVersion 1, kind, scopes, handlers [{table, action, rows}], credential, outstanding}
-- customers/* is "none_held" with no handler; shop/redact is "shop_redacted" (or
-- "none_held" when no installation of the app held the shop). outstanding is always empty:
-- a request is never completed while any store content remains.
CREATE FUNCTION morrow_identity.privacy_evidence_valid(p_topic text,p_evidence jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
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
   OR jsonb_typeof(h->'table')<>'string' OR (h->>'table') NOT IN ('morrow_vault.credentials','morrow_identity.linking_candidates',
    'morrow_identity.shopify_apps','morrow_identity.store_installations','morrow_work.proposal_parameters',
    'morrow_work.product_snapshots','morrow_work.run_drafts')
   OR jsonb_typeof(h->'action')<>'string' OR (h->>'action') NOT IN ('destroy_credential','empty_keep_digest','delete_rows',
    'pseudonymise','clear_install_link')
   OR jsonb_typeof(h->'rows')<>'number' OR (h->>'rows') !~ '^(0|[1-9][0-9]{0,8})$') THEN RETURN false; END IF;
 IF p_topic IN ('customers/data_request','customers/redact') THEN
  RETURN p_evidence->>'kind'='none_held' AND p_evidence->'handlers'='[]'::jsonb AND p_evidence->>'credential'='none';
 END IF;
 IF p_topic='shop/redact' THEN
  RETURN (p_evidence->>'kind'='shop_redacted' AND p_evidence->>'credential'<>'none')
   OR (p_evidence->>'kind'='none_held' AND p_evidence->'handlers'='[]'::jsonb AND p_evidence->>'credential'='none');
 END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.shop_pseudonym(text),morrow_identity.shopify_scope_list_valid(jsonb),
 morrow_identity.shopify_webhook_body_valid(text,jsonb),morrow_identity.shopify_webhook_effects_valid(jsonb),
 morrow_identity.privacy_evidence_valid(text,jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The webhook inbox (spine §6 and §11; ADR-0022 item 13): one row per verified delivery,
-- recorded by the broker in the transaction that verified its signature (no connector
-- login writes one). The tenant is the registry's invited workspace of the app that
-- signed it; the installation is found from the verified shop facts. Born received; one
-- change, received -> applied or ignored, with content-free effects. 7 days (the purge is
-- M6's, P09.T05; it must skip a row whose privacy request is still open, which the
-- applier still needs).
CREATE TABLE morrow_identity.shopify_webhook_inbox (
 id morrow_identity.record_id PRIMARY KEY CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 app_key text NOT NULL REFERENCES morrow_identity.shopify_apps(app_key),
 organization_id morrow_identity.record_id NOT NULL,
 workspace_id morrow_identity.record_id NOT NULL,
 shop_digest text NOT NULL CHECK (shop_digest ~ '^[a-f0-9]{64}$'),
 installation_id morrow_identity.record_id,
 topic text NOT NULL CHECK (topic IN ('app/uninstalled','app/scopes_update','customers/data_request','customers/redact','shop/redact')),
 webhook_id text NOT NULL CHECK (webhook_id ~ '^[A-Za-z0-9-]{1,128}$'),
 api_version text NOT NULL CHECK (api_version ~ '^([0-9]{4}-[0-9]{2}|unstable)$'),
 body jsonb NOT NULL CHECK (morrow_identity.shopify_webhook_body_valid(topic,body)),
 received_at timestamptz NOT NULL CHECK (received_at=date_trunc('milliseconds',received_at) AND isfinite(received_at)),
 expires_at timestamptz NOT NULL,
 status text NOT NULL CHECK (status IN ('received','applied','ignored')),
 settled_at timestamptz CHECK (settled_at=date_trunc('milliseconds',settled_at) AND isfinite(settled_at)),
 outcome text CHECK (outcome ~ '^[a-z][a-z0-9_]{2,63}$'),
 effects jsonb CHECK (effects IS NULL OR morrow_identity.shopify_webhook_effects_valid(effects)),
 UNIQUE (app_key,shop_digest,webhook_id),
 FOREIGN KEY (app_key,organization_id,workspace_id)
  REFERENCES morrow_identity.shopify_apps(app_key,invited_organization_id,invited_workspace_id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_identity.store_installations(organization_id,workspace_id,id),
 CHECK (expires_at=received_at+interval '7 days'),
 CHECK ((status='received')=(settled_at IS NULL) AND (status='received')=(outcome IS NULL) AND (status='received')=(effects IS NULL)
  AND (settled_at IS NULL OR settled_at>=received_at))
);
CREATE INDEX shopify_webhook_inbox_received ON morrow_identity.shopify_webhook_inbox (received_at,id) WHERE status='received';
-- One privacy request per compliance delivery (ADR-0022 item 14): customers/* are answered
-- "no customer data held"; shop/redact completes within 24 hours (target_at) and at most
-- 30 days (due_at). No customer digest is kept here (it lives only in the 7-day inbox).
-- inbox_id and webhook_id are plain ids, so the inbox purge never touches this record.
-- Born open; one change, open -> completed with its evidence. 365 days, content-free.
CREATE TABLE morrow_identity.privacy_requests (
 organization_id morrow_identity.record_id NOT NULL,
 workspace_id morrow_identity.record_id NOT NULL,
 id morrow_identity.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 app_key text NOT NULL,
 installation_id morrow_identity.record_id,
 inbox_id text NOT NULL UNIQUE CHECK (inbox_id ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 webhook_id text NOT NULL CHECK (webhook_id ~ '^[A-Za-z0-9-]{1,128}$'),
 topic text NOT NULL CHECK (topic IN ('customers/data_request','customers/redact','shop/redact')),
 shop_id text NOT NULL CHECK (shop_id ~ '^[1-9][0-9]{0,19}$'),
 data_request_id text CHECK (data_request_id ~ '^[1-9][0-9]{0,19}$'),
 received_at timestamptz NOT NULL CHECK (received_at=date_trunc('milliseconds',received_at) AND isfinite(received_at)),
 target_at timestamptz NOT NULL,
 due_at timestamptz NOT NULL,
 status text NOT NULL CHECK (status IN ('open','completed')),
 completed_at timestamptz CHECK (completed_at=date_trunc('milliseconds',completed_at) AND isfinite(completed_at)),
 evidence jsonb CHECK (evidence IS NULL OR morrow_identity.privacy_evidence_valid(topic,evidence)),
 evidence_digest text CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (app_key,organization_id,workspace_id)
  REFERENCES morrow_identity.shopify_apps(app_key,invited_organization_id,invited_workspace_id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_identity.store_installations(organization_id,workspace_id,id),
 CHECK ((topic='customers/data_request')=(data_request_id IS NOT NULL)),
 CHECK (target_at=received_at+CASE WHEN topic='shop/redact' THEN interval '24 hours' ELSE interval '0' END),
 CHECK (due_at=received_at+interval '30 days'),
 CHECK ((status='completed')=(completed_at IS NOT NULL) AND (status='completed')=(evidence IS NOT NULL)
  AND (evidence IS NULL)=(evidence_digest IS NULL) AND (completed_at IS NULL OR completed_at>=received_at)
  AND (evidence IS NULL OR evidence_digest=encode(sha256(convert_to(evidence::text,'UTF8')),'hex')))
);
-- One request per Shopify data request id of an app (a redelivery under another webhook
-- id answers the same request).
CREATE UNIQUE INDEX privacy_requests_one_data_request ON morrow_identity.privacy_requests (app_key,topic,data_request_id)
 WHERE data_request_id IS NOT NULL;
CREATE INDEX privacy_requests_open ON morrow_identity.privacy_requests (target_at,id) WHERE status='open';
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['shopify_webhook_inbox','privacy_requests'] LOOP
  EXECUTE format('ALTER TABLE morrow_identity.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_identity.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY identity_owner ON morrow_identity.%I TO morrow_identity_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON morrow_identity.%I FROM PUBLIC',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- The end states of a store installation (StoreInstallation@1 suspended and uninstalled;
-- spine §11): suspended with its reason (a human disconnect or a scope change), or
-- uninstalled (app/uninstalled, or shop/redact before the uninstall arrived); the time the
-- offline token's destruction was recorded, in the vault transaction that erased it; and
-- shop/redact's redaction, which replaces the domain with shop_pseudonym(id) and keeps
-- every id.
ALTER TABLE morrow_identity.store_installations
 ADD COLUMN suspended_at timestamptz CHECK (suspended_at=date_trunc('milliseconds',suspended_at) AND isfinite(suspended_at)),
 ADD COLUMN suspended_reason text CHECK (suspended_reason IN ('disconnected','scopes_changed')),
 ADD COLUMN uninstalled_at timestamptz CHECK (uninstalled_at=date_trunc('milliseconds',uninstalled_at) AND isfinite(uninstalled_at)),
 ADD COLUMN credential_destroyed_at timestamptz
  CHECK (credential_destroyed_at=date_trunc('milliseconds',credential_destroyed_at) AND isfinite(credential_destroyed_at)),
 ADD COLUMN redacted_at timestamptz CHECK (redacted_at=date_trunc('milliseconds',redacted_at) AND isfinite(redacted_at)),
 ADD CONSTRAINT store_installations_end CHECK ((suspended_at IS NULL)=(suspended_reason IS NULL)
  AND (status<>'suspended' OR suspended_at IS NOT NULL) AND (status IN ('suspended','uninstalled') OR suspended_at IS NULL)
  AND (status='uninstalled')=(uninstalled_at IS NOT NULL)
  AND (credential_destroyed_at IS NULL OR status IN ('suspended','uninstalled'))
  AND (redacted_at IS NULL OR (status='uninstalled' AND shop_domain=morrow_identity.shop_pseudonym(id::text)))
  AND (suspended_at IS NULL OR suspended_at>=created_at) AND (uninstalled_at IS NULL OR uninstalled_at>=created_at)
  AND (credential_destroyed_at IS NULL OR credential_destroyed_at>=created_at) AND (redacted_at IS NULL OR redacted_at>=created_at));
CREATE INDEX store_installations_credential_pending ON morrow_identity.store_installations (updated_at,id)
 WHERE status IN ('suspended','uninstalled') AND credential_destroyed_at IS NULL;
ALTER TABLE morrow_identity.linking_candidates
 ADD COLUMN redacted_at timestamptz CHECK (redacted_at IS NULL OR (isfinite(redacted_at)
  AND shop_domain=morrow_identity.shop_pseudonym(installation_id::text) AND proof_revoked_at IS NOT NULL));

-- The guard of the six Shopify tables (INVOKER, owned by the identity owner, granted to
-- nobody), replacing 0026's with every rule kept, plus:
--   * store_installations: born with no end state; the PR-2 changes (a re-authorisation
--     with the next credential version, unlinked -> linked with its link) only while
--     unlinked or linked and never touching the domain or the end columns; and, each once
--     at revision+1 with nothing else changing: unlinked|linked -> suspended (with its
--     reason), unlinked|linked|suspended -> uninstalled, the credential destruction mark
--     (suspended or uninstalled only), and the redaction (uninstalled only), which
--     replaces the domain with the installation's pseudonym;
--   * shopify_webhook_inbox: born received; one change, received -> applied or ignored;
--   * privacy_requests: born open; one change, open -> completed with its evidence.
-- No row of any of them is deleted or truncated.
CREATE OR REPLACE FUNCTION morrow_identity.shopify_preserve_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE v_fixed text[]; v_end text[]; v_new jsonb; v_old jsonb;
BEGIN
 -- One branch per table: PL/pgSQL resolves every NEW field an expression names.
 IF TG_OP='INSERT' THEN
  IF TG_TABLE_NAME='shopify_apps' THEN
   IF NEW.status='active' AND NEW.revision=1 AND NEW.retired_at IS NULL AND NEW.install_url IS NOT NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='shopify_oauth_states' THEN
   IF NEW.claimed_at IS NULL AND NEW.installation_id IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='store_installations' THEN
   IF NEW.status='unlinked' AND NEW.revision=1 AND NEW.generation=1 AND NEW.link_id IS NULL AND NEW.linked_at IS NULL
    AND NEW.reauthorised_at IS NULL AND NEW.credential_version=1 AND NEW.updated_at=NEW.created_at
    AND NEW.suspended_at IS NULL AND NEW.suspended_reason IS NULL AND NEW.uninstalled_at IS NULL
    AND NEW.credential_destroyed_at IS NULL AND NEW.redacted_at IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='install_continuations' THEN
   IF NEW.consumed_at IS NULL AND NEW.superseded_at IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='shopify_webhook_inbox' THEN
   IF NEW.status='received' AND NEW.settled_at IS NULL AND NEW.outcome IS NULL AND NEW.effects IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='privacy_requests' THEN
   IF NEW.status='open' AND NEW.completed_at IS NULL AND NEW.evidence IS NULL AND NEW.evidence_digest IS NULL THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'SHOPIFY_RECORD_INVALID';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='shopify_apps' THEN
   IF OLD.status='active' AND NEW.status='retired' AND NEW.revision=OLD.revision+1 AND NEW.retired_at IS NOT NULL
    AND (NEW.install_url IS NULL OR NEW.install_url=OLD.install_url)
    AND (to_jsonb(NEW)-ARRAY['status','revision','retired_at','install_url'])=(to_jsonb(OLD)-ARRAY['status','revision','retired_at','install_url']) THEN RETURN NEW; END IF;
   IF OLD.install_url IS NOT NULL AND NEW.install_url IS NULL AND NEW.revision=OLD.revision+1
    AND (to_jsonb(NEW)-ARRAY['install_url','revision'])=(to_jsonb(OLD)-ARRAY['install_url','revision']) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='shopify_oauth_states' THEN
   IF OLD.claimed_at IS NULL AND NEW.claimed_at IS NOT NULL AND NEW.installation_id IS NULL
    AND (to_jsonb(NEW)-'claimed_at')=(to_jsonb(OLD)-'claimed_at') THEN RETURN NEW; END IF;
   IF OLD.claimed_at IS NOT NULL AND OLD.installation_id IS NULL AND NEW.installation_id IS NOT NULL
    AND (to_jsonb(NEW)-'installation_id')=(to_jsonb(OLD)-'installation_id') THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='store_installations' THEN
   v_fixed:=ARRAY['organization_id','workspace_id','id','app_key','shop_id','store_id','connection_id',
    'generation','credential_id','created_at'];
   v_end:=ARRAY['suspended_at','suspended_reason','uninstalled_at','credential_destroyed_at','redacted_at'];
   v_new:=to_jsonb(NEW);
   v_old:=to_jsonb(OLD);
   IF (SELECT jsonb_object_agg(k,v_new->k) FROM unnest(v_fixed) k)=(SELECT jsonb_object_agg(k,v_old->k) FROM unnest(v_fixed) k)
    AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at THEN
    -- The PR-2 changes, while unlinked or linked only; the domain and end columns fixed.
    IF OLD.status IN ('unlinked','linked') AND NEW.shop_domain=OLD.shop_domain
     AND (SELECT jsonb_object_agg(k,v_new->k) FROM unnest(v_end) k)=(SELECT jsonb_object_agg(k,v_old->k) FROM unnest(v_end) k)
     -- Scopes, the development flag and the re-authorisation time change only with the
     -- next credential version.
     AND ((NEW.credential_version=OLD.credential_version AND NEW.reauthorised_at IS NOT DISTINCT FROM OLD.reauthorised_at
       AND NEW.granted_scopes=OLD.granted_scopes AND NEW.development_store=OLD.development_store)
      OR (NEW.credential_version=OLD.credential_version+1 AND NEW.reauthorised_at IS NOT NULL AND NEW.status=OLD.status))
     AND (NEW.status=OLD.status
      OR (OLD.status='unlinked' AND NEW.status='linked' AND NEW.link_id IS NOT NULL AND OLD.link_id IS NULL AND NEW.credential_version=OLD.credential_version))
     AND (NEW.link_id IS NOT DISTINCT FROM OLD.link_id OR (OLD.link_id IS NULL AND NEW.status='linked'))
     AND (NEW.linked_at IS NOT DISTINCT FROM OLD.linked_at OR (OLD.linked_at IS NULL AND NEW.status='linked')) THEN RETURN NEW; END IF;
    -- The PR-3 end states: only the status, the domain and the end columns may change.
    IF (v_new-v_end-ARRAY['status','shop_domain','revision','updated_at'])=(v_old-v_end-ARRAY['status','shop_domain','revision','updated_at']) THEN
     -- unlinked|linked -> suspended, with its reason.
     IF OLD.status IN ('unlinked','linked') AND NEW.status='suspended' AND OLD.suspended_at IS NULL AND NEW.suspended_at IS NOT NULL
      AND NEW.suspended_reason IS NOT NULL AND NEW.shop_domain=OLD.shop_domain AND NEW.uninstalled_at IS NULL
      AND NEW.credential_destroyed_at IS NULL AND NEW.redacted_at IS NULL AND OLD.credential_destroyed_at IS NULL THEN RETURN NEW; END IF;
     -- unlinked|linked|suspended -> uninstalled.
     IF OLD.status IN ('unlinked','linked','suspended') AND NEW.status='uninstalled' AND NEW.uninstalled_at IS NOT NULL
      AND NEW.suspended_at IS NOT DISTINCT FROM OLD.suspended_at AND NEW.suspended_reason IS NOT DISTINCT FROM OLD.suspended_reason
      AND NEW.credential_destroyed_at IS NOT DISTINCT FROM OLD.credential_destroyed_at AND NEW.shop_domain=OLD.shop_domain
      AND NEW.redacted_at IS NULL THEN RETURN NEW; END IF;
     -- The credential destruction mark, once, while suspended or uninstalled.
     IF OLD.status IN ('suspended','uninstalled') AND NEW.status=OLD.status AND OLD.credential_destroyed_at IS NULL
      AND NEW.credential_destroyed_at IS NOT NULL AND NEW.shop_domain=OLD.shop_domain
      AND (v_new-'credential_destroyed_at'-ARRAY['revision','updated_at'])=(v_old-'credential_destroyed_at'-ARRAY['revision','updated_at']) THEN RETURN NEW; END IF;
     -- shop/redact, once, while uninstalled: the domain becomes the pseudonym.
     IF OLD.status='uninstalled' AND NEW.status='uninstalled' AND OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL
      AND NEW.shop_domain=morrow_identity.shop_pseudonym(OLD.id::text)
      AND (v_new-ARRAY['shop_domain','redacted_at','revision','updated_at'])=(v_old-ARRAY['shop_domain','redacted_at','revision','updated_at']) THEN RETURN NEW; END IF;
    END IF;
   END IF;
  ELSIF TG_TABLE_NAME='install_continuations' THEN
   IF OLD.consumed_at IS NULL AND OLD.superseded_at IS NULL
    AND ((NEW.consumed_at IS NOT NULL AND NEW.superseded_at IS NULL
      AND (to_jsonb(NEW)-ARRAY['consumed_at','consumed_principal_id','consumed_handoff_id'])=(to_jsonb(OLD)-ARRAY['consumed_at','consumed_principal_id','consumed_handoff_id']))
     OR (NEW.superseded_at IS NOT NULL AND NEW.consumed_at IS NULL
      AND (to_jsonb(NEW)-'superseded_at')=(to_jsonb(OLD)-'superseded_at'))) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='shopify_webhook_inbox' THEN
   IF OLD.status='received' AND NEW.status IN ('applied','ignored') AND NEW.settled_at IS NOT NULL AND NEW.outcome IS NOT NULL
    AND NEW.effects IS NOT NULL
    AND (to_jsonb(NEW)-ARRAY['status','settled_at','outcome','effects'])=(to_jsonb(OLD)-ARRAY['status','settled_at','outcome','effects']) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='privacy_requests' THEN
   IF OLD.status='open' AND NEW.status='completed' AND NEW.completed_at IS NOT NULL AND NEW.evidence IS NOT NULL
    AND NEW.evidence_digest IS NOT NULL
    AND (to_jsonb(NEW)-ARRAY['status','completed_at','evidence','evidence_digest'])=(to_jsonb(OLD)-ARRAY['status','completed_at','evidence','evidence_digest']) THEN RETURN NEW; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'SHOPIFY_RECORD_IMMUTABLE';
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['shopify_webhook_inbox','privacy_requests'] LOOP
  EXECUTE format('CREATE TRIGGER shopify_record_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_identity.%I FOR EACH ROW EXECUTE FUNCTION morrow_identity.shopify_preserve_record()',t);
  EXECUTE format('CREATE TRIGGER shopify_record_no_truncate BEFORE TRUNCATE ON morrow_identity.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity.shopify_preserve_record()',t);
 END LOOP;
END $$;
-- 0005's linking guard with every rule kept, plus the candidate's redaction: shop/redact
-- replaces its domain with its installation's pseudonym once, with the proof revoked; a
-- redacted candidate never changes again.
CREATE OR REPLACE FUNCTION morrow_identity.preserve_linking_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='linking_handoffs' THEN
      IF OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND(to_jsonb(OLD)-'consumed_at')=(to_jsonb(NEW)-'consumed_at') THEN RETURN NEW; END IF;
    END IF;
    IF TG_TABLE_NAME='linking_reviews' THEN
      IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND(to_jsonb(OLD)-'revoked_at')=(to_jsonb(NEW)-'revoked_at') THEN RETURN NEW; END IF;
    END IF;
    IF TG_TABLE_NAME='linking_candidates' THEN
      IF NEW.id=OLD.id AND NEW.provider_id=OLD.provider_id AND NEW.application_id=OLD.application_id AND NEW.environment_id=OLD.environment_id
        AND NEW.shop_id=OLD.shop_id AND NEW.shop_domain=OLD.shop_domain AND OLD.redacted_at IS NULL AND NEW.redacted_at IS NULL THEN RETURN NEW; END IF;
      IF OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.proof_revoked_at IS NOT NULL
        AND NEW.shop_domain=morrow_identity.shop_pseudonym(OLD.installation_id::text)
        AND (to_jsonb(NEW)-ARRAY['shop_domain','redacted_at','proof_revoked_at'])=(to_jsonb(OLD)-ARRAY['shop_domain','redacted_at','proof_revoked_at'])
        THEN RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'LINKING_RECORD_IMMUTABLE';
END $$;

-- ---------------------------------------------------------------------------
-- The identity bridges: definers owned by the identity owner, EXECUTE for
-- morrow_work_command only. 0035's vault definers (the broker's own login) and connector
-- definers (the connector's login) call them; each takes ids, verified shop facts or the
-- tenant its caller read from a row, never a value from a client.
-- The webhook record (the broker's verifying transaction, after the signature over the raw
-- body passed). The app is the one whose secret signed the body, active or retired (a
-- compliance topic may arrive after retirement), and only for its own intended shop; its
-- invited workspace is the tenant. The installation is found by the app and the body's shop
-- id (by the app and the domain for app/scopes_update, whose body names no shop). The row
-- is inserted once per (app, shop, webhook id); a compliance topic also records its privacy
-- request in the same statement set. Outcomes: recorded, duplicate (with whether the first
-- delivery is settled), not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_webhook_record(p_app_key text,p_shop_domain text,p_topic text,p_webhook_id text,
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
  OR p_body IS NULL OR octet_length(p_body)>4096 OR NOT pg_input_is_valid(p_body,'jsonb') THEN
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
   WHERE x.app_key=p_app_key AND x.shop_domain=p_shop_domain AND x.redacted_at IS NULL;
 ELSE
  SELECT x.id::text INTO v_installation FROM morrow_identity.store_installations x
   WHERE x.app_key=p_app_key AND x.shop_id=v_body->>'shopId' AND (x.shop_domain=p_shop_domain OR x.redacted_at IS NOT NULL);
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
-- One inbox row for its applier, locked: the tenant it names, its installation's store,
-- connection and state, its topic, minimised body and status, and its privacy request.
-- Outcomes: found, not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_inbox_take(p_inbox_id text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,app_key text,installation_id text,store_id text,connection_id text,
 topic text,body text,status text,installation_status text,credential_destroyed boolean,credential_version bigint,request_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE x morrow_identity.shopify_webhook_inbox%ROWTYPE; i morrow_identity.store_installations%ROWTYPE; v_request text;
BEGIN
 IF p_inbox_id IS NULL OR p_inbox_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::boolean,NULL::bigint,NULL::text; RETURN;
 END IF;
 SELECT * INTO x FROM morrow_identity.shopify_webhook_inbox w WHERE w.id=p_inbox_id FOR UPDATE;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::boolean,NULL::bigint,NULL::text; RETURN;
 END IF;
 IF x.installation_id IS NOT NULL THEN
  SELECT * INTO i FROM morrow_identity.store_installations s
   WHERE s.organization_id=x.organization_id AND s.workspace_id=x.workspace_id AND s.id=x.installation_id;
 END IF;
 SELECT r.status INTO v_request FROM morrow_identity.privacy_requests r
  WHERE r.organization_id=x.organization_id AND r.workspace_id=x.workspace_id AND r.inbox_id=x.id::text;
 RETURN QUERY SELECT 'found'::text,x.organization_id::text,x.workspace_id::text,x.app_key,x.installation_id::text,i.store_id::text,
  i.connection_id::text,x.topic,x.body::text,x.status,i.status,i.credential_destroyed_at IS NOT NULL,i.credential_version::bigint,v_request;
END $$;
-- Settles one received inbox row with its content-free effects. Outcomes: settled,
-- already_settled, not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_inbox_settle(p_inbox_id text,p_status text,p_outcome text,p_effects jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE x morrow_identity.shopify_webhook_inbox%ROWTYPE;
BEGIN
 IF p_inbox_id IS NULL OR p_inbox_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_status IS NULL OR p_status NOT IN ('applied','ignored')
  OR p_outcome IS NULL OR p_outcome !~ '^[a-z][a-z0-9_]{2,63}$' OR NOT morrow_identity.shopify_webhook_effects_valid(p_effects) THEN
  RETURN 'invalid';
 END IF;
 SELECT * INTO x FROM morrow_identity.shopify_webhook_inbox w WHERE w.id=p_inbox_id FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 IF x.status<>'received' THEN RETURN 'already_settled'; END IF;
 UPDATE morrow_identity.shopify_webhook_inbox w SET status=p_status,outcome=p_outcome,effects=p_effects,
  settled_at=greatest(date_trunc('milliseconds',clock_timestamp()),w.received_at)
  WHERE w.id=p_inbox_id;
 RETURN 'settled';
END $$;
-- The cross-tenant re-drive (the pending_starts pattern): the ids of inbox rows still
-- received two minutes after they arrived, oldest first, at most 20. Ids only.
CREATE FUNCTION morrow_identity.work_shopify_inbox_pending()
RETURNS TABLE(inbox_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT x.id::text FROM morrow_identity.shopify_webhook_inbox x
 WHERE x.status='received' AND x.received_at<pg_catalog.clock_timestamp()-interval '2 minutes'
 ORDER BY x.received_at,x.id LIMIT 20
$$;
-- Ends one installation: app/uninstalled (and shop/redact before it) makes it uninstalled;
-- a scope change or a human disconnect suspends it with that reason. It takes the
-- per-shop install lock (0026's install record and prepare take it too), so it is
-- serialised with a re-authorisation of the same shop, and it is idempotent: an end state
-- is never left or repeated (an uninstall of a suspended installation still uninstalls
-- it). Every open handoff of the installation then fails (its candidate's proof is revoked)
-- and every open continuation is superseded. Outcomes: applied, unchanged (with the prior
-- status), not_found, invalid; with the end reason the row now records (uninstalled, or
-- the suspension's reason), which the token's destruction must name.
CREATE FUNCTION morrow_identity.work_shopify_installation_end(p_org text,p_ws text,p_installation_id text,p_reason text)
RETURNS TABLE(outcome text,prior_status text,status text,store_id text,connection_id text,end_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE i morrow_identity.store_installations%ROWTYPE; v_shop text; v_at timestamptz; v_outcome text:='unchanged'; v_prior text;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_reason IS NULL OR p_reason NOT IN ('uninstalled','scopes_changed','disconnected') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.shop_id INTO v_shop FROM morrow_identity.store_installations x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_installation_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.shopify_install',v_shop)::text,0));
 SELECT * INTO i FROM morrow_identity.store_installations x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_installation_id FOR UPDATE;
 v_at:=greatest(date_trunc('milliseconds',clock_timestamp()),i.updated_at);
 v_prior:=i.status;
 IF p_reason='uninstalled' AND i.status<>'uninstalled' THEN
  UPDATE morrow_identity.store_installations x SET status='uninstalled',uninstalled_at=v_at,revision=x.revision+1,updated_at=v_at
   WHERE x.organization_id=i.organization_id AND x.workspace_id=i.workspace_id AND x.id=i.id;
  v_outcome:='applied';
 ELSIF p_reason<>'uninstalled' AND i.status IN ('unlinked','linked') THEN
  UPDATE morrow_identity.store_installations x SET status='suspended',suspended_at=v_at,suspended_reason=p_reason,revision=x.revision+1,
   updated_at=v_at WHERE x.organization_id=i.organization_id AND x.workspace_id=i.workspace_id AND x.id=i.id;
  v_outcome:='applied';
 END IF;
 UPDATE morrow_identity.linking_candidates c SET proof_revoked_at=v_at
  WHERE c.installation_id=i.id AND c.proof_revoked_at IS NULL AND c.redacted_at IS NULL;
 UPDATE morrow_identity.install_continuations k SET superseded_at=greatest(v_at,k.created_at)
  WHERE k.organization_id=i.organization_id AND k.workspace_id=i.workspace_id AND k.installation_id=i.id
   AND k.consumed_at IS NULL AND k.superseded_at IS NULL;
 SELECT * INTO i FROM morrow_identity.store_installations x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_installation_id;
 RETURN QUERY SELECT v_outcome,v_prior,i.status,i.store_id::text,i.connection_id::text,
  CASE WHEN i.status='uninstalled' THEN 'uninstalled' ELSE i.suspended_reason END;
END $$;
-- shop/redact's identity handlers (spine §11), on an uninstalled installation only: the
-- installation's and its candidate's domain become the pseudonym (ids kept), and the
-- install link of the installation's own app (its app key, inviting this tenant) is
-- cleared. Shopify's shop/redact covers what Morrow holds through that app only: an app
-- registered later for the same shop, which may invite another tenant, keeps its link and
-- is not counted (review finding: a redaction writes only the tenant the event names).
-- Idempotent; the counts are of the rows now in the redacted state, so a re-run reports
-- the same evidence. Outcomes: applied, ineligible (not uninstalled), not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_redact_identity(p_org text,p_ws text,p_installation_id text)
RETURNS TABLE(outcome text,installations integer,candidates integer,apps integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE i morrow_identity.store_installations%ROWTYPE; v_shop text; v_at timestamptz; v_pseudonym text;
 n_candidates integer; n_apps integer;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::integer,NULL::integer,NULL::integer; RETURN;
 END IF;
 SELECT x.shop_id INTO v_shop FROM morrow_identity.store_installations x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_installation_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::integer,NULL::integer,NULL::integer; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.shopify_install',v_shop)::text,0));
 SELECT * INTO i FROM morrow_identity.store_installations x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_installation_id FOR UPDATE;
 IF i.status<>'uninstalled' THEN RETURN QUERY SELECT 'ineligible'::text,NULL::integer,NULL::integer,NULL::integer; RETURN; END IF;
 v_at:=greatest(date_trunc('milliseconds',clock_timestamp()),i.updated_at);
 v_pseudonym:=morrow_identity.shop_pseudonym(i.id::text);
 IF i.redacted_at IS NULL THEN
  UPDATE morrow_identity.store_installations x SET shop_domain=v_pseudonym,redacted_at=v_at,revision=x.revision+1,updated_at=v_at
   WHERE x.organization_id=i.organization_id AND x.workspace_id=i.workspace_id AND x.id=i.id;
 END IF;
 UPDATE morrow_identity.linking_candidates c SET shop_domain=v_pseudonym,redacted_at=v_at,proof_revoked_at=COALESCE(c.proof_revoked_at,v_at)
  WHERE c.installation_id=i.id AND c.redacted_at IS NULL;
 UPDATE morrow_identity.shopify_apps a SET install_url=NULL,revision=a.revision+1
  WHERE a.app_key=i.app_key AND a.invited_organization_id=i.organization_id AND a.invited_workspace_id=i.workspace_id
   AND a.install_url IS NOT NULL;
 SELECT count(*)::integer INTO n_candidates FROM morrow_identity.linking_candidates c WHERE c.installation_id=i.id AND c.redacted_at IS NOT NULL;
 SELECT count(*)::integer INTO n_apps FROM morrow_identity.shopify_apps a
  WHERE a.app_key=i.app_key AND a.invited_organization_id=i.organization_id AND a.invited_workspace_id=i.workspace_id
   AND a.install_url IS NULL;
 RETURN QUERY SELECT 'applied'::text,1,n_candidates,n_apps;
END $$;
-- Completes the open privacy request of one inbox row with its evidence (the CHECK refuses
-- evidence with anything outstanding). Outcomes: completed, already_completed, not_found,
-- invalid.
CREATE FUNCTION morrow_identity.work_privacy_request_complete(p_org text,p_ws text,p_inbox_id text,p_evidence jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE r morrow_identity.privacy_requests%ROWTYPE;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_inbox_id IS NULL OR p_inbox_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RETURN 'invalid'; END IF;
 SELECT * INTO r FROM morrow_identity.privacy_requests x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.inbox_id=p_inbox_id FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 IF r.status='completed' THEN RETURN 'already_completed'; END IF;
 IF NOT morrow_identity.privacy_evidence_valid(r.topic,p_evidence) THEN RETURN 'invalid'; END IF;
 UPDATE morrow_identity.privacy_requests x SET status='completed',completed_at=greatest(date_trunc('milliseconds',clock_timestamp()),x.received_at),
  evidence=p_evidence,evidence_digest=encode(sha256(convert_to(p_evidence::text,'UTF8')),'hex')
  WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.id=r.id;
 RETURN 'completed';
END $$;
-- The cross-tenant deadline check of the connector's cron (ADR-0022 item 14; M2 PR-3
-- review): how many privacy requests are still open past their target (shop/redact 24
-- hours; customers/* at once, with ten minutes' grace for the inbox re-drive, two minutes
-- plus the five-minute cron) and past their 30-day due time. Counts only, content-free.
CREATE FUNCTION morrow_identity.work_privacy_overdue()
RETURNS TABLE(target_missed integer,due_missed integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT (count(*) FILTER (WHERE r.target_at<pg_catalog.clock_timestamp()-interval '10 minutes'))::integer,
  (count(*) FILTER (WHERE r.due_at<pg_catalog.clock_timestamp()))::integer
 FROM morrow_identity.privacy_requests r WHERE r.status='open'
$$;
-- The broker's credential destruction (the vault transaction that erases the key material
-- calls this first): only for an installation that records its end, and only with the
-- reason its row records (uninstalled; or the suspension's reason). It marks the
-- destruction once, under the per-shop install lock, and returns the tenant and the
-- credential id whose active version the caller erases in the same transaction.
-- Outcomes: recorded (with whether it was already recorded), ineligible, not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_credential_end(p_installation_id text,p_reason text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,credential_id text,already boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE i morrow_identity.store_installations%ROWTYPE; v_shop text; v_at timestamptz;
BEGIN
 IF p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_reason IS NULL OR p_reason NOT IN ('uninstalled','scopes_changed','disconnected') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::boolean; RETURN;
 END IF;
 SELECT x.shop_id INTO v_shop FROM morrow_identity.store_installations x WHERE x.id=p_installation_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::boolean; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.shopify_install',v_shop)::text,0));
 SELECT * INTO i FROM morrow_identity.store_installations x WHERE x.id=p_installation_id FOR UPDATE;
 IF i.status NOT IN ('suspended','uninstalled')
  OR p_reason IS DISTINCT FROM (CASE WHEN i.status='uninstalled' THEN 'uninstalled' ELSE i.suspended_reason END) THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::boolean; RETURN;
 END IF;
 IF i.credential_destroyed_at IS NOT NULL THEN
  RETURN QUERY SELECT 'recorded'::text,i.organization_id::text,i.workspace_id::text,i.credential_id::text,true; RETURN;
 END IF;
 v_at:=greatest(date_trunc('milliseconds',clock_timestamp()),i.updated_at);
 UPDATE morrow_identity.store_installations x SET credential_destroyed_at=v_at,revision=x.revision+1,updated_at=v_at
  WHERE x.organization_id=i.organization_id AND x.workspace_id=i.workspace_id AND x.id=i.id;
 RETURN QUERY SELECT 'recorded'::text,i.organization_id::text,i.workspace_id::text,i.credential_id::text,false;
END $$;
-- The cross-tenant credential re-drive: installations that record an end but not yet the
-- destruction of their token, with the reason their row records, at most 20. Ids only.
CREATE FUNCTION morrow_identity.work_shopify_credentials_pending()
RETURNS TABLE(installation_id text,reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT i.id::text,CASE WHEN i.status='uninstalled' THEN 'uninstalled' ELSE i.suspended_reason END
 FROM morrow_identity.store_installations i
 WHERE i.status IN ('suspended','uninstalled') AND i.credential_destroyed_at IS NULL
 ORDER BY i.updated_at,i.id LIMIT 20
$$;
-- The read target of one store connection (the broker's read resolution): the linked
-- installation of that store on that connection, with its shop domain and id, granted
-- scopes and credential id. Nothing for any other state. Outcomes: found, not_found,
-- invalid.
CREATE FUNCTION morrow_identity.work_shopify_read_target(p_org text,p_ws text,p_store_id text,p_connection_id text)
RETURNS TABLE(outcome text,installation_id text,shop_domain text,shop_id text,granted_scopes text,credential_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE i record;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_connection_id IS NULL OR p_connection_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.id::text AS id,x.shop_domain,x.shop_id,array_to_string(x.granted_scopes,',') AS scopes,x.credential_id::text AS credential_id INTO i
  FROM morrow_identity.store_installations x JOIN morrow_identity.workspace_store_links l ON l.id=x.link_id AND l.installation_id=x.id
   AND l.organization_id=x.organization_id AND l.workspace_id=x.workspace_id
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=p_store_id AND x.connection_id=p_connection_id
   AND x.status='linked' AND x.redacted_at IS NULL AND x.linked_at<=pg_catalog.clock_timestamp();
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'found'::text,i.id,i.shop_domain,i.shop_id,i.scopes,i.credential_id;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.work_shopify_webhook_record(text,text,text,text,text,text),
 morrow_identity.work_shopify_inbox_take(text),morrow_identity.work_shopify_inbox_settle(text,text,text,jsonb),
 morrow_identity.work_shopify_inbox_pending(),morrow_identity.work_shopify_installation_end(text,text,text,text),
 morrow_identity.work_shopify_redact_identity(text,text,text),morrow_identity.work_privacy_request_complete(text,text,text,jsonb),
 morrow_identity.work_privacy_overdue(),
 morrow_identity.work_shopify_credential_end(text,text),morrow_identity.work_shopify_credentials_pending(),
 morrow_identity.work_shopify_read_target(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_shopify_webhook_record(text,text,text,text,text,text),
 morrow_identity.work_shopify_inbox_take(text),morrow_identity.work_shopify_inbox_settle(text,text,text,jsonb),
 morrow_identity.work_shopify_inbox_pending(),morrow_identity.work_shopify_installation_end(text,text,text,text),
 morrow_identity.work_shopify_redact_identity(text,text,text),morrow_identity.work_privacy_request_complete(text,text,text,jsonb),
 morrow_identity.work_privacy_overdue(),
 morrow_identity.work_shopify_credential_end(text,text),morrow_identity.work_shopify_credentials_pending(),
 morrow_identity.work_shopify_read_target(text,text,text,text) TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- work_shopify_launch (0026), same signature, owner and ACL, with one change: the
-- installation of an active app is found by the app (one app per shop, 0026) even after
-- shop/redact replaced its domain, so a launch of a suspended or uninstalled installation
-- reports that state and shows the ineligible page before any OAuth.
CREATE OR REPLACE FUNCTION morrow_identity.work_shopify_launch(p_app_key text,p_shop_domain text)
RETURNS TABLE(outcome text,client_id text,organization_id text,workspace_id text,installation text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE a morrow_identity.shopify_apps%ROWTYPE; v_status text;
BEGIN
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$'
  OR p_shop_domain IS NULL OR length(p_shop_domain)>255 OR p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO a FROM morrow_identity.shopify_apps x WHERE x.app_key=p_app_key AND x.status='active';
 IF NOT FOUND OR a.intended_shop_digest<>encode(sha256(convert_to(p_shop_domain,'UTF8')),'hex') THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT i.status INTO v_status FROM morrow_identity.store_installations i
  WHERE i.app_key=p_app_key AND (i.shop_domain=p_shop_domain OR i.redacted_at IS NOT NULL)
  ORDER BY i.created_at DESC,i.id LIMIT 1;
 RETURN QUERY SELECT 'found'::text,a.client_id,a.invited_organization_id::text,a.invited_workspace_id::text,COALESCE(v_status,'none');
END $$;
-- workspace_connections (0026), same signature, owner and ACL, with two changes: a redacted
-- installation (shop/redact) is left out of the list, and an active app with a suspended
-- or uninstalled installation offers no install link (M2 PR-3 review). A reinstall under
-- the same app is refused (0026's UNIQUE (app_key, shop_id), and the launch shows the
-- ineligible page), so its link would lead nowhere: the read reports no registered app
-- (InstallLinkOffer reason not_registered) until the operator retires it and registers a
-- new one. WorkspaceConnections@1 is unchanged.
CREATE OR REPLACE FUNCTION morrow_identity.workspace_connections(p_session text,p_workspace text)
RETURNS TABLE(installations jsonb,app_registered boolean,install_url text,route text,linked boolean,owner boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; v_url text; v_rows jsonb;
BEGIN
 IF NOT morrow_identity.executor_role_safe('morrow_identity_linking') THEN RETURN; END IF;
 IF p_session IS NULL OR p_session !~ '^[a-f0-9]{64}$' OR p_workspace IS NULL OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 SELECT x.principal_id,x.organization_id,x.workspace_id INTO e FROM morrow_identity.session_eligibility(p_session,p_workspace) x WHERE x.workspace_id=p_workspace;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT a.install_url INTO v_url FROM morrow_identity.shopify_apps a
  WHERE a.invited_organization_id=e.organization_id AND a.invited_workspace_id=e.workspace_id AND a.status='active'
   AND a.install_url IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM morrow_identity.store_installations i WHERE i.app_key=a.app_key
    AND i.status IN ('suspended','uninstalled'))
  ORDER BY a.created_at,a.app_key LIMIT 1;
 SELECT COALESCE(jsonb_agg(r.o ORDER BY r.created_at,r.id),'[]'::jsonb) INTO v_rows FROM (
  SELECT i.created_at,i.id::text AS id,jsonb_build_object('schemaVersion',1,'id',i.id::text,'organizationId',i.organization_id::text,
   'workspaceId',i.workspace_id::text,'storeId',i.store_id::text,'revision',i.revision::bigint,
   'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'shopId',i.shop_id,'shopDomain',i.shop_domain,'connectionId',i.connection_id::text,'status',i.status,
   'owningWorkspaceId',CASE WHEN i.status='linked' THEN i.workspace_id::text ELSE NULL END,
   'grantedScopes',to_jsonb(i.granted_scopes),'providerCredentialVersion',i.credential_version::bigint,
   'providerCredentialRef',i.credential_id::text) AS o
  FROM morrow_identity.store_installations i WHERE i.organization_id=e.organization_id AND i.workspace_id=e.workspace_id
   AND i.redacted_at IS NULL
  ORDER BY i.created_at,i.id LIMIT 51) r;
 RETURN QUERY SELECT v_rows,v_url IS NOT NULL,v_url,morrow_billing.link_route_current(e.organization_id::text,e.workspace_id::text),
  EXISTS(SELECT 1 FROM morrow_identity.store_installations i WHERE i.organization_id=e.organization_id
   AND i.workspace_id=e.workspace_id AND i.status='linked'),
  EXISTS(SELECT 1 FROM morrow_identity.organization_signups s WHERE s.organization_id=e.organization_id
   AND s.principal_id=e.principal_id);
END $$;
COMMIT;
