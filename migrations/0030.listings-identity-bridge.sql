BEGIN;
-- M3 PR-1 listings identity bridge (ADR-0022 items 3, 8 and 9; mvp-architecture §5-§7;
-- P05.T04b minimum). Executes AS morrow_identity_owner. It changes no existing row.
--   * Agent principals: morrow_identity.agent_principals records the workspace's built-in
--     Coordinator (role coordinator, one per workspace) and one principal per agent
--     installation (role installation). principals gains UNIQUE (id, kind) so grants can
--     bind a grant's principal kind to the principal's.
--   * grants admits agent principals: membership_id is null exactly for kind agent
--     (principal_kind, agent_principal_id and the grants_payload_binding CHECK, which
--     replaces the unnamed 0002 CHECK grants_check with the same payload binding plus the
--     kind rule). The membership foreign keys stay MATCH SIMPLE, so they bind only humans;
--     an agent grant names an agent principal of its own workspace (foreign key). Every
--     existing human-grant reader filters membership_id = the actor's membership, which a
--     NULL never matches.
--   * Bridges (SECURITY DEFINER, identity-owned and so revisable by a later identity-owner
--     migration, EXECUTE for morrow_work_command only): work_agent_principal_ensure,
--     work_agent_grants_issue (a fixed allowlist: the Listings installation's three
--     catalogue grants on exactly its store resource and the listing FieldPaths, never
--     approve or execute on catalog.content.publish; the Coordinator's
--     workspace.task.delegate {delegate} on one task, expiring within 24 hours; issued by
--     the session's own human), work_owner_disable_grant_issue (agents.installation.disable
--     {execute} for the session's human on one installation),
--     work_agent_grant_set_current (whether a stopped installation's grants are still
--     exactly its document's grant set, for the resume of the item 3 amendment) and
--     work_delegation_actor_facts (liveness and capability-filtered grants for the agent
--     kernel, for the runtime login only).
--   * agent_principals has a (tenant, principal, installation) key the work tables'
--     composite foreign keys reference (REFERENCES for the work owner, the 0014 pattern).
-- Role checks use the ADR-0020 helpers; no membership catalog text appears here.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regprocedure('morrow_identity.work_session_context(text,text)') IS NULL
 OR to_regprocedure('morrow_identity.work_lock_and_recheck_exclusive(text,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.work_lease_member_current(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.work_executor_safe(text)') IS NULL
 OR to_regprocedure('morrow_identity.work_store_installations(text,text)') IS NULL
 OR to_regclass('morrow_identity.agent_principals') IS NOT NULL
 -- The unnamed 0002 payload CHECK, exactly as 0002 created it.
 OR (SELECT count(*) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_identity.grants'::regclass AND c.contype='c')<>1
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_identity.grants'::regclass AND c.conname='grants_check'
   AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%(payload ->> ''id''::text) = (id)::text%'
   AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%(payload #>> ''{principal,membershipId}''::text[]) = (membership_id)::text%')
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_identity.grants'::regclass AND a.attname IN ('principal_kind','agent_principal_id'))
 THEN RAISE EXCEPTION 'LISTINGS_IDENTITY_BRIDGE_PREREQUISITES_INVALID'; END IF;
END $$;

ALTER TABLE morrow_identity.principals ADD CONSTRAINT principals_id_kind UNIQUE (id,kind);

-- One row per agent principal: the workspace's Coordinator, or one agent installation's
-- principal. Read and written only through the bridges below (FORCE RLS, owner policy).
CREATE TABLE morrow_identity.agent_principals (
 principal_id morrow_identity.record_id PRIMARY KEY,
 principal_kind text NOT NULL DEFAULT 'agent' CHECK (principal_kind='agent'),
 organization_id morrow_identity.record_id NOT NULL,
 workspace_id morrow_identity.record_id NOT NULL,
 role text NOT NULL CHECK (role IN ('coordinator','installation')),
 installation_id morrow_identity.record_id,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 FOREIGN KEY (principal_id,principal_kind) REFERENCES morrow_identity.principals(id,kind),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 UNIQUE (organization_id,workspace_id,principal_id),
 UNIQUE (organization_id,workspace_id,installation_id),
 -- The work tables bind an installation (and a delegation hop's agent) to its own agent
 -- principal through this key (the 0014 REFERENCES pattern, below).
 UNIQUE (organization_id,workspace_id,principal_id,installation_id),
 CONSTRAINT agent_principals_role CHECK ((role='coordinator')=(installation_id IS NULL))
);
CREATE UNIQUE INDEX agent_principals_one_coordinator ON morrow_identity.agent_principals (organization_id,workspace_id) WHERE role='coordinator';
ALTER TABLE morrow_identity.agent_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow_identity.agent_principals FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_owner ON morrow_identity.agent_principals TO morrow_identity_owner USING (true) WITH CHECK (true);
REVOKE ALL ON morrow_identity.agent_principals FROM PUBLIC;
GRANT REFERENCES (organization_id,workspace_id,principal_id,installation_id) ON morrow_identity.agent_principals TO morrow_work_owner;

-- The grants forward change. New columns go last, so 6-value inserts keep working.
ALTER TABLE morrow_identity.grants ALTER COLUMN membership_id DROP NOT NULL,
 ADD COLUMN principal_kind text NOT NULL DEFAULT 'human' CHECK (principal_kind IN ('human','agent')),
 ADD COLUMN agent_principal_id morrow_identity.record_id;
ALTER TABLE morrow_identity.grants DROP CONSTRAINT grants_check,
 ADD CONSTRAINT grants_payload_binding CHECK ((jsonb_typeof(payload)='object'
  AND payload->>'id'=id::text
  AND payload#>>'{principal,organizationId}'=organization_id::text
  AND payload#>>'{principal,workspaceId}'=workspace_id::text
  AND payload#>>'{principal,principalId}'=principal_id::text
  AND payload#>>'{principal,kind}'=principal_kind
  AND payload#>>'{scope,organizationId}'=organization_id::text
  AND payload#>>'{scope,workspaceId}'=workspace_id::text
  AND CASE principal_kind
   WHEN 'human' THEN membership_id IS NOT NULL AND agent_principal_id IS NULL
    AND payload#>>'{principal,membershipId}'=membership_id::text AND payload#>'{principal,installationId}'='null'::jsonb
   WHEN 'agent' THEN membership_id IS NULL AND agent_principal_id IS NOT NULL AND agent_principal_id::text=principal_id::text
    AND payload#>'{principal,membershipId}'='null'::jsonb
   ELSE false END) IS TRUE),
 ADD CONSTRAINT grants_principal_kind FOREIGN KEY (principal_id,principal_kind) REFERENCES morrow_identity.principals(id,kind),
 ADD CONSTRAINT grants_agent_principal FOREIGN KEY (organization_id,workspace_id,agent_principal_id)
  REFERENCES morrow_identity.agent_principals(organization_id,workspace_id,principal_id);
CREATE INDEX grants_agent_actor ON morrow_identity.grants (organization_id,workspace_id,principal_id) WHERE membership_id IS NULL;

-- An exact Date.toISOString() rendering, or NULL. Owned by the owner, granted to nobody.
CREATE FUNCTION morrow_identity.agent_utc(p_value jsonb) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v timestamptz;
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value)<>'string'
  OR (p_value#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN NULL; END IF;
 v:=(p_value#>>'{}')::timestamptz;
 IF to_char(v AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>(p_value#>>'{}') THEN RETURN NULL; END IF;
 RETURN v;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.agent_utc(jsonb) FROM PUBLIC;

-- Ensures the agent principal of a role: the workspace's one Coordinator, or the principal
-- of one installation. The caller's session context must resolve to this tenant. Returns
-- the existing principal, or creates it with the proposed id. Outcomes: created, exists,
-- invalid, denied.
CREATE FUNCTION morrow_identity.work_agent_principal_ensure(p_org text,p_ws text,p_role text,p_installation_id text,p_principal_id text)
RETURNS TABLE(outcome text,principal_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE s record; v_existing text; v_at timestamptz;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_role IS NULL OR p_role NOT IN ('coordinator','installation')
  OR (p_role='coordinator')<>(p_installation_id IS NULL)
  OR (p_installation_id IS NOT NULL AND p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  OR p_principal_id IS NULL OR p_principal_id !~ '^agent_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT c.principal_id,c.membership_id INTO s FROM morrow_identity.work_session_context(
  pg_catalog.current_setting('morrow.work_session_digest',true),pg_catalog.current_setting('morrow.work_workspace',true)) c
  WHERE c.organization_id=p_org AND c.workspace_id=p_ws;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.agent_principal',
  p_org,p_ws,p_role,COALESCE(p_installation_id,''))::text,0));
 SELECT a.principal_id::text INTO v_existing FROM morrow_identity.agent_principals a
  WHERE a.organization_id=p_org AND a.workspace_id=p_ws AND a.role=p_role AND a.installation_id IS NOT DISTINCT FROM p_installation_id;
 IF FOUND THEN RETURN QUERY SELECT 'exists'::text,v_existing; RETURN; END IF;
 v_at:=date_trunc('milliseconds',clock_timestamp());
 BEGIN
  INSERT INTO morrow_identity.principals(id,kind,active) VALUES (p_principal_id,'agent',true);
  INSERT INTO morrow_identity.agent_principals(principal_id,principal_kind,organization_id,workspace_id,role,installation_id,created_at)
  VALUES (p_principal_id,'agent',p_org,p_ws,p_role,p_installation_id,v_at);
 EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 RETURN QUERY SELECT 'created'::text,p_principal_id;
END $$;

-- Issues agent grants from the fixed allowlist. The session's human must be the issuer of
-- every grant (issuedBy), and every grant names one agent principal of this tenant with its
-- installation. Installation role: exactly the three Listings grants (catalog.products.read
-- {view}, catalog.content.propose {execute}, catalog.content.publish {propose}), each on
-- exactly the current store resource {kind store, id S, storeId S, connectionId C} with
-- scope.storeIds [S] and the five listing FieldPaths, no expiry, issued once. Coordinator
-- role: workspace.task.delegate {delegate} on exactly one storeless task resource with
-- fields taskId, installationId and mandate, expiring after validFrom and within 24 hours.
-- validFrom lies inside this transaction; policyRevision is the organization's current
-- one; revokedAt is null. Outcomes: issued (with the count), invalid, denied, exists.
CREATE FUNCTION morrow_identity.work_agent_grants_issue(p_org text,p_ws text,p_grants jsonb)
RETURNS TABLE(outcome text,issued integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE
 s record; g jsonb; a record; v_revision bigint; v_from timestamptz; v_until timestamptz; v_store text; v_connection text;
 v_role text; v_principal text; v_caps text[]:=ARRAY[]::text[]; v_count integer:=0; v_ids text[]:=ARRAY[]::text[];
 k text[]:=ARRAY['id','principal','capabilityId','verbs','scope','issuedBy','validFrom','expiresAt','revokedAt','policyRevision'];
 sk text[]:=ARRAY['organizationId','workspaceId','storeIds','accountIds','resources','fields'];
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_grants IS NULL OR jsonb_typeof(p_grants)<>'array' OR jsonb_array_length(p_grants) NOT BETWEEN 1 AND 3 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN;
 END IF;
 SELECT c.principal_id,c.membership_id INTO s FROM morrow_identity.work_session_context(
  pg_catalog.current_setting('morrow.work_session_digest',true),pg_catalog.current_setting('morrow.work_workspace',true)) c
  WHERE c.organization_id=p_org AND c.workspace_id=p_ws;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::integer; RETURN; END IF;
 SELECT o.policy_revision INTO v_revision FROM morrow_identity.organizations o WHERE o.id=p_org AND o.active;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::integer; RETURN; END IF;
 FOR g IN SELECT x FROM jsonb_array_elements(p_grants) x LOOP
  IF jsonb_typeof(g)<>'object' OR NOT (g ?& k) OR (g-k)<>'{}'::jsonb
   OR jsonb_typeof(g->'id')<>'string' OR (g->>'id') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR (g->>'id')=ANY(v_ids)
   OR jsonb_typeof(g->'capabilityId')<>'string' OR jsonb_typeof(g->'verbs')<>'array'
   OR jsonb_typeof(g->'principal')<>'object' OR jsonb_typeof(g->'scope')<>'object' OR NOT ((g->'scope') ?& sk) OR ((g->'scope')-sk)<>'{}'::jsonb
   OR g->'scope'->'organizationId' IS DISTINCT FROM to_jsonb(p_org) OR g->'scope'->'workspaceId' IS DISTINCT FROM to_jsonb(p_ws)
   OR g->'scope'->'accountIds' IS DISTINCT FROM '[]'::jsonb
   OR g->'revokedAt' IS DISTINCT FROM 'null'::jsonb OR g->'policyRevision' IS DISTINCT FROM to_jsonb(v_revision)
   OR g->'issuedBy' IS DISTINCT FROM jsonb_build_object('kind','human','principalId',s.principal_id,'organizationId',p_org,
    'workspaceId',p_ws,'membershipId',s.membership_id,'installationId',NULL,'mandateId',NULL) THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN;
  END IF;
  v_from:=morrow_identity.agent_utc(g->'validFrom');
  IF v_from IS NULL OR v_from<date_trunc('milliseconds',transaction_timestamp()) OR v_from>clock_timestamp() THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN;
  END IF;
  SELECT x.principal_id::text AS principal_id,x.role,x.installation_id::text AS installation_id INTO a FROM morrow_identity.agent_principals x
   WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.principal_id::text=g#>>'{principal,principalId}';
  IF NOT FOUND OR (v_principal IS NOT NULL AND v_principal<>a.principal_id)
   OR g->'principal' IS DISTINCT FROM jsonb_build_object('kind','agent','principalId',a.principal_id,'organizationId',p_org,
    'workspaceId',p_ws,'membershipId',NULL,'installationId',a.installation_id,'mandateId',NULL) THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN;
  END IF;
  v_principal:=a.principal_id; v_role:=a.role;
  IF a.role='installation' THEN
   v_store:=g#>>'{scope,storeIds,0}'; v_connection:=NULL;
   SELECT i.connection_id INTO v_connection FROM morrow_identity.work_store_installations(p_org,p_ws) i
    WHERE i.store_id=v_store AND i.status='linked' AND i.linked_at<=clock_timestamp();
   IF v_connection IS NULL OR g->'expiresAt' IS DISTINCT FROM 'null'::jsonb
    OR g->'scope'->'storeIds' IS DISTINCT FROM jsonb_build_array(v_store)
    OR g->'scope'->'resources' IS DISTINCT FROM jsonb_build_array(jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,
     'storeId',v_store,'connectionId',v_connection,'kind','store','id',v_store))
    OR g->'scope'->'fields' IS DISTINCT FROM '["descriptionHtml","seo.description","seo.title","tags","title"]'::jsonb
    OR NOT COALESCE((g->>'capabilityId'='catalog.products.read' AND g->'verbs'='["view"]'::jsonb)
     OR (g->>'capabilityId'='catalog.content.propose' AND g->'verbs'='["execute"]'::jsonb)
     OR (g->>'capabilityId'='catalog.content.publish' AND g->'verbs'='["propose"]'::jsonb),false)
    OR COALESCE((g->>'capabilityId')=ANY(v_caps),true) THEN
    RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN;
   END IF;
  ELSE
   v_until:=morrow_identity.agent_utc(g->'expiresAt');
   IF v_until IS NULL OR v_until<=v_from OR v_until>v_from+interval '24 hours'
    OR g->>'capabilityId' IS DISTINCT FROM 'workspace.task.delegate' OR g->'verbs' IS DISTINCT FROM '["delegate"]'::jsonb
    OR g->'scope'->'storeIds' IS DISTINCT FROM '[]'::jsonb
    OR jsonb_typeof(g->'scope'->'resources')<>'array' OR jsonb_array_length(g->'scope'->'resources')<>1
    OR jsonb_typeof(g#>'{scope,resources,0,id}') IS DISTINCT FROM 'string'
    OR COALESCE((g#>>'{scope,resources,0,id}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',true)
    OR g->'scope'->'resources'->0 IS DISTINCT FROM jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',NULL,
     'connectionId',NULL,'kind','task','id',g#>>'{scope,resources,0,id}')
    OR g->'scope'->'fields' IS DISTINCT FROM '["installationId","mandate","taskId"]'::jsonb THEN
    RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN;
   END IF;
  END IF;
  v_caps:=v_caps||(g->>'capabilityId'); v_ids:=v_ids||(g->>'id');
 END LOOP;
 -- The installation's grant set is issued once, whole.
 IF v_role='installation' THEN
  IF cardinality(v_caps)<>3 THEN RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN; END IF;
  IF EXISTS(SELECT 1 FROM morrow_identity.grants x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.principal_id=v_principal) THEN
   RETURN QUERY SELECT 'exists'::text,NULL::integer; RETURN;
  END IF;
 END IF;
 BEGIN
  INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload,principal_kind,agent_principal_id)
  SELECT x->>'id',p_org,p_ws,NULL,v_principal,x,'agent',v_principal FROM jsonb_array_elements(p_grants) x;
  GET DIAGNOSTICS v_count=ROW_COUNT;
 EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::integer; RETURN;
 END;
 RETURN QUERY SELECT 'issued'::text,v_count;
END $$;

-- Issues agents.installation.disable {execute} to the session's own human on one
-- installation of a current store: scope {O, W, [S], [], [{kind installation, id I,
-- storeId S, connectionId C}], [control, installationId]}, issued by the service
-- morrow.agents, no expiry. I must be an installation of this tenant (its agent principal
-- exists). An equal current grant already held is `exists`. Outcomes: issued, exists,
-- invalid, denied.
CREATE FUNCTION morrow_identity.work_owner_disable_grant_issue(p_org text,p_ws text,p_grant jsonb)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE s record; v_revision bigint; v_from timestamptz; v_store text; v_connection text; v_installation text;
 k text[]:=ARRAY['id','principal','capabilityId','verbs','scope','issuedBy','validFrom','expiresAt','revokedAt','policyRevision'];
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_grant IS NULL OR jsonb_typeof(p_grant)<>'object' OR NOT (p_grant ?& k) OR (p_grant-k)<>'{}'::jsonb
  OR jsonb_typeof(p_grant->'id')<>'string' OR (p_grant->>'id') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text; RETURN;
 END IF;
 SELECT c.principal_id,c.membership_id INTO s FROM morrow_identity.work_session_context(
  pg_catalog.current_setting('morrow.work_session_digest',true),pg_catalog.current_setting('morrow.work_workspace',true)) c
  WHERE c.organization_id=p_org AND c.workspace_id=p_ws;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text; RETURN; END IF;
 SELECT o.policy_revision INTO v_revision FROM morrow_identity.organizations o WHERE o.id=p_org AND o.active;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text; RETURN; END IF;
 v_store:=p_grant#>>'{scope,storeIds,0}'; v_installation:=p_grant#>>'{scope,resources,0,id}';
 SELECT i.connection_id INTO v_connection FROM morrow_identity.work_store_installations(p_org,p_ws) i
  WHERE i.store_id=v_store AND i.status='linked' AND i.linked_at<=clock_timestamp();
 v_from:=morrow_identity.agent_utc(p_grant->'validFrom');
 IF v_connection IS NULL OR v_from IS NULL OR v_from<date_trunc('milliseconds',transaction_timestamp()) OR v_from>clock_timestamp()
  OR NOT EXISTS(SELECT 1 FROM morrow_identity.agent_principals a WHERE a.organization_id=p_org AND a.workspace_id=p_ws
   AND a.role='installation' AND a.installation_id::text=v_installation)
  OR p_grant->'principal' IS DISTINCT FROM jsonb_build_object('kind','human','principalId',s.principal_id,'organizationId',p_org,
   'workspaceId',p_ws,'membershipId',s.membership_id,'installationId',NULL,'mandateId',NULL)
  OR p_grant->>'capabilityId' IS DISTINCT FROM 'agents.installation.disable' OR p_grant->'verbs' IS DISTINCT FROM '["execute"]'::jsonb
  OR p_grant->'scope' IS DISTINCT FROM jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeIds',jsonb_build_array(v_store),
   'accountIds','[]'::jsonb,'resources',jsonb_build_array(jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',v_store,
    'connectionId',v_connection,'kind','installation','id',v_installation)),'fields','["control","installationId"]'::jsonb)
  OR p_grant->'issuedBy' IS DISTINCT FROM jsonb_build_object('kind','service','principalId','morrow.agents','organizationId',p_org,
   'workspaceId',p_ws,'membershipId',NULL,'installationId',NULL,'mandateId',NULL)
  OR p_grant->'expiresAt' IS DISTINCT FROM 'null'::jsonb OR p_grant->'revokedAt' IS DISTINCT FROM 'null'::jsonb
  OR p_grant->'policyRevision' IS DISTINCT FROM to_jsonb(v_revision) THEN
  RETURN QUERY SELECT 'invalid'::text; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM morrow_identity.grants x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.membership_id=s.membership_id
   AND x.principal_id=s.principal_id AND x.payload->>'capabilityId'='agents.installation.disable' AND x.payload->'revokedAt'='null'::jsonb
   AND x.payload->'scope'=p_grant->'scope') THEN
  RETURN QUERY SELECT 'exists'::text; RETURN;
 END IF;
 BEGIN
  INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload,principal_kind,agent_principal_id)
  VALUES (p_grant->>'id',p_org,p_ws,s.membership_id,s.principal_id,p_grant,'human',NULL);
 EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text; RETURN;
 END;
 RETURN QUERY SELECT 'issued'::text;
END $$;

-- The identity facts of the agent kernel (decideDelegation) for one lease step: for each
-- named actor, its liveness, the organization's policy revision and its current grant rows
-- for the named capabilities (at most 1001, by id; the caller denies more than 1000),
-- optionally only those whose scope names one resource id (the Coordinator's grant on the
-- parent task). A human is named with its membership, an agent principal without one. Only
-- the runtime login's lease steps reach it (the work definer resolved current_lease()).
-- Grants are never interpreted here; the kernel decides.
CREATE FUNCTION morrow_identity.work_delegation_actor_facts(p_org text,p_ws text,p_actors jsonb)
RETURNS TABLE(principal_id text,kind text,membership_id text,installation_id text,role text,principal_active boolean,organization_active boolean,
 workspace_active boolean,membership_active boolean,policy_revision bigint,grants jsonb,grant_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE e jsonb; v_caps text[]; v_resource text; o record; w record; p record; m record; ap record; g record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor')
  OR p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_actors IS NULL OR jsonb_typeof(p_actors)<>'array' OR jsonb_array_length(p_actors) NOT BETWEEN 1 AND 16 THEN RETURN; END IF;
 SELECT x.active,x.policy_revision INTO o FROM morrow_identity.organizations x WHERE x.id=p_org;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT x.active INTO w FROM morrow_identity.workspaces x WHERE x.organization_id=p_org AND x.id=p_ws;
 IF NOT FOUND THEN RETURN; END IF;
 FOR e IN SELECT x FROM jsonb_array_elements(p_actors) x LOOP
  IF jsonb_typeof(e)<>'object' OR NOT (e ?& ARRAY['principalId','membershipId','capabilityIds','resourceId'])
   OR (e-ARRAY['principalId','membershipId','capabilityIds','resourceId'])<>'{}'::jsonb
   OR jsonb_typeof(e->'principalId')<>'string' OR (e->>'principalId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR NOT (e->'membershipId'='null'::jsonb OR (jsonb_typeof(e->'membershipId')='string' AND (e->>'membershipId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'))
   OR NOT (e->'resourceId'='null'::jsonb OR (jsonb_typeof(e->'resourceId')='string' AND (e->>'resourceId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'))
   OR jsonb_typeof(e->'capabilityIds')<>'array' OR jsonb_array_length(e->'capabilityIds') NOT BETWEEN 1 AND 8
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(e->'capabilityIds') c WHERE jsonb_typeof(c)<>'string' OR (c#>>'{}') !~ '^[a-z]+(\.[a-z_]+)+$') THEN
   RETURN;
  END IF;
  v_caps:=ARRAY(SELECT c FROM jsonb_array_elements_text(e->'capabilityIds') c);
  v_resource:=e->>'resourceId';
  SELECT x.kind,x.active INTO p FROM morrow_identity.principals x WHERE x.id=e->>'principalId';
  IF NOT FOUND THEN CONTINUE; END IF;
  IF e->'membershipId'<>'null'::jsonb THEN
   IF p.kind<>'human' THEN CONTINUE; END IF;
   SELECT (mem.active AND wm.active) AS active INTO m FROM morrow_identity.memberships mem
    JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=mem.organization_id AND wm.membership_id=mem.id AND wm.workspace_id=p_ws
    WHERE mem.organization_id=p_org AND mem.id=e->>'membershipId' AND mem.principal_id=e->>'principalId';
   IF NOT FOUND THEN CONTINUE; END IF;
   SELECT COALESCE(jsonb_agg(q.payload ORDER BY q.id COLLATE "C"),'[]'::jsonb) AS grants,count(*)::integer AS n INTO g FROM (
    SELECT x.id::text AS id,x.payload FROM morrow_identity.grants x WHERE x.organization_id=p_org AND x.workspace_id=p_ws
     AND x.membership_id=e->>'membershipId' AND x.principal_id=e->>'principalId' AND x.payload->>'capabilityId'=ANY(v_caps)
     AND (v_resource IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(x.payload#>'{scope,resources}') r WHERE r->>'id'=v_resource))
    ORDER BY x.id::text COLLATE "C" LIMIT 1001) q;
   RETURN QUERY SELECT e->>'principalId','human'::text,e->>'membershipId',NULL::text,NULL::text,p.active,o.active,w.active,m.active,
    o.policy_revision::bigint,g.grants,g.n;
  ELSE
   SELECT x.role,x.installation_id::text AS installation_id INTO ap FROM morrow_identity.agent_principals x
    WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.principal_id=e->>'principalId';
   IF NOT FOUND OR p.kind<>'agent' THEN CONTINUE; END IF;
   SELECT COALESCE(jsonb_agg(q.payload ORDER BY q.id COLLATE "C"),'[]'::jsonb) AS grants,count(*)::integer AS n INTO g FROM (
    SELECT x.id::text AS id,x.payload FROM morrow_identity.grants x WHERE x.organization_id=p_org AND x.workspace_id=p_ws
     AND x.membership_id IS NULL AND x.agent_principal_id=e->>'principalId' AND x.principal_id=e->>'principalId'
     AND x.payload->>'capabilityId'=ANY(v_caps)
     AND (v_resource IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(x.payload#>'{scope,resources}') r WHERE r->>'id'=v_resource))
    ORDER BY x.id::text COLLATE "C" LIMIT 1001) q;
   RETURN QUERY SELECT e->>'principalId','agent'::text,NULL::text,ap.installation_id,ap.role,p.active,o.active,w.active,false,
    o.policy_revision::bigint,g.grants,g.n;
  END IF;
 END LOOP;
END $$;

-- Whether one installation's grants are still exactly a confirmed document's grant set (the
-- ADR-0022 item 3 amendment: a resume reactivates the installation with the grants it
-- holds, so any change to them invalidates the confirmation). Exact means: the principal is
-- this tenant's active agent principal of that installation; it holds exactly three grants;
-- the i-th GrantRef names one of them, for that principal and installation, unrevoked and
-- without expiry, whose capability, verbs and scope are the i-th entry of p_expected. The
-- caller's session context must resolve to this tenant. Outcomes: exact, differs, invalid,
-- denied.
CREATE FUNCTION morrow_identity.work_agent_grant_set_current(p_org text,p_ws text,p_installation_id text,p_principal_id text,
 p_refs jsonb,p_expected jsonb)
RETURNS TABLE(outcome text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE s record; v_index integer;
BEGIN
 IF p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_principal_id IS NULL OR p_principal_id !~ '^agent_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_refs IS NULL OR jsonb_typeof(p_refs)<>'array' OR jsonb_array_length(p_refs)<>3
  OR p_expected IS NULL OR jsonb_typeof(p_expected)<>'array' OR jsonb_array_length(p_expected)<>3
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_refs) r WHERE jsonb_typeof(r)<>'object' OR jsonb_typeof(r->'id')<>'string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_expected) e WHERE jsonb_typeof(e)<>'object') THEN
  RETURN QUERY SELECT 'invalid'::text; RETURN;
 END IF;
 SELECT c.principal_id INTO s FROM morrow_identity.work_session_context(
  pg_catalog.current_setting('morrow.work_session_digest',true),pg_catalog.current_setting('morrow.work_workspace',true)) c
  WHERE c.organization_id=p_org AND c.workspace_id=p_ws;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text; RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_identity.agent_principals a JOIN morrow_identity.principals x ON x.id=a.principal_id
   WHERE a.organization_id=p_org AND a.workspace_id=p_ws AND a.principal_id=p_principal_id AND a.role='installation'
    AND a.installation_id=p_installation_id AND x.kind='agent' AND x.active)
  OR (SELECT count(*) FROM morrow_identity.grants x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.principal_id=p_principal_id)<>3 THEN
  RETURN QUERY SELECT 'differs'::text; RETURN;
 END IF;
 FOR v_index IN 0..2 LOOP
  IF NOT EXISTS(SELECT 1 FROM morrow_identity.grants x WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_refs->v_index->>'id'
    AND x.principal_kind='agent' AND x.membership_id IS NULL AND x.agent_principal_id=p_principal_id AND x.principal_id=p_principal_id
    AND x.payload->'principal'=jsonb_build_object('kind','agent','principalId',p_principal_id,'organizationId',p_org,'workspaceId',p_ws,
     'membershipId',NULL,'installationId',p_installation_id,'mandateId',NULL)
    AND x.payload->'revokedAt'='null'::jsonb AND x.payload->'expiresAt'='null'::jsonb
    AND jsonb_build_object('capabilityId',x.payload->'capabilityId','verbs',x.payload->'verbs','scope',x.payload->'scope')=p_expected->v_index) THEN
   RETURN QUERY SELECT 'differs'::text; RETURN;
  END IF;
 END LOOP;
 RETURN QUERY SELECT 'exact'::text;
END $$;

REVOKE ALL ON FUNCTION morrow_identity.work_agent_principal_ensure(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_identity.work_agent_grants_issue(text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_identity.work_owner_disable_grant_issue(text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_identity.work_agent_grant_set_current(text,text,text,text,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_identity.work_delegation_actor_facts(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_agent_principal_ensure(text,text,text,text,text),
 morrow_identity.work_agent_grants_issue(text,text,jsonb),morrow_identity.work_owner_disable_grant_issue(text,text,jsonb),
 morrow_identity.work_agent_grant_set_current(text,text,text,text,jsonb,jsonb),
 morrow_identity.work_delegation_actor_facts(text,text,jsonb) TO morrow_work_command;
COMMIT;
