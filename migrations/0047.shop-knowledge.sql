BEGIN;
-- PR 20 shop knowledge and notebooks (docs/briefs/shop-knowledge.md; ADR-0031 items 1, 2, 4 and
-- 6; ADR-0024 for who may accept). Executes AS morrow_work_owner, as 0047 after PR 18's 0046
-- (the commands CHECKs it widens are asserted below exactly as 0046 left them, so a revision
-- by any earlier file stops it). Forward only: no published migration is edited. On the
-- ADR-0010 tenant pattern: composite tenant keys, ENABLE and FORCE RLS, definers owned by
-- morrow_work_command, INVOKER triggers and checks owned by the owner. No external effect:
-- nothing here sends a request, reserves money, admits a run or writes to a store.
--   * knowledge_pages: one row per page (brand voice, policy, product fact, supplier,
--     decision), at most one live brand_voice page and 500 live pages per workspace. Its read
--     tags are computed here (knowledge_read_tags: one workspace.knowledge.read tag per linked
--     store, a null store before any is linked, and for a product fact the store's catalogue
--     tag), the union of its versions' tags; the customer tag is refused by CHECK.
--   * knowledge_versions: append-only versions (at most 1,000 per page) of typed text with up
--     to five sources and a content digest. Every version is a person's act: written by them,
--     or an installed agent's proposal they accepted (acceptedBy, the proposal kept by id).
--   * knowledge_proposals: an installed agent's pending addition, written only by the runtime
--     definer run_knowledge_propose under the run's lease (knowledge.propose; it grants
--     nothing). A person accepts it (bound to its digest, and to the page's version when it
--     was made) or rejects it; either decision erases its text, which only a pending
--     proposal keeps. At most 50 pending per workspace.
--   * knowledge_search_entries: one full-text entry per page (its current version), with the
--     page's read tags; the work API filters every hit per viewer in code.
--   * knowledge_deletions: the content-free record of each page deletion (counts and actor).
--   * agent_notebooks and agent_notebook_entries: an installed agent's own notebook, written
--     only by run_notebook_write under that installation's run lease. Each entry carries the
--     run's read tags and is clocked 90 days from its write (ADR-0031 item 1, CHECK); at most
--     100 live entries, the oldest superseded (erased) by the 101st.
--   * The deletion path, before any real content (ADR-0031 item 4; G9): cmd_knowledge_delete
--     erases the page's title, every version's text and sources, its search entry and its
--     pending proposals' text in one transaction and records knowledge_deletions;
--     cmd_notebook_clear erases a notebook. No runtime role holds DELETE (S4): an erased row
--     keeps ids, digests and times only. The retention sweep (the owner, under its maintenance
--     lease) removes expired notebook entries.
--   * Definers: begin_knowledge_command, cmd_knowledge_write, cmd_knowledge_accept,
--     cmd_knowledge_reject, cmd_knowledge_delete and cmd_notebook_clear (the api role, under
--     the P06.T01a prelude, which rechecks authority under lock); run_knowledge_page,
--     run_brand_voice, run_knowledge_search, run_knowledge_propose and run_notebook_write (the
--     runtime executor, under an entered run lease of an active installation). The commands
--     CHECKs are widened by knowledge.write, knowledge.accept, knowledge.reject,
--     knowledge.delete and notebook.clear (aggregates knowledge and notebook), each CHECK the
--     union of every value at this head.
-- The routes answer 503 before any of these definers while docs/decisions/shop-knowledge-
-- staging.json holds the switch off; the agent tools refuse switch_off while agent_tools is off.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regclass('morrow_work.agent_installations') IS NULL OR to_regclass('morrow_work.work_leases') IS NULL
 OR to_regclass('morrow_work.goals') IS NULL OR to_regclass('morrow_work.projects') IS NULL
 OR to_regclass('morrow_work.knowledge_pages') IS NOT NULL
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL OR to_regprocedure('morrow_work.current_lease()') IS NULL
 OR to_regprocedure('morrow_work.command_prelude(text,text)') IS NULL
 OR to_regprocedure('morrow_work.record_command(text,text,text,text,text,text,text,text,bigint,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.db_now()') IS NULL OR to_regprocedure('morrow_work.sha256_text(text)') IS NULL
 OR to_regprocedure('morrow_work.valid_read_tags(jsonb)') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_store_installations(text,text)','EXECUTE')
 -- The shared CHECKs this file widens, exactly as 0046 left them (shared protocol).
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_command_type_check')
  IS DISTINCT FROM '67292353da1a55fcd190be1cdd8eb11c'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_check')
  IS DISTINCT FROM '22384b50c969f6ab3f9ec140734782fc'
 THEN RAISE EXCEPTION 'SHOP_KNOWLEDGE_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pure functions: IMMUTABLE, owned by the owner; the command role holds EXECUTE because
