BEGIN;
-- M2 PR-1 spine foundation (ADR-0022 items 7-9 and 13-15; mvp-architecture §5, §6, §8,
-- §10). Executes AS morrow_work_owner, after 0019. On the ADR-0010 tenant pattern:
-- composite tenant keys, ENABLE and FORCE RLS everywhere, definers owned by
-- morrow_work_command, INVOKER helpers and triggers granted to nobody.
--   * Background tenancy: work_leases, current_lease(), enter_lease(), pending_starts()
--     (ids only), lease_mark_started() and lease_release() for morrow_runtime_executor;
--     the lease_open() helper for api commands. current_tenant() and every session definer
--     are unchanged: a lease context never reaches them, and a session never reaches the
--     lease definers.
--   * Stops: stop_controls (current state, platform rows with null tenant keys) and
--     stop_records (StopRecord@1 for system and operator events). A stop revokes its
--     matching active leases in the same statement; lease_open refuses under a stop.
--   * The OperationLedger: operations (claim columns nullable) and operation_transitions,
--     on the operation rows of state-transitions.json, unchanged.
--   * morrow_billing.workspace_billing_routes (ADR-0015, P01.T04a §8.1) with its
--     immutability trigger and the signup bridge that 0021 calls.
--   * morrow_vault.app_secrets and morrow_vault.credentials: AES-256-GCM envelopes that
--     only the broker's own login reads, through its definers.
-- No external effect: no definer here sends anything, writes an operation or reads a
-- credential for any login other than morrow_vault_broker.
DO $$ BEGIN
 IF current_user<>'morrow_work_owner'
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_work_owner','morrow_work_command','morrow_work_api') AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication)<>3
 OR (SELECT count(*) FROM pg_catalog.pg_roles r WHERE r.rolname IN ('morrow_connector_ingress','morrow_runtime_executor','morrow_vault_broker')
   AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolinherit AND NOT r.rolreplication
   AND morrow_identity.memberships_closed(r.rolname))<>3
 OR NOT morrow_identity.morrow_memberships_closed()
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_executor_safe(text)','EXECUTE')
 OR NOT pg_catalog.has_function_privilege('morrow_work_command','morrow_identity.work_lease_member_current(text,text,text,text)','EXECUTE')
 OR to_regprocedure('morrow_work.current_tenant()') IS NULL OR to_regprocedure('morrow_work.db_now()') IS NULL
 OR to_regprocedure('morrow_work.append_only()') IS NULL OR to_regclass('morrow_work.approval_claims') IS NULL
 OR (SELECT count(*) FROM pg_catalog.pg_constraint c WHERE c.conrelid='morrow_work.transition_rules'::regclass
   AND c.conname IN ('transition_rules_machine_check','transition_rules_pkey'))<>2
 OR EXISTS(SELECT 1 FROM morrow_work.transition_rules t WHERE t.machine='operation')
 OR to_regnamespace('morrow_billing') IS NOT NULL OR to_regnamespace('morrow_vault') IS NOT NULL
 OR to_regclass('morrow_work.work_leases') IS NOT NULL
 THEN RAISE EXCEPTION 'SPINE_FOUNDATION_PREREQUISITES_INVALID'; END IF;
END $$;

CREATE SCHEMA morrow_billing AUTHORIZATION morrow_work_owner;
CREATE SCHEMA morrow_vault AUTHORIZATION morrow_work_owner;
REVOKE ALL ON SCHEMA morrow_billing FROM PUBLIC;
REVOKE ALL ON SCHEMA morrow_vault FROM PUBLIC;
GRANT USAGE ON SCHEMA morrow_work TO morrow_runtime_executor;
-- The identity owner calls one billing definer (the signup bridge of 0021).
GRANT USAGE ON SCHEMA morrow_billing TO morrow_work_command,morrow_work_api,morrow_identity_owner;
GRANT USAGE ON SCHEMA morrow_vault TO morrow_work_command,morrow_vault_broker;

-- ---------------------------------------------------------------------------
-- The operation rows of state-transitions.json, unchanged (a strict superset of the
-- machine CHECK; the 0018 primary key already carries the guard).
ALTER TABLE morrow_work.transition_rules DROP CONSTRAINT transition_rules_machine_check,
 ADD CONSTRAINT transition_rules_machine_check CHECK (machine IN ('goal','task','question','approval','operation'));
INSERT INTO morrow_work.transition_rules(machine,from_status,to_status,actor,guard) VALUES
 ('operation','planned','awaiting_approval','action_service','review_required'),
 ('operation','planned','authorized','action_service','current_grants_and_preconditions'),
 ('operation','awaiting_approval','authorized','action_service','exact_current_approval'),
 ('operation','awaiting_approval','rejected','action_service','eligible_rejection'),
 ('operation','authorized','reserved','budget_service','atomic_liability_reservation'),
 ('operation','authorized','dispatching','action_service','non_billable_current_grants_and_lease'),
 ('operation','reserved','dispatching','action_service','current_grants_lease_and_reserved_ceiling'),
 ('operation','dispatching','submitted','connector','provider_submission_receipt'),
 ('operation','dispatching','uncertain','connector','unknown_external_outcome'),
 ('operation','submitted','verifying','connector','provider_terminal_result'),
 ('operation','submitted','uncertain','connector','unknown_external_outcome'),
 ('operation','verifying','verified','action_service','declared_postconditions_verified'),
 ('operation','verifying','uncertain','connector','verification_unavailable'),
 ('operation','uncertain','verifying','connector','reconciled_provider_result'),
 ('operation','uncertain','failed','action_service','verified_no_effect'),
 ('operation','authorized','conflict','action_service','precondition_changed_before_dispatch'),
 ('operation','reserved','conflict','action_service','precondition_changed_before_dispatch'),
 ('operation','dispatching','failed','connector','verified_no_effect'),
 ('operation','submitted','cancel_requested','owner','provider_cancel_supported_or_recorded_request'),
 ('operation','uncertain','cancel_requested','owner','reconciliation_continues'),
 ('operation','cancel_requested','cancelled','connector','verified_provider_cancellation_and_liability'),
 ('operation','cancel_requested','verifying','connector','submitted_effect_completed_before_cancel'),
 ('operation','planned','cancelled','owner','no_submitted_effects'),
 ('operation','authorized','cancelled','owner','no_submitted_effects'),
 ('operation','reserved','cancelled','owner','reservation_released_without_submission');

