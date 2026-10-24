BEGIN;
-- v1 PR 1: the identity side of the owner's live store (ADR-0035 item 2; ADR-0022 items 3-5,
-- amended; docs/briefs/v1-connect-store.md). Executes AS morrow_identity_owner, after 0038.
-- It adds:
--   * shopify_apps.live_store, the live-store mark: false for every app 0026's registration
--     writes, true only for the app shopify_app_register_live writes; never changed after
--     the row is born (0036's record guard compares every column, this one included);
--   * at most one active marked app per environment (a partial unique index), and every
--     marked app of an environment, retired or not, for one intended shop (a guard on the
--     insert): one store that is not a development store per environment, the owner's;
--   * a guard on store_installations: an installation that is not a development store is
--     born, or re-authorised, only under the active marked app and only for its intended
--     shop, so the database refuses a live store however the row is written;
--   * the operator's live registration (INVOKER, granted to nobody), and the broker's
--     admission bridge (EXECUTE for morrow_work_command only; 0040's vault definer calls
--     it): admitted only for the active marked app's own intended shop;
--   * issue_shopify_link_handoff and link_workspace_store replaced with the same
--     signatures, owner and ACL, with one change each: an installation is linkable when it
--     is a development store, or when its app is the active marked app and the store is
--     that app's intended shop. Every other check is 0026's, unchanged.
-- The shop's domain never appears here or anywhere in the repository: the registry keeps
-- its sha256 digest only (0026), and the operator passes that digest.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR to_regclass('morrow_identity.shopify_apps') IS NULL OR to_regclass('morrow_identity.store_installations') IS NULL
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_identity.shopify_apps'::regclass
   AND a.attname='live_store' AND NOT a.attisdropped)
 OR to_regprocedure('morrow_identity.executor_role_safe(text)') IS NULL
 OR NOT pg_catalog.has_function_privilege('morrow_identity_owner','morrow_billing.link_route_current(text,text)','EXECUTE')
 OR to_regprocedure('morrow_identity.shopify_app_register_live(text,text,text,text,text,text,text)') IS NOT NULL
 OR to_regprocedure('morrow_identity.work_shopify_live_store(text,text)') IS NOT NULL
 OR to_regprocedure('morrow_identity.shopify_live_store_guard()') IS NOT NULL
 -- The two function texts this file replaces, exactly as 0026 wrote them (a missed merge
 -- fails here).
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('morrow_identity.issue_shopify_link_handoff(text,text,text,text,text)'))
  IS DISTINCT FROM '138e5c4a960938e3c91e76bacf534488'
 OR (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
   WHERE p.oid=to_regprocedure('morrow_identity.link_workspace_store(text,text,text,text,text,text,text,text,text,text,text)'))
  IS DISTINCT FROM '74cb9d49a95458e4335ab522cc8defb2'
 THEN RAISE EXCEPTION 'SHOPIFY_LIVE_STORE_IDENTITY_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The mark. Existing rows (development-store apps) take false.
ALTER TABLE morrow_identity.shopify_apps ADD COLUMN live_store boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX shopify_apps_one_live_store ON morrow_identity.shopify_apps (environment_id)
 WHERE live_store AND status='active';

-- The guard of the mark (INVOKER, owned by the identity owner, granted to nobody):
-- shopify_apps: a marked app is born only when every marked app of its environment, retired
--   or not, names the same intended shop (the index above admits one active at a time);
-- store_installations: a row that is not a development store, when it is born or when a
--   re-authorisation writes its flag, needs the active marked app as its app and that
--   app's intended shop as its domain. The end states (suspension, uninstall, credential
--   destruction, shop/redact's pseudonym) change neither the flag nor the credential
--   version, so they pass untouched.
CREATE FUNCTION morrow_identity.shopify_live_store_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE v_check boolean;
BEGIN
 -- One branch per table: PL/pgSQL resolves every NEW field an expression names.
 IF TG_TABLE_NAME='shopify_apps' THEN
  IF TG_OP='INSERT' AND NEW.live_store AND EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a
    WHERE a.live_store AND a.environment_id=NEW.environment_id AND a.intended_shop_digest<>NEW.intended_shop_digest) THEN
   RAISE EXCEPTION 'SHOPIFY_LIVE_STORE_TAKEN';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='store_installations' THEN
  IF NEW.development_store THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
   v_check:=true;
  ELSE
   v_check:=OLD.development_store OR NEW.credential_version<>OLD.credential_version;
  END IF;
  IF v_check AND NOT EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a WHERE a.app_key=NEW.app_key
    AND a.status='active' AND a.live_store
    AND a.intended_shop_digest=encode(sha256(convert_to(NEW.shop_domain,'UTF8')),'hex')) THEN
   RAISE EXCEPTION 'SHOPIFY_STORE_NOT_DEVELOPMENT';
  END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'SHOPIFY_LIVE_STORE_GUARD_INVALID';
