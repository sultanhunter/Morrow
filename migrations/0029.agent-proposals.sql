BEGIN;
-- M3 PR-1 agent proposals and parameter redaction (ADR-0022 items 1-3 and 13; spine §7 and
-- §11). Executes AS morrow_work_owner, a forward migration on the P06.T01b tables.
--   * proposals admits an agent proposer and a store: store_id and connection_id (both or
--     neither), proposer_kind (human or agent), proposer_installation_id, and a nullable
--     proposer_membership_id. A human proposer has a membership and no installation; an
--     agent proposer an installation and no membership.
--   * proposals_document becomes two checks by capability: every non-catalog proposal keeps
--     the P06.T01b document check unchanged and must be a human's storeless proposal; a
--     catalog.* proposal must satisfy catalog_proposal_document_matches: Proposal@2 bound to
--     its store S and connection C (scope.storeIds [S], product targets on S and C with the
--     listing fields, maximumCredits "0", maximumCost null), a non-null task,
--     contextTaint untrusted_external, proposed by the agent of installation I.
--   * catalog_proposal_bind (BEFORE INSERT): a root catalog proposal is a
--     catalog.content.publish proposal of the store's active morrow.listings installation
--     and its own agent principal, on the current store connection.
--   * proposal_bind is replaced so a derived proposal inherits the store, connection,
--     proposer kind and installation of its root, and NULL cannot bypass the proposer
--     comparison (IS DISTINCT FROM).
--   * Parameter redaction (spine §11): proposal_parameters.redacted_at; the digest CHECK
--     admits only (unredacted and the digest of the text) or (redacted and '{}', the digest
--     kept); parameters_guard replaces the append-only trigger and admits only that one
--     change; the revisable owner helper parameters_redact_for_store empties every
--     parameter row a store's proposals name (M2 PR-3's shop/redact definer calls it);
--     decision_bind is replaced and approval_claims gains claim_parameters_bind, so a
--     redacted proposal can never be decided or claimed.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR to_regclass('morrow_work.agent_installations') IS NULL OR to_regclass('morrow_work.proposals') IS NULL
 OR to_regprocedure('morrow_work.listings_store_current(text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.proposal_document_matches(text,text,text,text,text,bigint,text,text,integer[],text,text,text,boolean,text,integer,numeric,text,text,text,text,text[],text,bigint,text,text,text,timestamp with time zone,timestamp with time zone)') IS NULL
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_work.proposals'::regclass AND a.attname IN ('store_id','proposer_kind'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_work.proposal_parameters'::regclass AND a.attname='redacted_at')
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.proposal_parameters'::regclass AND c.conname='proposal_parameters_digest')
  IS DISTINCT FROM 'CHECK (((digest)::text = morrow_work.sha256_text(canonical)))'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.proposals'::regclass AND c.conname='proposals_document'
   AND pg_catalog.pg_get_constraintdef(c.oid) LIKE 'CHECK (morrow_work.proposal_document_matches(canonical, scope_canonical, %')
 OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgrelid='morrow_work.proposal_parameters'::regclass AND t.tgname='append_only' AND NOT t.tgisinternal)<>1
 OR NOT morrow_identity.morrow_memberships_closed()
 THEN RAISE EXCEPTION 'AGENT_PROPOSALS_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The catalog Proposal@2 document check (spine §7). IMMUTABLE, owned by the owner,
