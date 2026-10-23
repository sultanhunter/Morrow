BEGIN;
-- v1 PR 1: the broker's live-store admission (ADR-0035 item 2; docs/briefs/v1-connect-store.md).
-- Executes AS morrow_work_owner, after 0039. One vault definer, SECURITY DEFINER, owned by
-- morrow_work_command after the transfer below, guarded by
-- work_executor_safe('morrow_vault_broker') and executable by the broker's own login only.
-- The broker asks it, inside its install transaction and before any prepare or seal, when
-- Shopify reports that the store is not a Partner development store: only the active app
-- that carries the live-store mark (0039), and only for its own intended shop, is admitted.
-- It takes the app key and the shop domain the broker verified; the answer comes from the
-- registry through 0039's identity bridge. Outcomes: admitted, refused, invalid, denied.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_live_store(text,text)','EXECUTE')
 OR to_regprocedure('morrow_vault.shopify_install_store(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_vault.shopify_live_store_admission(text,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'SHOPIFY_LIVE_STORE_VAULT_PREREQUISITES_INVALID'; END IF;
END $$;

CREATE FUNCTION morrow_vault.shopify_live_store_admission(p_app_key text,p_shop_domain text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN 'denied'; END IF;
 RETURN COALESCE(morrow_identity.work_shopify_live_store(p_app_key,p_shop_domain),'invalid');
END $$;

REVOKE ALL ON FUNCTION morrow_vault.shopify_live_store_admission(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_vault.shopify_live_store_admission(text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_vault.shopify_live_store_admission(text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_vault FROM morrow_work_command;
COMMIT;
