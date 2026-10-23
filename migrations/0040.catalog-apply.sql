BEGIN;
-- v1 PR 3, apply half: the gateway's first slice for Listings' product content (ADR-0022 items
-- 3, 7, 9 and 15; ADR-0011; spine §2 steps 11-14, §5 and §8; P06.T01c, P08.T03a, P11.T02a and
-- P11.T03a minimum). Executes AS morrow_work_owner, after catalog-review (0039). No external
-- effect: nothing here sends a request. On the ADR-0010 tenant pattern: composite tenant keys,
-- ENABLE and FORCE RLS, definers owned by morrow_work_command.
--   * Tables (content-free, append-only, 365 days): operation_writes, the send fence's record
--     (the credential version the send used, the fields sent and Shopify's updatedAt read just
--     before the send); operation_readbacks, one row per read-back with per-field verdict codes.
--   * The apply in the person's own session (the api login): cmd_catalog_apply consumes the
--     approval once (approval_claim, consumer catalog.apply, the Idempotency-Key as its command
--     id), rechecks the store's link, the proposing installation, the write scope and the stops,
--     opens one 15-minute operation lease and records one operation per approved product
--     (planned -> awaiting_approval -> authorized), each bound to the digest of its exact
--     approved item. cmd_catalog_dispatch moves one authorized operation to dispatching after
--     the Worker's kernel and approval rechecks, rechecking the lease, stops, link,
--     installation, scope and the approval's expiry under the operation's row lock (or records
--     the conflict the Worker found).
--   * The broker's login (morrow_vault_broker), keyed by operation id (ADR-0022 item 7):
--     catalog_write_resolve, catalog_write_begin (the send fence, committed before any request)
--     and catalog_write_end; catalog_reconcile_resolve and catalog_reconcile_record (read-back,
--     never blocked by a stop or a lease's end). Only a read-back that matches the approved
--     values reaches verified; an unknown outcome stays uncertain until a read-back settles it.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR to_regprocedure('morrow_work.catalog_review_sources(text)') IS NULL
 OR to_regprocedure('morrow_work.approval_claim(text,text,text,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.command_prelude_exclusive(text,text)') IS NULL
 OR to_regprocedure('morrow_work.command_prelude(text,text)') IS NULL
 OR to_regprocedure('morrow_work.lease_open(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.operation_transition(text,text,text,bigint,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.stop_active(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.listings_store_current(text,text,text)') IS NULL
 OR to_regprocedure('morrow_vault.credential_for_connection(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.db_now()') IS NULL OR to_regprocedure('morrow_work.sha256_text(text)') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_shopify_read_target(text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_lease_member_current(text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 OR to_regclass('morrow_work.operation_writes') IS NOT NULL OR to_regclass('morrow_work.operation_readbacks') IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM morrow_work.transition_rules t WHERE t.machine='operation' AND t.from_status='authorized'
   AND t.to_status='dispatching' AND t.actor='action_service' AND t.guard='non_billable_current_grants_and_lease')
 THEN RAISE EXCEPTION 'CATALOG_APPLY_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A read-back's per-field verdicts: a non-empty object of listing fields to codes. IMMUTABLE,
-- owned by the owner; the command role holds EXECUTE because CHECK constraints run with the
-- writer's privileges (the 0015 valid_scope pattern).
CREATE FUNCTION morrow_work.readback_verdicts_valid(p_verdicts jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT p_verdicts IS NOT NULL AND jsonb_typeof(p_verdicts)='object' AND p_verdicts<>'{}'::jsonb
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(p_verdicts) e WHERE e.key NOT IN ('descriptionHtml','seo.description','seo.title','tags','title')
   OR jsonb_typeof(e.value)<>'string' OR (e.value#>>'{}') NOT IN ('approved','source','other'))
$$;
REVOKE ALL ON FUNCTION morrow_work.readback_verdicts_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.readback_verdicts_valid(jsonb) TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- Tables. Every stored time is millisecond-truncated. Content class none: ids, codes, counts,
-- the listing field names and Shopify's own updatedAt text (compared only for equality).
CREATE TABLE morrow_work.operation_writes (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 operation_id morrow_work.record_id NOT NULL,
 fenced_at timestamptz NOT NULL CHECK (fenced_at=date_trunc('milliseconds',fenced_at) AND isfinite(fenced_at)),
 credential_id morrow_work.record_id NOT NULL,
 credential_version morrow_work.revision NOT NULL,
 fields text[] NOT NULL CHECK (morrow_work.run_fields_valid(fields)),
 source_updated_at text NOT NULL CHECK (source_updated_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'),
 PRIMARY KEY (organization_id,workspace_id,operation_id),
 FOREIGN KEY (organization_id,workspace_id,operation_id) REFERENCES morrow_work.operations(organization_id,workspace_id,id)
);
CREATE TABLE morrow_work.operation_readbacks (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 operation_id morrow_work.record_id NOT NULL,
 sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 1000),
 observed_at timestamptz NOT NULL CHECK (observed_at=date_trunc('milliseconds',observed_at) AND isfinite(observed_at)),
 outcome text NOT NULL CHECK (outcome IN ('read','not_found','credential_unavailable')),
 observed_updated_at text CHECK (observed_updated_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$'),
 field_verdicts jsonb,
 verdict text CHECK (verdict IN ('approved','source','mixed','missing')),
 PRIMARY KEY (organization_id,workspace_id,operation_id,sequence),
 FOREIGN KEY (organization_id,workspace_id,operation_id) REFERENCES morrow_work.operations(organization_id,workspace_id,id),
 CONSTRAINT operation_readbacks_shape CHECK (CASE outcome
  WHEN 'read' THEN observed_updated_at IS NOT NULL AND verdict IN ('approved','source','mixed')
   AND morrow_work.readback_verdicts_valid(field_verdicts)
  WHEN 'not_found' THEN observed_updated_at IS NULL AND verdict='missing' AND field_verdicts IS NULL
  ELSE observed_updated_at IS NULL AND verdict IS NULL AND field_verdicts IS NULL END)
);
-- The product lock's question (another open write on this product) and the claim's reads.
CREATE INDEX operations_open_product ON morrow_work.operations (organization_id,workspace_id,store_id,target_resource_id)
 WHERE kind='catalog_write' AND status IN ('dispatching','submitted','verifying','uncertain');
CREATE INDEX operations_claim ON morrow_work.operations (organization_id,workspace_id,claim_family_root_id,target_index)
 WHERE kind='catalog_write';

-- ---------------------------------------------------------------------------
-- Row security. Both tables: ENABLE + FORCE, the maintenance-only owner policy, the session
-- context (tenant_command) and the api's read of the read-backs (codes only).
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['operation_writes','operation_readbacks'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  -- The broker's catalog definers (below) reach exactly the operation their own
  -- transaction-local setting names (morrow.vault_catalog_operation), which only they write
  -- and clear, while the session user is the broker's login.
  EXECUTE format('CREATE POLICY broker_catalog ON morrow_work.%I TO morrow_work_command
   USING (session_user=''morrow_vault_broker'' AND operation_id::text=pg_catalog.current_setting(''morrow.vault_catalog_operation'',true))
   WITH CHECK (session_user=''morrow_vault_broker'' AND operation_id::text=pg_catalog.current_setting(''morrow.vault_catalog_operation'',true))',t);
 END LOOP;
END $$;
CREATE POLICY tenant_read ON morrow_work.operation_readbacks FOR SELECT TO morrow_work_api
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
-- The broker's catalog context on the shared tables. The operation it names (read and
-- written), its transitions, and, for reading only, its tenant's catalog operations (the
-- product lock), claims, proposals, parameters and snapshots (morrow.vault_catalog_tenant,
-- org|ws, written by the same definers from the operation row). The lease, stop and
-- installation reads reuse resolve_call's settings and policies (0031), which these
-- definers also write and clear themselves.
CREATE POLICY broker_catalog ON morrow_work.operations TO morrow_work_command
 USING (session_user='morrow_vault_broker' AND kind='catalog_write' AND id::text=pg_catalog.current_setting('morrow.vault_catalog_operation',true))
 WITH CHECK (session_user='morrow_vault_broker' AND kind='catalog_write' AND id::text=pg_catalog.current_setting('morrow.vault_catalog_operation',true));
CREATE POLICY broker_catalog_tenant ON morrow_work.operations FOR SELECT TO morrow_work_command
 USING (session_user='morrow_vault_broker' AND kind='catalog_write'
  AND organization_id::text||'|'||workspace_id::text=pg_catalog.current_setting('morrow.vault_catalog_tenant',true));
CREATE POLICY broker_catalog_transition ON morrow_work.operation_transitions TO morrow_work_command
 USING (session_user='morrow_vault_broker' AND operation_id::text=pg_catalog.current_setting('morrow.vault_catalog_operation',true))
 WITH CHECK (session_user='morrow_vault_broker' AND operation_id::text=pg_catalog.current_setting('morrow.vault_catalog_operation',true));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['approval_claims','proposals','proposal_parameters','product_snapshots'] LOOP
  EXECUTE format('CREATE POLICY broker_catalog_read ON morrow_work.%I FOR SELECT TO morrow_work_command
   USING (session_user=''morrow_vault_broker''
    AND organization_id::text||''|''||workspace_id::text=pg_catalog.current_setting(''morrow.vault_catalog_tenant'',true))',t);
 END LOOP;
END $$;

-- Privileges: SELECT and INSERT, never UPDATE, DELETE or TRUNCATE (append-only); the api reads
-- the read-backs column by column.
GRANT SELECT,INSERT ON morrow_work.operation_writes,morrow_work.operation_readbacks TO morrow_work_command;
GRANT SELECT (organization_id,workspace_id,operation_id,sequence,observed_at,outcome,field_verdicts,verdict)
 ON morrow_work.operation_readbacks TO morrow_work_api;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['operation_writes','operation_readbacks'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Pure helpers: IMMUTABLE, owned by the command role after the transfer, granted to nobody
-- (only the definers below call them). One target of a stored catalog.content.publish
-- proposal by its root target index (a derived proposal maps its targets to the root's through
-- derivedFrom.selectedTargetIndexes), and the CatalogContentChangeSet@1 item of that root
-- index in the claimed parameters. Null when absent.
CREATE FUNCTION morrow_work.catalog_target(p_proposal jsonb,p_root_index integer) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_selected jsonb; v_i integer;
BEGIN
 IF p_proposal IS NULL OR p_root_index IS NULL OR jsonb_typeof(p_proposal->'targets')<>'array' THEN RETURN NULL; END IF;
 v_selected:=p_proposal#>'{derivedFrom,selectedTargetIndexes}';
 IF v_selected IS NULL OR jsonb_typeof(v_selected)<>'array' THEN RETURN p_proposal->'targets'->p_root_index; END IF;
 SELECT (o-1)::integer INTO v_i FROM jsonb_array_elements(v_selected) WITH ORDINALITY s(x,o) WHERE s.x=to_jsonb(p_root_index);
 IF v_i IS NULL THEN RETURN NULL; END IF;
 RETURN p_proposal->'targets'->v_i;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
CREATE FUNCTION morrow_work.catalog_item(p_parameters jsonb,p_root_index integer) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT (SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_parameters->'items')='array' THEN p_parameters->'items' ELSE '[]'::jsonb END) e
  WHERE e->'targetIndex'=to_jsonb(p_root_index) LIMIT 1)
$$;
-- Whether an item is exactly one target's change: its product, and set keys that follow the
-- target's fields (the SEO pair as one `seo` object).
CREATE FUNCTION morrow_work.catalog_item_matches(p_item jsonb,p_target jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_fields text[]; v_keys text[];
BEGIN
 IF p_item IS NULL OR p_target IS NULL OR jsonb_typeof(p_item)<>'object' OR jsonb_typeof(p_item->'set')<>'object'
  OR NOT (p_item ?& ARRAY['targetIndex','productId','set']) OR (p_item-ARRAY['targetIndex','productId','set'])<>'{}'::jsonb
  OR p_item->'productId' IS DISTINCT FROM p_target#>'{resource,id}' OR jsonb_typeof(p_target->'fields')<>'array' THEN RETURN false; END IF;
 v_fields:=ARRAY(SELECT jsonb_array_elements_text(p_target->'fields'));
 v_keys:=ARRAY(SELECT DISTINCT CASE WHEN f LIKE 'seo.%' THEN 'seo' ELSE f END FROM unnest(v_fields) f ORDER BY 1);
 RETURN ARRAY(SELECT k FROM jsonb_object_keys(p_item->'set') k ORDER BY 1)=v_keys AND cardinality(v_keys)>0;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- ---------------------------------------------------------------------------
-- API functions: SECURITY DEFINER, owned by the command role after the transfer, EXECUTE for
-- morrow_work_api only. Tenant and actor come only from current_tenant().
--
-- The claim (spine §2 step 11), after the Worker's checks: the proposal's read rule, the
-- claimant's own `execute` on catalog.content.publish on the store resource with entitlement
-- (paid work), every counted reviewer still eligible (prepareApprovalClaim). One transaction
-- under the exclusive prelude: approval_claim (the exact approval revision, ApprovalRef
-- digest, proposal digest and capability; one claim per family; the counted set current;
-- never redacted parameters), then under the same lock: the items the Worker built must equal
-- the claimed parameters' items for exactly the claimed proposal's targets (jsonb equality),
-- each with its digest; the store's link still the proposal's connection; the proposing
-- installation active on it; write_products granted; at most 25 targets; no stop (lease_open,
-- under the stop interlock). It opens one operation lease for the claimant (marked started:
-- the apply runs in this session's requests, never the cron) and records one authorized
-- operation per target. p_items is a JSON array of {targetIndex, canonical, digest} in the
-- claimed proposal's target order. Outcomes: applied (with the claim), replayed (the same
-- claimant's same command, nothing written), the prelude's, approval_claim's codes,
-- link_changed, installation_inactive, scope_missing, limit_reached, stopped, invalid.
CREATE FUNCTION morrow_work.cmd_catalog_apply(p_command_id text,p_request_digest text,p_approval_id text,p_approval_revision text,
 p_approval_digest text,p_proposal_id text,p_proposal_digest text,p_counted text,p_items text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 pre record; c record; prop record; v_proposal jsonb; v_parameters jsonb; v_items jsonb; v_n integer; v_i integer; v_root integer;
 v_target jsonb; v_item jsonb; v_given jsonb; v_store text; v_connection text; v_installation text; t record; l record; v_subject text;
 v_now timestamptz; v_op text; x record; v_ops jsonb:='[]'::jsonb; v_selected jsonb; v_claim record;
BEGIN
 IF p_items IS NULL OR octet_length(p_items)>65536 OR NOT pg_input_is_valid(p_items,'jsonb') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 v_items:=p_items::jsonb;
 IF jsonb_typeof(v_items)<>'array' OR jsonb_array_length(v_items)<1 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO pre FROM morrow_work.command_prelude_exclusive(p_command_id,p_request_digest);
 IF pre.outcome IS DISTINCT FROM 'ok' THEN RETURN QUERY SELECT COALESCE(pre.outcome,'invalid'),NULL::text; RETURN; END IF;
 SELECT * INTO c FROM morrow_work.approval_claim(p_approval_id,p_approval_revision,p_approval_digest,p_proposal_id,p_proposal_digest,
  'catalog.content.publish','catalog.apply',p_command_id,p_counted);
 IF c.outcome='replayed' THEN
  SELECT x.family_root_id::text AS family_root_id INTO v_claim FROM morrow_work.approvals x
   WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id AND x.id=p_approval_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('operationId',o.id::text,'targetIndex',o.target_index,'productId',o.target_resource_id::text,
    'status',o.status) ORDER BY o.target_index),'[]'::jsonb),min(l2.subject_id::text),min(o.lease_id::text) INTO v_ops,v_subject,v_op
   FROM morrow_work.operations o JOIN morrow_work.work_leases l2 ON l2.organization_id=o.organization_id AND l2.workspace_id=o.workspace_id
    AND l2.id=o.lease_id
   WHERE o.organization_id=pre.organization_id AND o.workspace_id=pre.workspace_id AND o.kind='catalog_write'
    AND o.claim_family_root_id=v_claim.family_root_id;
  RETURN QUERY SELECT 'replayed'::text,jsonb_build_object('claimId',v_subject,'leaseId',v_op,'operations',v_ops)::text; RETURN;
 END IF;
 IF c.outcome IS DISTINCT FROM 'applied' THEN RETURN QUERY SELECT COALESCE(c.outcome,'invalid'),NULL::text; RETURN; END IF;
 v_proposal:=c.proposal;
 v_parameters:=c.parameters;
 v_store:=v_proposal->>'storeId';
 v_n:=jsonb_array_length(v_proposal->'targets');
 IF v_store IS NULL OR v_proposal->>'capabilityId'<>'catalog.content.publish' OR v_n<1 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 IF v_n>25 THEN RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN; END IF;
 IF jsonb_array_length(v_items)<>v_n THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 v_connection:=v_proposal#>>'{targets,0,resource,connectionId}';
 v_installation:=v_proposal#>>'{proposedBy,installationId}';
 v_selected:=v_proposal#>'{derivedFrom,selectedTargetIndexes}';
 -- Every target: this store and connection, and the Worker's item equal to the claimed one.
 FOR v_i IN 0..v_n-1 LOOP
  v_root:=CASE WHEN v_selected IS NULL OR jsonb_typeof(v_selected)<>'array' THEN v_i ELSE (v_selected->>v_i)::integer END;
  v_target:=morrow_work.catalog_target(v_proposal,v_root);
  v_item:=morrow_work.catalog_item(v_parameters,v_root);
  v_given:=v_items->v_i;
  IF v_target IS NULL OR v_item IS NULL OR v_target#>>'{resource,storeId}' IS DISTINCT FROM v_store
   OR v_target#>>'{resource,connectionId}' IS DISTINCT FROM v_connection OR v_target#>>'{resource,kind}' IS DISTINCT FROM 'product'
   OR NOT morrow_work.catalog_item_matches(v_item,v_target)
   OR jsonb_typeof(v_given)<>'object' OR NOT (v_given ?& ARRAY['targetIndex','canonical','digest'])
   OR (v_given-ARRAY['targetIndex','canonical','digest'])<>'{}'::jsonb OR v_given->'targetIndex'<>to_jsonb(v_root)
   OR jsonb_typeof(v_given->'canonical')<>'string' OR NOT pg_input_is_valid(v_given->>'canonical','jsonb')
   OR (v_given->>'canonical')::jsonb<>v_item OR v_given->>'digest' IS DISTINCT FROM morrow_work.sha256_text(v_given->>'canonical') THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
 END LOOP;
 -- The link, the proposing installation and the write scope, now.
 IF NOT EXISTS(SELECT 1 FROM morrow_work.listings_store_current(pre.organization_id,pre.workspace_id,v_store) s WHERE s.connection_id=v_connection) THEN
  RETURN QUERY SELECT 'link_changed'::text,NULL::text; RETURN;
 END IF;
 IF v_installation IS NULL OR NOT EXISTS(SELECT 1 FROM morrow_work.agent_installations i WHERE i.organization_id=pre.organization_id
   AND i.workspace_id=pre.workspace_id AND i.id=v_installation AND i.status='active' AND i.store_id=v_store AND i.connection_id=v_connection) THEN
  RETURN QUERY SELECT 'installation_inactive'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO t FROM morrow_identity.work_shopify_read_target(pre.organization_id,pre.workspace_id,v_store,v_connection);
 IF t.outcome IS DISTINCT FROM 'found' OR NOT ('write_products'=ANY(string_to_array(t.granted_scopes,','))) THEN
  RETURN QUERY SELECT 'scope_missing'::text,NULL::text; RETURN;
 END IF;
 -- The operation lease (refused under any stop), named by a fresh claim id, marked started.
 v_subject:=gen_random_uuid()::text;
 SELECT * INTO l FROM morrow_work.lease_open('operation',v_subject,v_store,v_connection,v_installation);
 IF l.outcome IS DISTINCT FROM 'opened' THEN
  RETURN QUERY SELECT CASE l.outcome WHEN 'stopped' THEN 'stopped' ELSE 'invalid' END,NULL::text; RETURN;
 END IF;
 UPDATE morrow_work.work_leases x SET started_at=x.created_at
  WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id AND x.id=l.lease_id AND x.started_at IS NULL;
 SELECT x.family_root_id::text AS family_root_id,x.revision::bigint AS revision INTO v_claim FROM morrow_work.approvals x
  WHERE x.organization_id=pre.organization_id AND x.workspace_id=pre.workspace_id AND x.id=p_approval_id;
 v_now:=morrow_work.db_now();
 FOR v_i IN 0..v_n-1 LOOP
  v_root:=CASE WHEN v_selected IS NULL OR jsonb_typeof(v_selected)<>'array' THEN v_i ELSE (v_selected->>v_i)::integer END;
  v_given:=v_items->v_i;
  v_target:=morrow_work.catalog_target(v_proposal,v_root);
  v_op:=gen_random_uuid()::text;
  INSERT INTO morrow_work.operations(organization_id,workspace_id,id,revision,kind,capability_id,task_id,store_id,connection_id,target_index,
   target_resource_id,proposal_id,proposal_digest,approval_id,approval_revision,approval_digest,claim_family_root_id,lease_id,status,
   request_digest,attempt,send_started_at,submitted_at,provider_request_id,uncertainty_reason,created_at,updated_at)
  VALUES (pre.organization_id,pre.workspace_id,v_op,1,'catalog_write','catalog.content.publish',v_proposal->>'taskId',v_store,v_connection,
   v_root,v_target#>>'{resource,id}',p_proposal_id,p_proposal_digest,p_approval_id,v_claim.revision,p_approval_digest,v_claim.family_root_id,
   l.lease_id,'planned',v_given->>'digest',0,NULL,NULL,NULL,NULL,v_now,v_now);
  SELECT * INTO x FROM morrow_work.operation_transition(pre.organization_id,pre.workspace_id,v_op,1,'awaiting_approval','action_service',
   'review_required','claim_admitted',NULL,l.lease_id);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
  SELECT * INTO x FROM morrow_work.operation_transition(pre.organization_id,pre.workspace_id,v_op,x.revision,'authorized','action_service',
   'exact_current_approval','approval_claimed',NULL,l.lease_id);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
  v_ops:=v_ops||jsonb_build_array(jsonb_build_object('operationId',v_op,'targetIndex',v_root,'productId',v_target#>>'{resource,id}',
   'status','authorized'));
 END LOOP;
 RETURN QUERY SELECT 'applied'::text,jsonb_build_object('claimId',v_subject,'leaseId',l.lease_id,'operations',v_ops)::text;
END $$;

-- One operation's dispatch check (spine §2 step 12), in the claimant's own session, after the
-- Worker reran the claimant's kernel decision (execute on the store resource, with
-- entitlement) and the approval's projection (still approved, unexpired, its policy current,
-- its counted reviewers eligible). A non-null p_conflict_reason records what the Worker found
-- (authority_lost, not_entitled, approval_invalid) as authorized -> conflict. Otherwise, under
-- the prelude, the stop interlock (shared, the lease_open order) and the operation's row lock:
-- the claimant is this actor; the operation lease is active and unexpired (else stopped,
-- member_removed or lease_ended); no stop; the store's link, the installation and
-- write_products are current; the approval has not expired. Each failure is authorized ->
-- conflict with its reason; nothing is sent. An operation past authorized is answered as it is
-- (a retry or a second tab changes nothing). Outcomes: dispatching, conflict, unchanged (with
-- the current status), not_found, not_claimant, invalid and the prelude's.
CREATE FUNCTION morrow_work.cmd_catalog_dispatch(p_operation_id text,p_conflict_reason text)
RETURNS TABLE(outcome text,status text,revision text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE pre record; o record; cl record; l record; t record; x record; v_reason text; v_now timestamptz; v_expires timestamptz;
BEGIN
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR (p_conflict_reason IS NOT NULL AND p_conflict_reason NOT IN ('authority_lost','not_entitled','approval_invalid')) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO pre FROM morrow_work.command_prelude(gen_random_uuid()::text,morrow_work.sha256_text('morrow.catalog.dispatch|'||p_operation_id));
 IF pre.outcome IS DISTINCT FROM 'ok' THEN RETURN QUERY SELECT COALESCE(pre.outcome,'invalid'),NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT x2.store_id::text AS store_id INTO o FROM morrow_work.operations x2
  WHERE x2.organization_id=pre.organization_id AND x2.workspace_id=pre.workspace_id AND x2.id=p_operation_id AND x2.kind='catalog_write';
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
  pre.organization_id,pre.workspace_id,o.store_id)::text,0));
 SELECT x2.status,x2.revision::bigint AS revision,x2.store_id::text AS store_id,x2.connection_id::text AS connection_id,x2.lease_id::text AS lease_id,
  x2.approval_id::text AS approval_id,x2.claim_family_root_id::text AS family_root_id INTO o FROM morrow_work.operations x2
  WHERE x2.organization_id=pre.organization_id AND x2.workspace_id=pre.workspace_id AND x2.id=p_operation_id FOR UPDATE;
 SELECT c.claimant_principal_id::text AS principal_id,c.claimant_membership_id::text AS membership_id INTO cl FROM morrow_work.approval_claims c
  WHERE c.organization_id=pre.organization_id AND c.workspace_id=pre.workspace_id AND c.family_root_id=o.family_root_id;
 IF NOT FOUND OR cl.principal_id<>pre.principal_id OR cl.membership_id<>pre.membership_id THEN
  RETURN QUERY SELECT 'not_claimant'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF o.status<>'authorized' THEN RETURN QUERY SELECT 'unchanged'::text,o.status,o.revision::text,NULL::text; RETURN; END IF;
 v_now:=pg_catalog.clock_timestamp();
 v_reason:=p_conflict_reason;
 IF v_reason IS NULL THEN
  SELECT x2.status,x2.revoked_reason,x2.expires_at,x2.installation_id::text AS installation_id INTO l FROM morrow_work.work_leases x2
   WHERE x2.organization_id=pre.organization_id AND x2.workspace_id=pre.workspace_id AND x2.id=o.lease_id;
  IF NOT FOUND THEN v_reason:='lease_ended';
  ELSIF l.status='revoked' THEN v_reason:=CASE l.revoked_reason WHEN 'stop' THEN 'stopped' ELSE 'member_removed' END;
  ELSIF l.status<>'active' OR l.expires_at<=v_now THEN v_reason:='lease_ended';
  ELSIF morrow_work.stop_active(pre.organization_id,pre.workspace_id,'operation',o.connection_id,l.installation_id) THEN v_reason:='stopped';
  ELSIF NOT EXISTS(SELECT 1 FROM morrow_work.listings_store_current(pre.organization_id,pre.workspace_id,o.store_id) s
    WHERE s.connection_id=o.connection_id) THEN v_reason:='link_lost';
  ELSIF NOT EXISTS(SELECT 1 FROM morrow_work.agent_installations i WHERE i.organization_id=pre.organization_id AND i.workspace_id=pre.workspace_id
    AND i.id=l.installation_id AND i.status='active' AND i.store_id=o.store_id AND i.connection_id=o.connection_id) THEN v_reason:='installation_inactive';
  ELSE
   SELECT * INTO t FROM morrow_identity.work_shopify_read_target(pre.organization_id,pre.workspace_id,o.store_id,o.connection_id);
   SELECT a.expires_at INTO v_expires FROM morrow_work.approvals a
    WHERE a.organization_id=pre.organization_id AND a.workspace_id=pre.workspace_id AND a.id=o.approval_id;
   IF t.outcome IS DISTINCT FROM 'found' OR NOT ('write_products'=ANY(string_to_array(t.granted_scopes,','))) THEN v_reason:='scope_missing';
   ELSIF v_expires IS NULL OR v_expires<=v_now THEN v_reason:='approval_expired';
   END IF;
  END IF;
 END IF;
 IF v_reason IS NOT NULL THEN
  SELECT * INTO x FROM morrow_work.operation_transition(pre.organization_id,pre.workspace_id,p_operation_id,o.revision,'conflict','action_service',
   'precondition_changed_before_dispatch',v_reason,NULL,o.lease_id);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
  RETURN QUERY SELECT 'conflict'::text,'conflict'::text,x.revision::text,v_reason; RETURN;
 END IF;
 SELECT * INTO x FROM morrow_work.operation_transition(pre.organization_id,pre.workspace_id,p_operation_id,o.revision,'dispatching','action_service',
  'non_billable_current_grants_and_lease','dispatch_checked',NULL,o.lease_id);
 IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
 RETURN QUERY SELECT 'dispatching'::text,'dispatching'::text,x.revision::text,NULL::text;
END $$;

-- ---------------------------------------------------------------------------
-- The broker's catalog definers: SECURITY DEFINER, owned by the command role after the
-- transfer, EXECUTE for morrow_vault_broker only, guarded by work_executor_safe. Each takes the
-- operation id (and closed codes) only and loads everything else itself: the operation, its
-- lease, the store's link and installation, the credential, the claimed proposal and its
-- parameters (ADR-0022 item 7). Each writes its own transaction-local settings before reading
-- and clears them before returning (catalog_context_clear); a setting the broker's login
-- forges outside them reaches nothing (it holds no table privilege).
--
-- The context of one catalog operation: the operation setting (its row, its transitions, its
-- fence and read-back rows), its tenant (the tenant's catalog reads), and resolve_call's
-- lease, tenant and installation settings for the lease, stop and installation reads.
CREATE FUNCTION morrow_vault.catalog_context(p_operation_id text,p_org text,p_ws text,p_lease_id text,p_installation_id text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM pg_catalog.set_config('morrow.vault_catalog_operation',p_operation_id,true),
  pg_catalog.set_config('morrow.vault_catalog_tenant',COALESCE(p_org||'|'||p_ws,''),true),
  pg_catalog.set_config('morrow.vault_resolve_lease',COALESCE(p_lease_id,''),true),
  pg_catalog.set_config('morrow.vault_resolve_tenant',COALESCE(p_org||'|'||p_ws,''),true),
  pg_catalog.set_config('morrow.vault_resolve_installation',COALESCE(p_org||'|'||p_ws||'|'||p_installation_id,''),true);
END $$;
CREATE FUNCTION morrow_vault.catalog_context_clear() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 PERFORM pg_catalog.set_config('morrow.vault_catalog_operation','',true),pg_catalog.set_config('morrow.vault_catalog_tenant','',true),
  pg_catalog.set_config('morrow.vault_resolve_lease','',true),pg_catalog.set_config('morrow.vault_resolve_tenant','',true),
  pg_catalog.set_config('morrow.vault_resolve_installation','',true);
END $$;
-- Why a dispatching, unfenced catalog operation may not be sent now, under the context set by
-- the caller, or NULL: the dispatch window (2 minutes from entering dispatching), the operation
-- lease (active, unexpired, this lease's member current), the stops, the proposing
-- installation, the store's link, write_products, the active credential (and, when given, its
-- version), and unredacted parameters. Its row comes back in p_out for the caller.
CREATE FUNCTION morrow_vault.catalog_send_refusal(p_operation_id text,p_credential_version text) RETURNS TABLE(refusal text,
 organization_id text,workspace_id text,store_id text,connection_id text,installation_id text,store_installation_id text,shop_domain text,
 product_id text,target_index integer,request_digest text,lease_id text,fields text,item text,expected_source_revision text,credential_id text,
 credential_version text,kek_version text,wrapped_key text,sealed_value text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE o record; l record; t record; c record; p record; q record; v_entered timestamptz; v_now timestamptz; v_target jsonb; v_item jsonb;
 v_refusal text;
BEGIN
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.store_id::text AS store_id,
  x.connection_id::text AS connection_id,x.target_resource_id::text AS product_id,x.target_index,x.request_digest::text AS request_digest,
  x.lease_id::text AS lease_id,x.proposal_id::text AS proposal_id INTO o
  FROM morrow_work.operations x WHERE x.id=p_operation_id AND x.kind='catalog_write';
 PERFORM morrow_vault.catalog_context(p_operation_id,o.organization_id,o.workspace_id,o.lease_id,NULL);
 v_now:=pg_catalog.clock_timestamp();
 SELECT max(x.occurred_at) INTO v_entered FROM morrow_work.operation_transitions x
  WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.operation_id=p_operation_id AND x.to_status='dispatching';
 SELECT x.status,x.revoked_reason,x.expires_at,x.installation_id::text AS installation_id,x.initiator_principal_id::text AS principal_id,
  x.initiator_membership_id::text AS membership_id INTO l FROM morrow_work.work_leases x WHERE x.id=o.lease_id;
 IF v_entered IS NULL OR v_entered<=v_now-interval '120 seconds' THEN v_refusal:='window_passed';
 ELSIF l.status IS NULL THEN v_refusal:='lease_ended';
 ELSIF l.status='revoked' THEN v_refusal:=CASE l.revoked_reason WHEN 'stop' THEN 'stopped' ELSE 'member_removed' END;
 ELSIF l.status<>'active' OR l.expires_at<=v_now THEN v_refusal:='lease_ended';
 ELSIF NOT morrow_identity.work_lease_member_current(o.organization_id,o.workspace_id,l.principal_id,l.membership_id) THEN v_refusal:='member_removed';
 END IF;
 IF v_refusal IS NULL THEN
  PERFORM morrow_vault.catalog_context(p_operation_id,o.organization_id,o.workspace_id,o.lease_id,l.installation_id);
  IF morrow_work.stop_active(o.organization_id,o.workspace_id,'operation',o.connection_id,l.installation_id) THEN v_refusal:='stopped';
  ELSIF NOT EXISTS(SELECT 1 FROM morrow_work.agent_installations i WHERE i.organization_id=o.organization_id AND i.workspace_id=o.workspace_id
    AND i.id=l.installation_id AND i.status='active' AND i.store_id=o.store_id AND i.connection_id=o.connection_id) THEN
   v_refusal:='installation_inactive';
  ELSIF NOT EXISTS(SELECT 1 FROM morrow_work.listings_store_current(o.organization_id,o.workspace_id,o.store_id) s
    WHERE s.connection_id=o.connection_id) THEN v_refusal:='link_lost';
  ELSE
   SELECT * INTO t FROM morrow_identity.work_shopify_read_target(o.organization_id,o.workspace_id,o.store_id,o.connection_id);
   IF t.outcome IS DISTINCT FROM 'found' OR NOT ('write_products'=ANY(string_to_array(t.granted_scopes,','))) THEN v_refusal:='scope_missing';
   ELSE
    SELECT * INTO c FROM morrow_vault.credential_for_connection(o.organization_id,o.workspace_id,t.installation_id);
    IF c.outcome IS DISTINCT FROM 'found' OR c.credential_id IS DISTINCT FROM t.credential_id
     OR (p_credential_version IS NOT NULL AND c.version IS DISTINCT FROM p_credential_version) THEN v_refusal:='credential_unavailable';
    ELSE
     SELECT x.canonical,x.parameters_id::text AS parameters_id INTO p FROM morrow_work.proposals x
      WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.id=o.proposal_id;
     SELECT x.canonical,x.redacted_at INTO q FROM morrow_work.proposal_parameters x
      WHERE x.organization_id=o.organization_id AND x.workspace_id=o.workspace_id AND x.id=p.parameters_id;
     IF NOT FOUND OR q.redacted_at IS NOT NULL THEN v_refusal:='parameters_redacted';
     ELSE
      v_target:=morrow_work.catalog_target(p.canonical::jsonb,o.target_index);
      v_item:=morrow_work.catalog_item(q.canonical::jsonb,o.target_index);
      IF v_target IS NULL OR v_item IS NULL OR NOT morrow_work.catalog_item_matches(v_item,v_target) THEN v_refusal:='request_mismatch'; END IF;
     END IF;
    END IF;
   END IF;
  END IF;
 END IF;
 IF v_refusal IS NOT NULL THEN
  RETURN QUERY SELECT v_refusal,o.organization_id,o.workspace_id,o.store_id,o.connection_id,NULL::text,NULL::text,NULL::text,o.product_id,
   o.target_index,o.request_digest,o.lease_id,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 RETURN QUERY SELECT NULL::text,o.organization_id,o.workspace_id,o.store_id,o.connection_id,l.installation_id,t.installation_id,t.shop_domain,
  o.product_id,o.target_index,o.request_digest,o.lease_id,array_to_string(ARRAY(SELECT jsonb_array_elements_text(v_target->'fields')),','),
  v_item::text,v_target->>'expectedSourceRevision',c.credential_id,c.version,c.kek_version,c.wrapped_key,c.sealed_value;
END $$;

-- T1, alone in its transaction (the vault login's connections are shared): the send's inputs
-- for one dispatching, unfenced catalog operation, after catalog_send_refusal. A durable
-- refusal closes the operation here (dispatching -> failed, verified_no_effect: nothing was
-- sent, no fence exists) and answers `refused` with its reason. An operation already fenced
-- is `in_flight` (a second call never sends); any other status is `settled` with it.
-- `resolved` returns the shop, the product, the fields, the claimed item's JSON (the broker
-- recomputes its digest and compares it with the operation's request digest before sending),
-- the expected source revision and the token's envelope. Outcomes: resolved, refused,
-- in_flight, settled, not_found, invalid, denied.
CREATE FUNCTION morrow_vault.catalog_write_resolve(p_operation_id text)
RETURNS TABLE(outcome text,status text,reason text,organization_id text,workspace_id text,shop_domain text,product_id text,fields text,item text,
 request_digest text,expected_source_revision text,store_installation_id text,credential_id text,credential_version text,kek_version text,
 wrapped_key text,sealed_value text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE o record; r record; x record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 PERFORM morrow_vault.catalog_context(p_operation_id,NULL,NULL,NULL,NULL);
 SELECT x2.organization_id::text AS organization_id,x2.workspace_id::text AS workspace_id,x2.status,x2.revision::bigint AS revision,
  x2.send_started_at,x2.lease_id::text AS lease_id INTO o
  FROM morrow_work.operations x2 WHERE x2.id=p_operation_id AND x2.kind='catalog_write' FOR UPDATE;
 IF NOT FOUND THEN
  PERFORM morrow_vault.catalog_context_clear();
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF o.status<>'dispatching' OR o.send_started_at IS NOT NULL THEN
  PERFORM morrow_vault.catalog_context_clear();
  RETURN QUERY SELECT CASE WHEN o.status='dispatching' THEN 'in_flight' ELSE 'settled' END,o.status,NULL::text,o.organization_id,o.workspace_id,
   NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO r FROM morrow_vault.catalog_send_refusal(p_operation_id,NULL);
 IF r.refusal IS NOT NULL THEN
  SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,o.revision,'failed','connector',
   'verified_no_effect',r.refusal,NULL,NULL);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
  PERFORM morrow_vault.catalog_context_clear();
  RETURN QUERY SELECT 'refused'::text,'failed'::text,r.refusal,o.organization_id,o.workspace_id,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 PERFORM morrow_vault.catalog_context_clear();
 RETURN QUERY SELECT 'resolved'::text,'dispatching'::text,NULL::text,r.organization_id,r.workspace_id,r.shop_domain,r.product_id,r.fields,r.item,
  r.request_digest,r.expected_source_revision,r.store_installation_id,r.credential_id,r.credential_version,r.kek_version,r.wrapped_key,r.sealed_value;
END $$;

-- T2, the send fence (spine §8), committed before any request. Lock order: the stop interlock
-- shared (platform, then the store; a stop takes it exclusively, so a stop either committed
-- first and is seen here, or waits), the product key (one open write per product across
-- claims), then the operation's row. Rechecks every T1 condition with the credential version
-- T1 returned, then the broker's own checks: the claimed item's canonical text must hash to the
-- operation's request digest (request_mismatch), and its pre-send read: a product Shopify no longer has
-- (product_missing), a 401 (connection_unauthorized), or a product whose current listing
-- fields' digest is not the draft's expectedSourceRevision (source_changed: it changed since
-- the draft, so nothing is written and the person is told). Another catalog operation on the
-- same product still open (fenced dispatching, submitted, verifying or uncertain) is
-- product_busy. Each refusal: dispatching -> failed (verified_no_effect), nothing sent.
-- Otherwise the fence (attempt+1, send_started_at, once) and its operation_writes row.
-- Outcomes: send, refused (with the reason), in_flight, settled, not_found, invalid, denied.
CREATE FUNCTION morrow_vault.catalog_write_begin(p_operation_id text,p_presend text,p_presend_digest text,p_presend_updated_at text,
 p_credential_version text)
RETURNS TABLE(outcome text,status text,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE o record; r record; x record; v_refusal text; v_at timestamptz;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_presend IS NULL OR p_presend NOT IN ('read','not_found','unauthorized','mismatch')
  OR (p_presend='read')<>(p_presend_digest IS NOT NULL) OR (p_presend='read')<>(p_presend_updated_at IS NOT NULL)
  OR (p_presend_digest IS NOT NULL AND p_presend_digest !~ '^[a-f0-9]{64}$')
  OR (p_presend_updated_at IS NOT NULL AND p_presend_updated_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$')
  OR p_credential_version IS NULL OR p_credential_version !~ '^[1-9][0-9]{0,15}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 PERFORM morrow_vault.catalog_context(p_operation_id,NULL,NULL,NULL,NULL);
 SELECT x2.organization_id::text AS organization_id,x2.workspace_id::text AS workspace_id,x2.store_id::text AS store_id,
  x2.target_resource_id::text AS product_id INTO o FROM morrow_work.operations x2 WHERE x2.id=p_operation_id AND x2.kind='catalog_write';
 IF NOT FOUND THEN PERFORM morrow_vault.catalog_context_clear(); RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
  o.organization_id,o.workspace_id,o.store_id)::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.product',
  o.organization_id,o.workspace_id,o.store_id,o.product_id)::text,0));
 SELECT x2.status,x2.revision::bigint AS revision,x2.send_started_at,x2.updated_at,x2.organization_id::text AS organization_id,
  x2.workspace_id::text AS workspace_id,x2.store_id::text AS store_id,x2.target_resource_id::text AS product_id INTO o
  FROM morrow_work.operations x2 WHERE x2.id=p_operation_id FOR UPDATE;
 IF o.status<>'dispatching' OR o.send_started_at IS NOT NULL THEN
  PERFORM morrow_vault.catalog_context_clear();
  RETURN QUERY SELECT CASE WHEN o.status='dispatching' THEN 'in_flight' ELSE 'settled' END,o.status,NULL::text; RETURN;
 END IF;
 SELECT * INTO r FROM morrow_vault.catalog_send_refusal(p_operation_id,p_credential_version);
 v_refusal:=r.refusal;
 IF v_refusal IS NULL THEN
  IF p_presend='mismatch' THEN v_refusal:='request_mismatch';
  ELSIF p_presend='not_found' THEN v_refusal:='product_missing';
  ELSIF p_presend='unauthorized' THEN v_refusal:='connection_unauthorized';
  ELSIF EXISTS(SELECT 1 FROM morrow_work.operations y WHERE y.organization_id=o.organization_id AND y.workspace_id=o.workspace_id
    AND y.kind='catalog_write' AND y.store_id=o.store_id AND y.target_resource_id=o.product_id AND y.id<>p_operation_id
    AND (y.status IN ('submitted','verifying','uncertain') OR (y.status='dispatching' AND y.send_started_at IS NOT NULL))) THEN
   v_refusal:='product_busy';
  ELSIF p_presend_digest IS DISTINCT FROM r.expected_source_revision THEN v_refusal:='source_changed';
  END IF;
 END IF;
 IF v_refusal IS NOT NULL THEN
  SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,o.revision,'failed','connector',
   'verified_no_effect',v_refusal,NULL,NULL);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
  PERFORM morrow_vault.catalog_context_clear();
  RETURN QUERY SELECT 'refused'::text,'failed'::text,v_refusal; RETURN;
 END IF;
 v_at:=greatest(morrow_work.db_now(),o.updated_at);
 UPDATE morrow_work.operations x2 SET attempt=x2.attempt+1,send_started_at=v_at,revision=x2.revision+1,updated_at=v_at
  WHERE x2.organization_id=o.organization_id AND x2.workspace_id=o.workspace_id AND x2.id=p_operation_id;
 INSERT INTO morrow_work.operation_writes(organization_id,workspace_id,operation_id,fenced_at,credential_id,credential_version,fields,
  source_updated_at)
 VALUES (o.organization_id,o.workspace_id,p_operation_id,v_at,r.credential_id,r.credential_version::bigint,string_to_array(r.fields,','),
  p_presend_updated_at);
 PERFORM morrow_vault.catalog_context_clear();
 RETURN QUERY SELECT 'send'::text,'dispatching'::text,NULL::text;
END $$;

-- T3, the close of one fenced send, from the broker's classification of Shopify's reply:
-- submitted (provider_accepted), failed (a reply that proves nothing ran: provider_rejected
-- for userErrors, throttled, connection_unauthorized, access_denied, or not_sent when the
-- deadline passed before any request) or uncertain (transport_after_dispatch: the reply was
-- lost, a 5xx, an unexpected status, a GraphQL error or a malformed reply). Shopify's request
-- id is recorded once. Only a fenced dispatching operation closes; anything else is
-- state_conflict (a late close is never promoted). Outcomes: recorded, state_conflict,
-- not_found, invalid, denied.
CREATE FUNCTION morrow_vault.catalog_write_end(p_operation_id text,p_outcome text,p_reason text,p_provider_request_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
DECLARE o record; x record; v_rev bigint; v_at timestamptz;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN 'denied'; END IF;
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_outcome IS NULL
  OR NOT ((p_outcome='submitted' AND p_reason='provider_accepted')
   OR (p_outcome='failed' AND p_reason IN ('provider_rejected','throttled','connection_unauthorized','access_denied','not_sent'))
   OR (p_outcome='uncertain' AND p_reason IN ('transport_lost','server_error','unexpected_status','graphql_error','reply_malformed')))
  OR (p_provider_request_id IS NOT NULL AND p_provider_request_id !~ '^[A-Za-z0-9-]{8,128}$') THEN
  RETURN 'invalid';
 END IF;
 PERFORM morrow_vault.catalog_context(p_operation_id,NULL,NULL,NULL,NULL);
 SELECT x2.organization_id::text AS organization_id,x2.workspace_id::text AS workspace_id,x2.status,x2.revision::bigint AS revision,
  x2.send_started_at,x2.provider_request_id,x2.updated_at INTO o FROM morrow_work.operations x2
  WHERE x2.id=p_operation_id AND x2.kind='catalog_write' FOR UPDATE;
 IF NOT FOUND THEN PERFORM morrow_vault.catalog_context_clear(); RETURN 'not_found'; END IF;
 IF o.status<>'dispatching' OR o.send_started_at IS NULL THEN PERFORM morrow_vault.catalog_context_clear(); RETURN 'state_conflict'; END IF;
 v_rev:=o.revision;
 IF p_provider_request_id IS NOT NULL AND o.provider_request_id IS NULL THEN
  v_at:=greatest(morrow_work.db_now(),o.updated_at);
  UPDATE morrow_work.operations x2 SET provider_request_id=p_provider_request_id,revision=x2.revision+1,updated_at=v_at
   WHERE x2.organization_id=o.organization_id AND x2.workspace_id=o.workspace_id AND x2.id=p_operation_id;
  v_rev:=v_rev+1;
 END IF;
 IF p_outcome='submitted' THEN
  SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,v_rev,'submitted','connector',
   'provider_submission_receipt',p_reason,NULL,NULL);
 ELSIF p_outcome='failed' THEN
  SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,v_rev,'failed','connector',
   'verified_no_effect',p_reason,NULL,NULL);
 ELSE
  SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,v_rev,'uncertain','connector',
   'unknown_external_outcome',p_reason,'transport_after_dispatch',NULL);
 END IF;
 IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
 PERFORM morrow_vault.catalog_context_clear();
 RETURN 'recorded';
END $$;

-- R1, read-back resolution (spine §8; ADR-0022 item 9: keyed by the operation, no lease,
-- never blocked by a stop or by the apply switch). Before any read it settles what time alone
-- proves: an unfenced dispatching operation 3 minutes after entering dispatching was never
-- sent (failed, not_sent); a fence left open 90 seconds after it was set (the send's budget
-- and a grace) is uncertain (unknown_submission). submitted and uncertain operations are read
-- back, at most once every 10 seconds (too_soon). Without the credential the fence used (an
-- uninstall, a disconnect, a new token) a read-back is impossible: a credential_unavailable
-- row, and a submitted operation becomes uncertain (verification_unavailable); an uncertain
-- one stays as it is. `resolved` returns the shop, the product, the fields, the approved item,
-- the source snapshot (null once gone), Shopify's updatedAt before the send and the token's
-- envelope. Outcomes: resolved, closed, too_soon, unavailable, settled, not_found, invalid,
-- denied.
CREATE FUNCTION morrow_vault.catalog_reconcile_resolve(p_operation_id text)
RETURNS TABLE(outcome text,status text,organization_id text,workspace_id text,shop_domain text,product_id text,fields text,item text,source text,
 source_updated_at text,store_installation_id text,credential_id text,credential_version text,kek_version text,wrapped_key text,sealed_value text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE o record; w record; t record; c record; p record; q record; x record; v_now timestamptz; v_entered timestamptz; v_last timestamptz;
 v_target jsonb; v_item jsonb; v_source text; v_status text; v_rev bigint; v_outcome text;
BEGIN
 <<settle>>
 BEGIN
  IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN v_outcome:='denied'; EXIT settle; END IF;
  IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN v_outcome:='invalid'; EXIT settle; END IF;
  PERFORM morrow_vault.catalog_context(p_operation_id,NULL,NULL,NULL,NULL);
  SELECT x2.organization_id::text AS organization_id,x2.workspace_id::text AS workspace_id,x2.status,x2.revision::bigint AS revision,
   x2.send_started_at,x2.store_id::text AS store_id,x2.connection_id::text AS connection_id,x2.target_resource_id::text AS product_id,
   x2.target_index,x2.proposal_id::text AS proposal_id INTO o
   FROM morrow_work.operations x2 WHERE x2.id=p_operation_id AND x2.kind='catalog_write' FOR UPDATE;
  IF NOT FOUND THEN v_outcome:='not_found'; EXIT settle; END IF;
  PERFORM morrow_vault.catalog_context(p_operation_id,o.organization_id,o.workspace_id,NULL,NULL);
  v_now:=pg_catalog.clock_timestamp();
  v_status:=o.status;
  v_rev:=o.revision;
  -- Time alone settles an unsent dispatch and an open fence.
  IF o.status='dispatching' AND o.send_started_at IS NULL THEN
   SELECT max(x2.occurred_at) INTO v_entered FROM morrow_work.operation_transitions x2
    WHERE x2.organization_id=o.organization_id AND x2.workspace_id=o.workspace_id AND x2.operation_id=p_operation_id AND x2.to_status='dispatching';
   IF v_entered IS NOT NULL AND v_entered>v_now-interval '180 seconds' THEN v_outcome:='too_soon'; EXIT settle; END IF;
   SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,o.revision,'failed','connector',
    'verified_no_effect','not_sent',NULL,NULL);
   IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
   v_status:='failed';
   v_outcome:='closed';
   EXIT settle;
  END IF;
  IF o.status='dispatching' THEN
   IF o.send_started_at>v_now-interval '90 seconds' THEN v_outcome:='too_soon'; EXIT settle; END IF;
   SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,o.revision,'uncertain','connector',
    'unknown_external_outcome','fence_expired','unknown_submission',NULL);
   IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
   v_status:='uncertain';
   v_rev:=x.revision;
  END IF;
  IF v_status NOT IN ('submitted','uncertain') THEN v_outcome:='settled'; EXIT settle; END IF;
  SELECT max(x2.observed_at) INTO v_last FROM morrow_work.operation_readbacks x2
   WHERE x2.organization_id=o.organization_id AND x2.workspace_id=o.workspace_id AND x2.operation_id=p_operation_id;
  IF v_last IS NOT NULL AND v_last>v_now-interval '10 seconds' THEN v_outcome:='too_soon'; EXIT settle; END IF;
  SELECT x2.credential_id::text AS credential_id,x2.credential_version::text AS credential_version,x2.source_updated_at INTO w
   FROM morrow_work.operation_writes x2 WHERE x2.organization_id=o.organization_id AND x2.workspace_id=o.workspace_id AND x2.operation_id=p_operation_id;
  SELECT * INTO t FROM morrow_identity.work_shopify_read_target(o.organization_id,o.workspace_id,o.store_id,o.connection_id);
  IF t.outcome='found' THEN SELECT * INTO c FROM morrow_vault.credential_for_connection(o.organization_id,o.workspace_id,t.installation_id); END IF;
  SELECT x2.canonical,x2.parameters_id::text AS parameters_id INTO p FROM morrow_work.proposals x2
   WHERE x2.organization_id=o.organization_id AND x2.workspace_id=o.workspace_id AND x2.id=o.proposal_id;
  SELECT x2.canonical,x2.redacted_at INTO q FROM morrow_work.proposal_parameters x2
   WHERE x2.organization_id=o.organization_id AND x2.workspace_id=o.workspace_id AND x2.id=p.parameters_id;
  v_target:=morrow_work.catalog_target(p.canonical::jsonb,o.target_index);
  v_item:=CASE WHEN q.redacted_at IS NULL THEN morrow_work.catalog_item(q.canonical::jsonb,o.target_index) END;
  -- No read-back without the credential the send used (an uninstall, a disconnect or a new
  -- token): a credential_unavailable row; a submitted operation becomes uncertain.
  IF w.credential_id IS NULL OR t.outcome IS DISTINCT FROM 'found' OR c.outcome IS DISTINCT FROM 'found'
   OR c.credential_id IS DISTINCT FROM w.credential_id OR c.version IS DISTINCT FROM w.credential_version OR v_target IS NULL OR v_item IS NULL THEN
   INSERT INTO morrow_work.operation_readbacks(organization_id,workspace_id,operation_id,sequence,observed_at,outcome,observed_updated_at,
    field_verdicts,verdict)
   SELECT o.organization_id,o.workspace_id,p_operation_id,COALESCE(max(x2.sequence),0)+1,date_trunc('milliseconds',v_now),'credential_unavailable',
    NULL,NULL,NULL FROM morrow_work.operation_readbacks x2
    WHERE x2.organization_id=o.organization_id AND x2.workspace_id=o.workspace_id AND x2.operation_id=p_operation_id;
   IF v_status='submitted' THEN
    SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,v_rev,'uncertain','connector',
     'unknown_external_outcome','credential_gone','verification_unavailable',NULL);
    IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
    v_status:='uncertain';
   END IF;
   v_outcome:='unavailable';
   EXIT settle;
  END IF;
  SELECT x2.canonical INTO v_source FROM morrow_work.product_snapshots x2 WHERE x2.organization_id=o.organization_id
   AND x2.workspace_id=o.workspace_id AND x2.store_id=o.store_id AND x2.digest=v_target->>'expectedSourceRevision' AND x2.product_id=o.product_id;
  v_outcome:='resolved';
 END settle;
 PERFORM morrow_vault.catalog_context_clear();
 IF v_outcome='resolved' THEN
  RETURN QUERY SELECT 'resolved'::text,v_status,o.organization_id,o.workspace_id,t.shop_domain,o.product_id,
   array_to_string(ARRAY(SELECT jsonb_array_elements_text(v_target->'fields')),','),v_item::text,v_source,w.source_updated_at,t.installation_id,
   c.credential_id,c.version,c.kek_version,c.wrapped_key,c.sealed_value;
 ELSE
  RETURN QUERY SELECT v_outcome,v_status,CASE WHEN v_outcome IN ('denied','invalid','not_found') THEN NULL ELSE o.organization_id END,
   CASE WHEN v_outcome IN ('denied','invalid','not_found') THEN NULL ELSE o.workspace_id END,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
   NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
 END IF;
