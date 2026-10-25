BEGIN;
-- Shop-specific webhook subscriptions, the identity side (docs/briefs/shopify-shop-specific-webhooks.md;
-- ADR-0022 items 4 and 7). Executes AS morrow_identity_owner, after 0046. Shopify CLI 4.9
-- refuses app-specific webhook topics while use_legacy_install_flow is on (the connector's own
-- authorization-code install), so the app configuration subscribes only the three compliance
-- topics, and the broker, the only holder of each store's offline token, registers
-- app/uninstalled and app/scopes_update for each active installation as shop-specific
-- subscriptions to the connector's signed webhook path. This file adds:
--   * shopify_webhook_registrations: per installation, the closed outcome of the broker's last
--     registration for the installation's credential version (registered, failed, unknown,
--     unauthorized), Shopify's two subscription ids once registered, and the number of
--     consecutive attempts that did not register. Content-free (ids, codes, counts and
--     times); ENABLE and FORCE RLS with the identity_owner policy only; its own guard
--     (shopify_webhook_registration_guard, INVOKER, granted to nobody): born at revision 1,
--     each change one revision with the tenant, the installation and the creation time fixed
--     and the credential version never going back; no delete or truncate;
--   * three identity bridges (SECURITY DEFINER, EXECUTE for morrow_work_command only; the
--     broker's vault definers of shopify-webhook-registrations-vault call them): the
--     registration target of one active installation (its tenant, app key, shop domain and
--     current credential), the record of one outcome for the credential version the broker
--     used, and the ids-only, cross-tenant list of active installations whose current
--     version is not registered (a missing row, an older version, or a failed, unknown or
--     unauthorized outcome past its backoff) or was registered more than 24 hours ago (a
--     list-only re-check), at most 10.
-- An active installation is unlinked or linked, of an active app, not redacted, with its
-- credential's destruction not recorded. A re-authorisation adds a credential version, so the
-- installation is listed again and its subscriptions are listed and completed with the new
-- token. Shopify removes a shop-specific subscription whose deliveries keep failing (eight
-- retries over about four hours, for example a broker or vault outage that long), and only a
-- new create brings it back, so a registered row is listed again 24 hours after its record:
-- the broker lists first and creates only a missing subscription, so a re-check of a store
-- whose subscriptions still exist is one list and one record. The tenant always comes from
-- the installation row, never from a caller (invariant 1).
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regclass('morrow_identity.store_installations') IS NULL OR to_regclass('morrow_identity.shopify_apps') IS NULL
 OR to_regclass('morrow_identity.shopify_webhook_registrations') IS NOT NULL
 OR to_regprocedure('morrow_identity.shopify_webhook_registration_guard()') IS NOT NULL
 OR to_regprocedure('morrow_identity.work_shopify_webhook_target(text)') IS NOT NULL
 OR to_regprocedure('morrow_identity.work_shopify_webhook_registration_record(text,text,text,text,text)') IS NOT NULL
 OR to_regprocedure('morrow_identity.work_shopify_webhook_registrations_pending()') IS NOT NULL
 OR (SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_identity.store_installations'::regclass
   AND a.attname IN ('credential_version','credential_destroyed_at','redacted_at','status','app_key') AND NOT a.attisdropped)<>5
 THEN RAISE EXCEPTION 'SHOPIFY_WEBHOOK_REGISTRATIONS_IDENTITY_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- One row per installation, keyed by its tenant (composite foreign key to the installation).
-- registered carries both subscription ids (the numeric tail of Shopify's
-- gid://shopify/WebhookSubscription/<id>) and no attempt count; every other outcome carries
-- neither id and counts its consecutive attempts for the backoff.
CREATE TABLE morrow_identity.shopify_webhook_registrations (
 organization_id morrow_identity.record_id NOT NULL,
 workspace_id morrow_identity.record_id NOT NULL,
 installation_id morrow_identity.record_id NOT NULL UNIQUE,
 credential_version morrow_identity.revision NOT NULL,
 status text NOT NULL CHECK (status IN ('registered','failed','unknown','unauthorized')),
 uninstalled_subscription_id text CHECK (uninstalled_subscription_id ~ '^[1-9][0-9]{0,19}$'),
 scopes_update_subscription_id text CHECK (scopes_update_subscription_id ~ '^[1-9][0-9]{0,19}$'),
 attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 1000000),
 revision morrow_identity.revision NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,installation_id),
 FOREIGN KEY (organization_id,workspace_id,installation_id)
  REFERENCES morrow_identity.store_installations(organization_id,workspace_id,id),
 CHECK ((status='registered')=(uninstalled_subscription_id IS NOT NULL)
  AND (status='registered')=(scopes_update_subscription_id IS NOT NULL)
  AND (status='registered')=(attempts=0)
  AND (uninstalled_subscription_id IS NULL OR uninstalled_subscription_id<>scopes_update_subscription_id)),
 CHECK (updated_at>=created_at)
);
ALTER TABLE morrow_identity.shopify_webhook_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_identity.shopify_webhook_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_owner ON morrow_identity.shopify_webhook_registrations TO morrow_identity_owner USING(true) WITH CHECK(true);
REVOKE ALL ON morrow_identity.shopify_webhook_registrations FROM PUBLIC;

