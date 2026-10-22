BEGIN;
-- M3 PR-2 listings runs (ADR-0022 items 2, 3, 9-11, 15 and 16; mvp-architecture §2 steps 7-9,
-- §5, §7, §9 and §11; P13.T01a-T03a, P05.T04b, P11.T04a and P11.T05a minimum). Executes AS
-- morrow_work_owner, after M3 PR-1's run credits (0033) and M2 PR-3's Shopify reads and
-- privacy (0034-0035), whose two revisable helpers it revises (pinned below as 0035 wrote
-- them). On the ADR-0010 tenant pattern: composite
-- tenant keys, ENABLE and FORCE RLS, definers owned by morrow_work_command, INVOKER triggers
-- and checks owned by the owner. No external effect: nothing here sends a request.
--   * Platform: model_catalogue_rates, the per-token rates and provider model id of every
--     published catalogue entry (drift-tested against the generated catalogue), so SQL books
--     an attempt's cost from its token counts itself.
--   * runs (aligned with Run@1; status on the `run` rows of state-transitions.json, seeded
--     here), run_products (one row per requested product, content-free), run_manifests
--     (aligned with RunManifest@1: the selection, its catalogue digest, the provider model,
--     the prompt and schema digests and the running usage totals; content-free),
--     run_model_calls (the attempt fence and the traceRef target; content-free; provider
--     ids never reach the api role), product_snapshots and run_drafts (store content, 90
--     days; deleted at shop/redact by M2 PR-3's handlers).
--   * Forward changes: the run machine in transition_rules; the commands and outbox CHECKs
--     widened by run.admit, run.reconcile, run.admitted and run.status_changed (each the
--     union of every value at this head); the owner-owned credit helpers of 0033 revised
--     (an `attempt` booking that is booked but not yet unrecovered, an `overflow` booking for
--     cost that no longer fits the reservation, the vendor guard admitting a later accrual,
--     and run_product_unrecovered); the lease twins the runtime definers need on the work
--     stream, the outbox, tasks, the approval records and the billing rows; the broker's
--     settings-keyed policies for its two model definers and for M2 PR-3's product read.
--   * M2 PR-3's two revisable helpers (0035), revised now that runs exist:
--     run_product_readable (a run lease reads a product of its own running run, in
--     progress) and store_content_redact (shop/redact also deletes the store's snapshots and
--     drafts).
--   * Definers: the api's begin_run_command, cmd_run_admit, cmd_runs_reconcile and
--     run_interrupted; the
--     runtime's run_start, run_billing_facts, run_product_begin, run_snapshot_put,
--     run_product_finish, run_drafts_pending, run_review_context, submit_agent_proposal and
--     run_finish; the
--     broker's morrow_vault.model_call_begin and model_call_end. The revisable owner helpers
--     run_fence_close_uncertain, run_end and runs_close_stale.
-- ListingsRunWorkflow and modelRespond stay held until the reviewed model-provider switch
-- (docs/decisions/model-provider-staging.json) is turned on by its own reviewed commit.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regclass('morrow_work.agent_installations') IS NULL OR to_regclass('morrow_work.work_envelopes') IS NULL
 OR to_regclass('morrow_work.delegation_hops') IS NULL OR to_regclass('morrow_work.model_catalogue_entries') IS NULL
 OR to_regclass('morrow_billing.credit_reservations') IS NULL OR to_regclass('morrow_billing.vendor_cost_reservations') IS NULL
 OR to_regclass('morrow_billing.run_cost_bookings') IS NULL OR to_regclass('morrow_billing.unrecovered_cost_entries') IS NULL
 OR to_regclass('morrow_billing.credit_wallets') IS NULL OR to_regclass('morrow_billing.verified_payment_events') IS NULL
 OR to_regclass('morrow_work.runs') IS NOT NULL
 OR to_regprocedure('morrow_billing.run_reserve(text,text,text,text,text,text,text,text,integer,text,text,integer,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_billing.run_book_cost(text,text,text,text,numeric,text)') IS NULL
 OR to_regprocedure('morrow_billing.run_settle(text,text,text,integer)') IS NULL
 OR to_regprocedure('morrow_billing.unrecovered_allows(text,text,timestamp with time zone,integer,numeric)') IS NULL
 OR to_regprocedure('morrow_vault.resolve_call(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.delegation_facts(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.lease_open(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.lease_release()') IS NULL OR to_regprocedure('morrow_work.lease_mark_started()') IS NULL
 OR to_regprocedure('morrow_work.current_lease()') IS NULL OR to_regprocedure('morrow_work.current_tenant()') IS NULL
 OR to_regprocedure('morrow_work.command_prelude(text,text)') IS NULL
 OR to_regprocedure('morrow_work.listings_store_current(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.stop_active(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.listings_scope(text,text,text,text)') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_agent_principal_ensure(text,text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_agent_grants_issue(text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_delegation_actor_facts(text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_store_installations(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 -- The shared CHECKs this file widens, exactly as the head defines them (shared protocol).
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_command_type_check')
  IS DISTINCT FROM '38ccece579b04540c42ddf4d1cecc02a'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_check')
  IS DISTINCT FROM '630c5fc98434561a98997ce40b9f2b77'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.outbox_events'::regclass AND c.conname='outbox_events_event_type_check')
  IS DISTINCT FROM 'd4759cacb331ac9f55fd1c075f963d51'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.outbox_events'::regclass AND c.conname='outbox_events_check')
  IS DISTINCT FROM '26a3ec584724e85775e3843226f48b0e'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.outbox_events'::regclass AND c.conname='outbox_events_check1')
  IS DISTINCT FROM 'c86bfbbab54487c0604aa1f1b1e07274'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.outbox_events'::regclass AND c.conname='outbox_events_check3')
  IS DISTINCT FROM 'ebaf56740b25726d9ea98b226385e2fa'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.transition_rules'::regclass AND c.conname='transition_rules_machine_check')
  IS DISTINCT FROM '204273252db20ee9760d350166b6e34b'
 OR EXISTS(SELECT 1 FROM morrow_work.transition_rules t WHERE t.machine='run')
 -- 0033's credit CHECKs this file revises, exactly as migrated.
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_billing.run_cost_bookings'::regclass AND c.conname='run_cost_bookings_kind_check')
  IS DISTINCT FROM 'aa755b25258675af798dd76ba5d9c1ad'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_billing.run_cost_bookings'::regclass AND c.conname='run_cost_bookings_check')
  IS DISTINCT FROM 'f43f5e5735c63eb994358362938d9e59'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_billing.unrecovered_cost_entries'::regclass AND c.conname='unrecovered_cost_entries_kind_check')
  IS DISTINCT FROM '668e746c6b0b8ed7e21156f4600666bd'
 -- M2 PR-3 (0035): the read resolution that calls run_product_readable, and the two
 -- revisable owner helpers this file replaces, exactly as 0035 wrote them (shared protocol:
 -- a later revision is never overwritten blind).
 OR to_regprocedure('morrow_vault.shopify_read_resolve(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.store_content_redact(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.run_product_readable(text,text,text,text)') IS NULL
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_work.store_content_redact(text,text,text)'))
  IS DISTINCT FROM '75bf566fa593783e27ae1cb610135eae'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_work.run_product_readable(text,text,text,text)'))
  IS DISTINCT FROM '9df3d7271b898326a1cd0c4ac9cd9785'
 THEN RAISE EXCEPTION 'LISTINGS_RUNS_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The run rows of state-transitions.json, unchanged (a strict superset of the machine
-- CHECK; the 0018 primary key already carries the guard). Only queued, running and the
-- three terminal states are reachable in the MVP; waiting and paused are recorded for
-- fidelity and never written.
ALTER TABLE morrow_work.transition_rules DROP CONSTRAINT transition_rules_machine_check,
 ADD CONSTRAINT transition_rules_machine_check CHECK (machine IN ('goal','task','question','approval','operation','run'));
INSERT INTO morrow_work.transition_rules(machine,from_status,to_status,actor,guard) VALUES
 ('run','queued','running','runtime','current_lease_and_grants'),
 ('run','running','waiting','runtime','durable_wait_recorded'),
 ('run','waiting','running','runtime','current_lease_and_grants'),
 ('run','running','paused','owner','stop_new_dispatch'),
 ('run','paused','running','runtime','current_lease_and_grants'),
 ('run','running','succeeded','runtime','completion_evidence'),
 ('run','running','failed','runtime','failure_evidence'),
 ('run','queued','cancelled','work_service','no_submitted_effects'),
 ('run','running','cancelled','work_service','submitted_effects_reconciled'),
 ('run','waiting','cancelled','work_service','submitted_effects_reconciled'),
 ('run','paused','cancelled','work_service','submitted_effects_reconciled');

-- ---------------------------------------------------------------------------
-- Pure functions: IMMUTABLE, owned by the owner; the command role holds EXECUTE because
-- CHECK constraints run with the writer's privileges (the 0015 valid_scope pattern).
-- The listing fields as a sorted text[] (morrow_work.listing_fields()).
CREATE FUNCTION morrow_work.listing_field_array() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT ARRAY['descriptionHtml','seo.description','seo.title','tags','title']
$$;
-- A run's requested fields: 1..5 distinct listing fields, sorted (C collation), with both
-- SEO fields or neither (spine §7: both are sent when either changes).
CREATE FUNCTION morrow_work.run_fields_valid(p_fields text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_fields IS NOT NULL AND cardinality(p_fields) BETWEEN 1 AND 5 AND array_position(p_fields,NULL) IS NULL
  AND p_fields<@morrow_work.listing_field_array()
  AND p_fields=ARRAY(SELECT DISTINCT f COLLATE "C" FROM unnest(p_fields) f ORDER BY 1)
  AND (('seo.title'=ANY(p_fields))=('seo.description'=ANY(p_fields)))
$$;
-- CoordinatorRoute@1 (ADR-0022 item 2), written by the code Coordinator and stored with its
-- run: ids only. The canonical text is the Worker's RFC 8785 output; this proves it parses to
-- exactly the run's own columns and a product list of the run's length.
CREATE FUNCTION morrow_work.route_matches(p_canonical text,p_org text,p_ws text,p_run text,p_task text,p_child_task text,
 p_installation text,p_store text,p_connection text,p_fields text[],p_product_count integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE d jsonb;
BEGIN
 IF p_canonical IS NULL OR NOT pg_input_is_valid(p_canonical,'jsonb') THEN RETURN false; END IF;
 d:=p_canonical::jsonb;
 IF jsonb_typeof(d)<>'object' OR jsonb_typeof(d->'products')<>'array' OR jsonb_array_length(d->'products')<>p_product_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'products') e WHERE jsonb_typeof(e)<>'string' OR (e#>>'{}') !~ '^product:[1-9][0-9]{0,19}$')
  OR (SELECT count(DISTINCT e) FROM jsonb_array_elements(d->'products') e)<>jsonb_array_length(d->'products') THEN RETURN false; END IF;
 RETURN d=jsonb_build_object('schemaVersion',1,'dispatcher','builtin_coordinator','specialist','morrow.listings','organizationId',p_org,
  'workspaceId',p_ws,'runId',p_run,'taskId',p_task,'childTaskId',p_child_task,'installationId',p_installation,'storeId',p_store,
  'connectionId',p_connection,'products',d->'products','fields',to_jsonb(p_fields)) IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- A product snapshot as read (spine §7 and §8): exactly the five listing fields of one
-- product, title and description HTML as strings, the SEO pair as strings or nulls and the
-- tags as distinct strings. Its digest is a draft's expectedSourceRevision.
CREATE FUNCTION morrow_work.snapshot_matches(p_canonical text,p_product_id text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE d jsonb;
BEGIN
 IF p_canonical IS NULL OR NOT pg_input_is_valid(p_canonical,'jsonb') THEN RETURN false; END IF;
 d:=p_canonical::jsonb;
 RETURN jsonb_typeof(d)='object' AND d ?& ARRAY['productId','title','descriptionHtml','seo','tags']
  AND (d-ARRAY['productId','title','descriptionHtml','seo','tags'])='{}'::jsonb
  AND d->'productId'=to_jsonb(p_product_id) AND jsonb_typeof(d->'title')='string' AND jsonb_typeof(d->'descriptionHtml')='string'
  AND jsonb_typeof(d->'seo')='object' AND (d->'seo') ?& ARRAY['title','description'] AND ((d->'seo')-ARRAY['title','description'])='{}'::jsonb
  AND jsonb_typeof(d#>'{seo,title}') IN ('string','null') AND jsonb_typeof(d#>'{seo,description}') IN ('string','null')
  AND jsonb_typeof(d->'tags')='array' AND jsonb_array_length(d->'tags')<=250
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'tags') t WHERE jsonb_typeof(t)<>'string')
  AND (SELECT count(DISTINCT t) FROM jsonb_array_elements(d->'tags') t)=jsonb_array_length(d->'tags');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- A validated draft's change set: the CatalogContentChangeSet@1 item `set` of one product.
-- Its keys follow exactly the draft's fields (title, descriptionHtml, the SEO pair as one
-- `seo` object, tags), within the spine §7 bounds: title 1..255 characters, description HTML
-- at most 10,000 bytes, SEO title at most 70 and description at most 320 characters, at most
-- 50 distinct tags of 1..64 characters; the set's canonical text at most 16,000 bytes.
CREATE FUNCTION morrow_work.draft_set_valid(p_canonical text,p_fields text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE d jsonb; v_keys text[];
BEGIN
 IF p_canonical IS NULL OR octet_length(p_canonical)>16000 OR NOT pg_input_is_valid(p_canonical,'jsonb')
  OR NOT morrow_work.run_fields_valid(p_fields) THEN RETURN false; END IF;
 d:=p_canonical::jsonb;
 IF jsonb_typeof(d)<>'object' THEN RETURN false; END IF;
 v_keys:=ARRAY(SELECT DISTINCT CASE WHEN f LIKE 'seo.%' THEN 'seo' ELSE f END FROM unnest(p_fields) f ORDER BY 1);
 IF ARRAY(SELECT k FROM jsonb_object_keys(d) k ORDER BY 1)<>v_keys THEN RETURN false; END IF;
 IF d ? 'title' AND (jsonb_typeof(d->'title')<>'string' OR char_length(d->>'title') NOT BETWEEN 1 AND 255) THEN RETURN false; END IF;
 IF d ? 'descriptionHtml' AND (jsonb_typeof(d->'descriptionHtml')<>'string' OR octet_length(d->>'descriptionHtml')>10000) THEN RETURN false; END IF;
 IF d ? 'seo' AND (jsonb_typeof(d->'seo')<>'object' OR NOT ((d->'seo') ?& ARRAY['title','description'])
  OR ((d->'seo')-ARRAY['title','description'])<>'{}'::jsonb OR jsonb_typeof(d#>'{seo,title}')<>'string'
  OR jsonb_typeof(d#>'{seo,description}')<>'string' OR char_length(d#>>'{seo,title}')>70
  OR char_length(d#>>'{seo,description}')>320) THEN RETURN false; END IF;
 IF d ? 'tags' AND (jsonb_typeof(d->'tags')<>'array' OR jsonb_array_length(d->'tags')>50
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'tags') t WHERE jsonb_typeof(t)<>'string' OR char_length(t#>>'{}') NOT BETWEEN 1 AND 64)
  OR (SELECT count(DISTINCT t) FROM jsonb_array_elements(d->'tags') t)<>jsonb_array_length(d->'tags')) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- A draft's reviewer flags: counts only (no content), closed.
CREATE FUNCTION morrow_work.draft_flags_valid(p_flags jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_flags IS NOT NULL AND jsonb_typeof(p_flags)='object'
  AND p_flags ?& ARRAY['newUrls','newEmails','newPhones','tagsAdded','tagsRemoved']
  AND (p_flags-ARRAY['newUrls','newEmails','newPhones','tagsAdded','tagsRemoved'])='{}'::jsonb
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(p_flags) e WHERE jsonb_typeof(e.value)<>'number' OR (e.value)::text !~ '^(0|[1-9][0-9]{0,2})$')
$$;

-- ---------------------------------------------------------------------------
-- Platform: the per-token rates of every published catalogue entry's model, in 10^-8 USD
-- (the generated catalogue's inputUsd8PerToken and outputUsd8PerToken), its provider model
-- id and the input cap per call. A new version is a new forward migration.
CREATE TABLE morrow_work.model_catalogue_rates (
 version integer NOT NULL REFERENCES morrow_work.model_catalogue_versions(version),
 model_key text NOT NULL CHECK (model_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 provider text NOT NULL CHECK (provider='anthropic'),
 provider_model_id text NOT NULL CHECK (provider_model_id ~ '^[a-z][a-z0-9-]{2,63}$'),
 input_usd8_per_token bigint NOT NULL CHECK (input_usd8_per_token>0),
 output_usd8_per_token bigint NOT NULL CHECK (output_usd8_per_token>0),
 max_input_tokens integer NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 1000000),
 PRIMARY KEY (version,model_key)
);
INSERT INTO morrow_work.model_catalogue_rates(version,model_key,provider,provider_model_id,input_usd8_per_token,output_usd8_per_token,max_input_tokens) VALUES
 (1,'claude_haiku_5_5','anthropic','claude-haiku-5-5',10,50,8000),
 (1,'claude_sonnet_5_5','anthropic','claude-sonnet-5-5',200,1000,8000),
 (1,'claude_opus_5_5','anthropic','claude-opus-5-5',400,2000,8000);

-- ---------------------------------------------------------------------------
-- Tenant tables. Every stored time is millisecond-truncated.
-- One run (aligned with Run@1, mvp-architecture §2 step 7): the parent task T it serves, the
-- child task T' its Listings installation works on, the envelope and hop of the delegation,
-- its run lease, the requester (the merchant), the selection and its multiplier, the
-- CoordinatorRoute@1, the billing account and period it reserved under, and its product
-- counters. Status follows the `run` machine of transition_rules: each change names the edge's
-- actor and guard. No DELETE or TRUNCATE. Content class none.
CREATE TABLE morrow_work.runs (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 task_id morrow_work.record_id NOT NULL,
 child_task_id morrow_work.record_id NOT NULL,
 store_id morrow_work.record_id NOT NULL,
 connection_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id NOT NULL,
 agent_principal_id morrow_work.record_id NOT NULL,
 coordinator_principal_id morrow_work.record_id NOT NULL,
 envelope_id morrow_work.record_id NOT NULL,
 hop_id morrow_work.record_id NOT NULL,
 lease_id morrow_work.record_id NOT NULL,
 lease_generation morrow_work.revision NOT NULL,
 requester_principal_id morrow_work.record_id NOT NULL,
 requester_membership_id morrow_work.record_id NOT NULL,
 status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
 status_actor text NOT NULL CHECK (status_actor ~ '^[a-z_]{1,32}$'),
 status_guard text NOT NULL CHECK (status_guard ~ '^[a-z_]{1,64}$'),
 ended_reason text CHECK (ended_reason IN ('breaker','unrecovered_cost_cap','spend_limit','provider_error','cost_overflow',
  'reservation_exhausted','time_budget','delegation_denied','entitlement','nothing_drafted','stopped','lease_ended','broker_held',
  'read_unavailable','proposal_refused')),
 catalogue_version integer NOT NULL,
 model_key text NOT NULL,
 effort_key text NOT NULL,
 credits_per_product integer NOT NULL CHECK (credits_per_product BETWEEN 1 AND 99),
 product_count integer NOT NULL CHECK (product_count BETWEEN 1 AND 25),
 fields text[] NOT NULL,
 route_canonical text NOT NULL CHECK (octet_length(route_canonical)<=8192),
 route_digest morrow_work.digest NOT NULL,
 billing_account_id morrow_work.record_id NOT NULL,
 period_start timestamptz NOT NULL CHECK (period_start=date_trunc('milliseconds',period_start) AND isfinite(period_start)),
 products_drafted integer NOT NULL CHECK (products_drafted>=0),
 products_failed integer NOT NULL CHECK (products_failed>=0),
 consecutive_failed integer NOT NULL CHECK (consecutive_failed>=0),
 workflow_version text NOT NULL CHECK (workflow_version ~ '^listings-run@[1-9][0-9]{0,3}$'),
 command_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 started_at timestamptz CHECK (started_at=date_trunc('milliseconds',started_at) AND isfinite(started_at)),
 ended_at timestamptz CHECK (ended_at=date_trunc('milliseconds',ended_at) AND isfinite(ended_at)),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,lease_id),
 UNIQUE (organization_id,workspace_id,child_task_id),
 UNIQUE (organization_id,workspace_id,envelope_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,task_id) REFERENCES morrow_work.tasks(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,child_task_id) REFERENCES morrow_work.tasks(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,envelope_id) REFERENCES morrow_work.work_envelopes(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,hop_id) REFERENCES morrow_work.delegation_hops(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,lease_id) REFERENCES morrow_work.work_leases(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,requester_membership_id,requester_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,requester_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 FOREIGN KEY (catalogue_version,model_key,effort_key) REFERENCES morrow_work.model_catalogue_entries(version,model_key,effort_key),
 FOREIGN KEY (organization_id,workspace_id,billing_account_id) REFERENCES morrow_billing.billing_accounts(organization_id,workspace_id,id),
 CONSTRAINT runs_fields CHECK (morrow_work.run_fields_valid(fields)),
 CONSTRAINT runs_counts CHECK (products_drafted+products_failed<=product_count AND consecutive_failed<=products_failed),
 CONSTRAINT runs_route CHECK (route_digest::text=morrow_work.sha256_text(route_canonical) AND morrow_work.route_matches(route_canonical,
  organization_id,workspace_id,id,task_id,child_task_id,installation_id,store_id,connection_id,fields,product_count)),
 CONSTRAINT runs_status CHECK (CASE status WHEN 'queued' THEN started_at IS NULL AND ended_at IS NULL AND ended_reason IS NULL
  WHEN 'running' THEN started_at IS NOT NULL AND ended_at IS NULL AND ended_reason IS NULL
  WHEN 'succeeded' THEN ended_at IS NOT NULL AND ended_reason IS NULL
  ELSE ended_at IS NOT NULL AND ended_reason IS NOT NULL END),
 CONSTRAINT runs_times CHECK (updated_at>=created_at AND (started_at IS NULL OR started_at>=created_at) AND (ended_at IS NULL OR ended_at>=created_at)
  AND task_id::text<>child_task_id::text)
);
CREATE INDEX runs_task ON morrow_work.runs (organization_id,workspace_id,task_id,created_at,id);
CREATE INDEX runs_open ON morrow_work.runs (organization_id,workspace_id,created_at) WHERE status IN ('queued','running');
-- One requested product of a run, in the route's order (content-free): its status, the
-- attempts the broker counted, the snapshot it was drafted from, its draft and why it failed.
CREATE TABLE morrow_work.run_products (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 product_index integer NOT NULL CHECK (product_index BETWEEN 0 AND 24),
 product_id text NOT NULL CHECK (product_id ~ '^product:[1-9][0-9]{0,19}$'),
 revision morrow_work.revision NOT NULL,
 status text NOT NULL CHECK (status IN ('pending','in_progress','drafted','failed','skipped')),
 attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 2),
 snapshot_digest morrow_work.digest,
 draft_id morrow_work.record_id,
 failure_code text CHECK (failure_code IN ('validation','product_mismatch','incomplete','refusal','invalid_output','uncertain',
  'input_over_cap','read_failed','too_large','provider_error','spend_limit','reservation_exhausted','interrupted')),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,run_id,product_index),
 UNIQUE (organization_id,workspace_id,run_id,product_id),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.runs(organization_id,workspace_id,id),
 CONSTRAINT run_products_status CHECK ((status='failed')=(failure_code IS NOT NULL) AND (status='drafted')=(draft_id IS NOT NULL)
  AND (status<>'drafted' OR snapshot_digest IS NOT NULL))
);
-- RunManifest@1-aligned record of one run: the selection, its pinned catalogue digest and
-- multiplier, the provider and provider model the broker sends to, the release, route and
-- workflow, the prompt and output-schema digests the broker binds (set once, then equal on
-- every call), and the running totals of counted attempts, tokens and booked cost.
CREATE TABLE morrow_work.run_manifests (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 catalogue_version integer NOT NULL,
 catalogue_digest morrow_work.digest NOT NULL,
 model_key text NOT NULL,
 effort_key text NOT NULL,
 credits_per_product integer NOT NULL CHECK (credits_per_product BETWEEN 1 AND 99),
 provider text NOT NULL CHECK (provider='anthropic'),
 provider_model_id text NOT NULL CHECK (provider_model_id ~ '^[a-z][a-z0-9-]{2,63}$'),
 release_id text NOT NULL,
 release_revision morrow_work.revision NOT NULL,
 release_digest morrow_work.digest NOT NULL,
 route_digest morrow_work.digest NOT NULL,
 workflow_version text NOT NULL CHECK (workflow_version ~ '^listings-run@[1-9][0-9]{0,3}$'),
 prompt_digest morrow_work.digest,
 schema_digest morrow_work.digest,
 attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND 50),
 input_tokens bigint NOT NULL CHECK (input_tokens>=0),
 output_tokens bigint NOT NULL CHECK (output_tokens>=0),
 cache_tokens bigint NOT NULL CHECK (cache_tokens>=0),
 booked_cost_usd numeric(20,8) NOT NULL CHECK (booked_cost_usd>=0),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,run_id),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.runs(organization_id,workspace_id,id),
 FOREIGN KEY (catalogue_version,model_key,effort_key) REFERENCES morrow_work.model_catalogue_entries(version,model_key,effort_key),
 FOREIGN KEY (release_id,release_revision,release_digest) REFERENCES morrow_work.agent_releases(id,revision,digest),
 CONSTRAINT run_manifests_times CHECK (updated_at>=created_at AND (prompt_digest IS NULL)=(schema_digest IS NULL))
);
-- One model call of a run (the attempt fence and the opaque traceRef target): keyed by the
-- product, the attempt (1..2, ADR-0022 item 11) and the sequence (a resend after a provider
-- throttle reuses the attempt). At most one call of a run is open. The broker opens it before
-- any provider request and closes it with the outcome, the counted usage, the booked cost and
-- the provider's request and model ids (never granted to the api role). Content-free.
CREATE TABLE morrow_work.run_model_calls (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 run_id morrow_work.record_id NOT NULL,
 product_index integer NOT NULL CHECK (product_index BETWEEN 0 AND 24),
 attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 2),
 sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 8),
 status text NOT NULL CHECK (status IN ('started','closed')),
 outcome text CHECK (outcome IN ('completed','incomplete','refusal','invalid_output','spend_limit','provider_error','uncertain',
  'not_sent','input_over_cap')),
 counted boolean,
 raw_stop_reason text CHECK (raw_stop_reason ~ '^[a-z_]{1,32}$'),
 provider_request_id text CHECK (provider_request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 provider_model_id text CHECK (provider_model_id ~ '^[A-Za-z0-9._-]{1,128}$'),
 counted_input_tokens integer CHECK (counted_input_tokens BETWEEN 0 AND 1000000),
 input_tokens bigint CHECK (input_tokens BETWEEN 0 AND 10000000),
 output_tokens bigint CHECK (output_tokens BETWEEN 0 AND 10000000),
 cache_creation_tokens bigint CHECK (cache_creation_tokens BETWEEN 0 AND 10000000),
 cache_read_tokens bigint CHECK (cache_read_tokens BETWEEN 0 AND 10000000),
 cost_usd numeric(20,8) CHECK (cost_usd>=0),
 overflow_usd numeric(20,8) CHECK (overflow_usd>=0),
 booking_id morrow_work.record_id,
 budget_ms integer NOT NULL CHECK (budget_ms BETWEEN 1000 AND 600000),
 started_at timestamptz NOT NULL CHECK (started_at=date_trunc('milliseconds',started_at) AND started_at>=timestamptz '2000-01-01T00:00:00Z' AND started_at<timestamptz '9000-01-01T00:00:00Z'),
 closed_at timestamptz CHECK (closed_at=date_trunc('milliseconds',closed_at) AND isfinite(closed_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,run_id,product_index,attempt,sequence),
 FOREIGN KEY (organization_id,workspace_id,run_id,product_index) REFERENCES morrow_work.run_products(organization_id,workspace_id,run_id,product_index),
 CONSTRAINT run_model_calls_state CHECK (CASE status WHEN 'started' THEN outcome IS NULL AND counted IS NULL AND closed_at IS NULL
   AND cost_usd IS NULL AND overflow_usd IS NULL AND booking_id IS NULL AND provider_request_id IS NULL AND provider_model_id IS NULL
   AND raw_stop_reason IS NULL AND input_tokens IS NULL AND output_tokens IS NULL
  ELSE outcome IS NOT NULL AND counted IS NOT NULL AND closed_at IS NOT NULL AND closed_at>=started_at
   AND counted=(outcome IN ('completed','incomplete','refusal','invalid_output','uncertain') OR (outcome='provider_error' AND input_tokens IS NOT NULL))
   AND (counted=(booking_id IS NOT NULL)) AND (counted=(cost_usd IS NOT NULL)) END)
);
CREATE UNIQUE INDEX run_model_calls_one_open ON morrow_work.run_model_calls (organization_id,workspace_id,run_id) WHERE status='started';
-- One product as read (store content, 90 days; deleted at shop/redact): content-addressed by
-- the sha256 of its canonical text, at most 64 KiB.
CREATE TABLE morrow_work.product_snapshots (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 store_id morrow_work.record_id NOT NULL,
 digest morrow_work.digest NOT NULL,
 product_id text NOT NULL CHECK (product_id ~ '^product:[1-9][0-9]{0,19}$'),
 canonical text NOT NULL CHECK (octet_length(canonical) BETWEEN 2 AND 65536),
 read_at timestamptz NOT NULL CHECK (read_at=date_trunc('milliseconds',read_at) AND read_at>=timestamptz '2000-01-01T00:00:00Z' AND read_at<timestamptz '9000-01-01T00:00:00Z'),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (organization_id,workspace_id,store_id,digest),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CONSTRAINT product_snapshots_digest CHECK (digest::text=morrow_work.sha256_text(canonical) AND morrow_work.snapshot_matches(canonical,product_id)),
 CONSTRAINT product_snapshots_window CHECK (expires_at=read_at+interval '90 days')
);
-- One validated draft of one product (store content, 90 days; deleted at shop/redact): the
-- CatalogContentChangeSet@1 item `set`, its digest and fields, the snapshot it changes, the
-- reviewer flags (counts only), and the proposal that packed it.
CREATE TABLE morrow_work.run_drafts (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 run_id morrow_work.record_id NOT NULL,
 product_index integer NOT NULL CHECK (product_index BETWEEN 0 AND 24),
 product_id text NOT NULL CHECK (product_id ~ '^product:[1-9][0-9]{0,19}$'),
 store_id morrow_work.record_id NOT NULL,
 snapshot_digest morrow_work.digest NOT NULL,
 fields text[] NOT NULL,
 set_canonical text NOT NULL,
 set_digest morrow_work.digest NOT NULL,
 flags jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('pending','packed')),
 proposal_id morrow_work.record_id,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 expires_at timestamptz NOT NULL,
 packed_at timestamptz CHECK (packed_at=date_trunc('milliseconds',packed_at) AND isfinite(packed_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,run_id,product_index),
 FOREIGN KEY (organization_id,workspace_id,run_id,product_index) REFERENCES morrow_work.run_products(organization_id,workspace_id,run_id,product_index),
 FOREIGN KEY (organization_id,workspace_id,proposal_id) REFERENCES morrow_work.proposals(organization_id,workspace_id,id),
 CONSTRAINT run_drafts_set CHECK (set_digest::text=morrow_work.sha256_text(set_canonical) AND morrow_work.draft_set_valid(set_canonical,fields)),
 CONSTRAINT run_drafts_flags CHECK (morrow_work.draft_flags_valid(flags)),
 CONSTRAINT run_drafts_status CHECK ((status='packed')=(proposal_id IS NOT NULL) AND (status='packed')=(packed_at IS NOT NULL)
  AND (packed_at IS NULL OR packed_at>=created_at)),
 CONSTRAINT run_drafts_window CHECK (expires_at=created_at+interval '90 days')
);

-- ---------------------------------------------------------------------------
-- Forward changes on the shared tables (each CHECK the union of every value at this head).
ALTER TABLE morrow_work.commands DROP CONSTRAINT commands_command_type_check, DROP CONSTRAINT commands_check,
 ADD CONSTRAINT commands_command_type_check CHECK (command_type IN ('goal.create','goal.transition','task.create','task.ready','task.assign',
  'question.request','question.answer','question.cancel','proposal.submit','approval.decide','approval.withdraw',
  'installation.document','installation.enable','installation.stop','model_default.revise','run.admit','run.reconcile')),
 ADD CONSTRAINT commands_check CHECK (aggregate_type IN ('goal','task','question','proposal','approval','installation','model_default','run')
  AND aggregate_type=split_part(command_type,'.',1));
ALTER TABLE morrow_work.outbox_events DROP CONSTRAINT outbox_events_event_type_check, DROP CONSTRAINT outbox_events_check,
 DROP CONSTRAINT outbox_events_check1, DROP CONSTRAINT outbox_events_check3,
 ADD CONSTRAINT outbox_events_event_type_check CHECK (event_type IN ('goal.created','goal.status_changed','task.created','task.status_changed','task.assigned',
  'question.requested','question.answered','question.cancelled','proposal.submitted','proposal.derived','approval.decided','approval.status_changed',
  'approval.claimed','kill_switch.executed','run.admitted','run.status_changed')),
 ADD CONSTRAINT outbox_events_check CHECK (aggregate_type IN ('goal','task','question','proposal','approval','kill_switch','run')
  AND aggregate_type=split_part(event_type,'.',1)),
 ADD CONSTRAINT outbox_events_check1 CHECK ((aggregate_type='goal' AND task_id IS NULL) OR (aggregate_type='task' AND task_id=aggregate_id)
  OR (aggregate_type='question' AND task_id IS NOT NULL) OR aggregate_type IN ('proposal','approval') OR (aggregate_type='kill_switch' AND task_id IS NULL)
  OR (aggregate_type='run' AND task_id IS NOT NULL)),
 ADD CONSTRAINT outbox_events_check3 CHECK (CASE WHEN jsonb_typeof(payload)<>'object' THEN false
  WHEN event_type='goal.created' THEN payload ? 'status' AND payload-'status'='{}'::jsonb AND jsonb_typeof(payload->'status')='string'
  WHEN event_type IN ('goal.status_changed','task.status_changed') THEN payload ?& ARRAY['from','to'] AND payload-ARRAY['from','to']='{}'::jsonb
   AND jsonb_typeof(payload->'from')='string' AND jsonb_typeof(payload->'to')='string'
  WHEN event_type='task.created' THEN payload ?& ARRAY['goalId','status'] AND payload-ARRAY['goalId','status']='{}'::jsonb
   AND jsonb_typeof(payload->'goalId')='string' AND jsonb_typeof(payload->'status')='string'
  WHEN event_type='task.assigned' THEN payload ?& ARRAY['assignmentId','ownerPrincipalId'] AND payload-ARRAY['assignmentId','ownerPrincipalId']='{}'::jsonb
   AND jsonb_typeof(payload->'assignmentId')='string' AND jsonb_typeof(payload->'ownerPrincipalId')='string'
  WHEN event_type='question.requested' THEN payload ? 'respondentPrincipalId' AND payload-'respondentPrincipalId'='{}'::jsonb
   AND jsonb_typeof(payload->'respondentPrincipalId')='string'
  WHEN event_type='question.answered' THEN payload ? 'answerId' AND payload-'answerId'='{}'::jsonb AND jsonb_typeof(payload->'answerId')='string'
  WHEN event_type='question.cancelled' THEN payload='{}'::jsonb
  WHEN event_type='proposal.submitted' THEN payload ?& ARRAY['approvalId','risk','targetCount'] AND payload-ARRAY['approvalId','risk','targetCount']='{}'::jsonb
   AND jsonb_typeof(payload->'approvalId')='string' AND jsonb_typeof(payload->'risk')='string' AND jsonb_typeof(payload->'targetCount')='number'
  WHEN event_type='proposal.derived' THEN payload ? 'parentId' AND payload-'parentId'='{}'::jsonb AND jsonb_typeof(payload->'parentId')='string'
  WHEN event_type='approval.decided' THEN payload ?& ARRAY['decision','status'] AND payload-ARRAY['decision','status']='{}'::jsonb
   AND jsonb_typeof(payload->'decision')='string' AND jsonb_typeof(payload->'status')='string'
  WHEN event_type='approval.status_changed' THEN payload ?& ARRAY['from','to','reason'] AND payload-ARRAY['from','to','reason']='{}'::jsonb
   AND jsonb_typeof(payload->'from')='string' AND jsonb_typeof(payload->'to')='string' AND jsonb_typeof(payload->'reason')='string'
   AND (payload->>'reason') IN ('quorum_met','solo_owner_confirmed','rejected','cancelled_before_effective','withdrawn','superseded_by_partial_approval','family_closed')
  WHEN event_type='approval.claimed' THEN payload ? 'consumer' AND payload-'consumer'='{}'::jsonb AND jsonb_typeof(payload->'consumer')='string'
  WHEN event_type='kill_switch.executed' THEN payload ?& ARRAY['capabilityId','sourceProposalId'] AND payload-ARRAY['capabilityId','sourceProposalId']='{}'::jsonb
   AND (payload->>'capabilityId') IN ('ads.campaign.pause','agents.installation.disable','governance.membership.revoke','governance.connection.disconnect','agents.release.revoke')
   AND (payload->'sourceProposalId'='null'::jsonb OR (jsonb_typeof(payload->'sourceProposalId')='string'
    AND (payload->>'sourceProposalId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'))
  WHEN event_type='run.admitted' THEN payload ?& ARRAY['childTaskId','productCount'] AND payload-ARRAY['childTaskId','productCount']='{}'::jsonb
   AND jsonb_typeof(payload->'childTaskId')='string' AND jsonb_typeof(payload->'productCount')='number'
  WHEN event_type='run.status_changed' THEN payload ?& ARRAY['from','to','reason'] AND payload-ARRAY['from','to','reason']='{}'::jsonb
   AND jsonb_typeof(payload->'from')='string' AND jsonb_typeof(payload->'to')='string'
   AND (payload->'reason'='null'::jsonb OR (jsonb_typeof(payload->'reason')='string' AND (payload->>'reason') ~ '^[a-z_]{1,32}$'))
  ELSE false END);

-- 0033's owner-owned credit helpers, revised (they are revisable by design; 0033 is the
-- merge-train migration of M3 PR-1 and is never edited). An `attempt` booking is one counted
-- model call's cost: booked against the run's vendor reservation and not yet unrecovered;
-- when its product fails, run_product_unrecovered accrues it (spine §9: failed products are
-- not charged and their cost is the workspace's). An `overflow` booking is cost that the
-- reservation can no longer hold (a reply whose actual input passed the counted estimate, or
-- a booking that arrives after the run settled): never dropped, it accrues to the period's
-- unrecovered cost at once and leaves the reservation untouched.
ALTER TABLE morrow_billing.run_cost_bookings DROP CONSTRAINT run_cost_bookings_kind_check, DROP CONSTRAINT run_cost_bookings_check,
 ADD CONSTRAINT run_cost_bookings_kind_check CHECK (kind IN ('drafted','failed_product','uncertain_attempt','attempt','overflow')),
 ADD CONSTRAINT run_cost_bookings_check CHECK (kind='overflow' OR booked_usd>=amount_usd);
ALTER TABLE morrow_billing.unrecovered_cost_entries DROP CONSTRAINT unrecovered_cost_entries_kind_check,
 ADD CONSTRAINT unrecovered_cost_entries_kind_check CHECK (kind IN ('failed_product','uncertain_attempt','overflow'));
-- The vendor reservation guard: books monotonically up to its maximum while reserved; the
-- unrecovered part only grows and never passes the booked total (0033 also tied each
-- update's unrecovered growth to the same update's booked growth, which a later accrual of
-- an already booked attempt cannot meet).
CREATE OR REPLACE FUNCTION morrow_billing.vendor_reservation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['booked_cost_usd','unrecovered_cost_usd','status','updated_at','revision'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>'reserved' OR NEW.booked_cost_usd<>0 OR NEW.unrecovered_cost_usd<>0 OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'VENDOR_RESERVATION_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'reserved' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.booked_cost_usd<OLD.booked_cost_usd OR NEW.unrecovered_cost_usd<OLD.unrecovered_cost_usd
  OR NEW.unrecovered_cost_usd>NEW.booked_cost_usd THEN
  RAISE EXCEPTION 'VENDOR_RESERVATION_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- run_book_cost (0033), revised: the kinds `attempt` (booked, not unrecovered) and
-- `overflow` (not booked against the reservation; unrecovered at once, also after the run
-- settled). Every other rule is 0033's: one row per entry id before any total changes, a
-- repeat of the same entry, run, kind and amount replays, anything else under the id
-- conflicts, and the booked total never passes the reservation.
CREATE OR REPLACE FUNCTION morrow_billing.run_book_cost(p_org text,p_ws text,p_run_id text,p_entry_id text,p_amount_usd numeric,p_kind text)
RETURNS TABLE(outcome text,booked_usd text,unrecovered_usd text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; b record; v_now timestamptz; v_unrecovered boolean; n integer; v_booked numeric(20,8); v_lost numeric(20,8);
BEGIN
 IF p_org IS NULL OR p_ws IS NULL OR p_run_id IS NULL OR p_amount_usd IS NULL OR p_amount_usd<0 OR p_amount_usd<>round(p_amount_usd,8)
  OR p_kind IS NULL OR p_kind NOT IN ('drafted','failed_product','uncertain_attempt','attempt','overflow')
  OR (p_kind='overflow' AND p_amount_usd=0)
  OR p_entry_id IS NULL OR p_entry_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.id::text AS id,x.status,x.maximum_cost_usd,x.booked_cost_usd,x.unrecovered_cost_usd,x.period_start,x.revision::bigint AS revision,x.updated_at
  INTO r FROM morrow_billing.vendor_cost_reservations x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.root_run_id=p_run_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT x.root_run_id::text AS root_run_id,x.kind,x.amount_usd,x.booked_usd,x.unrecovered_usd INTO b FROM morrow_billing.run_cost_bookings x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_entry_id;
 IF FOUND THEN
  IF b.root_run_id=p_run_id AND b.kind=p_kind AND b.amount_usd=p_amount_usd THEN
   RETURN QUERY SELECT 'booked'::text,to_char(b.booked_usd,'FM999999999990.00000000'),to_char(b.unrecovered_usd,'FM999999999990.00000000');
  ELSE
   RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text;
  END IF;
  RETURN;
 END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 IF p_kind='overflow' THEN
  BEGIN
   INSERT INTO morrow_billing.run_cost_bookings(organization_id,workspace_id,id,root_run_id,vendor_reservation_id,kind,amount_usd,booked_usd,
    unrecovered_usd,recorded_at)
   VALUES (p_org,p_ws,p_entry_id,p_run_id,r.id,'overflow',p_amount_usd,r.booked_cost_usd,r.unrecovered_cost_usd,v_now);
   INSERT INTO morrow_billing.unrecovered_costs(organization_id,workspace_id,period_start,amount_usd,revision,updated_at)
   VALUES (p_org,p_ws,r.period_start,0,1,v_now) ON CONFLICT DO NOTHING;
   UPDATE morrow_billing.unrecovered_costs u SET amount_usd=u.amount_usd+p_amount_usd,revision=u.revision+1,updated_at=greatest(v_now,u.updated_at)
    WHERE u.organization_id=p_org AND u.workspace_id=p_ws AND u.period_start=r.period_start;
   GET DIAGNOSTICS n=ROW_COUNT;
   IF n<>1 THEN RAISE EXCEPTION 'UNRECOVERED_COST_INVALID'; END IF;
   INSERT INTO morrow_billing.unrecovered_cost_entries(organization_id,workspace_id,id,period_start,root_run_id,vendor_reservation_id,kind,amount_usd,recorded_at)
   VALUES (p_org,p_ws,p_entry_id,r.period_start,p_run_id,r.id,'overflow',p_amount_usd,v_now);
  EXCEPTION WHEN unique_violation THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN;
  END;
  RETURN QUERY SELECT 'booked'::text,to_char(r.booked_cost_usd,'FM999999999990.00000000'),to_char(r.unrecovered_cost_usd,'FM999999999990.00000000');
  RETURN;
 END IF;
 IF r.status<>'reserved' THEN RETURN QUERY SELECT 'ended'::text,NULL::text,NULL::text; RETURN; END IF;
 IF r.booked_cost_usd+p_amount_usd>r.maximum_cost_usd THEN RETURN QUERY SELECT 'reservation_exceeded'::text,NULL::text,NULL::text; RETURN; END IF;
 v_unrecovered:=p_kind IN ('failed_product','uncertain_attempt') AND p_amount_usd>0;
 v_booked:=r.booked_cost_usd+p_amount_usd;
 v_lost:=r.unrecovered_cost_usd+CASE WHEN v_unrecovered THEN p_amount_usd ELSE 0 END;
 BEGIN
  INSERT INTO morrow_billing.run_cost_bookings(organization_id,workspace_id,id,root_run_id,vendor_reservation_id,kind,amount_usd,booked_usd,
   unrecovered_usd,recorded_at)
  VALUES (p_org,p_ws,p_entry_id,p_run_id,r.id,p_kind,p_amount_usd,v_booked,v_lost,v_now);
  UPDATE morrow_billing.vendor_cost_reservations x SET booked_cost_usd=v_booked,unrecovered_cost_usd=v_lost,revision=r.revision+1,
   updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'VENDOR_RESERVATION_INVALID'; END IF;
  IF v_unrecovered THEN
   INSERT INTO morrow_billing.unrecovered_costs(organization_id,workspace_id,period_start,amount_usd,revision,updated_at)
   VALUES (p_org,p_ws,r.period_start,0,1,v_now) ON CONFLICT DO NOTHING;
   UPDATE morrow_billing.unrecovered_costs u SET amount_usd=u.amount_usd+p_amount_usd,revision=u.revision+1,updated_at=greatest(v_now,u.updated_at)
    WHERE u.organization_id=p_org AND u.workspace_id=p_ws AND u.period_start=r.period_start;
   GET DIAGNOSTICS n=ROW_COUNT;
   IF n<>1 THEN RAISE EXCEPTION 'UNRECOVERED_COST_INVALID'; END IF;
   INSERT INTO morrow_billing.unrecovered_cost_entries(organization_id,workspace_id,id,period_start,root_run_id,vendor_reservation_id,kind,amount_usd,recorded_at)
   VALUES (p_org,p_ws,p_entry_id,r.period_start,p_run_id,r.id,p_kind,p_amount_usd,v_now);
  END IF;
 EXCEPTION WHEN unique_violation THEN
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN;
 END;
 RETURN QUERY SELECT 'booked'::text,to_char(v_booked,'FM999999999990.00000000'),to_char(v_lost,'FM999999999990.00000000');
END $$;
-- A failed product's `attempt` bookings become unrecovered (the AI cost of a product that
-- earned no credit, ADR-0022 item 11): each one not yet accrued gets an entry of kind
-- failed_product under its own booking id, and the reservation's unrecovered part and the
-- period's total grow by their sum, under the reservation's row lock. Idempotent: an accrued
-- booking is skipped. A product's attempt bookings are the entries `<run>:<index>:<attempt>`.
-- Outcomes: accrued (with the amount, possibly zero), invalid, not_found, ended.
CREATE FUNCTION morrow_billing.run_product_unrecovered(p_org text,p_ws text,p_run_id text,p_product_index integer)
RETURNS TABLE(outcome text,accrued_usd text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; v_sum numeric(20,8):=0; v_now timestamptz; n integer; b record;
BEGIN
 IF p_org IS NULL OR p_ws IS NULL OR p_run_id IS NULL OR p_run_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_product_index IS NULL OR p_product_index NOT BETWEEN 0 AND 24 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT x.id::text AS id,x.status,x.booked_cost_usd,x.unrecovered_cost_usd,x.period_start,x.revision::bigint AS revision INTO r
  FROM morrow_billing.vendor_cost_reservations x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.root_run_id=p_run_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 FOR b IN SELECT x.id::text AS id,x.amount_usd FROM morrow_billing.run_cost_bookings x WHERE x.organization_id=p_org AND x.workspace_id=p_ws
   AND x.root_run_id=p_run_id AND x.kind='attempt' AND x.amount_usd>0
   AND x.id::text IN (p_run_id||':'||p_product_index||':1',p_run_id||':'||p_product_index||':2')
   AND NOT EXISTS(SELECT 1 FROM morrow_billing.unrecovered_cost_entries e WHERE e.organization_id=x.organization_id AND e.workspace_id=x.workspace_id
    AND e.id=x.id) ORDER BY x.id LOOP
  INSERT INTO morrow_billing.unrecovered_costs(organization_id,workspace_id,period_start,amount_usd,revision,updated_at)
  VALUES (p_org,p_ws,r.period_start,0,1,v_now) ON CONFLICT DO NOTHING;
  INSERT INTO morrow_billing.unrecovered_cost_entries(organization_id,workspace_id,id,period_start,root_run_id,vendor_reservation_id,kind,amount_usd,recorded_at)
  VALUES (p_org,p_ws,b.id,r.period_start,p_run_id,r.id,'failed_product',b.amount_usd,v_now);
  v_sum:=v_sum+b.amount_usd;
 END LOOP;
 IF v_sum>0 THEN
  IF r.status<>'reserved' THEN RAISE EXCEPTION 'VENDOR_RESERVATION_INVALID'; END IF;
  UPDATE morrow_billing.unrecovered_costs u SET amount_usd=u.amount_usd+v_sum,revision=u.revision+1,updated_at=greatest(v_now,u.updated_at)
   WHERE u.organization_id=p_org AND u.workspace_id=p_ws AND u.period_start=r.period_start;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'UNRECOVERED_COST_INVALID'; END IF;
  UPDATE morrow_billing.vendor_cost_reservations x SET unrecovered_cost_usd=x.unrecovered_cost_usd+v_sum,revision=r.revision+1,
   updated_at=greatest(v_now,x.updated_at) WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'VENDOR_RESERVATION_INVALID'; END IF;
 END IF;
 RETURN QUERY SELECT 'accrued'::text,to_char(v_sum,'FM999999999990.00000000');
END $$;
REVOKE ALL ON FUNCTION morrow_billing.run_product_unrecovered(text,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_billing.run_product_unrecovered(text,text,text,integer) TO morrow_work_command;
-- run_reserve (0033), revised: the workspace's daily cost also counts that day's overflow
-- bookings (cost booked beyond a reservation, which neither its maximum nor its booked total
-- holds), so the US$25 daily cap stays a bound on real vendor spend. Every other rule is
-- 0033's; its ACL and owner are kept (CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION morrow_billing.run_reserve(p_org text,p_ws text,p_billing_account_id text,p_run_id text,p_reservation_id text,
 p_vendor_reservation_id text,p_allocation_id text,p_allocation_digest text,p_catalogue_version integer,p_model text,p_effort text,
 p_product_count integer,p_period_start timestamptz)
RETURNS TABLE(outcome text,credits_reserved text,vendor_maximum_usd text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; v record; w record; v_now timestamptz; v_credits bigint; v_vendor numeric(20,8); v_day date; v_today numeric; n integer;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_billing_account_id IS NULL OR p_billing_account_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_run_id IS NULL OR p_run_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_reservation_id IS NULL OR p_reservation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_vendor_reservation_id IS NULL OR p_vendor_reservation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_allocation_id IS NULL OR p_allocation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_allocation_digest IS NULL OR p_allocation_digest !~ '^[a-f0-9]{64}$'
  OR p_catalogue_version IS NULL OR p_model IS NULL OR p_effort IS NULL OR p_product_count IS NULL THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_period_start IS NULL OR NOT isfinite(p_period_start) THEN RETURN QUERY SELECT 'no_billing_period'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT x.credits_per_product,x.worst_case_per_product_usd,x.run_product_limit INTO e FROM morrow_work.model_catalogue_entries x
  JOIN morrow_work.model_catalogue_versions y ON y.version=x.version AND y.status='active'
  WHERE x.version=p_catalogue_version AND x.model_key=p_model AND x.effort_key=p_effort;
 IF NOT FOUND THEN RETURN QUERY SELECT 'catalogue_inactive'::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_product_count<1 OR p_product_count>e.run_product_limit THEN RETURN QUERY SELECT 'run_product_limit'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT y.workspace_daily_cost_cap_usd INTO v FROM morrow_work.model_catalogue_versions y WHERE y.version=p_catalogue_version;
 -- The workspace's daily interlock, then the wallet row: concurrent reservations of one
 -- workspace serialize, so a balance or a cap is never spent twice.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.billing.run_reserve',p_org,p_ws)::text,0));
 SELECT x.available,x.reserved,x.consumed,x.revision::bigint AS revision,x.updated_at INTO w FROM morrow_billing.credit_wallets x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.billing_account_id=p_billing_account_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'wallet_not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM morrow_billing.credit_reservations x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.root_run_id=p_run_id) THEN
  RETURN QUERY SELECT 'duplicate'::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_credits:=p_product_count::bigint*e.credits_per_product;
 v_vendor:=p_product_count*e.worst_case_per_product_usd;
 IF w.available<v_credits THEN RETURN QUERY SELECT 'insufficient_credits'::text,NULL::text,NULL::text; RETURN; END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 v_day:=(v_now AT TIME ZONE 'UTC')::date;
 SELECT COALESCE(sum(CASE WHEN x.status='reserved' THEN x.maximum_cost_usd ELSE x.booked_cost_usd END),0) INTO v_today
  FROM morrow_billing.vendor_cost_reservations x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.created_day=v_day;
 -- Overflow (cost no reservation could hold) is real spend too: that day's reservations'
 -- overflow bookings count against the daily cap.
 v_today:=v_today+COALESCE((SELECT sum(b.amount_usd) FROM morrow_billing.run_cost_bookings b JOIN morrow_billing.vendor_cost_reservations x
  ON x.organization_id=b.organization_id AND x.workspace_id=b.workspace_id AND x.id=b.vendor_reservation_id
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.created_day=v_day AND b.kind='overflow'),0);
 IF v_today+v_vendor>v.workspace_daily_cost_cap_usd THEN RETURN QUERY SELECT 'daily_cap'::text,NULL::text,NULL::text; RETURN; END IF;
 IF NOT morrow_billing.unrecovered_allows(p_org,p_ws,date_trunc('milliseconds',p_period_start),p_catalogue_version,e.worst_case_per_product_usd) THEN
  RETURN QUERY SELECT 'unrecovered_cost_cap'::text,NULL::text,NULL::text; RETURN;
 END IF;
 BEGIN
  UPDATE morrow_billing.credit_wallets x SET available=x.available-v_credits,reserved=x.reserved+v_credits,revision=x.revision+1,
   updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.billing_account_id=p_billing_account_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'CREDIT_WALLET_INVALID'; END IF;
  INSERT INTO morrow_billing.credit_reservations(organization_id,workspace_id,id,revision,billing_account_id,root_run_id,allocation_id,
   allocation_digest,catalogue_version,model_key,effort_key,credits_per_product,product_count,credits_reserved,credits_settled,status,created_at,settled_at)
  VALUES (p_org,p_ws,p_reservation_id,1,p_billing_account_id,p_run_id,p_allocation_id,p_allocation_digest,p_catalogue_version,p_model,p_effort,
   e.credits_per_product,p_product_count,v_credits,NULL,'reserved',v_now,NULL);
  INSERT INTO morrow_billing.vendor_cost_reservations(organization_id,workspace_id,id,revision,root_run_id,credit_reservation_id,vendor_id,
   catalogue_version,model_key,effort_key,maximum_cost_usd,booked_cost_usd,unrecovered_cost_usd,period_start,created_day,status,created_at,updated_at)
  VALUES (p_org,p_ws,p_vendor_reservation_id,1,p_run_id,p_reservation_id,'anthropic',p_catalogue_version,p_model,p_effort,v_vendor,0,0,
   date_trunc('milliseconds',p_period_start),v_day,'reserved',v_now,v_now);
 EXCEPTION WHEN unique_violation THEN RETURN QUERY SELECT 'duplicate'::text,NULL::text,NULL::text; RETURN;
  WHEN check_violation OR foreign_key_violation OR not_null_violation OR raise_exception THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END;
 RETURN QUERY SELECT 'reserved'::text,v_credits::text,to_char(v_vendor,'FM999999999990.00000000');
END $$;

-- ---------------------------------------------------------------------------
-- Row security. Every new table: ENABLE + FORCE and the maintenance-only owner policy.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['model_catalogue_rates','runs','run_products','run_manifests','run_model_calls','product_snapshots','run_drafts'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
 END LOOP;
 EXECUTE 'CREATE POLICY platform_command_read ON morrow_work.model_catalogue_rates FOR SELECT TO morrow_work_command USING (true)';
 -- The session context (admission and the stale-run close) and its lease twin (the run
 -- steps) on every run table.
 FOREACH t IN ARRAY ARRAY['runs','run_products','run_manifests','run_model_calls','product_snapshots','run_drafts'] LOOP
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('CREATE POLICY tenant_lease ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
 END LOOP;
 -- The api reads its tenant's runs, products, manifests, calls and drafts column by column
 -- (never a draft's or a snapshot's content).
 FOREACH t IN ARRAY ARRAY['runs','run_products','run_manifests','run_model_calls','run_drafts'] LOOP
  EXECUTE format('CREATE POLICY tenant_read ON morrow_work.%I FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
 -- The broker's two model definers (morrow_vault, below) read exactly the run and tenant they
 -- name through transaction-local settings they write themselves before reading and clear
 -- after, only while the session user is the broker's login (the resolve_call idiom of 0031).
 -- The one other path the broker reaches these tables by, M2 PR-3's read resolution through
 -- run_product_readable, has its own setting and FOR SELECT policies below; each of the three
 -- writes its setting before reading, names its run in every query and clears it after, so a
 -- setting the broker's login forges reaches nothing.
 EXECUTE 'CREATE POLICY broker_model_run ON morrow_work.runs TO morrow_work_command
   USING (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text||''|''||id::text=pg_catalog.current_setting(''morrow.vault_model_run'',true))
   WITH CHECK (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text||''|''||id::text=pg_catalog.current_setting(''morrow.vault_model_run'',true))';
 FOREACH t IN ARRAY ARRAY['run_products','run_manifests'] LOOP
  EXECUTE format('CREATE POLICY broker_model_run_child ON morrow_work.%I TO morrow_work_command
   USING (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text||''|''||run_id::text=pg_catalog.current_setting(''morrow.vault_model_run'',true))
   WITH CHECK (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text||''|''||run_id::text=pg_catalog.current_setting(''morrow.vault_model_run'',true))',t);
 END LOOP;
 EXECUTE 'CREATE POLICY broker_model_call ON morrow_work.run_model_calls TO morrow_work_command
   USING (session_user=''morrow_vault_broker'' AND (organization_id::text||''|''||workspace_id::text||''|''||run_id::text=pg_catalog.current_setting(''morrow.vault_model_run'',true)
    OR id::text=pg_catalog.current_setting(''morrow.vault_model_call'',true)))
   WITH CHECK (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text||''|''||run_id::text=pg_catalog.current_setting(''morrow.vault_model_run'',true))';
 FOREACH t IN ARRAY ARRAY['vendor_cost_reservations','run_cost_bookings','unrecovered_costs','unrecovered_cost_entries'] LOOP
  EXECUTE format('CREATE POLICY broker_model_tenant ON morrow_billing.%I TO morrow_work_command
   USING (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text=pg_catalog.current_setting(''morrow.vault_model_tenant'',true))
   WITH CHECK (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text=pg_catalog.current_setting(''morrow.vault_model_tenant'',true))',t);
 END LOOP;
 -- Lease twins the runtime definers need: the work stream and outbox (run events, the agent
 -- proposal's event), the tasks they read, the approval records the agent submit writes
 -- (claims are read by approval_bind), and the M5 billing rows run_billing_facts reads.
 FOREACH t IN ARRAY ARRAY['workspace_streams','outbox_events','review_policies','proposal_parameters','proposals','approvals'] LOOP
  EXECUTE format('CREATE POLICY tenant_lease ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['tasks','approval_claims'] LOOP
  EXECUTE format('CREATE POLICY tenant_lease_read ON morrow_work.%I FOR SELECT TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['workspace_billing_routes','billing_accounts','entitlement_snapshots','verified_payment_events','checkout_intents',
  'stripe_operations'] LOOP
  EXECUTE format('CREATE POLICY tenant_lease_read ON morrow_billing.%I FOR SELECT TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
 END LOOP;
END $$;
-- The broker's model_call_begin reads the parent task's objective digest only.
CREATE POLICY task_broker_model ON morrow_work.tasks FOR SELECT TO morrow_work_command
 USING (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||id::text=pg_catalog.current_setting('morrow.vault_model_task',true));
-- M2 PR-3's read resolution (morrow_vault.shopify_read_resolve) asks run_product_readable
-- (below) whether a run lease may read one product. It runs as the command role with the
-- broker's login as the session user, after resolve_call cleared its own settings, so FORCE
-- RLS shows it no run unless a policy admits one: these admit, for reading only, exactly the
-- run its own transaction-local setting names (morrow.vault_read_run, org|ws|run), which
-- only run_product_readable writes and clears. Not the model definers' setting: the read path
-- sees one run's status and its products' status, never a manifest or a call.
CREATE POLICY broker_read_run ON morrow_work.runs FOR SELECT TO morrow_work_command
 USING (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||id::text=pg_catalog.current_setting('morrow.vault_read_run',true));
CREATE POLICY broker_read_run_product ON morrow_work.run_products FOR SELECT TO morrow_work_command
 USING (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||run_id::text=pg_catalog.current_setting('morrow.vault_read_run',true));

-- Privileges: table SELECT and INSERT, column-scoped UPDATE, never DELETE or TRUNCATE. The
-- api role reads the tenant-readable tables column by column; never the provider ids.
GRANT SELECT ON morrow_work.model_catalogue_rates TO morrow_work_command;
GRANT SELECT,INSERT ON morrow_work.runs,morrow_work.run_products,morrow_work.run_manifests,morrow_work.run_model_calls,
 morrow_work.product_snapshots,morrow_work.run_drafts TO morrow_work_command;
GRANT UPDATE (revision,status,status_actor,status_guard,ended_reason,products_drafted,products_failed,consecutive_failed,started_at,ended_at,updated_at)
 ON morrow_work.runs TO morrow_work_command;
GRANT UPDATE (revision,status,attempts,snapshot_digest,draft_id,failure_code,updated_at) ON morrow_work.run_products TO morrow_work_command;
GRANT UPDATE (revision,prompt_digest,schema_digest,attempts,input_tokens,output_tokens,cache_tokens,booked_cost_usd,updated_at)
 ON morrow_work.run_manifests TO morrow_work_command;
GRANT UPDATE (status,outcome,counted,raw_stop_reason,provider_request_id,provider_model_id,counted_input_tokens,input_tokens,output_tokens,
 cache_creation_tokens,cache_read_tokens,cost_usd,overflow_usd,booking_id,closed_at) ON morrow_work.run_model_calls TO morrow_work_command;
GRANT UPDATE (status,proposal_id,packed_at) ON morrow_work.run_drafts TO morrow_work_command;
GRANT SELECT (organization_id,workspace_id,id,revision,task_id,child_task_id,store_id,connection_id,installation_id,status,ended_reason,
 catalogue_version,model_key,effort_key,credits_per_product,product_count,fields,products_drafted,products_failed,consecutive_failed,
 requester_principal_id,requester_membership_id,lease_id,workflow_version,created_at,started_at,ended_at,updated_at)
 ON morrow_work.runs TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,run_id,product_index,product_id,revision,status,attempts,draft_id,failure_code,updated_at)
 ON morrow_work.run_products TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,run_id,revision,catalogue_version,catalogue_digest,model_key,effort_key,credits_per_product,
 attempts,input_tokens,output_tokens,cache_tokens,booked_cost_usd,created_at,updated_at) ON morrow_work.run_manifests TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,run_id,product_index,attempt,sequence,status,outcome,counted,input_tokens,output_tokens,
 cost_usd,started_at,closed_at) ON morrow_work.run_model_calls TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,run_id,product_index,product_id,fields,flags,status,proposal_id,created_at,packed_at)
 ON morrow_work.run_drafts TO morrow_work_api;

-- ---------------------------------------------------------------------------
-- Triggers: INVOKER, owned by the owner, granted to nobody.
-- Runs: born queued at revision 1 with zero counters; afterwards revision+1, never
-- back-dated; only the status, its edge, the end reason, the counters and the three times
-- change; a status change is a `run` edge of transition_rules for the named actor and guard;
-- counters only grow (the consecutive count resets on a drafted product); a terminal run
-- never changes.
CREATE FUNCTION morrow_work.run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','status','status_actor','status_guard','ended_reason','products_drafted','products_failed',
 'consecutive_failed','started_at','ended_at','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>'queued' OR NEW.products_drafted<>0 OR NEW.products_failed<>0 OR NEW.consecutive_failed<>0
   OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'WORK_RUN_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status NOT IN ('queued','running') OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.products_drafted<OLD.products_drafted OR NEW.products_failed<OLD.products_failed
  OR (NEW.consecutive_failed<>0 AND NEW.consecutive_failed<OLD.consecutive_failed)
  OR (NEW.consecutive_failed=0 AND OLD.consecutive_failed>0 AND NEW.products_drafted=OLD.products_drafted)
  OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
  OR (NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS(SELECT 1 FROM morrow_work.transition_rules r WHERE r.machine='run'
   AND r.from_status=OLD.status AND r.to_status=NEW.status AND r.actor=NEW.status_actor AND r.guard=NEW.status_guard))
  OR (NEW.status IS NOT DISTINCT FROM OLD.status AND (NEW.status_actor IS DISTINCT FROM OLD.status_actor
   OR NEW.status_guard IS DISTINCT FROM OLD.status_guard)) THEN
  RAISE EXCEPTION 'WORK_RUN_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Run products: born pending with no attempt; afterwards revision+1 and forward only:
-- pending -> in_progress -> drafted or failed, pending or in_progress -> skipped or failed
-- when the run ends; attempts grow by at most one per change; the snapshot is set while in
-- progress and replaced only before any attempt; the draft and the failure code once.
CREATE FUNCTION morrow_work.run_product_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','status','attempts','snapshot_digest','draft_id','failure_code','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>'pending' OR NEW.attempts<>0 OR NEW.snapshot_digest IS NOT NULL OR NEW.draft_id IS NOT NULL THEN
   RAISE EXCEPTION 'WORK_RUN_PRODUCT_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR OLD.status IN ('drafted','failed','skipped')
  OR NOT ((OLD.status,NEW.status) IN (('pending','pending'),('pending','in_progress'),('pending','skipped'),('pending','failed'),
   ('in_progress','in_progress'),('in_progress','drafted'),('in_progress','failed'),('in_progress','skipped')))
  OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1
  OR (NEW.snapshot_digest IS DISTINCT FROM OLD.snapshot_digest AND (NEW.status<>'in_progress' OR OLD.status<>'in_progress'
   OR (OLD.snapshot_digest IS NOT NULL AND OLD.attempts>0) OR NEW.snapshot_digest IS NULL))
  OR (OLD.draft_id IS NOT NULL AND NEW.draft_id IS DISTINCT FROM OLD.draft_id) THEN
  RAISE EXCEPTION 'WORK_RUN_PRODUCT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Run manifests: born at revision 1 with zero totals and no prompt digests; afterwards
-- revision+1, totals only grow, the prompt and schema digests are set once.
CREATE FUNCTION morrow_work.run_manifest_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','prompt_digest','schema_digest','attempts','input_tokens','output_tokens','cache_tokens',
 'booked_cost_usd','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.attempts<>0 OR NEW.input_tokens<>0 OR NEW.output_tokens<>0 OR NEW.cache_tokens<>0 OR NEW.booked_cost_usd<>0
   OR NEW.prompt_digest IS NOT NULL OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'WORK_RUN_MANIFEST_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.attempts<OLD.attempts OR NEW.input_tokens<OLD.input_tokens OR NEW.output_tokens<OLD.output_tokens
  OR NEW.cache_tokens<OLD.cache_tokens OR NEW.booked_cost_usd<OLD.booked_cost_usd
  OR (OLD.prompt_digest IS NOT NULL AND (NEW.prompt_digest IS DISTINCT FROM OLD.prompt_digest OR NEW.schema_digest IS DISTINCT FROM OLD.schema_digest)) THEN
  RAISE EXCEPTION 'WORK_RUN_MANIFEST_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Model calls: born started; the one change is the close, with its outcome and record.
CREATE FUNCTION morrow_work.model_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['status','outcome','counted','raw_stop_reason','provider_request_id','provider_model_id','counted_input_tokens',
 'input_tokens','output_tokens','cache_creation_tokens','cache_read_tokens','cost_usd','overflow_usd','booking_id','closed_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'started' THEN RAISE EXCEPTION 'WORK_MODEL_CALL_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'started' OR NEW.status<>'closed'
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) THEN
  RAISE EXCEPTION 'WORK_MODEL_CALL_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Drafts: born pending; the one change is the packing into a proposal.
CREATE FUNCTION morrow_work.run_draft_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' THEN RAISE EXCEPTION 'WORK_RUN_DRAFT_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'pending' OR NEW.status<>'packed'
  OR (to_jsonb(NEW)-ARRAY['status','proposal_id','packed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','proposal_id','packed_at']) THEN
  RAISE EXCEPTION 'WORK_RUN_DRAFT_INVALID';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_work.run_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_product_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_manifest_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.model_call_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_draft_guard() FROM PUBLIC;
CREATE TRIGGER run_guard BEFORE INSERT OR UPDATE ON morrow_work.runs FOR EACH ROW EXECUTE FUNCTION morrow_work.run_guard();
CREATE TRIGGER run_product_guard BEFORE INSERT OR UPDATE ON morrow_work.run_products FOR EACH ROW EXECUTE FUNCTION morrow_work.run_product_guard();
CREATE TRIGGER run_manifest_guard BEFORE INSERT OR UPDATE ON morrow_work.run_manifests FOR EACH ROW EXECUTE FUNCTION morrow_work.run_manifest_guard();
CREATE TRIGGER model_call_guard BEFORE INSERT OR UPDATE ON morrow_work.run_model_calls FOR EACH ROW EXECUTE FUNCTION morrow_work.model_call_guard();
CREATE TRIGGER run_draft_guard BEFORE INSERT OR UPDATE ON morrow_work.run_drafts FOR EACH ROW EXECUTE FUNCTION morrow_work.run_draft_guard();
-- Snapshots and drafts hold store content: no runtime DELETE (no grant), and the owner's
-- retention and shop/redact paths delete them, so neither has an append-only DELETE trigger.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['model_catalogue_rates','product_snapshots'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 EXECUTE 'CREATE TRIGGER append_only_delete BEFORE DELETE ON morrow_work.model_catalogue_rates FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()';
 FOREACH t IN ARRAY ARRAY['runs','run_products','run_manifests','run_model_calls'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['model_catalogue_rates','runs','run_products','run_manifests','run_model_calls','product_snapshots','run_drafts'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Revisable owner helpers: INVOKER, owned by the owner (a later owner migration may
-- replace them), EXECUTE for the command role only. They run under the caller's policies
-- (session, lease or the broker's settings) and take no actor.
-- The worst case of one open call that outlived its broker budget (plus a minute) is
-- booked as `uncertain` (ADR-0022 item 10 and build-plan invariant 10: an unknown outcome is
-- never free): the fence closes as uncertain, counted, its product's attempts grow by one and
-- the manifest's totals carry the cost. A call already closed is left alone. Outcomes:
-- closed, not_open, invalid.
CREATE FUNCTION morrow_work.run_fence_close_uncertain(p_org text,p_ws text,p_call_id text)
RETURNS TABLE(outcome text,booked_usd text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE c record; r record; e record; b record; vr record; v_now timestamptz; v_entry text; v_overflow numeric(20,8); n integer;
BEGIN
 IF p_org IS NULL OR p_ws IS NULL OR p_call_id IS NULL OR p_call_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT x.run_id::text AS run_id,x.product_index,x.attempt,x.status INTO c FROM morrow_work.run_model_calls x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_call_id;
 IF NOT FOUND OR c.status<>'started' THEN RETURN QUERY SELECT 'not_open'::text,NULL::text; RETURN; END IF;
 SELECT x.catalogue_version,x.model_key,x.effort_key INTO r FROM morrow_work.runs x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=c.run_id;
 SELECT x.worst_case_per_attempt_usd INTO e FROM morrow_work.model_catalogue_entries x
  WHERE x.version=r.catalogue_version AND x.model_key=r.model_key AND x.effort_key=r.effort_key;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 v_entry:=c.run_id||':'||c.product_index||':'||c.attempt;
 v_overflow:=NULL;
 SELECT * INTO b FROM morrow_billing.run_book_cost(p_org,p_ws,c.run_id,v_entry,e.worst_case_per_attempt_usd,'uncertain_attempt');
 IF b.outcome='reservation_exceeded' THEN
  -- What the reservation still holds is booked; the rest is overflow, never dropped.
  SELECT x.maximum_cost_usd,x.booked_cost_usd INTO vr FROM morrow_billing.vendor_cost_reservations x WHERE x.organization_id=p_org
   AND x.workspace_id=p_ws AND x.root_run_id=c.run_id;
  SELECT * INTO b FROM morrow_billing.run_book_cost(p_org,p_ws,c.run_id,v_entry,greatest(vr.maximum_cost_usd-vr.booked_cost_usd,0),'uncertain_attempt');
  IF b.outcome IS DISTINCT FROM 'booked' THEN RAISE EXCEPTION 'WORK_MODEL_CALL_UNBOOKED'; END IF;
  v_overflow:=e.worst_case_per_attempt_usd-greatest(vr.maximum_cost_usd-vr.booked_cost_usd,0);
  SELECT * INTO b FROM morrow_billing.run_book_cost(p_org,p_ws,c.run_id,v_entry||':x',v_overflow,'overflow');
  IF b.outcome IS DISTINCT FROM 'booked' THEN RAISE EXCEPTION 'WORK_MODEL_CALL_UNBOOKED'; END IF;
 ELSIF b.outcome='ended' THEN
  -- The run settled meanwhile: the whole worst case is overflow.
  v_overflow:=e.worst_case_per_attempt_usd;
  v_entry:=v_entry||':x';
  SELECT * INTO b FROM morrow_billing.run_book_cost(p_org,p_ws,c.run_id,v_entry,v_overflow,'overflow');
  IF b.outcome IS DISTINCT FROM 'booked' THEN RAISE EXCEPTION 'WORK_MODEL_CALL_UNBOOKED'; END IF;
 ELSIF b.outcome IS DISTINCT FROM 'booked' THEN RAISE EXCEPTION 'WORK_MODEL_CALL_UNBOOKED';
 END IF;
 UPDATE morrow_work.run_model_calls x SET status='closed',outcome='uncertain',counted=true,cost_usd=e.worst_case_per_attempt_usd,
  overflow_usd=CASE WHEN v_overflow>0 THEN v_overflow ELSE NULL END,booking_id=v_entry,
  closed_at=greatest(v_now,x.started_at) WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_call_id;
 UPDATE morrow_work.run_products x SET attempts=least(x.attempts+1,2),revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.run_id=c.run_id AND x.product_index=c.product_index AND x.attempts<2;
 UPDATE morrow_work.run_manifests x SET attempts=least(x.attempts+1,50),booked_cost_usd=x.booked_cost_usd+e.worst_case_per_attempt_usd,
  revision=x.revision+1,updated_at=greatest(v_now,x.updated_at) WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.run_id=c.run_id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_RUN_MANIFEST_INVALID'; END IF;
 RETURN QUERY SELECT 'closed'::text,to_char(e.worst_case_per_attempt_usd,'FM999999999990.00000000');
END $$;
-- Ends one open run: products still pending are skipped; a product in progress fails as
-- interrupted and its attempts accrue as unrecovered; drafts never packed into a proposal
-- earned no credit, so their product's attempts accrue too; the credits settle at the
-- products whose drafts were proposed (never above the reservation; nothing proposed
-- releases them); the status moves along the named edge; the envelope and hop are revoked;
-- the run's event is appended. The caller holds the run's lock and has closed every open
-- call. The lock order everywhere is the workspace stream, then the run, then the rest
-- (each API command's prelude takes the stream first): the stream is taken here before
-- any credit or cost row (a no-op when the caller already holds it). Outcomes: ended (with
-- the status and the credits settled), invalid.
CREATE FUNCTION morrow_work.run_end(p_org text,p_ws text,p_run_id text,p_status text,p_actor text,p_guard text,p_reason text)
RETURNS TABLE(outcome text,status text,credits_settled text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; p record; s record; v_now timestamptz; v_packed integer; n integer;
BEGIN
 SELECT x.* INTO r FROM morrow_work.runs x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_run_id;
 IF NOT FOUND OR r.status NOT IN ('queued','running') OR p_status NOT IN ('succeeded','failed','cancelled')
  OR (p_status='succeeded')<>(p_reason IS NULL) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM morrow_work.run_model_calls x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.run_id=p_run_id
   AND x.status='started') THEN RAISE EXCEPTION 'WORK_RUN_CALL_OPEN'; END IF;
 PERFORM 1 FROM morrow_work.workspace_streams w WHERE w.organization_id=p_org AND w.workspace_id=p_ws FOR UPDATE;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 FOR p IN SELECT x.product_index,x.status FROM morrow_work.run_products x WHERE x.organization_id=p_org AND x.workspace_id=p_ws
   AND x.run_id=p_run_id AND x.status IN ('pending','in_progress') ORDER BY x.product_index LOOP
  IF p.status='in_progress' THEN
   SELECT * INTO s FROM morrow_billing.run_product_unrecovered(p_org,p_ws,p_run_id,p.product_index);
   IF s.outcome IS DISTINCT FROM 'accrued' THEN RAISE EXCEPTION 'WORK_RUN_UNRECOVERED_FAILED'; END IF;
   UPDATE morrow_work.run_products x SET status='failed',failure_code='interrupted',revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
    WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.run_id=p_run_id AND x.product_index=p.product_index;
  ELSE
   UPDATE morrow_work.run_products x SET status='skipped',revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
    WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.run_id=p_run_id AND x.product_index=p.product_index;
  END IF;
 END LOOP;
 FOR p IN SELECT d.product_index FROM morrow_work.run_drafts d WHERE d.organization_id=p_org AND d.workspace_id=p_ws AND d.run_id=p_run_id
   AND d.status='pending' ORDER BY d.product_index LOOP
  SELECT * INTO s FROM morrow_billing.run_product_unrecovered(p_org,p_ws,p_run_id,p.product_index);
  IF s.outcome IS DISTINCT FROM 'accrued' THEN RAISE EXCEPTION 'WORK_RUN_UNRECOVERED_FAILED'; END IF;
 END LOOP;
 SELECT count(*) INTO v_packed FROM morrow_work.run_drafts d WHERE d.organization_id=p_org AND d.workspace_id=p_ws AND d.run_id=p_run_id
  AND d.status='packed';
 SELECT * INTO s FROM morrow_billing.run_settle(p_org,p_ws,p_run_id,v_packed);
 IF s.outcome IS NULL OR s.outcome NOT IN ('settled','released') THEN RAISE EXCEPTION 'WORK_RUN_SETTLE_FAILED'; END IF;
 UPDATE morrow_work.runs x SET status=p_status,status_actor=p_actor,status_guard=p_guard,ended_reason=p_reason,
  products_failed=(SELECT count(*) FROM morrow_work.run_products q WHERE q.organization_id=p_org AND q.workspace_id=p_ws AND q.run_id=p_run_id
   AND q.status='failed'),
  started_at=CASE WHEN x.status='queued' THEN NULL ELSE x.started_at END,ended_at=greatest(v_now,x.created_at),revision=x.revision+1,
  updated_at=greatest(v_now,x.updated_at) WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_run_id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_RUN_INVALID'; END IF;
 UPDATE morrow_work.work_envelopes x SET revoked_at=greatest(v_now,x.created_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.envelope_id AND x.revoked_at IS NULL;
 UPDATE morrow_work.delegation_hops x SET revoked_at=greatest(v_now,x.created_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.hop_id AND x.revoked_at IS NULL;
 PERFORM morrow_work.append_event(p_org,p_ws,r.requester_principal_id,r.requester_membership_id,'run.status_changed','run',p_run_id,
  r.revision+1,r.task_id,jsonb_build_object('from',r.status,'to',p_status,'reason',p_reason),'run:'||p_run_id,v_now);
 RETURN QUERY SELECT 'ended'::text,p_status,s.credits_settled;
END $$;
-- The stale-run close (the run-close option of the PR-2 plan review): a run whose lease a
-- stop revoked, or whose 30-minute run lease ended, has no lease context left in which to
-- settle, so the workspace's own session context closes it: its open calls are booked as
-- uncertain at their worst case, its interrupted product's attempts accrue as unrecovered,
-- its credits settle at the products proposed, and it moves to cancelled through the
-- work_service edges (queued: no_submitted_effects; running: submitted_effects_reconciled).
-- p_requester null closes every stale run of the workspace (before an admission); a
-- principal closes only the runs it requested (the reconcile command). The caller holds the
-- workspace stream (its prelude); a run whose lock is held (a live step, or the broker
-- closing a call) is skipped rather than waited for, so the stream holder never waits on a
-- run, and the next close takes it; a run taken is rechecked under its lock. At most 25 runs
-- per call, oldest first. Returns the number closed.
CREATE FUNCTION morrow_work.runs_close_stale(p_org text,p_ws text,p_requester text) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE r record; c record; v_closed integer:=0; e record;
BEGIN
 FOR r IN SELECT x.id::text AS id,x.status,l.status AS lease_status,l.revoked_reason,l.expires_at
   FROM morrow_work.runs x JOIN morrow_work.work_leases l ON l.organization_id=x.organization_id AND l.workspace_id=x.workspace_id AND l.id=x.lease_id
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.status IN ('queued','running')
    AND (l.status<>'active' OR l.expires_at<=pg_catalog.clock_timestamp())
    AND (p_requester IS NULL OR x.requester_principal_id::text=p_requester)
   ORDER BY x.created_at,x.id LIMIT 25 LOOP
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run',p_org,p_ws,r.id)::text,0)) THEN
   CONTINUE;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM morrow_work.runs x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.id
    AND x.status IN ('queued','running')) THEN
   CONTINUE;
  END IF;
  FOR c IN SELECT x.id::text AS id FROM morrow_work.run_model_calls x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.run_id=r.id
    AND x.status='started' LOOP
   PERFORM morrow_work.run_fence_close_uncertain(p_org,p_ws,c.id);
  END LOOP;
  SELECT * INTO e FROM morrow_work.run_end(p_org,p_ws,r.id,'cancelled','work_service',
   CASE WHEN r.status='queued' THEN 'no_submitted_effects' ELSE 'submitted_effects_reconciled' END,
   CASE WHEN r.lease_status='revoked' AND r.revoked_reason='stop' THEN 'stopped' ELSE 'lease_ended' END);
  IF e.outcome IS DISTINCT FROM 'ended' THEN RAISE EXCEPTION 'WORK_RUN_CLOSE_FAILED'; END IF;
  v_closed:=v_closed+1;
 END LOOP;
 RETURN v_closed;
END $$;

-- ---------------------------------------------------------------------------
-- M2 PR-3's revisable owner helpers (0035), same signatures, revised now that the runs and
-- their store content exist. CREATE OR REPLACE keeps their owner (the work owner) and their
-- ACL (EXECUTE for the command role only), restated below; the prerequisites pin the text
-- 0035 wrote, so a later revision is never replaced blind.
-- Whether a run lease may read one product (spine §4; M2 PR-3 review finding B2): only a
-- product of that run, while the run is running and the product is in progress (begun by
-- run_product_begin, not yet finished). shopify_read_resolve calls it with the tenant and the
-- run id resolve_call resolved from the lease. It writes morrow.vault_read_run before it
-- reads (the broker_read_run and broker_read_run_product policies, the broker's login only)
-- and clears it after; under any other session user it reads nothing, so it is false.
CREATE OR REPLACE FUNCTION morrow_work.run_product_readable(p_org text,p_ws text,p_run_id text,p_product_id text) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_readable boolean;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_run_id IS NULL OR p_run_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_product_id IS NULL OR p_product_id !~ '^product:[1-9][0-9]{0,19}$' THEN
  RETURN false;
 END IF;
 PERFORM pg_catalog.set_config('morrow.vault_read_run',p_org||'|'||p_ws||'|'||p_run_id,true);
 SELECT EXISTS(SELECT 1 FROM morrow_work.runs r JOIN morrow_work.run_products q ON q.organization_id=r.organization_id
   AND q.workspace_id=r.workspace_id AND q.run_id=r.id
  WHERE r.organization_id=p_org AND r.workspace_id=p_ws AND r.id=p_run_id AND r.status='running'
   AND q.product_id=p_product_id AND q.status='in_progress') INTO v_readable;
 PERFORM pg_catalog.set_config('morrow.vault_read_run','',true);
 RETURN v_readable;
END $$;
REVOKE ALL ON FUNCTION morrow_work.run_product_readable(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.run_product_readable(text,text,text,text) TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- API functions: SECURITY DEFINER, owned by the command role after the transfer below,
-- EXECUTE for morrow_work_api only. Tenant and actor come only from current_tenant().
-- Replay first for the run commands: the per-actor key lock, then the recorded command.
CREATE FUNCTION morrow_work.begin_run_command(p_type text,p_command_id text,p_request_digest text)
RETURNS TABLE(outcome text,aggregate_type text,aggregate_id text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; c record;
BEGIN
 IF p_type IS NULL OR p_type NOT IN ('run.admit','run.reconcile')
  OR p_command_id IS NULL OR p_command_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_request_digest IS NULL OR p_request_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.organization_id,x.workspace_id,x.principal_id INTO t FROM morrow_work.current_tenant() x;
 IF NOT FOUND THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.work.command',t.organization_id,t.workspace_id,t.principal_id,p_command_id)::text,0));
 SELECT k.request_digest::text AS request_digest,k.command_type,k.aggregate_type,k.aggregate_id::text AS aggregate_id,k.result::text AS result INTO c
  FROM morrow_work.commands k WHERE k.organization_id=t.organization_id AND k.workspace_id=t.workspace_id
  AND k.actor_principal_id=t.principal_id AND k.command_id=p_command_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'new'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF c.request_digest<>p_request_digest OR c.command_type<>p_type THEN RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'replay'::text,c.aggregate_type,c.aggregate_id,c.result;
END $$;
-- Run admission (mvp-architecture §2 step 7 and §9), after the Worker's human kernel allowed
-- the requester on the store resource (execute on catalog.content.propose, view on
-- catalog.products.read, delegate on both, propose and delegate on catalog.content.publish),
-- entitlementFor allowed, and the selection resolved within the member's ceiling. One
-- transaction under the P06.T01a prelude (the actor's grants digest is rechecked under lock,
-- so the Worker's decisions, the ceiling exemption of governance.model_default.revise among
-- them, are current). Rechecked here: the parent task T is the actor's own and open; the
-- store's association is current, no stop blocks a run on it, and its morrow.listings
-- installation is active; the selection is an entry of the active SQL catalogue, within the
-- workspace's member ceiling unless p_holds_revise; the products are 1..the entry's run
-- limit distinct product ids; the fields are the run's listing fields with the SEO pair; the
-- CoordinatorRoute@1 is exactly the run's. Derived here, never taken from the request: the
-- workspace's active Morrow-direct billing account, its current entitlement (the latest
-- snapshot active and unexpired) and billing period (the latest granted subscription period,
-- unended), the single-payer allocation, the Coordinator's principal and its grant. Then, in
-- order: the stale runs of the workspace close; the reservations (run_reserve: credits,
-- vendor cost, daily cap, unrecovered cap); the run lease (lease_open, refused under any
-- stop); child task T' (draft -> ready, owned by the actor); the envelope on T (the actor as
-- requester and authorizer; the three Listings capabilities; view, execute and propose; the
-- store's listings scope; 24 hours; depth 1 and one child); the Coordinator's
-- workspace.task.delegate {delegate} grant on T, issued by the actor and expiring with the
-- envelope (the identity bridge's coordinator allowlist); the hop T -> T'; the run, its
-- products and its manifest; the run.admitted event; the command. Outcomes: applied,
-- invalid, ineligible, stale_authority, command_conflict, not_found, state_conflict, stopped,
-- denied (the store's installation is not active or the ceiling refuses), entitlement,
-- no_billing_period, approvals_limit (the workspace's live pending approvals under its current
-- review policy plus one proposal per product would pass the 1,000 cap the agent submit
-- enforces, so the run's drafts could never be proposed), insufficient_credits, daily_cap,
-- unrecovered_cost_cap, run_product_limit, catalogue_inactive, duplicate. Every non-applied
-- outcome is returned for rollback.
CREATE FUNCTION morrow_work.cmd_run_admit(p_command_id text,p_request_digest text,p_correlation_id text,p_task_id text,p_store_id text,
 p_run_id text,p_child_task_id text,p_envelope_id text,p_hop_id text,p_catalogue_version text,p_model text,p_effort text,p_holds_revise text,
 p_products text,p_fields text,p_route_canonical text,p_route_digest text,p_coordinator_principal_id text,p_grant_id text,p_workflow_version text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; k record; s record; i record; e record; v record; d record; a record; per record; snap record; res record; l record; c record;
 g record; rel record; v_policy bigint; v_now timestamptz; v_until timestamptz; v_products jsonb; v_fields text[]; v_ceiling integer;
 v_scope jsonb; v_caps text[]:=ARRAY['catalog.content.propose','catalog.content.publish','catalog.products.read'];
 v_verbs text[]:=ARRAY['execute','propose','view']; v_grant jsonb; v_actor jsonb; v_result jsonb; v_index integer:=0; v_product text;
 v_reservation text; v_vendor text; v_allocation text; v_child_envelope text;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_task_id IS NULL OR p_task_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_run_id IS NULL OR p_run_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_child_task_id IS NULL OR p_child_task_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_envelope_id IS NULL OR p_envelope_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_hop_id IS NULL OR p_hop_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_catalogue_version IS NULL OR p_catalogue_version !~ '^[1-9][0-9]{0,2}$'
  OR p_model IS NULL OR p_model !~ '^[a-z][a-z0-9_]{0,39}$' OR p_effort IS NULL OR p_effort !~ '^[a-z][a-z0-9_]{0,39}$'
  OR p_holds_revise IS NULL OR p_holds_revise NOT IN ('true','false')
  OR p_products IS NULL OR octet_length(p_products)>2048 OR NOT pg_input_is_valid(p_products,'jsonb')
  OR p_fields IS NULL OR octet_length(p_fields)>256 OR NOT pg_input_is_valid(p_fields,'jsonb')
  OR p_route_canonical IS NULL OR octet_length(p_route_canonical)>8192
  OR p_route_digest IS NULL OR p_route_digest !~ '^[a-f0-9]{64}$' OR morrow_work.sha256_text(p_route_canonical)<>p_route_digest
  OR p_coordinator_principal_id IS NULL OR p_coordinator_principal_id !~ '^agent_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_grant_id IS NULL OR p_grant_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_workflow_version IS NULL OR p_workflow_version !~ '^listings-run@[1-9][0-9]{0,3}$'
  OR (SELECT count(DISTINCT x) FROM unnest(ARRAY[p_run_id,p_child_task_id,p_envelope_id,p_hop_id,p_grant_id]) x)<>5 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_products:=p_products::jsonb;
 IF jsonb_typeof(v_products)<>'array' OR jsonb_array_length(v_products) NOT BETWEEN 1 AND 25
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_products) x WHERE jsonb_typeof(x)<>'string' OR (x#>>'{}') !~ '^product:[1-9][0-9]{0,19}$')
  OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(v_products) x)<>jsonb_array_length(v_products)
  OR jsonb_typeof(p_fields::jsonb)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_fields::jsonb) x WHERE jsonb_typeof(x)<>'string') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_fields:=ARRAY(SELECT x FROM jsonb_array_elements_text(p_fields::jsonb) WITH ORDINALITY q(x,o) ORDER BY o);
 IF NOT morrow_work.run_fields_valid(v_fields) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT c2.policy_revision INTO v_policy FROM morrow_work.current_tenant() c2;
 v_now:=morrow_work.db_now();
 v_until:=v_now+interval '24 hours';
 -- The parent task: the actor's own, open, read under a share lock.
 SELECT x.status,x.revision::bigint AS revision,x.goal_id::text AS goal_id,x.initiator_principal_id::text AS ip,
  x.initiator_membership_id::text AS im INTO k FROM morrow_work.tasks x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_task_id FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF k.status NOT IN ('draft','ready') OR k.ip<>p.principal_id OR k.im<>p.membership_id THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 -- The store, its stops and its active Listings installation.
 SELECT x.connection_id INTO s FROM morrow_work.listings_store_current(p.organization_id,p.workspace_id,p_store_id) x LIMIT 1;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 SELECT x.id::text AS id,x.agent_principal_id::text AS agent_principal_id,x.status,x.connection_id::text AS connection_id,x.release_id,
  x.release_revision::bigint AS release_revision,x.release_digest::text AS release_digest INTO i FROM morrow_work.agent_installations x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.store_id=p_store_id AND x.release_id='morrow.listings'
   AND x.status<>'uninstalled';
 IF NOT FOUND OR i.status<>'active' OR i.connection_id<>s.connection_id::text THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF morrow_work.stop_active(p.organization_id,p.workspace_id,'run',s.connection_id,i.id) THEN RETURN QUERY SELECT 'stopped'::text,NULL::text; RETURN; END IF;
 -- The selection: an entry of the active version, within the member ceiling.
 SELECT x.credits_per_product,x.run_product_limit,x.worst_case_per_product_usd INTO e FROM morrow_work.model_catalogue_entries x
  JOIN morrow_work.model_catalogue_versions y ON y.version=x.version AND y.status='active'
  WHERE x.version=p_catalogue_version::integer AND x.model_key=p_model AND x.effort_key=p_effort;
 IF NOT FOUND THEN RETURN QUERY SELECT 'catalogue_inactive'::text,NULL::text; RETURN; END IF;
 SELECT y.digest::text AS digest,y.default_member_credit_ceiling INTO v FROM morrow_work.model_catalogue_versions y WHERE y.version=p_catalogue_version::integer;
 SELECT COALESCE((SELECT x.max_credits_per_product FROM morrow_work.workspace_model_defaults x WHERE x.organization_id=p.organization_id
  AND x.workspace_id=p.workspace_id),v.default_member_credit_ceiling) INTO v_ceiling;
 IF p_holds_revise='false' AND e.credits_per_product>v_ceiling THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF jsonb_array_length(v_products)>e.run_product_limit THEN RETURN QUERY SELECT 'run_product_limit'::text,NULL::text; RETURN; END IF;
 IF NOT morrow_work.route_matches(p_route_canonical,p.organization_id,p.workspace_id,p_run_id,p_task_id,p_child_task_id,i.id,p_store_id,
   s.connection_id,v_fields,jsonb_array_length(v_products)) OR (p_route_canonical::jsonb)->'products'<>v_products THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 -- Billing, derived: the active Morrow-direct account, its current entitlement and period.
 SELECT x.id::text AS id INTO a FROM morrow_billing.billing_accounts x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
  AND x.route='morrow_direct' AND x.status='active';
 IF NOT FOUND THEN RETURN QUERY SELECT 'entitlement'::text,NULL::text; RETURN; END IF;
 SELECT x.status,x.valid_until INTO snap FROM morrow_billing.entitlement_snapshots x WHERE x.organization_id=p.organization_id
  AND x.workspace_id=p.workspace_id AND x.billing_account_id=a.id ORDER BY x.revision DESC LIMIT 1;
 IF NOT FOUND OR snap.status<>'active' OR snap.valid_until<=v_now THEN RETURN QUERY SELECT 'entitlement'::text,NULL::text; RETURN; END IF;
 SELECT x.period_start,x.period_end INTO per FROM morrow_billing.verified_payment_events x WHERE x.organization_id=p.organization_id
  AND x.workspace_id=p.workspace_id AND x.outcome='granted' AND x.kind='subscription_period' ORDER BY x.period_end DESC,x.recorded_at DESC LIMIT 1;
 IF NOT FOUND OR per.period_end<=v_now OR per.period_start>v_now THEN RETURN QUERY SELECT 'no_billing_period'::text,NULL::text; RETURN; END IF;
 -- The pending approvals cap (submit_agent_proposal's 1,000 live under the current policy),
 -- before any spend: one proposal per product at most must still fit.
 IF (SELECT count(*) FROM morrow_work.approvals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.status='pending' AND x.expires_at>v_now AND x.review_policy_revision=(SELECT max(y.revision) FROM morrow_work.review_policies y
    WHERE y.organization_id=p.organization_id AND y.workspace_id=p.workspace_id AND y.id='review-policy'))+jsonb_array_length(v_products)>1000 THEN
  RETURN QUERY SELECT 'approvals_limit'::text,NULL::text; RETURN;
 END IF;
 -- The workspace's stale runs close first, so their credits are back before this reserves.
 PERFORM morrow_work.runs_close_stale(p.organization_id,p.workspace_id,NULL);
 -- Ids derived from the run (single payer, SQL-built allocation).
 v_reservation:='credit:'||p_run_id; v_vendor:='vendor:'||p_run_id; v_allocation:='allocation:'||p_run_id;
 v_child_envelope:='envelope:'||p_hop_id;
 SELECT * INTO res FROM morrow_billing.run_reserve(p.organization_id,p.workspace_id,a.id,p_run_id,v_reservation,v_vendor,v_allocation,
  morrow_work.sha256_text(jsonb_build_array('morrow.cost_allocation',2,p.organization_id,p.workspace_id,p_task_id,p_run_id,a.id,
   jsonb_array_length(v_products)*e.credits_per_product)::text),p_catalogue_version::integer,p_model,p_effort,jsonb_array_length(v_products),
  per.period_start);
 IF res.outcome IS DISTINCT FROM 'reserved' THEN RETURN QUERY SELECT res.outcome,NULL::text; RETURN; END IF;
 SELECT * INTO l FROM morrow_work.lease_open('run',p_run_id,p_store_id,s.connection_id,i.id);
 IF l.outcome IS DISTINCT FROM 'opened' THEN RETURN QUERY SELECT CASE l.outcome WHEN 'stopped' THEN 'stopped' ELSE 'invalid' END,NULL::text; RETURN; END IF;
 SELECT x.id,x.revision::bigint AS revision,x.digest::text AS digest INTO rel FROM morrow_work.agent_releases x
  WHERE x.id=i.release_id AND x.revision=i.release_revision AND x.digest=i.release_digest AND x.status='published';
 IF NOT FOUND THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
 v_scope:=morrow_work.listings_scope(p.organization_id,p.workspace_id,p_store_id,s.connection_id);
 v_actor:=jsonb_build_object('kind','human','principalId',p.principal_id,'organizationId',p.organization_id,'workspaceId',p.workspace_id,
  'membershipId',p.membership_id,'installationId',NULL,'mandateId',NULL);
 BEGIN
  -- Child task T': the installation's work item, owned by the actor (a task owner is a member).
  INSERT INTO morrow_work.tasks(organization_id,workspace_id,id,revision,goal_id,status,objective,scope,initiator_principal_id,
   initiator_membership_id,owner_principal_id,owner_membership_id,created_at,updated_at)
  VALUES (p.organization_id,p.workspace_id,p_child_task_id,1,k.goal_id,'draft','Listings drafting for run '||p_run_id,
   jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,
    'resources','[]'::jsonb,'fields','[]'::jsonb),p.principal_id,p.membership_id,p.principal_id,p.membership_id,v_now,v_now);
  UPDATE morrow_work.tasks x SET status='ready',revision=2,updated_at=v_now
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_child_task_id;
  INSERT INTO morrow_work.work_envelopes(organization_id,workspace_id,id,revision,task_id,task_revision,requester_principal_id,
   requester_membership_id,store_id,installation_id,capability_ids,verbs,scope,valid_from,expires_at,revoked_at,maximum_depth,maximum_children,created_at)
  VALUES (p.organization_id,p.workspace_id,p_envelope_id,1,p_task_id,k.revision,p.principal_id,p.membership_id,p_store_id,i.id,v_caps,v_verbs,
   v_scope,v_now,v_until,NULL,1,1,v_now);
  -- The workspace's one Coordinator principal (created at enable; ensured here).
  SELECT * INTO c FROM morrow_identity.work_agent_principal_ensure(p.organization_id,p.workspace_id,'coordinator',NULL,p_coordinator_principal_id);
  IF c.outcome IS NULL OR c.outcome NOT IN ('created','exists') THEN RAISE EXCEPTION 'AGENT_COORDINATOR_REFUSED'; END IF;
  v_grant:=jsonb_build_object('id',p_grant_id,'principal',jsonb_build_object('kind','agent','principalId',c.principal_id,
    'organizationId',p.organization_id,'workspaceId',p.workspace_id,'membershipId',NULL,'installationId',NULL,'mandateId',NULL),
   'capabilityId','workspace.task.delegate','verbs','["delegate"]'::jsonb,
   'scope',jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,
    'resources',jsonb_build_array(jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeId',NULL,
     'connectionId',NULL,'kind','task','id',p_task_id)),'fields','["installationId","mandate","taskId"]'::jsonb),
   'issuedBy',v_actor,'validFrom',morrow_work.utc_text(v_now),'expiresAt',morrow_work.utc_text(v_until),'revokedAt',NULL,'policyRevision',v_policy);
  SELECT * INTO g FROM morrow_identity.work_agent_grants_issue(p.organization_id,p.workspace_id,jsonb_build_array(v_grant));
  IF g.outcome IS DISTINCT FROM 'issued' OR g.issued IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'AGENT_COORDINATOR_GRANT_REFUSED'; END IF;
  INSERT INTO morrow_work.delegation_hops(organization_id,workspace_id,id,revision,parent_task_id,parent_task_revision,child_task_id,
   child_task_revision,parent_envelope_id,parent_envelope_revision,child_envelope_id,child_envelope_revision,dispatcher_kind,dispatcher_principal_id,
   dispatcher_installation_id,recipient_principal_id,recipient_installation_id,capability_ids,verbs,scope,valid_from,expires_at,revoked_at,
   parent_child_count,created_at)
  VALUES (p.organization_id,p.workspace_id,p_hop_id,1,p_task_id,k.revision,p_child_task_id,2,p_envelope_id,1,v_child_envelope,1,
   'builtin_coordinator',c.principal_id,NULL,i.agent_principal_id,i.id,v_caps,v_verbs,v_scope,v_now,v_until,NULL,0,v_now);
  INSERT INTO morrow_work.runs(organization_id,workspace_id,id,revision,task_id,child_task_id,store_id,connection_id,installation_id,
   agent_principal_id,coordinator_principal_id,envelope_id,hop_id,lease_id,lease_generation,requester_principal_id,requester_membership_id,
   status,status_actor,status_guard,ended_reason,catalogue_version,model_key,effort_key,credits_per_product,product_count,fields,route_canonical,
   route_digest,billing_account_id,period_start,products_drafted,products_failed,consecutive_failed,workflow_version,command_id,created_at,
   started_at,ended_at,updated_at)
  VALUES (p.organization_id,p.workspace_id,p_run_id,1,p_task_id,p_child_task_id,p_store_id,s.connection_id,i.id,i.agent_principal_id,
   c.principal_id,p_envelope_id,p_hop_id,l.lease_id,l.generation::bigint,p.principal_id,p.membership_id,'queued','work_service','dispatch_eligible',
   NULL,p_catalogue_version::integer,p_model,p_effort,e.credits_per_product,jsonb_array_length(v_products),v_fields,p_route_canonical,p_route_digest,
   a.id,date_trunc('milliseconds',per.period_start),0,0,0,p_workflow_version,p_command_id,v_now,NULL,NULL,v_now);
  FOR v_product IN SELECT x FROM jsonb_array_elements_text(v_products) WITH ORDINALITY q(x,o) ORDER BY o LOOP
   INSERT INTO morrow_work.run_products(organization_id,workspace_id,run_id,product_index,product_id,revision,status,attempts,snapshot_digest,
    draft_id,failure_code,updated_at)
   VALUES (p.organization_id,p.workspace_id,p_run_id,v_index,v_product,1,'pending',0,NULL,NULL,NULL,v_now);
   v_index:=v_index+1;
  END LOOP;
  INSERT INTO morrow_work.run_manifests(organization_id,workspace_id,run_id,revision,catalogue_version,catalogue_digest,model_key,effort_key,
   credits_per_product,provider,provider_model_id,release_id,release_revision,release_digest,route_digest,workflow_version,prompt_digest,
   schema_digest,attempts,input_tokens,output_tokens,cache_tokens,booked_cost_usd,created_at,updated_at)
  SELECT p.organization_id,p.workspace_id,p_run_id,1,p_catalogue_version::integer,v.digest,p_model,p_effort,e.credits_per_product,r.provider,
   r.provider_model_id,rel.id,rel.revision,rel.digest,p_route_digest,p_workflow_version,NULL,NULL,0,0,0,0,0,v_now,v_now
  FROM morrow_work.model_catalogue_rates r WHERE r.version=p_catalogue_version::integer AND r.model_key=p_model;
  GET DIAGNOSTICS v_index=ROW_COUNT;
  IF v_index<>1 THEN RAISE EXCEPTION 'WORK_RUN_MANIFEST_INVALID'; END IF;
 EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'task.created','task',p_child_task_id,1,
  p_child_task_id,jsonb_build_object('goalId',k.goal_id,'status','draft'),p_correlation_id,v_now);
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'task.status_changed','task',p_child_task_id,2,
  p_child_task_id,jsonb_build_object('from','draft','to','ready'),p_correlation_id,v_now);
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'run.admitted','run',p_run_id,1,p_task_id,
  jsonb_build_object('childTaskId',p_child_task_id,'productCount',jsonb_array_length(v_products)),p_correlation_id,v_now);
 v_result:=jsonb_build_object('runId',p_run_id,'status','queued','childTaskId',p_child_task_id,'productCount',jsonb_array_length(v_products),
  'creditsReserved',res.credits_reserved,'catalogueVersion',p_catalogue_version::integer,'model',p_model,'effort',p_effort);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'run.admit',p_run_id,1,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;
-- Closes the actor's own stale runs (runs_close_stale for the actor's principal) as one
-- recorded command, so credits a stop or an ended lease stranded return even while every new
-- run would be refused; the Worker first requires view on task.read. Another member's stale
-- run closes at the next admission in the workspace. Outcomes: applied (with the number
-- closed), invalid, ineligible, stale_authority, command_conflict.
CREATE FUNCTION morrow_work.cmd_runs_reconcile(p_command_id text,p_request_digest text,p_correlation_id text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; v_closed integer; v_result jsonb; v_now timestamptz;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 v_closed:=morrow_work.runs_close_stale(p.organization_id,p.workspace_id,p.principal_id);
 v_result:=jsonb_build_object('closed',v_closed);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'run.reconcile',p.workspace_id,1,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- Whether one of the session tenant's runs was interrupted: still queued or running while its
-- lease was revoked (a stop, a removed member) or has ended. The task screen offers the stale
-- close (cmd_runs_reconcile) for it. Null for no such run.
CREATE FUNCTION morrow_work.run_interrupted(p_run_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE t record;
BEGIN
 IF p_run_id IS NULL OR p_run_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RETURN NULL; END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN (SELECT x.status IN ('queued','running') AND (l.status<>'active' OR l.expires_at<=pg_catalog.clock_timestamp())
  FROM morrow_work.runs x JOIN morrow_work.work_leases l ON l.organization_id=x.organization_id AND l.workspace_id=x.workspace_id AND l.id=x.lease_id
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=p_run_id);
END $$;

-- ---------------------------------------------------------------------------
-- Runtime definers: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_runtime_executor only; the tenant and the run come only from the entered run
-- lease (the run is the lease's subject). Each mutating definer takes the run's lock; the
-- three that append an event or settle (run_start, submit_agent_proposal, run_finish) take
-- the workspace stream first, as every API command's prelude does (stream, then run, then
-- the rest), so a run step never waits on the stream while holding what a command waits on.
-- The entered lease's run, locked: shared by the runtime definers below.
-- Starts the entered lease's run: queued -> running (runtime, current_lease_and_grants), the
-- lease marked started, the event appended. A running run is returned as it stands, a
-- terminal one names its status (the Workflow ends). Returns the route's ids, the lease's
-- expiry for the Workflow's time budget and the run's catalogue version and selection keys
-- (the Workflow sizes each modelRespond budget from the effort's max_tokens; the call itself
-- never names them). Outcomes: started, running, ended, denied.
CREATE FUNCTION morrow_work.run_start()
RETURNS TABLE(outcome text,run_id text,task_id text,child_task_id text,envelope_id text,installation_id text,agent_principal_id text,store_id text,
 connection_id text,product_count text,fields text,lease_expires_at_ms text,status text,catalogue_version text,model_key text,effort_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record; r record; v_now timestamptz; v_outcome text;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 PERFORM 1 FROM morrow_work.workspace_streams w WHERE w.organization_id=l.organization_id AND w.workspace_id=l.workspace_id FOR UPDATE;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run',l.organization_id,l.workspace_id,l.subject_id)::text,0));
 SELECT x.* INTO r FROM morrow_work.runs x WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=l.subject_id
  AND x.lease_id=l.lease_id;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 IF r.status='queued' THEN
  UPDATE morrow_work.runs x SET status='running',status_actor='runtime',status_guard='current_lease_and_grants',started_at=greatest(v_now,x.created_at),
   revision=x.revision+1,updated_at=greatest(v_now,x.updated_at) WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.id=r.id;
  PERFORM morrow_work.lease_mark_started();
  PERFORM morrow_work.append_event(r.organization_id,r.workspace_id,r.requester_principal_id,r.requester_membership_id,'run.status_changed','run',
   r.id,r.revision+1,r.task_id,jsonb_build_object('from','queued','to','running','reason',NULL),'run:'||r.id,v_now);
  v_outcome:='started';
 ELSIF r.status='running' THEN v_outcome:='running';
 ELSE v_outcome:='ended';
 END IF;
 RETURN QUERY SELECT v_outcome,r.id::text,r.task_id::text,r.child_task_id::text,r.envelope_id::text,r.installation_id::text,
  r.agent_principal_id::text,r.store_id::text,r.connection_id::text,r.product_count::text,to_jsonb(r.fields)::text,(extract(epoch FROM l.expires_at)*1000)::bigint::text,
  CASE WHEN v_outcome='started' THEN 'running' ELSE r.status END,r.catalogue_version::text,r.model_key,r.effort_key;
END $$;
-- The billing rows of the entered lease's workspace, in the exact row shapes of the api's
-- billing statements, so M5's createBillingFactsReader maps them unchanged into the agent
-- kernel's entitlement fact and the billing period. JSON text: {route, associations, account,
-- snapshot, wallet, conflicts, intent, period, hold}, each an array of rows. Ids, states and
-- times only. Empty for anything but an entered run lease.
CREATE FUNCTION morrow_work.run_billing_facts() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE l record; v_account text; o jsonb;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' THEN RETURN NULL; END IF;
 SELECT x.id::text INTO v_account FROM morrow_billing.billing_accounts x WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id
  AND x.route='morrow_direct';
 o:=jsonb_build_object(
  'route',COALESCE((SELECT jsonb_agg(jsonb_build_object('organization_id',r.organization_id::text,'workspace_id',r.workspace_id::text,'origin',r.origin,
    'shopify_bound_at',morrow_work.utc_text(r.shopify_bound_at),'route',r.route,'mode',r.mode,'route_fixed_at',morrow_work.utc_text(r.route_fixed_at),
    'fixing_payment_key',r.fixing_payment_key,'revision',r.revision::text)) FROM morrow_billing.workspace_billing_routes r
    WHERE r.organization_id=l.organization_id AND r.workspace_id=l.workspace_id),'[]'::jsonb),
  'associations',COALESCE((SELECT jsonb_agg(jsonb_build_object('installation_id',a.installation_id,'store_id',a.store_id,'connection_id',a.connection_id,
    'status',a.status,'linked_at',morrow_work.utc_text(date_trunc('milliseconds',a.linked_at))) ORDER BY a.linked_at,a.installation_id COLLATE "C")
    FROM (SELECT * FROM morrow_identity.work_store_installations(l.organization_id,l.workspace_id) w WHERE w.linked_at IS NOT NULL
     ORDER BY w.linked_at,w.installation_id COLLATE "C" LIMIT 101) a),'[]'::jsonb),
  'account',COALESCE((SELECT jsonb_agg(jsonb_build_object('organization_id',a.organization_id::text,'workspace_id',a.workspace_id::text,'id',a.id::text,
    'route',a.route,'mode',a.mode,'currency',a.currency,'status',a.status,'revision',a.revision::text)) FROM morrow_billing.billing_accounts a
    WHERE a.organization_id=l.organization_id AND a.workspace_id=l.workspace_id AND a.route='morrow_direct'),'[]'::jsonb),
  'snapshot',COALESCE((SELECT jsonb_agg(jsonb_build_object('organization_id',s.organization_id::text,'workspace_id',s.workspace_id::text,
    'billing_account_id',s.billing_account_id::text,'revision',s.revision::text,'route',s.route,'mode',s.mode,'subscription_key',s.subscription_key,
    'status',s.status,'provider_evidence_ref',s.provider_evidence_ref::text,'verified_at',morrow_work.utc_text(s.verified_at),
    'valid_until',morrow_work.utc_text(s.valid_until))) FROM (SELECT * FROM morrow_billing.entitlement_snapshots x WHERE x.organization_id=l.organization_id
    AND x.workspace_id=l.workspace_id AND x.billing_account_id=v_account ORDER BY x.revision DESC LIMIT 1) s),'[]'::jsonb),
  'wallet',COALESCE((SELECT jsonb_agg(jsonb_build_object('organization_id',w.organization_id::text,'workspace_id',w.workspace_id::text,
    'billing_account_id',w.billing_account_id::text,'available',w.available::text,'reserved',w.reserved::text,'consumed',w.consumed::text,
    'rate_revision',w.rate_revision::text,'terms_revision',w.terms_revision::text,'revision',w.revision::text)) FROM morrow_billing.credit_wallets w
    WHERE w.organization_id=l.organization_id AND w.workspace_id=l.workspace_id AND w.billing_account_id=v_account),'[]'::jsonb),
  'conflicts',COALESCE((SELECT jsonb_agg(jsonb_build_object('route',c.route,'subscription_key',c.subscription_key,'code',c.code)) FROM (
    SELECT DISTINCT ON (v.subscription_key) v.route,v.subscription_key,v.outcome_code AS code FROM morrow_billing.verified_payment_events v
    WHERE v.organization_id=l.organization_id AND v.workspace_id=l.workspace_id AND v.outcome='conflict'
    ORDER BY v.subscription_key,v.recorded_at DESC,v.id::text COLLATE "C" DESC LIMIT 101) c),'[]'::jsonb),
  'intent',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id::text,'status',i.status,'price_key',i.price_key,
    'expires_at',morrow_work.utc_text(i.expires_at))) FROM morrow_billing.checkout_intents i WHERE i.organization_id=l.organization_id
    AND i.workspace_id=l.workspace_id AND i.status IN ('open','completed')),'[]'::jsonb),
  'period',COALESCE((SELECT jsonb_agg(jsonb_build_object('period_start',morrow_work.utc_text(v.period_start),'period_end',morrow_work.utc_text(v.period_end)))
    FROM (SELECT * FROM morrow_billing.verified_payment_events x WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id
    AND x.outcome='granted' AND x.kind='subscription_period' ORDER BY x.period_end DESC,x.recorded_at DESC LIMIT 1) v),'[]'::jsonb),
  'hold',COALESCE((SELECT jsonb_agg(jsonb_build_object('operation_id',s.operation_id::text,'held_at',morrow_work.utc_text(s.held_at))) FROM (
    SELECT x.operation_id,x.held_at FROM morrow_billing.stripe_operations x JOIN morrow_work.operations o ON o.organization_id=x.organization_id
    AND o.workspace_id=x.workspace_id AND o.id=x.operation_id WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id
    AND x.purpose='customer_create' AND x.held_at IS NOT NULL AND o.status='uncertain' ORDER BY x.held_at DESC,x.operation_id::text COLLATE "C" LIMIT 2) s),
   '[]'::jsonb));
 RETURN o::text;
END $$;
-- Begins one product of the entered lease's run (mvp-architecture §2 step 8): the run is
-- running; no call of the run is open; no model call overflowed its reservation; the
-- failed-product breaker is below its limit; the reservation still holds one product's worst
-- case; the workspace's unrecovered cost this period plus that worst case stays within the cap
-- (ADR-0022 item 11). The product moves pending -> in_progress (a retried step finds it in
-- progress). Returns the product id, the attempts the broker counted, the snapshot it holds,
-- the run's fields and the parent task's objective (the merchant's request text: used inside
-- the step only, never stored by the Workflow). Outcomes: begun, done (the product already
-- ended), stop (the run must end: the reason is in `reason`), denied, invalid.
CREATE FUNCTION morrow_work.run_product_begin(p_index text)
RETURNS TABLE(outcome text,reason text,product_id text,attempts text,snapshot_digest text,fields text,objective text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record; r record; q record; e record; vr record; v_now timestamptz; v_index integer; v_objective text;
BEGIN
 IF p_index IS NULL OR p_index !~ '^(0|[1-9][0-9]?)$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_index:=p_index::integer;
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run',l.organization_id,l.workspace_id,l.subject_id)::text,0));
 SELECT x.* INTO r FROM morrow_work.runs x WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=l.subject_id
  AND x.lease_id=l.lease_id;
 IF NOT FOUND OR r.status<>'running' THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT x.* INTO q FROM morrow_work.run_products x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id
  AND x.product_index=v_index;
 IF NOT FOUND THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF q.status NOT IN ('pending','in_progress') THEN
  RETURN QUERY SELECT 'done'::text,q.status,q.product_id,q.attempts::text,q.snapshot_digest::text,to_jsonb(r.fields)::text,NULL::text; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM morrow_work.run_model_calls x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id
   AND x.status='started' AND x.product_index<>v_index) THEN
  RETURN QUERY SELECT 'invalid'::text,'call_open'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.worst_case_per_product_usd INTO e FROM morrow_work.model_catalogue_entries x WHERE x.version=r.catalogue_version AND x.model_key=r.model_key
  AND x.effort_key=r.effort_key;
 SELECT x.maximum_cost_usd,x.booked_cost_usd,x.status INTO vr FROM morrow_billing.vendor_cost_reservations x WHERE x.organization_id=r.organization_id
  AND x.workspace_id=r.workspace_id AND x.root_run_id=r.id;
 IF EXISTS(SELECT 1 FROM morrow_work.run_model_calls x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id
   AND x.overflow_usd>0) THEN
  RETURN QUERY SELECT 'stop'::text,'cost_overflow'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF q.status='pending' THEN
  -- maxConsecutiveFailedProducts of the catalogue (3 in every published version).
  IF r.consecutive_failed>=3 THEN
   RETURN QUERY SELECT 'stop'::text,'breaker'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  IF vr.status IS DISTINCT FROM 'reserved' OR vr.maximum_cost_usd-vr.booked_cost_usd<e.worst_case_per_product_usd THEN
   RETURN QUERY SELECT 'stop'::text,'reservation_exhausted'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  IF NOT morrow_billing.unrecovered_allows(r.organization_id,r.workspace_id,r.period_start,r.catalogue_version,e.worst_case_per_product_usd) THEN
   RETURN QUERY SELECT 'stop'::text,'unrecovered_cost_cap'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  v_now:=morrow_work.db_now();
  UPDATE morrow_work.run_products x SET status='in_progress',revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.product_index=v_index;
 END IF;
 SELECT x.objective INTO v_objective FROM morrow_work.tasks x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
  AND x.id=r.task_id;
 RETURN QUERY SELECT 'begun'::text,NULL::text,q.product_id,q.attempts::text,q.snapshot_digest::text,to_jsonb(r.fields)::text,v_objective;
END $$;
-- Records one product as read (store content, 90 days): the canonical snapshot of the
-- in-progress product, content-addressed and at most 64 KiB, bound to the product. A larger
-- product is too_large (it fails before any spend). A snapshot already bound is replaced only
-- before any attempt was counted (a re-read after a retried step); after that the call must
-- use exactly the bound snapshot. Outcomes: stored (with the digest), too_large, conflict,
-- denied, invalid.
CREATE FUNCTION morrow_work.run_snapshot_put(p_index text,p_canonical text)
RETURNS TABLE(outcome text,digest text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record; r record; q record; v_now timestamptz; v_digest text; v_index integer;
BEGIN
 IF p_index IS NULL OR p_index !~ '^(0|[1-9][0-9]?)$' OR p_canonical IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 v_index:=p_index::integer;
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run',l.organization_id,l.workspace_id,l.subject_id)::text,0));
 SELECT x.* INTO r FROM morrow_work.runs x WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=l.subject_id
  AND x.lease_id=l.lease_id;
 IF NOT FOUND OR r.status<>'running' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT x.* INTO q FROM morrow_work.run_products x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id
  AND x.product_index=v_index;
 IF NOT FOUND OR q.status<>'in_progress' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 IF octet_length(p_canonical)>65536 THEN RETURN QUERY SELECT 'too_large'::text,NULL::text; RETURN; END IF;
 IF NOT morrow_work.snapshot_matches(p_canonical,q.product_id) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 v_digest:=morrow_work.sha256_text(p_canonical);
 IF q.snapshot_digest IS NOT NULL AND q.snapshot_digest::text<>v_digest AND q.attempts>0 THEN RETURN QUERY SELECT 'conflict'::text,NULL::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 INSERT INTO morrow_work.product_snapshots(organization_id,workspace_id,store_id,digest,product_id,canonical,read_at,expires_at)
 VALUES (r.organization_id,r.workspace_id,r.store_id,v_digest,q.product_id,p_canonical,v_now,v_now+interval '90 days') ON CONFLICT DO NOTHING;
 IF q.snapshot_digest IS DISTINCT FROM v_digest THEN
  UPDATE morrow_work.run_products x SET snapshot_digest=v_digest,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.product_index=v_index;
 END IF;
 RETURN QUERY SELECT 'stored'::text,v_digest;
END $$;
-- Ends one product of the entered lease's run. drafted: the validated change set (the
-- CatalogContentChangeSet@1 item `set`, its changed fields within the run's, the reviewer
-- flags) becomes a pending draft of the bound snapshot; the consecutive count resets.
-- failed: the failure code; the product's attempt bookings accrue as unrecovered; the
-- consecutive count grows. No call of the product may be open. Returns whether the run must
-- stop (the breaker). Outcomes: recorded (with stop and reason), done (already ended), denied,
-- invalid, call_open.
CREATE FUNCTION morrow_work.run_product_finish(p_index text,p_outcome text,p_failure_code text,p_set_canonical text,p_fields text,p_flags text)
RETURNS TABLE(outcome text,stop boolean,reason text,draft_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record; r record; q record; u record; v_now timestamptz; v_index integer; v_fields text[]; v_draft text; v_consecutive integer;
BEGIN
 IF p_index IS NULL OR p_index !~ '^(0|[1-9][0-9]?)$' OR p_outcome IS NULL OR p_outcome NOT IN ('drafted','failed')
  OR (p_outcome='failed')<>(p_failure_code IS NOT NULL) OR (p_outcome='drafted')<>(p_set_canonical IS NOT NULL)
  OR (p_outcome='drafted')<>(p_fields IS NOT NULL) OR (p_outcome='drafted')<>(p_flags IS NOT NULL)
  OR (p_failure_code IS NOT NULL AND p_failure_code NOT IN ('validation','product_mismatch','incomplete','refusal','invalid_output','uncertain',
   'input_over_cap','read_failed','too_large','provider_error','spend_limit','reservation_exhausted'))
  OR (p_fields IS NOT NULL AND (octet_length(p_fields)>256 OR NOT pg_input_is_valid(p_fields,'jsonb')))
  OR (p_flags IS NOT NULL AND (octet_length(p_flags)>512 OR NOT pg_input_is_valid(p_flags,'jsonb')))
  OR (p_set_canonical IS NOT NULL AND octet_length(p_set_canonical)>16000) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::boolean,NULL::text,NULL::text; RETURN;
 END IF;
 v_index:=p_index::integer;
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' THEN RETURN QUERY SELECT 'denied'::text,NULL::boolean,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run',l.organization_id,l.workspace_id,l.subject_id)::text,0));
 SELECT x.* INTO r FROM morrow_work.runs x WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=l.subject_id
  AND x.lease_id=l.lease_id;
 IF NOT FOUND OR r.status<>'running' THEN RETURN QUERY SELECT 'denied'::text,NULL::boolean,NULL::text,NULL::text; RETURN; END IF;
 SELECT x.* INTO q FROM morrow_work.run_products x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id
  AND x.product_index=v_index;
 IF NOT FOUND THEN RETURN QUERY SELECT 'invalid'::text,NULL::boolean,NULL::text,NULL::text; RETURN; END IF;
 IF q.status IN ('drafted','failed','skipped') THEN RETURN QUERY SELECT 'done'::text,false,q.status,q.draft_id::text; RETURN; END IF;
 IF q.status<>'in_progress' THEN RETURN QUERY SELECT 'invalid'::text,NULL::boolean,NULL::text,NULL::text; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM morrow_work.run_model_calls x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id
   AND x.product_index=v_index AND x.status='started') THEN
  RETURN QUERY SELECT 'call_open'::text,NULL::boolean,NULL::text,NULL::text; RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 IF p_outcome='drafted' THEN
  IF jsonb_typeof(p_fields::jsonb)<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_fields::jsonb) x WHERE jsonb_typeof(x)<>'string') THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::boolean,NULL::text,NULL::text; RETURN;
  END IF;
  v_fields:=ARRAY(SELECT x FROM jsonb_array_elements_text(p_fields::jsonb) WITH ORDINALITY z(x,o) ORDER BY o);
  -- A draft changes only fields the run asked for, from a bound snapshot, after a counted attempt.
  IF NOT morrow_work.run_fields_valid(v_fields) OR NOT (v_fields<@r.fields) OR q.snapshot_digest IS NULL OR q.attempts<1 THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::boolean,NULL::text,NULL::text; RETURN;
  END IF;
  v_draft:=gen_random_uuid()::text;
  BEGIN
   INSERT INTO morrow_work.run_drafts(organization_id,workspace_id,id,run_id,product_index,product_id,store_id,snapshot_digest,fields,set_canonical,
    set_digest,flags,status,proposal_id,created_at,expires_at,packed_at)
   VALUES (r.organization_id,r.workspace_id,v_draft,r.id,v_index,q.product_id,r.store_id,q.snapshot_digest,v_fields,p_set_canonical,
    morrow_work.sha256_text(p_set_canonical),p_flags::jsonb,'pending',NULL,v_now,v_now+interval '90 days',NULL);
  EXCEPTION WHEN check_violation OR unique_violation OR foreign_key_violation OR not_null_violation OR raise_exception THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::boolean,NULL::text,NULL::text; RETURN;
  END;
  UPDATE morrow_work.run_products x SET status='drafted',draft_id=v_draft,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.product_index=v_index;
  UPDATE morrow_work.runs x SET products_drafted=x.products_drafted+1,consecutive_failed=0,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.id=r.id;
  RETURN QUERY SELECT 'recorded'::text,false,NULL::text,v_draft;
  RETURN;
 END IF;
 SELECT * INTO u FROM morrow_billing.run_product_unrecovered(r.organization_id,r.workspace_id,r.id,v_index);
 IF u.outcome IS DISTINCT FROM 'accrued' THEN RAISE EXCEPTION 'WORK_RUN_UNRECOVERED_FAILED'; END IF;
 UPDATE morrow_work.run_products x SET status='failed',failure_code=p_failure_code,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.product_index=v_index;
 v_consecutive:=r.consecutive_failed+1;
 UPDATE morrow_work.runs x SET products_failed=x.products_failed+1,consecutive_failed=v_consecutive,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.id=r.id;
 RETURN QUERY SELECT 'recorded'::text,v_consecutive>=3,CASE WHEN v_consecutive>=3 THEN 'breaker' ELSE NULL END,NULL::text;
END $$;
-- The run's pending drafts, for its propose step only: ids, the product, the snapshot digest,
-- the fields, the change set and the flags (store content, used in memory by the producer).
CREATE FUNCTION morrow_work.run_drafts_pending()
RETURNS TABLE(draft_id text,product_index text,product_id text,snapshot_digest text,fields text,set_canonical text,flags text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record; r record;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' THEN RETURN; END IF;
 SELECT x.id::text AS id,x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.status INTO r FROM morrow_work.runs x
  WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=l.subject_id AND x.lease_id=l.lease_id;
 IF NOT FOUND OR r.status<>'running' THEN RETURN; END IF;
 RETURN QUERY SELECT d.id::text,d.product_index::text,d.product_id,d.snapshot_digest::text,to_jsonb(d.fields)::text,d.set_canonical,d.flags::text
  FROM morrow_work.run_drafts d WHERE d.organization_id=r.organization_id AND d.workspace_id=r.workspace_id AND d.run_id=r.id AND d.status='pending'
  ORDER BY d.product_index;
END $$;
-- The workspace's current review policy for the propose step (its revision, canonical text
-- and digest, or nulls when none exists and the submit seeds revision 1) and the database
-- time the proposals are created at.
CREATE FUNCTION morrow_work.run_review_context()
RETURNS TABLE(policy_revision text,policy_canonical text,policy_digest text,database_now text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record; pol record;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' THEN RETURN; END IF;
 SELECT x.revision::text AS revision,x.canonical,x.digest::text AS digest INTO pol FROM morrow_work.review_policies x
  WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id='review-policy' ORDER BY x.revision DESC LIMIT 1;
 RETURN QUERY SELECT pol.revision,pol.canonical,pol.digest,morrow_work.utc_text(morrow_work.db_now());
END $$;
-- The agent submit (ADR-0022 item 3; spine §7 and §2 step 9): one catalog.content.publish
-- Proposal@2 of the entered lease's run, proposed by its Listings installation's agent
-- principal on behalf of the run's requester (the task initiator), never through the human
-- submit path. After the Worker reran decideDelegation with propose on
-- catalog.content.publish and built the proposal from the pending drafts it names, this
-- rechecks everything data-only: the run is running; the proposal is catalog.content.publish
-- on the run's task T, store and connection; its targets are exactly the named drafts in
-- order (each its product, the draft's snapshot digest as expectedSourceRevision and the
-- draft's fields), and its parameters are exactly the drafts' CatalogContentChangeSet@1
-- items; contextTaint untrusted_external; the workspace's current review policy (revision 1
-- seeded from the defaults when none exists) and its 1,000 pending approvals cap; the
-- document check of 0032 and its catalog_proposal_bind trigger. Writes the parameters, the
-- proposal, its pending approval, the drafts packed, and one proposal.submitted event whose
-- actor is the run's requester. Outcomes: applied, invalid, denied, stale_authority,
-- limit_reached, not_found.
CREATE FUNCTION morrow_work.submit_agent_proposal(p_approval_id text,p_policy_canonical text,p_policy_digest text,p_parameters_canonical text,
 p_parameters_digest text,p_proposal_canonical text,p_proposal_digest text,p_scope_canonical text,p_draft_ids text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 l record; r record; cap record; pol record; f record; d jsonb; v_params jsonb; v_policy jsonb; v_created timestamptz; v_expires timestamptz;
 v_now timestamptz; v_id text; v_parameters_id text; v_risk text; v_rule jsonb; v_approval_expires timestamptz; v_list text[]; v_result jsonb;
 v_ids text[]; v_targets jsonb:='[]'::jsonb; v_items jsonb:='[]'::jsonb; v_index integer:=0; v_draft text; dr record; v_org_revision bigint;
 n integer;
BEGIN
 IF p_approval_id IS NULL OR p_approval_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_policy_digest IS NULL OR p_policy_digest !~ '^[a-f0-9]{64}$'
  OR (p_policy_canonical IS NOT NULL AND (octet_length(p_policy_canonical)>16384 OR NOT pg_input_is_valid(p_policy_canonical,'jsonb')))
  OR p_parameters_canonical IS NULL OR octet_length(p_parameters_canonical) NOT BETWEEN 2 AND 32768 OR NOT pg_input_is_valid(p_parameters_canonical,'jsonb')
  OR p_parameters_digest IS NULL OR p_parameters_digest !~ '^[a-f0-9]{64}$'
  OR p_proposal_canonical IS NULL OR octet_length(p_proposal_canonical)>131072 OR NOT pg_input_is_valid(p_proposal_canonical,'jsonb')
  OR p_proposal_digest IS NULL OR p_proposal_digest !~ '^[a-f0-9]{64}$'
  OR p_scope_canonical IS NULL OR octet_length(p_scope_canonical)>16384 OR NOT pg_input_is_valid(p_scope_canonical,'jsonb')
  OR p_draft_ids IS NULL OR octet_length(p_draft_ids)>2048 OR NOT pg_input_is_valid(p_draft_ids,'jsonb') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF morrow_work.sha256_text(p_parameters_canonical)<>p_parameters_digest OR morrow_work.sha256_text(p_proposal_canonical)<>p_proposal_digest
  OR (p_policy_canonical IS NOT NULL AND morrow_work.sha256_text(p_policy_canonical)<>p_policy_digest) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 d:=p_proposal_canonical::jsonb; v_params:=p_parameters_canonical::jsonb;
 IF jsonb_typeof(d)<>'object' OR jsonb_typeof(v_params)<>'object' OR jsonb_typeof(p_draft_ids::jsonb)<>'array'
  OR jsonb_array_length(p_draft_ids::jsonb) NOT BETWEEN 1 AND 25
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_draft_ids::jsonb) x WHERE jsonb_typeof(x)<>'string'
   OR (x#>>'{}') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
  OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(p_draft_ids::jsonb) x)<>jsonb_array_length(p_draft_ids::jsonb)
  OR NOT morrow_work.json_id(d->'id') OR NOT morrow_work.json_id(d#>'{parametersRef,id}')
  OR jsonb_typeof(d->'createdAt')<>'string' OR jsonb_typeof(d->'expiresAt')<>'string' OR jsonb_typeof(d->'partialApproval')<>'string' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_ids:=ARRAY(SELECT x FROM jsonb_array_elements_text(p_draft_ids::jsonb) WITH ORDINALITY q(x,o) ORDER BY o);
 v_created:=morrow_work.utc_parse(d->>'createdAt'); v_expires:=morrow_work.utc_parse(d->>'expiresAt');
 IF v_created IS NULL OR v_expires IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 v_id:=d->>'id'; v_parameters_id:=d#>>'{parametersRef,id}';
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 PERFORM 1 FROM morrow_work.workspace_streams w WHERE w.organization_id=l.organization_id AND w.workspace_id=l.workspace_id FOR UPDATE;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run',l.organization_id,l.workspace_id,l.subject_id)::text,0));
 SELECT x.* INTO r FROM morrow_work.runs x WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=l.subject_id
  AND x.lease_id=l.lease_id;
 IF NOT FOUND OR r.status<>'running' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 -- The drafts it packs: pending drafts of this run, in the named order; the targets and the
 -- change set items they determine.
 FOREACH v_draft IN ARRAY v_ids LOOP
  SELECT x.product_id,x.snapshot_digest::text AS snapshot_digest,x.fields,x.set_canonical,x.status INTO dr FROM morrow_work.run_drafts x
   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.id=v_draft FOR UPDATE;
  IF NOT FOUND OR dr.status<>'pending' THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
  v_targets:=v_targets||jsonb_build_array(jsonb_build_object('resource',jsonb_build_object('organizationId',r.organization_id,'workspaceId',r.workspace_id,
   'storeId',r.store_id,'connectionId',r.connection_id,'kind','product','id',dr.product_id),'expectedSourceRevision',dr.snapshot_digest,
   'fields',to_jsonb(dr.fields),'maximumCredits','0','maximumCost',NULL));
  v_items:=v_items||jsonb_build_array(jsonb_build_object('targetIndex',v_index,'productId',dr.product_id,'set',dr.set_canonical::jsonb));
  v_index:=v_index+1;
 END LOOP;
 IF d->'targets' IS DISTINCT FROM v_targets OR v_params IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'storeId',r.store_id,'items',v_items)
  OR d->>'capabilityId' IS DISTINCT FROM 'catalog.content.publish' OR d->'taskId' IS DISTINCT FROM to_jsonb(r.task_id)
  OR d->'storeId' IS DISTINCT FROM to_jsonb(r.store_id) OR d->'derivedFrom' IS DISTINCT FROM 'null'::jsonb
  OR d->'beneficiaryPrincipalIds' IS DISTINCT FROM '[]'::jsonb OR d->'partialApproval' IS DISTINCT FROM '"allowed"'::jsonb THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT x.effect,x.irreversible,x.review_required,x.kill_switch INTO cap FROM morrow_work.review_capabilities x WHERE x.capability_id='catalog.content.publish';
 IF NOT FOUND OR NOT cap.review_required OR cap.kill_switch THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT x.risk INTO v_risk FROM morrow_work.review_risk_by_effect x WHERE x.effect=cap.effect;
 -- The organization's policy revision, through the kernel's identity facts of the requester.
 SELECT q.policy_revision,q.membership_active,q.principal_active INTO f FROM morrow_identity.work_delegation_actor_facts(r.organization_id,r.workspace_id,
  jsonb_build_array(jsonb_build_object('principalId',r.requester_principal_id,'membershipId',r.requester_membership_id,
   'capabilityIds','["catalog.content.publish"]'::jsonb,'resourceId',NULL))) q;
 IF NOT FOUND OR NOT f.membership_active OR NOT f.principal_active THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 v_org_revision:=f.policy_revision;
 v_now:=morrow_work.db_now();
 IF v_created<date_trunc('milliseconds',transaction_timestamp()) OR v_created>v_now THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT x.revision::bigint AS revision,x.digest::text AS digest,x.rules INTO pol FROM morrow_work.review_policies x
  WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.id='review-policy' ORDER BY x.revision DESC LIMIT 1;
 IF NOT FOUND THEN
  IF p_policy_canonical IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
  v_policy:=p_policy_canonical::jsonb;
  IF jsonb_typeof(v_policy)<>'object' OR v_policy->'revision' IS DISTINCT FROM '1'::jsonb
   OR v_policy->'rules' IS DISTINCT FROM (SELECT x.rules FROM morrow_work.review_policy_defaults x WHERE x.version='review-policy-defaults@1')
   OR v_policy->'createdAt' IS DISTINCT FROM to_jsonb(morrow_work.utc_text(v_created)) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
  BEGIN
   INSERT INTO morrow_work.review_policies(organization_id,workspace_id,id,revision,rules,canonical,digest,created_at)
   VALUES (r.organization_id,r.workspace_id,'review-policy',1,v_policy->'rules',p_policy_canonical,p_policy_digest,v_created);
  EXCEPTION WHEN check_violation OR raise_exception OR unique_violation OR foreign_key_violation OR not_null_violation THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END;
  SELECT x.revision::bigint AS revision,x.digest::text AS digest,x.rules INTO pol FROM morrow_work.review_policies x
   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.id='review-policy' AND x.revision=1;
 ELSIF p_policy_canonical IS NOT NULL OR pol.digest<>p_policy_digest THEN
  RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN;
 END IF;
 IF (SELECT count(*) FROM morrow_work.approvals x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
   AND x.status='pending' AND x.expires_at>v_now AND x.review_policy_revision=pol.revision)>=1000 THEN
  RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
 END IF;
 v_rule:=morrow_work.effective_rule(pol.rules,v_risk,cap.irreversible);
 IF v_expires<>v_created+make_interval(secs=>(v_rule->>'pendingExpirySeconds')::integer+(pol.rules#>>'{soloOwner,coolDownSeconds}')::integer
   +(v_rule->>'approvedValiditySeconds')::integer)
  OR NOT morrow_work.catalog_proposal_document_matches(p_proposal_canonical,p_scope_canonical,r.organization_id,r.workspace_id,v_id,1,NULL,NULL,NULL,
   r.task_id,'catalog.content.publish',v_risk,cap.irreversible,'allowed',jsonb_array_length(v_targets),0,r.agent_principal_id,r.installation_id,
   r.requester_principal_id,r.requester_membership_id,ARRAY[]::text[],'review-policy',pol.revision,pol.digest,v_parameters_id,p_parameters_digest,
   v_expires,v_created,r.store_id,r.connection_id) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_approval_expires:=least(v_expires,v_created+make_interval(secs=>(v_rule->>'pendingExpirySeconds')::integer));
 IF v_rule->'eligibleReviewerPrincipalIds'<>'null'::jsonb THEN
  v_list:=ARRAY(SELECT e FROM jsonb_array_elements_text(v_rule->'eligibleReviewerPrincipalIds') WITH ORDINALITY q(e,o) ORDER BY o);
 END IF;
 BEGIN
  INSERT INTO morrow_work.proposal_parameters(organization_id,workspace_id,id,canonical,digest,created_at)
  VALUES (r.organization_id,r.workspace_id,v_parameters_id,p_parameters_canonical,p_parameters_digest,v_created);
  INSERT INTO morrow_work.proposals(organization_id,workspace_id,id,revision,family_root_id,derived_from_id,derived_from_digest,selected_target_indexes,
   task_id,capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,proposer_principal_id,proposer_membership_id,
   requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,review_policy_digest,
   parameters_id,parameters_digest,canonical,digest,scope_canonical,scope_digest,expires_at,created_at,store_id,connection_id,proposer_kind,
   proposer_installation_id)
  VALUES (r.organization_id,r.workspace_id,v_id,1,v_id,NULL,NULL,NULL,r.task_id,'catalog.content.publish',v_risk,cap.irreversible,'allowed',
   jsonb_array_length(v_targets),0,r.agent_principal_id,NULL,r.requester_principal_id,r.requester_membership_id,ARRAY[]::text[],'review-policy',
   pol.revision,pol.digest,v_parameters_id,p_parameters_digest,p_proposal_canonical,p_proposal_digest,p_scope_canonical,
   morrow_work.sha256_text(p_scope_canonical),v_expires,v_created,r.store_id,r.connection_id,'agent',r.installation_id);
  INSERT INTO morrow_work.approvals(organization_id,workspace_id,id,revision,proposal_id,proposal_digest,family_root_id,status,required_approvals,
   self_approval,pending_expiry_seconds,approved_validity_seconds,cool_down_seconds,quiet_period_seconds,eligible_reviewer_principal_ids,
   counted_reviewer_principal_ids,scope_digest,review_policy_revision,policy_revision,effective_at,expires_at,invalidation_reason,created_at,updated_at)
  VALUES (r.organization_id,r.workspace_id,p_approval_id,1,v_id,p_proposal_digest,v_id,'pending',(v_rule->>'requiredApprovals')::integer,
   v_rule->>'selfApproval',(v_rule->>'pendingExpirySeconds')::integer,(v_rule->>'approvedValiditySeconds')::integer,
   (pol.rules#>>'{soloOwner,coolDownSeconds}')::integer,(pol.rules#>>'{soloOwner,quietPeriodSeconds}')::integer,v_list,NULL,
   morrow_work.sha256_text(p_scope_canonical),pol.revision,v_org_revision,NULL,v_approval_expires,NULL,v_created,v_created);
  UPDATE morrow_work.run_drafts x SET status='packed',proposal_id=v_id,packed_at=greatest(v_now,x.created_at)
   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.id=ANY(v_ids) AND x.status='pending';
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>cardinality(v_ids) THEN RAISE EXCEPTION 'WORK_RUN_DRAFT_INVALID'; END IF;
 EXCEPTION WHEN check_violation OR raise_exception OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 PERFORM morrow_work.append_event(r.organization_id,r.workspace_id,r.requester_principal_id,r.requester_membership_id,'proposal.submitted','proposal',
  v_id,1,r.task_id,jsonb_build_object('approvalId',p_approval_id,'risk',v_risk,'targetCount',jsonb_array_length(v_targets)),'run:'||r.id,v_now);
 v_result:=jsonb_build_object('proposalId',v_id,'proposalDigest',p_proposal_digest,'approvalId',p_approval_id,'status','pending',
  'expiresAt',morrow_work.utc_text(v_approval_expires),'targetCount',jsonb_array_length(v_targets));
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;
-- Ends the entered lease's run (mvp-architecture §2 step 15): with no reason, after every
-- product ended and every draft was proposed, it succeeds when at least one product was
-- proposed (otherwise it fails as nothing_drafted); with a reason it fails. An open call
-- still within its broker budget refuses (call_open: the step retries); one past it is booked
-- as uncertain first. Then run_end (settle, status, revocations, event) and the lease is
-- released. A run already ended returns its status. Outcomes: ended (status and credits
-- settled), call_open, drafts_pending, products_pending, denied, invalid.
CREATE FUNCTION morrow_work.run_finish(p_reason text)
RETURNS TABLE(outcome text,status text,credits_settled text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record; r record; c record; e record; v_status text; v_reason text;
BEGIN
 IF p_reason IS NOT NULL AND p_reason NOT IN ('breaker','unrecovered_cost_cap','spend_limit','provider_error','cost_overflow','reservation_exhausted',
   'time_budget','delegation_denied','entitlement','broker_held','read_unavailable','proposal_refused') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM 1 FROM morrow_work.workspace_streams w WHERE w.organization_id=l.organization_id AND w.workspace_id=l.workspace_id FOR UPDATE;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run',l.organization_id,l.workspace_id,l.subject_id)::text,0));
 SELECT x.* INTO r FROM morrow_work.runs x WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=l.subject_id
  AND x.lease_id=l.lease_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 IF r.status NOT IN ('queued','running') THEN RETURN QUERY SELECT 'ended'::text,r.status,NULL::text; RETURN; END IF;
 IF r.status='queued' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN; END IF;
 FOR c IN SELECT x.id::text AS id,x.started_at,x.budget_ms FROM morrow_work.run_model_calls x WHERE x.organization_id=r.organization_id
   AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.status='started' LOOP
  IF c.started_at+make_interval(secs=>c.budget_ms/1000.0+60)>pg_catalog.clock_timestamp() THEN
   RETURN QUERY SELECT 'call_open'::text,NULL::text,NULL::text; RETURN;
  END IF;
  PERFORM morrow_work.run_fence_close_uncertain(r.organization_id,r.workspace_id,c.id);
 END LOOP;
 IF p_reason IS NULL THEN
  IF EXISTS(SELECT 1 FROM morrow_work.run_products x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id
    AND x.status IN ('pending','in_progress')) THEN RETURN QUERY SELECT 'products_pending'::text,NULL::text,NULL::text; RETURN; END IF;
  IF EXISTS(SELECT 1 FROM morrow_work.run_drafts x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id
    AND x.status='pending') THEN RETURN QUERY SELECT 'drafts_pending'::text,NULL::text,NULL::text; RETURN; END IF;
  IF EXISTS(SELECT 1 FROM morrow_work.run_drafts x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id
    AND x.status='packed') THEN v_status:='succeeded'; v_reason:=NULL;
  ELSE v_status:='failed'; v_reason:='nothing_drafted';
  END IF;
 ELSE v_status:='failed'; v_reason:=p_reason;
 END IF;
 SELECT * INTO e FROM morrow_work.run_end(r.organization_id,r.workspace_id,r.id,v_status,'runtime',
  CASE WHEN v_status='succeeded' THEN 'completion_evidence' ELSE 'failure_evidence' END,v_reason);
 IF e.outcome IS DISTINCT FROM 'ended' THEN RAISE EXCEPTION 'WORK_RUN_END_FAILED'; END IF;
 PERFORM morrow_work.lease_release();
 RETURN QUERY SELECT 'ended'::text,v_status,e.credits_settled;
END $$;

-- ---------------------------------------------------------------------------
-- The broker's model definers: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_vault_broker only (spine §4 and §9; ADR-0022 item 10). Neither takes a run id: the
-- run is the subject of the lease (begin) or of the call (end).
-- Opens one model call's fence, before any provider request. The lease is the broker's
-- caller's: resolve_call's checks hold (lease, generation, member, purpose `model`, stops,
-- installation, connection) and are repeated after the stop interlock is taken shared, as
-- lease_open does, so a stop either committed before (refused here) or waits for this
-- transaction and then revokes the lease (no later call opens). Then, under the run's lock:
-- the run is running on this lease; the product is in progress with its snapshot bound; the
-- attempt is 1, or 2 after a counted attempt 1, and is not already counted; one call of a
-- run is open at a time (a call past its budget plus a minute is booked as uncertain at its
-- worst case first); the run's remaining vendor reservation holds this attempt's worst case;
-- the prompt and schema digests are the run's (bound by its first call). The same fence
-- again (a replayed step, a lost reply) never sends: a closed fence returns its recorded
-- outcome (`replay`), an open one in its budget is `in_flight`, an expired one is booked as
-- uncertain and replayed. Returns the selection and catalogue version from the run, the
-- provider model id from the catalogue, the product id, the snapshot and request digests the
-- call must match and the run's fields. Outcomes: begun, replay, in_flight, call_open,
-- reservation_exhausted, prompt_mismatch, product_state, attempt_invalid, run_inactive,
-- denied, invalid, and every resolve_call refusal.
CREATE FUNCTION morrow_vault.model_call_begin(p_lease_id text,p_generation text,p_product_index text,p_attempt text,p_sequence text,
 p_budget_ms text,p_prompt_digest text,p_schema_digest text)
RETURNS TABLE(outcome text,call_id text,catalogue_version text,model_key text,effort_key text,provider_model_id text,max_input_tokens text,
 product_id text,snapshot_digest text,request_digest text,fields text,recorded_outcome text,input_tokens text,output_tokens text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE
 lz record; rc record; r record; q record; m record; e record; vr record; rt record; c record; v_now timestamptz; v_call text; v_outcome text;
 v_index integer; v_attempt integer; v_sequence integer; v_budget integer; v_request text; v_attempts integer; v_found boolean;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 IF p_lease_id IS NULL OR p_lease_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_generation IS NULL OR p_generation !~ '^[1-9][0-9]{0,15}$'
  OR p_product_index IS NULL OR p_product_index !~ '^(0|[1-9][0-9]?)$' OR p_attempt IS NULL OR p_attempt !~ '^[12]$'
  OR p_sequence IS NULL OR p_sequence !~ '^[1-8]$' OR p_budget_ms IS NULL OR p_budget_ms !~ '^[1-9][0-9]{3,5}$'
  OR p_prompt_digest IS NULL OR p_prompt_digest !~ '^[a-f0-9]{64}$' OR p_schema_digest IS NULL OR p_schema_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 v_index:=p_product_index::integer; v_attempt:=p_attempt::integer; v_sequence:=p_sequence::integer; v_budget:=p_budget_ms::integer;
 IF v_index>24 OR v_budget NOT BETWEEN 1000 AND 600000 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 -- The lease's tenant, store and subject (resolve_call's own lease policy, keyed by its setting).
 PERFORM pg_catalog.set_config('morrow.vault_resolve_lease',p_lease_id,true);
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.subject_id::text AS subject_id,x.store_id::text AS store_id,
  x.kind INTO lz FROM morrow_work.work_leases x WHERE x.id=p_lease_id;
 -- FOUND is captured before the PERFORM below resets it.
 v_found:=FOUND;
 PERFORM pg_catalog.set_config('morrow.vault_resolve_lease','',true);
 IF NOT v_found OR lz.kind<>'run' THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 -- The stop interlock, shared (lease_open's order), then resolve_call as a new statement.
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
  lz.organization_id,lz.workspace_id,lz.store_id)::text,0));
 SELECT * INTO rc FROM morrow_vault.resolve_call(p_lease_id,p_generation,'model',lz.subject_id);
 IF rc.outcome IS DISTINCT FROM 'resolved' THEN
  RETURN QUERY SELECT COALESCE(rc.outcome,'denied'),NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run',rc.organization_id,rc.workspace_id,
  rc.subject_id)::text,0));
 PERFORM pg_catalog.set_config('morrow.vault_model_run',rc.organization_id||'|'||rc.workspace_id||'|'||rc.subject_id,true),
  pg_catalog.set_config('morrow.vault_model_tenant',rc.organization_id||'|'||rc.workspace_id,true);
 SELECT x.* INTO r FROM morrow_work.runs x WHERE x.organization_id=rc.organization_id AND x.workspace_id=rc.workspace_id AND x.id=rc.subject_id;
 IF NOT FOUND OR r.lease_id::text<>p_lease_id OR r.lease_generation::text<>p_generation OR r.status<>'running' THEN
  v_outcome:='run_inactive';
 ELSE
  SELECT x.* INTO q FROM morrow_work.run_products x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id
   AND x.product_index=v_index;
  IF NOT FOUND OR q.status<>'in_progress' OR q.snapshot_digest IS NULL THEN v_outcome:='product_state'; END IF;
 END IF;
 IF v_outcome IS NULL THEN
  v_now:=date_trunc('milliseconds',clock_timestamp());
  -- The same fence again: never a second send.
  SELECT x.id::text AS id,x.status,x.outcome,x.started_at,x.budget_ms,x.input_tokens,x.output_tokens INTO c FROM morrow_work.run_model_calls x
   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.product_index=v_index AND x.attempt=v_attempt
    AND x.sequence=v_sequence;
  IF FOUND THEN
   IF c.status='started' AND c.started_at+make_interval(secs=>c.budget_ms/1000.0+60)>clock_timestamp() THEN
    v_outcome:='in_flight';
   ELSE
    IF c.status='started' THEN PERFORM morrow_work.run_fence_close_uncertain(r.organization_id,r.workspace_id,c.id); END IF;
    SELECT x.id::text AS id,x.outcome,x.input_tokens,x.output_tokens INTO c FROM morrow_work.run_model_calls x
     WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.id=c.id;
    PERFORM pg_catalog.set_config('morrow.vault_model_run','',true),pg_catalog.set_config('morrow.vault_model_tenant','',true);
    RETURN QUERY SELECT 'replay'::text,c.id,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
     c.outcome,c.input_tokens::text,c.output_tokens::text;
    RETURN;
   END IF;
  END IF;
 END IF;
 IF v_outcome IS NULL THEN
  -- One open call per run; an expired one is booked as uncertain before this opens.
  FOR c IN SELECT x.id::text AS id,x.started_at,x.budget_ms FROM morrow_work.run_model_calls x WHERE x.organization_id=r.organization_id
    AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.status='started' LOOP
   IF c.started_at+make_interval(secs=>c.budget_ms/1000.0+60)>clock_timestamp() THEN v_outcome:='call_open';
   ELSE PERFORM morrow_work.run_fence_close_uncertain(r.organization_id,r.workspace_id,c.id);
   END IF;
  END LOOP;
 END IF;
 IF v_outcome IS NULL THEN
  -- The attempt: 1, or 2 after a counted 1; never one already counted.
  SELECT x.attempts INTO v_attempts FROM morrow_work.run_products x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
   AND x.run_id=r.id AND x.product_index=v_index;
  IF v_attempt<>v_attempts+1 OR EXISTS(SELECT 1 FROM morrow_work.run_model_calls x WHERE x.organization_id=r.organization_id
    AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.product_index=v_index AND x.attempt=v_attempt AND x.counted) THEN
   v_outcome:='attempt_invalid';
  END IF;
 END IF;
 IF v_outcome IS NULL THEN
  SELECT x.worst_case_per_attempt_usd INTO e FROM morrow_work.model_catalogue_entries x WHERE x.version=r.catalogue_version AND x.model_key=r.model_key
   AND x.effort_key=r.effort_key;
  SELECT x.maximum_cost_usd,x.booked_cost_usd,x.status INTO vr FROM morrow_billing.vendor_cost_reservations x WHERE x.organization_id=r.organization_id
   AND x.workspace_id=r.workspace_id AND x.root_run_id=r.id;
  IF NOT FOUND OR vr.status<>'reserved' OR vr.maximum_cost_usd-vr.booked_cost_usd<e.worst_case_per_attempt_usd THEN v_outcome:='reservation_exhausted'; END IF;
 END IF;
 IF v_outcome IS NULL THEN
  SELECT x.prompt_digest::text AS prompt_digest,x.schema_digest::text AS schema_digest INTO m FROM morrow_work.run_manifests x
   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id;
  IF m.prompt_digest IS NULL THEN
   UPDATE morrow_work.run_manifests x SET prompt_digest=p_prompt_digest,schema_digest=p_schema_digest,revision=x.revision+1,
    updated_at=greatest(v_now,x.updated_at) WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id;
  ELSIF m.prompt_digest<>p_prompt_digest OR m.schema_digest<>p_schema_digest THEN v_outcome:='prompt_mismatch';
  END IF;
 END IF;
 IF v_outcome IS NOT NULL THEN
  PERFORM pg_catalog.set_config('morrow.vault_model_run','',true),pg_catalog.set_config('morrow.vault_model_tenant','',true);
  RETURN QUERY SELECT v_outcome,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 SELECT x.provider_model_id,x.max_input_tokens INTO rt FROM morrow_work.model_catalogue_rates x WHERE x.version=r.catalogue_version AND x.model_key=r.model_key;
 PERFORM pg_catalog.set_config('morrow.vault_model_task',r.organization_id||'|'||r.workspace_id||'|'||r.task_id,true);
 SELECT morrow_work.sha256_text(x.objective) INTO v_request FROM morrow_work.tasks x WHERE x.organization_id=r.organization_id
  AND x.workspace_id=r.workspace_id AND x.id=r.task_id;
 v_call:=gen_random_uuid()::text;
 INSERT INTO morrow_work.run_model_calls(organization_id,workspace_id,id,run_id,product_index,attempt,sequence,status,outcome,counted,raw_stop_reason,
  provider_request_id,provider_model_id,counted_input_tokens,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd,overflow_usd,
  booking_id,budget_ms,started_at,closed_at)
 VALUES (r.organization_id,r.workspace_id,v_call,r.id,v_index,v_attempt,v_sequence,'started',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
  NULL,v_budget,v_now,NULL);
 PERFORM pg_catalog.set_config('morrow.vault_model_run','',true),pg_catalog.set_config('morrow.vault_model_tenant','',true),
  pg_catalog.set_config('morrow.vault_model_task','',true);
 RETURN QUERY SELECT 'begun'::text,v_call,r.catalogue_version::text,r.model_key,r.effort_key,rt.provider_model_id,rt.max_input_tokens::text,
  q.product_id,q.snapshot_digest::text,v_request,to_jsonb(r.fields)::text,NULL::text,NULL::text,NULL::text;
END $$;
-- Closes one model call by its fence (spine §9, ADR-0022 item 10's outcome table): it needs no
-- live lease, so a call in flight when a stop or the lease's end lands is still recorded and
-- booked, never lost. The outcome decides whether the attempt counted: completed, incomplete,
-- refusal, invalid_output, uncertain and a provider_error with usage count; not_sent,
-- spend_limit, input_over_cap and a provider_error without usage do not. A counted attempt's
-- cost is computed here from the run's catalogue version's rates (input, output, and any
-- cache tokens at twice the input rate, an upper bound), or its worst case when uncertain,
-- and booked under `<run>:<index>:<attempt>`; cost the reservation cannot hold is booked as
-- overflow (never dropped) and the run must stop. A usage outcome whose provider model is
-- not the run's is recorded as provider_error. The product's attempts and the manifest's
-- totals grow. Outcomes: closed (with the recorded outcome, the booked amount and whether it
-- overflowed), already_closed (with the recorded outcome), not_found, denied, invalid.
CREATE FUNCTION morrow_vault.model_call_end(p_call_id text,p_outcome text,p_raw_stop_reason text,p_provider_request_id text,p_provider_model_id text,
 p_counted_input_tokens text,p_input_tokens text,p_output_tokens text,p_cache_creation_tokens text,p_cache_read_tokens text)
RETURNS TABLE(outcome text,recorded_outcome text,booked_usd text,overflow boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE
 c record; r record; e record; rt record; b record; vr record; v_now timestamptz; v_outcome text; v_counted boolean; v_usage boolean; v_cost numeric(20,8);
 v_units bigint; v_entry text; v_overflow numeric(20,8); v_booked numeric(20,8); v_remaining numeric(20,8); n integer; v_found boolean;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::boolean; RETURN;
 END IF;
 IF p_call_id IS NULL OR p_call_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_outcome IS NULL OR p_outcome NOT IN ('completed','incomplete','refusal','invalid_output','spend_limit','provider_error','uncertain','not_sent','input_over_cap')
  OR (p_raw_stop_reason IS NOT NULL AND p_raw_stop_reason !~ '^[a-z_]{1,32}$')
  OR (p_provider_request_id IS NOT NULL AND p_provider_request_id !~ '^[A-Za-z0-9_-]{1,128}$')
  OR (p_provider_model_id IS NOT NULL AND p_provider_model_id !~ '^[A-Za-z0-9._-]{1,128}$')
  OR (p_counted_input_tokens IS NOT NULL AND p_counted_input_tokens !~ '^(0|[1-9][0-9]{0,6})$')
  OR ((p_input_tokens IS NULL)<>(p_output_tokens IS NULL)) OR ((p_input_tokens IS NULL)<>(p_cache_creation_tokens IS NULL))
  OR ((p_input_tokens IS NULL)<>(p_cache_read_tokens IS NULL))
  OR (p_input_tokens IS NOT NULL AND (p_input_tokens !~ '^(0|[1-9][0-9]{0,6})$' OR p_output_tokens !~ '^(0|[1-9][0-9]{0,6})$'
   OR p_cache_creation_tokens !~ '^(0|[1-9][0-9]{0,6})$' OR p_cache_read_tokens !~ '^(0|[1-9][0-9]{0,6})$'))
  OR (p_outcome IN ('completed','incomplete','refusal','invalid_output') AND p_input_tokens IS NULL)
  OR (p_outcome IN ('spend_limit','not_sent','input_over_cap','uncertain') AND p_input_tokens IS NOT NULL) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::boolean; RETURN;
 END IF;
 PERFORM pg_catalog.set_config('morrow.vault_model_call',p_call_id,true);
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.run_id::text AS run_id,x.product_index,x.attempt,x.status,
  x.outcome INTO c FROM morrow_work.run_model_calls x WHERE x.id=p_call_id;
 -- FOUND is captured before the PERFORM below resets it: an unknown call is not_found.
 v_found:=FOUND;
 PERFORM pg_catalog.set_config('morrow.vault_model_call','',true);
 IF NOT v_found THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::boolean; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run',c.organization_id,c.workspace_id,
  c.run_id)::text,0));
 PERFORM pg_catalog.set_config('morrow.vault_model_run',c.organization_id||'|'||c.workspace_id||'|'||c.run_id,true),
  pg_catalog.set_config('morrow.vault_model_tenant',c.organization_id||'|'||c.workspace_id,true);
 SELECT x.status,x.outcome INTO c.status,c.outcome FROM morrow_work.run_model_calls x WHERE x.organization_id=c.organization_id
  AND x.workspace_id=c.workspace_id AND x.id=p_call_id;
 IF c.status<>'started' THEN
  PERFORM pg_catalog.set_config('morrow.vault_model_run','',true),pg_catalog.set_config('morrow.vault_model_tenant','',true);
  RETURN QUERY SELECT 'already_closed'::text,c.outcome,NULL::text,NULL::boolean; RETURN;
 END IF;
 SELECT x.catalogue_version,x.model_key,x.effort_key INTO r FROM morrow_work.runs x WHERE x.organization_id=c.organization_id
  AND x.workspace_id=c.workspace_id AND x.id=c.run_id;
 SELECT x.worst_case_per_attempt_usd INTO e FROM morrow_work.model_catalogue_entries x WHERE x.version=r.catalogue_version AND x.model_key=r.model_key
  AND x.effort_key=r.effort_key;
 SELECT x.provider_model_id,x.input_usd8_per_token,x.output_usd8_per_token INTO rt FROM morrow_work.model_catalogue_rates x
  WHERE x.version=r.catalogue_version AND x.model_key=r.model_key;
 v_outcome:=p_outcome;
 v_usage:=p_input_tokens IS NOT NULL;
 -- A reply naming another model is a provider error (no fallback, ADR-0022 item 10).
 IF v_usage AND v_outcome<>'provider_error' AND p_provider_model_id IS DISTINCT FROM rt.provider_model_id THEN v_outcome:='provider_error'; END IF;
 v_counted:=v_outcome IN ('completed','incomplete','refusal','invalid_output','uncertain') OR (v_outcome='provider_error' AND v_usage);
 v_now:=date_trunc('milliseconds',clock_timestamp());
 v_overflow:=NULL;
 IF v_counted THEN
  IF v_outcome='uncertain' THEN v_cost:=e.worst_case_per_attempt_usd;
  ELSE
   v_units:=(p_input_tokens::bigint+2*(p_cache_creation_tokens::bigint+p_cache_read_tokens::bigint))*rt.input_usd8_per_token
    +p_output_tokens::bigint*rt.output_usd8_per_token;
   v_cost:=round(v_units::numeric/100000000,8);
  END IF;
  v_entry:=c.run_id||':'||c.product_index||':'||c.attempt;
  SELECT * INTO b FROM morrow_billing.run_book_cost(c.organization_id,c.workspace_id,c.run_id,v_entry,v_cost,
   CASE WHEN v_outcome='uncertain' THEN 'uncertain_attempt' ELSE 'attempt' END);
  IF b.outcome='reservation_exceeded' THEN
   SELECT x.maximum_cost_usd,x.booked_cost_usd INTO vr FROM morrow_billing.vendor_cost_reservations x WHERE x.organization_id=c.organization_id
    AND x.workspace_id=c.workspace_id AND x.root_run_id=c.run_id;
   v_remaining:=greatest(vr.maximum_cost_usd-vr.booked_cost_usd,0);
   v_booked:=v_remaining;
   SELECT * INTO b FROM morrow_billing.run_book_cost(c.organization_id,c.workspace_id,c.run_id,v_entry,v_remaining,
    CASE WHEN v_outcome='uncertain' THEN 'uncertain_attempt' ELSE 'attempt' END);
   IF b.outcome IS DISTINCT FROM 'booked' THEN RAISE EXCEPTION 'WORK_MODEL_CALL_UNBOOKED'; END IF;
   v_overflow:=v_cost-v_remaining;
   SELECT * INTO b FROM morrow_billing.run_book_cost(c.organization_id,c.workspace_id,c.run_id,v_entry||':x',v_overflow,'overflow');
   IF b.outcome IS DISTINCT FROM 'booked' THEN RAISE EXCEPTION 'WORK_MODEL_CALL_UNBOOKED'; END IF;
  ELSIF b.outcome='ended' THEN
   -- The run settled meanwhile (a stop closed it): the whole cost is overflow.
   v_overflow:=v_cost;
   v_entry:=v_entry||':x';
   SELECT * INTO b FROM morrow_billing.run_book_cost(c.organization_id,c.workspace_id,c.run_id,v_entry,v_cost,'overflow');
   IF v_cost>0 AND b.outcome IS DISTINCT FROM 'booked' THEN RAISE EXCEPTION 'WORK_MODEL_CALL_UNBOOKED'; END IF;
  ELSIF b.outcome IS DISTINCT FROM 'booked' THEN RAISE EXCEPTION 'WORK_MODEL_CALL_UNBOOKED';
  END IF;
 END IF;
 UPDATE morrow_work.run_model_calls x SET status='closed',outcome=v_outcome,counted=v_counted,raw_stop_reason=p_raw_stop_reason,
  provider_request_id=p_provider_request_id,provider_model_id=p_provider_model_id,counted_input_tokens=p_counted_input_tokens::integer,
  input_tokens=p_input_tokens::bigint,output_tokens=p_output_tokens::bigint,cache_creation_tokens=p_cache_creation_tokens::bigint,
  cache_read_tokens=p_cache_read_tokens::bigint,cost_usd=CASE WHEN v_counted THEN v_cost ELSE NULL END,
  overflow_usd=CASE WHEN v_overflow>0 THEN v_overflow ELSE NULL END,booking_id=CASE WHEN v_counted THEN v_entry ELSE NULL END,
  closed_at=greatest(v_now,x.started_at) WHERE x.organization_id=c.organization_id AND x.workspace_id=c.workspace_id AND x.id=p_call_id;
 IF v_counted THEN
  UPDATE morrow_work.run_products x SET attempts=least(x.attempts+1,2),revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=c.organization_id AND x.workspace_id=c.workspace_id AND x.run_id=c.run_id AND x.product_index=c.product_index
    AND x.attempts<2 AND x.status IN ('in_progress','pending');
  UPDATE morrow_work.run_manifests x SET attempts=least(x.attempts+1,50),input_tokens=x.input_tokens+COALESCE(p_input_tokens::bigint,0),
   output_tokens=x.output_tokens+COALESCE(p_output_tokens::bigint,0),
   cache_tokens=x.cache_tokens+COALESCE(p_cache_creation_tokens::bigint,0)+COALESCE(p_cache_read_tokens::bigint,0),
   booked_cost_usd=x.booked_cost_usd+v_cost,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=c.organization_id AND x.workspace_id=c.workspace_id AND x.run_id=c.run_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'WORK_RUN_MANIFEST_INVALID'; END IF;
 END IF;
 PERFORM pg_catalog.set_config('morrow.vault_model_run','',true),pg_catalog.set_config('morrow.vault_model_tenant','',true);
 RETURN QUERY SELECT 'closed'::text,v_outcome,CASE WHEN v_counted THEN to_char(v_cost,'FM999999999990.00000000') ELSE NULL END,COALESCE(v_overflow>0,false);
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p WHERE (p.pronamespace='morrow_work'::regnamespace AND p.proname IN (
  'listing_field_array','run_fields_valid','route_matches','snapshot_matches','draft_set_valid','draft_flags_valid','run_guard','run_product_guard',
  'run_manifest_guard','model_call_guard','run_draft_guard','run_fence_close_uncertain','run_end','runs_close_stale','begin_run_command',
  'cmd_run_admit','cmd_runs_reconcile','run_interrupted','run_start','run_billing_facts','run_product_begin','run_snapshot_put','run_product_finish',
  'run_drafts_pending','run_review_context','submit_agent_proposal','run_finish')) OR (p.pronamespace='morrow_vault'::regnamespace AND p.proname IN (
  'model_call_begin','model_call_end')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',r.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION morrow_work.listing_field_array(),morrow_work.run_fields_valid(text[]),
 morrow_work.route_matches(text,text,text,text,text,text,text,text,text,text[],integer),morrow_work.snapshot_matches(text,text),
 morrow_work.draft_set_valid(text,text[]),morrow_work.draft_flags_valid(jsonb),morrow_work.run_fence_close_uncertain(text,text,text),
 morrow_work.run_end(text,text,text,text,text,text,text),morrow_work.runs_close_stale(text,text,text) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_work.begin_run_command(text,text,text),
 morrow_work.cmd_run_admit(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text),
 morrow_work.cmd_runs_reconcile(text,text,text),morrow_work.run_interrupted(text) TO morrow_work_api;
GRANT EXECUTE ON FUNCTION morrow_work.run_start(),morrow_work.run_billing_facts(),morrow_work.run_product_begin(text),
 morrow_work.run_snapshot_put(text,text),morrow_work.run_product_finish(text,text,text,text,text,text),morrow_work.run_drafts_pending(),
 morrow_work.run_review_context(),morrow_work.submit_agent_proposal(text,text,text,text,text,text,text,text,text),morrow_work.run_finish(text) TO morrow_runtime_executor;
GRANT EXECUTE ON FUNCTION morrow_vault.model_call_begin(text,text,text,text,text,text,text,text),
 morrow_vault.model_call_end(text,text,text,text,text,text,text,text,text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_work,morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_work.begin_run_command(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_run_admit(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_runs_reconcile(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_interrupted(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_start() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_billing_facts() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_product_begin(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_snapshot_put(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_product_finish(text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_drafts_pending() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_review_context() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.submit_agent_proposal(text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_finish(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.model_call_begin(text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.model_call_end(text,text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work,morrow_vault FROM morrow_work_command;
COMMIT;