-- ---------------------------------------------------------------------------
-- Tenant tables. Every stored time is millisecond-truncated.
-- A lease selects the tenant of background work and fences its generation; it grants
-- nothing (ADR-0022 item 9). Only api commands open leases, inside the session
-- transaction that authorised the work (lease_open). Terms: read 60 s, run 30 min,
-- operation 15 min. Expiry is checked at every use, so there is no sweep. The subject
-- is the read's request id, the run id or the claim id; one lease per subject.
CREATE TABLE morrow_work.work_leases (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL CHECK (id::text ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'),
 generation morrow_work.revision NOT NULL,
 kind text NOT NULL CHECK (kind IN ('read','run','operation')),
 subject_id morrow_work.record_id NOT NULL,
 store_id morrow_work.record_id NOT NULL,
 connection_id morrow_work.record_id NOT NULL,
 installation_id morrow_work.record_id,
 initiator_principal_id morrow_work.record_id NOT NULL,
 initiator_membership_id morrow_work.record_id NOT NULL,
 status text NOT NULL CHECK (status IN ('active','released','revoked')),
 revoked_reason text CHECK (revoked_reason IN ('stop','membership')),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 expires_at timestamptz NOT NULL,
 started_at timestamptz CHECK (started_at=date_trunc('milliseconds',started_at) AND isfinite(started_at)),
 ended_at timestamptz CHECK (ended_at=date_trunc('milliseconds',ended_at) AND isfinite(ended_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,initiator_membership_id,initiator_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,initiator_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 -- An agent installation is named by run and operation leases, never by a read.
 CONSTRAINT work_leases_installation CHECK ((kind='read')=(installation_id IS NULL)),
 CONSTRAINT work_leases_term CHECK (expires_at=created_at+CASE kind WHEN 'read' THEN interval '60 seconds'
  WHEN 'run' THEN interval '30 minutes' ELSE interval '15 minutes' END),
 CONSTRAINT work_leases_status CHECK ((status='active')=(ended_at IS NULL) AND (status='revoked')=(revoked_reason IS NOT NULL)),
 CONSTRAINT work_leases_times CHECK ((started_at IS NULL OR started_at>=created_at) AND (ended_at IS NULL OR ended_at>=created_at))
);
CREATE UNIQUE INDEX work_leases_id ON morrow_work.work_leases (id);
CREATE UNIQUE INDEX work_leases_subject ON morrow_work.work_leases (organization_id,workspace_id,kind,subject_id);
CREATE INDEX work_leases_pending ON morrow_work.work_leases (created_at,id) WHERE status='active' AND started_at IS NULL AND kind IN ('run','operation');
CREATE INDEX work_leases_active_connection ON morrow_work.work_leases (organization_id,workspace_id,connection_id) WHERE status='active';
CREATE INDEX work_leases_active_installation ON morrow_work.work_leases (organization_id,workspace_id,installation_id) WHERE status='active';

-- The stop state (P11.T05a; ADR-0022 item 15). One row per stop; a lift sets the lifted_*
-- columns once and only a person lifts (a human member, or the operator by script).
-- Platform rows have null tenant keys, are visible to every tenant and are written only
-- by the owner's script (platform_stop_set). Installation and connection rows name their
-- store and target. Human kill switches set rows with set_by_kind 'human' through their
-- own commands (KillSwitchRecord, later packets); system and operator events also write
-- a stop_records row (StopRecord@1).
CREATE TABLE morrow_work.stop_controls (
 organization_id morrow_work.record_id,
 workspace_id morrow_work.record_id,
 id morrow_work.record_id NOT NULL PRIMARY KEY,
 scope text NOT NULL CHECK (scope IN ('platform','installation','connection')),
 store_id morrow_work.record_id,
 target_id morrow_work.record_id,
 set_by_kind text NOT NULL CHECK (set_by_kind IN ('human','system','operator')),
 set_by_principal_id morrow_work.record_id,
 set_by_membership_id morrow_work.record_id,
 set_by_operator_id morrow_work.record_id,
 reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1024 AND reason ~ '\S'),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 lifted_at timestamptz CHECK (lifted_at=date_trunc('milliseconds',lifted_at) AND isfinite(lifted_at)),
 lifted_by_kind text CHECK (lifted_by_kind IN ('human','operator')),
 lifted_by_principal_id morrow_work.record_id,
 lifted_by_membership_id morrow_work.record_id,
 lifted_by_operator_id morrow_work.record_id,
 UNIQUE (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,set_by_membership_id,set_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,set_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 FOREIGN KEY (organization_id,lifted_by_membership_id,lifted_by_principal_id) REFERENCES morrow_identity.memberships(organization_id,id,principal_id),
 FOREIGN KEY (workspace_id,lifted_by_membership_id) REFERENCES morrow_identity.workspace_memberships(workspace_id,membership_id),
 CONSTRAINT stop_controls_scope CHECK (CASE WHEN scope='platform' THEN organization_id IS NULL AND workspace_id IS NULL
   AND store_id IS NULL AND target_id IS NULL AND set_by_kind='operator' AND lifted_by_kind IS DISTINCT FROM 'human'
  ELSE organization_id IS NOT NULL AND workspace_id IS NOT NULL AND store_id IS NOT NULL AND target_id IS NOT NULL END),
 CONSTRAINT stop_controls_setter CHECK (CASE set_by_kind
  WHEN 'human' THEN set_by_principal_id IS NOT NULL AND set_by_membership_id IS NOT NULL AND set_by_operator_id IS NULL
  WHEN 'operator' THEN set_by_principal_id IS NULL AND set_by_membership_id IS NULL AND set_by_operator_id IS NOT NULL
  ELSE set_by_principal_id IS NULL AND set_by_membership_id IS NULL AND set_by_operator_id IS NULL END),
 CONSTRAINT stop_controls_lifter CHECK (CASE WHEN lifted_at IS NULL THEN lifted_by_kind IS NULL AND lifted_by_principal_id IS NULL
   AND lifted_by_membership_id IS NULL AND lifted_by_operator_id IS NULL
  WHEN lifted_by_kind='human' THEN lifted_by_principal_id IS NOT NULL AND lifted_by_membership_id IS NOT NULL AND lifted_by_operator_id IS NULL
  WHEN lifted_by_kind='operator' THEN lifted_by_principal_id IS NULL AND lifted_by_membership_id IS NULL AND lifted_by_operator_id IS NOT NULL
  ELSE false END),
 CONSTRAINT stop_controls_times CHECK (lifted_at IS NULL OR lifted_at>=created_at)
);
CREATE UNIQUE INDEX stop_controls_one_platform ON morrow_work.stop_controls (scope) WHERE scope='platform' AND lifted_at IS NULL;
CREATE UNIQUE INDEX stop_controls_one_per_target ON morrow_work.stop_controls (organization_id,workspace_id,scope,target_id) WHERE scope<>'platform' AND lifted_at IS NULL;

-- StopRecord@1: the append-only, content-free record of a system or operator stop event.
-- A set record repeats its control's scope, target, actor and reason; only an operator
-- (a person, by script) lifts, so a lift record is always an operator's.
CREATE TABLE morrow_work.stop_records (
 organization_id morrow_work.record_id,
 workspace_id morrow_work.record_id,
 id morrow_work.record_id NOT NULL PRIMARY KEY,
 stop_control_id morrow_work.record_id NOT NULL REFERENCES morrow_work.stop_controls(id),
 action text NOT NULL CHECK (action IN ('set','lift')),
 scope text NOT NULL CHECK (scope IN ('platform','installation','connection')),
 store_id morrow_work.record_id,
 target_id morrow_work.record_id,
 actor_kind text NOT NULL CHECK (actor_kind IN ('system','operator')),
 operator_id morrow_work.record_id,
 reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1024 AND reason ~ '\S'),
 recorded_at timestamptz NOT NULL CHECK (recorded_at=date_trunc('milliseconds',recorded_at) AND recorded_at>=timestamptz '2000-01-01T00:00:00Z' AND recorded_at<timestamptz '9000-01-01T00:00:00Z'),
 UNIQUE (stop_control_id,action),
 UNIQUE (organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,stop_control_id) REFERENCES morrow_work.stop_controls(organization_id,workspace_id,id),
 CONSTRAINT stop_records_scope CHECK (CASE WHEN scope='platform' THEN organization_id IS NULL AND workspace_id IS NULL
   AND store_id IS NULL AND target_id IS NULL
  ELSE organization_id IS NOT NULL AND workspace_id IS NOT NULL AND store_id IS NOT NULL AND target_id IS NOT NULL END),
 CONSTRAINT stop_records_actor CHECK ((actor_kind='operator')=(operator_id IS NOT NULL) AND (action='set' OR actor_kind='operator'))
);

-- The OperationLedger (P06.T01c minimum; spine §8). One row per approved target of a
-- claim (catalog_write: claim, proposal, approval and lease columns set), or one taskless
-- billing operation (stripe_write, governance.billing.manage; ADR-0022 item 2). Status
-- changes follow the operation rows of transition_rules, each one recorded in
-- operation_transitions. The send fence (send_started_at, attempt) is set once, under the
-- row lock, while dispatching.
CREATE TABLE morrow_work.operations (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 kind text NOT NULL CHECK (kind IN ('catalog_write','stripe_write')),
 capability_id text NOT NULL CHECK (char_length(capability_id)<=128 AND capability_id ~ '^[a-z]+(\.[a-z_]+)+$'),
 task_id morrow_work.record_id,
 store_id morrow_work.record_id,
 connection_id morrow_work.record_id,
 target_index integer CHECK (target_index BETWEEN 0 AND 99),
 target_resource_id morrow_work.record_id CHECK (target_resource_id::text ~ '^product:[1-9][0-9]{0,19}$'),
 proposal_id morrow_work.record_id,
 proposal_digest morrow_work.digest,
 approval_id morrow_work.record_id,
 approval_revision morrow_work.revision,
 approval_digest morrow_work.digest,
 claim_family_root_id morrow_work.record_id,
 lease_id morrow_work.record_id,
 status text NOT NULL CHECK (status IN ('planned','awaiting_approval','authorized','reserved','dispatching','submitted','verifying',
  'verified','rejected','conflict','failed','uncertain','cancel_requested','cancelled')),
 request_digest morrow_work.digest NOT NULL,
 attempt integer NOT NULL CHECK (attempt BETWEEN 0 AND 100),
 send_started_at timestamptz CHECK (send_started_at=date_trunc('milliseconds',send_started_at) AND isfinite(send_started_at)),
 submitted_at timestamptz CHECK (submitted_at=date_trunc('milliseconds',submitted_at) AND isfinite(submitted_at)),
 provider_request_id text CHECK (char_length(provider_request_id) BETWEEN 1 AND 1024),
 uncertainty_reason text CHECK (uncertainty_reason IN ('transport_after_dispatch','provider_job_pending','partial_result',
  'verification_unavailable','unknown_submission')),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id,id),
 UNIQUE (organization_id,workspace_id,claim_family_root_id,target_index),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 FOREIGN KEY (organization_id,workspace_id,task_id) REFERENCES morrow_work.tasks(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,proposal_id,proposal_digest) REFERENCES morrow_work.proposals(organization_id,workspace_id,id,digest),
 FOREIGN KEY (organization_id,workspace_id,approval_id) REFERENCES morrow_work.approvals(organization_id,workspace_id,id),
 FOREIGN KEY (organization_id,workspace_id,claim_family_root_id) REFERENCES morrow_work.approval_claims(organization_id,workspace_id,family_root_id),
 FOREIGN KEY (organization_id,workspace_id,lease_id) REFERENCES morrow_work.work_leases(organization_id,workspace_id,id),
 CONSTRAINT operations_kind CHECK (CASE kind
  WHEN 'catalog_write' THEN capability_id='catalog.content.publish' AND task_id IS NOT NULL AND store_id IS NOT NULL
   AND connection_id IS NOT NULL AND target_index IS NOT NULL AND target_resource_id IS NOT NULL AND proposal_id IS NOT NULL
   AND proposal_digest IS NOT NULL AND approval_id IS NOT NULL AND approval_revision IS NOT NULL AND approval_digest IS NOT NULL
   AND claim_family_root_id IS NOT NULL AND lease_id IS NOT NULL
  ELSE capability_id='governance.billing.manage' AND store_id IS NULL AND connection_id IS NULL AND target_index IS NULL
   AND target_resource_id IS NULL AND proposal_id IS NULL AND proposal_digest IS NULL AND approval_id IS NULL
   AND approval_revision IS NULL AND approval_digest IS NULL AND claim_family_root_id IS NULL AND lease_id IS NULL END),
 CONSTRAINT operations_uncertain CHECK (status<>'uncertain' OR uncertainty_reason IS NOT NULL),
 CONSTRAINT operations_fence CHECK ((send_started_at IS NULL)=(attempt=0) AND (submitted_at IS NULL OR send_started_at IS NOT NULL)),
 CONSTRAINT operations_times CHECK (updated_at>=created_at AND (send_started_at IS NULL OR send_started_at>=created_at)
  AND (submitted_at IS NULL OR submitted_at>=send_started_at))
);
CREATE INDEX operations_lease ON morrow_work.operations (organization_id,workspace_id,lease_id);
CREATE INDEX operations_task ON morrow_work.operations (organization_id,workspace_id,task_id,created_at,id);

-- One row per status change, carrying the transition_rules edge it used (FK) and, for
-- background changes, the lease it ran under. Append-only, content-free.
CREATE TABLE morrow_work.operation_transitions (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 operation_id morrow_work.record_id NOT NULL,
 revision morrow_work.revision NOT NULL,
 machine text NOT NULL CHECK (machine='operation'),
 from_status text NOT NULL,
 to_status text NOT NULL,
 actor text NOT NULL,
 guard text NOT NULL,
 reason text CHECK (reason ~ '^[a-z][a-z0-9_]{2,63}$'),
 lease_id morrow_work.record_id,
 occurred_at timestamptz NOT NULL CHECK (occurred_at=date_trunc('milliseconds',occurred_at) AND occurred_at>=timestamptz '2000-01-01T00:00:00Z' AND occurred_at<timestamptz '9000-01-01T00:00:00Z'),
 PRIMARY KEY (organization_id,workspace_id,operation_id,revision),
 FOREIGN KEY (organization_id,workspace_id,operation_id) REFERENCES morrow_work.operations(organization_id,workspace_id,id),
 FOREIGN KEY (machine,from_status,to_status,actor,guard) REFERENCES morrow_work.transition_rules(machine,from_status,to_status,actor,guard),
 FOREIGN KEY (organization_id,workspace_id,lease_id) REFERENCES morrow_work.work_leases(organization_id,workspace_id,id)
);

-- The server-held billing route of one workspace (ADR-0015 item 2; WorkspaceBillingRoute
-- billing v1.1; P01.T04a §3 R1-R4 and §8.1). Written in the creating transaction (the
-- 0021 signup bridge) or backfilled; a missing row reads as origin shopify_install
-- (R1, fail closed). origin never changes; shopify_bound_at is set at most once, only
-- while no route is fixed, and never cleared; the route is fixed at most once, with its
-- mode, time and payment key, and never changes. One event per revision.
CREATE TABLE morrow_billing.workspace_billing_routes (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 origin text NOT NULL CHECK (origin IN ('website','shopify_install')),
 shopify_bound_at timestamptz CHECK (shopify_bound_at=date_trunc('milliseconds',shopify_bound_at) AND isfinite(shopify_bound_at)),
 route text CHECK (route IN ('morrow_direct','shopify_app_pricing')),
 mode text CHECK (mode IN ('live','test')),
 route_fixed_at timestamptz CHECK (route_fixed_at=date_trunc('milliseconds',route_fixed_at) AND isfinite(route_fixed_at)),
 fixing_payment_key text,
 revision morrow_work.revision NOT NULL,
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 updated_at timestamptz NOT NULL CHECK (updated_at=date_trunc('milliseconds',updated_at) AND isfinite(updated_at)),
 PRIMARY KEY (organization_id,workspace_id),
 UNIQUE (workspace_id),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 -- The three WorkspaceBillingRoute variants.
 CONSTRAINT workspace_billing_routes_variant CHECK (CASE
  WHEN route IS NULL THEN mode IS NULL AND route_fixed_at IS NULL AND fixing_payment_key IS NULL
  WHEN route='morrow_direct' THEN origin='website' AND shopify_bound_at IS NULL AND mode IS NOT NULL AND route_fixed_at IS NOT NULL
   AND fixing_payment_key IS NOT NULL AND fixing_payment_key ~ '^stripe:invoice:in_[A-Za-z0-9]{8,100}$'
  ELSE shopify_bound_at IS NOT NULL AND mode IS NOT NULL AND route_fixed_at IS NOT NULL AND fixing_payment_key IS NOT NULL
   AND fixing_payment_key ~ '^shopify:app:(0|[1-9][0-9]{0,19}):shop:(0|[1-9][0-9]{0,19}):cycle:[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$' END),
 CONSTRAINT workspace_billing_routes_times CHECK (updated_at>=created_at AND (route_fixed_at IS NULL OR route_fixed_at>=created_at))
);

-- The broker vault (ADR-0022 item 7). Each row is an AES-256-GCM envelope: wrapped_key
-- is the 32-byte data key sealed under the versioned KEK (12-byte IV, ciphertext, 16-byte
-- tag), sealed_value the secret sealed under that data key (IV, ciphertext, tag). The KEK
-- lives only in broker secrets; the broker builds the AAD from its environment and the
-- row (scope, record id, provider, version, KEK version), so no row is portable across
-- environments, records or versions. A retired or destroyed row keeps only metadata.
-- Platform: one row per Shopify app client secret and version (owner-run script).
CREATE TABLE morrow_vault.app_secrets (
 app_key text NOT NULL CHECK (app_key ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
 version morrow_work.revision NOT NULL,
 provider text NOT NULL CHECK (provider='shopify'),
 status text NOT NULL CHECK (status IN ('active','retired')),
 kek_version integer NOT NULL CHECK (kek_version BETWEEN 1 AND 999),
 wrapped_key bytea CHECK (octet_length(wrapped_key)=60),
 sealed_value bytea CHECK (octet_length(sealed_value) BETWEEN 29 AND 4124),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 retired_at timestamptz CHECK (retired_at=date_trunc('milliseconds',retired_at) AND isfinite(retired_at)),
 PRIMARY KEY (app_key,version),
 CONSTRAINT app_secrets_material CHECK ((status='active')=(wrapped_key IS NOT NULL) AND (wrapped_key IS NULL)=(sealed_value IS NULL)
  AND (status='active')=(retired_at IS NULL) AND (retired_at IS NULL OR retired_at>=created_at))
);
CREATE UNIQUE INDEX app_secrets_one_active ON morrow_vault.app_secrets (app_key) WHERE status='active';
-- Tenant-keyed: one Shopify offline token per store installation (subject) and version;
-- re-authorisation adds a version and destroys the old one, and uninstall or disconnect
-- destroys the active one at once (ADR-0022 item 13). Writers land with M2 PR-2/PR-3.
CREATE TABLE morrow_vault.credentials (
 organization_id morrow_work.record_id NOT NULL,
 workspace_id morrow_work.record_id NOT NULL,
 id morrow_work.record_id NOT NULL,
 version morrow_work.revision NOT NULL,
 provider text NOT NULL CHECK (provider='shopify'),
 kind text NOT NULL CHECK (kind='shopify_offline_token'),
 subject_id morrow_work.record_id NOT NULL,
 status text NOT NULL CHECK (status IN ('active','destroyed')),
 kek_version integer NOT NULL CHECK (kek_version BETWEEN 1 AND 999),
 wrapped_key bytea CHECK (octet_length(wrapped_key)=60),
 sealed_value bytea CHECK (octet_length(sealed_value) BETWEEN 29 AND 4124),
 created_at timestamptz NOT NULL CHECK (created_at=date_trunc('milliseconds',created_at) AND created_at>=timestamptz '2000-01-01T00:00:00Z' AND created_at<timestamptz '9000-01-01T00:00:00Z'),
 destroyed_at timestamptz CHECK (destroyed_at=date_trunc('milliseconds',destroyed_at) AND isfinite(destroyed_at)),
 destroy_reason text CHECK (destroy_reason IN ('uninstalled','disconnected','reauthorised')),
 PRIMARY KEY (organization_id,workspace_id,id,version),
 FOREIGN KEY (organization_id,workspace_id) REFERENCES morrow_identity.workspaces(organization_id,id),
 CONSTRAINT credentials_material CHECK ((status='active')=(wrapped_key IS NOT NULL) AND (wrapped_key IS NULL)=(sealed_value IS NULL)
  AND (status='active')=(destroyed_at IS NULL) AND (status='active')=(destroy_reason IS NULL) AND (destroyed_at IS NULL OR destroyed_at>=created_at))
);
CREATE UNIQUE INDEX credentials_one_active ON morrow_vault.credentials (organization_id,workspace_id,id) WHERE status='active';
CREATE UNIQUE INDEX credentials_one_active_subject ON morrow_vault.credentials (organization_id,workspace_id,subject_id) WHERE status='active';

-- ---------------------------------------------------------------------------
-- Row security. Every table: ENABLE + FORCE and the maintenance-only owner policy.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['morrow_work.work_leases','morrow_work.stop_controls','morrow_work.stop_records','morrow_work.operations',
  'morrow_work.operation_transitions','morrow_billing.workspace_billing_routes','morrow_vault.app_secrets','morrow_vault.credentials'] LOOP
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY work_owner ON %s TO morrow_work_owner USING (true) WITH CHECK (true)',t);
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC',t);
 END LOOP;
END $$;

-- The lease context: a transaction-local setting that only enter_lease writes and only
-- this resolver reads. Every evaluation re-resolves it: the session user is exactly the
-- runtime executor (and passes the ADR-0020 guard), no session context is set, the
-- setting was made in this transaction, and the lease is active, unexpired, of the
-- named generation, with its initiating member still current. A forged, stale,
-- foreign-session or cross-role setting therefore yields zero rows.
CREATE FUNCTION morrow_work.current_lease()
RETURNS TABLE(organization_id text,workspace_id text,lease_id text,generation bigint,kind text,subject_id text,store_id text,
 connection_id text,installation_id text,initiator_principal_id text,initiator_membership_id text,expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 v_id text:=pg_catalog.current_setting('morrow.work_lease_id',true);
 v_generation text:=pg_catalog.current_setting('morrow.work_lease_generation',true);
 v_entered text:=pg_catalog.current_setting('morrow.work_lease_entered',true);
BEGIN
 IF COALESCE(v_id,'')='' OR COALESCE(v_generation,'')=''
  OR v_entered IS DISTINCT FROM ((extract(epoch FROM pg_catalog.transaction_timestamp())*1000000)::bigint::text||':'||pg_catalog.pg_backend_pid()::text)
  OR COALESCE(pg_catalog.current_setting('morrow.work_session_digest',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_workspace',true),'')<>'' THEN
  RETURN;
 END IF;
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor') THEN RETURN; END IF;
 RETURN QUERY SELECT l.organization_id::text,l.workspace_id::text,l.id::text,l.generation::bigint,l.kind,l.subject_id::text,
  l.store_id::text,l.connection_id::text,l.installation_id::text,l.initiator_principal_id::text,l.initiator_membership_id::text,l.expires_at
  FROM morrow_work.work_leases l
  WHERE l.id=v_id AND l.generation::text=v_generation AND l.status='active' AND l.expires_at>pg_catalog.clock_timestamp()
   AND morrow_identity.work_lease_member_current(l.organization_id,l.workspace_id,l.initiator_principal_id,l.initiator_membership_id);
END $$;
REVOKE ALL ON FUNCTION morrow_work.current_lease() FROM PUBLIC;

-- Policies. tenant_command and tenant_read are the P06.T01a template (session context,
-- current_tenant()); tenant_lease is its lease-context twin (current_lease()). Stop rows
-- with null tenant keys are platform stops, readable in every context and written only
-- by the owner. work_leases is read in the runtime context only through lease_self (the
-- entered lease) and lease_pending (the ids pending_starts() returns). The vault is
-- visible only while the session user is the broker's login.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['work_leases','operations','operation_transitions'] LOOP
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['operations','operation_transitions'] LOOP
  EXECUTE format('CREATE POLICY tenant_lease ON morrow_work.%I TO morrow_work_command
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
  EXECUTE format('CREATE POLICY tenant_read ON morrow_work.%I FOR SELECT TO morrow_work_api
   USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['stop_controls','stop_records'] LOOP
  EXECUTE format('CREATE POLICY tenant_command ON morrow_work.%I TO morrow_work_command
   USING (organization_id IS NULL OR (organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
   WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
  EXECUTE format('CREATE POLICY tenant_lease ON morrow_work.%I FOR SELECT TO morrow_work_command
   USING (organization_id IS NULL OR (organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_lease() c))',t);
  EXECUTE format('CREATE POLICY tenant_read ON morrow_work.%I FOR SELECT TO morrow_work_api
   USING (organization_id IS NULL OR (organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['app_secrets','credentials'] LOOP
  EXECUTE format('CREATE POLICY vault_broker ON morrow_vault.%I TO morrow_work_command
   USING (session_user=''morrow_vault_broker'') WITH CHECK (session_user=''morrow_vault_broker'')',t);
 END LOOP;
END $$;
CREATE POLICY lease_self ON morrow_work.work_leases TO morrow_work_command
 USING (session_user='morrow_runtime_executor' AND id::text=pg_catalog.current_setting('morrow.work_lease_id',true))
 WITH CHECK (session_user='morrow_runtime_executor' AND id::text=pg_catalog.current_setting('morrow.work_lease_id',true));
CREATE POLICY lease_pending ON morrow_work.work_leases FOR SELECT TO morrow_work_command
 USING (session_user='morrow_runtime_executor' AND status='active' AND started_at IS NULL AND kind IN ('run','operation'));
CREATE POLICY tenant_command ON morrow_billing.workspace_billing_routes TO morrow_work_command
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c))
 WITH CHECK ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
CREATE POLICY tenant_read ON morrow_billing.workspace_billing_routes FOR SELECT TO morrow_work_api
 USING ((organization_id::text,workspace_id::text)=(SELECT c.organization_id,c.workspace_id FROM morrow_work.current_tenant() c));
-- The signup bridge (record_signup_route) inserts only an unfixed website row.
CREATE POLICY route_signup ON morrow_billing.workspace_billing_routes FOR INSERT TO morrow_work_command
 WITH CHECK (origin='website' AND route IS NULL AND mode IS NULL AND route_fixed_at IS NULL AND fixing_payment_key IS NULL AND revision=1);

-- Runtime privileges: table SELECT and INSERT, column-scoped UPDATE, never DELETE or
-- TRUNCATE. The api role reads the tenant-readable tables column by column.
GRANT SELECT,INSERT ON morrow_work.work_leases,morrow_work.stop_controls,morrow_work.stop_records,morrow_work.operations,
 morrow_work.operation_transitions,morrow_billing.workspace_billing_routes TO morrow_work_command;
GRANT UPDATE (status,ended_at,revoked_reason,started_at) ON morrow_work.work_leases TO morrow_work_command;
GRANT UPDATE (lifted_at,lifted_by_kind,lifted_by_principal_id,lifted_by_membership_id,lifted_by_operator_id) ON morrow_work.stop_controls TO morrow_work_command;
GRANT UPDATE (status,revision,updated_at,attempt,send_started_at,submitted_at,provider_request_id,uncertainty_reason) ON morrow_work.operations TO morrow_work_command;
GRANT SELECT ON morrow_vault.app_secrets,morrow_vault.credentials TO morrow_work_command;
GRANT SELECT (organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,set_by_membership_id,set_by_operator_id,
 reason_code,reason,created_at,lifted_at,lifted_by_kind,lifted_by_principal_id,lifted_by_membership_id,lifted_by_operator_id)
 ON morrow_work.stop_controls TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,stop_control_id,action,scope,store_id,target_id,actor_kind,operator_id,reason_code,reason,recorded_at)
 ON morrow_work.stop_records TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,id,revision,kind,capability_id,task_id,store_id,connection_id,target_index,target_resource_id,
 proposal_id,proposal_digest,approval_id,approval_revision,approval_digest,claim_family_root_id,lease_id,status,request_digest,attempt,
 send_started_at,submitted_at,provider_request_id,uncertainty_reason,created_at,updated_at) ON morrow_work.operations TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,operation_id,revision,machine,from_status,to_status,actor,guard,reason,lease_id,occurred_at)
 ON morrow_work.operation_transitions TO morrow_work_api;
GRANT SELECT (organization_id,workspace_id,origin,shopify_bound_at,route,mode,route_fixed_at,fixing_payment_key,revision,created_at,updated_at)
 ON morrow_billing.workspace_billing_routes TO morrow_work_api;

-- ---------------------------------------------------------------------------
-- Triggers: INVOKER, owned by the owner, granted to nobody. They run with the writer's
-- privileges under its policies and raise a fixed code.
-- Leases: born active at generation 1; afterwards only started_at (once, while active)
-- and the one terminal change (released, or revoked with a reason) are allowed.
CREATE FUNCTION morrow_work.lease_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['status','ended_at','revoked_reason','started_at'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.generation<>1 OR NEW.status<>'active' OR NEW.started_at IS NOT NULL OR NEW.ended_at IS NOT NULL OR NEW.revoked_reason IS NOT NULL THEN
   RAISE EXCEPTION 'WORK_LEASE_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'active'
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR (NEW.started_at IS DISTINCT FROM OLD.started_at AND (OLD.started_at IS NOT NULL OR NEW.status<>'active'))
  OR (NEW.status='active' AND (NEW.ended_at IS NOT NULL OR NEW.revoked_reason IS NOT NULL)) THEN
  RAISE EXCEPTION 'WORK_LEASE_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- A stop takes the stop interlock exclusively (the platform key, or its store's key) and
-- revokes every matching active lease in the same statement. lease_open takes both keys
-- shared before it reads the stops, so a lease is either refused by a committed stop or
-- committed before the stop and revoked by it. A platform stop revokes run and operation
-- leases, a connection stop every lease on that connection, an installation stop the run
-- and operation leases of that installation. Afterwards only one lift is allowed.
CREATE FUNCTION morrow_work.stop_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_lift text[]:=ARRAY['lifted_at','lifted_by_kind','lifted_by_principal_id','lifted_by_membership_id','lifted_by_operator_id'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.lifted_at IS NOT NULL THEN RAISE EXCEPTION 'WORK_STOP_INVALID'; END IF;
  IF NEW.scope='platform' THEN
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
   UPDATE morrow_work.work_leases l SET status='revoked',revoked_reason='stop',
    ended_at=greatest(date_trunc('milliseconds',clock_timestamp()),l.created_at)
    WHERE l.status='active' AND l.kind IN ('run','operation');
  ELSE
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
    NEW.organization_id::text,NEW.workspace_id::text,NEW.store_id::text)::text,0));
   UPDATE morrow_work.work_leases l SET status='revoked',revoked_reason='stop',
    ended_at=greatest(date_trunc('milliseconds',clock_timestamp()),l.created_at)
    WHERE l.status='active' AND l.organization_id=NEW.organization_id AND l.workspace_id=NEW.workspace_id
     AND ((NEW.scope='connection' AND l.connection_id=NEW.target_id)
      OR (NEW.scope='installation' AND l.installation_id=NEW.target_id AND l.kind IN ('run','operation')));
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.lifted_at IS NULL AND NEW.lifted_at IS NOT NULL
  AND (to_jsonb(NEW)-v_lift) IS NOT DISTINCT FROM (to_jsonb(OLD)-v_lift) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'WORK_STOP_INVALID';
END $$;
-- A stop record matches its control: a set record repeats the control's scope, target,
-- setter and reason; a lift record follows the control's operator lift.
CREATE FUNCTION morrow_work.stop_record_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE c record;
BEGIN
 SELECT s.* INTO c FROM morrow_work.stop_controls s WHERE s.id=NEW.stop_control_id;
 IF NOT FOUND OR c.organization_id IS DISTINCT FROM NEW.organization_id OR c.workspace_id IS DISTINCT FROM NEW.workspace_id
  OR c.scope<>NEW.scope OR c.store_id IS DISTINCT FROM NEW.store_id OR c.target_id IS DISTINCT FROM NEW.target_id
  OR (NEW.action='set' AND (c.set_by_kind<>NEW.actor_kind OR c.set_by_operator_id IS DISTINCT FROM NEW.operator_id
   OR c.reason_code<>NEW.reason_code OR c.reason<>NEW.reason OR NEW.recorded_at<>c.created_at))
  OR (NEW.action='lift' AND (c.lifted_at IS NULL OR c.lifted_by_kind IS DISTINCT FROM 'operator'
   OR c.lifted_by_operator_id IS DISTINCT FROM NEW.operator_id OR NEW.recorded_at<>c.lifted_at)) THEN
  RAISE EXCEPTION 'WORK_STOP_RECORD_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Operations: born planned at revision 1. Each update is revision+1 and changes only the
-- mutable columns; a status change needs its operation_transitions row at the new
-- revision; the send fence is set once, while dispatching, with exactly one more
-- attempt; leaving dispatching for submitted or uncertain needs the fence (a send
-- happened or may have happened); submitted_at is set on entering submitted; the
-- provider request id is set once; the uncertainty reason changes only on entering
-- uncertain.
CREATE FUNCTION morrow_work.operation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE v_mutable text[]:=ARRAY['status','revision','updated_at','attempt','send_started_at','submitted_at','provider_request_id','uncertainty_reason'];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.status<>'planned' OR NEW.attempt<>0 OR NEW.send_started_at IS NOT NULL OR NEW.submitted_at IS NOT NULL
   OR NEW.provider_request_id IS NOT NULL OR NEW.uncertainty_reason IS NOT NULL OR NEW.updated_at<>NEW.created_at THEN
   RAISE EXCEPTION 'WORK_OPERATION_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.revision IS DISTINCT FROM OLD.revision+1 OR NEW.updated_at<OLD.updated_at
  OR (to_jsonb(NEW)-v_mutable) IS DISTINCT FROM (to_jsonb(OLD)-v_mutable)
  OR (NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS(SELECT 1 FROM morrow_work.operation_transitions t
   WHERE t.organization_id=NEW.organization_id AND t.workspace_id=NEW.workspace_id AND t.operation_id=NEW.id AND t.revision=NEW.revision
   AND t.from_status=OLD.status AND t.to_status=NEW.status))
  OR (NEW.send_started_at IS DISTINCT FROM OLD.send_started_at AND (OLD.send_started_at IS NOT NULL OR OLD.status<>'dispatching'
   OR NEW.status<>'dispatching' OR NEW.attempt<>OLD.attempt+1))
  OR (NEW.send_started_at IS NOT DISTINCT FROM OLD.send_started_at AND NEW.attempt<>OLD.attempt)
  OR (OLD.status='dispatching' AND NEW.status IN ('submitted','uncertain') AND OLD.send_started_at IS NULL)
  OR (NEW.submitted_at IS DISTINCT FROM OLD.submitted_at AND (OLD.submitted_at IS NOT NULL OR OLD.status<>'dispatching' OR NEW.status<>'submitted'))
  OR (OLD.status='dispatching' AND NEW.status='submitted' AND NEW.submitted_at IS NULL)
  OR (NEW.provider_request_id IS DISTINCT FROM OLD.provider_request_id AND OLD.provider_request_id IS NOT NULL)
  OR (NEW.uncertainty_reason IS DISTINCT FROM OLD.uncertainty_reason AND NOT (NEW.status='uncertain' AND OLD.status<>'uncertain')) THEN
  RAISE EXCEPTION 'WORK_OPERATION_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- A transition row starts from the operation's current status at the next revision; its
-- edge is a transition_rules row (the foreign key).
CREATE FUNCTION morrow_work.operation_transition_bind() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE o record;
BEGIN
 SELECT x.status,x.revision::bigint AS revision INTO o FROM morrow_work.operations x
  WHERE x.organization_id=NEW.organization_id AND x.workspace_id=NEW.workspace_id AND x.id=NEW.operation_id;
 IF NOT FOUND OR o.status<>NEW.from_status OR NEW.revision<>o.revision+1 THEN
  RAISE EXCEPTION 'WORK_OPERATION_TRANSITION_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- The billing route (P01.T04a §8.1): no delete or truncate; origin, tenant and creation
-- time never change; a set binding never changes or clears; a fixed route never changes;
-- each update is one event (a binding while unfixed, or the fixing) at revision+1.
CREATE FUNCTION morrow_billing.route_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_bind boolean; v_fix boolean;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.route IS NOT NULL OR NEW.updated_at<>NEW.created_at
   OR (NEW.shopify_bound_at IS NOT NULL AND NEW.shopify_bound_at>NEW.created_at) THEN
   RAISE EXCEPTION 'BILLING_ROUTE_INVALID';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
  OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR (OLD.shopify_bound_at IS NOT NULL AND NEW.shopify_bound_at IS DISTINCT FROM OLD.shopify_bound_at)
  OR (OLD.route IS NOT NULL AND (NEW.route,NEW.mode,NEW.route_fixed_at,NEW.fixing_payment_key)
   IS DISTINCT FROM (OLD.route,OLD.mode,OLD.route_fixed_at,OLD.fixing_payment_key)) THEN
  RAISE EXCEPTION 'BILLING_ROUTE_IMMUTABLE';
 END IF;
 v_bind:=OLD.shopify_bound_at IS NULL AND NEW.shopify_bound_at IS NOT NULL;
 v_fix:=OLD.route IS NULL AND NEW.route IS NOT NULL;
 IF v_bind=v_fix OR (v_bind AND OLD.route IS NOT NULL) OR NEW.revision IS DISTINCT FROM OLD.revision+1
  OR NEW.updated_at<OLD.updated_at THEN
  RAISE EXCEPTION 'BILLING_ROUTE_INVALID';
 END IF;
 RETURN NEW;
END $$;
-- Vault rows: born active at the next contiguous version (a credential keeps its subject
-- across versions); the only update is the one-way retirement or destruction that erases
-- the key material; no delete or truncate.
CREATE FUNCTION morrow_vault.vault_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
DECLARE v_previous bigint; v_mutable text[];
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'active' THEN RAISE EXCEPTION 'VAULT_RECORD_INVALID'; END IF;
  IF TG_TABLE_NAME='app_secrets' THEN
   SELECT max(s.version) INTO v_previous FROM morrow_vault.app_secrets s WHERE s.app_key=NEW.app_key;
  ELSE
   IF EXISTS(SELECT 1 FROM morrow_vault.credentials c WHERE c.organization_id=NEW.organization_id AND c.workspace_id=NEW.workspace_id
     AND c.id=NEW.id AND (c.subject_id<>NEW.subject_id OR c.kind<>NEW.kind OR c.provider<>NEW.provider)) THEN
    RAISE EXCEPTION 'VAULT_RECORD_INVALID';
   END IF;
   SELECT max(c.version) INTO v_previous FROM morrow_vault.credentials c
    WHERE c.organization_id=NEW.organization_id AND c.workspace_id=NEW.workspace_id AND c.id=NEW.id;
  END IF;
  IF NEW.version<>COALESCE(v_previous,0)+1 THEN RAISE EXCEPTION 'VAULT_RECORD_INVALID'; END IF;
  RETURN NEW;
 END IF;
 v_mutable:=CASE TG_TABLE_NAME WHEN 'app_secrets' THEN ARRAY['status','wrapped_key','sealed_value','retired_at']
  ELSE ARRAY['status','wrapped_key','sealed_value','destroyed_at','destroy_reason'] END;
 IF TG_OP='UPDATE' AND OLD.status='active' AND NEW.status<>'active' AND NEW.wrapped_key IS NULL AND NEW.sealed_value IS NULL
  AND (to_jsonb(NEW)-v_mutable) IS NOT DISTINCT FROM (to_jsonb(OLD)-v_mutable) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'VAULT_RECORD_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION morrow_work.lease_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.stop_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.stop_record_bind() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.operation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.operation_transition_bind() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_billing.route_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_vault.vault_guard() FROM PUBLIC;
CREATE TRIGGER lease_guard BEFORE INSERT OR UPDATE ON morrow_work.work_leases FOR EACH ROW EXECUTE FUNCTION morrow_work.lease_guard();
CREATE TRIGGER stop_guard BEFORE INSERT OR UPDATE ON morrow_work.stop_controls FOR EACH ROW EXECUTE FUNCTION morrow_work.stop_guard();
CREATE TRIGGER stop_record_bind BEFORE INSERT ON morrow_work.stop_records FOR EACH ROW EXECUTE FUNCTION morrow_work.stop_record_bind();
CREATE TRIGGER operation_guard BEFORE INSERT OR UPDATE ON morrow_work.operations FOR EACH ROW EXECUTE FUNCTION morrow_work.operation_guard();
CREATE TRIGGER operation_transition_bind BEFORE INSERT ON morrow_work.operation_transitions FOR EACH ROW EXECUTE FUNCTION morrow_work.operation_transition_bind();
CREATE TRIGGER route_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_billing.workspace_billing_routes FOR EACH ROW EXECUTE FUNCTION morrow_billing.route_guard();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_billing.workspace_billing_routes FOR EACH STATEMENT EXECUTE FUNCTION morrow_billing.route_guard();
CREATE TRIGGER vault_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_vault.app_secrets FOR EACH ROW EXECUTE FUNCTION morrow_vault.vault_guard();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_vault.app_secrets FOR EACH STATEMENT EXECUTE FUNCTION morrow_vault.vault_guard();
CREATE TRIGGER vault_guard BEFORE INSERT OR UPDATE OR DELETE ON morrow_vault.credentials FOR EACH ROW EXECUTE FUNCTION morrow_vault.vault_guard();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_vault.credentials FOR EACH STATEMENT EXECUTE FUNCTION morrow_vault.vault_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['stop_records','operation_transitions'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['work_leases','stop_controls','operations'] LOOP
  EXECUTE format('CREATE TRIGGER append_only BEFORE DELETE ON morrow_work.%I FOR EACH ROW EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['work_leases','stop_controls','stop_records','operations','operation_transitions'] LOOP
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON morrow_work.%I FOR EACH STATEMENT EXECUTE FUNCTION morrow_work.append_only()',t);
 END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Helpers: owned by the command role after the transfer below, INVOKER, granted to
-- nobody; they run under the caller's tenant or lease policies.
-- Whether an active stop blocks work of this kind on this connection or installation.
CREATE FUNCTION morrow_work.stop_active(p_org text,p_ws text,p_kind text,p_connection_id text,p_installation_id text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,morrow_work,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM morrow_work.stop_controls s WHERE s.lifted_at IS NULL AND (
  (s.scope='platform' AND p_kind IN ('run','operation'))
  OR (s.scope='connection' AND s.organization_id=p_org AND s.workspace_id=p_ws AND s.target_id=p_connection_id)
  OR (s.scope='installation' AND s.organization_id=p_org AND s.workspace_id=p_ws AND s.target_id=p_installation_id
   AND p_kind IN ('run','operation'))))
$$;
-- Opens a lease for the session's tenant and actor (current_tenant(), session context
-- only), called from an api command's own definer after its prelude, inside the
-- transaction that authorised the work. It takes the stop interlock keys shared, then
-- refuses under any matching stop. Outcomes: opened, invalid, ineligible, stopped,
-- subject_conflict. The lease id is generated here and returned with its generation and
-- expiry; it grants nothing.
CREATE FUNCTION morrow_work.lease_open(p_kind text,p_subject_id text,p_store_id text,p_connection_id text,p_installation_id text)
RETURNS TABLE(outcome text,lease_id text,generation text,expires_at_ms text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 t record; v_id text; v_at timestamptz; v_expires timestamptz;
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN ('read','run','operation')
  OR p_subject_id IS NULL OR p_subject_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_store_id IS NULL OR p_store_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_connection_id IS NULL OR p_connection_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR (p_kind='read' AND p_installation_id IS NOT NULL)
  OR (p_kind<>'read' AND (p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT c.organization_id,c.workspace_id,c.principal_id,c.membership_id INTO t FROM morrow_work.current_tenant() c;
 IF NOT FOUND THEN RETURN QUERY SELECT 'ineligible'::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
 PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop',
  t.organization_id,t.workspace_id,p_store_id)::text,0));
 -- New statements after the locks: READ COMMITTED sees every stop committed meanwhile.
 IF morrow_work.stop_active(t.organization_id,t.workspace_id,p_kind,p_connection_id,p_installation_id) THEN
  RETURN QUERY SELECT 'stopped'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 v_id:=gen_random_uuid()::text;
 v_at:=morrow_work.db_now();
 v_expires:=v_at+CASE p_kind WHEN 'read' THEN interval '60 seconds' WHEN 'run' THEN interval '30 minutes' ELSE interval '15 minutes' END;
 BEGIN
  INSERT INTO morrow_work.work_leases(organization_id,workspace_id,id,generation,kind,subject_id,store_id,connection_id,installation_id,
   initiator_principal_id,initiator_membership_id,status,revoked_reason,created_at,expires_at,started_at,ended_at)
  VALUES (t.organization_id,t.workspace_id,v_id,1,p_kind,p_subject_id,p_store_id,p_connection_id,p_installation_id,
   t.principal_id,t.membership_id,'active',NULL,v_at,v_expires,NULL,NULL);
 EXCEPTION WHEN unique_violation THEN
  RETURN QUERY SELECT 'subject_conflict'::text,NULL::text,NULL::text,NULL::text; RETURN;
 END;
 RETURN QUERY SELECT 'opened'::text,v_id,'1'::text,(extract(epoch FROM v_expires)*1000)::bigint::text;
END $$;
-- One status change of one operation, under its row lock: the expected revision, an
-- edge of transition_rules for (from, to, actor, guard), the transition row first and
-- then the operation row (operation_guard requires both). Called by the consumers'
-- definers in a session or a lease context; the caller's policies bound the rows.
-- Outcomes: applied, invalid, not_found, revision_conflict, state_conflict.
CREATE FUNCTION morrow_work.operation_transition(p_org text,p_ws text,p_operation_id text,p_expected_revision bigint,p_to text,
 p_actor text,p_guard text,p_reason text,p_uncertainty_reason text,p_lease_id text)
RETURNS TABLE(outcome text,revision bigint)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 o record; v_at timestamptz;
BEGIN
 IF p_org IS NULL OR p_ws IS NULL OR p_operation_id IS NULL OR p_expected_revision IS NULL OR p_to IS NULL OR p_actor IS NULL OR p_guard IS NULL
  OR p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR (p_reason IS NOT NULL AND p_reason !~ '^[a-z][a-z0-9_]{2,63}$')
  OR (p_lease_id IS NOT NULL AND p_lease_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  OR ((p_to='uncertain')<>(p_uncertainty_reason IS NOT NULL)) THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::bigint; RETURN;
 END IF;
 SELECT x.status,x.revision::bigint AS revision,x.updated_at INTO o FROM morrow_work.operations x
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_operation_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::bigint; RETURN; END IF;
 IF o.revision<>p_expected_revision THEN RETURN QUERY SELECT 'revision_conflict'::text,o.revision; RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM morrow_work.transition_rules r WHERE r.machine='operation' AND r.from_status=o.status AND r.to_status=p_to
   AND r.actor=p_actor AND r.guard=p_guard) THEN
  RETURN QUERY SELECT 'state_conflict'::text,o.revision; RETURN;
 END IF;
 v_at:=greatest(morrow_work.db_now(),o.updated_at);
 INSERT INTO morrow_work.operation_transitions(organization_id,workspace_id,operation_id,revision,machine,from_status,to_status,actor,guard,reason,lease_id,occurred_at)
  VALUES (p_org,p_ws,p_operation_id,o.revision+1,'operation',o.status,p_to,p_actor,p_guard,p_reason,p_lease_id,v_at);
 UPDATE morrow_work.operations x SET status=p_to,revision=o.revision+1,updated_at=v_at,
  submitted_at=CASE WHEN p_to='submitted' THEN v_at ELSE x.submitted_at END,
  uncertainty_reason=CASE WHEN p_to='uncertain' THEN p_uncertainty_reason ELSE x.uncertainty_reason END
  WHERE x.organization_id=p_org AND x.workspace_id=p_ws AND x.id=p_operation_id;
 RETURN QUERY SELECT 'applied'::text,o.revision+1;
END $$;

-- ---------------------------------------------------------------------------
-- Runtime definers: SECURITY DEFINER, owned by the command role after the transfer,
-- EXECUTE for morrow_runtime_executor only. Each takes ids only; the tenant comes only
-- from the lease.
-- Enters one lease for the rest of the transaction: refused for any other login, when a
-- session or lease context is already set, or when the lease does not resolve through
-- current_lease() or is stopped; a refusal leaves no context. Outcomes: entered,
-- denied, not_found (unknown id or another generation), ended (released or revoked),
-- expired, member_inactive, stopped.
CREATE FUNCTION morrow_work.enter_lease(p_lease_id text,p_generation text)
RETURNS TABLE(outcome text,organization_id text,workspace_id text,kind text,subject_id text,store_id text,connection_id text,
 installation_id text,initiator_principal_id text,initiator_membership_id text,expires_at_ms text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE
 l record; r record; v_outcome text;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor')
  OR COALESCE(pg_catalog.current_setting('morrow.work_session_digest',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_workspace',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_lease_id',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_lease_generation',true),'')<>''
  OR COALESCE(pg_catalog.current_setting('morrow.work_lease_entered',true),'')<>''
  OR p_lease_id IS NULL OR p_lease_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  OR p_generation IS NULL OR p_generation !~ '^[1-9][0-9]{0,15}$' THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 PERFORM pg_catalog.set_config('morrow.work_lease_id',p_lease_id,true),
  pg_catalog.set_config('morrow.work_lease_generation',p_generation,true),
  pg_catalog.set_config('morrow.work_lease_entered',
   (extract(epoch FROM pg_catalog.transaction_timestamp())*1000000)::bigint::text||':'||pg_catalog.pg_backend_pid()::text,true);
 SELECT * INTO l FROM morrow_work.current_lease();
 IF FOUND THEN
  IF NOT morrow_work.stop_active(l.organization_id,l.workspace_id,l.kind,l.connection_id,l.installation_id) THEN
   RETURN QUERY SELECT 'entered'::text,l.organization_id,l.workspace_id,l.kind,l.subject_id,l.store_id,l.connection_id,
    l.installation_id,l.initiator_principal_id,l.initiator_membership_id,(extract(epoch FROM l.expires_at)*1000)::bigint::text;
   RETURN;
  END IF;
  v_outcome:='stopped';
 ELSE
  -- Visible through lease_self while the setting names it; nothing else is read.
  SELECT x.generation::text AS generation,x.status,x.expires_at INTO r FROM morrow_work.work_leases x WHERE x.id=p_lease_id;
  v_outcome:=CASE WHEN NOT FOUND OR r.generation<>p_generation THEN 'not_found' WHEN r.status<>'active' THEN 'ended'
   WHEN r.expires_at<=pg_catalog.clock_timestamp() THEN 'expired' ELSE 'member_inactive' END;
 END IF;
 PERFORM pg_catalog.set_config('morrow.work_lease_id','',true),pg_catalog.set_config('morrow.work_lease_generation','',true),
  pg_catalog.set_config('morrow.work_lease_entered','',true);
 RETURN QUERY SELECT v_outcome,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text;
END $$;
-- The one cross-tenant read (spine §5): the ids of committed, unexpired run and operation
-- leases whose Workflow has not started, oldest first, at most 100. No tenant, store,
-- member or content column. Content-free (tenant-conformance registry).
CREATE FUNCTION morrow_work.pending_starts()
RETURNS TABLE(kind text,subject_id text,lease_id text,generation text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_runtime_executor') THEN RETURN; END IF;
 RETURN QUERY SELECT l.kind,l.subject_id::text,l.id::text,l.generation::text FROM morrow_work.work_leases l
  WHERE l.status='active' AND l.started_at IS NULL AND l.kind IN ('run','operation') AND l.expires_at>pg_catalog.clock_timestamp()
  ORDER BY l.created_at,l.id LIMIT 100;
END $$;
-- The entered lease's Workflow has started (its first step): started_at once. Outcomes:
-- started, already_started, denied.
CREATE FUNCTION morrow_work.lease_mark_started() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE l record; n integer;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND OR l.kind NOT IN ('run','operation') THEN RETURN 'denied'; END IF;
 UPDATE morrow_work.work_leases x SET started_at=greatest(morrow_work.db_now(),x.created_at)
  WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=l.lease_id AND x.started_at IS NULL;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN CASE WHEN n=1 THEN 'started' ELSE 'already_started' END;
END $$;
-- Releases the entered lease when its work ends; the context resolves nothing after.
-- Outcomes: released, denied.
CREATE FUNCTION morrow_work.lease_release() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_work,pg_temp AS $$
DECLARE l record; n integer;
BEGIN
 SELECT * INTO l FROM morrow_work.current_lease();
 IF NOT FOUND THEN RETURN 'denied'; END IF;
 UPDATE morrow_work.work_leases x SET status='released',ended_at=greatest(morrow_work.db_now(),x.created_at)
  WHERE x.organization_id=l.organization_id AND x.workspace_id=l.workspace_id AND x.id=l.lease_id AND x.status='active';
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN CASE WHEN n=1 THEN 'released' ELSE 'denied' END;
END $$;

-- ---------------------------------------------------------------------------
-- The vault definer: SECURITY DEFINER, owned by the command role after the transfer,
-- EXECUTE for morrow_vault_broker only. The active envelope of one app secret, as hex;
-- the broker decrypts it with its KEK. Outcomes: found, invalid, not_found, denied.
CREATE FUNCTION morrow_vault.app_secret_get(p_app_key text)
RETURNS TABLE(outcome text,version text,kek_version text,wrapped_key text,sealed_value text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE s record;
BEGIN
 IF NOT morrow_identity.work_executor_safe('morrow_vault_broker') THEN
  RETURN QUERY SELECT 'denied'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN;
 END IF;
 SELECT x.version::text AS version,x.kek_version::text AS kek_version,encode(x.wrapped_key,'hex') AS wrapped_key,
  encode(x.sealed_value,'hex') AS sealed_value INTO s FROM morrow_vault.app_secrets x WHERE x.app_key=p_app_key AND x.status='active';
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text,NULL::text,NULL::text,NULL::text,NULL::text; RETURN; END IF;
 RETURN QUERY SELECT 'found'::text,s.version,s.kek_version,s.wrapped_key,s.sealed_value;
END $$;

-- The signup bridge (P01.T04a §8.1 R1): SECURITY DEFINER, owned by the command role after
-- the transfer, EXECUTE for morrow_identity_owner only. 0021's trigger on
-- organization_signups calls it in the website signup's creating transaction, and 0021
-- backfills existing signups through it. It inserts the unfixed website route row (bound
-- at the workspace's first store link, if any), once. Outcomes: recorded, exists, invalid.
CREATE FUNCTION morrow_billing.record_signup_route(p_organization_id text,p_workspace_id text,p_shopify_bound_at timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow_billing,pg_temp AS $$
DECLARE v_at timestamptz:=date_trunc('milliseconds',clock_timestamp()); n integer;
BEGIN
 IF p_organization_id IS NULL OR p_organization_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_workspace_id IS NULL OR p_workspace_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR (p_shopify_bound_at IS NOT NULL AND (NOT isfinite(p_shopify_bound_at) OR p_shopify_bound_at>v_at)) THEN
  RETURN 'invalid';
 END IF;
 INSERT INTO morrow_billing.workspace_billing_routes(organization_id,workspace_id,origin,shopify_bound_at,route,mode,route_fixed_at,
  fixing_payment_key,revision,created_at,updated_at)
 VALUES (p_organization_id,p_workspace_id,'website',date_trunc('milliseconds',p_shopify_bound_at),NULL,NULL,NULL,NULL,1,v_at,v_at)
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN CASE WHEN n=1 THEN 'recorded' ELSE 'exists' END;
END $$;

-- ---------------------------------------------------------------------------
-- Operator functions: owned by the owner, INVOKER, granted to nobody. Only the owner's
-- audited scripts run them, as morrow_work_owner inside the administrator's own
-- transaction (the ADR-0020 runner shape); the application never does.
-- The platform stop (ADR-0022 item 15): one active at most; setting it revokes every
-- active run and operation lease (stop_guard) and writes its StopRecord@1.
-- Outcomes: applied, already_stopped, invalid, denied.
CREATE FUNCTION morrow_work.platform_stop_set(p_operator_id text,p_reason text)
RETURNS TABLE(outcome text,stop_id text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE v_id text; v_at timestamptz; v_existing text;
BEGIN
 IF current_user<>'morrow_work_owner' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF p_operator_id IS NULL OR p_operator_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 1024 OR p_reason !~ '\S' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
 SELECT s.id::text INTO v_existing FROM morrow_work.stop_controls s WHERE s.scope='platform' AND s.lifted_at IS NULL;
 IF FOUND THEN RETURN QUERY SELECT 'already_stopped'::text,v_existing; RETURN; END IF;
 v_id:=gen_random_uuid()::text;
 v_at:=date_trunc('milliseconds',clock_timestamp());
 INSERT INTO morrow_work.stop_controls(organization_id,workspace_id,id,scope,store_id,target_id,set_by_kind,set_by_principal_id,
  set_by_membership_id,set_by_operator_id,reason_code,reason,created_at)
 VALUES (NULL,NULL,v_id,'platform',NULL,NULL,'operator',NULL,NULL,p_operator_id,'operator_platform_stop',p_reason,v_at);
 INSERT INTO morrow_work.stop_records(organization_id,workspace_id,id,stop_control_id,action,scope,store_id,target_id,actor_kind,
  operator_id,reason_code,reason,recorded_at)
 VALUES (NULL,NULL,gen_random_uuid()::text,v_id,'set','platform',NULL,NULL,'operator',p_operator_id,'operator_platform_stop',p_reason,v_at);
 RETURN QUERY SELECT 'applied'::text,v_id;
END $$;
-- Lifts the active platform stop (a person, by script) and records it. Lifting revokes
-- nothing back: a revoked lease stays revoked. Outcomes: applied, not_stopped, invalid,
-- denied.
CREATE FUNCTION morrow_work.platform_stop_lift(p_operator_id text,p_reason text)
RETURNS TABLE(outcome text,stop_id text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_work,pg_temp AS $$
#variable_conflict use_column
DECLARE v_id text; v_at timestamptz;
BEGIN
 IF current_user<>'morrow_work_owner' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF p_operator_id IS NULL OR p_operator_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 1024 OR p_reason !~ '\S' THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.work.stop','platform')::text,0));
 SELECT s.id::text INTO v_id FROM morrow_work.stop_controls s WHERE s.scope='platform' AND s.lifted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'not_stopped'::text,NULL::text; RETURN; END IF;
 v_at:=date_trunc('milliseconds',clock_timestamp());
 UPDATE morrow_work.stop_controls s SET lifted_at=greatest(v_at,s.created_at),lifted_by_kind='operator',lifted_by_operator_id=p_operator_id
  WHERE s.id=v_id RETURNING s.lifted_at INTO v_at;
 INSERT INTO morrow_work.stop_records(organization_id,workspace_id,id,stop_control_id,action,scope,store_id,target_id,actor_kind,
  operator_id,reason_code,reason,recorded_at)
 VALUES (NULL,NULL,gen_random_uuid()::text,v_id,'lift','platform',NULL,NULL,'operator',p_operator_id,'operator_platform_lift',p_reason,v_at);
 RETURN QUERY SELECT 'applied'::text,v_id;
END $$;
-- Stores one Shopify app client secret envelope (the owner-run vault script encrypts it
-- with the offline KEK copy): the app's active version is retired, its key material
-- erased, and the new one becomes active at the next version. Inputs are lowercase hex.
-- Outcomes: stored, invalid, denied.
CREATE FUNCTION morrow_vault.app_secret_put(p_app_key text,p_kek_version text,p_wrapped_key text,p_sealed_value text)
RETURNS TABLE(outcome text,version text)
LANGUAGE plpgsql SET search_path=pg_catalog,morrow_vault,pg_temp AS $$
#variable_conflict use_column
DECLARE v_previous bigint; v_at timestamptz;
BEGIN
 IF current_user<>'morrow_work_owner' THEN RETURN QUERY SELECT 'denied'::text,NULL::text; RETURN; END IF;
 IF p_app_key IS NULL OR p_app_key !~ '^[a-z0-9][a-z0-9-]{2,62}$'
  OR p_kek_version IS NULL OR p_kek_version !~ '^[1-9][0-9]{0,2}$'
  OR p_wrapped_key IS NULL OR p_wrapped_key !~ '^[a-f0-9]+$' OR length(p_wrapped_key)<>120
  OR p_sealed_value IS NULL OR p_sealed_value !~ '^[a-f0-9]+$' OR length(p_sealed_value)%2<>0
  OR length(p_sealed_value) NOT BETWEEN 58 AND 8248 THEN
  RETURN QUERY SELECT 'invalid'::text,NULL::text; RETURN;
 END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array('morrow.vault.app_secret',p_app_key)::text,0));
 v_at:=date_trunc('milliseconds',clock_timestamp());
 SELECT max(s.version) INTO v_previous FROM morrow_vault.app_secrets s WHERE s.app_key=p_app_key;
 UPDATE morrow_vault.app_secrets s SET status='retired',wrapped_key=NULL,sealed_value=NULL,retired_at=greatest(v_at,s.created_at)
  WHERE s.app_key=p_app_key AND s.status='active';
 INSERT INTO morrow_vault.app_secrets(app_key,version,provider,status,kek_version,wrapped_key,sealed_value,created_at,retired_at)
 VALUES (p_app_key,COALESCE(v_previous,0)+1,'shopify','active',p_kek_version::integer,decode(p_wrapped_key,'hex'),
  decode(p_sealed_value,'hex'),v_at,NULL);
 RETURN QUERY SELECT 'stored'::text,(COALESCE(v_previous,0)+1)::text;
END $$;

-- ---------------------------------------------------------------------------
-- Explicit ACLs per function (S5 reads proacl), then the ownership transfer.
REVOKE ALL ON FUNCTION morrow_work.stop_active(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.lease_open(text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.operation_transition(text,text,text,bigint,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.enter_lease(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.pending_starts() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.lease_mark_started() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.lease_release() FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.platform_stop_set(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_work.platform_stop_lift(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_vault.app_secret_get(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_vault.app_secret_put(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION morrow_billing.record_signup_route(text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION morrow_work.enter_lease(text,text),morrow_work.pending_starts(),morrow_work.lease_mark_started(),
 morrow_work.lease_release() TO morrow_runtime_executor;
GRANT EXECUTE ON FUNCTION morrow_vault.app_secret_get(text) TO morrow_vault_broker;
GRANT EXECUTE ON FUNCTION morrow_billing.record_signup_route(text,text,timestamptz) TO morrow_identity_owner;
GRANT CREATE ON SCHEMA morrow_work,morrow_billing,morrow_vault TO morrow_work_command;
ALTER FUNCTION morrow_work.current_lease() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.stop_active(text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.lease_open(text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.operation_transition(text,text,text,bigint,text,text,text,text,text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.enter_lease(text,text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.pending_starts() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.lease_mark_started() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_work.lease_release() OWNER TO morrow_work_command;
ALTER FUNCTION morrow_vault.app_secret_get(text) OWNER TO morrow_work_command;
ALTER FUNCTION morrow_billing.record_signup_route(text,text,timestamptz) OWNER TO morrow_work_command;
REVOKE CREATE ON SCHEMA morrow_work,morrow_billing,morrow_vault FROM morrow_work_command;
COMMIT;