-- CHECK constraints run with the writer's privileges (the 0015 valid_scope pattern).
-- Knowledge read tags (ADR-0031 item 6; ReadTag@1): 1..24 unique {storeId, capability}; a null
-- store only for the two workspace capabilities; never the customer tag.
CREATE FUNCTION morrow_work.knowledge_tags_valid(t jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN t IS NULL OR jsonb_typeof(t)<>'array' OR jsonb_array_length(t) NOT BETWEEN 1 AND 24 THEN false ELSE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(t) e WHERE NOT (CASE WHEN jsonb_typeof(e)<>'object' THEN false ELSE
   e ?& ARRAY['storeId','capability'] AND (e-ARRAY['storeId','capability'])='{}'::jsonb
   AND jsonb_typeof(e->'capability')='string' AND (e->>'capability') IN ('catalog.products.read','inventory.levels.read',
    'orders.read','workspace.knowledge.read','workspace.artifact.read')
   AND CASE WHEN e->'storeId'='null'::jsonb THEN (e->>'capability') IN ('workspace.knowledge.read','workspace.artifact.read')
    ELSE jsonb_typeof(e->'storeId')='string' AND (e->>'storeId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' END END))
  AND (SELECT count(DISTINCT e) FROM jsonb_array_elements(t) e)=jsonb_array_length(t) END
$$;
-- A version's sources (KnowledgeSources@1): 0..5 distinct {kind, value}; a product value is
-- product:<id>, a task value an Id, a note 1..200 characters with a non-space.
CREATE FUNCTION morrow_work.knowledge_sources_valid(s jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN s IS NULL OR jsonb_typeof(s)<>'array' OR jsonb_array_length(s)>5 THEN false ELSE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(s) e WHERE NOT (CASE WHEN jsonb_typeof(e)<>'object' THEN false ELSE
   e ?& ARRAY['kind','value'] AND (e-ARRAY['kind','value'])='{}'::jsonb AND jsonb_typeof(e->'value')='string'
   AND char_length(e->>'value') BETWEEN 1 AND 200 AND (e->>'value') ~ '\S'
   AND CASE e->>'kind' WHEN 'product' THEN (e->>'value') ~ '^product:[1-9][0-9]{0,19}$'
    WHEN 'task' THEN (e->>'value') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    WHEN 'note' THEN true ELSE false END END))
  AND (SELECT count(DISTINCT e) FROM jsonb_array_elements(s) e)=jsonb_array_length(s) END
$$;
-- The content digest of a version or a proposal: sha256 over the jsonb text of its title,
-- text and sources (and, for a proposal, its target), which PostgreSQL renders one way.
CREATE FUNCTION morrow_work.knowledge_content_digest(p_title text,p_text text,p_sources jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT morrow_work.sha256_text(jsonb_build_object('title',p_title,'text',p_text,'sources',p_sources)::text)
$$;
CREATE FUNCTION morrow_work.knowledge_proposal_digest(p_page_id text,p_base_version integer,p_kind text,p_title text,
 p_text text,p_sources jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT morrow_work.sha256_text(jsonb_build_object('pageId',p_page_id,'baseVersion',p_base_version,'kind',p_kind,
  'title',p_title,'text',p_text,'sources',p_sources)::text)
$$;
-- The union of two tag lists, distinct, ordered by store then capability (NULL store first).
CREATE FUNCTION morrow_work.knowledge_tags_union(a jsonb,b jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(e ORDER BY e->>'storeId' NULLS FIRST,e->>'capability'),'[]'::jsonb)
 FROM (SELECT DISTINCT e FROM jsonb_array_elements(COALESCE(a,'[]'::jsonb)||COALESCE(b,'[]'::jsonb)) e) x
$$;
REVOKE ALL ON FUNCTION morrow_work.knowledge_tags_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.knowledge_sources_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.knowledge_content_digest(text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.knowledge_proposal_digest(text,integer,text,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.knowledge_tags_union(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.knowledge_tags_valid(jsonb),morrow_work.knowledge_sources_valid(jsonb),
 morrow_work.knowledge_content_digest(text,text,jsonb),morrow_work.knowledge_proposal_digest(text,integer,text,text,text,jsonb),
 morrow_work.knowledge_tags_union(jsonb,jsonb) TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- Tables.
CREATE TABLE morrow_work.knowledge_pages (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 kind text NOT NULL CHECK (kind IN ('brand_voice','policy','product_fact','supplier','decision')),
 revision morrow_work.revision NOT NULL,
 current_version integer NOT NULL CHECK (current_version BETWEEN 1 AND 1000),
 title text CHECK (char_length(title) BETWEEN 1 AND 120 AND title ~ '\S'),
 read_tags jsonb NOT NULL CHECK (morrow_work.knowledge_tags_valid(read_tags)),
 created_by_principal_id morrow_work.record_id NOT NULL,
 created_by_membership_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND updated_at>=created_at),
 deleted_at timestamptz CHECK (deleted_at=date_trunc('milliseconds',deleted_at) AND deleted_at>=created_at),
 deleted_by_principal_id morrow_work.record_id,
 deleted_by_membership_id morrow_work.record_id,
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,created_by_membership_id,created_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,created_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 FOREIGN KEY (organization_id,deleted_by_membership_id,deleted_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,deleted_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 -- ADR-0031 item 2: customer data never enters shop knowledge.
 CONSTRAINT knowledge_pages_no_customer CHECK (NOT (read_tags @> '[{"capability":"support.case.read"}]'::jsonb)),
 -- A live page has its title; a deleted one names who deleted it and keeps no title.
 CONSTRAINT knowledge_pages_deleted CHECK ((deleted_at IS NULL)=(title IS NOT NULL)
  AND (deleted_at IS NULL)=(deleted_by_principal_id IS NULL) AND (deleted_at IS NULL)=(deleted_by_membership_id IS NULL))
);
-- At most one live brand voice per workspace.
CREATE UNIQUE INDEX knowledge_pages_one_brand_voice ON morrow_work.knowledge_pages (organization_id,workspace_id)
 WHERE kind='brand_voice' AND deleted_at IS NULL;
CREATE INDEX knowledge_pages_live ON morrow_work.knowledge_pages (organization_id,workspace_id,updated_at) WHERE deleted_at IS NULL;
-- An installed agent's pending addition (knowledge.propose). Only a pending proposal keeps
-- its text; a decision (or its page's deletion) erases it and keeps the digest.
CREATE TABLE morrow_work.knowledge_proposals (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 page_id morrow_work.record_id,
 base_version integer CHECK (base_version BETWEEN 1 AND 1000),
 kind text NOT NULL CHECK (kind IN ('brand_voice','policy','product_fact','supplier','decision')),
 title text CHECK (char_length(title) BETWEEN 1 AND 120 AND title ~ '\S'),
 body text CHECK (char_length(body) BETWEEN 1 AND 8000 AND body ~ '\S'),
 sources jsonb CHECK (morrow_work.knowledge_sources_valid(sources)),
 digest morrow_work.digest NOT NULL,
 read_tags jsonb NOT NULL CHECK (morrow_work.knowledge_tags_valid(read_tags)),
 context_taint text NOT NULL CHECK (context_taint IN ('none','untrusted_external')),
 installation_id morrow_work.record_id NOT NULL,
 agent_principal_id morrow_work.record_id NOT NULL,
 run_id morrow_work.record_id NOT NULL,
 tool_use_id text NOT NULL CHECK (tool_use_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 lease_id morrow_work.record_id NOT NULL,
 status text NOT NULL CHECK (status IN ('pending','accepted','rejected','closed')),
 decided_by_principal_id morrow_work.record_id,
 decided_by_membership_id morrow_work.record_id,
 decided_at timestamptz CHECK (decided_at=date_trunc('milliseconds',decided_at) AND isfinite(decided_at)),
 accepted_page_id morrow_work.record_id,
 accepted_version integer CHECK (accepted_version BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,run_id,tool_use_id),
 FOREIGN KEY (organization_id,workspace_id,page_id) REFERENCES morrow_work.knowledge_pages(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,decided_by_membership_id,decided_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,decided_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT knowledge_proposals_no_customer CHECK (NOT (read_tags @> '[{"capability":"support.case.read"}]'::jsonb)),
 CONSTRAINT knowledge_proposals_target CHECK ((page_id IS NULL)=(base_version IS NULL)),
 -- Text only while pending; the digest always.
 CONSTRAINT knowledge_proposals_content CHECK (CASE WHEN status='pending'
  THEN title IS NOT NULL AND body IS NOT NULL AND sources IS NOT NULL
   AND digest::text=morrow_work.knowledge_proposal_digest(page_id,base_version,kind,title,body,sources)
  ELSE title IS NULL AND body IS NULL AND sources IS NULL END),
 -- A person's decision names that person; a closed proposal (its page deleted) names none.
 CONSTRAINT knowledge_proposals_decision CHECK (CASE status
  WHEN 'pending' THEN decided_at IS NULL AND decided_by_principal_id IS NULL AND decided_by_membership_id IS NULL
   AND accepted_page_id IS NULL AND accepted_version IS NULL
  WHEN 'accepted' THEN decided_at IS NOT NULL AND decided_by_principal_id IS NOT NULL AND decided_by_membership_id IS NOT NULL
   AND accepted_page_id IS NOT NULL AND accepted_version IS NOT NULL
  WHEN 'rejected' THEN decided_at IS NOT NULL AND decided_by_principal_id IS NOT NULL AND decided_by_membership_id IS NOT NULL
   AND accepted_page_id IS NULL AND accepted_version IS NULL
  ELSE decided_at IS NOT NULL AND decided_by_principal_id IS NULL AND decided_by_membership_id IS NULL
   AND accepted_page_id IS NULL AND accepted_version IS NULL END)
);
CREATE INDEX knowledge_proposals_pending ON morrow_work.knowledge_proposals (organization_id,workspace_id,created_at) WHERE status='pending';
-- Versions: append-only; deleting the page erases title, text and sources (the digest stays).
CREATE TABLE morrow_work.knowledge_versions (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 page_id morrow_work.record_id NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
 title text CHECK (char_length(title) BETWEEN 1 AND 120 AND title ~ '\S'),
 body text CHECK (char_length(body) BETWEEN 1 AND 8000 AND body ~ '\S'),
 sources jsonb CHECK (morrow_work.knowledge_sources_valid(sources)),
 digest morrow_work.digest NOT NULL,
 read_tags jsonb NOT NULL CHECK (morrow_work.knowledge_tags_valid(read_tags)),
 author_kind text NOT NULL CHECK (author_kind IN ('person','agent')),
 author_principal_id morrow_work.record_id NOT NULL,
 author_installation_id morrow_work.record_id,
 accepted_by_principal_id morrow_work.record_id NOT NULL,
 accepted_by_membership_id morrow_work.record_id NOT NULL,
 proposal_id morrow_work.record_id,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 erased_at timestamptz CHECK (erased_at=date_trunc('milliseconds',erased_at) AND erased_at>=created_at),
 PRIMARY KEY (organization_id,workspace_id,page_id,version),
 FOREIGN KEY (organization_id,workspace_id,page_id) REFERENCES morrow_work.knowledge_pages(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,proposal_id) REFERENCES morrow_work.knowledge_proposals(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,author_installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,accepted_by_membership_id,accepted_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,accepted_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT knowledge_versions_no_customer CHECK (NOT (read_tags @> '[{"capability":"support.case.read"}]'::jsonb)),
 -- A person wrote it (and accepted their own text), or a person accepted an agent's proposal.
 CONSTRAINT knowledge_versions_author CHECK (CASE author_kind
  WHEN 'person' THEN author_installation_id IS NULL AND proposal_id IS NULL AND author_principal_id=accepted_by_principal_id
  ELSE author_installation_id IS NOT NULL AND proposal_id IS NOT NULL END),
 CONSTRAINT knowledge_versions_content CHECK (CASE WHEN erased_at IS NULL
  THEN title IS NOT NULL AND body IS NOT NULL AND sources IS NOT NULL
   AND digest::text=morrow_work.knowledge_content_digest(title,body,sources)
  ELSE title IS NULL AND body IS NULL AND sources IS NULL END)
);
-- The full-text entry of each page's current version.
CREATE TABLE morrow_work.knowledge_search_entries (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 page_id morrow_work.record_id NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 1000),
 read_tags jsonb NOT NULL CHECK (morrow_work.knowledge_tags_valid(read_tags)),
 document tsvector,
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 erased_at timestamptz CHECK (erased_at=date_trunc('milliseconds',erased_at) AND isfinite(erased_at)),
 PRIMARY KEY (organization_id,workspace_id,page_id),
 FOREIGN KEY (organization_id,workspace_id,page_id) REFERENCES morrow_work.knowledge_pages(organization_id,workspace_id,id),
 CONSTRAINT knowledge_search_entries_no_customer CHECK (NOT (read_tags @> '[{"capability":"support.case.read"}]'::jsonb)),
 CONSTRAINT knowledge_search_entries_erased CHECK ((erased_at IS NULL)=(document IS NOT NULL))
);
CREATE INDEX knowledge_search_document ON morrow_work.knowledge_search_entries USING gin (document);
-- The content-free record of a page deletion.
CREATE TABLE morrow_work.knowledge_deletions (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 page_id morrow_work.record_id NOT NULL,
 kind text NOT NULL CHECK (kind IN ('brand_voice','policy','product_fact','supplier','decision')),
 versions_erased integer NOT NULL CHECK (versions_erased BETWEEN 1 AND 1000),
 search_entries_erased integer NOT NULL CHECK (search_entries_erased BETWEEN 0 AND 1),
 proposals_closed integer NOT NULL CHECK (proposals_closed BETWEEN 0 AND 50),
 deleted_by_principal_id morrow_work.record_id NOT NULL,
 deleted_by_membership_id morrow_work.record_id NOT NULL,
 command_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 PRIMARY KEY (organization_id,workspace_id,page_id),
 FOREIGN KEY (organization_id,workspace_id,page_id) REFERENCES morrow_work.knowledge_pages(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,deleted_by_membership_id,deleted_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,deleted_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id)
);
-- An installed agent's own notebook: counts only (its entries hold the text).
CREATE TABLE morrow_work.agent_notebooks (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 next_sequence integer NOT NULL CHECK (next_sequence BETWEEN 1 AND 1000001),
 live_entries integer NOT NULL CHECK (live_entries BETWEEN 0 AND 100),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND updated_at>=created_at),
 PRIMARY KEY (organization_id,workspace_id,installation_id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id)
);
-- One entry: the run's read tags, clocked 90 days from its write (ADR-0031 item 1).
CREATE TABLE morrow_work.agent_notebook_entries (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id NOT NULL,
 sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 1000000),
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 body text CHECK (char_length(body) BETWEEN 1 AND 2000 AND body ~ '\S'),
 read_tags jsonb NOT NULL CHECK (morrow_work.knowledge_tags_valid(read_tags)),
 run_id morrow_work.record_id NOT NULL,
 tool_use_id text NOT NULL CHECK (tool_use_id ~ '^[A-Za-z0-9_-]{1,64}$'),
 digest morrow_work.digest NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 expires_at timestamptz NOT NULL,
 erased_at timestamptz CHECK (erased_at=date_trunc('milliseconds',erased_at) AND erased_at>=created_at),
 erased_reason text CHECK (erased_reason IN ('superseded','cleared')),
 PRIMARY KEY (organization_id,workspace_id,installation_id,sequence),
 UNIQUE (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,run_id,tool_use_id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_work.agent_notebooks(organization_id,workspace_id,installation_id),
 CONSTRAINT agent_notebook_entries_no_customer CHECK (NOT (read_tags @> '[{"capability":"support.case.read"}]'::jsonb)),
 CONSTRAINT agent_notebook_entries_clock CHECK (expires_at=created_at+interval '90 days'),
 CONSTRAINT agent_notebook_entries_erased CHECK ((erased_at IS NULL)=(body IS NOT NULL) AND (erased_at IS NULL)=(erased_reason IS NULL)
  AND (erased_at IS NOT NULL OR digest::text=morrow_work.sha256_text(body)))
);
CREATE INDEX agent_notebook_entries_live ON morrow_work.agent_notebook_entries (organization_id,workspace_id,installation_id,sequence)
 WHERE erased_at IS NULL;

-- ---------------------------------------------------------------------------
-- Forward changes on the shared commands table (each CHECK the union at this head).
ALTER TABLE morrow_work.commands DROP CONSTRAINT commands_command_type_check, DROP CONSTRAINT commands_check,
 ADD CONSTRAINT commands_command_type_check CHECK (command_type IN ('goal.create','goal.transition','task.create','task.ready','task.assign',
  'question.request','question.answer','question.cancel','proposal.submit','approval.decide','approval.withdraw',
  'installation.document','installation.enable','installation.stop','model_default.revise','run.admit','run.reconcile',
  'connection.disconnect','goal.revise','goal.check','plan.start_document','plan.start',
  'knowledge.write','knowledge.accept','knowledge.reject','knowledge.delete','notebook.clear')),
 ADD CONSTRAINT commands_check CHECK (aggregate_type IN ('goal','task','question','proposal','approval','installation','model_default','run',
  'connection','plan','knowledge','notebook') AND aggregate_type=split_part(command_type,'.',1));

-- ---------------------------------------------------------------------------
-- Row security. Every table: ENABLE + FORCE, the maintenance-only owner policy, the session
-- template (tenant_command), the api's tenant_read and the lease twin (tenant_lease) for the
-- runtime definers.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['knowledge_pages','knowledge_proposals','knowledge_versions','knowledge_search_entries',
  'knowledge_deletions','agent_notebooks','agent_notebook_entries'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('CREATE POLICY tenant_read ON morrow_work.%I FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('GRANT SELECT,INSERT ON morrow_work.%I TO morrow_work_command',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['knowledge_pages','knowledge_proposals','knowledge_search_entries','agent_notebooks','agent_notebook_entries'] LOOP
  EXECUTE format('CREATE POLICY tenant_lease ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
 END LOOP;
END $$;
GRANT UPDATE (revision,current_version,title,read_tags,updated_at,deleted_at,deleted_by_principal_id,deleted_by_membership_id)
 ON morrow_work.knowledge_pages TO morrow_work_command;
GRANT UPDATE (title,body,sources,status,decided_by_principal_id,decided_by_membership_id,decided_at,accepted_page_id,accepted_version)
 ON morrow_work.knowledge_proposals TO morrow_work_command;
GRANT UPDATE (title,body,sources,erased_at) ON morrow_work.knowledge_versions TO morrow_work_command;
GRANT UPDATE (version,read_tags,document,updated_at,erased_at) ON morrow_work.knowledge_search_entries TO morrow_work_command;
GRANT UPDATE (revision,next_sequence,live_entries,updated_at) ON morrow_work.agent_notebooks TO morrow_work_command;
GRANT UPDATE (body,erased_at,erased_reason) ON morrow_work.agent_notebook_entries TO morrow_work_command;
-- The api role reads column by column; the work API filters every row per viewer by its read
-- tags in code (ADR-0031 item 6) before anything leaves the server.
GRANT SELECT (organization_id,workspace_id,id,kind,revision,current_version,title,read_tags,created_by_principal_id,
 created_by_membership_id,created_at,updated_at,deleted_at,deleted_by_principal_id,deleted_by_membership_id)
 ON morrow_work.knowledge_pages TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,page_id,base_version,kind,title,body,sources,digest,read_tags,context_taint,
 installation_id,agent_principal_id,run_id,tool_use_id,lease_id,status,decided_by_principal_id,decided_by_membership_id,
 decided_at,accepted_page_id,accepted_version,created_at) ON morrow_work.knowledge_proposals TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,page_id,version,title,body,sources,digest,read_tags,author_kind,author_principal_id,
 author_installation_id,accepted_by_principal_id,accepted_by_membership_id,proposal_id,created_at,erased_at)
 ON morrow_work.knowledge_versions TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,page_id,version,read_tags,document,updated_at,erased_at)
 ON morrow_work.knowledge_search_entries TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,page_id,kind,versions_erased,search_entries_erased,proposals_closed,
 deleted_by_principal_id,deleted_by_membership_id,command_id,created_at) ON morrow_work.knowledge_deletions TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,installation_id,revision,next_sequence,live_entries,created_at,updated_at)
 ON morrow_work.agent_notebooks TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,installation_id,sequence,id,body,read_tags,run_id,tool_use_id,digest,created_at,
 expires_at,erased_at,erased_reason) ON morrow_work.agent_notebook_entries TO morrow_work_api;

-- ---------------------------------------------------------------------------
-- Triggers: INVOKER, owned by the owner, granted to nobody.
-- Pages: born at revision 1 and version 1; afterwards revision+1 with a new version (the
-- title and grown read tags), or one deletion (title erased, who deleted it); nothing after.
CREATE FUNCTION morrow_work.knowledge_page_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.current_version<>1 OR NEW.updated_at<>NEW.created_at OR NEW.deleted_at IS NOT NULL THEN
   RAISE EXCEPTION 'KNOWLEDGE_PAGE_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.deleted_at IS NOT NULL OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-ARRAY['revision','current_version','title','read_tags','updated_at','deleted_at','deleted_by_principal_id','deleted_by_membership_id'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','current_version','title','read_tags','updated_at','deleted_at','deleted_by_principal_id','deleted_by_membership_id'])
  OR NOT (NEW.read_tags @> OLD.read_tags) THEN
  RAISE EXCEPTION 'KNOWLEDGE_PAGE_INVALID';
 END IF;
 IF NEW.deleted_at IS NULL AND NEW.current_version<>OLD.current_version+1 THEN RAISE EXCEPTION 'KNOWLEDGE_PAGE_INVALID'; END IF;
 IF NEW.deleted_at IS NOT NULL AND (NEW.current_version<>OLD.current_version OR NEW.read_tags<>OLD.read_tags) THEN
  RAISE EXCEPTION 'KNOWLEDGE_PAGE_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Versions: inserted live, next in line on a live page; the one change is erasure.
CREATE FUNCTION morrow_work.knowledge_version_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.erased_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM morrow_work.knowledge_pages p WHERE p.organization_id=NEW.organization_id
    AND p.workspace_id=NEW.workspace_id AND p.id=NEW.page_id AND p.deleted_at IS NULL)
   OR (NEW.version>1 AND NOT EXISTS(SELECT 1 FROM morrow_work.knowledge_versions v WHERE v.organization_id=NEW.organization_id
    AND v.workspace_id=NEW.workspace_id AND v.page_id=NEW.page_id AND v.version=NEW.version-1)) THEN
   RAISE EXCEPTION 'KNOWLEDGE_VERSION_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.erased_at IS NOT NULL OR NEW.erased_at IS NULL
  OR (to_jsonb(NEW)-ARRAY['title','body','sources','erased_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['title','body','sources','erased_at']) THEN
  RAISE EXCEPTION 'KNOWLEDGE_VERSION_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Proposals: born pending; the one change is a decision (or closing), which erases the text.
CREATE FUNCTION morrow_work.knowledge_proposal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' THEN RAISE EXCEPTION 'KNOWLEDGE_PROPOSAL_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'pending' OR NEW.status='pending'
  OR (to_jsonb(NEW)-ARRAY['title','body','sources','status','decided_by_principal_id','decided_by_membership_id','decided_at',
   'accepted_page_id','accepted_version'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['title','body','sources','status','decided_by_principal_id','decided_by_membership_id','decided_at',
   'accepted_page_id','accepted_version']) THEN
  RAISE EXCEPTION 'KNOWLEDGE_PROPOSAL_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Search entries: follow the page's version and tags; the one final change is erasure.
CREATE FUNCTION morrow_work.knowledge_search_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.erased_at IS NOT NULL THEN RAISE EXCEPTION 'KNOWLEDGE_SEARCH_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.erased_at IS NOT NULL OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-ARRAY['version','read_tags','document','updated_at','erased_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['version','read_tags','document','updated_at','erased_at'])
  OR (NEW.erased_at IS NULL AND NEW.version<>OLD.version+1) OR (NEW.erased_at IS NOT NULL AND NEW.version<>OLD.version) THEN
  RAISE EXCEPTION 'KNOWLEDGE_SEARCH_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Notebooks: counts move with revision+1; entries are written live and only ever erased.
CREATE FUNCTION morrow_work.agent_notebook_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.next_sequence<>1 OR NEW.live_entries<>0 OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'AGENT_NOTEBOOK_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR NEW.next_sequence<OLD.next_sequence
  OR (to_jsonb(NEW)-ARRAY['revision','next_sequence','live_entries','updated_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','next_sequence','live_entries','updated_at']) THEN
  RAISE EXCEPTION 'AGENT_NOTEBOOK_INVALID';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION morrow_work.agent_notebook_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.erased_at IS NOT NULL THEN RAISE EXCEPTION 'AGENT_NOTEBOOK_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.erased_at IS NOT NULL OR NEW.erased_at IS NULL
  OR (to_jsonb(NEW)-ARRAY['body','erased_at','erased_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['body','erased_at','erased_reason']) THEN
  RAISE EXCEPTION 'AGENT_NOTEBOOK_INVALID';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_work.knowledge_page_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.knowledge_version_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.knowledge_proposal_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.knowledge_search_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.agent_notebook_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.agent_notebook_entry_guard() FROM PUBLIC;
CREATE TRIGGER knowledge_page_guard BEFORE INSERT OR UPDATE ON morrow_work.knowledge_pages FOR EACH ROW EXECUTE FUNCTION morrow_work.knowledge_page_guard();
CREATE TRIGGER knowledge_version_guard BEFORE INSERT OR UPDATE ON morrow_work.knowledge_versions FOR EACH ROW EXECUTE FUNCTION morrow_work.knowledge_version_guard();
CREATE TRIGGER knowledge_proposal_guard BEFORE INSERT OR UPDATE ON morrow_work.knowledge_proposals FOR EACH ROW EXECUTE FUNCTION morrow_work.knowledge_proposal_guard();
CREATE TRIGGER knowledge_search_guard BEFORE INSERT OR UPDATE ON morrow_work.knowledge_search_entries FOR EACH ROW EXECUTE FUNCTION morrow_work.knowledge_search_guard();
CREATE TRIGGER agent_notebook_guard BEFORE INSERT OR UPDATE ON morrow_work.agent_notebooks FOR EACH ROW EXECUTE FUNCTION morrow_work.agent_notebook_guard();
CREATE TRIGGER agent_notebook_entry_guard BEFORE INSERT OR UPDATE ON morrow_work.agent_notebook_entries FOR EACH ROW EXECUTE FUNCTION morrow_work.agent_notebook_entry_guard();
DO $$ DECLARE t text; BEGIN
 -- Deletion records are permanent; pages, versions, proposals and search entries are erased in
 -- place, never deleted (only the owner's retention sweep removes expired notebook entries).
 EXECUTE 'CREATE TRIGGER append_only BEFORE UPDATE ON morrow_work.knowledge_deletions FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()';
 FOREACH t IN ARRAY ARRAY['knowledge_pages','knowledge_proposals','knowledge_versions','knowledge_search_entries','knowledge_deletions'] LOOP
  EXECUTE format('CREATE TRIGGER append_only_delete BEFORE DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['knowledge_pages','knowledge_proposals','knowledge_versions','knowledge_search_entries','knowledge_deletions',
  'agent_notebooks','agent_notebook_entries'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Revisable owner helpers: INVOKER, owned by the owner, EXECUTE for the command role only.
-- A page's read tags (ADR-0031 item 6): workspace.knowledge.read on each linked store (a null
-- store before any store is linked), and for a product fact the store's catalogue tag.
CREATE FUNCTION morrow_work.knowledge_read_tags(p_org text,p_ws text,p_kind text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT CASE WHEN count(s.store_id)=0 THEN '[{"storeId":null,"capability":"workspace.knowledge.read"}]'::jsonb
  ELSE morrow_work.knowledge_tags_union(
   jsonb_agg(jsonb_build_object('storeId',s.store_id,'capability','workspace.knowledge.read')),
   CASE WHEN p_kind='product_fact' THEN jsonb_agg(jsonb_build_object('storeId',s.store_id,'capability','catalog.products.read')) END) END
 FROM (SELECT DISTINCT i.store_id FROM morrow_identity.work_store_installations(p_org,p_ws) i
  WHERE i.status='linked' AND i.linked_at<=pg_catalog.clock_timestamp()) s
$$;
-- The search document of a version: its title and text, the 'simple' configuration (no
-- language stemming: the shop writes in any language).
CREATE FUNCTION morrow_work.knowledge_document(p_title text,p_text text) RETURNS tsvector
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT setweight(to_tsvector('simple'::regconfig,p_title),'A')||setweight(to_tsvector('simple'::regconfig,p_text),'B')
$$;
-- One version made current on a page (the definers' shared step): the version row, the page
-- (title, tags grown, revision and version+1, or the page itself at version 1) and its
-- search entry. The caller holds the page's row lock or created it in this transaction.
CREATE FUNCTION morrow_work.knowledge_version_put(p_org text,p_ws text,p_page_id text,p_version integer,p_title text,p_text text,
 p_sources jsonb,p_tags jsonb,p_author_kind text,p_author_principal text,p_author_installation text,p_accepted_principal text,
 p_accepted_membership text,p_proposal_id text,p_at timestamptz) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 INSERT INTO morrow_work.knowledge_versions(organization_id,workspace_id,page_id,version,title,body,sources,digest,read_tags,author_kind,
  author_principal_id,author_installation_id,accepted_by_principal_id,accepted_by_membership_id,proposal_id,created_at,erased_at)
 VALUES (p_org,p_ws,p_page_id,p_version,p_title,p_text,p_sources,morrow_work.knowledge_content_digest(p_title,p_text,p_sources),p_tags,
  p_author_kind,p_author_principal,p_author_installation,p_accepted_principal,p_accepted_membership,p_proposal_id,p_at,NULL);
 IF p_version=1 THEN
  INSERT INTO morrow_work.knowledge_search_entries(organization_id,workspace_id,page_id,version,read_tags,document,updated_at,erased_at)
  VALUES (p_org,p_ws,p_page_id,1,p_tags,morrow_work.knowledge_document(p_title,p_text),p_at,NULL);
 ELSE
  UPDATE morrow_work.knowledge_pages x SET title=p_title,current_version=p_version,revision=x.revision+1,
   read_tags=morrow_work.knowledge_tags_union(x.read_tags,p_tags),updated_at=greatest(p_at,x.updated_at)
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_page_id;
  UPDATE morrow_work.knowledge_search_entries x SET version=p_version,document=morrow_work.knowledge_document(p_title,p_text),
   read_tags=(SELECT p.read_tags FROM morrow_work.knowledge_pages p WHERE p.organization_id=p_org AND p.workspace_id=p_ws AND p.id=p_page_id),
   updated_at=greatest(p_at,x.updated_at)
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.page_id=p_page_id;
 END IF;
END $$;
REVOKE ALL ON FUNCTION morrow_work.knowledge_read_tags(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.knowledge_document(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.knowledge_version_put(text,text,text,integer,text,text,jsonb,jsonb,text,text,text,text,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.knowledge_read_tags(text,text,text),morrow_work.knowledge_document(text,text),
 morrow_work.knowledge_version_put(text,text,text,integer,text,text,jsonb,jsonb,text,text,text,text,text,text,timestamptz)
 TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- API functions: SECURITY DEFINER, owned by the command role after the transfer below,
-- EXECUTE for morrow_work_api only. Tenant and actor come only from current_tenant(); the
-- Worker's kernel decided the capability and verb first, and the prelude rechecks the
-- session's authority under lock.
CREATE FUNCTION morrow_work.begin_knowledge_command(p_type text,p_command_id text,p_request_digest text)
RETURNS TABLE(outcome text,aggregate_type text,aggregate_id text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; c record;
BEGIN
 IF p_type IS NULL OR p_type NOT IN ('knowledge.write','knowledge.accept','knowledge.reject','knowledge.delete','notebook.clear')
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

-- workspace.knowledge.approve {execute}, a person's own version (human_only): a new page
-- (p_page_id NULL; the server's id p_new_page_id, the kind, version 1) or the next version of
-- a live page at p_expected_version. Read tags are computed here.
CREATE FUNCTION morrow_work.cmd_knowledge_write(p_command_id text,p_request_digest text,p_correlation_id text,p_page_id text,
 p_new_page_id text,p_kind text,p_expected_version text,p_title text,p_text text,p_sources text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; g record; v_sources jsonb; v_at timestamptz; v_tags jsonb; v_page text; v_version integer; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_title IS NULL OR char_length(p_title) NOT BETWEEN 1 AND 120 OR p_title !~ '\S'
  OR p_text IS NULL OR char_length(p_text) NOT BETWEEN 1 AND 8000 OR p_text !~ '\S'
  OR p_sources IS NULL OR octet_length(p_sources)>4096
  OR (p_page_id IS NULL)=(p_new_page_id IS NULL) OR (p_page_id IS NULL)<>(p_expected_version IS NULL)
  OR (p_page_id IS NOT NULL AND (p_page_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_expected_version !~ '^[1-9][0-9]{0,3}$'))
  OR (p_new_page_id IS NOT NULL AND (p_new_page_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   OR p_kind IS NULL OR p_kind NOT IN ('brand_voice','policy','product_fact','supplier','decision'))) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 BEGIN v_sources:=p_sources::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 IF NOT morrow_work.knowledge_sources_valid(v_sources) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 v_at:=morrow_work.db_now();
 IF p_page_id IS NULL THEN
  IF p_kind='brand_voice' AND EXISTS(SELECT 1 FROM morrow_work.knowledge_pages x WHERE x.organization_id=p.organization_id
    AND x.workspace_id=p.workspace_id AND x.kind='brand_voice' AND x.deleted_at IS NULL) THEN
   RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
  END IF;
  IF (SELECT count(*) FROM morrow_work.knowledge_pages x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
    AND x.deleted_at IS NULL)>=500 THEN
   RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
  END IF;
  v_tags:=morrow_work.knowledge_read_tags(p.organization_id,p.workspace_id,p_kind);
  v_page:=p_new_page_id; v_version:=1;
  INSERT INTO morrow_work.knowledge_pages(organization_id,workspace_id,id,kind,revision,current_version,title,read_tags,
   created_by_principal_id,created_by_membership_id,created_at,updated_at,deleted_at,deleted_by_principal_id,deleted_by_membership_id)
  VALUES (p.organization_id,p.workspace_id,v_page,p_kind,1,1,p_title,v_tags,p.principal_id,p.membership_id,v_at,v_at,NULL,NULL,NULL);
 ELSE
  SELECT x.kind,x.current_version,x.deleted_at INTO g FROM morrow_work.knowledge_pages x
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_page_id FOR UPDATE;
  IF NOT FOUND OR g.deleted_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
  IF g.current_version<>p_expected_version::integer THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
  IF g.current_version>=1000 THEN RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN; END IF;
  v_tags:=morrow_work.knowledge_read_tags(p.organization_id,p.workspace_id,g.kind);
  v_page:=p_page_id; v_version:=g.current_version+1;
 END IF;
 PERFORM morrow_work.knowledge_version_put(p.organization_id,p.workspace_id,v_page,v_version,p_title,p_text,v_sources,v_tags,'person',
  p.principal_id,NULL,p.principal_id,p.membership_id,NULL,v_at);
 v_result:=jsonb_build_object('pageId',v_page,'version',v_version);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'knowledge.write',v_page,v_version,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- workspace.knowledge.approve {execute} on an agent's proposal (human_only; ADR-0024: a person,
-- never an agent or a mandate, decides): bound to the digest the person saw, and to the page's
-- version when the proposal was made (a page that changed since is stale). The accepted text
-- becomes the page's next version (or a new page), authored by the agent and accepted by the
-- person; the proposal keeps only its digest.
CREATE FUNCTION morrow_work.cmd_knowledge_accept(p_command_id text,p_request_digest text,p_correlation_id text,p_proposal_id text,
 p_digest text,p_new_page_id text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; q record; g record; v_at timestamptz; v_tags jsonb; v_page text; v_version integer; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_proposal_id IS NULL OR p_proposal_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
  OR p_new_page_id IS NULL OR p_new_page_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.page_id::text AS page_id,x.base_version,x.kind,x.title,x.body,x.sources,x.digest::text AS digest,x.read_tags,x.status,
  x.installation_id::text AS installation_id,x.agent_principal_id::text AS agent_principal_id INTO q
  FROM morrow_work.knowledge_proposals x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_proposal_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF q.status<>'pending' THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
 IF q.digest<>p_digest THEN RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN; END IF;
 v_at:=morrow_work.db_now();
 IF q.page_id IS NULL THEN
  IF q.kind='brand_voice' AND EXISTS(SELECT 1 FROM morrow_work.knowledge_pages x WHERE x.organization_id=p.organization_id
    AND x.workspace_id=p.workspace_id AND x.kind='brand_voice' AND x.deleted_at IS NULL) THEN
   RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN;
  END IF;
  IF (SELECT count(*) FROM morrow_work.knowledge_pages x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
    AND x.deleted_at IS NULL)>=500 THEN
   RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
  END IF;
  v_tags:=morrow_work.knowledge_tags_union(morrow_work.knowledge_read_tags(p.organization_id,p.workspace_id,q.kind),q.read_tags);
  IF jsonb_array_length(v_tags)>24 THEN RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN; END IF;
  v_page:=p_new_page_id; v_version:=1;
  INSERT INTO morrow_work.knowledge_pages(organization_id,workspace_id,id,kind,revision,current_version,title,read_tags,
   created_by_principal_id,created_by_membership_id,created_at,updated_at,deleted_at,deleted_by_principal_id,deleted_by_membership_id)
  VALUES (p.organization_id,p.workspace_id,v_page,q.kind,1,1,q.title,v_tags,p.principal_id,p.membership_id,v_at,v_at,NULL,NULL,NULL);
 ELSE
  SELECT x.kind,x.current_version,x.deleted_at,x.read_tags INTO g FROM morrow_work.knowledge_pages x
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=q.page_id FOR UPDATE;
  IF NOT FOUND OR g.deleted_at IS NOT NULL OR g.kind<>q.kind THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
  IF g.current_version<>q.base_version THEN RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN; END IF;
  IF g.current_version>=1000 THEN RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN; END IF;
  v_tags:=morrow_work.knowledge_tags_union(morrow_work.knowledge_read_tags(p.organization_id,p.workspace_id,g.kind),q.read_tags);
  IF jsonb_array_length(morrow_work.knowledge_tags_union(g.read_tags,v_tags))>24 THEN
   RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
  END IF;
  v_page:=q.page_id; v_version:=g.current_version+1;
 END IF;
 PERFORM morrow_work.knowledge_version_put(p.organization_id,p.workspace_id,v_page,v_version,q.title,q.body,q.sources,v_tags,'agent',
  q.agent_principal_id,q.installation_id,p.principal_id,p.membership_id,p_proposal_id,v_at);
 UPDATE morrow_work.knowledge_proposals x SET status='accepted',title=NULL,body=NULL,sources=NULL,decided_by_principal_id=p.principal_id,
  decided_by_membership_id=p.membership_id,decided_at=v_at,accepted_page_id=v_page,accepted_version=v_version
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_proposal_id;
 v_result:=jsonb_build_object('proposalId',p_proposal_id,'pageId',v_page,'version',v_version);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'knowledge.accept',p_proposal_id,1,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- workspace.knowledge.approve {execute}: a person rejects a pending proposal; its text is erased.
CREATE FUNCTION morrow_work.cmd_knowledge_reject(p_command_id text,p_request_digest text,p_correlation_id text,p_proposal_id text,
 p_digest text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; q record; v_at timestamptz; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_proposal_id IS NULL OR p_proposal_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.status,x.digest::text AS digest INTO q FROM morrow_work.knowledge_proposals x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_proposal_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF q.status<>'pending' THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
 IF q.digest<>p_digest THEN RETURN QUERY SELECT 'stale'::text,NULL::text; RETURN; END IF;
 v_at:=morrow_work.db_now();
 UPDATE morrow_work.knowledge_proposals x SET status='rejected',title=NULL,body=NULL,sources=NULL,decided_by_principal_id=p.principal_id,
  decided_by_membership_id=p.membership_id,decided_at=v_at
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_proposal_id;
 v_result:=jsonb_build_object('proposalId',p_proposal_id,'status','rejected');
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'knowledge.reject',p_proposal_id,1,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- workspace.knowledge.approve {administer} (human_only): the deletion path (ADR-0031 items 1, 3
-- and 4). In one transaction: every version's title, text and sources erased, the search entry
-- erased, each pending proposal on the page closed with its text erased, the page's title
-- erased, and the content-free knowledge_deletions record. Nothing of the content remains.
CREATE FUNCTION morrow_work.cmd_knowledge_delete(p_command_id text,p_request_digest text,p_correlation_id text,p_page_id text,
 p_expected_version text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; g record; v_at timestamptz; v_versions integer; v_entries integer; v_proposals integer; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_page_id IS NULL OR p_page_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_expected_version IS NULL OR p_expected_version !~ '^[1-9][0-9]{0,3}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.kind,x.current_version,x.deleted_at INTO g FROM morrow_work.knowledge_pages x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_page_id FOR UPDATE;
 IF NOT FOUND OR g.deleted_at IS NOT NULL THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF g.current_version<>p_expected_version::integer THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
 v_at:=morrow_work.db_now();
 UPDATE morrow_work.knowledge_versions x SET title=NULL,body=NULL,sources=NULL,erased_at=greatest(v_at,x.created_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.page_id=p_page_id AND x.erased_at IS NULL;
 GET DIAGNOSTICS v_versions=ROW_COUNT;
 UPDATE morrow_work.knowledge_search_entries x SET document=NULL,erased_at=greatest(v_at,x.updated_at),updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.page_id=p_page_id AND x.erased_at IS NULL;
 GET DIAGNOSTICS v_entries=ROW_COUNT;
 UPDATE morrow_work.knowledge_proposals x SET status='closed',title=NULL,body=NULL,sources=NULL,decided_at=greatest(v_at,x.created_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.page_id=p_page_id AND x.status='pending';
 GET DIAGNOSTICS v_proposals=ROW_COUNT;
 UPDATE morrow_work.knowledge_pages x SET title=NULL,deleted_at=greatest(v_at,x.updated_at),deleted_by_principal_id=p.principal_id,
  deleted_by_membership_id=p.membership_id,revision=x.revision+1,updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_page_id;
 INSERT INTO morrow_work.knowledge_deletions(organization_id,workspace_id,page_id,kind,versions_erased,search_entries_erased,proposals_closed,
  deleted_by_principal_id,deleted_by_membership_id,command_id,created_at)
 VALUES (p.organization_id,p.workspace_id,p_page_id,g.kind,v_versions,v_entries,v_proposals,p.principal_id,p.membership_id,p_command_id,v_at);
 v_result:=jsonb_build_object('pageId',p_page_id,'versionsErased',v_versions,'searchEntriesErased',v_entries,'proposalsClosed',v_proposals);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'knowledge.delete',p_page_id,g.current_version,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- workspace.notebook.write {administer} (a person; agents never hold administer): erase every
-- live entry of an installation's notebook ('cleared').
CREATE FUNCTION morrow_work.cmd_notebook_clear(p_command_id text,p_request_digest text,p_correlation_id text,p_installation_id text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; n record; v_at timestamptz; v_erased integer; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 SELECT x.revision::bigint AS revision INTO n FROM morrow_work.agent_notebooks x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.installation_id=p_installation_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 v_at:=morrow_work.db_now();
 UPDATE morrow_work.agent_notebook_entries x SET body=NULL,erased_at=greatest(v_at,x.created_at),erased_reason='cleared'
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.installation_id=p_installation_id AND x.erased_at IS NULL;
 GET DIAGNOSTICS v_erased=ROW_COUNT;
 UPDATE morrow_work.agent_notebooks x SET live_entries=0,revision=x.revision+1,updated_at=greatest(v_at,x.updated_at)
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.installation_id=p_installation_id;
 v_result:=jsonb_build_object('installationId',p_installation_id,'entriesErased',v_erased);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'notebook.clear',p_installation_id,n.revision+1,v_result,p_correlation_id,v_at);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- ---------------------------------------------------------------------------
-- Runtime functions: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_runtime_executor only. Ids only: the tenant, run and installation come from the
-- entered lease (current_lease(): a run lease of an active installation); the loop's
-- tool-call step decided authority and the run's read tags in code first (ADR-0027 item 2).
-- A live page's kind, version and read tags (no text), for the propose step's scope check.
CREATE FUNCTION morrow_work.run_knowledge_page(p_page_id text)
RETURNS TABLE(kind text,version text,read_tags text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record;
BEGIN
 IF p_page_id IS NULL OR p_page_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' OR l.installation_id IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT x.kind,x.current_version::text,x.read_tags::text FROM morrow_work.knowledge_pages x
  WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=p_page_id AND x.deleted_at IS NULL;
END $$;
-- The workspace's accepted brand voice (its current version), for Listings' context as marked
-- data. Only for a run lease of an active installation; no row when there is none.
CREATE FUNCTION morrow_work.run_brand_voice()
RETURNS TABLE(page_id text,version text,body text,read_tags text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' OR l.installation_id IS NULL OR NOT EXISTS(SELECT 1 FROM morrow_work.agent_installations i
   WHERE i.organization_id=l.organization_id AND i.workspace_id=l.workspace_id AND i.id=l.installation_id AND i.status='active') THEN
  RETURN;
 END IF;
 RETURN QUERY SELECT x.id::text,x.current_version::text,v.body,x.read_tags::text FROM morrow_work.knowledge_pages x
  JOIN morrow_work.knowledge_versions v ON v.organization_id=x.organization_id AND v.workspace_id=x.workspace_id AND v.page_id=x.id
   AND v.version=x.current_version AND v.erased_at IS NULL
  WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.kind='brand_voice' AND x.deleted_at IS NULL;
END $$;
-- Full-text candidates for knowledge.search (at most 200, best first, with their read tags):
-- the loop's step keeps only those whose every tag the run may view (ADR-0031 item 6).
CREATE FUNCTION morrow_work.run_knowledge_search(p_search_text text)
RETURNS TABLE(page_id text,kind text,version text,title text,body text,read_tags text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record;
BEGIN
 IF p_search_text IS NULL OR char_length(p_search_text) NOT BETWEEN 1 AND 200 OR p_search_text !~ '\S' THEN RETURN; END IF;
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' OR l.installation_id IS NULL OR NOT EXISTS(SELECT 1 FROM morrow_work.agent_installations i
   WHERE i.organization_id=l.organization_id AND i.workspace_id=l.workspace_id AND i.id=l.installation_id AND i.status='active') THEN
  RETURN;
 END IF;
 RETURN QUERY SELECT x.id::text,x.kind,x.current_version::text,v.title,v.body,s.read_tags::text
  FROM morrow_work.knowledge_search_entries s
  JOIN morrow_work.knowledge_pages x ON x.organization_id=s.organization_id AND x.workspace_id=s.workspace_id AND x.id=s.page_id AND x.deleted_at IS NULL
  JOIN morrow_work.knowledge_versions v ON v.organization_id=x.organization_id AND v.workspace_id=x.workspace_id AND v.page_id=x.id
   AND v.version=x.current_version AND v.erased_at IS NULL
  WHERE s.organization_id=l.organization_id AND s.workspace_id=l.workspace_id AND s.erased_at IS NULL
   AND s.document @@ websearch_to_tsquery('simple'::regconfig,p_search_text)
  ORDER BY ts_rank(s.document,websearch_to_tsquery('simple'::regconfig,p_search_text)) DESC,x.id::text COLLATE "C" LIMIT 200;
END $$;
-- knowledge.propose's server-side command (workspace.knowledge.propose, an internal write that
-- grants nothing): one pending proposal of the lease's installation, idempotent per run and
-- tool_use id (a replay of the same input returns the first record; another input is a
-- conflict). The run's read tags come from the loop (the union of its tool results' tags,
-- never a model's); a customer tag is refused (customer_data). A page target must be live and of
-- the same kind, at its current version (the base an accept is bound to).
CREATE FUNCTION morrow_work.run_knowledge_propose(p_tool_use_id text,p_page_id text,p_kind text,p_title text,p_text text,
 p_sources text,p_read_tags text,p_taint text)
RETURNS TABLE(outcome text,proposal_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 l record; i record; g record; x record; v_sources jsonb; v_tags jsonb; v_base integer; v_digest text; v_id text; v_at timestamptz;
BEGIN
 IF p_tool_use_id IS NULL OR p_tool_use_id !~ '^[A-Za-z0-9_-]{1,64}$'
  OR (p_page_id IS NOT NULL AND p_page_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  OR p_kind IS NULL OR p_kind NOT IN ('brand_voice','policy','product_fact','supplier','decision')
  OR p_title IS NULL OR char_length(p_title) NOT BETWEEN 1 AND 120 OR p_title !~ '\S'
  OR p_text IS NULL OR char_length(p_text) NOT BETWEEN 1 AND 8000 OR p_text !~ '\S'
  OR p_sources IS NULL OR octet_length(p_sources)>4096 OR p_read_tags IS NULL OR octet_length(p_read_tags)>8192
  OR p_taint IS NULL OR p_taint NOT IN ('none','untrusted_external') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 BEGIN v_sources:=p_sources::jsonb; v_tags:=p_read_tags::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 IF NOT morrow_work.knowledge_sources_valid(v_sources) OR jsonb_typeof(v_tags)<>'array' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF v_tags @> '[{"capability":"support.case.read"}]'::jsonb THEN RETURN QUERY SELECT 'customer_data'::text,NULL::text; RETURN; END IF;
 IF jsonb_array_length(v_tags)>0 AND NOT morrow_work.knowledge_tags_valid(v_tags) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' OR l.installation_id IS NULL THEN RETURN QUERY SELECT 'lease_ended'::text,NULL::text; RETURN; END IF;
 SELECT x.status,x.agent_principal_id::text AS agent_principal_id INTO i FROM morrow_work.agent_installations x
  WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=l.installation_id FOR SHARE;
 IF NOT FOUND OR i.status<>'active' THEN RETURN QUERY SELECT 'stopped'::text,NULL::text; RETURN; END IF;
 -- One proposal per run and tool call, serialised per workspace (the pending cap counts them).
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.work.knowledge_proposals',l.organization_id,l.workspace_id)::text,0));
 IF p_page_id IS NOT NULL THEN
  SELECT x.kind,x.current_version INTO g FROM morrow_work.knowledge_pages x
   WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=p_page_id AND x.deleted_at IS NULL;
  IF NOT FOUND OR g.kind<>p_kind THEN RETURN QUERY SELECT 'id_out_of_scope'::text,NULL::text; RETURN; END IF;
  v_base:=g.current_version;
 END IF;
 SELECT y.id::text AS id,y.digest::text AS digest,y.page_id::text AS page_id,y.base_version,y.kind INTO x FROM morrow_work.knowledge_proposals y
  WHERE y.organization_id=l.organization_id AND y.workspace_id=l.workspace_id AND y.run_id=l.subject_id AND y.tool_use_id=p_tool_use_id;
 IF FOUND THEN
  -- A replay of the same call (ADR-0027 item 2: an internal write returns its first record).
  IF x.page_id IS NOT DISTINCT FROM p_page_id AND x.kind=p_kind
   AND x.digest=morrow_work.knowledge_proposal_digest(x.page_id,x.base_version,p_kind,p_title,p_text,v_sources) THEN
   RETURN QUERY SELECT 'replay'::text,x.id; RETURN;
  END IF;
  RETURN QUERY SELECT 'conflict'::text,NULL::text; RETURN;
 END IF;
 IF (SELECT count(*) FROM morrow_work.knowledge_proposals y WHERE y.organization_id=l.organization_id AND y.workspace_id=l.workspace_id
   AND y.status='pending')>=50 THEN
  RETURN QUERY SELECT 'pending_limit'::text,NULL::text; RETURN;
 END IF;
 IF jsonb_array_length(v_tags)=0 THEN
  v_tags:=morrow_work.knowledge_read_tags(l.organization_id,l.workspace_id,p_kind);
 ELSE
  v_tags:=morrow_work.knowledge_tags_union(morrow_work.knowledge_read_tags(l.organization_id,l.workspace_id,p_kind),v_tags);
 END IF;
 IF jsonb_array_length(v_tags)>24 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 v_digest:=morrow_work.knowledge_proposal_digest(p_page_id,v_base,p_kind,p_title,p_text,v_sources);
 v_id:=gen_random_uuid()::text; v_at:=morrow_work.db_now();
 INSERT INTO morrow_work.knowledge_proposals(organization_id,workspace_id,id,page_id,base_version,kind,title,body,sources,digest,read_tags,
  context_taint,installation_id,agent_principal_id,run_id,tool_use_id,lease_id,status,decided_by_principal_id,decided_by_membership_id,
  decided_at,accepted_page_id,accepted_version,created_at)
 VALUES (l.organization_id,l.workspace_id,v_id,p_page_id,v_base,p_kind,p_title,p_text,v_sources,v_digest,v_tags,p_taint,l.installation_id,
  i.agent_principal_id,l.subject_id,p_tool_use_id,l.lease_id,'pending',NULL,NULL,NULL,NULL,NULL,v_at);
 RETURN QUERY SELECT 'applied'::text,v_id;
END $$;
-- notebook.write's server-side command (workspace.notebook.write): one entry in the lease's own
-- installation's notebook, idempotent per run and tool_use id; at most 100 live entries (the
-- oldest superseded); the run's read tags from the loop, never the customer tag, with the
-- installation's store artifact tag (workspace.artifact.read) on every entry.
CREATE FUNCTION morrow_work.run_notebook_write(p_tool_use_id text,p_text text,p_read_tags text)
RETURNS TABLE(outcome text,entry_id text,sequence text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 l record; i record; n record; x record; v_tags jsonb; v_id text; v_at timestamptz; v_seq integer; v_live integer;
BEGIN
 IF p_tool_use_id IS NULL OR p_tool_use_id !~ '^[A-Za-z0-9_-]{1,64}$'
  OR p_text IS NULL OR char_length(p_text) NOT BETWEEN 1 AND 2000 OR p_text !~ '\S'
  OR p_read_tags IS NULL OR octet_length(p_read_tags)>8192 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 BEGIN v_tags:=p_read_tags::jsonb;
 EXCEPTION WHEN OTHERS THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END;
 IF jsonb_typeof(v_tags)<>'array' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN; END IF;
 IF v_tags @> '[{"capability":"support.case.read"}]'::jsonb THEN RETURN QUERY SELECT 'customer_data'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' OR l.installation_id IS NULL THEN RETURN QUERY SELECT 'lease_ended'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT x.status INTO i FROM morrow_work.agent_installations x
  WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=l.installation_id FOR SHARE;
 IF NOT FOUND OR i.status<>'active' THEN RETURN QUERY SELECT 'stopped'::text,NULL::text,NULL::text; RETURN; END IF;
 -- An entry is the agent's own work on its store: it always carries the store's artifact tag,
 -- with the tags of whatever the run read.
 v_tags:=morrow_work.knowledge_tags_union(jsonb_build_array(jsonb_build_object('storeId',l.store_id,'capability','workspace.artifact.read')),v_tags);
 IF NOT morrow_work.knowledge_tags_valid(v_tags) THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN; END IF;
 v_at:=morrow_work.db_now();
 INSERT INTO morrow_work.agent_notebooks(organization_id,workspace_id,installation_id,revision,next_sequence,live_entries,created_at,updated_at)
 VALUES (l.organization_id,l.workspace_id,l.installation_id,1,1,0,v_at,v_at) ON CONFLICT DO NOTHING;
 SELECT y.revision::bigint AS revision,y.next_sequence,y.live_entries INTO n FROM morrow_work.agent_notebooks y
  WHERE y.organization_id=l.organization_id AND y.workspace_id=l.workspace_id AND y.installation_id=l.installation_id FOR UPDATE;
 SELECT y.id::text AS id,y.sequence::text AS sequence,y.digest::text AS digest INTO x FROM morrow_work.agent_notebook_entries y
  WHERE y.organization_id=l.organization_id AND y.workspace_id=l.workspace_id AND y.run_id=l.subject_id AND y.tool_use_id=p_tool_use_id;
 IF FOUND THEN
  IF x.digest=morrow_work.sha256_text(p_text) THEN RETURN QUERY SELECT 'replay'::text,x.id,x.sequence; RETURN; END IF;
  RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF n.next_sequence>1000000 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN; END IF;
 v_seq:=n.next_sequence; v_id:=gen_random_uuid()::text; v_live:=n.live_entries;
 -- The 101st live entry supersedes the oldest.
 IF v_live>=100 THEN
  UPDATE morrow_work.agent_notebook_entries y SET body=NULL,erased_at=greatest(v_at,y.created_at),erased_reason='superseded'
   WHERE y.organization_id=l.organization_id AND y.workspace_id=l.workspace_id AND y.installation_id=l.installation_id
   AND y.sequence=(SELECT min(z.sequence) FROM morrow_work.agent_notebook_entries z WHERE z.organization_id=l.organization_id
    AND z.workspace_id=l.workspace_id AND z.installation_id=l.installation_id AND z.erased_at IS NULL);
  v_live:=v_live-1;
 END IF;
 INSERT INTO morrow_work.agent_notebook_entries(organization_id,workspace_id,installation_id,sequence,id,body,read_tags,run_id,tool_use_id,
  digest,created_at,expires_at,erased_at,erased_reason)
 VALUES (l.organization_id,l.workspace_id,l.installation_id,v_seq,v_id,p_text,v_tags,l.subject_id,p_tool_use_id,morrow_work.sha256_text(p_text),
  v_at,v_at+interval '90 days',NULL,NULL);
 UPDATE morrow_work.agent_notebooks y SET next_sequence=v_seq+1,live_entries=v_live+1,revision=y.revision+1,updated_at=greatest(v_at,y.updated_at)
  WHERE y.organization_id=l.organization_id AND y.workspace_id=l.workspace_id AND y.installation_id=l.installation_id;
 RETURN QUERY SELECT 'applied'::text,v_id,v_seq::text;
END $$;

-- Explicit ACLs per function (S5 reads proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.begin_knowledge_command(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_knowledge_write(text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_knowledge_accept(text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_knowledge_reject(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_knowledge_delete(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.cmd_notebook_clear(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_knowledge_page(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_brand_voice() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_knowledge_search(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_knowledge_propose(text,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.run_notebook_write(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.begin_knowledge_command(text,text,text),
 morrow_work.cmd_knowledge_write(text,text,text,text,text,text,text,text,text,text),
 morrow_work.cmd_knowledge_accept(text,text,text,text,text,text),morrow_work.cmd_knowledge_reject(text,text,text,text,text),
 morrow_work.cmd_knowledge_delete(text,text,text,text,text),morrow_work.cmd_notebook_clear(text,text,text,text) TO morrow_work_api;
GRANT EXECUTE ON FUNCTION morrow_work.run_knowledge_page(text),morrow_work.run_brand_voice(),morrow_work.run_knowledge_search(text),
 morrow_work.run_knowledge_propose(text,text,text,text,text,text,text,text),morrow_work.run_notebook_write(text,text,text)
 TO morrow_runtime_executor;
GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;
ALTER FUNCTION morrow_work.begin_knowledge_command(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_knowledge_write(text,text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_knowledge_accept(text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_knowledge_reject(text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_knowledge_delete(text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_notebook_clear(text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_knowledge_page(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_brand_voice() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_knowledge_search(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_knowledge_propose(text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.run_notebook_write(text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;
COMMIT;