-- The guard: born at revision 1; each change one revision, never touching the tenant, the
-- installation or the creation time, never moving the credential version back; no delete
-- or truncate.
CREATE FUNCTION morrow_identity.shopify_webhook_registration_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision=1 AND NEW.updated_at=NEW.created_at THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'SHOPIFY_WEBHOOK_REGISTRATION_INVALID';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.organization_id=OLD.organization_id AND NEW.workspace_id=OLD.workspace_id AND NEW.installation_id=OLD.installation_id
   AND NEW.created_at=OLD.created_at AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at
   AND NEW.credential_version>=OLD.credential_version THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'SHOPIFY_WEBHOOK_REGISTRATION_IMMUTABLE';
END $$;
CREATE TRIGGER shopify_webhook_registration_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_identity.shopify_webhook_registrations
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.shopify_webhook_registration_guard();
CREATE TRIGGER shopify_webhook_registration_no_truncate BEFORE TRUNCATE ON morrow_identity.shopify_webhook_registrations
 FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity.shopify_webhook_registration_guard();

-- ---------------------------------------------------------------------------
-- The registration target of one active installation: its tenant, app key, shop domain,
-- credential id and current credential version (the vault definer reads that version's
-- envelope). Nothing for an ended, redacted or unknown installation or a retired app.
-- Outcomes: found, not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_webhook_target(p_installation_id text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,app_key text,shop_domain text,credential_id text,
 credential_version text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE i record;
BEGIN
 IF p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.app_key,x.shop_domain,
  x.credential_id::text AS credential_id,x.credential_version::text AS credential_version INTO i
  FROM morrow_identity.store_installations x JOIN morrow_identity.shopify_apps a ON a.app_key=x.app_key AND a.status='active'
  WHERE x.id=p_installation_id AND x.status IN ('unlinked','linked') AND x.redacted_at IS NULL AND x.credential_destroyed_at IS NULL;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 RETURN QUERY SELECT 'found'::text,i.organization_id,i.workspace_id,i.app_key,i.shop_domain,i.credential_id,i.credential_version;
END $$;

-- The record of one registration outcome, for the credential version the broker used. Only
-- while that version is the installation's current one and the installation is active: an
-- outcome for an older token, or for an installation that ended meanwhile, records nothing
-- (stale). Under a per-installation lock, so two concurrent records serialise. registered
-- needs both subscription ids and resets the attempt count; any other outcome takes neither
-- id and counts one more attempt of the same version (a new version starts at 1).
-- Outcomes: recorded, stale, not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_webhook_registration_record(p_installation_id text,p_credential_version text,
 p_status text,p_uninstalled_subscription_id text,p_scopes_update_subscription_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE i morrow_identity.store_installations%ROWTYPE; w morrow_identity.shopify_webhook_registrations%ROWTYPE;
 v_version bigint; v_at timestamptz; v_attempts integer;
BEGIN
 IF p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_credential_version IS NULL OR p_credential_version !~ '^[1-9][0-9]{0,15}$'
  OR p_status IS NULL OR p_status NOT IN ('registered','failed','unknown','unauthorized')
  OR (p_status='registered')<>(p_uninstalled_subscription_id IS NOT NULL)
  OR (p_status='registered')<>(p_scopes_update_subscription_id IS NOT NULL)
  OR (p_uninstalled_subscription_id IS NOT NULL AND p_uninstalled_subscription_id !~ '^[1-9][0-9]{0,19}$')
  OR (p_scopes_update_subscription_id IS NOT NULL AND p_scopes_update_subscription_id !~ '^[1-9][0-9]{0,19}$')
  OR p_uninstalled_subscription_id=p_scopes_update_subscription_id THEN
  RETURN 'invalid';
 END IF;
 v_version:=p_credential_version::bigint;
 SELECT * INTO i FROM morrow_identity.store_installations x WHERE x.id=p_installation_id FOR SHARE;
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 IF i.credential_version<>v_version OR i.status NOT IN ('unlinked','linked') OR i.redacted_at IS NOT NULL
  OR i.credential_destroyed_at IS NOT NULL THEN
  RETURN 'stale';
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.identity.shopify_webhook_registration',i.id::text)::text,0));
 v_at:=date_trunc('milliseconds',clock_timestamp());
 SELECT * INTO w FROM morrow_identity.shopify_webhook_registrations x WHERE x.installation_id=i.id FOR UPDATE;
 IF NOT FOUND THEN
  INSERT INTO morrow_identity.shopify_webhook_registrations(organization_id,workspace_id,installation_id,credential_version,status,
   uninstalled_subscription_id,scopes_update_subscription_id,attempts,revision,created_at,updated_at)
  VALUES (i.organization_id,i.workspace_id,i.id,v_version,p_status,p_uninstalled_subscription_id,p_scopes_update_subscription_id,
   CASE WHEN p_status='registered' THEN 0 ELSE 1 END,1,v_at,v_at);
  RETURN 'recorded';
 END IF;
 IF w.credential_version>v_version THEN RETURN 'stale'; END IF;
 v_attempts:=CASE WHEN p_status='registered' THEN 0
  WHEN w.credential_version=v_version AND w.status<>'registered' THEN least(w.attempts+1,1000000) ELSE 1 END;
 UPDATE morrow_identity.shopify_webhook_registrations x SET credential_version=v_version,status=p_status,
  uninstalled_subscription_id=p_uninstalled_subscription_id,scopes_update_subscription_id=p_scopes_update_subscription_id,
  attempts=v_attempts,revision=x.revision+1,updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=w.organization_id AND x.workspace_id=w.workspace_id AND x.installation_id=w.installation_id;
 RETURN 'recorded';
END $$;

-- The broker's re-drive (ids only, across tenants): active installations whose current
-- credential version has no registered row, or whose registered row is due for its re-check.
-- A missing row or an older version comes first and at once; a failed, unknown or
-- unauthorized outcome waits 4 minutes per consecutive attempt, at most 6 hours, so the
-- connector's five-minute cron retries it without spending Shopify's or the vault login's
-- budget on a store that keeps failing; a registered row comes back 24 hours after its last
-- record, last, so the broker lists the store again and re-creates a subscription Shopify
-- removed after failed deliveries (recording registered again moves the row's time). Within
-- each class the oldest first. At most 10.
CREATE FUNCTION morrow_identity.work_shopify_webhook_registrations_pending()
RETURNS TABLE(installation_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT i.id::text FROM morrow_identity.store_installations i
  JOIN morrow_identity.shopify_apps a ON a.app_key=i.app_key AND a.status='active'
  LEFT JOIN morrow_identity.shopify_webhook_registrations w ON w.organization_id=i.organization_id
   AND w.workspace_id=i.workspace_id AND w.installation_id=i.id
  WHERE i.status IN ('unlinked','linked') AND i.redacted_at IS NULL AND i.credential_destroyed_at IS NULL
   AND (w.installation_id IS NULL OR w.credential_version<>i.credential_version
    OR (w.status<>'registered'
     AND w.updated_at<=pg_catalog.clock_timestamp()-least(interval '4 minutes'*w.attempts,interval '6 hours'))
    OR (w.status='registered' AND w.updated_at<=pg_catalog.clock_timestamp()-interval '24 hours'))
  ORDER BY CASE WHEN w.installation_id IS NULL OR w.credential_version<>i.credential_version THEN 0
   WHEN w.status<>'registered' THEN 1 ELSE 2 END,COALESCE(w.updated_at,i.updated_at),i.id
  LIMIT 10
$$;

REVOKE ALL ON FUNCTION morrow_identity.shopify_webhook_registration_guard(),morrow_identity.work_shopify_webhook_target(text),
 morrow_identity.work_shopify_webhook_registration_record(text,text,text,text,text),
 morrow_identity.work_shopify_webhook_registrations_pending() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_shopify_webhook_target(text),
 morrow_identity.work_shopify_webhook_registration_record(text,text,text,text,text),
 morrow_identity.work_shopify_webhook_registrations_pending() TO morrow_work_command;
COMMIT;
