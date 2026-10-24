BEGIN;
-- v1 PR 4, Undo (build order "Undo, history and the product picker"; ADR-0011; ADR-0022 items 3,
-- 7, 9 and 13; ADR-0024 item 8; ADR-0031 item 1; ADR-0035 item 5). Executes AS
-- morrow_work_owner, after catalog-apply (0045). No external effect: nothing here sends a
-- request, and an undo is applied only through 0045's gateway (a new exact approval, the claim,
-- the dispatch rechecks, the fence and the read-back), never by a shortcut. On the ADR-0010
-- tenant pattern: composite tenant keys, ENABLE and FORCE RLS, definers owned by
-- morrow_work_command.
--   * An undo of one verified catalog_write operation is a NEW catalog.content.publish proposal
--     built from records only: its one target is the same product, store, connection and
--     fields; its expectedSourceRevision is the product as Shopify holds it now (the broker's
--     undo check below read it, found every listing field still as the apply left it and stored
--     that read as a product snapshot); its item sets each field back to the value the draft's
--     own snapshot holds (the values read before the apply: the gateway's pre-send read proved
--     the product equal to that snapshot when it wrote). It is proposed by the store's active
--     Listings installation (0032's catalog_proposal_bind: the only proposer a catalog proposal
--     may have) on behalf of the person who asked, who approves it like any other change.
--   * Undo is offered for 90 days from the apply's send, while the before values are still held
--     (the draft's snapshot follows ADR-0031's product-data clock and shop/redact deletes it;
--     shop/redact also empties the parameters), and never while an earlier undo of the same
--     change is open, uncertain or applied, nor after a later Morrow write to the product.
--   * Tables (content-free, append-only, 365 days): operation_undo_checks, the broker's reads
--     of the product before an undo (the read's digest and per-field codes, never a value);
--     catalog_undos, one row per undo proposal, naming the change it undoes (ids and times).
--   * The broker's login (morrow_vault_broker), keyed by operation id as R1 and R2 are:
--     catalog_undo_resolve and catalog_undo_record (the read's snapshot and its codes).
--   * The api: catalog_undo_states (the history's undo state of a task's changes),
--     catalog_undo_source (what the Worker builds the undo proposal from),
--     catalog_undo_proposer (the proposing installation as the agent kernel would require it:
--     its owner's liveness and grants, its own grant set and any stop) and cmd_catalog_undo
--     (stores it after rechecking every part of it in SQL).
--   * Review F1 (2026-10-25): the Listings installation that proposes an undo must be able to
--     propose it, as a Listings run on that store must (decideDelegation): an active
--     installation whose owner is still a live member holding `propose` on
--     catalog.content.publish over the store resource with the change's fields (decided by the
--     human kernel in the Worker; the owner's grants digest rechecked here under lock), whose
--     own grant set is still exactly its document's, with no stop on runs of that connection
--     or installation. Otherwise the undo is refused before the broker's read and again here.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR to_regprocedure('morrow_work.cmd_catalog_apply(text,text,text,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_vault.catalog_reconcile_record(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_vault.catalog_context(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_vault.catalog_context_clear()') IS NULL
 OR to_regprocedure('morrow_vault.credential_for_connection(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.catalog_target(jsonb,integer)') IS NULL
 OR to_regprocedure('morrow_work.catalog_item(jsonb,integer)') IS NULL
 OR to_regprocedure('morrow_work.catalog_item_matches(jsonb,jsonb)') IS NULL
 OR to_regprocedure('morrow_work.snapshot_matches(text,text)') IS NULL
 OR to_regprocedure('morrow_work.draft_set_valid(text,text[])') IS NULL
 OR to_regprocedure('morrow_work.command_prelude(text,text)') IS NULL
 OR to_regprocedure('morrow_work.append_event(text,text,text,text,text,text,text,bigint,text,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.listings_store_current(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.listings_grant_set(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.stop_active(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.effective_rule(jsonb,text,boolean)') IS NULL
 OR to_regprocedure('morrow_work.db_now()') IS NULL OR to_regprocedure('morrow_work.sha256_text(text)') IS NULL
 OR to_regprocedure('morrow_work.utc_text(timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.utc_parse(text)') IS NULL OR to_regprocedure('morrow_work.json_id(jsonb)') IS NULL
 OR to_regprocedure('morrow_work.catalog_proposal_document_matches(text,text,text,text,text,bigint,text,text,integer[],text,text,text,boolean,text,integer,numeric,text,text,text,text,text[],text,bigint,text,text,text,timestamp with time zone,timestamp with time zone,text,text)') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_read_target(text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_member_authority(text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_agent_grant_set_current(text,text,text,text,jsonb,jsonb)','EXECUTE')
 OR to_regclass('morrow_work.operation_writes') IS NULL OR to_regclass('morrow_work.product_snapshots') IS NULL
 OR to_regclass('morrow_work.operation_undo_checks') IS NOT NULL OR to_regclass('morrow_work.catalog_undos') IS NOT NULL
 THEN RAISE EXCEPTION 'CATALOG_UNDO_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- An undo check's per-field codes: exactly the five listing fields, each `unchanged` (as the
-- apply left it, under the read-back's canonical comparison) or `changed`. IMMUTABLE, owned by
-- the owner; the command role holds EXECUTE because CHECK constraints run with the writer's
-- privileges (the 0015 valid_scope pattern).
CREATE FUNCTION morrow_work.undo_verdicts_valid(p_verdicts jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_verdicts IS NOT NULL AND jsonb_typeof(p_verdicts)='object'
  AND ARRAY(SELECT k FROM jsonb_object_keys(p_verdicts) k ORDER BY k COLLATE "C")=ARRAY['descriptionHtml','seo.description','seo.title','tags','title']
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(p_verdicts) e WHERE jsonb_typeof(e.value)<>'string' OR (e.value#>>'{}') NOT IN ('unchanged','changed'))
$$;
REVOKE ALL ON FUNCTION morrow_work.undo_verdicts_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.undo_verdicts_valid(jsonb) TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- Tables. Every stored time is millisecond-truncated. Content class none: ids, digests, codes
-- and times only.
CREATE TABLE morrow_work.operation_undo_checks (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 operation_id morrow_work.record_id NOT NULL,
 sequence integer NOT NULL CHECK (sequence>=1),
 observed_at timestamptz NOT NULL CHECK (observed_at=date_trunc('milliseconds',observed_at) AND isfinite(observed_at)),
 outcome text NOT NULL CHECK (outcome IN ('read','not_found')),
 current_digest morrow_work.digest,
 field_verdicts jsonb,
 verdict text NOT NULL CHECK (verdict IN ('unchanged','changed','missing')),
 PRIMARY KEY (organization_id,workspace_id,operation_id,sequence),
 FOREIGN KEY (organization_id,workspace_id,operation_id) REFERENCES morrow_work.operations(organization_id,workspace_id,id),
 CONSTRAINT operation_undo_checks_shape CHECK (CASE outcome
  WHEN 'read' THEN current_digest IS NOT NULL AND verdict IN ('unchanged','changed') AND morrow_work.undo_verdicts_valid(field_verdicts)
  ELSE current_digest IS NULL AND field_verdicts IS NULL AND verdict='missing' END)
);
CREATE TABLE morrow_work.catalog_undos (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 proposal_id morrow_work.record_id NOT NULL,
 operation_id morrow_work.record_id NOT NULL,
 check_sequence integer NOT NULL,
 requester_principal_id morrow_work.record_id NOT NULL,
 requester_membership_id morrow_work.record_id NOT NULL,
 command_id morrow_work.record_id NOT NULL CHECK (command_id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 request_digest morrow_work.digest NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 PRIMARY KEY (organization_id,workspace_id,proposal_id),
 UNIQUE (organization_id,workspace_id,requester_principal_id,command_id),
 FOREIGN KEY (organization_id,workspace_id,proposal_id) REFERENCES morrow_work.proposals(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,operation_id) REFERENCES morrow_work.operations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,operation_id,check_sequence)
  REFERENCES morrow_work.operation_undo_checks(organization_id,workspace_id,operation_id,sequence)
);
CREATE INDEX catalog_undos_operation ON morrow_work.catalog_undos (organization_id,workspace_id,operation_id,created_at);
-- The undo state's later-write question (a later Morrow write to the same product).
CREATE INDEX operations_product_writes ON morrow_work.operations (organization_id,workspace_id,store_id,target_resource_id,send_started_at)
 WHERE kind='catalog_write' AND send_started_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row security. Both tables: ENABLE + FORCE and the maintenance-only owner policy.
--   * operation_undo_checks: the session context reads it (tenant_command FOR SELECT: no session
--     definer writes it) and the broker's undo definers reach exactly the operation their own
--     transaction-local setting names (broker_catalog_operation, 0045's shape).
--   * catalog_undos: the session template (cmd_catalog_undo writes it) and the api's read.
-- product_snapshots gains one INSERT policy: the undo check's read, as the broker's login only,
-- for exactly the tenant, store and product its own setting names (morrow.vault_undo_product,
-- written and cleared by catalog_undo_record alone).
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['operation_undo_checks','catalog_undos'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
 END LOOP;
END $$;
CREATE POLICY tenant_command ON morrow_work.operation_undo_checks FOR SELECT TO morrow_work_command
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
CREATE POLICY broker_catalog_operation ON morrow_work.operation_undo_checks TO morrow_work_command
 USING (session_user='morrow_vault_broker' AND operation_id::text=pg_catalog.current_setting('morrow.vault_catalog_operation',true))
 WITH CHECK (session_user='morrow_vault_broker' AND operation_id::text=pg_catalog.current_setting('morrow.vault_catalog_operation',true));
CREATE POLICY tenant_command ON morrow_work.catalog_undos TO morrow_work_command
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
 WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
CREATE POLICY tenant_read ON morrow_work.catalog_undos FOR SELECT TO morrow_work_api
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
CREATE POLICY broker_undo_snapshot ON morrow_work.product_snapshots FOR INSERT TO morrow_work_command
 WITH CHECK (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||store_id::text||'|'||product_id=pg_catalog.current_setting('morrow.vault_undo_product',true));

-- Privileges: SELECT and INSERT, never UPDATE, DELETE or TRUNCATE (append-only); the api reads
-- the undo records column by column.
GRANT SELECT,INSERT ON morrow_work.operation_undo_checks,morrow_work.catalog_undos TO morrow_work_command;
GRANT SELECT (organization_id,workspace_id,proposal_id,operation_id,check_sequence,requester_principal_id,requester_membership_id,command_id,
 request_digest,created_at) ON morrow_work.catalog_undos TO morrow_work_api;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['operation_undo_checks','catalog_undos'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Helpers: owned by the command role after the transfer, granted to nobody (only the definers
-- below call them).
-- The undo's item `set` for a target's fields, from the snapshot its draft was made from: each
-- field back to the value read before the apply (the SEO pair as one object, a missing SEO
-- value as "", as the read-back compares it). Null when the snapshot is not an object.
CREATE FUNCTION morrow_work.catalog_undo_set(p_snapshot jsonb,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v jsonb:='{}'::jsonb;
BEGIN
 IF p_snapshot IS NULL OR p_fields IS NULL OR jsonb_typeof(p_snapshot)<>'object' THEN RETURN NULL; END IF;
 IF 'title'=ANY(p_fields) THEN v:=v||jsonb_build_object('title',p_snapshot->'title'); END IF;
 IF 'descriptionHtml'=ANY(p_fields) THEN v:=v||jsonb_build_object('descriptionHtml',p_snapshot->'descriptionHtml'); END IF;
 IF 'seo.title'=ANY(p_fields) OR 'seo.description'=ANY(p_fields) THEN
  v:=v||jsonb_build_object('seo',jsonb_build_object('title',COALESCE(p_snapshot#>>'{seo,title}',''),
   'description',COALESCE(p_snapshot#>>'{seo,description}','')));
 END IF;
 IF 'tags'=ANY(p_fields) THEN v:=v||jsonb_build_object('tags',p_snapshot->'tags'); END IF;
 RETURN v;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
-- The undo state of one catalog_write operation of the caller's tenant, under the caller's own
-- policies (the session context): none (not verified: an unknown outcome is never undone),
-- undone (an undo of it was applied and verified), requested (an undo of it is pending or
-- approved and unexpired, or claimed and not closed with nothing written: in flight, uncertain
-- or set aside), changed (a later Morrow write to the product was sent: the product changed
-- since this apply), unavailable (more than 90 days after the send, the parameters redacted,
-- or the before values' snapshot gone or past its own clock) or available, with the time it
-- stays available until. No row when the operation is not the tenant's.
CREATE FUNCTION morrow_work.catalog_undo_state(p_org text,p_ws text,p_operation_id text)
RETURNS TABLE(state text,available_until timestamptz,undo_proposal_id text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE o record; p record; q record; s record; u record; v_now timestamptz; v_target jsonb;
BEGIN
 SELECT x.status,x.send_started_at,x.store_id::text AS store_id,x.target_resource_id::text AS product_id,x.target_index,
  x.proposal_id::text AS proposal_id INTO o FROM morrow_work.operations x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_operation_id AND x.kind='catalog_write';
 IF NOT FOUND THEN RETURN; END IF;
 IF o.status<>'verified' OR o.send_started_at IS NULL THEN
  RETURN QUERY SELECT 'none'::text,NULL::timestamptz,NULL::text; RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 FOR u IN SELECT x.proposal_id::text AS proposal_id FROM morrow_work.catalog_undos x
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.operation_id=p_operation_id ORDER BY x.created_at DESC LOOP
  IF EXISTS(SELECT 1 FROM morrow_work.operations y WHERE y.organization_id=p_org AND y.workspace_id=p_ws AND y.kind='catalog_write'
    AND y.claim_family_root_id=u.proposal_id AND y.status='verified') THEN
   RETURN QUERY SELECT 'undone'::text,NULL::timestamptz,u.proposal_id; RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM morrow_work.operations y WHERE y.organization_id=p_org AND y.workspace_id=p_ws AND y.kind='catalog_write'
    AND y.claim_family_root_id=u.proposal_id AND y.status NOT IN ('failed','conflict'))
   OR (NOT EXISTS(SELECT 1 FROM morrow_work.approval_claims c WHERE c.organization_id=p_org AND c.workspace_id=p_ws
     AND c.family_root_id=u.proposal_id)
    AND EXISTS(SELECT 1 FROM morrow_work.approvals a WHERE a.organization_id=p_org AND a.workspace_id=p_ws AND a.family_root_id=u.proposal_id
     AND a.status IN ('pending','approved') AND a.expires_at>v_now)) THEN
   RETURN QUERY SELECT 'requested'::text,NULL::timestamptz,u.proposal_id; RETURN;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM morrow_work.operations y WHERE y.organization_id=p_org AND y.workspace_id=p_ws AND y.kind='catalog_write'
   AND y.store_id=o.store_id AND y.target_resource_id=o.product_id AND y.id<>p_operation_id AND y.send_started_at IS NOT NULL
   AND y.send_started_at>o.send_started_at AND y.status NOT IN ('failed','conflict')) THEN
  RETURN QUERY SELECT 'changed'::text,NULL::timestamptz,NULL::text; RETURN;
 END IF;
 IF o.send_started_at+interval '90 days'<=v_now THEN RETURN QUERY SELECT 'unavailable'::text,NULL::timestamptz,NULL::text; RETURN; END IF;
 SELECT x.canonical,x.parameters_id::text AS parameters_id INTO p FROM morrow_work.proposals x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=o.proposal_id;
 SELECT x.redacted_at INTO q FROM morrow_work.proposal_parameters x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p.parameters_id;
 IF NOT FOUND OR q.redacted_at IS NOT NULL THEN RETURN QUERY SELECT 'unavailable'::text,NULL::timestamptz,NULL::text; RETURN; END IF;
 v_target:=morrow_work.catalog_target(p.canonical::jsonb,o.target_index);
 SELECT x.expires_at INTO s FROM morrow_work.product_snapshots x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=o.store_id
  AND x.digest=v_target->>'expectedSourceRevision' AND x.product_id=o.product_id;
 IF v_target IS NULL OR NOT FOUND OR s.expires_at<=v_now THEN
  RETURN QUERY SELECT 'unavailable'::text,NULL::timestamptz,NULL::text; RETURN;
 END IF;
 RETURN QUERY SELECT 'available'::text,least(o.send_started_at+interval '90 days',s.expires_at),NULL::text;
END $$;
-- The installation that would propose an undo on this store and connection (review F1): the
-- store's active morrow.listings installation through that connection (no row when there is
-- none), with what the agent kernel requires of it before a Listings run may propose there
-- (decideDelegation; spine §5): owner_live, the owner is still that installation owner's
-- membership, an active human member of the active organization and workspace
-- (work_member_authority); owner_grants, that member's catalog.content.publish grants (by id;
-- the kernel in the Worker decides `propose` over them; never interpreted here) with their
-- digest, and owner_grant_count 1001 when the member holds more than 1,000 grants (the Worker
-- denies); agent_grant_set, whether the agent principal is active and its grants are still
-- exactly the installation's document (work_agent_grant_set_current: exact, differs, invalid
-- or denied); stopped, whether a stop blocks runs on the connection or the installation
-- (stop_active). Run in the caller's session (the grant-set check resolves its context).
CREATE FUNCTION morrow_work.catalog_undo_proposer_facts(p_org text,p_ws text,p_store text,p_connection text)
RETURNS TABLE(installation_id text,agent_principal_id text,scope jsonb,owner_principal_id text,owner_membership_id text,owner_live boolean,
 owner_grants jsonb,owner_grant_count integer,owner_grants_digest text,agent_grant_set text,stopped boolean)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE i record; m record; v_live boolean:=false; v_grants jsonb:='[]'::jsonb; v_count integer:=0; v_set text;
BEGIN
 SELECT x.id::text AS id,x.agent_principal_id::text AS agent_principal_id,x.scope,x.grant_refs,x.owner_principal_id::text AS owner_principal_id,
  x.owner_membership_id::text AS owner_membership_id INTO i FROM morrow_work.agent_installations x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.status='active' AND x.release_id='morrow.listings' AND x.store_id=p_store
   AND x.connection_id=p_connection;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT a.membership_id,a.grants,a.grant_count INTO m FROM morrow_identity.work_member_authority(p_org,p_ws,i.owner_principal_id) a;
 IF FOUND AND m.membership_id=i.owner_membership_id THEN
  v_live:=true;
  SELECT COALESCE(jsonb_agg(q.g ORDER BY q.n),'[]'::jsonb),count(*)::integer INTO v_grants,v_count
   FROM jsonb_array_elements(m.grants) WITH ORDINALITY q(g,n) WHERE q.g->>'capabilityId'='catalog.content.publish';
  IF m.grant_count>1000 THEN v_count:=1001; END IF;
 END IF;
 SELECT g.outcome INTO v_set FROM morrow_identity.work_agent_grant_set_current(p_org,p_ws,i.id,i.agent_principal_id,i.grant_refs,
  morrow_work.listings_grant_set(p_org,p_ws,p_store,p_connection)) g;
 RETURN QUERY SELECT i.id,i.agent_principal_id,i.scope,i.owner_principal_id,i.owner_membership_id,v_live,v_grants,v_count,
  encode(sha256(convert_to(v_grants::text,'UTF8')),'hex'),COALESCE(v_set,'denied'),
  morrow_work.stop_active(p_org,p_ws,'run',p_connection,i.id);
END $$;

-- ---------------------------------------------------------------------------
-- API functions: SECURITY DEFINER, owned by the command role after the transfer, EXECUTE for
-- morrow_work_api only. Tenant and actor come only from current_tenant(). The Worker first
-- requires that the person may read the operation's proposal and holds `view` on
-- catalog.products.read on the store resource (the kernel, in code).
--
-- The history's undo state of a task's catalog changes (at most 100, the operations read's
-- order): per operation, its state and until when, the open or applied undo proposal, and, for
-- an operation that applied an undo, the operation it undid. Ids, codes and times only.
CREATE FUNCTION morrow_work.catalog_undo_states(p_task_id text)
RETURNS TABLE(operation_id text,state text,available_until text,undo_proposal_id text,undo_of_operation_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; o record; st record; v_of text;
BEGIN
 IF p_task_id IS NULL OR p_task_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 FOR o IN SELECT x.id::text AS id,x.claim_family_root_id::text AS family_root_id FROM morrow_work.operations x
   WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.task_id=p_task_id AND x.kind='catalog_write'
   ORDER BY x.created_at DESC,x.target_index LIMIT 100 LOOP
  SELECT * INTO st FROM morrow_work.catalog_undo_state(t.organization_id,t.workspace_id,o.id);
  SELECT u.operation_id::text INTO v_of FROM morrow_work.catalog_undos u
   WHERE u.organization_id=t.organization_id AND u.workspace_id=t.workspace_id AND u.proposal_id=o.family_root_id;
  IF NOT FOUND THEN v_of:=NULL; END IF;
  RETURN QUERY SELECT o.id,st.state,morrow_work.utc_text(st.available_until),st.undo_proposal_id,v_of;
 END LOOP;
END $$;

-- What the Worker builds one undo proposal from: the operation's undo state (as above) and,
-- only while it is available, the draft's snapshot (the values read before the apply: store
-- content, for this tenant's own session after the Worker's read rule) and the operation's
-- latest undo check (its sequence, the read's digest, its codes and time). No row when the
-- operation is not the tenant's catalog_write operation.
CREATE FUNCTION morrow_work.catalog_undo_source(p_operation_id text)
RETURNS TABLE(state text,available_until text,undo_proposal_id text,before_snapshot text,check_sequence text,check_digest text,
 check_verdict text,check_fields text,check_observed_at text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; o record; st record; k record; v_target jsonb; v_snapshot text;
BEGIN
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO st FROM morrow_work.catalog_undo_state(t.organization_id,t.workspace_id,p_operation_id);
 IF NOT FOUND THEN RETURN; END IF;
 IF st.state='available' THEN
  SELECT x.store_id::text AS store_id,x.target_resource_id::text AS product_id,x.target_index,p.canonical INTO o
   FROM morrow_work.operations x JOIN morrow_work.proposals p ON p.organization_id=x.organization_id AND p.workspace_id=x.workspace_id
    AND p.id=x.proposal_id
   WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=p_operation_id;
  v_target:=morrow_work.catalog_target(o.canonical::jsonb,o.target_index);
  SELECT x.canonical INTO v_snapshot FROM morrow_work.product_snapshots x WHERE x.organization_id=t.organization_id
   AND x.workspace_id=t.workspace_id AND x.store_id=o.store_id AND x.digest=v_target->>'expectedSourceRevision' AND x.product_id=o.product_id;
 END IF;
 SELECT x.sequence,x.current_digest::text AS digest,x.verdict,x.field_verdicts::text AS fields,x.observed_at INTO k
  FROM morrow_work.operation_undo_checks x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
   AND x.operation_id=p_operation_id ORDER BY x.sequence DESC LIMIT 1;
 RETURN QUERY SELECT st.state,morrow_work.utc_text(st.available_until),st.undo_proposal_id,v_snapshot,k.sequence::text,k.digest,k.verdict,
  k.fields,morrow_work.utc_text(k.observed_at);
END $$;

-- The installation that would propose an undo of one of the tenant's catalog_write operations
-- (catalog_undo_proposer_facts on the operation's store and connection; review F1), for the
-- Worker's kernel before the broker's read: ids, the installation's scope, the owner's
-- catalog.content.publish grants and their digest, and codes. No row when the operation is
-- not the tenant's catalog_write operation or the store has no active Listings installation
-- through its connection. The Worker calls it only after the person's own checks.
CREATE FUNCTION morrow_work.catalog_undo_proposer(p_operation_id text)
RETURNS TABLE(installation_id text,agent_principal_id text,scope text,owner_principal_id text,owner_membership_id text,owner_live text,
 owner_grants text,owner_grant_count text,owner_grants_digest text,agent_grant_set text,stopped text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; o record;
BEGIN
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT x.store_id::text AS store_id,x.connection_id::text AS connection_id INTO o FROM morrow_work.operations x
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=p_operation_id AND x.kind='catalog_write';
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT f.installation_id,f.agent_principal_id,f.scope::text,f.owner_principal_id,f.owner_membership_id,f.owner_live::text,
  f.owner_grants::text,f.owner_grant_count::text,f.owner_grants_digest,f.agent_grant_set,f.stopped::text
  FROM morrow_work.catalog_undo_proposer_facts(t.organization_id,t.workspace_id,o.store_id,o.connection_id) f;
END $$;

-- The undo (ADR-0011; ADR-0022 item 3; ADR-0024 item 8): one catalog.content.publish
-- Proposal@2 that undoes one verified catalog_write operation, after the Worker's checks (the
-- person reads the operation's proposal, holds `view` on catalog.products.read and `propose`
-- and `delegate` on catalog.content.publish on the store resource with the target's fields)
-- and after the broker's undo check (catalog_undo_record). Under the prelude, the stop
-- interlock (shared, in lease_open's order, after the stream: shop/redact holds the store's key
-- from its system stop through its redaction pass, so these parameters are either emptied by
-- that pass or never written) and the operation's row lock, it rechecks everything data-only:
-- the operation is the tenant's, verified and available (catalog_undo_state: no open, uncertain
-- or applied undo of it, no later write, within 90 days, the before values held); its latest
-- undo check is the one named, read at most 10 minutes ago, every field unchanged, and its read
-- is stored as a snapshot; the proposal has exactly one target (the same product, store,
-- connection and fields, the check's digest as expectedSourceRevision) and the item that sets
-- each field back to the draft snapshot's value (draft_set_valid, else not_reversible); the
-- store is still linked through that connection; it is proposed by the store's active Listings
-- installation through its agent principal for this person, and that installation may still
-- propose (review F1, catalog_undo_proposer_facts): no stop on runs of the connection or the
-- installation (stopped); its owner still a live member and its own grant set exact
-- (installation_inactive); the owner's catalog.content.publish grants exactly those the
-- Worker's kernel decided on (p_owner_grants_digest), none expired since that decision
-- (stale_authority); the task is the operation's; the workspace's current review policy
-- (never seeded here), its 1,000 pending cap and 0032's document check. Writes the parameters, the proposal, its pending approval, the undo record
-- and one proposal.submitted event whose actor is the person. The same person's same command
-- (Idempotency-Key and request digest) answers replayed with the recorded result.
-- Outcomes: applied, replayed, the prelude's, not_found, not_applied, already_requested,
-- already_undone, changed_since_apply, unavailable, check_stale, product_missing,
-- not_reversible, link_changed, installation_inactive, stopped, limit_reached, stale_authority,
-- command_conflict, invalid.
CREATE FUNCTION morrow_work.cmd_catalog_undo(p_command_id text,p_request_digest text,p_operation_id text,p_check_sequence text,
 p_approval_id text,p_policy_digest text,p_parameters_canonical text,p_parameters_digest text,p_proposal_canonical text,
 p_proposal_digest text,p_scope_canonical text,p_owner_grants_digest text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 pre record; o record; u record; st record; k record; s record; cap record; pol record; ins record; p record;
 d jsonb; v_params jsonb; v_created timestamptz; v_expires timestamptz; v_now timestamptz; v_id text; v_parameters_id text;
 v_risk text; v_rule jsonb; v_approval_expires timestamptz; v_list text[]; v_org_revision bigint; v_target jsonb; v_fields text[];
 v_sorted text[]; v_set jsonb; v_targets jsonb; v_items jsonb; v_sequence integer; v_result jsonb; v_expired boolean;
BEGIN
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_check_sequence IS NULL OR p_check_sequence !~ '^[1-9][0-9]{0,8}$'
  OR p_owner_grants_digest IS NULL OR p_owner_grants_digest !~ '^[a-f0-9]{64}$'
  OR p_approval_id IS NULL OR p_approval_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_policy_digest IS NULL OR p_policy_digest !~ '^[a-f0-9]{64}$'
  OR p_parameters_canonical IS NULL OR octet_length(p_parameters_canonical) NOT BETWEEN 2 AND 32768 OR NOT pg_input_is_valid(p_parameters_canonical,'jsonb')
  OR p_parameters_digest IS NULL OR p_parameters_digest !~ '^[a-f0-9]{64}$'
  OR p_proposal_canonical IS NULL OR octet_length(p_proposal_canonical)>131072 OR NOT pg_input_is_valid(p_proposal_canonical,'jsonb')
  OR p_proposal_digest IS NULL OR p_proposal_digest !~ '^[a-f0-9]{64}$'
  OR p_scope_canonical IS NULL OR octet_length(p_scope_canonical)>16384 OR NOT pg_input_is_valid(p_scope_canonical,'jsonb') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF morrow_work.sha256_text(p_parameters_canonical)<>p_parameters_digest OR morrow_work.sha256_text(p_proposal_canonical)<>p_proposal_digest THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 d:=p_proposal_canonical::jsonb; v_params:=p_parameters_canonical::jsonb;
 IF jsonb_typeof(d)<>'object' OR jsonb_typeof(v_params)<>'object' OR NOT morrow_work.json_id(d->'id')
  OR NOT morrow_work.json_id(d#>'{parametersRef,id}') OR jsonb_typeof(d->'createdAt')<>'string' OR jsonb_typeof(d->'expiresAt')<>'string' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_created:=morrow_work.utc_parse(d->>'createdAt'); v_expires:=morrow_work.utc_parse(d->>'expiresAt');
 IF v_created IS NULL OR v_expires IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 v_id:=d->>'id'; v_parameters_id:=d#>>'{parametersRef,id}'; v_sequence:=p_check_sequence::integer;
 SELECT * INTO pre FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF pre.outcome IS DISTINCT FROM 'ok' THEN RETURN QUERY SELECT COALESCE(pre.outcome,'invalid'),NULL::text; RETURN; END IF;
 -- The same person's same command: replayed with its recorded result, or command_conflict.
 SELECT x.proposal_id::text AS proposal_id,x.operation_id::text AS operation_id,x.request_digest::text AS request_digest INTO u
  FROM morrow_work.catalog_undos x WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id
   AND x.requester_principal_id=pre.principal_id AND x.command_id=p_command_id;
 IF FOUND THEN
  IF u.request_digest<>p_request_digest THEN RETURN QUERY SELECT 'command_conflict'::text,NULL::text; RETURN; END IF;
  SELECT x.digest::text AS digest,a.id::text AS approval_id,a.status,a.expires_at INTO p FROM morrow_work.proposals x
   JOIN morrow_work.approvals a ON a.organization_id=x.organization_id AND a.workspace_id=x.workspace_id AND a.proposal_id=x.id
   WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id AND x.id=u.proposal_id;
  RETURN QUERY SELECT 'replayed'::text,jsonb_build_object('proposalId',u.proposal_id,'proposalDigest',p.digest,'approvalId',p.approval_id,
   'status',p.status,'expiresAt',morrow_work.utc_text(p.expires_at),'operationId',u.operation_id)::text;
  RETURN;
 END IF;
 SELECT x.store_id::text AS store_id INTO o FROM morrow_work.operations x
  WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id AND x.id=p_operation_id AND x.kind='catalog_write';
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
  pre.organization_id,pre.workspace_id,o.store_id)::text,0));
 SELECT x.store_id::text AS store_id,x.connection_id::text AS connection_id,x.target_resource_id::text AS product_id,x.target_index,
  x.task_id::text AS task_id,x.proposal_id::text AS proposal_id INTO o FROM morrow_work.operations x
  WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id AND x.id=p_operation_id FOR UPDATE;
 SELECT * INTO st FROM morrow_work.catalog_undo_state(pre.organization_id,pre.workspace_id,p_operation_id);
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF st.state<>'available' THEN
  RETURN QUERY SELECT CASE st.state WHEN 'none' THEN 'not_applied' WHEN 'requested' THEN 'already_requested'
   WHEN 'undone' THEN 'already_undone' WHEN 'changed' THEN 'changed_since_apply' ELSE 'unavailable' END,
   jsonb_build_object('undoProposalId',st.undo_proposal_id)::text;
  RETURN;
 END IF;
 v_now:=morrow_work.db_now();
 IF v_created<date_trunc('milliseconds',transaction_timestamp()) OR v_created>v_now THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 -- The latest undo check: the one named, read at most 10 minutes ago, every field unchanged,
 -- and its read stored as an unexpired snapshot of this product.
 SELECT x.sequence,x.current_digest::text AS digest,x.verdict,x.observed_at INTO k FROM morrow_work.operation_undo_checks x
  WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id AND x.operation_id=p_operation_id
  ORDER BY x.sequence DESC LIMIT 1;
 IF NOT FOUND OR k.sequence<>v_sequence OR k.observed_at<=v_now-interval '10 minutes' THEN
  RETURN QUERY SELECT 'check_stale'::text,NULL::text; RETURN;
 END IF;
 IF k.verdict='missing' THEN RETURN QUERY SELECT 'product_missing'::text,NULL::text; RETURN; END IF;
 IF k.verdict<>'unchanged' THEN RETURN QUERY SELECT 'changed_since_apply'::text,NULL::text; RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_work.product_snapshots x WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id
   AND x.store_id=o.store_id AND x.digest=k.digest AND x.product_id=o.product_id AND x.expires_at>v_now) THEN
  RETURN QUERY SELECT 'check_stale'::text,NULL::text; RETURN;
 END IF;
 -- The original target and the values read before the apply (catalog_undo_state proved both).
 SELECT x.canonical INTO p FROM morrow_work.proposals x
  WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id AND x.id=o.proposal_id;
 v_target:=morrow_work.catalog_target(p.canonical::jsonb,o.target_index);
 IF v_target IS NULL OR jsonb_typeof(v_target->'fields')<>'array' THEN RETURN QUERY SELECT 'unavailable'::text,NULL::text; RETURN; END IF;
 v_fields:=ARRAY(SELECT f FROM jsonb_array_elements_text(v_target->'fields') WITH ORDINALITY q(f,n) ORDER BY n);
 v_sorted:=ARRAY(SELECT f FROM unnest(v_fields) f ORDER BY f COLLATE "C");
 SELECT x.canonical INTO s FROM morrow_work.product_snapshots x WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id
  AND x.store_id=o.store_id AND x.digest=v_target->>'expectedSourceRevision' AND x.product_id=o.product_id AND x.expires_at>v_now;
 IF NOT FOUND THEN RETURN QUERY SELECT 'unavailable'::text,NULL::text; RETURN; END IF;
 v_set:=morrow_work.catalog_undo_set(s.canonical::jsonb,v_fields);
 IF v_set IS NULL OR NOT morrow_work.draft_set_valid(v_set::text,v_sorted) THEN
  RETURN QUERY SELECT 'not_reversible'::text,NULL::text; RETURN;
 END IF;
 -- The link through the operation's connection and the store's active Listings installation.
 IF NOT EXISTS(SELECT 1 FROM morrow_work.listings_store_current(pre.organization_id,pre.workspace_id,o.store_id) x
   WHERE x.connection_id=o.connection_id) THEN
  RETURN QUERY SELECT 'link_changed'::text,NULL::text; RETURN;
 END IF;
 -- Review F1: that installation may still propose here, as the agent kernel requires of a
 -- Listings run (under the stop keys and the row lock, after the prelude: a new statement sees
 -- any stop, removal or grant change that committed before it).
 SELECT f.installation_id AS id,f.agent_principal_id,f.owner_live,f.owner_grants,f.owner_grants_digest,f.agent_grant_set,f.stopped INTO ins
  FROM morrow_work.catalog_undo_proposer_facts(pre.organization_id,pre.workspace_id,o.store_id,o.connection_id) f;
 IF NOT FOUND THEN RETURN QUERY SELECT 'installation_inactive'::text,NULL::text; RETURN; END IF;
 IF ins.stopped THEN RETURN QUERY SELECT 'stopped'::text,NULL::text; RETURN; END IF;
 IF NOT ins.owner_live OR ins.agent_grant_set IS DISTINCT FROM 'exact' THEN
  RETURN QUERY SELECT 'installation_inactive'::text,NULL::text; RETURN;
 END IF;
 IF ins.owner_grants_digest IS DISTINCT FROM p_owner_grants_digest THEN RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN; END IF;
 -- An owner grant that expired after the Worker's decision (work_lock_and_recheck's rule, from
 -- this transaction's own context snapshot).
 BEGIN
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(ins.owner_grants) g WHERE g->'expiresAt'<>'null'::jsonb
   AND (g->>'expiresAt')::timestamptz<=pg_catalog.clock_timestamp()
   AND (g->>'expiresAt')::timestamptz>timestamptz 'epoch'+(pg_catalog.current_setting('morrow.work_evaluated_at_us',true)||' microseconds')::interval)
   INTO v_expired;
 EXCEPTION WHEN OTHERS THEN v_expired:=NULL;
 END;
 IF v_expired IS NOT FALSE THEN RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN; END IF;
 -- The one target and item this undo must be.
 v_targets:=jsonb_build_array(jsonb_build_object('resource',jsonb_build_object('organizationId',pre.organization_id,
  'workspaceId',pre.workspace_id,'storeId',o.store_id,'connectionId',o.connection_id,'kind','product','id',o.product_id),
  'expectedSourceRevision',k.digest,'fields',to_jsonb(v_fields),'maximumCredits','0','maximumCost',NULL));
 v_items:=jsonb_build_array(jsonb_build_object('targetIndex',0,'productId',o.product_id,'set',v_set));
 IF d->'targets' IS DISTINCT FROM v_targets
  OR v_params IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'storeId',o.store_id,'items',v_items)
  OR d->>'capabilityId' IS DISTINCT FROM 'catalog.content.publish' OR d->'taskId' IS DISTINCT FROM to_jsonb(o.task_id)
  OR d->'storeId' IS DISTINCT FROM to_jsonb(o.store_id) OR d->'derivedFrom' IS DISTINCT FROM 'null'::jsonb
  OR d->'beneficiaryPrincipalIds' IS DISTINCT FROM '[]'::jsonb OR d->'partialApproval' IS DISTINCT FROM '"allowed"'::jsonb THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT x.effect,x.irreversible,x.review_required,x.kill_switch INTO cap FROM morrow_work.review_capabilities x
  WHERE x.capability_id='catalog.content.publish';
 IF NOT FOUND OR NOT cap.review_required OR cap.kill_switch THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT x.risk INTO v_risk FROM morrow_work.review_risk_by_effect x WHERE x.effect=cap.effect;
 SELECT c.policy_revision INTO v_org_revision FROM morrow_work.current_tenant() c;
 -- The workspace's current review policy, never seeded here (a store that applied a change
 -- has one); a newer one than the Worker read is stale_authority.
 SELECT x.revision::bigint AS revision,x.digest::text AS digest,x.rules INTO pol FROM morrow_work.review_policies x
  WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id AND x.id='review-policy' ORDER BY x.revision DESC LIMIT 1;
 IF NOT FOUND THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 IF pol.digest<>p_policy_digest THEN RETURN QUERY SELECT 'stale_authority'::text,NULL::text; RETURN; END IF;
 IF (SELECT count(*) FROM morrow_work.approvals x WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id
   AND x.status='pending' AND x.expires_at>v_now AND x.review_policy_revision=pol.revision)>=1000 THEN
  RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
 END IF;
 v_rule:=morrow_work.effective_rule(pol.rules,v_risk,cap.irreversible);
 IF v_expires<>v_created+make_interval(secs=>(v_rule->>'pendingExpirySeconds')::integer+(pol.rules#>>'{soloOwner,coolDownSeconds}')::integer
   +(v_rule->>'approvedValiditySeconds')::integer)
  OR NOT morrow_work.catalog_proposal_document_matches(p_proposal_canonical,p_scope_canonical,pre.organization_id,pre.workspace_id,v_id,1,NULL,
   NULL,NULL,o.task_id,'catalog.content.publish',v_risk,cap.irreversible,'allowed',1,0,ins.agent_principal_id,ins.id,pre.principal_id,
   pre.membership_id,ARRAY[]::text[],'review-policy',pol.revision,pol.digest,v_parameters_id,p_parameters_digest,v_expires,v_created,
   o.store_id,o.connection_id) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_approval_expires:=least(v_expires,v_created+make_interval(secs=>(v_rule->>'pendingExpirySeconds')::integer));
 IF v_rule->'eligibleReviewerPrincipalIds'<>'null'::jsonb THEN
  v_list:=ARRAY(SELECT e FROM jsonb_array_elements_text(v_rule->'eligibleReviewerPrincipalIds') WITH ORDINALITY q(e,n) ORDER BY n);
 END IF;
 BEGIN
  INSERT INTO morrow_work.proposal_parameters(organization_id,workspace_id,id,canonical,digest,created_at)
  VALUES (pre.organization_id,pre.workspace_id,v_parameters_id,p_parameters_canonical,p_parameters_digest,v_created);
  INSERT INTO morrow_work.proposals(organization_id,workspace_id,id,revision,family_root_id,derived_from_id,derived_from_digest,selected_target_indexes,
   task_id,capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,proposer_principal_id,proposer_membership_id,
   requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,review_policy_digest,
   parameters_id,parameters_digest,canonical,digest,scope_canonical,scope_digest,expires_at,created_at,store_id,connection_id,proposer_kind,
   proposer_installation_id)
  VALUES (pre.organization_id,pre.workspace_id,v_id,1,v_id,NULL,NULL,NULL,o.task_id,'catalog.content.publish',v_risk,cap.irreversible,'allowed',
   1,0,ins.agent_principal_id,NULL,pre.principal_id,pre.membership_id,ARRAY[]::text[],'review-policy',pol.revision,pol.digest,v_parameters_id,
   p_parameters_digest,p_proposal_canonical,p_proposal_digest,p_scope_canonical,morrow_work.sha256_text(p_scope_canonical),v_expires,v_created,
   o.store_id,o.connection_id,'agent',ins.id);
  INSERT INTO morrow_work.approvals(organization_id,workspace_id,id,revision,proposal_id,proposal_digest,family_root_id,status,required_approvals,
   self_approval,pending_expiry_seconds,approved_validity_seconds,cool_down_seconds,quiet_period_seconds,eligible_reviewer_principal_ids,
   counted_reviewer_principal_ids,scope_digest,review_policy_revision,policy_revision,effective_at,expires_at,invalidation_reason,created_at,updated_at)
  VALUES (pre.organization_id,pre.workspace_id,p_approval_id,1,v_id,p_proposal_digest,v_id,'pending',(v_rule->>'requiredApprovals')::integer,
   v_rule->>'selfApproval',(v_rule->>'pendingExpirySeconds')::integer,(v_rule->>'approvedValiditySeconds')::integer,
   (pol.rules#>>'{soloOwner,coolDownSeconds}')::integer,(pol.rules#>>'{soloOwner,quietPeriodSeconds}')::integer,v_list,NULL,
   morrow_work.sha256_text(p_scope_canonical),pol.revision,v_org_revision,NULL,v_approval_expires,NULL,v_created,v_created);
  INSERT INTO morrow_work.catalog_undos(organization_id,workspace_id,proposal_id,operation_id,check_sequence,requester_principal_id,
   requester_membership_id,command_id,request_digest,created_at)
  VALUES (pre.organization_id,pre.workspace_id,v_id,p_operation_id,v_sequence,pre.principal_id,pre.membership_id,p_command_id,p_request_digest,
   v_created);
 EXCEPTION WHEN check_violation OR raise_exception OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 PERFORM morrow_work.append_event(pre.organization_id,pre.workspace_id,pre.principal_id,pre.membership_id,'proposal.submitted','proposal',
  v_id,1,o.task_id,jsonb_build_object('approvalId',p_approval_id,'risk',v_risk,'targetCount',1),p_command_id,v_now);
 v_result:=jsonb_build_object('proposalId',v_id,'proposalDigest',p_proposal_digest,'approvalId',p_approval_id,'status','pending',
  'expiresAt',morrow_work.utc_text(v_approval_expires),'operationId',p_operation_id);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- ---------------------------------------------------------------------------
-- The broker's undo definers: SECURITY DEFINER, owned by the command role after the transfer,
-- EXECUTE for morrow_vault_broker only, guarded by work_executor_safe. Each takes the operation
-- id (and closed codes and the read) only and loads everything else itself, as R1 and R2 do,
-- writing 0045's context settings (catalog_context) before reading and clearing them before
-- returning. Neither is blocked by a stop or the apply switch: the check only reads, and the
-- undo it prepares is applied through the gateway, which is.
--
-- U1, the check's resolution for one verified catalog_write operation within 90 days of its
-- send, at most once every 10 seconds (too_soon): the shop, the product, the target's fields,
-- the approved item, the draft's snapshot (the values read before the apply) and the token's
-- envelope. Outcomes: resolved, not_applied, unavailable (past 90 days, the parameters
-- redacted, the snapshot gone), too_soon, link_changed, credential_unavailable, not_found,
-- invalid, denied.
CREATE FUNCTION morrow_vault.catalog_undo_resolve(p_operation_id text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,shop_domain text,product_id text,fields text,item text,source text,
 store_installation_id text,credential_id text,credential_version text,kek_version text,wrapped_key text,sealed_value text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE o record; p record; q record; s record; t record; c record; v_now timestamptz; v_last timestamptz; v_target jsonb; v_item jsonb;
 v_outcome text;
BEGIN
 <<resolve>>
 BEGIN
  IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN v_outcome:='denied'; EXIT resolve; END IF;
  IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN v_outcome:='invalid'; EXIT resolve; END IF;
  PERFORM morrow_vault.catalog_context(p_operation_id,NULL,NULL,NULL,NULL);
  SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.status,x.send_started_at,x.store_id::text AS store_id,
   x.connection_id::text AS connection_id,x.target_resource_id::text AS product_id,x.target_index,x.proposal_id::text AS proposal_id INTO o
   FROM morrow_work.operations x WHERE x.id=p_operation_id AND x.kind='catalog_write';
  IF NOT FOUND THEN v_outcome:='not_found'; EXIT resolve; END IF;
  PERFORM morrow_vault.catalog_context(p_operation_id,o.organization_id,o.workspace_id,NULL,NULL);
  v_now:=pg_catalog.clock_timestamp();
  IF o.status<>'verified' OR o.send_started_at IS NULL THEN v_outcome:='not_applied'; EXIT resolve; END IF;
  IF o.send_started_at+interval '90 days'<=v_now THEN v_outcome:='unavailable'; EXIT resolve; END IF;
  SELECT max(x.observed_at) INTO v_last FROM morrow_work.operation_undo_checks x
   WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.operation_id=p_operation_id;
  IF v_last IS NOT NULL AND v_last>v_now-interval '10 seconds' THEN v_outcome:='too_soon'; EXIT resolve; END IF;
  SELECT x.canonical,x.parameters_id::text AS parameters_id INTO p FROM morrow_work.proposals x
   WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.id=o.proposal_id;
  SELECT x.canonical,x.redacted_at INTO q FROM morrow_work.proposal_parameters x
   WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.id=p.parameters_id;
  IF NOT FOUND OR q.redacted_at IS NOT NULL THEN v_outcome:='unavailable'; EXIT resolve; END IF;
  v_target:=morrow_work.catalog_target(p.canonical::jsonb,o.target_index);
  v_item:=morrow_work.catalog_item(q.canonical::jsonb,o.target_index);
  IF v_target IS NULL OR v_item IS NULL OR NOT morrow_work.catalog_item_matches(v_item,v_target) THEN v_outcome:='unavailable'; EXIT resolve; END IF;
  SELECT x.canonical INTO s FROM morrow_work.product_snapshots x WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id
   AND x.store_id=o.store_id AND x.digest=v_target->>'expectedSourceRevision' AND x.product_id=o.product_id AND x.expires_at>v_now;
  IF NOT FOUND THEN v_outcome:='unavailable'; EXIT resolve; END IF;
  IF NOT EXISTS(SELECT 1 FROM morrow_work.listings_store_current(o.organization_id,o.workspace_id,o.store_id) x
    WHERE x.connection_id=o.connection_id) THEN v_outcome:='link_changed'; EXIT resolve; END IF;
  SELECT * INTO t FROM morrow_identity.work_shopify_read_target(o.organization_id,o.workspace_id,o.store_id,o.connection_id);
  IF t.outcome IS DISTINCT FROM 'found' THEN v_outcome:='link_changed'; EXIT resolve; END IF;
  SELECT * INTO c FROM morrow_vault.credential_for_connection(o.organization_id,o.workspace_id,t.installation_id);
  IF c.outcome IS DISTINCT FROM 'found' OR c.credential_id IS DISTINCT FROM t.credential_id THEN v_outcome:='credential_unavailable'; EXIT resolve; END IF;
  v_outcome:='resolved';
 END resolve;
 PERFORM morrow_vault.catalog_context_clear();
 IF v_outcome='resolved' THEN
  RETURN QUERY SELECT 'resolved'::text,o.organization_id,o.workspace_id,t.shop_domain,o.product_id,
   array_to_string(ARRAY(SELECT jsonb_array_elements_text(v_target->'fields')),','),v_item::text,s.canonical,t.installation_id,c.credential_id,
   c.version,c.kek_version,c.wrapped_key,c.sealed_value;
 ELSE
  RETURN QUERY SELECT v_outcome,CASE WHEN v_outcome IN ('denied','invalid','not_found') THEN NULL ELSE o.organization_id END,
   CASE WHEN v_outcome IN ('denied','invalid','not_found') THEN NULL ELSE o.workspace_id END,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
 END IF;
END $$;

-- U2, one check's record. Lock order as T2: the stop interlock shared (platform, then the
-- store; shop/redact holds the store's key exclusively, so its redaction pass either deletes
-- this snapshot or committed first and this sees the store unlinked), then the operation's
-- row. Rechecks U1's conditions, then: a read is a snapshot of exactly this product's five
-- listing fields (snapshot_matches, at most 64 KiB), stored content-addressed (store content,
-- 90 days from this read, deleted at shop/redact; an existing row with the same digest is
-- kept), with the five fields' codes and the overall verdict (unchanged only when every field
-- is); a product Shopify no longer has is `missing`. Outcomes: recorded (with the sequence and
-- verdict), too_soon, not_applied, unavailable, link_changed, not_found, invalid, denied.
CREATE FUNCTION morrow_vault.catalog_undo_record(p_operation_id text,p_outcome text,p_snapshot text,p_field_verdicts text,p_verdict text)
RETURNS TABLE(outcome text,sequence text,verdict text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE o record; v_now timestamptz; v_last timestamptz; v_verdicts jsonb; v_digest text; v_sequence integer; v_outcome text;
BEGIN
 <<undo_check>>
 BEGIN
  IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN v_outcome:='denied'; EXIT undo_check; END IF;
  IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   OR p_outcome IS NULL OR p_outcome NOT IN ('read','not_found')
   OR (p_outcome='read')<>(p_snapshot IS NOT NULL) OR (p_outcome='read')<>(p_field_verdicts IS NOT NULL)
   OR (p_outcome='read' AND (p_verdict IS NULL OR p_verdict NOT IN ('unchanged','changed')))
   OR (p_outcome='not_found' AND p_verdict IS DISTINCT FROM 'missing')
   OR (p_snapshot IS NOT NULL AND octet_length(p_snapshot)>65536)
   OR (p_field_verdicts IS NOT NULL AND (octet_length(p_field_verdicts)>512 OR NOT pg_input_is_valid(p_field_verdicts,'jsonb'))) THEN
   v_outcome:='invalid'; EXIT undo_check;
  END IF;
  IF p_outcome='read' THEN
   v_verdicts:=p_field_verdicts::jsonb;
   IF NOT morrow_work.undo_verdicts_valid(v_verdicts) OR p_verdict<>(CASE WHEN NOT EXISTS(SELECT 1 FROM jsonb_each(v_verdicts) e
     WHERE e.value<>'"unchanged"'::jsonb) THEN 'unchanged' ELSE 'changed' END) THEN v_outcome:='invalid'; EXIT undo_check; END IF;
  END IF;
  PERFORM morrow_vault.catalog_context(p_operation_id,NULL,NULL,NULL,NULL);
  SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.store_id::text AS store_id INTO o
   FROM morrow_work.operations x WHERE x.id=p_operation_id AND x.kind='catalog_write';
  IF NOT FOUND THEN v_outcome:='not_found'; EXIT undo_check; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
   o.organization_id,o.workspace_id,o.store_id)::text,0));
  PERFORM morrow_vault.catalog_context(p_operation_id,o.organization_id,o.workspace_id,NULL,NULL);
  SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.status,x.send_started_at,x.store_id::text AS store_id,
   x.connection_id::text AS connection_id,x.target_resource_id::text AS product_id INTO o
   FROM morrow_work.operations x WHERE x.id=p_operation_id FOR UPDATE;
  v_now:=date_trunc('milliseconds',pg_catalog.clock_timestamp());
  IF o.status<>'verified' OR o.send_started_at IS NULL THEN v_outcome:='not_applied'; EXIT undo_check; END IF;
  IF o.send_started_at+interval '90 days'<=v_now THEN v_outcome:='unavailable'; EXIT undo_check; END IF;
  SELECT max(x.observed_at) INTO v_last FROM morrow_work.operation_undo_checks x
   WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.operation_id=p_operation_id;
  IF v_last IS NOT NULL AND v_last>v_now-interval '10 seconds' THEN v_outcome:='too_soon'; EXIT undo_check; END IF;
  IF NOT EXISTS(SELECT 1 FROM morrow_work.listings_store_current(o.organization_id,o.workspace_id,o.store_id) x
    WHERE x.connection_id=o.connection_id) THEN v_outcome:='link_changed'; EXIT undo_check; END IF;
  IF p_outcome='read' THEN
   IF NOT morrow_work.snapshot_matches(p_snapshot,o.product_id) THEN v_outcome:='invalid'; EXIT undo_check; END IF;
   v_digest:=morrow_work.sha256_text(p_snapshot);
   PERFORM pg_catalog.set_config('morrow.vault_undo_product',o.organization_id||'|'||o.workspace_id||'|'||o.store_id||'|'||o.product_id,true);
   INSERT INTO morrow_work.product_snapshots(organization_id,workspace_id,store_id,digest,product_id,canonical,read_at,expires_at)
   VALUES (o.organization_id,o.workspace_id,o.store_id,v_digest,o.product_id,p_snapshot,v_now,v_now+interval '90 days') ON CONFLICT DO NOTHING;
   PERFORM pg_catalog.set_config('morrow.vault_undo_product','',true);
  END IF;
  SELECT COALESCE(max(x.sequence),0)+1 INTO v_sequence FROM morrow_work.operation_undo_checks x
   WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.operation_id=p_operation_id;
  INSERT INTO morrow_work.operation_undo_checks(organization_id,workspace_id,operation_id,sequence,observed_at,outcome,current_digest,
   field_verdicts,verdict)
  VALUES (o.organization_id,o.workspace_id,p_operation_id,v_sequence,v_now,p_outcome,v_digest,v_verdicts,p_verdict);
  v_outcome:='recorded';
 END undo_check;
 PERFORM pg_catalog.set_config('morrow.vault_undo_product','',true);
 PERFORM morrow_vault.catalog_context_clear();
 IF v_outcome='recorded' THEN RETURN QUERY SELECT 'recorded'::text,v_sequence::text,p_verdict; RETURN; END IF;
 RETURN QUERY SELECT v_outcome,NULL::text,NULL::text;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.catalog_undo_set(jsonb,text[]),morrow_work.catalog_undo_state(text,text,text),
 morrow_work.catalog_undo_proposer_facts(text,text,text,text),
 morrow_work.catalog_undo_states(text),morrow_work.catalog_undo_source(text),morrow_work.catalog_undo_proposer(text),
 morrow_work.cmd_catalog_undo(text,text,text,text,text,text,text,text,text,text,text,text),
 morrow_vault.catalog_undo_resolve(text),morrow_vault.catalog_undo_record(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.catalog_undo_states(text),morrow_work.catalog_undo_source(text),morrow_work.catalog_undo_proposer(text),
 morrow_work.cmd_catalog_undo(text,text,text,text,text,text,text,text,text,text,text,text) TO morrow_work_api;
GRANT EXECUTE ON FUNCTION morrow_vault.catalog_undo_resolve(text),morrow_vault.catalog_undo_record(text,text,text,text,text)
 TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_work,morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_undo_set(jsonb,text[]) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_undo_state(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_undo_proposer_facts(text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_undo_states(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_undo_source(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_undo_proposer(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_catalog_undo(text,text,text,text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.catalog_undo_resolve(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.catalog_undo_record(text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work,morrow_vault FROM morrow_work_command;
COMMIT;
