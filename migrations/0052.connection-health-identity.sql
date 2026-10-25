BEGIN;
-- v1 PR 5, "Keep the store connection healthy": the identity side (ADR-0025 items 9 and 10;
-- ADR-0031 item 3 and owner question 2; ADR-0035 item 3; docs/briefs/v1-connection-health.md).
-- Executes AS morrow_identity_owner, after 0051. It changes:
--   * scope changes keep the connection: store_installations.granted_scopes may now record a
--     narrower set ('{}' included) without a new token, and two columns record what the
--     broker observed with the installation's own token: scopes_observed_at (the time it read
--     the granted scopes back from Shopify) and token_refused_at (Shopify refused the token).
--     Only the replaced guard admits the change: while unlinked or linked, the scopes only
--     narrow unless a fresh observation records them; a re-authorisation clears the refusal;
--   * reinstall under the same app: UNIQUE (app_key, shop_id) becomes one installation that is
--     not uninstalled per app and shop, and one active, unredacted linking candidate per shop
--     and app (was: one ever). A reinstall is a new installation with new ids (a new store and
--     connection, a new credential), born unlinked: only a person links it again. The earlier
--     installation keeps its end state and its clocks (the 48-hour deletion still runs for it);
--   * the 48-hour deletion's record (store_data_deletions: one per uninstalled installation,
--     ever; content-free evidence; 365 days), FORCE RLS with the identity_owner policy only,
--     guarded by the replaced shopify_preserve_record;
--   * replaced with the same signatures (each pinned by md5 below): shopify_preserve_record
--     (0036), work_shopify_install_prepare and work_shopify_install_record (0026: the live
--     installation of the app and shop, else a fresh install; the record refuses while an
--     earlier installation's token is not destroyed), work_shopify_webhook_record (0036: each
--     topic finds the installation it concerns when several exist), work_shopify_installation_end
--     (0036: a scope change no longer ends an installation, so the M2 PR-3 applier's suspension
--     is refused), work_shopify_launch (0036: an uninstalled latest installation reports
--     uninstalled, so the connector starts a reinstall; a live one missing a scope, or whose
--     token Shopify refused, reports reconnect), workspace_connections (0036: an install
--     link is offered unless the app's installation is suspended) and
--     work_shopify_redact_identity (0036: the app's install link is kept while the app has an
--     installation that is not uninstalled, so a shop/redact for an earlier installation never
--     takes the link a reinstall is connected through; the 48-hour deletion runs the same
--     function, so the two deletions keep one rule; PR 5 review finding F1);
--   * identity bridges (SECURITY DEFINER, EXECUTE for morrow_work_command only; 0053's
--     connector and vault definers call them): the scope record, the health target, the
--     reinstall leftovers, the ids-only due lists (checks, reconnects, deletions, stuck inbox
--     rows), the deletion's open and completion.
-- The tenant always comes from a row the broker recorded or the installation itself, never
-- from a caller (invariant 1). Nothing here deletes a row or reaches the vault.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regclass('morrow_identity.store_installations') IS NULL OR to_regclass('morrow_identity.shopify_webhook_inbox') IS NULL
 OR to_regclass('morrow_identity.privacy_requests') IS NULL OR to_regclass('morrow_identity.store_data_deletions') IS NOT NULL
 OR to_regprocedure('morrow_identity.work_executor_safe(text)') IS NULL
 OR to_regprocedure('morrow_identity.shop_pseudonym(text)') IS NULL
 OR to_regprocedure('morrow_identity.shopify_scope_list_valid(jsonb)') IS NULL
 OR to_regprocedure('morrow_identity.privacy_evidence_valid(text,jsonb)') IS NULL
 OR to_regprocedure('morrow_identity.work_shopify_scopes_record(text,text,text,text,text,text,text)') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_identity.store_installations'::regclass
   AND a.attname IN ('scopes_observed_at','token_refused_at') AND NOT a.attisdropped)
 -- The constraints this file replaces, exactly as 0026 and 0005 wrote them.
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='morrow_identity.store_installations'::regclass AND c.conname='store_installations_app_key_shop_id_key')
  IS DISTINCT FROM 'UNIQUE (app_key, shop_id)'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='morrow_identity.store_installations'::regclass AND c.conname='store_installations_granted_scopes_check')
  IS DISTINCT FROM 'CHECK (((granted_scopes = ARRAY[''read_products''::text, ''write_products''::text]) OR (granted_scopes = ARRAY[''read_products''::text])))'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c
   WHERE c.conrelid='morrow_identity.linking_candidates'::regclass AND c.conname='linking_candidates_provider_id_application_id_environment_i_key')
  IS DISTINCT FROM 'UNIQUE (provider_id, application_id, environment_id, shop_id)'
 -- The function texts this file replaces, exactly as 0026 and 0036 wrote them (a missed
 -- merge fails here).
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.shopify_preserve_record()'))
  IS DISTINCT FROM 'cfab3bd2c38020e93003666907bcf9b5'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.work_shopify_install_prepare(text,text,text,text)'))
  IS DISTINCT FROM 'dc95f79a507fb3506aa7c804cce11331'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('morrow_identity.work_shopify_install_record(text,text,text,text,text,text,text,text,text,text,text,text)'))
  IS DISTINCT FROM '59b8f951a4798d85009f449db22836c3'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('morrow_identity.work_shopify_webhook_record(text,text,text,text,text,text)'))
  IS DISTINCT FROM 'f2936b60ce7b36fd0c9446026109d72a'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.work_shopify_installation_end(text,text,text,text)'))
  IS DISTINCT FROM '91308dd26e3e70ded7eb5ed56470810a'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.work_shopify_launch(text,text)'))
  IS DISTINCT FROM '4645b96addcae40825584b697fff49cb'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.workspace_connections(text,text)'))
  IS DISTINCT FROM '7309340ec93b8749d57833abd586e474'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_identity.work_shopify_redact_identity(text,text,text)'))
  IS DISTINCT FROM '07a5f45bf50c3bae986c1de9784d5ba9'
 THEN RAISE EXCEPTION 'CONNECTION_HEALTH_IDENTITY_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pure functions (IMMUTABLE, owned by the identity owner, granted to nobody).
