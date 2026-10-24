BEGIN;
-- Build order PR 11 (track T4), the agent loop's records (ADR-0027 items 1-7 and 11-12;
-- ADR-0026 item 4; ADR-0024 item 7; brief docs/briefs/t4-agent-loop.md). Executes AS
-- morrow_work_owner, after 0046. On the ADR-0010 tenant pattern: composite tenant keys,
-- ENABLE and FORCE RLS, definers owned by morrow_work_command, INVOKER triggers and checks
-- owned by the owner. No external effect: nothing here sends a request. Nothing here is
-- reachable while the agent-loop switch (docs/decisions/agent-loop-staging.json) is off:
-- the api refuses admission (switch_off) before any statement, the orchestrator never
-- starts AgentRunWorkflow and the broker holds modelTurn.
--   * Platform: loop_catalogue_versions and loop_catalogue_entries, the agent-loop
--     catalogue (version 2: Haiku, Sonnet and Opus 5.5 at low, medium and high, ADR-0027
--     item 12's limits and prices) committed `proposed`: admission takes only an `active`
--     version, so no loop run is admitted until a later forward migration publishes it on
--     the owner's recorded confirmation (drift-tested against the generated catalogue);
--     tool_catalogue_entries, ToolCatalogue@1 version 2 (each tool's capability, verb,
--     replay class and contexts), so SQL derives an envelope's capabilities and checks every
--     tool call's pair itself.
--   * Tenant: agent_runs (one agent-run@1: its pinned AgentRunManifest@1, the routed run's
--     delegation envelope and hop, its current run lease, the caps, the hold and the running
--     counters; ids, digests, codes and amounts only), run_turns (the only place loop
--     content lives: each turn's input, the model's reply and the tool results it led to;
--     ADR-0027 item 7), run_tool_calls (RunToolCall@1: ids, codes and digests),
--     agent_model_calls (the broker's turn fence: one row per send, content-free) and
--     agent_run_questions (inbox.ask's question and the person's answer).
--   * Definers: the api's cmd_agent_run_admit (a person's routed run of one installed agent
--     on one store; this migration admits no other kind) and cmd_agent_run_answer (the
--     requester's answer, which opens the resume lease, ADR-0027 item 1); the runtime's
--     agent_run_pending_starts and agent_run_resume_lease (ids only), agent_run_start,
--     agent_run_conversation, agent_turn_open, agent_tool_call_begin, agent_tool_call_finish,
--     agent_question_ask, agent_run_wait and agent_run_finish; the broker's
--     morrow_vault.agent_turn_begin and agent_turn_end. Revisable owner helpers:
--     agent_turn_close_uncertain, agent_run_end and agent_runs_close_stale.
-- Money (ADR-0026 item 4, ADR-0027 items 6 and 12): before the rate card a loop run earns
-- no credit and runs only under the operator test entitlement; its hold is the lowest of its
-- turn limit times its entry's worst-case turn and the US$7 backstop, computed here (the
-- code computes the same and admission refuses a mismatch); every counted turn books its
-- cost against the hold (an uncertain one at the worst case; what the hold cannot hold is
-- overflow, never dropped), and admission counts the day's listings and loop spend against
-- the daily backstop and the period's unrecovered cost against its cap. Listings' own
-- run_reserve does not yet count loop spend: the switch's prerequisites record that.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regclass('morrow_work.runs') IS NULL OR to_regclass('morrow_work.agent_installations') IS NULL
 OR to_regclass('morrow_work.agent_releases') IS NULL OR to_regclass('morrow_work.work_envelopes') IS NULL
 OR to_regclass('morrow_work.delegation_hops') IS NULL OR to_regclass('morrow_work.work_leases') IS NULL
 OR to_regclass('morrow_billing.vendor_cost_reservations') IS NULL OR to_regclass('morrow_billing.run_cost_bookings') IS NULL
 OR to_regclass('morrow_billing.unrecovered_costs') IS NULL OR to_regclass('morrow_billing.entitlement_snapshots') IS NULL
 OR to_regclass('morrow_work.goal_measure_values') IS NULL
 OR to_regclass('morrow_work.agent_runs') IS NOT NULL OR to_regclass('morrow_work.run_turns') IS NOT NULL
 OR to_regclass('morrow_work.loop_catalogue_versions') IS NOT NULL
 OR to_regprocedure('morrow_vault.resolve_call(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.lease_open(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.lease_release()') IS NULL OR to_regprocedure('morrow_work.lease_mark_started()') IS NULL
 OR to_regprocedure('morrow_work.current_lease()') IS NULL OR to_regprocedure('morrow_work.current_tenant()') IS NULL
 OR to_regprocedure('morrow_work.command_prelude(text,text)') IS NULL
 OR to_regprocedure('morrow_work.record_command(text,text,text,text,text,text,text,text,bigint,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.append_event(text,text,text,text,text,text,text,bigint,text,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.listings_store_current(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.stop_active(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.listings_scope(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.valid_read_tags(jsonb)') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_agent_principal_ensure(text,text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_agent_grants_issue(text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 -- The shared command and event CHECKs this file relies on, unchanged (it widens none):
 -- run.admit and question.answer are recorded commands, task.created and
 -- task.status_changed the child task's events.
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass
   AND c.conname='commands_command_type_check') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_command_type_check'
   AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''run.admit''%' AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''question.answer''%')
 THEN RAISE EXCEPTION 'AGENT_RUNS_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pure functions: IMMUTABLE, owned by the owner; the command role holds EXECUTE because
-- CHECK constraints run with the writer's privileges.
-- A UserModelMessage as stored (ADR-0027 item 5): role user, 1..32 blocks, each a text
-- block, a data block naming a closed untrusted source, or a tool result (8 KiB). The
-- contract validator checks the full shape in the Worker; this bounds what SQL stores.
CREATE FUNCTION morrow_work.loop_user_message_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'object' OR NOT (p ?& ARRAY['role','content']) OR (p-ARRAY['role','content'])<>'{}'::jsonb
   OR p->'role'<>'"user"'::jsonb OR jsonb_typeof(p->'content')<>'array' OR jsonb_array_length(p->'content') NOT BETWEEN 1 AND 32
   OR octet_length(p::text)>393216 THEN false ELSE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(p->'content') b WHERE NOT (CASE WHEN jsonb_typeof(b)<>'object' THEN false
   WHEN b->>'type'='text' THEN (b-ARRAY['type','text'])='{}'::jsonb AND jsonb_typeof(b->'text')='string'
    AND char_length(b->>'text') BETWEEN 1 AND 32000
   WHEN b->>'type'='data' THEN (b-ARRAY['type','source','sourceId','text'])='{}'::jsonb AND b ?& ARRAY['source','sourceId','text']
    AND (b->>'source') IN ('product','inventory','order_summary','support_mail','knowledge_page','artifact','report','upload',
     'sandbox_output','tool_result','message')
    AND (b->'sourceId'='null'::jsonb OR (jsonb_typeof(b->'sourceId')='string' AND (b->>'sourceId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'))
    AND jsonb_typeof(b->'text')='string' AND char_length(b->>'text')<=65536
   WHEN b->>'type'='tool_result' THEN (b-ARRAY['type','toolUseId','outcome','content'])='{}'::jsonb AND b ?& ARRAY['toolUseId','outcome','content']
    AND jsonb_typeof(b->'toolUseId')='string' AND (b->>'toolUseId') ~ '^[A-Za-z0-9_-]{1,64}$'
    AND (b->>'outcome') IN ('ok','refused','invalid_input','tool_outcome_unknown','computer_unavailable')
    AND jsonb_typeof(b->'content')='string' AND octet_length(b->>'content')<=8192
   ELSE false END)) END
$$;
-- An AssistantModelMessage as stored: role assistant, 1..32 blocks of text, tool_use (at
-- most four) or reasoning. The broker writes it from the provider's reply; the Worker
-- validates it fully with the generated contract before any tool runs.
CREATE FUNCTION morrow_work.loop_assistant_message_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'object' OR NOT (p ?& ARRAY['role','content']) OR (p-ARRAY['role','content'])<>'{}'::jsonb
   OR p->'role'<>'"assistant"'::jsonb OR jsonb_typeof(p->'content')<>'array' OR jsonb_array_length(p->'content') NOT BETWEEN 1 AND 32
   OR octet_length(p::text)>393216 THEN false ELSE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(p->'content') b WHERE NOT (CASE WHEN jsonb_typeof(b)<>'object' THEN false
   WHEN b->>'type'='text' THEN (b-ARRAY['type','text'])='{}'::jsonb AND jsonb_typeof(b->'text')='string'
    AND char_length(b->>'text') BETWEEN 1 AND 32000
   WHEN b->>'type'='tool_use' THEN (b-ARRAY['type','id','name','input'])='{}'::jsonb AND b ?& ARRAY['id','name','input']
    AND jsonb_typeof(b->'id')='string' AND (b->>'id') ~ '^[A-Za-z0-9_-]{1,64}$'
    AND jsonb_typeof(b->'name')='string' AND (b->>'name') ~ '^[a-z]+(\.[a-z]+)+$' AND jsonb_typeof(b->'input')='object'
   WHEN b->>'type'='reasoning' THEN (b-ARRAY['type','text','continuity','redacted'])='{}'::jsonb AND b ?& ARRAY['text','continuity','redacted']
    AND jsonb_typeof(b->'text')='string' AND char_length(b->>'text')<=65536 AND jsonb_typeof(b->'continuity')='string'
    AND char_length(b->>'continuity')<=65536 AND jsonb_typeof(b->'redacted')='boolean'
   ELSE false END))
  AND (SELECT count(*) FROM jsonb_array_elements(p->'content') b WHERE b->>'type'='tool_use')<=4 END
$$;
-- The tool results one turn's reply led to: 0..4 tool_result blocks, distinct ids.
CREATE FUNCTION morrow_work.loop_tool_results_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'array' OR jsonb_array_length(p)>4 THEN false
  ELSE morrow_work.loop_user_message_valid(jsonb_build_object('role','user','content',
    CASE WHEN jsonb_array_length(p)=0 THEN jsonb_build_array(jsonb_build_object('type','text','text','.')) ELSE p END))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p) b WHERE b->>'type'<>'tool_result')
   AND (SELECT count(DISTINCT b->>'toolUseId') FROM jsonb_array_elements(p) b)=jsonb_array_length(p) END