-- EXECUTE for the command role (CHECK constraints run with the writer's privileges).
CREATE FUNCTION morrow_work.catalog_proposal_document_matches(p_canonical text,p_scope_canonical text,p_org text,p_ws text,p_id text,
 p_revision bigint,p_derived_from_id text,p_derived_from_digest text,p_selected integer[],p_task_id text,p_capability_id text,p_risk text,
 p_irreversible boolean,p_partial_approval text,p_target_count integer,p_maximum_credits numeric,p_proposer_principal text,
 p_proposer_installation text,p_requester_principal text,p_requester_membership text,p_beneficiaries text[],p_policy_id text,
 p_policy_revision bigint,p_policy_digest text,p_parameters_id text,p_parameters_digest text,p_expires_at timestamptz,p_created_at timestamptz,
 p_store_id text,p_connection_id text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE
 k text[]:=ARRAY['schemaVersion','id','organizationId','workspaceId','storeId','revision','createdAt','updatedAt','taskId','capabilityId',
  'scope','targets','parametersRef','parametersDigest','maximumCredits','maximumCost','risk','irreversible','reviewPolicyRef','proposedBy',
  'requestedBy','beneficiaryPrincipalIds','contextTaint','partialApproval','derivedFrom','expiresAt'];
 tk text[]:=ARRAY['resource','expectedSourceRevision','fields','maximumCredits','maximumCost'];
 listing text[]:=ARRAY['descriptionHtml','seo.description','seo.title','tags','title'];
 d jsonb; s jsonb; t jsonb; f jsonb; r jsonb; v_fields jsonb; v_resources jsonb;
BEGIN
 IF p_canonical IS NULL OR p_scope_canonical IS NULL OR p_created_at IS NULL OR p_expires_at IS NULL OR p_store_id IS NULL
  OR p_connection_id IS NULL OR p_task_id IS NULL OR p_proposer_installation IS NULL OR p_capability_id NOT LIKE 'catalog.%'
  OR NOT pg_input_is_valid(p_canonical,'jsonb') OR NOT pg_input_is_valid(p_scope_canonical,'jsonb') THEN RETURN false; END IF;
 d:=p_canonical::jsonb; s:=p_scope_canonical::jsonb;
 IF jsonb_typeof(d)<>'object' OR NOT (d ?& k) OR (d-k)<>'{}'::jsonb THEN RETURN false; END IF;
 IF d->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR d->'id' IS DISTINCT FROM to_jsonb(p_id)
  OR d->'organizationId' IS DISTINCT FROM to_jsonb(p_org) OR d->'workspaceId' IS DISTINCT FROM to_jsonb(p_ws)
  OR d->'storeId' IS DISTINCT FROM to_jsonb(p_store_id) OR d->'revision' IS DISTINCT FROM to_jsonb(p_revision)
  OR d->'createdAt' IS DISTINCT FROM to_jsonb(morrow_work.utc_text(p_created_at))
  OR d->'updatedAt' IS DISTINCT FROM to_jsonb(morrow_work.utc_text(p_created_at))
  OR d->'expiresAt' IS DISTINCT FROM to_jsonb(morrow_work.utc_text(p_expires_at))
  OR d->'taskId' IS DISTINCT FROM to_jsonb(p_task_id)
  OR d->'capabilityId' IS DISTINCT FROM to_jsonb(p_capability_id) OR d->'risk' IS DISTINCT FROM to_jsonb(p_risk)
  OR d->'irreversible' IS DISTINCT FROM to_jsonb(p_irreversible) OR d->'partialApproval' IS DISTINCT FROM to_jsonb(p_partial_approval)
  OR d->'contextTaint' IS DISTINCT FROM '"untrusted_external"'::jsonb
  OR d->'proposedBy' IS DISTINCT FROM jsonb_build_object('kind','agent','principalId',p_proposer_principal,'organizationId',p_org,
   'workspaceId',p_ws,'membershipId',NULL,'installationId',p_proposer_installation,'mandateId',NULL)
  OR d->'requestedBy' IS DISTINCT FROM jsonb_build_object('kind','human','principalId',p_requester_principal,'organizationId',p_org,
   'workspaceId',p_ws,'membershipId',p_requester_membership,'installationId',NULL,'mandateId',NULL)
  OR d->'beneficiaryPrincipalIds' IS DISTINCT FROM to_jsonb(p_beneficiaries)
  OR d->'reviewPolicyRef' IS DISTINCT FROM jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',NULL,'kind','policy',
   'id',p_policy_id,'revision',p_policy_revision,'digest',p_policy_digest)
  OR d->'parametersRef' IS DISTINCT FROM jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',p_store_id,'kind','artifact',
   'id',p_parameters_id,'revision',1,'digest',p_parameters_digest)
  OR d->'parametersDigest' IS DISTINCT FROM to_jsonb(p_parameters_digest)
  OR d->'derivedFrom' IS DISTINCT FROM (CASE WHEN p_derived_from_id IS NULL THEN 'null'::jsonb ELSE jsonb_build_object('parentRef',
   jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',p_store_id,'kind','proposal','id',p_derived_from_id,'revision',1,
    'digest',p_derived_from_digest),'selectedTargetIndexes',to_jsonb(p_selected)) END)
  OR d->'maximumCredits' IS DISTINCT FROM '"0"'::jsonb OR p_maximum_credits IS DISTINCT FROM 0
  OR d->'maximumCost' IS DISTINCT FROM 'null'::jsonb THEN
  RETURN false;
 END IF;
 IF cardinality(p_beneficiaries)>100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'beneficiaryPrincipalIds') e WHERE NOT morrow_work.json_id(e))
  OR (SELECT count(DISTINCT e) FROM unnest(p_beneficiaries) e)<>cardinality(p_beneficiaries) THEN RETURN false; END IF;
 -- Targets: products of this store and connection, the listing fields, no credits or cost.
 t:=d->'targets';
 IF jsonb_typeof(t)<>'array' OR p_target_count IS NULL OR p_target_count NOT BETWEEN 1 AND 100 OR jsonb_array_length(t)<>p_target_count THEN
  RETURN false;
 END IF;
 FOR f IN SELECT x FROM jsonb_array_elements(t) x LOOP
  IF jsonb_typeof(f)<>'object' OR NOT (f ?& tk) OR (f-tk)<>'{}'::jsonb THEN RETURN false; END IF;
  r:=f->'resource';
  IF jsonb_typeof(r)<>'object' OR r IS DISTINCT FROM jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',p_store_id,
    'connectionId',p_connection_id,'kind','product','id',r->'id') OR jsonb_typeof(r->'id')<>'string'
   OR (r->>'id') !~ '^product:[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
  IF jsonb_typeof(f->'expectedSourceRevision')<>'string' OR char_length(f->>'expectedSourceRevision') NOT BETWEEN 1 AND 256
   OR jsonb_typeof(f->'fields')<>'array' OR jsonb_array_length(f->'fields') NOT BETWEEN 1 AND 5
   OR f->'maximumCredits' IS DISTINCT FROM '"0"'::jsonb OR f->'maximumCost' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(f->'fields') e WHERE jsonb_typeof(e)<>'string' OR NOT ((e#>>'{}')=ANY(listing)))
   OR (SELECT count(DISTINCT e) FROM jsonb_array_elements(f->'fields') e)<>jsonb_array_length(f->'fields') THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT x->'resource'->>'id') FROM jsonb_array_elements(t) x)<>jsonb_array_length(t) THEN RETURN false; END IF;
 -- Scope: {O, W, [S], [], the target resources in target order, the sorted distinct fields}.
 SELECT jsonb_agg(x->'resource' ORDER BY o) INTO v_resources FROM jsonb_array_elements(t) WITH ORDINALITY q(x,o);
 SELECT jsonb_agg(x ORDER BY x COLLATE "C") INTO v_fields
  FROM (SELECT DISTINCT e AS x FROM jsonb_array_elements(t) q(target), jsonb_array_elements_text(q.target->'fields') e) u;
 IF s IS DISTINCT FROM jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeIds',jsonb_build_array(p_store_id),'accountIds','[]'::jsonb,
   'resources',v_resources,'fields',v_fields) OR d->'scope' IS DISTINCT FROM s THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION morrow_work.catalog_proposal_document_matches(text,text,text,text,text,bigint,text,text,integer[],text,text,text,boolean,
 text,integer,numeric,text,text,text,text,text[],text,bigint,text,text,text,timestamptz,timestamptz,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.catalog_proposal_document_matches(text,text,text,text,text,bigint,text,text,integer[],text,text,text,boolean,
 text,integer,numeric,text,text,text,text,text[],text,bigint,text,text,text,timestamptz,timestamptz,text,text) TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- proposals: the agent proposer and the store.
ALTER TABLE morrow_work.proposals ALTER COLUMN proposer_membership_id DROP NOT NULL,
 ADD COLUMN store_id morrow_work.record_id,
 ADD COLUMN connection_id morrow_work.record_id,
 ADD COLUMN proposer_kind text NOT NULL DEFAULT 'human' CHECK (proposer_kind IN ('human','agent')),
 ADD COLUMN proposer_installation_id morrow_work.record_id;
ALTER TABLE morrow_work.proposals
 ADD CONSTRAINT proposals_proposer CHECK ((proposer_kind='human')=(proposer_membership_id IS NOT NULL)
  AND (proposer_kind='agent')=(proposer_installation_id IS NOT NULL) AND (store_id IS NULL)=(connection_id IS NULL)),
 ADD CONSTRAINT proposals_proposer_installation FOREIGN KEY (organization_id,workspace_id,proposer_installation_id)
  REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 DROP CONSTRAINT proposals_document,
 ADD CONSTRAINT proposals_document CHECK (CASE WHEN capability_id LIKE 'catalog.%' THEN
  morrow_work.catalog_proposal_document_matches(canonical,scope_canonical,organization_id,workspace_id,id,revision,derived_from_id,derived_from_digest,
   selected_target_indexes,task_id,capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,proposer_principal_id,
   proposer_installation_id,requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,
   review_policy_digest,parameters_id,parameters_digest,expires_at,created_at,store_id,connection_id) AND proposer_kind='agent'
  ELSE morrow_work.proposal_document_matches(canonical,scope_canonical,organization_id,workspace_id,id,revision,derived_from_id,derived_from_digest,
   selected_target_indexes,task_id,capability_id,risk,irreversible,partial_approval,target_count,maximum_credits,proposer_principal_id,
   proposer_membership_id,requester_principal_id,requester_membership_id,beneficiary_principal_ids,review_policy_id,review_policy_revision,
   review_policy_digest,parameters_id,parameters_digest,expires_at,created_at)
   AND proposer_kind='human' AND store_id IS NULL AND connection_id IS NULL AND proposer_installation_id IS NULL END);
CREATE INDEX proposals_store ON morrow_work.proposals (organization_id,workspace_id,store_id) WHERE store_id IS NOT NULL;
GRANT SELECT (store_id,connection_id,proposer_kind,proposer_installation_id) ON morrow_work.proposals TO morrow_work_api;

-- A root catalog proposal: catalog.content.publish only, by the store's active Listings
-- installation through its own agent principal, on the current store connection. A
-- derived proposal inherits all of it from its root (proposal_bind, after this trigger).
CREATE FUNCTION morrow_work.catalog_proposal_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF NEW.capability_id NOT LIKE 'catalog.%' OR NEW.derived_from_id IS NOT NULL THEN RETURN NEW; END IF;
 IF NEW.capability_id<>'catalog.content.publish' OR NEW.proposer_kind IS DISTINCT FROM 'agent' OR NEW.store_id IS NULL
  OR NEW.connection_id IS NULL OR NEW.proposer_installation_id IS NULL OR NEW.task_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM morrow_work.listings_store_current(NEW.organization_id,NEW.workspace_id,NEW.store_id) x
   WHERE x.connection_id=NEW.connection_id)
  OR NOT EXISTS(SELECT 1 FROM morrow_work.agent_installations i WHERE i.organization_id=NEW.organization_id AND i.workspace_id=NEW.workspace_id
   AND i.id=NEW.proposer_installation_id AND i.status='active' AND i.release_id='morrow.listings' AND i.store_id=NEW.store_id
   AND i.connection_id=NEW.connection_id AND i.agent_principal_id=NEW.proposer_principal_id) THEN
  RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_work.catalog_proposal_bind() FROM PUBLIC;
