BEGIN;
-- Plan row H7a, the agent loop's data model (ADR-0041 item 4, with items 3, 5 to 7, 9, 12 to
-- 14, 16, 17, 20 and 28 to 34; ADR-0027 as ADR-0036, ADR-0039 and ADR-0041 amend it; packet
-- docs/packets/H7a.md, brief docs/briefs/t4-agent-loop.md). Executes AS morrow_work_owner, after
-- 0056 and pull request 92's 0057 (memory foundation, independent of this file). Unapplied, so it
-- is edited in place until it is first applied (ADR-0041's immutable-migrations note).
-- On the ADR-0010 tenant pattern: composite tenant keys, ENABLE and FORCE RLS on every table,
-- definers owned by morrow_work_command, INVOKER triggers and checks owned by the owner, no
-- DELETE or TRUNCATE. No external effect: nothing here sends a request. Nothing here is
-- reachable while the agent-loop switch (docs/decisions/agent-loop-staging.json) is off: the
-- api refuses admission and the answer (switch_off) before any statement, the orchestrator
-- never starts AgentRunWorkflow, and the switch cannot go on before H7b's runner is recorded
-- (its `harness_runner` prerequisite).
--   * Platform: the loop catalogue (version 2, proposed; its safety template, AgentRunSafety@1
--     without the entry's max_tokens), ToolCatalogue@1 version 4 and context_policy_versions
--     (ContextPolicy@1 version 1, proposed). Admission takes only active rows, so nothing is
--     admitted until later reviewed migrations publish them.
--   * Tenant, ADR-0041 item 4's one data model: jobs, agent_contexts, context_epochs,
--     context_checkpoints, agent_runs (kind, purpose, lineage, segments and incarnations, the
--     envelope, the open wait, taint and read tags, credits, pinned versions and the safety
--     profile), run_turns (keyed by context and sequence), run_tool_calls, agent_model_calls,
--     agent_run_questions, run_waits, run_plans and run_plan_revisions, run_events, agent_calls,
--     teammate_results, result_items and result_item_pages, run_detector_state, run_segments,
--     run_taint_sources, run_memory_reads and upkeep_triggers. Content lives only in run_turns,
--     checkpoints, plan revisions, teammate results, result items and questions; every other
--     table holds ids, codes, counts, digests and times. ADR-0040's conversation tables are
--     P07.T03's: agent_runs.conversation_id and source_inbox_id and jobs.conversation_id land
--     without their foreign keys, which a later forward migration adds (plan row H4).
--   * CHECKs hold safety ranges only, never a limit that ends work: turns 1 to 100,000, tool
--     calls per turn 1 to 64, max_output_tokens up to 128,000, a call budget up to 1,800,000 ms,
--     a wait on a person 1 to 365 days, a stored message 384 KiB, a reply its own 4 MiB of jsonb
--     text (twice replyStoredBytes' 2 MiB of compact JSON, H6's carry-forward N3).
--   * Definers: the person's acts (cmd_agent_run_admit, cmd_agent_run_answer, the api); the
--     runtime's ids-only definers, each one round trip and executable only by
--     morrow_runtime_executor: agent_run_lease_renew (per-step renewal under the entered lease),
--     agent_run_resume (a resolvable wait's lease, re-issued after admission's checks),
--     admit_upkeep_run (one pending upkeep_triggers row), agent_run_wake_candidates (the
--     sweep's cross-tenant ids, which never issues a lease) and agent_run_segment_roll; and the
--     Workflow's entry lookups (agent_run_pending_starts, agent_run_resume_lease,
--     agent_run_start). The turn, tool, question, plan and finish steps and the broker's turn
--     fence are H7b's and H7c's (the packet lists what left this file and why).
-- Money (ADR-0039; ADR-0041 item 9; OD-2026-10-26-12): credits are the only budget, and
-- nothing here caps spend. The run and each model call carry credit columns (held, drawn,
-- refunded, absorbed; whole credits) that H8 fills under the wallet's row lock; admission
-- holds nothing yet and the switch's `shared_wallet` prerequisite keeps it off until H8.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regclass('morrow_work.runs') IS NULL OR to_regclass('morrow_work.agent_installations') IS NULL
 OR to_regclass('morrow_work.agent_releases') IS NULL OR to_regclass('morrow_work.work_envelopes') IS NULL
 OR to_regclass('morrow_work.delegation_hops') IS NULL OR to_regclass('morrow_work.work_leases') IS NULL
 OR to_regclass('morrow_work.lease_entries') IS NULL OR to_regclass('morrow_work.stop_controls') IS NULL
 OR to_regclass('morrow_billing.entitlement_snapshots') IS NULL
 OR to_regclass('morrow_work.goal_measure_values') IS NULL
 OR to_regclass('morrow_work.agent_runs') IS NOT NULL OR to_regclass('morrow_work.run_turns') IS NOT NULL
 OR to_regclass('morrow_work.agent_contexts') IS NOT NULL OR to_regclass('morrow_work.jobs') IS NOT NULL
 OR to_regclass('morrow_work.loop_catalogue_versions') IS NOT NULL OR to_regclass('morrow_work.context_policy_versions') IS NOT NULL
 OR to_regprocedure('morrow_work.lease_open(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.enter_lease(text,text)') IS NULL
 OR to_regprocedure('morrow_work.lease_release()') IS NULL OR to_regprocedure('morrow_work.lease_mark_started()') IS NULL
 OR to_regprocedure('morrow_work.current_lease()') IS NULL OR to_regprocedure('morrow_work.current_tenant()') IS NULL
 OR to_regprocedure('morrow_work.command_prelude(text,text)') IS NULL
 OR to_regprocedure('morrow_work.record_command(text,text,text,text,text,text,text,text,bigint,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.append_event(text,text,text,text,text,text,text,bigint,text,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.listings_store_current(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.stop_active(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.listings_scope(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.valid_read_tags(jsonb)') IS NULL
 OR (SELECT p.proowner::regrole::text FROM pg_catalog.pg_proc p WHERE p.oid='morrow_work.enter_lease(text,text)'::regprocedure)<>'morrow_work_command'
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_agent_principal_ensure(text,text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_agent_grants_issue(text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_lease_member_current(text,text,text,text)','EXECUTE')
 -- The shared command and event CHECKs this file relies on, unchanged (it widens none):
 -- run.admit and question.answer are recorded commands, task.created and
 -- task.status_changed the child task's events.
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_command_type_check'
   AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''run.admit''%' AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''question.answer''%')
 THEN RAISE EXCEPTION 'AGENT_RUNS_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pure functions: IMMUTABLE, owned by the owner; the command role holds EXECUTE because
-- CHECK constraints run with the writer's privileges. Each bounds what SQL stores; the
-- generated contract validators check the full shapes in the Workers first.
-- A stored time: millisecond-truncated and inside the records' range (null passes).
CREATE FUNCTION morrow_work.harness_ms(p timestamptz) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p IS NULL OR (p=date_trunc('milliseconds',p) AND p>=timestamptz '2000-01-01T00:00:00Z' AND p<timestamptz '9000-01-01T00:00:00Z')
$$;
-- RFC 8785 text of a jsonb value as Morrow's contracts use them (objects with ASCII keys,
-- arrays, strings, integers, booleans and null): keys in code-unit order, no whitespace. The
-- Workers' canonicalJson gives the same bytes (drift-tested in lab:agent-runs), so a digest
-- SQL computes for a record it builds is the digest code computes.
CREATE FUNCTION morrow_work.harness_jcs(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v text;
BEGIN
 IF p IS NULL THEN RETURN NULL; END IF;
 CASE jsonb_typeof(p)
  WHEN 'object' THEN
   SELECT '{'||COALESCE(string_agg(to_jsonb(e.k)::text||':'||morrow_work.harness_jcs(e.v),',' ORDER BY e.k COLLATE "C"),'')||'}' INTO v
    FROM jsonb_each(p) e(k,v);
  WHEN 'array' THEN
   SELECT '['||COALESCE(string_agg(morrow_work.harness_jcs(a.v),',' ORDER BY a.o),'')||']' INTO v
    FROM jsonb_array_elements(p) WITH ORDINALITY a(v,o);
  ELSE v:=p::text;
 END CASE;
 RETURN v;
END $$;
-- A UserModelMessage as stored (ADR-0041 items 8 and 13): role user, 1..128 blocks (text, data
-- naming a closed untrusted source, a tool result with its code label, the requester's post, a
-- code-rendered state block), within the stored-message bound (ContextPolicy@1's
-- storedMessageBytes, 384 KiB, kept as a CHECK: it holds the per-turn budget and 16 previews).
CREATE FUNCTION morrow_work.loop_user_message_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'object' OR NOT (p ?& ARRAY['role','content']) OR (p-ARRAY['role','content'])<>'{}'::jsonb
   OR p->'role'<>'"user"'::jsonb OR jsonb_typeof(p->'content')<>'array' OR jsonb_array_length(p->'content') NOT BETWEEN 1 AND 128
   OR octet_length(p::text)>393216 THEN false ELSE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(p->'content') b WHERE NOT (CASE WHEN jsonb_typeof(b)<>'object' THEN false
   WHEN b->>'type'='text' THEN (b-ARRAY['type','text'])='{}'::jsonb AND jsonb_typeof(b->'text')='string'
    AND char_length(b->>'text') BETWEEN 1 AND 32000
   WHEN b->>'type'='data' THEN (b-ARRAY['type','source','sourceId','text'])='{}'::jsonb AND b ?& ARRAY['source','sourceId','text']
    AND (b->>'source') IN ('product','inventory','order_summary','support_mail','knowledge_page','artifact','report','upload',
     'sandbox_output','tool_result','message','teammate_result','result_item','notebook_entry','conversation_summary','person_memory',
     'context_checkpoint','thread_post','other_member')
    AND (b->'sourceId'='null'::jsonb OR (jsonb_typeof(b->'sourceId')='string' AND (b->>'sourceId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'))
    AND jsonb_typeof(b->'text')='string' AND char_length(b->>'text')<=65536
   WHEN b->>'type'='tool_result' THEN (b-ARRAY['type','toolUseId','label','outcome','content','itemId'])='{}'::jsonb
    AND b ?& ARRAY['toolUseId','label','outcome','content','itemId']
    AND jsonb_typeof(b->'toolUseId')='string' AND (b->>'toolUseId') ~ '^[A-Za-z0-9_-]{1,64}$'
    AND jsonb_typeof(b->'label')='string' AND (b->>'label') ~ '^c[1-9][0-9]{0,5}$'
    AND (b->>'outcome') IN ('ok','refused','invalid_input','tool_outcome_unknown','computer_unavailable')
    AND jsonb_typeof(b->'content')='string' AND octet_length(b->>'content')<=262144
    AND (b->'itemId'='null'::jsonb OR (jsonb_typeof(b->'itemId')='string' AND (b->>'itemId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'))
   WHEN b->>'type'='post' THEN (b-ARRAY['type','messageId','label','authorPrincipalId','postedAt','text'])='{}'::jsonb
    AND b ?& ARRAY['messageId','label','authorPrincipalId','postedAt','text'] AND jsonb_typeof(b->'text')='string'
    AND char_length(b->>'text') BETWEEN 1 AND 32000
   WHEN b->>'type'='state' THEN (b-ARRAY['type','kind','digest','taint','text'])='{}'::jsonb AND b ?& ARRAY['kind','digest','taint','text']
    AND (b->>'kind') IN ('opening','ledger','plan','recitation','requests','checkpoint','compiled_view')
    AND jsonb_typeof(b->'text')='string' AND char_length(b->>'text') BETWEEN 1 AND 262144
   ELSE false END)) END
$$;
-- An AssistantModelMessage as stored: role assistant, 1..128 blocks of text (32,000
-- characters), tool_use (at most 64 in a reply, the safety range; code runs 16 a turn and
-- answers the rest parallel_limit) or reasoning (text and continuity up to 1 MiB each), and the
-- reply's own stored-size limit: 4 MiB of jsonb text (H6's carry-forward N3). The broker's
-- replyFit refuses a reply above 2 MiB of compact JSON first (over_bound: incomplete, booked,
-- resent with output_cut), and jsonb's text adds at most one space after each ':' and ',', so a
-- reply replyFit lets through always fits; the stored-message bound of results (384 KiB) would
-- cut healthy high-effort replies and is not this one.
CREATE FUNCTION morrow_work.loop_assistant_message_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'object' OR NOT (p ?& ARRAY['role','content']) OR (p-ARRAY['role','content'])<>'{}'::jsonb
   OR p->'role'<>'"assistant"'::jsonb OR jsonb_typeof(p->'content')<>'array' OR jsonb_array_length(p->'content') NOT BETWEEN 1 AND 128
   OR octet_length(p::text)>4194304 THEN false ELSE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(p->'content') b WHERE NOT (CASE WHEN jsonb_typeof(b)<>'object' THEN false
   WHEN b->>'type'='text' THEN (b-ARRAY['type','text'])='{}'::jsonb AND jsonb_typeof(b->'text')='string'
    AND char_length(b->>'text') BETWEEN 1 AND 32000
   WHEN b->>'type'='tool_use' THEN (b-ARRAY['type','id','name','input'])='{}'::jsonb AND b ?& ARRAY['id','name','input']
    AND jsonb_typeof(b->'id')='string' AND (b->>'id') ~ '^[A-Za-z0-9_-]{1,64}$'
    AND jsonb_typeof(b->'name')='string' AND (b->>'name') ~ '^[a-z]+(\.[a-z_]+)+$' AND jsonb_typeof(b->'input')='object'
   WHEN b->>'type'='reasoning' THEN (b-ARRAY['type','text','continuity','redacted'])='{}'::jsonb AND b ?& ARRAY['text','continuity','redacted']
    AND jsonb_typeof(b->'text')='string' AND char_length(b->>'text')<=1048576 AND jsonb_typeof(b->'continuity')='string'
    AND char_length(b->>'continuity')<=1048576 AND (b->>'continuity') ~ '^[A-Za-z0-9+/=_-]*$' AND jsonb_typeof(b->'redacted')='boolean'
   ELSE false END))
  AND (SELECT count(*) FROM jsonb_array_elements(p->'content') b WHERE b->>'type'='tool_use')<=64 END
$$;
-- inbox.ask's choices: 0..5 distinct strings of 1..100 characters.
CREATE FUNCTION morrow_work.loop_choices_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'array' OR jsonb_array_length(p)>5 THEN false
  ELSE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p) c WHERE jsonb_typeof(c)<>'string' OR char_length(c#>>'{}') NOT BETWEEN 1 AND 100)
   AND (SELECT count(DISTINCT c) FROM jsonb_array_elements(p) c)=jsonb_array_length(p) END
$$;
-- The fields each offered tool's operation names (packages/work/src/loop/authority.ts
-- toolFieldScopes, drift-tested): the envelope's and the hop's scope fields are exactly
-- their sorted union over the run's tools, so the delegation is never wider than its tools
-- and never blocks one of them. A tool with no field scope in this build adds none (the
-- harness and memory tools grant nothing and name no field).
CREATE FUNCTION morrow_work.loop_tool_fields(p_tools text[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(q.f ORDER BY q.f COLLATE "C"),'[]'::jsonb) FROM (SELECT DISTINCT u.f FROM unnest(p_tools) t(tool)
  CROSS JOIN LATERAL unnest(CASE t.tool
   WHEN 'products.read' THEN ARRAY['descriptionHtml','seo.description','seo.title','tags','title']
   WHEN 'proposal.listing' THEN ARRAY['descriptionHtml','seo.description','seo.title','tags','title']
   WHEN 'inbox.ask' THEN ARRAY['answerSchema','question','respondentId','taskId']
   WHEN 'message.post' THEN ARRAY['parts','replyToMessageId']
   ELSE ARRAY[]::text[] END) u(f)) q
$$;
-- Audience (ADR-0041 item 25): the workspace, a subject, or one principal.
CREATE FUNCTION morrow_work.harness_audience_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'object' THEN false
  WHEN p->>'kind'='workspace' THEN p='{"kind":"workspace"}'::jsonb
  WHEN p->>'kind'='principal' THEN (p-ARRAY['kind','principalId'])='{}'::jsonb AND jsonb_typeof(p->'principalId')='string'
   AND (p->>'principalId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  WHEN p->>'kind'='subject' THEN (p-ARRAY['kind','subject'])='{}'::jsonb AND jsonb_typeof(p->'subject')='object'
   AND ((p->'subject')-ARRAY['kind','id'])='{}'::jsonb AND (p#>>'{subject,kind}') IN ('project','task','conversation')
   AND jsonb_typeof(p#>'{subject,id}')='string' AND (p#>>'{subject,id}') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ELSE false END
$$;
-- A derived row's source subjects: at most 64 distinct {kind, id}.
CREATE FUNCTION morrow_work.harness_source_subjects_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'array' OR jsonb_array_length(p)>64 THEN false
  ELSE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p) s WHERE jsonb_typeof(s)<>'object' OR (s-ARRAY['kind','id'])<>'{}'::jsonb
    OR (s->>'kind') NOT IN ('project','task','conversation') OR jsonb_typeof(s->'id')<>'string'
    OR (s->>'id') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
   AND (SELECT count(DISTINCT s) FROM jsonb_array_elements(p) s)=jsonb_array_length(p) END
$$;
-- DerivedTaint (ADR-0041 item 34): every taint kind, never truncated, and a source count.
CREATE FUNCTION morrow_work.harness_derived_taint_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'object' OR (p-ARRAY['kinds','sourceCount'])<>'{}'::jsonb OR NOT (p ?& ARRAY['kinds','sourceCount'])
   OR jsonb_typeof(p->'kinds')<>'array' OR jsonb_array_length(p->'kinds')>19 OR jsonb_typeof(p->'sourceCount')<>'number'
   OR (p->>'sourceCount') !~ '^(0|[1-9][0-9]{0,9})$' THEN false
  ELSE (p->>'sourceCount')::bigint<=2147483647
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'kinds') k WHERE jsonb_typeof(k)<>'string' OR (k#>>'{}') NOT IN ('product','inventory',
    'order_summary','support_mail','knowledge_page','artifact','report','upload','sandbox_output','tool_result','message','teammate_result',
    'result_item','notebook_entry','conversation_summary','person_memory','context_checkpoint','thread_post','other_member'))
   AND (SELECT count(DISTINCT k) FROM jsonb_array_elements(p->'kinds') k)=jsonb_array_length(p->'kinds')
   AND (jsonb_array_length(p->'kinds')=0)=((p->>'sourceCount')::bigint=0) END
$$;
-- RunTaint (ADR-0041 item 34): context taint, every kind, up to 256 sources inline and the
-- count of the rest (run_taint_sources holds them all).
CREATE FUNCTION morrow_work.harness_run_taint_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'object' OR (p-ARRAY['contextTaint','kinds','sources','omittedSources'])<>'{}'::jsonb
   OR NOT (p ?& ARRAY['contextTaint','kinds','sources','omittedSources']) OR (p->>'contextTaint') NOT IN ('none','untrusted_external')
   OR jsonb_typeof(p->'sources')<>'array' OR jsonb_array_length(p->'sources')>256 OR jsonb_typeof(p->'omittedSources')<>'number'
   OR (p->>'omittedSources') !~ '^(0|[1-9][0-9]{0,9})$' THEN false
  ELSE morrow_work.harness_derived_taint_valid(jsonb_build_object('kinds',p->'kinds','sourceCount',
    CASE WHEN jsonb_array_length(p->'kinds')=0 THEN 0 ELSE 1 END))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'sources') s WHERE jsonb_typeof(s)<>'object' OR (s-ARRAY['source','sourceId'])<>'{}'::jsonb
    OR NOT (s ?& ARRAY['source','sourceId']) OR NOT (p->'kinds' @> jsonb_build_array(s->'source'))
    OR NOT (s->'sourceId'='null'::jsonb OR (jsonb_typeof(s->'sourceId')='string' AND (s->>'sourceId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')))
   AND (SELECT count(DISTINCT s) FROM jsonb_array_elements(p->'sources') s)=jsonb_array_length(p->'sources')
   AND CASE p->>'contextTaint' WHEN 'none' THEN jsonb_array_length(p->'kinds')=0 AND jsonb_array_length(p->'sources')=0
     AND (p->>'omittedSources')::bigint=0
    ELSE jsonb_array_length(p->'kinds')>=1 AND jsonb_array_length(p->'sources')>=1 END END
$$;
-- ContextSectionTokens: the five sections' token counts.
CREATE FUNCTION morrow_work.harness_section_tokens_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'object' OR (p-ARRAY['tools','system','workspace','opening','conversation'])<>'{}'::jsonb
   OR NOT (p ?& ARRAY['tools','system','workspace','opening','conversation']) THEN false
  ELSE NOT EXISTS(SELECT 1 FROM jsonb_each(p) e WHERE jsonb_typeof(e.value)<>'number' OR (e.value#>>'{}') !~ '^(0|[1-9][0-9]{0,7})$'
   OR (e.value#>>'{}')::bigint>10000000) END
$$;
-- A turn's notices: at most 8 closed codes with a number or null (ADR-0041 item 15).
CREATE FUNCTION morrow_work.harness_notices_valid(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'array' OR jsonb_array_length(p)>8 THEN false
  ELSE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p) n WHERE jsonb_typeof(n)<>'object' OR (n-ARRAY['code','value'])<>'{}'::jsonb
   OR NOT (n ?& ARRAY['code','value']) OR (n->>'code') NOT IN ('checkpoint_request','output_cut','parallel_limit','continue_or_complete',
    'repeat_detected','error_streak','replan','resumed','verification_failed','fork_started')
   OR NOT (n->'value'='null'::jsonb OR (jsonb_typeof(n->'value')='number' AND (n->>'value') ~ '^(0|[1-9][0-9]{0,6})$'
    AND (n->>'value')::integer<=1000000))) END
$$;
-- AgentRunSafety@1 (ADR-0041 items 3, 6 to 9, 17 and 18): its schema's safety ranges and the
-- orderings packages/policy/src/harness.ts checkRunSafety keeps, so a stored profile is one
-- the code accepts. Ranges only: nothing here is a limit that ends work.
CREATE FUNCTION morrow_work.agent_safety_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE d jsonb; n bigint; v_prev bigint;
BEGIN
 IF p IS NULL OR jsonb_typeof(p)<>'object' OR octet_length(p::text)>8192 THEN RETURN false; END IF;
 IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p) k)
   IS DISTINCT FROM ARRAY['checkIns','creditsPark','detectors','envelope','lease','personWait','profileVersion','providerBackoff','schemaVersion',
    'segments','turn'] THEN RETURN false; END IF;
 IF p->'schemaVersion'<>'1'::jsonb OR (p->>'profileVersion')::integer NOT BETWEEN 1 AND 1000 THEN RETURN false; END IF;
 IF ((p->'turn')-ARRAY['maxOutputTokens','callBudgetMs'])<>'{}'::jsonb OR (p#>>'{turn,maxOutputTokens}')::integer NOT BETWEEN 1 AND 128000
  OR (p#>>'{turn,callBudgetMs}')::integer NOT BETWEEN 1000 AND 1800000 THEN RETURN false; END IF;
 d:=p->'checkIns';
 IF (d-ARRAY['modelTurns','toolCalls','activeMs','sinceRequesterActMs','children'])<>'{}'::jsonb
  OR (d->>'modelTurns')::bigint NOT BETWEEN 1 AND 100000 OR (d->>'toolCalls')::bigint NOT BETWEEN 1 AND 1000000
  OR (d->>'activeMs')::bigint NOT BETWEEN 60000 AND 2592000000 OR (d->>'sinceRequesterActMs')::bigint NOT BETWEEN 3600000 AND 31536000000
  OR (d->>'children')::bigint NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
 d:=p->'detectors';
 IF (d-ARRAY['signatureRing','repetition','errorStreak','alternation','idleTurns','stall','costWithoutProgress','renewalThrash','outputCut'])<>'{}'::jsonb
  OR (d->>'signatureRing')::integer NOT BETWEEN 8 AND 256
  OR (d#>>'{repetition,nudgeAt}')::integer NOT BETWEEN 2 AND 30 OR (d#>>'{repetition,tripAt}')::integer NOT BETWEEN 2 AND 30
  OR (d#>>'{repetition,nudgeAt}')::integer>=(d#>>'{repetition,tripAt}')::integer
  OR (d#>>'{errorStreak,nudgeAt}')::integer NOT BETWEEN 2 AND 30 OR (d#>>'{errorStreak,tripAt}')::integer NOT BETWEEN 2 AND 30
  OR (d#>>'{errorStreak,nudgeAt}')::integer>=(d#>>'{errorStreak,tripAt}')::integer
  OR (d#>>'{alternation,nudgeAfterSteps}')::integer NOT BETWEEN 4 AND 128 OR (d#>>'{alternation,tripAfterSteps}')::integer NOT BETWEEN 4 AND 128
  OR (d#>>'{alternation,nudgeAfterSteps}')::integer>=(d#>>'{alternation,tripAfterSteps}')::integer
  OR (d->>'signatureRing')::integer<(d#>>'{alternation,tripAfterSteps}')::integer
  OR (d->>'signatureRing')::integer<(d#>>'{repetition,tripAt}')::integer
  OR (d#>>'{idleTurns,tripAt}')::integer NOT BETWEEN 1 AND 30
  OR (d#>>'{stall,replanAt}')::integer NOT BETWEEN 2 AND 1000 OR (d#>>'{stall,tripAfterReplans}')::integer NOT BETWEEN 1 AND 20
  OR (d#>>'{costWithoutProgress,medianMultiple}')::integer NOT BETWEEN 2 AND 100
  OR (d#>>'{costWithoutProgress,expectedTurns}')::integer NOT BETWEEN 1 AND 100000
  OR (d#>>'{renewalThrash,keptBasisPoints}')::integer NOT BETWEEN 1000 AND 10000 OR (d#>>'{renewalThrash,keptTimes}')::integer NOT BETWEEN 1 AND 20
  OR (d#>>'{renewalThrash,compactions}')::integer NOT BETWEEN 2 AND 50 OR (d#>>'{renewalThrash,withinTurns}')::integer NOT BETWEEN 2 AND 100000
  OR (d#>>'{outputCut,tripAt}')::integer NOT BETWEEN 1 AND 20 THEN RETURN false; END IF;
 IF ((p->'envelope')-ARRAY['activeMs','wallMs'])<>'{}'::jsonb OR (p#>>'{envelope,activeMs}')::bigint NOT BETWEEN 60000 AND 2592000000
  OR (p#>>'{envelope,wallMs}')::bigint NOT BETWEEN 3600000 AND 2592000000
  OR (p#>>'{envelope,activeMs}')::bigint>(p#>>'{envelope,wallMs}')::bigint
  OR (p#>>'{checkIns,activeMs}')::bigint>(p#>>'{envelope,activeMs}')::bigint
  OR (p#>>'{checkIns,sinceRequesterActMs}')::bigint>(p#>>'{envelope,wallMs}')::bigint THEN RETURN false; END IF;
 IF ((p->'lease')-ARRAY['ms','renewBelowMs'])<>'{}'::jsonb OR (p#>>'{lease,ms}')::integer NOT BETWEEN 60000 AND 1800000
  OR (p#>>'{lease,renewBelowMs}')::integer NOT BETWEEN 600000 AND 1800000
  OR (p#>>'{lease,renewBelowMs}')::integer>=(p#>>'{lease,ms}')::integer
  OR (p#>>'{lease,ms}')::integer<least((p#>>'{turn,callBudgetMs}')::integer+120000,1800000)
  OR (p#>>'{turn,callBudgetMs}')::integer+120000>1800000 THEN RETURN false; END IF;
 -- A wait on a person lasts 1 to 365 days; reminders ascend inside it.
 IF ((p->'personWait')-ARRAY['ms','remindersMs'])<>'{}'::jsonb OR (p#>>'{personWait,ms}')::bigint NOT BETWEEN 86400000 AND 31536000000
  OR jsonb_typeof(p#>'{personWait,remindersMs}')<>'array' OR jsonb_array_length(p#>'{personWait,remindersMs}')>4 THEN RETURN false; END IF;
 v_prev:=0;
 FOR n IN SELECT (x#>>'{}')::bigint FROM jsonb_array_elements(p#>'{personWait,remindersMs}') WITH ORDINALITY q(x,o) ORDER BY o LOOP
  IF n<60000 OR n<=v_prev OR n>=(p#>>'{personWait,ms}')::bigint THEN RETURN false; END IF;
  v_prev:=n;
 END LOOP;
 IF ((p->'creditsPark')-ARRAY['closeAfterMs'])<>'{}'::jsonb OR (p#>>'{creditsPark,closeAfterMs}')::bigint NOT BETWEEN 86400000 AND 31536000000 THEN
  RETURN false; END IF;
 d:=p->'providerBackoff';
 IF (d-ARRAY['scheduleMs','thenEveryMs','checkInAfterMs'])<>'{}'::jsonb OR jsonb_typeof(d->'scheduleMs')<>'array'
  OR jsonb_array_length(d->'scheduleMs') NOT BETWEEN 1 AND 12 OR (d->>'thenEveryMs')::bigint NOT BETWEEN 60000 AND 86400000
  OR (d->>'checkInAfterMs')::bigint NOT BETWEEN 3600000 AND 604800000 THEN RETURN false; END IF;
 v_prev:=0;
 FOR n IN SELECT (x#>>'{}')::bigint FROM jsonb_array_elements(d->'scheduleMs') WITH ORDINALITY q(x,o) ORDER BY o LOOP
  IF n NOT BETWEEN 1000 AND 86400000 OR n<=v_prev THEN RETURN false; END IF;
  v_prev:=n;
 END LOOP;
 IF (d->>'thenEveryMs')::bigint<v_prev OR (d->>'checkInAfterMs')::bigint<=(d#>>'{scheduleMs,0}')::bigint THEN RETURN false; END IF;
 IF ((p->'segments')-ARRAY['rollSteps','rollBeforeWaitMs'])<>'{}'::jsonb OR (p#>>'{segments,rollSteps}')::integer NOT BETWEEN 100 AND 10000
  OR (p#>>'{segments,rollBeforeWaitMs}')::bigint NOT BETWEEN 0 AND 86400000
  OR (p#>>'{segments,rollBeforeWaitMs}')::bigint>(p#>>'{lease,ms}')::bigint THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- A run's safety: its catalogue version's template with the entry's max_tokens (ADR-0041 item 8:
-- max_tokens comes from the entry). packages/policy/src/run-safety.ts composes the same.
CREATE FUNCTION morrow_work.agent_safety_compose(p_template jsonb,p_max_output_tokens integer) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_set(p_template,'{turn}',jsonb_build_object('maxOutputTokens',p_max_output_tokens,'callBudgetMs',p_template#>'{turn,callBudgetMs}'))
$$;
-- A RunWaitCondition for its kind (ADR-0041 item 17): the condition names its own kind and
-- only that kind's fields.
CREATE FUNCTION morrow_work.run_wait_condition_valid(p_kind text,p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p IS NULL OR jsonb_typeof(p)<>'object' OR p->>'kind' IS DISTINCT FROM p_kind OR octet_length(p::text)>8192 THEN false
  WHEN p_kind='question' THEN (p-ARRAY['kind','questionId'])='{}'::jsonb AND (p->>'questionId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  WHEN p_kind='checkin' THEN (p-ARRAY['kind','code'])='{}'::jsonb
   AND (p->>'code') IN ('turns','tool_calls','active_time','envelope','children','provider')
  WHEN p_kind='detector' THEN (p-ARRAY['kind','code'])='{}'::jsonb AND (p->>'code') IN ('repetition','error_streak','alternation','idle','stall',
   'cost_without_progress','renewal_thrash','output_cut')
  WHEN p_kind IN ('credits','slot') THEN p=jsonb_build_object('kind',p_kind)
  WHEN p_kind='agent_credit_limit' THEN (p-ARRAY['kind','installationId'])='{}'::jsonb
   AND (p->>'installationId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  WHEN p_kind='children' THEN (p-ARRAY['kind','mode','callIds'])='{}'::jsonb AND (p->>'mode') IN ('any','all')
   AND jsonb_typeof(p->'callIds')='array' AND jsonb_array_length(p->'callIds')<=32
  WHEN p_kind='approval' THEN (p-ARRAY['kind','until','proposalIds'])='{}'::jsonb AND (p->>'until') IN ('decided','applied')
   AND jsonb_typeof(p->'proposalIds')='array' AND jsonb_array_length(p->'proposalIds') BETWEEN 1 AND 64
  WHEN p_kind='timer' THEN (p-ARRAY['kind','until'])='{}'::jsonb AND jsonb_typeof(p->'until')='string'
  WHEN p_kind='provider' THEN (p-ARRAY['kind','attempt','nextAt'])='{}'::jsonb AND jsonb_typeof(p->'attempt')='number'
   AND jsonb_typeof(p->'nextAt')='string'
  WHEN p_kind='idle_followup' THEN (p-ARRAY['kind','callId'])='{}'::jsonb AND (p->>'callId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ELSE false END
$$;
-- AgentRunManifest@1 as admission pins it (ADR-0027 item 1, ADR-0041 items 4 and 6): the
-- canonical text parses to exactly the run's own columns (ids, digests, codes, the lineage, the
-- safety profile and the pinned versions; no content). Checked by agent_run_guard at insert;
-- the manifest columns never change after.
CREATE FUNCTION morrow_work.agent_manifest_matches(p_canonical text,r jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE m jsonb; v_requester jsonb;
BEGIN
 IF p_canonical IS NULL OR r IS NULL OR octet_length(p_canonical)>32768 OR NOT pg_input_is_valid(p_canonical,'jsonb') THEN RETURN false; END IF;
 m:=p_canonical::jsonb;
 IF jsonb_typeof(m)<>'object' THEN RETURN false; END IF;
 IF (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(m) k)
   IS DISTINCT FROM (SELECT array_agg(k ORDER BY k COLLATE "C") FROM unnest(ARRAY['schemaVersion','workflow','runId','organizationId',
    'workspaceId','storeId','connectionId','kind','purpose','taskId','jobId','contextId','conversationId','sourceInboxId','lineage','envelopeId',
    'installationId','mandateId','triggerId','requester','release','systemTextDigest','toolCatalogueVersion','toolCatalogueDigest','tools',
    'modelProfile','safety','pins','specDigest','dataClasses','admittedAt']) k) THEN RETURN false; END IF;
 v_requester:=CASE WHEN r->'requester_membership_id'<>'null'::jsonb THEN jsonb_build_object('kind','human','principalId',r->'requester_principal_id',
   'organizationId',r->'organization_id','workspaceId',r->'workspace_id','membershipId',r->'requester_membership_id','installationId',NULL,
   'mandateId',NULL)
  ELSE jsonb_build_object('kind','installation','installationId',r->'installation_id','mandateId',r->'mandate_id',
   'principalId',r->'agent_principal_id','ownerPrincipalId',r->'requester_principal_id','organizationId',r->'organization_id',
   'workspaceId',r->'workspace_id') END;
 RETURN m->'schemaVersion'='1'::jsonb AND m->'workflow'='"agent-run@1"'::jsonb AND m->'runId'=r->'id'
  AND m->'organizationId'=r->'organization_id' AND m->'workspaceId'=r->'workspace_id'
  AND m->'storeId'=r->'store_id' AND m->'connectionId'=r->'connection_id' AND m->'kind'=r->'kind' AND m->'purpose'=r->'purpose'
  AND m->'taskId'=CASE WHEN r->>'kind'='routed' THEN r->'child_task_id' ELSE r->'task_id' END
  AND m->'jobId'=r->'job_id' AND m->'contextId'=r->'context_id' AND m->'conversationId'=r->'conversation_id'
  AND m->'sourceInboxId'=r->'source_inbox_id'
  AND m->'lineage'=jsonb_build_object('rootRunId',r->'root_run_id','parentRunId',r->'parent_run_id','parentToolUseId',r->'parent_tool_use_id',
   'callId',r->'call_id','depth',r->'depth','forkedFromRunId',r->'forked_from_run_id','forkedAtSequence',r->'forked_at_sequence',
   'continuesRunId',r->'continues_run_id')
  AND m->'envelopeId'=r->'envelope_id' AND m->'installationId'=r->'installation_id' AND m->'mandateId'=r->'mandate_id'
  AND m->'triggerId'=r->'trigger_id' AND m->'requester'=v_requester
  AND m->'release'=jsonb_build_object('id',r->'release_id','revision',r->'release_revision','digest',r->'release_digest')
  AND m->'systemTextDigest'=r->'system_text_digest' AND m->'toolCatalogueVersion'=r->'tool_catalogue_version'
  AND m->'toolCatalogueDigest'=r->'tool_catalogue_digest' AND m->'tools'=r->'tools'
  AND m->'modelProfile'=jsonb_build_object('model',r->'model_key','effort',r->'effort_key','catalogueVersion',r->'catalogue_version')
  AND m->'safety'=r->'safety'
  AND m->'pins'=jsonb_build_object('harnessVersion',r->'harness_version','runnerVersion',r->'runner_version',
   'rendererVersion',r->'renderer_version','loopCatalogueVersion',r->'catalogue_version','contextPolicyVersion',r->'context_policy_version',
   'contextPolicyDigest',r->'context_policy_digest','rateCardVersion',r->'rate_card_version')
  AND m->'specDigest'='null'::jsonb AND m->'dataClasses'='null'::jsonb
  AND jsonb_typeof(m->'admittedAt')='string' AND (m->>'admittedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  AND (m->>'admittedAt')::timestamptz=(r->>'created_at')::timestamptz;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- ---------------------------------------------------------------------------
-- Platform: the agent-loop catalogue (ADR-0027 items 6 and 12, ADR-0041 items 2 and 38),
-- drift-tested against packages/policy/src/generated/loop-catalogue.ts and
-- packages/policy/src/run-safety.ts. Rates are exact integers of 10^-12 USD per token, the
-- provider's prices that metering reads (no money cap: ADR-0039 item 1). A version carries its
-- digest and its safety template (AgentRunSafety@1 without max_tokens, which each entry gives),
-- in place of AgentRunCaps: no turn, call, question or wall-time limit. A new version, or the
-- publication of a proposed one, is a new forward migration; H3 rewrites version 2 Opus-only
-- while it is unpublished.
CREATE TABLE morrow_work.loop_catalogue_versions (
 version integer NOT NULL PRIMARY KEY CHECK (version BETWEEN 2 AND 999),
 status text NOT NULL CHECK (status IN ('proposed','active','retired')),
 digest morrow_work.digest NOT NULL,
 safety_profile_version integer NOT NULL CHECK (safety_profile_version BETWEEN 1 AND 1000),
 safety_template jsonb NOT NULL,
 safety_template_digest morrow_work.digest NOT NULL,
 CONSTRAINT loop_catalogue_versions_safety CHECK (morrow_work.agent_safety_valid(morrow_work.agent_safety_compose(safety_template,1))
  AND safety_template->'profileVersion'=to_jsonb(safety_profile_version)
  AND safety_template_digest::text=morrow_work.sha256_text(morrow_work.harness_jcs(safety_template)))
);
CREATE UNIQUE INDEX loop_catalogue_versions_one_active ON morrow_work.loop_catalogue_versions (status) WHERE status='active';
CREATE TABLE morrow_work.loop_catalogue_entries (
 version integer NOT NULL REFERENCES morrow_work.loop_catalogue_versions(version),
 model_key text NOT NULL CHECK (model_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 effort_key text NOT NULL CHECK (effort_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 provider text NOT NULL CHECK (provider='anthropic'),
 provider_model_id text NOT NULL CHECK (provider_model_id ~ '^[a-z][a-z0-9-]{2,63}$'),
 max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 128000),
 input_usd12_per_token bigint NOT NULL CHECK (input_usd12_per_token>0),
 output_usd12_per_token bigint NOT NULL CHECK (output_usd12_per_token>0),
 cache_write_usd12_per_token bigint NOT NULL CHECK (cache_write_usd12_per_token>0),
 cache_read_usd12_per_token bigint NOT NULL CHECK (cache_read_usd12_per_token>0),
 PRIMARY KEY (version,model_key,effort_key)
);
INSERT INTO morrow_work.loop_catalogue_versions(version,status,digest,safety_profile_version,safety_template,safety_template_digest)
SELECT 2,'proposed','b21bfcfd7a01659501977586dbba42fe7ff164402750833c0a96c9f436a43e5f',1,t::jsonb,morrow_work.sha256_text(t)
FROM (VALUES ('{"checkIns":{"activeMs":86400000,"children":32,"modelTurns":1000,"sinceRequesterActMs":604800000,"toolCalls":10000},"creditsPark":{"closeAfterMs":604800000},"detectors":{"alternation":{"nudgeAfterSteps":6,"tripAfterSteps":8},"costWithoutProgress":{"expectedTurns":25,"medianMultiple":4},"errorStreak":{"nudgeAt":3,"tripAt":5},"idleTurns":{"tripAt":3},"outputCut":{"tripAt":3},"renewalThrash":{"compactions":3,"keptBasisPoints":7000,"keptTimes":2,"withinTurns":20},"repetition":{"nudgeAt":3,"tripAt":4},"signatureRing":32,"stall":{"replanAt":12,"tripAfterReplans":2}},"envelope":{"activeMs":86400000,"wallMs":604800000},"lease":{"ms":1800000,"renewBelowMs":1200000},"personWait":{"ms":604800000,"remindersMs":[86400000,259200000]},"profileVersion":1,"providerBackoff":{"checkInAfterMs":86400000,"scheduleMs":[60000,300000,900000,1800000,3600000],"thenEveryMs":3600000},"schemaVersion":1,"segments":{"rollBeforeWaitMs":300000,"rollSteps":1000},"turn":{"callBudgetMs":1680000}}')) v(t);
INSERT INTO morrow_work.loop_catalogue_entries(version,model_key,effort_key,provider,provider_model_id,max_output_tokens,input_usd12_per_token,
 output_usd12_per_token,cache_write_usd12_per_token,cache_read_usd12_per_token)
SELECT 2,m.model_key,e.effort_key,'anthropic',m.provider_model_id,e.max_output_tokens,m.input,m.output,m.cache_write,m.cache_read
FROM (VALUES ('claude_haiku_5_5','claude-haiku-5-5',100000::bigint,500000::bigint,125000::bigint,10000::bigint,1),
  ('claude_sonnet_5_5','claude-sonnet-5-5',2000000,10000000,2500000,200000,2),
  ('claude_opus_5_5','claude-opus-5-5',4000000,20000000,5000000,200000,3)) m(model_key,provider_model_id,input,output,cache_write,cache_read,o)
CROSS JOIN (VALUES ('low',5000,1),('medium',12000,2),('high',16000,3)) e(effort_key,max_output_tokens,o)
ORDER BY m.o,e.o;
-- ToolCatalogue@1 version 4 (docs/contracts/tool-catalogue.json, generated into
-- packages/policy/src/generated/tool-catalogue.ts; drift-tested): each tool's family, its one
-- capability and verb (none for the memory and harness families, which grant nothing), its
-- replay class and the contexts it is offered in.
CREATE TABLE morrow_work.tool_catalogue_entries (
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
 tool text NOT NULL CHECK (tool ~ '^[a-z]+(\.[a-z_]+)+$'),
 family text NOT NULL CHECK (family IN ('read','internal','coordination','proposal','memory','harness','computer')),
 capability_id text CHECK (capability_id ~ '^[a-z]+(\.[a-z_]+)+$'),
 verb text CHECK (verb IN ('view','propose','execute','delegate')),
 replay_class text NOT NULL CHECK (replay_class IN ('read','internal_write','computer')),
 contexts text[] NOT NULL CHECK (cardinality(contexts) BETWEEN 1 AND 5
  AND contexts<@ARRAY['coordinator','routed','mandate','look_for_work','call']),
 PRIMARY KEY (version,tool),
 CONSTRAINT tool_catalogue_entries_capability CHECK ((family IN ('memory','harness'))=(capability_id IS NULL)
  AND (capability_id IS NULL)=(verb IS NULL))
);
INSERT INTO morrow_work.tool_catalogue_entries(version,tool,family,capability_id,verb,replay_class,contexts) VALUES
 (4,'knowledge.search','read','workspace.knowledge.read','view','read',ARRAY['coordinator','routed','mandate','look_for_work','call']),
 (4,'work.read','read','workspace.artifact.read','view','read',ARRAY['coordinator','routed','mandate','look_for_work','call']),
 (4,'products.read','read','catalog.products.read','view','read',ARRAY['routed','mandate','look_for_work','call']),
 (4,'inventory.read','read','inventory.levels.read','view','read',ARRAY['routed','mandate','look_for_work','call']),
 (4,'orders.summary','read','orders.read','view','read',ARRAY['routed','mandate','look_for_work','call']),
 (4,'support.thread.read','read','support.case.read','view','read',ARRAY['routed','mandate']),
 (4,'message.post','internal','workspace.conversation.post','execute','internal_write',ARRAY['coordinator','routed','mandate']),
 (4,'inbox.ask','internal','workspace.question.request','execute','internal_write',ARRAY['coordinator','routed','mandate']),
 (4,'task.create','internal','workspace.task.create','execute','internal_write',ARRAY['coordinator','routed','mandate','call']),
 (4,'suggestion.create','internal','workspace.comment.create','execute','internal_write',ARRAY['routed','mandate','look_for_work','call']),
 (4,'report.write','internal','workspace.artifact.edit','execute','internal_write',ARRAY['routed','mandate','call']),
 (4,'agent.route','coordination','workspace.task.delegate','delegate','internal_write',ARRAY['coordinator']),
 (4,'agent.ask','coordination','workspace.task.delegate','delegate','internal_write',ARRAY['coordinator']),
 (4,'agent.map','coordination','workspace.task.delegate','delegate','internal_write',ARRAY['coordinator']),
 (4,'agent.message','coordination','workspace.task.delegate','delegate','internal_write',ARRAY['coordinator']),
 (4,'agent.cancel','coordination','workspace.task.delegate','delegate','internal_write',ARRAY['coordinator']),
 (4,'agent.propose','coordination','agents.builder.describe','execute','internal_write',ARRAY['coordinator']),
 (4,'proposal.listing','proposal','catalog.content.publish','propose','internal_write',ARRAY['routed','mandate','call']),
 (4,'proposal.reply','proposal','support.reply.send','propose','internal_write',ARRAY['routed','mandate']),
 (4,'plan.draft','coordination','workspace.conversation.post','execute','internal_write',ARRAY['coordinator']),
 (4,'knowledge.propose','internal','workspace.knowledge.propose','execute','internal_write',ARRAY['coordinator','routed','mandate']),
 (4,'notebook.write','internal','workspace.notebook.write','execute','internal_write',ARRAY['routed','mandate','call']),
 (4,'memory.search','memory',NULL,NULL,'read',ARRAY['coordinator','routed','mandate','look_for_work','call']),
 (4,'memory.read','memory',NULL,NULL,'read',ARRAY['coordinator','routed','mandate','look_for_work','call']),
 (4,'memory.suggest','memory',NULL,NULL,'internal_write',ARRAY['coordinator','routed']),
 (4,'run.plan','harness',NULL,NULL,'internal_write',ARRAY['coordinator','routed','mandate','look_for_work','call']),
 (4,'run.complete','harness',NULL,NULL,'internal_write',ARRAY['coordinator','routed','mandate','look_for_work','call']),
 (4,'run.wait','harness',NULL,NULL,'internal_write',ARRAY['coordinator','routed','mandate']),
 (4,'result.write','harness',NULL,NULL,'internal_write',ARRAY['call']),
 (4,'context.checkpoint','harness',NULL,NULL,'internal_write',ARRAY['coordinator','routed','mandate','look_for_work','call']);
-- ContextPolicy@1 rows (ADR-0041 item 12; docs/decisions/context-policy.json, generated into
-- packages/policy/src/generated/context-policy.ts; drift-tested): one row per model and effort
-- and version, its digest the SHA-256 of its RFC 8785 text, which a run and its context pin.
-- Version 1 is proposed: the context-fill sweep sets the real values, and admission takes only
-- an active row (an unknown or inactive policy refuses admission and attach).
CREATE TABLE morrow_work.context_policy_versions (
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
 model_key text NOT NULL CHECK (model_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 effort_key text NOT NULL CHECK (effort_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 status text NOT NULL CHECK (status IN ('proposed','active','retired')),
 policy jsonb NOT NULL CHECK (jsonb_typeof(policy)='object' AND octet_length(policy::text)<=16384),
 digest morrow_work.digest NOT NULL,
 PRIMARY KEY (version,model_key,effort_key),
 UNIQUE (version,model_key,effort_key,digest),
 CONSTRAINT context_policy_versions_row CHECK (policy->'version'=to_jsonb(version) AND policy->'model'=to_jsonb(model_key)
  AND policy->'effort'=to_jsonb(effort_key) AND policy->'schemaVersion'='1'::jsonb
  AND digest::text=morrow_work.sha256_text(morrow_work.harness_jcs(policy)))
);
CREATE UNIQUE INDEX context_policy_versions_one_active ON morrow_work.context_policy_versions (model_key,effort_key) WHERE status='active';
INSERT INTO morrow_work.context_policy_versions(version,model_key,effort_key,status,policy,digest)
SELECT v.version,v.model_key,v.effort_key,v.status,v.t::jsonb,morrow_work.sha256_text(v.t) FROM (VALUES
 (1,'claude_opus_5_5','high','proposed','{"cache":{"call":{"rest":"5m","system":"1h"},"conversation":{"rest":"1h","system":"1h"},"job":{"rest":"1h","system":"1h"},"upkeep":{"rest":"5m","system":"1h"}},"clear":{"fromBasisPoints":5000,"keepToolUses":4,"minimumBasisPoints":1000},"compact":{"atBasisPoints":8000,"backgroundFromBasisPoints":null,"minimumCutBasisPoints":4000},"effort":"high","evalRecord":null,"hardGuardBasisPoints":5000,"model":"claude_opus_5_5","modelWindowTokens":1000000,"newEpoch":{"keptTailBasisPoints":1250,"targetBasisPoints":4000},"opening":{"checkpointBasisPoints":600,"conversationSummariesTokens":8000,"factsTokens":1000,"knowledgeIndexTokens":4000,"ledgerBasisPoints":500,"notebookIndexTokens":2000,"personMemoryTokens":2000,"pinnedKnowledgeTokens":6000,"teammatesTokens":2000},"recitation":{"tokens":1000,"trigger":"on_change"},"results":{"inlineTokens":24000,"perTurnBasisPoints":1500,"previewTokens":1000},"schemaVersion":1,"storedMessageBytes":393216,"toolCalls":{"inFlight":6,"perTurn":16},"version":1,"workingWindowTokens":200000}'),
 (1,'claude_opus_5_5','medium','proposed','{"cache":{"call":{"rest":"5m","system":"1h"},"conversation":{"rest":"1h","system":"1h"},"job":{"rest":"1h","system":"1h"},"upkeep":{"rest":"5m","system":"1h"}},"clear":{"fromBasisPoints":5000,"keepToolUses":4,"minimumBasisPoints":1000},"compact":{"atBasisPoints":8000,"backgroundFromBasisPoints":null,"minimumCutBasisPoints":4000},"effort":"medium","evalRecord":null,"hardGuardBasisPoints":5000,"model":"claude_opus_5_5","modelWindowTokens":1000000,"newEpoch":{"keptTailBasisPoints":1250,"targetBasisPoints":4000},"opening":{"checkpointBasisPoints":600,"conversationSummariesTokens":8000,"factsTokens":1000,"knowledgeIndexTokens":4000,"ledgerBasisPoints":500,"notebookIndexTokens":2000,"personMemoryTokens":2000,"pinnedKnowledgeTokens":6000,"teammatesTokens":2000},"recitation":{"tokens":1000,"trigger":"on_change"},"results":{"inlineTokens":24000,"perTurnBasisPoints":1500,"previewTokens":1000},"schemaVersion":1,"storedMessageBytes":393216,"toolCalls":{"inFlight":6,"perTurn":16},"version":1,"workingWindowTokens":200000}')
) v(version,model_key,effort_key,status,t);
-- ---------------------------------------------------------------------------
-- Tenant tables (ADR-0041 item 4). Every time is millisecond-truncated (harness_ms). Server
-- ids are uuids. Content-free tables keep 365 days (item 14); content follows its epoch's
-- 90-day clock, set when the epoch closes (H7d), and goes at once on redaction (G9).
-- One job (ADR-0040 item 5): its conversation, requester, origin and state, and the opening
-- and result messages. JobStatus@1 is a per-viewer projection of it and run_events. Content
-- class none. conversation_id and the message ids have no foreign key until P07.T03's
-- conversations land (plan row H4).
CREATE TABLE morrow_work.jobs (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 conversation_id morrow_work.record_id,
 origin text NOT NULL CHECK (origin IN ('ask','project','hand_off','mandate','standing_request','routed')),
 requester_principal_id morrow_work.record_id NOT NULL,
 requester_membership_id morrow_work.record_id,
 state text NOT NULL CHECK (state IN ('not_started','received','reading','queued','working','waiting','paused','checking','done','stopped','failed')),
 opening_message_id morrow_work.record_id,
 result_message_id morrow_work.record_id,
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 updated_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(updated_at)),
 ended_at timestamptz CHECK (morrow_work.harness_ms(ended_at)),
 expires_at timestamptz CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,requester_membership_id,requester_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 CONSTRAINT jobs_requester CHECK (origin='mandate' OR requester_membership_id IS NOT NULL),
 CONSTRAINT jobs_times CHECK (updated_at>=created_at AND (state IN ('done','stopped','failed'))=(ended_at IS NOT NULL)
  AND (ended_at IS NULL)=(expires_at IS NULL) AND (ended_at IS NULL OR (ended_at>=created_at AND expires_at=ended_at+interval '365 days')))
);
-- One context (ADR-0041 item 5): one writer at a time (agent_runs_one_writer), its scope,
-- requester, agent and audience, the pinned tools, system text, model, effort, renderer and
-- context policy, which never change inside it (a change applies from the next context), its
-- current epoch (0 until the first opens) and last sequence, and its read tags and taint,
-- which never shrink. Content class none (its content is its epochs' turns and checkpoints).
CREATE TABLE morrow_work.agent_contexts (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 scope text NOT NULL CHECK (scope IN ('conversation','job','call','upkeep')),
 job_id morrow_work.record_id,
 conversation_id morrow_work.record_id,
 call_id morrow_work.record_id,
 requester_principal_id morrow_work.record_id NOT NULL,
 requester_membership_id morrow_work.record_id,
 agent_principal_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id,
 audience jsonb NOT NULL CHECK (morrow_work.harness_audience_valid(audience)),
 tools text[] NOT NULL CHECK (cardinality(tools) BETWEEN 0 AND 64),
 tool_catalogue_version integer NOT NULL CHECK (tool_catalogue_version BETWEEN 1 AND 1000),
 tool_catalogue_digest morrow_work.digest NOT NULL,
 system_text_digest morrow_work.digest NOT NULL,
 catalogue_version integer NOT NULL,
 model_key text NOT NULL,
 effort_key text NOT NULL,
 renderer_version integer NOT NULL CHECK (renderer_version BETWEEN 1 AND 1000000),
 context_policy_version integer NOT NULL,
 context_policy_digest morrow_work.digest NOT NULL,
 current_epoch integer NOT NULL CHECK (current_epoch BETWEEN 0 AND 100000),
 last_sequence bigint NOT NULL CHECK (last_sequence BETWEEN 0 AND 1000000000),
 read_tags jsonb NOT NULL CHECK (morrow_work.valid_read_tags(read_tags)),
 taint jsonb NOT NULL CHECK (morrow_work.harness_derived_taint_valid(taint)),
 status text NOT NULL CHECK (status IN ('open','closed')),
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 updated_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(updated_at)),
 closed_at timestamptz CHECK (morrow_work.harness_ms(closed_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,job_id) REFERENCES morrow_work.jobs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,requester_membership_id,requester_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (catalogue_version,model_key,effort_key) REFERENCES morrow_work.loop_catalogue_entries(version,model_key,effort_key),
 FOREIGN KEY (context_policy_version,model_key,effort_key,context_policy_digest)
  REFERENCES morrow_work.context_policy_versions(version,model_key,effort_key,digest),
 CONSTRAINT agent_contexts_scope CHECK (CASE scope WHEN 'job' THEN job_id IS NOT NULL AND call_id IS NULL
  WHEN 'conversation' THEN conversation_id IS NOT NULL AND job_id IS NULL AND call_id IS NULL
  WHEN 'call' THEN call_id IS NOT NULL ELSE job_id IS NULL AND conversation_id IS NULL AND call_id IS NULL END),
 CONSTRAINT agent_contexts_times CHECK (updated_at>=created_at AND (status='closed')=(closed_at IS NOT NULL)
  AND (closed_at IS NULL OR closed_at>=created_at) AND (current_epoch>0 OR last_sequence=0))
);
-- A job has one active context per (job, agent) (ADR-0041 item 5).
CREATE UNIQUE INDEX agent_contexts_one_per_job_agent ON morrow_work.agent_contexts (organization_id,workspace_id,job_id,agent_principal_id)
 WHERE status='open' AND scope='job';
-- One epoch of a context (ADR-0041 items 11 to 14): its kind, its opening as a manifest of
-- references and digests (never a copy), the cut and kept tail, the prefix digest, section
-- tokens, the policy and renderer it was rendered with, and its own clock: its content is kept
-- 90 days from its close. Content class none (references, digests and counts only).
CREATE TABLE morrow_work.context_epochs (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 context_id morrow_work.record_id NOT NULL,
 epoch integer NOT NULL CHECK (epoch BETWEEN 1 AND 100000),
 kind text NOT NULL CHECK (kind IN ('initial','clear','compaction','reset','view_rebase','model_rebase','renderer_rebase')),
 cut_sequence bigint CHECK (cut_sequence BETWEEN 1 AND 1000000000),
 tail_from bigint CHECK (tail_from BETWEEN 1 AND 1000000000),
 tail_through bigint CHECK (tail_through BETWEEN 1 AND 1000000000),
 opening jsonb NOT NULL CHECK (jsonb_typeof(opening)='object' AND octet_length(opening::text)<=262144),
 prefix_digest morrow_work.digest NOT NULL,
 section_tokens jsonb NOT NULL CHECK (morrow_work.harness_section_tokens_valid(section_tokens)),
 policy_version integer NOT NULL CHECK (policy_version BETWEEN 1 AND 1000),
 renderer_version integer NOT NULL CHECK (renderer_version BETWEEN 1 AND 1000000),
 opened_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(opened_at)),
 closed_at timestamptz CHECK (morrow_work.harness_ms(closed_at)),
 expires_at timestamptz CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,context_id,epoch),
 FOREIGN KEY (organization_id,workspace_id,context_id) REFERENCES morrow_work.agent_contexts(organization_id,workspace_id,id),
 CONSTRAINT context_epochs_kind CHECK ((kind='initial')=(epoch=1) AND (kind<>'initial' OR (cut_sequence IS NULL AND tail_from IS NULL))
  AND (kind NOT IN ('compaction','reset') OR (cut_sequence IS NOT NULL AND opening ? 'checkpoint'))
  AND (tail_from IS NULL)=(tail_through IS NULL) AND (tail_from IS NULL OR tail_from<=tail_through)),
 CONSTRAINT context_epochs_times CHECK ((closed_at IS NULL)=(expires_at IS NULL) AND (closed_at IS NULL OR (closed_at>=opened_at
  AND expires_at>=closed_at+interval '90 days')))
);
-- One agent run (agent-run@1; ADR-0041 item 4): kind and purpose; lineage (root, parent, the
-- parent's tool_use, the call, depth 0 or 1, fork and continuation); its context, job,
-- conversation and inbox row; segment, incarnation, Workflow instance and heartbeat; the
-- envelope (its id, absolute expiry and the active time at the requester's last act) and the
-- delegation envelope and hop of a routed run; its current lease (none while it waits) and the
-- one open wait; RunTaint and read tags; whether person memory was loaded; credits held,
-- drawn, refunded and absorbed (whole credits, H8); the pinned manifest with its versions
-- (harness, runner, renderer, tool catalogue, loop catalogue, context policy, rate card,
-- safety profile) and AgentRunSafety@1; counters as bigint; a closed end reason. Content class
-- none. Status: queued -> running -> (waiting -> queued -> running)* -> succeeded, failed or
-- cancelled; a terminal run never changes.
CREATE TABLE morrow_work.agent_runs (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 kind text NOT NULL CHECK (kind IN ('coordinator','routed','mandate','call','review','upkeep')),
 purpose text CHECK (purpose IN ('conversation','job')),
 job_id morrow_work.record_id,
 root_run_id morrow_work.record_id NOT NULL,
 parent_run_id morrow_work.record_id,
 parent_tool_use_id text CHECK (parent_tool_use_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 call_id morrow_work.record_id,
 depth smallint NOT NULL CHECK (depth IN (0,1)),
 forked_from_run_id morrow_work.record_id,
 forked_at_sequence bigint CHECK (forked_at_sequence BETWEEN 1 AND 1000000000),
 continues_run_id morrow_work.record_id,
 context_id morrow_work.record_id NOT NULL,
 conversation_id morrow_work.record_id,
 source_inbox_id morrow_work.record_id,
 task_id morrow_work.record_id,
 child_task_id morrow_work.record_id,
 store_id morrow_work.record_id,
 connection_id morrow_work.record_id,
 installation_id morrow_work.record_id,
 mandate_id morrow_work.record_id,
 trigger_id morrow_work.record_id,
 agent_principal_id morrow_work.record_id NOT NULL,
 coordinator_principal_id morrow_work.record_id,
 envelope_id morrow_work.record_id NOT NULL CHECK (envelope_id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 work_envelope_id morrow_work.record_id,
 hop_id morrow_work.record_id,
 envelope_expires_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(envelope_expires_at)),
 envelope_renewed_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(envelope_renewed_at)),
 envelope_active_base_ms bigint NOT NULL CHECK (envelope_active_base_ms>=0),
 lease_id morrow_work.record_id,
 lease_generation morrow_work.revision,
 lease_expires_at timestamptz CHECK (morrow_work.harness_ms(lease_expires_at)),
 lease_renewals integer NOT NULL CHECK (lease_renewals BETWEEN 0 AND 1000000000),
 requester_principal_id morrow_work.record_id NOT NULL,
 requester_membership_id morrow_work.record_id,
 status text NOT NULL CHECK (status IN ('queued','running','waiting','succeeded','failed','cancelled')),
 ended_reason text CHECK (ended_reason IN ('completed','turn_limit','tool_call_limit','cost_budget','wall_time','deadline',
  'question_unanswered','invalid_output','refusal','spend_limit','provider_error','prefix_mismatch','stopped','lease_ended',
  'mandate_ended','task_closed','switch_off','person_wait_expired','checkin_unanswered','envelope_expired','lease_lapsed','internal_error','released')),
 segment integer NOT NULL CHECK (segment BETWEEN 1 AND 1000000),
 incarnation integer NOT NULL CHECK (incarnation BETWEEN 1 AND 1000),
 workflow_instance_id text NOT NULL CHECK (workflow_instance_id=id::text||'-s'||segment||'-i'||incarnation),
 segment_steps integer NOT NULL CHECK (segment_steps BETWEEN 0 AND 10000),
 heartbeat_at timestamptz CHECK (morrow_work.harness_ms(heartbeat_at)),
 active_ms bigint NOT NULL CHECK (active_ms>=0),
 segment_started_at timestamptz CHECK (morrow_work.harness_ms(segment_started_at)),
 wait_id morrow_work.record_id,
 taint jsonb NOT NULL CHECK (morrow_work.harness_run_taint_valid(taint)),
 read_tags jsonb NOT NULL CHECK (morrow_work.valid_read_tags(read_tags)),
 person_memory_loaded boolean NOT NULL,
 credits_held bigint NOT NULL CHECK (credits_held BETWEEN 0 AND 999999999999999999),
 credits_drawn bigint NOT NULL CHECK (credits_drawn BETWEEN 0 AND 999999999999999999),
 credits_refunded bigint NOT NULL CHECK (credits_refunded BETWEEN 0 AND 999999999999999999),
 credits_absorbed bigint NOT NULL CHECK (credits_absorbed BETWEEN 0 AND 999999999999999999),
 release_id text NOT NULL,
 release_revision morrow_work.revision NOT NULL,
 release_digest morrow_work.digest NOT NULL,
 manifest_canonical text NOT NULL CHECK (octet_length(manifest_canonical) BETWEEN 2 AND 32768),
 manifest_digest morrow_work.digest NOT NULL,
 system_text_digest morrow_work.digest NOT NULL,
 tool_catalogue_version integer NOT NULL CHECK (tool_catalogue_version BETWEEN 1 AND 1000),
 tool_catalogue_digest morrow_work.digest NOT NULL,
 tools text[] NOT NULL CHECK (cardinality(tools) BETWEEN 0 AND 64),
 catalogue_version integer NOT NULL,
 model_key text NOT NULL,
 effort_key text NOT NULL,
 safety jsonb NOT NULL CHECK (morrow_work.agent_safety_valid(safety)),
 safety_profile_version integer NOT NULL CHECK (safety_profile_version BETWEEN 1 AND 1000),
 max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 128000),
 call_budget_ms integer NOT NULL CHECK (call_budget_ms BETWEEN 1000 AND 1800000),
 harness_version integer NOT NULL CHECK (harness_version BETWEEN 1 AND 1000000),
 runner_version integer NOT NULL CHECK (runner_version BETWEEN 1 AND 1000000),
 renderer_version integer NOT NULL CHECK (renderer_version BETWEEN 1 AND 1000000),
 context_policy_version integer NOT NULL,
 context_policy_digest morrow_work.digest NOT NULL,
 rate_card_version integer CHECK (rate_card_version BETWEEN 1 AND 1000),
 turns_taken bigint NOT NULL CHECK (turns_taken BETWEEN 0 AND 100000),
 tool_calls_taken bigint NOT NULL CHECK (tool_calls_taken BETWEEN 0 AND 1000000000),
 children_admitted integer NOT NULL CHECK (children_admitted BETWEEN 0 AND 1000000),
 request_digest morrow_work.digest,
 command_id morrow_work.record_id,
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 started_at timestamptz CHECK (morrow_work.harness_ms(started_at)),
 ended_at timestamptz CHECK (morrow_work.harness_ms(ended_at)),
 updated_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,job_id) REFERENCES morrow_work.jobs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,root_run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,parent_run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,forked_from_run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,continues_run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,context_id) REFERENCES morrow_work.agent_contexts(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,task_id) REFERENCES morrow_work.tasks(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,child_task_id) REFERENCES morrow_work.tasks(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,work_envelope_id) REFERENCES morrow_work.work_envelopes(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,hop_id) REFERENCES morrow_work.delegation_hops(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,lease_id) REFERENCES morrow_work.work_leases(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,requester_membership_id,requester_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (release_id,release_revision,release_digest) REFERENCES morrow_work.agent_releases(id,revision,digest),
 FOREIGN KEY (catalogue_version,model_key,effort_key) REFERENCES morrow_work.loop_catalogue_entries(version,model_key,effort_key),
 FOREIGN KEY (context_policy_version,model_key,effort_key,context_policy_digest)
  REFERENCES morrow_work.context_policy_versions(version,model_key,effort_key,digest),
 -- Each kind's binding (AgentRunManifest@1's allOf).
 CONSTRAINT agent_runs_kind CHECK (CASE kind
  WHEN 'coordinator' THEN purpose IS NOT NULL AND installation_id IS NULL AND mandate_id IS NULL AND trigger_id IS NULL
   AND requester_membership_id IS NOT NULL AND depth=0
  WHEN 'routed' THEN store_id IS NOT NULL AND connection_id IS NOT NULL AND installation_id IS NOT NULL AND task_id IS NOT NULL
   AND child_task_id IS NOT NULL AND mandate_id IS NULL AND trigger_id IS NULL AND purpose IS NULL AND requester_membership_id IS NOT NULL
   AND work_envelope_id IS NOT NULL AND work_envelope_id::text=envelope_id::text AND hop_id IS NOT NULL AND coordinator_principal_id IS NOT NULL
  WHEN 'mandate' THEN store_id IS NOT NULL AND connection_id IS NOT NULL AND installation_id IS NOT NULL AND mandate_id IS NOT NULL
   AND trigger_id IS NOT NULL AND task_id IS NOT NULL AND purpose IS NULL AND requester_membership_id IS NULL AND depth=0
  WHEN 'call' THEN store_id IS NOT NULL AND connection_id IS NOT NULL AND installation_id IS NOT NULL AND mandate_id IS NULL
   AND trigger_id IS NULL AND purpose IS NULL AND depth=1 AND call_id IS NOT NULL AND requester_membership_id IS NOT NULL
  WHEN 'review' THEN trigger_id IS NULL AND purpose IS NULL AND depth=1
  ELSE mandate_id IS NULL AND trigger_id IS NULL AND purpose IS NULL AND task_id IS NULL AND job_id IS NULL
   AND requester_membership_id IS NOT NULL AND depth=0 END
  AND (kind='routed' OR (child_task_id IS NULL AND hop_id IS NULL AND work_envelope_id IS NULL))
  AND (installation_id IS NULL OR (store_id IS NOT NULL AND connection_id IS NOT NULL))),
 CONSTRAINT agent_runs_lineage CHECK (CASE depth WHEN 0 THEN parent_run_id IS NULL AND parent_tool_use_id IS NULL AND call_id IS NULL
   AND root_run_id::text=id::text
  ELSE parent_run_id IS NOT NULL AND root_run_id::text<>id::text END
  AND (call_id IS NULL OR parent_tool_use_id IS NOT NULL)
  AND (forked_from_run_id IS NULL)=(forked_at_sequence IS NULL)
  AND (forked_from_run_id IS NULL OR (kind='coordinator' AND purpose='job'))),
 CONSTRAINT agent_runs_purpose CHECK ((purpose IS DISTINCT FROM 'job' OR job_id IS NOT NULL)
  AND (purpose IS DISTINCT FROM 'conversation' OR conversation_id IS NOT NULL)),
 CONSTRAINT agent_runs_status CHECK (CASE status
  WHEN 'queued' THEN lease_id IS NOT NULL AND wait_id IS NULL AND ended_at IS NULL AND ended_reason IS NULL AND segment_started_at IS NULL
  WHEN 'running' THEN lease_id IS NOT NULL AND wait_id IS NULL AND started_at IS NOT NULL AND ended_at IS NULL AND ended_reason IS NULL
   AND segment_started_at IS NOT NULL
  WHEN 'waiting' THEN lease_id IS NULL AND wait_id IS NOT NULL AND ended_at IS NULL AND ended_reason IS NULL AND segment_started_at IS NULL
  WHEN 'succeeded' THEN lease_id IS NULL AND wait_id IS NULL AND ended_at IS NOT NULL AND ended_reason='completed' AND segment_started_at IS NULL
  ELSE lease_id IS NULL AND wait_id IS NULL AND ended_at IS NOT NULL AND ended_reason IS NOT NULL AND ended_reason<>'completed'
   AND segment_started_at IS NULL END
  AND (lease_id IS NULL)=(lease_generation IS NULL) AND (lease_id IS NULL)=(lease_expires_at IS NULL)),
 CONSTRAINT agent_runs_safety CHECK (max_output_tokens=CASE WHEN jsonb_typeof(safety#>'{turn,maxOutputTokens}')='number'
   THEN (safety#>>'{turn,maxOutputTokens}')::numeric END
  AND call_budget_ms=CASE WHEN jsonb_typeof(safety#>'{turn,callBudgetMs}')='number' THEN (safety#>>'{turn,callBudgetMs}')::numeric END
  AND safety_profile_version=CASE WHEN jsonb_typeof(safety->'profileVersion')='number' THEN (safety->>'profileVersion')::numeric END),
 CONSTRAINT agent_runs_manifest CHECK (manifest_digest::text=morrow_work.sha256_text(manifest_canonical)),
 CONSTRAINT agent_runs_times CHECK (updated_at>=created_at AND (started_at IS NULL OR started_at>=created_at)
  AND (ended_at IS NULL OR ended_at>=created_at) AND envelope_renewed_at>=created_at AND envelope_expires_at>envelope_renewed_at
  AND (task_id IS NULL OR child_task_id IS NULL OR task_id::text<>child_task_id::text))
);
-- One writer per context: at most one open (queued, running or waiting) run attached
-- (ADR-0041 item 5); a job has at most one active Morrow run.
CREATE UNIQUE INDEX agent_runs_one_writer ON morrow_work.agent_runs (organization_id,workspace_id,context_id)
 WHERE status IN ('queued','running','waiting');
CREATE UNIQUE INDEX agent_runs_one_morrow_per_job ON morrow_work.agent_runs (organization_id,workspace_id,job_id)
 WHERE kind='coordinator' AND status IN ('queued','running','waiting');
CREATE UNIQUE INDEX agent_runs_lease ON morrow_work.agent_runs (organization_id,workspace_id,lease_id) WHERE lease_id IS NOT NULL;
CREATE UNIQUE INDEX agent_runs_envelope ON morrow_work.agent_runs (organization_id,workspace_id,work_envelope_id) WHERE work_envelope_id IS NOT NULL;
CREATE UNIQUE INDEX agent_runs_child_task ON morrow_work.agent_runs (organization_id,workspace_id,child_task_id) WHERE child_task_id IS NOT NULL;
CREATE INDEX agent_runs_root ON morrow_work.agent_runs (organization_id,workspace_id,root_run_id);
CREATE INDEX agent_runs_task ON morrow_work.agent_runs (organization_id,workspace_id,task_id,created_at,id);
CREATE INDEX agent_runs_open ON morrow_work.agent_runs (organization_id,workspace_id,created_at) WHERE status IN ('queued','running','waiting');
CREATE INDEX agent_runs_queued ON morrow_work.agent_runs (created_at,id) WHERE status='queued';
CREATE INDEX agent_runs_waiting ON morrow_work.agent_runs (created_at,id) WHERE status IN ('running','waiting');
-- The call registry (ADR-0041 item 21; ADR-0040's step rows are a view over it): one call of a
-- parent run's tool_use, its mode, state and follow-up sequence, and its child run and
-- context. Content class none.
CREATE TABLE morrow_work.agent_calls (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 job_id morrow_work.record_id,
 parent_run_id morrow_work.record_id NOT NULL,
 parent_tool_use_id text NOT NULL CHECK (parent_tool_use_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 installation_id morrow_work.record_id NOT NULL,
 mode text NOT NULL CHECK (mode IN ('ask','review')),
 state text NOT NULL CHECK (state IN ('admitted','running','idle','finished','cancelled','released')),
 sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 1000),
 child_run_id morrow_work.record_id,
 child_context_id morrow_work.record_id,
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 updated_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(updated_at)),
 ended_at timestamptz CHECK (morrow_work.harness_ms(ended_at)),
 expires_at timestamptz CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,parent_run_id,parent_tool_use_id),
 FOREIGN KEY (organization_id,workspace_id,job_id) REFERENCES morrow_work.jobs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,parent_run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,child_run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,child_context_id) REFERENCES morrow_work.agent_contexts(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 CONSTRAINT agent_calls_times CHECK (updated_at>=created_at AND (state IN ('finished','cancelled','released'))=(ended_at IS NOT NULL)
  AND (ended_at IS NULL)=(expires_at IS NULL) AND (ended_at IS NULL OR expires_at=ended_at+interval '365 days'))
);
-- One inbox.ask question of a run and the requester's answer (ADR-0041 item 17: one open
-- question at a time; the wait on it is run_waits' question wait, 7 days). Content class
-- workspace: the question the agent wrote and the answer the person wrote, on the run's turns'
-- clock (born 90 days after it is asked; only ever later).
CREATE TABLE morrow_work.agent_run_questions (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 run_id morrow_work.record_id NOT NULL,
 tool_use_id text NOT NULL CHECK (tool_use_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 question text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 4000 AND question ~ '\S'),
 choices jsonb NOT NULL CHECK (morrow_work.loop_choices_valid(choices)),
 status text NOT NULL CHECK (status IN ('open','answered','expired','cancelled')),
 answer text CHECK (char_length(answer) BETWEEN 1 AND 4000 AND answer ~ '\S'),
 answered_by_principal_id morrow_work.record_id,
 answered_by_membership_id morrow_work.record_id,
 resume_lease_id morrow_work.record_id,
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 answered_at timestamptz CHECK (morrow_work.harness_ms(answered_at)),
 expires_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,run_id,tool_use_id),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT agent_run_questions_status CHECK ((status='answered')=(answer IS NOT NULL) AND (status='answered')=(answered_at IS NOT NULL)
  AND (status='answered')=(answered_by_principal_id IS NOT NULL) AND (status='answered')=(answered_by_membership_id IS NOT NULL)
  AND (status='answered')=(resume_lease_id IS NOT NULL) AND (answered_at IS NULL OR answered_at>=created_at)),
 CONSTRAINT agent_run_questions_times CHECK (expires_at>=created_at+interval '90 days')
);
CREATE UNIQUE INDEX agent_run_questions_one_open ON morrow_work.agent_run_questions (organization_id,workspace_id,run_id) WHERE status='open';
-- One durable wait of a run (RunWait@1; ADR-0041 items 7, 9, 17 and 18): its sequence (the
-- wake event is w-<sequence>), kind and typed condition, state, when it wakes or lapses, the
-- code that made it resolvable, and its resolution with the lease source that resumed the run.
-- A wait holds no lease and no credits. One open wait per run. A wait on a person (a question,
-- a check-in, a detector, credits) lapses after 1 to 365 days (the safety profile's 7 days).
-- Content class none; 365 days.
CREATE TABLE morrow_work.run_waits (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 run_id morrow_work.record_id NOT NULL,
 job_id morrow_work.record_id,
 wait_sequence integer NOT NULL CHECK (wait_sequence BETWEEN 1 AND 1000000),
 kind text NOT NULL CHECK (kind IN ('question','checkin','detector','credits','agent_credit_limit','children','approval','timer','provider','slot',
  'idle_followup')),
 condition jsonb NOT NULL,
 question_id morrow_work.record_id,
 state text NOT NULL CHECK (state IN ('open','resolvable','resolved','lapsed','cancelled')),
 resolvable_code text CHECK (resolvable_code IN ('answered','continued','continued_with_guidance','accepted_as_is','followup_delivered',
  'child_finished','proposal_decided','operation_applied','time_reached','credits_covered','slot_free','provider_back')),
 resolution_code text CHECK (resolution_code IN ('answered','continued','continued_with_guidance','accepted_as_is','followup_delivered',
  'child_finished','proposal_decided','operation_applied','time_reached','credits_covered','slot_free','provider_back','stopped','lapsed','released')),
 resolution_lease_source text CHECK (resolution_lease_source IN ('person_act','mandate_trigger','parent_admission','step_renewal','wait_resume',
  'upkeep_admission','standing_request_firing')),
 opened_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(opened_at)),
 wake_at timestamptz CHECK (morrow_work.harness_ms(wake_at)),
 lapses_at timestamptz CHECK (morrow_work.harness_ms(lapses_at)),
 resolvable_at timestamptz CHECK (morrow_work.harness_ms(resolvable_at)),
 resolved_at timestamptz CHECK (morrow_work.harness_ms(resolved_at)),
 expires_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,run_id,wait_sequence),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,job_id) REFERENCES morrow_work.jobs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,question_id) REFERENCES morrow_work.agent_run_questions(organization_id,workspace_id,id),
 CONSTRAINT run_waits_condition CHECK (morrow_work.run_wait_condition_valid(kind,condition)
  AND (kind='question')=(question_id IS NOT NULL) AND (question_id IS NULL OR condition->>'questionId'=question_id::text)),
 -- Safety ranges only: a wait on a person lasts 1 to 365 days; any other at most 365 days.
 CONSTRAINT run_waits_window CHECK (CASE WHEN kind IN ('question','checkin','detector','credits')
   THEN lapses_at IS NOT NULL AND lapses_at BETWEEN opened_at+interval '1 day' AND opened_at+interval '365 days'
  ELSE lapses_at IS NULL OR lapses_at BETWEEN opened_at AND opened_at+interval '365 days' END
  AND (wake_at IS NULL OR wake_at BETWEEN opened_at AND opened_at+interval '365 days')),
 CONSTRAINT run_waits_state CHECK (CASE state
  WHEN 'open' THEN resolvable_code IS NULL AND resolvable_at IS NULL AND resolution_code IS NULL AND resolved_at IS NULL
  WHEN 'resolvable' THEN resolvable_code IS NOT NULL AND resolvable_at IS NOT NULL AND resolution_code IS NULL AND resolved_at IS NULL
  WHEN 'resolved' THEN resolution_code IS NOT NULL AND resolution_code NOT IN ('stopped','lapsed','released') AND resolved_at IS NOT NULL
   AND resolution_lease_source IS NOT NULL
  WHEN 'lapsed' THEN resolution_code='lapsed' AND resolved_at IS NOT NULL AND resolution_lease_source IS NULL
  ELSE resolution_code IN ('stopped','released') AND resolved_at IS NOT NULL AND resolution_lease_source IS NULL END
  AND (resolution_code IS NOT NULL OR resolution_lease_source IS NULL)),
 CONSTRAINT run_waits_times CHECK ((resolvable_at IS NULL OR resolvable_at>=opened_at) AND (resolved_at IS NULL OR resolved_at>=opened_at)
  AND expires_at=opened_at+interval '365 days')
);
CREATE UNIQUE INDEX run_waits_one_open ON morrow_work.run_waits (organization_id,workspace_id,run_id) WHERE state IN ('open','resolvable');
CREATE INDEX run_waits_due ON morrow_work.run_waits (opened_at,id) WHERE state IN ('open','resolvable');
ALTER TABLE morrow_work.agent_runs ADD CONSTRAINT agent_runs_call_fkey FOREIGN KEY (organization_id,workspace_id,call_id)
 REFERENCES morrow_work.agent_calls(organization_id,workspace_id,id);
ALTER TABLE morrow_work.agent_runs ADD CONSTRAINT agent_runs_wait_fkey FOREIGN KEY (organization_id,workspace_id,wait_id)
 REFERENCES morrow_work.run_waits(organization_id,workspace_id,id);
-- The model-written hand-off of an epoch (ADR-0041 items 11 and 13): a provider compaction
-- block and its readable summary, or a fallback ContextCheckpoint@1, its validation result, and
-- its read tags, audience, source subjects and taint. Content class workspace (a model's
-- narrative over the context; no store text enters a context before the switch's
-- store_content_cleanup prerequisite).
CREATE TABLE morrow_work.context_checkpoints (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 context_id morrow_work.record_id NOT NULL,
 epoch integer NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 kind text NOT NULL CHECK (kind IN ('provider_compaction','fallback')),
 through_sequence bigint NOT NULL CHECK (through_sequence BETWEEN 1 AND 1000000000),
 summary text CHECK (char_length(summary) BETWEEN 1 AND 131072),
 block text CHECK (char_length(block) BETWEEN 1 AND 1048576 AND block ~ '^[A-Za-z0-9+/=_-]*$'),
 content jsonb CHECK (jsonb_typeof(content)='object' AND octet_length(content::text)<=1048576),
 validation_result text NOT NULL CHECK (validation_result IN ('valid','rejected')),
 validation_code text CHECK (validation_code IN ('claims_approval','claims_consent','claims_apply','claims_payment','state_mismatch',
  'unknown_label','quote_mismatch','unknown_record','customer_data','over_budget')),
 read_tags jsonb NOT NULL CHECK (morrow_work.valid_read_tags(read_tags)),
 audience jsonb NOT NULL CHECK (morrow_work.harness_audience_valid(audience)),
 source_subjects jsonb NOT NULL CHECK (morrow_work.harness_source_subjects_valid(source_subjects)),
 taint jsonb NOT NULL CHECK (morrow_work.harness_derived_taint_valid(taint)),
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 expires_at timestamptz CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,context_id,epoch) REFERENCES morrow_work.context_epochs(organization_id,workspace_id,context_id,epoch),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT context_checkpoints_kind CHECK (CASE kind WHEN 'provider_compaction' THEN summary IS NOT NULL AND block IS NOT NULL AND content IS NULL
  ELSE summary IS NULL AND block IS NULL AND content IS NOT NULL END
  AND (validation_result='valid')=(validation_code IS NULL)),
 CONSTRAINT context_checkpoints_times CHECK (expires_at IS NULL OR expires_at>=created_at+interval '90 days')
);
-- One model call's row of a context (RunTurn@1; ADR-0041 items 4, 8 and 13): keyed by context
-- and sequence, with its run, turn (1 to 100,000) and attempt, epoch, purpose and notices; the
-- input (null at an epoch's first row, whose opening carries the request), the reply (only with
-- end_turn or tool_use; its own stored-size limit, loop_assistant_message_valid), the prefix
-- digests, usage, section tokens, the call budget fixed when it opened (up to 30 minutes), and
-- its read tags, audience and taint. `final` is gone: there is no final turn. Content class
-- workspace; 90 days from its epoch's close (H7d sets it), thinking removed when it stops
-- being sent.
CREATE TABLE morrow_work.run_turns (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 context_id morrow_work.record_id NOT NULL,
 sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 1000000000),
 run_id morrow_work.record_id NOT NULL,
 turn integer NOT NULL CHECK (turn BETWEEN 1 AND 100000),
 attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 1000),
 epoch integer NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('turn','compaction','checkpoint','review','summary')),
 notices jsonb NOT NULL CHECK (morrow_work.harness_notices_valid(notices)),
 input jsonb CHECK (input IS NULL OR morrow_work.loop_user_message_valid(input)),
 input_digest morrow_work.digest,
 output jsonb CHECK (output IS NULL OR morrow_work.loop_assistant_message_valid(output)),
 outcome text CHECK (outcome IN ('end_turn','tool_use','incomplete','refusal','invalid_output','spend_limit','provider_error','uncertain',
  'not_sent','input_over_cap','prefix_mismatch','compacted','lease_refused')),
 prefix_digest_before morrow_work.digest,
 prefix_digest_after morrow_work.digest,
 input_tokens bigint CHECK (input_tokens BETWEEN 0 AND 10000000),
 cache_write_tokens bigint CHECK (cache_write_tokens BETWEEN 0 AND 10000000),
 cache_read_tokens bigint CHECK (cache_read_tokens BETWEEN 0 AND 10000000),
 output_tokens bigint CHECK (output_tokens BETWEEN 0 AND 10000000),
 section_tokens jsonb CHECK (section_tokens IS NULL OR morrow_work.harness_section_tokens_valid(section_tokens)),
 budget_ms integer NOT NULL CHECK (budget_ms BETWEEN 1000 AND 1800000),
 read_tags jsonb NOT NULL CHECK (morrow_work.valid_read_tags(read_tags)),
 audience jsonb NOT NULL CHECK (morrow_work.harness_audience_valid(audience)),
 taint jsonb NOT NULL CHECK (morrow_work.harness_derived_taint_valid(taint)),
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 updated_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(updated_at)),
 expires_at timestamptz CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,context_id,sequence),
 UNIQUE (organization_id,workspace_id,run_id,turn,attempt),
 FOREIGN KEY (organization_id,workspace_id,context_id,epoch) REFERENCES morrow_work.context_epochs(organization_id,workspace_id,context_id,epoch),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT run_turns_reply CHECK ((output IS NOT NULL)=(outcome IS NOT NULL AND outcome IN ('end_turn','tool_use'))
  AND (output IS NOT NULL)=(prefix_digest_after IS NOT NULL) AND (input IS NULL)=(input_digest IS NULL)
  AND (purpose<>'compaction' OR (input IS NULL AND output IS NULL))
  AND (input_tokens IS NULL)=(output_tokens IS NULL) AND (input_tokens IS NULL)=(cache_write_tokens IS NULL)
  AND (input_tokens IS NULL)=(cache_read_tokens IS NULL)
  AND (outcome IS NOT NULL OR (input_tokens IS NULL AND prefix_digest_before IS NULL))),
 CONSTRAINT run_turns_times CHECK (updated_at>=created_at AND (expires_at IS NULL OR expires_at>=created_at+interval '90 days'))
);
-- One tool call (RunToolCall@1): ids, codes, digests and its stable label (c17) per context;
-- the input and the result live in run_turns. Born started (counted, unless it is not offered
-- or past the turn's parallel calls: then born uncounted and it can only finish refused with
-- that code, however often its step is retried); finished once. Capability and verb are null
-- exactly for the memory and harness tools. Content class none; 365 days.
CREATE TABLE morrow_work.run_tool_calls (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 tool_use_id text NOT NULL CHECK (tool_use_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 context_id morrow_work.record_id NOT NULL,
 turn integer NOT NULL CHECK (turn BETWEEN 1 AND 100000),
 ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
 label text NOT NULL CHECK (label ~ '^c[1-9][0-9]{0,5}$'),
 tool text NOT NULL CHECK (tool ~ '^[a-z]+(\.[a-z_]+)+$'),
 capability_id text CHECK (capability_id ~ '^[a-z]+(\.[a-z_]+)+$'),
 verb text CHECK (verb IN ('view','propose','approve','execute','delegate','administer')),
 replay_class text NOT NULL CHECK (replay_class IN ('read','internal_write','computer')),
 input_digest morrow_work.digest NOT NULL,
 counted boolean NOT NULL,
 outcome text CHECK (outcome IN ('ok','refused','invalid_input','tool_outcome_unknown','computer_unavailable')),
 refusal text CHECK (refusal IN ('not_offered','lease_ended','run_closed','deadline_passed','task_closed','release_revoked','switch_off',
  'stopped','input_invalid','id_out_of_scope','authority_denied','budget_exhausted','tool_call_limit','question_limit','report_in_turn',
  'result_too_large','sender_inactive','sender_not_usable','customer_data','pending_limit','teammate_unavailable','children_limit',
  'insufficient_credits','result_customer_tagged','item_not_received','page_out_of_range','hand_off_in_ask','card_tool_excluded','card_limit',
  'parallel_limit','fork_first','retry_blocked','recall_out_of_scope','call_not_found','call_not_idle','milestone_too_soon',
  'checkpoint_not_requested','plan_not_set','verification_failed','item_closed','plan_full')),
 result_digest morrow_work.digest,
 result_bytes integer CHECK (result_bytes BETWEEN 0 AND 67108864),
 item_id morrow_work.record_id,
 record_kind text CHECK (record_kind IN ('message','question','task','suggestion','artifact','proposal','knowledge_proposal','notebook_entry',
  'agent_card','teammate_run','teammate_result','agent_call','agent_map','agent_message','memory_suggestion','run_plan_revision','run_completion',
  'run_wait','result_item','context_checkpoint')),
 record_id morrow_work.record_id,
 started_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(started_at)),
 finished_at timestamptz CHECK (morrow_work.harness_ms(finished_at)),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (organization_id,workspace_id,run_id,tool_use_id),
 UNIQUE (organization_id,workspace_id,run_id,turn,ordinal),
 UNIQUE (organization_id,workspace_id,context_id,label),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,context_id) REFERENCES morrow_work.agent_contexts(organization_id,workspace_id,id),
 CONSTRAINT run_tool_calls_outcome CHECK (CASE WHEN outcome IS NULL THEN refusal IS NULL AND result_digest IS NULL AND result_bytes IS NULL
   AND finished_at IS NULL AND record_kind IS NULL AND record_id IS NULL AND item_id IS NULL
  WHEN outcome='refused' THEN refusal IS NOT NULL AND refusal<>'input_invalid' AND finished_at IS NOT NULL
  WHEN outcome='invalid_input' THEN refusal='input_invalid' AND finished_at IS NOT NULL
  ELSE refusal IS NULL AND finished_at IS NOT NULL END
  AND (record_kind IS NULL)=(record_id IS NULL) AND (result_digest IS NULL)=(result_bytes IS NULL)
  AND (outcome IS NULL OR result_digest IS NOT NULL) AND (capability_id IS NULL)=(verb IS NULL)),
 CONSTRAINT run_tool_calls_counted CHECK (counted OR outcome IS NULL OR (outcome='refused' AND refusal IN ('not_offered','parallel_limit'))),
 CONSTRAINT run_tool_calls_times CHECK ((finished_at IS NULL OR finished_at>=started_at) AND expires_at=started_at+interval '365 days')
);
-- One model call (the broker's fence and the traceRef target; ADR-0041 item 8): keyed by the
-- turn row's run, turn and attempt, and its resend sequence; its purpose, epoch and cache TTL;
-- the outcome, usage and section tokens; the call budget and max_tokens of the send (safety
-- ranges: 30 minutes, 128,000); and its credits (held for the send, drawn at its close: H8) and
-- the metered provider cost at the catalogue's rates. One open call per run and purpose.
-- Content-free.
CREATE TABLE morrow_work.agent_model_calls (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 run_id morrow_work.record_id NOT NULL,
 context_id morrow_work.record_id NOT NULL,
 turn integer NOT NULL CHECK (turn BETWEEN 1 AND 100000),
 attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 1000),
 sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 1000),
 purpose text NOT NULL CHECK (purpose IN ('turn','compaction','checkpoint','review','summary')),
 epoch integer NOT NULL CHECK (epoch BETWEEN 1 AND 100000),
 cache_ttl text NOT NULL CHECK (cache_ttl IN ('5m','1h')),
 status text NOT NULL CHECK (status IN ('started','closed')),
 outcome text CHECK (outcome IN ('end_turn','tool_use','incomplete','refusal','invalid_output','spend_limit','provider_error','uncertain',
  'not_sent','input_over_cap','prefix_mismatch','compacted','lease_refused')),
 counted boolean,
 raw_stop_reason text CHECK (raw_stop_reason ~ '^[a-z_]{1,32}$'),
 provider_request_id text CHECK (provider_request_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 provider_model_id text CHECK (provider_model_id ~ '^[A-Za-z0-9._-]{1,128}$'),
 counted_input_tokens bigint CHECK (counted_input_tokens BETWEEN 0 AND 10000000),
 input_tokens bigint CHECK (input_tokens BETWEEN 0 AND 10000000),
 cache_write_tokens bigint CHECK (cache_write_tokens BETWEEN 0 AND 10000000),
 cache_read_tokens bigint CHECK (cache_read_tokens BETWEEN 0 AND 10000000),
 output_tokens bigint CHECK (output_tokens BETWEEN 0 AND 10000000),
 section_tokens jsonb CHECK (section_tokens IS NULL OR morrow_work.harness_section_tokens_valid(section_tokens)),
 budget_ms integer NOT NULL CHECK (budget_ms BETWEEN 1000 AND 1800000),
 max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 128000),
 credits_held bigint CHECK (credits_held BETWEEN 0 AND 999999999999999999),
 credits_drawn bigint CHECK (credits_drawn BETWEEN 0 AND 999999999999999999),
 metered_usd12 bigint CHECK (metered_usd12>=0),
 started_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(started_at)),
 closed_at timestamptz CHECK (morrow_work.harness_ms(closed_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,run_id,turn,attempt,sequence),
 FOREIGN KEY (organization_id,workspace_id,run_id,turn,attempt) REFERENCES morrow_work.run_turns(organization_id,workspace_id,run_id,turn,attempt),
 CONSTRAINT agent_model_calls_state CHECK (CASE status WHEN 'started' THEN outcome IS NULL AND counted IS NULL AND closed_at IS NULL
   AND credits_drawn IS NULL AND metered_usd12 IS NULL AND provider_request_id IS NULL AND provider_model_id IS NULL AND raw_stop_reason IS NULL
   AND input_tokens IS NULL AND output_tokens IS NULL AND cache_write_tokens IS NULL AND cache_read_tokens IS NULL
  ELSE outcome IS NOT NULL AND counted IS NOT NULL AND closed_at IS NOT NULL AND closed_at>=started_at
   AND counted=(outcome IN ('end_turn','tool_use','incomplete','refusal','invalid_output','uncertain','compacted')
    OR (outcome='provider_error' AND input_tokens IS NOT NULL)) END)
);
CREATE UNIQUE INDEX agent_model_calls_one_open ON morrow_work.agent_model_calls (organization_id,workspace_id,run_id,purpose) WHERE status='started';
-- One plan per job (RunPlan@1; ADR-0041 item 16) and its append-only revisions: the plan as
-- run.plan stored it (no field names a tool, capability, scope, store, model, recipient or
-- limit; code refuses plan_full before a revision passes the record's bounds), its digest,
-- why a frozen criterion changed, and its read tags, audience, source subjects and taint.
-- run_plans is content-free; revisions are content class workspace.
CREATE TABLE morrow_work.run_plans (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 job_id morrow_work.record_id NOT NULL,
 created_by_run_id morrow_work.record_id NOT NULL,
 current_revision integer NOT NULL CHECK (current_revision BETWEEN 1 AND 1000000),
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 updated_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,job_id),
 FOREIGN KEY (organization_id,workspace_id,job_id) REFERENCES morrow_work.jobs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,created_by_run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT run_plans_times CHECK (updated_at>=created_at)
);
CREATE TABLE morrow_work.run_plan_revisions (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 plan_id morrow_work.record_id NOT NULL,
 revision integer NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
 run_id morrow_work.record_id NOT NULL,
 plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object'),
 plan_digest morrow_work.digest NOT NULL,
 change_kind text CHECK (change_kind IN ('requester_message','logged_reason')),
 read_tags jsonb NOT NULL CHECK (morrow_work.valid_read_tags(read_tags)),
 audience jsonb NOT NULL CHECK (morrow_work.harness_audience_valid(audience)),
 source_subjects jsonb NOT NULL CHECK (morrow_work.harness_source_subjects_valid(source_subjects)),
 taint jsonb NOT NULL CHECK (morrow_work.harness_derived_taint_valid(taint)),
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 expires_at timestamptz CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,plan_id,revision),
 FOREIGN KEY (organization_id,workspace_id,plan_id) REFERENCES morrow_work.run_plans(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT run_plan_revisions_plan CHECK (plan->'revision'=to_jsonb(revision) AND plan->'schemaVersion'='1'::jsonb
  AND plan_digest::text=morrow_work.sha256_text(morrow_work.harness_jcs(plan))
  AND (revision>1 OR change_kind IS NULL) AND plan->'change'->>'kind' IS NOT DISTINCT FROM change_kind),
 CONSTRAINT run_plan_revisions_times CHECK (expires_at IS NULL OR expires_at>=created_at+interval '90 days')
);
-- One content-free event stream per root run (RunEvent@1; ADR-0041 item 36), numbered by
-- sequence, appended in the transaction of each state change: ids, codes, counts, token counts,
-- durations, credits and digests only. The raw sequence never leaves the server. 365 days.
CREATE TABLE morrow_work.run_events (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 root_run_id morrow_work.record_id NOT NULL,
 sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 1000000000),
 run_id morrow_work.record_id NOT NULL,
 job_id morrow_work.record_id,
 context_id morrow_work.record_id,
 kind text NOT NULL CHECK (kind IN ('run.admitted','run.started','run.segment_rolled','run.lease_renewed','run.lease_refused','run.ended',
  'turn.sent','turn.finished','turn.resent','tool.dispatched','tool.finished','tool.refused','call.admitted','call.finished','call.followed_up',
  'call.guided','call.cancelled','call.released','wait.opened','wait.resolvable','wait.resolved','wait.lapsed','plan.set','plan.item_changed',
  'plan.criterion_changed','completion.accepted','completion.refused','review.admitted','review.verdict','credits.held','credits.drawn',
  'credits.refunded','credits.absorbed','credits.parked','credits.resumed','detector.nudged','detector.tripped','checkin.opened',
  'checkin.continued','notice.sent','taint.joined','approval.waiting','operation.unknown','provider.retried','provider.parked','cache.alarm',
  'context.epoch_started','context.cleared','context.compacted','context.checkpointed','context.rebased','context.recalled','context.forked',
  'memory.read','memory.suggested')),
 code text CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
 ref_kind text CHECK (ref_kind IN ('run','context','epoch','checkpoint','turn','tool_call','call','wait','plan','review','proposal','operation',
  'question','message','result_item','memory')),
 ref_id morrow_work.record_id,
 count bigint CHECK (count BETWEEN 0 AND 1000000000),
 tokens_before bigint CHECK (tokens_before BETWEEN 0 AND 100000000),
 tokens_after bigint CHECK (tokens_after BETWEEN 0 AND 100000000),
 duration_ms bigint CHECK (duration_ms BETWEEN 0 AND 31536000000),
 credits bigint CHECK (credits BETWEEN 0 AND 999999999999999999),
 digest morrow_work.digest,
 at timestamptz NOT NULL CHECK (morrow_work.harness_ms(at)),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (organization_id,workspace_id,root_run_id,sequence),
 FOREIGN KEY (organization_id,workspace_id,root_run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT run_events_shape CHECK ((ref_kind IS NULL)=(ref_id IS NULL)
  AND (kind<>'run.ended' OR code IS NOT NULL)
  AND (kind NOT IN ('context.cleared','context.compacted','context.rebased','context.epoch_started')
   OR (tokens_before IS NOT NULL AND tokens_after IS NOT NULL))
  AND (kind NOT IN ('credits.held','credits.drawn','credits.refunded','credits.absorbed') OR credits IS NOT NULL)
  AND (kind NOT IN ('wait.opened','wait.resolvable','wait.resolved','wait.lapsed') OR ref_kind='wait')),
 CONSTRAINT run_events_times CHECK (expires_at=at+interval '365 days')
);
-- One result of a call per follow-up sequence (TeammateResult@1; ADR-0041 items 21 and 23):
-- outcome and next (code's, never model text), the result as stored, its digest and its read
-- tags, audience, source subjects and taint. Content class workspace.
CREATE TABLE morrow_work.teammate_results (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 call_id morrow_work.record_id NOT NULL,
 sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 1000),
 run_id morrow_work.record_id NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('done','partial','nothing_found','blocked','cannot_do','no_result','stopped','failed')),
 next text NOT NULL CHECK (next IN ('none','follow_up','rebrief','reroute','retry_later','ask_person','do_not_retry')),
 result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
 result_digest morrow_work.digest NOT NULL,
 read_tags jsonb NOT NULL CHECK (morrow_work.valid_read_tags(read_tags)),
 audience jsonb NOT NULL CHECK (morrow_work.harness_audience_valid(audience)),
 source_subjects jsonb NOT NULL CHECK (morrow_work.harness_source_subjects_valid(source_subjects)),
 taint jsonb NOT NULL CHECK (morrow_work.harness_derived_taint_valid(taint)),
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 expires_at timestamptz CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,call_id,sequence),
 FOREIGN KEY (organization_id,workspace_id,call_id) REFERENCES morrow_work.agent_calls(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT teammate_results_result CHECK (result->>'outcome'=outcome AND result->>'next'=next
  AND result_digest::text=morrow_work.sha256_text(morrow_work.harness_jcs(result))),
 CONSTRAINT teammate_results_times CHECK (expires_at IS NULL OR expires_at>=created_at+interval '90 days')
);
-- Result items, the shared artifact plane (ResultItem@1 and ResultItemPage@1; ADR-0041 item
-- 22): written across turns with result.write, open until closed, in pages of at most 256 KiB
-- so any read fits one step; with their read tags, audience, source subjects and taint.
-- Content class workspace.
CREATE TABLE morrow_work.result_items (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 call_id morrow_work.record_id,
 title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title ~ '\S'),
 kind text NOT NULL CHECK (kind IN ('text','table','file')),
 media_type text NOT NULL CHECK (media_type IN ('text/plain','text/markdown','text/csv','application/json')),
 columns jsonb CHECK (columns IS NULL OR (jsonb_typeof(columns)='array' AND jsonb_array_length(columns) BETWEEN 1 AND 32)),
 open boolean NOT NULL,
 sections integer NOT NULL CHECK (sections BETWEEN 0 AND 1000000),
 pages integer NOT NULL CHECK (pages BETWEEN 0 AND 1000000),
 bytes bigint NOT NULL CHECK (bytes BETWEEN 0 AND 274877906944),
 read_tags jsonb NOT NULL CHECK (morrow_work.valid_read_tags(read_tags)),
 audience jsonb NOT NULL CHECK (morrow_work.harness_audience_valid(audience)),
 source_subjects jsonb NOT NULL CHECK (morrow_work.harness_source_subjects_valid(source_subjects)),
 taint jsonb NOT NULL CHECK (morrow_work.harness_derived_taint_valid(taint)),
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 updated_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(updated_at)),
 closed_at timestamptz CHECK (morrow_work.harness_ms(closed_at)),
 expires_at timestamptz CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,call_id) REFERENCES morrow_work.agent_calls(organization_id,workspace_id,id),
 CONSTRAINT result_items_shape CHECK ((kind='table')=(columns IS NOT NULL) AND open=(closed_at IS NULL)),
 CONSTRAINT result_items_times CHECK (updated_at>=created_at AND (closed_at IS NULL OR closed_at>=created_at)
  AND (expires_at IS NULL OR expires_at>=created_at+interval '90 days'))
);
CREATE TABLE morrow_work.result_item_pages (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 item_id morrow_work.record_id NOT NULL,
 page integer NOT NULL CHECK (page BETWEEN 1 AND 1000000),
 content text NOT NULL CHECK (octet_length(content)<=262144),
 digest morrow_work.digest NOT NULL,
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 expires_at timestamptz CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,item_id,page),
 FOREIGN KEY (organization_id,workspace_id,item_id) REFERENCES morrow_work.result_items(organization_id,workspace_id,id),
 CONSTRAINT result_item_pages_digest CHECK (digest::text=morrow_work.sha256_text(content)
  AND (expires_at IS NULL OR expires_at>=created_at+interval '90 days'))
);
-- The detectors' content-free state per run (ADR-0041 item 18): a ring of the last call
-- signatures (digests), the counters and the sequence of the last progress event, so a replay
-- reaches the same verdict. 365 days.
CREATE TABLE morrow_work.run_detector_state (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 ring jsonb NOT NULL CHECK (jsonb_typeof(ring)='array' AND jsonb_array_length(ring)<=256 AND NOT jsonb_path_exists(ring,
  '$[*] ? (@.type() != "string" || !(@ like_regex "^[a-f0-9]{64}$"))')),
 counters jsonb NOT NULL CHECK (jsonb_typeof(counters)='object' AND NOT jsonb_path_exists(counters,
  '$.* ? (@.type() != "number" || @ < 0 || @ > 1000000000)') AND jsonb_array_length(jsonb_path_query_array(counters,'$.keyvalue()'))<=16),
 progress_sequence bigint NOT NULL CHECK (progress_sequence BETWEEN 0 AND 1000000000),
 updated_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(updated_at)),
 expires_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(expires_at)),
 PRIMARY KEY (organization_id,workspace_id,run_id),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT run_detector_state_times CHECK (expires_at>=updated_at+interval '365 days')
);
-- One Workflow segment of a run (ADR-0041 item 6): its incarnation, its instance id
-- (<run>-s<segment>-i<incarnation>, never reused), why it began, its step count, and when it
-- rolled. Content-free; 365 days.
CREATE TABLE morrow_work.run_segments (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 segment integer NOT NULL CHECK (segment BETWEEN 1 AND 1000000),
 incarnation integer NOT NULL CHECK (incarnation BETWEEN 1 AND 1000),
 workflow_instance_id text NOT NULL CHECK (workflow_instance_id ~ '^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$'
  AND workflow_instance_id=run_id::text||'-s'||segment||'-i'||incarnation),
 reason text NOT NULL CHECK (reason IN ('start','steps','epoch','wait','incarnation')),
 steps integer NOT NULL CHECK (steps BETWEEN 0 AND 10000),
 started_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(started_at)),
 rolled_at timestamptz CHECK (morrow_work.harness_ms(rolled_at)),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (organization_id,workspace_id,run_id,segment,incarnation),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT run_segments_times CHECK ((rolled_at IS NULL OR rolled_at>=started_at) AND expires_at=started_at+interval '365 days')
);
CREATE UNIQUE INDEX run_segments_instance ON morrow_work.run_segments (workflow_instance_id);
-- A run's taint sources past RunTaint's 256 inline (ADR-0041 item 34: taint never truncates):
-- every source, in order. Content-free; 365 days.
CREATE TABLE morrow_work.run_taint_sources (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 2147483647),
 source text NOT NULL CHECK (source IN ('product','inventory','order_summary','support_mail','knowledge_page','artifact','report','upload',
  'sandbox_output','tool_result','message','teammate_result','result_item','notebook_entry','conversation_summary','person_memory',
  'context_checkpoint','thread_post','other_member')),
 source_id morrow_work.record_id,
 joined_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(joined_at)),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (organization_id,workspace_id,run_id,ordinal),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT run_taint_sources_times CHECK (expires_at=joined_at+interval '365 days')
);
CREATE UNIQUE INDEX run_taint_sources_once ON morrow_work.run_taint_sources (organization_id,workspace_id,run_id,source,source_id) NULLS NOT DISTINCT;
-- What memory reached a run (ADR-0041 items 25 and 32): each entry read, its version, and the
-- principals whose words or requests it carries (the notebook entry's requester, the authors a
-- summary or checkpoint cites), which a proposal's conflict set gains. Content-free; 365 days.
CREATE TABLE morrow_work.run_memory_reads (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 2147483647),
 memory_kind text NOT NULL CHECK (memory_kind IN ('notebook_entry','conversation_summary','person_memory','knowledge_page','context_checkpoint',
  'result_item','teammate_result','message','turn')),
 memory_id morrow_work.record_id NOT NULL,
 memory_version integer CHECK (memory_version BETWEEN 1 AND 1000000),
 influence_principal_ids text[] NOT NULL CHECK (cardinality(influence_principal_ids) BETWEEN 0 AND 64
  AND array_position(influence_principal_ids,NULL) IS NULL
  AND array_to_string(influence_principal_ids,',') ~ '^([A-Za-z0-9][A-Za-z0-9._:-]{0,127}(,[A-Za-z0-9][A-Za-z0-9._:-]{0,127})*)?$'),
 read_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(read_at)),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (organization_id,workspace_id,run_id,ordinal),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 CONSTRAINT run_memory_reads_times CHECK (expires_at=read_at+interval '365 days')
);
-- One upkeep trigger (ADR-0041 items 7, 26 and 27): a consolidation of an agent's notebook or a
-- shared thread's summary, written in a person's act or in a write made under a lease a
-- person's act admitted (never by a consolidation's own changeset); the agent and store it
-- tends, the requester whose act caused it, the agent's model and effort, the pinned upkeep text
-- and catalogues; its state and the run admit_upkeep_run admitted. At most one pending or
-- running per notebook or thread. Content-free; 365 days.
CREATE TABLE morrow_work.upkeep_triggers (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 revision morrow_work.revision NOT NULL,
 kind text NOT NULL CHECK (kind IN ('consolidation','summary')),
 subject_kind text NOT NULL CHECK (subject_kind IN ('notebook','conversation')),
 subject_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id NOT NULL,
 store_id morrow_work.record_id NOT NULL,
 connection_id morrow_work.record_id NOT NULL,
 agent_principal_id morrow_work.record_id NOT NULL,
 requester_principal_id morrow_work.record_id NOT NULL,
 requester_membership_id morrow_work.record_id NOT NULL,
 source_kind text NOT NULL CHECK (source_kind IN ('person_act','lease')),
 source_run_id morrow_work.record_id,
 source_lease_id morrow_work.record_id,
 catalogue_version integer NOT NULL,
 model_key text NOT NULL,
 effort_key text NOT NULL,
 system_text_digest morrow_work.digest NOT NULL,
 tool_catalogue_version integer NOT NULL CHECK (tool_catalogue_version BETWEEN 1 AND 1000),
 tool_catalogue_digest morrow_work.digest NOT NULL,
 state text NOT NULL CHECK (state IN ('pending','admitted','done','skipped')),
 run_id morrow_work.record_id,
 created_at timestamptz NOT NULL CHECK (morrow_work.harness_ms(created_at)),
 admitted_at timestamptz CHECK (morrow_work.harness_ms(admitted_at)),
 ended_at timestamptz CHECK (morrow_work.harness_ms(ended_at)),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,requester_membership_id,requester_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (organization_id,workspace_id,source_run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,run_id) REFERENCES morrow_work.agent_runs(organization_id,workspace_id,id),
 FOREIGN KEY (catalogue_version,model_key,effort_key) REFERENCES morrow_work.loop_catalogue_entries(version,model_key,effort_key),
 CONSTRAINT upkeep_triggers_source CHECK ((source_kind='lease')=(source_lease_id IS NOT NULL AND source_run_id IS NOT NULL)
  AND (kind='consolidation')=(subject_kind='notebook')),
 CONSTRAINT upkeep_triggers_state CHECK (CASE state WHEN 'pending' THEN run_id IS NULL AND admitted_at IS NULL AND ended_at IS NULL
  WHEN 'admitted' THEN run_id IS NOT NULL AND admitted_at IS NOT NULL AND ended_at IS NULL
  WHEN 'done' THEN run_id IS NOT NULL AND admitted_at IS NOT NULL AND ended_at IS NOT NULL
  ELSE run_id IS NULL AND ended_at IS NOT NULL END),
 CONSTRAINT upkeep_triggers_times CHECK ((admitted_at IS NULL OR admitted_at>=created_at) AND (ended_at IS NULL OR ended_at>=created_at)
  AND expires_at=created_at+interval '365 days')
);
CREATE UNIQUE INDEX upkeep_triggers_one_open ON morrow_work.upkeep_triggers (organization_id,workspace_id,kind,subject_kind,subject_id)
 WHERE state IN ('pending','admitted');
CREATE INDEX upkeep_triggers_pending ON morrow_work.upkeep_triggers (created_at,id) WHERE state='pending';

-- ---------------------------------------------------------------------------
-- Row security. Every new table: ENABLE + FORCE and the maintenance-only owner policy.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['loop_catalogue_versions','loop_catalogue_entries','tool_catalogue_entries','context_policy_versions','jobs',
  'agent_contexts','context_epochs','agent_runs','agent_calls','agent_run_questions','run_waits','context_checkpoints','run_turns',
  'run_tool_calls','agent_model_calls','run_plans','run_plan_revisions','run_events','teammate_results','result_items','result_item_pages',
  'run_detector_state','run_segments','run_taint_sources','run_memory_reads','upkeep_triggers'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['loop_catalogue_versions','loop_catalogue_entries','tool_catalogue_entries','context_policy_versions'] LOOP
  EXECUTE format('CREATE POLICY platform_command_read ON morrow_work.%I FOR SELECT TO morrow_work_command USING (true)',t);
 END LOOP;
 -- The session context (a person's acts: admission, the answer) and its lease twin (the run
 -- steps and the runtime definers once they entered a lease) on every tenant table.
 FOREACH t IN ARRAY ARRAY['jobs','agent_contexts','context_epochs','agent_runs','agent_calls','agent_run_questions','run_waits',
  'context_checkpoints','run_turns','run_tool_calls','agent_model_calls','run_plans','run_plan_revisions','run_events','teammate_results',
  'result_items','result_item_pages','run_detector_state','run_segments','run_taint_sources','run_memory_reads','upkeep_triggers'] LOOP
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('CREATE POLICY tenant_lease ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
 END LOOP;
 -- The api reads its tenant's runs and jobs column by column (ids, codes, counts and credits).
 FOREACH t IN ARRAY ARRAY['agent_runs','jobs'] LOOP
  EXECUTE format('CREATE POLICY tenant_read ON morrow_work.%I FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
END $$;
-- The runtime login's cross-tenant reads, ids and codes only and read only (spine §5): open
-- runs (the cron's starts, the Workflow's lease lookup, the sweep's candidates and a resume's
-- run), open waits (the sweep and a resume) and pending or admitted upkeep triggers (upkeep
-- admission). Nothing here writes.
CREATE POLICY runtime_agent_open ON morrow_work.agent_runs FOR SELECT TO morrow_work_command
 USING (session_user='morrow_runtime_executor' AND status IN ('queued','running','waiting'));
CREATE POLICY runtime_wait_open ON morrow_work.run_waits FOR SELECT TO morrow_work_command
 USING (session_user='morrow_runtime_executor' AND state IN ('open','resolvable'));
CREATE POLICY runtime_upkeep_read ON morrow_work.upkeep_triggers FOR SELECT TO morrow_work_command
 USING (session_user='morrow_runtime_executor' AND state IN ('pending','admitted'));

-- Privileges: table SELECT and INSERT, column-scoped UPDATE, never DELETE or TRUNCATE.
GRANT SELECT ON morrow_work.loop_catalogue_versions,morrow_work.loop_catalogue_entries,morrow_work.tool_catalogue_entries,
 morrow_work.context_policy_versions TO morrow_work_command;
GRANT SELECT,INSERT ON morrow_work.jobs,morrow_work.agent_contexts,morrow_work.context_epochs,morrow_work.agent_runs,morrow_work.agent_calls,
 morrow_work.agent_run_questions,morrow_work.run_waits,morrow_work.context_checkpoints,morrow_work.run_turns,morrow_work.run_tool_calls,
 morrow_work.agent_model_calls,morrow_work.run_plans,morrow_work.run_plan_revisions,morrow_work.run_events,morrow_work.teammate_results,
 morrow_work.result_items,morrow_work.result_item_pages,morrow_work.run_detector_state,morrow_work.run_segments,morrow_work.run_taint_sources,
 morrow_work.run_memory_reads,morrow_work.upkeep_triggers TO morrow_work_command;
GRANT UPDATE (revision,state,result_message_id,updated_at,ended_at,expires_at) ON morrow_work.jobs TO morrow_work_command;
GRANT UPDATE (revision,current_epoch,last_sequence,read_tags,taint,status,updated_at,closed_at) ON morrow_work.agent_contexts TO morrow_work_command;
GRANT UPDATE (closed_at,expires_at) ON morrow_work.context_epochs TO morrow_work_command;
GRANT UPDATE (revision,status,ended_reason,lease_id,lease_generation,lease_expires_at,lease_renewals,segment,incarnation,workflow_instance_id,
 segment_steps,heartbeat_at,active_ms,segment_started_at,wait_id,taint,read_tags,person_memory_loaded,credits_held,credits_drawn,credits_refunded,
 credits_absorbed,turns_taken,tool_calls_taken,children_admitted,envelope_expires_at,envelope_renewed_at,envelope_active_base_ms,started_at,
 ended_at,updated_at) ON morrow_work.agent_runs TO morrow_work_command;
GRANT UPDATE (revision,state,sequence,child_run_id,child_context_id,updated_at,ended_at,expires_at) ON morrow_work.agent_calls TO morrow_work_command;
GRANT UPDATE (status,answer,answered_by_principal_id,answered_by_membership_id,resume_lease_id,answered_at,expires_at)
 ON morrow_work.agent_run_questions TO morrow_work_command;
GRANT UPDATE (state,resolvable_code,resolution_code,resolution_lease_source,resolvable_at,resolved_at) ON morrow_work.run_waits TO morrow_work_command;
GRANT UPDATE (expires_at) ON morrow_work.context_checkpoints,morrow_work.run_plan_revisions,morrow_work.teammate_results,
 morrow_work.result_item_pages TO morrow_work_command;
GRANT UPDATE (output,outcome,prefix_digest_before,prefix_digest_after,input_tokens,cache_write_tokens,cache_read_tokens,output_tokens,
 section_tokens,updated_at,expires_at) ON morrow_work.run_turns TO morrow_work_command;
GRANT UPDATE (outcome,refusal,result_digest,result_bytes,item_id,record_kind,record_id,finished_at) ON morrow_work.run_tool_calls TO morrow_work_command;
GRANT UPDATE (status,outcome,counted,raw_stop_reason,provider_request_id,provider_model_id,counted_input_tokens,input_tokens,cache_write_tokens,
 cache_read_tokens,output_tokens,section_tokens,credits_held,credits_drawn,metered_usd12,closed_at) ON morrow_work.agent_model_calls TO morrow_work_command;
GRANT UPDATE (current_revision,updated_at) ON morrow_work.run_plans TO morrow_work_command;
GRANT UPDATE (revision,open,sections,pages,bytes,updated_at,closed_at,expires_at) ON morrow_work.result_items TO morrow_work_command;
GRANT UPDATE (ring,counters,progress_sequence,updated_at,expires_at) ON morrow_work.run_detector_state TO morrow_work_command;
GRANT UPDATE (steps,rolled_at) ON morrow_work.run_segments TO morrow_work_command;
GRANT UPDATE (revision,state,run_id,admitted_at,ended_at) ON morrow_work.upkeep_triggers TO morrow_work_command;
GRANT SELECT (organization_id,workspace_id,id,revision,kind,purpose,job_id,root_run_id,parent_run_id,call_id,depth,context_id,conversation_id,
 task_id,child_task_id,store_id,connection_id,installation_id,status,ended_reason,catalogue_version,model_key,effort_key,turns_taken,
 tool_calls_taken,children_admitted,credits_drawn,requester_principal_id,requester_membership_id,created_at,started_at,ended_at,updated_at)
 ON morrow_work.agent_runs TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,revision,conversation_id,origin,requester_principal_id,requester_membership_id,state,opening_message_id,
 result_message_id,created_at,updated_at,ended_at) ON morrow_work.jobs TO morrow_work_api;

-- ---------------------------------------------------------------------------
-- Triggers: INVOKER, owned by the owner, granted to nobody.
-- Jobs: born at revision 1, unended; afterwards revision+1, the state, the result message
-- (once) and the end (once, with its 365-day clock); a done, stopped or failed job never
-- changes.
CREATE FUNCTION morrow_work.job_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','state','result_message_id','updated_at','ended_at','expires_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.ended_at IS NOT NULL OR NEW.result_message_id IS NOT NULL OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'WORK_JOB_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.state IN ('done','stopped','failed') OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR (OLD.result_message_id IS NOT NULL AND NEW.result_message_id IS DISTINCT FROM OLD.result_message_id) THEN
  RAISE EXCEPTION 'WORK_JOB_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Contexts: born open at revision 1 with no epoch; afterwards revision+1, the epoch and the
-- last sequence only grow, read tags and taint never shrink, and a closed context stays
-- closed. Its pins (tools, system text, model, effort, renderer, policy) never change: a
-- change applies from the next context (ADR-0041 item 2).
CREATE FUNCTION morrow_work.agent_context_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','current_epoch','last_sequence','read_tags','taint','status','updated_at','closed_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>'open' OR NEW.current_epoch<>0 OR NEW.last_sequence<>0 OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'WORK_AGENT_CONTEXT_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status='closed' OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.current_epoch<OLD.current_epoch OR NEW.last_sequence<OLD.last_sequence
  OR NOT (NEW.read_tags @> OLD.read_tags) OR NOT ((NEW.taint->'kinds') @> (OLD.taint->'kinds'))
  OR (NEW.taint->>'sourceCount')::bigint<(OLD.taint->>'sourceCount')::bigint THEN
  RAISE EXCEPTION 'WORK_AGENT_CONTEXT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Epochs: born open; the one change is the close, with its 90-day clock, and afterwards only
-- a later expiry.
CREATE FUNCTION morrow_work.context_epoch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.closed_at IS NOT NULL THEN RAISE EXCEPTION 'WORK_CONTEXT_EPOCH_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-ARRAY['closed_at','expires_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['closed_at','expires_at'])
  OR (OLD.closed_at IS NOT NULL AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.expires_at<OLD.expires_at)) THEN
  RAISE EXCEPTION 'WORK_CONTEXT_EPOCH_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Rows whose one later change is their content clock (checkpoints, plan revisions, teammate
-- results, result pages): only expires_at, set once or moved later.
CREATE FUNCTION morrow_work.harness_expiry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-'expires_at') IS DISTINCT FROM (to_jsonb(OLD)-'expires_at') OR NEW.expires_at IS NULL
  OR NEW.expires_at<OLD.expires_at THEN
  RAISE EXCEPTION 'WORK_HARNESS_RECORD_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
-- Agent runs: born queued at revision 1 with zero counters and credits, segment 1 and
-- incarnation 1, the manifest exactly the run's columns (agent_manifest_matches). Afterwards
-- revision+1, never back-dated; only the status, its end, the lease, the segment and
-- incarnation (which only grow), the open wait, the counters, credits drawn, refunded and
-- absorbed and the active time (which only grow), the taint and read tags (which never
-- shrink), the person-memory flag (never cleared) and the envelope's renewal (only later)
-- change. The edges: queued -> running or waiting, running -> waiting, waiting -> queued (with
-- a new lease), and any open status -> a terminal one; a terminal run never changes.
CREATE FUNCTION morrow_work.agent_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','status','ended_reason','lease_id','lease_generation','lease_expires_at','lease_renewals','segment',
 'incarnation','workflow_instance_id','segment_steps','heartbeat_at','active_ms','segment_started_at','wait_id','taint','read_tags',
 'person_memory_loaded','credits_held','credits_drawn','credits_refunded','credits_absorbed','turns_taken','tool_calls_taken','children_admitted',
 'envelope_expires_at','envelope_renewed_at','envelope_active_base_ms','started_at','ended_at','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>'queued' OR NEW.turns_taken<>0 OR NEW.tool_calls_taken<>0 OR NEW.children_admitted<>0 OR NEW.active_ms<>0
   OR NEW.credits_held<>0 OR NEW.credits_drawn<>0 OR NEW.credits_refunded<>0 OR NEW.credits_absorbed<>0 OR NEW.segment<>1 OR NEW.incarnation<>1
   OR NEW.segment_steps<>0 OR NEW.lease_renewals<>0 OR NEW.started_at IS NOT NULL OR NEW.heartbeat_at IS NOT NULL
   OR NEW.updated_at<>NEW.created_at OR NEW.envelope_renewed_at<>NEW.created_at OR NEW.envelope_active_base_ms<>0
   OR NOT morrow_work.agent_manifest_matches(NEW.manifest_canonical,to_jsonb(NEW)) THEN
   RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status IN ('succeeded','failed','cancelled') OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.turns_taken<OLD.turns_taken OR NEW.tool_calls_taken<OLD.tool_calls_taken OR NEW.children_admitted<OLD.children_admitted
  OR NEW.active_ms<OLD.active_ms OR NEW.credits_drawn<OLD.credits_drawn OR NEW.credits_refunded<OLD.credits_refunded
  OR NEW.credits_absorbed<OLD.credits_absorbed OR NEW.lease_renewals<OLD.lease_renewals
  OR NEW.segment<OLD.segment OR NEW.incarnation<OLD.incarnation
  OR NOT (NEW.read_tags @> OLD.read_tags) OR NOT ((NEW.taint->'kinds') @> (OLD.taint->'kinds'))
  OR NOT ((NEW.taint->'sources') @> (OLD.taint->'sources') OR (NEW.taint->>'omittedSources')::bigint>(OLD.taint->>'omittedSources')::bigint)
  OR jsonb_array_length(NEW.taint->'sources')+(NEW.taint->>'omittedSources')::bigint
   <jsonb_array_length(OLD.taint->'sources')+(OLD.taint->>'omittedSources')::bigint
  OR (OLD.person_memory_loaded AND NOT NEW.person_memory_loaded)
  OR NEW.envelope_renewed_at<OLD.envelope_renewed_at OR NEW.envelope_active_base_ms<OLD.envelope_active_base_ms
  OR ((NEW.envelope_expires_at,NEW.envelope_active_base_ms) IS DISTINCT FROM (OLD.envelope_expires_at,OLD.envelope_active_base_ms)
   AND NEW.envelope_renewed_at=OLD.envelope_renewed_at)
  OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
  OR (NEW.status<>OLD.status AND NOT ((OLD.status='queued' AND NEW.status IN ('running','waiting')) OR (OLD.status='running' AND NEW.status='waiting')
   OR (OLD.status='waiting' AND NEW.status='queued') OR NEW.status IN ('succeeded','failed','cancelled')))
  OR (OLD.status='waiting' AND NEW.status='queued' AND NEW.lease_id IS NOT DISTINCT FROM OLD.lease_id) THEN
  RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Calls: born admitted at revision 1, sequence 1; afterwards revision+1, the state (never out
-- of an ended one), the follow-up sequence (only grows), the child run and context (set once)
-- and the end (once).
CREATE FUNCTION morrow_work.agent_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','state','sequence','child_run_id','child_context_id','updated_at','ended_at','expires_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.state<>'admitted' OR NEW.sequence<>1 OR NEW.ended_at IS NOT NULL OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'WORK_AGENT_CALL_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.state IN ('finished','cancelled','released') OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) OR NEW.sequence<OLD.sequence
  OR (OLD.child_run_id IS NOT NULL AND NEW.child_run_id IS DISTINCT FROM OLD.child_run_id)
  OR (OLD.child_context_id IS NOT NULL AND NEW.child_context_id IS DISTINCT FROM OLD.child_context_id) THEN
  RAISE EXCEPTION 'WORK_AGENT_CALL_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Questions: born open on the turns' clock (90 days after it is asked); answered (once, with
-- the answer, the answerer and the resume lease), expired or cancelled once; the expiry only
-- moves later, whatever the status; nothing else changes.
CREATE FUNCTION morrow_work.agent_run_question_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['status','answer','answered_by_principal_id','answered_by_membership_id','resume_lease_id','answered_at',
 'expires_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'open' OR NEW.expires_at<>NEW.created_at+interval '90 days' THEN RAISE EXCEPTION 'WORK_AGENT_QUESTION_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) OR NEW.expires_at<OLD.expires_at
  OR (NEW.status IS DISTINCT FROM OLD.status AND (OLD.status<>'open' OR NEW.status='open'))
  OR (NEW.status IS NOT DISTINCT FROM OLD.status AND (to_jsonb(NEW)-'expires_at') IS DISTINCT FROM (to_jsonb(OLD)-'expires_at')) THEN
  RAISE EXCEPTION 'WORK_AGENT_QUESTION_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Waits: born open; open -> resolvable (once, with the code that made it so); open or
-- resolvable -> resolved (with its resolution and the lease source that resumed the run),
-- lapsed or cancelled; a closed wait never changes, and nothing else changes.
CREATE FUNCTION morrow_work.run_wait_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['state','resolvable_code','resolution_code','resolution_lease_source','resolvable_at','resolved_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'open' THEN RAISE EXCEPTION 'WORK_RUN_WAIT_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.state NOT IN ('open','resolvable') OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR (OLD.state='resolvable' AND NEW.state IN ('open','resolvable'))
  OR (OLD.resolvable_code IS NOT NULL AND NEW.resolvable_code IS DISTINCT FROM OLD.resolvable_code)
  OR (OLD.resolvable_at IS NOT NULL AND NEW.resolvable_at IS DISTINCT FROM OLD.resolvable_at) THEN
  RAISE EXCEPTION 'WORK_RUN_WAIT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Turns: born with the input and the call budget only (no reply, outcome, usage or digests).
-- The reply, its outcome, usage, section tokens and the digests are set once (the broker's
-- close, or an uncertain close); afterwards only its reasoning blocks are removed (when the
-- epoch stops sending them) and the expiry only moves later. The input never changes.
CREATE FUNCTION morrow_work.run_turn_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['output','outcome','prefix_digest_before','prefix_digest_after','input_tokens','cache_write_tokens',
 'cache_read_tokens','output_tokens','section_tokens','updated_at','expires_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.output IS NOT NULL OR NEW.outcome IS NOT NULL OR NEW.prefix_digest_before IS NOT NULL OR NEW.prefix_digest_after IS NOT NULL
   OR NEW.input_tokens IS NOT NULL OR NEW.section_tokens IS NOT NULL OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'WORK_RUN_TURN_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) OR NEW.updated_at<OLD.updated_at
  OR NEW.expires_at<OLD.expires_at OR (OLD.expires_at IS NOT NULL AND NEW.expires_at IS NULL)
  OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.prefix_digest_before IS DISTINCT FROM OLD.prefix_digest_before
   OR NEW.prefix_digest_after IS DISTINCT FROM OLD.prefix_digest_after OR NEW.section_tokens IS DISTINCT FROM OLD.section_tokens
   OR (NEW.input_tokens,NEW.cache_write_tokens,NEW.cache_read_tokens,NEW.output_tokens)
    IS DISTINCT FROM (OLD.input_tokens,OLD.cache_write_tokens,OLD.cache_read_tokens,OLD.output_tokens)))
  OR (OLD.outcome IS NOT NULL AND NEW.output IS DISTINCT FROM OLD.output AND (OLD.output IS NULL OR NEW.output IS DISTINCT FROM
   jsonb_build_object('role','assistant','content',COALESCE((SELECT jsonb_agg(b ORDER BY o) FROM jsonb_array_elements(OLD.output->'content')
    WITH ORDINALITY q(b,o) WHERE b->>'type'<>'reasoning'),'[{"type":"text","text":"[reasoning removed]"}]'::jsonb)))) THEN
  RAISE EXCEPTION 'WORK_RUN_TURN_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Tool calls: born started (no outcome); finished once; nothing else changes.
CREATE FUNCTION morrow_work.run_tool_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['outcome','refusal','result_digest','result_bytes','item_id','record_kind','record_id','finished_at'];
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
-- Model calls: born started; the one change is the close, with its outcome, usage, credits and
-- record.
CREATE FUNCTION morrow_work.agent_model_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['status','outcome','counted','raw_stop_reason','provider_request_id','provider_model_id','counted_input_tokens',
 'input_tokens','cache_write_tokens','cache_read_tokens','output_tokens','section_tokens','credits_held','credits_drawn','metered_usd12','closed_at'];
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
-- Plans: one per job; the current revision moves forward by one, with its revision row.
CREATE FUNCTION morrow_work.run_plan_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.current_revision<>1 OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'WORK_RUN_PLAN_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-ARRAY['current_revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['current_revision','updated_at'])
  OR NEW.current_revision<>OLD.current_revision+1 OR NEW.updated_at<OLD.updated_at THEN
  RAISE EXCEPTION 'WORK_RUN_PLAN_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Result items: born open at revision 1; afterwards revision+1, sections, pages and bytes only
-- grow, the close happens once, and the expiry only moves later.
CREATE FUNCTION morrow_work.result_item_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','open','sections','pages','bytes','updated_at','closed_at','expires_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NOT NEW.open OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'WORK_RESULT_ITEM_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NEW.sections<OLD.sections OR NEW.pages<OLD.pages OR NEW.bytes<OLD.bytes OR (NOT OLD.open AND NEW.open)
  OR (NOT OLD.open AND (NEW.sections,NEW.pages,NEW.bytes) IS DISTINCT FROM (OLD.sections,OLD.pages,OLD.bytes))
  OR NEW.expires_at<OLD.expires_at OR (OLD.expires_at IS NOT NULL AND NEW.expires_at IS NULL) THEN
  RAISE EXCEPTION 'WORK_RESULT_ITEM_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Detector state: the ring and counters change; the progress sequence only grows.
CREATE FUNCTION morrow_work.run_detector_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF TG_OP<>'UPDATE' OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
  OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.progress_sequence<OLD.progress_sequence OR NEW.updated_at<OLD.updated_at
  OR NEW.expires_at<OLD.expires_at THEN
  RAISE EXCEPTION 'WORK_RUN_DETECTOR_STATE_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Segments: born unrolled; the steps only grow and the roll happens once.
CREATE FUNCTION morrow_work.run_segment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.rolled_at IS NOT NULL THEN RAISE EXCEPTION 'WORK_RUN_SEGMENT_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.rolled_at IS NOT NULL OR NEW.steps<OLD.steps
  OR (to_jsonb(NEW)-ARRAY['steps','rolled_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['steps','rolled_at']) THEN
  RAISE EXCEPTION 'WORK_RUN_SEGMENT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Upkeep triggers: born pending at revision 1; pending -> admitted (with its run) or skipped;
-- admitted -> done; revision+1; nothing else changes.
CREATE FUNCTION morrow_work.upkeep_trigger_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['revision','state','run_id','admitted_at','ended_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.state<>'pending' THEN RAISE EXCEPTION 'WORK_UPKEEP_TRIGGER_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision<>OLD.revision+1 OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NOT ((OLD.state='pending' AND NEW.state IN ('admitted','skipped')) OR (OLD.state='admitted' AND NEW.state='done'))
  OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id) THEN
  RAISE EXCEPTION 'WORK_UPKEEP_TRIGGER_INVALID';
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT * FROM (VALUES ('jobs','job_guard'),('agent_contexts','agent_context_guard'),('context_epochs','context_epoch_guard'),
   ('agent_runs','agent_run_guard'),('agent_calls','agent_call_guard'),('agent_run_questions','agent_run_question_guard'),
   ('run_waits','run_wait_guard'),('context_checkpoints','harness_expiry_guard'),('run_turns','run_turn_guard'),
   ('run_tool_calls','run_tool_call_guard'),('agent_model_calls','agent_model_call_guard'),('run_plans','run_plan_guard'),
   ('run_plan_revisions','harness_expiry_guard'),('teammate_results','harness_expiry_guard'),('result_items','result_item_guard'),
   ('result_item_pages','harness_expiry_guard'),('run_detector_state','run_detector_state_guard'),('run_segments','run_segment_guard'),
   ('upkeep_triggers','upkeep_trigger_guard')) v(t,f) LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.%I()',r.f,r.t,r.f);
 END LOOP;
END $$;
-- run_events, run_taint_sources and run_memory_reads have no UPDATE grant: append only. No
-- DELETE or TRUNCATE on any new table (the retention sweep and redaction are the owner's).
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['loop_catalogue_versions','loop_catalogue_entries','tool_catalogue_entries','context_policy_versions','jobs',
  'agent_contexts','context_epochs','agent_runs','agent_calls','agent_run_questions','run_waits','context_checkpoints','run_turns',
  'run_tool_calls','agent_model_calls','run_plans','run_plan_revisions','run_events','teammate_results','result_items','result_item_pages',
  'run_detector_state','run_segments','run_taint_sources','run_memory_reads','upkeep_triggers'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Revisable owner helpers: INVOKER, owned by the owner (a later owner migration may replace
-- them), EXECUTE for the command role only. They run under the caller's policies (session or
-- lease) and take no actor.
-- Appends one RunEvent@1 to the run's root stream (ADR-0041 item 36), numbered under the
-- root's lock, in the caller's transaction: ids, codes and a count only. Returns its sequence.
CREATE FUNCTION morrow_work.agent_run_event(p_org text,p_ws text,p_run_id text,p_kind text,p_code text,p_ref_kind text,p_ref_id text,
 p_count bigint) RETURNS bigint
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE r record; v_sequence bigint; v_now timestamptz;
BEGIN
 SELECT x.root_run_id::text AS root,x.job_id::text AS job,x.context_id::text AS context INTO r FROM morrow_work.agent_runs x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_run_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'WORK_RUN_EVENT_INVALID'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.run_events',p_org,p_ws,
  r.root)::text,0));
 SELECT COALESCE(max(e.sequence),0)+1 INTO v_sequence FROM morrow_work.run_events e
  WHERE e.organization_id=p_org AND e.workspace_id=p_ws AND e.root_run_id=r.root;
 v_now:=morrow_work.db_now();
 INSERT INTO morrow_work.run_events(organization_id,workspace_id,root_run_id,sequence,run_id,job_id,context_id,kind,code,ref_kind,ref_id,count,
  tokens_before,tokens_after,duration_ms,credits,digest,at,expires_at)
 VALUES (p_org,p_ws,r.root,v_sequence,p_run_id,r.job,r.context,p_kind,p_code,p_ref_kind,p_ref_id,p_count,NULL,NULL,NULL,NULL,NULL,v_now,
  v_now+interval '365 days');
 RETURN v_sequence;
END $$;
-- Admission's checks again, for a run already admitted (ADR-0041 item 7: renewal and resume
-- re-run them; the requester's own act runs them with p_renewing, since that act renews the
-- job envelope): the run is open; the requester is a current member; the job envelope is
-- unexpired (24 hours active or 7 days, the safety profile's) unless the act renews it; no stop
-- blocks a run on its store or installation (platform stops included); its installation is
-- active on its store and connection with its release published, and the store's association
-- is current; a routed run's tasks are open and its delegation envelope and hop are neither
-- revoked nor expired. Returns null when every check passes, or the end reason: lease_ended,
-- stopped, task_closed or envelope_expired. The grants themselves are decided again at every
-- tool call by the kernel (a lease grants nothing).
CREATE FUNCTION morrow_work.agent_run_admission_check(p_org text,p_ws text,p_run_id text,p_renewing boolean) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE r record; i record; s record; v record; v_now timestamptz;
BEGIN
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_run_id;
 IF NOT FOUND OR r.status NOT IN ('queued','running','waiting') THEN RETURN 'lease_ended'; END IF;
 v_now:=morrow_work.db_now();
 IF r.requester_membership_id IS NULL OR NOT morrow_identity.work_lease_member_current(p_org,p_ws,r.requester_principal_id,r.requester_membership_id) THEN
  RETURN 'lease_ended';
 END IF;
 IF NOT p_renewing AND (r.envelope_expires_at<=v_now
   OR r.active_ms-r.envelope_active_base_ms>=(r.safety#>>'{envelope,activeMs}')::bigint) THEN
  RETURN 'envelope_expired';
 END IF;
 IF morrow_work.stop_active(p_org,p_ws,'run',r.connection_id,r.installation_id) THEN RETURN 'stopped'; END IF;
 IF r.installation_id IS NOT NULL THEN
  SELECT x.status,x.store_id::text AS store_id,x.connection_id::text AS connection_id,x.agent_principal_id::text AS agent_principal_id INTO i
   FROM morrow_work.agent_installations x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.installation_id;
  IF NOT FOUND OR i.status<>'active' OR i.store_id<>r.store_id OR i.connection_id<>r.connection_id THEN RETURN 'lease_ended'; END IF;
  SELECT x.connection_id INTO s FROM morrow_work.listings_store_current(p_org,p_ws,r.store_id) x LIMIT 1;
  IF NOT FOUND OR s.connection_id::text<>r.connection_id::text THEN RETURN 'lease_ended'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_work.agent_releases x WHERE x.id=r.release_id AND x.revision=r.release_revision AND x.digest=r.release_digest
   AND x.status='published') THEN
  RETURN 'lease_ended';
 END IF;
 IF r.kind='routed' THEN
  IF EXISTS(SELECT 1 FROM morrow_work.tasks x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id IN (r.task_id,r.child_task_id)
    AND x.status NOT IN ('draft','ready')) THEN
   RETURN 'task_closed';
  END IF;
  SELECT x.revoked_at,x.expires_at INTO v FROM morrow_work.work_envelopes x WHERE x.organization_id=p_org AND x.workspace_id=p_ws
   AND x.id=r.work_envelope_id;
  IF NOT FOUND OR v.revoked_at IS NOT NULL THEN RETURN 'lease_ended'; END IF;
  IF v.expires_at<=v_now THEN RETURN 'envelope_expired'; END IF;
  SELECT x.revoked_at,x.expires_at INTO v FROM morrow_work.delegation_hops x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.hop_id;
  IF NOT FOUND OR v.revoked_at IS NOT NULL THEN RETURN 'lease_ended'; END IF;
  IF v.expires_at<=v_now THEN RETURN 'envelope_expired'; END IF;
 END IF;
 RETURN NULL;
END $$;
-- Ends one open run (queued, running or waiting) with a terminal status and its reason (ADR-0041
-- item 3): an open model call closes uncertain (an unknown outcome is never success; H8
-- settles its credits), its turn row with it; the open wait closes (lapsed for a lapsed wait,
-- released, or stopped) and an open question with it; the active time closes; the lease and
-- wait references clear (the caller releases the lease it entered); the segment rolls; a routed
-- run's delegation envelope and hop are revoked; an upkeep trigger is done; the job ends when no
-- other run of it is open; the context stays open for a person's Continue. Outcomes: ended
-- (with the status), invalid.
CREATE FUNCTION morrow_work.agent_run_end(p_org text,p_ws text,p_run_id text,p_status text,p_reason text)
RETURNS TABLE(outcome text,status text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; v_now timestamptz; v_lapsed boolean; n integer;
BEGIN
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_run_id;
 IF NOT FOUND OR r.status NOT IN ('queued','running','waiting') OR p_status IS NULL OR p_status NOT IN ('succeeded','failed','cancelled')
  OR p_reason IS NULL OR (p_status='succeeded')<>(p_reason='completed') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 v_lapsed:=p_reason IN ('person_wait_expired','checkin_unanswered');
 UPDATE morrow_work.run_turns t SET outcome='uncertain',updated_at=greatest(v_now,t.updated_at)
  WHERE t.organization_id=p_org AND t.workspace_id=p_ws AND t.run_id=p_run_id AND t.outcome IS NULL
   AND EXISTS(SELECT 1 FROM morrow_work.agent_model_calls c WHERE c.organization_id=p_org AND c.workspace_id=p_ws AND c.run_id=p_run_id
    AND c.turn=t.turn AND c.attempt=t.attempt AND c.status='started');
 UPDATE morrow_work.agent_model_calls c SET status='closed',outcome='uncertain',counted=true,closed_at=greatest(v_now,c.started_at)
  WHERE c.organization_id=p_org AND c.workspace_id=p_ws AND c.run_id=p_run_id AND c.status='started';
 UPDATE morrow_work.agent_runs x SET status=p_status,ended_reason=p_reason,ended_at=greatest(v_now,x.created_at),
  active_ms=x.active_ms+CASE WHEN x.segment_started_at IS NULL THEN 0 ELSE greatest((extract(epoch FROM v_now-x.segment_started_at)*1000)::bigint,0) END,
  segment_started_at=NULL,lease_id=NULL,lease_generation=NULL,lease_expires_at=NULL,wait_id=NULL,revision=x.revision+1,
  updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_run_id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 UPDATE morrow_work.run_waits w SET state=CASE WHEN v_lapsed THEN 'lapsed' ELSE 'cancelled' END,
  resolution_code=CASE WHEN v_lapsed THEN 'lapsed' WHEN p_reason='released' THEN 'released' ELSE 'stopped' END,
  resolved_at=greatest(v_now,w.opened_at)
  WHERE w.organization_id=p_org AND w.workspace_id=p_ws AND w.run_id=p_run_id AND w.state IN ('open','resolvable');
 UPDATE morrow_work.agent_run_questions q SET status=CASE WHEN v_lapsed THEN 'expired' ELSE 'cancelled' END
  WHERE q.organization_id=p_org AND q.workspace_id=p_ws AND q.run_id=p_run_id AND q.status='open';
 UPDATE morrow_work.run_segments s SET rolled_at=greatest(v_now,s.started_at)
  WHERE s.organization_id=p_org AND s.workspace_id=p_ws AND s.run_id=p_run_id AND s.rolled_at IS NULL;
 IF r.kind='routed' THEN
  UPDATE morrow_work.work_envelopes x SET revoked_at=greatest(v_now,x.created_at)
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.work_envelope_id AND x.revoked_at IS NULL;
  UPDATE morrow_work.delegation_hops x SET revoked_at=greatest(v_now,x.created_at)
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=r.hop_id AND x.revoked_at IS NULL;
 END IF;
 UPDATE morrow_work.upkeep_triggers u SET state='done',ended_at=greatest(v_now,u.created_at),revision=u.revision+1
  WHERE u.organization_id=p_org AND u.workspace_id=p_ws AND u.run_id=p_run_id AND u.state='admitted';
 IF r.job_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM morrow_work.agent_runs x WHERE x.organization_id=p_org AND x.workspace_id=p_ws
   AND x.job_id=r.job_id AND x.status IN ('queued','running','waiting')) THEN
  UPDATE morrow_work.jobs j SET state=CASE p_status WHEN 'succeeded' THEN 'done' WHEN 'cancelled' THEN 'stopped' ELSE 'failed' END,
   ended_at=greatest(v_now,j.created_at),expires_at=greatest(v_now,j.created_at)+interval '365 days',revision=j.revision+1,
   updated_at=greatest(v_now,j.updated_at)
   WHERE j.organization_id=p_org AND j.workspace_id=p_ws AND j.id=r.job_id AND j.state NOT IN ('done','stopped','failed');
 END IF;
 PERFORM morrow_work.agent_run_event(p_org,p_ws,p_run_id,'run.ended',p_reason,'run',p_run_id,NULL);
 RETURN QUERY SELECT 'ended'::text,p_status;
END $$;

-- ---------------------------------------------------------------------------
-- The command role's INVOKER helpers (owned by it, granted to nobody).
-- The entered run lease's agent run, locked. The run is the lease subject's prefix before ':'
-- (`<run>` at admission, `<run>:w<sequence>` after a wait, `<run>:l<n>` after a renewal,
-- `<run>:u:<trigger>` for upkeep), and the run's current lease must be exactly the entered one.
-- Zero rows otherwise.
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
-- Whether the runtime login may insert this run lease (lease_agent_issue): a renewal of the
-- entered lease of the same queued or running run (`<run>:l<renewals+1>`); a resolvable wait's
-- lease (`<run>:w<sequence>`: the run waits on exactly that wait, resolvable or a timer that is
-- due, never a question, which only the requester's answer resumes); or a pending upkeep
-- trigger's admission (`<run>:u:<trigger>`). Store, connection, installation and initiator are
-- exactly the run's (or the trigger's). Anything else is refused.
CREATE FUNCTION morrow_work.agent_lease_issuable(p_org text,p_ws text,p_kind text,p_subject text,p_store text,p_connection text,
 p_installation text,p_principal text,p_membership text) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_run text; v_rest text; r record; l record; t record;
BEGIN
 IF p_kind IS DISTINCT FROM 'run' OR session_user<>'morrow_runtime_executor' OR p_subject IS NULL THEN RETURN false; END IF;
 v_run:=split_part(p_subject,':',1);
 v_rest:=substr(p_subject,length(v_run)+2);
 IF v_run !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 IF v_rest ~ '^u:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  SELECT x.store_id::text AS store_id,x.connection_id::text AS connection_id,x.installation_id::text AS installation_id,
   x.requester_principal_id::text AS principal,x.requester_membership_id::text AS membership INTO t
   FROM morrow_work.upkeep_triggers x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=substr(v_rest,3) AND x.state='pending';
  RETURN FOUND AND NOT EXISTS(SELECT 1 FROM morrow_work.agent_runs x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=v_run)
   AND t.store_id=p_store AND t.connection_id=p_connection AND t.installation_id=p_installation AND t.principal=p_principal
   AND t.membership=p_membership;
 ELSIF v_rest ~ '^l[1-9][0-9]{0,8}$' THEN
  SELECT * INTO l FROM morrow_work.current_lease();
  IF NOT FOUND OR l.organization_id<>p_org OR l.workspace_id<>p_ws OR split_part(l.subject_id,':',1)<>v_run THEN RETURN false; END IF;
  SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=v_run
   AND x.status IN ('queued','running') AND x.lease_id=l.lease_id AND x.lease_renewals+1=substr(v_rest,2)::integer;
  IF NOT FOUND THEN RETURN false; END IF;
 ELSIF v_rest ~ '^w[1-9][0-9]{0,6}$' THEN
  SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=v_run AND x.status='waiting'
   AND EXISTS(SELECT 1 FROM morrow_work.run_waits w WHERE w.organization_id=p_org AND w.workspace_id=p_ws AND w.id=x.wait_id
    AND w.wait_sequence=substr(v_rest,2)::integer AND w.kind<>'question'
    AND (w.lapses_at IS NULL OR w.lapses_at>pg_catalog.clock_timestamp())
    AND (w.state='resolvable' OR (w.state='open' AND w.kind='timer' AND w.wake_at<=pg_catalog.clock_timestamp())));
  IF NOT FOUND THEN RETURN false; END IF;
 ELSE
  RETURN false;
 END IF;
 RETURN r.store_id::text IS NOT DISTINCT FROM p_store AND r.connection_id::text IS NOT DISTINCT FROM p_connection
  AND r.installation_id::text IS NOT DISTINCT FROM p_installation AND r.requester_principal_id::text=p_principal
  AND r.requester_membership_id::text IS NOT DISTINCT FROM p_membership;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- A run lease the runtime definers issue (ADR-0041 item 7): only a lease that renews the
-- entered lease of the same run (<run>:l<n>), re-issues a resolvable wait's lease
-- (<run>:w<sequence>) or admits one pending upkeep trigger (<run>:u:<trigger>), for exactly
-- that run's (or trigger's) requester, store, connection and installation
-- (agent_lease_issuable). The lease grants nothing: entering it re-checks the member and the
-- stops, and the definer re-runs admission's checks before the run may use it.
CREATE POLICY lease_agent_issue ON morrow_work.work_leases FOR INSERT TO morrow_work_command
 WITH CHECK (session_user='morrow_runtime_executor' AND morrow_work.agent_lease_issuable(organization_id::text,workspace_id::text,kind,
  subject_id::text,store_id::text,connection_id::text,installation_id::text,initiator_principal_id::text,initiator_membership_id::text));

-- ---------------------------------------------------------------------------
-- API functions: SECURITY DEFINER, owned by the command role after the transfer below,
-- EXECUTE for morrow_work_api only. Tenant and actor come only from current_tenant(). The
-- Worker replays both commands first through 0038's begin_run_command (run.admit) and
-- 0015's begin_command (question.answer). Both are a person's act, the first lease source of
-- ADR-0041 item 7.
-- Agent-run admission, a person's routed run of one installed agent on one store (ADR-0027
-- items 1, 6 and 12; ADR-0041 items 4 to 7), after the Worker built and validated the
-- AgentRunManifest@1 (offered tools: the release's declared tools within the routed context
-- and this build's available tools; the installation's model profile; the safety profile and
-- pins) and the human kernel allowed the requester. One transaction under the P06.T01a
-- prelude. Rechecked here: the parent task T is the actor's own and open; the store's
-- association is current, no stop blocks a run on it, and the named installation is active on
-- that store and connection with a published release; the loop catalogue's version is active
-- with the entry and a safety template; the context policy row for the entry's model and
-- effort is active; the harness, runner and renderer versions are ones this build knows (1);
-- every tool is in the tool catalogue with the routed context. Derived here, never taken from
-- the request: the safety profile (the version's template with the entry's max_tokens), the
-- context policy digest, the envelope's and the hop's capabilities and verbs (exactly the
-- tools' pairs) and scope (the run's store and exactly the tools' fields), the workspace's
-- active Morrow-direct billing account, its operator test entitlement and billing period, the
-- Coordinator's principal and its grant. No money cap and no turn, call or time limit (credits
-- are the only budget; H8 holds them). Then, in order: the run lease (lease_open, refused
-- under any stop); child task T'; the delegation envelope on T (24 hours, the 0031 window;
-- depth 1, one child); the Coordinator's workspace.task.delegate {delegate} grant on T; the hop
-- T -> T'; the job (origin routed); the job's context (scope job, epoch 0 until H7d opens one);
-- the run (its trigger proves the manifest is exactly its columns) with its job envelope of 7
-- days and 24 hours active from now (the safety profile's); segment 1; the run.admitted event;
-- the task events; the command. Outcomes: applied, invalid, ineligible, stale_authority,
-- command_conflict, not_found, state_conflict, stopped, denied, catalogue_inactive,
-- entry_not_offered, version_unknown, entitlement, no_billing_period. Every non-applied
-- outcome is returned for rollback.
CREATE FUNCTION morrow_work.cmd_agent_run_admit(p_command_id text,p_request_digest text,p_correlation_id text,p_task_id text,p_store_id text,
 p_installation_id text,p_run_id text,p_child_task_id text,p_envelope_id text,p_hop_id text,p_coordinator_principal_id text,p_grant_id text,
 p_job_id text,p_context_id text,p_catalogue_version text,p_model text,p_effort text,p_context_policy_version text,p_tools text,
 p_tool_catalogue_version text,p_tool_catalogue_digest text,p_system_text_digest text,p_manifest_canonical text,p_admitted_at text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; k record; s record; i record; v record; e record; a record; snap record; per record; l record; c record; g record; rel record; cp record;
 v_policy bigint; v_now timestamptz; v_admitted timestamptz; v_until timestamptz; v_tools text[]; v_caps text[]; v_verbs text[];
 v_safety jsonb; v_scope jsonb; v_grant jsonb; v_actor jsonb; v_result jsonb; v_child_envelope text;
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
  OR p_job_id IS NULL OR p_job_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_context_id IS NULL OR p_context_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_catalogue_version IS NULL OR p_catalogue_version !~ '^[1-9][0-9]{0,2}$'
  OR p_model IS NULL OR p_model !~ '^[a-z][a-z0-9_]{0,39}$' OR p_effort IS NULL OR p_effort !~ '^[a-z][a-z0-9_]{0,39}$'
  OR p_context_policy_version IS NULL OR p_context_policy_version !~ '^[1-9][0-9]{0,2}$'
  OR p_tools IS NULL OR octet_length(p_tools)>4096 OR NOT pg_input_is_valid(p_tools,'jsonb')
  OR p_tool_catalogue_version IS NULL OR p_tool_catalogue_version !~ '^[1-9][0-9]{0,3}$'
  OR p_tool_catalogue_digest IS NULL OR p_tool_catalogue_digest !~ '^[a-f0-9]{64}$'
  OR p_system_text_digest IS NULL OR p_system_text_digest !~ '^[a-f0-9]{64}$'
  OR p_manifest_canonical IS NULL OR octet_length(p_manifest_canonical)>32768
  OR p_admitted_at IS NULL OR morrow_work.utc_parse(p_admitted_at) IS NULL
  OR (SELECT count(DISTINCT x) FROM unnest(ARRAY[p_run_id,p_child_task_id,p_envelope_id,p_hop_id,p_grant_id,p_job_id,p_context_id]) x)<>7 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF jsonb_typeof(p_tools::jsonb)<>'array' OR jsonb_array_length(p_tools::jsonb) NOT BETWEEN 1 AND 64
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
 v_safety:=morrow_work.agent_safety_compose(v.safety_template,e.max_output_tokens);
 IF NOT morrow_work.agent_safety_valid(v_safety) THEN RETURN QUERY SELECT 'catalogue_inactive'::text,NULL::text; RETURN; END IF;
 -- The context policy: the active row for this model and effort (an unknown or inactive
 -- version refuses admission).
 SELECT x.version,x.digest::text AS digest INTO cp FROM morrow_work.context_policy_versions x
  WHERE x.version=p_context_policy_version::integer AND x.model_key=p_model AND x.effort_key=p_effort AND x.status='active';
 IF NOT FOUND THEN RETURN QUERY SELECT 'version_unknown'::text,NULL::text; RETURN; END IF;
 -- The tools: each in the tool catalogue's version with the routed context; the envelope
 -- carries exactly the capabilities and verbs of those that hold one (the memory and harness
 -- tools grant nothing).
 IF (SELECT count(*) FROM morrow_work.tool_catalogue_entries t WHERE t.version=p_tool_catalogue_version::integer AND t.tool=ANY(v_tools)
   AND 'routed'=ANY(t.contexts))<>cardinality(v_tools) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT array_agg(DISTINCT t.capability_id ORDER BY t.capability_id),array_agg(DISTINCT t.verb ORDER BY t.verb) INTO v_caps,v_verbs
  FROM morrow_work.tool_catalogue_entries t WHERE t.version=p_tool_catalogue_version::integer AND t.tool=ANY(v_tools)
   AND t.capability_id IS NOT NULL;
 IF v_caps IS NULL OR cardinality(v_caps)>16 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
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
 SELECT * INTO l FROM morrow_work.lease_open('run',p_run_id,p_store_id,s.connection_id,i.id);
 IF l.outcome IS DISTINCT FROM 'opened' THEN RETURN QUERY SELECT CASE l.outcome WHEN 'stopped' THEN 'stopped' ELSE 'invalid' END,NULL::text; RETURN; END IF;
 -- The scope of the envelope and the hop: the run's store and exactly the offered tools' fields.
 v_scope:=jsonb_set(morrow_work.listings_scope(p.organization_id,p.workspace_id,p_store_id,s.connection_id),'{fields}',
  morrow_work.loop_tool_fields(v_tools));
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
  INSERT INTO morrow_work.jobs(organization_id,workspace_id,id,revision,conversation_id,origin,requester_principal_id,requester_membership_id,state,
   opening_message_id,result_message_id,created_at,updated_at,ended_at,expires_at)
  VALUES (p.organization_id,p.workspace_id,p_job_id,1,NULL,'routed',p.principal_id,p.membership_id,'received',NULL,NULL,v_admitted,v_admitted,NULL,NULL);
  INSERT INTO morrow_work.agent_contexts(organization_id,workspace_id,id,revision,scope,job_id,conversation_id,call_id,requester_principal_id,
   requester_membership_id,agent_principal_id,installation_id,audience,tools,tool_catalogue_version,tool_catalogue_digest,system_text_digest,
   catalogue_version,model_key,effort_key,renderer_version,context_policy_version,context_policy_digest,current_epoch,last_sequence,read_tags,taint,
   status,created_at,updated_at,closed_at)
  VALUES (p.organization_id,p.workspace_id,p_context_id,1,'job',p_job_id,NULL,NULL,p.principal_id,p.membership_id,i.agent_principal_id,i.id,
   '{"kind":"workspace"}'::jsonb,v_tools,p_tool_catalogue_version::integer,p_tool_catalogue_digest,p_system_text_digest,v.version,p_model,p_effort,
   1,cp.version,cp.digest,0,0,'[]'::jsonb,'{"kinds":[],"sourceCount":0}'::jsonb,'open',v_admitted,v_admitted,NULL);
  INSERT INTO morrow_work.agent_runs(organization_id,workspace_id,id,revision,kind,purpose,job_id,root_run_id,parent_run_id,parent_tool_use_id,call_id,
   depth,forked_from_run_id,forked_at_sequence,continues_run_id,context_id,conversation_id,source_inbox_id,task_id,child_task_id,store_id,
   connection_id,installation_id,mandate_id,trigger_id,agent_principal_id,coordinator_principal_id,envelope_id,work_envelope_id,hop_id,
   envelope_expires_at,envelope_renewed_at,envelope_active_base_ms,lease_id,lease_generation,lease_expires_at,lease_renewals,
   requester_principal_id,requester_membership_id,status,ended_reason,segment,incarnation,workflow_instance_id,segment_steps,heartbeat_at,
   active_ms,segment_started_at,wait_id,taint,read_tags,person_memory_loaded,credits_held,credits_drawn,credits_refunded,credits_absorbed,
   release_id,release_revision,release_digest,manifest_canonical,manifest_digest,system_text_digest,tool_catalogue_version,tool_catalogue_digest,
   tools,catalogue_version,model_key,effort_key,safety,safety_profile_version,max_output_tokens,call_budget_ms,harness_version,runner_version,
   renderer_version,context_policy_version,context_policy_digest,rate_card_version,turns_taken,tool_calls_taken,children_admitted,request_digest,
   command_id,created_at,started_at,ended_at,updated_at)
  VALUES (p.organization_id,p.workspace_id,p_run_id,1,'routed',NULL,p_job_id,p_run_id,NULL,NULL,NULL,0,NULL,NULL,NULL,p_context_id,NULL,NULL,
   p_task_id,p_child_task_id,p_store_id,s.connection_id,i.id,NULL,NULL,i.agent_principal_id,c.principal_id,p_envelope_id,p_envelope_id,p_hop_id,
   v_admitted+(v_safety#>>'{envelope,wallMs}')::bigint*interval '1 millisecond',v_admitted,0,l.lease_id,l.generation::bigint,
   timestamptz 'epoch'+l.expires_at_ms::bigint*interval '1 millisecond',0,p.principal_id,p.membership_id,'queued',NULL,1,1,p_run_id||'-s1-i1',0,NULL,0,NULL,NULL,
   '{"contextTaint":"none","kinds":[],"sources":[],"omittedSources":0}'::jsonb,'[]'::jsonb,false,0,0,0,0,rel.id,rel.revision,rel.digest,
   p_manifest_canonical,morrow_work.sha256_text(p_manifest_canonical),p_system_text_digest,p_tool_catalogue_version::integer,
   p_tool_catalogue_digest,v_tools,v.version,p_model,p_effort,v_safety,v.safety_profile_version,e.max_output_tokens,
   (v_safety#>>'{turn,callBudgetMs}')::integer,1,1,1,cp.version,cp.digest,NULL,0,0,0,p_request_digest,p_command_id,v_admitted,NULL,NULL,v_admitted);
  INSERT INTO morrow_work.run_segments(organization_id,workspace_id,run_id,segment,incarnation,workflow_instance_id,reason,steps,started_at,
   rolled_at,expires_at)
  VALUES (p.organization_id,p.workspace_id,p_run_id,1,1,p_run_id||'-s1-i1','start',0,v_admitted,NULL,v_admitted+interval '365 days');
 EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 PERFORM morrow_work.agent_run_event(p.organization_id,p.workspace_id,p_run_id,'run.admitted','person_act','run',p_run_id,NULL);
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'task.created','task',p_child_task_id,1,
  p_child_task_id,jsonb_build_object('goalId',k.goal_id,'status','draft'),p_correlation_id,v_now);
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'task.status_changed','task',p_child_task_id,2,
  p_child_task_id,jsonb_build_object('from','draft','to','ready'),p_correlation_id,v_now);
 v_result:=jsonb_build_object('runId',p_run_id,'status','queued','childTaskId',p_child_task_id,'jobId',p_job_id,'contextId',p_context_id,
  'catalogueVersion',v.version,'model',p_model,'effort',p_effort,'safetyProfileVersion',v.safety_profile_version,
  'contextPolicyVersion',cp.version);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'run.admit',p_run_id,1,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;
-- The requester's answer to a waiting run's question (ADR-0041 items 7 and 17: an answer is
-- the requester's own act; it resumes the run and renews its job envelope). Only the run's
-- requester answers, once, while the question wait is open (7 days, the safety profile's), no
-- stop blocks the run, the store's connection is current and every other admission check
-- passes; the answer opens the run lease `<run>:w<sequence>` (lease_open, in the person's
-- session; it grants nothing), resolves the wait (answered, lease source person_act) and puts
-- the run back to queued with its envelope renewed (7 days and 24 hours active from now).
-- Outcomes: applied, invalid, ineligible, stale_authority, command_conflict, not_found, denied,
-- state_conflict, expired, stopped.
CREATE FUNCTION morrow_work.cmd_agent_run_answer(p_command_id text,p_request_digest text,p_correlation_id text,p_question_id text,p_answer text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; q record; r record; w record; l record; v_now timestamptz; v_reason text; v_result jsonb; v_question_status text; n integer;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_question_id IS NULL OR p_question_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_answer IS NULL OR char_length(p_answer) NOT BETWEEN 1 AND 4000 OR p_answer !~ '\S' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.run_id::text AS run_id INTO q FROM morrow_work.agent_run_questions x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.agent_run',p.organization_id,
  p.workspace_id,q.run_id)::text,0));
 SELECT x.* INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=q.run_id;
 IF r.requester_principal_id::text<>p.principal_id OR r.requester_membership_id::text IS DISTINCT FROM p.membership_id THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN;
 END IF;
 -- Read again under the run's lock: the question's status and its open wait.
 SELECT x.status INTO v_question_status FROM morrow_work.agent_run_questions x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id;
 SELECT x.id::text AS id,x.wait_sequence,x.state,x.lapses_at INTO w FROM morrow_work.run_waits x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.question_id=p_question_id AND x.state='open';
 IF NOT FOUND OR v_question_status IS DISTINCT FROM 'open' OR r.status<>'waiting' OR r.wait_id::text IS DISTINCT FROM w.id THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 IF w.lapses_at<=v_now THEN RETURN QUERY SELECT 'expired'::text,NULL::text; RETURN; END IF;
 v_reason:=morrow_work.agent_run_admission_check(p.organization_id,p.workspace_id,r.id,true);
 IF v_reason IS NOT NULL THEN
  RETURN QUERY SELECT CASE v_reason WHEN 'stopped' THEN 'stopped' WHEN 'envelope_expired' THEN 'expired' WHEN 'lease_ended' THEN 'stopped'
   ELSE 'state_conflict' END,NULL::text;
  RETURN;
 END IF;
 SELECT * INTO l FROM morrow_work.lease_open('run',r.id||':w'||w.wait_sequence,r.store_id,r.connection_id,r.installation_id);
 IF l.outcome IS DISTINCT FROM 'opened' THEN RETURN QUERY SELECT CASE l.outcome WHEN 'stopped' THEN 'stopped' ELSE 'invalid' END,NULL::text; RETURN; END IF;
 UPDATE morrow_work.agent_run_questions x SET status='answered',answer=p_answer,answered_by_principal_id=p.principal_id,
  answered_by_membership_id=p.membership_id,resume_lease_id=l.lease_id,answered_at=greatest(v_now,x.created_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_question_id;
 UPDATE morrow_work.agent_runs x SET status='queued',wait_id=NULL,lease_id=l.lease_id,lease_generation=l.generation::bigint,
  lease_expires_at=timestamptz 'epoch'+l.expires_at_ms::bigint*interval '1 millisecond',
  envelope_renewed_at=greatest(v_now,x.envelope_renewed_at),
  envelope_expires_at=greatest(v_now,x.envelope_renewed_at)+(x.safety#>>'{envelope,wallMs}')::bigint*interval '1 millisecond',
  envelope_active_base_ms=x.active_ms,revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=r.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 UPDATE morrow_work.run_waits x SET state='resolved',resolution_code='answered',resolution_lease_source='person_act',
  resolved_at=greatest(v_now,x.opened_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=w.id;
 PERFORM morrow_work.agent_run_event(p.organization_id,p.workspace_id,r.id,'wait.resolved','answered','wait',w.id,NULL);
 v_result:=jsonb_build_object('runId',r.id,'questionId',p_question_id,'status','queued');
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'question.answer',p_question_id,1,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- ---------------------------------------------------------------------------
-- Runtime definers: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_runtime_executor only, ids and codes only, each one round trip (ADR-0041 item 35).
-- Except the cross-tenant lists and the lookups that name their tenant, the tenant and the run
-- come only from the entered run lease (agent_run_entered, which also takes the run's lock).
-- The cron's ids-only list (spine §5): unstarted, active, unexpired leases of open agent runs,
-- oldest first, at most 100 (a queued run's admission, answer, resume or upkeep lease, and a
-- running run's renewed lease until its next step marks it started), so the orchestrator
-- keeps every one of them out of ListingsRunWorkflow's starts; `resume` says whether the run
-- started before.
CREATE FUNCTION morrow_work.agent_run_pending_starts()
RETURNS TABLE(organization_id text,workspace_id text,run_id text,lease_id text,generation text,resume text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor') THEN RETURN; END IF;
 RETURN QUERY SELECT a.organization_id::text,a.workspace_id::text,a.id::text,l.id::text,l.generation::text,(a.started_at IS NOT NULL)::text
  FROM morrow_work.agent_runs a JOIN morrow_work.work_leases l ON l.organization_id=a.organization_id AND l.workspace_id=a.workspace_id
   AND l.id=a.lease_id
  WHERE a.status IN ('queued','running') AND l.status='active' AND l.started_at IS NULL AND l.kind='run'
   AND l.expires_at>pg_catalog.clock_timestamp()
  ORDER BY a.created_at,a.id LIMIT 100;
END $$;
-- One open run's current lease reference and status (ids and a code only): what the
-- Workflow enters first, or again when its step's result was lost after it committed. A
-- waiting run holds no lease (null lease). Zero rows unless the run is queued, running or
-- waiting. It grants nothing: enter_lease decides whether the lease is still usable.
CREATE FUNCTION morrow_work.agent_run_resume_lease(p_organization_id text,p_workspace_id text,p_run_id text)
RETURNS TABLE(lease_id text,generation text,status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor')
  OR p_organization_id IS NULL OR p_organization_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_workspace_id IS NULL OR p_workspace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_run_id IS NULL OR p_run_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN;
 END IF;
 RETURN QUERY SELECT a.lease_id::text,a.lease_generation::text,a.status FROM morrow_work.agent_runs a
  WHERE a.organization_id=p_organization_id AND a.workspace_id=p_workspace_id AND a.id=p_run_id
   AND a.status IN ('queued','running','waiting');
END $$;
-- A step's entry under the entered lease: the lease is marked started (once), a queued run
-- becomes running with a new active-time segment, and the heartbeat moves. A running run is
-- returned as it stands. Outcomes: started, resumed, running, ended, denied.
CREATE FUNCTION morrow_work.agent_run_start() RETURNS TABLE(outcome text,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; v_now timestamptz; n integer;
BEGIN
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 SELECT x.status,x.started_at INTO r FROM morrow_work.agent_runs x WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id
  AND x.id=e.run_id;
 PERFORM morrow_work.lease_mark_started();
 v_now:=morrow_work.db_now();
 IF r.status='queued' THEN
  UPDATE morrow_work.agent_runs x SET status='running',started_at=COALESCE(x.started_at,greatest(v_now,x.created_at)),
   segment_started_at=greatest(v_now,x.updated_at),heartbeat_at=greatest(v_now,x.updated_at),revision=x.revision+1,
   updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
  PERFORM morrow_work.agent_run_event(e.organization_id,e.workspace_id,e.run_id,'run.started',NULL,'run',e.run_id,NULL);
  RETURN QUERY SELECT CASE WHEN r.started_at IS NULL THEN 'started' ELSE 'resumed' END,'running'::text; RETURN;
 END IF;
 IF r.status='running' THEN
  UPDATE morrow_work.agent_runs x SET heartbeat_at=greatest(v_now,x.updated_at),revision=x.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=e.organization_id AND x.workspace_id=e.workspace_id AND x.id=e.run_id;
  RETURN QUERY SELECT 'running'::text,'running'::text; RETURN;
 END IF;
 RETURN QUERY SELECT 'ended'::text,r.status;
END $$;
-- Per-step renewal, the fourth lease source (ADR-0041 item 7): at a step's entry, under the
-- entered lease of the segment and incarnation that drives the run (another is superseded, and
-- nothing is written), a turn step always renews and any other step renews when less than the
-- safety profile's renewBelowMs remains. Admission's checks run again first: the envelope's
-- absolute expiry checks the run in (a check-in wait with the code envelope, its lease
-- released: only the requester's Continue renews an envelope); any other failure ends the run
-- with its reason and releases the lease. Otherwise a new 30-minute run lease
-- `<run>:l<n>` is issued for the same requester, store, connection and installation, the run
-- moves to it, and the entered lease is released (this transaction's lease context ends with
-- it). Outcomes: renewed, current, checked_in, ended, superseded, invalid, denied.
CREATE FUNCTION morrow_work.agent_run_lease_renew(p_segment text,p_incarnation text,p_step text)
RETURNS TABLE(outcome text,lease_id text,generation text,expires_at_ms text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; x record; v_now timestamptz; v_reason text; v_lease text; v_expires timestamptz; v_wait text; v_sequence integer;
 v_end text; n integer;
BEGIN
 IF p_segment IS NULL OR p_segment !~ '^[1-9][0-9]{0,6}$' OR p_incarnation IS NULL OR p_incarnation !~ '^[1-9][0-9]{0,3}$'
  OR p_step IS NULL OR p_step NOT IN ('turn','other') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT y.* INTO r FROM morrow_work.agent_runs y WHERE y.organization_id=e.organization_id AND y.workspace_id=e.workspace_id AND y.id=e.run_id;
 IF r.segment<>p_segment::integer OR r.incarnation<>p_incarnation::integer THEN
  RETURN QUERY SELECT 'superseded'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 IF p_step='other' AND e.expires_at-v_now>=(r.safety#>>'{lease,renewBelowMs}')::bigint*interval '1 millisecond' THEN
  RETURN QUERY SELECT 'current'::text,e.lease_id,r.lease_generation::text,(extract(epoch FROM e.expires_at)*1000)::bigint::text,NULL::text; RETURN;
 END IF;
 v_reason:=morrow_work.agent_run_admission_check(e.organization_id,e.workspace_id,e.run_id,false);
 IF v_reason IS NULL THEN
  -- The interlock lease_open takes: the stop keys shared, then the stops read again.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
   e.organization_id,e.workspace_id,r.store_id)::text,0));
  IF morrow_work.stop_active(e.organization_id,e.workspace_id,'run',r.connection_id,r.installation_id) THEN v_reason:='stopped'; END IF;
 END IF;
 IF v_reason='envelope_expired' THEN
  SELECT COALESCE(max(w.wait_sequence),0)+1 INTO v_sequence FROM morrow_work.run_waits w
   WHERE w.organization_id=e.organization_id AND w.workspace_id=e.workspace_id AND w.run_id=e.run_id;
  v_wait:=gen_random_uuid()::text;
  INSERT INTO morrow_work.run_waits(organization_id,workspace_id,id,run_id,job_id,wait_sequence,kind,condition,question_id,state,resolvable_code,
   resolution_code,resolution_lease_source,opened_at,wake_at,lapses_at,resolvable_at,resolved_at,expires_at)
  VALUES (e.organization_id,e.workspace_id,v_wait,e.run_id,r.job_id,v_sequence,'checkin','{"kind":"checkin","code":"envelope"}'::jsonb,NULL,'open',
   NULL,NULL,NULL,v_now,NULL,v_now+(r.safety#>>'{personWait,ms}')::bigint*interval '1 millisecond',NULL,NULL,v_now+interval '365 days');
  UPDATE morrow_work.agent_runs y SET status='waiting',wait_id=v_wait,lease_id=NULL,lease_generation=NULL,lease_expires_at=NULL,
   active_ms=y.active_ms+CASE WHEN y.segment_started_at IS NULL THEN 0
    ELSE greatest((extract(epoch FROM v_now-y.segment_started_at)*1000)::bigint,0) END,
   segment_started_at=NULL,revision=y.revision+1,updated_at=greatest(v_now,y.updated_at)
   WHERE y.organization_id=e.organization_id AND y.workspace_id=e.workspace_id AND y.id=e.run_id;
  PERFORM morrow_work.agent_run_event(e.organization_id,e.workspace_id,e.run_id,'run.lease_refused','envelope_expired','run',e.run_id,NULL);
  PERFORM morrow_work.agent_run_event(e.organization_id,e.workspace_id,e.run_id,'checkin.opened','envelope','wait',v_wait,NULL);
  PERFORM morrow_work.agent_run_event(e.organization_id,e.workspace_id,e.run_id,'wait.opened','checkin','wait',v_wait,v_sequence);
  PERFORM morrow_work.lease_release();
  RETURN QUERY SELECT 'checked_in'::text,NULL::text,NULL::text,NULL::text,'envelope_expired'::text; RETURN;
 END IF;
 IF v_reason IS NOT NULL THEN
  PERFORM morrow_work.agent_run_event(e.organization_id,e.workspace_id,e.run_id,'run.lease_refused',v_reason,'run',e.run_id,NULL);
  SELECT * INTO x FROM morrow_work.agent_run_end(e.organization_id,e.workspace_id,e.run_id,'cancelled',v_reason);
  IF x.outcome IS DISTINCT FROM 'ended' THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
  PERFORM morrow_work.lease_release();
  RETURN QUERY SELECT 'ended'::text,NULL::text,NULL::text,NULL::text,v_reason; RETURN;
 END IF;
 v_lease:=gen_random_uuid()::text;
 v_expires:=v_now+interval '30 minutes';
 INSERT INTO morrow_work.work_leases(organization_id,workspace_id,id,generation,kind,subject_id,store_id,connection_id,installation_id,
  initiator_principal_id,initiator_membership_id,status,revoked_reason,created_at,expires_at,started_at,ended_at)
 VALUES (e.organization_id,e.workspace_id,v_lease,1,'run',e.run_id||':l'||(r.lease_renewals+1),r.store_id,r.connection_id,r.installation_id,
  r.requester_principal_id,r.requester_membership_id,'active',NULL,v_now,v_expires,NULL,NULL);
 UPDATE morrow_work.agent_runs y SET lease_id=v_lease,lease_generation=1,lease_expires_at=v_expires,lease_renewals=y.lease_renewals+1,
  heartbeat_at=greatest(v_now,y.updated_at),revision=y.revision+1,updated_at=greatest(v_now,y.updated_at)
  WHERE y.organization_id=e.organization_id AND y.workspace_id=e.workspace_id AND y.id=e.run_id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 PERFORM morrow_work.agent_run_event(e.organization_id,e.workspace_id,e.run_id,'run.lease_renewed','step_renewal','run',e.run_id,
  r.lease_renewals+1);
 v_end:=morrow_work.lease_release();
 IF v_end IS DISTINCT FROM 'released' THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 RETURN QUERY SELECT 'renewed'::text,v_lease,'1'::text,(extract(epoch FROM v_expires)*1000)::bigint::text,NULL::text;
END $$;
-- Wait resolution, the fifth lease source (ADR-0041 items 7 and 17): a waiting run whose open
-- wait (this sequence) is resolvable, or a timer that is due, resumes only here, never on a
-- question (only the requester's answer resumes it). Refused with no write when the envelope
-- has expired (the sweep checks the run in) or the wait is not resolvable. Otherwise, all or
-- nothing: a new 30-minute run lease `<run>:w<sequence>` for the run's requester, store,
-- connection and installation, entered at once (enter_lease: the member current and no stop),
-- then admission's checks again (any failure ends the run with that reason and releases the
-- lease), then the wait resolved (its resolution, lease source wait_resume) and the run queued
-- under the new lease. The caller sends w-<sequence> to <run>-s<segment>-i<incarnation>.
-- Outcomes: resumed, not_waiting, not_resolvable, lapsed, envelope_expired, stopped,
-- member_inactive, refused, ended, invalid, denied.
CREATE FUNCTION morrow_work.agent_run_resume(p_organization_id text,p_workspace_id text,p_run_id text,p_wait_sequence text)
RETURNS TABLE(outcome text,lease_id text,generation text,segment text,incarnation text,event_type text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE r record; w record; l record; x record; v_now timestamptz; v_code text; v_lease text; v_expires timestamptz; v_out text; v_reason text;
 n integer;
BEGIN
 IF p_organization_id IS NULL OR p_organization_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_workspace_id IS NULL OR p_workspace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_run_id IS NULL OR p_run_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_wait_sequence IS NULL OR p_wait_sequence !~ '^[1-9][0-9]{0,6}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor')
  OR COALESCE(pg_catalog.current_setting('morrow.work_session_digest',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_lease_id',true),'')<>'' THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.agent_run',p_organization_id,
  p_workspace_id,p_run_id)::text,0));
 SELECT y.* INTO r FROM morrow_work.agent_runs y WHERE y.organization_id=p_organization_id AND y.workspace_id=p_workspace_id AND y.id=p_run_id
  AND y.status='waiting';
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_waiting'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT y.id::text AS id,y.wait_sequence,y.kind,y.state,y.resolvable_code,y.wake_at,y.lapses_at INTO w FROM morrow_work.run_waits y
  WHERE y.organization_id=p_organization_id AND y.workspace_id=p_workspace_id AND y.id=r.wait_id AND y.wait_sequence=p_wait_sequence::integer;
 v_now:=morrow_work.db_now();
 v_code:=CASE WHEN NOT FOUND OR w.kind='question' THEN NULL WHEN w.state='resolvable' THEN w.resolvable_code
  WHEN w.state='open' AND w.kind='timer' AND w.wake_at<=v_now THEN 'time_reached' END;
 IF v_code IS NULL THEN RETURN QUERY SELECT 'not_resolvable'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 -- A wait past its lapse time never resumes, resolvable or not: the sweep lapses it and the run
 -- closes keeping its context (ADR-0041 items 3 and 9), so only a person's Continue goes on.
 IF w.lapses_at IS NOT NULL AND w.lapses_at<=v_now THEN
  RETURN QUERY SELECT 'lapsed'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF r.envelope_expires_at<=v_now OR r.active_ms-r.envelope_active_base_ms>=(r.safety#>>'{envelope,activeMs}')::bigint THEN
  RETURN QUERY SELECT 'envelope_expired'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,'envelope_expired'::text; RETURN;
 END IF;
 v_lease:=gen_random_uuid()::text;
 v_expires:=v_now+interval '30 minutes';
 BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
   p_organization_id,p_workspace_id,r.store_id)::text,0));
  INSERT INTO morrow_work.work_leases(organization_id,workspace_id,id,generation,kind,subject_id,store_id,connection_id,installation_id,
   initiator_principal_id,initiator_membership_id,status,revoked_reason,created_at,expires_at,started_at,ended_at)
  VALUES (p_organization_id,p_workspace_id,v_lease,1,'run',p_run_id||':w'||w.wait_sequence,r.store_id,r.connection_id,r.installation_id,
   r.requester_principal_id,r.requester_membership_id,'active',NULL,v_now,v_expires,NULL,NULL);
  SELECT * INTO l FROM morrow_work.enter_lease(v_lease,'1');
  IF l.outcome IS DISTINCT FROM 'entered' THEN v_out:=COALESCE(l.outcome,'denied'); RAISE EXCEPTION 'AGENT_RUN_RESUME_REFUSED'; END IF;
 EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR not_null_violation OR foreign_key_violation OR insufficient_privilege THEN
  RETURN QUERY SELECT CASE WHEN v_out IN ('stopped','member_inactive') THEN v_out ELSE 'refused' END,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,v_out;
  RETURN;
 END;
 -- In the run's own lease context from here: admission's checks again.
 v_reason:=morrow_work.agent_run_admission_check(p_organization_id,p_workspace_id,p_run_id,false);
 IF v_reason='envelope_expired' THEN
  PERFORM morrow_work.lease_release();
  RETURN QUERY SELECT 'envelope_expired'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,v_reason; RETURN;
 END IF;
 IF v_reason IS NOT NULL THEN
  PERFORM morrow_work.agent_run_event(p_organization_id,p_workspace_id,p_run_id,'run.lease_refused',v_reason,'run',p_run_id,NULL);
  SELECT * INTO x FROM morrow_work.agent_run_end(p_organization_id,p_workspace_id,p_run_id,'cancelled',v_reason);
  IF x.outcome IS DISTINCT FROM 'ended' THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
  PERFORM morrow_work.lease_release();
  RETURN QUERY SELECT 'ended'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,v_reason; RETURN;
 END IF;
 UPDATE morrow_work.agent_runs y SET status='queued',wait_id=NULL,lease_id=v_lease,lease_generation=1,lease_expires_at=v_expires,
  revision=y.revision+1,updated_at=greatest(v_now,y.updated_at)
  WHERE y.organization_id=p_organization_id AND y.workspace_id=p_workspace_id AND y.id=p_run_id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 UPDATE morrow_work.run_waits y SET state='resolved',resolution_code=v_code,resolution_lease_source='wait_resume',
  resolved_at=greatest(v_now,y.opened_at)
  WHERE y.organization_id=p_organization_id AND y.workspace_id=p_workspace_id AND y.id=w.id;
 PERFORM morrow_work.agent_run_event(p_organization_id,p_workspace_id,p_run_id,'wait.resolved',v_code,'wait',w.id,w.wait_sequence);
 RETURN QUERY SELECT 'resumed'::text,v_lease,'1'::text,r.segment::text,r.incarnation::text,'w-'||w.wait_sequence,NULL::text;
END $$;
-- Upkeep admission, the sixth lease source (ADR-0041 items 7, 26 and 27): one pending
-- upkeep_triggers row (written in a person's act, or under a lease a person's act admitted)
-- admits one upkeep run of the agent whose memory it tends, at that agent's model and effort,
-- with the upkeep tool set only (a consolidation: memory.read, memory.search, notebook.write
-- and run.complete; a summary: memory.read and run.complete). All or nothing: the run lease
-- `<run>:u:<trigger>` for the trigger's requester, entered at once (the member current and no
-- stop: the requester's live view), then the installation active on its store and connection
-- with its release published and the store's association current, the catalogue entry, the
-- active context policy and the tool set present; a failure there skips the trigger. Then the
-- context (scope upkeep), the run (its manifest built here, RFC 8785, with the same digest code
-- computes), segment 1, the trigger admitted, and the run.admitted event. A trigger already
-- admitted answers its run. Outcomes: admitted, admitted_before, not_found, skipped (with a
-- reason), stopped, member_inactive, refused, invalid, denied.
CREATE FUNCTION morrow_work.admit_upkeep_run(p_organization_id text,p_workspace_id text,p_trigger_id text)
RETURNS TABLE(outcome text,run_id text,lease_id text,generation text,workflow_instance_id text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; l record; i record; v record; e record; cp record; rel record; v_now timestamptz; v_run text; v_context text; v_envelope text;
 v_lease text; v_expires timestamptz; v_out text; v_reason text; v_tools text[]; v_safety jsonb; v_audience jsonb; v_manifest jsonb; v_canonical text;
 v_instance text;
BEGIN
 IF p_organization_id IS NULL OR p_organization_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_workspace_id IS NULL OR p_workspace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_trigger_id IS NULL OR p_trigger_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor')
  OR COALESCE(pg_catalog.current_setting('morrow.work_session_digest',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_lease_id',true),'')<>'' THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.upkeep_trigger',p_organization_id,
  p_workspace_id,p_trigger_id)::text,0));
 SELECT y.* INTO t FROM morrow_work.upkeep_triggers y WHERE y.organization_id=p_organization_id AND y.workspace_id=p_workspace_id AND y.id=p_trigger_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF t.state='admitted' THEN RETURN QUERY SELECT 'admitted_before'::text,t.run_id::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 v_run:=gen_random_uuid()::text;
 v_context:=gen_random_uuid()::text;
 v_envelope:=gen_random_uuid()::text;
 v_lease:=gen_random_uuid()::text;
 v_expires:=v_now+interval '30 minutes';
 BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
   p_organization_id,p_workspace_id,t.store_id)::text,0));
  INSERT INTO morrow_work.work_leases(organization_id,workspace_id,id,generation,kind,subject_id,store_id,connection_id,installation_id,
   initiator_principal_id,initiator_membership_id,status,revoked_reason,created_at,expires_at,started_at,ended_at)
  VALUES (p_organization_id,p_workspace_id,v_lease,1,'run',v_run||':u:'||p_trigger_id,t.store_id,t.connection_id,t.installation_id,
   t.requester_principal_id,t.requester_membership_id,'active',NULL,v_now,v_expires,NULL,NULL);
  SELECT * INTO l FROM morrow_work.enter_lease(v_lease,'1');
  IF l.outcome IS DISTINCT FROM 'entered' THEN v_out:=COALESCE(l.outcome,'denied'); RAISE EXCEPTION 'AGENT_UPKEEP_REFUSED'; END IF;
 EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR not_null_violation OR foreign_key_violation OR insufficient_privilege THEN
  RETURN QUERY SELECT CASE WHEN v_out IN ('stopped','member_inactive') THEN v_out ELSE 'refused' END,NULL::text,NULL::text,NULL::text,
   NULL::text,v_out;
  RETURN;
 END;
 -- In the new lease's context: the requester's live view of the agent it tends, and the set.
 SELECT y.status,y.store_id::text AS store_id,y.connection_id::text AS connection_id,y.agent_principal_id::text AS agent_principal_id,
  y.release_id,y.release_revision::bigint AS release_revision,y.release_digest::text AS release_digest INTO i FROM morrow_work.agent_installations y
  WHERE y.organization_id=p_organization_id AND y.workspace_id=p_workspace_id AND y.id=t.installation_id;
 IF NOT FOUND OR i.status<>'active' OR i.store_id<>t.store_id::text OR i.connection_id<>t.connection_id::text
  OR i.agent_principal_id<>t.agent_principal_id::text THEN
  v_reason:='lease_ended';
 ELSIF NOT EXISTS(SELECT 1 FROM morrow_work.listings_store_current(p_organization_id,p_workspace_id,t.store_id) y
   WHERE y.connection_id::text=t.connection_id::text) THEN
  v_reason:='lease_ended';
 END IF;
 IF v_reason IS NULL THEN
  SELECT y.id,y.revision::bigint AS revision,y.digest::text AS digest INTO rel FROM morrow_work.agent_releases y
   WHERE y.id=i.release_id AND y.revision=i.release_revision AND y.digest=i.release_digest AND y.status='published';
  IF NOT FOUND THEN v_reason:='lease_ended'; END IF;
 END IF;
 IF v_reason IS NULL THEN
  SELECT y.* INTO v FROM morrow_work.loop_catalogue_versions y WHERE y.version=t.catalogue_version AND y.status='active';
  IF FOUND THEN
   SELECT y.* INTO e FROM morrow_work.loop_catalogue_entries y WHERE y.version=v.version AND y.model_key=t.model_key AND y.effort_key=t.effort_key;
  END IF;
  IF NOT FOUND THEN v_reason:='version_unknown'; END IF;
 END IF;
 IF v_reason IS NULL THEN
  SELECT y.version,y.digest::text AS digest INTO cp FROM morrow_work.context_policy_versions y WHERE y.model_key=t.model_key
   AND y.effort_key=t.effort_key AND y.status='active';
  IF NOT FOUND THEN v_reason:='version_unknown'; END IF;
 END IF;
 IF v_reason IS NULL THEN
  v_tools:=CASE t.kind WHEN 'consolidation' THEN ARRAY['notebook.write','memory.search','memory.read','run.complete']
   ELSE ARRAY['memory.read','run.complete'] END;
  IF (SELECT count(*) FROM morrow_work.tool_catalogue_entries y WHERE y.version=t.tool_catalogue_version AND y.tool=ANY(v_tools))
    <>cardinality(v_tools) THEN
   v_reason:='version_unknown';
  END IF;
 END IF;
 IF v_reason IS NULL THEN
  v_safety:=morrow_work.agent_safety_compose(v.safety_template,e.max_output_tokens);
  IF NOT morrow_work.agent_safety_valid(v_safety) THEN v_reason:='version_unknown'; END IF;
 END IF;
 IF v_reason IS NOT NULL THEN
  UPDATE morrow_work.upkeep_triggers y SET state='skipped',ended_at=greatest(v_now,y.created_at),revision=y.revision+1
   WHERE y.organization_id=p_organization_id AND y.workspace_id=p_workspace_id AND y.id=p_trigger_id;
  PERFORM morrow_work.lease_release();
  RETURN QUERY SELECT 'skipped'::text,NULL::text,NULL::text,NULL::text,NULL::text,v_reason; RETURN;
 END IF;
 v_audience:=CASE t.subject_kind WHEN 'conversation' THEN jsonb_build_object('kind','subject','subject',
  jsonb_build_object('kind','conversation','id',t.subject_id)) ELSE '{"kind":"workspace"}'::jsonb END;
 v_instance:=v_run||'-s1-i1';
 v_manifest:=jsonb_build_object('schemaVersion',1,'workflow','agent-run@1','runId',v_run,'organizationId',p_organization_id,
  'workspaceId',p_workspace_id,'storeId',t.store_id,'connectionId',t.connection_id,'kind','upkeep','purpose',NULL,'taskId',NULL,'jobId',NULL,
  'contextId',v_context,'conversationId',NULL,'sourceInboxId',NULL,
  'lineage',jsonb_build_object('rootRunId',v_run,'parentRunId',NULL,'parentToolUseId',NULL,'callId',NULL,'depth',0,'forkedFromRunId',NULL,
   'forkedAtSequence',NULL,'continuesRunId',NULL),
  'envelopeId',v_envelope,'installationId',t.installation_id,'mandateId',NULL,'triggerId',NULL,
  'requester',jsonb_build_object('kind','human','principalId',t.requester_principal_id,'organizationId',p_organization_id,
   'workspaceId',p_workspace_id,'membershipId',t.requester_membership_id,'installationId',NULL,'mandateId',NULL),
  'release',jsonb_build_object('id',rel.id,'revision',rel.revision,'digest',rel.digest),'systemTextDigest',t.system_text_digest,
  'toolCatalogueVersion',t.tool_catalogue_version,'toolCatalogueDigest',t.tool_catalogue_digest,'tools',to_jsonb(v_tools),
  'modelProfile',jsonb_build_object('model',t.model_key,'effort',t.effort_key,'catalogueVersion',v.version),'safety',v_safety,
  'pins',jsonb_build_object('harnessVersion',1,'runnerVersion',1,'rendererVersion',1,'loopCatalogueVersion',v.version,
   'contextPolicyVersion',cp.version,'contextPolicyDigest',cp.digest,'rateCardVersion',NULL),
  'specDigest',NULL,'dataClasses',NULL,'admittedAt',morrow_work.utc_text(v_now));
 v_canonical:=morrow_work.harness_jcs(v_manifest);
 INSERT INTO morrow_work.agent_contexts(organization_id,workspace_id,id,revision,scope,job_id,conversation_id,call_id,requester_principal_id,
  requester_membership_id,agent_principal_id,installation_id,audience,tools,tool_catalogue_version,tool_catalogue_digest,system_text_digest,
  catalogue_version,model_key,effort_key,renderer_version,context_policy_version,context_policy_digest,current_epoch,last_sequence,read_tags,taint,
  status,created_at,updated_at,closed_at)
 VALUES (p_organization_id,p_workspace_id,v_context,1,'upkeep',NULL,NULL,NULL,t.requester_principal_id,t.requester_membership_id,
  t.agent_principal_id,t.installation_id,v_audience,v_tools,t.tool_catalogue_version,t.tool_catalogue_digest,t.system_text_digest,v.version,
  t.model_key,t.effort_key,1,cp.version,cp.digest,0,0,'[]'::jsonb,'{"kinds":[],"sourceCount":0}'::jsonb,'open',v_now,v_now,NULL);
 INSERT INTO morrow_work.agent_runs(organization_id,workspace_id,id,revision,kind,purpose,job_id,root_run_id,parent_run_id,parent_tool_use_id,call_id,
  depth,forked_from_run_id,forked_at_sequence,continues_run_id,context_id,conversation_id,source_inbox_id,task_id,child_task_id,store_id,
  connection_id,installation_id,mandate_id,trigger_id,agent_principal_id,coordinator_principal_id,envelope_id,work_envelope_id,hop_id,
  envelope_expires_at,envelope_renewed_at,envelope_active_base_ms,lease_id,lease_generation,lease_expires_at,lease_renewals,
  requester_principal_id,requester_membership_id,status,ended_reason,segment,incarnation,workflow_instance_id,segment_steps,heartbeat_at,
  active_ms,segment_started_at,wait_id,taint,read_tags,person_memory_loaded,credits_held,credits_drawn,credits_refunded,credits_absorbed,
  release_id,release_revision,release_digest,manifest_canonical,manifest_digest,system_text_digest,tool_catalogue_version,tool_catalogue_digest,
  tools,catalogue_version,model_key,effort_key,safety,safety_profile_version,max_output_tokens,call_budget_ms,harness_version,runner_version,
  renderer_version,context_policy_version,context_policy_digest,rate_card_version,turns_taken,tool_calls_taken,children_admitted,request_digest,
  command_id,created_at,started_at,ended_at,updated_at)
 VALUES (p_organization_id,p_workspace_id,v_run,1,'upkeep',NULL,NULL,v_run,NULL,NULL,NULL,0,NULL,NULL,NULL,v_context,NULL,NULL,NULL,NULL,
  t.store_id,t.connection_id,t.installation_id,NULL,NULL,t.agent_principal_id,NULL,v_envelope,NULL,NULL,
  v_now+(v_safety#>>'{envelope,wallMs}')::bigint*interval '1 millisecond',v_now,0,v_lease,1,v_expires,0,t.requester_principal_id,
  t.requester_membership_id,'queued',NULL,1,1,v_instance,0,NULL,0,NULL,NULL,'{"contextTaint":"none","kinds":[],"sources":[],"omittedSources":0}'::jsonb,
  '[]'::jsonb,false,0,0,0,0,rel.id,rel.revision,rel.digest,v_canonical,morrow_work.sha256_text(v_canonical),t.system_text_digest,
  t.tool_catalogue_version,t.tool_catalogue_digest,v_tools,v.version,t.model_key,t.effort_key,v_safety,v.safety_profile_version,
  e.max_output_tokens,(v_safety#>>'{turn,callBudgetMs}')::integer,1,1,1,cp.version,cp.digest,NULL,0,0,0,NULL,NULL,v_now,NULL,NULL,v_now);
 INSERT INTO morrow_work.run_segments(organization_id,workspace_id,run_id,segment,incarnation,workflow_instance_id,reason,steps,started_at,
  rolled_at,expires_at)
 VALUES (p_organization_id,p_workspace_id,v_run,1,1,v_instance,'start',0,v_now,NULL,v_now+interval '365 days');
 UPDATE morrow_work.upkeep_triggers y SET state='admitted',run_id=v_run,admitted_at=greatest(v_now,y.created_at),revision=y.revision+1
  WHERE y.organization_id=p_organization_id AND y.workspace_id=p_workspace_id AND y.id=p_trigger_id;
 PERFORM morrow_work.agent_run_event(p_organization_id,p_workspace_id,v_run,'run.admitted','upkeep_admission','run',v_run,NULL);
 RETURN QUERY SELECT 'admitted'::text,v_run,v_lease,'1'::text,v_instance,NULL::text;
END $$;
-- The sweep's list, the changed lease source (ADR-0041 item 7): ids, positions and one action
-- per open run, cross-tenant, oldest first, at most 100; it never issues a lease and writes
-- nothing. resume: a waiting run's wait is resolvable (or a due timer) inside its envelope
-- (agent_run_resume issues the lease after admission's checks); check_in: the same past the
-- envelope (the run checks in, H7b); lapse: a wait past its lapse time (the run closes and keeps
-- its context, H7b); close_lapsed: a queued or running run whose lease expired unrenewed (it
-- closes lease_lapsed, keeping its context; only a person's Continue picks it up); wake: a
-- running run whose lease is unexpired and whose heartbeat is older than a turn step (the
-- sweep re-sends a lost wake only while the lease holds).
CREATE FUNCTION morrow_work.agent_run_wake_candidates()
RETURNS TABLE(organization_id text,workspace_id text,run_id text,segment text,incarnation text,wait_sequence text,action text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor') THEN RETURN; END IF;
 RETURN QUERY SELECT q.organization_id,q.workspace_id,q.id,q.segment::text,q.incarnation::text,q.wait_sequence::text,q.action FROM (
  SELECT a.organization_id::text AS organization_id,a.workspace_id::text AS workspace_id,a.id::text AS id,a.segment,a.incarnation,
   w.wait_sequence,a.created_at,
   CASE
    WHEN a.status='waiting' AND w.lapses_at IS NOT NULL AND w.lapses_at<=pg_catalog.clock_timestamp() THEN 'lapse'
    WHEN a.status='waiting' AND w.kind<>'question'
     AND (w.state='resolvable' OR (w.state='open' AND w.kind='timer' AND w.wake_at<=pg_catalog.clock_timestamp())) THEN
     CASE WHEN a.envelope_expires_at<=pg_catalog.clock_timestamp()
       OR a.active_ms-a.envelope_active_base_ms>=(a.safety#>>'{envelope,activeMs}')::bigint THEN 'check_in' ELSE 'resume' END
    WHEN a.status IN ('queued','running') AND a.lease_expires_at<=pg_catalog.clock_timestamp() THEN 'close_lapsed'
    WHEN a.status='running' AND a.lease_expires_at>pg_catalog.clock_timestamp()
     AND (a.heartbeat_at IS NULL OR a.heartbeat_at<=pg_catalog.clock_timestamp()
      -((a.safety#>>'{turn,callBudgetMs}')::bigint+120000)*interval '1 millisecond') THEN 'wake'
   END AS action
  FROM morrow_work.agent_runs a LEFT JOIN morrow_work.run_waits w ON w.organization_id=a.organization_id AND w.workspace_id=a.workspace_id
   AND w.id=a.wait_id
  WHERE a.status IN ('queued','running','waiting')) q
  WHERE q.action IS NOT NULL ORDER BY q.created_at,q.id LIMIT 100;
END $$;
-- A segment roll (ADR-0041 item 6): under the entered lease of the incarnation that drives the
-- run, the next segment is recorded with its instance id <run>-s<segment+1>-i<incarnation> in
-- one transaction (the same step creates the instance; "already exists" counts as success);
-- the old segment is closed with its step count. A replay after the roll answers the roll it
-- made; another incarnation, or a segment the run has left, is superseded and writes nothing.
-- Reasons: steps (1,000 in a segment), epoch (every epoch boundary), wait (before a wait
-- expected to last more than 5 minutes). Outcomes: rolled, rolled_before, superseded,
-- invalid, denied.
CREATE FUNCTION morrow_work.agent_run_segment_roll(p_segment text,p_incarnation text,p_reason text)
RETURNS TABLE(outcome text,segment text,incarnation text,workflow_instance_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; r record; v_now timestamptz; v_next integer; v_instance text; n integer;
BEGIN
 IF p_segment IS NULL OR p_segment !~ '^[1-9][0-9]{0,6}$' OR p_incarnation IS NULL OR p_incarnation !~ '^[1-9][0-9]{0,3}$'
  OR p_reason IS NULL OR p_reason NOT IN ('steps','epoch','wait') OR p_segment::integer>=1000000 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO e FROM morrow_work.agent_run_entered();
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT y.* INTO r FROM morrow_work.agent_runs y WHERE y.organization_id=e.organization_id AND y.workspace_id=e.workspace_id AND y.id=e.run_id;
 IF r.incarnation<>p_incarnation::integer THEN RETURN QUERY SELECT 'superseded'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF r.segment=p_segment::integer+1 AND EXISTS(SELECT 1 FROM morrow_work.run_segments s WHERE s.organization_id=e.organization_id
   AND s.workspace_id=e.workspace_id AND s.run_id=e.run_id AND s.segment=p_segment::integer AND s.incarnation=r.incarnation
   AND s.rolled_at IS NOT NULL) THEN
  RETURN QUERY SELECT 'rolled_before'::text,r.segment::text,r.incarnation::text,r.workflow_instance_id; RETURN;
 END IF;
 IF r.segment<>p_segment::integer THEN RETURN QUERY SELECT 'superseded'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 v_next:=r.segment+1;
 v_instance:=e.run_id||'-s'||v_next||'-i'||r.incarnation;
 UPDATE morrow_work.run_segments s SET steps=greatest(s.steps,r.segment_steps),rolled_at=greatest(v_now,s.started_at)
  WHERE s.organization_id=e.organization_id AND s.workspace_id=e.workspace_id AND s.run_id=e.run_id AND s.segment=r.segment
   AND s.incarnation=r.incarnation AND s.rolled_at IS NULL;
 INSERT INTO morrow_work.run_segments(organization_id,workspace_id,run_id,segment,incarnation,workflow_instance_id,reason,steps,started_at,
  rolled_at,expires_at)
 VALUES (e.organization_id,e.workspace_id,e.run_id,v_next,r.incarnation,v_instance,p_reason,0,v_now,NULL,v_now+interval '365 days');
 UPDATE morrow_work.agent_runs y SET segment=v_next,workflow_instance_id=v_instance,segment_steps=0,heartbeat_at=greatest(v_now,y.updated_at),
  revision=y.revision+1,updated_at=greatest(v_now,y.updated_at)
  WHERE y.organization_id=e.organization_id AND y.workspace_id=e.workspace_id AND y.id=e.run_id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'WORK_AGENT_RUN_INVALID'; END IF;
 PERFORM morrow_work.agent_run_event(e.organization_id,e.workspace_id,e.run_id,'run.segment_rolled',p_reason,'run',e.run_id,v_next);
 RETURN QUERY SELECT 'rolled'::text,v_next::text,r.incarnation::text,v_instance;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p WHERE p.pronamespace='morrow_work'::regnamespace AND p.proname IN (
  'harness_ms','harness_jcs','loop_user_message_valid','loop_assistant_message_valid','loop_choices_valid','loop_tool_fields',
  'harness_audience_valid','harness_source_subjects_valid','harness_derived_taint_valid','harness_run_taint_valid','harness_section_tokens_valid',
  'harness_notices_valid','agent_safety_valid','agent_safety_compose','run_wait_condition_valid','agent_manifest_matches',
  'job_guard','agent_context_guard','context_epoch_guard','harness_expiry_guard','agent_run_guard','agent_call_guard','agent_run_question_guard',
  'run_wait_guard','run_turn_guard','run_tool_call_guard','agent_model_call_guard','run_plan_guard','result_item_guard','run_detector_state_guard',
  'run_segment_guard','upkeep_trigger_guard','agent_run_event','agent_run_admission_check','agent_run_end','agent_run_entered',
  'agent_lease_issuable','cmd_agent_run_admit','cmd_agent_run_answer','agent_run_pending_starts','agent_run_resume_lease','agent_run_start',
  'agent_run_lease_renew','agent_run_resume','admit_upkeep_run','agent_run_wake_candidates','agent_run_segment_roll') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',r.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION morrow_work.harness_ms(timestamptz),morrow_work.harness_jcs(jsonb),morrow_work.loop_user_message_valid(jsonb),
 morrow_work.loop_assistant_message_valid(jsonb),morrow_work.loop_choices_valid(jsonb),morrow_work.loop_tool_fields(text[]),
 morrow_work.harness_audience_valid(jsonb),morrow_work.harness_source_subjects_valid(jsonb),morrow_work.harness_derived_taint_valid(jsonb),
 morrow_work.harness_run_taint_valid(jsonb),morrow_work.harness_section_tokens_valid(jsonb),morrow_work.harness_notices_valid(jsonb),
 morrow_work.agent_safety_valid(jsonb),morrow_work.agent_safety_compose(jsonb,integer),morrow_work.run_wait_condition_valid(text,jsonb),
 morrow_work.agent_manifest_matches(text,jsonb) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_work.agent_run_event(text,text,text,text,text,text,text,bigint),
 morrow_work.agent_run_admission_check(text,text,text,boolean),morrow_work.agent_run_end(text,text,text,text,text) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_work.cmd_agent_run_admit(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,
  text,text,text,text,text,text),
 morrow_work.cmd_agent_run_answer(text,text,text,text,text) TO morrow_work_api;
GRANT EXECUTE ON FUNCTION morrow_work.agent_run_pending_starts(),morrow_work.agent_run_resume_lease(text,text,text),morrow_work.agent_run_start(),
 morrow_work.agent_run_lease_renew(text,text,text),morrow_work.agent_run_resume(text,text,text,text),morrow_work.admit_upkeep_run(text,text,text),
 morrow_work.agent_run_wake_candidates(),morrow_work.agent_run_segment_roll(text,text,text) TO morrow_runtime_executor;
GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_entered() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_lease_issuable(text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_agent_run_admit(text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,text,
 text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_agent_run_answer(text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_pending_starts() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_resume_lease(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_start() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_lease_renew(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_resume(text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.admit_upkeep_run(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_wake_candidates() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_run_segment_roll(text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;

COMMIT;