END $$;
REVOKE ALL ON FUNCTION morrow_identity.shopify_live_store_guard() FROM PUBLIC;
CREATE TRIGGER shopify_live_store_guard BEFORE INSERT ON morrow_identity.shopify_apps
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.shopify_live_store_guard();
CREATE TRIGGER shopify_live_store_guard BEFORE INSERT OR UPDATE ON morrow_identity.store_installations
 FOR EACH ROW EXECUTE FUNCTION morrow_identity.shopify_live_store_guard();

-- ---------------------------------------------------------------------------
-- The operator's live registration (INVOKER, owned by the identity owner, granted to
-- nobody; only the owner's audited script runs it, as morrow_identity_owner inside the
-- administrator's own transaction): 0026's registration with the mark set. Under one
-- per-environment lock, it refuses when the environment already has an active marked app,
-- or a marked app (retired or not) for another shop (live_store_taken); every other rule is
-- 0026's (exists, invalid, denied). Outcomes: registered, exists, live_store_taken,
-- invalid, denied.
CREATE FUNCTION morrow_identity.shopify_app_register_live(p_app_key text,p_client_id text,p_environment text,
 p_intended_shop_digest text,p_org text,p_ws text,p_install_url text)
RETURNS TABLE(outcome text,app_key text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE v_at timestamptz; n integer;
BEGIN
 IF current_user<>'morrow_identity_owner' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$' OR p_client_id IS NULL OR p_client_id !~ '^[a-f0-9]{32}$'
  OR p_environment IS NULL OR p_environment NOT IN ('development','staging')
  OR p_intended_shop_digest IS NULL OR p_intended_shop_digest !~ '^[a-f0-9]{64}$'
  OR p_org IS NULL OR p_org !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR p_ws IS NULL OR p_ws !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_install_url IS NULL OR length(p_install_url)>2048
  OR p_install_url !~ '^https://(admin\.shopify\.com|[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com)/[!-~]+$'
  OR NOT EXISTS(SELECT 1 FROM morrow_identity.workspaces w JOIN morrow_identity.organizations o ON o.id=w.organization_id
   WHERE w.id=p_ws AND w.organization_id=p_org AND w.active AND o.active) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
  pg_catalog.jsonb_build_array('morrow.identity.shopify_live_store',p_environment)::text,0));
 IF EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a WHERE a.app_key=p_app_key OR a.client_id=p_client_id
   OR (a.status='active' AND a.intended_shop_digest=p_intended_shop_digest))
  OR EXISTS(SELECT 1 FROM morrow_identity.store_installations i WHERE i.status<>'uninstalled'
   AND encode(sha256(convert_to(i.shop_domain,'UTF8')),'hex')=p_intended_shop_digest) THEN
  RETURN QUERY SELECT 'exists'::text,NULL::text; RETURN;
 END IF;
 IF EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a WHERE a.live_store AND a.environment_id=p_environment
   AND (a.status='active' OR a.intended_shop_digest<>p_intended_shop_digest)) THEN
  RETURN QUERY SELECT 'live_store_taken'::text,NULL::text; RETURN;
 END IF;
 v_at:=date_trunc('milliseconds',clock_timestamp());
 INSERT INTO morrow_identity.shopify_apps(app_key,client_id,environment_id,intended_shop_digest,invited_organization_id,
  invited_workspace_id,scopes,api_version,install_url,status,revision,created_at,retired_at,live_store)
 VALUES (p_app_key,p_client_id,p_environment,p_intended_shop_digest,p_org,p_ws,'read_products,write_products','2026-10',
  p_install_url,'active',1,v_at,NULL,true);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN QUERY SELECT CASE WHEN n=1 THEN 'registered' ELSE 'invalid' END,p_app_key;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.shopify_app_register_live(text,text,text,text,text,text,text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The broker's admission bridge (definer owned by the identity owner, EXECUTE for
-- morrow_work_command only; 0040's vault definer, the broker's own login, calls it before
-- an install of a store that Shopify reports is not a development store): admitted only
-- when the app is active, carries the mark and the shop is its intended shop. Takes the app
-- key and the domain the broker verified, never a workspace. Outcomes: admitted, refused,
-- invalid.
CREATE FUNCTION morrow_identity.work_shopify_live_store(p_app_key text,p_shop_domain text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
BEGIN
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$'
  OR p_shop_domain IS NULL OR length(p_shop_domain)>255 OR p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' THEN
  RETURN 'invalid';
 END IF;
 RETURN CASE WHEN EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a WHERE a.app_key=p_app_key AND a.status='active'
   AND a.live_store AND a.intended_shop_digest=encode(sha256(convert_to(p_shop_domain,'UTF8')),'hex'))
  THEN 'admitted' ELSE 'refused' END;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.work_shopify_live_store(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_shopify_live_store(text,text) TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- issue_shopify_link_handoff (0026), same signature, owner and ACL, with one change: the
-- installation must be a development store, or its app the active marked app and the
-- store that app's intended shop (was: a development store only).
CREATE OR REPLACE FUNCTION morrow_identity.issue_shopify_link_handoff(p_session text,p_workspace text,p_nonce text,p_command text,p_grant text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE
 v_org text; o morrow_identity.organizations%ROWTYPE; k morrow_identity.install_continuations%ROWTYPE;
 i morrow_identity.store_installations%ROWTYPE; c morrow_identity.linking_candidates%ROWTYPE;
 g morrow_identity.grants%ROWTYPE; e record; e2 record; v_at timestamptz; v_scope jsonb; v_resource jsonb;
 v_grant_ok boolean; v_start timestamptz; v_end timestamptz; v_proof text; v_proof_digest text; v_revision bigint;
 v_review text; v_handoff text; v_request text;
BEGIN
 IF NOT morrow_identity.executor_role_safe('morrow_identity_linking') THEN RETURN 'denied'; END IF;
 IF p_session IS NULL OR p_session !~ '^[a-f0-9]{64}$' OR p_nonce IS NULL OR p_nonce !~ '^[a-f0-9]{64}$'
  OR p_workspace IS NULL OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_command IS NULL OR p_command !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_grant IS NULL OR p_grant !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN 'invalid'; END IF;
 SELECT w.organization_id::text INTO v_org FROM morrow_identity.workspaces w WHERE w.id=p_workspace;
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 -- The organization interlock (0014), then the organization row.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.organization',v_org)::text,0));
 SELECT * INTO o FROM morrow_identity.organizations x WHERE x.id=v_org FOR UPDATE;
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 -- The continuation names its installation; lock order: installation, candidate,
 -- continuation (the install record's order).
 SELECT * INTO k FROM morrow_identity.install_continuations x WHERE x.token_digest=p_nonce;
 IF NOT FOUND OR k.organization_id<>v_org OR k.workspace_id<>p_workspace THEN RETURN 'not_found'; END IF;
 SELECT * INTO i FROM morrow_identity.store_installations x
  WHERE x.organization_id=k.organization_id AND x.workspace_id=k.workspace_id AND x.id=k.installation_id FOR UPDATE;
 SELECT * INTO c FROM morrow_identity.linking_candidates x WHERE x.installation_id=k.installation_id FOR UPDATE;
 SELECT * INTO k FROM morrow_identity.install_continuations x
  WHERE x.organization_id=k.organization_id AND x.workspace_id=k.workspace_id AND x.id=k.id FOR UPDATE;
 IF k.consumed_at IS NOT NULL THEN
  RETURN CASE WHEN EXISTS(SELECT 1 FROM morrow_identity.linking_handoffs h WHERE h.id=k.consumed_handoff_id
   AND h.session_digest=p_session AND h.workspace_id=p_workspace AND h.command_id=p_command AND h.nonce_digest=p_nonce)
   THEN 'exists' ELSE 'denied' END;
 END IF;
 v_at:=clock_timestamp();
 IF k.superseded_at IS NOT NULL OR k.expires_at<=v_at OR k.created_at>v_at THEN RETURN 'denied'; END IF;
 IF EXISTS(SELECT 1 FROM morrow_identity.linking_handoffs h WHERE h.organization_id=v_org AND h.command_id=p_command) THEN
  RETURN 'denied';
 END IF;
 -- The actor: the session's eligibility chain, locked in the shared order, then reread.
 SELECT x.principal_id,x.membership_id INTO e FROM morrow_identity.session_eligibility(p_session,p_workspace) x
  WHERE x.workspace_id=p_workspace AND x.organization_id=v_org;
 IF NOT FOUND THEN RETURN 'denied'; END IF;
 PERFORM morrow_identity.lock_session_eligibility(p_session,p_workspace,e.principal_id,v_org);
 PERFORM 1 FROM morrow_identity.principals x WHERE x.id=e.principal_id FOR UPDATE;
 PERFORM 1 FROM morrow_identity.workspaces x WHERE x.id=p_workspace AND x.organization_id=v_org FOR UPDATE;
 PERFORM 1 FROM morrow_identity.memberships x WHERE x.id=e.membership_id AND x.organization_id=v_org FOR UPDATE;
 PERFORM 1 FROM morrow_identity.workspace_memberships x WHERE x.workspace_id=p_workspace AND x.membership_id=e.membership_id FOR UPDATE;
 SELECT * INTO g FROM morrow_identity.grants x WHERE x.id=p_grant FOR UPDATE;
 SELECT x.principal_id,x.membership_id INTO e2 FROM morrow_identity.session_eligibility(p_session,p_workspace) x
  WHERE x.workspace_id=p_workspace AND x.organization_id=v_org;
 IF NOT FOUND OR e2.principal_id<>e.principal_id OR e2.membership_id<>e.membership_id OR NOT o.active THEN RETURN 'denied'; END IF;
 -- The owner: only the organization's founding principal links a Shopify store.
 IF NOT EXISTS(SELECT 1 FROM morrow_identity.organization_signups s WHERE s.organization_id=v_org AND s.principal_id=e.principal_id) THEN
  RETURN 'denied';
 END IF;
 -- The grant: the actor's own current connect/administer grant on the workspace resource.
 v_at:=clock_timestamp();
 v_resource:=jsonb_build_object('organizationId',v_org,'workspaceId',p_workspace,'storeId',NULL,'connectionId',NULL,'kind','workspace','id',p_workspace);
 v_grant_ok:=g.id IS NOT NULL AND g.organization_id=v_org AND g.workspace_id=p_workspace AND g.principal_id=e.principal_id
  AND g.membership_id=e.membership_id AND jsonb_typeof(g.payload)='object'
  AND g.payload->>'capabilityId'='governance.connection.connect' AND g.payload->'verbs' @> '["administer"]'::jsonb
  AND g.payload#>>'{principal,kind}'='human' AND g.payload#>'{principal,installationId}'='null'::jsonb
  AND g.payload#>'{principal,mandateId}'='null'::jsonb AND g.payload->'revokedAt'='null'::jsonb
  AND g.payload#>>'{scope,organizationId}'=v_org AND g.payload#>>'{scope,workspaceId}'=p_workspace
  AND g.payload#>'{scope,storeIds}'='[]'::jsonb AND g.payload#>'{scope,accountIds}'='[]'::jsonb
  AND g.payload#>'{scope,resources}' @> jsonb_build_array(v_resource)
  AND g.payload#>'{scope,fields}' @> '["installationProof","providerId","scope"]'::jsonb
  AND jsonb_typeof(g.payload->'policyRevision')='number' AND (g.payload->>'policyRevision')::numeric<=o.policy_revision;
 IF v_grant_ok THEN
  BEGIN
   v_start:=(g.payload->>'validFrom')::timestamptz;
   v_end:=(g.payload->>'expiresAt')::timestamptz;
   v_grant_ok:=v_start IS NOT NULL AND isfinite(v_start) AND v_start<=v_at
    AND (g.payload->'expiresAt'='null'::jsonb OR (v_end IS NOT NULL AND isfinite(v_end) AND v_end>v_at));
  EXCEPTION WHEN OTHERS THEN v_grant_ok:=false;
  END;
 END IF;
 IF v_grant_ok IS NOT TRUE THEN RETURN 'denied'; END IF;
 -- The installation and its candidate.
 IF i.id IS NULL OR i.status<>'unlinked'
  OR NOT EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a WHERE a.app_key=i.app_key AND a.status='active'
   AND a.invited_organization_id=i.organization_id AND a.invited_workspace_id=i.workspace_id
   AND (i.development_store OR (a.live_store AND a.intended_shop_digest=encode(sha256(convert_to(i.shop_domain,'UTF8')),'hex'))))
  OR c.id IS NULL OR NOT c.active OR c.proof_kind<>'shopify_oauth' OR c.proof_revoked_at IS NOT NULL
  OR c.generation<>i.generation OR c.proof_revision>=9007199254740991
  OR EXISTS(SELECT 1 FROM morrow_identity.workspace_store_links l WHERE l.candidate_id=c.id) THEN
  RETURN 'denied';
 END IF;
 -- The route, only after the session and grant passed (ADR-0022 item 5).
 IF morrow_billing.link_route_current(v_org,p_workspace) IS DISTINCT FROM 'morrow_direct' THEN RETURN 'route_not_ready'; END IF;
 -- Rebind the proof to the actor, then the review and the handoff.
 v_proof:=gen_random_uuid()::text;
 v_revision:=c.proof_revision+1;
 v_proof_digest:=encode(sha256(convert_to(jsonb_build_array('morrow.linking.shopify_oauth.proof',1,c.id::text,i.id::text,
  c.shop_id,v_proof,v_revision,e.principal_id)::text,'UTF8')),'hex');
 UPDATE morrow_identity.linking_candidates x SET eligible_principal_id=e.principal_id,proof_id=v_proof,proof_revision=v_revision,
  proof_digest=v_proof_digest,proof_created_at=v_at,proof_expires_at=v_at+interval '10 minutes',proof_revoked_at=NULL
  WHERE x.id=c.id RETURNING * INTO c;
 v_scope:=jsonb_build_object('organizationId',v_org,'workspaceId',p_workspace,'storeIds','[]'::jsonb,'accountIds','[]'::jsonb,
  'resources',jsonb_build_array(v_resource),'fields','["installationProof","providerId","scope"]'::jsonb);
 v_review:=gen_random_uuid()::text;
 v_handoff:=gen_random_uuid()::text;
 v_request:=encode(sha256(convert_to(jsonb_build_array('morrow.linking.shopify_oauth.handoff',1,v_org,p_workspace,e.principal_id,
  e.membership_id,p_session,p_nonce,p_command,v_handoff,i.id::text,i.generation,c.proof_id::text,c.proof_revision,c.proof_digest,
  g.id::text,o.policy_revision,c.ownership_revision,'workspace_first')::text,'UTF8')),'hex');
 INSERT INTO morrow_identity.linking_reviews(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,
  nonce_digest,handoff_id,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,
  expected_ownership_revision,proof_id,proof_revision,proof_digest,scope_snapshot,evidence_kind,created_at,expires_at)
 VALUES (v_review,v_org,p_workspace,e.principal_id,e.membership_id,p_session,p_nonce,v_handoff,c.id,i.id,i.generation,p_command,v_request,
  'workspace_first',o.policy_revision,c.ownership_revision,c.proof_id,c.proof_revision,c.proof_digest,v_scope,'shopify_oauth',
  v_at,v_at+interval '5 minutes');
 INSERT INTO morrow_identity.linking_handoffs(id,organization_id,workspace_id,actor_principal_id,actor_membership_id,session_digest,
  nonce_digest,candidate_id,installation_id,generation,command_id,request_digest,purpose,expected_policy_revision,
  expected_ownership_revision,proof_id,proof_revision,proof_digest,review_id,authorizing_grant_id,authorizing_grant_snapshot,
  requested_scope_snapshot,created_at,expires_at)
 VALUES (v_handoff,v_org,p_workspace,e.principal_id,e.membership_id,p_session,p_nonce,c.id,i.id,i.generation,p_command,v_request,
  'workspace_first',o.policy_revision,c.ownership_revision,c.proof_id,c.proof_revision,c.proof_digest,v_review,g.id,g.payload,v_scope,
  v_at,v_at+interval '5 minutes');
 UPDATE morrow_identity.install_continuations x SET consumed_at=greatest(date_trunc('milliseconds',v_at),x.created_at),
  consumed_principal_id=e.principal_id,consumed_handoff_id=v_handoff
  WHERE x.organization_id=k.organization_id AND x.workspace_id=k.workspace_id AND x.id=k.id;
 RETURN 'issued';
END $$;

-- ---------------------------------------------------------------------------
-- link_workspace_store (0026), same signature, result, owner and ACL, with one change: a
-- shopify_oauth candidate's installation must be a development store, or its app the active
-- marked app and the store that app's intended shop (was: a development store only); else
-- installation_ineligible, as before.
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
     FROM (SELECT x.capability_id,x.verbs,x.fields,gen_random_uuid()::text AS grant_key FROM morrow_identity.store_link_grants_v1() x) t;
   END IF;
 END IF;
 UPDATE morrow_identity.linking_handoffs SET consumed_at=at_time WHERE id=h.id;
 INSERT INTO morrow_identity.workspace_link_results VALUES(result_id,h.id,h.organization_id,h.workspace_id,h.command_id,h.actor_principal_id,c.id,h.review_id,
   CASE WHEN reason_code='applied' THEN 'applied' ELSE 'denied' END,reason_code,created_link,CASE WHEN reason_code='applied' THEN c.ownership_revision ELSE NULL END,o.policy_revision,at_time);
 RETURN QUERY SELECT CASE WHEN reason_code='applied' THEN 'applied' ELSE 'denied' END,created_link,
   CASE WHEN reason_code='applied' THEN c.ownership_revision::text ELSE NULL END,o.policy_revision::text,result_id;
END $$;
COMMIT;
