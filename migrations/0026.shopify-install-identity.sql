BEGIN;
-- M2 PR-2: the identity side of the Shopify install and link (ADR-0022 items 3-5 and 8;
-- ADR-0008 items 2 and 5; mvp-architecture §2 steps 4-5 and §6; P09.T01a, P09.T02a).
-- Executes AS morrow_identity_owner, after 0025. It adds:
--   * the platform app registry (shopify_apps), the single-use OAuth states, the store
--     installations (StoreInstallation@1) and the install continuations (ADR-0015
--     persistence item 2), each ENABLE and FORCE RLS with the identity_owner policy only
--     and an immutability guard; tenant-keyed references are composite foreign keys, and
--     one shop has at most one installation that is not uninstalled, under any app;
--   * shopify_oauth as a linking proof and review evidence kind, and the two new link
--     result reasons, by forward CHECK replacement;
--   * the store-link grant template (ADR-0022 item 3) and link_workspace_store replaced
--     with the same signature, owner and ACL: the route must be fixed to morrow_direct
--     (ADR-0022 item 5, every candidate kind; shopify_bound_at is never set), a
--     shopify_oauth link needs the organization's owner (its founding principal) as the
--     actor and an active app, marks its installation linked and issues the template's
--     grants to that owner on the store resource;
--   * the connector login's one definer (the OAuth state), the vault login's identity
--     bridges (EXECUTE to morrow_work_command only; 0027's vault definers call them), the
--     shared store-installation read bridge for the work and billing definers, and the
--     linking login's issuer, authority and connections reads;
--   * the operator's app registration and retirement (INVOKER, granted to nobody).
-- Tenancy is server-derived (invariant 1): the workspace comes from the registry and the
-- session, never from a shop, host or query value. Role checks reuse the ADR-0020 helpers
-- through executor_role_safe and work_executor_safe, so the helper census is unchanged.
DO $$ BEGIN
 IF current_user<>'morrow_identity_owner'
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles o WHERE o.rolname='morrow_identity_owner' AND NOT o.rolcanlogin AND NOT o.rolsuper AND NOT o.rolbypassrls AND NOT o.rolcreatedb AND NOT o.rolcreaterole AND NOT o.rolinherit AND NOT o.rolreplication)
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR NOT morrow_identity.morrow_memberships_closed()
 OR NOT pg_catalog.has_function_privilege('morrow_identity_owner','morrow_billing.link_route_current(text,text)','EXECUTE')
 OR to_regprocedure('morrow_identity.work_executor_safe(text)') IS NULL
 OR to_regprocedure('morrow_identity.executor_role_safe(text)') IS NULL
 OR to_regprocedure('morrow_identity.session_eligibility(text,text)') IS NULL
 OR to_regprocedure('morrow_identity.lock_session_eligibility(text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_identity.link_workspace_store(text,text,text,text,text,text,text,text,text,text,text)') IS NULL
 OR to_regclass('morrow_identity.organization_signups') IS NULL OR to_regclass('morrow_identity.workspace_store_links') IS NULL
 -- The three CHECKs this file widens, exactly as 0005 wrote them (a missed merge fails here).
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_identity.linking_candidates'::regclass
   AND c.conname='linking_candidates_proof_kind_check') IS DISTINCT FROM 'CHECK ((proof_kind = ''controlled_fixture''::text))'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_identity.linking_reviews'::regclass
   AND c.conname='linking_reviews_evidence_kind_check') IS DISTINCT FROM 'CHECK ((evidence_kind = ''controlled_review''::text))'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_identity.workspace_link_results'::regclass
   AND c.conname='workspace_link_results_reason_check') IS DISTINCT FROM
   'CHECK ((reason = ANY (ARRAY[''applied''::text, ''actor_ineligible''::text, ''grant_changed''::text, ''handoff_expired''::text, ''review_invalid''::text, ''proof_invalid''::text, ''purpose_denied''::text, ''policy_conflict''::text, ''ownership_conflict''::text, ''revision_exhausted''::text])))'
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conname IN ('workspace_store_links_tenant_id_key','linking_handoffs_tenant_id_key'))
 OR to_regclass('morrow_identity.shopify_apps') IS NOT NULL OR to_regclass('morrow_identity.store_installations') IS NOT NULL
 OR to_regprocedure('morrow_identity.work_store_installations(text,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'SHOPIFY_INSTALL_IDENTITY_PREREQUISITES_INVALID'; END IF;
END $$;

-- The connector login executes exactly one identity definer (connector_oauth_state_open).
GRANT USAGE ON SCHEMA morrow_identity TO morrow_connector_ingress;
-- Tenant-keyed targets for the composite foreign keys below: a link or handoff id names
-- one tenant's row, so the database refuses a pointer across tenants (0005 rows unchanged).
ALTER TABLE morrow_identity.workspace_store_links
 ADD CONSTRAINT workspace_store_links_tenant_id_key UNIQUE (organization_id,workspace_id,id);
ALTER TABLE morrow_identity.linking_handoffs
 ADD CONSTRAINT linking_handoffs_tenant_id_key UNIQUE (organization_id,workspace_id,id);

-- ---------------------------------------------------------------------------
-- The platform registry: one custom-distribution app per beta store (ADR-0022 item 4).
-- The intended shop is stored as its sha256 digest. The install link names the shop (a
-- *.myshopify.com host, or the shop in a custom-distribution link's signed parameter), so
-- the registry is store content: retirement clears the link, and shop/redact clears it
-- (M2 PR-3; packages/work/src/redaction.ts). The client id is public; the client secret is
-- a morrow_vault.app_secrets row (0020), never here.
CREATE TABLE morrow_identity.shopify_apps (
 app_key text PRIMARY KEY CHECK (app_key ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
 client_id text NOT NULL UNIQUE CHECK (client_id ~ '^[a-f0-9]{32}$'),
 environment_id text NOT NULL CHECK (environment_id IN ('development','staging')),
 intended_shop_digest text NOT NULL CHECK (intended_shop_digest ~ '^[a-f0-9]{64}$'),
 invited_organization_id morrow_identity.record_id NOT NULL,
 invited_workspace_id morrow_identity.record_id NOT NULL,
 scopes text NOT NULL CHECK (scopes='read_products,write_products'),
 api_version text NOT NULL CHECK (api_version='2026-10'),
 install_url text CHECK (install_url IS NULL OR (length(install_url)<=2048
  AND install_url ~ '^https://(admin\.shopify\.com|[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com)/[!-~]+$')),
 status text NOT NULL CHECK (status IN ('active','retired')),
 revision morrow_identity.revision NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 retired_at timestamptz CHECK (retired_at=date_trunc('milliseconds',retired_at) AND isfinite(retired_at)),
 UNIQUE (app_key,invited_organization_id,invited_workspace_id),
 FOREIGN KEY (invited_organization_id,invited_workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CHECK ((status='active')=(retired_at IS NULL) AND (retired_at IS NULL OR retired_at>=created_at))
);
CREATE UNIQUE INDEX shopify_apps_one_active_shop ON morrow_identity.shopify_apps (intended_shop_digest) WHERE status='active';
-- One OAuth state: its digest only (the state itself lives in the browser's __Host-
-- cookie and Shopify's redirect), 10 minutes, claimed once by the callback and recorded
-- once by the install it led to. Content-free; 7 days (data-lifecycle.md).
CREATE TABLE morrow_identity.shopify_oauth_states (
 id morrow_identity.record_id PRIMARY KEY,
 app_key text NOT NULL REFERENCES morrow_identity.shopify_apps(app_key),
 shop_digest text NOT NULL CHECK (shop_digest ~ '^[a-f0-9]{64}$'),
 state_digest text NOT NULL UNIQUE CHECK (state_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 expires_at timestamptz NOT NULL,
 claimed_at timestamptz CHECK (claimed_at=date_trunc('milliseconds',claimed_at) AND isfinite(claimed_at)),
 installation_id morrow_identity.record_id,
 CHECK (expires_at=created_at+interval '10 minutes'),
 CHECK ((claimed_at IS NULL OR claimed_at>=created_at) AND (installation_id IS NULL OR claimed_at IS NOT NULL))
);
CREATE INDEX shopify_oauth_states_open ON morrow_identity.shopify_oauth_states (app_key,expires_at) WHERE claimed_at IS NULL;
-- StoreInstallation@1. The tenant is the registry's invited workspace; the installation id
-- is also the linking candidate's installation id, the vault credential's subject and the
-- link's installation id. store_id and connection_id are allocated at the first install
-- and make the store resource {kind: store, id: store_id, storeId, connectionId}.
-- granted_scopes are expanded and sorted. shop_domain is shop identity (spine §11):
-- shop/redact pseudonymises it in M2 PR-3. The tenant is the app's invited workspace and
-- the link is the tenant's own (composite foreign keys); one shop (by id or domain) has at
-- most one installation that is not uninstalled, whichever app installed it.
CREATE TABLE morrow_identity.store_installations (
 organization_id morrow_identity.record_id NOT NULL,
 workspace_id morrow_identity.record_id NOT NULL,
 id morrow_identity.record_id NOT NULL UNIQUE,
 app_key text NOT NULL,
 shop_id text NOT NULL CHECK (shop_id ~ '^[1-9][0-9]{0,19}$'),
 shop_domain text NOT NULL CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' AND length(shop_domain)<=255),
 store_id morrow_identity.record_id NOT NULL UNIQUE,
 connection_id morrow_identity.record_id NOT NULL UNIQUE,
 generation morrow_identity.revision NOT NULL,
 status text NOT NULL CHECK (status IN ('unlinked','linked','suspended','uninstalled')),
 granted_scopes text[] NOT NULL CHECK (granted_scopes=ARRAY['read_products','write_products']::text[] OR granted_scopes=ARRAY['read_products']::text[]),
 credential_id morrow_identity.record_id NOT NULL UNIQUE,
 credential_version morrow_identity.revision NOT NULL,
 development_store boolean NOT NULL,
 link_id morrow_identity.record_id UNIQUE,
 revision morrow_identity.revision NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 reauthorised_at timestamptz CHECK (reauthorised_at=date_trunc('milliseconds',reauthorised_at) AND isfinite(reauthorised_at)),
 linked_at timestamptz CHECK (linked_at=date_trunc('milliseconds',linked_at) AND isfinite(linked_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (app_key,shop_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (app_key,organization_id,workspace_id)
  REFERENCES morrow_identity.shopify_apps(app_key,invited_organization_id,invited_workspace_id),
 FOREIGN KEY (organization_id,workspace_id,link_id) REFERENCES morrow_identity.workspace_store_links(organization_id,workspace_id,id),
 CHECK ((link_id IS NULL)=(linked_at IS NULL) AND (status<>'linked' OR link_id IS NOT NULL) AND (status<>'unlinked' OR link_id IS NULL)),
 CHECK (updated_at>=created_at AND (linked_at IS NULL OR linked_at>=created_at) AND (reauthorised_at IS NULL OR reauthorised_at>=created_at))
);
CREATE UNIQUE INDEX store_installations_one_live_shop_id ON morrow_identity.store_installations (shop_id) WHERE status<>'uninstalled';
CREATE UNIQUE INDEX store_installations_one_live_shop_domain ON morrow_identity.store_installations (shop_domain) WHERE status<>'uninstalled';
-- An OAuth state records the installation it led to.
ALTER TABLE morrow_identity.shopify_oauth_states
 ADD FOREIGN KEY (installation_id) REFERENCES morrow_identity.store_installations(id);
-- The continuation of a first-party install (ADR-0015 persistence item 2): the digest of a
-- 32-byte token the broker hands the connector for the browser fragment, 5 minutes, single
-- use, superseded by a later install of the same store. Content-free; 365 days.
CREATE TABLE morrow_identity.install_continuations (
 organization_id morrow_identity.record_id NOT NULL,
 workspace_id morrow_identity.record_id NOT NULL,
 id morrow_identity.record_id NOT NULL,
 installation_id morrow_identity.record_id NOT NULL,
 token_digest text NOT NULL UNIQUE CHECK (token_digest ~ '^[a-f0-9]{64}$'),
 purpose text NOT NULL CHECK (purpose='workspace_first'),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND isfinite(created_at)),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz CHECK (consumed_at=date_trunc('milliseconds',consumed_at) AND isfinite(consumed_at)),
 consumed_principal_id morrow_identity.record_id REFERENCES morrow_identity.principals(id),
 consumed_handoff_id morrow_identity.record_id UNIQUE,
 superseded_at timestamptz CHECK (superseded_at=date_trunc('milliseconds',superseded_at) AND isfinite(superseded_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_identity.store_installations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,consumed_handoff_id) REFERENCES morrow_identity.linking_handoffs(organization_id,workspace_id,id),
 CHECK (expires_at=created_at+interval '5 minutes'),
 CHECK ((consumed_at IS NULL)=(consumed_principal_id IS NULL) AND (consumed_at IS NULL)=(consumed_handoff_id IS NULL)
  AND (consumed_at IS NULL OR superseded_at IS NULL)
  AND (consumed_at IS NULL OR consumed_at>=created_at) AND (superseded_at IS NULL OR superseded_at>=created_at))
);
CREATE UNIQUE INDEX install_continuations_one_open ON morrow_identity.install_continuations (installation_id)
 WHERE consumed_at IS NULL AND superseded_at IS NULL;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['shopify_apps','shopify_oauth_states','store_installations','install_continuations'] LOOP
  EXECUTE format('ALTER TABLE morrow_identity.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_identity.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY identity_owner ON morrow_identity.%I TO morrow_identity_owner USING(true) WITH CHECK(true)',t);
  EXECUTE format('REVOKE ALL ON morrow_identity.%I FROM PUBLIC',t);
 END LOOP;
END $$;

-- The guard of the four tables (INVOKER, owned by the identity owner, granted to nobody):
-- shopify_apps: born active at revision 1 with its install link; the changes are active ->
--   retired (which may clear the link) and clearing the link (shop/redact, M2 PR-3), each
--   one revision.
-- shopify_oauth_states: claimed once, then recorded once; no delete (the P09.T05 prune
--   replaces this function in a later forward migration).
-- store_installations: born unlinked at revision 1; identity and tenant never change;
--   unlinked -> linked only with its link; a re-authorisation adds exactly one credential
--   version; every change is one revision.
-- install_continuations: born open; the one change is open -> consumed or superseded.
CREATE FUNCTION morrow_identity.shopify_preserve_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE v_fixed text[];
BEGIN
 -- One branch per table: PL/pgSQL resolves every NEW field an expression names.
 IF TG_OP='INSERT' THEN
  IF TG_TABLE_NAME='shopify_apps' THEN
   IF NEW.status='active' AND NEW.revision=1 AND NEW.retired_at IS NULL AND NEW.install_url IS NOT NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='shopify_oauth_states' THEN
   IF NEW.claimed_at IS NULL AND NEW.installation_id IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='store_installations' THEN
   IF NEW.status='unlinked' AND NEW.revision=1 AND NEW.generation=1 AND NEW.link_id IS NULL AND NEW.linked_at IS NULL
    AND NEW.reauthorised_at IS NULL AND NEW.credential_version=1 AND NEW.updated_at=NEW.created_at THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='install_continuations' THEN
   IF NEW.consumed_at IS NULL AND NEW.superseded_at IS NULL THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'SHOPIFY_RECORD_INVALID';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='shopify_apps' THEN
   IF OLD.status='active' AND NEW.status='retired' AND NEW.revision=OLD.revision+1 AND NEW.retired_at IS NOT NULL
    AND (NEW.install_url IS NULL OR NEW.install_url=OLD.install_url)
    AND (to_jsonb(NEW)-ARRAY['status','revision','retired_at','install_url'])=(to_jsonb(OLD)-ARRAY['status','revision','retired_at','install_url']) THEN RETURN NEW; END IF;
   IF OLD.install_url IS NOT NULL AND NEW.install_url IS NULL AND NEW.revision=OLD.revision+1
    AND (to_jsonb(NEW)-ARRAY['install_url','revision'])=(to_jsonb(OLD)-ARRAY['install_url','revision']) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='shopify_oauth_states' THEN
   IF OLD.claimed_at IS NULL AND NEW.claimed_at IS NOT NULL AND NEW.installation_id IS NULL
    AND (to_jsonb(NEW)-'claimed_at')=(to_jsonb(OLD)-'claimed_at') THEN RETURN NEW; END IF;
   IF OLD.claimed_at IS NOT NULL AND OLD.installation_id IS NULL AND NEW.installation_id IS NOT NULL
    AND (to_jsonb(NEW)-'installation_id')=(to_jsonb(OLD)-'installation_id') THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='store_installations' THEN
   v_fixed:=ARRAY['organization_id','workspace_id','id','app_key','shop_id','shop_domain','store_id','connection_id',
    'generation','credential_id','created_at'];
   IF (SELECT jsonb_object_agg(k,to_jsonb(NEW)->k) FROM unnest(v_fixed) k)=(SELECT jsonb_object_agg(k,to_jsonb(OLD)->k) FROM unnest(v_fixed) k)
    AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at
    -- Scopes, the development flag and the re-authorisation time change only with the
    -- next credential version.
    AND ((NEW.credential_version=OLD.credential_version AND NEW.reauthorised_at IS NOT DISTINCT FROM OLD.reauthorised_at
      AND NEW.granted_scopes=OLD.granted_scopes AND NEW.development_store=OLD.development_store)
     OR (NEW.credential_version=OLD.credential_version+1 AND NEW.reauthorised_at IS NOT NULL AND NEW.status=OLD.status))
    AND (NEW.status=OLD.status
     OR (OLD.status='unlinked' AND NEW.status='linked' AND NEW.link_id IS NOT NULL AND OLD.link_id IS NULL AND NEW.credential_version=OLD.credential_version))
    AND (NEW.link_id IS NOT DISTINCT FROM OLD.link_id OR (OLD.link_id IS NULL AND NEW.status='linked'))
    AND (NEW.linked_at IS NOT DISTINCT FROM OLD.linked_at OR (OLD.linked_at IS NULL AND NEW.status='linked')) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='install_continuations' THEN
   IF OLD.consumed_at IS NULL AND OLD.superseded_at IS NULL
    AND ((NEW.consumed_at IS NOT NULL AND NEW.superseded_at IS NULL
      AND (to_jsonb(NEW)-ARRAY['consumed_at','consumed_principal_id','consumed_handoff_id'])=(to_jsonb(OLD)-ARRAY['consumed_at','consumed_principal_id','consumed_handoff_id']))
     OR (NEW.superseded_at IS NOT NULL AND NEW.consumed_at IS NULL
      AND (to_jsonb(NEW)-'superseded_at')=(to_jsonb(OLD)-'superseded_at'))) THEN RETURN NEW; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'SHOPIFY_RECORD_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION morrow_identity.shopify_preserve_record() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['shopify_apps','shopify_oauth_states','store_installations','install_continuations'] LOOP
  EXECUTE format('CREATE TRIGGER shopify_record_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_identity.%I FOR EACH ROW EXECUTE FUNCTION morrow_identity.shopify_preserve_record()',t);
  EXECUTE format('CREATE TRIGGER shopify_record_no_truncate BEFORE TRUNCATE ON morrow_identity.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_identity.shopify_preserve_record()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Forward CHECK replacements (0005): the shopify_oauth proof and evidence kinds, and the
-- two new link refusals. The unions of every value at the head.
ALTER TABLE morrow_identity.linking_candidates DROP CONSTRAINT linking_candidates_proof_kind_check,
 ADD CONSTRAINT linking_candidates_proof_kind_check CHECK (proof_kind IN ('controlled_fixture','shopify_oauth'));
ALTER TABLE morrow_identity.linking_reviews DROP CONSTRAINT linking_reviews_evidence_kind_check,
 ADD CONSTRAINT linking_reviews_evidence_kind_check CHECK (evidence_kind IN ('controlled_review','shopify_oauth'));
ALTER TABLE morrow_identity.workspace_link_results DROP CONSTRAINT workspace_link_results_reason_check,
 ADD CONSTRAINT workspace_link_results_reason_check CHECK (reason IN ('applied','actor_ineligible','grant_changed','handoff_expired',
  'review_invalid','proof_invalid','purpose_denied','policy_conflict','ownership_conflict','revision_exhausted',
  'billing_route_required','installation_ineligible'));

-- The store-link grant template (ADR-0022 item 3), applied in the link transaction to the
-- linking owner on the store resource. Fields are the request's input names (the
-- owner-bootstrap-v1 rule): catalogue grants use exactly the listing FieldPaths
-- (listingFieldPaths in packages/policy/src/store-resource.ts); agents.installation.activate
-- uses its v1 input names. packages/policy/src/store-link-template.ts is the TypeScript
-- twin, pinned equal by tests/store-link-template.test.mjs.
CREATE FUNCTION morrow_identity.store_link_grants_v1() RETURNS TABLE(capability_id text,verbs jsonb,fields jsonb)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT c,v::jsonb,f::jsonb FROM (VALUES
  ('catalog.products.read','["view","delegate"]','["descriptionHtml","seo.description","seo.title","tags","title"]'),
  ('catalog.content.propose','["execute","delegate"]','["descriptionHtml","seo.description","seo.title","tags","title"]'),
  ('catalog.content.publish','["propose","approve","execute","delegate"]','["descriptionHtml","seo.description","seo.title","tags","title"]'),
  ('agents.installation.activate','["execute"]','["evaluation","grant","installationId","revision"]')) t(c,v,f)
$$;
REVOKE ALL ON FUNCTION morrow_identity.store_link_grants_v1() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Operator functions: INVOKER, owned by the identity owner, granted to nobody. Only the
-- owner's audited scripts run them, as morrow_identity_owner inside the administrator's
-- own transaction (the ADR-0020 runner shape).
-- Registers one app for one beta store: its key, public client id, environment, the
-- digest of the intended *.myshopify.com domain, the invited workspace (which must be
-- active) and the custom-distribution install link. A shop that already has an installation
-- that is not uninstalled (under any app, retired or not) cannot be registered again, so
-- one store is never linked into two workspaces. Outcomes: registered, exists, invalid,
-- denied.
CREATE FUNCTION morrow_identity.shopify_app_register(p_app_key text,p_client_id text,p_environment text,
 p_intended_shop_digest text,p_org text,p_ws text,p_install_url text)
RETURNS TABLE(outcome text,app_key text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE v_at timestamptz:=date_trunc('milliseconds',clock_timestamp()); n integer;
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
 IF EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a WHERE a.app_key=p_app_key OR a.client_id=p_client_id
   OR (a.status='active' AND a.intended_shop_digest=p_intended_shop_digest))
  OR EXISTS(SELECT 1 FROM morrow_identity.store_installations i WHERE i.status<>'uninstalled'
   AND encode(sha256(convert_to(i.shop_domain,'UTF8')),'hex')=p_intended_shop_digest) THEN
  RETURN QUERY SELECT 'exists'::text,NULL::text; RETURN;
 END IF;
 INSERT INTO morrow_identity.shopify_apps(app_key,client_id,environment_id,intended_shop_digest,invited_organization_id,
  invited_workspace_id,scopes,api_version,install_url,status,revision,created_at,retired_at)
 VALUES (p_app_key,p_client_id,p_environment,p_intended_shop_digest,p_org,p_ws,'read_products,write_products','2026-10',
  p_install_url,'active',1,v_at,NULL);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN QUERY SELECT CASE WHEN n=1 THEN 'registered' ELSE 'invalid' END,p_app_key;
END $$;
-- Retires one app: no new launch, state, install, offer or link. Its install link, which
-- names the shop, is cleared; the other rows are kept. Outcomes: retired, not_found,
-- invalid, denied.
CREATE FUNCTION morrow_identity.shopify_app_retire(p_app_key text)
RETURNS TABLE(outcome text,app_key text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE n integer;
BEGIN
 IF current_user<>'morrow_identity_owner' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 UPDATE morrow_identity.shopify_apps a SET status='retired',revision=a.revision+1,install_url=NULL,
  retired_at=greatest(date_trunc('milliseconds',clock_timestamp()),a.created_at)
  WHERE a.app_key=p_app_key AND a.status='active';
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN QUERY SELECT CASE WHEN n=1 THEN 'retired' ELSE 'not_found' END,p_app_key;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.shopify_app_register(text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_identity.shopify_app_retire(text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The connector login's one definer (ADR-0022 item 8): opens one OAuth state after the
-- broker verified the launch. It refuses unless the app is active and the shop is the
-- app's intended shop; at most 10 open states per app. Returns the public client id and
-- the fixed scopes for the authorize URL, never a workspace. Outcomes: opened, limited,
-- not_found, invalid, denied.
CREATE FUNCTION morrow_identity.connector_oauth_state_open(p_app_key text,p_shop_domain text,p_state_digest text)
RETURNS TABLE(outcome text,client_id text,scopes text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE a morrow_identity.shopify_apps%ROWTYPE; v_at timestamptz;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_connector_ingress') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$'
  OR p_shop_domain IS NULL OR length(p_shop_domain)>255 OR p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'
  OR p_state_digest IS NULL OR p_state_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO a FROM morrow_identity.shopify_apps x WHERE x.app_key=p_app_key AND x.status='active';
 IF NOT FOUND OR a.intended_shop_digest<>encode(sha256(convert_to(p_shop_domain,'UTF8')),'hex') THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.shopify_state',p_app_key)::text,0));
 v_at:=date_trunc('milliseconds',clock_timestamp());
 IF (SELECT count(*) FROM morrow_identity.shopify_oauth_states s WHERE s.app_key=p_app_key AND s.claimed_at IS NULL AND s.expires_at>v_at)>=10 THEN
  RETURN QUERY SELECT 'limited'::text,NULL::text,NULL::text; RETURN;
 END IF;
 INSERT INTO morrow_identity.shopify_oauth_states(id,app_key,shop_digest,state_digest,created_at,expires_at,claimed_at,installation_id)
 VALUES (gen_random_uuid()::text,p_app_key,a.intended_shop_digest,p_state_digest,v_at,v_at+interval '10 minutes',NULL,NULL);
 RETURN QUERY SELECT 'opened'::text,a.client_id,a.scopes;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.connector_oauth_state_open(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.connector_oauth_state_open(text,text,text) TO morrow_connector_ingress;

-- ---------------------------------------------------------------------------
-- The vault login's identity bridges: definers owned by the identity owner, EXECUTE for
-- morrow_work_command only. 0027's vault definers (SECURITY DEFINER for the broker's own
-- login, morrow_vault_broker) call them; no other path reaches them. Each takes app keys,
-- digests and the shop facts the broker verified, never a workspace: the tenant comes
-- from the registry.
-- The registry and installation state for a launch, a status page or a webhook: the
-- public client id, the invited workspace and the installation's status (none when no
-- installation exists). Outcomes: found, not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_launch(p_app_key text,p_shop_domain text)
RETURNS TABLE(outcome text,client_id text,organization_id text,workspace_id text,installation text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE a morrow_identity.shopify_apps%ROWTYPE; v_status text;
BEGIN
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$'
  OR p_shop_domain IS NULL OR length(p_shop_domain)>255 OR p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO a FROM morrow_identity.shopify_apps x WHERE x.app_key=p_app_key AND x.status='active';
 IF NOT FOUND OR a.intended_shop_digest<>encode(sha256(convert_to(p_shop_domain,'UTF8')),'hex') THEN
  RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT i.status INTO v_status FROM morrow_identity.store_installations i WHERE i.app_key=p_app_key AND i.shop_domain=p_shop_domain;
 RETURN QUERY SELECT 'found'::text,a.client_id,a.invited_organization_id::text,a.invited_workspace_id::text,COALESCE(v_status,'none');
END $$;
-- Claims one state for the callback, alone in its own transaction, before any provider
-- call: a replayed or expired state can never reach the code exchange. Outcomes: claimed,
-- expired, replayed, not_found, invalid.
CREATE FUNCTION morrow_identity.work_shopify_state_claim(p_app_key text,p_state_digest text)
RETURNS TABLE(outcome text,shop_digest text,client_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE s morrow_identity.shopify_oauth_states%ROWTYPE; a morrow_identity.shopify_apps%ROWTYPE; v_at timestamptz;
BEGIN
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$' OR p_state_digest IS NULL OR p_state_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO a FROM morrow_identity.shopify_apps x WHERE x.app_key=p_app_key AND x.status='active';
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 SELECT * INTO s FROM morrow_identity.shopify_oauth_states x WHERE x.state_digest=p_state_digest AND x.app_key=p_app_key FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text; RETURN; END IF;
 IF s.claimed_at IS NOT NULL THEN RETURN QUERY SELECT 'replayed'::text,NULL::text,NULL::text; RETURN; END IF;
 v_at:=date_trunc('milliseconds',clock_timestamp());
 IF s.expires_at<=v_at OR s.created_at>v_at THEN RETURN QUERY SELECT 'expired'::text,NULL::text,NULL::text; RETURN; END IF;
 UPDATE morrow_identity.shopify_oauth_states x SET claimed_at=v_at WHERE x.id=s.id;
 RETURN QUERY SELECT 'claimed'::text,s.shop_digest,a.client_id;
END $$;
-- The common checks of prepare and record: the app is active, the shop is its intended
-- shop, and the state of this app and shop was claimed within 10 minutes and has led to no
-- install yet. Takes the per-shop install lock (across apps, so the one-live-installation
-- rule below is decided serially). Returns the app row, or NULL. INVOKER, granted to
-- nobody: only the two identity definers below call it, as the owner.
CREATE FUNCTION morrow_identity.shopify_install_state(p_app_key text,p_state_digest text,p_shop_id text,p_shop_domain text)
RETURNS morrow_identity.shopify_apps
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
DECLARE a morrow_identity.shopify_apps%ROWTYPE; s morrow_identity.shopify_oauth_states%ROWTYPE; v_digest text;
BEGIN
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$' OR p_state_digest IS NULL OR p_state_digest !~ '^[a-f0-9]{64}$'
  OR p_shop_id IS NULL OR p_shop_id !~ '^[1-9][0-9]{0,19}$'
  OR p_shop_domain IS NULL OR length(p_shop_domain)>255 OR p_shop_domain !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' THEN
  RETURN NULL;
 END IF;
 v_digest:=encode(sha256(convert_to(p_shop_domain,'UTF8')),'hex');
 SELECT * INTO a FROM morrow_identity.shopify_apps x WHERE x.app_key=p_app_key AND x.status='active';
 IF NOT FOUND OR a.intended_shop_digest<>v_digest THEN RETURN NULL; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.identity.shopify_install',p_shop_id)::text,0));
 SELECT * INTO s FROM morrow_identity.shopify_oauth_states x WHERE x.state_digest=p_state_digest AND x.app_key=p_app_key FOR UPDATE;
 IF NOT FOUND OR s.claimed_at IS NULL OR s.installation_id IS NOT NULL OR s.shop_digest<>v_digest
  OR s.claimed_at<=clock_timestamp()-interval '10 minutes' THEN RETURN NULL; END IF;
 RETURN a;
END $$;
-- Whether another app's installation that is not uninstalled holds this shop (by id or
-- domain). INVOKER, granted to nobody, called under the per-shop install lock.
CREATE FUNCTION morrow_identity.shopify_shop_held_elsewhere(p_app_key text,p_shop_id text,p_shop_domain text)
RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM morrow_identity.store_installations x WHERE x.app_key<>p_app_key
  AND x.status<>'uninstalled' AND (x.shop_id=p_shop_id OR x.shop_domain=p_shop_domain))
$$;
-- Before sealing: the ids the broker binds into the envelope's additional data. An
-- existing installation of this app and shop is re-authorised (the next credential
-- version of its one credential); otherwise every id is allocated here. An installation
-- that is suspended or uninstalled is ineligible (reinstall semantics are M2 PR-3), and so
-- is a shop that another app's installation (not uninstalled) holds.
-- Outcomes: install, reauthorise, state_invalid, ineligible.
CREATE FUNCTION morrow_identity.work_shopify_install_prepare(p_app_key text,p_state_digest text,p_shop_id text,p_shop_domain text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,installation_id text,store_id text,connection_id text,
 credential_id text,credential_version text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE a morrow_identity.shopify_apps%ROWTYPE; i morrow_identity.store_installations%ROWTYPE;
BEGIN
 a:=morrow_identity.shopify_install_state(p_app_key,p_state_digest,p_shop_id,p_shop_domain);
 IF a.app_key IS NULL THEN
  RETURN QUERY SELECT 'state_invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF morrow_identity.shopify_shop_held_elsewhere(p_app_key,p_shop_id,p_shop_domain) THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO i FROM morrow_identity.store_installations x WHERE x.app_key=p_app_key AND x.shop_id=p_shop_id FOR UPDATE;
 IF FOUND THEN
  IF i.status NOT IN ('unlinked','linked') OR i.shop_domain<>p_shop_domain
   OR i.organization_id<>a.invited_organization_id OR i.workspace_id<>a.invited_workspace_id THEN
   RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  RETURN QUERY SELECT 'reauthorise'::text,i.organization_id::text,i.workspace_id::text,i.id::text,i.store_id::text,
   i.connection_id::text,i.credential_id::text,(i.credential_version+1)::text;
  RETURN;
 END IF;
 RETURN QUERY SELECT 'install'::text,a.invited_organization_id::text,a.invited_workspace_id::text,gen_random_uuid()::text,
  gen_random_uuid()::text,gen_random_uuid()::text,gen_random_uuid()::text,'1'::text;
END $$;
-- The identity half of the broker's one install transaction (0027 shopify_install_store
-- writes the vault half in the same transaction, after this returns installed or
-- reauthorised). It rechecks everything prepare checked and that the ids are prepare's:
--   * a first install inserts the installation (unlinked), its shopify_oauth linking
--     candidate (eligible principal: the invited workspace's founding principal, whom the
--     P09.T02a issuer rebinds to the linking actor; a fresh proof, 10 minutes) and a
--     continuation;
--   * a re-authorisation records the new credential version and scopes; while the
--     installation is unlinked it also refreshes the candidate's proof, which invalidates
--     every handoff issued against the old one, and supersedes any open continuation with
--     a new one; a linked installation gets no continuation and no candidate change;
--   * the state is marked recorded, so it never leads to a second install.
-- Outcomes: installed, reauthorised, state_invalid, ineligible, invalid.
CREATE FUNCTION morrow_identity.work_shopify_install_record(p_app_key text,p_state_digest text,p_shop_id text,p_shop_domain text,
 p_scopes text,p_development_store text,p_installation_id text,p_store_id text,p_connection_id text,p_credential_id text,
 p_credential_version text,p_continuation_digest text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,continuation text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE a morrow_identity.shopify_apps%ROWTYPE; i morrow_identity.store_installations%ROWTYPE;
 c morrow_identity.linking_candidates%ROWTYPE; v_at timestamptz; v_founder text; v_scopes text[]; v_proof text;
 v_reauthorise boolean; v_continuation text:='none'; v_version bigint;
BEGIN
 IF p_scopes IS NULL OR p_scopes NOT IN ('read_products,write_products','read_products')
  OR p_development_store IS NULL OR p_development_store NOT IN ('true','false')
  OR p_installation_id IS NULL OR p_installation_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_connection_id IS NULL OR p_connection_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_credential_id IS NULL OR p_credential_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_credential_version IS NULL OR p_credential_version !~ '^[1-9][0-9]{0,15}$'
  OR p_continuation_digest IS NULL OR p_continuation_digest !~ '^[a-f0-9]{64}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_version:=p_credential_version::bigint;
 v_scopes:=string_to_array(p_scopes,',');
 a:=morrow_identity.shopify_install_state(p_app_key,p_state_digest,p_shop_id,p_shop_domain);
 IF a.app_key IS NULL THEN RETURN QUERY SELECT 'state_invalid'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 IF morrow_identity.shopify_shop_held_elsewhere(p_app_key,p_shop_id,p_shop_domain) THEN
  RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_at:=date_trunc('milliseconds',clock_timestamp());
 SELECT * INTO i FROM morrow_identity.store_installations x WHERE x.app_key=p_app_key AND x.shop_id=p_shop_id FOR UPDATE;
 v_reauthorise:=FOUND;
 IF v_reauthorise THEN
  IF i.status NOT IN ('unlinked','linked') OR i.shop_domain<>p_shop_domain OR i.id<>p_installation_id OR i.store_id<>p_store_id
   OR i.connection_id<>p_connection_id OR i.credential_id<>p_credential_id OR v_version<>i.credential_version+1
   OR i.organization_id<>a.invited_organization_id OR i.workspace_id<>a.invited_workspace_id THEN
   RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  UPDATE morrow_identity.store_installations x SET granted_scopes=v_scopes,development_store=p_development_store::boolean,
   credential_version=v_version,reauthorised_at=greatest(v_at,x.created_at),revision=x.revision+1,updated_at=greatest(v_at,x.updated_at)
   WHERE x.organization_id=i.organization_id AND x.workspace_id=i.workspace_id AND x.id=i.id RETURNING * INTO i;
  IF i.status='unlinked' THEN
   SELECT * INTO c FROM morrow_identity.linking_candidates x WHERE x.installation_id=i.id FOR UPDATE;
   IF NOT FOUND OR c.proof_kind<>'shopify_oauth' THEN RAISE EXCEPTION 'SHOPIFY_CANDIDATE_MISSING'; END IF;
   v_proof:=gen_random_uuid()::text;
   UPDATE morrow_identity.linking_candidates x SET proof_id=v_proof,proof_revision=x.proof_revision+1,
    proof_digest=encode(sha256(convert_to(jsonb_build_array('morrow.linking.shopify_oauth.proof',1,x.id::text,x.installation_id::text,
     x.shop_id,v_proof,x.proof_revision+1,x.eligible_principal_id::text)::text,'UTF8')),'hex'),
    proof_created_at=v_at,proof_expires_at=v_at+interval '10 minutes',proof_revoked_at=NULL
    WHERE x.id=c.id;
  END IF;
 ELSE
  IF v_version<>1 OR EXISTS(SELECT 1 FROM morrow_identity.store_installations x WHERE x.id=p_installation_id OR x.store_id=p_store_id
    OR x.connection_id=p_connection_id OR x.credential_id=p_credential_id) THEN
   RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN;
  END IF;
  SELECT s.principal_id::text INTO v_founder FROM morrow_identity.organization_signups s
   WHERE s.organization_id=a.invited_organization_id AND s.workspace_id=a.invited_workspace_id;
  IF v_founder IS NULL THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
  INSERT INTO morrow_identity.store_installations(organization_id,workspace_id,id,app_key,shop_id,shop_domain,store_id,connection_id,
   generation,status,granted_scopes,credential_id,credential_version,development_store,link_id,revision,created_at,updated_at,
   reauthorised_at,linked_at)
  VALUES (a.invited_organization_id,a.invited_workspace_id,p_installation_id,p_app_key,p_shop_id,p_shop_domain,p_store_id,
   p_connection_id,1,'unlinked',v_scopes,p_credential_id,1,p_development_store::boolean,NULL,1,v_at,v_at,NULL,NULL)
  RETURNING * INTO i;
  v_proof:=gen_random_uuid()::text;
  INSERT INTO morrow_identity.linking_candidates(id,provider_id,application_id,environment_id,shop_id,shop_domain,installation_id,
   generation,active,ownership_revision,proof_kind,proof_id,proof_revision,proof_digest,eligible_principal_id,proof_created_at,
   proof_expires_at,proof_revoked_at)
  VALUES (gen_random_uuid()::text,'shopify',a.client_id,a.environment_id,p_shop_id,p_shop_domain,i.id,1,true,1,'shopify_oauth',v_proof,1,
   encode(sha256(convert_to(jsonb_build_array('morrow.linking.shopify_oauth.proof',1,i.id::text,p_shop_id,v_proof,1,v_founder)::text,'UTF8')),'hex'),
   v_founder,v_at,v_at+interval '10 minutes',NULL);
 END IF;
 IF i.status='unlinked' THEN
  UPDATE morrow_identity.install_continuations x SET superseded_at=greatest(v_at,x.created_at)
   WHERE x.installation_id=i.id AND x.consumed_at IS NULL AND x.superseded_at IS NULL;
  INSERT INTO morrow_identity.install_continuations(organization_id,workspace_id,id,installation_id,token_digest,purpose,created_at,
   expires_at,consumed_at,consumed_principal_id,consumed_handoff_id,superseded_at)
  VALUES (i.organization_id,i.workspace_id,gen_random_uuid()::text,i.id,p_continuation_digest,'workspace_first',v_at,
   v_at+interval '5 minutes',NULL,NULL,NULL,NULL);
  v_continuation:='created';
 END IF;
 UPDATE morrow_identity.shopify_oauth_states x SET installation_id=i.id WHERE x.state_digest=p_state_digest AND x.app_key=p_app_key;
 RETURN QUERY SELECT CASE WHEN v_reauthorise THEN 'reauthorised' ELSE 'installed' END,i.organization_id::text,i.workspace_id::text,v_continuation;
END $$;
REVOKE ALL ON FUNCTION morrow_identity.work_shopify_launch(text,text),morrow_identity.work_shopify_state_claim(text,text),
 morrow_identity.shopify_install_state(text,text,text,text),morrow_identity.shopify_shop_held_elsewhere(text,text,text),morrow_identity.work_shopify_install_prepare(text,text,text,text),
 morrow_identity.work_shopify_install_record(text,text,text,text,text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_shopify_launch(text,text),morrow_identity.work_shopify_state_claim(text,text),
 morrow_identity.work_shopify_install_prepare(text,text,text,text),
 morrow_identity.work_shopify_install_record(text,text,text,text,text,text,text,text,text,text,text,text) TO morrow_work_command;

-- The shared store-installation read bridge (the M2 PR-2 interface of integration.json):
-- one workspace's installations, ids and states only, never a shop domain. A current
-- association is status linked with its link row. Callers pass the tenant from
-- current_tenant() or a lease row, never from a client. EXECUTE for morrow_work_command
-- only; identity-owned, so later identity-owner migrations (M2 PR-3: disconnect and
-- uninstall) can revise it. LANGUAGE sql BEGIN ATOMIC records the table dependencies.
CREATE FUNCTION morrow_identity.work_store_installations(p_org text,p_ws text)
RETURNS TABLE(installation_id text,store_id text,connection_id text,status text,linked_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp
BEGIN ATOMIC
 SELECT i.id::text,i.store_id::text,i.connection_id::text,i.status,i.linked_at
 FROM morrow_identity.store_installations i
 LEFT JOIN morrow_identity.workspace_store_links l ON l.id=i.link_id AND l.installation_id=i.id
  AND l.organization_id=i.organization_id AND l.workspace_id=i.workspace_id
 WHERE i.organization_id=p_org AND i.workspace_id=p_ws AND (i.status<>'linked' OR l.id IS NOT NULL)
 ORDER BY i.created_at,i.id;
END;
REVOKE ALL ON FUNCTION morrow_identity.work_store_installations(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.work_store_installations(text,text) TO morrow_work_command;

-- ---------------------------------------------------------------------------
-- The linking login's definers (P09.T02a). Each is guarded by executor_role_safe, the
-- ADR-0020 guard of the identity executors, and resolves the actor only from the session
-- digest through session_eligibility.
-- The actor and its current grants (at most 1001, by id) for the TypeScript kernel, with
-- the database clock. No row when the session is not eligible for the workspace.
CREATE FUNCTION morrow_identity.linking_actor_authority(p_session text,p_workspace text)
RETURNS TABLE(principal_id text,organization_id text,workspace_id text,membership_id text,policy_revision text,grants jsonb,
 grant_count integer,database_now_ms text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
BEGIN
 IF NOT morrow_identity.executor_role_safe('morrow_identity_linking') THEN RETURN; END IF;
 IF p_session IS NULL OR p_session !~ '^[a-f0-9]{64}$' OR p_workspace IS NULL OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 RETURN QUERY
 WITH e AS MATERIALIZED (SELECT x.principal_id,x.organization_id,x.workspace_id,x.membership_id,x.policy_revision
   FROM morrow_identity.session_eligibility(p_session,p_workspace) x WHERE x.workspace_id=p_workspace),
  g AS (SELECT gr.id::text AS id,gr.payload FROM morrow_identity.grants gr JOIN e ON gr.organization_id=e.organization_id
   AND gr.workspace_id=e.workspace_id AND gr.membership_id=e.membership_id AND gr.principal_id=e.principal_id
   ORDER BY gr.id::text COLLATE "C" LIMIT 1001),
  agg AS (SELECT COALESCE(jsonb_agg(g.payload ORDER BY g.id COLLATE "C"),'[]'::jsonb) AS grants,count(*)::integer AS n FROM g)
 SELECT e.principal_id,e.organization_id,e.workspace_id,e.membership_id,e.policy_revision::text,agg.grants,agg.n,
  floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text
 FROM e CROSS JOIN agg;
END $$;
-- The connections of one workspace for any session-eligible member: its installations as
-- StoreInstallation@1 objects (at most 51, oldest first; the caller refuses more than 50)
-- and the install-offer facts: whether an active app with an install link invites this
-- workspace and that link, the route (link_route_current), whether a store is linked, and
-- whether the reader is the organization's owner (its founding principal), the only actor
-- a Shopify link admits (ADR-0022 item 3). The offer itself also needs the TypeScript
-- kernel's connect/administer decision.
CREATE FUNCTION morrow_identity.workspace_connections(p_session text,p_workspace text)
RETURNS TABLE(installations jsonb,app_registered boolean,install_url text,route text,linked boolean,owner boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_identity,pg_temp AS $$
#variable_conflict use_column
DECLARE e record; v_url text; v_rows jsonb;
BEGIN
 IF NOT morrow_identity.executor_role_safe('morrow_identity_linking') THEN RETURN; END IF;
 IF p_session IS NULL OR p_session !~ '^[a-f0-9]{64}$' OR p_workspace IS NULL OR p_workspace !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 SELECT x.principal_id,x.organization_id,x.workspace_id INTO e FROM morrow_identity.session_eligibility(p_session,p_workspace) x WHERE x.workspace_id=p_workspace;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT a.install_url INTO v_url FROM morrow_identity.shopify_apps a
  WHERE a.invited_organization_id=e.organization_id AND a.invited_workspace_id=e.workspace_id AND a.status='active'
   AND a.install_url IS NOT NULL
  ORDER BY a.created_at,a.app_key LIMIT 1;
 SELECT COALESCE(jsonb_agg(r.o ORDER BY r.created_at,r.id),'[]'::jsonb) INTO v_rows FROM (
  SELECT i.created_at,i.id::text AS id,jsonb_build_object('schemaVersion',1,'id',i.id::text,'organizationId',i.organization_id::text,
   'workspaceId',i.workspace_id::text,'storeId',i.store_id::text,'revision',i.revision::bigint,
   'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'updatedAt',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'shopId',i.shop_id,'shopDomain',i.shop_domain,'connectionId',i.connection_id::text,'status',i.status,
   'owningWorkspaceId',CASE WHEN i.status='linked' THEN i.workspace_id::text ELSE NULL END,
   'grantedScopes',to_jsonb(i.granted_scopes),'providerCredentialVersion',i.credential_version::bigint,
   'providerCredentialRef',i.credential_id::text) AS o
  FROM morrow_identity.store_installations i WHERE i.organization_id=e.organization_id AND i.workspace_id=e.workspace_id
  ORDER BY i.created_at,i.id LIMIT 51) r;
 RETURN QUERY SELECT v_rows,v_url IS NOT NULL,v_url,morrow_billing.link_route_current(e.organization_id::text,e.workspace_id::text),
  EXISTS(SELECT 1 FROM morrow_identity.store_installations i WHERE i.organization_id=e.organization_id
   AND i.workspace_id=e.workspace_id AND i.status='linked'),
  EXISTS(SELECT 1 FROM morrow_identity.organization_signups s WHERE s.organization_id=e.organization_id
   AND s.principal_id=e.principal_id);
END $$;
-- The P09.T02a issuer, in the store-link preview: turns one install continuation into the
-- P05.T03a linking review and handoff, bound to the actor's session, the command
-- (Idempotency-Key) and the continuation digest (the handoff nonce). After the TypeScript
-- kernel allowed governance.connection.connect administer and picked p_grant, it rechecks
-- everything under locks (organization interlock, installation, candidate, continuation,
-- the session's eligibility chain and the grant): the continuation is open, unexpired and
-- for this workspace, which is the installation's tenant; the installation is unlinked, a
-- development store, and its app is active; the actor is the organization's owner (its
-- founding principal: the store-link template goes to the linking owner, ADR-0022 item 3);
-- the grant is current, the actor's own, connect/administer on the workspace resource with
-- the connect input fields. Only after the session, owner and grant pass does it read the
-- route, which must be morrow_direct. It then
-- rebinds the candidate's eligible principal to the actor with a fresh proof revision
-- (invalidating any earlier handoff), writes the review (evidence shopify_oauth) and the
-- 5-minute handoff, and consumes the continuation. A replay with the same session,
-- workspace, command and nonce answers exists. Outcomes: issued, exists, denied,
-- route_not_ready, not_found, invalid.
CREATE FUNCTION morrow_identity.issue_shopify_link_handoff(p_session text,p_workspace text,p_nonce text,p_command text,p_grant text)
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
 IF i.id IS NULL OR i.status<>'unlinked' OR NOT i.development_store
  OR NOT EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a WHERE a.app_key=i.app_key AND a.status='active'
   AND a.invited_organization_id=i.organization_id AND a.invited_workspace_id=i.workspace_id)
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
REVOKE ALL ON FUNCTION morrow_identity.linking_actor_authority(text,text),morrow_identity.workspace_connections(text,text),
 morrow_identity.issue_shopify_link_handoff(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_identity.linking_actor_authority(text,text),morrow_identity.workspace_connections(text,text),
 morrow_identity.issue_shopify_link_handoff(text,text,text,text,text) TO morrow_identity_linking;

-- ---------------------------------------------------------------------------
-- link_workspace_store: its 0014 definition (same signature, result, owner and ACL;
-- CREATE OR REPLACE keeps them; one inline ADR-0020 guard, so the census is unchanged)
-- with three additions:
--   * a shopify_oauth link locks its installation first (the install record's order:
--     installation, then candidate);
--   * the route must be fixed to morrow_direct (ADR-0022 item 5, every candidate kind):
--     else the result is billing_route_required; shopify_bound_at is never set;
--   * a shopify_oauth candidate needs the organization's owner (its founding principal) as
--     the actor (else actor_ineligible), and its installation unlinked, a development
--     store, the handoff's tenant and its app active (else installation_ineligible); when
--     applied, the installation becomes linked with the new link, and the linking owner
--     receives the store-link template's grants on the store resource, issued by the
--     service morrow.linking at the new policy revision. A denied link issues nothing.
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
   AND inst.status='unlinked' AND inst.link_id IS NULL AND inst.development_store
   AND EXISTS(SELECT 1 FROM morrow_identity.shopify_apps a WHERE a.app_key=inst.app_key AND a.status='active'
    AND a.invited_organization_id=inst.organization_id AND a.invited_workspace_id=inst.workspace_id));
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
