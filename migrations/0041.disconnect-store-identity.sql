BEGIN;
-- "Disconnect store", the identity side (ADR-0022 items 2, 3 and 15 with the amendments of
-- 2026-10-22, owner decision 8; the M2 brief's PR-3 checklist). Executes AS
-- morrow_identity_owner, after 0040. It adds:
--   * store-link template v2: morrow_identity.store_link_grants_v2(), version 1's four rows
--     and governance.connection.disconnect {execute} (fields connectionId and control, its
--     v1.1 input names), the human kill switch "Disconnect store" (ADR-0005; the item 3
--     amendment). packages/policy/src/store-link-template.ts is its TypeScript twin, pinned
--     equal by tests/store-link-template.test.mjs. Version 1 stays as 0026 wrote it;
--   * link_workspace_store replaced with 0039's definition exactly (signature, result,
--     owner, ACL and body: 0026's, with v1 PR 1's live-store linkability), except that a
--     link applies template v2;
--   * the one forward backfill: on every store installation still linked, the linking
--     owner who holds version 1's agents.installation.activate row on that store resource
--     (issued by morrow.linking, unrevoked) receives the disconnect grant once, issued by
--     morrow.linking at the organization's current policy revision (the 0030 owner
--     disable grant's precedent). Nothing else is issued, revoked or revised.
-- The disconnect itself is the work command of the next migration (disconnect-store-work),
-- which ends the installation through 0036's work_shopify_installation_end; no identity
-- bridge changes here.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regprocedure('morrow_identity.store_link_grants_v1()') IS NULL
 OR to_regprocedure('morrow_identity.store_link_grants_v2()') IS NOT NULL
 OR to_regclass('morrow_identity.store_installations') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_identity.grants'::regclass
   AND a.attname='principal_kind' AND NOT a.attisdropped)
 -- The function this file replaces, exactly as v1 PR 1's live-store identity migration
 -- (0039) wrote it (shared protocol: a later revision is never overwritten blind).
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('morrow_identity.link_workspace_store(text,text,text,text,text,text,text,text,text,text,text)'))
  IS DISTINCT FROM '955c8e1effa1291b7a8019eba2cc5fd8'
 THEN RAISE EXCEPTION 'DISCONNECT_STORE_IDENTITY_PREREQUISITES_INVALID'; END IF;
END $$;

-- Store-link template v2 (ADR-0022 item 3 as amended 2026-10-22): version 1's rows, then
-- the disconnect grant. Fields are the request's input names (the owner-bootstrap-v1 rule).
CREATE FUNCTION morrow_identity.store_link_grants_v2() RETURNS TABLE(capability_id text,verbs jsonb,fields jsonb)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT c,v::jsonb,f::jsonb FROM (VALUES
  ('catalog.products.read','["view","delegate"]','["descriptionHtml","seo.description","seo.title","tags","title"]'),
  ('catalog.content.propose','["execute","delegate"]','["descriptionHtml","seo.description","seo.title","tags","title"]'),
  ('catalog.content.publish','["propose","approve","execute","delegate"]','["descriptionHtml","seo.description","seo.title","tags","title"]'),
  ('agents.installation.activate','["execute"]','["evaluation","grant","installationId","revision"]'),
  ('governance.connection.disconnect','["execute"]','["connectionId","control"]')) t(c,v,f)
$$;
REVOKE ALL ON FUNCTION morrow_identity.store_link_grants_v2() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- link_workspace_store: 0039's definition (same signature, result, owner and ACL; CREATE
-- OR REPLACE keeps them), with one change: an applied shopify_oauth link issues store-link
-- template v2 (store_link_grants_v2()) to the linking owner, so a store linked from now on
-- can be disconnected by that owner. Every other rule is 0039's (0026's, with the live
-- store linkable), word for word.
CREATE OR REPLACE FUNCTION morrow_identity.link_workspace_store(
 p_handoff text,p_command text,p_digest text,p_session text,p_nonce text,p_org text,p_workspace text,p_installation text,p_purpose text,p_policy text,p_ownership text)
