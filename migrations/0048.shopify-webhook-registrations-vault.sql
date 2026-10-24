BEGIN;
-- Shop-specific webhook subscriptions, the vault side (docs/briefs/shopify-shop-specific-webhooks.md;
-- ADR-0022 items 4 and 7). Executes AS morrow_work_owner, after shopify-webhook-registrations-identity.
-- Three vault definers, SECURITY DEFINER, owned by morrow_work_command after the transfer
-- below, guarded by work_executor_safe('morrow_vault_broker') and executable by the broker's
-- own login only (ConnectorBroker.shopifyWebhookSubscriptionsSync, apps/broker/src/shopify-webhooks.ts):
--   * shopify_webhook_registrations_pending: the identity bridge's ids-only list of active
--     installations whose current credential version is not registered;
--   * shopify_webhook_target: one such installation's tenant, app key, shop domain and the
--     active envelope of its current credential version, whose subject is the installation
--     (the broker opens it with the KEK; the additional data binds the tenant, the
--     credential, the installation and the version). The identity bridge decides what is
--     active; nothing is returned for an ended installation or a destroyed credential;
--   * shopify_webhook_registration_record: one closed outcome (and, once registered,
--     Shopify's two subscription ids) for the version the broker used.
-- Each takes ids and codes only; the tenant always comes from the installation row.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regclass('morrow_vault.credentials') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_webhook_target(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command',
   'morrow_identity.work_shopify_webhook_registration_record(text,text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_webhook_registrations_pending()','EXECUTE')
 OR to_regprocedure('morrow_vault.shopify_webhook_target(text)') IS NOT NULL
 OR to_regprocedure('morrow_vault.shopify_webhook_registration_record(text,text,text,text,text)') IS NOT NULL
 OR to_regprocedure('morrow_vault.shopify_webhook_registrations_pending()') IS NOT NULL
 THEN RAISE EXCEPTION 'SHOPIFY_WEBHOOK_REGISTRATIONS_VAULT_PREREQUISITES_INVALID'; END IF;
END $$;

-- At most 10 installation ids, oldest due first. Nothing for any other login.
CREATE FUNCTION morrow_vault.shopify_webhook_registrations_pending()
RETURNS TABLE(installation_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN; END IF;
 RETURN QUERY SELECT p.installation_id FROM morrow_identity.work_shopify_webhook_registrations_pending() p;
END $$;
-- The target and its token's envelope. Outcomes: found, not_found (an unknown or ended
-- installation, a retired app), credential_unavailable (no active version of the current
-- credential whose subject is the installation), invalid, denied.
CREATE FUNCTION morrow_vault.shopify_webhook_target(p_installation_id text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,app_key text,shop_domain text,credential_id text,
 credential_version text,kek_version text,wrapped_key text,sealed_value text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; c record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 SELECT * INTO t FROM morrow_identity.work_shopify_webhook_target(p_installation_id);
 IF t.outcome IS DISTINCT FROM 'found' THEN
  RETURN QUERY SELECT COALESCE(t.outcome,'invalid'),NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text;
  RETURN;
 END IF;
 SELECT x.kek_version::text AS kek_version,encode(x.wrapped_key,'hex') AS wrapped_key,encode(x.sealed_value,'hex') AS sealed_value INTO c
  FROM morrow_vault.credentials x
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=t.credential_id
   AND x.version::text=t.credential_version AND x.subject_id=p_installation_id AND x.status='active'
   AND x.provider='shopify' AND x.kind='shopify_offline_token';
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'credential_unavailable'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text;
  RETURN;
 END IF;
 RETURN QUERY SELECT 'found'::text,t.organization_id,t.workspace_id,t.app_key,t.shop_domain,t.credential_id,t.credential_version,
  c.kek_version,c.wrapped_key,c.sealed_value;
END $$;
-- One outcome, through the identity bridge (which checks the version, the status and the
-- ids). An absent subscription id is the empty string, which the statement turns into NULL.
-- Outcomes: recorded, stale, not_found, invalid, denied.
CREATE FUNCTION morrow_vault.shopify_webhook_registration_record(p_installation_id text,p_credential_version text,p_status text,
 p_uninstalled_subscription_id text,p_scopes_update_subscription_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN 'denied'; END IF;
 RETURN COALESCE(morrow_identity.work_shopify_webhook_registration_record(p_installation_id,p_credential_version,p_status,
  p_uninstalled_subscription_id,p_scopes_update_subscription_id),'invalid');
END $$;

REVOKE ALL ON FUNCTION morrow_vault.shopify_webhook_registrations_pending(),morrow_vault.shopify_webhook_target(text),
 morrow_vault.shopify_webhook_registration_record(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_vault.shopify_webhook_registrations_pending(),morrow_vault.shopify_webhook_target(text),
 morrow_vault.shopify_webhook_registration_record(text,text,text,text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_webhook_registrations_pending() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_webhook_target(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_webhook_registration_record(text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_vault FROM morrow_work_command;
COMMIT;
