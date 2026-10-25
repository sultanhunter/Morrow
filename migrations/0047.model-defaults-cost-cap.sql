BEGIN;
-- ADR-0036 (OD-2026-10-25-1): model defaults and the AI cost cap. Executes AS
-- morrow_work_owner, after 0046. No external effect: nothing here sends a request, reserves
-- money or dispatches.
--   * Catalogue version 3 (per product, listings-run@1), published: version 1's entries,
--     credits, rates and caps, with the default selection Opus 5.5 at medium (four credits a
--     product), the default member ceiling 4 that admits it, and no unrecovered-cost cap
--     (docs/decisions/model-policy.json; the generated catalogue's version 3, drift-tested by
--     tests/model-defaults-cost-cap.test.mjs). Version 1 is retired, not removed: a run
--     recorded at version 1 is still booked at version 1. The append-only trigger is lifted
--     for that one status change only, inside this transaction.
--   * model_catalogue_versions.workspace_period_unrecovered_cost_cap_usd becomes nullable:
--     version 1 keeps its published US$4.50, and every later version has none.
--   * morrow_billing.unrecovered_allows (0033's revisable owner helper), revised: it no longer
--     compares the period's unrecovered cost with any cap, for any version. Its callers,
--     run_reserve (0038's revision) and run_product_begin (0038), therefore never return
--     unrecovered_cost_cap. Every other check is unchanged: an unknown version, a missing
--     billing period or a negative worst case is still false, and the per-run US$7 and
--     per-day US$25 caps, the credit and vendor reservations and the three-failure breaker
--     stay in run_reserve and run_product_begin. The unrecovered-cost ledger
--     (unrecovered_costs, unrecovered_cost_entries) still records failed products' cost.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regclass('morrow_work.model_catalogue_versions') IS NULL OR to_regclass('morrow_work.model_catalogue_entries') IS NULL
 OR to_regclass('morrow_work.model_catalogue_rates') IS NULL OR to_regclass('morrow_billing.unrecovered_costs') IS NULL
 OR to_regprocedure('morrow_billing.unrecovered_allows(text,text,timestamp with time zone,integer,numeric)') IS NULL
 OR to_regprocedure('morrow_billing.run_reserve(text,text,text,text,text,text,text,text,integer,text,text,integer,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.run_product_begin(text)') IS NULL
 -- The helper this file replaces, exactly as 0033 wrote it (shared protocol: a later
 -- revision is never overwritten blind).
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('morrow_billing.unrecovered_allows(text,text,timestamp with time zone,integer,numeric)'))
  IS DISTINCT FROM '1d6141a728470d401ea866e20d04fff8'
 -- The catalogue as 0031 and 0038 seeded it: version 1 alone, active, at its pinned digest.
 OR (SELECT count(*) FROM morrow_work.model_catalogue_versions)<>1
 OR NOT EXISTS(SELECT 1 FROM morrow_work.model_catalogue_versions v WHERE v.version=1 AND v.status='active'
   AND v.digest='fca7f9ac7151f67818e5fa242f5e9bca8e6c36246738e78d0ffbd55c39aed660'
   AND v.workspace_period_unrecovered_cost_cap_usd=4.50000000)
 OR (SELECT count(*) FROM morrow_work.model_catalogue_entries)<>9 OR (SELECT count(*) FROM morrow_work.model_catalogue_rates)<>3
 THEN RAISE EXCEPTION 'MODEL_DEFAULTS_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Version 1 keeps its published unrecovered-cost cap; no other version has one.
ALTER TABLE morrow_work.model_catalogue_versions ALTER COLUMN workspace_period_unrecovered_cost_cap_usd DROP NOT NULL,
 ADD CONSTRAINT model_catalogue_versions_unrecovered_cap CHECK ((workspace_period_unrecovered_cost_cap_usd IS NOT NULL)=(version=1));

-- Version 1 retires (its row is otherwise unchanged; status is outside its pinned digest).
ALTER TABLE morrow_work.model_catalogue_versions DISABLE TRIGGER append_only;
UPDATE morrow_work.model_catalogue_versions SET status='retired' WHERE version=1 AND status='active';
ALTER TABLE morrow_work.model_catalogue_versions ENABLE TRIGGER append_only;

-- Version 3, active: exactly as scripts/generate-model-catalogue.mjs computes it.
INSERT INTO morrow_work.model_catalogue_versions(version,status,digest,default_model,default_effort,default_member_credit_ceiling,
 max_products_per_run,run_cost_cap_usd,workspace_daily_cost_cap_usd,workspace_period_unrecovered_cost_cap_usd)
VALUES (3,'active','a162e95134acc2218bf86b40487fa1600c5e315a16f331d6c4d0b3d7392987d0','claude_opus_5_5','medium',4,25,7.00000000,25.00000000,NULL);
INSERT INTO morrow_work.model_catalogue_entries(version,model_key,effort_key,credits_per_product,worst_case_per_product_usd,
 worst_case_per_attempt_usd,run_product_limit) VALUES
 (3,'claude_haiku_5_5','low',1,0.00660000,0.00330000,25),
 (3,'claude_haiku_5_5','medium',1,0.01360000,0.00680000,25),
 (3,'claude_haiku_5_5','high',1,0.01760000,0.00880000,25),
 (3,'claude_sonnet_5_5','low',1,0.13200000,0.06600000,25),
 (3,'claude_sonnet_5_5','medium',2,0.27200000,0.13600000,25),
 (3,'claude_sonnet_5_5','high',3,0.35200000,0.17600000,19),
 (3,'claude_opus_5_5','low',2,0.26400000,0.13200000,25),
 (3,'claude_opus_5_5','medium',4,0.54400000,0.27200000,12),
 (3,'claude_opus_5_5','high',6,0.70400000,0.35200000,9);
INSERT INTO morrow_work.model_catalogue_rates(version,model_key,provider,provider_model_id,input_usd8_per_token,output_usd8_per_token,max_input_tokens) VALUES
 (3,'claude_haiku_5_5','anthropic','claude-haiku-5-5',10,50,8000),
 (3,'claude_sonnet_5_5','anthropic','claude-sonnet-5-5',200,1000,8000),
 (3,'claude_opus_5_5','anthropic','claude-opus-5-5',400,2000,8000);

-- ---------------------------------------------------------------------------
-- unrecovered_allows (0033), revised: no cap (ADR-0036). True for a known catalogue version,
-- a billing period and a non-negative worst case; false otherwise, as before. Its owner,
-- INVOKER security and EXECUTE for morrow_work_command alone are 0033's, kept by OR REPLACE.
CREATE OR REPLACE FUNCTION morrow_billing.unrecovered_allows(p_org text,p_ws text,p_period_start timestamptz,p_catalogue_version integer,p_worst_case_usd numeric)
RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
 SELECT COALESCE((SELECT true FROM morrow_work.model_catalogue_versions v WHERE v.version=p_catalogue_version
  AND p_period_start IS NOT NULL AND p_worst_case_usd>=0),false)
$$;
COMMIT;