RETURNS TABLE(outcome text,link_id text,ownership_revision text,policy_revision text,audit_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
 o morrow_identity.organizations%ROWTYPE; c morrow_identity.linking_candidates%ROWTYPE;
 h morrow_identity.linking_handoffs%ROWTYPE; r morrow_identity.linking_reviews%ROWTYPE;
 previous morrow_identity.workspace_link_results%ROWTYPE; association morrow_identity.workspace_store_links%ROWTYPE;
 inst morrow_identity.store_installations%ROWTYPE;
 actor_ok boolean; grant_ok boolean; proof_ok boolean; review_ok boolean; at_time timestamptz;
 grant_start timestamptz; grant_end timestamptz; reason_code text; result_id text; created_link text;
 route_now text; installation_ok boolean; owner_ok boolean;
BEGIN
 -- The definer owner is not the calling identity. Neither SET ROLE nor a
 -- subsequently unsafe executor configuration may substitute for this login.
 IF session_user<>'morrow_identity_linking' OR NOT EXISTS(
   SELECT 1 FROM pg_roles x WHERE x.rolname=session_user AND NOT x.rolsuper
     AND NOT x.rolbypassrls AND NOT x.rolcreatedb AND NOT x.rolcreaterole AND NOT x.rolinherit
     AND morrow_identity.executor_memberships_closed(x.rolname)) THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_handoff IS NULL OR p_command IS NULL OR p_digest IS NULL OR p_session IS NULL OR p_nonce IS NULL OR p_org IS NULL OR p_workspace IS NULL OR p_installation IS NULL OR p_purpose IS NULL OR p_policy IS NULL OR p_ownership IS NULL
   OR p_handoff !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_command !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_installation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   OR p_digest !~ '^[a-f0-9]{64}$' OR p_session !~ '^[a-f0-9]{64}$' OR p_nonce !~ '^[a-f0-9]{64}$'
   OR p_purpose NOT IN ('install_first','workspace_first','existing_account','additional_store','cross_host_resume')
   OR p_policy !~ '^[1-9][0-9]{0,15}$' OR p_ownership !~ '^[1-9][0-9]{0,15}$' THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF p_policy::numeric>9007199254740991 OR p_ownership::numeric>9007199254740991 THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',p_org)::text,0));
 SELECT * INTO o FROM morrow_identity.organizations WHERE id::text=p_org FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 -- Read the exact private locator only; authority comes from locked records below.
 SELECT * INTO h FROM morrow_identity.linking_handoffs WHERE id::text=p_handoff AND organization_id=o.id;
 IF NOT FOUND THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO inst FROM morrow_identity.store_installations x WHERE x.id=h.installation_id FOR UPDATE;
 SELECT * INTO c FROM morrow_identity.linking_candidates WHERE id=h.candidate_id FOR UPDATE;
 SELECT * INTO h FROM morrow_identity.linking_handoffs WHERE id::text=p_handoff AND organization_id=o.id FOR UPDATE;
 IF h.workspace_id::text<>p_workspace OR h.installation_id::text<>p_installation OR h.session_digest<>p_session OR h.nonce_digest<>p_nonce
   OR h.purpose<>p_purpose OR h.expected_policy_revision::text<>p_policy OR h.expected_ownership_revision::text<>p_ownership THEN
   RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF h.command_id::text<>p_command OR h.request_digest<>p_digest THEN
   RETURN QUERY SELECT 'conflict'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO r FROM morrow_identity.linking_reviews WHERE id=h.review_id FOR UPDATE;
 PERFORM morrow_identity.lock_session_eligibility(h.session_digest,h.workspace_id::text,h.actor_principal_id::text,h.organization_id::text);
 PERFORM 1 FROM morrow_identity.principals WHERE id=h.actor_principal_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.workspaces WHERE id=h.workspace_id AND organization_id=h.organization_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.memberships WHERE id=h.actor_membership_id AND organization_id=h.organization_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.workspace_memberships WHERE workspace_id=h.workspace_id AND membership_id=h.actor_membership_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.grants WHERE id=h.authorizing_grant_id FOR UPDATE;
 SELECT * INTO association FROM morrow_identity.workspace_store_links WHERE candidate_id=c.id FOR UPDATE;
 at_time:=clock_timestamp();
 actor_ok:=o.active AND EXISTS(SELECT 1 FROM morrow_identity.principals p
   JOIN morrow_identity.memberships m ON m.principal_id=p.id AND m.id=h.actor_membership_id AND m.organization_id=o.id AND m.active
   JOIN morrow_identity.workspace_memberships wm ON wm.organization_id=o.id AND wm.workspace_id=h.workspace_id AND wm.membership_id=m.id AND wm.active
   JOIN morrow_identity.workspaces w ON w.id=wm.workspace_id AND w.organization_id=o.id AND w.active
   JOIN morrow_identity.session_eligibility(h.session_digest,h.workspace_id::text) s ON s.principal_id=p.id::text AND s.organization_id=o.id::text AND s.membership_id=h.actor_membership_id::text
   WHERE p.id=h.actor_principal_id AND p.kind='human' AND p.active);
 grant_ok:=EXISTS(SELECT 1 FROM morrow_identity.grants g WHERE g.id=h.authorizing_grant_id AND g.organization_id=o.id AND g.workspace_id=h.workspace_id
   AND g.principal_id=h.actor_principal_id AND g.membership_id=h.actor_membership_id AND g.payload=h.authorizing_grant_snapshot);
 BEGIN
   grant_start:=(h.authorizing_grant_snapshot->>'validFrom')::timestamptz;
   grant_end:=(h.authorizing_grant_snapshot->>'expiresAt')::timestamptz;
   grant_ok:=grant_ok AND grant_start IS NOT NULL AND isfinite(grant_start) AND grant_start<=at_time
     AND(h.authorizing_grant_snapshot->'expiresAt'='null'::jsonb OR(grant_end IS NOT NULL AND isfinite(grant_end) AND grant_end>at_time));
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN grant_ok:=false; END;
 proof_ok:=c.active AND c.installation_id=h.installation_id AND c.generation=h.generation AND c.eligible_principal_id=h.actor_principal_id
   AND c.proof_id=h.proof_id AND c.proof_revision=h.proof_revision AND c.proof_digest=h.proof_digest
   AND c.proof_created_at<=at_time AND c.proof_expires_at>at_time AND c.proof_revoked_at IS NULL;
 review_ok:=r.organization_id=h.organization_id AND r.workspace_id=h.workspace_id AND r.actor_principal_id=h.actor_principal_id
   AND r.actor_membership_id=h.actor_membership_id AND r.session_digest=h.session_digest AND r.nonce_digest=h.nonce_digest AND r.handoff_id=h.id
   AND r.candidate_id=h.candidate_id AND r.installation_id=h.installation_id AND r.generation=h.generation
   AND r.command_id=h.command_id AND r.request_digest=h.request_digest AND r.purpose=h.purpose
   AND r.expected_policy_revision=h.expected_policy_revision AND r.expected_ownership_revision=h.expected_ownership_revision
   AND r.proof_id=h.proof_id AND r.proof_revision=h.proof_revision AND r.proof_digest=h.proof_digest
   AND r.scope_snapshot=h.requested_scope_snapshot AND r.revoked_at IS NULL AND r.created_at<=at_time;
 SELECT * INTO previous FROM morrow_identity.workspace_link_results WHERE handoff_id=h.id;
 IF FOUND THEN
   -- Historical acknowledgement is not a second write. Old handoff/review TTLs
   -- do not extend authority; current human/grant/proof/ownership still must hold.
   IF actor_ok AND grant_ok IS TRUE AND proof_ok IS TRUE AND review_ok IS TRUE
     AND((previous.outcome='applied' AND association.id=previous.link_id AND association.organization_id=h.organization_id
       AND association.workspace_id=h.workspace_id AND association.installation_id=h.installation_id AND association.generation=h.generation
       AND association.ownership_revision=previous.ownership_revision AND c.ownership_revision=previous.ownership_revision)
       OR(previous.outcome='denied' AND association.id IS NULL AND c.ownership_revision=h.expected_ownership_revision)) THEN
     RETURN QUERY SELECT previous.outcome,previous.link_id::text,previous.ownership_revision::text,previous.policy_revision::text,previous.id::text;
   ELSE RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; END IF; RETURN;
 END IF;
 IF h.consumed_at IS NOT NULL THEN RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 -- ADR-0022 item 5: a fixed morrow_direct route, in every environment and for every
 -- candidate kind. A shopify_oauth candidate also needs its installation linkable.
 route_now:=morrow_billing.link_route_current(h.organization_id::text,h.workspace_id::text);
 installation_ok:=c.proof_kind<>'shopify_oauth' OR (inst.id IS NOT NULL AND inst.organization_id=h.organization_id
   AND inst.workspace_id=h.workspace_id AND inst.id=c.installation_id AND inst.generation=h.generation
   AND inst.status='unlinked' AND inst.link_id IS NULL
   AND EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a WHERE a.app_key=inst.app_key AND a.status='active'
    AND a.invited_organization_id=inst.organization_id AND a.invited_workspace_id=inst.workspace_id
    AND (inst.development_store OR (a.live_store AND a.intended_shop_digest=encode(sha256(convert_to(inst.shop_domain,'UTF8')),'hex')))));
 -- ADR-0022 item 3: the store-link template goes to the linking owner.
 owner_ok:=c.proof_kind<>'shopify_oauth' OR EXISTS(SELECT 1 FROM morrow_identity.organization_signups s
   WHERE s.organization_id=h.organization_id AND s.principal_id=h.actor_principal_id);
 reason_code:=CASE WHEN NOT actor_ok OR owner_ok IS NOT TRUE THEN 'actor_ineligible' WHEN grant_ok IS NOT TRUE THEN 'grant_changed'
   WHEN h.created_at>at_time OR h.expires_at<=at_time THEN 'handoff_expired'
   WHEN proof_ok IS NOT TRUE THEN 'proof_invalid' WHEN review_ok IS NOT TRUE OR r.expires_at<=at_time THEN 'review_invalid'
   WHEN h.purpose='cross_host_resume' THEN 'purpose_denied'
   WHEN route_now IS DISTINCT FROM 'morrow_direct' THEN 'billing_route_required'
   WHEN installation_ok IS NOT TRUE THEN 'installation_ineligible'
   WHEN o.policy_revision<>h.expected_policy_revision THEN 'policy_conflict'
   WHEN association.id IS NOT NULL OR c.ownership_revision<>h.expected_ownership_revision THEN 'ownership_conflict'
   WHEN o.policy_revision=9007199254740991 OR c.ownership_revision=9007199254740991 THEN 'revision_exhausted' ELSE 'applied' END;
 result_id:=gen_random_uuid()::text;
 IF reason_code='applied' THEN
   created_link:=gen_random_uuid()::text;
   UPDATE morrow_identity.linking_candidates SET ownership_revision=linking_candidates.ownership_revision+1 WHERE id=c.id RETURNING * INTO c;
   UPDATE morrow_identity.organizations SET policy_revision=organizations.policy_revision+1 WHERE id=o.id RETURNING * INTO o;
   INSERT INTO morrow_identity.workspace_store_links VALUES(created_link,c.id,h.organization_id,h.workspace_id,h.installation_id,h.generation,c.ownership_revision,h.actor_principal_id,at_time);
   IF c.proof_kind='shopify_oauth' THEN
     UPDATE morrow_identity.store_installations x SET status='linked',link_id=created_link,
       linked_at=greatest(date_trunc('milliseconds',at_time),x.created_at),revision=x.revision+1,
       updated_at=greatest(date_trunc('milliseconds',at_time),x.updated_at)
       WHERE x.organization_id=inst.organization_id AND x.workspace_id=inst.workspace_id AND x.id=inst.id;
     INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload)
     SELECT t.grant_key,h.organization_id,h.workspace_id,h.actor_membership_id,h.actor_principal_id,jsonb_build_object(
       'id',t.grant_key,
       'principal',jsonb_build_object('kind','human','principalId',h.actor_principal_id::text,'organizationId',h.organization_id::text,
         'workspaceId',h.workspace_id::text,'membershipId',h.actor_membership_id::text,'installationId',NULL,'mandateId',NULL),
       'capabilityId',t.capability_id,'verbs',t.verbs,
       'scope',jsonb_build_object('organizationId',h.organization_id::text,'workspaceId',h.workspace_id::text,
         'storeIds',jsonb_build_array(inst.store_id::text),'accountIds','[]'::jsonb,
         'resources',jsonb_build_array(jsonb_build_object('organizationId',h.organization_id::text,'workspaceId',h.workspace_id::text,
           'storeId',inst.store_id::text,'connectionId',inst.connection_id::text,'kind','store','id',inst.store_id::text)),
         'fields',t.fields),
       'issuedBy',jsonb_build_object('kind','service','principalId','morrow.linking','organizationId',h.organization_id::text,
         'workspaceId',h.workspace_id::text,'membershipId',NULL,'installationId',NULL,'mandateId',NULL),
       'validFrom',to_char(at_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',NULL,'revokedAt',NULL,
       'policyRevision',o.policy_revision::bigint)
     FROM (SELECT x.capability_id,x.verbs,x.fields,gen_random_uuid()::text AS grant_key FROM morrow_identity.store_link_grants_v2() x) t;
   END IF;
 END IF;
 UPDATE morrow_identity.linking_handoffs SET consumed_at=at_time WHERE id=h.id;
 INSERT INTO morrow_identity.workspace_link_results VALUES(result_id,h.id,h.organization_id,h.workspace_id,h.command_id,h.actor_principal_id,c.id,h.review_id,
   CASE WHEN reason_code='applied' THEN 'applied' ELSE 'denied' END,reason_code,created_link,CASE WHEN reason_code='applied' THEN c.ownership_revision ELSE NULL END,o.policy_revision,at_time);
 RETURN QUERY SELECT CASE WHEN reason_code='applied' THEN 'applied' ELSE 'denied' END,created_link,
   CASE WHEN reason_code='applied' THEN c.ownership_revision::text ELSE NULL END,o.policy_revision::text,result_id;
END $$;

-- ---------------------------------------------------------------------------
-- The forward backfill: a store linked under template v1 gains the disconnect right, and
-- nothing else. For each installation still linked, the holder of version 1's
-- agents.installation.activate row on exactly its store resource (the linking owner, the
-- organization's founding principal: 0026's link and 0039's issue the template to no one
-- else) receives
-- governance.connection.disconnect {execute} on the same store resource, issued by
-- morrow.linking at the organization's current policy revision, never expiring, once (a
-- holder who already has that exact grant receives nothing). An installation that is not
-- linked (unlinked, suspended or uninstalled) receives nothing: its connection has ended or
-- never started.
INSERT INTO morrow_identity.grants(id,organization_id,workspace_id,membership_id,principal_id,payload,principal_kind,agent_principal_id)
SELECT k.grant_key,k.organization_id,k.workspace_id,k.membership_id,k.principal_id,jsonb_build_object(
  'id',k.grant_key,
  'principal',jsonb_build_object('kind','human','principalId',k.principal_id,'organizationId',k.organization_id,
    'workspaceId',k.workspace_id,'membershipId',k.membership_id,'installationId',NULL,'mandateId',NULL),
  'capabilityId','governance.connection.disconnect','verbs','["execute"]'::jsonb,
  'scope',k.scope,
  'issuedBy',jsonb_build_object('kind','service','principalId','morrow.linking','organizationId',k.organization_id,
    'workspaceId',k.workspace_id,'membershipId',NULL,'installationId',NULL,'mandateId',NULL),
  'validFrom',to_char(date_trunc('milliseconds',transaction_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt',NULL,'revokedAt',NULL,'policyRevision',k.policy_revision),
 'human',NULL
FROM (
 SELECT DISTINCT ON (i.id,g.principal_id,g.membership_id) gen_random_uuid()::text AS grant_key,i.organization_id::text AS organization_id,
  i.workspace_id::text AS workspace_id,g.membership_id::text AS membership_id,g.principal_id::text AS principal_id,
  o.policy_revision::bigint AS policy_revision,
  jsonb_build_object('organizationId',i.organization_id::text,'workspaceId',i.workspace_id::text,
   'storeIds',jsonb_build_array(i.store_id::text),'accountIds','[]'::jsonb,
   'resources',jsonb_build_array(jsonb_build_object('organizationId',i.organization_id::text,'workspaceId',i.workspace_id::text,
    'storeId',i.store_id::text,'connectionId',i.connection_id::text,'kind','store','id',i.store_id::text)),
   'fields','["connectionId","control"]'::jsonb) AS scope
 FROM morrow_identity.store_installations i
 JOIN morrow_identity.organizations o ON o.id=i.organization_id
 JOIN morrow_identity.grants g ON g.organization_id=i.organization_id AND g.workspace_id=i.workspace_id AND g.principal_kind='human'
  AND g.membership_id IS NOT NULL
  AND g.payload->>'capabilityId'='agents.installation.activate'
  AND g.payload#>>'{issuedBy,kind}'='service' AND g.payload#>>'{issuedBy,principalId}'='morrow.linking'
  AND g.payload->'revokedAt'='null'::jsonb
  AND g.payload#>'{scope,storeIds}'=jsonb_build_array(i.store_id::text)
  AND g.payload#>'{scope,resources}'=jsonb_build_array(jsonb_build_object('organizationId',i.organization_id::text,
   'workspaceId',i.workspace_id::text,'storeId',i.store_id::text,'connectionId',i.connection_id::text,'kind','store','id',i.store_id::text))
 WHERE i.status='linked' AND i.link_id IS NOT NULL
 ORDER BY i.id,g.principal_id,g.membership_id
) k
WHERE NOT EXISTS(SELECT 1 FROM morrow_identity.grants x WHERE x.organization_id=k.organization_id AND x.workspace_id=k.workspace_id
  AND x.membership_id=k.membership_id AND x.principal_id=k.principal_id
  AND x.payload->>'capabilityId'='governance.connection.disconnect' AND x.payload->'revokedAt'='null'::jsonb
  AND x.payload->'scope'=k.scope);
COMMIT;
