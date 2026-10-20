BEGIN;
-- M3 PR-1 listings authority and stops (ADR-0022 items 3, 9, 10, 15 and 16, with the item 3
-- amendment of 2026-10-20; mvp-architecture §5-§7, §9, §10; P05.T04b, P11.T05a and the
-- P13.T01a catalogue part). Executes AS morrow_work_owner, after the identity bridge. On the
-- ADR-0010 tenant pattern: composite tenant keys, ENABLE and FORCE RLS, definers owned by
-- morrow_work_command, INVOKER triggers and checks owned by the owner.
--   * Platform: agent_releases (the first-party release morrow.listings v1, seeded), and
--     model_catalogue_versions/model_catalogue_entries (catalogue version 1 of
--     docs/decisions/model-policy.json, seeded and drift-tested against the generated
--     catalogue) so SQL can refuse a default or reservation naming no entry.
--   * agent_installations, agent_enable_documents (the item 3 amendment's confirm
--     screen: a server-built installation document bound to the actor, the session, a
--     five-minute expiry and a single-use nonce), work_envelopes and delegation_hops
--     (written by run admission in M3 PR-2), kill_switch_records (KillSwitchRecord,
--     committed with its stop) and workspace_model_defaults (the default selection and the
--     member ceiling).
--   * Forward changes: stop_controls.kill_switch_record_id (a human stop names its record);
--     the commands and outbox CHECKs widened by the installation and model_default commands
--     and the kill_switch.executed event (each the union of every value at this head).
--   * Definers: the api's begin_agent_command, store_association,
--     cmd_listings_enable_document, cmd_listings_enable (create, or resume after the
--     owner's own "Stop AI work": only an installation that is exactly the confirmed
--     document, its release, store connection and grant set, and only the stop the
--     document named), cmd_stop_ai_work and cmd_model_default_revise; the
--     runtime's delegation_facts (the agent kernel's facts under a run lease); the broker's
--     morrow_vault.resolve_call (lease, generation, purpose, subject, member, stops,
--     installation, connection and credential, or one refusal code).
--   * Revisable owner helpers (INVOKER, EXECUTE for the command role only): the store
--     resolution over M2 PR-2's work_store_installations and the credential lookup over
--     M2's morrow_vault.credentials, so later owner migrations can revise them.
-- Every definer here is command-owned and final. No external effect: nothing here sends a
-- request, reserves money or dispatches; ListingsRunWorkflow stays dispatch_disabled.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR NOT morrow_identity.morrow_memberships_closed()
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL OR to_regprocedure('morrow_work.current_lease()') IS NULL
 OR to_regprocedure('morrow_work.stop_active(text,text,text,text,text)') IS NULL
 OR to_regprocedure('morrow_work.command_prelude(text,text)') IS NULL
 OR to_regprocedure('morrow_work.command_prelude_exclusive(text,text)') IS NULL
 OR to_regprocedure('morrow_work.append_event(text,text,text,text,text,text,text,bigint,text,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.record_command(text,text,text,text,text,text,text,text,bigint,jsonb,text,timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.db_now()') IS NULL OR to_regprocedure('morrow_work.utc_text(timestamp with time zone)') IS NULL
 OR to_regprocedure('morrow_work.utc_parse(text)') IS NULL OR to_regprocedure('morrow_work.sha256_text(text)') IS NULL
 OR to_regclass('morrow_vault.credentials') IS NULL OR to_regclass('morrow_work.agent_installations') IS NOT NULL
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_agent_principal_ensure(text,text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_agent_grants_issue(text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_owner_disable_grant_issue(text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_agent_grant_set_current(text,text,text,text,jsonb,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_column_privilege('morrow_work_owner','morrow_identity.agent_principals','installation_id','REFERENCES')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_delegation_actor_facts(text,text,jsonb)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_store_installations(text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_lease_member_current(text,text,text,text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 -- The shared CHECKs this file widens, exactly as the head defines them (shared protocol).
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_command_type_check')
  IS DISTINCT FROM 'CHECK ((command_type = ANY (ARRAY[''goal.create''::text, ''goal.transition''::text, ''task.create''::text, ''task.ready''::text, ''task.assign''::text, ''question.request''::text, ''question.answer''::text, ''question.cancel''::text, ''proposal.submit''::text, ''approval.decide''::text, ''approval.withdraw''::text])))'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.commands'::regclass AND c.conname='commands_check')
  IS DISTINCT FROM 'CHECK (((aggregate_type = ANY (ARRAY[''goal''::text, ''task''::text, ''question''::text, ''proposal''::text, ''approval''::text])) AND (aggregate_type = split_part(command_type, ''.''::text, 1))))'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.outbox_events'::regclass AND c.conname='outbox_events_event_type_check')
  IS DISTINCT FROM 'CHECK ((event_type = ANY (ARRAY[''goal.created''::text, ''goal.status_changed''::text, ''task.created''::text, ''task.status_changed''::text, ''task.assigned''::text, ''question.requested''::text, ''question.answered''::text, ''question.cancelled''::text, ''proposal.submitted''::text, ''proposal.derived''::text, ''approval.decided''::text, ''approval.status_changed''::text, ''approval.claimed''::text])))'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.outbox_events'::regclass AND c.conname='outbox_events_check')
  IS DISTINCT FROM 'CHECK (((aggregate_type = ANY (ARRAY[''goal''::text, ''task''::text, ''question''::text, ''proposal''::text, ''approval''::text])) AND (aggregate_type = split_part(event_type, ''.''::text, 1))))'
 OR (SELECT pg_catalog.pg_get_constraintdef(c.oid) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.outbox_events'::regclass AND c.conname='outbox_events_check1')
  IS DISTINCT FROM 'CHECK ((((aggregate_type = ''goal''::text) AND (task_id IS NULL)) OR ((aggregate_type = ''task''::text) AND ((task_id)::text = (aggregate_id)::text)) OR ((aggregate_type = ''question''::text) AND (task_id IS NOT NULL)) OR (aggregate_type = ANY (ARRAY[''proposal''::text, ''approval''::text]))))'
 OR (SELECT md5(pg_catalog.pg_get_constraintdef(c.oid)) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.outbox_events'::regclass AND c.conname='outbox_events_check3')
  IS DISTINCT FROM 'fe9e0ce69c83515fa1a7ce571acf657c'
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid='morrow_work.stop_controls'::regclass AND a.attname='kill_switch_record_id')
 THEN RAISE EXCEPTION 'LISTINGS_AUTHORITY_PREREQUISITES_INVALID'; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pure functions: IMMUTABLE, owned by the owner. CHECK constraints run with the writer's
-- privileges, so the command role holds EXECUTE (the 0015 valid_scope pattern).
-- The listing FieldPaths (ADR-0022 item 1), sorted as @morrow/policy listingFieldPaths.
CREATE FUNCTION morrow_work.listing_fields() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT '["descriptionHtml","seo.description","seo.title","tags","title"]'::jsonb
$$;
-- The store resource {kind store, id S, storeId S, connectionId C} (storeResource()).
CREATE FUNCTION morrow_work.store_resource(p_org text,p_ws text,p_store text,p_connection text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',p_store,'connectionId',p_connection,'kind','store','id',p_store)
$$;
-- The Listings installation's scope: exactly its store resource and the listing fields.
CREATE FUNCTION morrow_work.listings_scope(p_org text,p_ws text,p_store text,p_connection text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeIds',jsonb_build_array(p_store),'accountIds','[]'::jsonb,
  'resources',jsonb_build_array(morrow_work.store_resource(p_org,p_ws,p_store,p_connection)),'fields',morrow_work.listing_fields())
$$;
-- The owner's agents.installation.disable scope: the installation resource only.
CREATE FUNCTION morrow_work.installation_scope(p_org text,p_ws text,p_store text,p_connection text,p_installation text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeIds',jsonb_build_array(p_store),'accountIds','[]'::jsonb,
  'resources',jsonb_build_array(jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',p_store,'connectionId',p_connection,
   'kind','installation','id',p_installation)),'fields','["control","installationId"]'::jsonb)
$$;
-- The installation's three grants, in capability order (the document's `grants`).
CREATE FUNCTION morrow_work.listings_grant_set(p_org text,p_ws text,p_store text,p_connection text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_array(
  jsonb_build_object('capabilityId','catalog.content.propose','verbs','["execute"]'::jsonb,'scope',morrow_work.listings_scope(p_org,p_ws,p_store,p_connection)),
  jsonb_build_object('capabilityId','catalog.content.publish','verbs','["propose"]'::jsonb,'scope',morrow_work.listings_scope(p_org,p_ws,p_store,p_connection)),
  jsonb_build_object('capabilityId','catalog.products.read','verbs','["view"]'::jsonb,'scope',morrow_work.listings_scope(p_org,p_ws,p_store,p_connection)))
$$;
-- grant_refs: exactly three GrantRefs of this tenant and store, revision 1, distinct ids.
CREATE FUNCTION morrow_work.valid_grant_refs(p_refs jsonb,p_org text,p_ws text,p_store text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p_refs IS NULL OR jsonb_typeof(p_refs)<>'array' OR jsonb_array_length(p_refs)<>3 THEN false ELSE
  NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_refs) r WHERE NOT (jsonb_typeof(r)='object'
   AND r ?& ARRAY['organizationId','workspaceId','storeId','kind','id','revision','digest']
   AND (r-ARRAY['organizationId','workspaceId','storeId','kind','id','revision','digest'])='{}'::jsonb
   AND r->'organizationId'=to_jsonb(p_org) AND r->'workspaceId'=to_jsonb(p_ws) AND r->'storeId'=to_jsonb(p_store)
   AND r->'kind'='"grant"'::jsonb AND r->'revision'='1'::jsonb
   AND jsonb_typeof(r->'id')='string' AND (r->>'id') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   AND jsonb_typeof(r->'digest')='string' AND (r->>'digest') ~ '^[a-f0-9]{64}$'))
  AND (SELECT count(DISTINCT r->>'id') FROM jsonb_array_elements(p_refs) r)=3 END
$$;
-- The item 3 amendment's installation document, exactly as cmd_listings_enable_document
-- derives it: release, store resource, installation, the exact grant set, the owner's
-- disable grant, the actor and the five-minute window. The canonical text is the Worker's
-- RFC 8785 output; this proves it parses to exactly the row.
CREATE FUNCTION morrow_work.enable_document_matches(p_canonical text,p_org text,p_ws text,p_id text,p_store text,p_connection text,
 p_installation text,p_purpose text,p_release_id text,p_release_revision bigint,p_release_digest text,p_actor_principal text,
 p_actor_membership text,p_created_at timestamptz,p_expires_at timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF p_canonical IS NULL OR NOT pg_input_is_valid(p_canonical,'jsonb') THEN RETURN false; END IF;
 RETURN p_canonical::jsonb=jsonb_build_object('schemaVersion',1,'kind','morrow.agent_installation_document','id',p_id,'purpose',p_purpose,
  'organizationId',p_org,'workspaceId',p_ws,'store',morrow_work.store_resource(p_org,p_ws,p_store,p_connection),'installationId',p_installation,
  'release',jsonb_build_object('id',p_release_id,'revision',p_release_revision,'digest',p_release_digest),
  'grants',morrow_work.listings_grant_set(p_org,p_ws,p_store,p_connection),
  'ownerGrant',jsonb_build_object('capabilityId','agents.installation.disable','verbs','["execute"]'::jsonb,
   'scope',morrow_work.installation_scope(p_org,p_ws,p_store,p_connection,p_installation)),
  'actor',jsonb_build_object('principalId',p_actor_principal,'membershipId',p_actor_membership),
  'createdAt',morrow_work.utc_text(p_created_at),'expiresAt',morrow_work.utc_text(p_expires_at)) IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- KillSwitchRecord (core v1.1) of "Stop AI work", exactly as the row: the installation
-- target on its store and connection, the human actor, a control whose reason is the stop's
-- reason and whose sourceProposalRef is null (no agent proposal path in the MVP).
CREATE FUNCTION morrow_work.kill_switch_record_matches(p_canonical text,p_org text,p_ws text,p_id text,p_store text,p_connection text,
 p_capability text,p_target_kind text,p_target text,p_actor_principal text,p_actor_membership text,p_command_id text,p_request_digest text,
 p_prior text,p_created_at timestamptz) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE d jsonb;
BEGIN
 IF p_canonical IS NULL OR NOT pg_input_is_valid(p_canonical,'jsonb') OR p_capability IS DISTINCT FROM 'agents.installation.disable'
  OR p_target_kind IS DISTINCT FROM 'installation' THEN RETURN false; END IF;
 d:=p_canonical::jsonb;
 IF jsonb_typeof(d)<>'object' OR jsonb_typeof(d->'control')<>'object' OR NOT ((d->'control') ?& ARRAY['reason','sourceProposalRef'])
  OR ((d->'control')-ARRAY['reason','sourceProposalRef'])<>'{}'::jsonb OR d#>'{control,sourceProposalRef}'<>'null'::jsonb
  OR jsonb_typeof(d#>'{control,reason}')<>'string' OR char_length(d#>>'{control,reason}') NOT BETWEEN 1 AND 1024
  OR (d#>>'{control,reason}') !~ '\S' THEN RETURN false; END IF;
 RETURN d=jsonb_build_object('schemaVersion',1,'id',p_id,'organizationId',p_org,'workspaceId',p_ws,'storeId',p_store,'revision',1,
  'createdAt',morrow_work.utc_text(p_created_at),'capabilityId',p_capability,
  'actor',jsonb_build_object('kind','human','principalId',p_actor_principal,'organizationId',p_org,'workspaceId',p_ws,
   'membershipId',p_actor_membership,'installationId',NULL,'mandateId',NULL),
  'control',d->'control',
  'targets',jsonb_build_array(jsonb_build_object('organizationId',p_org,'workspaceId',p_ws,'storeId',p_store,'connectionId',p_connection,
   'kind',p_target_kind,'id',p_target)),
  'commandId',p_command_id,'requestDigest',p_request_digest,'priorStateObserved',p_prior) IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
-- The release manifest digest of the first-party Listings specialist.
CREATE FUNCTION morrow_work.release_manifest_valid(p_manifest text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p_manifest IS NULL OR octet_length(p_manifest)>16384 OR NOT pg_input_is_valid(p_manifest,'jsonb') THEN false
  ELSE jsonb_typeof(p_manifest::jsonb)='object' END
$$;

-- ---------------------------------------------------------------------------
-- Platform tables.
-- Published agent releases (P05.T04b minimum): the immutable manifest and its digest. A
-- release is revoked by a later owner migration (agents.release.revoke lands later).
CREATE TABLE morrow_work.agent_releases (
 id text NOT NULL CHECK (id ~ '^[a-z][a-z0-9_.]{2,63}$'),
 revision morrow_work.revision NOT NULL,
 status text NOT NULL CHECK (status IN ('published','revoked')),
 manifest text NOT NULL CHECK (morrow_work.release_manifest_valid(manifest)),
 digest morrow_work.digest NOT NULL,
 published_at timestamptz NOT NULL CHECK (published_at=date_trunc('milliseconds',published_at) AND isfinite(published_at)),
 PRIMARY KEY (id,revision),
 UNIQUE (id,revision,digest),
 CONSTRAINT agent_releases_digest CHECK (digest::text=morrow_work.sha256_text(manifest))
);
INSERT INTO morrow_work.agent_releases(id,revision,status,manifest,digest,published_at)
SELECT 'morrow.listings',1,'published',m,morrow_work.sha256_text(m),timestamptz '2026-10-20T00:00:00Z'
FROM (VALUES ('{"capabilities":{"catalog.content.propose":["execute"],"catalog.content.publish":["propose"],"catalog.products.read":["view"]},"fields":["descriptionHtml","seo.description","seo.title","tags","title"],"id":"morrow.listings","kind":"specialist","revision":1}')) v(m);
-- The model catalogue in SQL (ADR-0022 item 16): every published version's caps and entries,
-- exactly as scripts/generate-model-catalogue.mjs computes them (drift-tested). Money is
-- numeric(20,8) USD. A new version is a new forward migration.
CREATE TABLE morrow_work.model_catalogue_versions (
 version integer NOT NULL PRIMARY KEY CHECK (version BETWEEN 1 AND 999),
 status text NOT NULL CHECK (status IN ('active','retired')),
 digest morrow_work.digest NOT NULL,
 default_model text NOT NULL CHECK (default_model ~ '^[a-z][a-z0-9_]{0,39}$'),
 default_effort text NOT NULL CHECK (default_effort ~ '^[a-z][a-z0-9_]{0,39}$'),
 default_member_credit_ceiling integer NOT NULL CHECK (default_member_credit_ceiling BETWEEN 1 AND 99),
 max_products_per_run integer NOT NULL CHECK (max_products_per_run BETWEEN 1 AND 1000),
 run_cost_cap_usd numeric(20,8) NOT NULL CHECK (run_cost_cap_usd>0),
 workspace_daily_cost_cap_usd numeric(20,8) NOT NULL CHECK (workspace_daily_cost_cap_usd>0),
 workspace_period_unrecovered_cost_cap_usd numeric(20,8) NOT NULL CHECK (workspace_period_unrecovered_cost_cap_usd>0)
);
CREATE UNIQUE INDEX model_catalogue_versions_one_active ON morrow_work.model_catalogue_versions (status) WHERE status='active';
CREATE TABLE morrow_work.model_catalogue_entries (
 version integer NOT NULL REFERENCES morrow_work.model_catalogue_versions(version),
 model_key text NOT NULL CHECK (model_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 effort_key text NOT NULL CHECK (effort_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 credits_per_product integer NOT NULL CHECK (credits_per_product BETWEEN 1 AND 99),
 worst_case_per_product_usd numeric(20,8) NOT NULL CHECK (worst_case_per_product_usd>0),
 worst_case_per_attempt_usd numeric(20,8) NOT NULL CHECK (worst_case_per_attempt_usd>0),
 run_product_limit integer NOT NULL CHECK (run_product_limit BETWEEN 1 AND 1000),
 PRIMARY KEY (version,model_key,effort_key)
);
INSERT INTO morrow_work.model_catalogue_versions(version,status,digest,default_model,default_effort,default_member_credit_ceiling,
 max_products_per_run,run_cost_cap_usd,workspace_daily_cost_cap_usd,workspace_period_unrecovered_cost_cap_usd)
VALUES (1,'active','fca7f9ac7151f67818e5fa242f5e9bca8e6c36246738e78d0ffbd55c39aed660','claude_sonnet_5_5','low',1,25,7.00000000,25.00000000,4.50000000);
INSERT INTO morrow_work.model_catalogue_entries(version,model_key,effort_key,credits_per_product,worst_case_per_product_usd,
 worst_case_per_attempt_usd,run_product_limit) VALUES
 (1,'claude_haiku_5_5','low',1,0.00660000,0.00330000,25),
 (1,'claude_haiku_5_5','medium',1,0.01360000,0.00680000,25),
 (1,'claude_haiku_5_5','high',1,0.01760000,0.00880000,25),
 (1,'claude_sonnet_5_5','low',1,0.13200000,0.06600000,25),
 (1,'claude_sonnet_5_5','medium',2,0.27200000,0.13600000,25),
 (1,'claude_sonnet_5_5','high',3,0.35200000,0.17600000,19),
 (1,'claude_opus_5_5','low',2,0.26400000,0.13200000,25),
 (1,'claude_opus_5_5','medium',4,0.54400000,0.27200000,12),
 (1,'claude_opus_5_5','high',6,0.70400000,0.35200000,9);

-- ---------------------------------------------------------------------------
-- Tenant tables. Every stored time is millisecond-truncated.
-- One agent installation (AgentInstallation v1.1): a release pinned by digest, bound to one
-- store and connection, its agent principal, its owner (the human who enabled it), and its
-- three grants by GrantRef. Only "Enable Listings agent" creates one; "Stop AI work"
-- disables it and the owner's resume reactivates it.
CREATE TABLE morrow_work.agent_installations (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 release_id text NOT NULL,
 release_revision morrow_work.revision NOT NULL,
 release_digest morrow_work.digest NOT NULL,
 store_id morrow_work.record_id NOT NULL,
 connection_id morrow_work.record_id NOT NULL,
 agent_principal_id morrow_work.record_id NOT NULL,
 owner_principal_id morrow_work.record_id NOT NULL,
 owner_membership_id morrow_work.record_id NOT NULL,
 status text NOT NULL CHECK (status IN ('active','disabled','uninstalled')),
 scope jsonb NOT NULL,
 grant_refs jsonb NOT NULL,
 configuration_digest morrow_work.digest NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,agent_principal_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (release_id,release_revision,release_digest) REFERENCES morrow_work.agent_releases(id,revision,digest),
 FOREIGN KEY (organization_id,owner_membership_id,owner_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,owner_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 -- The installation's agent principal is its own (the identity bridge's installation role).
 FOREIGN KEY (organization_id,workspace_id,agent_principal_id,id)
  REFERENCES morrow_identity.agent_principals(organization_id,workspace_id,principal_id,installation_id),
 CONSTRAINT agent_installations_scope CHECK (scope=morrow_work.listings_scope(organization_id,workspace_id,store_id,connection_id)),
 CONSTRAINT agent_installations_grant_refs CHECK (morrow_work.valid_grant_refs(grant_refs,organization_id,workspace_id,store_id)),
 CONSTRAINT agent_installations_times CHECK (updated_at>=created_at)
);
CREATE UNIQUE INDEX agent_installations_one_per_store ON morrow_work.agent_installations (organization_id,workspace_id,store_id,release_id)
 WHERE status<>'uninstalled';
-- The item 3 amendment's confirm screen: one server-built installation document, bound to
-- the actor and the session, valid for five minutes, consumed once with its nonce.
CREATE TABLE morrow_work.agent_enable_documents (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 purpose text NOT NULL CHECK (purpose IN ('enable','resume')),
 store_id morrow_work.record_id NOT NULL,
 connection_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id NOT NULL,
 release_id text NOT NULL,
 release_revision morrow_work.revision NOT NULL,
 release_digest morrow_work.digest NOT NULL,
 actor_principal_id morrow_work.record_id NOT NULL,
 actor_membership_id morrow_work.record_id NOT NULL,
 session_digest morrow_work.digest NOT NULL,
 nonce_digest morrow_work.digest NOT NULL,
 canonical text NOT NULL CHECK (octet_length(canonical)<=16384),
 digest morrow_work.digest NOT NULL,
 command_id morrow_work.record_id NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz CHECK (consumed_at=date_trunc('milliseconds',consumed_at) AND isfinite(consumed_at)),
 consumed_command_id morrow_work.record_id,
 -- A resume document names the one stop it lifts: the person's installation stop open
 -- when the document was built. A later stop needs a later document.
 stop_id morrow_work.record_id,
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,digest),
 UNIQUE (nonce_digest),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (release_id,release_revision,release_digest) REFERENCES morrow_work.agent_releases(id,revision,digest),
 FOREIGN KEY (organization_id,actor_membership_id,actor_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 FOREIGN KEY (organization_id,workspace_id,stop_id) REFERENCES morrow_work.stop_controls(organization_id,workspace_id,id),
 CONSTRAINT agent_enable_documents_stop CHECK ((purpose='resume')=(stop_id IS NOT NULL)),
 CONSTRAINT agent_enable_documents_window CHECK (expires_at=created_at+interval '5 minutes'),
 CONSTRAINT agent_enable_documents_consumed CHECK ((consumed_at IS NULL)=(consumed_command_id IS NULL)
  AND (consumed_at IS NULL OR consumed_at>=created_at)),
 CONSTRAINT agent_enable_documents_digest CHECK (digest::text=morrow_work.sha256_text(canonical)),
 CONSTRAINT agent_enable_documents_document CHECK (morrow_work.enable_document_matches(canonical,organization_id,workspace_id,id,store_id,
  connection_id,installation_id,purpose,release_id,release_revision,release_digest,actor_principal_id,actor_membership_id,created_at,expires_at))
);
CREATE INDEX agent_enable_documents_open ON morrow_work.agent_enable_documents (organization_id,workspace_id,actor_principal_id,store_id,expires_at)
 WHERE consumed_at IS NULL;
-- PrincipalWorkEnvelope (agent-authority.md): the requester's bounded mandate on one task,
-- written by run admission (M3 PR-2). Its requester is its authorizer (a human member).
CREATE TABLE morrow_work.work_envelopes (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL CHECK (revision=1),
 task_id morrow_work.record_id NOT NULL,
 task_revision morrow_work.revision NOT NULL,
 requester_principal_id morrow_work.record_id NOT NULL,
 requester_membership_id morrow_work.record_id NOT NULL,
 store_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id NOT NULL,
 capability_ids text[] NOT NULL CHECK (cardinality(capability_ids) BETWEEN 1 AND 16),
 verbs text[] NOT NULL CHECK (cardinality(verbs) BETWEEN 1 AND 6 AND verbs<@ARRAY['view','propose','approve','execute','delegate','administer']),
 scope jsonb NOT NULL CHECK (jsonb_typeof(scope)='object' AND pg_column_size(scope)<=16384),
 valid_from timestamptz NOT NULL CHECK (valid_from=date_trunc('milliseconds',valid_from) AND isfinite(valid_from)),
 expires_at timestamptz NOT NULL CHECK (expires_at=date_trunc('milliseconds',expires_at) AND isfinite(expires_at)),
 revoked_at timestamptz CHECK (revoked_at=date_trunc('milliseconds',revoked_at) AND isfinite(revoked_at)),
 maximum_depth integer NOT NULL CHECK (maximum_depth BETWEEN 0 AND 8),
 maximum_children integer NOT NULL CHECK (maximum_children BETWEEN 0 AND 32),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,task_id) REFERENCES morrow_work.tasks(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,requester_membership_id,requester_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,requester_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT work_envelopes_window CHECK (expires_at>valid_from AND expires_at<=valid_from+interval '24 hours'
  AND (revoked_at IS NULL OR revoked_at>=created_at))
);
-- DelegationHop (agent-authority.md): one dispatch from a parent task's envelope to a child
-- task's recipient. The hop carries the child envelope's id and revision as its own bounds.
CREATE TABLE morrow_work.delegation_hops (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL CHECK (revision=1),
 parent_task_id morrow_work.record_id NOT NULL,
 parent_task_revision morrow_work.revision NOT NULL,
 child_task_id morrow_work.record_id NOT NULL,
 child_task_revision morrow_work.revision NOT NULL,
 parent_envelope_id morrow_work.record_id NOT NULL,
 parent_envelope_revision morrow_work.revision NOT NULL,
 child_envelope_id morrow_work.record_id NOT NULL,
 child_envelope_revision morrow_work.revision NOT NULL,
 dispatcher_kind text NOT NULL CHECK (dispatcher_kind IN ('builtin_coordinator','installed_agent')),
 dispatcher_principal_id morrow_work.record_id NOT NULL,
 dispatcher_installation_id morrow_work.record_id,
 recipient_principal_id morrow_work.record_id NOT NULL,
 recipient_installation_id morrow_work.record_id NOT NULL,
 capability_ids text[] NOT NULL CHECK (cardinality(capability_ids) BETWEEN 1 AND 16),
 verbs text[] NOT NULL CHECK (cardinality(verbs) BETWEEN 1 AND 6 AND verbs<@ARRAY['view','propose','approve','execute','delegate','administer']),
 scope jsonb NOT NULL CHECK (jsonb_typeof(scope)='object' AND pg_column_size(scope)<=16384),
 valid_from timestamptz NOT NULL CHECK (valid_from=date_trunc('milliseconds',valid_from) AND isfinite(valid_from)),
 expires_at timestamptz NOT NULL CHECK (expires_at=date_trunc('milliseconds',expires_at) AND isfinite(expires_at)),
 revoked_at timestamptz CHECK (revoked_at=date_trunc('milliseconds',revoked_at) AND isfinite(revoked_at)),
 parent_child_count integer NOT NULL CHECK (parent_child_count BETWEEN 0 AND 32),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,child_envelope_id),
 FOREIGN KEY (organization_id,workspace_id,parent_task_id) REFERENCES morrow_work.tasks(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,child_task_id) REFERENCES morrow_work.tasks(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,parent_envelope_id) REFERENCES morrow_work.work_envelopes(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,recipient_installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,dispatcher_installation_id) REFERENCES morrow_work.agent_installations(organization_id,workspace_id,id),
 -- The recipient, and an installed dispatcher, are named with their own agent principals
 -- (a Coordinator dispatcher has no installation, so its key is not checked here).
 FOREIGN KEY (organization_id,workspace_id,recipient_principal_id,recipient_installation_id)
  REFERENCES morrow_identity.agent_principals(organization_id,workspace_id,principal_id,installation_id),
 FOREIGN KEY (organization_id,workspace_id,dispatcher_principal_id,dispatcher_installation_id)
  REFERENCES morrow_identity.agent_principals(organization_id,workspace_id,principal_id,installation_id),
 CONSTRAINT delegation_hops_dispatcher CHECK ((dispatcher_kind='installed_agent')=(dispatcher_installation_id IS NOT NULL)),
 CONSTRAINT delegation_hops_window CHECK (expires_at>valid_from AND expires_at<=valid_from+interval '24 hours'
  AND (revoked_at IS NULL OR revoked_at>=created_at) AND child_task_id::text<>parent_task_id::text)
);
CREATE INDEX delegation_hops_parent ON morrow_work.delegation_hops (organization_id,workspace_id,parent_envelope_id);
-- KillSwitchRecord (ADR-0005; core v1.1), committed with its stop. It holds the owner's
-- reason, so its content class is workspace. M2 PR-3's disconnect reuses it (revising the
-- owner-owned kill_switch_record_matches and the capability CHECK).
CREATE TABLE morrow_work.kill_switch_records (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 store_id morrow_work.record_id NOT NULL,
 connection_id morrow_work.record_id NOT NULL,
 capability_id text NOT NULL CHECK (capability_id IN ('agents.installation.disable')),
 target_kind text NOT NULL CHECK (target_kind IN ('installation')),
 target_id morrow_work.record_id NOT NULL,
 actor_principal_id morrow_work.record_id NOT NULL,
 actor_membership_id morrow_work.record_id NOT NULL,
 canonical text NOT NULL CHECK (octet_length(canonical)<=16384),
 digest morrow_work.digest NOT NULL,
 command_id morrow_work.record_id NOT NULL,
 request_digest morrow_work.digest NOT NULL,
 prior_state_observed text NOT NULL CHECK (prior_state_observed IN ('active','already_stopped')),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,actor_membership_id,actor_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT kill_switch_records_digest CHECK (digest::text=morrow_work.sha256_text(canonical)),
 CONSTRAINT kill_switch_records_document CHECK (morrow_work.kill_switch_record_matches(canonical,organization_id,workspace_id,id,store_id,
  connection_id,capability_id,target_kind,target_id,actor_principal_id,actor_membership_id,command_id,request_digest,prior_state_observed,created_at))
);
CREATE INDEX kill_switch_records_target ON morrow_work.kill_switch_records (organization_id,workspace_id,target_kind,target_id,created_at);
-- The workspace's default model selection and member ceiling (ADR-0022 item 16). A missing
-- row is the active catalogue's default and ceiling.
CREATE TABLE morrow_work.workspace_model_defaults (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 catalogue_version integer NOT NULL,
 model_key text NOT NULL CHECK (model_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 effort_key text NOT NULL CHECK (effort_key ~ '^[a-z][a-z0-9_]{0,39}$'),
 max_credits_per_product integer NOT NULL CHECK (max_credits_per_product BETWEEN 1 AND 99),
 revision morrow_work.revision NOT NULL,
 updated_by_principal_id morrow_work.record_id NOT NULL,
 updated_by_membership_id morrow_work.record_id NOT NULL,
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND updated_at>=timestamptz '2000-01-01T00:00:00Z' AND updated_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (catalogue_version,model_key,effort_key) REFERENCES morrow_work.model_catalogue_entries(version,model_key,effort_key),
 FOREIGN KEY (organization_id,updated_by_membership_id,updated_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,updated_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id)
);

-- Forward changes on the M2 PR-1 and P06 tables.
ALTER TABLE morrow_work.stop_controls ADD COLUMN kill_switch_record_id morrow_work.record_id,
 ADD CONSTRAINT stop_controls_kill_switch_record FOREIGN KEY (organization_id,workspace_id,kill_switch_record_id)
  REFERENCES morrow_work.kill_switch_records(organization_id,workspace_id,id),
 ADD CONSTRAINT stop_controls_human_record CHECK ((set_by_kind='human')=(kill_switch_record_id IS NOT NULL));
ALTER TABLE morrow_work.commands DROP CONSTRAINT commands_command_type_check, DROP CONSTRAINT commands_check,
 ADD CONSTRAINT commands_command_type_check CHECK (command_type IN ('goal.create','goal.transition','task.create','task.ready','task.assign',
  'question.request','question.answer','question.cancel','proposal.submit','approval.decide','approval.withdraw',
  'installation.document','installation.enable','installation.stop','model_default.revise')),
 ADD CONSTRAINT commands_check CHECK (aggregate_type IN ('goal','task','question','proposal','approval','installation','model_default')
  AND aggregate_type=split_part(command_type,'.',1));
ALTER TABLE morrow_work.outbox_events DROP CONSTRAINT outbox_events_event_type_check, DROP CONSTRAINT outbox_events_check,
 DROP CONSTRAINT outbox_events_check1, DROP CONSTRAINT outbox_events_check3,
 ADD CONSTRAINT outbox_events_event_type_check CHECK (event_type IN ('goal.created','goal.status_changed','task.created','task.status_changed','task.assigned',
  'question.requested','question.answered','question.cancelled','proposal.submitted','proposal.derived','approval.decided','approval.status_changed',
  'approval.claimed','kill_switch.executed')),
 ADD CONSTRAINT outbox_events_check CHECK (aggregate_type IN ('goal','task','question','proposal','approval','kill_switch')
  AND aggregate_type=split_part(event_type,'.',1)),
 ADD CONSTRAINT outbox_events_check1 CHECK ((aggregate_type='goal' AND task_id IS NULL) OR (aggregate_type='task' AND task_id=aggregate_id)
  OR (aggregate_type='question' AND task_id IS NOT NULL) OR aggregate_type IN ('proposal','approval') OR (aggregate_type='kill_switch' AND task_id IS NULL)),
 ADD CONSTRAINT outbox_events_check3 CHECK (CASE WHEN jsonb_typeof(payload)<>'object' THEN false
  WHEN event_type='goal.created' THEN payload ? 'status' AND payload-'status'='{}'::jsonb AND jsonb_typeof(payload->'status')='string'
  WHEN event_type IN ('goal.status_changed','task.status_changed') THEN payload ?& ARRAY['from','to'] AND payload-ARRAY['from','to']='{}'::jsonb
   AND jsonb_typeof(payload->'from')='string' AND jsonb_typeof(payload->'to')='string'
  WHEN event_type='task.created' THEN payload ?& ARRAY['goalId','status'] AND payload-ARRAY['goalId','status']='{}'::jsonb
   AND jsonb_typeof(payload->'goalId')='string' AND jsonb_typeof(payload->'status')='string'
  WHEN event_type='task.assigned' THEN payload ?& ARRAY['assignmentId','ownerPrincipalId'] AND payload-ARRAY['assignmentId','ownerPrincipalId']='{}'::jsonb
   AND jsonb_typeof(payload->'assignmentId')='string' AND jsonb_typeof(payload->'ownerPrincipalId')='string'
  WHEN event_type='question.requested' THEN payload ? 'respondentPrincipalId' AND payload-'respondentPrincipalId'='{}'::jsonb
   AND jsonb_typeof(payload->'respondentPrincipalId')='string'
  WHEN event_type='question.answered' THEN payload ? 'answerId' AND payload-'answerId'='{}'::jsonb AND jsonb_typeof(payload->'answerId')='string'
  WHEN event_type='question.cancelled' THEN payload='{}'::jsonb
  WHEN event_type='proposal.submitted' THEN payload ?& ARRAY['approvalId','risk','targetCount'] AND payload-ARRAY['approvalId','risk','targetCount']='{}'::jsonb
   AND jsonb_typeof(payload->'approvalId')='string' AND jsonb_typeof(payload->'risk')='string' AND jsonb_typeof(payload->'targetCount')='number'
  WHEN event_type='proposal.derived' THEN payload ? 'parentId' AND payload-'parentId'='{}'::jsonb AND jsonb_typeof(payload->'parentId')='string'
  WHEN event_type='approval.decided' THEN payload ?& ARRAY['decision','status'] AND payload-ARRAY['decision','status']='{}'::jsonb
   AND jsonb_typeof(payload->'decision')='string' AND jsonb_typeof(payload->'status')='string'
  WHEN event_type='approval.status_changed' THEN payload ?& ARRAY['from','to','reason'] AND payload-ARRAY['from','to','reason']='{}'::jsonb
   AND jsonb_typeof(payload->'from')='string' AND jsonb_typeof(payload->'to')='string' AND jsonb_typeof(payload->'reason')='string'
   AND (payload->>'reason') IN ('quorum_met','solo_owner_confirmed','rejected','cancelled_before_effective','withdrawn','superseded_by_partial_approval','family_closed')
  WHEN event_type='approval.claimed' THEN payload ? 'consumer' AND payload-'consumer'='{}'::jsonb AND jsonb_typeof(payload->'consumer')='string'
  WHEN event_type='kill_switch.executed' THEN payload ?& ARRAY['capabilityId','sourceProposalId'] AND payload-ARRAY['capabilityId','sourceProposalId']='{}'::jsonb
   AND (payload->>'capabilityId') IN ('ads.campaign.pause','agents.installation.disable','governance.membership.revoke','governance.connection.disconnect','agents.release.revoke')
   AND (payload->'sourceProposalId'='null'::jsonb OR (jsonb_typeof(payload->'sourceProposalId')='string'
    AND (payload->>'sourceProposalId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'))
  ELSE false END);

-- ---------------------------------------------------------------------------
-- Row security. Every table: ENABLE + FORCE and the maintenance-only owner policy.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['agent_releases','model_catalogue_versions','model_catalogue_entries','agent_installations','agent_enable_documents',
  'work_envelopes','delegation_hops','kill_switch_records','workspace_model_defaults'] LOOP
  EXECUTE format('ALTER TABLE morrow_work.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE morrow_work.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON morrow_work.%I TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON morrow_work.%I FROM PUBLIC',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['agent_releases','model_catalogue_versions','model_catalogue_entries'] LOOP
  EXECUTE format('CREATE POLICY platform_command_read ON morrow_work.%I FOR SELECT TO morrow_work_command USING (true)',t);
  EXECUTE format('GRANT SELECT ON morrow_work.%I TO morrow_work_command',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['agent_installations','agent_enable_documents','work_envelopes','delegation_hops','kill_switch_records','workspace_model_defaults'] LOOP
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('GRANT SELECT,INSERT ON morrow_work.%I TO morrow_work_command',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['agent_installations','kill_switch_records','workspace_model_defaults'] LOOP
  EXECUTE format('CREATE POLICY tenant_read ON morrow_work.%I FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
 -- The lease-context twin for the runtime's delegation_facts (spine §5).
 FOREACH t IN ARRAY ARRAY['agent_installations','work_envelopes','delegation_hops'] LOOP
  EXECUTE format('CREATE POLICY tenant_lease ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
 END LOOP;
END $$;
-- The broker's resolve_call (morrow_vault, below) reads exactly the lease it names, that
-- lease's tenant's stops (and the platform's) and that lease's installation, through
-- transaction-local settings it writes itself before reading and clears after; only while
-- the session user is the broker's login. No other definer the broker may execute reads
-- these tables, so a setting the login forges reaches nothing.
CREATE POLICY lease_broker_resolve ON morrow_work.work_leases FOR SELECT TO morrow_work_command
 USING (session_user='morrow_vault_broker' AND id::text=pg_catalog.current_setting('morrow.vault_resolve_lease',true));
CREATE POLICY stop_broker_resolve ON morrow_work.stop_controls FOR SELECT TO morrow_work_command
 USING (session_user='morrow_vault_broker' AND (organization_id IS NULL
  OR organization_id::text||'|'||workspace_id::text=pg_catalog.current_setting('morrow.vault_resolve_tenant',true)));
CREATE POLICY installation_broker_resolve ON morrow_work.agent_installations FOR SELECT TO morrow_work_command
 USING (session_user='morrow_vault_broker'
  AND organization_id::text||'|'||workspace_id::text||'|'||id::text=pg_catalog.current_setting('morrow.vault_resolve_installation',true));

GRANT UPDATE (status,revision,updated_at) ON morrow_work.agent_installations TO morrow_work_command;
GRANT UPDATE (consumed_at,consumed_command_id) ON morrow_work.agent_enable_documents TO morrow_work_command;
GRANT UPDATE (revoked_at) ON morrow_work.work_envelopes TO morrow_work_command;
GRANT UPDATE (revoked_at) ON morrow_work.delegation_hops TO morrow_work_command;
GRANT UPDATE (catalogue_version,model_key,effort_key,max_credits_per_product,revision,updated_by_principal_id,updated_by_membership_id,updated_at)
 ON morrow_work.workspace_model_defaults TO morrow_work_command;
GRANT SELECT (organization_id,workspace_id,id,revision,release_id,release_revision,release_digest,store_id,connection_id,agent_principal_id,
 owner_principal_id,owner_membership_id,status,scope,grant_refs,configuration_digest,created_at,updated_at) ON morrow_work.agent_installations TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,store_id,connection_id,capability_id,target_kind,target_id,actor_principal_id,actor_membership_id,
 canonical,digest,command_id,request_digest,prior_state_observed,created_at) ON morrow_work.kill_switch_records TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,catalogue_version,model_key,effort_key,max_credits_per_product,revision,updated_by_principal_id,
 updated_by_membership_id,updated_at) ON morrow_work.workspace_model_defaults TO morrow_work_api;
GRANT SELECT (kill_switch_record_id) ON morrow_work.stop_controls TO morrow_work_api;

-- ---------------------------------------------------------------------------
-- Triggers: INVOKER, owned by the owner, granted to nobody.
-- Installations: born active at revision 1; afterwards revision+1 with only status and
-- updated_at changing, along active<->disabled and to uninstalled.
CREATE FUNCTION morrow_work.agent_installation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['status','revision','updated_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>'active' OR NEW.updated_at<>NEW.created_at THEN RAISE EXCEPTION 'AGENT_INSTALLATION_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR NOT ((OLD.status,NEW.status) IN (('active','disabled'),('disabled','active'),('active','uninstalled'),('disabled','uninstalled'))) THEN
  RAISE EXCEPTION 'AGENT_INSTALLATION_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Documents: born unconsumed; the one change is consumption, once.
CREATE FUNCTION morrow_work.enable_document_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['consumed_at','consumed_command_id'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'AGENT_DOCUMENT_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable) THEN
  RAISE EXCEPTION 'AGENT_DOCUMENT_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Envelopes and hops: append-only except one revocation (revoked_at null to set).
CREATE FUNCTION morrow_work.revocable_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'WORK_RECORD_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
  OR (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at') THEN
  RAISE EXCEPTION 'WORK_RECORD_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
-- Model defaults: born at revision 1; each change is revision+1, never back-dated.
CREATE FUNCTION morrow_work.model_default_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'MODEL_DEFAULT_INVALID'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
  RAISE EXCEPTION 'MODEL_DEFAULT_INVALID';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION morrow_work.agent_installation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.enable_document_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.revocable_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.model_default_guard() FROM PUBLIC;
CREATE TRIGGER agent_installation_guard BEFORE INSERT OR UPDATE ON morrow_work.agent_installations FOR EACH ROW EXECUTE FUNCTION morrow_work.agent_installation_guard();
CREATE TRIGGER enable_document_guard BEFORE INSERT OR UPDATE ON morrow_work.agent_enable_documents FOR EACH ROW EXECUTE FUNCTION morrow_work.enable_document_guard();
CREATE TRIGGER revocable_guard BEFORE INSERT OR UPDATE ON morrow_work.work_envelopes FOR EACH ROW EXECUTE FUNCTION morrow_work.revocable_guard();
CREATE TRIGGER revocable_guard BEFORE INSERT OR UPDATE ON morrow_work.delegation_hops FOR EACH ROW EXECUTE FUNCTION morrow_work.revocable_guard();
CREATE TRIGGER model_default_guard BEFORE INSERT OR UPDATE ON morrow_work.workspace_model_defaults FOR EACH ROW EXECUTE FUNCTION morrow_work.model_default_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['agent_releases','model_catalogue_versions','model_catalogue_entries','kill_switch_records'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['agent_installations','agent_enable_documents','work_envelopes','delegation_hops','workspace_model_defaults'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['agent_releases','model_catalogue_versions','model_catalogue_entries','agent_installations','agent_enable_documents',
  'work_envelopes','delegation_hops','kill_switch_records','workspace_model_defaults'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Revisable owner helpers: INVOKER, owned by the owner (a later owner migration may
-- CREATE OR REPLACE them), EXECUTE for the command role only. Store-dependent SQL lives
-- here, over M2 PR-2's work_store_installations, so M2 PR-3 can revise it.
-- The current connection of one store of a tenant: a linked association whose link time
-- has passed. Zero rows otherwise.
CREATE FUNCTION morrow_work.listings_store_current(p_org text,p_ws text,p_store_id text)
RETURNS TABLE(connection_id text,installation_id text)
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT i.connection_id,i.installation_id FROM morrow_identity.work_store_installations(p_org,p_ws) i
 WHERE i.store_id=p_store_id AND i.status='linked' AND i.linked_at<=pg_catalog.clock_timestamp()
$$;
-- The active Shopify offline token envelope of one store installation (M2: the credential's
-- subject is the store installation id), as hex. Read only while the session user is the
-- broker's login (morrow_vault.credentials vault_broker policy). Outcomes: found, not_found.
CREATE FUNCTION morrow_vault.credential_for_connection(p_org text,p_ws text,p_store_installation_id text)
RETURNS TABLE(outcome text,credential_id text,version text,kek_version text,wrapped_key text,sealed_value text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE c record;
BEGIN
 SELECT x.id::text AS id,x.version::text AS version,x.kek_version::text AS kek_version,encode(x.wrapped_key,'hex') AS wrapped_key,
  encode(x.sealed_value,'hex') AS sealed_value INTO c FROM morrow_vault.credentials x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.subject_id=p_store_installation_id AND x.status='active'
   AND x.provider='shopify' AND x.kind='shopify_offline_token';
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'found'::text,c.id,c.version,c.kek_version,c.wrapped_key,c.sealed_value;
END $$;

-- ---------------------------------------------------------------------------
-- API functions: SECURITY DEFINER, owned by the command role after the transfer below,
-- EXECUTE for morrow_work_api only. Tenant and actor come only from current_tenant().
-- Replay first for the agent commands: the per-actor key lock, then the recorded command.
CREATE FUNCTION morrow_work.begin_agent_command(p_type text,p_command_id text,p_request_digest text)
RETURNS TABLE(outcome text,aggregate_type text,aggregate_id text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record; c record;
BEGIN
 IF p_type IS NULL OR p_type NOT IN ('installation.document','installation.enable','installation.stop','model_default.revise')
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
-- The session tenant's current association of one store (read before any command takes its
-- locks, so never trusted as current: every command re-reads it under lock). Ids only.
CREATE FUNCTION morrow_work.store_association(p_store_id text)
RETURNS TABLE(store_id text,connection_id text,database_now text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record;
BEGIN
 IF p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT p_store_id,s.connection_id,morrow_work.utc_text(morrow_work.db_now())
  FROM morrow_work.listings_store_current(t.organization_id,t.workspace_id,p_store_id) s LIMIT 1;
END $$;

-- One installation document of the session's own actor, by digest (the confirm step reads
-- the document it built). Nothing for another actor, tenant or digest.
CREATE FUNCTION morrow_work.agent_enable_document(p_digest text)
RETURNS TABLE(id text,purpose text,store_id text,connection_id text,installation_id text,canonical text,expires_at text,consumed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE t record;
BEGIN
 IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RETURN; END IF;
 SELECT c.organization_id,c.workspace_id,c.principal_id,c.membership_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT x.id::text,x.purpose,x.store_id::text,x.connection_id::text,x.installation_id::text,x.canonical,
  morrow_work.utc_text(x.expires_at),x.consumed_at IS NOT NULL
  FROM morrow_work.agent_enable_documents x WHERE x.organization_id=t.organization_id AND x.workspace_id=t.workspace_id
   AND x.digest=p_digest AND x.actor_principal_id=t.principal_id AND x.actor_membership_id=t.membership_id;
END $$;

-- "Enable Listings agent", step 1 (the item 3 amendment): records the server-built
-- installation document the owner confirms, after the Worker's kernel allowed
-- agents.installation.activate on the store resource. The document names the current
-- published release, the current store resource, the installation (new for `enable`; the
-- owner-stopped one for `resume`), the exact grant set and the owner's disable grant; it is
-- bound to the actor, this session, five minutes and the nonce's digest (the Worker returns
-- the nonce once). A resume reactivates the installation as it stands (its release,
-- connection and grants never change), so the document is built only when that
-- installation is exactly what it names: the current published release, the store's
-- current connection and the exact grant set (work_agent_grant_set_current). It records
-- the person's open "Stop AI work" on the installation, the one stop it may lift. At most
-- ten open documents per actor and store. Outcomes: applied, invalid, ineligible,
-- stale_authority, command_conflict, not_found (no current store), stopped (a platform or
-- connection stop), state_conflict (enable: an installation exists; resume: none is
-- stopped by a person's "Stop AI work", or it differs from the document), limit_reached.
CREATE FUNCTION morrow_work.cmd_listings_enable_document(p_command_id text,p_request_digest text,p_correlation_id text,p_store_id text,
 p_purpose text,p_installation_id text,p_document_id text,p_canonical text,p_digest text,p_nonce_digest text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; s record; r record; i record; d jsonb; v_created timestamptz; v_now timestamptz; v_result jsonb; v_revision bigint;
 v_stop text; v_grants text;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_purpose IS NULL OR p_purpose NOT IN ('enable','resume')
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_document_id IS NULL OR p_document_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_canonical IS NULL OR octet_length(p_canonical)>16384 OR NOT pg_input_is_valid(p_canonical,'jsonb')
  OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_nonce_digest IS NULL OR p_nonce_digest !~ '^[a-f0-9]{64}$'
  OR morrow_work.sha256_text(p_canonical)<>p_digest THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 d:=p_canonical::jsonb;
 IF jsonb_typeof(d)<>'object' THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 v_created:=morrow_work.utc_parse(d->>'createdAt');
 IF v_created IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 IF v_created<date_trunc('milliseconds',transaction_timestamp()) OR v_created>v_now THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT x.connection_id INTO s FROM morrow_work.listings_store_current(p.organization_id,p.workspace_id,p_store_id) x LIMIT 1;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF morrow_work.stop_active(p.organization_id,p.workspace_id,'run',s.connection_id,NULL) THEN RETURN QUERY SELECT 'stopped'::text,NULL::text; RETURN; END IF;
 SELECT x.id,x.revision::bigint AS revision,x.digest::text AS digest INTO r FROM morrow_work.agent_releases x
  WHERE x.id='morrow.listings' AND x.status='published' ORDER BY x.revision DESC LIMIT 1;
 IF NOT FOUND THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
 SELECT x.id::text AS id,x.status,x.revision::bigint AS revision,x.connection_id::text AS connection_id,x.release_id,
  x.release_revision::bigint AS release_revision,x.release_digest::text AS release_digest,x.agent_principal_id::text AS agent_principal_id,
  x.grant_refs INTO i FROM morrow_work.agent_installations x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.store_id=p_store_id AND x.release_id='morrow.listings'
   AND x.status<>'uninstalled';
 IF p_purpose='enable' THEN
  IF FOUND OR EXISTS(SELECT 1 FROM morrow_work.agent_installations x WHERE x.organization_id=p.organization_id
    AND x.workspace_id=p.workspace_id AND x.id=p_installation_id) THEN
   RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
  END IF;
  v_revision:=1;
 ELSE
  -- The installation the document will name, exactly: its release, store connection and
  -- grant set are the document's (the item 3 amendment; any difference refuses).
  IF NOT FOUND OR i.id<>p_installation_id OR i.status<>'disabled' OR i.connection_id<>s.connection_id::text
   OR (i.release_id,i.release_revision,i.release_digest)<>(r.id::text,r.revision,r.digest) THEN
   RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
  END IF;
  SELECT g.outcome INTO v_grants FROM morrow_identity.work_agent_grant_set_current(p.organization_id,p.workspace_id,i.id,i.agent_principal_id,
   i.grant_refs,morrow_work.listings_grant_set(p.organization_id,p.workspace_id,p_store_id,s.connection_id)) g;
  IF v_grants IS DISTINCT FROM 'exact' THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
  -- The person's own "Stop AI work" on this installation (its KillSwitchRecord), never a
  -- platform, connection, system or operator stop.
  SELECT x.id::text INTO v_stop FROM morrow_work.stop_controls x
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.scope='installation' AND x.target_id=p_installation_id
    AND x.lifted_at IS NULL AND x.set_by_kind='human' AND x.reason_code='human_stop_ai_work'
    AND EXISTS(SELECT 1 FROM morrow_work.kill_switch_records k WHERE k.organization_id=x.organization_id AND k.workspace_id=x.workspace_id
     AND k.id=x.kill_switch_record_id AND k.capability_id='agents.installation.disable' AND k.target_kind='installation'
     AND k.target_id=x.target_id);
  IF NOT FOUND THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
  v_revision:=i.revision;
 END IF;
 IF (SELECT count(*) FROM morrow_work.agent_enable_documents x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.actor_principal_id=p.principal_id AND x.store_id=p_store_id AND x.consumed_at IS NULL AND x.expires_at>v_now)>=10 THEN
  RETURN QUERY SELECT 'limit_reached'::text,NULL::text; RETURN;
 END IF;
 BEGIN
  INSERT INTO morrow_work.agent_enable_documents(organization_id,workspace_id,id,purpose,store_id,connection_id,installation_id,release_id,
   release_revision,release_digest,actor_principal_id,actor_membership_id,session_digest,nonce_digest,canonical,digest,command_id,created_at,
   expires_at,consumed_at,consumed_command_id,stop_id)
  VALUES (p.organization_id,p.workspace_id,p_document_id,p_purpose,p_store_id,s.connection_id,p_installation_id,r.id,r.revision,r.digest,
   p.principal_id,p.membership_id,pg_catalog.current_setting('morrow.work_session_digest',true),p_nonce_digest,p_canonical,p_digest,p_command_id,
   v_created,v_created+interval '5 minutes',NULL,NULL,v_stop);
 EXCEPTION WHEN check_violation OR raise_exception OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 v_result:=jsonb_build_object('documentId',p_document_id,'documentDigest',p_digest,'installationId',p_installation_id,'purpose',p_purpose,
  'expiresAt',morrow_work.utc_text(v_created+interval '5 minutes'));
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'installation.document',p_installation_id,v_revision,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- "Enable Listings agent", step 2: the owner's confirmation of one document. Under the
-- exclusive organization interlock (it writes identity rows), after the Worker reran the
-- kernel against current authority: the document is this tenant's, this store's, this
-- actor's and this session's, unexpired and unconsumed, and the nonce is its own; the
-- release, store connection, platform and connection stops and the installation state are
-- rechecked against the document. `enable` creates the agent principals (the
-- installation's, and the workspace Coordinator's on first use), issues the installation's
-- three grants (the identity bridge's allowlist; each one exactly the document's) and the
-- owner's disable grant, and records the installation with its GrantRefs. `resume` needs the
-- installation to be exactly the document (its release, store connection and grant set),
-- lifts only the stop the document recorded (a person's lift; a stop set after the
-- document was built stays) and reactivates the installation; its grants are unchanged.
-- The document is consumed with the command. Outcomes: applied, invalid, ineligible,
-- stale_authority, command_conflict, not_found, guard_failed (the document or nonce does
-- not hold), stopped, state_conflict.
CREATE FUNCTION morrow_work.cmd_listings_enable(p_command_id text,p_request_digest text,p_correlation_id text,p_store_id text,
 p_document_digest text,p_nonce text,p_agent_principal_id text,p_coordinator_principal_id text,p_grants text,p_owner_grant text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 p record; doc record; r record; i record; e record; c record; v_now timestamptz; v_texts jsonb; v_payloads jsonb:='[]'::jsonb;
 v_refs jsonb:='[]'::jsonb; v_set jsonb; v_owner jsonb; v_text text; v_payload jsonb; v_index integer:=0; v_revision bigint; v_result jsonb;
 v_count integer; v_grants text;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_document_digest IS NULL OR p_document_digest !~ '^[a-f0-9]{64}$'
  OR p_nonce IS NULL OR p_nonce !~ '^[a-f0-9]{64}$'
  OR (p_agent_principal_id IS NOT NULL AND p_agent_principal_id !~ '^agent_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
  OR (p_coordinator_principal_id IS NOT NULL AND p_coordinator_principal_id !~ '^agent_[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')
  OR (p_grants IS NOT NULL AND (octet_length(p_grants)>65536 OR NOT pg_input_is_valid(p_grants,'jsonb')))
  OR (p_owner_grant IS NOT NULL AND (octet_length(p_owner_grant)>16384 OR NOT pg_input_is_valid(p_owner_grant,'jsonb'))) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude_exclusive(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 SELECT x.* INTO doc FROM morrow_work.agent_enable_documents x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
  AND x.digest=p_document_digest FOR UPDATE;
 IF NOT FOUND OR doc.store_id<>p_store_id THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 IF doc.actor_principal_id<>p.principal_id OR doc.actor_membership_id<>p.membership_id
  OR doc.session_digest<>pg_catalog.current_setting('morrow.work_session_digest',true)
  OR doc.consumed_at IS NOT NULL OR doc.expires_at<=v_now OR doc.nonce_digest<>morrow_work.sha256_text(p_nonce) THEN
  RETURN QUERY SELECT 'guard_failed'::text,NULL::text; RETURN;
 END IF;
 -- The document against the current state.
 IF NOT EXISTS(SELECT 1 FROM morrow_work.listings_store_current(p.organization_id,p.workspace_id,doc.store_id) x WHERE x.connection_id=doc.connection_id) THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 IF morrow_work.stop_active(p.organization_id,p.workspace_id,'run',doc.connection_id,NULL) THEN RETURN QUERY SELECT 'stopped'::text,NULL::text; RETURN; END IF;
 SELECT x.id,x.revision::bigint AS revision,x.digest::text AS digest INTO r FROM morrow_work.agent_releases x
  WHERE x.id='morrow.listings' AND x.status='published' ORDER BY x.revision DESC LIMIT 1;
 IF NOT FOUND OR (r.id,r.revision,r.digest)<>(doc.release_id::text,doc.release_revision::bigint,doc.release_digest::text) THEN
  RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
 END IF;
 SELECT x.id::text AS id,x.status,x.revision::bigint AS revision,x.agent_principal_id::text AS agent_principal_id,
  x.connection_id::text AS connection_id,x.release_id,x.release_revision::bigint AS release_revision,x.release_digest::text AS release_digest,
  x.grant_refs INTO i
  FROM morrow_work.agent_installations x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
   AND x.store_id=doc.store_id AND x.release_id='morrow.listings' AND x.status<>'uninstalled' FOR UPDATE;
 IF doc.purpose='enable' THEN
  IF FOUND OR p_agent_principal_id IS NULL OR p_coordinator_principal_id IS NULL OR p_grants IS NULL OR p_owner_grant IS NULL THEN
   RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
  END IF;
  -- The three grants: canonical texts whose payloads are exactly the document's grant set
  -- for the installation's agent principal, issued by this actor inside this transaction.
  v_texts:=p_grants::jsonb;
  v_set:=morrow_work.listings_grant_set(p.organization_id,p.workspace_id,doc.store_id,doc.connection_id);
  IF jsonb_typeof(v_texts)<>'array' OR jsonb_array_length(v_texts)<>3
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_texts) x WHERE jsonb_typeof(x)<>'string') THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
  FOR v_text IN SELECT x FROM jsonb_array_elements_text(v_texts) x LOOP
   IF NOT pg_input_is_valid(v_text,'jsonb') OR octet_length(v_text)>16384 THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
   v_payload:=v_text::jsonb;
   IF jsonb_typeof(v_payload)<>'object' OR jsonb_build_object('capabilityId',v_payload->'capabilityId','verbs',v_payload->'verbs',
     'scope',v_payload->'scope') IS DISTINCT FROM v_set->v_index
    OR v_payload->'principal' IS DISTINCT FROM jsonb_build_object('kind','agent','principalId',p_agent_principal_id,
     'organizationId',p.organization_id,'workspaceId',p.workspace_id,'membershipId',NULL,'installationId',doc.installation_id,'mandateId',NULL)
    OR jsonb_typeof(v_payload->'id')<>'string' THEN
    RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
   END IF;
   v_payloads:=v_payloads||jsonb_build_array(v_payload);
   v_refs:=v_refs||jsonb_build_array(jsonb_build_object('organizationId',p.organization_id,'workspaceId',p.workspace_id,'storeId',doc.store_id,
    'kind','grant','id',v_payload->>'id','revision',1,'digest',morrow_work.sha256_text(v_text)));
   v_index:=v_index+1;
  END LOOP;
  v_owner:=p_owner_grant::jsonb;
  IF jsonb_typeof(v_owner)<>'object' OR v_owner->>'capabilityId' IS DISTINCT FROM 'agents.installation.disable'
   OR v_owner->'verbs' IS DISTINCT FROM '["execute"]'::jsonb
   OR v_owner->'scope' IS DISTINCT FROM morrow_work.installation_scope(p.organization_id,p.workspace_id,doc.store_id,doc.connection_id,doc.installation_id) THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END IF;
  -- Every write of the enable, or none: a refusal inside rolls the block back.
  BEGIN
   SELECT * INTO e FROM morrow_identity.work_agent_principal_ensure(p.organization_id,p.workspace_id,'installation',doc.installation_id,p_agent_principal_id);
   IF e.outcome IS DISTINCT FROM 'created' OR e.principal_id IS DISTINCT FROM p_agent_principal_id THEN RAISE EXCEPTION 'AGENT_PRINCIPAL_REFUSED'; END IF;
   SELECT * INTO c FROM morrow_identity.work_agent_principal_ensure(p.organization_id,p.workspace_id,'coordinator',NULL,p_coordinator_principal_id);
   IF c.outcome IS NULL OR c.outcome NOT IN ('created','exists') THEN RAISE EXCEPTION 'AGENT_COORDINATOR_REFUSED'; END IF;
   SELECT * INTO e FROM morrow_identity.work_agent_grants_issue(p.organization_id,p.workspace_id,v_payloads);
   IF e.outcome IS DISTINCT FROM 'issued' OR e.issued IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'AGENT_GRANTS_REFUSED'; END IF;
   SELECT * INTO e FROM morrow_identity.work_owner_disable_grant_issue(p.organization_id,p.workspace_id,v_owner);
   IF e.outcome IS NULL OR e.outcome NOT IN ('issued','exists') THEN RAISE EXCEPTION 'AGENT_OWNER_GRANT_REFUSED'; END IF;
   INSERT INTO morrow_work.agent_installations(organization_id,workspace_id,id,revision,release_id,release_revision,release_digest,store_id,
    connection_id,agent_principal_id,owner_principal_id,owner_membership_id,status,scope,grant_refs,configuration_digest,created_at,updated_at)
   VALUES (p.organization_id,p.workspace_id,doc.installation_id,1,r.id,r.revision,r.digest,doc.store_id,doc.connection_id,p_agent_principal_id,
    p.principal_id,p.membership_id,'active',morrow_work.listings_scope(p.organization_id,p.workspace_id,doc.store_id,doc.connection_id),v_refs,
    morrow_work.sha256_text('{"fields":["descriptionHtml","seo.description","seo.title","tags","title"]}'),v_now,v_now);
  EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
   RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
  END;
  v_revision:=1;
 ELSE
  IF NOT FOUND OR i.id<>doc.installation_id OR i.status<>'disabled' OR i.connection_id<>doc.connection_id::text
   OR (i.release_id,i.release_revision,i.release_digest)<>(doc.release_id::text,doc.release_revision::bigint,doc.release_digest::text)
   OR doc.stop_id IS NULL OR p_grants IS NOT NULL OR p_owner_grant IS NOT NULL
   OR p_agent_principal_id IS NOT NULL OR p_coordinator_principal_id IS NOT NULL THEN
   RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN;
  END IF;
  -- The grants the installation resumes with are still exactly the document's grant set.
  SELECT g.outcome INTO v_grants FROM morrow_identity.work_agent_grant_set_current(p.organization_id,p.workspace_id,i.id,i.agent_principal_id,
   i.grant_refs,morrow_work.listings_grant_set(p.organization_id,p.workspace_id,doc.store_id,doc.connection_id)) g;
  IF v_grants IS DISTINCT FROM 'exact' THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
  -- A person lifts the owner's own stop that the document named (only a person lifts a
  -- stop; ADR-0022 item 15). Any other stop, or this one already lifted, is a conflict.
  UPDATE morrow_work.stop_controls x SET lifted_at=greatest(v_now,x.created_at),lifted_by_kind='human',lifted_by_principal_id=p.principal_id,
   lifted_by_membership_id=p.membership_id
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=doc.stop_id AND x.scope='installation' AND x.target_id=doc.installation_id
    AND x.lifted_at IS NULL AND x.set_by_kind='human';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
  UPDATE morrow_work.agent_installations x SET status='active',revision=i.revision+1,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=doc.installation_id;
  v_revision:=i.revision+1;
 END IF;
 UPDATE morrow_work.agent_enable_documents x SET consumed_at=greatest(v_now,x.created_at),consumed_command_id=p_command_id
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=doc.id;
 v_result:=jsonb_build_object('installationId',doc.installation_id,'revision',v_revision,'status','active','purpose',doc.purpose,
  'documentDigest',doc.digest);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'installation.enable',doc.installation_id,v_revision,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- "Stop AI work" (agents.installation.disable; ADR-0005 human kill switch; ADR-0022 item
-- 15): after the Worker's kernel allowed `execute` on the installation resource and
-- checkKillSwitchTarget accepted the target, the KillSwitchRecord commits with its effect:
-- the installation stop (which revokes its run and operation leases through stop_guard) and
-- the installation's status disabled. Already stopped: the record (priorStateObserved
-- already_stopped) and its event only. The record's priorStateObserved is the Worker's read
-- before this lock: a concurrent stop that committed in between makes it stale, which is a
-- state_conflict (reread, then a retry records already_stopped), never a refusal. It never
-- reads entitlement or credits (ADR-0011 Q8). Outcomes: applied, invalid, ineligible,
-- stale_authority, command_conflict, not_found, state_conflict.
CREATE FUNCTION morrow_work.cmd_stop_ai_work(p_command_id text,p_request_digest text,p_correlation_id text,p_store_id text,
 p_installation_id text,p_record_canonical text,p_record_digest text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; i record; d jsonb; v_created timestamptz; v_now timestamptz; v_prior text; v_stop text; v_result jsonb; v_revision bigint;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_record_canonical IS NULL OR octet_length(p_record_canonical)>16384 OR NOT pg_input_is_valid(p_record_canonical,'jsonb')
  OR p_record_digest IS NULL OR p_record_digest !~ '^[a-f0-9]{64}$' OR morrow_work.sha256_text(p_record_canonical)<>p_record_digest THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 d:=p_record_canonical::jsonb;
 IF jsonb_typeof(d)<>'object' OR NOT morrow_work.json_id(d->'id') THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 v_created:=morrow_work.utc_parse(d->>'createdAt');
 IF v_created IS NULL THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 IF v_created<date_trunc('milliseconds',transaction_timestamp()) OR v_created>v_now THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT x.id::text AS id,x.status,x.revision::bigint AS revision,x.connection_id::text AS connection_id INTO i FROM morrow_work.agent_installations x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_installation_id AND x.store_id=p_store_id
   AND x.status IN ('active','disabled') FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text; RETURN; END IF;
 SELECT x.id::text INTO v_stop FROM morrow_work.stop_controls x WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id
  AND x.scope='installation' AND x.target_id=p_installation_id AND x.lifted_at IS NULL;
 v_prior:=CASE WHEN FOUND THEN 'already_stopped' ELSE 'active' END;
 IF d->'priorStateObserved' IS DISTINCT FROM to_jsonb(v_prior) THEN RETURN QUERY SELECT 'state_conflict'::text,NULL::text; RETURN; END IF;
 v_revision:=i.revision;
 BEGIN
  INSERT INTO morrow_work.kill_switch_records(organization_id,workspace_id,id,store_id,connection_id,capability_id,target_kind,target_id,
   actor_principal_id,actor_membership_id,canonical,digest,command_id,request_digest,prior_state_observed,created_at)
  VALUES (p.organization_id,p.workspace_id,d->>'id',p_store_id,i.connection_id,'agents.installation.disable','installation',p_installation_id,
   p.principal_id,p.membership_id,p_record_canonical,p_record_digest,p_command_id,p_request_digest,v_prior,v_created);
  IF v_prior='active' THEN
   v_stop:=gen_random_uuid()::text;
   INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,
    set_by_membership_id,set_by_operator_id,reason_code,reason,created_at,kill_switch_record_id)
   VALUES (p.organization_id,p.workspace_id,v_stop,'installation',p_store_id,p_installation_id,'human',p.principal_id,p.membership_id,NULL,
    'human_stop_ai_work',d#>>'{control,reason}',v_now,d->>'id');
  END IF;
  IF i.status='active' THEN
   UPDATE morrow_work.agent_installations x SET status='disabled',revision=i.revision+1,updated_at=greatest(v_now,x.updated_at)
    WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id AND x.id=p_installation_id;
   v_revision:=i.revision+1;
  END IF;
 EXCEPTION WHEN raise_exception OR check_violation OR unique_violation OR foreign_key_violation OR not_null_violation THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END;
 PERFORM morrow_work.append_event(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,'kill_switch.executed','kill_switch',d->>'id',1,
  NULL,jsonb_build_object('capabilityId','agents.installation.disable','sourceProposalId',NULL),p_correlation_id,v_now);
 v_result:=jsonb_build_object('status','disabled','pendingOperations','[]'::jsonb,'killSwitchRecordId',d->>'id','priorStateObserved',v_prior,
  'stopId',v_stop,'installationId',p_installation_id,'revision',v_revision);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'installation.stop',p_installation_id,v_revision,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- The workspace's default selection and member ceiling (governance.model_default.revise,
-- after the Worker's kernel allowed it): keys of the active catalogue version, a ceiling
-- that admits the default, and the expected revision (null for the first row). Outcomes:
-- applied, invalid, ineligible, stale_authority, command_conflict, revision_conflict.
CREATE FUNCTION morrow_work.cmd_model_default_revise(p_command_id text,p_request_digest text,p_correlation_id text,p_catalogue_version text,
 p_model text,p_effort text,p_max_credits text,p_expected_revision text)
RETURNS TABLE(outcome text,result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE p record; e record; m record; v_now timestamptz; v_revision bigint; v_result jsonb;
BEGIN
 IF p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_catalogue_version IS NULL OR p_catalogue_version !~ '^[1-9][0-9]{0,2}$'
  OR p_model IS NULL OR p_model !~ '^[a-z][a-z0-9_]{0,39}$' OR p_effort IS NULL OR p_effort !~ '^[a-z][a-z0-9_]{0,39}$'
  OR p_max_credits IS NULL OR p_max_credits !~ '^[1-9][0-9]?$'
  OR (p_expected_revision IS NOT NULL AND p_expected_revision !~ '^[1-9][0-9]{0,15}$') THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 SELECT * INTO p FROM morrow_work.command_prelude(p_command_id,p_request_digest);
 IF p.outcome<>'ok' THEN RETURN QUERY SELECT p.outcome,NULL::text; RETURN; END IF;
 v_now:=morrow_work.db_now();
 SELECT x.credits_per_product INTO e FROM morrow_work.model_catalogue_entries x JOIN morrow_work.model_catalogue_versions v ON v.version=x.version
  WHERE x.version=p_catalogue_version::integer AND v.status='active' AND x.model_key=p_model AND x.effort_key=p_effort;
 IF NOT FOUND OR e.credits_per_product>p_max_credits::integer THEN RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN; END IF;
 SELECT x.revision::bigint AS revision INTO m FROM morrow_work.workspace_model_defaults x
  WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id FOR UPDATE;
 IF NOT FOUND THEN
  IF p_expected_revision IS NOT NULL THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
  INSERT INTO morrow_work.workspace_model_defaults(organization_id,workspace_id,catalogue_version,model_key,effort_key,max_credits_per_product,
   revision,updated_by_principal_id,updated_by_membership_id,updated_at)
  VALUES (p.organization_id,p.workspace_id,p_catalogue_version::integer,p_model,p_effort,p_max_credits::integer,1,p.principal_id,p.membership_id,v_now);
  v_revision:=1;
 ELSE
  IF p_expected_revision IS NULL OR m.revision<>p_expected_revision::bigint THEN RETURN QUERY SELECT 'revision_conflict'::text,NULL::text; RETURN; END IF;
  UPDATE morrow_work.workspace_model_defaults x SET catalogue_version=p_catalogue_version::integer,model_key=p_model,effort_key=p_effort,
   max_credits_per_product=p_max_credits::integer,revision=m.revision+1,updated_by_principal_id=p.principal_id,
   updated_by_membership_id=p.membership_id,updated_at=greatest(v_now,x.updated_at)
   WHERE x.organization_id=p.organization_id AND x.workspace_id=p.workspace_id;
  v_revision:=m.revision+1;
 END IF;
 -- The result records what was set, so a replay returns the same body.
 v_result:=jsonb_build_object('revision',v_revision,'model',p_model,'effort',p_effort,'maxCreditsPerProduct',p_max_credits::integer);
 PERFORM morrow_work.record_command(p.organization_id,p.workspace_id,p.principal_id,p.membership_id,p_command_id,p_request_digest,
  'model_default.revise',p.workspace_id,v_revision,v_result,p_correlation_id,v_now);
 RETURN QUERY SELECT 'applied'::text,v_result::text;
END $$;

-- ---------------------------------------------------------------------------
-- The runtime definer: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_runtime_executor only; the tenant comes only from the entered run lease.
-- The agent kernel's facts for one step (decideDelegation): the envelope, the one chain of
-- hops (at most eight, in order) from the envelope to this executor's installation, the
-- installations they and the executor name, the store's currency, and the identity facts
-- of every actor (origin, executor, owners and dispatchers) with their grants filtered to
-- the capabilities the kernel reads. An envelope may have several children: the chain is
-- the path whose last recipient is this installation, and two or more such paths are
-- ambiguous (the step's task cannot be told apart), so nothing is returned. Returns
-- nothing unless the entered lease is a run lease of exactly this installation. The
-- kernel in the Worker decides; nothing here interprets a grant.
CREATE FUNCTION morrow_work.delegation_facts(p_envelope_id text,p_installation_id text,p_capability_id text)
RETURNS TABLE(lease text,envelope text,hops text,installations text,actors text,store_current text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE l record; v_envelope jsonb; v_hops jsonb:='[]'::jsonb; v_hop jsonb; v_installations jsonb; v_actors jsonb:='[]'::jsonb;
 v_facts jsonb; v_caps jsonb; v_ids text[]; v_path text[]; v_chain text[]; v_paths integer:=0;
BEGIN
 IF p_envelope_id IS NULL OR p_envelope_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_capability_id IS NULL OR char_length(p_capability_id)>128 OR p_capability_id !~ '^[a-z]+(\.[a-z_]+)+$' THEN RETURN; END IF;
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind<>'run' OR l.installation_id IS DISTINCT FROM p_installation_id THEN RETURN; END IF;
 SELECT to_jsonb(x) INTO v_envelope FROM (SELECT e.id::text AS id,e.revision::bigint AS revision,e.task_id::text AS task_id,
   e.task_revision::bigint AS task_revision,e.requester_principal_id::text AS requester_principal_id,
   e.requester_membership_id::text AS requester_membership_id,e.store_id::text AS store_id,e.installation_id::text AS installation_id,
   to_jsonb(e.capability_ids) AS capability_ids,to_jsonb(e.verbs) AS verbs,e.scope,morrow_work.utc_text(e.valid_from) AS valid_from,
   morrow_work.utc_text(e.expires_at) AS expires_at,morrow_work.utc_text(e.revoked_at) AS revoked_at,e.maximum_depth,e.maximum_children
  FROM morrow_work.work_envelopes e WHERE e.organization_id=l.organization_id AND e.workspace_id=l.workspace_id AND e.id=p_envelope_id) x;
 IF v_envelope IS NULL THEN RETURN; END IF;
 -- Every path of hops from the envelope (at most eight deep) whose last recipient is this
 -- installation; at most two are read, and a second one is ambiguity.
 FOR v_path IN WITH RECURSIVE walk(depth,path,child_envelope_id,recipient_installation_id) AS (
   SELECT 1,ARRAY[h.id::text],h.child_envelope_id::text,h.recipient_installation_id::text FROM morrow_work.delegation_hops h
    WHERE h.organization_id=l.organization_id AND h.workspace_id=l.workspace_id AND h.parent_envelope_id=p_envelope_id
   UNION ALL
   SELECT w.depth+1,w.path||h.id::text,h.child_envelope_id::text,h.recipient_installation_id::text FROM walk w
    JOIN morrow_work.delegation_hops h ON h.organization_id=l.organization_id AND h.workspace_id=l.workspace_id
     AND h.parent_envelope_id=w.child_envelope_id
    WHERE w.depth<8)
  SELECT w.path FROM walk w WHERE w.recipient_installation_id=p_installation_id LIMIT 2 LOOP
  v_paths:=v_paths+1;
  v_chain:=v_path;
 END LOOP;
 IF v_paths>1 THEN RETURN; END IF;
 IF v_chain IS NOT NULL THEN
  SELECT COALESCE(jsonb_agg(to_jsonb(x)-'ordinal' ORDER BY x.ordinal),'[]'::jsonb) INTO v_hops FROM (SELECT u.ordinal,h.id::text AS id,
    h.revision::bigint AS revision,h.parent_task_id::text AS parent_task_id,
    h.parent_task_revision::bigint AS parent_task_revision,h.child_task_id::text AS child_task_id,h.child_task_revision::bigint AS child_task_revision,
    h.parent_envelope_id::text AS parent_envelope_id,h.parent_envelope_revision::bigint AS parent_envelope_revision,
    h.child_envelope_id::text AS child_envelope_id,h.child_envelope_revision::bigint AS child_envelope_revision,h.dispatcher_kind,
    h.dispatcher_principal_id::text AS dispatcher_principal_id,h.dispatcher_installation_id::text AS dispatcher_installation_id,
    h.recipient_principal_id::text AS recipient_principal_id,h.recipient_installation_id::text AS recipient_installation_id,
    to_jsonb(h.capability_ids) AS capability_ids,to_jsonb(h.verbs) AS verbs,h.scope,morrow_work.utc_text(h.valid_from) AS valid_from,
    morrow_work.utc_text(h.expires_at) AS expires_at,morrow_work.utc_text(h.revoked_at) AS revoked_at,h.parent_child_count
   FROM unnest(v_chain) WITH ORDINALITY u(hop_id,ordinal) JOIN morrow_work.delegation_hops h ON h.organization_id=l.organization_id
    AND h.workspace_id=l.workspace_id AND h.id=u.hop_id) x;
 END IF;
 v_ids:=ARRAY[p_installation_id];
 FOR v_hop IN SELECT x FROM jsonb_array_elements(v_hops) x LOOP
  IF v_hop->>'dispatcher_installation_id' IS NOT NULL THEN v_ids:=v_ids||(v_hop->>'dispatcher_installation_id'); END IF;
  v_ids:=v_ids||(v_hop->>'recipient_installation_id');
 END LOOP;
 SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'::jsonb) INTO v_installations FROM (SELECT DISTINCT i.id::text AS id,i.revision::bigint AS revision,
   i.release_id,i.release_revision::bigint AS release_revision,i.release_digest::text AS release_digest,i.store_id::text AS store_id,
   i.connection_id::text AS connection_id,i.agent_principal_id::text AS agent_principal_id,i.owner_principal_id::text AS owner_principal_id,
   i.owner_membership_id::text AS owner_membership_id,i.status,i.scope,i.grant_refs,i.configuration_digest::text AS configuration_digest,
   morrow_work.utc_text(i.created_at) AS created_at,morrow_work.utc_text(i.updated_at) AS updated_at
  FROM morrow_work.agent_installations i WHERE i.organization_id=l.organization_id AND i.workspace_id=l.workspace_id AND i.id=ANY(v_ids)) x;
 -- The actors: the origin (the envelope's requester) with the operation's capability and
 -- workspace.task.delegate; every installation's agent principal (all its grants: the
 -- three Listings capabilities) and owner (the operation's capability and the delegate
 -- capability); every Coordinator dispatcher with its delegate grant on its parent task.
 v_caps:=jsonb_build_array(p_capability_id,'workspace.task.delegate');
 v_actors:=jsonb_build_array(jsonb_build_object('principalId',v_envelope->>'requester_principal_id','membershipId',
  v_envelope->>'requester_membership_id','capabilityIds',v_caps,'resourceId',NULL));
 SELECT v_actors||COALESCE(jsonb_agg(a),'[]'::jsonb) INTO v_actors FROM (
  SELECT jsonb_build_object('principalId',x->>'agent_principal_id','membershipId',NULL,'capabilityIds',
   '["catalog.content.propose","catalog.content.publish","catalog.products.read"]'::jsonb,'resourceId',NULL) AS a FROM jsonb_array_elements(v_installations) x
  UNION ALL
  SELECT jsonb_build_object('principalId',x->>'owner_principal_id','membershipId',x->>'owner_membership_id','capabilityIds',v_caps,'resourceId',NULL)
   FROM jsonb_array_elements(v_installations) x
  UNION ALL
  SELECT jsonb_build_object('principalId',h->>'dispatcher_principal_id','membershipId',NULL,'capabilityIds','["workspace.task.delegate"]'::jsonb,
   'resourceId',h->>'parent_task_id') FROM jsonb_array_elements(v_hops) h WHERE h->>'dispatcher_kind'='builtin_coordinator') q;
 SELECT COALESCE(jsonb_agg(to_jsonb(f)),'[]'::jsonb) INTO v_facts
  FROM morrow_identity.work_delegation_actor_facts(l.organization_id,l.workspace_id,v_actors) f;
 RETURN QUERY SELECT jsonb_build_object('organizationId',l.organization_id,'workspaceId',l.workspace_id,'leaseId',l.lease_id,'kind',l.kind,
   'storeId',l.store_id,'connectionId',l.connection_id,'installationId',l.installation_id,'initiatorPrincipalId',l.initiator_principal_id,
   'initiatorMembershipId',l.initiator_membership_id)::text,
  v_envelope::text,v_hops::text,v_installations::text,v_facts::text,
  (EXISTS(SELECT 1 FROM morrow_work.listings_store_current(l.organization_id,l.workspace_id,l.store_id) s WHERE s.connection_id=l.connection_id)
   AND NOT morrow_work.stop_active(l.organization_id,l.workspace_id,'run',l.connection_id,l.installation_id))::text;
END $$;

-- ---------------------------------------------------------------------------
-- The vault definer: SECURITY DEFINER, owned by the command role, EXECUTE for
-- morrow_vault_broker only (spine §4). Every Shopify read and model call names a live lease:
-- the lease is active, of this generation and unexpired, and its initiating member is
-- current; the purpose fits the lease (model: a run; shopify_read: a read or a run) and the
-- subject is the lease's; no platform, connection or installation stop blocks it; a run's
-- installation is active on the lease's store and connection; the store's connection is
-- current; for shopify_read, the store installation's active credential envelope (hex) is
-- returned for the broker to open with its KEK. Any doubt is one fixed refusal and nothing
-- else. The settings it writes for its policies live only inside this call. Outcomes:
-- resolved, denied, invalid, not_found, ended, expired, member_inactive, purpose_mismatch,
-- subject_mismatch, stopped, installation_inactive, connection_inactive,
-- credential_unavailable.
CREATE FUNCTION morrow_vault.resolve_call(p_lease_id text,p_generation text,p_purpose text,p_subject_id text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,lease_kind text,subject_id text,store_id text,connection_id text,
 installation_id text,credential_id text,credential_version text,kek_version text,wrapped_key text,sealed_value text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE l record; s record; c record; v_outcome text:='resolved';
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 IF p_lease_id IS NULL OR p_lease_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' OR p_generation IS NULL OR p_generation !~ '^[1-9][0-9]{0,15}$'
  OR p_purpose IS NULL OR p_purpose NOT IN ('model','shopify_read')
  OR p_subject_id IS NULL OR p_subject_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 PERFORM pg_catalog.set_config('morrow.vault_resolve_lease',p_lease_id,true);
 SELECT x.organization_id::text AS organization_id,x.workspace_id::text AS workspace_id,x.generation::text AS generation,x.kind,x.status,
  x.subject_id::text AS subject_id,x.store_id::text AS store_id,x.connection_id::text AS connection_id,x.installation_id::text AS installation_id,
  x.initiator_principal_id::text AS initiator_principal_id,x.initiator_membership_id::text AS initiator_membership_id,x.expires_at INTO l
  FROM morrow_work.work_leases x WHERE x.id=p_lease_id;
 IF NOT FOUND OR l.generation<>p_generation THEN v_outcome:='not_found';
 ELSIF l.status<>'active' THEN v_outcome:='ended';
 ELSIF l.expires_at<=pg_catalog.clock_timestamp() THEN v_outcome:='expired';
 ELSIF NOT morrow_identity.work_lease_member_current(l.organization_id,l.workspace_id,l.initiator_principal_id,l.initiator_membership_id) THEN
  v_outcome:='member_inactive';
 ELSIF (p_purpose='model' AND l.kind<>'run') OR (p_purpose='shopify_read' AND l.kind NOT IN ('read','run')) THEN v_outcome:='purpose_mismatch';
 ELSIF l.subject_id<>p_subject_id THEN v_outcome:='subject_mismatch';
 END IF;
 IF v_outcome='resolved' THEN
  PERFORM pg_catalog.set_config('morrow.vault_resolve_tenant',l.organization_id||'|'||l.workspace_id,true),
   pg_catalog.set_config('morrow.vault_resolve_installation',l.organization_id||'|'||l.workspace_id||'|'||COALESCE(l.installation_id,''),true);
  IF morrow_work.stop_active(l.organization_id,l.workspace_id,l.kind,l.connection_id,l.installation_id) THEN v_outcome:='stopped';
  ELSIF l.kind='run' AND NOT EXISTS(SELECT 1 FROM morrow_work.agent_installations i WHERE i.organization_id=l.organization_id
    AND i.workspace_id=l.workspace_id AND i.id=l.installation_id AND i.status='active' AND i.store_id=l.store_id AND i.connection_id=l.connection_id) THEN
   v_outcome:='installation_inactive';
  ELSE
   SELECT x.connection_id,x.installation_id INTO s FROM morrow_work.listings_store_current(l.organization_id,l.workspace_id,l.store_id) x
    WHERE x.connection_id=l.connection_id LIMIT 1;
   IF NOT FOUND THEN v_outcome:='connection_inactive';
   ELSIF p_purpose='shopify_read' THEN
    SELECT * INTO c FROM morrow_vault.credential_for_connection(l.organization_id,l.workspace_id,s.installation_id);
    IF c.outcome IS DISTINCT FROM 'found' THEN v_outcome:='credential_unavailable'; END IF;
   END IF;
  END IF;
 END IF;
 PERFORM pg_catalog.set_config('morrow.vault_resolve_lease','',true),pg_catalog.set_config('morrow.vault_resolve_tenant','',true),
  pg_catalog.set_config('morrow.vault_resolve_installation','',true);
 IF v_outcome<>'resolved' THEN
  RETURN QUERY SELECT v_outcome,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 IF p_purpose='shopify_read' THEN
  RETURN QUERY SELECT 'resolved'::text,l.organization_id,l.workspace_id,l.kind,l.subject_id,l.store_id,l.connection_id,l.installation_id,
   c.credential_id,c.version,c.kek_version,c.wrapped_key,c.sealed_value;
 ELSE
  RETURN QUERY SELECT 'resolved'::text,l.organization_id,l.workspace_id,l.kind,l.subject_id,l.store_id,l.connection_id,l.installation_id,
   NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
 END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 and S7 read proacl), then the ownership transfer.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p WHERE (p.pronamespace='morrow_work'::regnamespace AND p.proname IN (
  'listing_fields','store_resource','listings_scope','installation_scope','listings_grant_set','valid_grant_refs','enable_document_matches',
  'kill_switch_record_matches','release_manifest_valid','agent_installation_guard','enable_document_guard','revocable_guard','model_default_guard',
  'listings_store_current','begin_agent_command','store_association','agent_enable_document','cmd_listings_enable_document','cmd_listings_enable','cmd_stop_ai_work',
  'cmd_model_default_revise','delegation_facts')) OR (p.pronamespace='morrow_vault'::regnamespace AND p.proname IN ('credential_for_connection','resolve_call')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',r.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION morrow_work.listing_fields(),morrow_work.store_resource(text,text,text,text),morrow_work.listings_scope(text,text,text,text),
 morrow_work.installation_scope(text,text,text,text,text),morrow_work.listings_grant_set(text,text,text,text),
 morrow_work.valid_grant_refs(jsonb,text,text,text),
 morrow_work.enable_document_matches(text,text,text,text,text,text,text,text,text,bigint,text,text,text,timestamptz,timestamptz),
 morrow_work.kill_switch_record_matches(text,text,text,text,text,text,text,text,text,text,text,text,text,text,timestamptz),
 morrow_work.release_manifest_valid(text),morrow_work.listings_store_current(text,text,text),
 morrow_vault.credential_for_connection(text,text,text) TO morrow_work_command;
GRANT EXECUTE ON FUNCTION morrow_work.begin_agent_command(text,text,text),morrow_work.store_association(text),
 morrow_work.agent_enable_document(text),
 morrow_work.cmd_listings_enable_document(text,text,text,text,text,text,text,text,text,text),
 morrow_work.cmd_listings_enable(text,text,text,text,text,text,text,text,text,text),
 morrow_work.cmd_stop_ai_work(text,text,text,text,text,text,text),
 morrow_work.cmd_model_default_revise(text,text,text,text,text,text,text,text) TO morrow_work_api;
GRANT EXECUTE ON FUNCTION morrow_work.delegation_facts(text,text,text) TO morrow_runtime_executor;
GRANT EXECUTE ON FUNCTION morrow_vault.resolve_call(text,text,text,text) TO morrow_vault_broker;
GRANT CREATE ON SCHEMA morrow_work,morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_work.begin_agent_command(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.store_association(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.agent_enable_document(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_listings_enable_document(text,text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_listings_enable(text,text,text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_stop_ai_work(text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.cmd_model_default_revise(text,text,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.delegation_facts(text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.resolve_call(text,text,text,text) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work,morrow_vault FROM morrow_work_command;
COMMIT;
