BEGIN;
-- M2 PR-2: the broker's vault-login definers for the Shopify launch and callback
-- (ADR-0022 items 7-8; ADR-0008 item 2; mvp-architecture §4), and the first writer of
-- morrow_vault.credentials. Executes AS morrow_work_owner, after 0026. Each definer is
-- SECURITY DEFINER, owned by morrow_work_command after the transfer below, guarded by
-- work_executor_safe('morrow_vault_broker') and executable by the broker's own login only.
-- They take app keys, digests, the shop facts the broker verified and hex envelopes; the
-- tenant always comes from the registry through 0026's identity bridges. The offline token
-- exists in plaintext only inside the broker: it arrives here as an AES-256-GCM envelope
-- (wrapped_key, sealed_value) whose additional data the broker built from the prepared
-- ids, and no definer returns key material. shopify_install_store writes the vault row and
-- the identity install record in the broker's one transaction, so there is no orphaned
-- credential and no install without its credential.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR to_regclass('morrow_vault.credentials') IS NULL OR to_regprocedure('morrow_vault.vault_guard()') IS NULL
 OR (SELECT count(*) FROM pg_catalog.pg_policies p WHERE p.schemaname='morrow_vault' AND p.tablename='credentials'
   AND p.policyname='vault_broker')<>1
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_launch(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_state_claim(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_install_prepare(text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_install_record(text,text,text,text,text,text,text,text,text,text,text,text)','EXECUTE')
 OR to_regprocedure('morrow_vault.shopify_install_store(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)') IS NOT NULL
 OR pg_catalog.has_table_privilege('morrow_work_command','morrow_vault.credentials','INSERT')
 OR NOT morrow_identity.morrow_memberships_closed()
 THEN RAISE EXCEPTION 'SHOPIFY_VAULT_INSTALL_PREREQUISITES_INVALID'; END IF;
END $$;

-- The first writer of credentials: insert a version, and destroy the active one (the only
-- update vault_guard admits erases the key material). The vault_broker policy (0020)
-- already limits every read and write to the broker's own login.
GRANT INSERT ON morrow_vault.credentials TO morrow_work_command;
GRANT UPDATE (status,wrapped_key,sealed_value,destroyed_at,destroy_reason) ON morrow_vault.credentials TO morrow_work_command;

-- The registry and installation state for a launch, a status page or a webhook: the
-- public client id, the invited workspace and the installation's status (none, unlinked,
-- linked, suspended, uninstalled). No secret: the broker reads the app secret with
-- app_secret_get. Outcomes: found, not_found, invalid, denied.
CREATE FUNCTION morrow_vault.shopify_launch_context(p_app_key text,p_shop_domain text)
RETURNS TABLE(outcome text,client_id text,workspace_id text,installation text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE r record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO r FROM morrow_identity.work_shopify_launch(p_app_key,p_shop_domain);
 IF r.outcome IS DISTINCT FROM 'found' THEN
  RETURN QUERY SELECT COALESCE(r.outcome,'invalid'),NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 RETURN QUERY SELECT 'found'::text,r.client_id,r.workspace_id,r.installation;
END $$;
-- Claims the callback's state, alone in its own transaction, before the code exchange.
-- Outcomes: claimed (with the shop's digest and the client id), expired, replayed,
-- not_found, invalid, denied.
CREATE FUNCTION morrow_vault.shopify_callback_claim(p_app_key text,p_state_digest text)
RETURNS TABLE(outcome text,shop_digest text,client_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE r record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO r FROM morrow_identity.work_shopify_state_claim(p_app_key,p_state_digest);
 RETURN QUERY SELECT COALESCE(r.outcome,'invalid'),r.shop_digest,r.client_id;
END $$;
-- The ids the broker binds into the token envelope's additional data, before sealing:
-- tenant keys, the installation (the credential's subject), its store and connection,
-- the credential id and the next version. Outcomes: install, reauthorise, state_invalid,
-- ineligible, denied.
CREATE FUNCTION morrow_vault.shopify_install_prepare(p_app_key text,p_state_digest text,p_shop_id text,p_shop_domain text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,installation_id text,store_id text,connection_id text,
 credential_id text,credential_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE r record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO r FROM morrow_identity.work_shopify_install_prepare(p_app_key,p_state_digest,p_shop_id,p_shop_domain);
 RETURN QUERY SELECT COALESCE(r.outcome,'state_invalid'),r.organization_id,r.workspace_id,r.installation_id,r.store_id,
  r.connection_id,r.credential_id,r.credential_version;
END $$;
-- The broker's one install transaction, after prepare and sealing: the identity record
-- first (it rechecks the state, the app, the shop and that the ids are prepare's, and
-- writes nothing when it refuses), then the vault: a re-authorisation destroys the active
-- version (reason reauthorised, key material erased), then the new version is inserted
-- active. Inputs are text: scopes 'read_products,write_products' or 'read_products', the
-- development flag 'true' or 'false', lowercase hex envelopes within the 0020 byte limits
-- and the continuation token's digest. Outcomes: installed, reauthorised (with the
-- workspace and whether a continuation was created), state_invalid, ineligible, invalid,
-- denied.
CREATE FUNCTION morrow_vault.shopify_install_store(p_app_key text,p_state_digest text,p_shop_id text,p_shop_domain text,
 p_scopes text,p_development_store text,p_installation_id text,p_store_id text,p_connection_id text,p_credential_id text,
 p_version text,p_kek_version text,p_wrapped_key text,p_sealed_value text,p_continuation_digest text)
RETURNS TABLE(outcome text,workspace_id text,continuation text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; v_at timestamptz; v_version bigint; n integer;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_version IS NULL OR p_version !~ '^[1-9][0-9]{0,15}$' OR p_kek_version IS NULL OR p_kek_version !~ '^[1-9][0-9]{0,2}$'
  OR p_wrapped_key IS NULL OR p_wrapped_key !~ '^[a-f0-9]+$' OR length(p_wrapped_key)<>120
  OR p_sealed_value IS NULL OR p_sealed_value !~ '^[a-f0-9]+$' OR length(p_sealed_value)%2<>0
  OR length(p_sealed_value) NOT BETWEEN 58 AND 8248 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO r FROM morrow_identity.work_shopify_install_record(p_app_key,p_state_digest,p_shop_id,p_shop_domain,p_scopes,
  p_development_store,p_installation_id,p_store_id,p_connection_id,p_credential_id,p_version,p_continuation_digest);
 IF r.outcome IS NULL OR r.outcome NOT IN ('installed','reauthorised') THEN
  RETURN QUERY SELECT COALESCE(r.outcome,'invalid'),NULL::text,NULL::text; RETURN;
 END IF;
 v_version:=p_version::bigint;
 v_at:=date_trunc('milliseconds',clock_timestamp());
 IF r.outcome='reauthorised' THEN
  UPDATE morrow_vault.credentials c SET status='destroyed',wrapped_key=NULL,sealed_value=NULL,
   destroyed_at=greatest(v_at,c.created_at),destroy_reason='reauthorised'
   WHERE c.organization_id=r.organization_id AND c.workspace_id=r.workspace_id AND c.id=p_credential_id AND c.status='active';
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'SHOPIFY_CREDENTIAL_ACTIVE_MISSING'; END IF;
 END IF;
 INSERT INTO morrow_vault.credentials(organization_id,workspace_id,id,version,provider,kind,subject_id,status,kek_version,
  wrapped_key,sealed_value,created_at,destroyed_at,destroy_reason)
 VALUES (r.organization_id,r.workspace_id,p_credential_id,v_version,'shopify','shopify_offline_token',p_installation_id,'active',
  p_kek_version::integer,decode(p_wrapped_key,'hex'),decode(p_sealed_value,'hex'),v_at,NULL,NULL);
 RETURN QUERY SELECT r.outcome,r.workspace_id,r.continuation;
END $$;

REVOKE ALL ON FUNCTION morrow_vault.shopify_launch_context(text,text),morrow_vault.shopify_callback_claim(text,text),
 morrow_vault.shopify_install_prepare(text,text,text,text),
 morrow_vault.shopify_install_store(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_vault.shopify_launch_context(text,text),morrow_vault.shopify_callback_claim(text,text),
 morrow_vault.shopify_install_prepare(text,text,text,text),
 morrow_vault.shopify_install_store(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_launch_context(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_callback_claim(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_install_prepare(text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_install_store(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_vault FROM morrow_work_command;
COMMIT;