-- A Shopify scope list as the bridges record it: write_X implies read_X (Shopify grants
-- it), kept to the two scopes this app requests at this head, sorted. NULL for an invalid
-- list.
CREATE FUNCTION morrow_identity.shopify_scopes_known(p_list jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT CASE WHEN NOT morrow_identity.shopify_scope_list_valid(p_list) THEN NULL ELSE
  (SELECT COALESCE(array_agg(DISTINCT z.s ORDER BY z.s),'{}') FROM (
    SELECT s FROM jsonb_array_elements_text(p_list) s
    UNION SELECT regexp_replace(s,'^(unauthenticated_)?write_','\1read_') FROM jsonb_array_elements_text(p_list) s) z
   WHERE z.s IN ('read_products','write_products')) END
$$;
-- The 48-hour deletion's evidence (ADR-0031 item 3): content-free and closed, exactly
-- shop/redact's shape (0036 privacy_evidence_valid, whose closed handler list every
-- store-content table extends, so both deletions admit the same handlers) with its own kind
-- and a credential that was destroyed.
--   {schemaVersion 1, kind "store_deleted", scopes, handlers [{table, action, rows}],
--    credential (destroyed | already_destroyed), outstanding []}
CREATE FUNCTION morrow_identity.store_deletion_evidence_valid(p_evidence jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' OR p_evidence->>'kind' IS DISTINCT FROM 'store_deleted'
   OR jsonb_typeof(p_evidence->'credential') IS DISTINCT FROM 'string'
   OR (p_evidence->>'credential') NOT IN ('destroyed','already_destroyed') THEN false
  ELSE COALESCE(morrow_identity.privacy_evidence_valid('shop/redact',jsonb_set(p_evidence,'{kind}','"shop_redacted"'::jsonb)),false) END
$$;
REVOKE ALL ON FUNCTION morrow_identity.shopify_scopes_known(jsonb),morrow_identity.store_deletion_evidence_valid(jsonb) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Scope changes keep the installation (ADR-0025 item 10): an empty set is now a valid record
-- (every scope removed), and the broker's observations are recorded with their time.
ALTER TABLE morrow_identity.store_installations DROP CONSTRAINT store_installations_granted_scopes_check,
 ADD CONSTRAINT store_installations_granted_scopes_check CHECK (granted_scopes=ARRAY['read_products','write_products']::text[]
  OR granted_scopes=ARRAY['read_products']::text[] OR granted_scopes='{}'::text[]),
 ADD COLUMN scopes_observed_at timestamptz
  CHECK (scopes_observed_at=date_trunc('milliseconds',scopes_observed_at) AND isfinite(scopes_observed_at)),
 ADD COLUMN token_refused_at timestamptz
  CHECK (token_refused_at=date_trunc('milliseconds',token_refused_at) AND isfinite(token_refused_at)),
 ADD CONSTRAINT store_installations_health CHECK ((scopes_observed_at IS NULL OR scopes_observed_at>=created_at)
  AND (token_refused_at IS NULL OR token_refused_at>=created_at));
-- Reinstall (ADR-0025 item 10's "reinstall" half; build order PR 5): one installation that is
-- not uninstalled per app and shop (with 0026's one per shop under any app), never one ever.
ALTER TABLE morrow_identity.store_installations DROP CONSTRAINT store_installations_app_key_shop_id_key;
CREATE UNIQUE INDEX store_installations_one_live_app_shop ON morrow_identity.store_installations (app_key,shop_id)
 WHERE status<>'uninstalled';
CREATE INDEX store_installations_checks_due ON morrow_identity.store_installations (scopes_observed_at,id)
 WHERE status IN ('unlinked','linked') AND redacted_at IS NULL;
CREATE INDEX store_installations_deletions_due ON morrow_identity.store_installations (uninstalled_at,id)
 WHERE status='uninstalled';
ALTER TABLE morrow_identity.linking_candidates
 DROP CONSTRAINT linking_candidates_provider_id_application_id_environment_i_key;
CREATE UNIQUE INDEX linking_candidates_one_active ON morrow_identity.linking_candidates
 (provider_id,application_id,environment_id,shop_id) WHERE active AND redacted_at IS NULL;

-- The 48-hour deletion (ADR-0031 item 3): when Shopify's shop/redact has not completed for an
-- uninstalled installation 48 hours after its uninstall, Morrow deletes the store's data
-- itself, once. One record per installation, ever (UNIQUE), born open when the deletion
-- starts and completed only when nothing is outstanding, the token's destruction included.
-- Content-free: ids, codes, counts and times. 365 days (expires_at, set in code).
CREATE TABLE morrow_identity.store_data_deletions (
 organization_id morrow_identity.record_id NOT NULL,
 workspace_id morrow_identity.record_id NOT NULL,
 id morrow_identity.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 installation_id morrow_identity.record_id NOT NULL UNIQUE,
 app_key text NOT NULL,
 store_id morrow_identity.record_id NOT NULL,
 trigger text NOT NULL CHECK (trigger='uninstall_48h'),
 uninstalled_at timestamptz NOT NULL CHECK (uninstalled_at=date_trunc('milliseconds',uninstalled_at) AND isfinite(uninstalled_at)),
 due_at timestamptz NOT NULL,
 opened_at timestamptz NOT NULL CHECK (opened_at=date_trunc('milliseconds',opened_at) AND isfinite(opened_at)),
 expires_at timestamptz NOT NULL,
 status text NOT NULL CHECK (status IN ('open','completed')),
 completed_at timestamptz CHECK (completed_at=date_trunc('milliseconds',completed_at) AND isfinite(completed_at)),
 evidence jsonb CHECK (evidence IS NULL OR morrow_identity.store_deletion_evidence_valid(evidence)),
 evidence_digest text CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_identity.store_installations(organization_id,workspace_id,id),
 FOREIGN KEY (app_key,organization_id,workspace_id)
  REFERENCES morrow_identity.shopify_apps(app_key,invited_organization_id,invited_workspace_id),
 CHECK (due_at=uninstalled_at+interval '48 hours'),
 CHECK (opened_at>=due_at),
 CHECK (expires_at=opened_at+interval '365 days'),
 CHECK ((status='completed')=(completed_at IS NOT NULL) AND (status='completed')=(evidence IS NOT NULL)
  AND (evidence IS NULL)=(evidence_digest IS NULL) AND (completed_at IS NULL OR completed_at>=opened_at)
  AND (evidence IS NULL OR evidence_digest=encode(sha256(convert_to(evidence::text,'UTF8')),'hex')))
);
CREATE INDEX store_data_deletions_open ON morrow_identity.store_data_deletions (opened_at,id) WHERE status='open';
ALTER TABLE morrow_identity.store_data_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_identity.store_data_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_owner ON morrow_identity.store_data_deletions TO morrow_identity_owner USING(true) WITH CHECK(true);
REVOKE ALL ON morrow_identity.store_data_deletions FROM PUBLIC;

-- The guard of the seven Shopify tables (INVOKER, owned by the identity owner, granted to
-- nobody), replacing 0036's with every rule kept, plus:
--   * store_installations: born with no observation or refusal; the PR-2 re-authorisation
--     (the next credential version) records the new token's scopes as observed at the
--     re-authorisation and clears a refusal, and a link leaves both untouched; the PR-5 scope
--     record, while unlinked or linked and changing nothing else: the scopes only narrow,
--     unless the same change records a fresh observation (the broker's read-back), which may
--     also set or clear the refusal; an observation time never goes back or clears;
--   * store_data_deletions: born open; one change, open -> completed with its evidence.
-- No row of any of them is deleted or truncated.
CREATE OR REPLACE FUNCTION morrow_identity.shopify_preserve_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE v_fixed text[]; v_end text[]; v_health text[]; v_new jsonb; v_old jsonb;
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
    AND NEW.credential_destroyed_at IS NULL AND NEW.redacted_at IS NULL
    AND NEW.scopes_observed_at IS NULL AND NEW.token_refused_at IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='install_continuations' THEN
   IF NEW.consumed_at IS NULL AND NEW.superseded_at IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='shopify_webhook_inbox' THEN
   IF NEW.status='received' AND NEW.settled_at IS NULL AND NEW.outcome IS NULL AND NEW.effects IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='privacy_requests' THEN
   IF NEW.status='open' AND NEW.completed_at IS NULL AND NEW.evidence IS NULL AND NEW.evidence_digest IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='store_data_deletions' THEN
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
   v_health:=ARRAY['scopes_observed_at','token_refused_at'];
   v_new:=to_jsonb(NEW);
   v_old:=to_jsonb(OLD);
   IF (SELECT jsonb_object_agg(k,v_new->k) FROM unnest(v_fixed) k)=(SELECT jsonb_object_agg(k,v_old->k) FROM unnest(v_fixed) k)
    AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at THEN
    -- The PR-2 changes, while unlinked or linked only; the domain and end columns fixed.
    IF OLD.status IN ('unlinked','linked') AND NEW.shop_domain=OLD.shop_domain
     AND (SELECT jsonb_object_agg(k,v_new->k) FROM unnest(v_end) k)=(SELECT jsonb_object_agg(k,v_old->k) FROM unnest(v_end) k)
     -- Scopes, the development flag and the re-authorisation time change only with the
     -- next credential version, which also records the new token's scopes as observed at
     -- the re-authorisation and clears a refusal (PR 5); otherwise neither changes.
     AND ((NEW.credential_version=OLD.credential_version AND NEW.reauthorised_at IS NOT DISTINCT FROM OLD.reauthorised_at
       AND NEW.granted_scopes=OLD.granted_scopes AND NEW.development_store=OLD.development_store
       AND (SELECT jsonb_object_agg(k,v_new->k) FROM unnest(v_health) k)=(SELECT jsonb_object_agg(k,v_old->k) FROM unnest(v_health) k))
      OR (NEW.credential_version=OLD.credential_version+1 AND NEW.reauthorised_at IS NOT NULL AND NEW.status=OLD.status
       AND NEW.scopes_observed_at IS NOT DISTINCT FROM NEW.reauthorised_at AND NEW.token_refused_at IS NULL))
     AND (NEW.status=OLD.status
      OR (OLD.status='unlinked' AND NEW.status='linked' AND NEW.link_id IS NOT NULL AND OLD.link_id IS NULL AND NEW.credential_version=OLD.credential_version))
     AND (NEW.link_id IS NOT DISTINCT FROM OLD.link_id OR (OLD.link_id IS NULL AND NEW.status='linked'))
     AND (NEW.linked_at IS NOT DISTINCT FROM OLD.linked_at OR (OLD.linked_at IS NULL AND NEW.status='linked')) THEN RETURN NEW; END IF;
    -- PR 5, the scope record: while unlinked or linked, only the scopes and the two health
    -- columns change. Without an observation the scopes only narrow (a delivery's current
    -- scopes, ADR-0025 item 10) and the refusal stays; a fresh observation (strictly later
    -- than the last) records the scopes and the refusal as the broker found them.
    IF OLD.status IN ('unlinked','linked') AND NEW.status=OLD.status
     AND (v_new-ARRAY['granted_scopes','scopes_observed_at','token_refused_at','revision','updated_at'])
      =(v_old-ARRAY['granted_scopes','scopes_observed_at','token_refused_at','revision','updated_at'])
     AND ((NEW.granted_scopes<@OLD.granted_scopes AND NEW.token_refused_at IS NOT DISTINCT FROM OLD.token_refused_at
       AND NEW.scopes_observed_at IS NOT DISTINCT FROM OLD.scopes_observed_at)
      OR (NEW.scopes_observed_at IS NOT NULL AND (OLD.scopes_observed_at IS NULL OR NEW.scopes_observed_at>OLD.scopes_observed_at)
       AND (NEW.token_refused_at IS NULL OR NEW.token_refused_at=NEW.scopes_observed_at))) THEN RETURN NEW; END IF;
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
     -- shop/redact (or the 48-hour deletion), once, while uninstalled: the domain becomes the
     -- pseudonym.
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
  ELSIF TG_TABLE_NAME='store_data_deletions' THEN
   IF OLD.status='open' AND NEW.status='completed' AND NEW.completed_at IS NOT NULL AND NEW.evidence IS NOT NULL
    AND NEW.evidence_digest IS NOT NULL
    AND (to_jsonb(NEW)-ARRAY['status','completed_at','evidence','evidence_digest'])=(to_jsonb(OLD)-ARRAY['status','completed_at','evidence','evidence_digest']) THEN RETURN NEW; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'SHOPIFY_RECORD_IMMUTABLE';
END $$;
CREATE TRIGGER shopify_record_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_identity.store_data_deletions
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.shopify_preserve_record();
CREATE TRIGGER shopify_record_no_truncate BEFORE TRUNCATE ON morrow_identity.store_data_deletions
 FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity.shopify_preserve_record();

-- ---------------------------------------------------------------------------
-- Install and reinstall (0026's prepare and record, same signatures, owner and ACL).
-- Before sealing: the ids the broker binds into the envelope's additional data. The
-- installation of this app and shop that is not uninstalled is re-authorised (the next
-- credential version of its one credential) while unlinked or linked; a suspended one stays
-- ineligible (a person's disconnect needs the app uninstalled first). With none, every id is
-- allocated here: a first install, or a reinstall after an uninstall (a new installation,
-- store, connection and credential; the earlier installation keeps its end and its clocks).
-- A shop that another app's live installation holds is ineligible.
-- Outcomes: install, reauthorise, state_invalid, ineligible.
CREATE OR REPLACE FUNCTION morrow_identity.work_shopify_install_prepare(p_app_key text,p_state_digest text,p_shop_id text,p_shop_domain text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,installation_id text,store_id text,connection_id text,
 credential_id text,credential_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE a morrow_identity.shopify_apps%ROWTYPE; i morrow_identity.store_installations%ROWTYPE;
BEGIN
 a:=morrow_identity.shopify_install_state(p_app_key,p_state_digest,p_shop_id,p_shop_domain);
 IF a.app_key IS NULL THEN
  RETURN QUERY SELECT 'state_invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF morrow_identity.shopify_shop_held_elsewhere(p_app_key,p_shop_id,p_shop_domain) THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO i FROM morrow_identity.store_installations x WHERE x.app_key=p_app_key AND x.shop_id=p_shop_id
  AND x.status<>'uninstalled' FOR UPDATE;
 IF FOUND THEN
  IF i.status NOT IN ('unlinked','linked') OR i.shop_domain<>p_shop_domain
   OR i.organization_id<>a.invited_organization_id OR i.workspace_id<>a.invited_workspace_id THEN
   RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  RETURN QUERY SELECT 'reauthorise'::text,i.organization_id::text,i.workspace_id::text,i.id::text,i.store_id::text,
   i.connection_id::text,i.credential_id::text,(i.credential_version+1)::text;
  RETURN;
 END IF;
 RETURN QUERY SELECT 'install'::text,a.invited_organization_id::text,a.invited_workspace_id::text,gen_random_uuid()::text,
  gen_random_uuid()::text,gen_random_uuid()::text,gen_random_uuid()::text,'1'::text;
END $$;
-- The identity half of the broker's one install transaction (0027 shopify_install_store
-- writes the vault half in the same transaction). Every 0026 rule is kept, with the live
-- installation of the app and shop in place of the one ever, and, for a fresh install after
-- an uninstall (a reinstall): every earlier installation of this app and shop must already
-- record its token's destruction (0053's prepare destroys a leftover token in the same
-- transaction first; ineligible otherwise), and its candidates that are not redacted stop
-- being active, so the new installation's candidate is the shop's one active candidate. A
-- re-authorisation also records the new token's scopes as observed now and clears a token
-- refusal (PR 5: the reconnect).
-- Outcomes: installed, reauthorised, state_invalid, ineligible, invalid.
CREATE OR REPLACE FUNCTION morrow_identity.work_shopify_install_record(p_app_key text,p_state_digest text,p_shop_id text,p_shop_domain text,
 p_scopes text,p_development_store text,p_installation_id text,p_store_id text,p_connection_id text,p_credential_id text,
 p_credential_version text,p_continuation_digest text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,continuation text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE a morrow_identity.shopify_apps%ROWTYPE; i morrow_identity.store_installations%ROWTYPE;
 c morrow_identity.linking_candidates%ROWTYPE; v_at timestamptz; v_founder text; v_scopes text[]; v_proof text;
 v_reauthorise boolean; v_continuation text:='none'; v_version bigint;
BEGIN
 IF p_scopes IS NULL OR p_scopes NOT IN ('read_products,write_products','read_products')
  OR p_development_store IS NULL OR p_development_store NOT IN ('true','false')
  OR p_installation_id IS NULL OR p_installation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_connection_id IS NULL OR p_connection_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_credential_id IS NULL OR p_credential_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_credential_version IS NULL OR p_credential_version !~ '^[1-9][0-9]{0,15}$'
  OR p_continuation_digest IS NULL OR p_continuation_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_version:=p_credential_version::bigint;
 v_scopes:=string_to_array(p_scopes,',');
 a:=morrow_identity.shopify_install_state(p_app_key,p_state_digest,p_shop_id,p_shop_domain);
 IF a.app_key IS NULL THEN RETURN QUERY SELECT 'state_invalid'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF morrow_identity.shopify_shop_held_elsewhere(p_app_key,p_shop_id,p_shop_domain) THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_at:=date_trunc('milliseconds',clock_timestamp());
 SELECT * INTO i FROM morrow_identity.store_installations x WHERE x.app_key=p_app_key AND x.shop_id=p_shop_id
  AND x.status<>'uninstalled' FOR UPDATE;
 v_reauthorise:=FOUND;
 IF v_reauthorise THEN
  IF i.status NOT IN ('unlinked','linked') OR i.shop_domain<>p_shop_domain OR i.id<>p_installation_id OR i.store_id<>p_store_id
   OR i.connection_id<>p_connection_id OR i.credential_id<>p_credential_id OR v_version<>i.credential_version+1
   OR i.organization_id<>a.invited_organization_id OR i.workspace_id<>a.invited_workspace_id THEN
   RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  UPDATE morrow_identity.store_installations x SET granted_scopes=v_scopes,development_store=p_development_store::boolean,
   credential_version=v_version,reauthorised_at=greatest(v_at,x.created_at),scopes_observed_at=greatest(v_at,x.created_at),
   token_refused_at=NULL,revision=x.revision+1,updated_at=greatest(v_at,x.updated_at)
   WHERE x.organization_id=i.organization_id AND x.workspace_id=i.workspace_id AND x.id=i.id RETURNING * INTO i;
  IF i.status='unlinked' THEN
   SELECT * INTO c FROM morrow_identity.linking_candidates x WHERE x.installation_id=i.id FOR UPDATE;
   IF NOT FOUND OR c.proof_kind<>'shopify_oauth' THEN RAISE EXCEPTION 'SHOPIFY_CANDIDATE_MISSING'; END IF;
   v_proof:=gen_random_uuid()::text;
   UPDATE morrow_identity.linking_candidates x SET proof_id=v_proof,proof_revision=x.proof_revision+1,
    proof_digest=encode(sha256(convert_to(jsonb_build_array('morrow.linking.shopify_oauth.proof',1,x.id::text,x.installation_id::text,
     x.shop_id,v_proof,x.proof_revision+1,x.eligible_principal_id::text)::text,'UTF8')),'hex'),
    proof_created_at=v_at,proof_expires_at=v_at+interval '10 minutes',proof_revoked_at=NULL
    WHERE x.id=c.id;
  END IF;
 ELSE
  IF v_version<>1 OR EXISTS(SELECT 1 FROM morrow_identity.store_installations x WHERE x.id=p_installation_id OR x.store_id=p_store_id
    OR x.connection_id=p_connection_id OR x.credential_id=p_credential_id) THEN
   RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  -- A reinstall: the earlier installations' tokens are already destroyed (the vault's
  -- prepare destroys a leftover first, in this transaction), and their live candidates step
  -- aside for the new one.
  IF EXISTS(SELECT 1 FROM morrow_identity.store_installations x WHERE x.app_key=p_app_key AND x.shop_id=p_shop_id
    AND x.credential_destroyed_at IS NULL) THEN
   RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  UPDATE morrow_identity.linking_candidates c2 SET active=false
   WHERE c2.provider_id='shopify' AND c2.application_id=a.client_id AND c2.environment_id=a.environment_id AND c2.shop_id=p_shop_id
    AND c2.active AND c2.redacted_at IS NULL
    AND c2.installation_id IN (SELECT x.id FROM morrow_identity.store_installations x WHERE x.app_key=p_app_key AND x.shop_id=p_shop_id
     AND x.status='uninstalled');
  SELECT s.principal_id::text INTO v_founder FROM morrow_identity.organization_signups s
   WHERE s.organization_id=a.invited_organization_id AND s.workspace_id=a.invited_workspace_id;
  IF v_founder IS NULL THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
  INSERT INTO morrow_identity.store_installations(organization_id,workspace_id,id,app_key,shop_id,shop_domain,store_id,connection_id,
   generation,status,granted_scopes,credential_id,credential_version,development_store,link_id,revision,created_at,updated_at,
   reauthorised_at,linked_at)
  VALUES (a.invited_organization_id,a.invited_workspace_id,p_installation_id,p_app_key,p_shop_id,p_shop_domain,p_store_id,
   p_connection_id,1,'unlinked',v_scopes,p_credential_id,1,p_development_store::boolean,NULL,1,v_at,v_at,NULL,NULL)
  RETURNING * INTO i;
  v_proof:=gen_random_uuid()::text;
  INSERT INTO morrow_identity.linking_candidates(id,provider_id,application_id,environment_id,shop_id,shop_domain,installation_id,
   generation,active,ownership_revision,proof_kind,proof_id,proof_revision,proof_digest,eligible_principal_id,proof_created_at,
   proof_expires_at,proof_revoked_at)
  VALUES (gen_random_uuid()::text,'shopify',a.client_id,a.environment_id,p_shop_id,p_shop_domain,i.id,1,true,1,'shopify_oauth',v_proof,1,
   encode(sha256(convert_to(jsonb_build_array('morrow.linking.shopify_oauth.proof',1,i.id::text,p_shop_id,v_proof,1,v_founder)::text,'UTF8')),'hex'),
   v_founder,v_at,v_at+interval '10 minutes',NULL);
 END IF;
 IF i.status='unlinked' THEN
  UPDATE morrow_identity.install_continuations x SET superseded_at=greatest(v_at,x.created_at)
   WHERE x.installation_id=i.id AND x.consumed_at IS NULL AND x.superseded_at IS NULL;
  INSERT INTO morrow_identity.install_continuations(organization_id,workspace_id,id,installation_id,token_digest,purpose,created_at,
   expires_at,consumed_at,consumed_principal_id,consumed_handoff_id,superseded_at)
  VALUES (i.organization_id,i.workspace_id,gen_random_uuid()::text,i.id,p_continuation_digest,'workspace_first',v_at,
   v_at+interval '5 minutes',NULL,NULL,NULL,NULL);
  v_continuation:='created';
 END IF;
 UPDATE morrow_identity.shopify_oauth_states x SET installation_id=i.id WHERE x.state_digest=p_state_digest AND x.app_key=p_app_key;
 RETURN QUERY SELECT CASE WHEN v_reauthorise THEN 'reauthorised' ELSE 'installed' END,i.organization_id::text,i.workspace_id::text,v_continuation;
END $$;

-- ---------------------------------------------------------------------------
-- The webhook record (0036), same signature, owner and ACL, with one change: when an app
-- and shop have more than one installation (a reinstall), each topic records the one it
-- concerns. app/uninstalled, app/scopes_update and customers/* name the installation that is
-- not uninstalled, else the latest; shop/redact names an uninstalled installation (one not
-- yet redacted first, the latest uninstall first), so it never ends a reinstalled one, and
-- the live one only when the shop was never uninstalled (shop/redact before the uninstall
-- arrived). Every other rule is 0036's.
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

-- Ends one installation (0036), same signature, owner and ACL, with one change (ADR-0025
-- item 10): a scope change never ends an installation, so the reason scopes_changed is
-- refused (invalid) and the M2 PR-3 applier's suspension can no longer run; the uninstall
-- and a person's disconnect are 0036's. An installation that 0036 already suspended for a
-- scope change keeps that state, and its token's destruction (work_shopify_credential_end)
-- still names it.
CREATE OR REPLACE FUNCTION morrow_identity.work_shopify_installation_end(p_org text,p_ws text,p_installation_id text,p_reason text)
RETURNS TABLE(outcome text,prior_status text,status text,store_id text,connection_id text,end_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE i morrow_identity.store_installations%ROWTYPE; v_shop text; v_at timestamptz; v_outcome text:='unchanged'; v_prior text;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_reason IS NULL OR p_reason NOT IN ('uninstalled','disconnected') THEN
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

-- work_shopify_launch (0036), same signature, owner and ACL, with two changes: the
-- installation a launch reports is the app's installation for the shop that is not
-- uninstalled, else the latest (a reinstall after an uninstall launches OAuth: the
-- connector reads uninstalled); and a live installation (unlinked or linked) that lacks a
-- scope the app requests, or whose token Shopify refused, reports reconnect, so the launch
-- starts OAuth and the re-authorisation records the new token (PR 5's reconnect).
CREATE OR REPLACE FUNCTION morrow_identity.work_shopify_launch(p_app_key text,p_shop_domain text)
RETURNS TABLE(outcome text,client_id text,organization_id text,workspace_id text,installation text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE a morrow_identity.shopify_apps%ROWTYPE; i record; v_status text;
BEGIN
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$'
  OR p_shop_domain IS NULL OR length(p_shop_domain)>255 OR p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO a FROM morrow_identity.shopify_apps x WHERE x.app_key=p_app_key AND x.status='active';
 IF NOT FOUND OR a.intended_shop_digest<>encode(sha256(convert_to(p_shop_domain,'UTF8')),'hex') THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.status,x.granted_scopes,x.token_refused_at INTO i FROM morrow_identity.store_installations x
  WHERE x.app_key=p_app_key AND (x.shop_domain=p_shop_domain OR x.redacted_at IS NOT NULL)
  ORDER BY (x.status='uninstalled'),x.created_at DESC,x.id LIMIT 1;
 v_status:=CASE WHEN i.status IS NULL THEN 'none'
  WHEN i.status IN ('unlinked','linked') AND (i.token_refused_at IS NOT NULL
   OR NOT (string_to_array(a.scopes,',')<@i.granted_scopes)) THEN 'reconnect'
  ELSE i.status END;
 RETURN QUERY SELECT 'found'::text,a.client_id,a.invited_organization_id::text,a.invited_workspace_id::text,v_status;
END $$;

-- workspace_connections (0036), same signature, owner and ACL, with one change: an active
-- app offers its install link unless one of its installations is suspended (a person's
-- disconnect, or an M2 PR-3 scope suspension, which needs the app uninstalled first). An
-- uninstalled installation no longer blocks the link: the reinstall goes through it, and a
-- live installation that needs reconnecting goes through it too. WorkspaceConnections@1 is
-- unchanged.
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
   AND NOT EXISTS(SELECT 1 FROM morrow_identity.store_installations i WHERE i.app_key=a.app_key AND i.status='suspended')
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

-- shop/redact's identity handlers (0036), same signature, owner and ACL, with one change:
-- the installation's and its candidate's domain become the pseudonym (ids kept), as before,
-- and its app's install link is cleared unless that app has an installation that is not
-- uninstalled. A reinstall connects through that link and its live installation holds the
-- same shop domain, so a shop/redact for an earlier installation (a late or retried
-- delivery) or the 48-hour deletion of one (0053's connector_deletion_apply calls this same
-- function; ADR-0031 owner question 2: the earlier installation's data is deleted anyway)
-- never leaves the reinstalled store without the link it would need after a later
-- uninstall (the shopify_apps guard only ever clears it). With no live installation the
-- link is cleared, as 0036 did. Idempotent; the counts are of the rows now in the redacted
-- state. Outcomes: applied, ineligible (not uninstalled), not_found, invalid.
CREATE OR REPLACE FUNCTION morrow_identity.work_shopify_redact_identity(p_org text,p_ws text,p_installation_id text)
RETURNS TABLE(outcome text,installations integer,candidates integer,apps integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE i morrow_identity.store_installations%ROWTYPE; v_shop text; v_at timestamptz; v_pseudonym text;
 n_candidates integer; n_apps integer; v_live boolean;
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
 -- The install (and reinstall) lock above serialises this with a reinstall of the shop.
 v_live:=EXISTS(SELECT 1 FROM morrow_identity.store_installations x WHERE x.app_key=i.app_key AND x.status<>'uninstalled');
 IF NOT v_live THEN
  UPDATE morrow_identity.shopify_apps a SET install_url=NULL,revision=a.revision+1
   WHERE a.app_key=i.app_key AND a.invited_organization_id=i.organization_id AND a.invited_workspace_id=i.workspace_id
    AND a.install_url IS NOT NULL;
 END IF;
 SELECT count(*)::integer INTO n_candidates FROM morrow_identity.linking_candidates c WHERE c.installation_id=i.id AND c.redacted_at IS NOT NULL;
 SELECT count(*)::integer INTO n_apps FROM morrow_identity.shopify_apps a
  WHERE a.app_key=i.app_key AND a.invited_organization_id=i.organization_id AND a.invited_workspace_id=i.workspace_id
   AND a.install_url IS NULL;
 RETURN QUERY SELECT 'applied'::text,1,n_candidates,n_apps;
END $$;

-- ---------------------------------------------------------------------------
-- The identity bridges of PR 5: definers owned by the identity owner, EXECUTE for
-- morrow_work_command only. 0053's connector definers (the connector's login) and vault
-- definers (the broker's login) call them; each takes ids or the tenant its caller read
-- from a row, never a value from a client.
-- The health target of one installation: its tenant, app, state, store and connection, the
-- scopes the app requests and the ones the installation records, whether Shopify refused
-- its token, its active credential's id and version, and the people a Reconnect item goes
-- to: the connection steward (the person who linked it) and the Owner (the organization's
-- founding principal). Outcomes: found, not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_health_target(p_installation_id text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,app_key text,status text,store_id text,connection_id text,
 shop_domain text,credential_id text,credential_version bigint,requested_scopes text,granted_scopes text,token_refused boolean,
 credential_destroyed boolean,redacted boolean,steward_principal_id text,owner_principal_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE i morrow_identity.store_installations%ROWTYPE; a morrow_identity.shopify_apps%ROWTYPE; v_steward text; v_owner text;
BEGIN
 IF p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::bigint,
   NULL::text,NULL::text,NULL::boolean,NULL::boolean,NULL::boolean,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO i FROM morrow_identity.store_installations x WHERE x.id=p_installation_id;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::bigint,
   NULL::text,NULL::text,NULL::boolean,NULL::boolean,NULL::boolean,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO a FROM morrow_identity.shopify_apps x WHERE x.app_key=i.app_key;
 SELECT l.actor_principal_id::text INTO v_steward FROM morrow_identity.workspace_store_links l
  WHERE l.id=i.link_id AND l.installation_id=i.id AND l.organization_id=i.organization_id AND l.workspace_id=i.workspace_id;
 SELECT s.principal_id::text INTO v_owner FROM morrow_identity.organization_signups s WHERE s.organization_id=i.organization_id;
 RETURN QUERY SELECT 'found'::text,i.organization_id::text,i.workspace_id::text,i.app_key,i.status,i.store_id::text,i.connection_id::text,
  i.shop_domain,i.credential_id::text,i.credential_version::bigint,a.scopes,array_to_string(i.granted_scopes,','),
  i.token_refused_at IS NOT NULL,i.credential_destroyed_at IS NOT NULL,i.redacted_at IS NOT NULL,v_steward,v_owner;
END $$;
-- Records an installation's scopes (ADR-0025 item 10), under the per-shop install lock, while
-- it is unlinked or linked:
--   narrow    a verified app/scopes_update delivery's current scopes (as the inbox row holds
--             them): the recorded scopes keep only those still granted, never gain one
--             (deliveries arrive out of order; only an observation or a re-authorisation
--             adds a scope back);
--   observed  the broker read the granted scopes back from Shopify with the token of
--             p_credential_version, after resolving the installation at p_revision: both
--             must still be the installation's (no re-authorisation, delivery, link or end
--             since the read began), and the scopes are then recorded as they are (known
--             scopes only) at this observation, and a refusal is cleared;
--   refused   Shopify refused that token (same two conditions): the refusal is recorded at
--             this observation; the scopes are kept.
-- A read that began before a narrowing delivery is never recorded after it (PR 5 review
-- finding F2): the narrowing moves the revision, so the read is stale and the cron asks
-- again; only a read that began after it may widen the scopes back.
-- Outcomes: applied (with the scopes before and after), unchanged, ineligible (not unlinked
-- or linked), stale (another token or another change since the read began), not_found,
-- invalid.
CREATE FUNCTION morrow_identity.work_shopify_scopes_record(p_org text,p_ws text,p_installation_id text,p_mode text,p_scopes text,
 p_credential_version text,p_revision text)
RETURNS TABLE(outcome text,prior_scopes text,granted_scopes text,status text,store_id text,connection_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE i morrow_identity.store_installations%ROWTYPE; v_shop text; v_at timestamptz; v_list jsonb; v_new text[]; v_observed timestamptz;
 v_refused timestamptz;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_mode IS NULL OR p_mode NOT IN ('narrow','observed','refused')
  OR (p_mode='refused')<>(p_scopes IS NULL) OR (p_scopes IS NOT NULL AND (octet_length(p_scopes)>4096 OR NOT pg_input_is_valid(p_scopes,'jsonb')))
  OR (p_mode='narrow')<>(p_credential_version IS NULL) OR (p_mode='narrow')<>(p_revision IS NULL)
  OR (p_credential_version IS NOT NULL AND p_credential_version !~ '^[1-9][0-9]{0,15}$')
  OR (p_revision IS NOT NULL AND p_revision !~ '^[1-9][0-9]{0,15}$') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_scopes IS NOT NULL THEN
  v_list:=p_scopes::jsonb;
  IF morrow_identity.shopify_scopes_known(v_list) IS NULL THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
 END IF;
 SELECT x.shop_id INTO v_shop FROM morrow_identity.store_installations x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_installation_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.shopify_install',v_shop)::text,0));
 SELECT * INTO i FROM morrow_identity.store_installations x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_installation_id FOR UPDATE;
 IF i.status NOT IN ('unlinked','linked') THEN
  RETURN QUERY SELECT 'ineligible'::text,array_to_string(i.granted_scopes,','),array_to_string(i.granted_scopes,','),i.status,
   i.store_id::text,i.connection_id::text; RETURN;
 END IF;
 IF p_mode<>'narrow' AND (p_credential_version::bigint<>i.credential_version OR p_revision::bigint<>i.revision) THEN
  RETURN QUERY SELECT 'stale'::text,array_to_string(i.granted_scopes,','),array_to_string(i.granted_scopes,','),i.status,
   i.store_id::text,i.connection_id::text; RETURN;
 END IF;
 v_at:=greatest(date_trunc('milliseconds',clock_timestamp()),i.updated_at);
 v_observed:=i.scopes_observed_at;
 v_refused:=i.token_refused_at;
 IF p_mode='narrow' THEN
  SELECT COALESCE(array_agg(s ORDER BY s),'{}') INTO v_new FROM unnest(i.granted_scopes) s
   WHERE s=ANY(morrow_identity.shopify_scopes_known(v_list));
 ELSE
  -- An observation is strictly later than the last one (the guard's freshness rule).
  v_at:=greatest(v_at,i.scopes_observed_at+interval '1 millisecond');
  v_observed:=v_at;
  IF p_mode='observed' THEN
   v_new:=morrow_identity.shopify_scopes_known(v_list);
   v_refused:=NULL;
  ELSE
   v_new:=i.granted_scopes;
   v_refused:=v_at;
  END IF;
 END IF;
 IF v_new=i.granted_scopes AND v_observed IS NOT DISTINCT FROM i.scopes_observed_at AND v_refused IS NOT DISTINCT FROM i.token_refused_at THEN
  RETURN QUERY SELECT 'unchanged'::text,array_to_string(i.granted_scopes,','),array_to_string(i.granted_scopes,','),i.status,
   i.store_id::text,i.connection_id::text; RETURN;
 END IF;
 UPDATE morrow_identity.store_installations x SET granted_scopes=v_new,scopes_observed_at=v_observed,token_refused_at=v_refused,
  revision=x.revision+1,updated_at=v_at
  WHERE x.organization_id=i.organization_id AND x.workspace_id=i.workspace_id AND x.id=i.id;
 RETURN QUERY SELECT 'applied'::text,array_to_string(i.granted_scopes,','),array_to_string(v_new,','),i.status,i.store_id::text,
  i.connection_id::text;
END $$;
-- The broker's read-back target (0053's vault check): the live installation's tenant, shop
-- domain, credential id and version, and its revision (the record of the read refuses it as
-- stale once the installation has changed since), only while unlinked or linked and not
-- redacted. Outcomes: found, ineligible, not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_check_target(p_installation_id text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,shop_domain text,credential_id text,credential_version text,
 revision text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE i morrow_identity.store_installations%ROWTYPE;
BEGIN
 IF p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO i FROM morrow_identity.store_installations x WHERE x.id=p_installation_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF i.status NOT IN ('unlinked','linked') OR i.redacted_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a
   WHERE a.app_key=i.app_key AND a.status='active') THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 RETURN QUERY SELECT 'found'::text,i.organization_id::text,i.workspace_id::text,i.shop_domain,i.credential_id::text,i.credential_version::text,
  i.revision::text;
END $$;
-- The cron's read-back list (ids only, across tenants): live installations of active apps
-- whose scopes were not observed in the last 24 hours, oldest first, at most 20.
CREATE FUNCTION morrow_identity.work_shopify_checks_due()
RETURNS TABLE(installation_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT i.id::text FROM morrow_identity.store_installations i
 WHERE i.status IN ('unlinked','linked') AND i.redacted_at IS NULL
  AND (i.scopes_observed_at IS NULL OR i.scopes_observed_at<pg_catalog.clock_timestamp()-interval '24 hours')
  AND EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a WHERE a.app_key=i.app_key AND a.status='active')
 ORDER BY i.scopes_observed_at NULLS FIRST,i.created_at,i.id LIMIT 20
$$;
-- The cron's reconcile list (ids only, across tenants): every live installation of an active
-- app that needs reconnecting (a requested scope the installation does not record, or a
-- token Shopify refused). Not capped here: 0053's connector_notices_due (its only caller)
-- keeps the ones whose connection has no open Reconnect item yet (a recorded narrowing or
-- refusal whose reconcile was lost) and caps its merged list at 20. A cap here, in an order
-- the reconcile never changes, would let the same 20 that already have their items hide
-- every other one for good (PR 5 review finding F3). The set is only the live
-- installations that need reconnecting now.
CREATE FUNCTION morrow_identity.work_shopify_reconnect_due()
RETURNS TABLE(installation_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT i.id::text FROM morrow_identity.store_installations i JOIN morrow_identity.shopify_apps a ON a.app_key=i.app_key
 WHERE i.status IN ('unlinked','linked') AND i.redacted_at IS NULL AND a.status='active'
  AND (i.token_refused_at IS NOT NULL OR NOT (string_to_array(a.scopes,',')<@i.granted_scopes))
 ORDER BY i.id
$$;
-- A reinstall's leftovers (0053's vault prepare destroys them first): earlier installations
-- of this app and shop that are uninstalled and whose token's destruction is not recorded.
CREATE FUNCTION morrow_identity.work_shopify_reinstall_leftovers(p_app_key text,p_shop_id text)
RETURNS TABLE(installation_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT i.id::text FROM morrow_identity.store_installations i
 WHERE p_app_key ~ '^[a-z0-9][a-z0-9-]{2,62}$' AND p_shop_id ~ '^[1-9][0-9]{0,19}$'
  AND i.app_key=p_app_key AND i.shop_id=p_shop_id AND i.status='uninstalled' AND i.credential_destroyed_at IS NULL
 ORDER BY i.created_at,i.id LIMIT 20
$$;
-- The 48-hour deletion's list (ids only, across tenants; ADR-0031 item 3): installations
-- uninstalled at least 48 hours ago that are not redacted and have no deletion record (a
-- shop/redact redacted them already otherwise), and those whose deletion is still open (its
-- handlers ran and redacted the installation, but the token's destruction was not yet
-- recorded), oldest first, at most 20.
CREATE FUNCTION morrow_identity.work_shopify_deletions_due()
RETURNS TABLE(installation_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT i.id::text FROM morrow_identity.store_installations i
 WHERE i.status='uninstalled' AND i.uninstalled_at<=pg_catalog.clock_timestamp()-interval '48 hours'
  AND ((i.redacted_at IS NULL AND NOT EXISTS(SELECT 1 FROM morrow_identity.store_data_deletions d WHERE d.installation_id=i.id))
   OR EXISTS(SELECT 1 FROM morrow_identity.store_data_deletions d WHERE d.installation_id=i.id AND d.status='open'))
 ORDER BY i.uninstalled_at,i.id LIMIT 20
$$;
-- Opens (or returns) the 48-hour deletion of one installation, under the per-shop install
-- lock: the installation must be uninstalled for 48 hours and not redacted (a shop/redact
-- that redacted it holds its own record, the privacy request). The record is born once per
-- installation (UNIQUE); a completed one is reported settled. Returns the tenant and store
-- the work-side handlers take, and whether the token's destruction is recorded.
-- Outcomes: opened, open, settled, ineligible (not uninstalled, not yet due, or redacted
-- before any deletion record), not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_deletion_open(p_installation_id text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,store_id text,connection_id text,app_key text,
 credential_destroyed boolean,credential_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE i morrow_identity.store_installations%ROWTYPE; d morrow_identity.store_data_deletions%ROWTYPE; v_shop text; v_at timestamptz;
 v_outcome text; v_recorded boolean;
BEGIN
 IF p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::boolean,NULL::bigint; RETURN;
 END IF;
 SELECT x.shop_id INTO v_shop FROM morrow_identity.store_installations x WHERE x.id=p_installation_id;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::boolean,NULL::bigint; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.shopify_install',v_shop)::text,0));
 SELECT * INTO i FROM morrow_identity.store_installations x WHERE x.id=p_installation_id FOR UPDATE;
 SELECT * INTO d FROM morrow_identity.store_data_deletions x WHERE x.installation_id=i.id FOR UPDATE;
 v_recorded:=FOUND;
 IF v_recorded AND d.status='completed' THEN
  RETURN QUERY SELECT 'settled'::text,i.organization_id::text,i.workspace_id::text,i.store_id::text,i.connection_id::text,i.app_key,
   i.credential_destroyed_at IS NOT NULL,i.credential_version::bigint; RETURN;
 END IF;
 v_at:=date_trunc('milliseconds',clock_timestamp());
 IF NOT v_recorded THEN
  IF i.status<>'uninstalled' OR i.uninstalled_at>v_at-interval '48 hours' OR i.redacted_at IS NOT NULL THEN
   RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::boolean,NULL::bigint; RETURN;
  END IF;
  INSERT INTO morrow_identity.store_data_deletions(organization_id,workspace_id,id,installation_id,app_key,store_id,trigger,uninstalled_at,
   due_at,opened_at,expires_at,status,completed_at,evidence,evidence_digest)
  VALUES (i.organization_id,i.workspace_id,gen_random_uuid()::text,i.id,i.app_key,i.store_id,'uninstall_48h',i.uninstalled_at,
   i.uninstalled_at+interval '48 hours',v_at,v_at+interval '365 days','open',NULL,NULL,NULL);
  v_outcome:='opened';
 ELSE
  v_outcome:='open';
 END IF;
 RETURN QUERY SELECT v_outcome,i.organization_id::text,i.workspace_id::text,i.store_id::text,i.connection_id::text,i.app_key,
  i.credential_destroyed_at IS NOT NULL,i.credential_version::bigint;
END $$;
-- Completes the open 48-hour deletion of one installation with its evidence (the CHECK
-- refuses evidence with anything outstanding). Outcomes: completed, already_completed,
-- not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_deletion_complete(p_org text,p_ws text,p_installation_id text,p_evidence jsonb)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE d morrow_identity.store_data_deletions%ROWTYPE;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN 'invalid'; END IF;
 SELECT * INTO d FROM morrow_identity.store_data_deletions x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.installation_id=p_installation_id FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 IF d.status='completed' THEN RETURN 'already_completed'; END IF;
 IF NOT morrow_identity.store_deletion_evidence_valid(p_evidence) THEN RETURN 'invalid'; END IF;
 UPDATE morrow_identity.store_data_deletions x SET status='completed',completed_at=greatest(date_trunc('milliseconds',clock_timestamp()),x.opened_at),
  evidence=p_evidence,evidence_digest=encode(sha256(convert_to(p_evidence::text,'UTF8')),'hex')
  WHERE x.organization_id=d.organization_id AND x.workspace_id=d.workspace_id AND x.id=d.id;
 RETURN 'completed';
END $$;
-- Stuck deliveries (ids and counts only, across tenants): an inbox row still received 24
-- hours after it arrived. A scope change is closed with the recorded outcome stuck_closed
-- (ignored; the daily read-back reconciles the scopes); every other topic is only counted,
-- never closed: an uninstall and the compliance topics carry an end or a privacy request
-- that must complete (the privacy deadline check logs those). At most 20 closed per call.
CREATE FUNCTION morrow_identity.work_shopify_inbox_stuck()
RETURNS TABLE(closed integer,stuck integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; n integer:=0; v_stuck integer;
BEGIN
 FOR r IN SELECT x.id::text AS id FROM morrow_identity.shopify_webhook_inbox x
   WHERE x.status='received' AND x.topic='app/scopes_update' AND x.received_at<pg_catalog.clock_timestamp()-interval '24 hours'
   ORDER BY x.received_at,x.id LIMIT 20 LOOP
  IF morrow_identity.work_shopify_inbox_settle(r.id,'ignored','stuck_closed',jsonb_build_object('reason','stuck')) IN ('settled','already_settled') THEN
   n:=n+1;
  END IF;
 END LOOP;
 SELECT count(*)::integer INTO v_stuck FROM morrow_identity.shopify_webhook_inbox x
  WHERE x.status='received' AND x.received_at<pg_catalog.clock_timestamp()-interval '24 hours';
 RETURN QUERY SELECT n,v_stuck;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.work_shopify_health_target(text),
 morrow_identity.work_shopify_scopes_record(text,text,text,text,text,text,text),morrow_identity.work_shopify_check_target(text),
 morrow_identity.work_shopify_checks_due(),morrow_identity.work_shopify_reconnect_due(),
 morrow_identity.work_shopify_reinstall_leftovers(text,text),
 morrow_identity.work_shopify_deletions_due(),morrow_identity.work_shopify_deletion_open(text),
 morrow_identity.work_shopify_deletion_complete(text,text,text,jsonb),
 morrow_identity.work_shopify_inbox_stuck() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_shopify_health_target(text),
 morrow_identity.work_shopify_scopes_record(text,text,text,text,text,text,text),morrow_identity.work_shopify_check_target(text),
 morrow_identity.work_shopify_checks_due(),morrow_identity.work_shopify_reconnect_due(),
 morrow_identity.work_shopify_reinstall_leftovers(text,text),
 morrow_identity.work_shopify_deletions_due(),morrow_identity.work_shopify_deletion_open(text),
 morrow_identity.work_shopify_deletion_complete(text,text,text,jsonb),
 morrow_identity.work_shopify_inbox_stuck() TO morrow_work_command;
COMMIT;