CREATE TRIGGER catalog_proposal_bind BEFORE INSERT ON morrow_work.proposals FOR EACH ROW EXECUTE FUNCTION morrow_work.catalog_proposal_bind();

-- proposal_bind (0018), replaced: a derived proposal also inherits its root's store,
-- connection, proposer kind and installation, and every proposer and requester comparison
-- is NULL-safe. Every other rule is 0018's, unchanged.
CREATE OR REPLACE FUNCTION morrow_work.proposal_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE cap record; v_risk text; v_rules jsonb; r jsonb; parent record; d jsonb; pd jsonb; v_targets jsonb; i integer; prev integer:=-1;
BEGIN
 -- No writer stores a proposal created in the future (commands also bind it to
 -- their own transaction time).
 IF NEW.created_at>date_trunc('milliseconds',clock_timestamp()) THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 SELECT x.effect,x.irreversible,x.review_required,x.kill_switch INTO cap FROM morrow_work.review_capabilities x WHERE x.capability_id=NEW.capability_id;
 IF NOT FOUND OR NOT cap.review_required OR cap.kill_switch OR NEW.capability_id='governance.connection.connect' THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 SELECT x.risk INTO v_risk FROM morrow_work.review_risk_by_effect x WHERE x.effect=cap.effect;
 IF v_risk IS DISTINCT FROM NEW.risk OR NEW.irreversible IS DISTINCT FROM cap.irreversible THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 SELECT x.rules INTO v_rules FROM morrow_work.review_policies x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id
  AND x.id=NEW.review_policy_id AND x.revision=NEW.review_policy_revision AND x.digest=NEW.review_policy_digest;
 IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 r:=morrow_work.effective_rule(v_rules,NEW.risk,NEW.irreversible);
 IF NEW.derived_from_id IS NULL THEN
  IF NEW.expires_at IS DISTINCT FROM NEW.created_at+make_interval(secs=>(r->>'pendingExpirySeconds')::integer
    +(v_rules#>>'{soloOwner,coolDownSeconds}')::integer+(r->>'approvedValiditySeconds')::integer) THEN
   RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 SELECT x.* INTO parent FROM morrow_work.proposals x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.derived_from_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 -- The 0018 writer of derived proposals (cmd_approval_decide) names none of these columns:
 -- the root's values are the only ones a derived proposal may carry.
 NEW.store_id:=parent.store_id; NEW.connection_id:=parent.connection_id;
 NEW.proposer_kind:=parent.proposer_kind; NEW.proposer_installation_id:=parent.proposer_installation_id;
 IF parent.derived_from_id IS NOT NULL OR parent.partial_approval<>'allowed' OR parent.digest IS DISTINCT FROM NEW.derived_from_digest
  OR parent.task_id IS DISTINCT FROM NEW.task_id OR parent.capability_id<>NEW.capability_id OR parent.risk<>NEW.risk OR parent.irreversible<>NEW.irreversible
  OR parent.proposer_principal_id IS DISTINCT FROM NEW.proposer_principal_id OR parent.proposer_membership_id IS DISTINCT FROM NEW.proposer_membership_id
  OR parent.requester_principal_id IS DISTINCT FROM NEW.requester_principal_id OR parent.requester_membership_id IS DISTINCT FROM NEW.requester_membership_id
  OR parent.beneficiary_principal_ids IS DISTINCT FROM NEW.beneficiary_principal_ids
  OR parent.review_policy_id<>NEW.review_policy_id OR parent.review_policy_revision<>NEW.review_policy_revision OR parent.review_policy_digest<>NEW.review_policy_digest
  OR parent.parameters_id<>NEW.parameters_id OR parent.parameters_digest<>NEW.parameters_digest
  OR parent.created_at<>NEW.created_at OR parent.expires_at<>NEW.expires_at THEN
  RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
 END IF;
 IF NEW.selected_target_indexes IS NULL OR cardinality(NEW.selected_target_indexes)<1 OR cardinality(NEW.selected_target_indexes)>=parent.target_count
  OR NEW.target_count<>cardinality(NEW.selected_target_indexes) THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 FOREACH i IN ARRAY NEW.selected_target_indexes LOOP
  IF i IS NULL OR i<=prev OR i>=parent.target_count THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
  prev:=i;
 END LOOP;
 IF NOT pg_input_is_valid(NEW.canonical,'jsonb') THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 d:=NEW.canonical::jsonb; pd:=parent.canonical::jsonb;
 SELECT jsonb_agg(pd->'targets'->u.ix ORDER BY u.o) INTO v_targets FROM unnest(NEW.selected_target_indexes) WITH ORDINALITY u(ix,o);
 IF d->'targets' IS DISTINCT FROM v_targets OR NEW.maximum_credits>parent.maximum_credits THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 IF d->'maximumCost' IS DISTINCT FROM 'null'::jsonb THEN
  IF pd->'maximumCost'='null'::jsonb OR (d#>>'{maximumCost,amount}') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$'
   OR (pd#>>'{maximumCost,amount}') !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$' THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
  IF (d#>>'{maximumCost,amount}')::numeric>(pd#>>'{maximumCost,amount}')::numeric THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 END IF;
 RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Parameter redaction (spine §11; ADR-0022 item 13).
ALTER TABLE morrow_work.proposal_parameters
 ADD COLUMN redacted_at timestamptz CHECK (redacted_at=date_trunc('milliseconds',redacted_at) AND isfinite(redacted_at)),
 DROP CONSTRAINT proposal_parameters_digest,
 ADD CONSTRAINT proposal_parameters_digest CHECK ((redacted_at IS NULL AND digest::text=morrow_work.sha256_text(canonical))
  OR (redacted_at IS NOT NULL AND canonical='{}' AND redacted_at>=created_at));
GRANT UPDATE (canonical,redacted_at) ON morrow_work.proposal_parameters TO morrow_work_command;
GRANT SELECT (redacted_at) ON morrow_work.proposal_parameters TO morrow_work_api;
-- Append-only except the one redaction: redacted_at null to set, canonical to '{}', every
-- other column (the digest included) unchanged. No delete.
CREATE FUNCTION morrow_work.parameters_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL AND NEW.canonical='{}'
  AND (to_jsonb(NEW)-ARRAY['canonical','redacted_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['canonical','redacted_at']) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'WORK_RECORD_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION morrow_work.parameters_guard() FROM PUBLIC;
DROP TRIGGER append_only ON morrow_work.proposal_parameters;
CREATE TRIGGER parameters_guard BEFORE UPDATE OR DELETE ON morrow_work.proposal_parameters FOR EACH ROW EXECUTE FUNCTION morrow_work.parameters_guard();
-- decision_bind (0018), replaced: a decision never lands on a proposal whose parameters
-- were redacted. Every other rule is 0018's, unchanged.
CREATE OR REPLACE FUNCTION morrow_work.decision_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE a record; prop record; v_count integer;
BEGIN
 SELECT x.* INTO a FROM morrow_work.approvals x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.approval_id;
 IF NOT FOUND OR a.status<>'pending' OR NEW.decided_at<a.created_at OR NEW.decided_digest<>a.proposal_digest THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM morrow_work.proposals x JOIN morrow_work.proposal_parameters q ON q.organization_id=x.organization_id
   AND q.workspace_id=x.workspace_id AND q.id=x.parameters_id WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id
   AND x.id=a.proposal_id AND q.redacted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'APPROVAL_PARAMETERS_REDACTED';
 END IF;
 SELECT count(*) INTO v_count FROM morrow_work.approval_decisions x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.approval_id=NEW.approval_id;
 IF NEW.sequence<>v_count+1 THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 IF a.eligible_reviewer_principal_ids IS NOT NULL AND NOT (NEW.reviewer_principal_id::text=ANY(a.eligible_reviewer_principal_ids)) THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
 SELECT x.proposer_principal_id::text AS proposer,x.requester_principal_id::text AS requester,x.beneficiary_principal_ids,x.canonical INTO prop
  FROM morrow_work.proposals x WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=a.proposal_id;
 IF NEW.decision='approve' AND morrow_work.conflicted(prop.proposer,prop.requester,prop.beneficiary_principal_ids,NEW.reviewer_principal_id) THEN
  IF a.self_approval='denied' THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
  ELSIF a.self_approval='solo_owner_typed_confirmation' THEN
   IF NEW.solo_phrase_digest IS DISTINCT FROM morrow_work.sha256_text(morrow_work.solo_phrase(prop.canonical::jsonb))
    OR NEW.solo_cool_down_seconds IS DISTINCT FROM a.cool_down_seconds THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID'; END IF;
  ELSIF NEW.solo_phrase_digest IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
  END IF;
 ELSIF NEW.solo_phrase_digest IS NOT NULL THEN RAISE EXCEPTION 'APPROVAL_RECORD_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- A claim never consumes a proposal whose parameters were redacted (approval_claim is
-- command-owned and final, so its table refuses the row).
CREATE FUNCTION morrow_work.claim_parameters_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM morrow_work.approvals a JOIN morrow_work.proposals x ON x.organization_id=a.organization_id
   AND x.workspace_id=a.workspace_id AND x.id=a.proposal_id JOIN morrow_work.proposal_parameters q ON q.organization_id=x.organization_id
   AND q.workspace_id=x.workspace_id AND q.id=x.parameters_id WHERE a.organization_id=NEW.organization_id AND a.workspace_id=NEW.workspace_id
   AND a.id=NEW.approval_id AND q.redacted_at IS NOT NULL) THEN
  RAISE EXCEPTION 'APPROVAL_PARAMETERS_REDACTED';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_work.claim_parameters_bind() FROM PUBLIC;
CREATE TRIGGER claim_parameters_bind BEFORE INSERT ON morrow_work.approval_claims FOR EACH ROW EXECUTE FUNCTION morrow_work.claim_parameters_bind();

-- The redaction helper (revisable, owned by the owner, INVOKER, EXECUTE for the command role
-- only): empties every unredacted parameter row that a proposal on the store names, keeping
-- each digest, under the caller's own policies (M2 PR-3's shop/redact definer). Outcomes:
-- applied (with the number redacted), invalid.
CREATE FUNCTION morrow_work.parameters_redact_for_store(p_org text,p_ws text,p_store_id text)
RETURNS TABLE(outcome text,redacted integer)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE n integer; v_at timestamptz:=date_trunc('milliseconds',clock_timestamp());
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN;
 END IF;
 UPDATE morrow_work.proposal_parameters q SET canonical='{}',redacted_at=greatest(v_at,q.created_at)
  WHERE q.organization_id=p_org AND q.workspace_id=p_ws AND q.redacted_at IS NULL
   AND q.id IN (SELECT x.parameters_id FROM morrow_work.proposals x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.store_id=p_store_id);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN QUERY SELECT 'applied'::text,n;
END $$;
REVOKE ALL ON FUNCTION morrow_work.parameters_redact_for_store(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.parameters_redact_for_store(text,text,text) TO morrow_work_command;
COMMIT;