$$;
-- inbox.ask's choices: 0..5 distinct strings of 1..100 characters.
CREATE FUNCTION morrow_work.loop_choices_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'array' OR jsonb_array_length(p)>5 THEN false
  ELSE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p) c WHERE jsonb_typeof(c)<>'string' OR char_length(c#>>'{}') NOT BETWEEN 1 AND 100)
   AND (SELECT count(DISTINCT c) FROM jsonb_array_elements(p) c)=jsonb_array_length(p) END
$$;
-- AgentRunManifest@1 of a routed run, as admission pins it (ADR-0027 item 1). The canonical
-- text is the Worker's RFC 8785 output of the validated manifest; this proves it parses to
-- exactly the run's own columns: no content, only ids, digests, codes, caps and the hold.
CREATE FUNCTION morrow_work.agent_manifest_matches(p_canonical text,p_org text,p_ws text,p_run text,p_store text,p_connection text,
 p_task text,p_installation text,p_principal text,p_membership text,p_release_id text,p_release_revision bigint,p_release_digest text,
 p_system_text_digest text,p_tool_version integer,p_tool_digest text,p_tools text[],p_catalogue_version integer,p_model text,p_effort text,
 p_turn_limit integer,p_tool_calls_per_turn integer,p_tool_calls_per_run integer,p_questions integer,p_max_input integer,p_max_output integer,
 p_wall_ms integer,p_hold numeric,p_admitted_at timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE m jsonb; v_keys text[];
BEGIN
 IF p_canonical IS NULL OR octet_length(p_canonical)>16384 OR NOT pg_input_is_valid(p_canonical,'jsonb') THEN RETURN false; END IF;
 m:=p_canonical::jsonb;
 IF jsonb_typeof(m)<>'object' THEN RETURN false; END IF;
 SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(m) k;
 IF v_keys<>ARRAY['admittedAt','caps','connectionId','dataClasses','installationId','kind','mandateId','modelProfile','organizationId',
   'release','requester','runId','schemaVersion','specDigest','storeId','systemTextDigest','taskId','toolCatalogueDigest',
   'toolCatalogueVersion','tools','triggerId','workflow','workspaceId'] THEN RETURN false; END IF;
 RETURN m->'schemaVersion'='1'::jsonb AND m->'workflow'='"agent-run@1"'::jsonb AND m->'kind'='"routed"'::jsonb
  AND m->'organizationId'=to_jsonb(p_org) AND m->'workspaceId'=to_jsonb(p_ws) AND m->'runId'=to_jsonb(p_run)
  AND m->'storeId'=to_jsonb(p_store) AND m->'connectionId'=to_jsonb(p_connection) AND m->'taskId'=to_jsonb(p_task)
  AND m->'installationId'=to_jsonb(p_installation) AND m->'mandateId'='null'::jsonb AND m->'triggerId'='null'::jsonb
  AND m->'specDigest'='null'::jsonb AND m->'dataClasses'='null'::jsonb
  AND m->'requester'=jsonb_build_object('kind','human','principalId',p_principal,'organizationId',p_org,'workspaceId',p_ws,
   'membershipId',p_membership,'installationId',NULL,'mandateId',NULL)
  AND m->'release'=jsonb_build_object('id',p_release_id,'revision',p_release_revision,'digest',p_release_digest)
  AND m->'systemTextDigest'=to_jsonb(p_system_text_digest) AND m->'toolCatalogueVersion'=to_jsonb(p_tool_version)
  AND m->'toolCatalogueDigest'=to_jsonb(p_tool_digest) AND m->'tools'=to_jsonb(p_tools)
  AND m->'modelProfile'=jsonb_build_object('model',p_model,'effort',p_effort,'catalogueVersion',p_catalogue_version)
  AND (m->'caps')-'holdUsd'=jsonb_build_object('maxTurns',p_turn_limit,'maxToolCallsPerTurn',p_tool_calls_per_turn,
   'maxToolCallsPerRun',p_tool_calls_per_run,'maxQuestions',p_questions,'maxInputTokensPerTurn',p_max_input,
   'maxOutputTokensPerTurn',p_max_output,'wallTimeSeconds',p_wall_ms/1000,'deadline',NULL)
  AND jsonb_typeof(m#>'{caps,holdUsd}')='string' AND (m#>>'{caps,holdUsd}') ~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,8})?$'
  AND (m#>>'{caps,holdUsd}')::numeric=p_hold
  AND jsonb_typeof(m->'admittedAt')='string' AND (m->>'admittedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND (m->>'admittedAt')::timestamptz=p_admitted_at;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- ---------------------------------------------------------------------------
-- Platform: the agent-loop catalogue (ADR-0027 items 6 and 12), drift-tested against
-- packages/policy/src/generated/loop-catalogue.ts. Rates are exact integers of 10^-12 USD per
-- token; a worst-case turn is the input cap at the cache-write rate plus the effort's whole
-- max_tokens at the output rate, rounded up to numeric(20,8). A new version, or the
-- publication of a proposed one, is a new forward migration.
CREATE TABLE morrow_work.loop_catalogue_versions (
 version integer NOT NULL PRIMARY KEY CHECK (version BETWEEN 2 AND 999),
 status text NOT NULL CHECK (status IN ('proposed','active','retired')),
 digest morrow_work.digest NOT NULL,
 max_input_tokens_per_turn integer NOT NULL CHECK (max_input_tokens_per_turn BETWEEN 1 AND 64000),
 max_turns_per_run integer NOT NULL CHECK (max_turns_per_run BETWEEN 1 AND 16),
 max_turns_per_coordinator_run integer NOT NULL CHECK (max_turns_per_coordinator_run BETWEEN 1 AND 16),
 max_tool_calls_per_turn integer NOT NULL CHECK (max_tool_calls_per_turn BETWEEN 0 AND 4),
 max_tool_calls_per_run integer NOT NULL CHECK (max_tool_calls_per_run BETWEEN 0 AND 40),
 max_questions_per_run integer NOT NULL CHECK (max_questions_per_run BETWEEN 0 AND 2),
 question_wait_hours integer NOT NULL CHECK (question_wait_hours BETWEEN 1 AND 72),
 wall_time_minutes integer NOT NULL CHECK (wall_time_minutes BETWEEN 1 AND 30),
 run_cost_cap_usd numeric(20,8) NOT NULL CHECK (run_cost_cap_usd>0),
 workspace_daily_cost_cap_usd numeric(20,8) NOT NULL CHECK (workspace_daily_cost_cap_usd>0),
 workspace_period_unrecovered_cost_cap_usd numeric(20,8) NOT NULL CHECK (workspace_period_unrecovered_cost_cap_usd>0)
);
CREATE UNIQUE INDEX loop_catalogue_versions_one_active ON morrow_work.loop_catalogue_versions (status) WHERE status='active';
CREATE TABLE morrow_work.loop_catalogue_entries (
 version integer NOT NULL REFERENCES morrow_work.loop_catalogue_versions(version),
 model_key text NOT NULL CHECK (model_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 effort_key text NOT NULL CHECK (effort_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 provider text NOT NULL CHECK (provider='anthropic'),
 provider_model_id text NOT NULL CHECK (provider_model_id ~ '^[a-z][a-z0-9-]{2,63}$'),
 max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 16000),
 input_usd12_per_token bigint NOT NULL CHECK (input_usd12_per_token>0),
 output_usd12_per_token bigint NOT NULL CHECK (output_usd12_per_token>0),
 cache_write_usd12_per_token bigint NOT NULL CHECK (cache_write_usd12_per_token>0),
 cache_read_usd12_per_token bigint NOT NULL CHECK (cache_read_usd12_per_token>0),
 worst_case_turn_usd numeric(20,8) NOT NULL CHECK (worst_case_turn_usd>0),
 PRIMARY KEY (version,model_key,effort_key)
);
INSERT INTO morrow_work.loop_catalogue_versions(version,status,digest,max_input_tokens_per_turn,max_turns_per_run,max_turns_per_coordinator_run,
 max_tool_calls_per_turn,max_tool_calls_per_run,max_questions_per_run,question_wait_hours,wall_time_minutes,run_cost_cap_usd,
 workspace_daily_cost_cap_usd,workspace_period_unrecovered_cost_cap_usd)
VALUES (2,'proposed','ffbbafa67164cdb0ab6095d9c27f747659606387e0cec08ff3b0930614d3d538',64000,16,6,4,40,2,72,30,7.00000000,25.00000000,4.50000000);
INSERT INTO morrow_work.loop_catalogue_entries(version,model_key,effort_key,provider,provider_model_id,max_output_tokens,input_usd12_per_token,
 output_usd12_per_token,cache_write_usd12_per_token,cache_read_usd12_per_token,worst_case_turn_usd)
SELECT 2,m.model_key,e.effort_key,'anthropic',m.provider_model_id,e.max_output_tokens,m.input,m.output,m.cache_write,m.cache_read,
 ceil((64000::numeric*m.cache_write+e.max_output_tokens::numeric*m.output)/10000)/100000000
FROM (VALUES ('claude_haiku_5_5','claude-haiku-5-5',100000::bigint,500000::bigint,125000::bigint,10000::bigint,1),
  ('claude_sonnet_5_5','claude-sonnet-5-5',2000000,10000000,2500000,200000,2),
  ('claude_opus_5_5','claude-opus-5-5',4000000,20000000,5000000,200000,3)) m(model_key,provider_model_id,input,output,cache_write,cache_read,o)
CROSS JOIN (VALUES ('low',5000,1),('medium',12000,2),('high',16000,3)) e(effort_key,max_output_tokens,o)
ORDER BY m.o,e.o;
-- ToolCatalogue@1 version 2 (docs/contracts/tool-catalogue.json, generated into
-- packages/policy/src/generated/tool-catalogue.ts; drift-tested): each tool's one capability
-- and verb, its replay class and the contexts it is offered in.
CREATE TABLE morrow_work.tool_catalogue_entries (
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
 tool text NOT NULL CHECK (tool ~ '^[a-z]+(\.[a-z]+)+$'),
 capability_id text NOT NULL CHECK (capability_id ~ '^[a-z]+(\.[a-z_]+)+$'),
 verb text NOT NULL CHECK (verb IN ('view','propose','execute','delegate')),
 replay_class text NOT NULL CHECK (replay_class IN ('read','internal_write','computer')),
 contexts text[] NOT NULL CHECK (cardinality(contexts) BETWEEN 1 AND 5
  AND contexts<@ARRAY['coordinator','routed','mandate','look_for_work','specialist']),
 PRIMARY KEY (version,tool)
);
INSERT INTO morrow_work.tool_catalogue_entries(version,tool,capability_id,verb,replay_class,contexts) VALUES
 (2,'knowledge.search','workspace.knowledge.read','view','read',ARRAY['coordinator','routed','mandate','look_for_work','specialist']),
 (2,'work.read','workspace.artifact.read','view','read',ARRAY['coordinator','routed','mandate','look_for_work','specialist']),
 (2,'products.read','catalog.products.read','view','read',ARRAY['routed','mandate','look_for_work','specialist']),
 (2,'inventory.read','inventory.levels.read','view','read',ARRAY['routed','mandate','look_for_work','specialist']),
 (2,'orders.summary','orders.read','view','read',ARRAY['routed','mandate','look_for_work']),
 (2,'support.thread.read','support.case.read','view','read',ARRAY['routed','mandate']),
 (2,'message.post','workspace.conversation.post','execute','internal_write',ARRAY['coordinator','routed','mandate','specialist']),
 (2,'inbox.ask','workspace.question.request','execute','internal_write',ARRAY['coordinator','routed','mandate','specialist']),
 (2,'task.create','workspace.task.create','execute','internal_write',ARRAY['coordinator','routed','mandate']),
 (2,'suggestion.create','workspace.comment.create','execute','internal_write',ARRAY['routed','mandate','look_for_work','specialist']),
 (2,'report.write','workspace.artifact.edit','execute','internal_write',ARRAY['routed','mandate','specialist']),
 (2,'agent.route','workspace.task.delegate','delegate','internal_write',ARRAY['coordinator']),
 (2,'specialist.draft','agents.builder.describe','execute','internal_write',ARRAY['coordinator']),
 (2,'proposal.listing','catalog.content.publish','propose','internal_write',ARRAY['routed','mandate','specialist']),
 (2,'proposal.reply','support.reply.send','propose','internal_write',ARRAY['routed','mandate']),
 (2,'plan.draft','workspace.conversation.post','execute','internal_write',ARRAY['coordinator']);

-- ---------------------------------------------------------------------------
-- Tenant tables. Every stored time is millisecond-truncated.
-- One agent run (agent-run@1). A routed run: a person's run of one installed agent on one
-- store, on the child task T' of the person's task T, under the delegation envelope on T and
-- the Coordinator's hop T -> T' (decideDelegation re-checks every tool call against them).
-- The manifest pins the release, the system text, the tool catalogue and offered tools, the
-- model profile, the caps and the hold; SQL keeps the counters every turn and tool call
-- checks. The current run lease changes once per answered question (the resume lease, whose
-- subject is the question). Status: queued -> running -> (waiting -> queued -> running)* ->
-- succeeded, failed or cancelled; a terminal run never changes. Content class none.
CREATE TABLE morrow_work.agent_runs (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 kind text NOT NULL CHECK (kind='routed'),
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
 status text NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelled')),
 ended_reason text CHECK (ended_reason IN ('completed','turn_limit','tool_call_limit','cost_budget','wall_time','deadline',
  'question_unanswered','invalid_output','refusal','spend_limit','provider_error','prefix_mismatch','stopped','lease_ended',
  'mandate_ended','task_closed','switch_off')),
 release_id text NOT NULL,
 release_revision morrow_work.revision NOT NULL,
 release_digest morrow_work.digest NOT NULL,
 manifest_canonical text NOT NULL,
 manifest_digest morrow_work.digest NOT NULL,
 system_text_digest morrow_work.digest NOT NULL,
 tool_catalogue_version integer NOT NULL,
 tool_catalogue_digest morrow_work.digest NOT NULL,
 tools text[] NOT NULL CHECK (cardinality(tools) BETWEEN 1 AND 32),
 catalogue_version integer NOT NULL,
 model_key text NOT NULL,
 effort_key text NOT NULL,
 turn_limit integer NOT NULL CHECK (turn_limit BETWEEN 1 AND 16),
 tool_calls_per_turn integer NOT NULL CHECK (tool_calls_per_turn BETWEEN 0 AND 4),
 tool_calls_per_run integer NOT NULL CHECK (tool_calls_per_run BETWEEN 0 AND 40),
 questions_limit integer NOT NULL CHECK (questions_limit BETWEEN 0 AND 2),
 max_input_tokens integer NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 64000),
 max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 16000),
 wall_time_ms integer NOT NULL CHECK (wall_time_ms BETWEEN 60000 AND 1800000 AND wall_time_ms%1000=0),
 worst_case_turn_usd numeric(20,8) NOT NULL CHECK (worst_case_turn_usd>0),
 hold_usd numeric(20,8) NOT NULL CHECK (hold_usd>=worst_case_turn_usd),
 booked_usd numeric(20,8) NOT NULL CHECK (booked_usd>=0 AND booked_usd<=hold_usd),
 overflow_usd numeric(20,8) NOT NULL CHECK (overflow_usd>=0),
 turns_taken integer NOT NULL CHECK (turns_taken BETWEEN 0 AND 16 AND turns_taken<=turn_limit),
 tool_calls_taken integer NOT NULL CHECK (tool_calls_taken BETWEEN 0 AND 40 AND tool_calls_taken<=tool_calls_per_run),
 questions_asked integer NOT NULL CHECK (questions_asked BETWEEN 0 AND 2 AND questions_asked<=questions_limit),
 active_ms bigint NOT NULL CHECK (active_ms>=0),
 segment_started_at timestamptz CHECK (segment_started_at=date_trunc('milliseconds',segment_started_at) AND isfinite(segment_started_at)),
 prefix_digest morrow_work.digest,
 tainted boolean NOT NULL,
 question_id morrow_work.record_id,
 period_start timestamptz NOT NULL CHECK (period_start=date_trunc('milliseconds',period_start) AND isfinite(period_start)),
 created_day date NOT NULL,
 request_digest morrow_work.digest NOT NULL,
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
 FOREIGN KEY (release_id,release_revision,release_digest) REFERENCES morrow_work.agent_releases(id,revision,digest),
 FOREIGN KEY (catalogue_version,model_key,effort_key) REFERENCES morrow_work.loop_catalogue_entries(version,model_key,effort_key),
 CONSTRAINT agent_runs_manifest CHECK (manifest_digest::text=morrow_work.sha256_text(manifest_canonical)
  AND morrow_work.agent_manifest_matches(manifest_canonical,organization_id,workspace_id,id,store_id,connection_id,child_task_id,installation_id,
   requester_principal_id,requester_membership_id,release_id,release_revision,release_digest,system_text_digest,tool_catalogue_version,
   tool_catalogue_digest,tools,catalogue_version,model_key,effort_key,turn_limit,tool_calls_per_turn,tool_calls_per_run,questions_limit,
   max_input_tokens,max_output_tokens,wall_time_ms,hold_usd,created_at)),
 CONSTRAINT agent_runs_status CHECK (CASE status
  WHEN 'queued' THEN ended_at IS NULL AND ended_reason IS NULL AND segment_started_at IS NULL AND question_id IS NULL
  WHEN 'running' THEN started_at IS NOT NULL AND ended_at IS NULL AND ended_reason IS NULL AND segment_started_at IS NOT NULL AND question_id IS NULL
  WHEN 'waiting' THEN started_at IS NOT NULL AND ended_at IS NULL AND ended_reason IS NULL AND segment_started_at IS NULL AND question_id IS NOT NULL
  WHEN 'succeeded' THEN ended_at IS NOT NULL AND ended_reason='completed' AND segment_started_at IS NULL
  ELSE ended_at IS NOT NULL AND ended_reason IS NOT NULL AND ended_reason<>'completed' AND segment_started_at IS NULL END),
 CONSTRAINT agent_runs_times CHECK (updated_at>=created_at AND (started_at IS NULL OR started_at>=created_at)
  AND (ended_at IS NULL OR ended_at>=created_at) AND task_id::text<>child_task_id::text
  AND created_day=(created_at AT TIME ZONE 'UTC')::date)
);
CREATE INDEX agent_runs_task ON morrow_work.agent_runs (organization_id,workspace_id,task_id,created_at,id);
CREATE INDEX agent_runs_open ON morrow_work.agent_runs (organization_id,workspace_id,created_at) WHERE status IN ('queued','running','waiting');
CREATE INDEX agent_runs_day ON morrow_work.agent_runs (organization_id,workspace_id,created_day);
CREATE INDEX agent_runs_queued ON morrow_work.agent_runs (created_at,id) WHERE status='queued';
-- One turn of one run (RunTurn@1; ADR-0027 item 7): the only place loop content lives. The
-- input (the request on turn 1, the previous reply's tool results after) is written by the
-- run's turn step under its lease, with its digest, before any send; the broker writes the
-- reply, the outcome, the usage and the conversation's digest after it in the transaction
-- that closes the turn's fence (so a paid reply is never lost); the tool steps append each
-- tool's result. Reasoning blocks are removed when the run ends (ADR-0027 item 7), and the
-- row expires 90 days after the run ends (ADR-0031 item 1). Content class workspace: the
-- person's request, Morrow's replies and tool results (no tool that reads a store's content
-- is composed until run_turns has its store-content cleanup handler; the brief's follow-up).
CREATE TABLE morrow_work.run_turns (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 turn integer NOT NULL CHECK (turn BETWEEN 1 AND 16),
 attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 2),
 input jsonb NOT NULL CHECK (morrow_work.loop_user_message_valid(input)),
 input_digest morrow_work.digest NOT NULL,
 untrusted boolean NOT NULL,
 output jsonb CHECK (output IS NULL OR morrow_work.loop_assistant_message_valid(output)),
 outcome text CHECK (outcome IN ('end_turn','tool_use','incomplete','refusal','invalid_output','spend_limit','provider_error','uncertain',
  'not_sent','input_over_cap','prefix_mismatch')),
 prefix_digest_before morrow_work.digest,
 prefix_digest_after morrow_work.digest,
 input_tokens bigint CHECK (input_tokens BETWEEN 0 AND 10000000),
 cache_write_tokens bigint CHECK (cache_write_tokens BETWEEN 0 AND 10000000),
 cache_read_tokens bigint CHECK (cache_read_tokens BETWEEN 0 AND 10000000),
 output_tokens bigint CHECK (output_tokens BETWEEN 0 AND 10000000),
 tool_results jsonb NOT NULL CHECK (morrow_work.loop_tool_results_valid(tool_results)),
 read_tags jsonb NOT NULL CHECK (morrow_work.valid_read_tags(read_tags)),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 expires_at timestamptz NOT NULL CHECK (expires_at=date_trunc('milliseconds',expires_at) AND isfinite(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,run_id,turn,attempt),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT run_turns_reply CHECK ((output IS NOT NULL)=(outcome IN ('end_turn','tool_use'))
  AND (output IS NOT NULL)=(prefix_digest_after IS NOT NULL)
  AND (input_tokens IS NULL)=(output_tokens IS NULL) AND (input_tokens IS NULL)=(cache_write_tokens IS NULL)
  AND (input_tokens IS NULL)=(cache_read_tokens IS NULL)
  AND (outcome IS NOT NULL OR (input_tokens IS NULL AND prefix_digest_before IS NULL))
  AND (jsonb_array_length(tool_results)=0 OR outcome='tool_use')),
 CONSTRAINT run_turns_times CHECK (updated_at>=created_at AND expires_at>=created_at+interval '90 days')
);
-- One tool call (RunToolCall@1): ids, codes and digests only (the input and the result live
-- in run_turns). Born started when the call's step begins (that counts the call); finished
-- once, with its outcome, refusal, result digest and size, and the first record an internal
-- write made (returned again on replay). Content class none; 365 days.
CREATE TABLE morrow_work.run_tool_calls (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 tool_use_id text NOT NULL CHECK (tool_use_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 turn integer NOT NULL CHECK (turn BETWEEN 1 AND 16),
 ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 3),
 tool text NOT NULL CHECK (tool ~ '^[a-z]+(\.[a-z]+)+$'),
 capability_id text NOT NULL CHECK (capability_id ~ '^[a-z]+(\.[a-z_]+)+$'),
 verb text NOT NULL CHECK (verb IN ('view','propose','approve','execute','delegate','administer')),
 replay_class text NOT NULL CHECK (replay_class IN ('read','internal_write','computer')),
 input_digest morrow_work.digest NOT NULL,
 outcome text CHECK (outcome IN ('ok','refused','invalid_input','tool_outcome_unknown','computer_unavailable')),
 refusal text CHECK (refusal IN ('not_offered','lease_ended','run_closed','deadline_passed','task_closed','release_revoked','switch_off',
  'stopped','input_invalid','id_out_of_scope','authority_denied','budget_exhausted','tool_call_limit','question_limit','route_used',
  'report_in_turn','result_too_large','sender_inactive','sender_not_usable')),
 result_digest morrow_work.digest,
 result_bytes integer CHECK (result_bytes BETWEEN 0 AND 8192),
 record_kind text CHECK (record_kind IN ('message','question','task','suggestion','artifact','proposal','specialist_spec')),
 record_id morrow_work.record_id,
 started_at timestamptz NOT NULL CHECK (started_at=date_trunc('milliseconds',started_at) AND started_at>=timestamptz '2000-01-01T00:00:00Z' AND started_at<timestamptz '9000-01-01T00:00:00Z'),
 finished_at timestamptz CHECK (finished_at=date_trunc('milliseconds',finished_at) AND isfinite(finished_at)),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (organization_id,workspace_id,run_id,tool_use_id),
 UNIQUE (organization_id,workspace_id,run_id,turn,ordinal),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT run_tool_calls_outcome CHECK (CASE WHEN outcome IS NULL THEN refusal IS NULL AND result_digest IS NULL AND result_bytes IS NULL
   AND finished_at IS NULL AND record_kind IS NULL AND record_id IS NULL
  WHEN outcome='refused' THEN refusal IS NOT NULL AND refusal<>'input_invalid' AND finished_at IS NOT NULL
  WHEN outcome='invalid_input' THEN refusal='input_invalid' AND finished_at IS NOT NULL
  ELSE refusal IS NULL AND finished_at IS NOT NULL END
  AND (record_kind IS NULL)=(record_id IS NULL) AND (result_digest IS NULL)=(result_bytes IS NULL)
  AND (outcome IS NULL OR result_digest IS NOT NULL)),
 CONSTRAINT run_tool_calls_times CHECK ((finished_at IS NULL OR finished_at>=started_at) AND expires_at=started_at+interval '365 days')
);
-- One model call of one turn (the broker's turn fence and the traceRef target): keyed by the
-- turn, the attempt (an uncertain turn is sent again at most once, ADR-0027 item 4) and the
-- sequence (a resend after a provider throttle reuses the attempt). At most one call of a run
-- is open. The broker opens it before any provider request and closes it with the outcome,
-- the counted usage, the booked cost and the provider's request and model ids (never granted
-- to the api role). Content-free.
CREATE TABLE morrow_work.agent_model_calls (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 run_id morrow_work.record_id NOT NULL,
 turn integer NOT NULL CHECK (turn BETWEEN 1 AND 16),
 attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 2),
 sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 8),
 final boolean NOT NULL,
 status text NOT NULL CHECK (status IN ('started','closed')),
 outcome text CHECK (outcome IN ('end_turn','tool_use','incomplete','refusal','invalid_output','spend_limit','provider_error','uncertain',
  'not_sent','input_over_cap')),
 counted boolean,
 raw_stop_reason text CHECK (raw_stop_reason ~ '^[a-z_]{1,32}$'),
 provider_request_id text CHECK (provider_request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 provider_model_id text CHECK (provider_model_id ~ '^[A-Za-z0-9._-]{1,128}$'),
 counted_input_tokens integer CHECK (counted_input_tokens BETWEEN 0 AND 1000000),
 input_tokens bigint CHECK (input_tokens BETWEEN 0 AND 10000000),
 cache_write_tokens bigint CHECK (cache_write_tokens BETWEEN 0 AND 10000000),
 cache_read_tokens bigint CHECK (cache_read_tokens BETWEEN 0 AND 10000000),
 output_tokens bigint CHECK (output_tokens BETWEEN 0 AND 10000000),
 cost_usd numeric(20,8) CHECK (cost_usd>=0),
 overflow_usd numeric(20,8) CHECK (overflow_usd>=0),
 budget_ms integer NOT NULL CHECK (budget_ms BETWEEN 1000 AND 600000),
 started_at timestamptz NOT NULL CHECK (started_at=date_trunc('milliseconds',started_at) AND started_at>=timestamptz '2000-01-01T00:00:00Z' AND started_at<timestamptz '9000-01-01T00:00:00Z'),
 closed_at timestamptz CHECK (closed_at=date_trunc('milliseconds',closed_at) AND isfinite(closed_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,run_id,turn,attempt,sequence),
 FOREIGN KEY (organization_id,workspace_id,run_id,turn,attempt) REFERENCES morrow_work.run_turns(organization_id,workspace_id,run_id,turn,attempt),
 CONSTRAINT agent_model_calls_state CHECK (CASE status WHEN 'started' THEN outcome IS NULL AND counted IS NULL AND closed_at IS NULL
   AND cost_usd IS NULL AND overflow_usd IS NULL AND provider_request_id IS NULL AND provider_model_id IS NULL AND raw_stop_reason IS NULL
   AND input_tokens IS NULL AND output_tokens IS NULL AND cache_write_tokens IS NULL AND cache_read_tokens IS NULL
  ELSE outcome IS NOT NULL AND counted IS NOT NULL AND closed_at IS NOT NULL AND closed_at>=started_at
   AND counted=(outcome IN ('end_turn','tool_use','incomplete','refusal','invalid_output','uncertain') OR (outcome='provider_error' AND input_tokens IS NOT NULL))
   AND counted=(cost_usd IS NOT NULL) END)
);
CREATE UNIQUE INDEX agent_model_calls_one_open ON morrow_work.agent_model_calls (organization_id,workspace_id,run_id) WHERE status='started';
-- One inbox.ask question of a run and the requester's answer (ADR-0027 item 1: at most two
-- per run; 72 hours unanswered ends the run). Content class workspace: the question Morrow's
-- agent wrote and the answer the person wrote. Answered once, by the run's requester only
-- (cmd_agent_run_answer), which opens the resume lease (its subject is the question).
CREATE TABLE morrow_work.agent_run_questions (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 run_id morrow_work.record_id NOT NULL,
 tool_use_id text NOT NULL CHECK (tool_use_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 500),
 choices jsonb NOT NULL CHECK (morrow_work.loop_choices_valid(choices)),
 status text NOT NULL CHECK (status IN ('open','answered','expired','cancelled')),
 answer text CHECK (char_length(answer) BETWEEN 1 AND 2000),
 answered_by_principal_id morrow_work.record_id,
 answered_by_membership_id morrow_work.record_id,
 resume_lease_id morrow_work.record_id,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 answer_by timestamptz NOT NULL,
 answered_at timestamptz CHECK (answered_at=date_trunc('milliseconds',answered_at) AND isfinite(answered_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,run_id,tool_use_id),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT agent_run_questions_status CHECK ((status='answered')=(answer IS NOT NULL) AND (status='answered')=(answered_at IS NOT NULL)
  AND (status='answered')=(answered_by_principal_id IS NOT NULL) AND (status='answered')=(answered_by_membership_id IS NOT NULL)
  AND (status='answered')=(resume_lease_id IS NOT NULL) AND (answered_at IS NULL OR answered_at>=created_at)),
 CONSTRAINT agent_run_questions_window CHECK (answer_by=created_at+interval '72 hours')
);

-- ---------------------------------------------------------------------------
-- Row security. Every new table: ENABLE + FORCE and the maintenance-only owner policy.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['loop_catalogue_versions','loop_catalogue_entries','tool_catalogue_entries','agent_runs','run_turns',
  'run_tool_calls','agent_model_calls','agent_run_questions'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['loop_catalogue_versions','loop_catalogue_entries','tool_catalogue_entries'] LOOP
  EXECUTE format('CREATE POLICY platform_command_read ON morrow_work.%I FOR SELECT TO morrow_work_command USING (true)',t);
 END LOOP;
 -- The session context (admission, the answer and the stale-run close) and its lease twin
 -- (the run steps) on every run table.
 FOREACH t IN ARRAY ARRAY['agent_runs','run_turns','run_tool_calls','agent_model_calls','agent_run_questions'] LOOP
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('CREATE POLICY tenant_lease ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
 END LOOP;
 -- The api reads its tenant's agent runs column by column (ids, codes, counts and amounts).
 EXECUTE 'CREATE POLICY tenant_read ON morrow_work.agent_runs FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))';
 -- The broker's two turn definers (morrow_vault, below) reach exactly the run (and call)
 -- they name through transaction-local settings they write themselves before reading and
 -- clear after, only while the session user is the broker's login (0038's idiom). They write
 -- the reply into the run's own turn row, so the reply and the fence close commit together.
 EXECUTE 'CREATE POLICY broker_agent_run ON morrow_work.agent_runs TO morrow_work_command
   USING (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text||''|''||id::text=pg_catalog.current_setting(''morrow.vault_agent_run'',true))
   WITH CHECK (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text||''|''||id::text=pg_catalog.current_setting(''morrow.vault_agent_run'',true))';
 EXECUTE 'CREATE POLICY broker_agent_turn ON morrow_work.run_turns TO morrow_work_command
   USING (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text||''|''||run_id::text=pg_catalog.current_setting(''morrow.vault_agent_run'',true))
   WITH CHECK (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text||''|''||run_id::text=pg_catalog.current_setting(''morrow.vault_agent_run'',true))';
 EXECUTE 'CREATE POLICY broker_agent_call ON morrow_work.agent_model_calls TO morrow_work_command
   USING (session_user=''morrow_vault_broker'' AND (organization_id::text||''|''||workspace_id::text||''|''||run_id::text=pg_catalog.current_setting(''morrow.vault_agent_run'',true)
    OR id::text=pg_catalog.current_setting(''morrow.vault_agent_call'',true)))
   WITH CHECK (session_user=''morrow_vault_broker'' AND organization_id::text||''|''||workspace_id::text||''|''||run_id::text=pg_catalog.current_setting(''morrow.vault_agent_run'',true))';
 -- The orchestrator's cron lists queued agent runs (ids only, agent_run_pending_starts) and
 -- a Workflow finds its run's current lease (agent_run_resume_lease): the runtime login reads
 -- queued and running runs only, as lease_pending (0020) shows it unstarted leases.
 EXECUTE 'CREATE POLICY runtime_agent_open ON morrow_work.agent_runs FOR SELECT TO morrow_work_command
   USING (session_user=''morrow_runtime_executor'' AND status IN (''queued'',''running''))';
END $$;

-- Privileges: table SELECT and INSERT, column-scoped UPDATE, never DELETE or TRUNCATE.
GRANT SELECT ON morrow_work.loop_catalogue_versions,morrow_work.loop_catalogue_entries,morrow_work.tool_catalogue_entries TO morrow_work_command;
GRANT SELECT,INSERT ON morrow_work.agent_runs,morrow_work.run_turns,morrow_work.run_tool_calls,morrow_work.agent_model_calls,
 morrow_work.agent_run_questions TO morrow_work_command;
GRANT UPDATE (revision,status,ended_reason,lease_id,lease_generation,booked_usd,overflow_usd,turns_taken,tool_calls_taken,questions_asked,
 active_ms,segment_started_at,prefix_digest,tainted,question_id,started_at,ended_at,updated_at) ON morrow_work.agent_runs TO morrow_work_command;
GRANT UPDATE (output,outcome,prefix_digest_before,prefix_digest_after,input_tokens,cache_write_tokens,cache_read_tokens,output_tokens,
 tool_results,updated_at,expires_at) ON morrow_work.run_turns TO morrow_work_command;
GRANT UPDATE (outcome,refusal,result_digest,result_bytes,record_kind,record_id,finished_at) ON morrow_work.run_tool_calls TO morrow_work_command;
GRANT UPDATE (status,outcome,counted,raw_stop_reason,provider_request_id,provider_model_id,counted_input_tokens,input_tokens,
 cache_write_tokens,cache_read_tokens,output_tokens,cost_usd,overflow_usd,closed_at) ON morrow_work.agent_model_calls TO morrow_work_command;
GRANT UPDATE (status,answer,answered_by_principal_id,answered_by_membership_id,resume_lease_id,answered_at)
 ON morrow_work.agent_run_questions TO morrow_work_command;
GRANT SELECT (organization_id,workspace_id,id,revision,kind,task_id,child_task_id,store_id,connection_id,installation_id,status,ended_reason,
 catalogue_version,model_key,effort_key,turn_limit,hold_usd,booked_usd,turns_taken,tool_calls_taken,questions_asked,requester_principal_id,
 requester_membership_id,created_at,started_at,ended_at,updated_at) ON morrow_work.agent_runs TO morrow_work_api;

-- ---------------------------------------------------------------------------
-- Triggers: INVOKER, owned by the owner, granted to nobody.
-- Agent runs: born queued at revision 1 with zero counters and no reply digest; afterwards
-- revision+1, never back-dated; only the status, its end, the current lease (on an answer),
-- the counters, the hold's bookings, the wall-time segment, the conversation's digest, the
-- taint and the open question change; counters, bookings and active time only grow; the
-- taint is never cleared; the edges are queued -> running, running -> waiting, waiting ->
-- queued (with a new lease) and any open status -> a terminal one; a terminal run never
-- changes.
CREATE FUNCTION morrow_work.agent_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','status','ended_reason','lease_id','lease_generation','booked_usd','overflow_usd','turns_taken',
 'tool_calls_taken','questions_asked','active_ms','segment_started_at','prefix_digest','tainted','question_id','started_at','ended_at','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>'queued' OR NEW.booked_usd<>0 OR NEW.overflow_usd<>0 OR NEW.turns_taken<>0 OR NEW.tool_calls_taken<>0
   OR NEW.questions_asked<>0 OR NEW.active_ms<>0 OR NEW.prefix_digest IS NOT NULL OR NEW.tainted OR NEW.question_id IS NOT NULL
   OR NEW.started_at IS NOT NULL OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status IN ('succeeded','failed','cancelled') OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.booked_usd<OLD.booked_usd OR NEW.overflow_usd<OLD.overflow_usd OR NEW.turns_taken<OLD.turns_taken
  OR NEW.tool_calls_taken<OLD.tool_calls_taken OR NEW.questions_asked<OLD.questions_asked OR NEW.active_ms<OLD.active_ms
  OR (OLD.tainted AND NOT NEW.tainted)
  OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
  OR ((NEW.lease_id,NEW.lease_generation) IS DISTINCT FROM (OLD.lease_id,OLD.lease_generation) AND NOT (OLD.status='waiting' AND NEW.status='queued'))
  OR (NEW.prefix_digest IS DISTINCT FROM OLD.prefix_digest AND (OLD.status<>'running' OR NEW.prefix_digest IS NULL))
  OR (NEW.status<>OLD.status AND NOT ((OLD.status='queued' AND NEW.status='running') OR (OLD.status='running' AND NEW.status='waiting')
   OR (OLD.status='waiting' AND NEW.status='queued') OR NEW.status IN ('succeeded','failed','cancelled')))
  OR (NEW.status=OLD.status AND NEW.status<>'running' AND (NEW.booked_usd,NEW.overflow_usd,NEW.turns_taken,NEW.tool_calls_taken,NEW.questions_asked)
   IS DISTINCT FROM (OLD.booked_usd,OLD.overflow_usd,OLD.turns_taken,OLD.tool_calls_taken,OLD.questions_asked)) THEN
  RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Run turns: born with the input only (no reply, outcome, usage or digests, no tool
-- results). The reply, its outcome, usage and the digests are set once (the broker's close,
-- or the uncertain close); tool results only grow, one block at a time, after a tool_use
-- reply; the one later change of a reply is the run end's removal of its reasoning blocks;
-- the expiry only moves later. The input never changes.
CREATE FUNCTION morrow_work.run_turn_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['output','outcome','prefix_digest_before','prefix_digest_after','input_tokens','cache_write_tokens',
 'cache_read_tokens','output_tokens','tool_results','updated_at','expires_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.output IS NOT NULL OR NEW.outcome IS NOT NULL OR NEW.prefix_digest_before IS NOT NULL OR NEW.prefix_digest_after IS NOT NULL
   OR NEW.input_tokens IS NOT NULL OR NEW.tool_results<>'[]'::jsonb OR NEW.updated_at<>NEW.created_at
   OR NEW.input_digest::text !~ '^[a-f0-9]{64}$' THEN
   RAISE EXCEPTION 'WORK_RUN_TURN_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) OR NEW.updated_at<OLD.updated_at
  OR NEW.expires_at<OLD.expires_at
  -- The close: from no outcome to one, its reply, usage and digests with it.
  OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.prefix_digest_before IS DISTINCT FROM OLD.prefix_digest_before
   OR NEW.prefix_digest_after IS DISTINCT FROM OLD.prefix_digest_after OR (NEW.input_tokens,NEW.cache_write_tokens,NEW.cache_read_tokens,NEW.output_tokens)
   IS DISTINCT FROM (OLD.input_tokens,OLD.cache_write_tokens,OLD.cache_read_tokens,OLD.output_tokens)))
  OR (OLD.outcome IS NULL AND NEW.tool_results<>'[]'::jsonb)
  -- The reply: set with the close; afterwards only its reasoning blocks are removed.
  OR (OLD.outcome IS NOT NULL AND NEW.output IS DISTINCT FROM OLD.output AND (OLD.output IS NULL OR NEW.output IS DISTINCT FROM
   jsonb_build_object('role','assistant','content',COALESCE((SELECT jsonb_agg(b ORDER BY o) FROM jsonb_array_elements(OLD.output->'content')
    WITH ORDINALITY q(b,o) WHERE b->>'type'<>'reasoning'),'[{"type":"text","text":"[reasoning removed]"}]'::jsonb))))
  -- Tool results: one more block at a time, the earlier ones unchanged.
  OR (NEW.tool_results<>OLD.tool_results AND (jsonb_array_length(NEW.tool_results)<>jsonb_array_length(OLD.tool_results)+1
   OR NEW.tool_results-(-1)<>OLD.tool_results)) THEN
  RAISE EXCEPTION 'WORK_RUN_TURN_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Tool calls: born started (no outcome); finished once; nothing else changes.
CREATE FUNCTION morrow_work.run_tool_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['outcome','refusal','result_digest','result_bytes','record_kind','record_id','finished_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.outcome IS NOT NULL THEN RAISE EXCEPTION 'WORK_RUN_TOOL_CALL_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) THEN
  RAISE EXCEPTION 'WORK_RUN_TOOL_CALL_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Model calls: born started; the one change is the close, with its outcome and record.
CREATE FUNCTION morrow_work.agent_model_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['status','outcome','counted','raw_stop_reason','provider_request_id','provider_model_id','counted_input_tokens',
 'input_tokens','cache_write_tokens','cache_read_tokens','output_tokens','cost_usd','overflow_usd','closed_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'started' THEN RAISE EXCEPTION 'WORK_AGENT_MODEL_CALL_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'started' OR NEW.status<>'closed' OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) THEN
  RAISE EXCEPTION 'WORK_AGENT_MODEL_CALL_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Questions: born open; answered (once, with the answer, the answerer and the resume
-- lease), expired or cancelled once; nothing else changes.
CREATE FUNCTION morrow_work.agent_run_question_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['status','answer','answered_by_principal_id','answered_by_membership_id','resume_lease_id','answered_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'open' THEN RAISE EXCEPTION 'WORK_AGENT_QUESTION_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'open' OR NEW.status='open' OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) THEN
  RAISE EXCEPTION 'WORK_AGENT_QUESTION_INVALID';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_work.agent_run_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_turn_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_tool_call_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.agent_model_call_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.agent_run_question_guard() FROM PUBLIC;
CREATE TRIGGER agent_run_guard BEFORE INSERT OR UPDATE ON morrow_work.agent_runs FOR EACH ROW EXECUTE FUNCTION morrow_work.agent_run_guard();
CREATE TRIGGER run_turn_guard BEFORE INSERT OR UPDATE ON morrow_work.run_turns FOR EACH ROW EXECUTE FUNCTION morrow_work.run_turn_guard();
CREATE TRIGGER run_tool_call_guard BEFORE INSERT OR UPDATE ON morrow_work.run_tool_calls FOR EACH ROW EXECUTE FUNCTION morrow_work.run_tool_call_guard();
CREATE TRIGGER agent_model_call_guard BEFORE INSERT OR UPDATE ON morrow_work.agent_model_calls FOR EACH ROW EXECUTE FUNCTION morrow_work.agent_model_call_guard();
CREATE TRIGGER agent_run_question_guard BEFORE INSERT OR UPDATE ON morrow_work.agent_run_questions FOR EACH ROW EXECUTE FUNCTION morrow_work.agent_run_question_guard();
-- No DELETE or TRUNCATE on any new table (the retention sweep is the owner's).
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['loop_catalogue_versions','loop_catalogue_entries','tool_catalogue_entries','agent_runs','run_turns','run_tool_calls',
  'agent_model_calls','agent_run_questions'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Revisable owner helpers: INVOKER, owned by the owner (a later owner migration may replace
-- them), EXECUTE for the command role only. They run under the caller's policies (session,
-- lease or the broker's settings) and take no actor.
-- The worst case of one open call that outlived its broker budget (plus a minute) is booked
-- (ADR-0027 item 4 and build-plan invariant 10: an unknown outcome is never free): the fence
-- closes as uncertain, counted, its turn's outcome is uncertain, and the run's hold carries
-- the worst-case turn (what it cannot hold is overflow). A call already closed is left
-- alone. Outcomes: closed, not_open, invalid.
CREATE FUNCTION morrow_work.agent_turn_close_uncertain(p_org text,p_ws text,p_call_id text)
RETURNS TABLE(outcome text,booked_usd text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE c record; r record; v_now timestamptz; v_booked numeric(20,8); v_overflow numeric(20,8); n integer;
BEGIN
 IF p_org IS NULL OR p_ws IS NULL OR p_call_id IS NULL OR p_call_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT x.run_id::text AS run_id,x.turn,x.attempt,x.status INTO c FROM morrow_work.agent_model_calls x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_call_id;
 IF NOT FOUND OR c.status<>'started' THEN RETURN QUERY SELECT 'not_open'::text,NULL::text; RETURN; END IF;
 SELECT x.hold_usd,x.booked_usd,x.worst_case_turn_usd INTO r FROM morrow_work.agent_runs x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=c.run_id;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 v_booked:=least(r.worst_case_turn_usd,greatest(r.hold_usd-r.booked_usd,0));
 v_overflow:=r.worst_case_turn_usd-v_booked;
 UPDATE morrow_work.agent_model_calls x SET status='closed',outcome='uncertain',counted=true,cost_usd=r.worst_case_turn_usd,
  overflow_usd=CASE WHEN v_overflow>0 THEN v_overflow ELSE NULL END,closed_at=greatest(v_now,x.started_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_call_id;
 UPDATE morrow_work.run_turns t SET outcome='uncertain',updated_at=greatest(v_now,t.updated_at)
  WHERE t.organization_id=p_org AND t.workspace_id=p_ws AND t.run_id=c.run_id AND t.turn=c.turn AND t.attempt=c.attempt AND t.outcome IS NULL;
 UPDATE morrow_work.agent_runs x SET booked_usd=x.booked_usd+v_booked,overflow_usd=x.overflow_usd+v_overflow,revision=x.revision+1,
  updated_at=greatest(v_now,x.updated_at) WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=c.run_id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 RETURN QUERY SELECT 'closed'::text,to_char(r.worst_case_turn_usd,'FM999999999990.00000000');
END $$;
-- Ends one open run (queued, running or waiting) with a terminal status and its reason:
-- every reply's reasoning blocks are removed (ADR-0027 item 7), every turn of the run
-- expires 90 days after the end (ADR-0031 item 1), an open question is cancelled (or
-- expired past its 72 hours), the active time is closed, the envelope and the hop are
-- revoked. The caller holds the run's lock and has closed every open call. Outcomes: ended
-- (with the status), invalid.
CREATE FUNCTION morrow_work.agent_run_end(p_org text,p_ws text,p_run_id text,p_status text,p_reason text)
RETURNS TABLE(outcome text,status text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; v_now timestamptz; n integer;
BEGIN
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_run_id;
 IF NOT FOUND OR r.status NOT IN ('queued','running','waiting') OR p_status NOT IN ('succeeded','failed','cancelled')
  OR (p_status='succeeded')<>(p_reason='completed') OR p_reason IS NULL THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM morrow_work.agent_model_calls x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.run_id=p_run_id
   AND x.status='started') THEN RAISE EXCEPTION 'WORK_AGENT_RUN_CALL_OPEN'; END IF;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 UPDATE morrow_work.run_turns t SET output=CASE WHEN t.output IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.output->'content') b
    WHERE b->>'type'='reasoning') THEN jsonb_build_object('role','assistant','content',COALESCE((SELECT jsonb_agg(b ORDER BY o)
    FROM jsonb_array_elements(t.output->'content') WITH ORDINALITY q(b,o) WHERE b->>'type'<>'reasoning'),
    '[{"type":"text","text":"[reasoning removed]"}]'::jsonb)) ELSE t.output END,
  expires_at=greatest(t.expires_at,v_now+interval '90 days'),updated_at=greatest(v_now,t.updated_at)
  WHERE t.organization_id=p_org AND t.workspace_id=p_ws AND t.run_id=p_run_id;
 UPDATE morrow_work.agent_run_questions q SET status=CASE WHEN q.answer_by<=v_now THEN 'expired' ELSE 'cancelled' END
  WHERE q.organization_id=p_org AND q.workspace_id=p_ws AND q.run_id=p_run_id AND q.status='open';
 UPDATE morrow_work.agent_runs x SET status=p_status,ended_reason=p_reason,ended_at=greatest(v_now,x.created_at),
  active_ms=x.active_ms+CASE WHEN x.segment_started_at IS NULL THEN 0 ELSE greatest((extract(epoch FROM v_now-x.segment_started_at)*1000)::bigint,0) END,
  segment_started_at=NULL,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_run_id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 UPDATE morrow_work.work_envelopes x SET revoked_at=greatest(v_now,x.created_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.envelope_id AND x.revoked_at IS NULL;
 UPDATE morrow_work.delegation_hops x SET revoked_at=greatest(v_now,x.created_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.hop_id AND x.revoked_at IS NULL;
 RETURN QUERY SELECT 'ended'::text,p_status;
END $$;
-- The stale agent-run close (ADR-0027 item 1: the approved stale-run sweep extends to
-- agent-run@1): a queued or running run whose run lease a stop revoked or whose 30-minute
-- lease ended has no lease left in which to finish, and a waiting run whose question went
-- 72 hours unanswered (or whose store or installation a stop blocks) will never resume, so
-- the workspace's own session context closes them: open calls are booked as uncertain at
-- their worst case, and the run ends (stopped, lease_ended or question_unanswered). The
-- caller holds the workspace stream (its prelude); a run whose lock is held is skipped and
-- the next close takes it. At most 25 per call, oldest first. Returns the number closed.
CREATE FUNCTION morrow_work.agent_runs_close_stale(p_org text,p_ws text) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE r record; c record; e record; v_closed integer:=0; v_reason text;
BEGIN
 FOR r IN SELECT x.id::text AS id,x.status,x.connection_id::text AS connection_id,x.installation_id::text AS installation_id,
   l.status AS lease_status,l.revoked_reason,l.expires_at,q.answer_by
   FROM morrow_work.agent_runs x JOIN morrow_work.work_leases l ON l.organization_id=x.organization_id AND l.workspace_id=x.workspace_id AND l.id=x.lease_id
   LEFT JOIN morrow_work.agent_run_questions q ON q.organization_id=x.organization_id AND q.workspace_id=x.workspace_id AND q.id=x.question_id
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.status IN ('queued','running','waiting')
    AND CASE WHEN x.status='waiting' THEN q.answer_by<=pg_catalog.clock_timestamp()
      OR morrow_work.stop_active(p_org,p_ws,'run',x.connection_id,x.installation_id)
     ELSE l.status<>'active' OR l.expires_at<=pg_catalog.clock_timestamp() END
   ORDER BY x.created_at,x.id LIMIT 25 LOOP
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.agent_run',p_org,p_ws,r.id)::text,0)) THEN
   CONTINUE;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM morrow_work.agent_runs x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.id
    AND x.status=r.status) THEN
   CONTINUE;
  END IF;
  FOR c IN SELECT x.id::text AS id FROM morrow_work.agent_model_calls x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.run_id=r.id
    AND x.status='started' LOOP
   PERFORM morrow_work.agent_turn_close_uncertain(p_org,p_ws,c.id);
  END LOOP;
  v_reason:=CASE WHEN r.status='waiting' AND r.answer_by<=pg_catalog.clock_timestamp() THEN 'question_unanswered'
   WHEN r.status='waiting' OR (r.lease_status='revoked' AND r.revoked_reason='stop') THEN 'stopped' ELSE 'lease_ended' END;
  SELECT * INTO e FROM morrow_work.agent_run_end(p_org,p_ws,r.id,CASE WHEN v_reason='question_unanswered' THEN 'failed' ELSE 'cancelled' END,v_reason);
  IF e.outcome IS DISTINCT FROM 'ended' THEN RAISE EXCEPTION 'WORK_AGENT_RUN_CLOSE_FAILED'; END IF;
  v_closed:=v_closed+1;
 END LOOP;
 RETURN v_closed;
END $$;
REVOKE ALL ON FUNCTION morrow_work.agent_turn_close_uncertain(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.agent_run_end(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.agent_runs_close_stale(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.agent_turn_close_uncertain(text,text,text),morrow_work.agent_run_end(text,text,text,text,text),
 morrow_work.agent_runs_close_stale(text,text) TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- The command role's INVOKER helper (owned by it, granted to nobody): the entered run
-- lease's agent run, locked. The run is the lease's subject (its first lease) or the
-- subject's prefix before ':' (a resume lease's subject is `<run>:r<n>`), and the run's
-- current lease must be exactly the entered one. Zero rows otherwise.
CREATE FUNCTION morrow_work.agent_run_entered()
RETURNS TABLE(organization_id text,workspace_id text,run_id text,lease_id text,expires_at timestamptz)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record; v_run text;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' THEN RETURN; END IF;
 v_run:=split_part(l.subject_id,':',1);
 IF v_run !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.agent_run',l.organization_id,
  l.workspace_id,v_run)::text,0));
 IF NOT EXISTS(SELECT 1 FROM morrow_work.agent_runs x WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=v_run
   AND x.lease_id=l.lease_id AND x.lease_generation=l.generation) THEN
  RETURN;
 END IF;
 RETURN QUERY SELECT l.organization_id,l.workspace_id,v_run,l.lease_id,l.expires_at;
END $$;

-- ---------------------------------------------------------------------------
-- API functions: SECURITY DEFINER, owned by the command role after the transfer below,
-- EXECUTE for morrow_work_api only. Tenant and actor come only from current_tenant(). The
-- Worker replays both commands first through 0038's begin_run_command (run.admit) and
-- 0015's begin_command (question.answer).
-- Agent-run admission (ADR-0027 items 1, 6 and 12), after the Worker built and validated
-- the AgentRunManifest@1 (offered tools: the release's declared tools within the routed
-- context and this build's available tools; the installation's model profile) and the
-- human kernel allowed the requester. One transaction under the P06.T01a prelude. Rechecked
-- here: the parent task T is the actor's own and open; the store's association is current,
-- no stop blocks a run on it, and the named installation is active on that store and
-- connection with a published release; the loop catalogue's version is active and the
-- entry exists; every tool is in the tool catalogue with the routed context. Derived here,
-- never taken from the request: the caps and the hold (the turn limit is the version's,
-- lowered so that it times the entry's worst-case turn fits the run backstop; the hold the
-- lower of that product and the backstop; refused cap_below_turn under one worst-case
-- turn), the envelope's capabilities and verbs (exactly the tools' pairs), the workspace's
-- active Morrow-direct billing account, its operator test entitlement (before the rate card
-- no other entitlement admits a loop run, ADR-0027 item 6) and billing period, the
-- Coordinator's principal and its grant. Then, in order: the workspace's stale agent runs
-- close; the daily backstop (today's listings reservations and overflow, today's agent runs'
-- holds or bookings, and this hold) and the period's unrecovered cost (listings' plus every
-- loop run's, and this hold), under listings' run_reserve interlock; the run lease
-- (lease_open, refused under any stop); child task T' (draft -> ready, owned by the actor);
-- the envelope on T (the actor as requester and authorizer; 24 hours; depth 1, one child);
-- the Coordinator's workspace.task.delegate {delegate} grant on T; the hop T -> T'; the run
-- with its manifest (its CHECK proves the canonical text is exactly the run's); the task
-- events; the command. Outcomes: applied, invalid, ineligible, stale_authority,
-- command_conflict, not_found, state_conflict, stopped, denied, catalogue_inactive,
-- entry_not_offered, cap_below_turn, entitlement, no_billing_period, daily_backstop,
-- unrecovered_cost_cap. Every non-applied outcome is returned for rollback.
CREATE FUNCTION morrow_work.cmd_agent_run_admit(p_command_id text,p_request_digest text,p_correlation_id text,p_task_id text,p_store_id text,
 p_installation_id text,p_run_id text,p_child_task_id text,p_envelope_id text,p_hop_id text,p_coordinator_principal_id text,p_grant_id text,
 p_catalogue_version text,p_model text,p_effort text,p_tools text,p_tool_catalogue_version text,p_tool_catalogue_digest text,
 p_system_text_digest text,p_manifest_canonical text,p_admitted_at text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; k record; s record; i record; v record; e record; a record; snap record; per record; l record; c record; g record; rel record;
 v_policy bigint; v_now timestamptz; v_admitted timestamptz; v_until timestamptz; v_tools text[]; v_caps text[]; v_verbs text[];
 v_turn_limit integer; v_hold numeric(20,8); v_today numeric; v_unrecovered numeric; v_scope jsonb; v_grant jsonb; v_actor jsonb;
 v_result jsonb; v_child_envelope text; v_day date;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_task_id IS NULL OR p_task_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_run_id IS NULL OR p_run_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_child_task_id IS NULL OR p_child_task_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_envelope_id IS NULL OR p_envelope_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_hop_id IS NULL OR p_hop_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_coordinator_principal_id IS NULL OR p_coordinator_principal_id !~ '^agent_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_grant_id IS NULL OR p_grant_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_catalogue_version IS NULL OR p_catalogue_version !~ '^[1-9][0-9]{0,2}$'
  OR p_model IS NULL OR p_model !~ '^[a-z][a-z0-9_]{0,39}$' OR p_effort IS NULL OR p_effort !~ '^[a-z][a-z0-9_]{0,39}$'
  OR p_tools IS NULL OR octet_length(p_tools)>2048 OR NOT pg_input_is_valid(p_tools,'jsonb')
  OR p_tool_catalogue_version IS NULL OR p_tool_catalogue_version !~ '^[1-9][0-9]{0,3}$'
  OR p_tool_catalogue_digest IS NULL OR p_tool_catalogue_digest !~ '^[a-f0-9]{64}$'
  OR p_system_text_digest IS NULL OR p_system_text_digest !~ '^[a-f0-9]{64}$'
  OR p_manifest_canonical IS NULL OR octet_length(p_manifest_canonical)>16384
  OR p_admitted_at IS NULL OR morrow_work.utc_parse(p_admitted_at) IS NULL
  OR (SELECT count(DISTINCT x) FROM unnest(ARRAY[p_run_id,p_child_task_id,p_envelope_id,p_hop_id,p_grant_id]) x)<>5 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF jsonb_typeof(p_tools::jsonb)<>'array' OR jsonb_array_length(p_tools::jsonb) NOT BETWEEN 1 AND 32
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_tools::jsonb) x WHERE jsonb_typeof(x)<>'string')
  OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(p_tools::jsonb) x)<>jsonb_array_length(p_tools::jsonb) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_tools:=ARRAY(SELECT x FROM jsonb_array_elements_text(p_tools::jsonb) WITH ORDINALITY q(x,o) ORDER BY o);
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT c2.policy_revision INTO v_policy FROM morrow_work.current_tenant() c2;
 v_now:=morrow_work.db_now();
 v_admitted:=morrow_work.utc_parse(p_admitted_at);
 IF v_admitted>v_now+interval '1 minute' OR v_admitted<v_now-interval '2 minutes' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 v_until:=v_now+interval '24 hours';
 v_day:=(v_admitted AT TIME ZONE 'UTC')::date;
 -- The parent task: the actor's own, open, read under a share lock.
 SELECT x.status,x.revision::bigint AS revision,x.goal_id::text AS goal_id,x.initiator_principal_id::text AS ip,
  x.initiator_membership_id::text AS im INTO k FROM morrow_work.tasks x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_task_id FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF k.status NOT IN ('draft','ready') OR k.ip<>p.principal_id OR k.im<>p.membership_id THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 -- The store, its stops and the named installation (active, on this store and connection).
 SELECT x.connection_id INTO s FROM morrow_work.listings_store_current(p.organization_id,p.workspace_id,p_store_id) x LIMIT 1;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 SELECT x.id::text AS id,x.agent_principal_id::text AS agent_principal_id,x.status,x.store_id::text AS store_id,
  x.connection_id::text AS connection_id,x.release_id,x.release_revision::bigint AS release_revision,x.release_digest::text AS release_digest
  INTO i FROM morrow_work.agent_installations x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_installation_id;
 IF NOT FOUND OR i.status<>'active' OR i.store_id<>p_store_id OR i.connection_id<>s.connection_id::text THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN;
 END IF;
 IF morrow_work.stop_active(p.organization_id,p.workspace_id,'run',s.connection_id,i.id) THEN RETURN QUERY SELECT 'stopped'::text,NULL::text; RETURN; END IF;
 SELECT x.id,x.revision::bigint AS revision,x.digest::text AS digest INTO rel FROM morrow_work.agent_releases x
  WHERE x.id=i.release_id AND x.revision=i.release_revision AND x.digest=i.release_digest AND x.status='published';
 IF NOT FOUND THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
 -- The loop catalogue: an active version and the profile's entry in it (substituting nothing).
 SELECT y.* INTO v FROM morrow_work.loop_catalogue_versions y WHERE y.version=p_catalogue_version::integer AND y.status='active';
 IF NOT FOUND THEN RETURN QUERY SELECT 'catalogue_inactive'::text,NULL::text; RETURN; END IF;
 SELECT x.* INTO e FROM morrow_work.loop_catalogue_entries x WHERE x.version=v.version AND x.model_key=p_model AND x.effort_key=p_effort;
 IF NOT FOUND THEN RETURN QUERY SELECT 'entry_not_offered'::text,NULL::text; RETURN; END IF;
 -- The tools: each in the tool catalogue's version with the routed context; the envelope
 -- carries exactly their capabilities and verbs.
 IF (SELECT count(*) FROM morrow_work.tool_catalogue_entries t WHERE t.version=p_tool_catalogue_version::integer AND t.tool=ANY(v_tools)
   AND 'routed'=ANY(t.contexts))<>cardinality(v_tools) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT array_agg(DISTINCT t.capability_id ORDER BY t.capability_id),array_agg(DISTINCT t.verb ORDER BY t.verb) INTO v_caps,v_verbs
  FROM morrow_work.tool_catalogue_entries t WHERE t.version=p_tool_catalogue_version::integer AND t.tool=ANY(v_tools);
 IF cardinality(v_caps)>16 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 -- The caps and the hold (ADR-0027 items 6 and 12): a routed run must afford one turn.
 v_turn_limit:=least(v.max_turns_per_run,floor(v.run_cost_cap_usd/e.worst_case_turn_usd)::integer);
 v_hold:=least(v_turn_limit*e.worst_case_turn_usd,v.run_cost_cap_usd);
 IF v_turn_limit<1 OR v_hold<e.worst_case_turn_usd THEN RETURN QUERY SELECT 'cap_below_turn'::text,NULL::text; RETURN; END IF;
 -- Billing, derived: the active Morrow-direct account, its operator test entitlement and period.
 SELECT x.id::text AS id INTO a FROM morrow_billing.billing_accounts x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
  AND x.route='morrow_direct' AND x.status='active';
 IF NOT FOUND THEN RETURN QUERY SELECT 'entitlement'::text,NULL::text; RETURN; END IF;
 SELECT x.status,x.valid_until,x.subscription_key INTO snap FROM morrow_billing.entitlement_snapshots x WHERE x.organization_id=p.organization_id
  AND x.workspace_id=p.workspace_id AND x.billing_account_id=a.id ORDER BY x.revision DESC LIMIT 1;
 IF NOT FOUND OR snap.status<>'active' OR snap.valid_until<=v_now OR snap.subscription_key !~ '^morrow:operator_entitlement:' THEN
  RETURN QUERY SELECT 'entitlement'::text,NULL::text; RETURN;
 END IF;
 SELECT y.period_start,y.period_end INTO per FROM (SELECT x.period_start,x.period_end,x.recorded_at FROM morrow_billing.verified_payment_events x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.outcome='granted' AND x.kind='subscription_period'
  UNION ALL SELECT z.verified_at,z.valid_until,z.recorded_at FROM morrow_billing.entitlement_snapshots z WHERE z.organization_id=p.organization_id
  AND z.workspace_id=p.workspace_id AND z.subscription_key ~ '^morrow:operator_entitlement:') y ORDER BY y.period_end DESC,y.recorded_at DESC LIMIT 1;
 IF NOT FOUND OR per.period_end<=v_now OR per.period_start>v_now THEN RETURN QUERY SELECT 'no_billing_period'::text,NULL::text; RETURN; END IF;
 -- The workspace's stale agent runs close first, so their holds stop counting as open.
 PERFORM morrow_work.agent_runs_close_stale(p.organization_id,p.workspace_id);
 -- The daily backstop and the period's unrecovered cost, under listings' interlock, so a
 -- listings admission and a loop admission of one workspace serialize.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.billing.run_reserve',
  p.organization_id,p.workspace_id)::text,0));
 SELECT COALESCE(sum(CASE WHEN x.status='reserved' THEN x.maximum_cost_usd ELSE x.booked_cost_usd END),0) INTO v_today
  FROM morrow_billing.vendor_cost_reservations x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.created_day=v_day;
 v_today:=v_today+COALESCE((SELECT sum(b.amount_usd) FROM morrow_billing.run_cost_bookings b JOIN morrow_billing.vendor_cost_reservations x
  ON x.organization_id=b.organization_id AND x.workspace_id=b.workspace_id AND x.id=b.vendor_reservation_id
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.created_day=v_day AND b.kind='overflow'),0);
 v_today:=v_today+COALESCE((SELECT sum(CASE WHEN x.status IN ('queued','running','waiting') THEN greatest(x.hold_usd,x.booked_usd)+x.overflow_usd
   ELSE x.booked_usd+x.overflow_usd END) FROM morrow_work.agent_runs x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.created_day=v_day),0);
 IF v_today+v_hold>v.workspace_daily_cost_cap_usd THEN RETURN QUERY SELECT 'daily_backstop'::text,NULL::text; RETURN; END IF;
 v_unrecovered:=COALESCE((SELECT u.amount_usd FROM morrow_billing.unrecovered_costs u WHERE u.organization_id=p.organization_id
   AND u.workspace_id=p.workspace_id AND u.period_start=date_trunc('milliseconds',per.period_start)),0)
  +COALESCE((SELECT sum(CASE WHEN x.status IN ('queued','running','waiting') THEN greatest(x.hold_usd,x.booked_usd)+x.overflow_usd
   ELSE x.booked_usd+x.overflow_usd END) FROM morrow_work.agent_runs x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.period_start=date_trunc('milliseconds',per.period_start)),0);
 IF v_unrecovered+v_hold>v.workspace_period_unrecovered_cost_cap_usd THEN
  RETURN QUERY SELECT 'unrecovered_cost_cap'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO l FROM morrow_work.lease_open('run',p_run_id,p_store_id,s.connection_id,i.id);
 IF l.outcome IS DISTINCT FROM 'opened' THEN RETURN QUERY SELECT CASE l.outcome WHEN 'stopped' THEN 'stopped' ELSE 'invalid' END,NULL::text; RETURN; END IF;
 v_scope:=morrow_work.listings_scope(p.organization_id,p.workspace_id,p_store_id,s.connection_id);
 v_actor:=jsonb_build_object('kind','human','principalId',p.principal_id,'organizationId',p.organization_id,'workspaceId',p.workspace_id,
  'membershipId',p.membership_id,'installationId',NULL,'mandateId',NULL);
 v_child_envelope:='envelope:'||p_hop_id;
 BEGIN
  -- Child task T': the installation's work item, owned by the actor (a task owner is a member).
  INSERT INTO morrow_work.tasks(organization_id,workspace_id,id,revision,goal_id,status,objective,scope,initiator_principal_id,
   initiator_membership_id,owner_principal_id,owner_membership_id,created_at,updated_at)
  VALUES (p.organization_id,p.workspace_id,p_child_task_id,1,k.goal_id,'draft','Agent run '||p_run_id,
   jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,
    'resources','[]'::jsonb,'fields','[]'::jsonb),p.principal_id,p.membership_id,p.principal_id,p.membership_id,v_now,v_now);
  UPDATE morrow_work.tasks x SET status='ready',revision=2,updated_at=v_now
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_child_task_id;
  INSERT INTO morrow_work.work_envelopes(organization_id,workspace_id,id,revision,task_id,task_revision,requester_principal_id,
   requester_membership_id,store_id,installation_id,capability_ids,verbs,scope,valid_from,expires_at,revoked_at,maximum_depth,maximum_children,created_at)
  VALUES (p.organization_id,p.workspace_id,p_envelope_id,1,p_task_id,k.revision,p.principal_id,p.membership_id,p_store_id,i.id,v_caps,v_verbs,
   v_scope,v_now,v_until,NULL,1,1,v_now);
  -- The workspace's one Coordinator principal (ensured here, as run admission does).
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
  INSERT INTO morrow_work.agent_runs(organization_id,workspace_id,id,revision,kind,task_id,child_task_id,store_id,connection_id,installation_id,
   agent_principal_id,coordinator_principal_id,envelope_id,hop_id,lease_id,lease_generation,requester_principal_id,requester_membership_id,status,
   ended_reason,release_id,release_revision,release_digest,manifest_canonical,manifest_digest,system_text_digest,tool_catalogue_version,
   tool_catalogue_digest,tools,catalogue_version,model_key,effort_key,turn_limit,tool_calls_per_turn,tool_calls_per_run,questions_limit,
   max_input_tokens,max_output_tokens,wall_time_ms,worst_case_turn_usd,hold_usd,booked_usd,overflow_usd,turns_taken,tool_calls_taken,
   questions_asked,active_ms,segment_started_at,prefix_digest,tainted,question_id,period_start,created_day,request_digest,command_id,created_at,
   started_at,ended_at,updated_at)
  VALUES (p.organization_id,p.workspace_id,p_run_id,1,'routed',p_task_id,p_child_task_id,p_store_id,s.connection_id,i.id,i.agent_principal_id,
   c.principal_id,p_envelope_id,p_hop_id,l.lease_id,l.generation::bigint,p.principal_id,p.membership_id,'queued',NULL,rel.id,rel.revision,
   rel.digest,p_manifest_canonical,morrow_work.sha256_text(p_manifest_canonical),p_system_text_digest,p_tool_catalogue_version::integer,
   p_tool_catalogue_digest,v_tools,v.version,p_model,p_effort,v_turn_limit,v.max_tool_calls_per_turn,v.max_tool_calls_per_run,
   v.max_questions_per_run,v.max_input_tokens_per_turn,e.max_output_tokens,v.wall_time_minutes*60000,e.worst_case_turn_usd,v_hold,0,0,0,0,0,0,
   NULL,NULL,false,NULL,date_trunc('milliseconds',per.period_start),v_day,p_request_digest,p_command_id,v_admitted,NULL,NULL,v_admitted);
 EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'task.created','task',p_child_task_id,1,
  p_child_task_id,jsonb_build_object('goalId',k.goal_id,'status','draft'),p_correlation_id,v_now);
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'task.status_changed','task',p_child_task_id,2,
  p_child_task_id,jsonb_build_object('from','draft','to','ready'),p_correlation_id,v_now);
 v_result:=jsonb_build_object('runId',p_run_id,'status','queued','childTaskId',p_child_task_id,'catalogueVersion',v.version,'model',p_model,
  'effort',p_effort,'turnLimit',v_turn_limit,'holdUsd',to_char(v_hold,'FM999999999990.00000000'));
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'run.admit',p_run_id,1,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;
-- The requester's answer to a waiting run's question (ADR-0027 item 1: at a resume after
-- inbox.ask the lease comes from the answer command for a person's run; it grants nothing).
-- Only the run's requester answers, once, within 72 hours, while no stop blocks the run's
-- store or installation and the store's connection is current; the answer opens the resume
-- run lease (its subject `<run>:r<n>`) and the run goes back to queued under it, so the
-- orchestrator resumes its Workflow. Outcomes: applied, invalid, ineligible,
-- stale_authority, command_conflict, not_found, denied, state_conflict, expired, stopped.
CREATE FUNCTION morrow_work.cmd_agent_run_answer(p_command_id text,p_request_digest text,p_correlation_id text,p_question_id text,p_answer text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; q record; r record; s record; l record; v_now timestamptz; v_resume integer; v_result jsonb; n integer;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_question_id IS NULL OR p_question_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_answer IS NULL OR char_length(p_answer) NOT BETWEEN 1 AND 2000 OR p_answer !~ '\S' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.run_id::text AS run_id,x.status,x.answer_by INTO q FROM morrow_work.agent_run_questions x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.agent_run',p.organization_id,
  p.workspace_id,q.run_id)::text,0));
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=q.run_id;
 IF r.requester_principal_id::text<>p.principal_id OR r.requester_membership_id::text<>p.membership_id THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN;
 END IF;
 SELECT x.status INTO q.status FROM morrow_work.agent_run_questions x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id;
 IF q.status<>'open' OR r.status<>'waiting' OR r.question_id IS DISTINCT FROM p_question_id THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 IF q.answer_by<=v_now THEN RETURN QUERY SELECT 'expired'::text,NULL::text; RETURN; END IF;
 IF morrow_work.stop_active(p.organization_id,p.workspace_id,'run',r.connection_id,r.installation_id) THEN
  RETURN QUERY SELECT 'stopped'::text,NULL::text; RETURN;
 END IF;
 SELECT x.connection_id INTO s FROM morrow_work.listings_store_current(p.organization_id,p.workspace_id,r.store_id) x LIMIT 1;
 IF NOT FOUND OR s.connection_id<>r.connection_id::text THEN RETURN QUERY SELECT 'stopped'::text,NULL::text; RETURN; END IF;
 SELECT count(*)::integer+1 INTO v_resume FROM morrow_work.agent_run_questions x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.run_id=r.id AND x.status='answered';
 SELECT * INTO l FROM morrow_work.lease_open('run',r.id||':r'||v_resume,r.store_id,r.connection_id,r.installation_id);
 IF l.outcome IS DISTINCT FROM 'opened' THEN RETURN QUERY SELECT CASE l.outcome WHEN 'stopped' THEN 'stopped' ELSE 'invalid' END,NULL::text; RETURN; END IF;
 UPDATE morrow_work.agent_run_questions x SET status='answered',answer=p_answer,answered_by_principal_id=p.principal_id,
  answered_by_membership_id=p.membership_id,resume_lease_id=l.lease_id,answered_at=greatest(v_now,x.created_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id;
 UPDATE morrow_work.agent_runs x SET status='queued',question_id=NULL,lease_id=l.lease_id,lease_generation=l.generation::bigint,
  revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=r.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 v_result:=jsonb_build_object('runId',r.id,'questionId',p_question_id,'status','queued');
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'question.answer',p_question_id,1,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- ---------------------------------------------------------------------------
-- Runtime definers: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_runtime_executor only. Except the two id lookups, the tenant and the run come only
-- from the entered run lease (agent_run_entered, which takes the run's lock).
-- The cron's ids-only list (spine §5): queued agent runs whose current lease is committed,
-- active, unstarted and unexpired, oldest first, at most 100; resume says whether the run
-- started before (an answered question). The orchestrator starts a new AgentRunWorkflow or
-- wakes the waiting one, and keeps these leases out of ListingsRunWorkflow's starts.
CREATE FUNCTION morrow_work.agent_run_pending_starts()
RETURNS TABLE(organization_id text,workspace_id text,run_id text,lease_id text,generation text,resume text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor') THEN RETURN; END IF;
 RETURN QUERY SELECT a.organization_id::text,a.workspace_id::text,a.id::text,l.id::text,l.generation::text,(a.started_at IS NOT NULL)::text
  FROM morrow_work.agent_runs a JOIN morrow_work.work_leases l ON l.organization_id=a.organization_id AND l.workspace_id=a.workspace_id
   AND l.id=a.lease_id
  WHERE a.status='queued' AND l.status='active' AND l.started_at IS NULL AND l.kind='run' AND l.expires_at>pg_catalog.clock_timestamp()
  ORDER BY a.created_at,a.id LIMIT 100;
END $$;
-- One open run's current lease reference (ids only): what AgentRunWorkflow enters first (or
-- again, when its first step's result was lost after it committed), and after an answer.
-- Zero rows unless the run is queued or running. It grants nothing: enter_lease decides
-- whether the lease is still usable.
CREATE FUNCTION morrow_work.agent_run_resume_lease(p_organization_id text,p_workspace_id text,p_run_id text)
RETURNS TABLE(lease_id text,generation text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor')
  OR p_organization_id IS NULL OR p_organization_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_workspace_id IS NULL OR p_workspace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_run_id IS NULL OR p_run_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN;
 END IF;
 RETURN QUERY SELECT a.lease_id::text,a.lease_generation::text FROM morrow_work.agent_runs a
  WHERE a.organization_id=p_organization_id AND a.workspace_id=p_workspace_id AND a.id=p_run_id AND a.status IN ('queued','running');
END $$;
-- Starts (or resumes) the entered lease's run: queued -> running, the lease marked started,
-- a new wall-time segment. A running run is returned as it stands; a waiting or terminal one
-- names its status. Outcomes: started, resumed, running, waiting, ended, denied.
CREATE FUNCTION morrow_work.agent_run_start() RETURNS TABLE(outcome text,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; v_now timestamptz; n integer;
BEGIN
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT x.status,x.started_at INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id
  AND x.id=e.run_id;
 IF r.status='queued' THEN
  v_now:=morrow_work.db_now();
  UPDATE morrow_work.agent_runs x SET status='running',started_at=COALESCE(x.started_at,greatest(v_now,x.created_at)),
   segment_started_at=greatest(v_now,x.updated_at),revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
  PERFORM morrow_work.lease_mark_started();
  RETURN QUERY SELECT CASE WHEN r.started_at IS NULL THEN 'started' ELSE 'resumed' END,'running'::text; RETURN;
 END IF;
 RETURN QUERY SELECT CASE r.status WHEN 'running' THEN 'running' WHEN 'waiting' THEN 'waiting' ELSE 'ended' END,r.status;
END $$;
-- The entered lease's run as every step checks it (ids, codes, caps, counters and amounts;
-- never content): the active time includes the running segment, and the lease's expiry and
-- the database's time let the step size its wall-time check. Outcomes: found, denied.
CREATE FUNCTION morrow_work.agent_run_state()
RETURNS TABLE(outcome text,run_id text,status text,kind text,task_id text,child_task_id text,envelope_id text,installation_id text,
 agent_principal_id text,store_id text,connection_id text,requester_principal_id text,requester_membership_id text,release_id text,
 system_text_digest text,tools text,catalogue_version text,model_key text,effort_key text,turn_limit text,tool_calls_per_turn text,
 tool_calls_per_run text,questions_limit text,max_input_tokens text,max_output_tokens text,wall_time_ms text,hold_usd text,
 worst_case_turn_usd text,booked_usd text,overflow_usd text,turns_taken text,tool_calls_taken text,questions_asked text,active_ms text,
 lease_expires_at_ms text,database_now_ms text,tainted text,prefix_digest text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; v_now timestamptz;
BEGIN
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id;
 v_now:=morrow_work.db_now();
 RETURN QUERY SELECT 'found'::text,r.id::text,r.status,r.kind,r.task_id::text,r.child_task_id::text,r.envelope_id::text,r.installation_id::text,
  r.agent_principal_id::text,r.store_id::text,r.connection_id::text,r.requester_principal_id::text,r.requester_membership_id::text,r.release_id,
  r.system_text_digest::text,to_jsonb(r.tools)::text,r.catalogue_version::text,r.model_key,r.effort_key,r.turn_limit::text,r.tool_calls_per_turn::text,
  r.tool_calls_per_run::text,r.questions_limit::text,r.max_input_tokens::text,r.max_output_tokens::text,r.wall_time_ms::text,
  to_char(r.hold_usd,'FM999999999990.00000000'),to_char(r.worst_case_turn_usd,'FM999999999990.00000000'),
  to_char(r.booked_usd,'FM999999999990.00000000'),to_char(r.overflow_usd,'FM999999999990.00000000'),r.turns_taken::text,r.tool_calls_taken::text,
  r.questions_asked::text,(r.active_ms+CASE WHEN r.segment_started_at IS NULL THEN 0
   ELSE greatest((extract(epoch FROM v_now-r.segment_started_at)*1000)::bigint,0) END)::text,
  (extract(epoch FROM e.expires_at)*1000)::bigint::text,(extract(epoch FROM v_now)*1000)::bigint::text,r.tainted::text,r.prefix_digest::text;
END $$;
-- The entered lease's run's request: the parent task's objective, the person's own words
-- (turn 1's text). Content, inside the step only. Outcomes: found, denied.
CREATE FUNCTION morrow_work.agent_run_objective() RETURNS TABLE(outcome text,objective text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; v_objective text;
BEGIN
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT t.objective INTO v_objective FROM morrow_work.agent_runs x JOIN morrow_work.tasks t ON t.organization_id=x.organization_id
  AND t.workspace_id=x.workspace_id AND t.id=x.task_id WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id;
 RETURN QUERY SELECT 'found'::text,v_objective;
END $$;
-- The entered lease's run's conversation, in order: every turn attempt's input, reply,
-- outcome, the tool results its reply led to and the digest after it. Content, inside the
-- step only (ADR-0027 item 7: no content reaches Workflow outputs, Queues or logs).
CREATE FUNCTION morrow_work.agent_run_conversation()
RETURNS TABLE(turn text,attempt text,input text,input_digest text,output text,outcome text,tool_results text,prefix_digest_after text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record;
BEGIN
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT t.turn::text,t.attempt::text,t.input::text,t.input_digest::text,t.output::text,t.outcome,t.tool_results::text,
  t.prefix_digest_after::text FROM morrow_work.run_turns t
  WHERE t.organization_id=e.organization_id AND t.workspace_id=e.workspace_id AND t.run_id=e.run_id ORDER BY t.turn,t.attempt;
END $$;
-- Opens one turn attempt (ADR-0027 items 4 and 6): the run is running; attempt 1 of turn n
-- is the next turn (n = turns taken + 1) after a tool_use reply whose every tool call
-- finished (or n = 1); attempt 2 only after attempt 1 of the same turn closed uncertain
-- (resent at most once); the turn limit, the hold (one more worst-case turn, no overflow)
-- and the wall time are checked again here after the code checked them. The input and its
-- digest are stored before any send; the same input again is opened_before (a replayed
-- step). Outcomes: opened, opened_before, conflict, stop (reason turn_limit, cost_budget or
-- wall_time), run_inactive, invalid, denied.
CREATE FUNCTION morrow_work.agent_turn_open(p_turn text,p_attempt text,p_input text,p_input_digest text,p_untrusted text,p_read_tags text)
RETURNS TABLE(outcome text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; t record; v_turn integer; v_attempt integer; v_now timestamptz; v_active bigint; n integer;
BEGIN
 IF p_turn IS NULL OR p_turn !~ '^[1-9][0-9]?$' OR p_attempt IS NULL OR p_attempt !~ '^[12]$'
  OR p_input IS NULL OR octet_length(p_input)>393216 OR NOT pg_input_is_valid(p_input,'jsonb')
  OR p_input_digest IS NULL OR p_input_digest !~ '^[a-f0-9]{64}$' OR p_untrusted IS NULL OR p_untrusted NOT IN ('true','false')
  OR p_read_tags IS NULL OR octet_length(p_read_tags)>8192 OR NOT pg_input_is_valid(p_read_tags,'jsonb') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_turn:=p_turn::integer; v_attempt:=p_attempt::integer;
 IF v_turn>16 OR NOT morrow_work.loop_user_message_valid(p_input::jsonb) OR NOT morrow_work.valid_read_tags(p_read_tags::jsonb) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id;
 IF r.status<>'running' THEN RETURN QUERY SELECT 'run_inactive'::text,NULL::text; RETURN; END IF;
 SELECT x.input_digest::text AS input_digest INTO t FROM morrow_work.run_turns x WHERE x.organization_id=r.organization_id
  AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.turn=v_turn AND x.attempt=v_attempt;
 IF FOUND THEN
  RETURN QUERY SELECT CASE WHEN t.input_digest=p_input_digest THEN 'opened_before' ELSE 'conflict' END,NULL::text; RETURN;
 END IF;
 IF v_attempt=1 THEN
  IF v_turn<>r.turns_taken+1 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
  IF v_turn>r.turn_limit THEN RETURN QUERY SELECT 'stop'::text,'turn_limit'::text; RETURN; END IF;
  IF v_turn>1 AND NOT EXISTS(SELECT 1 FROM morrow_work.run_turns x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
    AND x.run_id=r.id AND x.turn=v_turn-1 AND x.outcome='tool_use'
    AND jsonb_array_length(x.tool_results)=(SELECT count(*) FROM jsonb_array_elements(x.output->'content') b WHERE b->>'type'='tool_use')) THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
 ELSIF v_turn<>r.turns_taken OR NOT EXISTS(SELECT 1 FROM morrow_work.run_turns x WHERE x.organization_id=r.organization_id
   AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.turn=v_turn AND x.attempt=1 AND x.outcome='uncertain') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF r.overflow_usd>0 OR r.hold_usd-r.booked_usd<r.worst_case_turn_usd THEN RETURN QUERY SELECT 'stop'::text,'cost_budget'::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 v_active:=r.active_ms+greatest((extract(epoch FROM v_now-r.segment_started_at)*1000)::bigint,0);
 IF v_active>=r.wall_time_ms THEN RETURN QUERY SELECT 'stop'::text,'wall_time'::text; RETURN; END IF;
 INSERT INTO morrow_work.run_turns(organization_id,workspace_id,run_id,turn,attempt,input,input_digest,untrusted,output,outcome,
  prefix_digest_before,prefix_digest_after,input_tokens,cache_write_tokens,cache_read_tokens,output_tokens,tool_results,read_tags,created_at,
  updated_at,expires_at)
 VALUES (r.organization_id,r.workspace_id,r.id,v_turn,v_attempt,p_input::jsonb,p_input_digest,p_untrusted='true',NULL,NULL,NULL,NULL,NULL,NULL,NULL,
  NULL,'[]'::jsonb,p_read_tags::jsonb,v_now,v_now,v_now+interval '90 days');
 UPDATE morrow_work.agent_runs x SET turns_taken=CASE WHEN v_attempt=1 THEN v_turn ELSE x.turns_taken END,tainted=x.tainted OR p_untrusted='true',
  revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.id=r.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 RETURN QUERY SELECT 'opened'::text,NULL::text;
END $$;
-- One turn attempt's fence as the step sees it before any send: its recorded outcome (null
-- while none), whether a call is open (live within its budget plus a minute, or expired),
-- and the last sequence used. An expired open call is booked as uncertain at its worst case
-- here (never promoted to success; a late close is refused), so its outcome is uncertain.
-- Outcomes: found, run_inactive, invalid, denied.
CREATE FUNCTION morrow_work.agent_turn_settle(p_turn text,p_attempt text)
RETURNS TABLE(outcome text,turn_outcome text,open_call text,last_sequence text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; t record; c record; v_open text:='none'; v_seq integer;
BEGIN
 IF p_turn IS NULL OR p_turn !~ '^[1-9][0-9]?$' OR p_attempt IS NULL OR p_attempt !~ '^[12]$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT x.status INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id;
 IF r.status<>'running' THEN RETURN QUERY SELECT 'run_inactive'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT x.outcome INTO t FROM morrow_work.run_turns x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id
  AND x.run_id=e.run_id AND x.turn=p_turn::integer AND x.attempt=p_attempt::integer;
 IF NOT FOUND THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 FOR c IN SELECT x.id::text AS id,x.turn,x.attempt,x.started_at,x.budget_ms FROM morrow_work.agent_model_calls x
   WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.run_id=e.run_id AND x.status='started' LOOP
  IF c.started_at+make_interval(secs=>c.budget_ms/1000.0+60)>pg_catalog.clock_timestamp() THEN v_open:='live';
  ELSE PERFORM morrow_work.agent_turn_close_uncertain(e.organization_id,e.workspace_id,c.id);
  END IF;
 END LOOP;
 SELECT x.outcome INTO t FROM morrow_work.run_turns x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id
  AND x.run_id=e.run_id AND x.turn=p_turn::integer AND x.attempt=p_attempt::integer;
 SELECT COALESCE(max(x.sequence),0) INTO v_seq FROM morrow_work.agent_model_calls x WHERE x.organization_id=e.organization_id
  AND x.workspace_id=e.workspace_id AND x.run_id=e.run_id AND x.turn=p_turn::integer AND x.attempt=p_attempt::integer;
 RETURN QUERY SELECT 'found'::text,t.outcome,v_open,v_seq::text;
END $$;
-- Begins one tool call (ADR-0027 item 2): the call must be exactly a tool_use the turn's
-- recorded reply made (its id and tool at its position); its capability, verb and replay
-- class come from the tool catalogue, never the caller. A recorded call is returned again
-- (replay: its outcome and first record; resumed: begun but not finished, the step reruns
-- a read and looks up an internal write's first record). A new call is counted against the
-- run's caps first: over the per-turn or per-run limit, or a tool the manifest does not
-- offer, it is still recorded but not counted, and the step must finish it refused
-- (tool_call_limit, not_offered). Outcomes: begun, refuse (with the refusal), resumed,
-- replay, run_inactive, invalid, denied.
CREATE FUNCTION morrow_work.agent_tool_call_begin(p_turn text,p_ordinal text,p_tool_use_id text,p_tool text,p_input_digest text)
RETURNS TABLE(outcome text,refusal text,capability_id text,verb text,replay_class text,recorded_outcome text,recorded_refusal text,
 record_kind text,record_id text,result_digest text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; t record; c record; k record; v_turn integer; v_ordinal integer; v_now timestamptz; v_refusal text; n integer;
BEGIN
 IF p_turn IS NULL OR p_turn !~ '^[1-9][0-9]?$' OR p_ordinal IS NULL OR p_ordinal !~ '^[0-3]$'
  OR p_tool_use_id IS NULL OR p_tool_use_id !~ '^[A-Za-z0-9_-]{1,64}$' OR p_tool IS NULL OR p_tool !~ '^[a-z]+(\.[a-z]+)+$'
  OR p_input_digest IS NULL OR p_input_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_turn:=p_turn::integer; v_ordinal:=p_ordinal::integer;
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id;
 IF r.status<>'running' THEN
  RETURN QUERY SELECT 'run_inactive'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 -- The turn's recorded tool_use reply: this call is its ordinal-th tool_use, by id and tool.
 SELECT x.output INTO t FROM morrow_work.run_turns x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
  AND x.run_id=r.id AND x.turn=v_turn AND x.outcome='tool_use' ORDER BY x.attempt DESC LIMIT 1;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM (SELECT b,row_number() OVER (ORDER BY o)-1 AS ordinal FROM jsonb_array_elements(t.output->'content')
    WITH ORDINALITY q(b,o) WHERE b->>'type'='tool_use') u WHERE u.ordinal=v_ordinal AND u.b->>'id'=p_tool_use_id AND u.b->>'name'=p_tool) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.* INTO c FROM morrow_work.run_tool_calls x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
  AND x.run_id=r.id AND x.tool_use_id=p_tool_use_id;
 IF FOUND THEN
  IF c.turn<>v_turn OR c.ordinal<>v_ordinal OR c.tool<>p_tool OR c.input_digest::text<>p_input_digest THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  RETURN QUERY SELECT CASE WHEN c.outcome IS NULL THEN 'resumed' ELSE 'replay' END,NULL::text,c.capability_id,c.verb,c.replay_class,c.outcome,
   c.refusal,c.record_kind,c.record_id::text,c.result_digest::text;
  RETURN;
 END IF;
 SELECT x.capability_id,x.verb,x.replay_class INTO k FROM morrow_work.tool_catalogue_entries x
  WHERE x.version=r.tool_catalogue_version AND x.tool=p_tool;
 IF NOT FOUND THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_refusal:=CASE WHEN NOT p_tool=ANY(r.tools) THEN 'not_offered'
  WHEN v_ordinal>=r.tool_calls_per_turn OR r.tool_calls_taken>=r.tool_calls_per_run THEN 'tool_call_limit' END;
 v_now:=morrow_work.db_now();
 INSERT INTO morrow_work.run_tool_calls(organization_id,workspace_id,run_id,tool_use_id,turn,ordinal,tool,capability_id,verb,replay_class,
  input_digest,outcome,refusal,result_digest,result_bytes,record_kind,record_id,started_at,finished_at,expires_at)
 VALUES (r.organization_id,r.workspace_id,r.id,p_tool_use_id,v_turn,v_ordinal,p_tool,k.capability_id,k.verb,k.replay_class,p_input_digest,NULL,NULL,
  NULL,NULL,NULL,NULL,v_now,NULL,v_now+interval '365 days');
 IF v_refusal IS NULL THEN
  UPDATE morrow_work.agent_runs x SET tool_calls_taken=x.tool_calls_taken+1,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.id=r.id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 END IF;
 RETURN QUERY SELECT CASE WHEN v_refusal IS NULL THEN 'begun' ELSE 'refuse' END,v_refusal,k.capability_id,k.verb,k.replay_class,NULL::text,
  NULL::text,NULL::text,NULL::text,NULL::text;
END $$;
-- Finishes one begun tool call: its outcome (a refusal pairs with its code, invalid_input
-- with input_invalid, anything else with none), the result text (at most 8 KiB) whose
-- digest SQL computes and checks, and an internal write's first record. The result is
-- appended, as one tool_result block, to the tool results of the turn whose reply made the
-- call (the next turn's input), and a result that carried untrusted data taints the run.
-- The same finish again is replay. Outcomes: finished, replay, conflict, run_inactive,
-- invalid, denied.
CREATE FUNCTION morrow_work.agent_tool_call_finish(p_tool_use_id text,p_outcome text,p_refusal text,p_result text,p_result_digest text,
 p_record_kind text,p_record_id text,p_untrusted text)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; c record; v_now timestamptz; n integer;
BEGIN
 IF p_tool_use_id IS NULL OR p_tool_use_id !~ '^[A-Za-z0-9_-]{1,64}$'
  OR p_outcome IS NULL OR p_outcome NOT IN ('ok','refused','invalid_input','tool_outcome_unknown','computer_unavailable')
  OR (p_outcome='refused')<>(p_refusal IS NOT NULL AND p_refusal<>'input_invalid')
  OR (p_outcome='invalid_input')<>(p_refusal IS NOT DISTINCT FROM 'input_invalid')
  OR (p_outcome NOT IN ('refused','invalid_input') AND p_refusal IS NOT NULL)
  OR p_result IS NULL OR octet_length(p_result)>8192 OR p_result_digest IS NULL OR p_result_digest<>morrow_work.sha256_text(p_result)
  OR (p_record_kind IS NULL)<>(p_record_id IS NULL)
  OR (p_record_kind IS NOT NULL AND p_record_kind NOT IN ('message','question','task','suggestion','artifact','proposal','specialist_spec'))
  OR (p_record_id IS NOT NULL AND p_record_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  OR p_untrusted IS NULL OR p_untrusted NOT IN ('true','false') THEN
  RETURN QUERY SELECT 'invalid'::text; RETURN;
 END IF;
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text; RETURN; END IF;
 SELECT x.status INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id;
 SELECT x.* INTO c FROM morrow_work.run_tool_calls x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id
  AND x.run_id=e.run_id AND x.tool_use_id=p_tool_use_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'invalid'::text; RETURN; END IF;
 IF c.outcome IS NOT NULL THEN
  RETURN QUERY SELECT CASE WHEN c.outcome=p_outcome AND c.result_digest::text=p_result_digest THEN 'replay' ELSE 'conflict' END; RETURN;
 END IF;
 IF r.status<>'running' THEN RETURN QUERY SELECT 'run_inactive'::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 UPDATE morrow_work.run_tool_calls x SET outcome=p_outcome,refusal=p_refusal,result_digest=p_result_digest,result_bytes=octet_length(p_result),
  record_kind=p_record_kind,record_id=p_record_id,finished_at=greatest(v_now,x.started_at)
  WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.run_id=e.run_id AND x.tool_use_id=p_tool_use_id;
 UPDATE morrow_work.run_turns t SET tool_results=t.tool_results||jsonb_build_array(jsonb_build_object('type','tool_result','toolUseId',p_tool_use_id,
   'outcome',p_outcome,'content',p_result)),updated_at=greatest(v_now,t.updated_at)
  WHERE t.organization_id=e.organization_id AND t.workspace_id=e.workspace_id AND t.run_id=e.run_id AND t.turn=c.turn
   AND t.attempt=(SELECT max(y.attempt) FROM morrow_work.run_turns y WHERE y.organization_id=e.organization_id AND y.workspace_id=e.workspace_id
    AND y.run_id=e.run_id AND y.turn=c.turn AND y.outcome='tool_use');
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_RUN_TURN_INVALID'; END IF;
 IF p_untrusted='true' THEN
  UPDATE morrow_work.agent_runs x SET tainted=true,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id AND NOT x.tainted;
 END IF;
 RETURN QUERY SELECT 'finished'::text;
END $$;
-- inbox.ask's internal write (ADR-0027 item 1): one question to the run's requester per
-- begun inbox.ask call, at most the run's questions limit (2). The same call again returns
-- its first question (replay). Outcomes: asked, replay, question_limit, run_inactive,
-- invalid, denied.
CREATE FUNCTION morrow_work.agent_question_ask(p_tool_use_id text,p_question text,p_choices text)
RETURNS TABLE(outcome text,question_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; c record; q record; v_now timestamptz; v_id text; n integer;
BEGIN
 IF p_tool_use_id IS NULL OR p_tool_use_id !~ '^[A-Za-z0-9_-]{1,64}$' OR p_question IS NULL OR char_length(p_question) NOT BETWEEN 1 AND 500
  OR p_question !~ '\S' OR p_choices IS NULL OR octet_length(p_choices)>4096 OR NOT pg_input_is_valid(p_choices,'jsonb') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id;
 IF r.status<>'running' THEN RETURN QUERY SELECT 'run_inactive'::text,NULL::text; RETURN; END IF;
 SELECT x.tool,x.outcome INTO c FROM morrow_work.run_tool_calls x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
  AND x.run_id=r.id AND x.tool_use_id=p_tool_use_id;
 IF NOT FOUND OR c.tool<>'inbox.ask' OR c.outcome IS NOT NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT x.id::text AS id INTO q FROM morrow_work.agent_run_questions x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
  AND x.run_id=r.id AND x.tool_use_id=p_tool_use_id;
 IF FOUND THEN RETURN QUERY SELECT 'replay'::text,q.id; RETURN; END IF;
 IF r.questions_asked>=r.questions_limit THEN RETURN QUERY SELECT 'question_limit'::text,NULL::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 v_id:=gen_random_uuid()::text;
 BEGIN
  INSERT INTO morrow_work.agent_run_questions(organization_id,workspace_id,id,run_id,tool_use_id,question,choices,status,answer,
   answered_by_principal_id,answered_by_membership_id,resume_lease_id,created_at,answer_by,answered_at)
  VALUES (r.organization_id,r.workspace_id,v_id,r.id,p_tool_use_id,p_question,p_choices::jsonb,'open',NULL,NULL,NULL,NULL,v_now,
   v_now+interval '72 hours',NULL);
 EXCEPTION WHEN check_violation THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 UPDATE morrow_work.agent_runs x SET questions_asked=x.questions_asked+1,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.id=r.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 RETURN QUERY SELECT 'asked'::text,v_id;
END $$;
-- The run waits durably for its requester's answer (ADR-0027 item 1): running -> waiting on
-- its open question, after every tool call of its last turn finished and with no call open;
-- the running segment closes (waits do not count toward the wall time) and the lease is
-- released (the answer opens the next one). Outcomes: waiting, call_open, run_inactive,
-- invalid, denied.
CREATE FUNCTION morrow_work.agent_run_wait() RETURNS TABLE(outcome text,question_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; q record; v_now timestamptz; n integer;
BEGIN
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id;
 IF r.status<>'running' THEN RETURN QUERY SELECT 'run_inactive'::text,NULL::text; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM morrow_work.agent_model_calls x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
   AND x.run_id=r.id AND x.status='started') THEN
  RETURN QUERY SELECT 'call_open'::text,NULL::text; RETURN;
 END IF;
 SELECT x.id::text AS id INTO q FROM morrow_work.agent_run_questions x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
  AND x.run_id=r.id AND x.status='open' ORDER BY x.created_at DESC LIMIT 1;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM morrow_work.run_tool_calls x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
   AND x.run_id=r.id AND x.outcome IS NULL)
  OR NOT EXISTS(SELECT 1 FROM morrow_work.run_turns x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
   AND x.run_id=r.id AND x.turn=r.turns_taken AND x.outcome='tool_use'
   AND jsonb_array_length(x.tool_results)=(SELECT count(*) FROM jsonb_array_elements(x.output->'content') b WHERE b->>'type'='tool_use')) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 UPDATE morrow_work.agent_runs x SET status='waiting',question_id=q.id,
  active_ms=x.active_ms+greatest((extract(epoch FROM v_now-x.segment_started_at)*1000)::bigint,0),segment_started_at=NULL,
  revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.id=r.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 PERFORM morrow_work.lease_release();
 RETURN QUERY SELECT 'waiting'::text,q.id;
END $$;
-- Finishes the entered lease's run with the end reason the code derived (never model text,
-- ADR-0027 item 1): completed succeeds; stopped, lease_ended, switch_off, task_closed and
-- mandate_ended cancel; every other reason fails. An open call within its budget blocks the
-- finish (call_open: the step waits); an expired one is booked as uncertain first. Ends the
-- run (agent_run_end) and releases the lease. A terminal run returns its status. Outcomes:
-- ended, call_open, invalid, denied.
CREATE FUNCTION morrow_work.agent_run_finish(p_reason text) RETURNS TABLE(outcome text,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; c record; x record; v_status text;
BEGIN
 IF p_reason IS NULL OR p_reason NOT IN ('completed','turn_limit','tool_call_limit','cost_budget','wall_time','deadline','question_unanswered',
  'invalid_output','refusal','spend_limit','provider_error','prefix_mismatch','stopped','lease_ended','mandate_ended','task_closed','switch_off') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT y.status INTO r FROM morrow_work.agent_runs y WHERE y.organization_id=e.organization_id AND y.workspace_id=e.workspace_id AND y.id=e.run_id;
 IF r.status IN ('succeeded','failed','cancelled') THEN RETURN QUERY SELECT 'ended'::text,r.status; RETURN; END IF;
 FOR c IN SELECT y.id::text AS id,y.started_at,y.budget_ms FROM morrow_work.agent_model_calls y WHERE y.organization_id=e.organization_id
   AND y.workspace_id=e.workspace_id AND y.run_id=e.run_id AND y.status='started' LOOP
  IF c.started_at+make_interval(secs=>c.budget_ms/1000.0+60)>pg_catalog.clock_timestamp() THEN
   RETURN QUERY SELECT 'call_open'::text,NULL::text; RETURN;
  END IF;
  PERFORM morrow_work.agent_turn_close_uncertain(e.organization_id,e.workspace_id,c.id);
 END LOOP;
 v_status:=CASE WHEN p_reason='completed' THEN 'succeeded'
  WHEN p_reason IN ('stopped','lease_ended','switch_off','task_closed','mandate_ended') THEN 'cancelled' ELSE 'failed' END;
 SELECT * INTO x FROM morrow_work.agent_run_end(e.organization_id,e.workspace_id,e.run_id,v_status,p_reason);
 IF x.outcome IS DISTINCT FROM 'ended' THEN RAISE EXCEPTION 'WORK_AGENT_RUN_END_FAILED'; END IF;
 PERFORM morrow_work.lease_release();
 RETURN QUERY SELECT 'ended'::text,v_status;
END $$;

-- ---------------------------------------------------------------------------
-- The broker's turn fence: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_vault_broker only (RuntimeBroker.modelTurn, ModelCall@2; ADR-0027 item 4).
-- Opens one model call of one turn attempt, before any provider request: the lease
-- resolves for purpose `model` with every resolve_call check, repeated under the stop
-- interlock; the run is the lease's run, running, under exactly this lease; the turn's
-- input row exists with exactly this input digest and no outcome yet; the conversation's
-- prefix is exactly the run's recorded one (null on turn 1), so the conversation is
-- append-only (prefix_mismatch before any request); attempt 2 only after an uncertain
-- attempt 1; the last turn the limit allows is final (tool_choice none); one call per run is
-- open; the hold covers one more worst-case turn. The same fence again never sends: a closed
-- one returns its recorded outcome, reply, digest and usage (`replay`), an open one in its
-- budget is `in_flight`, an expired one is booked as uncertain and replayed. Returns the
-- run's selection and its catalogue entry (provider model id, input and output caps), its
-- offered tools and pinned system-text digest: never the caller's. Outcomes: begun, replay,
-- in_flight, call_open, prefix_mismatch, turn_state, attempt_invalid, cost_budget,
-- run_inactive, denied, invalid, and every resolve_call refusal.
CREATE FUNCTION morrow_vault.agent_turn_begin(p_lease_id text,p_generation text,p_turn text,p_attempt text,p_sequence text,p_final text,
 p_budget_ms text,p_prefix_digest text,p_input_digest text)
RETURNS TABLE(outcome text,call_id text,model_key text,effort_key text,provider_model_id text,max_input_tokens text,max_output_tokens text,
 tools text,system_text_digest text,recorded_outcome text,recorded_output text,recorded_prefix_after text,recorded_usage text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE
 lz record; rc record; r record; t record; c record; en record; v_run text; v_found boolean; v_turn integer; v_attempt integer; v_sequence integer;
 v_budget integer; v_outcome text; v_call text; v_now timestamptz;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text;
  RETURN;
 END IF;
 IF p_lease_id IS NULL OR p_lease_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_generation IS NULL OR p_generation !~ '^[1-9][0-9]{0,15}$'
  OR p_turn IS NULL OR p_turn !~ '^[1-9][0-9]?$' OR p_attempt IS NULL OR p_attempt !~ '^[12]$' OR p_sequence IS NULL OR p_sequence !~ '^[1-8]$'
  OR p_final IS NULL OR p_final NOT IN ('true','false') OR p_budget_ms IS NULL OR p_budget_ms !~ '^[1-9][0-9]{3,5}$'
  OR p_prefix_digest IS NULL OR (p_prefix_digest<>'' AND p_prefix_digest !~ '^[a-f0-9]{64}$')
  OR p_input_digest IS NULL OR p_input_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text;
  RETURN;
 END IF;
 v_turn:=p_turn::integer; v_attempt:=p_attempt::integer; v_sequence:=p_sequence::integer; v_budget:=p_budget_ms::integer;
 IF v_turn>16 OR v_budget NOT BETWEEN 1000 AND 600000 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text;
  RETURN;
 END IF;
 -- The lease's tenant, store and subject (resolve_call's own lease policy, keyed by its setting).
 PERFORM pg_catalog.set_config('morrow.vault_resolve_lease',p_lease_id,true);
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.subject_id::text AS subject_id,x.store_id::text AS store_id,
  x.kind INTO lz FROM morrow_work.work_leases x WHERE x.id=p_lease_id;
 v_found:=FOUND;
 PERFORM pg_catalog.set_config('morrow.vault_resolve_lease','',true);
 IF NOT v_found OR lz.kind<>'run' THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text;
  RETURN;
 END IF;
 v_run:=split_part(lz.subject_id,':',1);
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
  lz.organization_id,lz.workspace_id,lz.store_id)::text,0));
 SELECT * INTO rc FROM morrow_vault.resolve_call(p_lease_id,p_generation,'model',lz.subject_id);
 IF rc.outcome IS DISTINCT FROM 'resolved' THEN
  RETURN QUERY SELECT COALESCE(rc.outcome,'denied'),NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.agent_run',rc.organization_id,
  rc.workspace_id,v_run)::text,0));
 PERFORM pg_catalog.set_config('morrow.vault_agent_run',rc.organization_id||'|'||rc.workspace_id||'|'||v_run,true);
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=rc.organization_id AND x.workspace_id=rc.workspace_id AND x.id=v_run;
 IF NOT FOUND OR r.lease_id::text<>p_lease_id OR r.lease_generation::text<>p_generation OR r.status<>'running' THEN
  v_outcome:='run_inactive';
 END IF;
 IF v_outcome IS NULL THEN
  -- The same fence again: never a second send.
  SELECT x.id::text AS id,x.status,x.outcome,x.started_at,x.budget_ms INTO c FROM morrow_work.agent_model_calls x
   WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.turn=v_turn AND x.attempt=v_attempt
    AND x.sequence=v_sequence;
  IF FOUND THEN
   IF c.status='started' AND c.started_at+make_interval(secs=>c.budget_ms/1000.0+60)>clock_timestamp() THEN
    v_outcome:='in_flight';
   ELSE
    IF c.status='started' THEN PERFORM morrow_work.agent_turn_close_uncertain(r.organization_id,r.workspace_id,c.id); END IF;
    SELECT x.outcome INTO c.outcome FROM morrow_work.agent_model_calls x WHERE x.organization_id=r.organization_id
     AND x.workspace_id=r.workspace_id AND x.id=c.id;
    SELECT x.output,x.prefix_digest_after,x.input_tokens,x.cache_write_tokens,x.cache_read_tokens,x.output_tokens INTO t
     FROM morrow_work.run_turns x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id AND x.run_id=r.id
     AND x.turn=v_turn AND x.attempt=v_attempt;
    PERFORM pg_catalog.set_config('morrow.vault_agent_run','',true);
    RETURN QUERY SELECT 'replay'::text,c.id,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,c.outcome,
     CASE WHEN c.outcome IN ('end_turn','tool_use') THEN t.output::text END,CASE WHEN c.outcome IN ('end_turn','tool_use') THEN t.prefix_digest_after::text END,
     CASE WHEN t.input_tokens IS NOT NULL AND c.outcome NOT IN ('uncertain','not_sent') THEN jsonb_build_object('inputTokens',t.input_tokens,
      'cacheWriteTokens',t.cache_write_tokens,'cacheReadTokens',t.cache_read_tokens,'outputTokens',t.output_tokens)::text END;
    RETURN;
   END IF;
  END IF;
 END IF;
 IF v_outcome IS NULL THEN
  -- One open call per run; an expired one is booked as uncertain before this opens.
  FOR c IN SELECT x.id::text AS id,x.started_at,x.budget_ms FROM morrow_work.agent_model_calls x WHERE x.organization_id=r.organization_id
    AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.status='started' LOOP
   IF c.started_at+make_interval(secs=>c.budget_ms/1000.0+60)>clock_timestamp() THEN v_outcome:='call_open';
   ELSE PERFORM morrow_work.agent_turn_close_uncertain(r.organization_id,r.workspace_id,c.id);
   END IF;
  END LOOP;
 END IF;
 IF v_outcome IS NULL THEN
  SELECT x.input_digest::text AS input_digest,x.outcome INTO t FROM morrow_work.run_turns x WHERE x.organization_id=r.organization_id
   AND x.workspace_id=r.workspace_id AND x.run_id=r.id AND x.turn=v_turn AND x.attempt=v_attempt;
  IF NOT FOUND OR t.input_digest<>p_input_digest OR t.outcome IS NOT NULL OR v_turn<>r.turns_taken THEN v_outcome:='turn_state';
  ELSIF (v_turn=1 AND (p_prefix_digest<>'' OR r.prefix_digest IS NOT NULL))
   OR (v_turn>1 AND (r.prefix_digest IS NULL OR p_prefix_digest<>r.prefix_digest::text)) THEN v_outcome:='prefix_mismatch';
  ELSIF v_attempt=2 AND NOT EXISTS(SELECT 1 FROM morrow_work.run_turns x WHERE x.organization_id=r.organization_id AND x.workspace_id=r.workspace_id
    AND x.run_id=r.id AND x.turn=v_turn AND x.attempt=1 AND x.outcome='uncertain') THEN v_outcome:='attempt_invalid';
  ELSIF v_turn=r.turn_limit AND p_final<>'true' THEN v_outcome:='invalid';
  ELSIF r.overflow_usd>0 OR r.hold_usd-r.booked_usd<r.worst_case_turn_usd THEN v_outcome:='cost_budget';
  END IF;
 END IF;
 IF v_outcome IS NOT NULL THEN
  PERFORM pg_catalog.set_config('morrow.vault_agent_run','',true);
  RETURN QUERY SELECT v_outcome,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text;
  RETURN;
 END IF;
 SELECT x.provider_model_id,x.max_output_tokens INTO en FROM morrow_work.loop_catalogue_entries x WHERE x.version=r.catalogue_version
  AND x.model_key=r.model_key AND x.effort_key=r.effort_key;
 v_now:=date_trunc('milliseconds',clock_timestamp());
 v_call:=gen_random_uuid()::text;
 INSERT INTO morrow_work.agent_model_calls(organization_id,workspace_id,id,run_id,turn,attempt,sequence,final,status,outcome,counted,raw_stop_reason,
  provider_request_id,provider_model_id,counted_input_tokens,input_tokens,cache_write_tokens,cache_read_tokens,output_tokens,cost_usd,overflow_usd,
  budget_ms,started_at,closed_at)
 VALUES (r.organization_id,r.workspace_id,v_call,r.id,v_turn,v_attempt,v_sequence,p_final='true','started',NULL,NULL,NULL,NULL,NULL,NULL,NULL,
  NULL,NULL,NULL,NULL,NULL,v_budget,v_now,NULL);
 PERFORM pg_catalog.set_config('morrow.vault_agent_run','',true);
 RETURN QUERY SELECT 'begun'::text,v_call,r.model_key,r.effort_key,en.provider_model_id,r.max_input_tokens::text,en.max_output_tokens::text,
  to_jsonb(r.tools)::text,r.system_text_digest::text,NULL::text,NULL::text,NULL::text,NULL::text;
END $$;
-- Closes one turn's model call by its fence (ADR-0027 item 4): it needs no live lease, so a
-- call in flight when a stop or the lease's end lands is still recorded and booked. The
-- outcome decides whether it counted: end_turn, tool_use, incomplete, refusal,
-- invalid_output, uncertain and a provider_error with usage count; not_sent, spend_limit,
-- input_over_cap and a provider_error without usage do not. A counted call's cost is
-- computed here from the run's loop catalogue entry (each token kind at its rate, rounded
-- up), or its worst-case turn when uncertain, and booked against the run's hold; what the
-- hold cannot hold is overflow (never dropped). A reply (end_turn, tool_use) is written
-- into the turn's row with the conversation's digest after it, which becomes the run's
-- prefix; a reply that is not a stored AssistantModelMessage, or names another provider
-- model, is recorded as invalid_output or provider_error. not_sent leaves the turn open for
-- the next sequence. Outcomes: closed (with the recorded outcome, the cost and whether it
-- overflowed), already_closed (with the recorded outcome), not_found, denied, invalid.
CREATE FUNCTION morrow_vault.agent_turn_end(p_call_id text,p_outcome text,p_raw_stop_reason text,p_provider_request_id text,
 p_provider_model_id text,p_counted_input_tokens text,p_input_tokens text,p_cache_write_tokens text,p_cache_read_tokens text,p_output_tokens text,
 p_reply text,p_prefix_after text)
RETURNS TABLE(outcome text,recorded_outcome text,cost_usd text,overflow boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE
 c record; r record; en record; v_found boolean; v_outcome text; v_usage boolean; v_counted boolean; v_cost numeric(20,8); v_booked numeric(20,8);
 v_overflow numeric(20,8); v_reply jsonb; v_now timestamptz; n integer;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::boolean; RETURN;
 END IF;
 IF p_call_id IS NULL OR p_call_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_outcome IS NULL OR p_outcome NOT IN ('end_turn','tool_use','incomplete','refusal','invalid_output','spend_limit','provider_error','uncertain',
   'not_sent','input_over_cap')
  OR (p_raw_stop_reason IS NOT NULL AND p_raw_stop_reason !~ '^[a-z_]{1,32}$')
  OR (p_provider_request_id IS NOT NULL AND p_provider_request_id !~ '^[A-Za-z0-9_-]{1,128}$')
  OR (p_provider_model_id IS NOT NULL AND p_provider_model_id !~ '^[A-Za-z0-9._-]{1,128}$')
  OR (p_counted_input_tokens IS NOT NULL AND p_counted_input_tokens !~ '^(0|[1-9][0-9]{0,6})$')
  OR ((p_input_tokens IS NULL)<>(p_output_tokens IS NULL)) OR ((p_input_tokens IS NULL)<>(p_cache_write_tokens IS NULL))
  OR ((p_input_tokens IS NULL)<>(p_cache_read_tokens IS NULL))
  OR (p_input_tokens IS NOT NULL AND (p_input_tokens !~ '^(0|[1-9][0-9]{0,6})$' OR p_output_tokens !~ '^(0|[1-9][0-9]{0,6})$'
   OR p_cache_write_tokens !~ '^(0|[1-9][0-9]{0,6})$' OR p_cache_read_tokens !~ '^(0|[1-9][0-9]{0,6})$'))
  OR (p_outcome IN ('end_turn','tool_use','incomplete','refusal','invalid_output') AND p_input_tokens IS NULL)
  OR (p_outcome IN ('spend_limit','not_sent','input_over_cap','uncertain') AND p_input_tokens IS NOT NULL)
  OR ((p_outcome IN ('end_turn','tool_use'))<>(p_reply IS NOT NULL)) OR ((p_reply IS NULL)<>(p_prefix_after IS NULL))
  OR (p_prefix_after IS NOT NULL AND p_prefix_after !~ '^[a-f0-9]{64}$')
  OR (p_reply IS NOT NULL AND (octet_length(p_reply)>393216 OR NOT pg_input_is_valid(p_reply,'jsonb'))) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::boolean; RETURN;
 END IF;
 PERFORM pg_catalog.set_config('morrow.vault_agent_call',p_call_id,true);
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.run_id::text AS run_id,x.turn,x.attempt,x.status,
  x.outcome INTO c FROM morrow_work.agent_model_calls x WHERE x.id=p_call_id;
 v_found:=FOUND;
 PERFORM pg_catalog.set_config('morrow.vault_agent_call','',true);
 IF NOT v_found THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::boolean; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.agent_run',c.organization_id,
  c.workspace_id,c.run_id)::text,0));
 PERFORM pg_catalog.set_config('morrow.vault_agent_run',c.organization_id||'|'||c.workspace_id||'|'||c.run_id,true);
 SELECT x.status,x.outcome INTO c.status,c.outcome FROM morrow_work.agent_model_calls x WHERE x.organization_id=c.organization_id
  AND x.workspace_id=c.workspace_id AND x.id=p_call_id;
 IF c.status<>'started' THEN
  PERFORM pg_catalog.set_config('morrow.vault_agent_run','',true);
  RETURN QUERY SELECT 'already_closed'::text,c.outcome,NULL::text,NULL::boolean; RETURN;
 END IF;
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=c.organization_id AND x.workspace_id=c.workspace_id AND x.id=c.run_id;
 SELECT x.* INTO en FROM morrow_work.loop_catalogue_entries x WHERE x.version=r.catalogue_version AND x.model_key=r.model_key
  AND x.effort_key=r.effort_key;
 v_outcome:=p_outcome;
 v_usage:=p_input_tokens IS NOT NULL;
 -- A reply naming another model is a provider error (no fallback).
 IF v_usage AND v_outcome<>'provider_error' AND p_provider_model_id IS DISTINCT FROM en.provider_model_id THEN v_outcome:='provider_error'; END IF;
 IF v_outcome IN ('end_turn','tool_use') THEN
  v_reply:=p_reply::jsonb;
  IF NOT morrow_work.loop_assistant_message_valid(v_reply)
   OR (v_outcome='tool_use')<>EXISTS(SELECT 1 FROM jsonb_array_elements(v_reply->'content') b WHERE b->>'type'='tool_use') THEN
   v_outcome:='invalid_output';
  END IF;
 END IF;
 IF v_outcome NOT IN ('end_turn','tool_use') THEN v_reply:=NULL; END IF;
 v_counted:=v_outcome IN ('end_turn','tool_use','incomplete','refusal','invalid_output','uncertain') OR (v_outcome='provider_error' AND v_usage);
 v_now:=date_trunc('milliseconds',clock_timestamp());
 v_cost:=NULL; v_overflow:=0;
 IF v_counted THEN
  IF v_outcome='uncertain' THEN v_cost:=r.worst_case_turn_usd;
  ELSE
   v_cost:=ceil((p_input_tokens::numeric*en.input_usd12_per_token+p_cache_write_tokens::numeric*en.cache_write_usd12_per_token
    +p_cache_read_tokens::numeric*en.cache_read_usd12_per_token+p_output_tokens::numeric*en.output_usd12_per_token)/10000)/100000000;
  END IF;
  v_booked:=least(v_cost,greatest(r.hold_usd-r.booked_usd,0));
  v_overflow:=v_cost-v_booked;
  UPDATE morrow_work.agent_runs x SET booked_usd=x.booked_usd+v_booked,overflow_usd=x.overflow_usd+v_overflow,
   prefix_digest=CASE WHEN v_reply IS NOT NULL THEN p_prefix_after ELSE x.prefix_digest END,revision=x.revision+1,
   updated_at=greatest(v_now,x.updated_at) WHERE x.organization_id=c.organization_id AND x.workspace_id=c.workspace_id AND x.id=c.run_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 END IF;
 UPDATE morrow_work.agent_model_calls x SET status='closed',outcome=v_outcome,counted=v_counted,raw_stop_reason=p_raw_stop_reason,
  provider_request_id=p_provider_request_id,provider_model_id=p_provider_model_id,counted_input_tokens=p_counted_input_tokens::integer,
  input_tokens=p_input_tokens::bigint,cache_write_tokens=p_cache_write_tokens::bigint,cache_read_tokens=p_cache_read_tokens::bigint,
  output_tokens=p_output_tokens::bigint,cost_usd=v_cost,overflow_usd=CASE WHEN v_overflow>0 THEN v_overflow ELSE NULL END,
  closed_at=greatest(v_now,x.started_at) WHERE x.organization_id=c.organization_id AND x.workspace_id=c.workspace_id AND x.id=p_call_id;
 -- not_sent generated nothing: the turn stays open for the next sequence.
 IF v_outcome<>'not_sent' THEN
  UPDATE morrow_work.run_turns t SET outcome=v_outcome,output=v_reply,prefix_digest_before=CASE WHEN v_reply IS NOT NULL THEN r.prefix_digest END,
   prefix_digest_after=CASE WHEN v_reply IS NOT NULL THEN p_prefix_after END,input_tokens=p_input_tokens::bigint,
   cache_write_tokens=p_cache_write_tokens::bigint,cache_read_tokens=p_cache_read_tokens::bigint,output_tokens=p_output_tokens::bigint,
   updated_at=greatest(v_now,t.updated_at)
   WHERE t.organization_id=c.organization_id AND t.workspace_id=c.workspace_id AND t.run_id=c.run_id AND t.turn=c.turn AND t.attempt=c.attempt
    AND t.outcome IS NULL;
 END IF;
 PERFORM pg_catalog.set_config('morrow.vault_agent_run','',true);
 RETURN QUERY SELECT 'closed'::text,v_outcome,CASE WHEN v_counted THEN to_char(v_cost,'FM999999999990.00000000') END,v_overflow>0;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p WHERE (p.pronamespace='morrow_work'::regnamespace AND p.proname IN (
  'loop_user_message_valid','loop_assistant_message_valid','loop_tool_results_valid','loop_choices_valid','agent_manifest_matches','agent_run_entered',
  'cmd_agent_run_admit','cmd_agent_run_answer','agent_run_pending_starts','agent_run_resume_lease','agent_run_start','agent_run_state',
  'agent_run_objective','agent_run_conversation','agent_turn_open','agent_turn_settle','agent_tool_call_begin','agent_tool_call_finish',
  'agent_question_ask','agent_run_wait','agent_run_finish')) OR (p.pronamespace='morrow_vault'::regnamespace AND p.proname IN (
  'agent_turn_begin','agent_turn_end')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',r.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION morrow_work.loop_user_message_valid(jsonb),morrow_work.loop_assistant_message_valid(jsonb),
 morrow_work.loop_tool_results_valid(jsonb),morrow_work.loop_choices_valid(jsonb),
 morrow_work.agent_manifest_matches(text,text,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,text,text[],integer,text,text,
  integer,integer,integer,integer,integer,integer,integer,numeric,timestamp with time zone) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_work.cmd_agent_run_admit(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,
  text,text,text),
 morrow_work.cmd_agent_run_answer(text,text,text,text,text) TO morrow_work_api;
GRANT EXECUTE ON FUNCTION morrow_work.agent_run_pending_starts(),morrow_work.agent_run_resume_lease(text,text,text),morrow_work.agent_run_start(),
 morrow_work.agent_run_state(),morrow_work.agent_run_objective(),morrow_work.agent_run_conversation(),
 morrow_work.agent_turn_open(text,text,text,text,text,text),morrow_work.agent_turn_settle(text,text),
 morrow_work.agent_tool_call_begin(text,text,text,text,text),morrow_work.agent_tool_call_finish(text,text,text,text,text,text,text,text),
 morrow_work.agent_question_ask(text,text,text),morrow_work.agent_run_wait(),morrow_work.agent_run_finish(text) TO morrow_runtime_executor;
GRANT EXECUTE ON FUNCTION morrow_vault.agent_turn_begin(text,text,text,text,text,text,text,text,text),
 morrow_vault.agent_turn_end(text,text,text,text,text,text,text,text,text,text,text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_work,morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_entered() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_agent_run_admit(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,
 text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_agent_run_answer(text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_pending_starts() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_resume_lease(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_start() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_state() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_objective() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_conversation() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_turn_open(text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_turn_settle(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_tool_call_begin(text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_tool_call_finish(text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_question_ask(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_wait() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_finish(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.agent_turn_begin(text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.agent_turn_end(text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work,morrow_vault FROM morrow_work_command;
COMMIT;
