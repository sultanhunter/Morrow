BEGIN;
-- PR 18 projects behind the scenes (ADR-0033 and ADR-0034; docs/briefs/projects-backend.md).
-- Executes AS morrow_work_owner, as 0046 after the v1 PRs' 0039-0045 (written after M3
-- PR-2's listings runs, 0038; the shared CHECKs it widens are asserted below exactly as the
-- head defines them, so a revision by any earlier file stops it). Forward only: no
-- published migration is edited. On the ADR-0010 tenant pattern: composite tenant keys,
-- ENABLE and FORCE RLS, definers owned by morrow_work_command, INVOKER triggers and checks
-- owned by the owner. No external effect: nothing here sends a request, reserves money,
-- admits a run or dispatches.
--   * goals: due_at (a dated project) and area_template_id (an Everyday work area or Quick
--     tasks), never both, at most one record per template; the criteria CHECK replaced by
--     the v1.1 CriteriaList (key and measure, at most 3 measured, unique keys, a stored
--     startRef always null, no measure due after its record). A dated project or an area
--     holds 1 to 3 criteria, every one measured; Quick tasks holds none measured (ADR-0033
--     items 1 and 7). enforce_status (0015) is revised so a goal's objective, date and
--     criteria change only with revision+1; a new goal_kind_guard keeps a dated record
--     dated, keeps Quick tasks open (never paused or ended) and an area from ending (its
--     template is never blocked), makes `achieved` need Finish's results record and
--     `cancelled` need every task ended (with no terminal task state yet, any task blocks
--     it, as cmd_goal_transition's own guard already does).
--   * projects: one per goal record, made and pinned only by people (ADR-0016 item 1);
--     workspace-wide pins at most 20.
--   * goal_measure_values: append-only values written by code or, for a hand check, by a
--     person through cmd_goal_check (workspace.goal.measure.record, human_only). Read tags,
--     class and clock are server-derived. A customer-tagged value is refused here: it lives
--     only in a content: customer table with its customer_redact handler, which lands with
--     Support's deletion path (ADR-0031 items 2 and 4; CLAUDE.md), so until then the
--     Customer emails goal reads Not measured. A person records at most 3 checks per goal,
--     goal key, product row and UTC day.
--   * goal_finish_results: Finish's code-computed results record, one per goal record:
--     keys and health codes only, never a measured number and never a customer-class goal.
--   * plan_draft_revisions: a card's revisions (PlanDraft@1), each keeping revision 1's
--     taint and restricted sources; written by T4's Coordinator (revision 1) and by the
--     asker's edits (later revisions). A digest need not be unique: two cards, or an edit
--     back to an earlier revision, may hold the same draft (every lookup is by message).
--   * plan_start_documents: PlanStartDocument@1, bound to the actor and the session, five
--     minutes, consumed once with its nonce; purged 24 hours after use or expiry.
--   * Definers: begin_project_command, plan_start_document (the actor's own document, read
--     by digest), cmd_goal_revise (workspace.goal.revise, human_only),
--     cmd_goal_check, cmd_plan_start_document and cmd_plan_start (one transaction that
--     consumes the document, rechecks the actor, session, nonce, grant summary and every
--     assignee under lock and creates every record as the actor's own; any refusal rolls
--     everything back). Only the Owner (ADR-0024; work_ownership_facts) gets and confirms a
--     Quick tasks document, checked again under lock. A plan change never revises Quick
--     tasks, and never drops a customer-class goal (the Worker keeps each by key). The
--     commands CHECKs are widened by goal.revise, goal.check, plan.start_document and
--     plan.start, and the outbox's by goal.revised, which every goal revision appends (so a
--     goal's aggregate revisions stay contiguous); each CHECK the union of every value at
--     this head.
-- The work API's start routes answer 503 before any of these definers while
-- docs/decisions/plan-drafts-staging.json holds them (`start_routes` held).
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regclass('morrow_work.goals') IS NULL OR to_regclass('morrow_work.tasks') IS NULL
 OR to_regclass('morrow_work.runs') IS NULL OR to_regclass('morrow_work.agent_installations') IS NULL
 OR to_regclass('morrow_work.projects') IS NOT NULL
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL
 OR to_regprocedure('morrow_work.command_prelude(text,text)') IS NULL
 OR to_regprocedure('morrow_work.target_recheck(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.stop_active(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.append_event(text,text,text,text,text,text,text,bigint,text,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.record_command(text,text,text,text,text,text,text,text,bigint,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.db_now()') IS NULL OR to_regprocedure('morrow_work.utc_text(timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.utc_parse(text)') IS NULL OR to_regprocedure('morrow_work.sha256_text(text)') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_store_installations(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_ownership_facts(text)','EXECUTE')
 -- The shared CHECKs and the trigger this file revises, exactly as the head defines them
 -- (shared protocol: a later revision is never overwritten blind).
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_command_type_check')
  IS DISTINCT FROM 'ca4b097af5cd5ddf3e97bf48b214bc56'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_check')
  IS DISTINCT FROM 'a517388dfd7a53b7eac1151d9cbccab6'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.outbox_events'::regclass AND c.conname='outbox_events_event_type_check')
  IS DISTINCT FROM 'c337a4779f7b9e92957152eb064b1962'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.outbox_events'::regclass AND c.conname='outbox_events_check3')
  IS DISTINCT FROM '68b51a30e4eaacda103a293e5d454092'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.goals'::regclass AND c.conname='goals_valid_criteria')
  IS DISTINCT FROM '7b379acd1b3d8b09974806ff58729cf1'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('morrow_work.enforce_status()'))
  IS DISTINCT FROM 'cde87b752518a5a05a8350890fae1e71'
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_work.goals'::regclass AND a.attname IN ('due_at','area_template_id'))
 THEN RAISE EXCEPTION 'PROJECTS_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pure functions: IMMUTABLE, owned by the owner; the command role holds EXECUTE because
-- CHECK constraints run with the writer's privileges (the 0015 valid_scope pattern).
-- A UtcTime text (date-time ending in Z), or NULL for anything else.
CREATE FUNCTION morrow_work.goal_time(p_text text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_text IS NULL OR p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
  OR NOT pg_input_is_valid(p_text,'timestamptz') THEN RETURN NULL; END IF;
 RETURN p_text::timestamptz;
END $$;
-- One GoalMeasure as a goal record stores it (core v1.1, ADR-0033 item 3): a closed kind, a
-- target 0..1e9, a dueAt null or no later than the record's, and startRef always null (the
-- server derives the start at read time; no request body carries it).
CREATE FUNCTION morrow_work.valid_goal_measure(m jsonb,p_due timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_keys text[]; v_due timestamptz; r jsonb; q jsonb;
BEGIN
 IF m IS NULL OR jsonb_typeof(m)<>'object' OR jsonb_typeof(m->'kind')<>'string' THEN RETURN false; END IF;
 v_keys:=CASE m->>'kind' WHEN 'metric' THEN ARRAY['kind','metricId','target','dueAt','startRef']
  WHEN 'checklist' THEN ARRAY['kind','checklistId','productIds','target','dueAt','startRef']
  WHEN 'manual' THEN ARRAY['kind','assistant','cadenceWeeks','rows','target','dueAt','startRef'] END;
 IF v_keys IS NULL OR NOT (m ?& v_keys) OR (m-v_keys)<>'{}'::jsonb THEN RETURN false; END IF;
 IF jsonb_typeof(m->'target')<>'number' OR (m->>'target')::numeric NOT BETWEEN 0 AND 1000000000
  OR m->'startRef'<>'null'::jsonb THEN RETURN false; END IF;
 IF m->'dueAt'<>'null'::jsonb THEN
  v_due:=morrow_work.goal_time(CASE WHEN jsonb_typeof(m->'dueAt')='string' THEN m->>'dueAt' END);
  IF v_due IS NULL OR (p_due IS NOT NULL AND v_due>p_due) THEN RETURN false; END IF;
 END IF;
 IF m->>'kind'='metric' THEN
  RETURN jsonb_typeof(m->'metricId')='string' AND (m->>'metricId') IN
   ('days_of_stock_cover','best_sellers_at_risk','replied_within_a_day','orders_per_week','discounted_order_share');
 ELSIF m->>'kind'='checklist' THEN
  IF m->'checklistId'<>'"product_facts_complete"'::jsonb OR jsonb_typeof(m->'productIds')<>'array'
   OR jsonb_array_length(m->'productIds')>20 THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(m->'productIds') p WHERE jsonb_typeof(p)<>'string' OR (p#>>'{}') !~ '^product:[1-9][0-9]{0,19}$')
   OR (SELECT count(DISTINCT p) FROM jsonb_array_elements(m->'productIds') p)<>jsonb_array_length(m->'productIds') THEN RETURN false; END IF;
  RETURN true;
 END IF;
 IF jsonb_typeof(m->'assistant')<>'string' OR (m->>'assistant') NOT IN ('chatgpt','gemini','copilot','perplexity')
  OR jsonb_typeof(m->'cadenceWeeks')<>'number' OR (m->>'cadenceWeeks') !~ '^([1-9]|1[0-3])$'
  OR jsonb_typeof(m->'rows')<>'array' OR jsonb_array_length(m->'rows') NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
 FOR r IN SELECT x FROM jsonb_array_elements(m->'rows') x LOOP
  IF jsonb_typeof(r)<>'object' OR NOT (r ?& ARRAY['productId','checkItems']) OR (r-ARRAY['productId','checkItems'])<>'{}'::jsonb
   OR jsonb_typeof(r->'productId')<>'string' OR (r->>'productId') !~ '^product:[1-9][0-9]{0,19}$'
   OR jsonb_typeof(r->'checkItems')<>'array' OR jsonb_array_length(r->'checkItems') NOT BETWEEN 1 AND 10 THEN RETURN false; END IF;
  FOR q IN SELECT x FROM jsonb_array_elements(r->'checkItems') x LOOP
   IF jsonb_typeof(q)<>'string' OR char_length(q#>>'{}') NOT BETWEEN 1 AND 300 THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- The v1.1 CriteriaList as a goal record stores it (ADR-0033 item 2): 1..20 exact items
-- (the work API's cap), each the v1 item plus an optional key and measure; a measured item
-- needs its key; at most 3 measured; keys unique. Every v1 list stays valid.
CREATE FUNCTION morrow_work.valid_goal_criteria(c jsonb,p_due timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE e jsonb; v_measured integer:=0; v_keys text[]:=ARRAY[]::text[];
BEGIN
 IF c IS NULL OR jsonb_typeof(c)<>'array' OR jsonb_array_length(c) NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
 FOR e IN SELECT x FROM jsonb_array_elements(c) x LOOP
  IF jsonb_typeof(e)<>'object' OR NOT (e ?& ARRAY['description','verificationCapabilityId','evidenceRequired'])
   OR (e-ARRAY['description','verificationCapabilityId','evidenceRequired','key','measure'])<>'{}'::jsonb
   OR jsonb_typeof(e->'description')<>'string' OR char_length(e->>'description') NOT BETWEEN 1 AND 2048
   OR NOT (e->'verificationCapabilityId'='null'::jsonb OR (jsonb_typeof(e->'verificationCapabilityId')='string'
    AND char_length(e->>'verificationCapabilityId') BETWEEN 1 AND 128 AND (e->>'verificationCapabilityId') ~ '^[a-z]+(\.[a-z_]+)+$'))
   OR jsonb_typeof(e->'evidenceRequired')<>'boolean' THEN RETURN false; END IF;
  IF e ? 'key' THEN
   IF jsonb_typeof(e->'key')<>'string' OR (e->>'key') !~ '^[a-z][a-z0-9_]{0,31}$' OR (e->>'key')=ANY(v_keys) THEN RETURN false; END IF;
   v_keys:=v_keys||(e->>'key');
  END IF;
  IF e ? 'measure' AND e->'measure'<>'null'::jsonb THEN
   IF NOT (e ? 'key') OR NOT morrow_work.valid_goal_measure(e->'measure',p_due) THEN RETURN false; END IF;
   v_measured:=v_measured+1;
  END IF;
 END LOOP;
 RETURN v_measured<=3;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- A project's criteria (ADR-0033 items 1 and 7; flow-contracts.md): a dated project or an
-- Everyday work area holds 1 to 3 criteria, every one measured; Quick tasks holds none
-- measured (its one hidden criterion); a record with neither (a v1 goal) is not a project.
CREATE FUNCTION morrow_work.valid_project_criteria(c jsonb,p_due timestamptz,p_area text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_measured integer;
BEGIN
 IF p_due IS NULL AND p_area IS NULL THEN RETURN true; END IF;
 IF c IS NULL OR jsonb_typeof(c)<>'array' THEN RETURN false; END IF;
 SELECT count(*)::integer INTO v_measured FROM jsonb_array_elements(c) e WHERE jsonb_typeof(e->'measure')='object';
 IF p_area='quick_tasks' THEN RETURN v_measured=0; END IF;
 RETURN v_measured BETWEEN 1 AND 3 AND v_measured=jsonb_array_length(c);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- Read tags (ADR-0031 item 6; core v1.1 ReadTags, PR 10): 0..24 unique {storeId, capability}
-- from the closed list. ReadTag@1 allows a null store for the two workspace capabilities; a
-- goal value's tags always name a store, so here storeId is always an id.
CREATE FUNCTION morrow_work.valid_read_tags(t jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN t IS NULL OR jsonb_typeof(t)<>'array' OR jsonb_array_length(t)>24 THEN false ELSE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(t) e WHERE NOT (CASE WHEN jsonb_typeof(e)<>'object' THEN false ELSE
   e ?& ARRAY['storeId','capability'] AND (e-ARRAY['storeId','capability'])='{}'::jsonb
   AND jsonb_typeof(e->'storeId')='string' AND (e->>'storeId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   AND jsonb_typeof(e->'capability')='string' AND (e->>'capability') IN ('catalog.products.read','inventory.levels.read',
    'orders.read','support.case.read','workspace.knowledge.read','workspace.artifact.read') END))
  AND (SELECT count(DISTINCT e) FROM jsonb_array_elements(t) e)=jsonb_array_length(t) END
$$;
-- Hand-check answers: 0..10 codes from the closed set.
CREATE FUNCTION morrow_work.valid_check_answers(a jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN a IS NULL OR jsonb_typeof(a)<>'array' OR jsonb_array_length(a)>10 THEN false ELSE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(a) e WHERE jsonb_typeof(e)<>'string'
   OR (e#>>'{}') NOT IN ('named_this_product','named_other_shops_only','named_no_shop')) END
$$;
REVOKE ALL ON FUNCTION morrow_work.goal_time(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.valid_goal_measure(jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.valid_goal_criteria(jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.valid_project_criteria(jsonb,timestamptz,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.valid_read_tags(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.valid_check_answers(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.goal_time(text),morrow_work.valid_goal_measure(jsonb,timestamptz),
 morrow_work.valid_goal_criteria(jsonb,timestamptz),morrow_work.valid_project_criteria(jsonb,timestamptz,text),
 morrow_work.valid_read_tags(jsonb),morrow_work.valid_check_answers(jsonb)
 TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- goals: the dated project's end date and the area template; the criteria CHECK replaced.
ALTER TABLE morrow_work.goals ADD COLUMN due_at timestamptz, ADD COLUMN area_template_id text;
ALTER TABLE morrow_work.goals
 ADD CONSTRAINT goals_due_at CHECK (due_at IS NULL OR (due_at=date_trunc('milliseconds',due_at)
  AND due_at>=timestamptz '2000-01-01T00:00:00Z' AND due_at<timestamptz '9000-01-01T00:00:00Z')),
 ADD CONSTRAINT goals_area_template CHECK (area_template_id IS NULL OR area_template_id IN
  ('product_pages','stock','customer_emails','sales_and_numbers','promotions','quick_tasks')),
 ADD CONSTRAINT goals_due_or_area CHECK (due_at IS NULL OR area_template_id IS NULL),
 DROP CONSTRAINT goals_valid_criteria,
 ADD CONSTRAINT goals_valid_criteria CHECK (morrow_work.valid_goal_criteria(success_criteria,due_at)),
 ADD CONSTRAINT goals_project_criteria CHECK (morrow_work.valid_project_criteria(success_criteria,due_at,area_template_id));
-- At most one area per template, and one Quick tasks record, per workspace (an area never
-- ends, goal_kind_guard, so its template is never blocked).
CREATE UNIQUE INDEX goals_one_area ON morrow_work.goals (organization_id,workspace_id,area_template_id)
 WHERE area_template_id IS NOT NULL;
GRANT UPDATE (objective,due_at,success_criteria) ON morrow_work.goals TO morrow_work_command;
GRANT SELECT (due_at,area_template_id) ON morrow_work.goals TO morrow_work_api;

-- ---------------------------------------------------------------------------
-- New tables.
-- One project per goal record (ADR-0016 item 1; Project@1). People make and pin it; pins
-- are workspace-wide, positions 0..19, so at most 20.
CREATE TABLE morrow_work.projects (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 goal_id morrow_work.record_id NOT NULL,
 title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
 pin_position integer CHECK (pin_position BETWEEN 0 AND 19),
 created_by_principal_id morrow_work.record_id NOT NULL,
 created_by_membership_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND updated_at>=created_at),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,goal_id),
 FOREIGN KEY (organization_id,workspace_id,goal_id) REFERENCES morrow_work.goals(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,created_by_membership_id,created_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,created_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id)
);
CREATE UNIQUE INDEX projects_pin_position ON morrow_work.projects (organization_id,workspace_id,pin_position)
 WHERE pin_position IS NOT NULL;
-- Values (GoalMeasureValue@1): append-only; a value from orders is an order aggregate on its
-- 90-day clock; work values have no clock; a customer-tagged value is never stored here.
CREATE TABLE morrow_work.goal_measure_values (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 goal_id morrow_work.record_id NOT NULL,
 key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,31}$'),
 product_id text CHECK (product_id ~ '^product:[1-9][0-9]{0,19}$'),
 value numeric NOT NULL CHECK (value BETWEEN 0 AND 1000000000),
 observed_at timestamptz NOT NULL CHECK (observed_at=date_trunc('milliseconds',observed_at) AND isfinite(observed_at)),
 recorder_kind text NOT NULL CHECK (recorder_kind IN ('code','human')),
 recorder_principal_id morrow_work.record_id,
 recorder_membership_id morrow_work.record_id,
 assistant text CHECK (assistant IN ('chatgpt','gemini','copilot','perplexity')),
 answers jsonb NOT NULL CHECK (morrow_work.valid_check_answers(answers)),
 counted boolean NOT NULL,
 read_tags jsonb NOT NULL CHECK (morrow_work.valid_read_tags(read_tags)),
 data_class text NOT NULL CHECK (data_class IN ('work','order_aggregates')),
 expires_at timestamptz,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,goal_id) REFERENCES morrow_work.goals(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,recorder_membership_id,recorder_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,recorder_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 -- ADR-0031 item 2: customer data lives only in content: customer tables.
 CONSTRAINT goal_measure_values_no_customer CHECK (NOT (read_tags @> '[{"capability":"support.case.read"}]'::jsonb)),
 CONSTRAINT goal_measure_values_clock CHECK ((data_class='work')=(expires_at IS NULL)
  AND (data_class<>'order_aggregates' OR expires_at<=date_trunc('day',observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'+interval '90 days')),
 -- A person records only a hand check: its assistant, its product row and its answers.
 CONSTRAINT goal_measure_values_recorder CHECK (CASE recorder_kind
  WHEN 'human' THEN recorder_principal_id IS NOT NULL AND recorder_membership_id IS NOT NULL AND assistant IS NOT NULL
   AND product_id IS NOT NULL AND jsonb_array_length(answers)>=1 AND data_class='work'
  ELSE recorder_principal_id IS NULL AND recorder_membership_id IS NULL AND assistant IS NULL
   AND jsonb_array_length(answers)=0 AND counted END)
);
CREATE INDEX goal_measure_values_goal ON morrow_work.goal_measure_values (organization_id,workspace_id,goal_id,key,observed_at);
-- Finish's code-computed results record (ADR-0033 item 5), one per goal record.
CREATE TABLE morrow_work.goal_finish_results (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 goal_id morrow_work.record_id NOT NULL,
 goal_revision morrow_work.revision NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('achieved','cancelled')),
 canonical text NOT NULL CHECK (octet_length(canonical)<=8192),
 digest morrow_work.digest NOT NULL,
 document_id morrow_work.record_id NOT NULL,
 actor_principal_id morrow_work.record_id NOT NULL,
 actor_membership_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 PRIMARY KEY (organization_id,workspace_id,goal_id),
 FOREIGN KEY (organization_id,workspace_id,goal_id) REFERENCES morrow_work.goals(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,actor_membership_id,actor_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT goal_finish_results_digest CHECK (digest::text=morrow_work.sha256_text(canonical))
);
-- A card's revisions (ADR-0034 item 3). Revision 1 is the Coordinator's (no editor);
-- every later one names its editor and keeps revision 1's taint and restricted sources
-- (plan_draft_guard). A start document is issued only for a digest held here, at its
-- message's latest revision. The digest covers only the draft, so it is not unique: two
-- cards with the same draft, or an edit back to an earlier revision's draft, are kept.
CREATE TABLE morrow_work.plan_draft_revisions (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 message_id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 kind text NOT NULL CHECK (kind IN ('project','task','repeating','plan_change')),
 canonical text NOT NULL CHECK (octet_length(canonical)<=32768),
 digest morrow_work.digest NOT NULL,
 asker_principal_id morrow_work.record_id NOT NULL,
 asker_membership_id morrow_work.record_id NOT NULL,
 editor_principal_id morrow_work.record_id,
 editor_membership_id morrow_work.record_id,
 context_taint text NOT NULL CHECK (context_taint IN ('none','untrusted_external')),
 restricted_sources jsonb NOT NULL CHECK (jsonb_typeof(restricted_sources)='array' AND jsonb_array_length(restricted_sources)<=100),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 PRIMARY KEY (organization_id,workspace_id,message_id,revision),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,asker_membership_id,asker_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,asker_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 FOREIGN KEY (organization_id,editor_membership_id,editor_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,editor_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT plan_draft_revisions_digest CHECK (digest::text=morrow_work.sha256_text(canonical)),
 CONSTRAINT plan_draft_revisions_editor CHECK ((revision=1)=(editor_principal_id IS NULL) AND (editor_principal_id IS NULL)=(editor_membership_id IS NULL)),
 CONSTRAINT plan_draft_revisions_document CHECK (pg_input_is_valid(canonical,'jsonb') AND (canonical::jsonb)->>'kind'=kind
  AND (canonical::jsonb)->'schemaVersion'='1'::jsonb)
);
-- PlanStartDocument@1 (ADR-0034 item 5): bound to the actor and the session, five
-- minutes, consumed once with its nonce; kept 24 hours after use or expiry (ADR-0031
-- item 1's start-document clock), then deleted by the retention sweep.
CREATE TABLE morrow_work.plan_start_documents (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 purpose text NOT NULL CHECK (purpose IN ('plan_card','area','quick_tasks','finish')),
 message_id morrow_work.record_id,
 draft_revision morrow_work.revision,
 draft_digest morrow_work.digest,
 target_kind text NOT NULL CHECK (target_kind IN ('new_project','existing_project','area','quick_tasks')),
 target_id text CHECK (target_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 target_revision morrow_work.revision,
 actor_principal_id morrow_work.record_id NOT NULL,
 actor_membership_id morrow_work.record_id NOT NULL,
 session_digest morrow_work.digest NOT NULL,
 nonce_digest morrow_work.digest NOT NULL,
 grant_summary_digest morrow_work.digest NOT NULL,
 canonical text NOT NULL CHECK (octet_length(canonical)<=65536),
 digest morrow_work.digest NOT NULL,
 command_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz CHECK (consumed_at=date_trunc('milliseconds',consumed_at) AND isfinite(consumed_at)),
 consumed_command_id morrow_work.record_id,
 purge_after timestamptz NOT NULL,
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,digest),
 UNIQUE (nonce_digest),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,actor_membership_id,actor_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT plan_start_documents_window CHECK (expires_at=created_at+interval '5 minutes'),
 CONSTRAINT plan_start_documents_consumed CHECK ((consumed_at IS NULL)=(consumed_command_id IS NULL)
  AND (consumed_at IS NULL OR (consumed_at>=created_at AND consumed_at<expires_at))),
 CONSTRAINT plan_start_documents_purge CHECK (purge_after=COALESCE(consumed_at,expires_at)+interval '24 hours'),
 CONSTRAINT plan_start_documents_digest CHECK (digest::text=morrow_work.sha256_text(canonical)),
 CONSTRAINT plan_start_documents_draft CHECK ((purpose='plan_card')=(message_id IS NOT NULL)
  AND (message_id IS NULL)=(draft_revision IS NULL) AND (message_id IS NULL)=(draft_digest IS NULL)),
 CONSTRAINT plan_start_documents_target CHECK (CASE target_kind
  WHEN 'new_project' THEN target_id IS NULL AND target_revision IS NULL
  WHEN 'existing_project' THEN target_id IS NOT NULL AND target_revision IS NOT NULL
  WHEN 'area' THEN target_id IN ('product_pages','stock','customer_emails','sales_and_numbers','promotions') AND target_revision IS NULL
  ELSE target_id IS NULL AND target_revision IS NULL END),
 CONSTRAINT plan_start_documents_document CHECK (pg_input_is_valid(canonical,'jsonb')
  AND (canonical::jsonb)->>'id'=id::text AND (canonical::jsonb)->>'purpose'=purpose
  AND (canonical::jsonb)->>'organizationId'=organization_id::text AND (canonical::jsonb)->>'workspaceId'=workspace_id::text
  AND (canonical::jsonb)#>>'{actor,principalId}'=actor_principal_id::text AND (canonical::jsonb)#>>'{actor,membershipId}'=actor_membership_id::text
  AND (canonical::jsonb)->>'grantSummaryDigest'=grant_summary_digest::text
  AND (canonical::jsonb)->>'createdAt'=morrow_work.utc_text(created_at) AND (canonical::jsonb)->>'expiresAt'=morrow_work.utc_text(expires_at))
);
CREATE INDEX plan_start_documents_open ON morrow_work.plan_start_documents (organization_id,workspace_id,actor_principal_id,expires_at)
 WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Forward changes on the shared tables (each CHECK the union of every value at this head).
ALTER TABLE morrow_work.commands DROP CONSTRAINT commands_command_type_check, DROP CONSTRAINT commands_check,
 ADD CONSTRAINT commands_command_type_check CHECK (command_type IN ('goal.create','goal.transition','task.create','task.ready','task.assign',
  'question.request','question.answer','question.cancel','proposal.submit','approval.decide','approval.withdraw',
  'installation.document','installation.enable','installation.stop','model_default.revise','run.admit','run.reconcile',
  'goal.revise','goal.check','plan.start_document','plan.start')),
 ADD CONSTRAINT commands_check CHECK (aggregate_type IN ('goal','task','question','proposal','approval','installation','model_default','run','plan')
  AND aggregate_type=split_part(command_type,'.',1));
-- goal.revised (registered in docs/contracts/event-registry.json, EmptyEventPayload): every
-- goal revision a person makes (cmd_goal_revise, or a plan change through the start) appends
-- one, so a goal's aggregate revisions stay contiguous on the stream. The envelope carries the
-- goal's id and revision; the payload is empty (objectives and criteria never enter the outbox).
ALTER TABLE morrow_work.outbox_events DROP CONSTRAINT outbox_events_event_type_check, DROP CONSTRAINT outbox_events_check3,
 ADD CONSTRAINT outbox_events_event_type_check CHECK (event_type IN ('goal.created','goal.status_changed','task.created','task.status_changed','task.assigned',
  'question.requested','question.answered','question.cancelled','proposal.submitted','proposal.derived','approval.decided','approval.status_changed',
  'approval.claimed','kill_switch.executed','run.admitted','run.status_changed','goal.revised')),
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
  WHEN event_type='goal.revised' THEN payload='{}'::jsonb
  ELSE false END);

-- ---------------------------------------------------------------------------
-- Row security. Every table: ENABLE + FORCE and the maintenance-only owner policy.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['projects','goal_measure_values','goal_finish_results','plan_draft_revisions','plan_start_documents'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('GRANT SELECT,INSERT ON morrow_work.%I TO morrow_work_command',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['projects','goal_measure_values','goal_finish_results','plan_draft_revisions'] LOOP
  EXECUTE format('CREATE POLICY tenant_read ON morrow_work.%I FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
END $$;
GRANT UPDATE (revision,title,pin_position,updated_at) ON morrow_work.projects TO morrow_work_command;
GRANT UPDATE (consumed_at,consumed_command_id,purge_after) ON morrow_work.plan_start_documents TO morrow_work_command;
-- The api role reads the readable tables column by column (values by goal; the work API
-- filters each viewer's values by read tags in code, ADR-0031 item 6).
GRANT SELECT (organization_id,workspace_id,id,revision,goal_id,title,pin_position,created_by_principal_id,created_by_membership_id,
 created_at,updated_at) ON morrow_work.projects TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,goal_id,key,product_id,value,observed_at,recorder_kind,recorder_principal_id,
 recorder_membership_id,assistant,answers,counted,read_tags,data_class,expires_at,created_at) ON morrow_work.goal_measure_values TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,goal_id,goal_revision,outcome,canonical,digest,document_id,actor_principal_id,
 actor_membership_id,created_at) ON morrow_work.goal_finish_results TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,message_id,revision,kind,canonical,digest,asker_principal_id,asker_membership_id,
 editor_principal_id,editor_membership_id,context_taint,restricted_sources,created_at) ON morrow_work.plan_draft_revisions TO morrow_work_api;

-- ---------------------------------------------------------------------------
-- Triggers: INVOKER, owned by the owner, granted to nobody.
-- 0015's enforce_status, revised: a goal's objective, date and criteria may also change,
-- only with revision+1 (cmd_goal_revise and the plan start); tasks and questions unchanged.
CREATE OR REPLACE FUNCTION morrow_work.enforce_status() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE
 v_machine text; v_initial text; v_mutable text[];
BEGIN
 v_machine:=CASE TG_TABLE_NAME WHEN 'goals' THEN 'goal' WHEN 'tasks' THEN 'task' WHEN 'questions' THEN 'question' END;
 v_initial:=CASE v_machine WHEN 'question' THEN 'open' ELSE 'draft' END;
 v_mutable:=CASE v_machine WHEN 'task' THEN ARRAY['status','revision','updated_at','owner_principal_id','owner_membership_id']
  WHEN 'goal' THEN ARRAY['status','revision','updated_at','objective','due_at','success_criteria']
  ELSE ARRAY['status','revision','updated_at'] END;
 IF v_machine IS NULL THEN RAISE EXCEPTION 'WORK_STATE_INVALID'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>v_initial OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'WORK_STATE_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.updated_at<OLD.updated_at
  OR (NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS(SELECT 1 FROM morrow_work.transition_rules r
   WHERE r.machine=v_machine AND r.from_status=OLD.status AND r.to_status=NEW.status)) THEN
  RAISE EXCEPTION 'WORK_STATE_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Goals only: a dated record stays dated and an undated one undated; the objective,
-- criteria and date change only while the record is open; Quick tasks is always open
-- (ADR-0033 item 7: once active it is never paused or ended); an area never ends, so its
-- template is never blocked (at most one record per template); `achieved` needs Finish's
-- results record at that revision; `cancelled` needs every task ended.
CREATE FUNCTION morrow_work.goal_kind_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'WORK_STATE_INVALID'; END IF;
 IF (OLD.due_at IS NULL)<>(NEW.due_at IS NULL) THEN RAISE EXCEPTION 'GOAL_KIND_IMMUTABLE'; END IF;
 IF OLD.area_template_id='quick_tasks' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status<>'active' THEN
  RAISE EXCEPTION 'QUICK_TASKS_ALWAYS_OPEN';
 END IF;
 IF OLD.area_template_id IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('achieved','cancelled') THEN
  RAISE EXCEPTION 'AREA_NEVER_ENDS';
 END IF;
 IF (NEW.objective,NEW.due_at,NEW.success_criteria) IS DISTINCT FROM (OLD.objective,OLD.due_at,OLD.success_criteria)
  AND (OLD.status NOT IN ('draft','active','paused') OR NEW.status<>OLD.status) THEN
  RAISE EXCEPTION 'WORK_STATE_INVALID';
 END IF;
 IF NEW.status='achieved' AND OLD.status<>'achieved' AND NOT EXISTS(SELECT 1 FROM morrow_work.goal_finish_results f
   WHERE f.organization_id=NEW.organization_id AND f.workspace_id=NEW.workspace_id AND f.goal_id=NEW.id
   AND f.goal_revision=NEW.revision AND f.outcome='achieved') THEN
  RAISE EXCEPTION 'GOAL_FINISH_RESULTS_MISSING';
 END IF;
 IF NEW.status='cancelled' AND OLD.status<>'cancelled' AND EXISTS(SELECT 1 FROM morrow_work.tasks t
   WHERE t.organization_id=NEW.organization_id AND t.workspace_id=NEW.workspace_id AND t.goal_id=NEW.id
   AND t.status NOT IN ('succeeded','failed','cancelled')) THEN
  RAISE EXCEPTION 'GOAL_TASKS_OPEN';
 END IF;
 RETURN NEW;
END $$;
-- Projects: born at revision 1; afterwards revision+1 with only the title, the pin and
-- updated_at changing.
CREATE FUNCTION morrow_work.project_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','title','pin_position','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'PROJECT_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) THEN
  RAISE EXCEPTION 'PROJECT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Card revisions: revision n+1 of a message follows n, keeps its kind and asker, names an
-- editor, and keeps revision 1's taint and restricted sources (an edit never clears them).
CREATE FUNCTION morrow_work.plan_draft_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE f record;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'WORK_RECORD_IMMUTABLE'; END IF;
 IF NEW.revision=1 THEN
  IF EXISTS(SELECT 1 FROM morrow_work.plan_draft_revisions x WHERE x.organization_id=NEW.organization_id
    AND x.workspace_id=NEW.workspace_id AND x.message_id=NEW.message_id) THEN RAISE EXCEPTION 'PLAN_DRAFT_INVALID'; END IF;
  RETURN NEW;
 END IF;
 SELECT x.kind,x.asker_principal_id::text AS asker_principal_id,x.context_taint,x.restricted_sources INTO f
  FROM morrow_work.plan_draft_revisions x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id
  AND x.message_id=NEW.message_id AND x.revision=1;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM morrow_work.plan_draft_revisions x WHERE x.organization_id=NEW.organization_id
   AND x.workspace_id=NEW.workspace_id AND x.message_id=NEW.message_id AND x.revision=NEW.revision-1)
  OR f.kind<>NEW.kind OR f.asker_principal_id<>NEW.asker_principal_id::text
  OR f.context_taint<>NEW.context_taint OR f.restricted_sources<>NEW.restricted_sources THEN
  RAISE EXCEPTION 'PLAN_DRAFT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Start documents: born unconsumed; the one change is consumption, once.
CREATE FUNCTION morrow_work.plan_start_document_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['consumed_at','consumed_command_id','purge_after'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'PLAN_START_DOCUMENT_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) THEN
  RAISE EXCEPTION 'PLAN_START_DOCUMENT_INVALID';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_work.goal_kind_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.project_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.plan_draft_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.plan_start_document_guard() FROM PUBLIC;
CREATE TRIGGER goal_kind_guard BEFORE UPDATE ON morrow_work.goals FOR EACH ROW EXECUTE FUNCTION morrow_work.goal_kind_guard();
CREATE TRIGGER project_guard BEFORE INSERT OR UPDATE ON morrow_work.projects FOR EACH ROW EXECUTE FUNCTION morrow_work.project_guard();
CREATE TRIGGER plan_draft_guard BEFORE INSERT OR UPDATE ON morrow_work.plan_draft_revisions FOR EACH ROW EXECUTE FUNCTION morrow_work.plan_draft_guard();
CREATE TRIGGER plan_start_document_guard BEFORE INSERT OR UPDATE ON morrow_work.plan_start_documents FOR EACH ROW EXECUTE FUNCTION morrow_work.plan_start_document_guard();
DO $$ DECLARE t text; BEGIN
 -- Values and results are append-only; the retention sweep (the owner, under its
 -- maintenance lease) deletes expired values and purged documents.
 FOREACH t IN ARRAY ARRAY['goal_measure_values','goal_finish_results'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['projects','goal_finish_results','plan_draft_revisions'] LOOP
  EXECUTE format('CREATE TRIGGER append_only_delete BEFORE DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['projects','goal_measure_values','goal_finish_results','plan_draft_revisions','plan_start_documents'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Revisable owner helpers: INVOKER, owned by the owner, EXECUTE for the command role only.
-- The tasks of a goal record that count toward its 200-task cap: for an area or Quick
-- tasks record only tasks that have not ended (ADR-0033 item 7), otherwise every task.
-- Until P06.T03's task states, no task ends, so both counts are equal.
CREATE FUNCTION morrow_work.goal_task_count(p_org text,p_ws text,p_goal_id text) RETURNS bigint
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT count(*) FROM morrow_work.tasks t JOIN morrow_work.goals g ON g.organization_id=t.organization_id
  AND g.workspace_id=t.workspace_id AND g.id=t.goal_id
 WHERE t.organization_id=p_org AND t.workspace_id=p_ws AND t.goal_id=p_goal_id
  AND (g.area_template_id IS NULL OR t.status NOT IN ('succeeded','failed','cancelled'))
$$;
-- The read tags of a hand check: the catalogue tag of every store linked to the workspace.
CREATE FUNCTION morrow_work.hand_check_read_tags(p_org text,p_ws text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('storeId',i.store_id,'capability','catalog.products.read')),'[]'::jsonb)
 FROM morrow_identity.work_store_installations(p_org,p_ws) i WHERE i.status='linked' AND i.linked_at<=pg_catalog.clock_timestamp()
$$;
REVOKE ALL ON FUNCTION morrow_work.goal_task_count(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.hand_check_read_tags(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.goal_task_count(text,text,text),morrow_work.hand_check_read_tags(text,text) TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- API functions: SECURITY DEFINER, owned by the command role after the transfer below,
-- EXECUTE for morrow_work_api only. Tenant and actor come only from current_tenant().
CREATE FUNCTION morrow_work.begin_project_command(p_type text,p_command_id text,p_request_digest text)
RETURNS TABLE(outcome text,aggregate_type text,aggregate_id text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; c record;
BEGIN
 IF p_type IS NULL OR p_type NOT IN ('goal.revise','goal.check','plan.start_document','plan.start')
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

-- workspace.goal.revise (ADR-0033 item 5; human_only, the Worker's kernel decided the verb:
-- own -> execute, another member's record -> administer). The objective, the date (Extend),
-- the targets, questions and assistant, within 1 to 3 goals, every one measured; a stored
-- startRef stays null. An area keeps no date, a dated project keeps one, and Quick tasks is
-- never revised; a record with neither a date nor an area (a v1 goal, not a project) is
-- never revised here.
CREATE FUNCTION morrow_work.cmd_goal_revise(p_command_id text,p_request_digest text,p_correlation_id text,p_goal_id text,
 p_expected_revision text,p_basis text,p_objective text,p_due_at text,p_success_criteria text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; g record; v_criteria jsonb; v_due timestamptz; v_at timestamptz; v_revision bigint; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_goal_id IS NULL OR p_goal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_expected_revision IS NULL OR p_expected_revision !~ '^[1-9][0-9]{0,15}$'
  OR p_basis IS NULL OR p_basis NOT IN ('own','other')
  OR p_objective IS NULL OR char_length(p_objective) NOT BETWEEN 1 AND 8192
  OR p_success_criteria IS NULL OR octet_length(p_success_criteria)>65536 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF p_due_at IS NOT NULL THEN
  v_due:=morrow_work.goal_time(p_due_at);
  IF v_due IS NULL OR v_due<>date_trunc('milliseconds',v_due) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 END IF;
 BEGIN v_criteria:=p_success_criteria::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 IF NOT morrow_work.valid_goal_criteria(v_criteria,v_due) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.status,x.revision::bigint AS revision,x.owner_principal_id::text AS owner_principal_id,
  x.owner_membership_id::text AS owner_membership_id,x.due_at,x.area_template_id INTO g
  FROM morrow_work.goals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_goal_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF g.revision<>p_expected_revision::bigint THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
 IF g.status NOT IN ('draft','active','paused') OR g.area_template_id='quick_tasks'
  OR (g.due_at IS NULL AND g.area_template_id IS NULL) OR (g.due_at IS NULL)<>(v_due IS NULL) THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 IF NOT morrow_work.valid_project_criteria(v_criteria,v_due,g.area_template_id) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF p_basis='own' AND (g.owner_principal_id<>p.principal_id OR g.owner_membership_id<>p.membership_id) THEN
  RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN;
 END IF;
 v_at:=morrow_work.db_now(); v_revision:=g.revision+1;
 UPDATE morrow_work.goals x SET objective=p_objective,due_at=v_due,success_criteria=v_criteria,revision=v_revision,
  updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_goal_id;
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'goal.revised','goal',p_goal_id,v_revision,NULL,
  '{}'::jsonb,p_correlation_id,v_at);
 v_result:=jsonb_build_object('revision',v_revision);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'goal.revise',p_goal_id,v_revision,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- workspace.goal.measure.record (ADR-0033 items 3 and 4; human_only): one hand-check row.
-- The value (how many questions named the product), its read tags, class and clock are
-- computed here; a check in another assistant than the goal's is kept and never counts.
-- At most 3 checks per goal, key, product row and UTC day (the goal's lock serialises the
-- count), so values grow by a bounded number a day.
CREATE FUNCTION morrow_work.cmd_goal_check(p_command_id text,p_request_digest text,p_correlation_id text,p_goal_id text,
 p_key text,p_product_id text,p_assistant text,p_answers text,p_value_id text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; g record; v_answers jsonb; v_measure jsonb; v_row jsonb; v_value integer; v_counted boolean; v_at timestamptz; v_result jsonb;
 v_day timestamptz;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_goal_id IS NULL OR p_goal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_key IS NULL OR p_key !~ '^[a-z][a-z0-9_]{0,31}$'
  OR p_product_id IS NULL OR p_product_id !~ '^product:[1-9][0-9]{0,19}$'
  OR p_assistant IS NULL OR p_assistant NOT IN ('chatgpt','gemini','copilot','perplexity')
  OR p_value_id IS NULL OR p_value_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_answers IS NULL OR octet_length(p_answers)>1024 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 BEGIN v_answers:=p_answers::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 IF NOT morrow_work.valid_check_answers(v_answers) OR jsonb_array_length(v_answers)<1 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.status,x.revision::bigint AS revision,x.success_criteria INTO g
  FROM morrow_work.goals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_goal_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF g.status NOT IN ('draft','active','paused') THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
 SELECT e->'measure' INTO v_measure FROM jsonb_array_elements(g.success_criteria) e
  WHERE e->>'key'=p_key AND jsonb_typeof(e->'measure')='object' AND e#>>'{measure,kind}'='manual';
 IF v_measure IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT r INTO v_row FROM jsonb_array_elements(v_measure->'rows') r WHERE r->>'productId'=p_product_id;
 IF v_row IS NULL OR jsonb_array_length(v_row->'checkItems')<>jsonb_array_length(v_answers) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT count(*)::integer INTO v_value FROM jsonb_array_elements_text(v_answers) a WHERE a='named_this_product';
 v_counted:=(v_measure->>'assistant')=p_assistant;
 v_at:=morrow_work.db_now();
 v_day:=date_trunc('day',v_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
 IF (SELECT count(*) FROM morrow_work.goal_measure_values x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.goal_id=p_goal_id AND x.key=p_key AND x.product_id=p_product_id AND x.observed_at>=v_day AND x.observed_at<v_day+interval '1 day')>=3 THEN
  RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
 END IF;
 INSERT INTO morrow_work.goal_measure_values(organization_id,workspace_id,id,goal_id,key,product_id,value,observed_at,recorder_kind,
  recorder_principal_id,recorder_membership_id,assistant,answers,counted,read_tags,data_class,expires_at,created_at)
 VALUES (p.organization_id,p.workspace_id,p_value_id,p_goal_id,p_key,p_product_id,v_value,v_at,'human',p.principal_id,p.membership_id,
  p_assistant,v_answers,v_counted,morrow_work.hand_check_read_tags(p.organization_id,p.workspace_id),'work',NULL,v_at);
 v_result:=jsonb_build_object('valueId',p_value_id,'counted',v_counted);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'goal.check',p_goal_id,g.revision,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- One start document of the session's own actor, by digest (the start reads the document it
-- confirms). Nothing for another actor, tenant or digest; never the nonce or the session.
CREATE FUNCTION morrow_work.plan_start_document(p_digest text)
RETURNS TABLE(id text,purpose text,canonical text,message_id text,draft_revision text,expires_at text,consumed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record;
BEGIN
 IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id,c.principal_id,c.membership_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT x.id::text,x.purpose,x.canonical,x.message_id::text,x.draft_revision::text,morrow_work.utc_text(x.expires_at),
  x.consumed_at IS NOT NULL
  FROM morrow_work.plan_start_documents x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
   AND x.digest=p_digest AND x.actor_principal_id=t.principal_id AND x.actor_membership_id=t.membership_id;
END $$;

-- The plan start, step 1 (ADR-0034 item 5): records the server-built PlanStartDocument@1
-- the actor confirms, after the Worker's kernel and eligibility checks. Bound to the actor,
-- this session, five minutes and a single-use nonce (stored only as its digest). A card's
-- document needs the card's current revision and digest, asked by this actor; an area or
-- Quick tasks document needs that record not to exist yet.
CREATE FUNCTION morrow_work.cmd_plan_start_document(p_command_id text,p_request_digest text,p_correlation_id text,p_document_id text,
 p_canonical text,p_digest text,p_nonce_digest text,p_grant_summary_digest text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; d jsonb; v_purpose text; v_target jsonb; v_target_kind text; v_target_id text; v_target_revision bigint;
 v_message text; v_draft_revision bigint; v_draft_digest text; v_created timestamptz; v_now timestamptz; v_result jsonb; f record;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_document_id IS NULL OR p_document_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_canonical IS NULL OR octet_length(p_canonical)>65536
  OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_digest<>morrow_work.sha256_text(p_canonical)
  OR p_nonce_digest IS NULL OR p_nonce_digest !~ '^[a-f0-9]{64}$'
  OR p_grant_summary_digest IS NULL OR p_grant_summary_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 BEGIN d:=p_canonical::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 v_purpose:=d->>'purpose'; v_target:=d->'target'; v_target_kind:=v_target->>'kind';
 v_created:=morrow_work.utc_parse(d->>'createdAt');
 IF jsonb_typeof(d)<>'object' OR d->'schemaVersion'<>'1'::jsonb OR d->>'id'<>p_document_id
  OR v_purpose NOT IN ('plan_card','area','quick_tasks') OR v_created IS NULL
  OR d->>'grantSummaryDigest'<>p_grant_summary_digest OR jsonb_typeof(d->'records')<>'object' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_target_id:=CASE v_target_kind WHEN 'existing_project' THEN v_target->>'projectId' WHEN 'area' THEN v_target->>'areaTemplateId' END;
 v_target_revision:=CASE WHEN v_target_kind='existing_project' AND (v_target->>'goalRevision') ~ '^[1-9][0-9]{0,15}$'
  THEN (v_target->>'goalRevision')::bigint END;
 IF (v_purpose='area' AND (v_target_kind<>'area' OR d#>>'{records,goal,areaTemplateId}' IS DISTINCT FROM v_target_id))
  OR (v_purpose='quick_tasks' AND (v_target_kind<>'quick_tasks' OR d#>>'{records,goal,areaTemplateId}' IS DISTINCT FROM 'quick_tasks'))
  OR (v_purpose='plan_card' AND jsonb_typeof(d->'draft')<>'object')
  OR (v_purpose<>'plan_card' AND d->'draft'<>'null'::jsonb) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF v_purpose='plan_card' THEN
  v_message:=d#>>'{draft,messageId}'; v_draft_digest:=d#>>'{draft,digest}';
  IF (d#>>'{draft,revision}') !~ '^[1-9][0-9]{0,15}$' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
  v_draft_revision:=(d#>>'{draft,revision}')::bigint;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 IF d->>'organizationId'<>p.organization_id OR d->>'workspaceId'<>p.workspace_id
  OR d#>>'{actor,principalId}'<>p.principal_id OR d#>>'{actor,membershipId}'<>p.membership_id THEN
  RETURN QUERY SELECT 'actor_ineligible'::text,NULL::text; RETURN;
 END IF;
 -- Quick tasks is created by the Owner's tap (ADR-0033 item 7; the Owner of ADR-0024).
 IF v_purpose='quick_tasks' AND NOT EXISTS(SELECT 1 FROM morrow_identity.work_ownership_facts(p.organization_id) o
   WHERE o.owner_principal_id=p.principal_id AND o.owner_membership_id=p.membership_id) THEN
  RETURN QUERY SELECT 'owner_only'::text,NULL::text; RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 IF v_created>v_now OR v_created<v_now-interval '10 seconds' THEN RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN; END IF;
 IF v_purpose='plan_card' THEN
  -- The card's current revision, asked by this actor; only a digest the server holds.
  SELECT x.revision::bigint AS revision,x.digest::text AS digest,x.asker_principal_id::text AS asker_principal_id,
   x.asker_membership_id::text AS asker_membership_id INTO f
   FROM morrow_work.plan_draft_revisions x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.message_id=v_message ORDER BY x.revision DESC LIMIT 1;
  IF NOT FOUND OR f.revision<>v_draft_revision OR f.digest<>v_draft_digest THEN RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN; END IF;
  IF f.asker_principal_id<>p.principal_id OR f.asker_membership_id<>p.membership_id THEN
   RETURN QUERY SELECT 'actor_ineligible'::text,NULL::text; RETURN;
  END IF;
 ELSIF EXISTS(SELECT 1 FROM morrow_work.goals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.area_template_id=d#>>'{records,goal,areaTemplateId}') THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 IF v_target_kind='existing_project' AND NOT EXISTS(SELECT 1 FROM morrow_work.projects j JOIN morrow_work.goals x
   ON x.organization_id=j.organization_id AND x.workspace_id=j.workspace_id AND x.id=j.goal_id
   WHERE j.organization_id=p.organization_id AND j.workspace_id=p.workspace_id AND j.id=v_target_id AND x.revision=v_target_revision) THEN
  RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN;
 END IF;
 IF (SELECT count(*) FROM morrow_work.plan_start_documents x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.actor_principal_id=p.principal_id AND x.consumed_at IS NULL AND x.expires_at>v_now)>=10 THEN
  RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
 END IF;
 INSERT INTO morrow_work.plan_start_documents(organization_id,workspace_id,id,purpose,message_id,draft_revision,draft_digest,target_kind,
  target_id,target_revision,actor_principal_id,actor_membership_id,session_digest,nonce_digest,grant_summary_digest,canonical,digest,
  command_id,created_at,expires_at,consumed_at,consumed_command_id,purge_after)
 VALUES (p.organization_id,p.workspace_id,p_document_id,v_purpose,v_message,v_draft_revision,v_draft_digest,v_target_kind,
  v_target_id,v_target_revision,p.principal_id,p.membership_id,pg_catalog.current_setting('morrow.work_session_digest',true),
  p_nonce_digest,p_grant_summary_digest,p_canonical,p_digest,p_command_id,v_created,v_created+interval '5 minutes',NULL,NULL,
  v_created+interval '5 minutes'+interval '24 hours');
 v_result:=jsonb_build_object('documentId',p_document_id,'documentDigest',p_digest,
  'expiresAt',morrow_work.utc_text(v_created+interval '5 minutes'));
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'plan.start_document',p_document_id,1,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- The plan start, step 2: one transaction. (a) Consumes the document: this actor, this
-- session, unexpired, unconsumed, its nonce, an unchanged grant summary and card; (b) the
-- Worker's kernel decided every piece under this snapshot's grants and the prelude rechecks
-- them under lock; every assignee is rechecked here (a member's grants, an installation
-- active and not stopped); (c) creates, as the actor's own commands, the goal record (made
-- active), the project with its pin and the tasks; (e) records one command. Repeating tasks
-- wait for T5's routine records (`repeating_unavailable`), and nothing is posted until T6's
-- conversations exist. Any refusal returns before any write, or raises, so nothing commits.
CREATE FUNCTION morrow_work.cmd_plan_start(p_command_id text,p_request_digest text,p_correlation_id text,p_document_digest text,
 p_nonce_digest text,p_grant_summary_digest text,p_assignees text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; doc record; d jsonb; v_assignees jsonb; v_now timestamptz; v_goal_id text; v_project_id text; v_task_id text;
 v_task_ids jsonb:='[]'::jsonb; v_records jsonb; t jsonb; a jsonb; v_pin integer; v_due timestamptz; v_revision bigint;
 v_result jsonb; v_assignment text; v_owner record; g record;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_document_digest IS NULL OR p_document_digest !~ '^[a-f0-9]{64}$'
  OR p_nonce_digest IS NULL OR p_nonce_digest !~ '^[a-f0-9]{64}$'
  OR p_grant_summary_digest IS NULL OR p_grant_summary_digest !~ '^[a-f0-9]{64}$'
  OR p_assignees IS NULL OR octet_length(p_assignees)>8192 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 BEGIN v_assignees:=p_assignees::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 IF jsonb_typeof(v_assignees)<>'object' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 -- (a) The document, locked: unknown, consumed, expired, another nonce or summary is stale;
 -- another actor or session is ineligible.
 SELECT x.id::text AS id,x.purpose,x.canonical,x.actor_principal_id::text AS actor_principal_id,
  x.actor_membership_id::text AS actor_membership_id,x.session_digest::text AS session_digest,x.nonce_digest::text AS nonce_digest,
  x.grant_summary_digest::text AS grant_summary_digest,x.expires_at,x.consumed_at,x.message_id::text AS message_id,
  x.draft_revision::bigint AS draft_revision,x.draft_digest::text AS draft_digest,x.target_kind,x.target_id,
  x.target_revision::bigint AS target_revision INTO doc
  FROM morrow_work.plan_start_documents x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
  AND x.digest=p_document_digest FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN; END IF;
 IF doc.actor_principal_id<>p.principal_id OR doc.actor_membership_id<>p.membership_id
  OR doc.session_digest IS DISTINCT FROM pg_catalog.current_setting('morrow.work_session_digest',true) THEN
  RETURN QUERY SELECT 'actor_ineligible'::text,NULL::text; RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 IF doc.consumed_at IS NOT NULL OR v_now>=doc.expires_at OR doc.nonce_digest<>p_nonce_digest
  OR doc.grant_summary_digest<>p_grant_summary_digest THEN
  RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN;
 END IF;
 d:=doc.canonical::jsonb; v_records:=d->'records';
 IF doc.purpose NOT IN ('plan_card','area','quick_tasks') THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
 -- Quick tasks: still the Owner, under the prelude's organization interlock.
 IF doc.purpose='quick_tasks' AND NOT EXISTS(SELECT 1 FROM morrow_identity.work_ownership_facts(p.organization_id) o
   WHERE o.owner_principal_id=p.principal_id AND o.owner_membership_id=p.membership_id) THEN
  RETURN QUERY SELECT 'owner_only'::text,NULL::text; RETURN;
 END IF;
 IF doc.purpose='plan_card' AND NOT EXISTS(SELECT 1 FROM morrow_work.plan_draft_revisions x WHERE x.organization_id=p.organization_id
   AND x.workspace_id=p.workspace_id AND x.message_id=doc.message_id AND x.revision=doc.draft_revision AND x.digest=doc.draft_digest
   AND NOT EXISTS(SELECT 1 FROM morrow_work.plan_draft_revisions y WHERE y.organization_id=x.organization_id
    AND y.workspace_id=x.workspace_id AND y.message_id=x.message_id AND y.revision>x.revision)) THEN
  RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN;
 END IF;
 IF jsonb_array_length(COALESCE(v_records->'repeating','[]'::jsonb))>0 THEN
  RETURN QUERY SELECT 'repeating_unavailable'::text,NULL::text; RETURN;
 END IF;
 -- Every record is checked before the first write, so a refusal writes nothing.
 IF jsonb_typeof(v_records->'tasks')<>'array' OR jsonb_array_length(v_records->'tasks')>8
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_records->'tasks') x WHERE jsonb_typeof(x->'objective')<>'string'
   OR char_length(x->>'objective') NOT BETWEEN 1 AND 8192 OR jsonb_typeof(x->'assignee')<>'object'
   OR (x#>>'{assignee,kind}') NOT IN ('person','agent','specialist','code'))
  OR (jsonb_typeof(v_records->'project')='object' AND (jsonb_typeof(v_records#>'{project,title}')<>'string'
   OR char_length(v_records#>>'{project,title}') NOT BETWEEN 1 AND 120 OR jsonb_typeof(v_records#>'{project,pin}')<>'boolean'))
  OR NOT (v_records->'project'='null'::jsonb OR jsonb_typeof(v_records->'project')='object') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF jsonb_typeof(v_records->'project')='object' AND (v_records#>>'{project,pin}')::boolean THEN
  SELECT min(n) INTO v_pin FROM generate_series(0,19) n WHERE NOT EXISTS(SELECT 1 FROM morrow_work.projects j
   WHERE j.organization_id=p.organization_id AND j.workspace_id=p.workspace_id AND j.pin_position=n);
  IF v_pin IS NULL THEN RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN; END IF;
 END IF;
 -- (b) Every assignee, under lock: a person other than the actor is an eligible member
 -- whose grants are those the Worker judged; an agent is an active installation that no
 -- stop holds. An assignee that changed is stale; a stopped one is stopped.
 FOR t IN SELECT x FROM jsonb_array_elements(v_records->'tasks') x LOOP
  IF t#>>'{assignee,kind}'='person' AND t#>>'{assignee,principalId}'<>p.principal_id THEN
   a:=v_assignees->(t#>>'{assignee,principalId}');
   IF a IS NULL OR jsonb_typeof(a)<>'string' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
   SELECT r.outcome INTO v_assignment FROM morrow_work.target_recheck(p.organization_id,p.workspace_id,t#>>'{assignee,principalId}',a#>>'{}') r;
   IF v_assignment IS DISTINCT FROM 'current' THEN RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN; END IF;
  ELSIF t#>>'{assignee,kind}'='agent' THEN
   IF NOT EXISTS(SELECT 1 FROM morrow_work.agent_installations i WHERE i.organization_id=p.organization_id AND i.workspace_id=p.workspace_id
     AND i.id=t#>>'{assignee,installationId}' AND i.status='active') THEN
    RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN;
   END IF;
   IF morrow_work.stop_active(p.organization_id,p.workspace_id,'run',
     (SELECT i.connection_id::text FROM morrow_work.agent_installations i WHERE i.organization_id=p.organization_id
      AND i.workspace_id=p.workspace_id AND i.id=t#>>'{assignee,installationId}'),t#>>'{assignee,installationId}') THEN
    RETURN QUERY SELECT 'stopped'::text,NULL::text; RETURN;
   END IF;
  END IF;
 END LOOP;
 -- (c) The goal record: a new one (made active), or a plan change of the target's.
 IF doc.target_kind='existing_project' THEN
  SELECT x.id::text AS id,x.revision::bigint AS revision,x.status,x.due_at,x.area_template_id,x.success_criteria INTO g
   FROM morrow_work.goals x JOIN morrow_work.projects j ON j.organization_id=x.organization_id AND j.workspace_id=x.workspace_id
   AND j.goal_id=x.id WHERE j.organization_id=p.organization_id AND j.workspace_id=p.workspace_id AND j.id=doc.target_id FOR UPDATE OF x;
  IF NOT FOUND OR g.revision<>doc.target_revision THEN RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN; END IF;
  IF g.status NOT IN ('draft','active','paused') THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
  v_goal_id:=g.id;
  IF jsonb_typeof(v_records->'goal')='object' THEN
   -- Quick tasks is never revised (cmd_goal_revise's rule; ADR-0033 item 7).
   IF g.area_template_id='quick_tasks' THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
   v_due:=morrow_work.goal_time(v_records#>>'{goal,dueAt}');
   IF (v_due IS NULL)<>(g.due_at IS NULL) OR NOT morrow_work.valid_goal_criteria(v_records#>'{goal,successCriteria}',v_due)
    OR NOT morrow_work.valid_project_criteria(v_records#>'{goal,successCriteria}',v_due,g.area_template_id)
    OR jsonb_typeof(v_records#>'{goal,objective}')<>'string' OR char_length(v_records#>>'{goal,objective}') NOT BETWEEN 1 AND 8192 THEN
    RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
   END IF;
   -- A plan change never drops a customer-class goal (ADR-0033 Consequences; the one
   -- customer-class metric, measures.ts): Morrow's card never sees one, so the Worker keeps
   -- each, unchanged, after the card's goals. Any other list is refused here, under lock.
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(g.success_criteria) e WHERE e#>>'{measure,kind}'='metric'
     AND e#>>'{measure,metricId}'='replied_within_a_day'
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_records#>'{goal,successCriteria}') n WHERE n=e)) THEN
    RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
   END IF;
  END IF;
 ELSIF doc.target_kind IN ('area','quick_tasks') AND v_records->'goal'='null'::jsonb THEN
  -- A task or repeating card for an existing area or Quick tasks record.
  SELECT x.id::text AS id,x.status INTO g FROM morrow_work.goals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.area_template_id=COALESCE(doc.target_id,'quick_tasks') FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
  IF g.status NOT IN ('draft','active','paused') THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
  v_goal_id:=g.id;
 ELSE
  -- A new goal record: a dated project, an area or Quick tasks, at most one per template.
  IF jsonb_typeof(v_records->'goal')<>'object' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
  v_due:=morrow_work.goal_time(v_records#>>'{goal,dueAt}');
  IF (doc.target_kind='new_project')<>(v_due IS NOT NULL) OR (v_due IS NOT NULL AND v_due<>date_trunc('milliseconds',v_due))
   OR (doc.target_kind='new_project' AND v_records#>'{goal,areaTemplateId}'<>'null'::jsonb)
   OR (doc.target_kind IN ('area','quick_tasks') AND v_records#>>'{goal,areaTemplateId}' IS DISTINCT FROM COALESCE(doc.target_id,'quick_tasks'))
   OR NOT morrow_work.valid_goal_criteria(v_records#>'{goal,successCriteria}',v_due)
   OR NOT morrow_work.valid_project_criteria(v_records#>'{goal,successCriteria}',v_due,v_records#>>'{goal,areaTemplateId}')
   OR jsonb_typeof(v_records#>'{goal,objective}')<>'string' OR char_length(v_records#>>'{goal,objective}') NOT BETWEEN 1 AND 8192 THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
  IF v_records#>>'{goal,areaTemplateId}' IS NOT NULL AND EXISTS(SELECT 1 FROM morrow_work.goals x WHERE x.organization_id=p.organization_id
    AND x.workspace_id=p.workspace_id AND x.area_template_id=v_records#>>'{goal,areaTemplateId}') THEN
   RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
  END IF;
  IF (SELECT count(*) FROM morrow_work.goals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id)>=10000 THEN
   RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
  END IF;
  v_goal_id:=NULL;
 END IF;
 -- The 200-task cap (an area or Quick tasks record counts only tasks not ended).
 IF v_goal_id IS NOT NULL AND morrow_work.goal_task_count(p.organization_id,p.workspace_id,v_goal_id)
   +jsonb_array_length(v_records->'tasks')>200 THEN
  RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
 END IF;
 -- (c) Writes start here; every refusal above wrote nothing.
 IF v_goal_id IS NULL THEN
  v_goal_id:=gen_random_uuid()::text;
  INSERT INTO morrow_work.goals(organization_id,workspace_id,id,revision,status,objective,scope,success_criteria,owner_principal_id,
   owner_membership_id,created_by_principal_id,created_by_membership_id,created_at,updated_at,due_at,area_template_id)
  VALUES (p.organization_id,p.workspace_id,v_goal_id,1,'draft',v_records#>>'{goal,objective}',
   jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,
    'resources',jsonb_build_array(jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeId',NULL,
     'connectionId',NULL,'kind','workspace','id',p.workspace_id)),'fields','[]'::jsonb),
   v_records#>'{goal,successCriteria}',p.principal_id,p.membership_id,p.principal_id,p.membership_id,v_now,v_now,v_due,
   v_records#>>'{goal,areaTemplateId}');
  PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'goal.created','goal',v_goal_id,1,NULL,
   jsonb_build_object('status','draft'),p_correlation_id,v_now);
  UPDATE morrow_work.goals x SET status='active',revision=2,updated_at=v_now
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=v_goal_id;
  PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'goal.status_changed','goal',v_goal_id,2,NULL,
   jsonb_build_object('from','draft','to','active'),p_correlation_id,v_now);
 ELSIF doc.target_kind='existing_project' AND jsonb_typeof(v_records->'goal')='object' THEN
  -- A plan change applies as workspace.goal.revise against the project's current revision.
  v_revision:=g.revision+1;
  UPDATE morrow_work.goals x SET objective=v_records#>>'{goal,objective}',due_at=v_due,success_criteria=v_records#>'{goal,successCriteria}',
   revision=v_revision,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=v_goal_id;
  PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'goal.revised','goal',v_goal_id,v_revision,NULL,
   '{}'::jsonb,p_correlation_id,v_now);
 END IF;
 -- The project and its pin (human_only: this actor's own act).
 IF jsonb_typeof(v_records->'project')='object' THEN
  v_project_id:=gen_random_uuid()::text;
  INSERT INTO morrow_work.projects(organization_id,workspace_id,id,revision,goal_id,title,pin_position,created_by_principal_id,
   created_by_membership_id,created_at,updated_at)
  VALUES (p.organization_id,p.workspace_id,v_project_id,1,v_goal_id,v_records#>>'{project,title}',v_pin,p.principal_id,p.membership_id,v_now,v_now);
 END IF;
 -- The tasks, as the actor's own; a person other than the actor is then assigned (the
 -- recheck above holds: the prelude's organization interlock is held to commit).
 FOR t IN SELECT x FROM jsonb_array_elements(v_records->'tasks') x LOOP
  v_task_id:=gen_random_uuid()::text;
  INSERT INTO morrow_work.tasks(organization_id,workspace_id,id,revision,goal_id,status,objective,scope,initiator_principal_id,
   initiator_membership_id,owner_principal_id,owner_membership_id,created_at,updated_at)
  VALUES (p.organization_id,p.workspace_id,v_task_id,1,v_goal_id,'draft',t->>'objective',
   jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,
    'resources',jsonb_build_array(jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeId',NULL,
     'connectionId',NULL,'kind','workspace','id',p.workspace_id)),'fields','[]'::jsonb),
   p.principal_id,p.membership_id,p.principal_id,p.membership_id,v_now,v_now);
  PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'task.created','task',v_task_id,1,v_task_id,
   jsonb_build_object('goalId',v_goal_id,'status','draft'),p_correlation_id,v_now);
  IF t#>>'{assignee,kind}'='person' AND t#>>'{assignee,principalId}'<>p.principal_id THEN
   SELECT r.outcome,r.membership_id INTO v_owner FROM morrow_work.target_recheck(p.organization_id,p.workspace_id,
    t#>>'{assignee,principalId}',v_assignees->>(t#>>'{assignee,principalId}')) r;
   IF v_owner.outcome IS DISTINCT FROM 'current' THEN RAISE EXCEPTION 'PLAN_START_ASSIGNEE_STALE'; END IF;
   v_assignment:=gen_random_uuid()::text;
   UPDATE morrow_work.tasks x SET owner_principal_id=t#>>'{assignee,principalId}',owner_membership_id=v_owner.membership_id,revision=2,updated_at=v_now
    WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=v_task_id;
   INSERT INTO morrow_work.task_assignments(organization_id,workspace_id,id,task_id,assignee_principal_id,assignee_membership_id,
    assigned_by_principal_id,assigned_by_membership_id,task_revision,created_at)
   VALUES (p.organization_id,p.workspace_id,v_assignment,v_task_id,t#>>'{assignee,principalId}',v_owner.membership_id,p.principal_id,
    p.membership_id,2,v_now);
   PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'task.assigned','task',v_task_id,2,v_task_id,
    jsonb_build_object('assignmentId',v_assignment,'ownerPrincipalId',t#>>'{assignee,principalId}'),p_correlation_id,v_now);
  END IF;
  v_task_ids:=v_task_ids||to_jsonb(v_task_id);
 END LOOP;
 -- (a) consumed, and (e) the one audit record: the command row with every created id.
 UPDATE morrow_work.plan_start_documents x SET consumed_at=v_now,consumed_command_id=p_command_id,purge_after=v_now+interval '24 hours'
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=doc.id;
 v_result:=jsonb_build_object('goalId',v_goal_id,'projectId',v_project_id,'taskIds',v_task_ids,'routineIds','[]'::jsonb);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'plan.start',doc.id,1,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- Explicit ACLs per function (S5 reads proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.begin_project_command(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.plan_start_document(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_goal_revise(text,text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_goal_check(text,text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_plan_start_document(text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_plan_start(text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.begin_project_command(text,text,text),morrow_work.plan_start_document(text),
 morrow_work.cmd_goal_revise(text,text,text,text,text,text,text,text,text),
 morrow_work.cmd_goal_check(text,text,text,text,text,text,text,text,text),
 morrow_work.cmd_plan_start_document(text,text,text,text,text,text,text,text),
 morrow_work.cmd_plan_start(text,text,text,text,text,text,text) TO morrow_work_api;
GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;
ALTER FUNCTION morrow_work.begin_project_command(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.plan_start_document(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_goal_revise(text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_goal_check(text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_plan_start_document(text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_plan_start(text,text,text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;
COMMIT;
