BEGIN;
-- v1 PR 3, review half (ADR-0022 items 1-3 and 13; ADR-0011; ADR-0024 item 8; spine §2 step 10):
-- the two reads the review screen needs beyond the approval records. Executes AS
-- morrow_work_owner, after the listings runs (0038). On the ADR-0010 tenant pattern: session
-- definers owned by morrow_work_command, EXECUTE for morrow_work_api only, the tenant only
-- from current_tenant(). No table, policy, CHECK or grant on a table changes, and nothing here
-- sends a request.
--   * catalog_review_sources: for each target of one catalog.content.publish proposal, the
--     product as the Listings run read it (the snapshot its expectedSourceRevision names,
--     store content, 90 days), or `expired` once the snapshot is gone or past its window, or
--     `redacted` once shop/redact emptied the proposal's parameters. The api role holds no
--     SELECT on product_snapshots; the Worker first requires the proposal's read rule and
--     `view` on catalog.products.read on the store resource (the kernel, in code).
--   * catalog_claim_of: the one claim of a review family, ids only (approval_claims is
--     tenant-internal), so the review screen and the apply route can tell "applied by you",
--     "applied by someone else" and "not applied yet" apart.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR to_regclass('morrow_work.product_snapshots') IS NULL OR to_regclass('morrow_work.run_drafts') IS NULL
 OR to_regclass('morrow_work.approval_claims') IS NULL OR to_regclass('morrow_work.proposal_parameters') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_work.proposal_parameters'::regclass AND a.attname='redacted_at' AND NOT a.attisdropped)
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_work.proposals'::regclass AND a.attname='store_id' AND NOT a.attisdropped)
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL OR to_regprocedure('morrow_work.db_now()') IS NULL
 OR to_regprocedure('morrow_work.utc_text(timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.catalog_review_sources(text)') IS NOT NULL
 OR to_regprocedure('morrow_work.catalog_claim_of(text)') IS NOT NULL
 THEN RAISE EXCEPTION 'CATALOG_REVIEW_PREREQUISITES_INVALID'; END IF;
END $$;

-- The "before" side of one proposal's review, target by target in the proposal's order. A
-- proposal that is not this tenant's, not catalog.content.publish or not store-bound yields
-- no rows (the Worker answers not_found). Outcomes per target: available (with the snapshot's
-- canonical text), expired, redacted.
CREATE FUNCTION morrow_work.catalog_review_sources(p_proposal_id text)
RETURNS TABLE(target_index text,product_id text,state text,snapshot text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; p record; v_redacted boolean; v_now timestamptz; tg jsonb; v_index integer:=0; s record; v_product text; v_revision text;
BEGIN
 IF p_proposal_id IS NULL OR p_proposal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT x.canonical,x.store_id::text AS store_id,x.capability_id,x.parameters_id::text AS parameters_id INTO p FROM morrow_work.proposals x
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=p_proposal_id;
 IF NOT FOUND OR p.capability_id<>'catalog.content.publish' OR p.store_id IS NULL THEN RETURN; END IF;
 SELECT q.redacted_at IS NOT NULL INTO v_redacted FROM morrow_work.proposal_parameters q
  WHERE q.organization_id=t.organization_id AND q.workspace_id=t.workspace_id AND q.id=p.parameters_id;
 IF NOT FOUND THEN RETURN; END IF;
 v_now:=morrow_work.db_now();
 FOR tg IN SELECT e.x FROM jsonb_array_elements(p.canonical::jsonb->'targets') WITH ORDINALITY e(x,o) ORDER BY e.o LOOP
  v_product:=tg#>>'{resource,id}';
  v_revision:=tg->>'expectedSourceRevision';
  IF v_redacted THEN
   RETURN QUERY SELECT v_index::text,v_product,'redacted'::text,NULL::text;
  ELSE
   SELECT x.canonical,x.expires_at INTO s FROM morrow_work.product_snapshots x
    WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.store_id=p.store_id AND x.digest=v_revision
     AND x.product_id=v_product;
   IF FOUND AND s.expires_at>v_now THEN
    RETURN QUERY SELECT v_index::text,v_product,'available'::text,s.canonical;
   ELSE
    RETURN QUERY SELECT v_index::text,v_product,'expired'::text,NULL::text;
   END IF;
  END IF;
  v_index:=v_index+1;
 END LOOP;
END $$;

-- The claim of one review family (any member's id names its family), or no row. Ids and the
-- claim time only.
CREATE FUNCTION morrow_work.catalog_claim_of(p_proposal_id text)
RETURNS TABLE(approval_id text,proposal_id text,claimant_principal_id text,claimant_membership_id text,consumer text,
 consumer_command_id text,claimed_at text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; v_root text;
BEGIN
 IF p_proposal_id IS NULL OR p_proposal_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT x.family_root_id::text INTO v_root FROM morrow_work.proposals x
  WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id AND x.id=p_proposal_id;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT c.approval_id::text,a.proposal_id::text,c.claimant_principal_id::text,c.claimant_membership_id::text,c.consumer,
  c.consumer_command_id::text,morrow_work.utc_text(c.claimed_at)
  FROM morrow_work.approval_claims c JOIN morrow_work.approvals a ON a.organization_id=c.organization_id AND a.workspace_id=c.workspace_id
   AND a.id=c.approval_id
  WHERE c.organization_id=t.organization_id AND c.workspace_id=t.workspace_id AND c.family_root_id=v_root;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.catalog_review_sources(text),morrow_work.catalog_claim_of(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.catalog_review_sources(text),morrow_work.catalog_claim_of(text) TO morrow_work_api;
GRANT CREATE ON SCHEMA morrow_work TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_review_sources(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.catalog_claim_of(text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work FROM morrow_work_command;
COMMIT;