END $$;

-- R2, one read-back's record and its verdict (spine §8), under the operation's row lock. The
-- broker compares each sent field: approved (the read-back equals the approved value under
-- the canonical comparison: Shopify may reorder tags or reformat HTML), else source (equal to
-- the product as drafted), else other; the overall verdict is approved, source or mixed, or
-- missing when Shopify no longer has the product. Here, only:
--   submitted: approved -> verifying -> verified; read-after-write lag (not approved, and
--     Shopify's updatedAt still the one read before the send) -> no change; anything else ->
--     verifying -> uncertain (partial_result: someone else's edit or a revert). A receipt is
--     never turned into "no effect".
--   uncertain: approved -> verifying -> verified; "no effect" (failed, verified_no_effect) only
--     when Shopify never acknowledged the send, and this read-back and an earlier one at least
--     60 seconds before it, both taken 30 seconds or more after the fence, both show every
--     field as drafted with updatedAt unchanged since before the send; otherwise no change.
-- Outcomes: recorded (with the status), too_soon, settled, not_found, invalid, denied.
CREATE FUNCTION morrow_vault.catalog_reconcile_record(p_operation_id text,p_outcome text,p_observed_updated_at text,p_field_verdicts text,
 p_verdict text)
RETURNS TABLE(outcome text,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE o record; w record; x record; v_now timestamptz; v_last timestamptz; v_verdicts jsonb; v_fields text[]; v_rev bigint; v_status text;
 v_n integer; v_approved integer; v_source integer;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF p_operation_id IS NULL OR p_operation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_outcome IS NULL OR p_outcome NOT IN ('read','not_found')
  OR (p_outcome='read')<>(p_observed_updated_at IS NOT NULL) OR (p_outcome='read')<>(p_field_verdicts IS NOT NULL)
  OR (p_outcome='read' AND (p_verdict IS NULL OR p_verdict NOT IN ('approved','source','mixed')))
  OR (p_outcome='not_found' AND p_verdict IS DISTINCT FROM 'missing')
  OR (p_observed_updated_at IS NOT NULL AND p_observed_updated_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$')
  OR (p_field_verdicts IS NOT NULL AND (octet_length(p_field_verdicts)>512 OR NOT pg_input_is_valid(p_field_verdicts,'jsonb'))) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 PERFORM morrow_vault.catalog_context(p_operation_id,NULL,NULL,NULL,NULL);
 SELECT x2.organization_id::text AS organization_id,x2.workspace_id::text AS workspace_id,x2.status,x2.revision::bigint AS revision,
  x2.send_started_at,x2.submitted_at INTO o
  FROM morrow_work.operations x2 WHERE x2.id=p_operation_id AND x2.kind='catalog_write' FOR UPDATE;
 IF NOT FOUND THEN PERFORM morrow_vault.catalog_context_clear(); RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF o.status NOT IN ('submitted','uncertain') THEN PERFORM morrow_vault.catalog_context_clear(); RETURN QUERY SELECT 'settled'::text,o.status; RETURN; END IF;
 SELECT x2.fields,x2.source_updated_at INTO w FROM morrow_work.operation_writes x2
  WHERE x2.organization_id=o.organization_id AND x2.workspace_id=o.workspace_id AND x2.operation_id=p_operation_id;
 IF NOT FOUND THEN PERFORM morrow_vault.catalog_context_clear(); RETURN QUERY SELECT 'settled'::text,o.status; RETURN; END IF;
 -- The verdicts: exactly the sent fields, each a code, consistent with the overall verdict.
 IF p_outcome='read' THEN
  v_verdicts:=p_field_verdicts::jsonb;
  IF jsonb_typeof(v_verdicts)<>'object' OR ARRAY(SELECT k FROM jsonb_object_keys(v_verdicts) k ORDER BY k COLLATE "C")<>
    ARRAY(SELECT f FROM unnest(w.fields) f ORDER BY f COLLATE "C")
   OR EXISTS(SELECT 1 FROM jsonb_each(v_verdicts) e WHERE jsonb_typeof(e.value)<>'string' OR (e.value#>>'{}') NOT IN ('approved','source','other')) THEN
   PERFORM morrow_vault.catalog_context_clear(); RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
  SELECT count(*),count(*) FILTER (WHERE e.value='"approved"'::jsonb),count(*) FILTER (WHERE e.value='"source"'::jsonb)
   INTO v_n,v_approved,v_source FROM jsonb_each(v_verdicts) e;
  IF p_verdict<>(CASE WHEN v_approved=v_n THEN 'approved' WHEN v_source=v_n THEN 'source' ELSE 'mixed' END) THEN
   PERFORM morrow_vault.catalog_context_clear(); RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
 END IF;
 v_now:=date_trunc('milliseconds',pg_catalog.clock_timestamp());
 SELECT max(x2.observed_at) INTO v_last FROM morrow_work.operation_readbacks x2
  WHERE x2.organization_id=o.organization_id AND x2.workspace_id=o.workspace_id AND x2.operation_id=p_operation_id;
 IF v_last IS NOT NULL AND v_last>v_now-interval '10 seconds' THEN
  PERFORM morrow_vault.catalog_context_clear(); RETURN QUERY SELECT 'too_soon'::text,o.status; RETURN;
 END IF;
 INSERT INTO morrow_work.operation_readbacks(organization_id,workspace_id,operation_id,sequence,observed_at,outcome,observed_updated_at,
  field_verdicts,verdict)
 SELECT o.organization_id,o.workspace_id,p_operation_id,COALESCE(max(x2.sequence),0)+1,v_now,p_outcome,p_observed_updated_at,v_verdicts,p_verdict
  FROM morrow_work.operation_readbacks x2
  WHERE x2.organization_id=o.organization_id AND x2.workspace_id=o.workspace_id AND x2.operation_id=p_operation_id;
 v_rev:=o.revision;
 v_status:=o.status;
 IF p_verdict='approved' THEN
  SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,v_rev,'verifying','connector',
   CASE WHEN o.status='submitted' THEN 'provider_terminal_result' ELSE 'reconciled_provider_result' END,'readback',NULL,NULL);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
  SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,x.revision,'verified','action_service',
   'declared_postconditions_verified','readback_matched',NULL,NULL);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
  v_status:='verified';
 ELSIF o.status='submitted' AND NOT (p_outcome='read' AND p_observed_updated_at=w.source_updated_at) THEN
  SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,v_rev,'verifying','connector',
   'provider_terminal_result','readback',NULL,NULL);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
  SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,x.revision,'uncertain','connector',
   'verification_unavailable',CASE WHEN p_outcome='not_found' THEN 'product_missing' ELSE 'readback_differs' END,'partial_result',NULL);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
  v_status:='uncertain';
 ELSIF o.status='uncertain' AND p_verdict='source' AND o.submitted_at IS NULL AND p_observed_updated_at=w.source_updated_at
  AND v_now>=o.send_started_at+interval '30 seconds'
  AND EXISTS(SELECT 1 FROM morrow_work.operation_readbacks y WHERE y.organization_id=o.organization_id AND y.workspace_id=o.workspace_id
   AND y.operation_id=p_operation_id AND y.outcome='read' AND y.verdict='source' AND y.observed_updated_at=w.source_updated_at
   AND y.observed_at<=v_now-interval '60 seconds' AND y.observed_at>=o.send_started_at+interval '30 seconds') THEN
  SELECT * INTO x FROM morrow_work.operation_transition(o.organization_id,o.workspace_id,p_operation_id,v_rev,'failed','action_service',
   'verified_no_effect','readback_no_effect',NULL,NULL);
  IF x.outcome IS DISTINCT FROM 'applied' THEN RAISE EXCEPTION 'CATALOG_OPERATION_INVALID'; END IF;
  v_status:='failed';
 END IF;
 PERFORM morrow_vault.catalog_context_clear();
 RETURN QUERY SELECT 'recorded'::text,v_status;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.catalog_target(jsonb,integer),morrow_work.catalog_item(jsonb,integer),
 morrow_work.catalog_item_matches(jsonb,jsonb),morrow_work.cmd_catalog_apply(text,text,text,text,text,text,text,text,text),
 morrow_work.cmd_catalog_dispatch(text,text),morrow_vault.catalog_context(text,text,text,text,text),morrow_vault.catalog_context_clear(),
 morrow_vault.catalog_send_refusal(text,text),morrow_vault.catalog_write_resolve(text),morrow_vault.catalog_write_begin(text,text,text,text,text),
 morrow_vault.catalog_write_end(text,text,text,text),morrow_vault.catalog_reconcile_resolve(text),
 morrow_vault.catalog_reconcile_record(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.cmd_catalog_apply(text,text,text,text,text,text,text,text,text),
 morrow_work.cmd_catalog_dispatch(text,text) TO morrow_work_api;
GRANT EXECUTE ON FUNCTION morrow_vault.catalog_write_resolve(text),morrow_vault.catalog_write_begin(text,text,text,text,text),
 morrow_vault.catalog_write_end(text,text,text,text),morrow_vault.catalog_reconcile_resolve(text),
 morrow_vault.catalog_reconcile_record(text,text,text,text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_work,morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_target(jsonb,integer) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_item(jsonb,integer) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_item_matches(jsonb,jsonb) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_catalog_apply(text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_catalog_dispatch(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.catalog_context(text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.catalog_context_clear() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.catalog_send_refusal(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.catalog_write_resolve(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.catalog_write_begin(text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.catalog_write_end(text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.catalog_reconcile_resolve(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.catalog_reconcile_record(text,text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work,morrow_vault FROM morrow_work_command;
COMMIT;
