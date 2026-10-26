BEGIN;
-- H12a, the memory foundation (docs/briefs/memory-foundation.md; ADR-0041 items 25 to 30, with
-- ADR-0031 items 1, 3, 4 and 6 as ADR-0041 amends them). Executes AS morrow_work_owner, as 0057
-- after 0056. Forward only: no published migration is edited. On the ADR-0010 tenant pattern:
-- composite tenant keys, ENABLE and FORCE RLS, definers owned by morrow_work_command, INVOKER
-- triggers, checks and helpers owned by the owner. No external effect: nothing here sends a
-- request, reserves money, admits a run or writes to a store.
--   * pg_trgm, in its own schema `extensions` (owned by the owner, USAGE for the command role
--     only; its name is outside morrow_% so no executor login can reach its functions), for the
--     trigram half of the hybrid lexical search (ADR-0041 item 30).
--   * Notebooks re-keyed by agent principal (ADR-0041 item 27): 0052's agent_notebooks and
--     agent_notebook_entries are altered in place, guarded on both being empty (nothing writes
--     them while docs/decisions/shop-knowledge-staging.json holds agent_tools off). An entry
--     gains its kind, title, taint (kinds and sources), derived_from, audience, source subjects,
--     the requester it was written for, renewal and use counts, and is clocked 90 days after its
--     last write or re-affirmation. Its text is indexed in the same row (a `simple` tsvector and
--     trigram text, both expressions of title and body), so erasing the text erases its index in
--     the same UPDATE.
--   * memory_derivations: the content-free lineage of every derived row (which source it came
--     from), read by the deletion path ("deletion follows the source") and the view rebase.
--   * memory_repairs: content-free flags on memory a person or an upkeep run must look at: an
--     entry erased because its source was, an entry whose knowledge page changed, and an
--     untainted entry a tainted run tried to replace or retire (it may only flag it).
--   * memory_settings: one row per person (personal memory on or off and its default scope),
--     written first by H12b's Settings › Memory.
--   * Definers: run_notebook_write_v2 (notebook.write's add, replace and retire under the run's
--     lease), run_memory_search and run_memory_read (the memory tools: every layer's predicates,
--     read tags, source subjects and audience, applied before ranking), and cmd_notebook_clear_v2
--     (a person clears an agent's notebook at the revision their check read). 0052's
--     run_notebook_write and cmd_notebook_clear stay registered and fail closed on the re-keyed
--     tables (their statements name a dropped column), so neither can write.
--   * The deletion path (ADR-0031 items 3 and 4; G9): a cleared or source-erased entry erases
--     every entry derived from it, and a deleted knowledge page erases every entry derived from
--     it, each in the same transaction, recorded as a repair; memory_erase_expired is the daily
--     sweep's handler for the 90-day clock. No runtime role holds DELETE (S4).
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR NOT morrow_identity.memberships_closed('morrow_runtime_executor')
 OR to_regclass('morrow_work.agent_notebooks') IS NULL OR to_regclass('morrow_work.agent_notebook_entries') IS NULL
 OR to_regclass('morrow_work.knowledge_pages') IS NULL OR to_regclass('morrow_work.knowledge_versions') IS NULL
 OR to_regclass('morrow_work.agent_installations') IS NULL OR to_regclass('morrow_work.work_leases') IS NULL
 OR to_regclass('morrow_work.memory_derivations') IS NOT NULL OR to_regclass('morrow_work.memory_repairs') IS NOT NULL
 OR to_regclass('morrow_work.memory_settings') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname='extensions')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pg_trgm')
 OR NOT pg_catalog.has_database_privilege('morrow_work_owner',pg_catalog.current_database(),'CREATE')
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL OR to_regprocedure('morrow_work.current_lease()') IS NULL
 OR to_regprocedure('morrow_work.command_prelude(text,text)') IS NULL
 OR to_regprocedure('morrow_work.record_command(text,text,text,text,text,text,text,text,bigint,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.db_now()') IS NULL OR to_regprocedure('morrow_work.sha256_text(text)') IS NULL
 OR to_regprocedure('morrow_work.append_only()') IS NULL
 OR to_regprocedure('morrow_work.knowledge_tags_valid(jsonb)') IS NULL OR to_regprocedure('morrow_work.knowledge_tags_union(jsonb,jsonb)') IS NULL
 OR to_regprocedure('morrow_work.agent_notebook_entry_guard()') IS NULL
 OR to_regprocedure('morrow_work.run_notebook_write(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.cmd_notebook_clear(text,text,text,text,text)') IS NULL
 OR NOT pg_catalog.has_column_privilege('morrow_work_owner','morrow_identity.agent_principals','principal_id','REFERENCES')
 -- The two notebook tables exactly as 0052 left them: columns, constraints and the entry guard.
 OR (SELECT string_agg(a.attname,',' ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
   WHERE a.attrelid='morrow_work.agent_notebooks'::regclass AND a.attnum>0 AND NOT a.attisdropped)
  IS DISTINCT FROM 'organization_id,workspace_id,installation_id,revision,next_sequence,live_entries,created_at,updated_at'
 OR (SELECT string_agg(a.attname,',' ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
   WHERE a.attrelid='morrow_work.agent_notebook_entries'::regclass AND a.attnum>0 AND NOT a.attisdropped)
  IS DISTINCT FROM 'organization_id,workspace_id,installation_id,sequence,id,body,read_tags,run_id,tool_use_id,digest,created_at,expires_at,erased_at,erased_reason'
 OR (SELECT md5(string_agg(k.conname||':'||pg_catalog.pg_get_constraintdef(k.oid),',' ORDER BY k.conname)) FROM pg_catalog.pg_constraint k
   WHERE k.conrelid='morrow_work.agent_notebooks'::regclass) IS DISTINCT FROM '5c5da81aeccc76e97333797bf41ab5b7'
 OR (SELECT md5(string_agg(k.conname||':'||pg_catalog.pg_get_constraintdef(k.oid),',' ORDER BY k.conname)) FROM pg_catalog.pg_constraint k
   WHERE k.conrelid='morrow_work.agent_notebook_entries'::regclass) IS DISTINCT FROM '705c6ee3058093d6062cc5462bc270f9'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid='morrow_work.agent_notebook_entry_guard()'::regprocedure)
  IS DISTINCT FROM 'db122ff86bcd7e3a9f86d9761c81d804'
 THEN RAISE EXCEPTION 'MEMORY_FOUNDATION_PREREQUISITES_INVALID'; END IF;
 -- Re-keying is safe only while no notebook or entry exists (ADR-0041 item 27). The owner's
 -- maintenance policy sees every tenant's rows.
 IF EXISTS(SELECT 1 FROM morrow_work.agent_notebooks) OR EXISTS(SELECT 1 FROM morrow_work.agent_notebook_entries) THEN
  RAISE EXCEPTION 'MEMORY_FOUNDATION_NOTEBOOKS_NOT_EMPTY';
 END IF;
END $$;

-- ---------------------------------------------------------------------------
-- pg_trgm (trusted since PostgreSQL 13: the owner, holding CREATE on the database, installs it;
-- its objects belong to the bootstrap superuser). Its schema grants USAGE to the command role
-- alone, which owns every definer that ranks with it.
CREATE SCHEMA extensions AUTHORIZATION morrow_work_owner;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
CREATE EXTENSION pg_trgm WITH SCHEMA extensions VERSION '1.6';
GRANT USAGE ON SCHEMA extensions TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- Pure functions: IMMUTABLE, owned by the owner; the command role holds EXECUTE because CHECK
-- constraints and index expressions run with the writer's privileges (the 0015 pattern).
-- One subject a derived row came from or is shown in (ADR-0041 item 25): a project (its goal),
-- a task or a conversation, by id.
CREATE FUNCTION morrow_work.memory_subject_valid(s jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN s IS NULL OR jsonb_typeof(s)<>'object' THEN false ELSE
  s ?& ARRAY['kind','id'] AND (s-ARRAY['kind','id'])='{}'::jsonb
  AND jsonb_typeof(s->'kind')='string' AND (s->>'kind') IN ('goal','task','conversation')
  AND jsonb_typeof(s->'id')='string' AND (s->>'id') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' END
$$;
-- A row's source subjects: at most 32, distinct, in canonical order (kind, then id).
CREATE FUNCTION morrow_work.memory_subjects_valid(s jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT CASE WHEN s IS NULL OR jsonb_typeof(s)<>'array' OR jsonb_array_length(s)>32 THEN false ELSE
  NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s) e WHERE NOT morrow_work.memory_subject_valid(e))
  AND s=(SELECT COALESCE(jsonb_agg(DISTINCT e ORDER BY e),'[]'::jsonb) FROM jsonb_array_elements(s) e) END
$$;
-- The audience of a derived row (ADR-0041 item 25): the workspace, one subject, or one
-- principal (a private Ask's owner).
CREATE FUNCTION morrow_work.memory_audience_valid(a jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT CASE WHEN a IS NULL OR jsonb_typeof(a)<>'object' OR jsonb_typeof(a->'kind')<>'string' THEN false
  WHEN a->>'kind'='workspace' THEN a='{"kind":"workspace"}'::jsonb
  WHEN a->>'kind'='subject' THEN (a-'subject')='{"kind":"subject"}'::jsonb AND morrow_work.memory_subject_valid(a->'subject')
  WHEN a->>'kind'='principal' THEN (a-'principalId')='{"kind":"principal"}'::jsonb AND jsonb_typeof(a->'principalId')='string'
   AND (a->>'principalId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ELSE false END
$$;
-- One untrusted source a row's taint names (ModelUntrustedSource, with ADR-0041 item 34's and
-- ADR-0040's additions), with its id when it has one.
CREATE FUNCTION morrow_work.memory_taint_source_valid(s jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN s IS NULL OR jsonb_typeof(s)<>'object' THEN false ELSE
  s ?& ARRAY['source','sourceId'] AND (s-ARRAY['source','sourceId'])='{}'::jsonb
  AND jsonb_typeof(s->'source')='string' AND (s->>'source') IN ('product','inventory','order_summary','support_mail',
   'knowledge_page','artifact','report','upload','sandbox_output','tool_result','message','teammate_result','result_item',
   'notebook_entry','conversation_summary','person_memory','context_checkpoint','thread_post','other_member')
  AND (s->'sourceId'='null'::jsonb OR (jsonb_typeof(s->'sourceId')='string'
   AND (s->>'sourceId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')) END
$$;
-- A row's taint (ADR-0041 item 34: kept whole, never truncated): its kinds in canonical order,
-- up to 256 sources inline and a count of the rest. No kind exactly when nothing is named.
CREATE FUNCTION morrow_work.memory_taint_valid(t jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT CASE WHEN t IS NULL OR jsonb_typeof(t)<>'object' OR NOT (t ?& ARRAY['kinds','sources','omitted'])
  OR (t-ARRAY['kinds','sources','omitted'])<>'{}'::jsonb OR jsonb_typeof(t->'kinds')<>'array'
  OR jsonb_typeof(t->'sources')<>'array' OR jsonb_typeof(t->'omitted')<>'number' THEN false ELSE
  (t->>'omitted') ~ '^(0|[1-9][0-9]{0,9})$' AND (t->>'omitted')::bigint<=2147483647
  AND jsonb_array_length(t->'kinds')<=2 AND jsonb_array_length(t->'sources')<=256
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t->'kinds') k WHERE jsonb_typeof(k)<>'string'
   OR (k#>>'{}') NOT IN ('other_member','untrusted_external'))
  AND t->'kinds'=(SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k),'[]'::jsonb) FROM jsonb_array_elements(t->'kinds') k)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t->'sources') s WHERE NOT morrow_work.memory_taint_source_valid(s))
  AND (SELECT count(DISTINCT s) FROM jsonb_array_elements(t->'sources') s)=jsonb_array_length(t->'sources')
  AND ((jsonb_array_length(t->'kinds')=0)=(jsonb_array_length(t->'sources')=0 AND (t->>'omitted')='0')) END
$$;
-- The union of two taints: every kind; the sources distinct in canonical order, 256 inline and
-- the rest counted. Taint is sticky: a union never drops a kind.
CREATE FUNCTION morrow_work.memory_taint_union(a jsonb,b jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 WITH s AS (SELECT DISTINCT e FROM jsonb_array_elements(COALESCE(a->'sources','[]'::jsonb)||COALESCE(b->'sources','[]'::jsonb)) e),
 r AS (SELECT e,row_number() OVER (ORDER BY e->>'source' COLLATE "C",e->>'sourceId' COLLATE "C" NULLS FIRST) AS n FROM s)
 SELECT jsonb_build_object(
  'kinds',(SELECT COALESCE(jsonb_agg(DISTINCT k ORDER BY k),'[]'::jsonb)
   FROM jsonb_array_elements(COALESCE(a->'kinds','[]'::jsonb)||COALESCE(b->'kinds','[]'::jsonb)) k),
  'sources',(SELECT COALESCE(jsonb_agg(r.e ORDER BY r.n),'[]'::jsonb) FROM r WHERE r.n<=256),
  'omitted',least(2147483647,COALESCE((a->>'omitted')::bigint,0)+COALESCE((b->>'omitted')::bigint,0)
   +(SELECT count(*) FROM r WHERE r.n>256)))
$$;
-- The union of two subject lists, canonical; NULL past 32.
CREATE FUNCTION morrow_work.memory_subjects_union(a jsonb,b jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN count(DISTINCT e)>32 THEN NULL ELSE COALESCE(jsonb_agg(DISTINCT e ORDER BY e),'[]'::jsonb) END
 FROM jsonb_array_elements(COALESCE(a,'[]'::jsonb)||COALESCE(b,'[]'::jsonb)) e
$$;
-- The narrower of two audiences, or NULL when no one audience covers both (two different
-- subjects, or two different people). A subject and a person give the person: the derived row
-- keeps the subject among its source subjects, so its reader must still see it.
CREATE FUNCTION morrow_work.memory_audience_narrow(a jsonb,b jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN a IS NULL OR b IS NULL THEN NULL WHEN a->>'kind'='workspace' THEN b WHEN b->>'kind'='workspace' THEN a
  WHEN a=b THEN a WHEN a->>'kind'='subject' AND b->>'kind'='principal' THEN b
  WHEN a->>'kind'='principal' AND b->>'kind'='subject' THEN a ELSE NULL END
$$;
-- Whether a reader whose output goes to `reader` may read a row shown to `row_audience`
-- (ADR-0041 item 25): workspace rows to anyone; a subject's rows to that subject's work or to a
-- person's private work (the row's source subjects, which hold that subject, are checked
-- too); a person's rows only to that same person's private work, so private-Ask content never
-- reaches project, mandate or other people's runs.
CREATE FUNCTION morrow_work.memory_audience_readable(row_audience jsonb,reader jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE row_audience->>'kind' WHEN 'workspace' THEN true
  WHEN 'subject' THEN reader=row_audience OR reader->>'kind'='principal'
  WHEN 'principal' THEN reader=row_audience ELSE false END
$$;
-- A reader's subject view, decided in code under live grants: every subject of the kinds it
-- may view, and the named subjects it may view besides (at most 256).
CREATE FUNCTION morrow_work.memory_subject_scope_valid(s jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT CASE WHEN s IS NULL OR jsonb_typeof(s)<>'object' OR NOT (s ?& ARRAY['kinds','ids']) OR (s-ARRAY['kinds','ids'])<>'{}'::jsonb
  OR jsonb_typeof(s->'kinds')<>'array' OR jsonb_typeof(s->'ids')<>'array' THEN false ELSE
  jsonb_array_length(s->'kinds')<=3 AND jsonb_array_length(s->'ids')<=256
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'kinds') k WHERE jsonb_typeof(k)<>'string'
   OR (k#>>'{}') NOT IN ('goal','task','conversation'))
  AND (SELECT count(DISTINCT k) FROM jsonb_array_elements(s->'kinds') k)=jsonb_array_length(s->'kinds')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'ids') e WHERE NOT morrow_work.memory_subject_valid(e)) END
$$;
-- Every source subject within the reader's subject view.
CREATE FUNCTION morrow_work.memory_subjects_viewable(subjects jsonb,scope jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(subjects) s
  WHERE NOT ((scope->'kinds') @> jsonb_build_array(s->'kind') OR (scope->'ids') @> jsonb_build_array(s)))
$$;
-- The read tags a reader may view, decided in code under live grants: at most 256 distinct
-- {storeId, capability} (ReadTag@1's shape).
CREATE FUNCTION morrow_work.memory_viewable_tags_valid(t jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN t IS NULL OR jsonb_typeof(t)<>'array' OR jsonb_array_length(t)>256 THEN false ELSE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(t) e WHERE NOT (CASE WHEN jsonb_typeof(e)<>'object' THEN false ELSE
   e ?& ARRAY['storeId','capability'] AND (e-ARRAY['storeId','capability'])='{}'::jsonb
   AND jsonb_typeof(e->'capability')='string' AND (e->>'capability') IN ('catalog.products.read','inventory.levels.read',
    'orders.read','support.case.read','workspace.knowledge.read','workspace.artifact.read')
   AND (e->'storeId'='null'::jsonb OR (jsonb_typeof(e->'storeId')='string'
    AND (e->>'storeId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')) END))
  AND (SELECT count(DISTINCT e) FROM jsonb_array_elements(t) e)=jsonb_array_length(t) END
$$;
-- One reference to a memory row a derived row came from: a notebook entry or a knowledge page.
-- Later layers widen this list in their own forward migrations.
CREATE FUNCTION morrow_work.memory_ref_valid(r jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN r IS NULL OR jsonb_typeof(r)<>'object' THEN false ELSE
  r ?& ARRAY['kind','id'] AND (r-ARRAY['kind','id'])='{}'::jsonb
  AND jsonb_typeof(r->'kind')='string' AND (r->>'kind') IN ('notebook_entry','knowledge_page')
  AND jsonb_typeof(r->'id')='string' AND (r->>'id') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' END
$$;
-- A row's derived_from: at most p_max distinct references, in canonical order.
CREATE FUNCTION morrow_work.memory_refs_valid(r jsonb,p_max integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT CASE WHEN r IS NULL OR jsonb_typeof(r)<>'array' OR jsonb_array_length(r)>p_max THEN false ELSE
  NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r) e WHERE NOT morrow_work.memory_ref_valid(e))
  AND r=(SELECT COALESCE(jsonb_agg(DISTINCT e ORDER BY e),'[]'::jsonb) FROM jsonb_array_elements(r) e) END
$$;
-- A notebook entry's content digest: sha256 over the jsonb text of its kind, title and text.
CREATE FUNCTION morrow_work.memory_entry_digest(p_kind text,p_title text,p_text text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT morrow_work.sha256_text(jsonb_build_object('kind',p_kind,'title',p_title,'text',p_text)::text)
$$;
-- The two index expressions of a row's text (never revised: a change needs a new function and a
-- rebuilt index). Both are NULL once the text is erased, so erasing the text erases the index.
CREATE FUNCTION morrow_work.memory_document(p_title text,p_text text) RETURNS tsvector
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p_text IS NULL THEN NULL ELSE
  setweight(to_tsvector('simple'::regconfig,COALESCE(p_title,'')),'A')||setweight(to_tsvector('simple'::regconfig,p_text),'B') END
$$;
CREATE FUNCTION morrow_work.memory_trigram_text(p_title text,p_text text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p_text IS NULL THEN NULL ELSE COALESCE(p_title,'')||E'\n'||p_text END
$$;
REVOKE ALL ON FUNCTION morrow_work.memory_subject_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_subjects_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_audience_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_taint_source_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_taint_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_taint_union(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_subjects_union(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_audience_narrow(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_audience_readable(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_subject_scope_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_subjects_viewable(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_viewable_tags_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_ref_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_refs_valid(jsonb,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_entry_digest(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_document(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_trigram_text(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.memory_subject_valid(jsonb),morrow_work.memory_subjects_valid(jsonb),
 morrow_work.memory_audience_valid(jsonb),morrow_work.memory_taint_source_valid(jsonb),morrow_work.memory_taint_valid(jsonb),
 morrow_work.memory_taint_union(jsonb,jsonb),morrow_work.memory_subjects_union(jsonb,jsonb),
 morrow_work.memory_audience_narrow(jsonb,jsonb),morrow_work.memory_audience_readable(jsonb,jsonb),
 morrow_work.memory_subject_scope_valid(jsonb),morrow_work.memory_subjects_viewable(jsonb,jsonb),
 morrow_work.memory_viewable_tags_valid(jsonb),morrow_work.memory_ref_valid(jsonb),morrow_work.memory_refs_valid(jsonb,integer),
 morrow_work.memory_entry_digest(text,text,text),morrow_work.memory_document(text,text),morrow_work.memory_trigram_text(text,text)
 TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- Notebooks re-keyed by agent principal (both tables are empty: checked above). A notebook is
-- an agent principal's (a teammate's, or Morrow's own once its runs hold a lease), not an
-- installation's.
ALTER TABLE morrow_work.agent_notebook_entries
 DROP CONSTRAINT agent_notebook_entries_organization_id_workspace_id_instal_fkey,
 DROP CONSTRAINT agent_notebook_entries_pkey,
 DROP CONSTRAINT agent_notebook_entries_erased,
 DROP CONSTRAINT agent_notebook_entries_clock,
 DROP CONSTRAINT agent_notebook_entries_erased_reason_check;
ALTER TABLE morrow_work.agent_notebooks
 DROP CONSTRAINT agent_notebooks_pkey,
 DROP CONSTRAINT agent_notebooks_organization_id_workspace_id_installation__fkey,
 DROP CONSTRAINT agent_notebooks_live_entries_check,
 DROP COLUMN installation_id,
 ADD COLUMN agent_principal_id morrow_work.record_id NOT NULL;
ALTER TABLE morrow_work.agent_notebooks
 ADD PRIMARY KEY (organization_id,workspace_id,agent_principal_id),
 ADD FOREIGN KEY (organization_id,workspace_id,agent_principal_id)
  REFERENCES morrow_identity.agent_principals(organization_id,workspace_id,principal_id),
 -- A safety range (ADR-0041 "Values"): consolidation tends the notebook long before it.
 ADD CONSTRAINT agent_notebooks_live_entries_check CHECK (live_entries BETWEEN 0 AND 1000);
ALTER TABLE morrow_work.agent_notebook_entries
 DROP COLUMN installation_id,
 ADD COLUMN agent_principal_id morrow_work.record_id NOT NULL,
 ADD COLUMN kind text NOT NULL CHECK (kind IN ('lesson','correction','procedure','shop_fact','open_question')),
 ADD COLUMN title text CHECK (char_length(title) BETWEEN 1 AND 120 AND title ~ '\S'),
 ADD COLUMN taint jsonb NOT NULL CHECK (morrow_work.memory_taint_valid(taint)),
 ADD COLUMN derived_from jsonb NOT NULL CHECK (morrow_work.memory_refs_valid(derived_from,64)),
 ADD COLUMN audience jsonb NOT NULL CHECK (morrow_work.memory_audience_valid(audience)),
 ADD COLUMN source_subjects jsonb NOT NULL CHECK (morrow_work.memory_subjects_valid(source_subjects)),
 ADD COLUMN requester_principal_id morrow_work.record_id NOT NULL,
 ADD COLUMN requester_membership_id morrow_work.record_id NOT NULL,
 ADD COLUMN renewed_at timestamptz NOT NULL CHECK (renewed_at=date_trunc('milliseconds',renewed_at) AND isfinite(renewed_at)),
 ADD COLUMN renewals integer NOT NULL CHECK (renewals BETWEEN 0 AND 1000000),
 ADD COLUMN use_count bigint NOT NULL CHECK (use_count BETWEEN 0 AND 9007199254740991),
 ADD COLUMN last_used_at timestamptz CHECK (last_used_at=date_trunc('milliseconds',last_used_at) AND isfinite(last_used_at)),
 ADD COLUMN renewed_run_id morrow_work.record_id,
 ADD COLUMN renewed_tool_use_id text CHECK (renewed_tool_use_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 ADD COLUMN erased_run_id morrow_work.record_id,
 ADD COLUMN erased_tool_use_id text CHECK (erased_tool_use_id ~ '^[A-Za-z0-9_-]{1,64}$');
ALTER TABLE morrow_work.agent_notebook_entries
 ADD PRIMARY KEY (organization_id,workspace_id,agent_principal_id,sequence),
 ADD FOREIGN KEY (organization_id,workspace_id,agent_principal_id)
  REFERENCES morrow_work.agent_notebooks(organization_id,workspace_id,agent_principal_id),
 ADD FOREIGN KEY (organization_id,requester_membership_id,requester_principal_id)
  REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 ADD FOREIGN KEY (workspace_id,requester_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 -- ADR-0041 item 27's clock: 90 days after the last write or re-affirmation. A renewal names
 -- the tool call that made it (its replay returns it instead of renewing again).
 ADD CONSTRAINT agent_notebook_entries_clock CHECK (expires_at=renewed_at+interval '90 days' AND renewed_at>=created_at
  AND (last_used_at IS NULL OR last_used_at>=created_at) AND (use_count=0)=(last_used_at IS NULL)
  AND (renewed_run_id IS NULL)=(renewed_tool_use_id IS NULL) AND (renewed_run_id IS NULL OR renewals>0)),
 -- A live entry has its text and the digest of it; an erased one keeps ids, digests and times.
 ADD CONSTRAINT agent_notebook_entries_erased CHECK ((erased_at IS NULL)=(body IS NOT NULL) AND (erased_at IS NULL)=(title IS NOT NULL)
  AND (erased_at IS NULL)=(erased_reason IS NULL)
  AND (erased_at IS NOT NULL OR digest::text=morrow_work.memory_entry_digest(kind,title,body))
  AND (erased_run_id IS NULL)=(erased_tool_use_id IS NULL) AND (erased_run_id IS NULL OR erased_reason='retired')),
 ADD CONSTRAINT agent_notebook_entries_erased_reason_check
  CHECK (erased_reason IN ('superseded','cleared','retired','source_erased','expired')),
 -- Never private-Ask content (ADR-0041 item 33: notebook.write is refused in an Ask), and a
 -- subject audience is always among the source subjects its reader must see.
 ADD CONSTRAINT agent_notebook_entries_audience CHECK (audience->>'kind'<>'principal'
  AND (audience->>'kind'<>'subject' OR source_subjects @> jsonb_build_array(audience->'subject'))),
 -- An entry never derives from itself.
 ADD CONSTRAINT agent_notebook_entries_lineage
  CHECK (NOT derived_from @> jsonb_build_array(jsonb_build_object('kind','notebook_entry','id',id::text)));
CREATE INDEX agent_notebook_entries_live ON morrow_work.agent_notebook_entries (organization_id,workspace_id,agent_principal_id,sequence)
 WHERE erased_at IS NULL;
CREATE INDEX agent_notebook_entries_renewal ON morrow_work.agent_notebook_entries
 (organization_id,workspace_id,agent_principal_id,renewed_at,sequence) WHERE erased_at IS NULL;
CREATE INDEX agent_notebook_entries_expiry ON morrow_work.agent_notebook_entries (expires_at) WHERE erased_at IS NULL;
-- A tool call's replay finds what it did: the entry it wrote (0052's unique run and tool_use
-- key), the entry it renewed, or the one entry it retired.
CREATE INDEX agent_notebook_entries_renewed_call ON morrow_work.agent_notebook_entries
 (organization_id,workspace_id,renewed_run_id,renewed_tool_use_id) WHERE renewed_run_id IS NOT NULL;
CREATE UNIQUE INDEX agent_notebook_entries_erased_call ON morrow_work.agent_notebook_entries
 (organization_id,workspace_id,erased_run_id,erased_tool_use_id) WHERE erased_run_id IS NOT NULL;
CREATE INDEX agent_notebook_entries_document ON morrow_work.agent_notebook_entries
 USING gin (morrow_work.memory_document(title,body)) WHERE erased_at IS NULL;
CREATE INDEX agent_notebook_entries_trigram ON morrow_work.agent_notebook_entries
 USING gin (morrow_work.memory_trigram_text(title,body) extensions.gin_trgm_ops) WHERE erased_at IS NULL;
-- Shop knowledge's trigram half: each live version's text (the full-text half is 0052's
-- knowledge_search_entries). Deleting a page erases every version's text, and with it this.
CREATE INDEX knowledge_versions_trigram ON morrow_work.knowledge_versions
 USING gin (morrow_work.memory_trigram_text(title,body) extensions.gin_trgm_ops) WHERE erased_at IS NULL;

-- ---------------------------------------------------------------------------
-- New tables.
-- The lineage of derived memory: one row per (derived row, source). Content-free. Written in the
-- transaction that writes the derived row; read by the deletion path and the view rebase.
-- Removed only with its derived row, by the owner's sweep.
CREATE TABLE morrow_work.memory_derivations (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 derived_kind text NOT NULL CHECK (derived_kind IN ('notebook_entry')),
 derived_id morrow_work.record_id NOT NULL,
 source_kind text NOT NULL CHECK (source_kind IN ('notebook_entry','knowledge_page')),
 source_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 PRIMARY KEY (organization_id,workspace_id,derived_kind,derived_id,source_kind,source_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CONSTRAINT memory_derivations_not_self CHECK (NOT (derived_kind=source_kind AND derived_id=source_id))
);
CREATE INDEX memory_derivations_source ON morrow_work.memory_derivations (organization_id,workspace_id,source_kind,source_id);
-- Flags on memory to look at again. Content-free: ids, codes and times. Open until a person or
-- an upkeep run resolves or dismisses it; then kept 365 days.
CREATE TABLE morrow_work.memory_repairs (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 target_kind text NOT NULL CHECK (target_kind IN ('notebook_entry')),
 target_id morrow_work.record_id NOT NULL,
 agent_principal_id morrow_work.record_id NOT NULL,
 reason text NOT NULL CHECK (reason IN ('source_erased','source_changed','tainted_flag')),
 source_kind text NOT NULL CHECK (source_kind IN ('notebook_entry','knowledge_page','run')),
 source_id morrow_work.record_id NOT NULL,
 run_id morrow_work.record_id,
 tool_use_id text CHECK (tool_use_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 status text NOT NULL CHECK (status IN ('open','resolved','dismissed')),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 resolved_at timestamptz CHECK (resolved_at=date_trunc('milliseconds',resolved_at) AND resolved_at>=created_at),
 expires_at timestamptz,
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,agent_principal_id)
  REFERENCES morrow_identity.agent_principals(organization_id,workspace_id,principal_id),
 CONSTRAINT memory_repairs_resolution CHECK ((status='open')=(resolved_at IS NULL) AND (status='open')=(expires_at IS NULL)
  AND (expires_at IS NULL OR expires_at=resolved_at+interval '365 days')),
 -- A tainted run's flag names that run and its tool call; nothing else names a run.
 CONSTRAINT memory_repairs_run CHECK ((reason='tainted_flag')=(run_id IS NOT NULL) AND (run_id IS NULL)=(tool_use_id IS NULL)
  AND (reason<>'tainted_flag' OR (source_kind='run' AND source_id=run_id)) AND (reason='tainted_flag' OR source_kind<>'run'))
);
-- One open flag per target, reason and source, except a tainted run's: each of its tool calls
-- keeps its own flag (its replay finds it), one per call.
CREATE UNIQUE INDEX memory_repairs_one_open ON morrow_work.memory_repairs
 (organization_id,workspace_id,target_kind,target_id,reason,source_kind,source_id) WHERE status='open' AND reason<>'tainted_flag';
CREATE UNIQUE INDEX memory_repairs_tool_call ON morrow_work.memory_repairs (organization_id,workspace_id,run_id,tool_use_id)
 WHERE run_id IS NOT NULL;
CREATE INDEX memory_repairs_agent_open ON morrow_work.memory_repairs (organization_id,workspace_id,agent_principal_id,created_at)
 WHERE status='open';
-- A person's memory settings (ADR-0041 item 29): personal memory on or off, and the scope a new
-- memory gets ("only in my private chats" by default). Codes only. Written first by H12b.
CREATE TABLE morrow_work.memory_settings (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 principal_id morrow_work.record_id NOT NULL,
 membership_id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 personal_memory text NOT NULL CHECK (personal_memory IN ('on','off')),
 default_scope text NOT NULL CHECK (default_scope IN ('private_chats','everywhere')),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND updated_at>=created_at),
 PRIMARY KEY (organization_id,workspace_id,principal_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,membership_id,principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id)
);

-- ---------------------------------------------------------------------------
-- Row security for the new tables, on 0052's template: ENABLE + FORCE, the owner's maintenance
-- policy, the session template (tenant_command), the api's tenant_read for the readable ones,
-- and the lease twin (tenant_lease) for the runtime definers.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['memory_derivations','memory_repairs','memory_settings'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('CREATE POLICY tenant_lease ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
  EXECUTE format('GRANT SELECT,INSERT ON morrow_work.%I TO morrow_work_command',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['memory_repairs','memory_settings'] LOOP
  EXECUTE format('CREATE POLICY tenant_read ON morrow_work.%I FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
END $$;
-- The command role's column updates (0052's grants on the re-keyed tables stay; the dropped
-- installation_id took its own column grants with it).
GRANT UPDATE (title,use_count,last_used_at,renewed_at,renewals,renewed_run_id,renewed_tool_use_id,expires_at,erased_run_id,
 erased_tool_use_id) ON morrow_work.agent_notebook_entries TO morrow_work_command;
GRANT UPDATE (status,resolved_at,expires_at) ON morrow_work.memory_repairs TO morrow_work_command;
GRANT UPDATE (revision,personal_memory,default_scope,updated_at) ON morrow_work.memory_settings TO morrow_work_command;
-- The api role reads column by column; the work API decides every row per viewer (read tags,
-- source subjects and audience) in code before anything leaves the server.
GRANT SELECT (agent_principal_id) ON morrow_work.agent_notebooks TO morrow_work_api;
GRANT SELECT (agent_principal_id,kind,title,taint,derived_from,audience,source_subjects,requester_principal_id,requester_membership_id,
 renewed_at,renewals,use_count,last_used_at,erased_run_id,erased_tool_use_id) ON morrow_work.agent_notebook_entries TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,target_kind,target_id,agent_principal_id,reason,source_kind,source_id,run_id,tool_use_id,
 status,created_at,resolved_at,expires_at) ON morrow_work.memory_repairs TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,principal_id,membership_id,revision,personal_memory,default_scope,created_at,updated_at)
 ON morrow_work.memory_settings TO morrow_work_api;

-- ---------------------------------------------------------------------------
-- Triggers: INVOKER, owned by the owner, granted to nobody.
-- Entries: born live, unused and unrenewed. Afterwards the only changes are a use (the count
-- and its time move forward), a renewal (its time moves forward with the count and the clock)
-- or the one erasure (title and text gone, the reason and, for a retire, the run that did it).
-- Revised in place from 0052 (the re-keyed columns; agent_notebook_guard's rule is unchanged).
CREATE OR REPLACE FUNCTION morrow_work.agent_notebook_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['title','body','erased_at','erased_reason','erased_run_id','erased_tool_use_id','use_count',
 'last_used_at','renewed_at','renewals','renewed_run_id','renewed_tool_use_id','expires_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.erased_at IS NOT NULL OR NEW.renewals<>0 OR NEW.renewed_run_id IS NOT NULL OR NEW.use_count<>0
   OR NEW.last_used_at IS NOT NULL OR NEW.renewed_at<>NEW.created_at THEN
   RAISE EXCEPTION 'AGENT_NOTEBOOK_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.erased_at IS NOT NULL
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  -- Counts and clocks only move forward.
  OR NEW.use_count<OLD.use_count OR NEW.renewals<OLD.renewals OR NEW.renewed_at<OLD.renewed_at
  OR (OLD.last_used_at IS NOT NULL AND (NEW.last_used_at IS NULL OR NEW.last_used_at<OLD.last_used_at))
  -- A renewal moves its count and time together and names its call; a use moves the count, and
  -- its time (within the same millisecond, the count alone).
  OR (NEW.renewals<>OLD.renewals)<>(NEW.renewed_at<>OLD.renewed_at)
  OR (NEW.renewals=OLD.renewals AND (NEW.renewed_run_id IS DISTINCT FROM OLD.renewed_run_id
   OR NEW.renewed_tool_use_id IS DISTINCT FROM OLD.renewed_tool_use_id))
  OR (NEW.use_count=OLD.use_count AND NEW.last_used_at IS DISTINCT FROM OLD.last_used_at)
  -- Live text never changes; the one erasure takes no use or renewal with it.
  OR (NEW.erased_at IS NULL AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title))
  OR (NEW.erased_at IS NOT NULL AND (NEW.use_count<>OLD.use_count OR NEW.renewals<>OLD.renewals
   OR NEW.last_used_at IS DISTINCT FROM OLD.last_used_at)) THEN
  RAISE EXCEPTION 'AGENT_NOTEBOOK_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Repairs: born open; the one change is its resolution.
CREATE FUNCTION morrow_work.memory_repair_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'open' THEN RAISE EXCEPTION 'MEMORY_REPAIR_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'open' OR NEW.status='open'
  OR (to_jsonb(NEW)-ARRAY['status','resolved_at','expires_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','resolved_at','expires_at']) THEN
  RAISE EXCEPTION 'MEMORY_REPAIR_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Settings: born at revision 1; afterwards revision+1 with the two settings and the time.
CREATE FUNCTION morrow_work.memory_settings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'MEMORY_SETTINGS_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-ARRAY['revision','personal_memory','default_scope','updated_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','personal_memory','default_scope','updated_at']) THEN
  RAISE EXCEPTION 'MEMORY_SETTINGS_INVALID';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_work.memory_repair_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_settings_guard() FROM PUBLIC;
CREATE TRIGGER memory_repair_guard BEFORE INSERT OR UPDATE ON morrow_work.memory_repairs FOR EACH ROW EXECUTE FUNCTION morrow_work.memory_repair_guard();
CREATE TRIGGER memory_settings_guard BEFORE INSERT OR UPDATE ON morrow_work.memory_settings FOR EACH ROW EXECUTE FUNCTION morrow_work.memory_settings_guard();
DO $$ DECLARE t text; BEGIN
 -- Lineage rows never change; no new table is truncated.
 EXECUTE 'CREATE TRIGGER append_only BEFORE UPDATE ON morrow_work.memory_derivations FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()';
 FOREACH t IN ARRAY ARRAY['memory_derivations','memory_repairs','memory_settings'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- The deletion path. Revisable owner helpers: INVOKER, owned by the owner, EXECUTE for the
-- command role only; they run inside the definer, command or trigger that calls them, under
-- its tenant or lease context.
-- Erase every live entry derived from one source (ADR-0031 item 3, as ADR-0041 items 14 and 25
-- amend it: "deletion follows the source"), in the caller's transaction: the text goes, the
-- notebook's count and revision move, and a content-free repair records why. An erased entry is
-- itself a source: memory_entry_follow carries the erasure on through its own derived entries.
CREATE FUNCTION morrow_work.memory_erase_derived(p_org text,p_ws text,p_source_kind text,p_source_id text,p_at timestamptz)
RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_erased integer:=0; r record;
BEGIN
 FOR r IN
  WITH e AS (
   UPDATE morrow_work.agent_notebook_entries x SET title=NULL,body=NULL,erased_at=greatest(p_at,x.renewed_at),erased_reason='source_erased'
   FROM morrow_work.memory_derivations d
   WHERE d.organization_id=p_org AND d.workspace_id=p_ws AND d.source_kind=p_source_kind AND d.source_id=p_source_id
    AND d.derived_kind='notebook_entry' AND x.organization_id=d.organization_id AND x.workspace_id=d.workspace_id
    AND x.id=d.derived_id AND x.erased_at IS NULL
   RETURNING x.agent_principal_id::text AS agent,x.id::text AS id)
  SELECT e.agent,array_agg(e.id ORDER BY e.id) AS ids,count(*)::integer AS n FROM e GROUP BY e.agent ORDER BY e.agent
 LOOP
  UPDATE morrow_work.agent_notebooks y SET live_entries=y.live_entries-r.n,revision=y.revision+1,updated_at=greatest(p_at,y.updated_at)
   WHERE y.organization_id=p_org AND y.workspace_id=p_ws AND y.agent_principal_id=r.agent;
  INSERT INTO morrow_work.memory_repairs(organization_id,workspace_id,id,target_kind,target_id,agent_principal_id,reason,source_kind,
   source_id,run_id,tool_use_id,status,created_at,resolved_at,expires_at)
  SELECT p_org,p_ws,gen_random_uuid()::text,'notebook_entry',i,r.agent,'source_erased',p_source_kind,p_source_id,NULL,NULL,'open',p_at,NULL,NULL
   FROM unnest(r.ids) i
  ON CONFLICT DO NOTHING;
  v_erased:=v_erased+r.n;
 END LOOP;
 RETURN v_erased;
END $$;
-- Flag every live entry derived from a knowledge page that just took a new version (stale, not
-- erased: ADR-0041 item 28 flags, never expires). Idempotent while the flag is open.
CREATE FUNCTION morrow_work.memory_flag_changed(p_org text,p_ws text,p_source_kind text,p_source_id text,p_at timestamptz)
RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_flagged integer;
BEGIN
 INSERT INTO morrow_work.memory_repairs(organization_id,workspace_id,id,target_kind,target_id,agent_principal_id,reason,source_kind,
  source_id,run_id,tool_use_id,status,created_at,resolved_at,expires_at)
 SELECT p_org,p_ws,gen_random_uuid()::text,'notebook_entry',x.id,x.agent_principal_id,'source_changed',p_source_kind,p_source_id,
  NULL,NULL,'open',p_at,NULL,NULL
  FROM morrow_work.memory_derivations d JOIN morrow_work.agent_notebook_entries x ON x.organization_id=d.organization_id
   AND x.workspace_id=d.workspace_id AND x.id=d.derived_id AND x.erased_at IS NULL
  WHERE d.organization_id=p_org AND d.workspace_id=p_ws AND d.source_kind=p_source_kind AND d.source_id=p_source_id
   AND d.derived_kind='notebook_entry'
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS v_flagged=ROW_COUNT;
 RETURN v_flagged;
END $$;
-- The 90-day clock's handler (ADR-0031 item 1, ADR-0041 item 27), for the daily sweep under
-- its maintenance lease: erase up to p_limit live entries of one workspace past their clock.
-- An expiry erases only its own text; entries derived from it keep their own clocks.
CREATE FUNCTION morrow_work.memory_erase_expired(p_org text,p_ws text,p_at timestamptz,p_limit integer)
RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_erased integer:=0; r record;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 OR p_at IS NULL THEN RAISE EXCEPTION 'MEMORY_SWEEP_INVALID'; END IF;
 FOR r IN
  WITH due AS (SELECT x.agent_principal_id,x.sequence FROM morrow_work.agent_notebook_entries x
    WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.erased_at IS NULL AND x.expires_at<=p_at
    ORDER BY x.expires_at,x.agent_principal_id,x.sequence LIMIT p_limit FOR UPDATE),
  e AS (UPDATE morrow_work.agent_notebook_entries x SET title=NULL,body=NULL,erased_at=greatest(p_at,x.renewed_at),erased_reason='expired'
    FROM due WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.agent_principal_id=due.agent_principal_id
     AND x.sequence=due.sequence
    RETURNING x.agent_principal_id::text AS agent)
  SELECT e.agent,count(*)::integer AS n FROM e GROUP BY e.agent ORDER BY e.agent
 LOOP
  UPDATE morrow_work.agent_notebooks y SET live_entries=y.live_entries-r.n,revision=y.revision+1,updated_at=greatest(p_at,y.updated_at)
   WHERE y.organization_id=p_org AND y.workspace_id=p_ws AND y.agent_principal_id=r.agent;
  v_erased:=v_erased+r.n;
 END LOOP;
 RETURN v_erased;
END $$;
-- The taint a knowledge page's current version carries: untrusted when it was accepted from a
-- proposal made by a tainted run (ADR-0041 item 28: such a page taints its readers).
CREATE FUNCTION morrow_work.memory_knowledge_taint(p_org text,p_ws text,p_page_id text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM morrow_work.knowledge_pages p
   JOIN morrow_work.knowledge_versions v ON v.organization_id=p.organization_id AND v.workspace_id=p.workspace_id
    AND v.page_id=p.id AND v.version=p.current_version
   JOIN morrow_work.knowledge_proposals q ON q.organization_id=v.organization_id AND q.workspace_id=v.workspace_id AND q.id=v.proposal_id
   WHERE p.organization_id=p_org AND p.workspace_id=p_ws AND p.id=p_page_id AND q.context_taint='untrusted_external')
  THEN jsonb_build_object('kinds','["untrusted_external"]'::jsonb,'sources',
   jsonb_build_array(jsonb_build_object('source','knowledge_page','sourceId',p_page_id)),'omitted',0)
  ELSE '{"kinds":[],"sources":[],"omitted":0}'::jsonb END
$$;
-- Text a notebook never keeps (ADR-0041 item 27: identifier patterns refused): an email address
-- or a Shopify customer id. H9a's customer identifier screen, in code, runs first; this is the
-- definer's backstop and is revised with that screen.
CREATE FUNCTION morrow_work.memory_text_refused(p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_text ~* '[A-Z0-9._%+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}' OR p_text ~* 'gid://shopify/Customer/'
$$;
REVOKE ALL ON FUNCTION morrow_work.memory_erase_derived(text,text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_flag_changed(text,text,text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_erase_expired(text,text,timestamptz,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_knowledge_taint(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_text_refused(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.memory_erase_derived(text,text,text,text,timestamptz),
 morrow_work.memory_flag_changed(text,text,text,text,timestamptz),morrow_work.memory_erase_expired(text,text,timestamptz,integer),
 morrow_work.memory_knowledge_taint(text,text,text),morrow_work.memory_text_refused(text) TO morrow_work_command;
-- The source-following triggers (INVOKER, owned by the owner, granted to nobody). They fire in
-- whatever command erases the source, so every erasure path follows it: a page deleted by a
-- person today, by shop/redact or workspace erasure later.
CREATE FUNCTION morrow_work.memory_page_follow() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
  PERFORM morrow_work.memory_erase_derived(NEW.organization_id,NEW.workspace_id,'knowledge_page',NEW.id,NEW.deleted_at);
 ELSIF NEW.current_version<>OLD.current_version THEN
  PERFORM morrow_work.memory_flag_changed(NEW.organization_id,NEW.workspace_id,'knowledge_page',NEW.id,NEW.updated_at);
 END IF;
 RETURN NULL;
END $$;
-- A person's erasure of an entry ('cleared') or its source's ('source_erased') carries on to
-- the entries derived from it. A supersede, retire or expiry erases only the entry itself
-- (a consolidation's output outlives the inputs it retires).
CREATE FUNCTION morrow_work.memory_entry_follow() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 PERFORM morrow_work.memory_erase_derived(NEW.organization_id,NEW.workspace_id,'notebook_entry',NEW.id,NEW.erased_at);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION morrow_work.memory_page_follow() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.memory_entry_follow() FROM PUBLIC;
CREATE TRIGGER memory_page_follow AFTER UPDATE ON morrow_work.knowledge_pages FOR EACH ROW
 WHEN ((NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) OR NEW.current_version<>OLD.current_version)
 EXECUTE FUNCTION morrow_work.memory_page_follow();
CREATE TRIGGER memory_entry_follow AFTER UPDATE ON morrow_work.agent_notebook_entries FOR EACH ROW
 WHEN (OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL AND NEW.erased_reason IN ('cleared','source_erased'))
 EXECUTE FUNCTION morrow_work.memory_entry_follow();

-- ---------------------------------------------------------------------------
-- The ranked search (ADR-0041 item 30), a revisable owner helper the search definer calls:
-- each layer's rows that pass its predicates (the owning agent's own notebook, live and
-- unexpired; read tags within the reader's viewable set; every source subject within its
-- subject view; the audience readable by its output's audience) are filtered first, then every
-- query is matched by both signals (full text over the `simple` document, trigram word
-- similarity over the text), each signal ranks its own matches, and reciprocal rank fusion
-- (k = 60) adds small trust, recency and use priors. Ties break by layer and id.
CREATE FUNCTION morrow_work.memory_search_ranked(p_org text,p_ws text,p_agent text,p_queries text[],p_layers text[],p_tags jsonb,
 p_scope jsonb,p_audience jsonb,p_limit integer,p_at timestamptz)
RETURNS TABLE(layer text,item_id text,version text,kind text,title text,snippet text,trust text,requester_principal_id text,
 read_tags text,taint text,score text)
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_work,pg_temp SET pg_trgm.word_similarity_threshold='0.5' AS $$
 WITH q AS (SELECT t.n::integer AS qn,t.text,websearch_to_tsquery('simple'::regconfig,t.text) AS tsq
   FROM unnest(p_queries) WITH ORDINALITY AS t(text,n)),
 nb AS MATERIALIZED (
  SELECT e.id::text AS id,e.kind,e.title,e.body,e.read_tags,e.taint,e.renewed_at,e.use_count,e.requester_principal_id::text AS requester
   FROM morrow_work.agent_notebook_entries e
   WHERE 'notebook'=ANY(p_layers) AND e.organization_id=p_org AND e.workspace_id=p_ws AND e.agent_principal_id=p_agent
    AND e.erased_at IS NULL AND e.expires_at>p_at AND e.read_tags<@p_tags
    AND morrow_work.memory_subjects_viewable(e.source_subjects,p_scope)
    AND morrow_work.memory_audience_readable(e.audience,p_audience)),
 kn AS MATERIALIZED (
  SELECT p.id::text AS id,p.kind,p.current_version,v.title,v.body,p.read_tags,s.document,p.updated_at
   FROM morrow_work.knowledge_pages p
   JOIN morrow_work.knowledge_versions v ON v.organization_id=p.organization_id AND v.workspace_id=p.workspace_id AND v.page_id=p.id
    AND v.version=p.current_version AND v.erased_at IS NULL
   JOIN morrow_work.knowledge_search_entries s ON s.organization_id=p.organization_id AND s.workspace_id=p.workspace_id
    AND s.page_id=p.id AND s.erased_at IS NULL
   WHERE 'knowledge'=ANY(p_layers) AND p.organization_id=p_org AND p.workspace_id=p_ws AND p.deleted_at IS NULL
    AND p.read_tags<@p_tags),
 hits AS (
  SELECT 'notebook'::text AS layer,nb.id,q.qn,'text'::text AS sig,ts_rank_cd(morrow_work.memory_document(nb.title,nb.body),q.tsq)::float8 AS r
   FROM nb,q WHERE morrow_work.memory_document(nb.title,nb.body)@@q.tsq
  UNION ALL
  SELECT 'notebook',nb.id,q.qn,'trigram',extensions.word_similarity(q.text,morrow_work.memory_trigram_text(nb.title,nb.body))::float8
   FROM nb,q WHERE q.text OPERATOR(extensions.<%) morrow_work.memory_trigram_text(nb.title,nb.body)
  UNION ALL
  SELECT 'knowledge',kn.id,q.qn,'text',ts_rank_cd(kn.document,q.tsq)::float8 FROM kn,q WHERE kn.document@@q.tsq
  UNION ALL
  SELECT 'knowledge',kn.id,q.qn,'trigram',extensions.word_similarity(q.text,morrow_work.memory_trigram_text(kn.title,kn.body))::float8
   FROM kn,q WHERE q.text OPERATOR(extensions.<%) morrow_work.memory_trigram_text(kn.title,kn.body)),
 ranked AS (SELECT h.layer,h.id,row_number() OVER (PARTITION BY h.qn,h.sig ORDER BY h.r DESC,h.layer,h.id COLLATE "C") AS rk FROM hits h),
 fused AS (SELECT r.layer,r.id,sum(1.0/(60+r.rk))::float8 AS rrf FROM ranked r WHERE r.rk<=100 GROUP BY r.layer,r.id),
 scored AS (
  SELECT f.layer,f.id,NULL::text AS version,nb.kind,nb.title,left(nb.body,280) AS snippet,'agent_lesson'::text AS trust,
   nb.requester,nb.read_tags,nb.taint,
   f.rrf
    +CASE WHEN jsonb_array_length(nb.taint->'kinds')=0 THEN 0.002 ELSE 0 END
    +0.002*exp(-greatest(0,extract(epoch FROM p_at-nb.renewed_at))/7776000.0)
    +0.002*least(1.0,ln(1+nb.use_count)/ln(101.0)) AS score
   FROM fused f JOIN nb ON f.layer='notebook' AND nb.id=f.id
  UNION ALL
  SELECT f.layer,f.id,kn.current_version::text,kn.kind,kn.title,left(kn.body,280),'approved_knowledge',NULL,kn.read_tags,
   morrow_work.memory_knowledge_taint(p_org,p_ws,kn.id),
   f.rrf+0.004+0.002*exp(-greatest(0,extract(epoch FROM p_at-kn.updated_at))/7776000.0)
   FROM fused f JOIN kn ON f.layer='knowledge' AND kn.id=f.id)
 SELECT x.layer,x.id,x.version,x.kind,x.title,x.snippet,x.trust,x.requester,x.read_tags::text,x.taint::text,
  to_char(x.score,'FM0.000000000')
 FROM scored x ORDER BY x.score DESC,x.layer,x.id COLLATE "C" LIMIT p_limit
$$;
REVOKE ALL ON FUNCTION morrow_work.memory_search_ranked(text,text,text,text[],text[],jsonb,jsonb,jsonb,integer,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.memory_search_ranked(text,text,text,text[],text[],jsonb,jsonb,jsonb,integer,timestamptz)
 TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- Runtime functions: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_runtime_executor only. Ids only from the entered lease (current_lease(): a run lease of
-- an active installation, whose agent principal owns the notebook); the loop's tool-call step
-- decided authority, the run's read tags, taint, audience and source subjects and the reader's
-- view in code first (ADR-0027 item 2; ADR-0031 item 6). A model never sets any of them.
-- The run lease's agent: its installation, active, and that installation's agent principal.
CREATE FUNCTION morrow_work.memory_lease_agent() RETURNS TABLE(organization_id text,workspace_id text,run_id text,
 store_id text,installation_id text,agent_principal_id text,requester_principal_id text,requester_membership_id text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' OR l.installation_id IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT l.organization_id,l.workspace_id,l.subject_id,l.store_id,l.installation_id,i.agent_principal_id::text,
  l.initiator_principal_id,l.initiator_membership_id
  FROM morrow_work.agent_installations i WHERE i.organization_id=l.organization_id AND i.workspace_id=l.workspace_id
   AND i.id=l.installation_id AND i.status='active';
END $$;
REVOKE ALL ON FUNCTION morrow_work.memory_lease_agent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.memory_lease_agent() TO morrow_work_command;

-- notebook.write's server-side command (workspace.notebook.write; ADR-0041 items 24 and 27), in
-- the lease's own agent's notebook, idempotent per run and tool_use id (a replay returns what
-- the call did: the entry it wrote or renewed, its retire, or its flag):
--   * add: one new entry (an identical live entry with the same scope is renewed instead);
--   * replace: a new entry derived from the target, and the target retired;
--   * retire: the target retired.
-- A run that read customer data, loaded person memory or works for a private Ask is refused;
-- identifier patterns are refused. The target and every source must pass the same predicates
-- as a read by this run (its viewable tags, its subject view and its output's audience), so a
-- write names only memory the run could have read. Every entry carries the union of the run's
-- and its sources' taint, read tags (with the store's artifact tag) and source subjects, the
-- narrowest of their audiences, and its sources' knowledge pages as its own (lineage is closed
-- over pages, so deleting a page erases every live entry that came from it however indirectly).
-- A tainted run never retires an untainted entry: it flags it instead ('flagged'; a replace
-- still adds its new, tainted entry). The 1,001st live entry supersedes the least recently
-- renewed. Lock order: the knowledge pages named, directly or through a source's lineage
-- (FOR SHARE, in id order), then the notebook: the order a page deletion takes.
CREATE FUNCTION morrow_work.run_notebook_write_v2(p_tool_use_id text,p_op text,p_target_id text,p_kind text,p_title text,p_text text,
 p_read_tags text,p_taint text,p_audience text,p_source_subjects text,p_derived_from text,p_viewable_tags text,p_subject_scope text,
 p_person_memory_loaded text)
RETURNS TABLE(outcome text,entry_id text,sequence text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 a record; n record; x record; t record; r jsonb; v_page text; v_pages text[]; v_missing boolean:=false; v_target_clean boolean:=false;
 v_tags jsonb; v_taint jsonb; v_audience jsonb; v_subjects jsonb; v_refs jsonb; v_view jsonb; v_scope jsonb; v_at timestamptz;
 v_id text; v_seq integer; v_live integer; v_digest text; v_tainted boolean; v_flagged boolean:=false; v_superseded integer;
 v_notes text[]; v_direct text[];
BEGIN
 IF p_tool_use_id IS NULL OR p_tool_use_id !~ '^[A-Za-z0-9_-]{1,64}$'
  OR p_op IS NULL OR p_op NOT IN ('add','replace','retire')
  OR (p_op='add')<>(p_target_id IS NULL)
  OR (p_target_id IS NOT NULL AND p_target_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
  OR (p_op='retire')<>(p_kind IS NULL) OR (p_op='retire')<>(p_title IS NULL) OR (p_op='retire')<>(p_text IS NULL)
  OR (p_op<>'retire' AND (p_kind NOT IN ('lesson','correction','procedure','shop_fact','open_question')
   OR char_length(p_title) NOT BETWEEN 1 AND 120 OR p_title !~ '\S'
   OR char_length(p_text) NOT BETWEEN 1 AND 2000 OR p_text !~ '\S'))
  OR p_read_tags IS NULL OR octet_length(p_read_tags)>8192 OR p_taint IS NULL OR octet_length(p_taint)>65536
  OR p_audience IS NULL OR octet_length(p_audience)>1024 OR p_source_subjects IS NULL OR octet_length(p_source_subjects)>8192
  OR p_derived_from IS NULL OR octet_length(p_derived_from)>16384
  OR p_viewable_tags IS NULL OR octet_length(p_viewable_tags)>65536 OR p_subject_scope IS NULL OR octet_length(p_subject_scope)>65536
  OR p_person_memory_loaded IS NULL OR p_person_memory_loaded NOT IN ('true','false') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 BEGIN
  v_tags:=p_read_tags::jsonb; v_taint:=p_taint::jsonb; v_audience:=p_audience::jsonb;
  v_subjects:=p_source_subjects::jsonb; v_refs:=p_derived_from::jsonb; v_view:=p_viewable_tags::jsonb; v_scope:=p_subject_scope::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END;
 IF jsonb_typeof(v_tags)<>'array' OR jsonb_typeof(v_subjects)<>'array' OR jsonb_typeof(v_refs)<>'array'
  OR NOT morrow_work.memory_taint_valid(v_taint) OR NOT morrow_work.memory_audience_valid(v_audience)
  OR NOT morrow_work.memory_viewable_tags_valid(v_view) OR NOT morrow_work.memory_subject_scope_valid(v_scope) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 -- Canonical forms (distinct, in order) before the closed checks: the caller need not sort.
 v_taint:=morrow_work.memory_taint_union(v_taint,'{"kinds":[],"sources":[],"omitted":0}'::jsonb);
 v_subjects:=morrow_work.memory_subjects_union(v_subjects,'[]'::jsonb);
 v_refs:=(SELECT COALESCE(jsonb_agg(DISTINCT e ORDER BY e),'[]'::jsonb) FROM jsonb_array_elements(v_refs) e);
 IF v_subjects IS NULL OR NOT morrow_work.memory_subjects_valid(v_subjects) OR NOT morrow_work.memory_refs_valid(v_refs,64) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 -- What a notebook never takes (ADR-0041 items 27 and 33).
 IF v_tags @> '[{"capability":"support.case.read"}]'::jsonb THEN
  RETURN QUERY SELECT 'customer_data'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF jsonb_array_length(v_tags)>0 AND NOT morrow_work.knowledge_tags_valid(v_tags) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_person_memory_loaded='true' THEN RETURN QUERY SELECT 'person_memory_loaded'::text,NULL::text,NULL::text; RETURN; END IF;
 IF v_audience->>'kind'='principal' THEN RETURN QUERY SELECT 'ask_bound'::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_op<>'retire' AND morrow_work.memory_text_refused(p_title||E'\n'||p_text) THEN
  RETURN QUERY SELECT 'customer_data'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO a FROM morrow_work.memory_lease_agent();
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM morrow_work.current_lease() l WHERE l.kind='run' AND l.installation_id IS NOT NULL) THEN
   RETURN QUERY SELECT 'stopped'::text,NULL::text,NULL::text; RETURN;
  END IF;
  RETURN QUERY SELECT 'lease_ended'::text,NULL::text,NULL::text; RETURN;
 END IF;
 PERFORM 1 FROM morrow_work.agent_installations i WHERE i.organization_id=a.organization_id AND i.workspace_id=a.workspace_id
  AND i.id=a.installation_id AND i.status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'stopped'::text,NULL::text,NULL::text; RETURN; END IF;
 -- The notebook entries this call names (its sources and its target), and every knowledge page
 -- they come from: the pages named directly and those in the entries' lineage (immutable on an
 -- entry, so this unlocked read names the same pages the locked one below finds).
 v_notes:=ARRAY(SELECT DISTINCT e->>'id' FROM jsonb_array_elements(v_refs||CASE WHEN p_target_id IS NULL THEN '[]'::jsonb
   ELSE jsonb_build_array(jsonb_build_object('kind','notebook_entry','id',p_target_id)) END) e
  WHERE e->>'kind'='notebook_entry' ORDER BY 1);
 v_direct:=ARRAY(SELECT DISTINCT e->>'id' FROM jsonb_array_elements(v_refs) e WHERE e->>'kind'='knowledge_page' ORDER BY 1);
 v_pages:=ARRAY(SELECT DISTINCT q.id FROM (
   SELECT e->>'id' AS id FROM jsonb_array_elements(v_refs) e WHERE e->>'kind'='knowledge_page'
   UNION ALL
   SELECT d->>'id' FROM morrow_work.agent_notebook_entries y CROSS JOIN LATERAL jsonb_array_elements(y.derived_from) d
    WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.agent_principal_id=a.agent_principal_id
     AND y.id=ANY(v_notes) AND d->>'kind'='knowledge_page') q ORDER BY 1);
 -- Knowledge pages first, under a share lock until commit, so a page deleted under this write
 -- either waits for it and then erases the new entry with the page, or is refused here. A page
 -- named directly must be one this run may view; a page in a source's lineage need only be live
 -- (its tags are already the source's).
 FOREACH v_page IN ARRAY v_pages LOOP
  PERFORM 1 FROM morrow_work.knowledge_pages p WHERE p.organization_id=a.organization_id AND p.workspace_id=a.workspace_id
   AND p.id=v_page AND p.deleted_at IS NULL AND (NOT v_page=ANY(v_direct) OR p.read_tags<@v_view) FOR SHARE;
  IF NOT FOUND THEN v_missing:=true; END IF;
 END LOOP;
 v_at:=morrow_work.db_now();
 INSERT INTO morrow_work.agent_notebooks(organization_id,workspace_id,agent_principal_id,revision,next_sequence,live_entries,created_at,updated_at)
 VALUES (a.organization_id,a.workspace_id,a.agent_principal_id,1,1,0,v_at,v_at) ON CONFLICT DO NOTHING;
 SELECT y.revision::bigint AS revision,y.next_sequence,y.live_entries INTO n FROM morrow_work.agent_notebooks y
  WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.agent_principal_id=a.agent_principal_id FOR UPDATE;
 -- Replays (ADR-0027 item 2: an internal write returns its first record), before any check
 -- that depends on state the first call may itself have changed.
 v_digest:=CASE WHEN p_op='retire' THEN NULL ELSE morrow_work.memory_entry_digest(p_kind,p_title,p_text) END;
 SELECT y.id::text AS id,y.sequence::text AS sequence,y.digest::text AS digest INTO x FROM morrow_work.agent_notebook_entries y
  WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.run_id=a.run_id AND y.tool_use_id=p_tool_use_id;
 IF FOUND THEN
  IF x.digest=v_digest AND (p_op<>'add')=EXISTS(SELECT 1 FROM morrow_work.agent_notebook_entries z
    WHERE z.organization_id=a.organization_id AND z.workspace_id=a.workspace_id AND z.id=x.id
     AND z.derived_from @> jsonb_build_array(jsonb_build_object('kind','notebook_entry','id',COALESCE(p_target_id,'')))) THEN
   RETURN QUERY SELECT CASE WHEN EXISTS(SELECT 1 FROM morrow_work.memory_repairs y WHERE y.organization_id=a.organization_id
     AND y.workspace_id=a.workspace_id AND y.run_id=a.run_id AND y.tool_use_id=p_tool_use_id) THEN 'replay_flagged' ELSE 'replay' END,
    x.id,x.sequence;
   RETURN;
  END IF;
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT y.id::text AS id,y.sequence::text AS sequence,y.digest::text AS digest INTO x FROM morrow_work.agent_notebook_entries y
  WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.renewed_run_id=a.run_id
   AND y.renewed_tool_use_id=p_tool_use_id;
 IF FOUND THEN
  IF p_op='add' AND x.digest=v_digest THEN RETURN QUERY SELECT 'replay_renewed'::text,x.id,x.sequence; RETURN; END IF;
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM morrow_work.agent_notebook_entries y WHERE y.organization_id=a.organization_id
   AND y.workspace_id=a.workspace_id AND y.erased_run_id=a.run_id AND y.erased_tool_use_id=p_tool_use_id) THEN
  -- (A replace's retire is found with its new entry above.)
  IF p_op='retire' AND EXISTS(SELECT 1 FROM morrow_work.agent_notebook_entries y WHERE y.organization_id=a.organization_id
    AND y.workspace_id=a.workspace_id AND y.erased_run_id=a.run_id AND y.erased_tool_use_id=p_tool_use_id AND y.id=p_target_id) THEN
   RETURN QUERY SELECT 'replay'::text,NULL::text,NULL::text; RETURN;
  END IF;
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM morrow_work.memory_repairs y WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id
   AND y.run_id=a.run_id AND y.tool_use_id=p_tool_use_id) THEN
  IF p_op='retire' AND EXISTS(SELECT 1 FROM morrow_work.memory_repairs y WHERE y.organization_id=a.organization_id
    AND y.workspace_id=a.workspace_id AND y.run_id=a.run_id AND y.tool_use_id=p_tool_use_id AND y.target_id=p_target_id) THEN
   RETURN QUERY SELECT 'replay_flagged'::text,NULL::text,NULL::text; RETURN;
  END IF;
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF v_missing THEN RETURN QUERY SELECT 'id_out_of_scope'::text,NULL::text,NULL::text; RETURN; END IF;
 -- The target of a replace or retire: a live entry of this agent's own notebook that this run
 -- could read.
 IF p_op<>'add' THEN
  SELECT y.id::text AS id,y.sequence,y.taint INTO t FROM morrow_work.agent_notebook_entries y
   WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.agent_principal_id=a.agent_principal_id
    AND y.id=p_target_id AND y.erased_at IS NULL AND y.expires_at>v_at AND y.read_tags<@v_view
    AND morrow_work.memory_subjects_viewable(y.source_subjects,v_scope) AND morrow_work.memory_audience_readable(y.audience,v_audience);
  IF NOT FOUND THEN RETURN QUERY SELECT 'id_out_of_scope'::text,NULL::text,NULL::text; RETURN; END IF;
  v_target_clean:=jsonb_array_length(t.taint->'kinds')=0;
  v_refs:=(SELECT jsonb_agg(DISTINCT e ORDER BY e) FROM jsonb_array_elements(v_refs||jsonb_build_array(
   jsonb_build_object('kind','notebook_entry','id',p_target_id))) e);
 END IF;
 -- Lineage (ADR-0041 items 25 and 27): the union of taint, read tags and source subjects, and the
 -- narrowest audience, over the run and every source it names, each of which this run could
 -- read; a source entry's own pages join the new entry's.
 v_tags:=morrow_work.knowledge_tags_union(jsonb_build_array(jsonb_build_object('storeId',a.store_id,'capability','workspace.artifact.read')),v_tags);
 FOR r IN SELECT e FROM jsonb_array_elements(v_refs) e LOOP
  IF r->>'kind'='notebook_entry' THEN
   SELECT y.taint,y.read_tags,y.audience,y.source_subjects,y.derived_from INTO x FROM morrow_work.agent_notebook_entries y
    WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.agent_principal_id=a.agent_principal_id
     AND y.id=r->>'id' AND y.erased_at IS NULL AND y.expires_at>v_at AND y.read_tags<@v_view
     AND morrow_work.memory_subjects_viewable(y.source_subjects,v_scope) AND morrow_work.memory_audience_readable(y.audience,v_audience);
   IF NOT FOUND THEN RETURN QUERY SELECT 'id_out_of_scope'::text,NULL::text,NULL::text; RETURN; END IF;
   v_taint:=morrow_work.memory_taint_union(v_taint,x.taint);
   v_tags:=morrow_work.knowledge_tags_union(v_tags,x.read_tags);
   v_subjects:=morrow_work.memory_subjects_union(v_subjects,x.source_subjects);
   v_audience:=morrow_work.memory_audience_narrow(v_audience,x.audience);
   v_refs:=(SELECT jsonb_agg(DISTINCT e ORDER BY e) FROM jsonb_array_elements(v_refs||COALESCE((SELECT jsonb_agg(d)
    FROM jsonb_array_elements(x.derived_from) d WHERE d->>'kind'='knowledge_page'),'[]'::jsonb)) e);
  ELSE
   SELECT p.read_tags INTO x FROM morrow_work.knowledge_pages p WHERE p.organization_id=a.organization_id
    AND p.workspace_id=a.workspace_id AND p.id=r->>'id' AND p.deleted_at IS NULL AND p.read_tags<@v_view;
   IF NOT FOUND THEN RETURN QUERY SELECT 'id_out_of_scope'::text,NULL::text,NULL::text; RETURN; END IF;
   v_taint:=morrow_work.memory_taint_union(v_taint,morrow_work.memory_knowledge_taint(a.organization_id,a.workspace_id,r->>'id'));
   v_tags:=morrow_work.knowledge_tags_union(v_tags,x.read_tags);
  END IF;
  IF v_subjects IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN; END IF;
  IF v_audience IS NULL THEN RETURN QUERY SELECT 'audience_conflict'::text,NULL::text,NULL::text; RETURN; END IF;
 END LOOP;
 -- Every page in the closed lineage was locked above (lineage is immutable; a defect otherwise).
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_refs) e WHERE e->>'kind'='knowledge_page' AND NOT (e->>'id')=ANY(v_pages)) THEN
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF NOT morrow_work.memory_refs_valid(v_refs,64) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN; END IF;
 IF v_audience->>'kind'='principal' THEN RETURN QUERY SELECT 'ask_bound'::text,NULL::text,NULL::text; RETURN; END IF;
 IF v_audience->>'kind'='subject' THEN
  v_subjects:=morrow_work.memory_subjects_union(v_subjects,jsonb_build_array(v_audience->'subject'));
  IF v_subjects IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN; END IF;
 END IF;
 IF NOT morrow_work.knowledge_tags_valid(v_tags) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN; END IF;
 v_tainted:=jsonb_array_length(v_taint->'kinds')>0;
 -- A tainted run never retires an untainted entry; it may only flag it (ADR-0041 item 27).
 IF p_op<>'add' AND v_tainted AND v_target_clean THEN
  INSERT INTO morrow_work.memory_repairs(organization_id,workspace_id,id,target_kind,target_id,agent_principal_id,reason,source_kind,
   source_id,run_id,tool_use_id,status,created_at,resolved_at,expires_at)
  VALUES (a.organization_id,a.workspace_id,gen_random_uuid()::text,'notebook_entry',p_target_id,a.agent_principal_id,'tainted_flag','run',
   a.run_id,a.run_id,p_tool_use_id,'open',v_at,NULL,NULL);
  v_flagged:=true;
  IF p_op='retire' THEN RETURN QUERY SELECT 'flagged'::text,NULL::text,NULL::text; RETURN; END IF;
  -- A flagged replace still adds its entry, derived from the target, which stays live.
 ELSIF p_op<>'add' THEN
  UPDATE morrow_work.agent_notebook_entries y SET title=NULL,body=NULL,erased_at=greatest(v_at,y.renewed_at),erased_reason='retired',
   erased_run_id=a.run_id,erased_tool_use_id=p_tool_use_id
   WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.agent_principal_id=a.agent_principal_id
    AND y.id=p_target_id AND y.erased_at IS NULL;
  n.live_entries:=n.live_entries-1;
  IF p_op='retire' THEN
   UPDATE morrow_work.agent_notebooks y SET live_entries=n.live_entries,revision=y.revision+1,updated_at=greatest(v_at,y.updated_at)
    WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.agent_principal_id=a.agent_principal_id;
   RETURN QUERY SELECT 'applied'::text,NULL::text,NULL::text; RETURN;
  END IF;
 END IF;
 -- An identical live entry with the same scope and lineage is re-affirmed, not duplicated; a
 -- tainted run never re-affirms an untainted entry.
 IF p_op='add' THEN
  SELECT y.id::text AS id,y.sequence::text AS sequence INTO x FROM morrow_work.agent_notebook_entries y
   WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.agent_principal_id=a.agent_principal_id
    AND y.erased_at IS NULL AND y.expires_at>v_at AND y.digest=v_digest AND y.audience=v_audience AND y.source_subjects=v_subjects
    AND y.derived_from=v_refs AND y.read_tags=v_tags AND (NOT v_tainted OR jsonb_array_length(y.taint->'kinds')>0)
   ORDER BY y.sequence LIMIT 1;
  IF FOUND THEN
   UPDATE morrow_work.agent_notebook_entries y SET renewed_at=greatest(v_at,y.renewed_at+interval '1 millisecond'),
    renewals=y.renewals+1,expires_at=greatest(v_at,y.renewed_at+interval '1 millisecond')+interval '90 days',
    renewed_run_id=a.run_id,renewed_tool_use_id=p_tool_use_id
    WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.id=x.id;
   UPDATE morrow_work.agent_notebooks y SET revision=y.revision+1,updated_at=greatest(v_at,y.updated_at)
    WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.agent_principal_id=a.agent_principal_id;
   RETURN QUERY SELECT 'renewed'::text,x.id,x.sequence; RETURN;
  END IF;
 END IF;
 IF n.next_sequence>1000000 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN; END IF;
 v_seq:=n.next_sequence; v_id:=gen_random_uuid()::text; v_live:=n.live_entries;
 IF v_live>=1000 THEN
  UPDATE morrow_work.agent_notebook_entries y SET title=NULL,body=NULL,erased_at=greatest(v_at,y.renewed_at),erased_reason='superseded'
   WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.agent_principal_id=a.agent_principal_id
    AND y.sequence=(SELECT z.sequence FROM morrow_work.agent_notebook_entries z WHERE z.organization_id=a.organization_id
     AND z.workspace_id=a.workspace_id AND z.agent_principal_id=a.agent_principal_id AND z.erased_at IS NULL
     ORDER BY z.renewed_at,z.sequence LIMIT 1);
  GET DIAGNOSTICS v_superseded=ROW_COUNT;
  v_live:=v_live-v_superseded;
 END IF;
 INSERT INTO morrow_work.agent_notebook_entries(organization_id,workspace_id,agent_principal_id,sequence,id,kind,title,body,read_tags,
  taint,derived_from,audience,source_subjects,requester_principal_id,requester_membership_id,run_id,tool_use_id,digest,created_at,
  renewed_at,renewals,renewed_run_id,renewed_tool_use_id,use_count,last_used_at,expires_at,erased_at,erased_reason,erased_run_id,
  erased_tool_use_id)
 VALUES (a.organization_id,a.workspace_id,a.agent_principal_id,v_seq,v_id,p_kind,p_title,p_text,v_tags,v_taint,v_refs,v_audience,
  v_subjects,a.requester_principal_id,a.requester_membership_id,a.run_id,p_tool_use_id,v_digest,v_at,v_at,0,NULL,NULL,0,NULL,
  v_at+interval '90 days',NULL,NULL,NULL,NULL);
 INSERT INTO morrow_work.memory_derivations(organization_id,workspace_id,derived_kind,derived_id,source_kind,source_id,created_at)
 SELECT a.organization_id,a.workspace_id,'notebook_entry',v_id,e->>'kind',e->>'id',v_at FROM jsonb_array_elements(v_refs) e;
 UPDATE morrow_work.agent_notebooks y SET next_sequence=v_seq+1,live_entries=v_live+1,revision=y.revision+1,updated_at=greatest(v_at,y.updated_at)
  WHERE y.organization_id=a.organization_id AND y.workspace_id=a.workspace_id AND y.agent_principal_id=a.agent_principal_id;
 RETURN QUERY SELECT CASE WHEN v_flagged THEN 'flagged' ELSE 'applied' END,v_id,v_seq::text;
END $$;

-- memory.search's candidates (ADR-0041 items 24 and 30): up to five queries at once over the
-- layers the loop allows, ranked, at most 20, each with its read tags and taint (the loop joins
-- them to the run's before the model sees a snippet). Every predicate applies before ranking.
CREATE FUNCTION morrow_work.run_memory_search(p_queries text,p_layers text,p_viewable_tags text,p_subject_scope text,p_audience text,
 p_limit text)
RETURNS TABLE(layer text,item_id text,version text,kind text,title text,snippet text,trust text,requester_principal_id text,
 read_tags text,taint text,score text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE a record; v_queries jsonb; v_layers jsonb; v_tags jsonb; v_scope jsonb; v_audience jsonb;
BEGIN
 IF p_queries IS NULL OR octet_length(p_queries)>8192 OR p_layers IS NULL OR octet_length(p_layers)>256
  OR p_viewable_tags IS NULL OR octet_length(p_viewable_tags)>65536 OR p_subject_scope IS NULL OR octet_length(p_subject_scope)>65536
  OR p_audience IS NULL OR octet_length(p_audience)>1024 OR p_limit IS NULL OR p_limit !~ '^[1-9][0-9]?$' OR p_limit::integer>20 THEN
  RETURN;
 END IF;
 BEGIN
  v_queries:=p_queries::jsonb; v_layers:=p_layers::jsonb; v_tags:=p_viewable_tags::jsonb; v_scope:=p_subject_scope::jsonb;
  v_audience:=p_audience::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN;
 END;
 IF jsonb_typeof(v_queries)<>'array' OR jsonb_array_length(v_queries) NOT BETWEEN 1 AND 5
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_queries) e WHERE jsonb_typeof(e)<>'string' OR char_length(e#>>'{}') NOT BETWEEN 1 AND 200
   OR (e#>>'{}') !~ '\S')
  OR jsonb_typeof(v_layers)<>'array' OR jsonb_array_length(v_layers) NOT BETWEEN 1 AND 2
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_layers) e WHERE jsonb_typeof(e)<>'string' OR (e#>>'{}') NOT IN ('knowledge','notebook'))
  OR (SELECT count(DISTINCT e) FROM jsonb_array_elements(v_layers) e)<>jsonb_array_length(v_layers)
  OR NOT morrow_work.memory_viewable_tags_valid(v_tags) OR NOT morrow_work.memory_subject_scope_valid(v_scope)
  OR NOT morrow_work.memory_audience_valid(v_audience) THEN
  RETURN;
 END IF;
 SELECT * INTO a FROM morrow_work.memory_lease_agent();
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT * FROM morrow_work.memory_search_ranked(a.organization_id,a.workspace_id,a.agent_principal_id,
  ARRAY(SELECT e#>>'{}' FROM jsonb_array_elements(v_queries) WITH ORDINALITY AS q(e,n) ORDER BY q.n),
  ARRAY(SELECT e#>>'{}' FROM jsonb_array_elements(v_layers) e),v_tags,v_scope,v_audience,p_limit::integer,morrow_work.db_now());
END $$;

-- memory.read's opening of one item (ADR-0041 items 14 and 24) under the same predicates as the
-- search, in full, with its taint, read tags, lineage and requester; no row when it does not
-- pass. An untainted run's read of an untainted entry counts as a use (ADR-0041 item 27: reads
-- by tainted runs do not raise use counts).
CREATE FUNCTION morrow_work.run_memory_read(p_layer text,p_item_id text,p_viewable_tags text,p_subject_scope text,p_audience text,
 p_reader_tainted text)
RETURNS TABLE(layer text,item_id text,version text,kind text,title text,body text,trust text,requester_principal_id text,
 read_tags text,taint text,source_subjects text,derived_from text,created_at text,renewed_at text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE a record; x record; v_tags jsonb; v_scope jsonb; v_audience jsonb; v_at timestamptz;
BEGIN
 IF p_layer IS NULL OR p_layer NOT IN ('knowledge','notebook') OR p_item_id IS NULL OR p_item_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_viewable_tags IS NULL OR octet_length(p_viewable_tags)>65536 OR p_subject_scope IS NULL OR octet_length(p_subject_scope)>65536
  OR p_audience IS NULL OR octet_length(p_audience)>1024 OR p_reader_tainted IS NULL OR p_reader_tainted NOT IN ('true','false') THEN
  RETURN;
 END IF;
 BEGIN v_tags:=p_viewable_tags::jsonb; v_scope:=p_subject_scope::jsonb; v_audience:=p_audience::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN;
 END;
 IF NOT morrow_work.memory_viewable_tags_valid(v_tags) OR NOT morrow_work.memory_subject_scope_valid(v_scope)
  OR NOT morrow_work.memory_audience_valid(v_audience) THEN
  RETURN;
 END IF;
 SELECT * INTO a FROM morrow_work.memory_lease_agent();
 IF NOT FOUND THEN RETURN; END IF;
 v_at:=morrow_work.db_now();
 IF p_layer='notebook' THEN
  SELECT e.id::text AS id,e.sequence,e.kind,e.title,e.body,e.requester_principal_id::text AS requester,e.read_tags,e.taint,
   e.source_subjects,e.derived_from,e.created_at,e.renewed_at INTO x
   FROM morrow_work.agent_notebook_entries e
   WHERE e.organization_id=a.organization_id AND e.workspace_id=a.workspace_id AND e.agent_principal_id=a.agent_principal_id
    AND e.id=p_item_id AND e.erased_at IS NULL AND e.expires_at>v_at AND e.read_tags<@v_tags
    AND morrow_work.memory_subjects_viewable(e.source_subjects,v_scope) AND morrow_work.memory_audience_readable(e.audience,v_audience);
  IF NOT FOUND THEN RETURN; END IF;
  IF p_reader_tainted='false' AND jsonb_array_length(x.taint->'kinds')=0 THEN
   UPDATE morrow_work.agent_notebook_entries e SET use_count=e.use_count+1,last_used_at=greatest(v_at,e.created_at,
    COALESCE(e.last_used_at,e.created_at))
    WHERE e.organization_id=a.organization_id AND e.workspace_id=a.workspace_id AND e.agent_principal_id=a.agent_principal_id
     AND e.sequence=x.sequence AND e.erased_at IS NULL;
  END IF;
  RETURN QUERY SELECT 'notebook'::text,x.id,NULL::text,x.kind,x.title,x.body,'agent_lesson'::text,x.requester,x.read_tags::text,
   x.taint::text,x.source_subjects::text,x.derived_from::text,morrow_work.utc_text(x.created_at),morrow_work.utc_text(x.renewed_at);
  RETURN;
 END IF;
 SELECT p.id::text AS id,p.kind,p.current_version,v.title,v.body,p.read_tags,v.created_at INTO x
  FROM morrow_work.knowledge_pages p JOIN morrow_work.knowledge_versions v ON v.organization_id=p.organization_id
   AND v.workspace_id=p.workspace_id AND v.page_id=p.id AND v.version=p.current_version AND v.erased_at IS NULL
  WHERE p.organization_id=a.organization_id AND p.workspace_id=a.workspace_id AND p.id=p_item_id AND p.deleted_at IS NULL
   AND p.read_tags<@v_tags;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT 'knowledge'::text,x.id,x.current_version::text,x.kind,x.title,x.body,'approved_knowledge'::text,NULL::text,
  x.read_tags::text,morrow_work.memory_knowledge_taint(a.organization_id,a.workspace_id,x.id)::text,'[]'::text,'[]'::text,
  morrow_work.utc_text(x.created_at),morrow_work.utc_text(x.created_at);
END $$;

-- ---------------------------------------------------------------------------
-- API function: SECURITY DEFINER, owned by the command role after the transfer below, EXECUTE
-- for morrow_work_api only. workspace.notebook.write {administer} (a person; agents never hold
-- administer): erase every live entry of an installation's agent's notebook ('cleared'), at the
-- notebook revision the work API read before it checked that this person may see every live
-- entry (0052's rule, on the re-keyed notebook). Every write, renewal, retire and erasure bumps
-- the revision, so a change after that read is a revision_conflict under this lock, never erased
-- unseen. Entries derived from the cleared ones are erased with them (memory_entry_follow).
CREATE FUNCTION morrow_work.cmd_notebook_clear_v2(p_command_id text,p_request_digest text,p_correlation_id text,p_installation_id text,
 p_expected_revision text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; i record; n record; v_at timestamptz; v_erased integer; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_expected_revision IS NULL OR p_expected_revision !~ '^[1-9][0-9]{0,15}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF p_expected_revision::numeric>9007199254740991 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.agent_principal_id::text AS agent_principal_id INTO i FROM morrow_work.agent_installations x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_installation_id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 SELECT x.revision::bigint AS revision INTO n FROM morrow_work.agent_notebooks x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.agent_principal_id=i.agent_principal_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF n.revision<>p_expected_revision::bigint THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
 v_at:=morrow_work.db_now();
 UPDATE morrow_work.agent_notebook_entries x SET title=NULL,body=NULL,erased_at=greatest(v_at,x.renewed_at),erased_reason='cleared'
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.agent_principal_id=i.agent_principal_id
   AND x.erased_at IS NULL;
 GET DIAGNOSTICS v_erased=ROW_COUNT;
 UPDATE morrow_work.agent_notebooks x SET live_entries=0,revision=x.revision+1,updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.agent_principal_id=i.agent_principal_id;
 v_result:=jsonb_build_object('installationId',p_installation_id,'entriesErased',v_erased);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'notebook.clear',p_installation_id,n.revision+1,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- Explicit ACLs per function (S5 reads proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.run_notebook_write_v2(text,text,text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_memory_search(text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_memory_read(text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_notebook_clear_v2(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.run_notebook_write_v2(text,text,text,text,text,text,text,text,text,text,text,text,text,text),
 morrow_work.run_memory_search(text,text,text,text,text,text),morrow_work.run_memory_read(text,text,text,text,text,text)
 TO morrow_runtime_executor;
GRANT EXECUTE ON FUNCTION morrow_work.cmd_notebook_clear_v2(text,text,text,text,text) TO morrow_work_api;
GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;
ALTER FUNCTION morrow_work.run_notebook_write_v2(text,text,text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_memory_search(text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_memory_read(text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_notebook_clear_v2(text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;
COMMIT;
